/**
 * Async task queue for agent protocol tasks.
 *
 * Polls the task store for SUBMITTED tasks, claims them, and executes
 * them via the engine. Same polling pattern as the scheduler.
 */

import crypto from 'crypto';
import { logger } from '../logger';
import type { TaskStore } from './task-store';
import type { AgentTask, AgentMessage, AgentArtifact, AgentPart } from './types';

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
    try {
      // Task is already in WORKING state from claimNextSubmitted

      const result = await this.executor(task);

      // Convert results to artifacts
      if (result.checkResults) {
        const artifacts = this.resultToArtifacts(result.checkResults);
        for (const artifact of artifacts) {
          this.taskStore.addArtifact(task.id, artifact);
        }
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

  private resultToArtifacts(checkResults: Record<string, unknown>): AgentArtifact[] {
    const artifacts: AgentArtifact[] = [];

    for (const [checkId, checkResult] of Object.entries(checkResults)) {
      if (!checkResult || typeof checkResult !== 'object') continue;
      const cr = checkResult as Record<string, unknown>;
      if (cr.status === 'skipped') continue;

      const parts: AgentPart[] = [];

      if (typeof cr.output === 'string') {
        parts.push({ text: cr.output, media_type: 'text/markdown' });
      } else if (typeof cr.output === 'object' && cr.output !== null) {
        parts.push({ data: cr.output, media_type: 'application/json' });
      }

      if (parts.length > 0) {
        artifacts.push({
          artifact_id: crypto.randomUUID(),
          name: checkId,
          description: `Output from check: ${checkId}`,
          parts,
        });
      }
    }

    return artifacts;
  }
}
