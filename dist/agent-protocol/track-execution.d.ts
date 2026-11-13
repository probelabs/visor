/**
 * Shared execution tracking helper.
 *
 * Wraps any engine execution call with task lifecycle management:
 * creates a task in 'submitted' state, transitions to 'working',
 * runs the executor, then sets terminal state (completed/failed).
 *
 * Used by CLI, Slack, TUI, and Scheduler frontends when task_tracking is enabled.
 */
import type { TaskLiveUpdatesConfig } from '../types/config';
import type { TaskStore } from './task-store';
import type { AgentTask } from './types';
import { type TaskLiveUpdateSink } from './task-live-updates';
export type TaskSource = 'cli' | 'slack' | 'telegram' | 'email' | 'whatsapp' | 'teams' | 'a2a' | 'mcp' | 'tui' | 'scheduler' | 'webhook' | 'test';
export interface TrackExecutionOptions {
    taskStore: TaskStore;
    source: TaskSource;
    workflowId?: string;
    /** Config file path — used to prefix workflowId as "config.yaml#workflow" */
    configPath?: string;
    metadata?: Record<string, unknown>;
    /** Human-readable description of what's being executed */
    messageText: string;
    /** Run LLM evaluation after task completion (non-blocking). */
    autoEvaluate?: boolean;
    /** Optional live progress updates for supported interactive frontends. */
    liveUpdates?: {
        config?: boolean | TaskLiveUpdatesConfig;
        sink?: TaskLiveUpdateSink;
        includeTraceId?: boolean;
    };
}
/**
 * Wrap an engine execution call with task lifecycle tracking.
 *
 * Creates a task, transitions to 'working', runs the executor,
 * then sets terminal state. Returns both the task and the original result.
 * Re-throws any executor error after marking the task as failed.
 */
export declare function trackExecution<T>(opts: TrackExecutionOptions, executor: () => Promise<T>): Promise<{
    task: AgentTask;
    result: T;
}>;
//# sourceMappingURL=track-execution.d.ts.map