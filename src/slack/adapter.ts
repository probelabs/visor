import { SlackClient } from './client';
import { ThreadCache } from './thread-cache';
import { logger } from '../logger';
import { ConversationContext, NormalizedMessage, SlackBotConfig } from '../types/bot';

/**
 * Slack message from API
 */
interface SlackMessage {
  ts: string;
  user?: string;
  text?: string;
  bot_id?: string;
  thread_ts?: string;
}

/**
 * Slack adapter for fetching and normalizing conversation context
 *
 * This adapter implements a two-tier approach for fetching thread history:
 * 1. Cache first: Check in-memory LRU cache to avoid repeated API calls
 * 2. API fallback: On cache miss or expiry, fetch from Slack API and update cache
 *
 * Features:
 * - Message normalization from Slack format to NormalizedMessage
 * - Thread vs channel message detection
 * - Pagination support for long threads
 * - User mention parsing
 * - Bot vs human message identification
 */
export class SlackAdapter {
  private client: SlackClient;
  private cache: ThreadCache;
  private config: SlackBotConfig;
  private botUserId: string | null = null;
  private botId: string;

  /**
   * Create a new Slack adapter
   * @param client Slack client instance
   * @param config Slack bot configuration
   * @param cache Optional ThreadCache instance (for custom cache backends)
   * @param botId Bot identifier (for multi-bot deployments)
   */
  constructor(
    client: SlackClient,
    config: SlackBotConfig,
    cache?: ThreadCache,
    botId: string = 'default'
  ) {
    this.client = client;
    this.config = config;
    this.botId = botId;

    if (cache) {
      // Use provided cache instance
      this.cache = cache;
      logger.info(`Bot ${this.botId}: Initialized SlackAdapter with provided cache instance`);
    } else {
      // Initialize cache with configuration
      const cacheConfig = config.fetch?.cache;
      const maxThreads = cacheConfig?.max_threads || 200;
      const ttlSeconds = cacheConfig?.ttl_seconds || 600;
      this.cache = new ThreadCache(maxThreads, ttlSeconds);

      logger.info(
        `Bot ${this.botId}: Initialized SlackAdapter with cache (maxThreads=${maxThreads}, ttl=${ttlSeconds}s)`
      );
    }
  }

  /**
   * Get bot user ID (cached after first fetch)
   */
  private async getBotUserId(): Promise<string> {
    if (!this.botUserId) {
      this.botUserId = await this.client.getBotUserId();
      logger.debug(`Bot user ID: ${this.botUserId}`);
    }
    return this.botUserId;
  }

  /**
   * Fetch conversation context for a thread
   *
   * Uses two-tier approach:
   * 1. Check cache first
   * 2. Fetch from Slack API on cache miss
   *
   * @param channel Channel ID
   * @param threadTs Thread timestamp (if null, current message starts a new thread)
   * @param currentMessage Current message that triggered this fetch
   * @returns Conversation context with normalized messages
   */
  async fetchConversation(
    channel: string,
    threadTs: string,
    currentMessage: {
      ts: string;
      user: string;
      text: string;
      timestamp: number;
    }
  ): Promise<ConversationContext> {
    const threadId = `${channel}:${threadTs}`;

    logger.debug(`Fetching conversation for thread ${threadId}`);

    // Try cache first
    const cached = this.cache.get(threadId);
    let messages: NormalizedMessage[];

    if (cached) {
      logger.info(`Using cached conversation for thread ${threadId}`);
      messages = cached.messages;
    } else {
      logger.info(`Cache miss for thread ${threadId}, fetching from Slack API`);
      messages = await this.fetchThreadFromAPI(channel, threadTs);

      // Update cache (will also sync to Redis if enabled)
      this.cache.set(threadId, messages, { channel, threadTs });
    }

    // Normalize current message
    const current = this.normalizeSlackMessage({
      ts: currentMessage.ts,
      user: currentMessage.user,
      text: currentMessage.text,
    });

    // Build conversation context
    return this.buildConversationContext(
      channel,
      threadTs,
      messages,
      current,
      currentMessage.user,
      currentMessage.timestamp
    );
  }

  /**
   * Fetch thread messages from Slack API
   *
   * @param channel Channel ID
   * @param threadTs Thread timestamp
   * @returns Array of normalized messages
   */
  private async fetchThreadFromAPI(
    channel: string,
    threadTs: string
  ): Promise<NormalizedMessage[]> {
    try {
      // Get max_messages from config (default: 40)
      const maxMessages = this.config.fetch?.max_messages || 40;

      logger.debug(`Fetching thread ${threadTs} from channel ${channel} (limit: ${maxMessages})`);

      // Fetch thread replies from Slack
      const slackMessages = await this.client.fetchThreadReplies(channel, threadTs, maxMessages);

      logger.info(
        `Fetched ${slackMessages.length} messages from thread ${threadTs} in channel ${channel}`
      );

      // Normalize all messages
      const normalized = slackMessages.map(msg => this.normalizeSlackMessage(msg));

      return normalized;
    } catch (error) {
      logger.error(
        `Failed to fetch thread from Slack API: ${error instanceof Error ? error.message : String(error)}`
      );

      // On API error, return empty array so processing can continue
      // The current message will still be available in context
      return [];
    }
  }

  /**
   * Normalize a Slack message to NormalizedMessage format
   *
   * Determines if message is from bot or user and extracts text content
   *
   * @param msg Slack message
   * @returns Normalized message
   */
  normalizeSlackMessage(msg: SlackMessage): NormalizedMessage {
    // Determine role based on bot_id presence or bot user ID match
    const isBot = msg.bot_id !== undefined || (msg.user && msg.user === this.botUserId);

    // Determine origin - 'visor' for bot messages, undefined for user messages
    const origin = isBot ? 'visor' : undefined;

    return {
      role: isBot ? 'bot' : 'user',
      text: msg.text || '',
      timestamp: msg.ts,
      origin,
    };
  }

  /**
   * Build conversation context from fetched messages
   *
   * @param channel Channel ID
   * @param threadTs Thread timestamp
   * @param messages Normalized message history
   * @param current Current message that triggered execution
   * @param userId User ID who triggered the message
   * @param eventTimestamp Event timestamp
   * @returns Complete conversation context
   */
  private buildConversationContext(
    channel: string,
    threadTs: string,
    messages: NormalizedMessage[],
    current: NormalizedMessage,
    userId: string,
    eventTimestamp: number
  ): ConversationContext {
    // Build thread URL (Slack workspace URL would need to be configured)
    // For now, use a placeholder format
    const threadUrl = `https://slack.com/archives/${channel}/p${threadTs.replace('.', '')}`;

    const context: ConversationContext = {
      transport: 'slack',
      thread: {
        id: `${channel}:${threadTs}`,
        url: threadUrl,
      },
      messages,
      current,
      attributes: {
        channel,
        user: userId,
        thread_ts: threadTs,
        event_timestamp: eventTimestamp.toString(),
      },
    };

    logger.debug(
      `Built conversation context for thread ${context.thread.id} with ${messages.length} messages`
    );

    return context;
  }

  /**
   * Update cached thread with new message
   *
   * This should be called after processing to keep cache up-to-date
   *
   * @param channel Channel ID
   * @param threadTs Thread timestamp
   * @param newMessage New message to append
   */
  updateCache(channel: string, threadTs: string, newMessage: NormalizedMessage): void {
    const threadId = `${channel}:${threadTs}`;
    const cached = this.cache.get(threadId);

    if (cached) {
      // Append new message to history
      const updatedMessages = [...cached.messages, newMessage];
      this.cache.set(threadId, updatedMessages, { channel, threadTs });
      logger.debug(`Updated cache for thread ${threadId} with new message`);
    } else {
      // Create new cache entry with just this message
      this.cache.set(threadId, [newMessage], { channel, threadTs });
      logger.debug(`Created new cache entry for thread ${threadId}`);
    }
  }

  /**
   * Invalidate cache entry for a thread
   *
   * Useful when you want to force a fresh fetch on next access
   *
   * @param channel Channel ID
   * @param threadTs Thread timestamp
   */
  invalidateCache(channel: string, threadTs: string): void {
    const threadId = `${channel}:${threadTs}`;
    const cached = this.cache.get(threadId);

    if (cached) {
      this.cache.clear();
      logger.debug(`Invalidated cache for thread ${threadId}`);
    }
  }

  /**
   * Get cache statistics
   * @returns Cache statistics for monitoring
   */
  getCacheStats() {
    return this.cache.getStats();
  }

  /**
   * Get cache hit rate
   * @returns Hit rate as percentage (0-100)
   */
  getCacheHitRate(): number {
    return this.cache.getHitRate();
  }

  /**
   * Cleanup expired cache entries
   * @returns Number of entries removed
   */
  cleanupCache(): number {
    return this.cache.cleanupExpired();
  }

  /**
   * Get the thread cache instance
   * @returns ThreadCache instance
   */
  getCache(): ThreadCache {
    return this.cache;
  }

  /**
   * Get the Slack client instance
   * @returns SlackClient instance
   */
  getClient(): SlackClient {
    return this.client;
  }

  /**
   * Get the Slack configuration
   * @returns SlackBotConfig
   */
  getConfig(): SlackBotConfig {
    return this.config;
  }
}
