/**
 * WhatsApp Frontend for Visor workflows.
 *
 * Mirrors the TelegramFrontend pattern:
 * - Sends AI replies as WhatsApp text messages
 * - Converts Markdown to WhatsApp format
 * - No reaction equivalent (CheckScheduled is a no-op)
 */
import type { Frontend, FrontendContext } from './host';
import { WhatsAppClient } from '../whatsapp/client';
import { formatWhatsAppText } from '../whatsapp/markdown';

type WhatsAppFrontendConfig = {
  accessToken?: string;
  phoneNumberId?: string;
};

export class WhatsAppFrontend implements Frontend {
  public readonly name = 'whatsapp';
  private subs: Array<{ unsubscribe(): void }> = [];
  private cfg: WhatsAppFrontendConfig;
  private errorNotified: boolean = false;

  constructor(config?: WhatsAppFrontendConfig) {
    this.cfg = config || {};
  }

  start(ctx: FrontendContext): void {
    const bus = ctx.eventBus;

    try {
      ctx.logger.info(`[whatsapp-frontend] started`);
    } catch {}

    // CheckCompleted: post AI replies
    this.subs.push(
      bus.on('CheckCompleted', async (env: any) => {
        const ev = (env && env.payload) || env;
        await this.maybePostDirectReply(ctx, ev.checkId, ev.result).catch(() => {});
      })
    );

    // CheckErrored: post error notice
    this.subs.push(
      bus.on('CheckErrored', async (env: any) => {
        const ev = (env && env.payload) || env;
        const message = ev?.error?.message || 'Execution error';
        await this.maybePostError(ctx, 'Check failed', message, ev?.checkId).catch(() => {});
      })
    );

    // Shutdown: post error
    this.subs.push(
      bus.on('Shutdown', async (env: any) => {
        const ev = (env && env.payload) || env;
        const message = ev?.error?.message || 'Fatal error';
        await this.maybePostError(ctx, 'Run failed', message).catch(() => {});
      })
    );

    // CheckScheduled: no-op (WhatsApp has no reaction equivalent)
    // StateTransition: no-op
  }

  stop(): void {
    for (const s of this.subs) s.unsubscribe();
    this.subs = [];
  }

  private getWhatsApp(ctx: FrontendContext): WhatsAppClient | undefined {
    // Prefer injected client (for tests or shared runner context)
    const injected = (ctx as any).whatsapp || (ctx as any).whatsappClient;
    if (injected) return injected;
    // Lazy-create from env or frontend config
    try {
      const token = this.cfg.accessToken || process.env.WHATSAPP_ACCESS_TOKEN;
      const phoneId = this.cfg.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
      if (
        typeof token === 'string' &&
        token.trim() &&
        typeof phoneId === 'string' &&
        phoneId.trim()
      ) {
        return new WhatsAppClient({
          accessToken: token.trim(),
          phoneNumberId: phoneId.trim(),
        });
      }
    } catch {}
    return undefined;
  }

  private getInboundWhatsAppPayload(ctx: FrontendContext): any | null {
    try {
      const endpoint = '/bots/whatsapp/message';
      return (ctx as any).webhookContext?.webhookData?.get(endpoint) || null;
    } catch {
      return null;
    }
  }

  private async maybePostError(
    ctx: FrontendContext,
    title: string,
    message: string,
    checkId?: string
  ): Promise<void> {
    if (this.errorNotified) return;
    const whatsapp = this.getWhatsApp(ctx);
    if (!whatsapp) return;
    const payload = this.getInboundWhatsAppPayload(ctx);
    const ev: any = payload?.event;
    const from = ev?.from;
    if (!from) return;

    let text = `${title}`;
    if (checkId) text += `\nCheck: ${checkId}`;
    if (message) text += `\n${message}`;

    await whatsapp.sendMessage({
      to: from,
      text,
      replyToMessageId: ev?.message_id,
    });
    this.errorNotified = true;
  }

  private async maybePostDirectReply(
    ctx: FrontendContext,
    checkId: string,
    result: { output?: any; content?: string }
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

      const whatsapp = this.getWhatsApp(ctx);
      if (!whatsapp) return;

      const payload = this.getInboundWhatsAppPayload(ctx);
      const ev: any = payload?.event;
      const from = ev?.from;
      if (!from) {
        ctx.logger.warn(
          `[whatsapp-frontend] skip posting reply for ${checkId}: missing from number`
        );
        return;
      }

      // Extract text (same logic as Telegram/Email/Slack frontends)
      const out: any = (result as any)?.output;
      let text: string | undefined;
      if (out && typeof out.text === 'string' && out.text.trim().length > 0) {
        text = out.text.trim();
      } else if (isAi && typeof checkCfg.schema === 'string') {
        if (
          typeof (result as any)?.content === 'string' &&
          (result as any).content.trim().length > 0
        ) {
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
          `[whatsapp-frontend] skip posting reply for ${checkId}: no renderable text`
        );
        return;
      }

      // Normalize literal \n escape sequences
      text = text.replace(/\\n/g, '\n');

      const formattedText = formatWhatsAppText(text);
      const postResult = await whatsapp.sendMessage({
        to: from,
        text: formattedText,
        replyToMessageId: ev?.message_id,
      });

      if (!postResult.ok) {
        ctx.logger.warn(
          `[whatsapp-frontend] failed to post reply for ${checkId}: ${postResult.error}`
        );
        return;
      }
      ctx.logger.info(
        `[whatsapp-frontend] posted reply for ${checkId} to ${from} (messageId=${postResult.messageId})`
      );
    } catch (err) {
      try {
        ctx.logger.warn(
          `[whatsapp-frontend] maybePostDirectReply failed for ${checkId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      } catch {}
    }
  }
}
