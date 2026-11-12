/**
 * TaskStreamManager — manages SSE subscribers for task updates.
 *
 * Provides subscribe/emit/cleanup for real-time task event streaming.
 * Each subscriber is an HTTP ServerResponse that receives SSE events.
 */
import http from 'http';
import type { TaskStatusUpdateEvent, TaskArtifactUpdateEvent } from './types';
export type TaskEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;
export declare class TaskStreamManager {
    private subscribers;
    private keepaliveTimers;
    private keepaliveIntervalMs;
    constructor(keepaliveIntervalMs?: number);
    /**
     * Subscribe an HTTP response to SSE events for a task.
     * Sets SSE headers and registers cleanup on disconnect.
     */
    subscribe(taskId: string, res: http.ServerResponse): void;
    /**
     * Emit an event to all subscribers of a task.
     * If the event is a terminal status update, closes all connections.
     */
    emit(taskId: string, event: TaskEvent): void;
    /**
     * Check if a task has any active subscribers.
     */
    hasSubscribers(taskId: string): boolean;
    /**
     * Get count of subscribers for a task.
     */
    getSubscriberCount(taskId: string): number;
    /**
     * Close all connections and clean up.
     */
    shutdown(): void;
    private removeSubscriber;
    private clearKeepalive;
}
//# sourceMappingURL=task-stream-manager.d.ts.map