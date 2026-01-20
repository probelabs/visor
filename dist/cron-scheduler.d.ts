import * as cron from 'node-cron';
import { VisorConfig, CheckConfig } from './types/config';
import { StateMachineExecutionEngine } from './state-machine-execution-engine';
export interface ScheduledCheck {
    checkName: string;
    schedule: string;
    checkConfig: CheckConfig;
    task?: cron.ScheduledTask;
}
/**
 * Service for managing cron-scheduled check executions
 */
export declare class CronScheduler {
    private scheduledChecks;
    private executionEngine;
    private config;
    private isRunning;
    constructor(config: VisorConfig, executionEngine: StateMachineExecutionEngine);
    /**
     * Initialize scheduler and register all scheduled checks
     */
    initialize(): void;
    /**
     * Register a check for scheduled execution
     */
    private registerScheduledCheck;
    /**
     * Execute a scheduled check
     */
    private executeScheduledCheck;
    /**
     * Handle results from scheduled check execution
     */
    private handleScheduledResults;
    /**
     * Start the scheduler
     */
    start(): void;
    /**
     * Stop the scheduler
     */
    stop(): void;
    /**
     * Get list of scheduled checks
     */
    getScheduledChecks(): Array<{
        name: string;
        schedule: string;
        nextRun?: Date;
    }>;
    /**
     * Manually trigger a scheduled check
     */
    triggerCheck(checkName: string): Promise<void>;
    /**
     * Validate all cron expressions in config
     */
    static validateSchedules(config: VisorConfig): {
        valid: boolean;
        errors: string[];
    };
}
/**
 * Create and initialize a cron scheduler
 */
export declare function createCronScheduler(config: VisorConfig, executionEngine: StateMachineExecutionEngine): CronScheduler;
