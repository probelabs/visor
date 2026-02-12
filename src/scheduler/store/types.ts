/**
 * Store backend interface for schedule persistence
 *
 * Implementations:
 * - SqliteStoreBackend (OSS default, zero-config)
 * - KnexStoreBackend (Enterprise: PostgreSQL/MySQL with distributed locking)
 */
import type { Schedule, ScheduleLimits } from '../schedule-store';

/**
 * Statistics about the schedule store
 */
export interface ScheduleStoreStats {
  total: number;
  active: number;
  paused: number;
  completed: number;
  failed: number;
  recurring: number;
  oneTime: number;
}

/**
 * Backend interface that all store implementations must satisfy
 */
export interface ScheduleStoreBackend {
  /** Initialize the backend (create tables, run migrations, etc.) */
  initialize(): Promise<void>;

  /** Gracefully shut down (close connections, etc.) */
  shutdown(): Promise<void>;

  // --- CRUD ---

  /** Create a new schedule, assigning id/createdAt/runCount/failureCount/status */
  create(
    schedule: Omit<Schedule, 'id' | 'createdAt' | 'runCount' | 'failureCount' | 'status'>
  ): Promise<Schedule>;

  /** Import a full schedule preserving its original ID (used for migration) */
  importSchedule(schedule: Schedule): Promise<void>;

  /** Get a schedule by ID */
  get(id: string): Promise<Schedule | undefined>;

  /** Partial update of a schedule. Returns updated schedule or undefined if not found */
  update(id: string, patch: Partial<Schedule>): Promise<Schedule | undefined>;

  /** Delete a schedule. Returns true if it existed */
  delete(id: string): Promise<boolean>;

  // --- Queries ---

  /** Get all schedules for a specific creator */
  getByCreator(creatorId: string): Promise<Schedule[]>;

  /** Get all active schedules */
  getActiveSchedules(): Promise<Schedule[]>;

  /** Get schedules that are due for execution */
  getDueSchedules(now?: number): Promise<Schedule[]>;

  /** Find active schedules matching a workflow name (case-insensitive substring) */
  findByWorkflow(creatorId: string, workflowName: string): Promise<Schedule[]>;

  /** Get all schedules */
  getAll(): Promise<Schedule[]>;

  /** Get aggregate statistics */
  getStats(): Promise<ScheduleStoreStats>;

  /** Validate schedule limits before creation. Throws on violation */
  validateLimits(creatorId: string, isRecurring: boolean, limits: ScheduleLimits): Promise<void>;

  // --- HA Locking ---

  /**
   * Attempt to acquire a distributed lock for a schedule.
   * Returns a lock token on success, null if another node holds the lock.
   */
  tryAcquireLock(scheduleId: string, nodeId: string, ttlSeconds: number): Promise<string | null>;

  /** Release a lock. No-op if the token doesn't match */
  releaseLock(scheduleId: string, lockToken: string): Promise<void>;

  /** Renew an existing lock. Returns false if the lock was lost */
  renewLock(scheduleId: string, lockToken: string, ttlSeconds: number): Promise<boolean>;

  /** Flush any pending writes (no-op for SQL backends) */
  flush(): Promise<void>;
}

/**
 * SQLite connection configuration
 */
export interface SqliteConnectionConfig {
  /** Path to the SQLite database file (default: '.visor/schedules.db') */
  filename?: string;
}

/**
 * SSL/TLS configuration for server-based database connections
 */
export interface SslConfig {
  /** Enable SSL (default: true when SslConfig object is provided) */
  enabled?: boolean;
  /** Reject unauthorized certificates (default: true) */
  reject_unauthorized?: boolean;
  /** Path to CA certificate PEM file */
  ca?: string;
  /** Path to client certificate PEM file */
  cert?: string;
  /** Path to client key PEM file */
  key?: string;
}

/**
 * Server-based database connection configuration (PostgreSQL / MySQL / MSSQL)
 */
export interface ServerConnectionConfig {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean | SslConfig;
  /** Connection string URL (e.g., postgresql://user:pass@host/db) */
  connection_string?: string;
  /** Connection pool configuration */
  pool?: { min?: number; max?: number };
}

/**
 * Storage driver configuration
 */
export interface StorageConfig {
  /** Database driver (default: 'sqlite') */
  driver: 'sqlite' | 'postgresql' | 'mysql' | 'mssql';
  /** Connection configuration (driver-specific) */
  connection?: SqliteConnectionConfig | ServerConnectionConfig;
}

/**
 * High-availability configuration for multi-node deployments
 */
export interface HAConfig {
  /** Enable distributed locking (default: false) */
  enabled: boolean;
  /** Unique node identifier (default: hostname + pid) */
  node_id?: string;
  /** Lock time-to-live in seconds (default: 60) */
  lock_ttl?: number;
  /** Heartbeat interval in seconds (default: 15) */
  heartbeat_interval?: number;
}
