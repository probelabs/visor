/**
 * Generic AI Tool for scheduling and managing workflow executions
 * This tool is frontend-agnostic and can work with any context (Slack, CLI, GitHub, etc.)
 */
import { CustomToolDefinition } from '../types/config';
import { Schedule } from './schedule-store';
/**
 * Tool action types
 */
export type ScheduleAction = 'create' | 'list' | 'cancel' | 'pause' | 'resume' | 'test' | 'create_trigger' | 'list_triggers' | 'delete_trigger' | 'update_trigger';
/**
 * Target type for where to send the reminder/output
 */
export type TargetType = 'channel' | 'dm' | 'thread' | 'user';
/**
 * Tool input arguments - AI provides structured data, no parsing needed
 */
export interface ScheduleToolArgs {
    action: ScheduleAction;
    /** What to say/do when the schedule fires */
    reminder_text?: string;
    /** Where to send: channel, dm (to self), thread, or user (DM to specific user) */
    target_type?: TargetType;
    /** The Slack channel ID (C... for channels, D... for DMs) */
    target_id?: string;
    /** For thread replies: the thread_ts to reply to */
    thread_ts?: string;
    /** Is this a recurring schedule? */
    is_recurring?: boolean;
    /** For recurring: cron expression (AI generates this, e.g., "* * * * *" for every minute) */
    cron?: string;
    /** For one-time: ISO 8601 timestamp when to run */
    run_at?: string;
    /** Original natural language expression (for display only) */
    original_expression?: string;
    /** Optional workflow to run instead of just sending reminder_text */
    workflow?: string;
    /** Optional workflow inputs */
    workflow_inputs?: Record<string, unknown>;
    schedule_id?: string;
    /** For create_trigger: channel IDs to monitor */
    trigger_channels?: string[];
    /** For create_trigger: Slack user IDs to filter by (only trigger for these users) */
    trigger_from?: string[];
    /** For create_trigger: allow bot messages (default: false) */
    trigger_from_bots?: boolean;
    /** For create_trigger: keyword patterns (case-insensitive OR) */
    trigger_contains?: string[];
    /** For create_trigger: regex pattern */
    trigger_match?: string;
    /** For create_trigger: thread scope (default: 'any') */
    trigger_threads?: 'root_only' | 'thread_only' | 'any';
    /** For create_trigger: human-readable description */
    trigger_description?: string;
    /** For delete_trigger / update_trigger: trigger ID */
    trigger_id?: string;
    /** For update_trigger: enable/disable */
    trigger_enabled?: boolean;
}
/**
 * Schedule type for permission checking
 */
export type ScheduleType = 'personal' | 'channel' | 'dm';
/**
 * Permissions configuration for dynamic schedules
 */
export interface SchedulePermissions {
    /** Allow personal schedules (via DM or CLI) */
    allowPersonal?: boolean;
    /** Allow channel schedules (in Slack channels) */
    allowChannel?: boolean;
    /** Allow DM schedules (to specific users) */
    allowDm?: boolean;
    /** List of allowed workflow patterns (glob-style, e.g., "report-*") */
    allowedWorkflows?: string[];
    /** List of denied workflow patterns */
    deniedWorkflows?: string[];
}
/**
 * Context passed to the tool handler
 * This is generic and works with any frontend
 */
export interface ScheduleToolContext {
    /** Generic user ID (can be Slack user, GitHub user, CLI user, etc.) */
    userId: string;
    /** User display name (optional) */
    userName?: string;
    /** Context identifier: "slack:U123", "github:user", "cli", etc. */
    contextType: string;
    /** User's timezone (IANA format) */
    timezone?: string;
    /** Available workflows in the current config */
    availableWorkflows?: string[];
    /** Schedule type being created (for permission checking) */
    scheduleType?: ScheduleType;
    /** Permissions for dynamic schedule creation */
    permissions?: SchedulePermissions;
    /**
     * Allowed schedule type based on originating context.
     * When set, only schedules of this type can be created/managed
     * — unless explicitTarget is true.
     */
    allowedScheduleType?: ScheduleType;
    /** True when the AI tool call includes an explicit target_type + target_id,
     *  indicating the user intentionally wants cross-context delivery. */
    explicitTarget?: boolean;
    /** Origin of the current execution, used to prevent scheduler recursion. */
    executionSource?: 'user' | 'scheduler';
    /** The channel ID the request originated from (for listing channel schedules). */
    channelId?: string;
}
/**
 * Tool execution result
 */
export interface ScheduleToolResult {
    success: boolean;
    message: string;
    schedule?: Schedule;
    schedules?: Schedule[];
    error?: string;
}
/**
 * Handle schedule tool actions
 */
export declare function handleScheduleAction(args: ScheduleToolArgs, context: ScheduleToolContext): Promise<ScheduleToolResult>;
/**
 * Get the schedule tool definition for registration with AI providers
 *
 * The AI is responsible for:
 * 1. Extracting the target (channel ID, user ID, thread_ts) from the conversation context
 * 2. Determining if the schedule is recurring or one-time
 * 3. Generating the cron expression OR ISO timestamp
 * 4. Extracting the reminder text or workflow name
 */
export declare function getScheduleToolDefinition(): CustomToolDefinition;
/**
 * Check if this is the schedule tool and should be handled specially
 */
export declare function isScheduleTool(toolName: string): boolean;
/**
 * Build schedule tool context from various sources
 */
export declare function buildScheduleToolContext(sources: {
    slackContext?: {
        userId: string;
        userName?: string;
        timezone?: string;
        channelType?: 'channel' | 'dm' | 'group';
        channelId?: string;
    };
    cliContext?: {
        userId?: string;
    };
    githubContext?: {
        login: string;
    };
    schedulerContext?: {
        scheduleId?: string;
    };
}, availableWorkflows?: string[], permissions?: SchedulePermissions, outputInfo?: {
    outputType?: 'slack' | 'github' | 'webhook' | 'none';
    outputTarget?: string;
}): ScheduleToolContext;
//# sourceMappingURL=schedule-tool.d.ts.map