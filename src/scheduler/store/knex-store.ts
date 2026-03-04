/**
 * Unified Knex-backed schedule store for all drivers
 *
 * Supports:
 * - sqlite   (via better-sqlite3 dialect — OSS default, zero-config)
 * - postgresql, mysql, mssql (Enterprise, requires license gating in the factory)
 *
 * Uses Knex query builder for database-agnostic SQL. Schema migration is inline
 * (no external migration files — ncc-safe). SQLite gets WAL mode for better
 * concurrent read performance.
 *
 * HA locking:
 * - SQLite: in-memory Map (single-node only)
 * - Server DBs: distributed via scheduler_locks table
 */
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../logger';
import type { Schedule, ScheduleLimits } from '../schedule-store';
import type {
  ScheduleStoreBackend,
  ScheduleStoreStats,
  StorageConfig,
  HAConfig,
  ServerConnectionConfig,
  SqliteConnectionConfig,
  MessageTrigger,
} from './types';

// Knex types — loaded dynamically to avoid ncc bundling
type Knex = import('knex').Knex;

/**
 * Database row shape (snake_case) for schedules
 */
interface ScheduleRow {
  id: string;
  creator_id: string;
  creator_context: string | null;
  creator_name: string | null;
  timezone: string;
  schedule_expr: string;
  run_at: number | string | null;
  is_recurring: boolean | number;
  original_expression: string;
  workflow: string | null;
  workflow_inputs: string | null;
  output_context: string | null;
  status: string;
  created_at: number | string;
  last_run_at: number | string | null;
  next_run_at: number | string | null;
  run_count: number;
  failure_count: number;
  last_error: string | null;
  previous_response: string | null;
}

/**
 * Database row shape (snake_case) for message triggers
 */
interface TriggerRow {
  id: string;
  creator_id: string;
  creator_context: string | null;
  creator_name: string | null;
  description: string | null;
  channels: string | null;
  from_users: string | null;
  from_bots: boolean | number;
  contains: string | null;
  match_pattern: string | null;
  threads: string;
  workflow: string;
  inputs: string | null;
  output_context: string | null;
  status: string;
  enabled: boolean | number;
  created_at: number | string;
}

// --- Helpers ---

function toNum(val: number | string | null | undefined): number | undefined {
  if (val === null || val === undefined) return undefined;
  return typeof val === 'string' ? parseInt(val, 10) : val;
}

function toBool(val: boolean | number | null | undefined): boolean {
  if (val === null || val === undefined) return false;
  if (typeof val === 'number') return val !== 0;
  return val;
}

function safeJsonParse<T = unknown>(value: string | null | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

// --- Row converters (schedules) ---

function fromScheduleRow(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    creatorId: row.creator_id,
    creatorContext: row.creator_context ?? undefined,
    creatorName: row.creator_name ?? undefined,
    timezone: row.timezone,
    schedule: row.schedule_expr,
    runAt: toNum(row.run_at),
    isRecurring: row.is_recurring === true || row.is_recurring === 1,
    originalExpression: row.original_expression,
    workflow: row.workflow ?? undefined,
    workflowInputs: safeJsonParse(row.workflow_inputs),
    outputContext: safeJsonParse(row.output_context),
    status: row.status as Schedule['status'],
    createdAt: toNum(row.created_at)!,
    lastRunAt: toNum(row.last_run_at),
    nextRunAt: toNum(row.next_run_at),
    runCount: row.run_count,
    failureCount: row.failure_count,
    lastError: row.last_error ?? undefined,
    previousResponse: row.previous_response ?? undefined,
  };
}

function toScheduleInsertRow(schedule: Schedule): Record<string, unknown> {
  return {
    id: schedule.id,
    creator_id: schedule.creatorId,
    creator_context: schedule.creatorContext ?? null,
    creator_name: schedule.creatorName ?? null,
    timezone: schedule.timezone,
    schedule_expr: schedule.schedule,
    run_at: schedule.runAt ?? null,
    is_recurring: schedule.isRecurring,
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

// --- Row converters (message triggers) ---

function fromTriggerRow(row: TriggerRow): MessageTrigger {
  return {
    id: row.id,
    creatorId: row.creator_id,
    creatorContext: row.creator_context ?? undefined,
    creatorName: row.creator_name ?? undefined,
    description: row.description ?? undefined,
    channels: safeJsonParse<string[]>(row.channels),
    fromUsers: safeJsonParse<string[]>(row.from_users),
    fromBots: toBool(row.from_bots),
    contains: safeJsonParse<string[]>(row.contains),
    matchPattern: row.match_pattern ?? undefined,
    threads: row.threads as MessageTrigger['threads'],
    workflow: row.workflow,
    inputs: safeJsonParse<Record<string, unknown>>(row.inputs),
    outputContext: safeJsonParse<MessageTrigger['outputContext']>(row.output_context),
    status: row.status as MessageTrigger['status'],
    enabled: toBool(row.enabled),
    createdAt: toNum(row.created_at)!,
  };
}

function toTriggerInsertRow(trigger: MessageTrigger): Record<string, unknown> {
  return {
    id: trigger.id,
    creator_id: trigger.creatorId,
    creator_context: trigger.creatorContext ?? null,
    creator_name: trigger.creatorName ?? null,
    description: trigger.description ?? null,
    channels: trigger.channels ? JSON.stringify(trigger.channels) : null,
    from_users: trigger.fromUsers ? JSON.stringify(trigger.fromUsers) : null,
    from_bots: trigger.fromBots,
    contains: trigger.contains ? JSON.stringify(trigger.contains) : null,
    match_pattern: trigger.matchPattern ?? null,
    threads: trigger.threads,
    workflow: trigger.workflow,
    inputs: trigger.inputs ? JSON.stringify(trigger.inputs) : null,
    output_context: trigger.outputContext ? JSON.stringify(trigger.outputContext) : null,
    status: trigger.status,
    enabled: trigger.enabled,
    created_at: trigger.createdAt,
  };
}

/**
 * Unified Knex-backed store backend for all drivers
 */
export class KnexStoreBackend implements ScheduleStoreBackend {
  private knex: Knex | null = null;
  private driver: 'sqlite' | 'postgresql' | 'mysql' | 'mssql';
  private storageConfig: StorageConfig;
  // In-memory locks for SQLite (single-node only)
  private locks = new Map<string, { nodeId: string; token: string; expiresAt: number }>();

  constructor(
    driver: 'sqlite' | 'postgresql' | 'mysql' | 'mssql',
    storageConfig: StorageConfig,
    _haConfig?: HAConfig
  ) {
    this.driver = driver;
    this.storageConfig = storageConfig;
  }

  async initialize(): Promise<void> {
    // Load knex dynamically (ncc-safe)
    const { createRequire } = require('module') as typeof import('module');
    const runtimeRequire = createRequire(__filename);

    if (this.driver === 'sqlite') {
      // Ensure parent directories exist for SQLite
      const conn = this.storageConfig.connection as SqliteConnectionConfig | undefined;
      const filename = conn?.filename || '.visor/schedules.db';
      const resolvedPath = path.resolve(process.cwd(), filename);
      const dir = path.dirname(resolvedPath);
      fs.mkdirSync(dir, { recursive: true });

      let knexFactory: typeof import('knex').default;
      try {
        knexFactory = runtimeRequire('knex');
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
          throw new Error(
            'knex is required for schedule storage. Install it with: npm install knex'
          );
        }
        throw err;
      }

      this.knex = knexFactory({
        client: 'better-sqlite3',
        connection: { filename: resolvedPath },
        useNullAsDefault: true,
      });

      // Enable WAL mode for better concurrent reads
      await this.knex.raw('PRAGMA journal_mode = WAL');
    } else {
      // Server-based drivers
      let knexFactory: typeof import('knex').default;
      try {
        knexFactory = runtimeRequire('knex');
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
          throw new Error(
            `knex is required for ${this.driver} schedule storage. Install it with: npm install knex`
          );
        }
        throw err;
      }

      const clientMap: Record<string, string> = {
        postgresql: 'pg',
        mysql: 'mysql2',
        mssql: 'tedious',
      };

      const serverConn = (this.storageConfig.connection || {}) as ServerConnectionConfig;

      // Build connection config
      let connection: string | Record<string, unknown>;
      if (serverConn.connection_string) {
        connection = serverConn.connection_string;
      } else if (this.driver === 'mssql') {
        connection = this.buildMssqlConnection(serverConn);
      } else {
        connection = this.buildStandardConnection(serverConn);
      }

      this.knex = knexFactory({
        client: clientMap[this.driver],
        connection,
        pool: {
          min: serverConn.pool?.min ?? 0,
          max: serverConn.pool?.max ?? 10,
        },
      });
    }

    // Run schema migration (idempotent)
    await this.migrateSchema();

    logger.info(`[KnexStore] Initialized (${this.driver})`);
  }

  private buildStandardConnection(conn: ServerConnectionConfig): Record<string, unknown> {
    return {
      host: conn.host || 'localhost',
      port: conn.port,
      database: conn.database || 'visor',
      user: conn.user,
      password: conn.password,
      ssl: this.resolveSslConfig(conn),
    };
  }

  private buildMssqlConnection(conn: ServerConnectionConfig): Record<string, unknown> {
    const ssl = conn.ssl;
    const sslEnabled = ssl === true || (typeof ssl === 'object' && ssl.enabled !== false);

    return {
      server: conn.host || 'localhost',
      port: conn.port,
      database: conn.database || 'visor',
      user: conn.user,
      password: conn.password,
      options: {
        encrypt: sslEnabled,
        trustServerCertificate:
          typeof ssl === 'object' ? ssl.reject_unauthorized === false : !sslEnabled,
      },
    };
  }

  private resolveSslConfig(conn: ServerConnectionConfig): boolean | Record<string, unknown> {
    const ssl = conn.ssl;
    if (ssl === false || ssl === undefined) return false;
    if (ssl === true) return { rejectUnauthorized: true };

    // Object config
    if (ssl.enabled === false) return false;

    const result: Record<string, unknown> = {
      rejectUnauthorized: ssl.reject_unauthorized !== false,
    };

    if (ssl.ca) {
      const caPath = this.validateSslPath(ssl.ca, 'CA certificate');
      result.ca = fs.readFileSync(caPath, 'utf8');
    }
    if (ssl.cert) {
      const certPath = this.validateSslPath(ssl.cert, 'client certificate');
      result.cert = fs.readFileSync(certPath, 'utf8');
    }
    if (ssl.key) {
      const keyPath = this.validateSslPath(ssl.key, 'client key');
      result.key = fs.readFileSync(keyPath, 'utf8');
    }

    return result;
  }

  private validateSslPath(filePath: string, label: string): string {
    const resolved = path.resolve(filePath);
    if (resolved !== path.normalize(resolved)) {
      throw new Error(`SSL ${label} path contains invalid sequences: ${filePath}`);
    }
    if (!fs.existsSync(resolved)) {
      throw new Error(`SSL ${label} not found: ${filePath}`);
    }
    return resolved;
  }

  async shutdown(): Promise<void> {
    if (this.knex) {
      await this.knex.destroy();
      this.knex = null;
    }
    this.locks.clear();
  }

  // --- Schema Migration ---

  private async migrateSchema(): Promise<void> {
    const knex = this.getKnex();

    const schedulesExist = await knex.schema.hasTable('schedules');
    if (!schedulesExist) {
      await knex.schema.createTable('schedules', table => {
        table.string('id', 36).primary();
        table.string('creator_id', 255).notNullable().index();
        table.string('creator_context', 255);
        table.string('creator_name', 255);
        table.string('timezone', 64).notNullable().defaultTo('UTC');
        table.string('schedule_expr', 255);
        table.bigInteger('run_at');
        table.boolean('is_recurring').notNullable();
        table.text('original_expression');
        table.string('workflow', 255);
        table.text('workflow_inputs');
        table.text('output_context');
        table.string('status', 20).notNullable().index();
        table.bigInteger('created_at').notNullable();
        table.bigInteger('last_run_at');
        table.bigInteger('next_run_at');
        table.integer('run_count').notNullable().defaultTo(0);
        table.integer('failure_count').notNullable().defaultTo(0);
        table.text('last_error');
        table.text('previous_response');

        table.index(['status', 'next_run_at']);
      });
    }

    // Create scheduler_locks table for distributed locking
    const locksExist = await knex.schema.hasTable('scheduler_locks');
    if (!locksExist) {
      await knex.schema.createTable('scheduler_locks', table => {
        table.string('lock_id', 255).primary();
        table.string('node_id', 255).notNullable();
        table.string('lock_token', 36).notNullable();
        table.bigInteger('acquired_at').notNullable();
        table.bigInteger('expires_at').notNullable();
      });
    }

    // Create message_triggers table
    const triggersExist = await knex.schema.hasTable('message_triggers');
    if (!triggersExist) {
      await knex.schema.createTable('message_triggers', table => {
        table.string('id', 36).primary();
        table.string('creator_id', 255).notNullable().index();
        table.string('creator_context', 255);
        table.string('creator_name', 255);
        table.text('description');
        table.text('channels');
        table.text('from_users');
        table.boolean('from_bots').notNullable().defaultTo(false);
        table.text('contains');
        table.text('match_pattern');
        table.string('threads', 20).notNullable().defaultTo('any');
        table.string('workflow', 255).notNullable();
        table.text('inputs');
        table.text('output_context');
        table.string('status', 20).notNullable().defaultTo('active').index();
        table.boolean('enabled').notNullable().defaultTo(true);
        table.bigInteger('created_at').notNullable();
      });
    }
  }

  private getKnex(): Knex {
    if (!this.knex) {
      throw new Error('[KnexStore] Not initialized. Call initialize() first.');
    }
    return this.knex;
  }

  /** Whether this is an MSSQL driver (booleans are numeric 0/1) */
  private isMssql(): boolean {
    return this.driver === 'mssql';
  }

  /** Whether this is a SQLite driver (uses in-memory locking) */
  private isSqlite(): boolean {
    return this.driver === 'sqlite';
  }

  // --- CRUD (Schedules) ---

  async create(
    schedule: Omit<Schedule, 'id' | 'createdAt' | 'runCount' | 'failureCount' | 'status'>
  ): Promise<Schedule> {
    const knex = this.getKnex();

    const newSchedule: Schedule = {
      ...schedule,
      id: uuidv4(),
      createdAt: Date.now(),
      runCount: 0,
      failureCount: 0,
      status: 'active',
    };

    await knex('schedules').insert(toScheduleInsertRow(newSchedule));

    logger.info(`[KnexStore] Created schedule ${newSchedule.id} for user ${newSchedule.creatorId}`);
    return newSchedule;
  }

  async importSchedule(schedule: Schedule): Promise<void> {
    const knex = this.getKnex();
    const existing = await knex('schedules').where('id', schedule.id).first();
    if (existing) return; // Already imported (idempotent)
    await knex('schedules').insert(toScheduleInsertRow(schedule));
  }

  async get(id: string): Promise<Schedule | undefined> {
    const knex = this.getKnex();
    const row = await knex('schedules').where('id', id).first();
    return row ? fromScheduleRow(row as ScheduleRow) : undefined;
  }

  async update(id: string, patch: Partial<Schedule>): Promise<Schedule | undefined> {
    const knex = this.getKnex();

    const existing = await knex('schedules').where('id', id).first();
    if (!existing) return undefined;

    const current = fromScheduleRow(existing as ScheduleRow);
    const updated: Schedule = { ...current, ...patch, id: current.id };
    const row = toScheduleInsertRow(updated);
    // Remove id from update (PK cannot change)
    delete (row as Record<string, unknown>).id;

    await knex('schedules').where('id', id).update(row);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const knex = this.getKnex();
    const deleted = await knex('schedules').where('id', id).del();
    if (deleted > 0) {
      logger.info(`[KnexStore] Deleted schedule ${id}`);
      return true;
    }
    return false;
  }

  // --- Queries (Schedules) ---

  async getByCreator(creatorId: string): Promise<Schedule[]> {
    const knex = this.getKnex();
    const rows = await knex('schedules').where('creator_id', creatorId);
    return rows.map((r: ScheduleRow) => fromScheduleRow(r));
  }

  async getActiveSchedules(): Promise<Schedule[]> {
    const knex = this.getKnex();
    const rows = await knex('schedules').where('status', 'active');
    return rows.map((r: ScheduleRow) => fromScheduleRow(r));
  }

  async getDueSchedules(now?: number): Promise<Schedule[]> {
    const ts = now ?? Date.now();
    const knex = this.getKnex();
    const bFalse = this.isMssql() ? 0 : false;
    const bTrue = this.isMssql() ? 1 : true;
    const rows = await knex('schedules')
      .where('status', 'active')
      .andWhere(function () {
        this.where(function () {
          this.where('is_recurring', bFalse as unknown as boolean)
            .whereNotNull('run_at')
            .where('run_at', '<=', ts);
        }).orWhere(function () {
          this.where('is_recurring', bTrue as unknown as boolean)
            .whereNotNull('next_run_at')
            .where('next_run_at', '<=', ts);
        });
      });
    return rows.map((r: ScheduleRow) => fromScheduleRow(r));
  }

  async findByWorkflow(creatorId: string, workflowName: string): Promise<Schedule[]> {
    const knex = this.getKnex();
    const escaped = workflowName.toLowerCase().replace(/[%_\\]/g, '\\$&');
    const pattern = `%${escaped}%`;
    const rows = await knex('schedules')
      .where('creator_id', creatorId)
      .where('status', 'active')
      .whereRaw("LOWER(workflow) LIKE ? ESCAPE '\\'", [pattern]);
    return rows.map((r: ScheduleRow) => fromScheduleRow(r));
  }

  async getAll(): Promise<Schedule[]> {
    const knex = this.getKnex();
    const rows = await knex('schedules');
    return rows.map((r: ScheduleRow) => fromScheduleRow(r));
  }

  async getStats(): Promise<ScheduleStoreStats> {
    const knex = this.getKnex();
    const boolTrue = this.isMssql() ? '1' : 'true';
    const boolFalse = this.isMssql() ? '0' : 'false';
    const result = await knex('schedules')
      .select(
        knex.raw('COUNT(*) as total'),
        knex.raw("SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active"),
        knex.raw("SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) as paused"),
        knex.raw("SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed"),
        knex.raw("SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed"),
        knex.raw(`SUM(CASE WHEN is_recurring = ${boolTrue} THEN 1 ELSE 0 END) as recurring`),
        knex.raw(`SUM(CASE WHEN is_recurring = ${boolFalse} THEN 1 ELSE 0 END) as one_time`)
      )
      .first();

    return {
      total: Number(result.total) || 0,
      active: Number(result.active) || 0,
      paused: Number(result.paused) || 0,
      completed: Number(result.completed) || 0,
      failed: Number(result.failed) || 0,
      recurring: Number(result.recurring) || 0,
      oneTime: Number(result.one_time) || 0,
    };
  }

  async validateLimits(
    creatorId: string,
    isRecurring: boolean,
    limits: ScheduleLimits
  ): Promise<void> {
    const knex = this.getKnex();

    if (limits.maxGlobal) {
      const result = await knex('schedules').count('* as cnt').first();
      if (Number(result?.cnt) >= limits.maxGlobal) {
        throw new Error(`Global schedule limit reached (${limits.maxGlobal})`);
      }
    }

    if (limits.maxPerUser) {
      const result = await knex('schedules')
        .where('creator_id', creatorId)
        .count('* as cnt')
        .first();
      if (Number(result?.cnt) >= limits.maxPerUser) {
        throw new Error(`You have reached the maximum number of schedules (${limits.maxPerUser})`);
      }
    }

    if (isRecurring && limits.maxRecurringPerUser) {
      const bTrue = this.isMssql() ? 1 : true;
      const result = await knex('schedules')
        .where('creator_id', creatorId)
        .where('is_recurring', bTrue as unknown as boolean)
        .count('* as cnt')
        .first();
      if (Number(result?.cnt) >= limits.maxRecurringPerUser) {
        throw new Error(
          `You have reached the maximum number of recurring schedules (${limits.maxRecurringPerUser})`
        );
      }
    }
  }

  // --- HA Locking ---

  async tryAcquireLock(
    scheduleId: string,
    nodeId: string,
    ttlSeconds: number
  ): Promise<string | null> {
    if (this.isSqlite()) {
      return this.tryAcquireLockInMemory(scheduleId, nodeId, ttlSeconds);
    }
    return this.tryAcquireLockDistributed(scheduleId, nodeId, ttlSeconds);
  }

  async releaseLock(scheduleId: string, lockToken: string): Promise<void> {
    if (this.isSqlite()) {
      return this.releaseLockInMemory(scheduleId, lockToken);
    }
    return this.releaseLockDistributed(scheduleId, lockToken);
  }

  async renewLock(scheduleId: string, lockToken: string, ttlSeconds: number): Promise<boolean> {
    if (this.isSqlite()) {
      return this.renewLockInMemory(scheduleId, lockToken, ttlSeconds);
    }
    return this.renewLockDistributed(scheduleId, lockToken, ttlSeconds);
  }

  // In-memory locking (SQLite)

  private tryAcquireLockInMemory(
    scheduleId: string,
    nodeId: string,
    ttlSeconds: number
  ): Promise<string | null> {
    const now = Date.now();
    const existing = this.locks.get(scheduleId);

    if (existing && existing.expiresAt > now) {
      if (existing.nodeId === nodeId) {
        return Promise.resolve(existing.token);
      }
      return Promise.resolve(null);
    }

    const token = uuidv4();
    this.locks.set(scheduleId, {
      nodeId,
      token,
      expiresAt: now + ttlSeconds * 1000,
    });
    return Promise.resolve(token);
  }

  private releaseLockInMemory(scheduleId: string, lockToken: string): Promise<void> {
    const existing = this.locks.get(scheduleId);
    if (existing && existing.token === lockToken) {
      this.locks.delete(scheduleId);
    }
    return Promise.resolve();
  }

  private renewLockInMemory(
    scheduleId: string,
    lockToken: string,
    ttlSeconds: number
  ): Promise<boolean> {
    const existing = this.locks.get(scheduleId);
    if (!existing || existing.token !== lockToken) {
      return Promise.resolve(false);
    }
    existing.expiresAt = Date.now() + ttlSeconds * 1000;
    return Promise.resolve(true);
  }

  // Distributed locking (PostgreSQL / MySQL / MSSQL)

  private async tryAcquireLockDistributed(
    lockId: string,
    nodeId: string,
    ttlSeconds: number
  ): Promise<string | null> {
    const knex = this.getKnex();
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;
    const token = uuidv4();

    // Step 1: Try to claim an existing expired lock
    const updated = await knex('scheduler_locks')
      .where('lock_id', lockId)
      .where('expires_at', '<', now)
      .update({
        node_id: nodeId,
        lock_token: token,
        acquired_at: now,
        expires_at: expiresAt,
      });

    if (updated > 0) return token;

    // Step 2: Try to INSERT a new lock row
    try {
      await knex('scheduler_locks').insert({
        lock_id: lockId,
        node_id: nodeId,
        lock_token: token,
        acquired_at: now,
        expires_at: expiresAt,
      });
      return token;
    } catch {
      // Unique constraint violation — another node holds the lock
      return null;
    }
  }

  private async releaseLockDistributed(lockId: string, lockToken: string): Promise<void> {
    const knex = this.getKnex();
    await knex('scheduler_locks').where('lock_id', lockId).where('lock_token', lockToken).del();
  }

  private async renewLockDistributed(
    lockId: string,
    lockToken: string,
    ttlSeconds: number
  ): Promise<boolean> {
    const knex = this.getKnex();
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;

    const updated = await knex('scheduler_locks')
      .where('lock_id', lockId)
      .where('lock_token', lockToken)
      .update({ acquired_at: now, expires_at: expiresAt });

    return updated > 0;
  }

  async flush(): Promise<void> {
    // No-op for all backends — Knex writes are immediate
  }

  // --- Message Trigger CRUD ---

  async createTrigger(trigger: Omit<MessageTrigger, 'id' | 'createdAt'>): Promise<MessageTrigger> {
    const knex = this.getKnex();

    const newTrigger: MessageTrigger = {
      ...trigger,
      id: uuidv4(),
      createdAt: Date.now(),
    };

    await knex('message_triggers').insert(toTriggerInsertRow(newTrigger));

    logger.info(
      `[KnexStore] Created message trigger ${newTrigger.id} for user ${newTrigger.creatorId}`
    );
    return newTrigger;
  }

  async getTrigger(id: string): Promise<MessageTrigger | undefined> {
    const knex = this.getKnex();
    const row = await knex('message_triggers').where('id', id).first();
    return row ? fromTriggerRow(row as TriggerRow) : undefined;
  }

  async updateTrigger(
    id: string,
    patch: Partial<MessageTrigger>
  ): Promise<MessageTrigger | undefined> {
    const knex = this.getKnex();

    const existing = await knex('message_triggers').where('id', id).first();
    if (!existing) return undefined;

    const current = fromTriggerRow(existing as TriggerRow);
    const updated: MessageTrigger = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
    };
    const row = toTriggerInsertRow(updated);
    // Remove id from update (PK cannot change)
    delete (row as Record<string, unknown>).id;

    await knex('message_triggers').where('id', id).update(row);
    return updated;
  }

  async deleteTrigger(id: string): Promise<boolean> {
    const knex = this.getKnex();
    const deleted = await knex('message_triggers').where('id', id).del();
    return deleted > 0;
  }

  async getTriggersByCreator(creatorId: string): Promise<MessageTrigger[]> {
    const knex = this.getKnex();
    const rows = await knex('message_triggers')
      .where('creator_id', creatorId)
      .orderBy('created_at', 'desc');
    return rows.map((r: TriggerRow) => fromTriggerRow(r));
  }

  async getActiveTriggers(): Promise<MessageTrigger[]> {
    const knex = this.getKnex();
    const enabledValue = this.isMssql() ? 1 : true;
    const rows = await knex('message_triggers')
      .where('status', 'active')
      .where('enabled', enabledValue as unknown as boolean);
    return rows.map((r: TriggerRow) => fromTriggerRow(r));
  }
}
