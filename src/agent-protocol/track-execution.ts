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
import { logger } from '../logger';
import type { TaskStore } from './task-store';
import type { AgentMessage, AgentTask } from './types';

export type TaskSource = 'cli' | 'slack' | 'a2a' | 'tui' | 'scheduler' | 'webhook';

export interface TrackExecutionOptions {
  taskStore: TaskStore;
  source: TaskSource;
  workflowId?: string;
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
  const { taskStore, source, workflowId, metadata, messageText } = opts;

  const requestMessage: AgentMessage = {
    message_id: crypto.randomUUID(),
    role: 'user',
    parts: [{ text: messageText }],
  };

  const task = taskStore.createTask({
    contextId: crypto.randomUUID(),
    requestMessage,
    workflowId,
    requestMetadata: { source, ...metadata },
  });

  taskStore.updateTaskState(task.id, 'working');
  logger.info(
    `[TaskTracking] Task ${task.id} started (source=${source}, workflow=${workflowId || '-'})`
  );

  try {
    const result = await executor();

    const completedMsg: AgentMessage = {
      message_id: crypto.randomUUID(),
      role: 'agent',
      parts: [{ text: 'Execution completed' }],
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
