import {
  init_logger,
  logger
} from "./chunk-SZXICFQ3.mjs";
import "./chunk-UCMJJ3IM.mjs";
import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/agent-protocol/track-execution.ts
import crypto from "crypto";
async function trackExecution(opts, executor) {
  const { taskStore, source, workflowId, metadata, messageText } = opts;
  const requestMessage = {
    message_id: crypto.randomUUID(),
    role: "user",
    parts: [{ text: messageText }]
  };
  const task = taskStore.createTask({
    contextId: crypto.randomUUID(),
    requestMessage,
    workflowId,
    requestMetadata: { source, ...metadata }
  });
  taskStore.updateTaskState(task.id, "working");
  logger.info(
    `[TaskTracking] Task ${task.id} started (source=${source}, workflow=${workflowId || "-"})`
  );
  try {
    const result = await executor();
    const completedMsg = {
      message_id: crypto.randomUUID(),
      role: "agent",
      parts: [{ text: "Execution completed" }]
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
  }
});
init_track_execution();
export {
  trackExecution
};
//# sourceMappingURL=track-execution-UYB52PE2.mjs.map