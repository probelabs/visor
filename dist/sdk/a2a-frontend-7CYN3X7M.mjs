import {
  ContextMismatchError,
  InvalidRequestError,
  InvalidStateTransitionError,
  ParseError,
  TaskNotFoundError,
  assertValidTransition,
  init_state_transitions,
  init_types,
  isTerminalState
} from "./chunk-YSOIR46P.mjs";
import {
  init_trace_helpers,
  withActiveSpan
} from "./chunk-2HXOGRAS.mjs";
import "./chunk-6VVXKXTI.mjs";
import "./chunk-4TV2CVVI.mjs";
import {
  init_logger,
  logger
} from "./chunk-FT3I25QV.mjs";
import "./chunk-UCMJJ3IM.mjs";
import {
  __esm,
  __require
} from "./chunk-J7LXIPZS.mjs";

// src/agent-protocol/task-store.ts
import path from "path";
import fs from "fs";
import crypto from "crypto";
function safeJsonParse(value) {
  if (!value) return void 0;
  try {
    return JSON.parse(value);
  } catch {
    return void 0;
  }
}
function nowISO() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function taskRowToAgentTask(row) {
  return {
    id: row.id,
    context_id: row.context_id,
    status: {
      state: row.state,
      message: safeJsonParse(row.status_message),
      timestamp: row.updated_at
    },
    artifacts: safeJsonParse(row.artifacts) ?? [],
    history: safeJsonParse(row.history) ?? [],
    metadata: safeJsonParse(row.request_metadata),
    workflow_id: row.workflow_id ?? void 0
  };
}
var SqliteTaskStore;
var init_task_store = __esm({
  "src/agent-protocol/task-store.ts"() {
    "use strict";
    init_logger();
    init_types();
    init_state_transitions();
    SqliteTaskStore = class {
      db = null;
      dbPath;
      constructor(filename) {
        this.dbPath = filename || ".visor/agent-tasks.db";
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
              "better-sqlite3 is required for agent protocol task storage. Install it with: npm install better-sqlite3"
            );
          }
          throw err;
        }
        this.db = new Database(resolvedPath);
        this.db.pragma("journal_mode = WAL");
        this.migrateSchema();
        logger.info(`[AgentTaskStore] Initialized at ${this.dbPath}`);
      }
      async shutdown() {
        if (this.db) {
          this.db.close();
          this.db = null;
        }
      }
      getDb() {
        if (!this.db) throw new Error("TaskStore not initialized");
        return this.db;
      }
      /** Expose the underlying database for sibling managers (e.g. PushNotificationManager). */
      getDatabase() {
        return this.getDb();
      }
      migrateSchema() {
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
      createTask(params) {
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
          status: { state: "submitted", timestamp: now },
          artifacts: [],
          history: [],
          metadata: params.requestMetadata,
          workflow_id: params.workflowId
        };
      }
      getTask(taskId) {
        const db = this.getDb();
        const row = db.prepare("SELECT * FROM agent_tasks WHERE id = ?").get(taskId);
        return row ? taskRowToAgentTask(row) : null;
      }
      buildFilterClause(filter) {
        const conditions = [];
        const params = [];
        if (filter.contextId) {
          conditions.push("context_id = ?");
          params.push(filter.contextId);
        }
        if (filter.state && filter.state.length > 0) {
          const placeholders = filter.state.map(() => "?").join(", ");
          conditions.push(`state IN (${placeholders})`);
          params.push(...filter.state);
        }
        if (filter.workflowId) {
          conditions.push("workflow_id = ?");
          params.push(filter.workflowId);
        }
        if (filter.search) {
          const escaped = filter.search.replace(/[%_\\]/g, "\\$&");
          conditions.push("request_message LIKE ? ESCAPE '\\'");
          params.push(`%${escaped}%`);
        }
        if (filter.claimedBy) {
          conditions.push("claimed_by = ?");
          params.push(filter.claimedBy);
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        return { where, params };
      }
      listTasks(filter) {
        const db = this.getDb();
        const { where, params } = this.buildFilterClause(filter);
        const countRow = db.prepare(`SELECT COUNT(*) as total FROM agent_tasks ${where}`).get(...params);
        const total = countRow.total;
        const limit = Math.min(filter.limit ?? 50, 200);
        const offset = filter.offset ?? 0;
        const rows = db.prepare(`SELECT * FROM agent_tasks ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
        return {
          tasks: rows.map(taskRowToAgentTask),
          total
        };
      }
      listTasksRaw(filter) {
        const db = this.getDb();
        const { where, params } = this.buildFilterClause(filter);
        const countRow = db.prepare(`SELECT COUNT(*) as total FROM agent_tasks ${where}`).get(...params);
        const total = countRow.total;
        const limit = Math.min(filter.limit ?? 50, 200);
        const offset = filter.offset ?? 0;
        const rawRows = db.prepare(`SELECT * FROM agent_tasks ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
        const rows = rawRows.map((r) => {
          let messageText = "";
          try {
            const msg = JSON.parse(r.request_message);
            const parts = msg.parts ?? msg.content?.parts ?? [];
            const textPart = parts.find((p) => p.type === "text" || typeof p.text === "string");
            messageText = textPart?.text ?? "";
          } catch {
          }
          let source = "-";
          let metadata = {};
          try {
            metadata = JSON.parse(r.request_metadata || "{}");
            source = metadata.source || "-";
          } catch {
          }
          return {
            id: r.id,
            context_id: r.context_id,
            state: r.state,
            created_at: r.created_at,
            updated_at: r.updated_at,
            claimed_by: r.claimed_by,
            claimed_at: r.claimed_at,
            workflow_id: r.workflow_id,
            run_id: r.run_id,
            request_message: messageText,
            source,
            metadata
          };
        });
        return { rows, total };
      }
      // -------------------------------------------------------------------------
      // State mutations
      // -------------------------------------------------------------------------
      updateTaskState(taskId, newState, statusMessage) {
        const db = this.getDb();
        const row = db.prepare("SELECT state FROM agent_tasks WHERE id = ?").get(taskId);
        if (!row) throw new TaskNotFoundError(taskId);
        assertValidTransition(row.state, newState);
        const now = nowISO();
        db.prepare(
          `UPDATE agent_tasks
       SET state = ?, updated_at = ?, status_message = ?
       WHERE id = ?`
        ).run(newState, now, statusMessage ? JSON.stringify(statusMessage) : null, taskId);
      }
      claimTask(taskId, workerId) {
        const db = this.getDb();
        const now = nowISO();
        db.prepare(
          `UPDATE agent_tasks SET claimed_by = ?, claimed_at = ?, updated_at = ? WHERE id = ?`
        ).run(workerId, now, now, taskId);
      }
      addArtifact(taskId, artifact) {
        const db = this.getDb();
        const row = db.prepare("SELECT artifacts FROM agent_tasks WHERE id = ?").get(taskId);
        if (!row) throw new TaskNotFoundError(taskId);
        const artifacts = safeJsonParse(row.artifacts) ?? [];
        artifacts.push(artifact);
        db.prepare("UPDATE agent_tasks SET artifacts = ?, updated_at = ? WHERE id = ?").run(
          JSON.stringify(artifacts),
          nowISO(),
          taskId
        );
      }
      appendHistory(taskId, message) {
        const db = this.getDb();
        const row = db.prepare("SELECT history FROM agent_tasks WHERE id = ?").get(taskId);
        if (!row) throw new TaskNotFoundError(taskId);
        const history = safeJsonParse(row.history) ?? [];
        history.push(message);
        db.prepare("UPDATE agent_tasks SET history = ?, updated_at = ? WHERE id = ?").run(
          JSON.stringify(history),
          nowISO(),
          taskId
        );
      }
      setRunId(taskId, runId) {
        const db = this.getDb();
        const result = db.prepare("UPDATE agent_tasks SET run_id = ?, updated_at = ? WHERE id = ?").run(runId, nowISO(), taskId);
        if (result.changes === 0) throw new TaskNotFoundError(taskId);
      }
      // -------------------------------------------------------------------------
      // Queue operations
      // -------------------------------------------------------------------------
      claimNextSubmitted(workerId) {
        const db = this.getDb();
        const now = nowISO();
        const row = db.prepare(
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
        ).get(workerId, now, now);
        return row ? taskRowToAgentTask(row) : null;
      }
      reclaimStaleTasks(_workerId, staleTimeoutMs) {
        const db = this.getDb();
        const now = nowISO();
        const staleTimeoutSec = Math.floor((staleTimeoutMs ?? 3e5) / 1e3);
        const rows = db.prepare(
          `UPDATE agent_tasks
         SET state = 'submitted', claimed_by = NULL, claimed_at = NULL, updated_at = ?
         WHERE state = 'working'
         AND claimed_at IS NOT NULL
         AND claimed_at < datetime('now', '-' || ? || ' seconds')
         RETURNING *`
        ).all(now, staleTimeoutSec);
        return rows.map(taskRowToAgentTask);
      }
      releaseClaim(taskId) {
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
      failStaleTasks(reason) {
        const db = this.getDb();
        const now = nowISO();
        const msg = reason || "Process terminated while task was running";
        const statusMessage = JSON.stringify({
          message_id: crypto.randomUUID(),
          role: "agent",
          parts: [{ text: msg }]
        });
        const result = db.prepare(
          `UPDATE agent_tasks
         SET state = 'failed', updated_at = ?, status_message = ?
         WHERE state = 'working'`
        ).run(now, statusMessage);
        return result.changes;
      }
      purgeOldTasks(olderThanMs) {
        const db = this.getDb();
        const cutoff = new Date(Date.now() - olderThanMs).toISOString();
        const result = db.prepare(
          `DELETE FROM agent_tasks
         WHERE state IN ('completed', 'failed', 'canceled', 'rejected')
         AND updated_at <= ?`
        ).run(cutoff);
        return result.changes;
      }
      deleteExpiredTasks() {
        const db = this.getDb();
        const now = nowISO();
        const rows = db.prepare("SELECT id FROM agent_tasks WHERE expires_at IS NOT NULL AND expires_at < ?").all(now);
        if (rows.length > 0) {
          db.prepare("DELETE FROM agent_tasks WHERE expires_at IS NOT NULL AND expires_at < ?").run(
            now
          );
        }
        return rows.map((r) => r.id);
      }
      deleteTask(taskId) {
        const db = this.getDb();
        db.prepare("DELETE FROM agent_tasks WHERE id = ?").run(taskId);
      }
      // -------------------------------------------------------------------------
      // Context ID resolution
      // -------------------------------------------------------------------------
      resolveContextId(message, providedContextId) {
        if (message.task_id) {
          const existingTask = this.getTask(message.task_id);
          if (existingTask) {
            if (message.context_id && message.context_id !== existingTask.context_id) {
              throw new ContextMismatchError(message.context_id, existingTask.context_id);
            }
            return existingTask.context_id;
          }
        }
        return message.context_id ?? providedContextId;
      }
    };
  }
});

// src/agent-protocol/task-stream-manager.ts
var TaskStreamManager;
var init_task_stream_manager = __esm({
  "src/agent-protocol/task-stream-manager.ts"() {
    "use strict";
    init_state_transitions();
    TaskStreamManager = class {
      subscribers = /* @__PURE__ */ new Map();
      keepaliveTimers = /* @__PURE__ */ new Map();
      keepaliveIntervalMs;
      constructor(keepaliveIntervalMs = 3e4) {
        this.keepaliveIntervalMs = keepaliveIntervalMs;
      }
      /**
       * Subscribe an HTTP response to SSE events for a task.
       * Sets SSE headers and registers cleanup on disconnect.
       */
      subscribe(taskId, res) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive"
        });
        if (!this.subscribers.has(taskId)) {
          this.subscribers.set(taskId, /* @__PURE__ */ new Set());
        }
        this.subscribers.get(taskId).add(res);
        res.on("close", () => {
          this.removeSubscriber(taskId, res);
        });
        const timer = setInterval(() => {
          if (res.writable) {
            res.write(": keepalive\n\n");
          } else {
            this.removeSubscriber(taskId, res);
          }
        }, this.keepaliveIntervalMs);
        this.keepaliveTimers.set(res, timer);
      }
      /**
       * Emit an event to all subscribers of a task.
       * If the event is a terminal status update, closes all connections.
       */
      emit(taskId, event) {
        const subs = this.subscribers.get(taskId);
        if (!subs || subs.size === 0) return;
        const data = `data: ${JSON.stringify(event)}

`;
        for (const res of subs) {
          if (res.writable) {
            res.write(data);
          }
        }
        if (event.type === "TaskStatusUpdateEvent" && isTerminalState(event.status.state)) {
          for (const res of subs) {
            this.clearKeepalive(res);
            if (res.writable) {
              res.end();
            }
          }
          this.subscribers.delete(taskId);
        }
      }
      /**
       * Check if a task has any active subscribers.
       */
      hasSubscribers(taskId) {
        return (this.subscribers.get(taskId)?.size ?? 0) > 0;
      }
      /**
       * Get count of subscribers for a task.
       */
      getSubscriberCount(taskId) {
        return this.subscribers.get(taskId)?.size ?? 0;
      }
      /**
       * Close all connections and clean up.
       */
      shutdown() {
        for (const [, subs] of this.subscribers) {
          for (const res of subs) {
            this.clearKeepalive(res);
            if (res.writable) {
              res.end();
            }
          }
          subs.clear();
        }
        this.subscribers.clear();
      }
      removeSubscriber(taskId, res) {
        this.clearKeepalive(res);
        const subs = this.subscribers.get(taskId);
        if (subs) {
          subs.delete(res);
          if (subs.size === 0) {
            this.subscribers.delete(taskId);
          }
        }
      }
      clearKeepalive(res) {
        const timer = this.keepaliveTimers.get(res);
        if (timer) {
          clearInterval(timer);
          this.keepaliveTimers.delete(res);
        }
      }
    };
  }
});

// src/agent-protocol/push-notification-manager.ts
import crypto2 from "crypto";
var PushNotificationManager;
var init_push_notification_manager = __esm({
  "src/agent-protocol/push-notification-manager.ts"() {
    "use strict";
    init_logger();
    PushNotificationManager = class {
      db = null;
      maxRetries;
      baseDelayMs;
      deliveryTimeoutMs;
      constructor(options) {
        this.maxRetries = options?.maxRetries ?? 3;
        this.baseDelayMs = options?.baseDelayMs ?? 1e3;
        this.deliveryTimeoutMs = options?.deliveryTimeoutMs ?? 1e4;
      }
      /**
       * Initialize with a database connection. Must be called before any operations.
       * Creates the push configs table if it doesn't exist.
       */
      initialize(db) {
        this.db = db;
        db.exec("PRAGMA foreign_keys = ON");
        this.migrateSchema();
      }
      migrateSchema() {
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
      getDb() {
        if (!this.db) throw new Error("PushNotificationManager not initialized");
        return this.db;
      }
      // -------------------------------------------------------------------------
      // CRUD
      // -------------------------------------------------------------------------
      create(config) {
        const db = this.getDb();
        const id = config.id ?? crypto2.randomUUID();
        const now = (/* @__PURE__ */ new Date()).toISOString();
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
      get(taskId, configId) {
        const db = this.getDb();
        const row = db.prepare("SELECT * FROM agent_push_configs WHERE id = ? AND task_id = ?").get(configId, taskId);
        return row ? this.rowToConfig(row) : null;
      }
      list(taskId) {
        const db = this.getDb();
        const rows = db.prepare("SELECT * FROM agent_push_configs WHERE task_id = ? ORDER BY created_at ASC").all(taskId);
        return rows.map((r) => this.rowToConfig(r));
      }
      delete(taskId, configId) {
        const db = this.getDb();
        const result = db.prepare("DELETE FROM agent_push_configs WHERE id = ? AND task_id = ?").run(configId, taskId);
        return result.changes > 0;
      }
      deleteForTask(taskId) {
        const db = this.getDb();
        const result = db.prepare("DELETE FROM agent_push_configs WHERE task_id = ?").run(taskId);
        return result.changes;
      }
      // -------------------------------------------------------------------------
      // Delivery
      // -------------------------------------------------------------------------
      /**
       * Deliver an event to all push configs registered for a task.
       * Uses exponential backoff retry for server errors.
       */
      async notifyAll(taskId, event) {
        const configs = this.list(taskId);
        if (configs.length === 0) return;
        const deliveries = configs.map((config) => this.deliver(config, event));
        await Promise.allSettled(deliveries);
      }
      async deliver(config, event) {
        const headers = {
          "Content-Type": "application/json"
        };
        if (config.auth_scheme && config.auth_credentials) {
          headers["Authorization"] = `${config.auth_scheme} ${config.auth_credentials}`;
        }
        const body = JSON.stringify(event);
        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
          try {
            const resp = await fetch(config.url, {
              method: "POST",
              headers,
              body,
              signal: AbortSignal.timeout(this.deliveryTimeoutMs)
            });
            if (resp.ok) return;
            if (resp.status >= 400 && resp.status < 500) {
              logger.warn(`Push notification to ${config.url} returned ${resp.status}, not retrying`);
              return;
            }
          } catch (err) {
            logger.warn(
              `Push notification delivery attempt ${attempt + 1} failed for ${config.url}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
          if (attempt < this.maxRetries - 1) {
            await new Promise((r) => setTimeout(r, this.baseDelayMs * Math.pow(2, attempt)));
          }
        }
        logger.error(
          `Push notification delivery failed after ${this.maxRetries} attempts for task ${config.task_id} to ${config.url}`
        );
      }
      rowToConfig(row) {
        return {
          id: row.id,
          task_id: row.task_id,
          url: row.url,
          token: row.token ?? void 0,
          auth_scheme: row.auth_scheme ?? void 0,
          auth_credentials: row.auth_credentials ?? void 0
        };
      }
    };
  }
});

// src/agent-protocol/task-queue.ts
import crypto3 from "crypto";
var DEFAULT_CONFIG, TaskQueue;
var init_task_queue = __esm({
  "src/agent-protocol/task-queue.ts"() {
    "use strict";
    init_logger();
    init_trace_helpers();
    DEFAULT_CONFIG = {
      pollInterval: 1e3,
      maxConcurrent: 5,
      staleClaimTimeout: 3e5
    };
    TaskQueue = class {
      constructor(taskStore, executor, _eventBus, config, workerId) {
        this.taskStore = taskStore;
        this.executor = executor;
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.workerId = workerId ?? crypto3.randomUUID();
      }
      running = false;
      timer = null;
      activeCount = 0;
      config;
      workerId;
      start() {
        this.running = true;
        this.schedulePoll();
        logger.info(
          `Task queue started (worker=${this.workerId}, maxConcurrent=${this.config.maxConcurrent})`
        );
      }
      async stop() {
        this.running = false;
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = null;
        }
        const shutdownTimeout = 3e4;
        const start = Date.now();
        while (this.activeCount > 0 && Date.now() - start < shutdownTimeout) {
          await new Promise((r) => setTimeout(r, 100));
        }
        if (this.activeCount > 0) {
          logger.warn(`Task queue stopped with ${this.activeCount} active tasks`);
        }
      }
      getActiveCount() {
        return this.activeCount;
      }
      isRunning() {
        return this.running;
      }
      schedulePoll() {
        if (!this.running) return;
        this.timer = setTimeout(() => this.poll(), this.config.pollInterval);
      }
      async poll() {
        if (!this.running) return;
        try {
          this.taskStore.reclaimStaleTasks(this.workerId, this.config.staleClaimTimeout);
          while (this.activeCount < this.config.maxConcurrent) {
            const task = this.taskStore.claimNextSubmitted(this.workerId);
            if (!task) break;
            this.activeCount++;
            this.executeTask(task).finally(() => {
              this.activeCount--;
            });
          }
        } catch (err) {
          logger.error(`Task queue poll error: ${err instanceof Error ? err.message : String(err)}`);
        }
        this.schedulePoll();
      }
      async executeTask(task) {
        await withActiveSpan(
          "agent.queue.execute",
          {
            "agent.task.id": task.id,
            "agent.queue.worker_id": this.workerId
          },
          async () => this._executeTaskInner(task)
        );
      }
      async _executeTaskInner(task) {
        try {
          const result = await this.executor(task);
          if (result.stateAlreadySet) {
            return;
          }
          if (result.success) {
            const completedMsg = {
              message_id: crypto3.randomUUID(),
              role: "agent",
              parts: [
                {
                  text: result.summary ?? "Task completed successfully",
                  media_type: "text/markdown"
                }
              ]
            };
            this.taskStore.updateTaskState(task.id, "completed", completedMsg);
          } else {
            this.taskStore.updateTaskState(task.id, "failed", {
              message_id: crypto3.randomUUID(),
              role: "agent",
              parts: [{ text: result.error ?? "Task execution failed" }]
            });
          }
        } catch (err) {
          logger.error(
            `Task ${task.id} execution failed: ${err instanceof Error ? err.message : String(err)}`
          );
          try {
            this.taskStore.updateTaskState(task.id, "failed", {
              message_id: crypto3.randomUUID(),
              role: "agent",
              parts: [{ text: err instanceof Error ? err.message : "Unknown error" }]
            });
          } catch {
          }
        }
      }
    };
  }
});

// src/agent-protocol/a2a-frontend.ts
import http from "http";
import https from "https";
import fs2 from "fs";
import crypto4 from "crypto";
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new ParseError("Malformed JSON body"));
      }
    });
    req.on("error", reject);
  });
}
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}
function sendError(res, httpStatus, message, code) {
  sendJson(res, httpStatus, {
    error: {
      code: code ?? -httpStatus,
      message
    }
  });
}
function timingSafeEqual(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  try {
    return crypto4.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}
function validateAuth(req, config) {
  if (!config.auth || config.auth.type === "none") return true;
  if (config.auth.type === "bearer") {
    const header = req.headers["authorization"];
    if (!header || !header.startsWith("Bearer ")) return false;
    const token = header.slice(7);
    const expected = config.auth.token_env ? process.env[config.auth.token_env] : void 0;
    return timingSafeEqual(token, expected);
  }
  if (config.auth.type === "api_key") {
    const headerName = config.auth.header_name ?? "x-api-key";
    const key = req.headers[headerName.toLowerCase()];
    const expected = config.auth.key_env ? process.env[config.auth.key_env] : void 0;
    if (timingSafeEqual(key, expected)) return true;
    const paramName = config.auth.param_name ?? "api_key";
    const url = new URL(req.url || "", "http://localhost");
    const queryKey = url.searchParams.get(paramName) ?? void 0;
    return timingSafeEqual(queryKey, expected);
  }
  return false;
}
function resolveWorkflow(req, config) {
  if (config.skill_routing && Object.keys(config.skill_routing).length > 0) {
    const requestedSkill = req.metadata?.skill_id;
    if (requestedSkill && config.skill_routing[requestedSkill]) {
      return config.skill_routing[requestedSkill];
    }
  }
  return config.default_workflow ?? "assistant";
}
function messageToWorkflowInput(message, task) {
  const textContent = message.parts.filter((p) => p.text != null).map((p) => p.text).join("\n");
  const dataParts = message.parts.filter((p) => p.data != null);
  const structuredData = dataParts.length === 1 ? dataParts[0].data : dataParts.length > 1 ? dataParts.map((p) => p.data) : void 0;
  const fileParts = message.parts.filter((p) => p.url != null || p.raw != null);
  return {
    question: textContent,
    task: textContent,
    data: structuredData,
    files: fileParts.length > 0 ? fileParts : void 0,
    _agent: {
      task_id: task.id,
      context_id: task.context_id,
      message_id: message.message_id,
      metadata: message.metadata
    }
  };
}
function resultToArtifacts(checkResults) {
  const artifacts = [];
  for (const [checkId, checkResult] of Object.entries(checkResults ?? {})) {
    if (!checkResult || typeof checkResult !== "object") continue;
    const cr = checkResult;
    if (cr.status === "skipped") continue;
    const parts = [];
    if (typeof cr.output === "string") {
      parts.push({ text: cr.output, media_type: "text/markdown" });
    } else if (typeof cr.output === "object" && cr.output !== null) {
      const output = cr.output;
      if ("text" in output && typeof output.text === "string") {
        parts.push({ text: output.text, media_type: "text/markdown" });
      }
      parts.push({ data: cr.output, media_type: "application/json" });
    }
    if (Array.isArray(cr.issues) && cr.issues.length > 0) {
      parts.push({ data: cr.issues, media_type: "application/json" });
    }
    if (parts.length > 0) {
      artifacts.push({
        artifact_id: crypto4.randomUUID(),
        name: checkId,
        description: `Output from check: ${checkId}`,
        parts
      });
    }
  }
  return artifacts;
}
var A2AFrontend;
var init_a2a_frontend = __esm({
  "src/agent-protocol/a2a-frontend.ts"() {
    init_logger();
    init_task_store();
    init_types();
    init_state_transitions();
    init_task_stream_manager();
    init_push_notification_manager();
    init_task_queue();
    init_trace_helpers();
    A2AFrontend = class {
      name = "a2a";
      server = null;
      taskStore;
      agentCard = null;
      config;
      cleanupTimer = null;
      _ctx = null;
      streamManager = new TaskStreamManager();
      pushManager = new PushNotificationManager();
      _engine = null;
      // StateMachineExecutionEngine
      _visorConfig = null;
      taskQueue = null;
      _boundPort = 0;
      constructor(config, taskStore) {
        this.config = config;
        this.taskStore = taskStore ?? new SqliteTaskStore();
      }
      /** The actual port the server is listening on (useful when config.port is 0). */
      get boundPort() {
        return this._boundPort;
      }
      /** Set the execution engine for running workflows. */
      setEngine(engine) {
        this._engine = engine;
      }
      /** Set the full Visor config (needed for check definitions). */
      setVisorConfig(config) {
        this._visorConfig = config;
      }
      async start(ctx) {
        this._ctx = ctx;
        await this.taskStore.initialize();
        const db = this.taskStore.getDatabase?.();
        if (db) {
          this.pushManager.initialize(db);
        }
        if (ctx.engine) this._engine = ctx.engine;
        if (ctx.visorConfig) this._visorConfig = ctx.visorConfig;
        if (this.config.agent_card) {
          const cardPath = this.config.agent_card;
          const raw = fs2.readFileSync(cardPath, "utf8");
          this.agentCard = JSON.parse(raw);
        } else if (this.config.agent_card_inline) {
          this.agentCard = { ...this.config.agent_card_inline };
        }
        const handler = this.handleRequest.bind(this);
        if (this.config.tls) {
          const tlsOptions = {
            cert: fs2.readFileSync(this.config.tls.cert),
            key: fs2.readFileSync(this.config.tls.key)
          };
          this.server = https.createServer(tlsOptions, handler);
        } else {
          this.server = http.createServer(handler);
        }
        ctx.eventBus.on("CheckCompleted", (event) => {
          const envelope = event?.payload ? event : { payload: event };
          const taskId = envelope.metadata?.agentTaskId;
          if (!taskId) return;
          try {
            const artifact = this.checkResultToArtifact(envelope.payload);
            if (artifact) {
              this.taskStore.addArtifact(taskId, artifact);
              const task = this.taskStore.getTask(taskId);
              if (task) {
                this.emitArtifactEvent(taskId, task.context_id, artifact, false, false);
              }
            }
          } catch {
          }
        });
        ctx.eventBus.on("CheckErrored", (event) => {
          const envelope = event?.payload ? event : { payload: event };
          const taskId = envelope.metadata?.agentTaskId;
          if (!taskId) return;
          logger.warn(`Agent task ${taskId}: check errored`);
        });
        ctx.eventBus.on("HumanInputRequested", (event) => {
          const envelope = event?.payload ? event : { payload: event };
          const taskId = envelope.metadata?.agentTaskId;
          if (!taskId) return;
          try {
            const statusMessage = {
              message_id: crypto4.randomUUID(),
              role: "agent",
              parts: [{ text: envelope.payload?.prompt ?? "Agent requires input" }]
            };
            this.taskStore.updateTaskState(taskId, "input_required", statusMessage);
            const task = this.taskStore.getTask(taskId);
            if (task) {
              this.emitStatusEvent(taskId, task.context_id, task.status);
            }
          } catch {
          }
        });
        this.startCleanupSweep();
        if (this._engine && this._visorConfig) {
          const executor = this.createTaskExecutor();
          const queueCfg = this.config.queue;
          this.taskQueue = new TaskQueue(
            this.taskStore,
            executor,
            null,
            queueCfg ? {
              pollInterval: queueCfg.poll_interval,
              maxConcurrent: queueCfg.max_concurrent,
              staleClaimTimeout: queueCfg.stale_claim_timeout
            } : void 0
          );
          this.taskQueue.start();
          logger.info("[A2A] TaskQueue started for async task execution");
        }
        const port = this.config.port ?? 9e3;
        const host = this.config.host ?? "0.0.0.0";
        await new Promise((resolve) => {
          this.server.listen(port, host, () => {
            const addr = this.server.address();
            this._boundPort = typeof addr === "object" && addr ? addr.port : port;
            logger.info(`A2A server listening on ${host}:${this._boundPort}`);
            resolve();
          });
        });
        if (this.agentCard) {
          const publicUrl = this.config.public_url ?? `http://${host}:${this._boundPort}`;
          if (!this.agentCard.supported_interfaces?.length) {
            this.agentCard.supported_interfaces = [{ url: publicUrl, protocol_binding: "a2a/v1" }];
          } else {
            for (const iface of this.agentCard.supported_interfaces) {
              if (iface.protocol_binding === "a2a/v1" || !iface.url || !iface.url.startsWith("http") || iface.url.includes("localhost") || iface.url.includes("0.0.0.0")) {
                iface.url = publicUrl;
              }
            }
          }
        }
      }
      async stop() {
        this.stopCleanupSweep();
        if (this.taskQueue) {
          this.taskQueue.stop();
          this.taskQueue = null;
        }
        this.streamManager.shutdown();
        if (this.server) {
          await new Promise((resolve, reject) => {
            this.server.close((err) => err ? reject(err) : resolve());
          });
          this.server = null;
        }
        await this.taskStore.shutdown();
      }
      // -------------------------------------------------------------------------
      // HTTP request dispatcher
      // -------------------------------------------------------------------------
      async handleRequest(req, res) {
        const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
        if (url.pathname === "/.well-known/agent-card.json" && req.method === "GET") {
          return this.serveAgentCard(res);
        }
        if (!validateAuth(req, this.config)) {
          return sendError(res, 401, "Unauthorized");
        }
        try {
          if (url.pathname === "/message:send" && req.method === "POST") {
            return await this.handleSendMessage(req, res);
          }
          if (url.pathname === "/message:stream" && req.method === "POST") {
            if (!this.agentCard?.capabilities?.streaming) {
              return sendError(res, 400, "Streaming not supported", -32002);
            }
            return await this.handleSendStreamingMessage(req, res);
          }
          const taskMatch = url.pathname.match(/^\/tasks\/([^/:]+)$/);
          if (taskMatch && req.method === "GET") {
            return this.handleGetTask(taskMatch[1], res);
          }
          if (url.pathname === "/tasks" && req.method === "GET") {
            return this.handleListTasks(url.searchParams, res);
          }
          const cancelMatch = url.pathname.match(/^\/tasks\/([^/:]+):cancel$/);
          if (cancelMatch && req.method === "POST") {
            return this.handleCancelTask(cancelMatch[1], res);
          }
          const subscribeMatch = url.pathname.match(/^\/tasks\/([^/:]+):subscribe$/);
          if (subscribeMatch && req.method === "GET") {
            if (!this.agentCard?.capabilities?.streaming) {
              return sendError(res, 400, "Streaming not supported", -32002);
            }
            return this.handleSubscribeToTask(subscribeMatch[1], res);
          }
          const pushListMatch = url.pathname.match(/^\/tasks\/([^/:]+)\/pushNotificationConfigs$/);
          if (pushListMatch) {
            if (!this.agentCard?.capabilities?.push_notifications) {
              return sendError(res, 400, "Push notifications not supported", -32002);
            }
            if (req.method === "POST") {
              return await this.handleCreatePushConfig(pushListMatch[1], req, res);
            }
            if (req.method === "GET") {
              return this.handleListPushConfigs(pushListMatch[1], res);
            }
          }
          const pushDetailMatch = url.pathname.match(
            /^\/tasks\/([^/:]+)\/pushNotificationConfigs\/([^/:]+)$/
          );
          if (pushDetailMatch) {
            if (!this.agentCard?.capabilities?.push_notifications) {
              return sendError(res, 400, "Push notifications not supported", -32002);
            }
            if (req.method === "GET") {
              return this.handleGetPushConfig(pushDetailMatch[1], pushDetailMatch[2], res);
            }
            if (req.method === "DELETE") {
              return this.handleDeletePushConfig(pushDetailMatch[1], pushDetailMatch[2], res);
            }
          }
          sendError(res, 404, "MethodNotFound", -32601);
        } catch (err) {
          if (err instanceof ParseError) {
            return sendError(res, 400, err.message, -32700);
          }
          if (err instanceof TaskNotFoundError) {
            return sendError(res, 404, err.message, -32001);
          }
          if (err instanceof InvalidStateTransitionError) {
            return sendError(res, 409, err.message, -32003);
          }
          if (err instanceof InvalidRequestError) {
            return sendError(res, 400, err.message, -32600);
          }
          if (err instanceof ContextMismatchError) {
            return sendError(res, 400, err.message, -32600);
          }
          logger.error(`A2A request error: ${err instanceof Error ? err.message : String(err)}`);
          sendError(res, 500, "Internal error");
        }
      }
      // -------------------------------------------------------------------------
      // Endpoint handlers
      // -------------------------------------------------------------------------
      serveAgentCard(res) {
        if (!this.agentCard) {
          return sendError(res, 404, "Agent Card not configured");
        }
        sendJson(res, 200, this.agentCard);
      }
      async handleSendMessage(req, res) {
        const body = await readJsonBody(req);
        if (!body.message?.parts?.length) {
          throw new InvalidRequestError("Message must contain at least one part");
        }
        const existingTaskId = body.message.task_id;
        if (existingTaskId) {
          const response = await this.handleFollowUpMessage(existingTaskId, body);
          return sendJson(res, 200, response);
        }
        const contextId = body.message.context_id ?? crypto4.randomUUID();
        const workflowId = resolveWorkflow(body, this.config);
        const blocking = body.configuration?.blocking ?? false;
        await withActiveSpan(
          "agent.task",
          {
            "agent.task.context_id": contextId,
            "agent.task.workflow": workflowId,
            "agent.task.blocking": blocking,
            "agent.task.message_id": body.message.message_id ?? ""
          },
          async () => {
            const task = this.taskStore.createTask({
              contextId,
              requestMessage: body.message,
              requestConfig: body.configuration,
              requestMetadata: body.metadata,
              workflowId
            });
            this.taskStore.appendHistory(task.id, body.message);
            if (blocking) {
              await this.executeTaskDirectly(task, body.message);
              let finalTask = this.taskStore.getTask(task.id);
              const historyLength = body.configuration?.history_length;
              if (historyLength !== void 0) {
                finalTask = {
                  ...finalTask,
                  history: finalTask.history.slice(-historyLength)
                };
              }
              if (body.configuration?.accepted_output_modes?.length) {
                finalTask = this.filterOutputModes(finalTask, body.configuration.accepted_output_modes);
              }
              return sendJson(res, 200, { task: finalTask });
            }
            return sendJson(res, 200, { task: this.taskStore.getTask(task.id) });
          }
        );
      }
      async handleFollowUpMessage(taskId, req) {
        const task = this.taskStore.getTask(taskId);
        if (!task) throw new TaskNotFoundError(taskId);
        if (task.status.state !== "input_required" && task.status.state !== "auth_required") {
          throw new InvalidStateTransitionError(
            task.status.state,
            "working",
            "Task is not awaiting input"
          );
        }
        if (req.message.context_id && req.message.context_id !== task.context_id) {
          throw new ContextMismatchError(req.message.context_id, task.context_id);
        }
        this.taskStore.appendHistory(taskId, req.message);
        this.taskStore.updateTaskState(taskId, "working");
        this.emitStatusEvent(taskId, task.context_id, {
          state: "working",
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        const textContent = req.message.parts.filter((p) => p.text != null).map((p) => p.text).join("\n");
        if (this._ctx?.eventBus) {
          await this._ctx.eventBus.emit({
            type: "HumanInputReceived",
            taskId,
            message: textContent
          });
        }
        const blocking = req.configuration?.blocking ?? false;
        if (blocking) {
          await this.executeTaskDirectly(task, req.message);
          let finalTask = this.taskStore.getTask(taskId);
          const historyLength = req.configuration?.history_length;
          if (historyLength !== void 0) {
            finalTask = {
              ...finalTask,
              history: finalTask.history.slice(-historyLength)
            };
          }
          return { task: finalTask };
        }
        const updatedTask = this.taskStore.getTask(taskId);
        this.executeTaskDirectly(updatedTask, req.message).catch(() => {
        });
        return { task: this.taskStore.getTask(taskId) };
      }
      handleGetTask(taskId, res) {
        const task = this.taskStore.getTask(taskId);
        if (!task) throw new TaskNotFoundError(taskId);
        sendJson(res, 200, task);
      }
      handleListTasks(params, res) {
        const contextId = params.get("context_id") ?? void 0;
        const stateParam = params.get("state");
        const state = stateParam ? stateParam.split(",") : void 0;
        const limit = params.has("limit") ? parseInt(params.get("limit"), 10) : void 0;
        const offset = params.has("offset") ? parseInt(params.get("offset"), 10) : void 0;
        const result = this.taskStore.listTasks({ contextId, state, limit, offset });
        sendJson(res, 200, result);
      }
      handleCancelTask(taskId, res) {
        const task = this.taskStore.getTask(taskId);
        if (!task) throw new TaskNotFoundError(taskId);
        this.taskStore.updateTaskState(taskId, "canceled");
        const updated = this.taskStore.getTask(taskId);
        sendJson(res, 200, updated);
      }
      // -------------------------------------------------------------------------
      // Streaming handlers
      // -------------------------------------------------------------------------
      async handleSendStreamingMessage(req, res) {
        const body = await readJsonBody(req);
        if (!body.message?.parts?.length) {
          throw new InvalidRequestError("Message must contain at least one part");
        }
        const contextId = body.message.context_id ?? crypto4.randomUUID();
        const workflowId = resolveWorkflow(body, this.config);
        const task = this.taskStore.createTask({
          contextId,
          requestMessage: body.message,
          requestConfig: body.configuration,
          requestMetadata: body.metadata,
          workflowId
        });
        this.taskStore.appendHistory(task.id, body.message);
        this.streamManager.subscribe(task.id, res);
        this.emitStatusEvent(task.id, contextId, task.status);
        this.executeTaskDirectly(task, body.message).then(() => {
          const finalTask = this.taskStore.getTask(task.id);
          if (finalTask) {
            this.emitStatusEvent(task.id, contextId, finalTask.status);
          }
        }).catch(() => {
        });
      }
      handleSubscribeToTask(taskId, res) {
        const task = this.taskStore.getTask(taskId);
        if (!task) throw new TaskNotFoundError(taskId);
        if (isTerminalState(task.status.state)) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
          });
          const event = {
            type: "TaskStatusUpdateEvent",
            task_id: taskId,
            context_id: task.context_id,
            status: task.status
          };
          res.write(`data: ${JSON.stringify(event)}

`);
          res.end();
          return;
        }
        this.streamManager.subscribe(taskId, res);
        this.emitStatusEvent(taskId, task.context_id, task.status);
      }
      // -------------------------------------------------------------------------
      // Push notification handlers
      // -------------------------------------------------------------------------
      async handleCreatePushConfig(taskId, req, res) {
        const task = this.taskStore.getTask(taskId);
        if (!task) throw new TaskNotFoundError(taskId);
        const body = await readJsonBody(req);
        if (!body.url) {
          throw new InvalidRequestError("Push notification config must include url");
        }
        const config = this.pushManager.create({
          task_id: taskId,
          url: body.url,
          token: body.token,
          auth_scheme: body.auth_scheme,
          auth_credentials: body.auth_credentials
        });
        sendJson(res, 200, config);
      }
      handleListPushConfigs(taskId, res) {
        const task = this.taskStore.getTask(taskId);
        if (!task) throw new TaskNotFoundError(taskId);
        const configs = this.pushManager.list(taskId);
        sendJson(res, 200, { configs });
      }
      handleGetPushConfig(taskId, configId, res) {
        const config = this.pushManager.get(taskId, configId);
        if (!config) {
          return sendError(res, 404, "Push notification config not found", -32001);
        }
        sendJson(res, 200, config);
      }
      handleDeletePushConfig(taskId, configId, res) {
        const deleted = this.pushManager.delete(taskId, configId);
        if (!deleted) {
          return sendError(res, 404, "Push notification config not found", -32001);
        }
        sendJson(res, 200, { deleted: true });
      }
      // -------------------------------------------------------------------------
      // Event emission helpers
      // -------------------------------------------------------------------------
      /** Emit a task status update to SSE subscribers and push notification targets. */
      emitStatusEvent(taskId, contextId, status) {
        const event = {
          type: "TaskStatusUpdateEvent",
          task_id: taskId,
          context_id: contextId,
          status
        };
        this.streamManager.emit(taskId, event);
        this.pushManager.notifyAll(taskId, event).catch((err) => {
          logger.error(`Push notification error: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      /** Emit an artifact update to SSE subscribers and push notification targets. */
      emitArtifactEvent(taskId, contextId, artifact, append, lastChunk) {
        const event = {
          type: "TaskArtifactUpdateEvent",
          task_id: taskId,
          context_id: contextId,
          artifact,
          append,
          last_chunk: lastChunk
        };
        this.streamManager.emit(taskId, event);
        this.pushManager.notifyAll(taskId, event).catch((err) => {
          logger.error(`Push notification error: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      // -------------------------------------------------------------------------
      // Execution
      // -------------------------------------------------------------------------
      /**
       * Execute a task, either via the engine (if available) or with a stub response (for tests).
       */
      async executeTaskDirectly(task, message) {
        try {
          const currentTask = this.taskStore.getTask(task.id);
          if (currentTask && currentTask.status.state !== "working") {
            this.taskStore.updateTaskState(task.id, "working");
            this.emitStatusEvent(task.id, task.context_id, {
              state: "working",
              timestamp: (/* @__PURE__ */ new Date()).toISOString()
            });
          }
          if (this._engine && this._visorConfig) {
            await this.executeTaskViaEngine(task, message);
          } else {
            const agentResponse = {
              message_id: crypto4.randomUUID(),
              role: "agent",
              parts: [{ text: `Task ${task.id} received and processed.`, media_type: "text/markdown" }]
            };
            this.taskStore.appendHistory(task.id, agentResponse);
            this.taskStore.updateTaskState(task.id, "completed", agentResponse);
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : "Unknown error";
          logger.error(`[A2A] Task ${task.id} execution failed: ${errorMsg}`);
          try {
            const failMessage = {
              message_id: crypto4.randomUUID(),
              role: "agent",
              parts: [{ text: errorMsg }]
            };
            this.taskStore.updateTaskState(task.id, "failed", failMessage);
            this.emitStatusEvent(task.id, task.context_id, {
              state: "failed",
              message: failMessage,
              timestamp: (/* @__PURE__ */ new Date()).toISOString()
            });
          } catch {
          }
        }
      }
      /**
       * Execute a task through the Visor engine.
       * Creates a fresh engine execution per task and converts results to artifacts.
       */
      async executeTaskViaEngine(task, message) {
        const workflowId = task.workflow_id ?? this.config.default_workflow;
        const checks = workflowId ? [workflowId] : ["all"];
        const workflowInputs = messageToWorkflowInput(message, task);
        const prevCtx = this._engine.getExecutionContext?.() || {};
        this._engine.setExecutionContext?.({ ...prevCtx, workflowInputs });
        const execOptions = {
          checks,
          config: this._visorConfig,
          timeout: 3e5
        };
        const result = await this._engine.executeChecks(execOptions);
        const groupedResults = result?.executionStatistics?.groupedResults ?? result?.results ?? {};
        const artifacts = [];
        if (result?.reviewSummary) {
          const summaryParts = [];
          if (result.reviewSummary.issues?.length) {
            const issueText = result.reviewSummary.issues.map((i) => `- **${i.severity}**: ${i.message} (${i.file}:${i.line})`).join("\n");
            summaryParts.push({ text: `## Issues Found

${issueText}`, media_type: "text/markdown" });
            summaryParts.push({ data: result.reviewSummary.issues, media_type: "application/json" });
          }
          if (summaryParts.length > 0) {
            artifacts.push({
              artifact_id: crypto4.randomUUID(),
              name: "review-summary",
              description: "Review summary with issues found",
              parts: summaryParts
            });
          }
        }
        if (groupedResults && typeof groupedResults === "object") {
          for (const [groupName, groupChecks] of Object.entries(groupedResults)) {
            if (!Array.isArray(groupChecks)) continue;
            for (const cr of groupChecks) {
              const parts = [];
              if (typeof cr.content === "string" && cr.content.trim()) {
                parts.push({ text: cr.content, media_type: "text/markdown" });
              }
              if (cr.output != null) {
                parts.push({ data: cr.output, media_type: "application/json" });
              }
              if (parts.length > 0) {
                artifacts.push({
                  artifact_id: crypto4.randomUUID(),
                  name: cr.checkName ?? groupName,
                  description: `Output from check: ${cr.checkName ?? groupName}`,
                  parts
                });
              }
            }
          }
        }
        if (artifacts.length === 0) {
          artifacts.push({
            artifact_id: crypto4.randomUUID(),
            name: "result",
            description: "Execution result",
            parts: [
              {
                text: `Executed ${checks.join(", ")} checks. ${result?.checksExecuted?.length ?? 0} checks ran.`,
                media_type: "text/markdown"
              }
            ]
          });
        }
        for (let i = 0; i < artifacts.length; i++) {
          this.taskStore.addArtifact(task.id, artifacts[i]);
          this.emitArtifactEvent(
            task.id,
            task.context_id,
            artifacts[i],
            false,
            i === artifacts.length - 1
          );
        }
        const agentResponse = {
          message_id: crypto4.randomUUID(),
          role: "agent",
          parts: [
            {
              text: `Completed ${artifacts.length} artifact(s) from ${result?.checksExecuted?.length ?? 0} check(s).`,
              media_type: "text/markdown"
            }
          ],
          metadata: {
            executionTime: result?.executionTime,
            checksExecuted: result?.checksExecuted
          }
        };
        this.taskStore.appendHistory(task.id, agentResponse);
        this.taskStore.updateTaskState(task.id, "completed", agentResponse);
        this.emitStatusEvent(task.id, task.context_id, {
          state: "completed",
          message: agentResponse,
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
      }
      /**
       * Create a TaskExecutor callback for the TaskQueue.
       * The queue handles state transitions (submitted → working), so the executor
       * focuses on running the engine and converting results.
       */
      createTaskExecutor() {
        return async (task) => {
          try {
            const userMessage = task.history.find((m) => m.role === "user");
            if (!userMessage) return { success: false, error: "No user message found" };
            await this.executeTaskViaEngine(task, userMessage);
            return { success: true, stateAlreadySet: true };
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : "Unknown error";
            return { success: false, error: errorMsg, stateAlreadySet: true };
          }
        };
      }
      // -------------------------------------------------------------------------
      // Helpers
      // -------------------------------------------------------------------------
      checkResultToArtifact(payload) {
        if (!payload || typeof payload !== "object") return null;
        const p = payload;
        const parts = [];
        if (typeof p.output === "string") {
          parts.push({ text: p.output, media_type: "text/markdown" });
        } else if (typeof p.output === "object" && p.output !== null) {
          parts.push({ data: p.output, media_type: "application/json" });
        }
        if (parts.length === 0) return null;
        return {
          artifact_id: crypto4.randomUUID(),
          name: p.checkId ?? "check-result",
          parts
        };
      }
      filterOutputModes(task, acceptedModes) {
        const filteredArtifacts = task.artifacts.map((a) => ({
          ...a,
          parts: a.parts.filter(
            (p) => acceptedModes.some((mode) => (p.media_type ?? "text/plain").startsWith(mode))
          )
        })).filter((a) => a.parts.length > 0);
        return { ...task, artifacts: filteredArtifacts };
      }
      startCleanupSweep() {
        this.cleanupTimer = setInterval(() => {
          try {
            const deletedTaskIds = this.taskStore.deleteExpiredTasks();
            if (deletedTaskIds.length > 0) {
              for (const taskId of deletedTaskIds) {
                this.pushManager.deleteForTask(taskId);
              }
              logger.info(`[A2A] Cleaned up ${deletedTaskIds.length} expired tasks`);
            }
          } catch (err) {
            logger.error(
              `[A2A] Cleanup sweep error: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }, 36e5);
      }
      stopCleanupSweep() {
        if (this.cleanupTimer) {
          clearInterval(this.cleanupTimer);
          this.cleanupTimer = null;
        }
      }
      // -------------------------------------------------------------------------
      // Public accessors (for testing)
      // -------------------------------------------------------------------------
      getTaskStore() {
        return this.taskStore;
      }
      getAgentCard() {
        return this.agentCard;
      }
    };
  }
});
init_a2a_frontend();
export {
  A2AFrontend,
  messageToWorkflowInput,
  resultToArtifacts
};
//# sourceMappingURL=a2a-frontend-7CYN3X7M.mjs.map