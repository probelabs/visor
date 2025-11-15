/**
 * Cache prewarmer for Slack threads
 * Fetches recent threads on bot startup to populate the cache
 */

import { SlackClient } from './client';
import { SlackAdapter } from './adapter';
import { SlackCachePrewarmingConfig } from '../types/bot';
import { logger } from '../logger';

/**
 * Channel-based prewarming result
 */
interface ChannelPrewarmResult {
  /** Channel ID */
  channel: string;
  /** Number of threads prewarmed */
  threadsPrewarmed: number;
  /** Errors encountered (if any) */
  errors: string[];
}

/**
 * User-based prewarming result
 */
interface UserPrewarmResult {
  /** User ID */
  user: string;
  /** Number of threads prewarmed */
  threadsPrewarmed: number;
  /** Errors encountered (if any) */
  errors: string[];
}

/**
 * Overall prewarming result
 */
export interface PrewarmingResult {
  /** Total threads prewarmed */
  totalThreads: number;
  /** Total duration in milliseconds */
  durationMs: number;
  /** Channel results */
  channels: ChannelPrewarmResult[];
  /** User results */
  users: UserPrewarmResult[];
  /** Overall errors */
  errors: string[];
}

/**
 * Cache prewarmer for Slack threads
 * Populates cache on startup by fetching recent conversations
 */
export class CachePrewarmer {
  private client: SlackClient;
  private adapter: SlackAdapter;
  private config: Required<SlackCachePrewarmingConfig>;

  constructor(client: SlackClient, adapter: SlackAdapter, config: SlackCachePrewarmingConfig) {
    this.client = client;
    this.adapter = adapter;

    // Apply defaults
    this.config = {
      enabled: config.enabled ?? false,
      channels: config.channels ?? [],
      users: config.users ?? [],
      max_threads_per_channel: config.max_threads_per_channel ?? 20,
      concurrency: config.concurrency ?? 5,
      rate_limit_ms: config.rate_limit_ms ?? 100,
    };
  }

  /**
   * Prewarm the cache by fetching recent threads
   * @returns Prewarming results with statistics
   */
  async prewarm(): Promise<PrewarmingResult> {
    if (!this.config.enabled) {
      logger.info('Cache prewarming is disabled');
      return {
        totalThreads: 0,
        durationMs: 0,
        channels: [],
        users: [],
        errors: [],
      };
    }

    const startTime = Date.now();
    logger.info('Starting cache prewarming...');
    logger.info(`Channels to prewarm: ${this.config.channels.length}`);
    logger.info(`Users to prewarm: ${this.config.users.length}`);
    logger.info(`Max threads per channel: ${this.config.max_threads_per_channel}`);
    logger.info(`Concurrency: ${this.config.concurrency}`);
    logger.info(`Rate limit: ${this.config.rate_limit_ms}ms`);

    const result: PrewarmingResult = {
      totalThreads: 0,
      durationMs: 0,
      channels: [],
      users: [],
      errors: [],
    };

    try {
      // Prewarm channels
      if (this.config.channels.length > 0) {
        const channelResults = await this.prewarmChannels();
        result.channels = channelResults;
        result.totalThreads += channelResults.reduce((sum, r) => sum + r.threadsPrewarmed, 0);
      }

      // Prewarm users (DMs)
      if (this.config.users.length > 0) {
        const userResults = await this.prewarmUsers();
        result.users = userResults;
        result.totalThreads += userResults.reduce((sum, r) => sum + r.threadsPrewarmed, 0);
      }

      result.durationMs = Date.now() - startTime;

      logger.info(`Cache prewarming completed in ${result.durationMs}ms`);
      logger.info(`Total threads prewarmed: ${result.totalThreads}`);

      // Log cache statistics
      const cacheStats = this.adapter.getCacheStats();
      logger.info(`Cache stats after prewarming: ${JSON.stringify(cacheStats)}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Cache prewarming failed: ${errorMsg}`);
      result.errors.push(errorMsg);
      result.durationMs = Date.now() - startTime;
    }

    return result;
  }

  /**
   * Prewarm cache for specific channels
   */
  private async prewarmChannels(): Promise<ChannelPrewarmResult[]> {
    logger.info(`Prewarming ${this.config.channels.length} channels...`);

    const results: ChannelPrewarmResult[] = [];
    const channels = [...this.config.channels];

    // Process channels with concurrency control
    while (channels.length > 0) {
      const batch = channels.splice(0, this.config.concurrency);
      const batchResults = await Promise.all(batch.map(channel => this.prewarmChannel(channel)));
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Prewarm cache for specific users (DMs)
   */
  private async prewarmUsers(): Promise<UserPrewarmResult[]> {
    logger.info(`Prewarming ${this.config.users.length} user DMs...`);

    const results: UserPrewarmResult[] = [];
    const users = [...this.config.users];

    // Process users with concurrency control
    while (users.length > 0) {
      const batch = users.splice(0, this.config.concurrency);
      const batchResults = await Promise.all(batch.map(user => this.prewarmUser(user)));
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Prewarm a single channel
   */
  private async prewarmChannel(channel: string): Promise<ChannelPrewarmResult> {
    const result: ChannelPrewarmResult = {
      channel,
      threadsPrewarmed: 0,
      errors: [],
    };

    try {
      logger.info(`Prewarming channel: ${channel}`);

      // Fetch recent messages in the channel
      const response = await this.client.getWebClient().conversations.history({
        channel,
        limit: this.config.max_threads_per_channel,
      });

      if (!response.ok || !response.messages) {
        const error = `Failed to fetch messages for channel ${channel}`;
        logger.warn(error);
        result.errors.push(error);
        return result;
      }

      // Filter for threaded messages (messages with thread_ts)
      const threadedMessages = response.messages.filter(
        (msg: any) => msg.thread_ts && msg.thread_ts === msg.ts
      );

      logger.info(`Found ${threadedMessages.length} threads in channel ${channel}`);

      // Fetch each thread with rate limiting
      for (const message of threadedMessages) {
        try {
          if (!message.thread_ts) continue;

          // Apply rate limiting
          if (result.threadsPrewarmed > 0) {
            await this.sleep(this.config.rate_limit_ms);
          }

          // Fetch thread replies using adapter (which will cache them)
          await this.adapter.fetchConversation(channel, message.thread_ts, {
            ts: message.ts || '',
            user: (message as any).user || 'unknown',
            text: message.text || '',
            timestamp: Date.now(),
          });

          result.threadsPrewarmed++;
          logger.debug(
            `Prewarmed thread ${message.thread_ts} in channel ${channel} (${result.threadsPrewarmed}/${threadedMessages.length})`
          );
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          logger.warn(`Failed to prewarm thread ${message.thread_ts}: ${errorMsg}`);
          result.errors.push(errorMsg);
        }
      }

      logger.info(`Completed prewarming channel ${channel}: ${result.threadsPrewarmed} threads`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to prewarm channel ${channel}: ${errorMsg}`);
      result.errors.push(errorMsg);
    }

    return result;
  }

  /**
   * Prewarm a single user's DMs
   */
  private async prewarmUser(user: string): Promise<UserPrewarmResult> {
    const result: UserPrewarmResult = {
      user,
      threadsPrewarmed: 0,
      errors: [],
    };

    try {
      logger.info(`Prewarming DMs with user: ${user}`);

      // Open DM conversation with user
      const openResponse = await this.client.getWebClient().conversations.open({
        users: user,
      });

      if (!openResponse.ok || !openResponse.channel?.id) {
        const error = `Failed to open DM with user ${user}`;
        logger.warn(error);
        result.errors.push(error);
        return result;
      }

      const dmChannel = openResponse.channel.id;

      // Fetch recent messages in the DM
      const response = await this.client.getWebClient().conversations.history({
        channel: dmChannel,
        limit: this.config.max_threads_per_channel,
      });

      if (!response.ok || !response.messages) {
        const error = `Failed to fetch messages for DM with user ${user}`;
        logger.warn(error);
        result.errors.push(error);
        return result;
      }

      // Filter for threaded messages
      const threadedMessages = response.messages.filter(
        (msg: any) => msg.thread_ts && msg.thread_ts === msg.ts
      );

      logger.info(`Found ${threadedMessages.length} threads in DM with user ${user}`);

      // Fetch each thread with rate limiting
      for (const message of threadedMessages) {
        try {
          if (!message.thread_ts) continue;

          // Apply rate limiting
          if (result.threadsPrewarmed > 0) {
            await this.sleep(this.config.rate_limit_ms);
          }

          // Fetch thread replies using adapter (which will cache them)
          await this.adapter.fetchConversation(dmChannel, message.thread_ts, {
            ts: message.ts || '',
            user: (message as any).user || user,
            text: message.text || '',
            timestamp: Date.now(),
          });

          result.threadsPrewarmed++;
          logger.debug(
            `Prewarmed thread ${message.thread_ts} with user ${user} (${result.threadsPrewarmed}/${threadedMessages.length})`
          );
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          logger.warn(`Failed to prewarm thread ${message.thread_ts}: ${errorMsg}`);
          result.errors.push(errorMsg);
        }
      }

      logger.info(`Completed prewarming DMs with user ${user}: ${result.threadsPrewarmed} threads`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to prewarm DMs with user ${user}: ${errorMsg}`);
      result.errors.push(errorMsg);
    }

    return result;
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
