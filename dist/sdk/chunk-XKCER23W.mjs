import {
  init_logger,
  logger
} from "./chunk-SZXICFQ3.mjs";
import {
  __esm,
  __require
} from "./chunk-J7LXIPZS.mjs";

// src/scheduler/store/sqlite-store.ts
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
function toDbRow(schedule) {
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
    previous_response: schedule.previousResponse ?? null
  };
}
function safeJsonParse(value) {
  if (!value) return void 0;
  try {
    return JSON.parse(value);
  } catch {
    return void 0;
  }
}
function fromDbRow(row) {
  return {
    id: row.id,
    creatorId: row.creator_id,
    creatorContext: row.creator_context ?? void 0,
    creatorName: row.creator_name ?? void 0,
    timezone: row.timezone,
    schedule: row.schedule_expr,
    runAt: row.run_at ?? void 0,
    isRecurring: row.is_recurring === 1,
    originalExpression: row.original_expression,
    workflow: row.workflow ?? void 0,
    workflowInputs: safeJsonParse(row.workflow_inputs),
    outputContext: safeJsonParse(row.output_context),
    status: row.status,
    createdAt: row.created_at,
    lastRunAt: row.last_run_at ?? void 0,
    nextRunAt: row.next_run_at ?? void 0,
    runCount: row.run_count,
    failureCount: row.failure_count,
    lastError: row.last_error ?? void 0,
    previousResponse: row.previous_response ?? void 0
  };
}
var SqliteStoreBackend;
var init_sqlite_store = __esm({
  "src/scheduler/store/sqlite-store.ts"() {
    "use strict";
    init_logger();
    SqliteStoreBackend = class {
      db = null;
      dbPath;
      // In-memory locks (single-node only; SQLite doesn't support distributed locking)
      locks = /* @__PURE__ */ new Map();
      constructor(filename) {
        this.dbPath = filename || ".visor/schedules.db";
      }
      async initialize() {
        const resolvedPath = path.resolve(process.cwd(), this.dbPath);
        const dir = path.dirname(resolvedPath);
        fs.mkdirSync(dir, { recursive: true });
        const { createRequire } = __require("module");
        const runtimeRequire = createRequire(__filename);
        let Database;
        try {
          Database = runtimeRequire("better-sqlite3");
        } catch (err) {
          const code = err?.code;
          if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") {
            throw new Error(
              "better-sqlite3 is required for SQLite schedule storage. Install it with: npm install better-sqlite3"
            );
          }
          throw err;
        }
        this.db = new Database(resolvedPath);
        this.db.pragma("journal_mode = WAL");
        this.migrateSchema();
        logger.info(`[SqliteStore] Initialized at ${this.dbPath}`);
      }
      async shutdown() {
        if (this.db) {
          this.db.close();
          this.db = null;
        }
        this.locks.clear();
      }
      // --- Schema Migration ---
      migrateSchema() {
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
      getDb() {
        if (!this.db) {
          throw new Error("[SqliteStore] Database not initialized. Call initialize() first.");
        }
        return this.db;
      }
      // --- CRUD ---
      async create(schedule) {
        const db = this.getDb();
        const newSchedule = {
          ...schedule,
          id: uuidv4(),
          createdAt: Date.now(),
          runCount: 0,
          failureCount: 0,
          status: "active"
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
      async importSchedule(schedule) {
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
      async get(id) {
        const db = this.getDb();
        const row = db.prepare("SELECT * FROM schedules WHERE id = ?").get(id);
        return row ? fromDbRow(row) : void 0;
      }
      async update(id, patch) {
        const db = this.getDb();
        const existing = db.prepare("SELECT * FROM schedules WHERE id = ?").get(id);
        if (!existing) return void 0;
        const current = fromDbRow(existing);
        const updated = { ...current, ...patch, id: current.id };
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
      async delete(id) {
        const db = this.getDb();
        const result = db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
        if (result.changes > 0) {
          logger.info(`[SqliteStore] Deleted schedule ${id}`);
          return true;
        }
        return false;
      }
      // --- Queries ---
      async getByCreator(creatorId) {
        const db = this.getDb();
        const rows = db.prepare("SELECT * FROM schedules WHERE creator_id = ?").all(creatorId);
        return rows.map(fromDbRow);
      }
      async getActiveSchedules() {
        const db = this.getDb();
        const rows = db.prepare("SELECT * FROM schedules WHERE status = 'active'").all();
        return rows.map(fromDbRow);
      }
      async getDueSchedules(now) {
        const ts = now ?? Date.now();
        const db = this.getDb();
        const rows = db.prepare(
          `SELECT * FROM schedules
         WHERE status = 'active'
         AND (
           (is_recurring = 0 AND run_at IS NOT NULL AND run_at <= ?)
           OR
           (is_recurring = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?)
         )`
        ).all(ts, ts);
        return rows.map(fromDbRow);
      }
      async findByWorkflow(creatorId, workflowName) {
        const db = this.getDb();
        const escaped = workflowName.toLowerCase().replace(/[%_\\]/g, "\\$&");
        const pattern = `%${escaped}%`;
        const rows = db.prepare(
          `SELECT * FROM schedules
         WHERE creator_id = ? AND status = 'active'
         AND LOWER(workflow) LIKE ? ESCAPE '\\'`
        ).all(creatorId, pattern);
        return rows.map(fromDbRow);
      }
      async getAll() {
        const db = this.getDb();
        const rows = db.prepare("SELECT * FROM schedules").all();
        return rows.map(fromDbRow);
      }
      async getStats() {
        const db = this.getDb();
        const row = db.prepare(
          `SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
          SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) as paused,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN is_recurring = 1 THEN 1 ELSE 0 END) as recurring,
          SUM(CASE WHEN is_recurring = 0 THEN 1 ELSE 0 END) as one_time
        FROM schedules`
        ).get();
        return {
          total: row.total,
          active: row.active,
          paused: row.paused,
          completed: row.completed,
          failed: row.failed,
          recurring: row.recurring,
          oneTime: row.one_time
        };
      }
      async validateLimits(creatorId, isRecurring, limits) {
        const db = this.getDb();
        if (limits.maxGlobal) {
          const row = db.prepare("SELECT COUNT(*) as cnt FROM schedules").get();
          if (row.cnt >= limits.maxGlobal) {
            throw new Error(`Global schedule limit reached (${limits.maxGlobal})`);
          }
        }
        if (limits.maxPerUser) {
          const row = db.prepare("SELECT COUNT(*) as cnt FROM schedules WHERE creator_id = ?").get(creatorId);
          if (row.cnt >= limits.maxPerUser) {
            throw new Error(`You have reached the maximum number of schedules (${limits.maxPerUser})`);
          }
        }
        if (isRecurring && limits.maxRecurringPerUser) {
          const row = db.prepare("SELECT COUNT(*) as cnt FROM schedules WHERE creator_id = ? AND is_recurring = 1").get(creatorId);
          if (row.cnt >= limits.maxRecurringPerUser) {
            throw new Error(
              `You have reached the maximum number of recurring schedules (${limits.maxRecurringPerUser})`
            );
          }
        }
      }
      // --- HA Locking (in-memory for SQLite — single-node only) ---
      async tryAcquireLock(scheduleId, nodeId, ttlSeconds) {
        const now = Date.now();
        const existing = this.locks.get(scheduleId);
        if (existing && existing.expiresAt > now) {
          if (existing.nodeId === nodeId) {
            return existing.token;
          }
          return null;
        }
        const token = uuidv4();
        this.locks.set(scheduleId, {
          nodeId,
          token,
          expiresAt: now + ttlSeconds * 1e3
        });
        return token;
      }
      async releaseLock(scheduleId, lockToken) {
        const existing = this.locks.get(scheduleId);
        if (existing && existing.token === lockToken) {
          this.locks.delete(scheduleId);
        }
      }
      async renewLock(scheduleId, lockToken, ttlSeconds) {
        const existing = this.locks.get(scheduleId);
        if (!existing || existing.token !== lockToken) {
          return false;
        }
        existing.expiresAt = Date.now() + ttlSeconds * 1e3;
        return true;
      }
      async flush() {
      }
    };
  }
});

// src/scheduler/store/index.ts
async function createStoreBackend(storageConfig, haConfig) {
  const driver = storageConfig?.driver || "sqlite";
  switch (driver) {
    case "sqlite": {
      const conn = storageConfig?.connection;
      return new SqliteStoreBackend(conn?.filename);
    }
    case "postgresql":
    case "mysql":
    case "mssql": {
      try {
        const loaderPath = "../../enterprise/loader";
        const { loadEnterpriseStoreBackend } = await import(loaderPath);
        return await loadEnterpriseStoreBackend(driver, storageConfig, haConfig);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[StoreFactory] Failed to load enterprise ${driver} backend: ${msg}`);
        throw new Error(
          `The ${driver} schedule storage driver requires a Visor Enterprise license. Install the enterprise package or use driver: 'sqlite' (default). Original error: ${msg}`
        );
      }
    }
    default:
      throw new Error(`Unknown schedule storage driver: ${driver}`);
  }
}
var init_store = __esm({
  "src/scheduler/store/index.ts"() {
    "use strict";
    init_logger();
    init_sqlite_store();
  }
});

// src/scheduler/store/json-migrator.ts
import fs2 from "fs/promises";
import path2 from "path";
async function migrateJsonToBackend(jsonPath, backend) {
  const resolvedPath = path2.resolve(process.cwd(), jsonPath);
  let content;
  try {
    content = await fs2.readFile(resolvedPath, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return 0;
    }
    throw err;
  }
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    logger.warn(`[JsonMigrator] Failed to parse ${jsonPath}, skipping migration`);
    return 0;
  }
  const schedules = data.schedules;
  if (!Array.isArray(schedules) || schedules.length === 0) {
    logger.debug("[JsonMigrator] No schedules to migrate");
    await renameToMigrated(resolvedPath);
    return 0;
  }
  let migrated = 0;
  for (const schedule of schedules) {
    if (!schedule.id) {
      logger.warn("[JsonMigrator] Skipping schedule without ID");
      continue;
    }
    const existing = await backend.get(schedule.id);
    if (existing) {
      logger.debug(`[JsonMigrator] Schedule ${schedule.id} already exists, skipping`);
      continue;
    }
    try {
      await backend.importSchedule(schedule);
      migrated++;
    } catch (err) {
      logger.warn(
        `[JsonMigrator] Failed to migrate schedule ${schedule.id}: ${err instanceof Error ? err.message : err}`
      );
    }
  }
  await renameToMigrated(resolvedPath);
  logger.info(`[JsonMigrator] Migrated ${migrated}/${schedules.length} schedules from ${jsonPath}`);
  return migrated;
}
async function renameToMigrated(resolvedPath) {
  const migratedPath = `${resolvedPath}.migrated`;
  try {
    await fs2.rename(resolvedPath, migratedPath);
    logger.info(`[JsonMigrator] Backed up ${resolvedPath} \u2192 ${migratedPath}`);
  } catch (err) {
    logger.warn(
      `[JsonMigrator] Failed to rename ${resolvedPath}: ${err instanceof Error ? err.message : err}`
    );
  }
}
var init_json_migrator = __esm({
  "src/scheduler/store/json-migrator.ts"() {
    "use strict";
    init_logger();
  }
});

// src/scheduler/schedule-store.ts
var ScheduleStore;
var init_schedule_store = __esm({
  "src/scheduler/schedule-store.ts"() {
    "use strict";
    init_logger();
    init_store();
    init_json_migrator();
    ScheduleStore = class _ScheduleStore {
      static instance;
      backend = null;
      initialized = false;
      limits;
      config;
      externalBackend = null;
      constructor(config, limits, backend) {
        this.config = config || {};
        this.limits = {
          maxPerUser: limits?.maxPerUser ?? 25,
          maxRecurringPerUser: limits?.maxRecurringPerUser ?? 10,
          maxGlobal: limits?.maxGlobal ?? 1e3
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
      static getInstance(config, limits) {
        if (!_ScheduleStore.instance) {
          _ScheduleStore.instance = new _ScheduleStore(config, limits);
        } else if (config || limits) {
          logger.warn(
            "[ScheduleStore] getInstance() called with config/limits but instance already exists. Parameters ignored. Use createIsolated() for testing or resetInstance() first."
          );
        }
        return _ScheduleStore.instance;
      }
      /**
       * Create a new isolated instance (for testing)
       */
      static createIsolated(config, limits, backend) {
        return new _ScheduleStore(config, limits, backend);
      }
      /**
       * Reset singleton instance (for testing)
       */
      static resetInstance() {
        if (_ScheduleStore.instance) {
          if (_ScheduleStore.instance.backend) {
            _ScheduleStore.instance.backend.shutdown().catch(() => {
            });
          }
        }
        _ScheduleStore.instance = void 0;
      }
      /**
       * Initialize the store - creates backend and runs migrations
       */
      async initialize() {
        if (this.initialized) {
          return;
        }
        if (this.externalBackend) {
          this.backend = this.externalBackend;
        } else {
          this.backend = await createStoreBackend(this.config.storage, this.config.ha);
        }
        await this.backend.initialize();
        const jsonPath = this.config.path || ".visor/schedules.json";
        try {
          await migrateJsonToBackend(jsonPath, this.backend);
        } catch (err) {
          logger.warn(
            `[ScheduleStore] JSON migration failed (non-fatal): ${err instanceof Error ? err.message : err}`
          );
        }
        this.initialized = true;
      }
      /**
       * Create a new schedule (async, persists immediately)
       */
      async createAsync(schedule) {
        const backend = this.getBackend();
        await backend.validateLimits(schedule.creatorId, schedule.isRecurring, this.limits);
        return backend.create(schedule);
      }
      /**
       * Get a schedule by ID
       */
      async getAsync(id) {
        return this.getBackend().get(id);
      }
      /**
       * Update a schedule
       */
      async updateAsync(id, patch) {
        return this.getBackend().update(id, patch);
      }
      /**
       * Delete a schedule
       */
      async deleteAsync(id) {
        return this.getBackend().delete(id);
      }
      /**
       * Get all schedules for a specific creator
       */
      async getByCreatorAsync(creatorId) {
        return this.getBackend().getByCreator(creatorId);
      }
      /**
       * Get all active schedules
       */
      async getActiveSchedulesAsync() {
        return this.getBackend().getActiveSchedules();
      }
      /**
       * Get all schedules due for execution
       * @param now Current timestamp in milliseconds
       */
      async getDueSchedulesAsync(now = Date.now()) {
        return this.getBackend().getDueSchedules(now);
      }
      /**
       * Find schedules by workflow name
       */
      async findByWorkflowAsync(creatorId, workflowName) {
        return this.getBackend().findByWorkflow(creatorId, workflowName);
      }
      /**
       * Get schedule count statistics
       */
      async getStatsAsync() {
        return this.getBackend().getStats();
      }
      /**
       * Force immediate save (useful for shutdown)
       */
      async flush() {
        if (this.backend) {
          await this.backend.flush();
        }
      }
      /**
       * Check if initialized
       */
      isInitialized() {
        return this.initialized;
      }
      /**
       * Check if there are unsaved changes
       */
      hasPendingChanges() {
        return false;
      }
      /**
       * Get all schedules
       */
      async getAllAsync() {
        return this.getBackend().getAll();
      }
      /**
       * Get the underlying backend (for HA lock operations)
       */
      getBackend() {
        if (!this.backend) {
          throw new Error("[ScheduleStore] Not initialized. Call initialize() first.");
        }
        return this.backend;
      }
      /**
       * Shut down the backend cleanly
       */
      async shutdown() {
        if (this.backend) {
          await this.backend.shutdown();
          this.backend = null;
        }
        this.initialized = false;
      }
    };
  }
});

// src/scheduler/schedule-parser.ts
function getNextRunTime(cronExpression, _timezone = "UTC") {
  const parts = cronExpression.split(" ");
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${cronExpression}`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const now = /* @__PURE__ */ new Date();
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);
  const maxAttempts = 365 * 24 * 60;
  for (let i = 0; i < maxAttempts; i++) {
    if (matchesCronPart(next.getMinutes(), minute) && matchesCronPart(next.getHours(), hour) && matchesCronPart(next.getDate(), dayOfMonth) && matchesCronPart(next.getMonth() + 1, month) && matchesCronPart(next.getDay(), dayOfWeek)) {
      return next;
    }
    next.setMinutes(next.getMinutes() + 1);
  }
  const fallback = new Date(now);
  fallback.setDate(fallback.getDate() + 1);
  fallback.setHours(parseInt(hour, 10) || 9);
  fallback.setMinutes(parseInt(minute, 10) || 0);
  fallback.setSeconds(0, 0);
  return fallback;
}
function matchesCronPart(value, cronPart) {
  if (cronPart === "*") return true;
  if (cronPart.startsWith("*/")) {
    const step = parseInt(cronPart.slice(2), 10);
    return value % step === 0;
  }
  if (cronPart.includes("-")) {
    const [start, end] = cronPart.split("-").map((n) => parseInt(n, 10));
    return value >= start && value <= end;
  }
  if (cronPart.includes(",")) {
    return cronPart.split(",").map((n) => parseInt(n, 10)).includes(value);
  }
  return parseInt(cronPart, 10) === value;
}
function isValidCronExpression(expr) {
  if (!expr || typeof expr !== "string") return false;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const ranges = [
    [0, 59],
    // minute
    [0, 23],
    // hour
    [1, 31],
    // day of month
    [1, 12],
    // month
    [0, 7]
    // day of week (0 and 7 are Sunday)
  ];
  return parts.every((part, i) => {
    if (part === "*") return true;
    if (part.startsWith("*/")) {
      const step = parseInt(part.slice(2), 10);
      return !isNaN(step) && step > 0;
    }
    if (part.includes("-")) {
      const [start, end] = part.split("-").map((n) => parseInt(n, 10));
      return !isNaN(start) && !isNaN(end) && start >= ranges[i][0] && end <= ranges[i][1];
    }
    if (part.includes(",")) {
      return part.split(",").every((n) => {
        const val2 = parseInt(n, 10);
        return !isNaN(val2) && val2 >= ranges[i][0] && val2 <= ranges[i][1];
      });
    }
    const val = parseInt(part, 10);
    return !isNaN(val) && val >= ranges[i][0] && val <= ranges[i][1];
  });
}
var init_schedule_parser = __esm({
  "src/scheduler/schedule-parser.ts"() {
    "use strict";
  }
});

// src/scheduler/schedule-tool.ts
function matchGlobPattern(pattern, value) {
  const regexPattern = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${regexPattern}$`).test(value);
}
function isWorkflowAllowedByPatterns(workflow, allowedPatterns, deniedPatterns) {
  if (deniedPatterns && deniedPatterns.length > 0) {
    for (const pattern of deniedPatterns) {
      if (matchGlobPattern(pattern, workflow)) {
        return {
          allowed: false,
          reason: `Workflow "${workflow}" matches denied pattern "${pattern}"`
        };
      }
    }
  }
  if (allowedPatterns && allowedPatterns.length > 0) {
    for (const pattern of allowedPatterns) {
      if (matchGlobPattern(pattern, workflow)) {
        return { allowed: true };
      }
    }
    return {
      allowed: false,
      reason: `Workflow "${workflow}" does not match any allowed patterns: ${allowedPatterns.join(", ")}`
    };
  }
  return { allowed: true };
}
function checkSchedulePermissions(context, workflow, requestedScheduleType) {
  const permissions = context.permissions;
  const scheduleType = requestedScheduleType || context.scheduleType || "personal";
  if (context.allowedScheduleType && scheduleType !== context.allowedScheduleType) {
    const contextNames = {
      personal: "a direct message (DM)",
      channel: "a channel",
      dm: "a group DM"
    };
    const targetNames = {
      personal: "personal",
      channel: "channel",
      dm: "group"
    };
    return {
      allowed: false,
      reason: `From ${contextNames[context.allowedScheduleType]}, you can only create ${targetNames[context.allowedScheduleType]} schedules. To create a ${targetNames[scheduleType]} schedule, please use the appropriate context.`
    };
  }
  if (!permissions) {
    return { allowed: true };
  }
  switch (scheduleType) {
    case "personal":
      if (permissions.allowPersonal === false) {
        return {
          allowed: false,
          reason: "Personal schedules are not allowed in this configuration"
        };
      }
      break;
    case "channel":
      if (permissions.allowChannel === false) {
        return {
          allowed: false,
          reason: "Channel schedules are not allowed in this configuration"
        };
      }
      break;
    case "dm":
      if (permissions.allowDm === false) {
        return {
          allowed: false,
          reason: "DM schedules are not allowed in this configuration"
        };
      }
      break;
  }
  return isWorkflowAllowedByPatterns(
    workflow,
    permissions.allowedWorkflows,
    permissions.deniedWorkflows
  );
}
function formatSchedule(schedule) {
  const time = schedule.isRecurring ? schedule.originalExpression : new Date(schedule.runAt).toLocaleString();
  const status = schedule.status !== "active" ? ` (${schedule.status})` : "";
  const displayName = schedule.workflow || schedule.workflowInputs?.text || "scheduled message";
  const truncatedName = displayName.length > 30 ? displayName.substring(0, 27) + "..." : displayName;
  const output = schedule.outputContext?.type || "none";
  return `\`${schedule.id.substring(0, 8)}\` - "${truncatedName}" - ${time} (\u2192 ${output})${status}`;
}
function formatCreateConfirmation(schedule) {
  const outputDesc = schedule.outputContext?.type ? `${schedule.outputContext.type}${schedule.outputContext.target ? `:${schedule.outputContext.target}` : ""}` : "none";
  const displayName = schedule.workflow || schedule.workflowInputs?.text || "scheduled message";
  if (schedule.isRecurring) {
    const nextRun = schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }) : "calculating...";
    return `**Schedule created!**

**${schedule.workflow ? "Workflow" : "Reminder"}**: ${displayName}
**When**: ${schedule.originalExpression}
**Output**: ${outputDesc}
**Next run**: ${nextRun}

ID: \`${schedule.id.substring(0, 8)}\``;
  } else {
    const when = new Date(schedule.runAt).toLocaleString("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
    return `**Schedule created!**

**${schedule.workflow ? "Workflow" : "Reminder"}**: ${displayName}
**When**: ${when}
**Output**: ${outputDesc}

ID: \`${schedule.id.substring(0, 8)}\``;
  }
}
function formatScheduleList(schedules) {
  if (schedules.length === 0) {
    return `You don't have any active schedules.

To create one: "remind me every Monday at 9am to check PRs" or "schedule %daily-report every Monday at 9am"`;
  }
  const lines = schedules.map((s, i) => `${i + 1}. ${formatSchedule(s)}`);
  return `**Your active schedules:**

${lines.join("\n")}

To cancel: "cancel schedule <id>"
To pause: "pause schedule <id>"`;
}
async function handleScheduleAction(args, context) {
  const store = ScheduleStore.getInstance();
  if (!store.isInitialized()) {
    await store.initialize();
  }
  switch (args.action) {
    case "create":
      return handleCreate(args, context, store);
    case "list":
      return handleList(context, store);
    case "cancel":
      return handleCancel(args, context, store);
    case "pause":
      return handlePauseResume(args, context, store, "paused");
    case "resume":
      return handlePauseResume(args, context, store, "active");
    default:
      return {
        success: false,
        message: `Unknown action: ${args.action}`,
        error: `Supported actions: create, list, cancel, pause, resume`
      };
  }
}
async function handleCreate(args, context, store) {
  if (!args.reminder_text && !args.workflow) {
    return {
      success: false,
      message: "Missing reminder content",
      error: "Please specify either reminder_text (what to say) or workflow (what to run)"
    };
  }
  if (!args.cron && !args.run_at) {
    return {
      success: false,
      message: "Missing schedule timing",
      error: 'Please specify either cron (for recurring, e.g., "* * * * *") or run_at (ISO timestamp for one-time)'
    };
  }
  if (args.cron && !isValidCronExpression(args.cron)) {
    return {
      success: false,
      message: "Invalid cron expression",
      error: `"${args.cron}" is not a valid cron expression. Format: "minute hour day-of-month month day-of-week"`
    };
  }
  let runAtTimestamp;
  if (args.run_at) {
    const parsed = new Date(args.run_at);
    if (isNaN(parsed.getTime())) {
      return {
        success: false,
        message: "Invalid run_at timestamp",
        error: `"${args.run_at}" is not a valid ISO 8601 timestamp`
      };
    }
    if (parsed.getTime() <= Date.now()) {
      return {
        success: false,
        message: "run_at must be in the future",
        error: "Cannot schedule a reminder in the past"
      };
    }
    runAtTimestamp = parsed.getTime();
  }
  if (args.target_type && !args.target_id) {
    return {
      success: false,
      message: "Missing target_id",
      error: `target_type "${args.target_type}" requires a target_id (channel ID, user ID, or thread_ts)`
    };
  }
  let scheduleType = "personal";
  if (args.target_type === "channel") {
    scheduleType = "channel";
  } else if (args.target_type === "user") {
    scheduleType = "dm";
  }
  const workflowName = args.workflow || "reminder";
  const permissionCheck = checkSchedulePermissions(context, workflowName, scheduleType);
  if (!permissionCheck.allowed) {
    logger.warn(
      `[ScheduleTool] Permission denied for user ${context.userId}: ${permissionCheck.reason}`
    );
    return {
      success: false,
      message: "Permission denied",
      error: permissionCheck.reason || "You do not have permission to create this schedule"
    };
  }
  if (args.workflow && context.availableWorkflows && !context.availableWorkflows.includes(args.workflow)) {
    return {
      success: false,
      message: `Workflow "${args.workflow}" not found`,
      error: `Available workflows: ${context.availableWorkflows.slice(0, 5).join(", ")}${context.availableWorkflows.length > 5 ? "..." : ""}`
    };
  }
  try {
    const timezone = context.timezone || "UTC";
    const isRecurring = args.is_recurring === true || !!args.cron;
    let outputContext;
    if (args.target_type && args.target_id) {
      outputContext = {
        type: "slack",
        // Currently only Slack supported
        target: args.target_id,
        // Channel ID (C... or D...)
        threadId: args.thread_ts,
        // Thread timestamp for replies
        metadata: {
          targetType: args.target_type,
          reminderText: args.reminder_text
        }
      };
    }
    let nextRunAt;
    if (isRecurring && args.cron) {
      nextRunAt = getNextRunTime(args.cron, timezone).getTime();
    } else if (runAtTimestamp) {
      nextRunAt = runAtTimestamp;
    }
    const schedule = await store.createAsync({
      creatorId: context.userId,
      creatorContext: context.contextType,
      creatorName: context.userName,
      timezone,
      schedule: args.cron || "",
      runAt: runAtTimestamp,
      isRecurring,
      originalExpression: args.original_expression || args.cron || args.run_at || "",
      workflow: args.workflow,
      // Only set if explicitly provided
      workflowInputs: args.workflow_inputs || (args.reminder_text ? { text: args.reminder_text } : void 0),
      outputContext,
      nextRunAt
    });
    const displayText = args.reminder_text || args.workflow || "scheduled task";
    logger.info(
      `[ScheduleTool] Created schedule ${schedule.id} for user ${context.userId}: "${displayText}"`
    );
    return {
      success: true,
      message: formatCreateConfirmation(schedule),
      schedule
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    logger.warn(`[ScheduleTool] Failed to create schedule: ${errorMsg}`);
    return {
      success: false,
      message: `Failed to create schedule: ${errorMsg}`,
      error: errorMsg
    };
  }
}
async function handleList(context, store) {
  const allUserSchedules = await store.getByCreatorAsync(context.userId);
  const schedules = allUserSchedules.filter((s) => s.status !== "completed");
  let filteredSchedules = schedules;
  if (context.allowedScheduleType) {
    filteredSchedules = schedules.filter((s) => {
      const scheduleOutputType = s.outputContext?.type;
      if (!scheduleOutputType || scheduleOutputType === "none") {
        return context.allowedScheduleType === "personal";
      }
      if (scheduleOutputType === "slack") {
        const target = s.outputContext?.target || "";
        if (target.startsWith("#") || target.match(/^C[A-Z0-9]+$/)) {
          return context.allowedScheduleType === "channel";
        }
        if (target.startsWith("@") || target.match(/^U[A-Z0-9]+$/)) {
          return context.allowedScheduleType === "dm";
        }
      }
      return context.allowedScheduleType === "personal";
    });
  }
  return {
    success: true,
    message: formatScheduleList(filteredSchedules),
    schedules: filteredSchedules
  };
}
async function handleCancel(args, context, store) {
  let schedule;
  if (args.schedule_id) {
    const userSchedules = await store.getByCreatorAsync(context.userId);
    schedule = userSchedules.find((s) => s.id === args.schedule_id);
    if (!schedule) {
      schedule = userSchedules.find((s) => s.id.startsWith(args.schedule_id));
    }
  }
  if (!schedule) {
    return {
      success: false,
      message: "Schedule not found",
      error: `Could not find schedule with ID "${args.schedule_id}" in your schedules. Use "list my schedules" to see your schedules.`
    };
  }
  if (schedule.creatorId !== context.userId) {
    logger.warn(
      `[ScheduleTool] Attempted cross-user schedule cancellation: ${context.userId} tried to cancel ${schedule.id} owned by ${schedule.creatorId}`
    );
    return {
      success: false,
      message: "Not your schedule",
      error: "You can only cancel your own schedules."
    };
  }
  await store.deleteAsync(schedule.id);
  logger.info(`[ScheduleTool] Cancelled schedule ${schedule.id} for user ${context.userId}`);
  return {
    success: true,
    message: `**Schedule cancelled!**

Was: "${schedule.workflow}" scheduled for ${schedule.originalExpression}`
  };
}
async function handlePauseResume(args, context, store, newStatus) {
  if (!args.schedule_id) {
    return {
      success: false,
      message: "Missing schedule ID",
      error: "Please specify which schedule to pause/resume."
    };
  }
  const userSchedules = await store.getByCreatorAsync(context.userId);
  let schedule = userSchedules.find((s) => s.id === args.schedule_id);
  if (!schedule) {
    schedule = userSchedules.find((s) => s.id.startsWith(args.schedule_id));
  }
  if (!schedule) {
    return {
      success: false,
      message: "Schedule not found",
      error: `Could not find schedule with ID "${args.schedule_id}" in your schedules.`
    };
  }
  if (schedule.creatorId !== context.userId) {
    logger.warn(
      `[ScheduleTool] Attempted cross-user schedule modification: ${context.userId} tried to modify ${schedule.id} owned by ${schedule.creatorId}`
    );
    return {
      success: false,
      message: "Not your schedule",
      error: "You can only modify your own schedules."
    };
  }
  const updated = await store.updateAsync(schedule.id, { status: newStatus });
  const action = newStatus === "paused" ? "paused" : "resumed";
  logger.info(`[ScheduleTool] ${action} schedule ${schedule.id} for user ${context.userId}`);
  return {
    success: true,
    message: `**Schedule ${action}!**

"${schedule.workflow}" - ${schedule.originalExpression}`,
    schedule: updated
  };
}
function getScheduleToolDefinition() {
  return {
    name: "schedule",
    description: `Schedule, list, and manage reminders or workflow executions.

YOU (the AI) must extract and structure all scheduling parameters. Do NOT pass natural language time expressions - convert them to cron or ISO timestamps.

CRITICAL WORKFLOW RULE:
- To schedule a WORKFLOW, the user MUST use a '%' prefix (e.g., "schedule %my-workflow daily").
- If the '%' prefix is present, extract the word following it as the 'workflow' parameter (without the '%').
- If the '%' prefix is NOT present, the request is a simple text reminder. The ENTIRE user request (excluding the schedule expression) MUST be placed in the 'reminder_text' parameter.
- DO NOT guess or infer a workflow name from a user's request without the '%' prefix.

ACTIONS:
- create: Schedule a new reminder or workflow
- list: Show user's active schedules
- cancel: Remove a schedule by ID
- pause/resume: Temporarily disable/enable a schedule

FOR CREATE ACTION - Extract these from user's request:
1. WHAT:
   - If user says "schedule %some-workflow ...", populate 'workflow' with "some-workflow".
   - Otherwise, populate 'reminder_text' with the user's full request text.
2. WHERE: Use the CURRENT channel from context
   - target_id: The channel ID from context (C... for channels, D... for DMs)
   - target_type: "channel" for public/private channels, "dm" for direct messages
   - ONLY use target_type="thread" with thread_ts if user is INSIDE a thread
   - When NOT in a thread, reminders post as NEW messages (not thread replies)
3. WHEN: Either cron (for recurring) OR run_at (ISO 8601 for one-time)
   - Recurring: Generate cron expression (minute hour day-of-month month day-of-week)
   - One-time: Generate ISO 8601 timestamp

CRON EXAMPLES:
- "every minute" \u2192 cron: "* * * * *"
- "every hour" \u2192 cron: "0 * * * *"
- "every day at 9am" \u2192 cron: "0 9 * * *"
- "every Monday at 9am" \u2192 cron: "0 9 * * 1"
- "weekdays at 8:30am" \u2192 cron: "30 8 * * 1-5"
- "every 5 minutes" \u2192 cron: "*/5 * * * *"

ONE-TIME EXAMPLES:
- "in 2 hours" \u2192 run_at: "<ISO timestamp 2 hours from now>"
- "tomorrow at 3pm" \u2192 run_at: "2026-02-08T15:00:00Z"

USAGE EXAMPLES:

User in DM: "remind me to check builds every day at 9am"
\u2192 {
    "action": "create",
    "reminder_text": "check builds",
    "is_recurring": true,
    "cron": "0 9 * * *",
    "target_type": "dm",
    "target_id": "<DM channel ID from context, e.g., D09SZABNLG3>",
    "original_expression": "every day at 9am"
  }

User in #security channel: "schedule %security-scan every Monday at 10am"
\u2192 {
    "action": "create",
    "workflow": "security-scan",
    "is_recurring": true,
    "cron": "0 10 * * 1",
    "target_type": "channel",
    "target_id": "<channel ID from context, e.g., C05ABC123>",
    "original_expression": "every Monday at 10am"
  }

User in #security channel: "run security-scan every Monday at 10am" (NO % prefix!)
\u2192 {
    "action": "create",
    "reminder_text": "run security-scan every Monday at 10am",
    "is_recurring": true,
    "cron": "0 10 * * 1",
    "target_type": "channel",
    "target_id": "<channel ID from context, e.g., C05ABC123>",
    "original_expression": "every Monday at 10am"
  }

User in DM: "remind me in 2 hours to review the PR"
\u2192 {
    "action": "create",
    "reminder_text": "review the PR",
    "is_recurring": false,
    "run_at": "2026-02-07T18:00:00Z",
    "target_type": "dm",
    "target_id": "<DM channel ID from context>",
    "original_expression": "in 2 hours"
  }

User inside a thread: "remind me about this tomorrow"
\u2192 {
    "action": "create",
    "reminder_text": "Check this thread",
    "is_recurring": false,
    "run_at": "2026-02-08T09:00:00Z",
    "target_type": "thread",
    "target_id": "<channel ID>",
    "thread_ts": "<thread_ts from context>",
    "original_expression": "tomorrow"
  }

User: "list my schedules"
\u2192 { "action": "list" }

User: "cancel schedule abc123"
\u2192 { "action": "cancel", "schedule_id": "abc123" }`,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "list", "cancel", "pause", "resume"],
          description: "What to do: create new, list existing, cancel/pause/resume by ID"
        },
        // WHAT to do
        reminder_text: {
          type: "string",
          description: "For create: the message/reminder text to send when triggered"
        },
        workflow: {
          type: "string",
          description: 'For create: workflow ID to run. ONLY populate this if the user used the % prefix (e.g., "%my-workflow"). Extract the name without the % symbol. If no % prefix, use reminder_text instead.'
        },
        workflow_inputs: {
          type: "object",
          description: "For create: optional inputs to pass to the workflow"
        },
        // WHERE to send
        target_type: {
          type: "string",
          enum: ["channel", "dm", "thread", "user"],
          description: "For create: where to send output. channel=public/private channel, dm=DM to self (current DM channel), user=DM to specific user, thread=reply in current thread"
        },
        target_id: {
          type: "string",
          description: "For create: Slack channel ID. Channels start with C, DMs start with D. Always use the channel ID from the current context."
        },
        thread_ts: {
          type: "string",
          description: "For create with target_type=thread: the thread timestamp to reply to. Get this from the current thread context."
        },
        // WHEN to run
        is_recurring: {
          type: "boolean",
          description: "For create: true for recurring schedules (cron), false for one-time (run_at)"
        },
        cron: {
          type: "string",
          description: 'For create recurring: cron expression (minute hour day-of-month month day-of-week). Examples: "0 9 * * *" (daily 9am), "* * * * *" (every minute), "0 9 * * 1" (Mondays 9am)'
        },
        run_at: {
          type: "string",
          description: 'For create one-time: ISO 8601 timestamp when to run (e.g., "2026-02-07T15:00:00Z")'
        },
        original_expression: {
          type: "string",
          description: "For create: the original natural language expression from user (for display only)"
        },
        // For cancel/pause/resume
        schedule_id: {
          type: "string",
          description: "For cancel/pause/resume: the schedule ID to act on (first 8 chars is enough)"
        }
      },
      required: ["action"]
    },
    exec: ""
    // Not used - this tool has a custom handler
  };
}
function isScheduleTool(toolName) {
  return toolName === "schedule";
}
function determineScheduleType(contextType, outputType, outputTarget) {
  if (outputType === "slack" && outputTarget) {
    if (outputTarget.startsWith("#") || outputTarget.match(/^C[A-Z0-9]+$/)) {
      return "channel";
    }
    if (outputTarget.startsWith("@") || outputTarget.match(/^U[A-Z0-9]+$/)) {
      return "dm";
    }
  }
  if (contextType === "cli" || contextType.startsWith("github:")) {
    return "personal";
  }
  return "personal";
}
function slackChannelTypeToScheduleType(channelType) {
  switch (channelType) {
    case "channel":
      return "channel";
    case "group":
      return "dm";
    // Group DMs map to 'dm' schedule type
    case "dm":
    default:
      return "personal";
  }
}
function buildScheduleToolContext(sources, availableWorkflows, permissions, outputInfo) {
  if (sources.slackContext) {
    const contextType = `slack:${sources.slackContext.userId}`;
    const scheduleType = determineScheduleType(
      contextType,
      outputInfo?.outputType,
      outputInfo?.outputTarget
    );
    let allowedScheduleType;
    if (sources.slackContext.channelType) {
      allowedScheduleType = slackChannelTypeToScheduleType(sources.slackContext.channelType);
    }
    let finalScheduleType = scheduleType;
    if (!outputInfo?.outputType && sources.slackContext.channelType) {
      finalScheduleType = slackChannelTypeToScheduleType(sources.slackContext.channelType);
    }
    return {
      userId: sources.slackContext.userId,
      userName: sources.slackContext.userName,
      contextType,
      timezone: sources.slackContext.timezone,
      availableWorkflows,
      scheduleType: finalScheduleType,
      permissions,
      allowedScheduleType
    };
  }
  if (sources.githubContext) {
    return {
      userId: sources.githubContext.login,
      contextType: `github:${sources.githubContext.login}`,
      timezone: "UTC",
      // GitHub doesn't provide timezone
      availableWorkflows,
      scheduleType: "personal",
      permissions,
      allowedScheduleType: "personal"
      // GitHub context only allows personal schedules
    };
  }
  return {
    userId: sources.cliContext?.userId || process.env.USER || "cli-user",
    contextType: "cli",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    availableWorkflows,
    scheduleType: "personal",
    permissions,
    allowedScheduleType: "personal"
    // CLI context only allows personal schedules
  };
}
var init_schedule_tool = __esm({
  "src/scheduler/schedule-tool.ts"() {
    init_schedule_store();
    init_schedule_parser();
    init_logger();
  }
});

export {
  init_store,
  ScheduleStore,
  init_schedule_store,
  init_schedule_parser,
  handleScheduleAction,
  getScheduleToolDefinition,
  isScheduleTool,
  buildScheduleToolContext,
  init_schedule_tool
};
//# sourceMappingURL=chunk-XKCER23W.mjs.map