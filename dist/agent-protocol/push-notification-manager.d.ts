/**
 * PushNotificationManager — delivers webhook push notifications for task events.
 *
 * Persists push notification configs in the task store's SQLite database,
 * and delivers events via HTTP POST with retry logic.
 */
import type { AgentPushNotificationConfig, TaskStatusUpdateEvent, TaskArtifactUpdateEvent } from './types';
export type PushEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;
interface DbLike {
    exec(source: string): void;
    prepare(source: string): {
        run(...params: unknown[]): {
            changes: number;
        };
        get(...params: unknown[]): unknown;
        all(...params: unknown[]): unknown[];
    };
}
export declare class PushNotificationManager {
    private db;
    private maxRetries;
    private baseDelayMs;
    private deliveryTimeoutMs;
    constructor(options?: {
        maxRetries?: number;
        baseDelayMs?: number;
        deliveryTimeoutMs?: number;
    });
    /**
     * Initialize with a database connection. Must be called before any operations.
     * Creates the push configs table if it doesn't exist.
     */
    initialize(db: DbLike): void;
    private migrateSchema;
    private getDb;
    create(config: AgentPushNotificationConfig): AgentPushNotificationConfig;
    get(taskId: string, configId: string): AgentPushNotificationConfig | null;
    list(taskId: string): AgentPushNotificationConfig[];
    delete(taskId: string, configId: string): boolean;
    deleteForTask(taskId: string): number;
    /**
     * Deliver an event to all push configs registered for a task.
     * Uses exponential backoff retry for server errors.
     */
    notifyAll(taskId: string, event: PushEvent): Promise<void>;
    private deliver;
    private rowToConfig;
}
export {};
//# sourceMappingURL=push-notification-manager.d.ts.map