import {
  TaskLiveUpdateManager,
  init_task_live_updates,
  resolveTaskLiveUpdatesConfig
} from "./chunk-SRU5TFNY.mjs";
import "./chunk-IY5PQ5EN.mjs";
import {
  init_task_trace_resolution,
  resolveTaskTraceReference
} from "./chunk-WZQMTD7W.mjs";
import {
  getInstanceId,
  init_instance_id,
  require_package
} from "./chunk-F45PSSFG.mjs";
import {
  init_logger,
  logger
} from "./chunk-6E625R3C.mjs";
import {
  init_lazy_otel,
  trace
} from "./chunk-B2OUZAWY.mjs";
import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/agent-protocol/track-execution.ts
import crypto from "crypto";
import fs from "fs";
import path from "path";
function getPackageVersion() {
  try {
    return require_package()?.version || "dev";
  } catch {
    return "dev";
  }
}
async function readTraceIdFromFallbackFile(traceFile) {
  if (!traceFile || !fs.existsSync(traceFile)) return void 0;
  try {
    const { readTraceIdFromFile } = await import("./trace-serializer-EBHTHZYT.mjs");
    return await readTraceIdFromFile(traceFile) || void 0;
  } catch {
    return void 0;
  }
}
async function trackExecution(opts, executor) {
  const { taskStore, source, configPath, metadata, messageText } = opts;
  const configName = configPath ? path.basename(configPath, path.extname(configPath)) : void 0;
  const workflowId = configName && opts.workflowId ? `${configName}#${opts.workflowId}` : opts.workflowId;
  const requestMessage = {
    message_id: crypto.randomUUID(),
    role: "user",
    parts: [{ text: messageText }]
  };
  const traceFile = process.env.VISOR_FALLBACK_TRACE_FILE || void 0;
  const task = taskStore.createTask({
    contextId: crypto.randomUUID(),
    requestMessage,
    workflowId,
    requestMetadata: {
      source,
      instance_id: getInstanceId(),
      visor_version: process.env.VISOR_VERSION || getPackageVersion(),
      ...process.env.VISOR_COMMIT_SHORT ? { visor_commit: process.env.VISOR_COMMIT_SHORT } : {},
      trace_id: trace.getActiveSpan()?.spanContext().traceId || void 0,
      ...traceFile ? { trace_file: traceFile } : {},
      ...metadata
    }
  });
  const instanceId = getInstanceId();
  return await logger.withTaskContext(task.id, async () => {
    taskStore.updateTaskState(task.id, "working");
    taskStore.claimTask(task.id, instanceId);
    logger.info(
      `[TaskTracking] Task ${task.id} started (source=${source}, workflow=${workflowId || "-"}, instance=${instanceId})`
    );
    const liveUpdateConfig = resolveTaskLiveUpdatesConfig(opts.liveUpdates?.config);
    const initialTraceId = trace.getActiveSpan()?.spanContext().traceId || task.metadata?.trace_id;
    if (initialTraceId && !task.metadata?.trace_id) {
      try {
        taskStore.updateMetadata(task.id, { trace_id: initialTraceId });
      } catch {
      }
    }
    const initialResolvedTrace = await resolveTaskTraceReference({
      trace_id: initialTraceId || task.metadata?.trace_id,
      trace_file: task.metadata?.trace_file
    });
    const liveUpdateManager = liveUpdateConfig && opts.liveUpdates?.sink ? new TaskLiveUpdateManager({
      taskId: task.id,
      requestText: messageText,
      traceRef: initialResolvedTrace.primaryRef,
      traceId: initialResolvedTrace.traceId,
      includeTraceId: opts.liveUpdates?.includeTraceId === true,
      sink: opts.liveUpdates.sink,
      config: liveUpdateConfig,
      resolveTraceState: () => {
        let current;
        try {
          current = taskStore.getTask(task.id);
        } catch {
          return {
            traceRef: initialResolvedTrace.primaryRef,
            traceId: initialResolvedTrace.traceId
          };
        }
        return {
          traceRef: current?.metadata?.trace_id || current?.metadata?.trace_file || initialResolvedTrace.primaryRef,
          traceId: current?.metadata?.trace_id
        };
      },
      onPostedRef: (ref) => {
        try {
          taskStore.updateMetadata(task.id, ref);
        } catch {
        }
      },
      appendHistory: (text, stage) => {
        try {
          taskStore.appendHistory(task.id, {
            message_id: crypto.randomUUID(),
            role: "agent",
            parts: [{ text }],
            metadata: { kind: "task_live_update", stage, source }
          });
        } catch {
        }
      }
    }) : null;
    if (liveUpdateConfig && !opts.liveUpdates?.sink) {
      logger.debug(
        `[TaskTracking] Live updates requested for task ${task.id} but no sink is available for source=${source}`
      );
    } else if (liveUpdateManager) {
      logger.info(`[TaskTracking] Live updates enabled for task ${task.id} (source=${source})`);
    }
    const HEARTBEAT_INTERVAL = 6e4;
    const heartbeatTimer = setInterval(() => {
      try {
        taskStore.heartbeat(task.id);
      } catch {
      }
    }, HEARTBEAT_INTERVAL);
    try {
      if (liveUpdateManager) {
        await liveUpdateManager.start();
      }
      const result = await executor();
      try {
        const activeTraceId = trace.getActiveSpan()?.spanContext().traceId;
        const persistedTraceId = (activeTraceId && activeTraceId !== "" ? activeTraceId : void 0) || await readTraceIdFromFallbackFile(traceFile);
        if (persistedTraceId && !task.metadata?.trace_id) {
          taskStore.updateMetadata(task.id, { trace_id: persistedTraceId });
        }
      } catch {
      }
      let responseText = "Execution completed";
      try {
        const history = result?.reviewSummary?.history;
        if (history) {
          const entries = Object.values(history);
          for (let i = entries.length - 1; i >= 0; i--) {
            const outputs = entries[i];
            if (!Array.isArray(outputs)) continue;
            for (let j = outputs.length - 1; j >= 0; j--) {
              const text = outputs[j]?.text;
              if (typeof text === "string" && text.trim().length > 0) {
                responseText = text.trim();
                break;
              }
            }
            if (responseText !== "Execution completed") break;
          }
        }
      } catch {
      }
      const completedMsg = {
        message_id: crypto.randomUUID(),
        role: "agent",
        parts: [{ text: responseText }]
      };
      try {
        taskStore.updateTaskState(task.id, "completed", completedMsg);
        logger.info(`[TaskTracking] Task ${task.id} completed`);
      } catch (stateErr) {
        logger.warn(
          `[TaskTracking] Task ${task.id} completed but state transition failed: ${stateErr instanceof Error ? stateErr.message : stateErr}`
        );
      }
      if (opts.autoEvaluate || process.env.VISOR_TASK_EVALUATE === "true") {
        scheduleEvaluation(task.id, taskStore);
      }
      if (liveUpdateManager) {
        await liveUpdateManager.complete(responseText);
      }
      return { task, result };
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      const failMessage = {
        message_id: crypto.randomUUID(),
        role: "agent",
        parts: [{ text: errorText }]
      };
      try {
        taskStore.updateTaskState(task.id, "failed", failMessage);
        logger.info(`[TaskTracking] Task ${task.id} failed: ${errorText}`);
      } catch {
      }
      if (liveUpdateManager) {
        await liveUpdateManager.fail(`:warning: ${errorText}`);
      }
      throw err;
    } finally {
      clearInterval(heartbeatTimer);
      liveUpdateManager?.stop();
    }
  });
}
function scheduleEvaluation(taskId, taskStore) {
  setTimeout(async () => {
    await logger.withTaskContext(taskId, async () => {
      try {
        const { evaluateAndStore } = await import("./task-evaluator-H3BXC7SE.mjs");
        await evaluateAndStore(taskId, taskStore);
        logger.info(`[TaskEvaluator] Auto-evaluation completed for task ${taskId}`);
      } catch (err) {
        logger.warn(
          `[TaskEvaluator] Auto-evaluation failed for task ${taskId}: ${err instanceof Error ? err.message : err}`
        );
      }
    });
  }, 5e3);
}
var init_track_execution = __esm({
  "src/agent-protocol/track-execution.ts"() {
    init_logger();
    init_lazy_otel();
    init_instance_id();
    init_task_live_updates();
    init_task_trace_resolution();
  }
});
init_track_execution();
export {
  trackExecution
};
//# sourceMappingURL=track-execution-QZ5H3CMJ.mjs.map