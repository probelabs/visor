/**
 * Shared execution tracking helper.
 *
 * Wraps any engine execution call with task lifecycle management:
 * creates a task in 'submitted' state, transitions to 'working',
 * runs the executor, then sets terminal state (completed/failed).
 *
 * Used by CLI, Slack, TUI, and Scheduler frontends when task_tracking is enabled.
 */

import crypto from 'crypto';
import path from 'path';
import { logger } from '../logger';
import { trace } from '../telemetry/lazy-otel';
import { getInstanceId } from '../utils/instance-id';
import type { TaskStore } from './task-store';
import type { AgentMessage, AgentTask } from './types';

export type TaskSource =
  | 'cli'
  | 'slack'
  | 'telegram'
  | 'email'
  | 'whatsapp'
  | 'teams'
  | 'a2a'
  | 'mcp'
  | 'tui'
  | 'scheduler'
  | 'webhook';

export interface TrackExecutionOptions {
  taskStore: TaskStore;
  source: TaskSource;
  workflowId?: string;
  /** Config file path — used to prefix workflowId as "config.yaml#workflow" */
  configPath?: string;
  metadata?: Record<string, unknown>;
  /** Human-readable description of what's being executed */
  messageText: string;
}

/**
 * Wrap an engine execution call with task lifecycle tracking.
 *
 * Creates a task, transitions to 'working', runs the executor,
 * then sets terminal state. Returns both the task and the original result.
 * Re-throws any executor error after marking the task as failed.
 */
export async function trackExecution<T>(
  opts: TrackExecutionOptions,
  executor: () => Promise<T>
): Promise<{ task: AgentTask; result: T }> {
  const { taskStore, source, configPath, metadata, messageText } = opts;
  const configName = configPath ? path.basename(configPath, path.extname(configPath)) : undefined;
  const workflowId =
    configName && opts.workflowId ? `${configName}#${opts.workflowId}` : opts.workflowId;

  const requestMessage: AgentMessage = {
    message_id: crypto.randomUUID(),
    role: 'user',
    parts: [{ text: messageText }],
  };

  const task = taskStore.createTask({
    contextId: crypto.randomUUID(),
    requestMessage,
    workflowId,
    requestMetadata: {
      source,
      instance_id: getInstanceId(),
      trace_id: trace.getActiveSpan()?.spanContext().traceId || undefined,
      ...metadata,
    },
  });

  const instanceId = getInstanceId();
  taskStore.updateTaskState(task.id, 'working');
  taskStore.claimTask(task.id, instanceId);
  logger.info(
    `[TaskTracking] Task ${task.id} started (source=${source}, workflow=${workflowId || '-'}, instance=${instanceId})`
  );

  try {
    const result = await executor();

    // Extract AI response text from the result.
    // result.reviewSummary.history is keyed by checkId with arrays of outputs.
    // We want the LAST check's text output (the final AI response), not the
    // first (which is typically the intent router).
    let responseText = 'Execution completed';
    try {
      const history = (result as any)?.reviewSummary?.history as
        | Record<string, unknown[]>
        | undefined;
      if (history) {
        const entries = Object.values(history);
        // Iterate in reverse — last check output is the final response
        for (let i = entries.length - 1; i >= 0; i--) {
          const outputs = entries[i];
          if (!Array.isArray(outputs)) continue;
          // Within a check, look at the last output first too
          for (let j = outputs.length - 1; j >= 0; j--) {
            const text = (outputs[j] as any)?.text;
            if (typeof text === 'string' && text.trim().length > 0) {
              responseText = text.trim();
              break;
            }
          }
          if (responseText !== 'Execution completed') break;
        }
      }
    } catch {
      // ignore extraction errors
    }

    const completedMsg: AgentMessage = {
      message_id: crypto.randomUUID(),
      role: 'agent',
      parts: [{ text: responseText }],
    };
    taskStore.updateTaskState(task.id, 'completed', completedMsg);
    logger.info(`[TaskTracking] Task ${task.id} completed`);

    return { task, result };
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    const failMessage: AgentMessage = {
      message_id: crypto.randomUUID(),
      role: 'agent',
      parts: [{ text: errorText }],
    };
    try {
      taskStore.updateTaskState(task.id, 'failed', failMessage);
      logger.info(`[TaskTracking] Task ${task.id} failed: ${errorText}`);
    } catch {
      // ignore double-failure
    }
    throw err; // re-throw to preserve original behavior
  }
}
