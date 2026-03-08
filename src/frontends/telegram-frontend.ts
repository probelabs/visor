/**
 * Telegram Frontend for Visor workflows.
 *
 * Mirrors the SlackFrontend pattern:
 * - Posts AI replies to Telegram chats
 * - Converts Markdown to Telegram HTML format
 * - Manages emoji reactions for acknowledgement (👀 → 👍)
 */
import type { Frontend, FrontendContext } from './host';
import { TelegramClient } from '../telegram/client';
import { formatTelegramText } from '../telegram/markdown';

type TelegramFrontendConfig = {
  defaultChatId?: string | number;
  botToken?: string;
};

export class TelegramFrontend implements Frontend {
  public readonly name = 'telegram';
  private subs: Array<{ unsubscribe(): void }> = [];
  private cfg: TelegramFrontendConfig;
  private acked: boolean = false;
  private ackRef: { chatId: number | string; messageId: number } | null = null;
  private errorNotified: boolean = false;

  constructor(config?: TelegramFrontendConfig) {
    this.cfg = config || {};
  }

  start(ctx: FrontendContext): void {
    const bus = ctx.eventBus;

    try {
      ctx.logger.info(`[telegram-frontend] started`);
    } catch {}

    // Log inbound event if triggered from Telegram
    try {
      const payload = this.getInboundTelegramPayload(ctx);
      if (payload) {
        const ev: any = payload.event || {};
        const chatId = String(ev.chat_id || '-');
        const msgId = String(ev.message_id || '-');
        ctx.logger.info(
          `[telegram-frontend] inbound event: chat_id=${chatId} message_id=${msgId}`,
        );
      }
    } catch {}

    // CheckCompleted: post AI replies
    this.subs.push(
      bus.on('CheckCompleted', async (env: any) => {
        const ev = (env && env.payload) || env;
        await this.maybePostDirectReply(ctx, ev.checkId, ev.result).catch(() => {});
      }),
    );

    // CheckErrored: post error notice
    this.subs.push(
      bus.on('CheckErrored', async (env: any) => {
        const ev = (env && env.payload) || env;
        const message = ev?.error?.message || 'Execution error';
        await this.maybePostError(ctx, 'Check failed', message, ev?.checkId).catch(() => {});
      }),
    );

    // StateTransition: finalize reactions on terminal state
    this.subs.push(
      bus.on('StateTransition', async (env: any) => {
        const ev = (env && env.payload) || env;
        if (ev && (ev.to === 'Completed' || ev.to === 'Error')) {
          await this.finalizeReactions(ctx).catch(() => {});
        }
      }),
    );

    // Shutdown: post error
    this.subs.push(
      bus.on('Shutdown', async (env: any) => {
        const ev = (env && env.payload) || env;
        const message = ev?.error?.message || 'Fatal error';
        await this.maybePostError(ctx, 'Run failed', message).catch(() => {});
      }),
    );

    // CheckScheduled: add acknowledgement reaction
    this.subs.push(
      bus.on('CheckScheduled', async () => {
        await this.ensureAcknowledgement(ctx).catch(() => {});
      }),
    );
  }

  stop(): void {
    for (const s of this.subs) s.unsubscribe();
    this.subs = [];
  }

  private getTelegram(ctx: FrontendContext): TelegramClient | undefined {
    // Prefer injected client (for tests or shared runner context)
    const injected = (ctx as any).telegram || (ctx as any).telegramClient;
    if (injected) return injected;
    // Lazy-create from env or frontend config
    try {
      const token = this.cfg.botToken || process.env.TELEGRAM_BOT_TOKEN;
      if (typeof token === 'string' && token.trim()) {
        return new TelegramClient(token.trim());
      }
    } catch {}
    return undefined;
  }

  private getInboundTelegramPayload(ctx: FrontendContext): any | null {
    try {
      const endpoint = '/bots/telegram/message';
      return (ctx as any).webhookContext?.webhookData?.get(endpoint) || null;
    } catch {
      return null;
    }
  }

  private getInboundTelegramEvent(ctx: FrontendContext): { chatId: number | string; messageId: number } | null {
    try {
      const payload = this.getInboundTelegramPayload(ctx);
      const ev: any = payload?.event;
      const chatId = ev?.chat_id;
      const messageId = ev?.message_id;
      if (chatId !== undefined && messageId !== undefined) {
        return { chatId, messageId };
      }
    } catch {}
    return null;
  }

  private async ensureAcknowledgement(ctx: FrontendContext): Promise<void> {
    if (this.acked) return;
    const ref = this.getInboundTelegramEvent(ctx);
    if (!ref) return;
    const telegram = this.getTelegram(ctx);
    if (!telegram) return;

    // Skip ack for own bot messages
    try {
      const payload = this.getInboundTelegramPayload(ctx);
      const ev: any = payload?.event;
      const botInfo = telegram.getBotInfo();
      if (botInfo && ev?.from?.id === botInfo.id) return;
    } catch {}

    await telegram.setMessageReaction({
      chat_id: ref.chatId,
      message_id: ref.messageId,
      emoji: '👀',
    });
    try {
      ctx.logger.info(
        `[telegram-frontend] added ack reaction chat_id=${ref.chatId} message_id=${ref.messageId}`,
      );
    } catch {}
    this.acked = true;
    this.ackRef = ref;
  }

  private async finalizeReactions(ctx: FrontendContext): Promise<void> {
    if (!this.acked || !this.ackRef) return;
    const telegram = this.getTelegram(ctx);
    if (!telegram) return;
    try {
      await telegram.setMessageReaction({
        chat_id: this.ackRef.chatId,
        message_id: this.ackRef.messageId,
        emoji: '👍',
      });
      try {
        ctx.logger.info(
          `[telegram-frontend] finalized reaction chat_id=${this.ackRef.chatId} message_id=${this.ackRef.messageId}`,
        );
      } catch {}
    } finally {
      this.acked = false;
      this.ackRef = null;
    }
  }

  private async maybePostError(
    ctx: FrontendContext,
    title: string,
    message: string,
    checkId?: string,
  ): Promise<void> {
    if (this.errorNotified) return;
    const telegram = this.getTelegram(ctx);
    if (!telegram) return;
    const payload = this.getInboundTelegramPayload(ctx);
    const ev: any = payload?.event;
    const chatId = ev?.chat_id;
    const messageId = ev?.message_id;
    if (chatId === undefined) return;

    let text = `❌ ${title}`;
    if (checkId) text += `\nCheck: ${checkId}`;
    if (message) text += `\n${message}`;

    await telegram.sendMessage({
      chat_id: chatId,
      text,
      reply_to_message_id: messageId,
    });
    this.errorNotified = true;
  }

  private async maybePostDirectReply(
    ctx: FrontendContext,
    checkId: string,
    result: { output?: any; content?: string },
  ): Promise<void> {
    try {
      const cfg: any = ctx.config || {};
      const checkCfg: any = cfg.checks?.[checkId];
      if (!checkCfg) return;

      const providerType = (checkCfg.type as string) || '';
      const isAi = providerType === 'ai';
      const isLogChat = providerType === 'log' && checkCfg.group === 'chat';
      const isWorkflow = providerType === 'workflow';
      if (!isAi && !isLogChat && !isWorkflow) return;
      if (checkCfg.criticality === 'internal') return;

      // For AI checks, only post simple schemas
      if (isAi) {
        const schema = checkCfg.schema;
        if (typeof schema === 'string') {
          const simpleSchemas = ['code-review', 'markdown', 'text', 'plain'];
          if (!simpleSchemas.includes(schema)) return;
        }
      }

      const telegram = this.getTelegram(ctx);
      if (!telegram) return;

      const payload = this.getInboundTelegramPayload(ctx);
      const ev: any = payload?.event;
      const chatId = ev?.chat_id;
      const messageId = ev?.message_id;
      if (chatId === undefined) {
        ctx.logger.warn(
          `[telegram-frontend] skip posting reply for ${checkId}: missing chat_id`,
        );
        return;
      }

      // Extract text (same logic as SlackFrontend)
      const out: any = (result as any)?.output;
      let text: string | undefined;
      if (out && typeof out.text === 'string' && out.text.trim().length > 0) {
        text = out.text.trim();
      } else if (isAi && typeof checkCfg.schema === 'string') {
        if (typeof (result as any)?.content === 'string' && (result as any).content.trim().length > 0) {
          text = (result as any).content.trim();
        }
      } else if (isLogChat && typeof (result as any)?.logOutput === 'string') {
        const raw = (result as any).logOutput;
        if (raw.trim().length > 0) text = raw.trim();
      }

      // Append raw output
      if (out && typeof out._rawOutput === 'string' && out._rawOutput.trim().length > 0) {
        text = (text || '') + '\n\n' + out._rawOutput.trim();
      }

      if (!text) {
        ctx.logger.info(
          `[telegram-frontend] skip posting reply for ${checkId}: no renderable text`,
        );
        return;
      }

      // Normalize literal \n escape sequences
      text = text.replace(/\\n/g, '\n');

      const formattedText = formatTelegramText(text);
      const postResult = await telegram.sendMessage({
        chat_id: chatId,
        text: formattedText,
        parse_mode: 'HTML',
        reply_to_message_id: messageId,
        message_thread_id: ev?.message_thread_id,
      });

      if (!postResult.ok) {
        ctx.logger.warn(
          `[telegram-frontend] failed to post reply for ${checkId}: ${postResult.error}`,
        );
        return;
      }
      ctx.logger.info(
        `[telegram-frontend] posted reply for ${checkId} to chat_id=${chatId} message_id=${postResult.message_id}`,
      );
    } catch (err) {
      try {
        ctx.logger.warn(
          `[telegram-frontend] maybePostDirectReply failed for ${checkId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } catch {}
    }
  }
}
