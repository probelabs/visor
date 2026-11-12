/**
 * Slack output adapter for the scheduler
 * Posts schedule execution results to Slack channels or DMs
 */
import { SlackClient } from './client';
import type { Schedule } from '../scheduler/schedule-store';
import type { ScheduleOutputAdapter, ScheduleExecutionResult } from '../scheduler/scheduler';
/**
 * Slack output adapter configuration
 */
export interface SlackOutputAdapterConfig {
    /** Default channel for outputs without explicit target */
    defaultChannel?: string;
    /** Whether to include execution time in output */
    includeExecutionTime?: boolean;
    /** Whether to include error details in output */
    includeErrorDetails?: boolean;
}
/**
 * Adapter that posts schedule results to Slack
 */
export declare class SlackOutputAdapter implements ScheduleOutputAdapter {
    readonly type: "slack";
    private client;
    private config;
    constructor(client: SlackClient, config?: SlackOutputAdapterConfig);
    /**
     * Send schedule execution result to Slack
     */
    sendResult(schedule: Schedule, result: ScheduleExecutionResult): Promise<void>;
    /**
     * Resolve the target channel for output
     */
    private resolveTarget;
    /**
     * Build the message to post
     */
    private buildMessage;
}
/**
 * Create a Slack output adapter from a SlackClient
 */
export declare function createSlackOutputAdapter(client: SlackClient, config?: SlackOutputAdapterConfig): SlackOutputAdapter;
//# sourceMappingURL=slack-output-adapter.d.ts.map