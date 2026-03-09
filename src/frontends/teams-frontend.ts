/**
 * Microsoft Teams Frontend for Visor workflows.
 *
 * Mirrors the WhatsAppFrontend pattern:
 * - Sends AI replies as Teams text messages
 * - Uses standard Markdown (Teams renders it natively)
 * - No reaction equivalent (CheckScheduled is a no-op)
 */
import type { Frontend, FrontendContext } from './host';
import { TeamsClient } from '../teams/client';
import { formatTeamsText } from '../teams/markdown';
import type { ConversationReference } from 'botbuilder';

type TeamsFrontendConfig = {
  appId?: string;
  appPassword?: string;
  tenantId?: string;
};

export class TeamsFrontend implements Frontend {
  public readonly name = 'teams';
  private subs: Array<{ unsubscribe(): void }> = [];
  private cfg: TeamsFrontendConfig;
  private errorNotified: boolean = false;

  constructor(config?: TeamsFrontendConfig) {
    this.cfg = config || {};
  }

  start(ctx: FrontendContext): void {
    const bus = ctx.eventBus;

    try {
      ctx.logger.info(`[teams-frontend] started`);
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

    // CheckScheduled: no-op (Teams has no reaction equivalent for text messages)
    // StateTransition: no-op
  }

  stop(): void {
    for (const s of this.subs) s.unsubscribe();
    this.subs = [];
  }

  private getTeams(ctx: FrontendContext): TeamsClient | undefined {
    // Prefer injected client (for tests or shared runner context)
    const injected = (ctx as any).teams || (ctx as any).teamsClient;
    if (injected) return injected;
    // Lazy-create from env or frontend config
    try {
      const appId = this.cfg.appId || process.env.TEAMS_APP_ID;
      const appPassword = this.cfg.appPassword || process.env.TEAMS_APP_PASSWORD;
      if (
        typeof appId === 'string' &&
        appId.trim() &&
        typeof appPassword === 'string' &&
        appPassword.trim()
      ) {
        return new TeamsClient({
          appId: appId.trim(),
          appPassword: appPassword.trim(),
          tenantId: this.cfg.tenantId || process.env.TEAMS_TENANT_ID,
        });
      }
    } catch {}
    return undefined;
  }

  private getInboundTeamsPayload(ctx: FrontendContext): any | null {
    try {
      const endpoint = '/bots/teams/message';
      return (ctx as any).webhookContext?.webhookData?.get(endpoint) || null;
    } catch {
      return null;
    }
  }

  private async maybePostError(
    ctx: FrontendContext,
    title: string,
    message: string,
    _checkId?: string
  ): Promise<void> {
    if (this.errorNotified) return;
    const teams = this.getTeams(ctx);
    if (!teams) return;
    const payload = this.getInboundTeamsPayload(ctx);
    const conversationRef: ConversationReference | undefined =
      payload?.teams_conversation_reference;
    if (!conversationRef) return;
    const ev: any = payload?.event;

    let text = `${title}`;
    if (_checkId) text += `\nCheck: ${_checkId}`;
    if (message) text += `\n${message}`;

    await teams.sendMessage({
      conversationReference: conversationRef,
      text,
      replyToActivityId: ev?.activity_id,
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

      const teams = this.getTeams(ctx);
      if (!teams) return;

      const payload = this.getInboundTeamsPayload(ctx);
      const conversationRef: ConversationReference | undefined =
        payload?.teams_conversation_reference;
      if (!conversationRef) {
        ctx.logger.warn(
          `[teams-frontend] skip posting reply for ${checkId}: missing conversation reference`
        );
        return;
      }
      const ev: any = payload?.event;

      // Extract text (same logic as WhatsApp/Telegram/Email/Slack frontends)
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
        ctx.logger.info(`[teams-frontend] skip posting reply for ${checkId}: no renderable text`);
        return;
      }

      // Normalize literal \n escape sequences
      text = text.replace(/\\n/g, '\n');

      const formattedText = formatTeamsText(text);
      const postResult = await teams.sendMessage({
        conversationReference: conversationRef,
        text: formattedText,
        replyToActivityId: ev?.activity_id,
      });

      if (!postResult.ok) {
        ctx.logger.warn(
          `[teams-frontend] failed to post reply for ${checkId}: ${postResult.error}`
        );
        return;
      }
      ctx.logger.info(
        `[teams-frontend] posted reply for ${checkId} (activityId=${postResult.activityId})`
      );
    } catch (err) {
      try {
        ctx.logger.warn(
          `[teams-frontend] maybePostDirectReply failed for ${checkId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      } catch {}
    }
  }
}
