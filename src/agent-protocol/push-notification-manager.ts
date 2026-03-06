/**
 * PushNotificationManager — delivers webhook push notifications for task events.
 *
 * Persists push notification configs in the task store's SQLite database,
 * and delivers events via HTTP POST with retry logic.
 */

import crypto from 'crypto';
import { logger } from '../logger';
import type {
  AgentPushNotificationConfig,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from './types';

export type PushEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

// ---------------------------------------------------------------------------
// Database interface (minimal subset of better-sqlite3)
// ---------------------------------------------------------------------------

interface PushConfigRow {
  id: string;
  task_id: string;
  url: string;
  token: string | null;
  auth_scheme: string | null;
  auth_credentials: string | null;
  created_at: string;
}

interface DbLike {
  exec(source: string): void;
  prepare(source: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class PushNotificationManager {
  private db: DbLike | null = null;
  private maxRetries: number;
  private baseDelayMs: number;
  private deliveryTimeoutMs: number;

  constructor(options?: { maxRetries?: number; baseDelayMs?: number; deliveryTimeoutMs?: number }) {
    this.maxRetries = options?.maxRetries ?? 3;
    this.baseDelayMs = options?.baseDelayMs ?? 1000;
    this.deliveryTimeoutMs = options?.deliveryTimeoutMs ?? 10_000;
  }

  /**
   * Initialize with a database connection. Must be called before any operations.
   * Creates the push configs table if it doesn't exist.
   */
  initialize(db: DbLike): void {
    this.db = db;
    // Enable foreign key enforcement (must be set per-connection in SQLite)
    db.exec('PRAGMA foreign_keys = ON');
    this.migrateSchema();
  }

  private migrateSchema(): void {
    this.getDb().exec(`
      CREATE TABLE IF NOT EXISTS agent_push_configs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        url TEXT NOT NULL,
        token TEXT,
        auth_scheme TEXT,
        auth_credentials TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_agent_push_task ON agent_push_configs(task_id);
    `);
  }

  private getDb(): DbLike {
    if (!this.db) throw new Error('PushNotificationManager not initialized');
    return this.db;
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  create(config: AgentPushNotificationConfig): AgentPushNotificationConfig {
    const db = this.getDb();
    const id = config.id ?? crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO agent_push_configs (id, task_id, url, token, auth_scheme, auth_credentials, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      config.task_id,
      config.url,
      config.token ?? null,
      config.auth_scheme ?? null,
      config.auth_credentials ?? null,
      now
    );

    return { ...config, id };
  }

  get(taskId: string, configId: string): AgentPushNotificationConfig | null {
    const db = this.getDb();
    const row = db
      .prepare('SELECT * FROM agent_push_configs WHERE id = ? AND task_id = ?')
      .get(configId, taskId) as PushConfigRow | undefined;

    return row ? this.rowToConfig(row) : null;
  }

  list(taskId: string): AgentPushNotificationConfig[] {
    const db = this.getDb();
    const rows = db
      .prepare('SELECT * FROM agent_push_configs WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as PushConfigRow[];

    return rows.map(r => this.rowToConfig(r));
  }

  delete(taskId: string, configId: string): boolean {
    const db = this.getDb();
    const result = db
      .prepare('DELETE FROM agent_push_configs WHERE id = ? AND task_id = ?')
      .run(configId, taskId);
    return result.changes > 0;
  }

  deleteForTask(taskId: string): number {
    const db = this.getDb();
    const result = db.prepare('DELETE FROM agent_push_configs WHERE task_id = ?').run(taskId);
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // Delivery
  // -------------------------------------------------------------------------

  /**
   * Deliver an event to all push configs registered for a task.
   * Uses exponential backoff retry for server errors.
   */
  async notifyAll(taskId: string, event: PushEvent): Promise<void> {
    const configs = this.list(taskId);
    if (configs.length === 0) return;

    const deliveries = configs.map(config => this.deliver(config, event));
    await Promise.allSettled(deliveries);
  }

  private async deliver(config: AgentPushNotificationConfig, event: PushEvent): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.auth_scheme && config.auth_credentials) {
      headers['Authorization'] = `${config.auth_scheme} ${config.auth_credentials}`;
    }

    const body = JSON.stringify(event);

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const resp = await fetch(config.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(this.deliveryTimeoutMs),
        });
        if (resp.ok) return;
        if (resp.status >= 400 && resp.status < 500) {
          // Client error, don't retry
          logger.warn(`Push notification to ${config.url} returned ${resp.status}, not retrying`);
          return;
        }
        // Server error, retry
      } catch (err) {
        logger.warn(
          `Push notification delivery attempt ${attempt + 1} failed for ${config.url}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      if (attempt < this.maxRetries - 1) {
        await new Promise(r => setTimeout(r, this.baseDelayMs * Math.pow(2, attempt)));
      }
    }
    logger.error(
      `Push notification delivery failed after ${this.maxRetries} attempts for task ${config.task_id} to ${config.url}`
    );
  }

  private rowToConfig(row: PushConfigRow): AgentPushNotificationConfig {
    return {
      id: row.id,
      task_id: row.task_id,
      url: row.url,
      token: row.token ?? undefined,
      auth_scheme: row.auth_scheme ?? undefined,
      auth_credentials: row.auth_credentials ?? undefined,
    };
  }
}
