/**
 * Slack Frontend for Visor workflows.
 *
 * Features:
 * - Posts AI replies to Slack threads
 * - Converts Markdown to Slack mrkdwn format
 * - Renders mermaid diagrams to PNG and uploads as images
 * - Manages 👀/👍 reactions for acknowledgement
 * - Handles human input prompts via prompt-state
 *
 * Mermaid Diagram Rendering:
 * - Detects ```mermaid code blocks in AI responses
 * - Renders to PNG using @mermaid-js/mermaid-cli (mmdc)
 * - Uploads rendered images to Slack thread
 * - Replaces mermaid blocks with "_(See diagram above)_" placeholder
 *
 * Requirements for mermaid rendering:
 * - Node.js and npx in PATH
 * - Puppeteer/Chromium dependencies (mermaid-cli uses headless browser)
 * - On Linux: apt-get install chromium-browser libatk-bridge2.0-0 libgtk-3-0
 */
import type { Frontend, FrontendContext } from './host';
import { SlackClient } from '../slack/client';
import {
  formatSlackText,
  extractMermaidDiagrams,
  renderMermaidToPng,
  replaceMermaidBlocks,
} from '../slack/markdown';
import { context as otContext, trace } from '../telemetry/lazy-otel';

type SlackFrontendConfig = {
  defaultChannel?: string;
  groupChannels?: Record<string, string>;
  debounceMs?: number;
  maxWaitMs?: number;
  showRawOutput?: boolean;
  telemetry?: {
    enabled?: boolean;
  };
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
  private errorNotified: boolean = false;

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
        // Post execution failure notices when a check completes with fatal issues
        await this.maybePostExecutionFailure(ctx, ev.checkId, ev.result).catch(() => {});
      })
    );
    this.subs.push(
      bus.on('CheckErrored', async (env: any) => {
        const ev = (env && env.payload) || env;
        const message = ev?.error?.message || 'Execution error';
        await this.maybePostError(ctx, 'Check failed', message, ev?.checkId).catch(() => {});
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
    this.subs.push(
      bus.on('Shutdown', async (env: any) => {
        const ev = (env && env.payload) || env;
        const message = ev?.error?.message || 'Fatal error';
        await this.maybePostError(ctx, 'Run failed', message).catch(() => {});
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

  private isTelemetryEnabled(ctx: FrontendContext): boolean {
    try {
      const anyCfg: any = ctx.config || {};
      const slackCfg: any = anyCfg.slack || {};
      const telemetryCfg = slackCfg.telemetry ?? (this.cfg as any)?.telemetry;
      return (
        telemetryCfg === true ||
        (telemetryCfg && typeof telemetryCfg === 'object' && telemetryCfg.enabled === true)
      );
    } catch {
      return false;
    }
  }

  private async maybePostError(
    ctx: FrontendContext,
    title: string,
    message: string,
    checkId?: string
  ): Promise<void> {
    if (this.errorNotified) return;
    const slack = this.getSlack(ctx);
    if (!slack) return;
    const payload = this.getInboundSlackPayload(ctx);
    const ev: any = payload?.event;
    const channel = String(ev?.channel || '');
    const threadTs = String(ev?.thread_ts || ev?.ts || ev?.event_ts || '');
    if (!channel || !threadTs) return;

    let text = `❌ ${title}`;
    if (checkId) text += `\nCheck: ${checkId}`;
    if (message) text += `\n${message}`;

    if (this.isTelemetryEnabled(ctx)) {
      const traceInfo = this.getTraceInfo();
      if (traceInfo?.traceId) {
        text += `\n\n\`trace_id: ${traceInfo.traceId}\``;
      }
    }

    const formattedText = formatSlackText(text);
    await slack.chat.postMessage({ channel, text: formattedText, thread_ts: threadTs });
    try {
      ctx.logger.info(
        `[slack-frontend] posted error notice to ${channel} thread=${threadTs} check=${checkId || 'run'}`
      );
    } catch {}
    this.errorNotified = true;
  }

  private isExecutionFailureIssue(issue: any): boolean {
    const ruleId = String(issue?.ruleId || '');
    const msg = String(issue?.message || '');
    const msgLower = msg.toLowerCase();
    return (
      ruleId.endsWith('/error') ||
      ruleId.includes('/execution_error') ||
      ruleId.includes('timeout') ||
      ruleId.includes('sandbox_runner_error') ||
      msgLower.includes('timed out') ||
      msg.includes('Command execution failed')
    );
  }

  private async maybePostExecutionFailure(
    ctx: FrontendContext,
    checkId: string,
    result: { issues?: any[] }
  ): Promise<void> {
    try {
      if (this.errorNotified) return;
      const cfg: any = ctx.config || {};
      const checkCfg: any = cfg.checks?.[checkId];
      if (!checkCfg) return;
      if (checkCfg.type === 'human-input') return;
      if (checkCfg.criticality === 'internal') return;
      const issues = (result as any)?.issues;
      if (!Array.isArray(issues) || issues.length === 0) return;

      const failureIssue = issues.find(issue => this.isExecutionFailureIssue(issue));
      if (!failureIssue) return;
      if (
        typeof failureIssue.message === 'string' &&
        failureIssue.message.toLowerCase().includes('awaiting human input')
      ) {
        return;
      }

      const msg =
        typeof failureIssue.message === 'string' && failureIssue.message.trim().length > 0
          ? failureIssue.message.trim()
          : `Execution failed (${String(failureIssue.ruleId || 'unknown')})`;
      await this.maybePostError(ctx, 'Check failed', msg, checkId);
    } catch {}
  }

  private async ensureAcknowledgement(ctx: FrontendContext): Promise<void> {
    if (this.acked) return;
    const ref = this.getInboundSlackEvent(ctx);
    if (!ref) return;
    const slack = this.getSlack(ctx);
    if (!slack) return;
    // Skip ack for our own bot messages to avoid loops (allow other bots)
    try {
      const payload = this.getInboundSlackPayload(ctx);
      const ev: any = payload?.event;
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
      const telemetryCfg = slackRoot.telemetry ?? (this.cfg as any)?.telemetry;

      const providerType = (checkCfg.type as string) || '';
      const isAi = providerType === 'ai';
      const isLogChat = providerType === 'log' && checkCfg.group === 'chat';
      if (!isAi && !isLogChat) return;

      // Skip internal steps - they're intermediate processing and shouldn't post to Slack
      if (checkCfg.criticality === 'internal') return;

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
      } else if (isLogChat && typeof (result as any)?.logOutput === 'string') {
        // For log-based chat checks, render the formatted log output as the
        // Slack message when no structured text field is present.
        const raw = (result as any).logOutput;
        if (raw.trim().length > 0) {
          text = raw.trim();
        }
      } else if (isAi && showRawOutput && out !== undefined) {
        try {
          text = JSON.stringify(out, null, 2);
        } catch {
          text = String(out);
        }
      }
      if (!text) return;

      // Extract and render mermaid diagrams before posting
      const diagrams = extractMermaidDiagrams(text);
      let processedText = text;

      if (diagrams.length > 0) {
        try {
          ctx.logger.info(
            `[slack-frontend] found ${diagrams.length} mermaid diagram(s) to render for ${checkId}`
          );
        } catch {}

        // Render and upload each diagram
        const uploadedCount: number[] = [];
        for (let i = 0; i < diagrams.length; i++) {
          const diagram = diagrams[i];
          try {
            ctx.logger.info(`[slack-frontend] rendering mermaid diagram ${i + 1}...`);
            const pngBuffer = await renderMermaidToPng(diagram.code);
            if (pngBuffer) {
              ctx.logger.info(
                `[slack-frontend] rendered diagram ${i + 1}, size=${pngBuffer.length} bytes, uploading...`
              );
              const filename = `diagram-${i + 1}.png`;
              const uploadResult = await slack.files.uploadV2({
                content: pngBuffer,
                filename,
                channel,
                thread_ts: threadTs,
                title: `Diagram ${i + 1}`,
              });
              if (uploadResult.ok) {
                uploadedCount.push(i);
                ctx.logger.info(`[slack-frontend] uploaded mermaid diagram ${i + 1} to ${channel}`);
              } else {
                ctx.logger.warn(`[slack-frontend] upload failed for diagram ${i + 1}`);
              }
            } else {
              ctx.logger.warn(
                `[slack-frontend] mermaid rendering returned null for diagram ${i + 1} (mmdc failed or not installed)`
              );
            }
          } catch (e) {
            ctx.logger.warn(
              `[slack-frontend] failed to render/upload mermaid diagram ${i + 1}: ${
                e instanceof Error ? e.message : String(e)
              }`
            );
          }
        }

        // Replace mermaid blocks with placeholder text
        if (uploadedCount.length > 0) {
          processedText = replaceMermaidBlocks(text, diagrams, idx =>
            uploadedCount.includes(idx) ? '_(See diagram above)_' : '_(Diagram rendering failed)_'
          );
        }
      }

      let decoratedText = processedText;
      const telemetryEnabled =
        telemetryCfg === true ||
        (telemetryCfg && typeof telemetryCfg === 'object' && telemetryCfg.enabled === true);
      if (telemetryEnabled) {
        const traceInfo = this.getTraceInfo();
        if (traceInfo?.traceId) {
          const suffix = `\`trace_id: ${traceInfo.traceId}\``;
          decoratedText = `${decoratedText}\n\n${suffix}`;
        }
      }

      const formattedText = formatSlackText(decoratedText);
      await slack.chat.postMessage({ channel, text: formattedText, thread_ts: threadTs });
      ctx.logger.info(
        `[slack-frontend] posted AI reply for ${checkId} to ${channel} thread=${threadTs}`
      );
    } catch (outerErr) {
      // Log errors instead of silently swallowing them
      try {
        ctx.logger.warn(
          `[slack-frontend] maybePostDirectReply failed for ${checkId}: ${
            outerErr instanceof Error ? outerErr.message : String(outerErr)
          }`
        );
      } catch {}
    }
  }

  private getTraceInfo(): { traceId: string; spanId: string } | null {
    try {
      const span = trace.getSpan(otContext.active());
      if (!span) return null;
      const ctx = span.spanContext();
      if (!ctx || !ctx.traceId) return null;
      return { traceId: ctx.traceId, spanId: ctx.spanId };
    } catch {
      return null;
    }
  }
}
