import type { Frontend, FrontendContext } from './host';
import { SlackClient } from '../slack/client';
import { formatSlackText } from '../slack/markdown';

type SlackFrontendConfig = {
  defaultChannel?: string;
  groupChannels?: Record<string, string>;
  debounceMs?: number;
  maxWaitMs?: number;
  showRawOutput?: boolean;
};

export class SlackFrontend implements Frontend {
  public readonly name = 'slack';
  private subs: Array<{ unsubscribe(): void }> = [];
  private cfg: SlackFrontendConfig;
  // Reactions ack/done per run (inbound Slack events only)
  private acked: boolean = false;
  private ackRef: { channel: string; ts: string } | null = null;
  private ackName: string = 'eyes';
  private doneName: string = 'thumbsup';

  constructor(config?: SlackFrontendConfig) {
    this.cfg = config || {};
  }

  start(ctx: FrontendContext): void {
    const bus = ctx.eventBus;

    // Info-level boot log
    try {
      const hasClient = !!(
        (ctx as any).slack ||
        (ctx as any).slackClient ||
        (this.cfg as any)?.botToken ||
        process.env.SLACK_BOT_TOKEN
      );
      ctx.logger.info(`[slack-frontend] started; hasClient=${hasClient} defaultChannel=unset`);
    } catch {}

    // If this run was triggered by a Slack event, log key attributes
    try {
      const payload = this.getInboundSlackPayload(ctx);
      if (payload) {
        const ev: any = payload.event || {};
        const ch = String(ev.channel || '-');
        const ts = String(ev.ts || ev.event_ts || '-');
        const user = String(ev.user || ev.bot_id || '-');
        const type = String(ev.type || '-');
        const thread = String(ev.thread_ts || '');
        ctx.logger.info(
          `[slack-frontend] inbound event received: type=${type} channel=${ch} ts=${ts}` +
            (thread ? ` thread_ts=${thread}` : '') +
            ` user=${user}`
        );
      }
    } catch {}

    // Listen to check lifecycle; we only post on completion/error (no queued placeholders)
    this.subs.push(
      bus.on('CheckCompleted', async (env: any) => {
        const ev = (env && env.payload) || env;
        // For chat-style AI checks, post direct replies into the Slack thread
        await this.maybePostDirectReply(ctx, ev.checkId, ev.result).catch(() => {});
      })
    );

    // On terminal state, replace 👀 with 👍 if we acked an inbound Slack message
    this.subs.push(
      bus.on('StateTransition', async (env: any) => {
        const ev = (env && env.payload) || env;
        if (ev && (ev.to === 'Completed' || ev.to === 'Error')) {
          await this.finalizeReactions(ctx).catch(() => {});
        }
      })
    );
    // Add 👀 acknowledgement as soon as first check is scheduled for Slack-driven runs
    this.subs.push(
      bus.on('CheckScheduled', async () => {
        await this.ensureAcknowledgement(ctx).catch(() => {});
      })
    );

    // Human-input requests: post prompt to Slack and mark waiting using prompt-state
    this.subs.push(
      bus.on('HumanInputRequested', async (env: any) => {
        try {
          const ev = (env && env.payload) || env;
          if (!ev || typeof ev.prompt !== 'string' || !ev.checkId) return;
          // Determine channel/thread (Slack SocketMode); if we can't, just ignore.
          let channel = ev.channel as string | undefined;
          let threadTs = ev.threadTs as string | undefined;
          if (!channel || !threadTs) {
            const payload = this.getInboundSlackPayload(ctx);
            const e: any = payload?.event;
            const derivedTs = String(e?.thread_ts || e?.ts || e?.event_ts || '');
            const derivedCh = String(e?.channel || '');
            if (derivedCh && derivedTs) {
              channel = channel || derivedCh;
              threadTs = threadTs || derivedTs;
            }
          }
          if (!channel || !threadTs) return;

          // Mark waiting in prompt-state without posting the prompt text to Slack.
          const { getPromptStateManager } = await import('../slack/prompt-state');
          const mgr = getPromptStateManager();
          const prev = mgr.getWaiting(channel, threadTs);
          const text = String(ev.prompt);
          mgr.setWaiting(channel, threadTs, {
            checkName: String(ev.checkId),
            prompt: text,
            promptMessageTs: prev?.promptMessageTs,
            promptsPosted: ((prev?.promptsPosted || 0) + 1) as any,
          });
          try {
            ctx.logger.info(
              `[slack-frontend] registered human-input waiting state for ${channel} thread=${threadTs}`
            );
          } catch {}
        } catch (e) {
          try {
            ctx.logger.warn(
              `[slack-frontend] HumanInputRequested handling failed: ${
                e instanceof Error ? e.message : String(e)
              }`
            );
          } catch {}
        }
      })
    );

    // SnapshotSaved: attach snapshot path to waiting entry for this thread
    this.subs.push(
      bus.on('SnapshotSaved', async (env: any) => {
        try {
          const ev = (env && env.payload) || env;
          const channel = String(ev?.channel || '');
          const threadTs = String(ev?.threadTs || '');
          const filePath = String(ev?.filePath || '');
          if (!channel || !threadTs || !filePath) return;
          const { getPromptStateManager } = await import('../slack/prompt-state');
          const mgr = getPromptStateManager();
          mgr.update(channel, threadTs, { snapshotPath: filePath });
          try {
            ctx.logger.info(
              `[slack-frontend] snapshot path attached to waiting prompt: ${filePath}`
            );
          } catch {}
        } catch {}
      })
    );
  }

  stop(): void {
    for (const s of this.subs) s.unsubscribe();
    this.subs = [];
  }

  private getSlack(ctx: FrontendContext): any | undefined {
    // Prefer injected fake client in tests: ctx.slack or ctx.slackClient
    const injected = (ctx as any).slack || (ctx as any).slackClient;
    if (injected) return injected;
    // Else try to lazy-create from env or frontend config
    try {
      const token = (this.cfg as any)?.botToken || process.env.SLACK_BOT_TOKEN;
      if (typeof token === 'string' && token.trim()) {
        return new SlackClient(token.trim());
      }
    } catch {}
    return undefined;
  }

  private getInboundSlackPayload(ctx: FrontendContext): any | null {
    try {
      const anyCfg: any = ctx.config || {};
      const slackCfg: any = anyCfg.slack || {};
      const endpoint: string = slackCfg.endpoint || '/bots/slack/support';
      const payload: any = (ctx as any).webhookContext?.webhookData?.get(endpoint);
      return payload || null;
    } catch {
      return null;
    }
  }

  private getInboundSlackEvent(ctx: FrontendContext): { channel: string; ts: string } | null {
    try {
      const payload = this.getInboundSlackPayload(ctx);
      const ev: any = payload?.event;
      const channel = String(ev?.channel || '');
      const ts = String(ev?.ts || ev?.event_ts || '');
      if (channel && ts) return { channel, ts };
    } catch {}
    return null;
  }

  private async ensureAcknowledgement(ctx: FrontendContext): Promise<void> {
    if (this.acked) return;
    const ref = this.getInboundSlackEvent(ctx);
    if (!ref) return;
    const slack = this.getSlack(ctx);
    if (!slack) return;
    // Skip ack for bot messages to avoid loops
    try {
      const payload = this.getInboundSlackPayload(ctx);
      const ev: any = payload?.event;
      if (ev?.subtype === 'bot_message') return;
      // If we can resolve bot user id, skip if the sender is the bot
      try {
        const botId = await slack.getBotUserId?.();
        if (botId && ev?.user && String(ev.user) === String(botId)) return;
      } catch {}
    } catch {}
    // Allow overrides via config
    try {
      const anyCfg: any = ctx.config || {};
      const slackCfg: any = anyCfg.slack || {};
      if (slackCfg?.reactions?.enabled === false) return;
      this.ackName = slackCfg?.reactions?.ack || this.ackName;
      this.doneName = slackCfg?.reactions?.done || this.doneName;
    } catch {}
    await slack.reactions.add({ channel: ref.channel, timestamp: ref.ts, name: this.ackName });
    try {
      ctx.logger.info(
        `[slack-frontend] added acknowledgement reaction :${this.ackName}: channel=${ref.channel} ts=${ref.ts}`
      );
    } catch {}
    this.acked = true;
    this.ackRef = ref;
  }

  private async finalizeReactions(ctx: FrontendContext): Promise<void> {
    if (!this.acked || !this.ackRef) return;
    const slack = this.getSlack(ctx);
    if (!slack) return;
    try {
      try {
        await slack.reactions.remove({
          channel: this.ackRef.channel,
          timestamp: this.ackRef.ts,
          name: this.ackName,
        });
      } catch {}
      await slack.reactions.add({
        channel: this.ackRef.channel,
        timestamp: this.ackRef.ts,
        name: this.doneName,
      });
      try {
        ctx.logger.info(
          `[slack-frontend] replaced acknowledgement with completion reaction :${this.doneName}: channel=${this.ackRef.channel} ts=${this.ackRef.ts}`
        );
      } catch {}
    } finally {
      // Reset for safety
      this.acked = false;
      this.ackRef = null;
    }
  }

  /**
   * Post direct replies into the originating Slack thread when appropriate.
   * This is independent of summary messages and is intended for chat-style flows
   * (e.g., AI answers and explicit chat/notify steps).
   */
  private async maybePostDirectReply(
    ctx: FrontendContext,
    checkId: string,
    result: { output?: any; content?: string }
  ): Promise<void> {
    try {
      const cfg: any = ctx.config || {};
      const checkCfg: any = cfg.checks?.[checkId];
      if (!checkCfg) return;

      // Per-workflow / per-frontend flag to allow posting raw JSON
      // outputs for AI steps (useful for debugging router outputs).
      const slackRoot: any = (cfg as any).slack || {};
      const showRawOutput =
        slackRoot.show_raw_output === true || (this.cfg as any)?.showRawOutput === true;

      const providerType = (checkCfg.type as string) || '';
      const isAi = providerType === 'ai';
      const isLogChat = providerType === 'log' && checkCfg.group === 'chat';
      if (!isAi && !isLogChat) return;

      // For AI checks, only post when using simple/unstructured schemas (or none).
      if (isAi) {
        const schema = checkCfg.schema;
        // String schemas: allow only simple/plain ones
        if (typeof schema === 'string') {
          const simpleSchemas = ['code-review', 'markdown', 'text', 'plain'];
          if (!simpleSchemas.includes(schema)) return;
        }
        // Object schemas (custom JSON): treat as structured; require output.text
      }

      const slack = this.getSlack(ctx);
      if (!slack) return;

      const payload = this.getInboundSlackPayload(ctx);
      const ev: any = payload?.event;
      const channel = String(ev?.channel || '');
      const threadTs = String(ev?.thread_ts || ev?.ts || ev?.event_ts || '');
      if (!channel || !threadTs) return;

      // Prefer output.text; fall back to content ONLY for string/simple schemas.
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
      } else if (isAi && showRawOutput && out !== undefined) {
        try {
          text = JSON.stringify(out, null, 2);
        } catch {
          text = String(out);
        }
      }
      if (!text) return;

      const formattedText = formatSlackText(text);
      await slack.chat.postMessage({ channel, text: formattedText, thread_ts: threadTs });
      try {
        ctx.logger.info(
          `[slack-frontend] posted AI reply for ${checkId} to ${channel} thread=${threadTs}`
        );
      } catch {}
    } catch {}
  }
}
