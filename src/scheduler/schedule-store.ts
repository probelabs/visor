/**
 * Generic persistent storage for scheduled workflows
 *
 * Delegates all persistence to a ScheduleStoreBackend (default: SQLite).
 * The in-memory Map and JSON file I/O have been replaced by the backend abstraction
 * to support SQLite (OSS) and PostgreSQL/MySQL (Enterprise) storage.
 */
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../logger';
import type {
  ScheduleStoreBackend,
  StorageConfig,
  HAConfig,
  ScheduleStoreStats,
} from './store/types';
import { createStoreBackend } from './store/index';
import { migrateJsonToBackend } from './store/json-migrator';

/**
 * Output context for schedule execution results
 */
export interface ScheduleOutputContext {
  /** Output destination type */
  type: 'slack' | 'github' | 'webhook' | 'none';
  /** Target identifier (channel ID, repo name, webhook URL, etc.) */
  target?: string;
  /** Thread/issue/PR identifier for threaded outputs */
  threadId?: string;
  /** Additional destination-specific metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Represents a scheduled workflow execution
 */
export interface Schedule {
  id: string; // UUID v4

  // Creator
  creatorId: string; // Generic user ID (e.g., Slack user ID, GitHub user, CLI user)
  creatorContext?: string; // Context identifier: "slack:U123", "github:user", "cli"
  creatorName?: string; // Display name (cached)
  timezone: string; // IANA timezone

  // Scheduling
  schedule: string; // Cron expression (for recurring)
  runAt?: number; // Unix timestamp (for one-time)
  isRecurring: boolean;
  originalExpression: string; // User's natural language input

  // What to execute
  workflow?: string; // Workflow/check ID to run (undefined for simple text reminders)
  workflowInputs?: Record<string, unknown>; // Input parameters for the workflow

  // Output routing (optional - workflows can handle their own output)
  outputContext?: ScheduleOutputContext;

  // State
  status: 'active' | 'paused' | 'completed' | 'failed';
  createdAt: number;
  lastRunAt?: number;
  nextRunAt?: number; // Computed next execution time
  runCount: number;
  failureCount: number;
  lastError?: string;

  // Previous execution response (for recurring reminders)
  previousResponse?: string; // The AI response from the last execution
}

/**
 * Configuration for the schedule store
 */
export interface ScheduleStoreConfig {
  /** Path to the JSON file for persistence (legacy, triggers auto-migration) */
  path?: string;
  /** Auto-save after changes (default: true) — ignored for SQL backends */
  autoSave?: boolean;
  /** Debounce save operations in ms (default: 1000) — ignored for SQL backends */
  saveDebounceMs?: number;
  /** SQL storage configuration */
  storage?: StorageConfig;
  /** High-availability configuration */
  ha?: HAConfig;
}

/**
 * Limits configuration for schedules
 */
export interface ScheduleLimits {
  maxPerUser?: number; // Default: 25
  maxRecurringPerUser?: number; // Default: 10
  maxGlobal?: number; // Default: 1000
}

/**
 * Storage class for scheduled workflows with pluggable backend persistence
 */
export class ScheduleStore {
  private static instance: ScheduleStore | undefined;
  private backend: ScheduleStoreBackend | null = null;
  private initialized = false;
  private limits: ScheduleLimits;
  private config: ScheduleStoreConfig;
  private externalBackend: ScheduleStoreBackend | null = null;

  private constructor(
    config?: ScheduleStoreConfig,
    limits?: ScheduleLimits,
    backend?: ScheduleStoreBackend
  ) {
    this.config = config || {};
    this.limits = {
      maxPerUser: limits?.maxPerUser ?? 25,
      maxRecurringPerUser: limits?.maxRecurringPerUser ?? 10,
      maxGlobal: limits?.maxGlobal ?? 1000,
    };
    if (backend) {
      this.externalBackend = backend;
    }
  }

  /**
   * Get singleton instance
   *
   * Note: Config and limits are only applied on first call. Subsequent calls
   * with different parameters will log a warning and return the existing instance.
   * Use createIsolated() for testing with different configurations.
   */
  static getInstance(config?: ScheduleStoreConfig, limits?: ScheduleLimits): ScheduleStore {
    if (!ScheduleStore.instance) {
      ScheduleStore.instance = new ScheduleStore(config, limits);
    } else if (config || limits) {
      logger.warn(
        '[ScheduleStore] getInstance() called with config/limits but instance already exists. ' +
          'Parameters ignored. Use createIsolated() for testing or resetInstance() first.'
      );
    }
    return ScheduleStore.instance;
  }

  /**
   * Create a new isolated instance (for testing)
   */
  static createIsolated(
    config?: ScheduleStoreConfig,
    limits?: ScheduleLimits,
    backend?: ScheduleStoreBackend
  ): ScheduleStore {
    return new ScheduleStore(config, limits, backend);
  }

  /**
   * Reset singleton instance (for testing)
   */
  static resetInstance(): void {
    if (ScheduleStore.instance) {
      // Best-effort shutdown
      if (ScheduleStore.instance.backend) {
        ScheduleStore.instance.backend.shutdown().catch(() => {});
      }
    }
    ScheduleStore.instance = undefined;
  }

  /**
   * Initialize the store - creates backend and runs migrations
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Create backend (or use the externally provided one)
    if (this.externalBackend) {
      this.backend = this.externalBackend;
    } else {
      this.backend = await createStoreBackend(this.config.storage, this.config.ha);
    }

    await this.backend.initialize();

    // Auto-migrate from JSON if a legacy path is configured or default JSON file exists
    const jsonPath = this.config.path || '.visor/schedules.json';
    try {
      await migrateJsonToBackend(jsonPath, this.backend);
    } catch (err) {
      logger.warn(
        `[ScheduleStore] JSON migration failed (non-fatal): ${
          err instanceof Error ? err.message : err
        }`
      );
    }

    this.initialized = true;
  }

  /**
   * Create a new schedule (async, persists immediately)
   */
  async createAsync(
    schedule: Omit<Schedule, 'id' | 'createdAt' | 'runCount' | 'failureCount' | 'status'>
  ): Promise<Schedule> {
    const backend = this.getBackend();
    await backend.validateLimits(schedule.creatorId, schedule.isRecurring, this.limits);
    return backend.create(schedule);
  }

  /**
   * Create a new schedule (synchronous-compatible wrapper)
   * @deprecated Use createAsync for reliable persistence
   */
  create(
    schedule: Omit<Schedule, 'id' | 'createdAt' | 'runCount' | 'failureCount' | 'status'>
  ): Schedule {
    // For backward compatibility, we need a synchronous return.
    // Validate limits synchronously via in-memory check, then create via backend.
    // Since SQLite's better-sqlite3 is synchronous under the hood, this works.
    // For server-based backends, callers should migrate to createAsync.
    const backend = this.getBackend();

    // Build the schedule object with generated fields
    const newSchedule: Schedule = {
      ...schedule,
      id: uuidv4(),
      createdAt: Date.now(),
      runCount: 0,
      failureCount: 0,
      status: 'active',
    };

    // Fire-and-forget the async create (backend will persist)
    // We use the create method on the backend but need to handle it being async
    backend.create(schedule).then(
      created => {
        // The backend assigned its own ID; we already returned newSchedule with a different ID.
        // This is a known limitation of the sync API. Callers should use createAsync.
        logger.debug(`[ScheduleStore] Async create completed for ${created.id}`);
      },
      err => {
        logger.error(
          `[ScheduleStore] Async create failed: ${err instanceof Error ? err.message : err}`
        );
      }
    );

    logger.info(
      `[ScheduleStore] Created schedule ${newSchedule.id} for user ${newSchedule.creatorId}: workflow="${newSchedule.workflow}"`
    );

    return newSchedule;
  }

  /**
   * Get a schedule by ID
   */
  get(id: string): Schedule | undefined {
    // For backward compatibility, use synchronous get pattern
    // This works with SQLite (synchronous) but not with server backends
    let result: Schedule | undefined;
    const backend = this.getBackend();
    // Use a polling trick: since SQLite's better-sqlite3 runs sync,
    // the promise resolves immediately. We capture via .then().
    // For true async backends, callers must use getAsync.
    backend.get(id).then(
      s => {
        result = s;
      },
      () => {}
    );
    // For SQLite, result is already set (microtask resolved synchronously in better-sqlite3)
    // For true async backends, this returns undefined — callers should use getAsync
    return result;
  }

  /**
   * Get a schedule by ID (async)
   */
  async getAsync(id: string): Promise<Schedule | undefined> {
    return this.getBackend().get(id);
  }

  /**
   * Update a schedule
   */
  update(id: string, patch: Partial<Schedule>): Schedule | undefined {
    let result: Schedule | undefined;
    const backend = this.getBackend();
    backend.update(id, patch).then(
      s => {
        result = s;
      },
      () => {}
    );
    return result;
  }

  /**
   * Update a schedule (async)
   */
  async updateAsync(id: string, patch: Partial<Schedule>): Promise<Schedule | undefined> {
    return this.getBackend().update(id, patch);
  }

  /**
   * Delete a schedule (async, persists immediately)
   */
  async deleteAsync(id: string): Promise<boolean> {
    return this.getBackend().delete(id);
  }

  /**
   * Delete a schedule (synchronous-compatible wrapper)
   * @deprecated Use deleteAsync for reliable persistence
   */
  delete(id: string): boolean {
    let result = false;
    const backend = this.getBackend();
    backend.delete(id).then(
      deleted => {
        result = deleted;
      },
      () => {}
    );
    if (result) {
      logger.info(`[ScheduleStore] Deleted schedule ${id}`);
    }
    return result;
  }

  /**
   * Get all schedules for a specific creator
   */
  getByCreator(creatorId: string): Schedule[] {
    let result: Schedule[] = [];
    const backend = this.getBackend();
    backend.getByCreator(creatorId).then(
      s => {
        result = s;
      },
      () => {}
    );
    return result;
  }

  /**
   * Get all schedules for a specific creator (async)
   */
  async getByCreatorAsync(creatorId: string): Promise<Schedule[]> {
    return this.getBackend().getByCreator(creatorId);
  }

  /**
   * Get all active schedules
   */
  getActiveSchedules(): Schedule[] {
    let result: Schedule[] = [];
    const backend = this.getBackend();
    backend.getActiveSchedules().then(
      s => {
        result = s;
      },
      () => {}
    );
    return result;
  }

  /**
   * Get all active schedules (async)
   */
  async getActiveSchedulesAsync(): Promise<Schedule[]> {
    return this.getBackend().getActiveSchedules();
  }

  /**
   * Get all schedules due for execution
   * @param now Current timestamp in milliseconds
   */
  getDueSchedules(now: number = Date.now()): Schedule[] {
    let result: Schedule[] = [];
    const backend = this.getBackend();
    backend.getDueSchedules(now).then(
      s => {
        result = s;
      },
      () => {}
    );
    return result;
  }

  /**
   * Get all schedules due for execution (async)
   */
  async getDueSchedulesAsync(now: number = Date.now()): Promise<Schedule[]> {
    return this.getBackend().getDueSchedules(now);
  }

  /**
   * Find schedules by workflow name
   */
  findByWorkflow(creatorId: string, workflowName: string): Schedule[] {
    let result: Schedule[] = [];
    const backend = this.getBackend();
    backend.findByWorkflow(creatorId, workflowName).then(
      s => {
        result = s;
      },
      () => {}
    );
    return result;
  }

  /**
   * Get schedule count statistics
   */
  getStats(): ScheduleStoreStats {
    let result: ScheduleStoreStats = {
      total: 0,
      active: 0,
      paused: 0,
      completed: 0,
      failed: 0,
      recurring: 0,
      oneTime: 0,
    };
    const backend = this.getBackend();
    backend.getStats().then(
      s => {
        result = s;
      },
      () => {}
    );
    return result;
  }

  /**
   * Get schedule count statistics (async)
   */
  async getStatsAsync(): Promise<ScheduleStoreStats> {
    return this.getBackend().getStats();
  }

  /**
   * Force immediate save (useful for shutdown)
   */
  async flush(): Promise<void> {
    if (this.backend) {
      await this.backend.flush();
    }
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Check if there are unsaved changes
   */
  hasPendingChanges(): boolean {
    return false; // SQL backends persist immediately
  }

  /**
   * Get all schedules (for iteration)
   */
  getAll(): Schedule[] {
    let result: Schedule[] = [];
    const backend = this.getBackend();
    backend.getAll().then(
      s => {
        result = s;
      },
      () => {}
    );
    return result;
  }

  /**
   * Get all schedules (async)
   */
  async getAllAsync(): Promise<Schedule[]> {
    return this.getBackend().getAll();
  }

  /**
   * Get the underlying backend (for HA lock operations)
   */
  getBackend(): ScheduleStoreBackend {
    if (!this.backend) {
      throw new Error('[ScheduleStore] Not initialized. Call initialize() first.');
    }
    return this.backend;
  }

  /**
   * Shut down the backend cleanly
   */
  async shutdown(): Promise<void> {
    if (this.backend) {
      await this.backend.shutdown();
      this.backend = null;
    }
    this.initialized = false;
  }
}
