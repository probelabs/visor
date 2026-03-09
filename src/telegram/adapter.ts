// Telegram message adapter.
// Normalizes Telegram messages into Visor's shared ConversationContext format,
// mirroring the pattern from src/slack/adapter.ts.

import type { TelegramClient, TelegramUser } from './client';
import type { ConversationContext, NormalizedMessage } from '../types/bot';

/** Subset of Telegram message fields we care about */
export interface TelegramMessageInfo {
  message_id: number;
  from?: { id: number; is_bot: boolean; first_name: string; username?: string };
  chat: {
    id: number;
    type: 'private' | 'group' | 'supergroup' | 'channel';
    title?: string;
    username?: string;
  };
  date: number;
  text?: string;
  caption?: string;
  reply_to_message?: TelegramMessageInfo;
  message_thread_id?: number;
}

export class TelegramAdapter {
  private client: TelegramClient;
  private botInfo: TelegramUser | null = null;

  constructor(client: TelegramClient) {
    this.client = client;
  }

  async initialize(): Promise<void> {
    this.botInfo = await this.client.init();
  }

  getBotUsername(): string | undefined {
    return this.botInfo?.username;
  }

  getBotUserId(): number | undefined {
    return this.botInfo?.id;
  }

  /** Check if the bot is mentioned in the message text via @username */
  isBotMentioned(text: string): boolean {
    if (!this.botInfo?.username) return false;
    return text.toLowerCase().includes(`@${this.botInfo.username.toLowerCase()}`);
  }

  /** Check if this is a private (DM) chat */
  isPrivateChat(chat: { type: string }): boolean {
    return chat.type === 'private';
  }

  /** Check if this is a channel post */
  isChannelPost(chat: { type: string }): boolean {
    return chat.type === 'channel';
  }

  /** Normalize a Telegram message to NormalizedMessage */
  normalizeMessage(msg: TelegramMessageInfo): NormalizedMessage {
    const isOwnBot = msg.from?.is_bot === true && msg.from?.id === this.botInfo?.id;
    return {
      role: isOwnBot ? 'bot' : 'user',
      text: msg.text || msg.caption || '',
      timestamp: String(msg.date),
      origin: isOwnBot ? 'visor' : undefined,
      user: msg.from ? String(msg.from.id) : undefined,
    };
  }

  /** Build ConversationContext from a Telegram message */
  buildConversationContext(msg: TelegramMessageInfo): ConversationContext {
    const chatId = String(msg.chat.id);
    const threadId = msg.message_thread_id ? `${chatId}:${msg.message_thread_id}` : chatId;

    const current = this.normalizeMessage(msg);

    // Strip bot mention from text for cleaner processing
    if (this.botInfo?.username) {
      current.text = current.text
        .replace(new RegExp(`@${this.botInfo.username}\\b`, 'gi'), '')
        .trim();
    }

    return {
      transport: 'telegram',
      thread: {
        id: threadId,
        url: msg.chat.username ? `https://t.me/${msg.chat.username}/${msg.message_id}` : undefined,
      },
      messages: [current],
      current,
      attributes: {
        chat_id: chatId,
        chat_type: msg.chat.type,
        message_id: String(msg.message_id),
        user: msg.from ? String(msg.from.id) : 'unknown',
        ...(msg.from?.username ? { username: msg.from.username } : {}),
        ...(msg.message_thread_id ? { message_thread_id: String(msg.message_thread_id) } : {}),
        ...(msg.chat.title ? { chat_title: msg.chat.title } : {}),
      },
    };
  }
}
