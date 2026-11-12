/**
 * Async task queue for agent protocol tasks.
 *
 * Polls the task store for SUBMITTED tasks, claims them, and executes
 * them via the engine. Same polling pattern as the scheduler.
 */
import type { TaskStore } from './task-store';
import type { AgentTask } from './types';
export interface TaskQueueConfig {
    pollInterval: number;
    maxConcurrent: number;
    staleClaimTimeout: number;
}
export type TaskExecutor = (task: AgentTask) => Promise<{
    success: boolean;
    checkResults?: Record<string, unknown>;
    error?: string;
    summary?: string;
    /** When true, the executor already set the terminal state — the queue should skip its own transition. */
    stateAlreadySet?: boolean;
}>;
export declare class TaskQueue {
    private taskStore;
    private executor;
    private running;
    private timer;
    private activeCount;
    private config;
    private workerId;
    constructor(taskStore: TaskStore, executor: TaskExecutor, _eventBus: unknown, config?: Partial<TaskQueueConfig>, workerId?: string);
    start(): void;
    stop(): Promise<void>;
    getActiveCount(): number;
    isRunning(): boolean;
    private schedulePoll;
    private poll;
    private executeTask;
    private _executeTaskInner;
}
//# sourceMappingURL=task-queue.d.ts.map