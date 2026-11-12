import type { ScheduleStoreBackend, StorageConfig, HAConfig, ScheduleStoreStats, MessageTrigger } from './store/types';
/**
 * Output context for schedule execution results
 */
export interface ScheduleOutputContext {
    /** Output destination type */
    type: 'slack' | 'github' | 'webhook' | 'none';
    /** Target identifier (channel ID, repo name, webhook URL, etc.) */
    target?: string;
    /** Thread/issue/PR identifier for threaded outputs */
    threadId?: string;
    /** Additional destination-specific metadata */
    metadata?: Record<string, unknown>;
}
/**
 * Represents a scheduled workflow execution
 */
export interface Schedule {
    id: string;
    creatorId: string;
    creatorContext?: string;
    creatorName?: string;
    timezone: string;
    schedule: string;
    runAt?: number;
    isRecurring: boolean;
    originalExpression: string;
    workflow?: string;
    workflowInputs?: Record<string, unknown>;
    outputContext?: ScheduleOutputContext;
    status: 'active' | 'paused' | 'completed' | 'failed';
    createdAt: number;
    lastRunAt?: number;
    nextRunAt?: number;
    runCount: number;
    failureCount: number;
    lastError?: string;
    previousResponse?: string;
}
/**
 * Configuration for the schedule store
 */
export interface ScheduleStoreConfig {
    /** Path to the JSON file for persistence (legacy, triggers auto-migration) */
    path?: string;
    /** Auto-save after changes (default: true) — ignored for SQL backends */
    autoSave?: boolean;
    /** Debounce save operations in ms (default: 1000) — ignored for SQL backends */
    saveDebounceMs?: number;
    /** SQL storage configuration */
    storage?: StorageConfig;
    /** High-availability configuration */
    ha?: HAConfig;
}
/**
 * Limits configuration for schedules
 */
export interface ScheduleLimits {
    maxPerUser?: number;
    maxRecurringPerUser?: number;
    maxGlobal?: number;
}
/**
 * Storage class for scheduled workflows with pluggable backend persistence
 */
export declare class ScheduleStore {
    private static instance;
    private static onTriggersChanged?;
    private backend;
    private initialized;
    private limits;
    private config;
    private externalBackend;
    /**
     * Register a callback to be invoked when message triggers change (create/update/delete).
     * Used by SlackSocketRunner to rebuild its evaluator.
     */
    static setTriggersChangedCallback(cb: () => void): void;
    private constructor();
    /**
     * Get singleton instance
     *
     * Note: Config and limits are only applied on first call. Subsequent calls
     * with different parameters will log a warning and return the existing instance.
     * Use createIsolated() for testing with different configurations.
     */
    static getInstance(config?: ScheduleStoreConfig, limits?: ScheduleLimits): ScheduleStore;
    /**
     * Create a new isolated instance (for testing)
     */
    static createIsolated(config?: ScheduleStoreConfig, limits?: ScheduleLimits, backend?: ScheduleStoreBackend): ScheduleStore;
    /**
     * Reset singleton instance (for testing)
     */
    static resetInstance(): void;
    /**
     * Initialize the store - creates backend and runs migrations
     */
    initialize(): Promise<void>;
    /**
     * Create a new schedule (async, persists immediately)
     */
    createAsync(schedule: Omit<Schedule, 'id' | 'createdAt' | 'runCount' | 'failureCount' | 'status'>): Promise<Schedule>;
    /**
     * Get a schedule by ID
     */
    getAsync(id: string): Promise<Schedule | undefined>;
    /**
     * Update a schedule
     */
    updateAsync(id: string, patch: Partial<Schedule>): Promise<Schedule | undefined>;
    /**
     * Delete a schedule
     */
    deleteAsync(id: string): Promise<boolean>;
    /**
     * Get all schedules for a specific creator
     */
    getByCreatorAsync(creatorId: string): Promise<Schedule[]>;
    /**
     * Get all active schedules
     */
    getActiveSchedulesAsync(): Promise<Schedule[]>;
    /**
     * Get all schedules due for execution
     * @param now Current timestamp in milliseconds
     */
    getDueSchedulesAsync(now?: number): Promise<Schedule[]>;
    /**
     * Find schedules by workflow name
     */
    findByWorkflowAsync(creatorId: string, workflowName: string): Promise<Schedule[]>;
    /**
     * Get schedule count statistics
     */
    getStatsAsync(): Promise<ScheduleStoreStats>;
    /**
     * Force immediate save (useful for shutdown)
     */
    flush(): Promise<void>;
    /**
     * Check if initialized
     */
    isInitialized(): boolean;
    /**
     * Check if there are unsaved changes
     */
    hasPendingChanges(): boolean;
    /**
     * Get all schedules
     */
    getAllAsync(): Promise<Schedule[]>;
    /**
     * Get the underlying backend (for HA lock operations)
     */
    getBackend(): ScheduleStoreBackend;
    /**
     * Create a new message trigger
     */
    createTriggerAsync(trigger: Omit<MessageTrigger, 'id' | 'createdAt'>): Promise<MessageTrigger>;
    /**
     * Get a trigger by ID
     */
    getTriggerAsync(id: string): Promise<MessageTrigger | undefined>;
    /**
     * Update a trigger
     */
    updateTriggerAsync(id: string, patch: Partial<MessageTrigger>): Promise<MessageTrigger | undefined>;
    /**
     * Delete a trigger
     */
    deleteTriggerAsync(id: string): Promise<boolean>;
    /**
     * Get all triggers for a specific creator
     */
    getTriggersByCreatorAsync(creatorId: string): Promise<MessageTrigger[]>;
    /**
     * Get all active triggers
     */
    getActiveTriggersAsync(): Promise<MessageTrigger[]>;
    /**
     * Shut down the backend cleanly
     */
    shutdown(): Promise<void>;
}
//# sourceMappingURL=schedule-store.d.ts.map