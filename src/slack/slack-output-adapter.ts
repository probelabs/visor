/**
 * Slack output adapter for the scheduler
 * Posts schedule execution results to Slack channels or DMs
 */
import { SlackClient } from './client';
import type { Schedule, ScheduleOutputContext } from '../scheduler/schedule-store';
import type { ScheduleOutputAdapter, ScheduleExecutionResult } from '../scheduler/scheduler';
import { logger } from '../logger';

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
export class SlackOutputAdapter implements ScheduleOutputAdapter {
  readonly type = 'slack' as const;
  private client: SlackClient;
  private config: SlackOutputAdapterConfig;

  constructor(client: SlackClient, config?: SlackOutputAdapterConfig) {
    this.client = client;
    this.config = config || {};
  }

  /**
   * Send schedule execution result to Slack
   */
  async sendResult(schedule: Schedule, result: ScheduleExecutionResult): Promise<void> {
    const outputContext = schedule.outputContext;
    if (!outputContext || outputContext.type !== 'slack') {
      return;
    }

    try {
      // Determine target channel
      const targetChannel = await this.resolveTarget(schedule, outputContext);
      if (!targetChannel) {
        logger.warn(`[SlackOutputAdapter] Could not resolve target for schedule ${schedule.id}`);
        return;
      }

      // Build message
      const message = this.buildMessage(schedule, result);

      // Post message
      await this.client.chat.postMessage({
        channel: targetChannel,
        text: message,
        thread_ts: outputContext.threadId,
      });

      logger.debug(
        `[SlackOutputAdapter] Posted result for schedule ${schedule.id} to ${targetChannel}`
      );
    } catch (error) {
      logger.error(
        `[SlackOutputAdapter] Failed to post result for schedule ${schedule.id}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  /**
   * Resolve the target channel for output
   */
  private async resolveTarget(
    schedule: Schedule,
    outputContext: ScheduleOutputContext
  ): Promise<string | undefined> {
    // If explicit target is provided
    if (outputContext.target) {
      // Handle channel names (remove # prefix if present)
      const target = outputContext.target.startsWith('#')
        ? outputContext.target.slice(1)
        : outputContext.target;

      // If it looks like a channel ID, use directly
      if (target.match(/^[CDG][A-Z0-9]+$/)) {
        return target;
      }

      // Try to resolve channel name to ID
      // For now, just return the target and let Slack API handle it
      return target;
    }

    // Check for DM target in metadata
    if (outputContext.metadata?.target === 'dm' && schedule.creatorId) {
      // Open DM with creator
      const dmResult = await this.client.openDM(schedule.creatorId);
      if (dmResult.ok && dmResult.channel) {
        return dmResult.channel;
      }
    }

    // Use default channel if configured
    if (this.config.defaultChannel) {
      return this.config.defaultChannel;
    }

    return undefined;
  }

  /**
   * Build the message to post
   */
  private buildMessage(schedule: Schedule, result: ScheduleExecutionResult): string {
    const parts: string[] = [];

    if (result.success) {
      parts.push(`*Scheduled workflow completed: ${schedule.workflow}*`);

      // Add output if available
      if (result.output) {
        const outputStr =
          typeof result.output === 'string'
            ? result.output
            : JSON.stringify(result.output, null, 2);

        // Handle legacy reminder format
        if (typeof result.output === 'object' && (result.output as any).isLegacy) {
          parts.push((result.output as any).message || outputStr);
        } else if (outputStr.length > 2000) {
          parts.push(`\`\`\`\n${outputStr.substring(0, 1900)}...\n(truncated)\n\`\`\``);
        } else if (outputStr.trim()) {
          parts.push(`\`\`\`\n${outputStr}\n\`\`\``);
        }
      }

      if (this.config.includeExecutionTime) {
        parts.push(`_Completed in ${result.executionTimeMs}ms_`);
      }
    } else {
      parts.push(`*Scheduled workflow failed: ${schedule.workflow}*`);

      if (this.config.includeErrorDetails && result.error) {
        parts.push(`Error: ${result.error}`);
      }

      parts.push(`_Schedule ID: ${schedule.id.substring(0, 8)}_`);
    }

    return parts.join('\n\n');
  }
}

/**
 * Create a Slack output adapter from a SlackClient
 */
export function createSlackOutputAdapter(
  client: SlackClient,
  config?: SlackOutputAdapterConfig
): SlackOutputAdapter {
  return new SlackOutputAdapter(client, config);
}
