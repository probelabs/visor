/**
 * Copyright (c) ProbeLabs. All rights reserved.
 * Licensed under the Elastic License 2.0; you may not use this file except
 * in compliance with the Elastic License 2.0.
 */

/**
 * Knex-backed schedule store for PostgreSQL, MySQL, and MSSQL (Enterprise)
 *
 * Uses Knex query builder for database-agnostic SQL. Same schema as SQLite backend
 * but with real distributed locking via row-level claims (claimed_by/claimed_at/lock_token).
 */
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../logger';
import type { Schedule, ScheduleLimits } from '../../scheduler/schedule-store';
import type {
  ScheduleStoreBackend,
  ScheduleStoreStats,
  StorageConfig,
  HAConfig,
  ServerConnectionConfig,
  MessageTrigger,
} from '../../scheduler/store/types';

// Knex types — loaded dynamically to avoid ncc bundling
type Knex = import('knex').Knex;

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

function toNum(val: number | string | null | undefined): number | undefined {
  if (val === null || val === undefined) return undefined;
  return typeof val === 'string' ? parseInt(val, 10) : val;
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
 * Database row shape for message_triggers (snake_case)
 */
interface MessageTriggerRow {
  id: string;
  creator_id: string;
  creator_context: string | null;
  creator_name: string | null;
  description: string | null;
  channels: string | null; // JSON array
  from_users: string | null; // JSON array
  from_bots: boolean | number;
  contains: string | null; // JSON array
  match_pattern: string | null;
  threads: string;
  workflow: string;
  inputs: string | null; // JSON
  output_context: string | null; // JSON
  status: string;
  enabled: boolean | number;
  created_at: number | string;
}

function fromTriggerRow(row: MessageTriggerRow): MessageTrigger {
  return {
    id: row.id,
    creatorId: row.creator_id,
    creatorContext: row.creator_context ?? undefined,
    creatorName: row.creator_name ?? undefined,
    description: row.description ?? undefined,
    channels: safeJsonParse<string[]>(row.channels),
    fromUsers: safeJsonParse<string[]>(row.from_users),
    fromBots: row.from_bots === true || row.from_bots === 1,
    contains: safeJsonParse<string[]>(row.contains),
    matchPattern: row.match_pattern ?? undefined,
    threads: row.threads as MessageTrigger['threads'],
    workflow: row.workflow,
    inputs: safeJsonParse<Record<string, unknown>>(row.inputs),
    outputContext: safeJsonParse<MessageTrigger['outputContext']>(row.output_context),
    status: row.status as MessageTrigger['status'],
    enabled: row.enabled === true || row.enabled === 1,
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

function fromDbRow(row: ScheduleRow): Schedule {
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

function toInsertRow(schedule: Schedule): Record<string, unknown> {
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

/**
 * Enterprise Knex-backed store for PostgreSQL, MySQL, and MSSQL
 */
export class KnexStoreBackend implements ScheduleStoreBackend {
  private knex: Knex | null = null;
  private driver: 'postgresql' | 'mysql' | 'mssql';
  private connection: ServerConnectionConfig;

  constructor(
    driver: 'postgresql' | 'mysql' | 'mssql',
    storageConfig: StorageConfig,
    _haConfig?: HAConfig
  ) {
    this.driver = driver;
    this.connection = (storageConfig.connection || {}) as ServerConnectionConfig;
  }

  async initialize(): Promise<void> {
    // Load knex dynamically
    const { createRequire } = require('module') as typeof import('module');
    const runtimeRequire = createRequire(__filename);
    let knexFactory: typeof import('knex').default;
    try {
      knexFactory = runtimeRequire('knex');
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
        throw new Error(
          'knex is required for PostgreSQL/MySQL/MSSQL schedule storage. ' +
            'Install it with: npm install knex'
        );
      }
      throw err;
    }

    const clientMap: Record<string, string> = {
      postgresql: 'pg',
      mysql: 'mysql2',
      mssql: 'tedious',
    };
    const client = clientMap[this.driver];

    // Build connection config
    let connection: string | Record<string, unknown>;
    if (this.connection.connection_string) {
      connection = this.connection.connection_string;
    } else if (this.driver === 'mssql') {
      connection = this.buildMssqlConnection();
    } else {
      connection = this.buildStandardConnection();
    }

    this.knex = knexFactory({
      client,
      connection,
      pool: {
        min: this.connection.pool?.min ?? 0,
        max: this.connection.pool?.max ?? 10,
      },
    });

    // Run schema migration
    await this.migrateSchema();

    logger.info(`[KnexStore] Initialized (${this.driver})`);
  }

  private buildStandardConnection(): Record<string, unknown> {
    return {
      host: this.connection.host || 'localhost',
      port: this.connection.port,
      database: this.connection.database || 'visor',
      user: this.connection.user,
      password: this.connection.password,
      ssl: this.resolveSslConfig(),
    };
  }

  private buildMssqlConnection(): Record<string, unknown> {
    const ssl = this.connection.ssl;
    const sslEnabled = ssl === true || (typeof ssl === 'object' && ssl.enabled !== false);

    return {
      server: this.connection.host || 'localhost',
      port: this.connection.port,
      database: this.connection.database || 'visor',
      user: this.connection.user,
      password: this.connection.password,
      options: {
        encrypt: sslEnabled,
        trustServerCertificate:
          typeof ssl === 'object' ? ssl.reject_unauthorized === false : !sslEnabled,
      },
    };
  }

  private resolveSslConfig(): boolean | Record<string, unknown> {
    const ssl = this.connection.ssl;
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
  }

  private async migrateSchema(): Promise<void> {
    const knex = this.getKnex();

    const exists = await knex.schema.hasTable('schedules');
    if (!exists) {
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

    // Create message_triggers table
    const triggersExist = await knex.schema.hasTable('message_triggers');
    if (!triggersExist) {
      await knex.schema.createTable('message_triggers', table => {
        table.string('id', 36).primary();
        table.string('creator_id', 255).notNullable().index();
        table.string('creator_context', 255);
        table.string('creator_name', 255);
        table.text('description');
        table.text('channels'); // JSON array
        table.text('from_users'); // JSON array
        table.boolean('from_bots').notNullable().defaultTo(false);
        table.text('contains'); // JSON array
        table.text('match_pattern');
        table.string('threads', 20).notNullable().defaultTo('any');
        table.string('workflow', 255).notNullable();
        table.text('inputs'); // JSON
        table.text('output_context'); // JSON
        table.string('status', 20).notNullable().defaultTo('active').index();
        table.boolean('enabled').notNullable().defaultTo(true);
        table.bigInteger('created_at').notNullable();
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
  }

  private getKnex(): Knex {
    if (!this.knex) {
      throw new Error('[KnexStore] Not initialized. Call initialize() first.');
    }
    return this.knex;
  }

  // --- CRUD ---

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

    await knex('schedules').insert(toInsertRow(newSchedule));

    logger.info(`[KnexStore] Created schedule ${newSchedule.id} for user ${newSchedule.creatorId}`);
    return newSchedule;
  }

  async importSchedule(schedule: Schedule): Promise<void> {
    const knex = this.getKnex();
    const existing = await knex('schedules').where('id', schedule.id).first();
    if (existing) return; // Already imported (idempotent)
    await knex('schedules').insert(toInsertRow(schedule));
  }

  async get(id: string): Promise<Schedule | undefined> {
    const knex = this.getKnex();
    const row = await knex('schedules').where('id', id).first();
    return row ? fromDbRow(row as ScheduleRow) : undefined;
  }

  async update(id: string, patch: Partial<Schedule>): Promise<Schedule | undefined> {
    const knex = this.getKnex();

    const existing = await knex('schedules').where('id', id).first();
    if (!existing) return undefined;

    const current = fromDbRow(existing as ScheduleRow);
    const updated: Schedule = { ...current, ...patch, id: current.id };
    const row = toInsertRow(updated);
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

  // --- Queries ---

  async getByCreator(creatorId: string): Promise<Schedule[]> {
    const knex = this.getKnex();
    const rows = await knex('schedules').where('creator_id', creatorId);
    return rows.map((r: ScheduleRow) => fromDbRow(r));
  }

  async getActiveSchedules(): Promise<Schedule[]> {
    const knex = this.getKnex();
    const rows = await knex('schedules').where('status', 'active');
    return rows.map((r: ScheduleRow) => fromDbRow(r));
  }

  async getDueSchedules(now?: number): Promise<Schedule[]> {
    const ts = now ?? Date.now();
    const knex = this.getKnex();
    // MSSQL uses 1/0 for booleans
    const bFalse = this.driver === 'mssql' ? 0 : false;
    const bTrue = this.driver === 'mssql' ? 1 : true;
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
    return rows.map((r: ScheduleRow) => fromDbRow(r));
  }

  async findByWorkflow(creatorId: string, workflowName: string): Promise<Schedule[]> {
    const knex = this.getKnex();
    const escaped = workflowName.toLowerCase().replace(/[%_\\]/g, '\\$&');
    const pattern = `%${escaped}%`;
    const rows = await knex('schedules')
      .where('creator_id', creatorId)
      .where('status', 'active')
      .whereRaw("LOWER(workflow) LIKE ? ESCAPE '\\'", [pattern]);
    return rows.map((r: ScheduleRow) => fromDbRow(r));
  }

  async getAll(): Promise<Schedule[]> {
    const knex = this.getKnex();
    const rows = await knex('schedules');
    return rows.map((r: ScheduleRow) => fromDbRow(r));
  }

  async getStats(): Promise<ScheduleStoreStats> {
    const knex = this.getKnex();
    // MSSQL uses 1/0 for booleans; PostgreSQL/MySQL accept both true/1
    const boolTrue = this.driver === 'mssql' ? '1' : 'true';
    const boolFalse = this.driver === 'mssql' ? '0' : 'false';
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
      const bTrue = this.driver === 'mssql' ? 1 : true;
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

  // --- HA Distributed Locking (via scheduler_locks table) ---

  async tryAcquireLock(lockId: string, nodeId: string, ttlSeconds: number): Promise<string | null> {
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

  async releaseLock(lockId: string, lockToken: string): Promise<void> {
    const knex = this.getKnex();
    await knex('scheduler_locks').where('lock_id', lockId).where('lock_token', lockToken).del();
  }

  async renewLock(lockId: string, lockToken: string, ttlSeconds: number): Promise<boolean> {
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
    // No-op for server-based backends
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
    logger.info(`[KnexStore] Created trigger ${newTrigger.id} for user ${newTrigger.creatorId}`);
    return newTrigger;
  }

  async getTrigger(id: string): Promise<MessageTrigger | undefined> {
    const knex = this.getKnex();
    const row = await knex('message_triggers').where('id', id).first();
    return row ? fromTriggerRow(row as MessageTriggerRow) : undefined;
  }

  async updateTrigger(
    id: string,
    patch: Partial<MessageTrigger>
  ): Promise<MessageTrigger | undefined> {
    const knex = this.getKnex();
    const existing = await knex('message_triggers').where('id', id).first();
    if (!existing) return undefined;

    const current = fromTriggerRow(existing as MessageTriggerRow);
    const updated: MessageTrigger = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
    };
    const row = toTriggerInsertRow(updated);
    delete (row as Record<string, unknown>).id;

    await knex('message_triggers').where('id', id).update(row);
    return updated;
  }

  async deleteTrigger(id: string): Promise<boolean> {
    const knex = this.getKnex();
    const deleted = await knex('message_triggers').where('id', id).del();
    if (deleted > 0) {
      logger.info(`[KnexStore] Deleted trigger ${id}`);
      return true;
    }
    return false;
  }

  async getTriggersByCreator(creatorId: string): Promise<MessageTrigger[]> {
    const knex = this.getKnex();
    const rows = await knex('message_triggers').where('creator_id', creatorId);
    return rows.map((r: MessageTriggerRow) => fromTriggerRow(r));
  }

  async getActiveTriggers(): Promise<MessageTrigger[]> {
    const knex = this.getKnex();
    const rows = await knex('message_triggers')
      .where('status', 'active')
      .where('enabled', this.driver === 'mssql' ? 1 : true);
    return rows.map((r: MessageTriggerRow) => fromTriggerRow(r));
  }
}
