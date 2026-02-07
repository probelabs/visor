/**
 * Handler for executing the schedule tool within the MCP custom tools server context
 * This integrates the schedule tool with the AI check provider's custom tools system
 */
import { CustomToolDefinition } from '../types/config';
import {
  handleScheduleAction,
  getScheduleToolDefinition,
  ScheduleToolArgs,
  ScheduleToolContext,
} from './schedule-tool';
import { ReminderStore } from './reminder-store';
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
        const threadTs = event.thread_ts || event.ts || '';

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
  slackClient?: SlackClient
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

  const toolContext: ScheduleToolContext = {
    userId: slackContext.userId,
    userName: slackContext.userName,
    channel: slackContext.channel,
    threadTs: slackContext.threadTs,
    timezone: timezone || 'UTC',
  };

  const toolArgs: ScheduleToolArgs = {
    action: args.action as any,
    target: args.target as any,
    expression: args.expression as string | undefined,
    prompt: args.prompt as string | undefined,
    reminder_id: args.reminder_id as string | undefined,
  };

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
 * Initialize the reminder store if not already initialized
 */
export async function ensureReminderStoreInitialized(): Promise<ReminderStore> {
  const store = ReminderStore.getInstance();
  if (!store.isInitialized()) {
    await store.initialize();
  }
  return store;
}
