import { SlackClient } from './client';
import { ThreadCache } from './thread-cache';
import { logger } from '../logger';
import { ConversationContext, NormalizedMessage, SlackBotConfig } from '../types/bot';

interface SlackMessage {
  ts: string;
  user?: string;
  text?: string;
  bot_id?: string;
  thread_ts?: string;
}

export class SlackAdapter {
  private client: SlackClient;
  private cache: ThreadCache;
  private config: SlackBotConfig;
  private botUserId: string | null = null;
  private botId: string;

  constructor(client: SlackClient, config: SlackBotConfig, cache?: ThreadCache, botId = 'default') {
    this.client = client;
    this.config = config;
    this.botId = botId;
    if (cache) this.cache = cache;
    else {
      const cacheCfg = config.fetch?.cache || {};
      this.cache = new ThreadCache(cacheCfg.max_threads || 200, cacheCfg.ttl_seconds || 600);
    }
    logger.info(`Bot ${this.botId}: SlackAdapter ready`);
  }

  private async getBotUserId(): Promise<string> {
    if (!this.botUserId) this.botUserId = await this.client.getBotUserId();
    return this.botUserId;
  }

  async fetchConversation(
    channel: string,
    threadTs: string,
    currentMessage: { ts: string; user: string; text: string; timestamp: number }
  ): Promise<ConversationContext> {
    const threadId = `${channel}:${threadTs}`;
    const cached = this.cache.get(threadId);
    let messages: NormalizedMessage[];
    if (cached) messages = cached.messages;
    else {
      messages = await this.fetchThreadFromAPI(channel, threadTs);
      this.cache.set(threadId, messages, { channel, threadTs });
    }
    const current = this.normalizeSlackMessage({ ts: currentMessage.ts, user: currentMessage.user, text: currentMessage.text });
    return this.buildConversationContext(
      channel,
      threadTs,
      messages,
      current,
      currentMessage.user,
      currentMessage.timestamp
    );
  }

  private async fetchThreadFromAPI(channel: string, threadTs: string): Promise<NormalizedMessage[]> {
    try {
      const maxMessages = this.config.fetch?.max_messages || 40;
      const slackMessages = await this.client.fetchThreadReplies(channel, threadTs, maxMessages);
      return slackMessages.map(m => this.normalizeSlackMessage(m));
    } catch (e) {
      logger.error(`Failed to fetch thread replies: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  normalizeSlackMessage(msg: SlackMessage): NormalizedMessage {
    const isBot = msg.bot_id !== undefined || (msg.user && msg.user === this.botUserId);
    const origin = isBot ? 'visor' : undefined;
    return { role: isBot ? 'bot' : 'user', text: msg.text || '', timestamp: msg.ts, origin };
  }

  private buildConversationContext(
    channel: string,
    threadTs: string,
    messages: NormalizedMessage[],
    current: NormalizedMessage,
    userId: string,
    eventTimestamp: number
  ): ConversationContext {
    const threadUrl = `https://slack.com/archives/${channel}/p${threadTs.replace('.', '')}`;
    return {
      transport: 'slack',
      thread: { id: `${channel}:${threadTs}`, url: threadUrl },
      messages,
      current,
      attributes: { channel, user: userId, thread_ts: threadTs, event_timestamp: String(eventTimestamp) },
    };
  }

  updateCache(channel: string, threadTs: string, newMessage: NormalizedMessage): void {
    const id = `${channel}:${threadTs}`;
    const c = this.cache.get(id);
    if (c) this.cache.set(id, [...c.messages, newMessage], { channel, threadTs });
    else this.cache.set(id, [newMessage], { channel, threadTs });
  }

  invalidateCache(channel: string, threadTs: string): void {
    const id = `${channel}:${threadTs}`;
    if (this.cache.has(id)) this.cache.evict(id);
  }

  getCacheStats() { return this.cache.getStats(); }
  getCache(): ThreadCache { return this.cache; }
  getClient(): SlackClient { return this.client; }
  getConfig(): SlackBotConfig { return this.config; }
}

