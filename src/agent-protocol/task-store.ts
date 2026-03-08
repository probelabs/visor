/**
 * Persistent task store for agent protocol tasks.
 *
 * SQLite-backed (reuses the better-sqlite3 pattern from scheduler).
 * Stores agent tasks with full state machine enforcement.
 */

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { logger } from '../logger';
import {
  AgentTask,
  AgentMessage,
  AgentArtifact,
  AgentSendMessageConfig,
  TaskState,
  TaskNotFoundError,
  ContextMismatchError,
} from './types';
import { assertValidTransition } from './state-transitions';

// ---------------------------------------------------------------------------
// better-sqlite3 type declarations (avoid compile-time import)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Database row shape
// ---------------------------------------------------------------------------

interface TaskRow {
  id: string;
  context_id: string;
  state: string;
  created_at: string;
  updated_at: string;
  request_message: string; // JSON
  request_config: string | null; // JSON
  request_metadata: string | null; // JSON
  status_message: string | null; // JSON
  artifacts: string; // JSON array
  history: string; // JSON array
  workflow_id: string | null;
  run_id: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  expires_at: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeJsonParse<T = unknown>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function nowISO(): string {
  return new Date().toISOString();
}

function taskRowToAgentTask(row: TaskRow): AgentTask {
  return {
    id: row.id,
    context_id: row.context_id,
    status: {
      state: row.state as TaskState,
      message: safeJsonParse<AgentMessage>(row.status_message),
      timestamp: row.updated_at,
    },
    artifacts: safeJsonParse<AgentArtifact[]>(row.artifacts) ?? [],
    history: safeJsonParse<AgentMessage[]>(row.history) ?? [],
    metadata: safeJsonParse<Record<string, unknown>>(row.request_metadata),
    workflow_id: row.workflow_id ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// TaskStore Interface
// ---------------------------------------------------------------------------

export interface CreateTaskParams {
  contextId: string;
  requestMessage: AgentMessage;
  requestConfig?: AgentSendMessageConfig;
  requestMetadata?: Record<string, unknown>;
  workflowId?: string;
  expiresAt?: string; // ISO 8601
}

export interface ListTasksFilter {
  contextId?: string;
  state?: TaskState[];
  workflowId?: string;
  limit?: number; // default 50, max 200
  offset?: number;
}

/** Raw task row for queue monitoring — includes claim metadata. */
export interface TaskQueueRow {
  id: string;
  context_id: string;
  state: TaskState;
  created_at: string;
  updated_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
  workflow_id: string | null;
  run_id: string | null;
  request_message: string; // first message text (extracted)
  source: string; // extracted from request_metadata.source
  metadata: Record<string, unknown>; // full request_metadata
}

export interface ListTasksResult {
  tasks: AgentTask[];
  total: number;
}

export interface TaskStore {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;

  // CRUD
  createTask(params: CreateTaskParams): AgentTask;
  getTask(taskId: string): AgentTask | null;
  listTasks(filter: ListTasksFilter): ListTasksResult;

  // State mutations
  updateTaskState(taskId: string, newState: TaskState, statusMessage?: AgentMessage): void;
  /** Set claimed_by/claimed_at on a task (used by trackExecution to record instance ID). */
  claimTask(taskId: string, workerId: string): void;
  addArtifact(taskId: string, artifact: AgentArtifact): void;
  appendHistory(taskId: string, message: AgentMessage): void;
  setRunId(taskId: string, runId: string): void;

  // Queue operations (Milestone 4)
  claimNextSubmitted(workerId: string): AgentTask | null;
  reclaimStaleTasks(workerId: string, staleTimeoutMs?: number): AgentTask[];
  releaseClaim(taskId: string): void;

  // Queue monitoring (optional — only SqliteTaskStore implements this)
  listTasksRaw?(filter: ListTasksFilter): { rows: TaskQueueRow[]; total: number };

  // Cleanup
  deleteExpiredTasks(): string[];
  deleteTask(taskId: string): void;
}

// ---------------------------------------------------------------------------
// SQLite Implementation
// ---------------------------------------------------------------------------

export class SqliteTaskStore implements TaskStore {
  private db: BetterSqliteDatabase | null = null;
  private dbPath: string;

  constructor(filename?: string) {
    this.dbPath = filename || '.visor/agent-tasks.db';
  }

  async initialize(): Promise<void> {
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
          'better-sqlite3 is required for agent protocol task storage. ' +
            'Install it with: npm install better-sqlite3'
        );
      }
      throw err;
    }

    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.migrateSchema();
    logger.info(`[AgentTaskStore] Initialized at ${this.dbPath}`);
  }

  async shutdown(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private getDb(): BetterSqliteDatabase {
    if (!this.db) throw new Error('TaskStore not initialized');
    return this.db;
  }

  /** Expose the underlying database for sibling managers (e.g. PushNotificationManager). */
  getDatabase(): unknown {
    return this.getDb();
  }

  private migrateSchema(): void {
    const db = this.getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'submitted',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        request_message TEXT NOT NULL,
        request_config TEXT,
        request_metadata TEXT,
        status_message TEXT,
        artifacts TEXT DEFAULT '[]',
        history TEXT DEFAULT '[]',
        workflow_id TEXT,
        run_id TEXT,
        claimed_by TEXT,
        claimed_at TEXT,
        expires_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_agent_tasks_context ON agent_tasks(context_id);
      CREATE INDEX IF NOT EXISTS idx_agent_tasks_state ON agent_tasks(state);
      CREATE INDEX IF NOT EXISTS idx_agent_tasks_updated ON agent_tasks(updated_at);
      CREATE INDEX IF NOT EXISTS idx_agent_tasks_claim ON agent_tasks(state, claimed_by, claimed_at);
      CREATE INDEX IF NOT EXISTS idx_agent_tasks_expires ON agent_tasks(expires_at);
    `);
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  createTask(params: CreateTaskParams): AgentTask {
    const db = this.getDb();
    const id = crypto.randomUUID();
    const now = nowISO();
    const contextId = this.resolveContextId(params.requestMessage, params.contextId);

    const expiresAt = params.expiresAt ?? null;

    db.prepare(
      `INSERT INTO agent_tasks
        (id, context_id, state, created_at, updated_at,
         request_message, request_config, request_metadata,
         workflow_id, expires_at, artifacts, history)
       VALUES (?, ?, 'submitted', ?, ?,
         ?, ?, ?,
         ?, ?, '[]', '[]')`
    ).run(
      id,
      contextId,
      now,
      now,
      JSON.stringify(params.requestMessage),
      params.requestConfig ? JSON.stringify(params.requestConfig) : null,
      params.requestMetadata ? JSON.stringify(params.requestMetadata) : null,
      params.workflowId ?? null,
      expiresAt
    );

    return {
      id,
      context_id: contextId,
      status: { state: 'submitted', timestamp: now },
      artifacts: [],
      history: [],
      metadata: params.requestMetadata,
      workflow_id: params.workflowId,
    };
  }

  getTask(taskId: string): AgentTask | null {
    const db = this.getDb();
    const row = db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(taskId) as
      | TaskRow
      | undefined;
    return row ? taskRowToAgentTask(row) : null;
  }

  private buildFilterClause(filter: ListTasksFilter): { where: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.contextId) {
      conditions.push('context_id = ?');
      params.push(filter.contextId);
    }
    if (filter.state && filter.state.length > 0) {
      const placeholders = filter.state.map(() => '?').join(', ');
      conditions.push(`state IN (${placeholders})`);
      params.push(...filter.state);
    }
    if (filter.workflowId) {
      conditions.push('workflow_id = ?');
      params.push(filter.workflowId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return { where, params };
  }

  listTasks(filter: ListTasksFilter): ListTasksResult {
    const db = this.getDb();
    const { where, params } = this.buildFilterClause(filter);

    const countRow = db
      .prepare(`SELECT COUNT(*) as total FROM agent_tasks ${where}`)
      .get(...params) as { total: number };
    const total = countRow.total;

    const limit = Math.min(filter.limit ?? 50, 200);
    const offset = filter.offset ?? 0;
    const rows = db
      .prepare(`SELECT * FROM agent_tasks ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as TaskRow[];

    return {
      tasks: rows.map(taskRowToAgentTask),
      total,
    };
  }

  listTasksRaw(filter: ListTasksFilter): { rows: TaskQueueRow[]; total: number } {
    const db = this.getDb();
    const { where, params } = this.buildFilterClause(filter);

    const countRow = db
      .prepare(`SELECT COUNT(*) as total FROM agent_tasks ${where}`)
      .get(...params) as { total: number };
    const total = countRow.total;

    const limit = Math.min(filter.limit ?? 50, 200);
    const offset = filter.offset ?? 0;
    const rawRows = db
      .prepare(`SELECT * FROM agent_tasks ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as TaskRow[];

    const rows: TaskQueueRow[] = rawRows.map(r => {
      let messageText = '';
      try {
        const msg = JSON.parse(r.request_message);
        const parts = msg.parts ?? msg.content?.parts ?? [];
        const textPart = parts.find((p: any) => p.type === 'text' || typeof p.text === 'string');
        messageText = textPart?.text ?? '';
      } catch {}
      let source = '-';
      let metadata: Record<string, unknown> = {};
      try {
        metadata = JSON.parse(r.request_metadata || '{}');
        source = (metadata.source as string) || '-';
      } catch {}
      return {
        id: r.id,
        context_id: r.context_id,
        state: r.state as TaskState,
        created_at: r.created_at,
        updated_at: r.updated_at,
        claimed_by: r.claimed_by,
        claimed_at: r.claimed_at,
        workflow_id: r.workflow_id,
        run_id: r.run_id,
        request_message: messageText,
        source,
        metadata,
      };
    });

    return { rows, total };
  }

  // -------------------------------------------------------------------------
  // State mutations
  // -------------------------------------------------------------------------

  updateTaskState(taskId: string, newState: TaskState, statusMessage?: AgentMessage): void {
    const db = this.getDb();
    const row = db.prepare('SELECT state FROM agent_tasks WHERE id = ?').get(taskId) as
      | { state: string }
      | undefined;

    if (!row) throw new TaskNotFoundError(taskId);

    assertValidTransition(row.state as TaskState, newState);

    const now = nowISO();
    db.prepare(
      `UPDATE agent_tasks
       SET state = ?, updated_at = ?, status_message = ?
       WHERE id = ?`
    ).run(newState, now, statusMessage ? JSON.stringify(statusMessage) : null, taskId);
  }

  claimTask(taskId: string, workerId: string): void {
    const db = this.getDb();
    const now = nowISO();
    db.prepare(
      `UPDATE agent_tasks SET claimed_by = ?, claimed_at = ?, updated_at = ? WHERE id = ?`
    ).run(workerId, now, now, taskId);
  }

  addArtifact(taskId: string, artifact: AgentArtifact): void {
    const db = this.getDb();
    const row = db.prepare('SELECT artifacts FROM agent_tasks WHERE id = ?').get(taskId) as
      | { artifacts: string }
      | undefined;

    if (!row) throw new TaskNotFoundError(taskId);

    const artifacts = safeJsonParse<AgentArtifact[]>(row.artifacts) ?? [];
    artifacts.push(artifact);

    db.prepare('UPDATE agent_tasks SET artifacts = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(artifacts),
      nowISO(),
      taskId
    );
  }

  appendHistory(taskId: string, message: AgentMessage): void {
    const db = this.getDb();
    const row = db.prepare('SELECT history FROM agent_tasks WHERE id = ?').get(taskId) as
      | { history: string }
      | undefined;

    if (!row) throw new TaskNotFoundError(taskId);

    const history = safeJsonParse<AgentMessage[]>(row.history) ?? [];
    history.push(message);

    db.prepare('UPDATE agent_tasks SET history = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(history),
      nowISO(),
      taskId
    );
  }

  setRunId(taskId: string, runId: string): void {
    const db = this.getDb();
    const result = db
      .prepare('UPDATE agent_tasks SET run_id = ?, updated_at = ? WHERE id = ?')
      .run(runId, nowISO(), taskId);

    if (result.changes === 0) throw new TaskNotFoundError(taskId);
  }

  // -------------------------------------------------------------------------
  // Queue operations
  // -------------------------------------------------------------------------

  claimNextSubmitted(workerId: string): AgentTask | null {
    const db = this.getDb();
    const now = nowISO();

    // Atomic claim: find oldest unclaimed SUBMITTED task only.
    // Does NOT touch 'working' tasks — those are handled separately by
    // reclaimStaleTasks() to avoid reclaiming genuinely-running long tasks.
    const row = db
      .prepare(
        `UPDATE agent_tasks
         SET state = 'working', claimed_by = ?, claimed_at = ?, updated_at = ?
         WHERE id = (
           SELECT id FROM agent_tasks
           WHERE state = 'submitted'
           AND claimed_by IS NULL
           ORDER BY created_at ASC
           LIMIT 1
         )
         RETURNING *`
      )
      .get(workerId, now, now) as TaskRow | undefined;

    return row ? taskRowToAgentTask(row) : null;
  }

  reclaimStaleTasks(_workerId: string, staleTimeoutMs?: number): AgentTask[] {
    const db = this.getDb();
    const now = nowISO();
    const staleTimeoutSec = Math.floor((staleTimeoutMs ?? 300_000) / 1000);

    // Reclaim tasks stuck in 'working' state whose claim has expired.
    // Resets them to 'submitted' so they re-enter the normal claim queue.
    const rows = db
      .prepare(
        `UPDATE agent_tasks
         SET state = 'submitted', claimed_by = NULL, claimed_at = NULL, updated_at = ?
         WHERE state = 'working'
         AND claimed_at IS NOT NULL
         AND claimed_at < datetime('now', '-' || ? || ' seconds')
         RETURNING *`
      )
      .all(now, staleTimeoutSec) as TaskRow[];

    return rows.map(taskRowToAgentTask);
  }

  releaseClaim(taskId: string): void {
    const db = this.getDb();
    db.prepare(
      `UPDATE agent_tasks
       SET state = 'submitted', claimed_by = NULL, claimed_at = NULL, updated_at = ?
       WHERE id = ? AND state = 'working'`
    ).run(nowISO(), taskId);
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  deleteExpiredTasks(): string[] {
    const db = this.getDb();
    const now = nowISO();

    // Collect IDs first so callers can cascade-delete related data (e.g. push configs)
    const rows = db
      .prepare('SELECT id FROM agent_tasks WHERE expires_at IS NOT NULL AND expires_at < ?')
      .all(now) as { id: string }[];

    if (rows.length > 0) {
      db.prepare('DELETE FROM agent_tasks WHERE expires_at IS NOT NULL AND expires_at < ?').run(
        now
      );
    }

    return rows.map(r => r.id);
  }

  deleteTask(taskId: string): void {
    const db = this.getDb();
    db.prepare('DELETE FROM agent_tasks WHERE id = ?').run(taskId);
  }

  // -------------------------------------------------------------------------
  // Context ID resolution
  // -------------------------------------------------------------------------

  private resolveContextId(message: AgentMessage, providedContextId: string): string {
    // If message has task_id, check for context consistency
    if (message.task_id) {
      const existingTask = this.getTask(message.task_id);
      if (existingTask) {
        if (message.context_id && message.context_id !== existingTask.context_id) {
          throw new ContextMismatchError(message.context_id, existingTask.context_id);
        }
        return existingTask.context_id;
      }
    }

    // Use message context_id if provided, otherwise use the provided contextId param
    return message.context_id ?? providedContextId;
  }
}
