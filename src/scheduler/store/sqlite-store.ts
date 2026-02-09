/**
 * SQLite-backed schedule store (OSS default)
 *
 * Uses better-sqlite3 loaded via createRequire to avoid ncc bundling the native addon.
 * Schema migration is inline (no external migration files — ncc-safe).
 * WAL mode is enabled for better concurrent read performance.
 *
 * HA locking is in-memory (Map-based) since SQLite is single-node only.
 */
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../logger';
import type { Schedule, ScheduleLimits } from '../schedule-store';
import type { ScheduleStoreBackend, ScheduleStoreStats } from './types';

// Type declarations for better-sqlite3 (avoid importing the module at compile time)
interface BetterSqliteDatabase {
  pragma(source: string): unknown;
  exec(source: string): void;
  prepare(source: string): BetterSqliteStatement;
  close(): void;
}

interface BetterSqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/**
 * Database row shape (snake_case)
 */
interface ScheduleRow {
  id: string;
  creator_id: string;
  creator_context: string | null;
  creator_name: string | null;
  timezone: string;
  schedule_expr: string;
  run_at: number | null;
  is_recurring: number; // SQLite boolean: 0/1
  original_expression: string;
  workflow: string | null;
  workflow_inputs: string | null; // JSON
  output_context: string | null; // JSON
  status: string;
  created_at: number;
  last_run_at: number | null;
  next_run_at: number | null;
  run_count: number;
  failure_count: number;
  last_error: string | null;
  previous_response: string | null;
}

/**
 * Convert a Schedule object to a database row
 */
function toDbRow(schedule: Schedule): ScheduleRow {
  return {
    id: schedule.id,
    creator_id: schedule.creatorId,
    creator_context: schedule.creatorContext ?? null,
    creator_name: schedule.creatorName ?? null,
    timezone: schedule.timezone,
    schedule_expr: schedule.schedule,
    run_at: schedule.runAt ?? null,
    is_recurring: schedule.isRecurring ? 1 : 0,
    original_expression: schedule.originalExpression,
    workflow: schedule.workflow ?? null,
    workflow_inputs: schedule.workflowInputs ? JSON.stringify(schedule.workflowInputs) : null,
    output_context: schedule.outputContext ? JSON.stringify(schedule.outputContext) : null,
    status: schedule.status,
    created_at: schedule.createdAt,
    last_run_at: schedule.lastRunAt ?? null,
    next_run_at: schedule.nextRunAt ?? null,
    run_count: schedule.runCount,
    failure_count: schedule.failureCount,
    last_error: schedule.lastError ?? null,
    previous_response: schedule.previousResponse ?? null,
  };
}

function safeJsonParse<T = unknown>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/**
 * Convert a database row to a Schedule object
 */
function fromDbRow(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    creatorId: row.creator_id,
    creatorContext: row.creator_context ?? undefined,
    creatorName: row.creator_name ?? undefined,
    timezone: row.timezone,
    schedule: row.schedule_expr,
    runAt: row.run_at ?? undefined,
    isRecurring: row.is_recurring === 1,
    originalExpression: row.original_expression,
    workflow: row.workflow ?? undefined,
    workflowInputs: safeJsonParse(row.workflow_inputs),
    outputContext: safeJsonParse(row.output_context),
    status: row.status as Schedule['status'],
    createdAt: row.created_at,
    lastRunAt: row.last_run_at ?? undefined,
    nextRunAt: row.next_run_at ?? undefined,
    runCount: row.run_count,
    failureCount: row.failure_count,
    lastError: row.last_error ?? undefined,
    previousResponse: row.previous_response ?? undefined,
  };
}

/**
 * SQLite implementation of ScheduleStoreBackend
 */
export class SqliteStoreBackend implements ScheduleStoreBackend {
  private db: BetterSqliteDatabase | null = null;
  private dbPath: string;

  // In-memory locks (single-node only; SQLite doesn't support distributed locking)
  private locks = new Map<string, { nodeId: string; token: string; expiresAt: number }>();

  constructor(filename?: string) {
    this.dbPath = filename || '.visor/schedules.db';
  }

  async initialize(): Promise<void> {
    // Resolve and ensure directory exists
    const resolvedPath = path.resolve(process.cwd(), this.dbPath);
    const dir = path.dirname(resolvedPath);
    fs.mkdirSync(dir, { recursive: true });

    // Load better-sqlite3 via createRequire (ncc-safe)
    const { createRequire } = require('module') as typeof import('module');
    const runtimeRequire = createRequire(__filename);
    let Database: new (filename: string) => BetterSqliteDatabase;
    try {
      Database = runtimeRequire('better-sqlite3');
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
        throw new Error(
          'better-sqlite3 is required for SQLite schedule storage. ' +
            'Install it with: npm install better-sqlite3'
        );
      }
      throw err;
    }

    this.db = new Database(resolvedPath);

    // Enable WAL mode for better concurrent reads
    this.db.pragma('journal_mode = WAL');

    // Run schema migration (idempotent)
    this.migrateSchema();

    logger.info(`[SqliteStore] Initialized at ${this.dbPath}`);
  }

  async shutdown(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.locks.clear();
  }

  // --- Schema Migration ---

  private migrateSchema(): void {
    const db = this.getDb();

    db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id              VARCHAR(36)  PRIMARY KEY,
        creator_id      VARCHAR(255) NOT NULL,
        creator_context VARCHAR(255),
        creator_name    VARCHAR(255),
        timezone        VARCHAR(64)  NOT NULL DEFAULT 'UTC',
        schedule_expr   VARCHAR(255),
        run_at          BIGINT,
        is_recurring    BOOLEAN      NOT NULL,
        original_expression TEXT,
        workflow        VARCHAR(255),
        workflow_inputs TEXT,
        output_context  TEXT,
        status          VARCHAR(20)  NOT NULL,
        created_at      BIGINT       NOT NULL,
        last_run_at     BIGINT,
        next_run_at     BIGINT,
        run_count       INTEGER      NOT NULL DEFAULT 0,
        failure_count   INTEGER      NOT NULL DEFAULT 0,
        last_error      TEXT,
        previous_response TEXT,
        claimed_by      VARCHAR(255),
        claimed_at      BIGINT,
        lock_token      VARCHAR(36)
      );

      CREATE INDEX IF NOT EXISTS idx_schedules_creator_id
        ON schedules(creator_id);

      CREATE INDEX IF NOT EXISTS idx_schedules_status
        ON schedules(status);

      CREATE INDEX IF NOT EXISTS idx_schedules_status_next_run
        ON schedules(status, next_run_at);

      CREATE TABLE IF NOT EXISTS scheduler_locks (
        lock_id     VARCHAR(255) PRIMARY KEY,
        node_id     VARCHAR(255) NOT NULL,
        lock_token  VARCHAR(36)  NOT NULL,
        acquired_at BIGINT       NOT NULL,
        expires_at  BIGINT       NOT NULL
      );
    `);
  }

  // --- Helpers ---

  private getDb(): BetterSqliteDatabase {
    if (!this.db) {
      throw new Error('[SqliteStore] Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  // --- CRUD ---

  async create(
    schedule: Omit<Schedule, 'id' | 'createdAt' | 'runCount' | 'failureCount' | 'status'>
  ): Promise<Schedule> {
    const db = this.getDb();

    const newSchedule: Schedule = {
      ...schedule,
      id: uuidv4(),
      createdAt: Date.now(),
      runCount: 0,
      failureCount: 0,
      status: 'active',
    };

    const row = toDbRow(newSchedule);

    db.prepare(
      `
      INSERT INTO schedules (
        id, creator_id, creator_context, creator_name, timezone,
        schedule_expr, run_at, is_recurring, original_expression,
        workflow, workflow_inputs, output_context,
        status, created_at, last_run_at, next_run_at,
        run_count, failure_count, last_error, previous_response
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?
      )
    `
    ).run(
      row.id,
      row.creator_id,
      row.creator_context,
      row.creator_name,
      row.timezone,
      row.schedule_expr,
      row.run_at,
      row.is_recurring,
      row.original_expression,
      row.workflow,
      row.workflow_inputs,
      row.output_context,
      row.status,
      row.created_at,
      row.last_run_at,
      row.next_run_at,
      row.run_count,
      row.failure_count,
      row.last_error,
      row.previous_response
    );

    logger.info(
      `[SqliteStore] Created schedule ${newSchedule.id} for user ${newSchedule.creatorId}`
    );

    return newSchedule;
  }

  async importSchedule(schedule: Schedule): Promise<void> {
    const db = this.getDb();
    const row = toDbRow(schedule);

    db.prepare(
      `
      INSERT OR IGNORE INTO schedules (
        id, creator_id, creator_context, creator_name, timezone,
        schedule_expr, run_at, is_recurring, original_expression,
        workflow, workflow_inputs, output_context,
        status, created_at, last_run_at, next_run_at,
        run_count, failure_count, last_error, previous_response
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?
      )
    `
    ).run(
      row.id,
      row.creator_id,
      row.creator_context,
      row.creator_name,
      row.timezone,
      row.schedule_expr,
      row.run_at,
      row.is_recurring,
      row.original_expression,
      row.workflow,
      row.workflow_inputs,
      row.output_context,
      row.status,
      row.created_at,
      row.last_run_at,
      row.next_run_at,
      row.run_count,
      row.failure_count,
      row.last_error,
      row.previous_response
    );
  }

  async get(id: string): Promise<Schedule | undefined> {
    const db = this.getDb();
    const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as
      | ScheduleRow
      | undefined;
    return row ? fromDbRow(row) : undefined;
  }

  async update(id: string, patch: Partial<Schedule>): Promise<Schedule | undefined> {
    const db = this.getDb();

    // Get current row
    const existing = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as
      | ScheduleRow
      | undefined;
    if (!existing) return undefined;

    const current = fromDbRow(existing);
    const updated: Schedule = { ...current, ...patch, id: current.id }; // ID cannot change
    const row = toDbRow(updated);

    db.prepare(
      `
      UPDATE schedules SET
        creator_id = ?, creator_context = ?, creator_name = ?, timezone = ?,
        schedule_expr = ?, run_at = ?, is_recurring = ?, original_expression = ?,
        workflow = ?, workflow_inputs = ?, output_context = ?,
        status = ?, last_run_at = ?, next_run_at = ?,
        run_count = ?, failure_count = ?, last_error = ?, previous_response = ?
      WHERE id = ?
    `
    ).run(
      row.creator_id,
      row.creator_context,
      row.creator_name,
      row.timezone,
      row.schedule_expr,
      row.run_at,
      row.is_recurring,
      row.original_expression,
      row.workflow,
      row.workflow_inputs,
      row.output_context,
      row.status,
      row.last_run_at,
      row.next_run_at,
      row.run_count,
      row.failure_count,
      row.last_error,
      row.previous_response,
      row.id
    );

    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const db = this.getDb();
    const result = db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
    if (result.changes > 0) {
      logger.info(`[SqliteStore] Deleted schedule ${id}`);
      return true;
    }
    return false;
  }

  // --- Queries ---

  async getByCreator(creatorId: string): Promise<Schedule[]> {
    const db = this.getDb();
    const rows = db
      .prepare('SELECT * FROM schedules WHERE creator_id = ?')
      .all(creatorId) as ScheduleRow[];
    return rows.map(fromDbRow);
  }

  async getActiveSchedules(): Promise<Schedule[]> {
    const db = this.getDb();
    const rows = db
      .prepare("SELECT * FROM schedules WHERE status = 'active'")
      .all() as ScheduleRow[];
    return rows.map(fromDbRow);
  }

  async getDueSchedules(now?: number): Promise<Schedule[]> {
    const ts = now ?? Date.now();
    const db = this.getDb();
    const rows = db
      .prepare(
        `SELECT * FROM schedules
         WHERE status = 'active'
         AND (
           (is_recurring = 0 AND run_at IS NOT NULL AND run_at <= ?)
           OR
           (is_recurring = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?)
         )`
      )
      .all(ts, ts) as ScheduleRow[];
    return rows.map(fromDbRow);
  }

  async findByWorkflow(creatorId: string, workflowName: string): Promise<Schedule[]> {
    const db = this.getDb();
    const escaped = workflowName.toLowerCase().replace(/[%_\\]/g, '\\$&');
    const pattern = `%${escaped}%`;
    const rows = db
      .prepare(
        `SELECT * FROM schedules
         WHERE creator_id = ? AND status = 'active'
         AND LOWER(workflow) LIKE ? ESCAPE '\\'`
      )
      .all(creatorId, pattern) as ScheduleRow[];
    return rows.map(fromDbRow);
  }

  async getAll(): Promise<Schedule[]> {
    const db = this.getDb();
    const rows = db.prepare('SELECT * FROM schedules').all() as ScheduleRow[];
    return rows.map(fromDbRow);
  }

  async getStats(): Promise<ScheduleStoreStats> {
    const db = this.getDb();

    const row = db
      .prepare(
        `SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
          SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) as paused,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN is_recurring = 1 THEN 1 ELSE 0 END) as recurring,
          SUM(CASE WHEN is_recurring = 0 THEN 1 ELSE 0 END) as one_time
        FROM schedules`
      )
      .get() as {
      total: number;
      active: number;
      paused: number;
      completed: number;
      failed: number;
      recurring: number;
      one_time: number;
    };

    return {
      total: row.total,
      active: row.active,
      paused: row.paused,
      completed: row.completed,
      failed: row.failed,
      recurring: row.recurring,
      oneTime: row.one_time,
    };
  }

  async validateLimits(
    creatorId: string,
    isRecurring: boolean,
    limits: ScheduleLimits
  ): Promise<void> {
    const db = this.getDb();

    // Global limit
    if (limits.maxGlobal) {
      const row = db.prepare('SELECT COUNT(*) as cnt FROM schedules').get() as { cnt: number };
      if (row.cnt >= limits.maxGlobal) {
        throw new Error(`Global schedule limit reached (${limits.maxGlobal})`);
      }
    }

    // Per-user limit
    if (limits.maxPerUser) {
      const row = db
        .prepare('SELECT COUNT(*) as cnt FROM schedules WHERE creator_id = ?')
        .get(creatorId) as { cnt: number };
      if (row.cnt >= limits.maxPerUser) {
        throw new Error(`You have reached the maximum number of schedules (${limits.maxPerUser})`);
      }
    }

    // Per-user recurring limit
    if (isRecurring && limits.maxRecurringPerUser) {
      const row = db
        .prepare('SELECT COUNT(*) as cnt FROM schedules WHERE creator_id = ? AND is_recurring = 1')
        .get(creatorId) as { cnt: number };
      if (row.cnt >= limits.maxRecurringPerUser) {
        throw new Error(
          `You have reached the maximum number of recurring schedules (${limits.maxRecurringPerUser})`
        );
      }
    }
  }

  // --- HA Locking (in-memory for SQLite — single-node only) ---

  async tryAcquireLock(
    scheduleId: string,
    nodeId: string,
    ttlSeconds: number
  ): Promise<string | null> {
    const now = Date.now();
    const existing = this.locks.get(scheduleId);

    // Check if an unexpired lock exists
    if (existing && existing.expiresAt > now) {
      if (existing.nodeId === nodeId) {
        // Same node: return existing token
        return existing.token;
      }
      // Another node holds the lock
      return null;
    }

    // Acquire lock
    const token = uuidv4();
    this.locks.set(scheduleId, {
      nodeId,
      token,
      expiresAt: now + ttlSeconds * 1000,
    });
    return token;
  }

  async releaseLock(scheduleId: string, lockToken: string): Promise<void> {
    const existing = this.locks.get(scheduleId);
    if (existing && existing.token === lockToken) {
      this.locks.delete(scheduleId);
    }
  }

  async renewLock(scheduleId: string, lockToken: string, ttlSeconds: number): Promise<boolean> {
    const existing = this.locks.get(scheduleId);
    if (!existing || existing.token !== lockToken) {
      return false;
    }
    existing.expiresAt = Date.now() + ttlSeconds * 1000;
    return true;
  }

  async flush(): Promise<void> {
    // No-op for SQLite — writes are synchronous
  }
}
