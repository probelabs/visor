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
import type { TaskStore } from './agent-protocol/task-store';
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
    error: {
        code: string;
        message: string;
        retryable: boolean;
    } | null;
    user_message: string;
    next_instruction_for_model: string;
}
/**
 * Manages async jobs for MCP tool calls, backed by the existing TaskStore.
 *
 * Jobs created here are visible via `visor tasks list` and `visor tasks show`.
 */
export declare class JobManager {
    private taskStore;
    private longPollTimeoutMs;
    constructor(taskStore: TaskStore, opts?: {
        longPollTimeoutMs?: number;
    });
    /**
     * Start a new async job. Creates a task, runs the handler in the background,
     * and returns immediately with the task ID.
     */
    startJob(handler: () => Promise<any>, opts: {
        messageText: string;
        workflowId?: string;
        configPath?: string;
        metadata?: Record<string, unknown>;
    }): JobResponse;
    /**
     * Get the current state of a job by ID (supports both short and full IDs).
     *
     * Uses long polling: if the job is still running, waits up to 59 seconds
     * for it to finish before responding. Returns immediately if the job is
     * already in a terminal state (completed/failed).
     */
    getJob(jobId: string): Promise<JobResponse>;
    /**
     * Resolve a task by full UUID or short ID prefix.
     */
    private resolveTask;
}
