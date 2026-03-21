/**
 * MCP Job Manager — async job pattern for long-running MCP tool calls.
 *
 * Claude Code and other MCP clients have timeout issues with long-running tools.
 * This module provides a `start_job` / `get_job` pattern: the tool call returns
 * immediately with a job_id, and the client polls `get_job` until done.
 */

import * as crypto from 'crypto';

/** Job status values. */
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'expired';

/** Progress information for a running job. */
export interface JobProgress {
  percent: number | null;
  step: string;
  message: string;
}

/** Error information for a failed job. */
export interface JobError {
  code: string;
  message: string;
  retryable: boolean;
}

/** Internal job record. */
interface JobRecord {
  id: string;
  status: JobStatus;
  progress: JobProgress;
  result: any;
  error: JobError | null;
  createdAt: number;
  completedAt: number | null;
  idempotencyKey?: string;
}

/** Response shape returned by both start_job and get_job. */
export interface JobResponse {
  job_id: string;
  status: JobStatus;
  done: boolean;
  progress: JobProgress;
  polling: {
    recommended_next_action: 'get_job' | 'none';
    recommended_delay_seconds: number;
  };
  result: any;
  error: JobError | null;
  user_message: string;
  next_instruction_for_model: string;
}

/** Default TTL for completed/failed jobs: 1 hour. */
const JOB_TTL_MS = 60 * 60 * 1000;

/** How often to run cleanup (5 minutes). */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Manages async jobs for MCP tool calls.
 *
 * Usage:
 *   const mgr = new JobManager();
 *   const response = mgr.startJob(() => executeWorkflow(args));
 *   // ... later ...
 *   const status = mgr.getJob(jobId);
 */
export class JobManager {
  private jobs = new Map<string, JobRecord>();
  private idempotencyIndex = new Map<string, string>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Allow process to exit even if timer is running
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Start a new async job. Returns immediately with a queued response.
   * The handler runs in the background.
   */
  startJob(
    handler: (updateProgress: (progress: Partial<JobProgress>) => void) => Promise<any>,
    idempotencyKey?: string
  ): JobResponse {
    // Idempotency check: if same key already exists, return existing job
    if (idempotencyKey) {
      const existingId = this.idempotencyIndex.get(idempotencyKey);
      if (existingId) {
        const existing = this.jobs.get(existingId);
        if (existing) {
          return this.buildResponse(existing);
        }
        // Job was cleaned up — remove stale index entry
        this.idempotencyIndex.delete(idempotencyKey);
      }
    }

    const id = crypto.randomBytes(3).toString('hex'); // 6-char hex ID
    const job: JobRecord = {
      id,
      status: 'queued',
      progress: { percent: 0, step: 'queued', message: 'Job accepted and queued' },
      result: null,
      error: null,
      createdAt: Date.now(),
      completedAt: null,
      idempotencyKey,
    };

    this.jobs.set(id, job);
    if (idempotencyKey) {
      this.idempotencyIndex.set(idempotencyKey, id);
    }

    // Run handler in background
    const updateProgress = (progress: Partial<JobProgress>) => {
      const current = this.jobs.get(id);
      if (current && current.status === 'running') {
        current.progress = { ...current.progress, ...progress };
      }
    };

    // Transition to running and execute
    job.status = 'running';
    job.progress = { percent: null, step: 'running', message: 'Job is executing' };

    handler(updateProgress)
      .then(result => {
        const current = this.jobs.get(id);
        if (current) {
          current.status = 'completed';
          current.progress = {
            percent: 100,
            step: 'completed',
            message: 'Job finished successfully',
          };
          current.result = result;
          current.completedAt = Date.now();
        }
      })
      .catch(err => {
        const current = this.jobs.get(id);
        if (current) {
          current.status = 'failed';
          current.progress = {
            percent: null,
            step: 'failed',
            message: 'The job failed before completion',
          };
          current.error = {
            code: err?.code || 'EXECUTION_ERROR',
            message: err instanceof Error ? err.message : String(err),
            retryable: true,
          };
          current.completedAt = Date.now();
        }
      });

    return this.buildResponse(job);
  }

  /**
   * Get the current state of a job.
   */
  getJob(jobId: string): JobResponse {
    const job = this.jobs.get(jobId);
    if (!job) {
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
    return this.buildResponse(job);
  }

  /**
   * Remove expired jobs (completed/failed older than TTL).
   */
  cleanup(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      const age = now - (job.completedAt || job.createdAt);
      if ((job.status === 'completed' || job.status === 'failed') && age > JOB_TTL_MS) {
        this.jobs.delete(id);
        if (job.idempotencyKey) {
          this.idempotencyIndex.delete(job.idempotencyKey);
        }
      }
    }
  }

  /**
   * Stop the cleanup timer. Call this when shutting down.
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private buildResponse(job: JobRecord): JobResponse {
    const done = job.status === 'completed' || job.status === 'failed' || job.status === 'expired';
    const polling = done
      ? { recommended_next_action: 'none' as const, recommended_delay_seconds: 0 }
      : { recommended_next_action: 'get_job' as const, recommended_delay_seconds: 10 };

    let userMessage: string;
    let nextInstruction: string;

    switch (job.status) {
      case 'queued':
        userMessage = 'The job has been queued.';
        nextInstruction =
          'Call get_job with this job_id after 10 seconds. Continue calling get_job until done is true.';
        break;
      case 'running':
        userMessage = 'The job is still running.';
        nextInstruction =
          'Call get_job again with this job_id after 10 seconds. Continue calling get_job until done is true.';
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
      case 'expired':
        userMessage = 'The previous job expired.';
        nextInstruction = 'If the user still wants the result, start a new job.';
        break;
    }

    return {
      job_id: job.id,
      status: job.status,
      done,
      progress: job.progress,
      polling,
      result: job.result,
      error: job.error,
      user_message: userMessage,
      next_instruction_for_model: nextInstruction,
    };
  }
}
