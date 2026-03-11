import {
  getInstanceId,
  init_instance_id
} from "./chunk-6VVXKXTI.mjs";
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
async function trackExecution(opts, executor) {
  const { taskStore, source, configPath, metadata, messageText } = opts;
  const configName = configPath ? path.basename(configPath, path.extname(configPath)) : void 0;
  const workflowId = configName && opts.workflowId ? `${configName}#${opts.workflowId}` : opts.workflowId;
  const requestMessage = {
    message_id: crypto.randomUUID(),
    role: "user",
    parts: [{ text: messageText }]
  };
  const task = taskStore.createTask({
    contextId: crypto.randomUUID(),
    requestMessage,
    workflowId,
    requestMetadata: {
      source,
      instance_id: getInstanceId(),
      trace_id: trace.getActiveSpan()?.spanContext().traceId || void 0,
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
    let responseText = "Execution completed";
    try {
      const history = result?.reviewSummary?.history;
      if (history) {
        for (const outputs of Object.values(history)) {
          if (!Array.isArray(outputs)) continue;
          for (const out of outputs) {
            const text = out?.text;
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
    taskStore.updateTaskState(task.id, "completed", completedMsg);
    logger.info(`[TaskTracking] Task ${task.id} completed`);
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
//# sourceMappingURL=track-execution-2Q66SXBZ.mjs.map