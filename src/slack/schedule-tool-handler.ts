/**
 * Handler for executing the schedule tool within the MCP custom tools server context
 * This integrates the schedule tool with the AI check provider's custom tools system
 *
 * This is a Slack-specific adapter that translates between Slack context and the
 * generic frontend-agnostic scheduler.
 */
import { CustomToolDefinition } from '../types/config';
import {
  handleScheduleAction,
  getScheduleToolDefinition,
  buildScheduleToolContext,
  ScheduleToolArgs,
  ScheduleStore,
  SchedulePermissions,
} from '../scheduler';
import { SlackClient } from './client';
import { logger } from '../logger';

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
 * Determine channel type from channel ID
 * C = public channel, G = private channel/group DM, D = direct message
 */
function getChannelType(channelId: string): 'channel' | 'dm' | 'group' {
  if (channelId.startsWith('D')) {
    return 'dm';
  } else if (channelId.startsWith('G')) {
    // G prefix is used for both private channels and multi-party DMs
    // For permission purposes, we treat private channels like public ones
    return 'group';
  }
  // C prefix = public channel
  return 'channel';
}

/**
 * Extract Slack context from webhook payload
 */
export function extractSlackContext(webhookData: Map<string, unknown>): SlackWebhookContext | null {
  try {
    // Find the Slack payload in webhook data
    for (const payload of webhookData.values()) {
      const p = payload as any;
      if (!p || typeof p !== 'object') continue;

      const event = p.event;
      const conversation = p.slack_conversation;

      if (event) {
        const userId = event.user || '';
        const channel = event.channel || '';
        // Only use thread_ts if it's actually a threaded message
        // A message is in a thread if thread_ts exists AND differs from ts
        // (thread_ts === ts means it's the parent message of a thread, not a reply)
        const isInThread = event.thread_ts && event.thread_ts !== event.ts;
        const threadTs = isInThread ? event.thread_ts : undefined;

        if (userId && channel) {
          return {
            userId,
            channel,
            threadTs,
            userName: conversation?.current?.user,
            timezone: undefined, // Will be fetched on-demand
            channelType: getChannelType(channel),
          };
        }
      }
    }
  } catch {
    // Best effort
  }

  return null;
}

/**
 * Create a schedule tool definition that uses context from the execution environment
 * This returns a tool that can be added to the custom tools server
 */
export function createScheduleToolWithContext(
  slackContext: SlackWebhookContext,
  _slackClient?: SlackClient
): CustomToolDefinition {
  const baseDef = getScheduleToolDefinition();

  // Create an enhanced tool that captures context at creation time
  return {
    ...baseDef,
    // Override the exec to handle the tool call with context
    // This is a placeholder - the actual execution happens via executeScheduleTool
    exec: JSON.stringify({
      type: 'schedule_tool',
      context: slackContext,
    }),
  };
}

/**
 * Execute the schedule tool with the given arguments and context
 * This is called by the custom tool executor when the schedule tool is invoked
 */
export async function executeScheduleTool(
  args: Record<string, unknown>,
  slackContext: SlackWebhookContext,
  slackClient?: SlackClient,
  availableWorkflows?: string[],
  permissions?: SchedulePermissions
): Promise<string> {
  // Fetch user timezone if client is available and not already set
  let timezone = slackContext.timezone;
  if (!timezone && slackClient && slackContext.userId) {
    try {
      const userInfo = await slackClient.getUserInfo(slackContext.userId);
      if (userInfo.ok && userInfo.user?.tz) {
        timezone = userInfo.user.tz;
        slackContext.timezone = timezone;
      }
    } catch {
      // Use default timezone
    }
  }

  // Build the generic tool context from Slack context
  const toolContext = buildScheduleToolContext(
    {
      slackContext: {
        userId: slackContext.userId,
        userName: slackContext.userName,
        timezone: timezone || 'UTC',
        channelType: slackContext.channelType,
      },
    },
    availableWorkflows,
    permissions
  );

  // Map the tool arguments - AI provides structured data
  const toolArgs: ScheduleToolArgs = {
    action: args.action as any,
    // What to do
    reminder_text: args.reminder_text as string | undefined,
    workflow: args.workflow as string | undefined,
    workflow_inputs: args.workflow_inputs as Record<string, unknown> | undefined,
    // Where to send
    target_type: args.target_type as 'channel' | 'dm' | 'thread' | 'user' | undefined,
    target_id: args.target_id as string | undefined,
    thread_ts: args.thread_ts as string | undefined,
    // When to run
    is_recurring: args.is_recurring as boolean | undefined,
    cron: args.cron as string | undefined,
    run_at: args.run_at as string | undefined,
    original_expression: args.original_expression as string | undefined,
    // For cancel/pause/resume
    schedule_id: args.schedule_id as string | undefined,
  };

  // If AI didn't provide target, default to current Slack context
  if (!toolArgs.target_type && slackContext.channel) {
    // Only use 'thread' if we're actually in a thread
    if (slackContext.threadTs) {
      toolArgs.target_type = 'thread';
      toolArgs.target_id = slackContext.channel;
      toolArgs.thread_ts = slackContext.threadTs;
    } else {
      toolArgs.target_type = slackContext.channelType === 'channel' ? 'channel' : 'dm';
      toolArgs.target_id = slackContext.channel;
    }
  }

  try {
    const result = await handleScheduleAction(toolArgs, toolContext);

    if (result.success) {
      return result.message;
    } else {
      return `Error: ${result.error || result.message}`;
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[ScheduleToolHandler] Failed to execute schedule tool: ${errorMsg}`);
    return `Error: ${errorMsg}`;
  }
}

/**
 * Check if a tool name is the schedule tool
 */
export function isScheduleToolCall(toolName: string): boolean {
  return toolName === 'schedule';
}

/**
 * Initialize the schedule store if not already initialized
 */
export async function ensureScheduleStoreInitialized(): Promise<ScheduleStore> {
  const store = ScheduleStore.getInstance();
  if (!store.isInitialized()) {
    await store.initialize();
  }
  return store;
}

// Legacy alias for backwards compatibility
export const ensureReminderStoreInitialized = ensureScheduleStoreInitialized;
