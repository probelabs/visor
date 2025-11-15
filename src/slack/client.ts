import { WebClient } from '@slack/web-api';
import { logger } from '../logger';

/**
 * Slack client wrapper for common operations
 * Provides a simplified interface for interacting with the Slack API
 */
export class SlackClient {
  private client: WebClient;
  private botToken: string;

  constructor(botToken: string) {
    this.botToken = botToken;
    this.client = new WebClient(botToken);
  }

  /**
   * Add emoji reaction to a message
   * @param channel Channel ID
   * @param timestamp Message timestamp
   * @param emoji Emoji name (without colons)
   */
  async addReaction(channel: string, timestamp: string, emoji: string): Promise<void> {
    try {
      await this.client.reactions.add({
        channel,
        timestamp,
        name: emoji,
      });
      logger.debug(`Added reaction :${emoji}: to message ${timestamp} in channel ${channel}`);
    } catch (error) {
      logger.error(
        `Failed to add reaction :${emoji}: to message ${timestamp}: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  /**
   * Remove emoji reaction from a message
   * @param channel Channel ID
   * @param timestamp Message timestamp
   * @param emoji Emoji name (without colons)
   */
  async removeReaction(channel: string, timestamp: string, emoji: string): Promise<void> {
    try {
      await this.client.reactions.remove({
        channel,
        timestamp,
        name: emoji,
      });
      logger.debug(`Removed reaction :${emoji}: from message ${timestamp} in channel ${channel}`);
    } catch (error) {
      logger.error(
        `Failed to remove reaction :${emoji}: from message ${timestamp}: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  /**
   * Post message to channel or thread
   * @param channel Channel ID
   * @param text Message text
   * @param threadTs Thread timestamp (optional, for replies)
   * @returns Message timestamp
   */
  async postMessage(
    channel: string,
    text: string,
    threadTs?: string
  ): Promise<{ ts: string; channel: string }> {
    try {
      const result = await this.client.chat.postMessage({
        channel,
        text,
        thread_ts: threadTs,
      });

      if (!result.ok || !result.ts) {
        throw new Error('Failed to post message: ' + JSON.stringify(result));
      }

      logger.debug(
        `Posted message to channel ${channel}${threadTs ? ` in thread ${threadTs}` : ''}`
      );
      return {
        ts: result.ts,
        channel: result.channel || channel,
      };
    } catch (error) {
      logger.error(
        `Failed to post message to channel ${channel}: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  /**
   * Post an ephemeral message (only visible to specific user)
   * @param channel Channel ID
   * @param user User ID to show message to
   * @param text Message text
   * @param threadTs Thread timestamp (optional, for replies)
   * @returns Message timestamp
   */
  async postEphemeralMessage(
    channel: string,
    user: string,
    text: string,
    threadTs?: string
  ): Promise<{ ts: string }> {
    try {
      const result = await this.client.chat.postEphemeral({
        channel,
        user,
        text,
        thread_ts: threadTs,
      });

      if (!result.ok || !result.message_ts) {
        throw new Error('Failed to post ephemeral message: ' + JSON.stringify(result));
      }

      logger.debug(
        `Posted ephemeral message to user ${user} in channel ${channel}${threadTs ? ` thread ${threadTs}` : ''}`
      );
      return {
        ts: result.message_ts,
      };
    } catch (error) {
      logger.error(
        `Failed to post ephemeral message: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  /**
   * Fetch conversation replies (thread messages)
   * @param channel Channel ID
   * @param threadTs Thread timestamp
   * @param limit Maximum number of messages to fetch
   * @returns Array of messages
   */
  async fetchThreadReplies(
    channel: string,
    threadTs: string,
    limit: number = 40
  ): Promise<
    Array<{
      ts: string;
      user?: string;
      text?: string;
      bot_id?: string;
      thread_ts?: string;
    }>
  > {
    try {
      const result = await this.client.conversations.replies({
        channel,
        ts: threadTs,
        limit,
      });

      if (!result.ok || !result.messages) {
        throw new Error('Failed to fetch thread replies: ' + JSON.stringify(result));
      }

      logger.debug(
        `Fetched ${result.messages.length} messages from thread ${threadTs} in channel ${channel}`
      );

      return result.messages.map(msg => ({
        ts: msg.ts || '',
        user: msg.user,
        text: msg.text,
        bot_id: msg.bot_id,
        thread_ts: msg.thread_ts,
      }));
    } catch (error) {
      logger.error(
        `Failed to fetch thread replies from ${channel}/${threadTs}: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  /**
   * Get bot user ID
   * @returns Bot user ID
   */
  async getBotUserId(): Promise<string> {
    try {
      const result = await this.client.auth.test();

      if (!result.ok || !result.user_id) {
        throw new Error('Failed to get bot user ID: ' + JSON.stringify(result));
      }

      return result.user_id;
    } catch (error) {
      logger.error(
        `Failed to get bot user ID: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  /**
   * Get the underlying WebClient instance
   * Used by CachePrewarmer for advanced API calls
   * @returns WebClient instance
   */
  getWebClient(): WebClient {
    return this.client;
  }
}
