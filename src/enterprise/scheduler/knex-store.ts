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
  claimed_by: string | null;
  claimed_at: number | string | null;
  lock_token: string | null;
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
    claimed_by: null,
    claimed_at: null,
    lock_token: null,
  };
}

/**
 * Enterprise Knex-backed store for PostgreSQL, MySQL, and MSSQL
 */
export class KnexStoreBackend implements ScheduleStoreBackend {
  private knex: Knex | null = null;
  private driver: 'postgresql' | 'mysql' | 'mssql';
  private connection: ServerConnectionConfig;
  private haConfig?: HAConfig;

  constructor(
    driver: 'postgresql' | 'mysql' | 'mssql',
    storageConfig: StorageConfig,
    haConfig?: HAConfig
  ) {
    this.driver = driver;
    this.connection = (storageConfig.connection || {}) as ServerConnectionConfig;
    this.haConfig = haConfig;
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
        table.string('claimed_by', 255);
        table.bigInteger('claimed_at');
        table.string('lock_token', 36);

        table.index(['status', 'next_run_at']);
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
    // Remove id and lock columns from update
    delete (row as Record<string, unknown>).id;
    delete (row as Record<string, unknown>).claimed_by;
    delete (row as Record<string, unknown>).claimed_at;
    delete (row as Record<string, unknown>).lock_token;

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

  // --- HA Distributed Locking (row-level) ---

  async tryAcquireLock(
    scheduleId: string,
    nodeId: string,
    ttlSeconds: number
  ): Promise<string | null> {
    const knex = this.getKnex();
    const now = Date.now();
    const expiresAt = now - ttlSeconds * 1000; // Locks older than this are expired
    const token = uuidv4();

    // Atomic claim: only succeed if unclaimed or claim has expired
    const updated = await knex('schedules')
      .where('id', scheduleId)
      .andWhere(function () {
        this.whereNull('claimed_by').orWhere('claimed_at', '<', expiresAt);
      })
      .update({
        claimed_by: nodeId,
        claimed_at: now,
        lock_token: token,
      });

    return updated > 0 ? token : null;
  }

  async releaseLock(scheduleId: string, lockToken: string): Promise<void> {
    const knex = this.getKnex();
    await knex('schedules').where('id', scheduleId).where('lock_token', lockToken).update({
      claimed_by: null,
      claimed_at: null,
      lock_token: null,
    });
  }

  async renewLock(scheduleId: string, lockToken: string, _ttlSeconds: number): Promise<boolean> {
    const knex = this.getKnex();
    const now = Date.now();

    const updated = await knex('schedules')
      .where('id', scheduleId)
      .where('lock_token', lockToken)
      .update({ claimed_at: now });

    return updated > 0;
  }

  async flush(): Promise<void> {
    // No-op for server-based backends
  }
}
