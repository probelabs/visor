import { formatTelegramText } from '../telegram/markdown';
import type { TelegramClient } from '../telegram/client';
import { logger } from '../logger';
import type { TaskLiveUpdateSink } from './task-live-updates';

export class TelegramTaskLiveUpdateSink implements TaskLiveUpdateSink {
  readonly kind = 'telegram';
  private messageId?: number;

  constructor(
    private readonly telegram: TelegramClient,
    private readonly chatId: number | string,
    private readonly replyToMessageId: number,
    private readonly messageThreadId?: number,
    initialMessageId?: number
  ) {
    this.messageId = initialMessageId;
  }

  async start(): Promise<{ ref?: Record<string, unknown> } | null> {
    logger.debug(
      `[TaskLiveUpdates][Telegram] Initialized live update sink for chat=${this.chatId} reply_to=${this.replyToMessageId}`
    );
    return null;
  }

  async update(text: string): Promise<{ ref?: Record<string, unknown> } | null> {
    return this.publish(text, 'progress');
  }

  async complete(text: string): Promise<{ ref?: Record<string, unknown> } | null> {
    return this.publish(text, 'final');
  }

  async fail(text: string): Promise<{ ref?: Record<string, unknown> } | null> {
    return this.publish(text, 'final');
  }

  private async publish(
    text: string,
    mode: 'progress' | 'final'
  ): Promise<{ ref?: Record<string, unknown> } | null> {
    const formatted = formatTelegramText(text);
    if (this.messageId) {
      logger.debug(
        `[TaskLiveUpdates][Telegram] Updating existing message id=${this.messageId} in chat=${this.chatId}`
      );
      const updated = await this.telegram.editMessageText({
        chat_id: this.chatId,
        message_id: this.messageId,
        text: formatted,
        parse_mode: 'HTML',
      });
      if (updated?.ok) return null;
      logger.warn(
        `[TaskLiveUpdates][Telegram] editMessageText failed for message_id=${this.messageId} error=${updated?.error || 'unknown_error'}; falling back to sendMessage`
      );
    }

    logger.info(
      `[TaskLiveUpdates][Telegram] Posting live update message in chat=${this.chatId} reply_to=${this.replyToMessageId}`
    );
    const posted = await this.telegram.sendMessage({
      chat_id: this.chatId,
      text: formatted,
      parse_mode: 'HTML',
      reply_to_message_id: this.replyToMessageId,
      ...(this.messageThreadId ? { message_thread_id: this.messageThreadId } : {}),
    });
    if (posted?.ok && posted.message_id) {
      const previousMessageId = this.messageId;
      this.messageId = posted.message_id;
      if (mode === 'final' && previousMessageId && previousMessageId !== posted.message_id) {
        const deleted = await this.telegram.deleteMessage({
          chat_id: this.chatId,
          message_id: previousMessageId,
        });
        if (!deleted) {
          logger.warn(
            `[TaskLiveUpdates][Telegram] deleteMessage failed for stale live update message_id=${previousMessageId}`
          );
        } else {
          logger.info(
            `[TaskLiveUpdates][Telegram] Removed stale live update message id=${previousMessageId} after final fallback post`
          );
        }
      }
      return {
        ref: {
          telegram_live_update_chat_id: String(this.chatId),
          telegram_live_update_message_id: posted.message_id,
          ...(this.messageThreadId ? { telegram_live_update_thread_id: this.messageThreadId } : {}),
        },
      };
    }

    return null;
  }
}
