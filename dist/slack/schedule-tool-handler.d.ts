/**
 * Handler for executing the schedule tool within the MCP custom tools server context
 * This integrates the schedule tool with the AI check provider's custom tools system
 *
 * This is a Slack-specific adapter that translates between Slack context and the
 * generic frontend-agnostic scheduler.
 */
import { CustomToolDefinition } from '../types/config';
import { ScheduleStore, SchedulePermissions } from '../scheduler';
import { SlackClient } from './client';
/**
 * Context information extracted from Slack webhook payload
 */
export interface SlackWebhookContext {
    userId: string;
    userName?: string;
    channel: string;
    threadTs?: string;
    timezone?: string;
    /** Channel type: 'channel' for public/private channels, 'dm' for direct messages, 'group' for group DMs */
    channelType?: 'channel' | 'dm' | 'group';
}
/**
 * Extract Slack context from webhook payload
 */
export declare function extractSlackContext(webhookData: Map<string, unknown>): SlackWebhookContext | null;
/**
 * Create a schedule tool definition that uses context from the execution environment
 * This returns a tool that can be added to the custom tools server
 */
export declare function createScheduleToolWithContext(slackContext: SlackWebhookContext, _slackClient?: SlackClient): CustomToolDefinition;
/**
 * Execute the schedule tool with the given arguments and context
 * This is called by the custom tool executor when the schedule tool is invoked
 */
export declare function executeScheduleTool(args: Record<string, unknown>, slackContext: SlackWebhookContext, slackClient?: SlackClient, availableWorkflows?: string[], permissions?: SchedulePermissions): Promise<string>;
/**
 * Check if a tool name is the schedule tool
 */
export declare function isScheduleToolCall(toolName: string): boolean;
/**
 * Initialize the schedule store if not already initialized
 */
export declare function ensureScheduleStoreInitialized(): Promise<ScheduleStore>;
export declare const ensureReminderStoreInitialized: typeof ensureScheduleStoreInitialized;
//# sourceMappingURL=schedule-tool-handler.d.ts.map