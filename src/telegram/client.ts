// Telegram Bot API wrapper built on grammy.
// Exposes Visor-friendly methods matching the SlackClient pattern
// while leveraging grammy for transport, rate limiting, and middleware.

import { Bot, type Api } from 'grammy';
import { chunkText } from './markdown';

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramSendResult {
  ok: boolean;
  message_id?: number;
  error?: string;
}

export class TelegramClient {
  private bot: Bot;
  private _botInfo: TelegramUser | null = null;

  constructor(botToken: string) {
    if (!botToken || typeof botToken !== 'string') {
      throw new Error('TelegramClient: botToken is required');
    }
    this.bot = new Bot(botToken);
  }

  /** Get the underlying grammy Bot instance (for polling runner) */
  getBot(): Bot {
    return this.bot;
  }

  /** Get the underlying grammy API instance */
  get api(): Api {
    return this.bot.api;
  }

  /** Initialize bot info (call before using) */
  async init(): Promise<TelegramUser> {
    const me = await this.bot.api.getMe();
    this._botInfo = {
      id: me.id,
      is_bot: me.is_bot,
      first_name: me.first_name,
      username: me.username,
    };
    return this._botInfo;
  }

  /** Get cached bot info */
  getBotInfo(): TelegramUser | null {
    return this._botInfo;
  }

  /**
   * Send a text message with optional HTML parse mode.
   * Auto-chunks messages exceeding 4096 characters.
   * Falls back to plain text if HTML parsing fails.
   */
  async sendMessage(opts: {
    chat_id: number | string;
    text: string;
    parse_mode?: 'HTML';
    reply_to_message_id?: number;
    message_thread_id?: number;
  }): Promise<TelegramSendResult> {
    try {
      const { chat_id, text, parse_mode, reply_to_message_id, message_thread_id } = opts;
      const chunks = chunkText(text, 4096);
      let firstMessageId: number | undefined;

      for (let i = 0; i < chunks.length; i++) {
        const params: Record<string, unknown> = {
          // disable_web_page_preview is deprecated, use link_preview_options
          link_preview_options: { is_disabled: true },
        };
        if (parse_mode) params.parse_mode = parse_mode;
        if (i === 0 && reply_to_message_id)
          params.reply_parameters = { message_id: reply_to_message_id };
        if (message_thread_id) params.message_thread_id = message_thread_id;

        try {
          const msg = await this.bot.api.sendMessage(chat_id, chunks[i], params as any);
          if (i === 0) firstMessageId = msg.message_id;
        } catch (err: any) {
          // If HTML parse fails, retry without parse_mode
          if (parse_mode === 'HTML' && err?.description?.includes("can't parse entities")) {
            const plainParams = { ...params };
            delete plainParams.parse_mode;
            const msg = await this.bot.api.sendMessage(chat_id, chunks[i], plainParams as any);
            if (i === 0) firstMessageId = msg.message_id;
          } else {
            throw err;
          }
        }
      }

      return { ok: true, message_id: firstMessageId };
    } catch (err: any) {
      const errMsg = err?.description || err?.message || String(err);
      console.warn(`Telegram sendMessage failed (non-fatal): ${errMsg}`);
      return { ok: false, error: errMsg };
    }
  }

  /**
   * Send a document/file.
   */
  async sendDocument(opts: {
    chat_id: number | string;
    document: Buffer;
    filename: string;
    caption?: string;
    parse_mode?: 'HTML';
    reply_to_message_id?: number;
    message_thread_id?: number;
  }): Promise<TelegramSendResult> {
    try {
      const {
        chat_id,
        document,
        filename,
        caption,
        parse_mode,
        reply_to_message_id,
        message_thread_id,
      } = opts;
      const params: Record<string, unknown> = {};
      if (caption) params.caption = caption.slice(0, 1024); // Telegram caption limit
      if (parse_mode) params.parse_mode = parse_mode;
      if (reply_to_message_id) params.reply_parameters = { message_id: reply_to_message_id };
      if (message_thread_id) params.message_thread_id = message_thread_id;

      const file = new (await import('grammy')).InputFile(document, filename);
      const msg = await this.bot.api.sendDocument(chat_id, file, params as any);
      return { ok: true, message_id: msg.message_id };
    } catch (err: any) {
      const errMsg = err?.description || err?.message || String(err);
      console.warn(`Telegram sendDocument failed (non-fatal): ${errMsg}`);
      return { ok: false, error: errMsg };
    }
  }

  /**
   * Add an emoji reaction to a message.
   * Note: Bot must be admin in groups to set reactions.
   */
  async setMessageReaction(opts: {
    chat_id: number | string;
    message_id: number;
    emoji: string;
  }): Promise<boolean> {
    try {
      await this.bot.api.setMessageReaction(opts.chat_id, opts.message_id, [
        { type: 'emoji', emoji: opts.emoji as any },
      ]);
      return true;
    } catch (err: any) {
      // Non-fatal: reactions may fail if bot lacks permissions
      console.warn(
        `Telegram setMessageReaction failed (non-fatal): ${err?.description || err?.message || String(err)}`
      );
      return false;
    }
  }
}
