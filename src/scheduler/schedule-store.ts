/**
 * Generic persistent storage for scheduled workflows
 * Uses JSON file storage with atomic writes
 *
 * This is a frontend-agnostic scheduler that can be used with any output destination.
 * When a schedule fires, it runs a visor workflow/check and output destinations
 * (Slack, GitHub, webhooks) become workflow responsibilities.
 */
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../logger';

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
  /** Path to the JSON file for persistence */
  path?: string;
  /** Auto-save after changes (default: true) */
  autoSave?: boolean;
  /** Debounce save operations in ms (default: 1000) */
  saveDebounceMs?: number;
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
 * Storage class for scheduled workflows with JSON file persistence
 */
export class ScheduleStore {
  private static instance: ScheduleStore | undefined;
  private schedules: Map<string, Schedule> = new Map();
  private filePath: string;
  private autoSave: boolean;
  private saveDebounceMs: number;
  private initialized = false;
  private saveTimeout: NodeJS.Timeout | null = null;
  private limits: ScheduleLimits;

  private constructor(config?: ScheduleStoreConfig, limits?: ScheduleLimits) {
    this.filePath = config?.path || '.visor/schedules.json';
    this.autoSave = config?.autoSave !== false;
    this.saveDebounceMs = config?.saveDebounceMs ?? 1000;
    this.limits = {
      maxPerUser: limits?.maxPerUser ?? 25,
      maxRecurringPerUser: limits?.maxRecurringPerUser ?? 10,
      maxGlobal: limits?.maxGlobal ?? 1000,
    };
  }

  /**
   * Get singleton instance
   */
  static getInstance(config?: ScheduleStoreConfig, limits?: ScheduleLimits): ScheduleStore {
    if (!ScheduleStore.instance) {
      ScheduleStore.instance = new ScheduleStore(config, limits);
    }
    return ScheduleStore.instance;
  }

  /**
   * Create a new isolated instance (for testing)
   */
  static createIsolated(config?: ScheduleStoreConfig, limits?: ScheduleLimits): ScheduleStore {
    return new ScheduleStore(config, limits);
  }

  /**
   * Reset singleton instance (for testing)
   */
  static resetInstance(): void {
    if (ScheduleStore.instance) {
      ScheduleStore.instance.schedules.clear();
      if (ScheduleStore.instance.saveTimeout) {
        clearTimeout(ScheduleStore.instance.saveTimeout);
      }
    }
    ScheduleStore.instance = undefined;
  }

  /**
   * Initialize the store - load from file if it exists
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const resolvedPath = path.resolve(process.cwd(), this.filePath);
      const content = await fs.readFile(resolvedPath, 'utf-8');
      const data = JSON.parse(content) as { schedules?: Schedule[] };

      const scheduleList = data.schedules || [];

      if (Array.isArray(scheduleList)) {
        for (const schedule of scheduleList) {
          this.schedules.set(schedule.id, schedule);
        }
        logger.info(
          `[ScheduleStore] Loaded ${this.schedules.size} schedules from ${this.filePath}`
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(
          `[ScheduleStore] Failed to load schedules: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      } else {
        logger.debug(`[ScheduleStore] No existing schedules file at ${this.filePath}`);
      }
    }

    this.initialized = true;
  }

  /**
   * Save schedules to file with atomic write
   */
  async save(): Promise<void> {
    const resolvedPath = path.resolve(process.cwd(), this.filePath);
    const dir = path.dirname(resolvedPath);

    // Ensure directory exists
    await fs.mkdir(dir, { recursive: true });

    // Prepare data
    const data = {
      version: '2.0', // New version for schedule format
      savedAt: new Date().toISOString(),
      schedules: Array.from(this.schedules.values()),
    };

    // Atomic write: write to temp file, then rename
    const tempPath = `${resolvedPath}.tmp.${Date.now()}`;
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tempPath, resolvedPath);

    logger.debug(`[ScheduleStore] Saved ${this.schedules.size} schedules to ${this.filePath}`);
  }

  /**
   * Schedule a debounced save operation
   */
  private scheduleSave(): void {
    if (!this.autoSave) return;

    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    this.saveTimeout = setTimeout(() => {
      this.save().catch(error => {
        logger.error(
          `[ScheduleStore] Auto-save failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      });
    }, this.saveDebounceMs);
  }

  /**
   * Create a new schedule
   */
  create(
    schedule: Omit<Schedule, 'id' | 'createdAt' | 'runCount' | 'failureCount' | 'status'>
  ): Schedule {
    // Validate limits
    this.validateLimits(schedule.creatorId, schedule.isRecurring);

    const newSchedule: Schedule = {
      ...schedule,
      id: uuidv4(),
      createdAt: Date.now(),
      runCount: 0,
      failureCount: 0,
      status: 'active',
    };

    this.schedules.set(newSchedule.id, newSchedule);
    this.scheduleSave();

    logger.info(
      `[ScheduleStore] Created schedule ${newSchedule.id} for user ${newSchedule.creatorId}: workflow="${newSchedule.workflow}"`
    );

    return newSchedule;
  }

  /**
   * Validate schedule limits before creation
   */
  private validateLimits(creatorId: string, isRecurring: boolean): void {
    // Global limit
    if (this.limits.maxGlobal && this.schedules.size >= this.limits.maxGlobal) {
      throw new Error(`Global schedule limit reached (${this.limits.maxGlobal})`);
    }

    // Per-user limit
    const userSchedules = this.getByCreator(creatorId);
    if (this.limits.maxPerUser && userSchedules.length >= this.limits.maxPerUser) {
      throw new Error(
        `You have reached the maximum number of schedules (${this.limits.maxPerUser})`
      );
    }

    // Per-user recurring limit
    if (isRecurring && this.limits.maxRecurringPerUser) {
      const recurringCount = userSchedules.filter(s => s.isRecurring).length;
      if (recurringCount >= this.limits.maxRecurringPerUser) {
        throw new Error(
          `You have reached the maximum number of recurring schedules (${this.limits.maxRecurringPerUser})`
        );
      }
    }
  }

  /**
   * Get a schedule by ID
   */
  get(id: string): Schedule | undefined {
    return this.schedules.get(id);
  }

  /**
   * Update a schedule
   */
  update(id: string, patch: Partial<Schedule>): Schedule | undefined {
    const schedule = this.schedules.get(id);
    if (!schedule) {
      return undefined;
    }

    const updated = { ...schedule, ...patch, id: schedule.id }; // Ensure ID cannot be changed
    this.schedules.set(id, updated);
    this.scheduleSave();

    return updated;
  }

  /**
   * Delete a schedule
   */
  delete(id: string): boolean {
    const deleted = this.schedules.delete(id);
    if (deleted) {
      this.scheduleSave();
      logger.info(`[ScheduleStore] Deleted schedule ${id}`);
    }
    return deleted;
  }

  /**
   * Get all schedules for a specific creator
   */
  getByCreator(creatorId: string): Schedule[] {
    return Array.from(this.schedules.values()).filter(s => s.creatorId === creatorId);
  }

  /**
   * Get all active schedules
   */
  getActiveSchedules(): Schedule[] {
    return Array.from(this.schedules.values()).filter(s => s.status === 'active');
  }

  /**
   * Get all schedules due for execution
   * @param now Current timestamp in milliseconds
   */
  getDueSchedules(now: number = Date.now()): Schedule[] {
    return this.getActiveSchedules().filter(s => {
      // For one-time schedules, check if runAt is in the past
      if (!s.isRecurring && s.runAt) {
        return s.runAt <= now;
      }
      // For recurring schedules, check nextRunAt
      if (s.isRecurring && s.nextRunAt) {
        return s.nextRunAt <= now;
      }
      return false;
    });
  }

  /**
   * Find schedules by workflow name
   */
  findByWorkflow(creatorId: string, workflowName: string): Schedule[] {
    const lowerWorkflow = workflowName.toLowerCase();
    return this.getByCreator(creatorId).filter(
      s => s.status === 'active' && s.workflow?.toLowerCase().includes(lowerWorkflow)
    );
  }

  /**
   * Get schedule count statistics
   */
  getStats(): {
    total: number;
    active: number;
    paused: number;
    completed: number;
    failed: number;
    recurring: number;
    oneTime: number;
  } {
    const all = Array.from(this.schedules.values());
    return {
      total: all.length,
      active: all.filter(s => s.status === 'active').length,
      paused: all.filter(s => s.status === 'paused').length,
      completed: all.filter(s => s.status === 'completed').length,
      failed: all.filter(s => s.status === 'failed').length,
      recurring: all.filter(s => s.isRecurring).length,
      oneTime: all.filter(s => !s.isRecurring).length,
    };
  }

  /**
   * Force immediate save (useful for shutdown)
   */
  async flush(): Promise<void> {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    await this.save();
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get all schedules (for iteration)
   */
  getAll(): Schedule[] {
    return Array.from(this.schedules.values());
  }
}
