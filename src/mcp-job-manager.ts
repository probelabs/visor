/**
 * MCP Job Manager — async job pattern for long-running MCP tool calls.
 *
 * Claude Code and other MCP clients have timeout issues with long-running tools.
 * This module provides a `start_job` / `get_job` pattern: the tool call returns
 * immediately with a job_id, and the client polls `get_job` until done.
 *
 * This is a thin wrapper over the existing TaskStore — jobs are persisted as
 * regular Visor tasks (visible via `visor tasks list`, `visor tasks show`).
 */

import crypto from 'crypto';
import { logger } from './logger';
import type { TaskStore } from './agent-protocol/task-store';
import type { AgentTask, TaskState } from './agent-protocol/types';

/** Job status values exposed to MCP clients. */
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'expired';

/** Response shape returned by both start_job and get_job. */
export interface JobResponse {
  job_id: string;
  status: JobStatus;
  done: boolean;
  progress: {
    percent: number | null;
    step: string;
    message: string;
  };
  polling: {
    recommended_next_action: 'get_job' | 'none';
    recommended_delay_seconds: number;
  };
  result: any;
  error: { code: string; message: string; retryable: boolean } | null;
  user_message: string;
  next_instruction_for_model: string;
}

/** Map TaskState → JobStatus for the MCP response. */
function taskStateToJobStatus(state: TaskState): JobStatus {
  switch (state) {
    case 'submitted':
      return 'queued';
    case 'working':
    case 'input_required':
    case 'auth_required':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'canceled':
    case 'rejected':
      return 'failed';
    default:
      return 'running';
  }
}

/**
 * Build the standardized MCP job response from an AgentTask.
 */
function buildResponse(task: AgentTask): JobResponse {
  const status = taskStateToJobStatus(task.status.state);
  const done = status === 'completed' || status === 'failed';

  const polling = done
    ? { recommended_next_action: 'none' as const, recommended_delay_seconds: 0 }
    : { recommended_next_action: 'get_job' as const, recommended_delay_seconds: 0 };

  // Extract result text from task status message or artifacts
  let result: any = null;
  if (status === 'completed') {
    // The completed status message contains the AI response text
    const statusText = task.status.message?.parts?.[0]?.text;
    if (statusText) {
      result = statusText;
    }
    // Also check artifacts for richer output
    if (task.artifacts.length > 0) {
      const artifactTexts = task.artifacts
        .flatMap(a => a.parts)
        .filter(p => p.text)
        .map(p => p.text);
      if (artifactTexts.length > 0 && !result) {
        result = artifactTexts.join('\n');
      }
    }
  }

  // Extract error from failed status message
  let error: JobResponse['error'] = null;
  if (status === 'failed' && task.status.message) {
    const errorText = task.status.message.parts?.[0]?.text || 'Unknown error';
    error = {
      code: 'EXECUTION_ERROR',
      message: errorText,
      retryable: true,
    };
  }

  // Build progress
  let progress: JobResponse['progress'];
  switch (status) {
    case 'queued':
      progress = { percent: 0, step: 'queued', message: 'Job accepted and queued' };
      break;
    case 'running':
      progress = { percent: null, step: 'running', message: 'Job is executing' };
      break;
    case 'completed':
      progress = { percent: 100, step: 'completed', message: 'Job finished successfully' };
      break;
    case 'failed':
      progress = { percent: null, step: 'failed', message: 'The job failed before completion' };
      break;
    default:
      progress = { percent: null, step: status, message: `Job is ${status}` };
  }

  // Instructions for the model
  let userMessage: string;
  let nextInstruction: string;
  switch (status) {
    case 'queued':
      userMessage = 'The job has been queued.';
      nextInstruction =
        'Call get_job with this job_id. It will wait up to 59 seconds for the result. If it returns with done still false, call get_job again.';
      break;
    case 'running':
      userMessage = 'The job is still running.';
      nextInstruction =
        'Call get_job again with this job_id. It will wait up to 59 seconds for the result. If it returns with done still false, call get_job again.';
      break;
    case 'completed':
      userMessage = 'The result is ready.';
      nextInstruction = 'Use the result to answer the user.';
      break;
    case 'failed':
      userMessage = 'The job failed.';
      nextInstruction =
        'Explain the failure briefly. If the user still wants the result, start a new job.';
      break;
    default:
      userMessage = `Job status: ${status}`;
      nextInstruction = 'Call get_job again after 10 seconds.';
  }

  return {
    job_id: task.id.slice(0, 8),
    status,
    done,
    progress,
    polling,
    result,
    error,
    user_message: userMessage,
    next_instruction_for_model: nextInstruction,
  };
}

/** Build an "expired/not found" response. */
function buildExpiredResponse(jobId: string): JobResponse {
  return {
    job_id: jobId,
    status: 'expired',
    done: true,
    progress: { percent: null, step: 'expired', message: 'This job is no longer available' },
    polling: { recommended_next_action: 'none', recommended_delay_seconds: 0 },
    result: null,
    error: { code: 'JOB_EXPIRED', message: 'The job is no longer available', retryable: true },
    user_message: 'The previous job expired.',
    next_instruction_for_model: 'If the user still wants the result, start a new job.',
  };
}

/**
 * Manages async jobs for MCP tool calls, backed by the existing TaskStore.
 *
 * Jobs created here are visible via `visor tasks list` and `visor tasks show`.
 */
export class JobManager {
  private longPollTimeoutMs: number;

  constructor(
    private taskStore: TaskStore,
    opts?: { longPollTimeoutMs?: number }
  ) {
    this.longPollTimeoutMs = opts?.longPollTimeoutMs ?? 59_000;
  }

  /**
   * Start a new async job. Creates a task, runs the handler in the background,
   * and returns immediately with the task ID.
   */
  startJob(
    handler: () => Promise<any>,
    opts: {
      messageText: string;
      workflowId?: string;
      configPath?: string;
      metadata?: Record<string, unknown>;
    }
  ): JobResponse {
    // Create task via trackExecution pattern (inline, since we need non-blocking)
    const { getInstanceId } = require('./utils/instance-id');

    const requestMessage = {
      message_id: crypto.randomUUID(),
      role: 'user' as const,
      parts: [{ text: opts.messageText }],
    };

    const task = this.taskStore.createTask({
      contextId: crypto.randomUUID(),
      requestMessage,
      workflowId: opts.workflowId,
      requestMetadata: {
        source: 'mcp',
        instance_id: getInstanceId(),
        async_job: true,
        ...opts.metadata,
      },
    });

    // Transition to working
    this.taskStore.updateTaskState(task.id, 'working');
    this.taskStore.claimTask(task.id, getInstanceId());

    logger.info(
      `[MCP-AsyncJob] Job ${task.id.slice(0, 8)} started (workflow=${opts.workflowId || '-'})`
    );

    // Heartbeat timer
    const heartbeatTimer = setInterval(() => {
      try {
        this.taskStore.heartbeat(task.id);
      } catch {
        // best-effort
      }
    }, 60_000);
    if (heartbeatTimer.unref) heartbeatTimer.unref();

    // Run handler in background
    handler()
      .then(result => {
        clearInterval(heartbeatTimer);

        // Extract response text from the result (same logic as track-execution.ts)
        let responseText = 'Execution completed';
        try {
          // If result is an MCP content response, extract the text
          const content = result?.content;
          if (Array.isArray(content)) {
            const texts = content.filter((c: any) => c.type === 'text').map((c: any) => c.text);
            if (texts.length > 0) responseText = texts.join('\n');
          } else if (typeof result === 'string') {
            responseText = result;
          } else {
            // Try engine result format
            const history = result?.reviewSummary?.history;
            if (history) {
              const entries = Object.values(history);
              for (let i = entries.length - 1; i >= 0; i--) {
                const outputs = entries[i] as any[];
                if (!Array.isArray(outputs)) continue;
                for (let j = outputs.length - 1; j >= 0; j--) {
                  const text = outputs[j]?.text;
                  if (typeof text === 'string' && text.trim().length > 0) {
                    responseText = text.trim();
                    break;
                  }
                }
                if (responseText !== 'Execution completed') break;
              }
            }
          }
        } catch {
          // ignore extraction errors
        }

        const completedMsg = {
          message_id: crypto.randomUUID(),
          role: 'agent' as const,
          parts: [{ text: responseText }],
        };
        try {
          this.taskStore.updateTaskState(task.id, 'completed', completedMsg);
          logger.info(`[MCP-AsyncJob] Job ${task.id.slice(0, 8)} completed`);
        } catch (stateErr) {
          logger.warn(
            `[MCP-AsyncJob] Job ${task.id.slice(0, 8)} completed but state transition failed: ${stateErr}`
          );
        }
      })
      .catch(err => {
        clearInterval(heartbeatTimer);
        const errorText = err instanceof Error ? err.message : String(err);
        const failMsg = {
          message_id: crypto.randomUUID(),
          role: 'agent' as const,
          parts: [{ text: errorText }],
        };
        try {
          this.taskStore.updateTaskState(task.id, 'failed', failMsg);
          logger.info(`[MCP-AsyncJob] Job ${task.id.slice(0, 8)} failed: ${errorText}`);
        } catch {
          // ignore
        }
      });

    return buildResponse(task);
  }

  /**
   * Get the current state of a job by ID (supports both short and full IDs).
   *
   * Uses long polling: if the job is still running, waits up to 59 seconds
   * for it to finish before responding. Returns immediately if the job is
   * already in a terminal state (completed/failed).
   */
  async getJob(jobId: string): Promise<JobResponse> {
    const resolvedTask = this.resolveTask(jobId);
    if (!resolvedTask) {
      return buildExpiredResponse(jobId);
    }

    // If already done, return immediately
    const initialStatus = taskStateToJobStatus(resolvedTask.status.state);
    if (initialStatus === 'completed' || initialStatus === 'failed') {
      return buildResponse(resolvedTask);
    }

    // Long poll: check every 500ms for up to the configured timeout
    const POLL_INTERVAL_MS = 500;
    const MAX_WAIT_MS = this.longPollTimeoutMs;
    const deadline = Date.now() + MAX_WAIT_MS;

    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

      const task = this.resolveTask(jobId);
      if (!task) {
        return buildExpiredResponse(jobId);
      }

      const status = taskStateToJobStatus(task.status.state);
      if (status === 'completed' || status === 'failed') {
        return buildResponse(task);
      }
    }

    // Timeout — return current state (still running)
    const finalTask = this.resolveTask(jobId);
    if (!finalTask) {
      return buildExpiredResponse(jobId);
    }
    return buildResponse(finalTask);
  }

  /**
   * Resolve a task by full UUID or short ID prefix.
   */
  private resolveTask(jobId: string): import('./agent-protocol/types').AgentTask | null {
    // Try direct lookup first (full UUID)
    let task = this.taskStore.getTask(jobId);

    // If not found and looks like a short ID, search by prefix
    if (!task && jobId.length < 36) {
      const { tasks } = this.taskStore.listTasks({ limit: 200 });
      task = tasks.find(t => t.id.startsWith(jobId)) || null;
    }

    return task;
  }
}
