import {
  getInstanceId,
  init_instance_id,
  require_package
} from "./chunk-MFXPJUUE.mjs";
import {
  init_logger,
  logger
} from "./chunk-FT3I25QV.mjs";
import {
  init_lazy_otel,
  trace
} from "./chunk-UCMJJ3IM.mjs";
import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/agent-protocol/track-execution.ts
import crypto from "crypto";
import path from "path";
function getPackageVersion() {
  try {
    return require_package()?.version || "dev";
  } catch {
    return "dev";
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
  taskStore.updateTaskState(task.id, "working");
  taskStore.claimTask(task.id, instanceId);
  logger.info(
    `[TaskTracking] Task ${task.id} started (source=${source}, workflow=${workflowId || "-"}, instance=${instanceId})`
  );
  try {
    const result = await executor();
    try {
      const activeTraceId = trace.getActiveSpan()?.spanContext().traceId;
      if (activeTraceId && activeTraceId !== "" && !task.metadata?.trace_id) {
        taskStore.updateMetadata(task.id, { trace_id: activeTraceId });
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
    throw err;
  }
}
function scheduleEvaluation(taskId, taskStore) {
  setTimeout(async () => {
    try {
      const { evaluateAndStore } = await import("./task-evaluator-GQYDOSGT.mjs");
      await evaluateAndStore(taskId, taskStore);
      logger.info(`[TaskEvaluator] Auto-evaluation completed for task ${taskId}`);
    } catch (err) {
      logger.warn(
        `[TaskEvaluator] Auto-evaluation failed for task ${taskId}: ${err instanceof Error ? err.message : err}`
      );
    }
  }, 5e3);
}
var init_track_execution = __esm({
  "src/agent-protocol/track-execution.ts"() {
    init_logger();
    init_lazy_otel();
    init_instance_id();
  }
});
init_track_execution();
export {
  trackExecution
};
//# sourceMappingURL=track-execution-66RLL6QT.mjs.map