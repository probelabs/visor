import { ScheduleStore, Schedule, ScheduleLimits } from './schedule-store';
import type { VisorConfig } from '../types/config';
import { StateMachineExecutionEngine } from '../state-machine-execution-engine';
import type { StorageConfig, HAConfig, ScheduleStoreStats } from './store/types';
/**
 * Context enricher interface for frontend-specific functionality
 * This allows frontends (Slack, GitHub, etc.) to inject their specific context
 * without polluting the generic scheduler.
 */
export interface ScheduleContextEnricher {
    /**
     * Enrich the schedule context before execution
     * @returns Additional context to merge into the synthetic payload
     */
    enrichContext?(schedule: Schedule): Promise<{
        threadMessages?: Array<{
            user: string;
            text: string;
        }>;
        additionalPayload?: Record<string, unknown>;
    }>;
    /**
     * Prepare the execution environment before running the workflow
     * @param schedule The schedule being executed
     * @param reminderText The reminder text (for simple reminders)
     */
    prepareExecution?(schedule: Schedule, reminderText: string): Promise<void>;
    /**
     * Get the webhook endpoint for this frontend
     */
    getWebhookEndpoint?(): string;
}
/**
 * Output adapter interface for sending schedule results to different destinations
 */
export interface ScheduleOutputAdapter {
    /** Adapter type identifier */
    type: 'slack' | 'github' | 'webhook' | 'none';
    /**
     * Send schedule execution result to the destination
     * @param schedule The schedule that was executed
     * @param result The execution result (success/failure + output)
     */
    sendResult(schedule: Schedule, result: ScheduleExecutionResult): Promise<void>;
}
/**
 * Result of schedule execution
 */
export interface ScheduleExecutionResult {
    success: boolean;
    output?: unknown;
    error?: string;
    executionTimeMs: number;
}
/**
 * Configuration for the scheduler
 */
export interface SchedulerConfig {
    /** Enable/disable the scheduler (default: true) */
    enabled?: boolean;
    /** Path to the schedules storage file */
    storagePath?: string;
    /** Check interval for due schedules in ms (default: 60000 - 1 minute) */
    checkIntervalMs?: number;
    /** Limits for schedules */
    limits?: ScheduleLimits;
    /** Default timezone for schedules (default: UTC) */
    defaultTimezone?: string;
    /** SQL storage configuration */
    storage?: StorageConfig;
    /** High-availability configuration */
    ha?: HAConfig;
}
/**
 * Generic scheduler that manages schedule execution
 */
export declare class Scheduler {
    private store;
    private visorConfig;
    private checkIntervalMs;
    private defaultTimezone;
    private checkInterval;
    private cronJobs;
    private oneTimeTimeouts;
    private running;
    private engine?;
    private outputAdapters;
    private executionContext;
    private contextEnricher?;
    private taskStore?;
    private configPath?;
    private haConfig?;
    private nodeId;
    private heartbeatInterval;
    private heldLocks;
    constructor(visorConfig: VisorConfig, config?: SchedulerConfig);
    /**
     * Set the execution engine (called after construction to avoid circular deps)
     */
    setEngine(engine: StateMachineExecutionEngine): void;
    /** Set shared task store for execution tracking. */
    setTaskStore(store: import('../agent-protocol/task-store').TaskStore, configPath?: string): void;
    /**
     * Set the execution context (e.g., Slack client) for workflow executions
     */
    setExecutionContext(context: Record<string, unknown>): void;
    /**
     * Register an output adapter for a specific type
     */
    registerOutputAdapter(adapter: ScheduleOutputAdapter): void;
    /**
     * Register a context enricher for frontend-specific functionality
     * This allows frontends to inject thread history, prompt state, etc.
     */
    registerContextEnricher(enricher: ScheduleContextEnricher): void;
    /**
     * Get the schedule store instance
     */
    getStore(): ScheduleStore;
    /**
     * Cancel a schedule's in-memory job (cron or timeout).
     * Called after deleting from DB to ensure the job doesn't fire again.
     */
    cancelSchedule(scheduleId: string): void;
    /**
     * Start the scheduler
     */
    start(): Promise<void>;
    /**
     * Load and schedule static cron jobs from visor config
     * These are defined in scheduler.cron section and always run regardless of permissions
     */
    private loadStaticCronJobs;
    /**
     * Schedule a static cron job from config
     */
    private scheduleStaticCronJob;
    /**
     * Execute a static cron job
     */
    private executeStaticCronJob;
    /**
     * Internal: execute a static cron job (after lock is held in HA mode)
     */
    private doExecuteStaticCronJob;
    /**
     * Stop the scheduler
     */
    stop(): Promise<void>;
    /**
     * Start the heartbeat timer for renewing HA locks
     */
    private startHeartbeat;
    /**
     * Stop the heartbeat timer
     */
    private stopHeartbeat;
    /**
     * Restore schedules from persistent storage
     */
    private restoreSchedules;
    /**
     * Schedule a workflow for execution
     */
    private scheduleExecution;
    /**
     * Schedule a recurring workflow using cron
     */
    private scheduleRecurring;
    /**
     * Schedule a one-time workflow using setTimeout
     */
    private scheduleOneTime;
    /**
     * Check for and execute due schedules
     */
    private checkDueSchedules;
    /**
     * Execute a scheduled workflow
     */
    private executeSchedule;
    /**
     * Test-fire a schedule without modifying its state.
     * Executes the workflow/reminder and sends output, but does NOT update
     * runCount, lastRunAt, or mark one-time schedules as completed.
     */
    testSchedule(scheduleId: string): Promise<ScheduleExecutionResult>;
    /**
     * Helper to prepare execution environment - reduces duplication between workflow and reminder execution
     */
    private prepareExecution;
    /**
     * Execute the workflow for a schedule
     */
    private executeWorkflow;
    /**
     * Execute a simple reminder by posting its text directly.
     *
     * Previous versions ran the reminder through the full visor AI pipeline,
     * but that caused intent misrouting — reminders got classified as unrelated
     * intents (e.g. git analysis) and never reached the user.  Simple reminders
     * now bypass the pipeline entirely; the output adapter posts the text.
     * For AI-processed scheduled tasks, use a workflow schedule instead.
     */
    private executeSimpleReminder;
    /**
     * Handle schedule execution failure
     */
    private handleScheduleFailure;
    /**
     * Send execution result to the appropriate output adapter
     */
    private sendResult;
    /**
     * Check if scheduler is running
     */
    isRunning(): boolean;
    /**
     * Get scheduler stats
     */
    getStats(): Promise<{
        running: boolean;
        activeCronJobs: number;
        pendingOneTimeSchedules: number;
        storeStats: ScheduleStoreStats;
    }>;
}
/**
 * Get the singleton scheduler instance
 */
export declare function getScheduler(visorConfig?: VisorConfig, config?: SchedulerConfig): Scheduler | undefined;
/**
 * Reset the scheduler instance (for testing)
 */
export declare function resetScheduler(): void;
//# sourceMappingURL=scheduler.d.ts.map