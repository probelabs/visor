/**
 * Async task queue for agent protocol tasks.
 *
 * Polls the task store for SUBMITTED tasks, claims them, and executes
 * them via the engine. Same polling pattern as the scheduler.
 */

import crypto from 'crypto';
import { logger } from '../logger';
import type { TaskStore } from './task-store';
import type { AgentTask, AgentMessage } from './types';
import { withActiveSpan } from '../telemetry/trace-helpers';

// ---------------------------------------------------------------------------
// Queue config
// ---------------------------------------------------------------------------

export interface TaskQueueConfig {
  pollInterval: number; // ms, default 1000
  maxConcurrent: number; // default 5
  staleClaimTimeout: number; // ms, default 300000
}

const DEFAULT_CONFIG: TaskQueueConfig = {
  pollInterval: 1000,
  maxConcurrent: 5,
  staleClaimTimeout: 300_000,
};

// ---------------------------------------------------------------------------
// Execute callback type
// ---------------------------------------------------------------------------

export type TaskExecutor = (task: AgentTask) => Promise<{
  success: boolean;
  checkResults?: Record<string, unknown>;
  error?: string;
  summary?: string;
  /** When true, the executor already set the terminal state — the queue should skip its own transition. */
  stateAlreadySet?: boolean;
}>;

// ---------------------------------------------------------------------------
// TaskQueue
// ---------------------------------------------------------------------------

export class TaskQueue {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeCount = 0;
  private config: TaskQueueConfig;
  private workerId: string;

  constructor(
    private taskStore: TaskStore,
    private executor: TaskExecutor,
    _eventBus: unknown,
    config?: Partial<TaskQueueConfig>,
    workerId?: string
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.workerId = workerId ?? crypto.randomUUID();
  }

  start(): void {
    this.running = true;
    this.schedulePoll();
    logger.info(
      `Task queue started (worker=${this.workerId}, maxConcurrent=${this.config.maxConcurrent})`
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Wait for active tasks to finish (with timeout)
    const shutdownTimeout = 30_000;
    const start = Date.now();
    while (this.activeCount > 0 && Date.now() - start < shutdownTimeout) {
      await new Promise(r => setTimeout(r, 100));
    }

    if (this.activeCount > 0) {
      logger.warn(`Task queue stopped with ${this.activeCount} active tasks`);
    }
  }

  getActiveCount(): number {
    return this.activeCount;
  }

  isRunning(): boolean {
    return this.running;
  }

  private schedulePoll(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => this.poll(), this.config.pollInterval);
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      // Reclaim stale tasks from crashed workers back to 'submitted'
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

  private async executeTask(task: AgentTask): Promise<void> {
    await withActiveSpan(
      'agent.queue.execute',
      {
        'agent.task.id': task.id,
        'agent.queue.worker_id': this.workerId,
      },
      async () => this._executeTaskInner(task)
    );
  }

  private async _executeTaskInner(task: AgentTask): Promise<void> {
    try {
      // Task is already in WORKING state from claimNextSubmitted

      const result = await this.executor(task);

      // If the executor already handled the terminal state transition, we're done.
      if (result.stateAlreadySet) {
        return;
      }

      // Set terminal state
      if (result.success) {
        const completedMsg: AgentMessage = {
          message_id: crypto.randomUUID(),
          role: 'agent',
          parts: [
            {
              text: result.summary ?? 'Task completed successfully',
              media_type: 'text/markdown',
            },
          ],
        };
        this.taskStore.updateTaskState(task.id, 'completed', completedMsg);
      } else {
        this.taskStore.updateTaskState(task.id, 'failed', {
          message_id: crypto.randomUUID(),
          role: 'agent',
          parts: [{ text: result.error ?? 'Task execution failed' }],
        });
      }
    } catch (err) {
      logger.error(
        `Task ${task.id} execution failed: ${err instanceof Error ? err.message : String(err)}`
      );
      try {
        this.taskStore.updateTaskState(task.id, 'failed', {
          message_id: crypto.randomUUID(),
          role: 'agent',
          parts: [{ text: err instanceof Error ? err.message : 'Unknown error' }],
        });
      } catch {
        // ignore double-failure
      }
    }
  }
}
