/**
 * Persistent task store for agent protocol tasks.
 *
 * SQLite-backed (reuses the better-sqlite3 pattern from scheduler).
 * Stores agent tasks with full state machine enforcement.
 */
import { AgentTask, AgentMessage, AgentArtifact, AgentSendMessageConfig, TaskState } from './types';
export interface CreateTaskParams {
    contextId: string;
    requestMessage: AgentMessage;
    requestConfig?: AgentSendMessageConfig;
    requestMetadata?: Record<string, unknown>;
    workflowId?: string;
    expiresAt?: string;
}
export interface ListTasksFilter {
    contextId?: string;
    state?: TaskState[];
    workflowId?: string;
    search?: string;
    claimedBy?: string;
    /** Filter by key-value pairs in request_metadata JSON (uses JSON_EXTRACT). */
    metadata?: Record<string, string>;
    limit?: number;
    offset?: number;
}
/** Raw task row for queue monitoring — includes claim metadata. */
export interface TaskQueueRow {
    id: string;
    context_id: string;
    state: TaskState;
    created_at: string;
    updated_at: string;
    claimed_by: string | null;
    claimed_at: string | null;
    workflow_id: string | null;
    run_id: string | null;
    request_message: string;
    source: string;
    metadata: Record<string, unknown>;
}
export interface ListTasksResult {
    tasks: AgentTask[];
    total: number;
}
export interface TaskStore {
    initialize(): Promise<void>;
    shutdown(): Promise<void>;
    createTask(params: CreateTaskParams): AgentTask;
    getTask(taskId: string): AgentTask | null;
    listTasks(filter: ListTasksFilter): ListTasksResult;
    updateTaskState(taskId: string, newState: TaskState, statusMessage?: AgentMessage): void;
    /** Set claimed_by/claimed_at on a task (used by trackExecution to record instance ID). */
    claimTask(taskId: string, workerId: string): void;
    /** Touch updated_at to signal the task is still being actively worked on. */
    heartbeat(taskId: string): void;
    addArtifact(taskId: string, artifact: AgentArtifact): void;
    appendHistory(taskId: string, message: AgentMessage): void;
    setRunId(taskId: string, runId: string): void;
    /** Merge additional key-value pairs into the task's metadata JSON. */
    updateMetadata(taskId: string, extra: Record<string, unknown>): void;
    claimNextSubmitted(workerId: string): AgentTask | null;
    reclaimStaleTasks(workerId: string, staleTimeoutMs?: number): AgentTask[];
    releaseClaim(taskId: string): void;
    listTasksRaw?(filter: ListTasksFilter): {
        rows: TaskQueueRow[];
        total: number;
    };
    /** Mark 'working' tasks as 'failed' (crash recovery on startup).
     *  When `claimedBy` is provided, only fails tasks owned by that instance.
     *  Without it, only fails **unclaimed** working tasks (safe default). */
    failStaleTasks(reason?: string, claimedBy?: string): number;
    /** Mark 'working' tasks older than the given age as 'failed' (runtime stale detection). */
    failStaleTasksByAge(olderThanMs: number, reason?: string): number;
    /** Delete completed/failed/canceled tasks older than the given age. */
    purgeOldTasks(olderThanMs: number): number;
    deleteExpiredTasks(): string[];
    deleteTask(taskId: string): void;
}
export declare class SqliteTaskStore implements TaskStore {
    private db;
    private dbPath;
    constructor(filename?: string);
    initialize(): Promise<void>;
    shutdown(): Promise<void>;
    private getDb;
    /** Expose the underlying database for sibling managers (e.g. PushNotificationManager). */
    getDatabase(): unknown;
    private migrateSchema;
    createTask(params: CreateTaskParams): AgentTask;
    getTask(taskId: string): AgentTask | null;
    private buildFilterClause;
    listTasks(filter: ListTasksFilter): ListTasksResult;
    listTasksRaw(filter: ListTasksFilter): {
        rows: TaskQueueRow[];
        total: number;
    };
    updateTaskState(taskId: string, newState: TaskState, statusMessage?: AgentMessage): void;
    claimTask(taskId: string, workerId: string): void;
    heartbeat(taskId: string): void;
    addArtifact(taskId: string, artifact: AgentArtifact): void;
    appendHistory(taskId: string, message: AgentMessage): void;
    setRunId(taskId: string, runId: string): void;
    updateMetadata(taskId: string, extra: Record<string, unknown>): void;
    claimNextSubmitted(workerId: string): AgentTask | null;
    reclaimStaleTasks(_workerId: string, staleTimeoutMs?: number): AgentTask[];
    releaseClaim(taskId: string): void;
    failStaleTasks(reason?: string, claimedBy?: string): number;
    failStaleTasksByAge(olderThanMs: number, reason?: string): number;
    purgeOldTasks(olderThanMs: number): number;
    deleteExpiredTasks(): string[];
    deleteTask(taskId: string): void;
    private resolveContextId;
}
//# sourceMappingURL=task-store.d.ts.map