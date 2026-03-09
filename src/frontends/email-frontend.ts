/**
 * Email Frontend for Visor workflows.
 *
 * Mirrors the TelegramFrontend pattern:
 * - Sends AI replies as threaded emails (In-Reply-To, References headers)
 * - Converts Markdown to email HTML format
 * - No reaction equivalent (CheckScheduled is a no-op)
 */
import type { Frontend, FrontendContext } from './host';
import { EmailClient, type EmailSendOptions } from '../email/client';
import { formatEmailText, wrapInEmailTemplate, addRePrefix } from '../email/markdown';

type EmailFrontendConfig = {
  send?: {
    type?: string;
    host?: string;
    port?: number;
    auth?: { user?: string; pass?: string };
    secure?: boolean;
    from?: string;
    api_key?: string;
  };
};

export class EmailFrontend implements Frontend {
  public readonly name = 'email';
  private subs: Array<{ unsubscribe(): void }> = [];
  private cfg: EmailFrontendConfig;
  private errorNotified: boolean = false;

  constructor(config?: EmailFrontendConfig) {
    this.cfg = config || {};
  }

  start(ctx: FrontendContext): void {
    const bus = ctx.eventBus;

    try {
      ctx.logger.info(`[email-frontend] started`);
    } catch {}

    // CheckCompleted: send reply email
    this.subs.push(
      bus.on('CheckCompleted', async (env: any) => {
        const ev = (env && env.payload) || env;
        await this.maybePostDirectReply(ctx, ev.checkId, ev.result).catch(() => {});
      }),
    );

    // CheckErrored: send error email
    this.subs.push(
      bus.on('CheckErrored', async (env: any) => {
        const ev = (env && env.payload) || env;
        const message = ev?.error?.message || 'Execution error';
        await this.maybePostError(ctx, 'Check failed', message, ev?.checkId).catch(() => {});
      }),
    );

    // Shutdown: send fatal error email
    this.subs.push(
      bus.on('Shutdown', async (env: any) => {
        const ev = (env && env.payload) || env;
        const message = ev?.error?.message || 'Fatal error';
        await this.maybePostError(ctx, 'Run failed', message).catch(() => {});
      }),
    );

    // CheckScheduled: no-op for email (no reaction equivalent)
    // StateTransition: no-op for email
  }

  stop(): void {
    for (const s of this.subs) s.unsubscribe();
    this.subs = [];
  }

  private getEmailClient(ctx: FrontendContext): EmailClient | undefined {
    // Prefer injected client (for tests or shared runner context)
    const injected = (ctx as any).emailClient;
    if (injected) return injected;
    // Lazy-create from config
    try {
      const emailConfig = (ctx as any).webhookContext?.webhookData?.get('/bots/email/message');
      const sendCfg = this.cfg.send || (emailConfig as any)?.sendConfig;
      if (sendCfg || process.env.EMAIL_SMTP_HOST || process.env.RESEND_API_KEY) {
        return new EmailClient({
          send: sendCfg || {
            type: process.env.RESEND_API_KEY ? 'resend' : 'smtp',
          },
        });
      }
    } catch {}
    return undefined;
  }

  private getInboundEmailPayload(ctx: FrontendContext): any | null {
    try {
      const endpoint = '/bots/email/message';
      return (ctx as any).webhookContext?.webhookData?.get(endpoint) || null;
    } catch {
      return null;
    }
  }

  private async maybePostError(
    ctx: FrontendContext,
    title: string,
    message: string,
    checkId?: string,
  ): Promise<void> {
    if (this.errorNotified) return;
    const client = this.getEmailClient(ctx);
    if (!client) return;
    const payload = this.getInboundEmailPayload(ctx);
    const ev: any = payload?.event;
    if (!ev?.from) return;

    let text = `${title}`;
    if (checkId) text += `\nCheck: ${checkId}`;
    if (message) text += `\n${message}`;

    const sendOpts: EmailSendOptions = {
      to: ev.from,
      subject: ev.subject ? addRePrefix(ev.subject) : `Visor: ${title}`,
      text,
      html: wrapInEmailTemplate(`<p><strong>${title}</strong></p><p>${message}</p>`),
    };

    // Thread the reply
    if (ev.messageId) {
      sendOpts.inReplyTo = ev.messageId;
      sendOpts.references = ev.references
        ? [...ev.references, ev.messageId]
        : [ev.messageId];
    }

    await client.sendEmail(sendOpts);
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

      const client = this.getEmailClient(ctx);
      if (!client) return;

      const payload = this.getInboundEmailPayload(ctx);
      const ev: any = payload?.event;
      if (!ev?.from) {
        ctx.logger.warn(
          `[email-frontend] skip posting reply for ${checkId}: missing from address`,
        );
        return;
      }

      // Extract text (same logic as TelegramFrontend/SlackFrontend)
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
          `[email-frontend] skip posting reply for ${checkId}: no renderable text`,
        );
        return;
      }

      // Normalize literal \n escape sequences
      text = text.replace(/\\n/g, '\n');

      const htmlBody = formatEmailText(text);
      const sendOpts: EmailSendOptions = {
        to: ev.from,
        subject: ev.subject ? addRePrefix(ev.subject) : `Re: Visor response`,
        text,
        html: wrapInEmailTemplate(htmlBody),
      };

      // Thread the reply
      if (ev.messageId) {
        sendOpts.inReplyTo = ev.messageId;
        sendOpts.references = ev.references
          ? [...ev.references, ev.messageId]
          : [ev.messageId];
      }

      const sendResult = await client.sendEmail(sendOpts);

      if (!sendResult.ok) {
        ctx.logger.warn(
          `[email-frontend] failed to send reply for ${checkId}: ${sendResult.error}`,
        );
        return;
      }
      ctx.logger.info(
        `[email-frontend] sent reply for ${checkId} to ${ev.from} (messageId=${sendResult.messageId})`,
      );
    } catch (err) {
      try {
        ctx.logger.warn(
          `[email-frontend] maybePostDirectReply failed for ${checkId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } catch {}
    }
  }
}
