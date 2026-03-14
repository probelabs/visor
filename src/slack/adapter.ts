import { SlackClient } from './client';
import { ThreadCache } from './thread-cache';
import { logger } from '../logger';
import {
  ConversationContext,
  NormalizedMessage,
  SlackBotConfig,
  SlackFileAttachment,
} from '../types/bot';

interface SlackMessage {
  ts: string;
  user?: string;
  text?: string;
  bot_id?: string;
  thread_ts?: string;
  files?: any[];
  attachments?: any[];
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
    currentMessage: {
      ts: string;
      user: string;
      text: string;
      timestamp: number;
      files?: any[];
      attachments?: any[];
    }
  ): Promise<ConversationContext> {
    const threadId = `${channel}:${threadTs}`;
    const cached = this.cache.get(threadId);
    let messages: NormalizedMessage[];
    if (cached) messages = cached.messages;
    else {
      messages = await this.fetchThreadFromAPI(channel, threadTs);
      this.cache.set(threadId, messages, { channel, threadTs });
    }
    const current = this.normalizeSlackMessage({
      ts: currentMessage.ts,
      user: currentMessage.user,
      text: currentMessage.text,
      files: currentMessage.files,
      attachments: currentMessage.attachments,
    });
    return this.buildConversationContext(
      channel,
      threadTs,
      messages,
      current,
      currentMessage.user,
      currentMessage.timestamp
    );
  }

  private async fetchThreadFromAPI(
    channel: string,
    threadTs: string
  ): Promise<NormalizedMessage[]> {
    try {
      const maxMessages = this.config.fetch?.max_messages || 40;
      const slackMessages = await this.client.fetchThreadReplies(channel, threadTs, maxMessages);
      logger.info(
        `SlackAdapter: fetched ${slackMessages.length} messages for thread ${channel}:${threadTs}`
      );
      return slackMessages.map(m => this.normalizeSlackMessage(m));
    } catch (e) {
      logger.error(`Failed to fetch thread replies: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  /**
   * Extract readable text from Slack message attachments (used by integrations
   * like Logz.io, PagerDuty, Datadog, etc. that send structured attachments
   * with no top-level text).
   */
  private extractAttachmentText(attachments: any[]): string {
    const parts: string[] = [];
    for (const att of attachments) {
      // Collect the key text fields from each attachment
      if (att.pretext) parts.push(att.pretext);
      if (att.author_name) parts.push(att.author_name);
      if (att.title) parts.push(att.title);
      if (att.text) parts.push(att.text);
      if (att.footer) parts.push(att.footer);
      // Structured fields (e.g. alert samples, key-value pairs)
      if (Array.isArray(att.fields)) {
        for (const field of att.fields) {
          const title = field.title ? `${field.title}: ` : '';
          if (field.value) parts.push(`${title}${field.value}`);
        }
      }
    }
    return parts.join('\n');
  }

  normalizeSlackMessage(msg: SlackMessage): NormalizedMessage {
    const isBot = msg.bot_id !== undefined || (msg.user && msg.user === this.botUserId);
    const origin = isBot ? 'visor' : undefined;

    // Build message text: use top-level text, fall back to attachment content
    let text = msg.text || '';
    if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
      const attachmentText = this.extractAttachmentText(msg.attachments);
      if (attachmentText) {
        // If there's no top-level text, use attachment text directly;
        // otherwise append it so both are visible to the AI
        text = text ? `${text}\n\n${attachmentText}` : attachmentText;
      }
    }

    const normalized: NormalizedMessage = {
      role: isBot ? 'bot' : 'user',
      text,
      timestamp: msg.ts,
      origin,
      user: msg.user ? String(msg.user) : undefined,
    };
    // Preserve file attachment metadata
    if (Array.isArray(msg.files) && msg.files.length > 0) {
      normalized.files = msg.files.map(
        (f: any): SlackFileAttachment => ({
          id: String(f.id || ''),
          name: f.name,
          mimetype: f.mimetype,
          filetype: f.filetype,
          url_private: f.url_private,
          permalink: f.permalink,
          size: f.size,
        })
      );
    }
    return normalized;
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
      attributes: {
        channel,
        user: userId,
        thread_ts: threadTs,
        event_timestamp: String(eventTimestamp),
      },
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

  getCacheStats() {
    return this.cache.getStats();
  }
  getCache(): ThreadCache {
    return this.cache;
  }
  getClient(): SlackClient {
    return this.client;
  }
  getConfig(): SlackBotConfig {
    return this.config;
  }
}
