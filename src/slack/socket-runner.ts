import WebSocket from 'ws';
import { logger } from '../logger';
import type { VisorConfig } from '../types/config';
import { StateMachineExecutionEngine } from '../state-machine-execution-engine';
import { SlackClient } from './client';
import { SlackAdapter } from './adapter';
import { CachePrewarmer } from './cache-prewarmer';
import { RateLimiter, type RateLimitConfig } from './rate-limiter';
import type { SlackBotConfig } from '../types/bot';
import { withActiveSpan } from '../telemetry/trace-helpers';

type SlackSocketConfig = {
  appToken?: string; // xapp- token
  endpoint?: string; // reuse http_input endpoint for injection
  mentions?: 'direct' | 'all';
  threads?: 'required' | 'any';
  channel_allowlist?: string[]; // simple wildcard prefix match, e.g., CENG*
};

export class SlackSocketRunner {
  private appToken: string;
  private endpoint: string;
  private mentions: 'direct' | 'all' = 'direct';
  private threads: 'required' | 'any' = 'any';
  private allow: string[] = [];
  private ws?: WebSocket;
  private engine: StateMachineExecutionEngine;
  private cfg: VisorConfig;
  private client?: SlackClient;
  private limiter?: RateLimiter;
  private botUserId?: string;
  private processedKeys: Map<string, number> = new Map();
  private adapter?: SlackAdapter;
  private retryCount = 0;

  constructor(engine: StateMachineExecutionEngine, cfg: VisorConfig, opts: SlackSocketConfig) {
    const app = opts.appToken || process.env.SLACK_APP_TOKEN || '';
    if (!app) throw new Error('SLACK_APP_TOKEN (xapp-…) is required for Socket Mode');
    this.appToken = app;
    this.endpoint = opts.endpoint || '/bots/slack/support';
    this.mentions = opts.mentions || 'direct';
    this.threads = opts.threads || 'any';
    this.allow = Array.isArray(opts.channel_allowlist) ? opts.channel_allowlist : [];
    this.engine = engine;
    this.cfg = cfg;
  }

  /**
   * Lazily initialize the SlackClient if not already set.
   * Called by both start() and handleMessage() to ensure the client is available.
   */
  private async ensureClient(): Promise<void> {
    if (this.client) return;
    const slackAny: any = (this.cfg as any).slack || {};
    const botToken = slackAny.bot_token || process.env.SLACK_BOT_TOKEN;
    if (botToken) {
      this.client = new SlackClient(botToken);
      try {
        this.botUserId = await this.client.getBotUserId();
      } catch {}
    }
  }

  async start(): Promise<void> {
    // Optional cache prewarming
    try {
      await this.ensureClient();
      const slackAny: any = (this.cfg as any).slack || {};
      const botToken = slackAny.bot_token || process.env.SLACK_BOT_TOKEN;
      if (this.client && slackAny.cache_prewarming?.enabled) {
        const client = this.client;
        const adapter = new SlackAdapter(client, {
          id: 'default',
          endpoint: this.endpoint,
          signing_secret: '',
          bot_token: botToken!,
          fetch: {
            scope: 'thread',
            max_messages: slackAny.fetch?.max_messages || 40,
            cache: slackAny.fetch?.cache,
          },
        });
        const pre = new CachePrewarmer(client, adapter, slackAny.cache_prewarming || {});
        const res = await pre.prewarm();
        logger.info(`[SlackSocket] Prewarmed ${res.totalThreads} threads in ${res.durationMs}ms`);
      }
    } catch (e) {
      logger.warn(`[SlackSocket] Prewarm skipped: ${e instanceof Error ? e.message : e}`);
    }
    // Optional rate limiter
    try {
      const slackAny2: any = (this.cfg as any).slack || {};
      const rl = slackAny2.rate_limiting as RateLimitConfig | undefined;
      if (rl && rl.enabled) {
        this.limiter = new RateLimiter(rl);
        logger.info('[SlackSocket] Rate limiter enabled');
      }
    } catch {}

    const url = await this.openConnection();
    await this.connect(url);
  }

  private async openConnection(): Promise<string> {
    const resp = await fetch('https://slack.com/api/apps.connections.open', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.appToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: '',
    });
    const json: any = await resp.json();
    if (!json || json.ok !== true || typeof json.url !== 'string') {
      throw new Error(`apps.connections.open failed: ${(json && json.error) || 'unknown_error'}`);
    }
    logger.info('[SlackSocket] Connection URL acquired');
    return json.url;
  }

  private async connect(url: string): Promise<void> {
    this.ws = new WebSocket(url);
    this.ws.on('open', () => {
      this.retryCount = 0; // Reset on successful connection
      logger.info('[SlackSocket] WebSocket connected');
    });
    this.ws.on('close', (code, reason) => {
      logger.warn(`[SlackSocket] WebSocket closed: ${code} ${reason}`);
      setTimeout(() => this.restart().catch(() => {}), 1000);
    });
    this.ws.on('error', err => {
      logger.error(`[SlackSocket] WebSocket error: ${err}`);
    });
    this.ws.on('message', data => this.handleMessage(data.toString()).catch(() => {}));
  }

  private async restart(): Promise<void> {
    try {
      const url = await this.openConnection();
      await this.connect(url);
    } catch (e) {
      this.retryCount++;
      // Exponential backoff: 2s, 4s, 8s, 16s, 32s, capped at 60s
      const delay = Math.min(2000 * Math.pow(2, this.retryCount - 1), 60000);
      logger.error(
        `[SlackSocket] Restart failed (attempt ${this.retryCount}), retrying in ${Math.round(delay / 1000)}s: ${e instanceof Error ? e.message : e}`
      );
      setTimeout(() => this.restart().catch(() => {}), delay);
    }
  }

  private send(obj: unknown): void {
    try {
      this.ws?.send(JSON.stringify(obj));
    } catch {}
  }

  private matchesAllowlist(channel?: string): boolean {
    if (!this.allow.length) return true;
    if (!channel) return false;
    return this.allow.some(pat =>
      pat.endsWith('*') ? channel.startsWith(pat.slice(0, -1)) : channel === pat
    );
  }

  private async handleMessage(raw: string): Promise<void> {
    let env: any;
    try {
      env = JSON.parse(raw);
    } catch {
      if (process.env.VISOR_DEBUG === 'true') {
        logger.debug('[SlackSocket] Dropping non-JSON payload');
      }
      return;
    }
    if (env.type === 'hello') return;
    if (env.envelope_id) this.send({ envelope_id: env.envelope_id }); // ack ASAP
    if (env.type !== 'events_api' || !env.payload) {
      if (process.env.VISOR_DEBUG === 'true') {
        logger.debug(`[SlackSocket] Dropping non-events payload: type=${String(env.type || '-')}`);
      }
      return;
    }
    const p = env.payload;
    const ev = p.event || {};
    const type = ev.type as string;
    const subtype = ev.subtype as string | undefined;

    // Ensure botUserId is available for mention detection when possible
    try {
      await this.ensureClient();
    } catch {}

    // Ignore edited/changed events to prevent loops
    if (subtype && subtype !== 'thread_broadcast' && subtype !== 'bot_message') {
      if (process.env.VISOR_DEBUG === 'true') {
        logger.debug(`[SlackSocket] Dropping subtype=${subtype}`);
      }
      return;
    }
    // Only skip our own bot messages, allow other bots to trigger Visor
    if (this.botUserId && ev.user && String(ev.user) === String(this.botUserId)) {
      if (process.env.VISOR_DEBUG === 'true') {
        logger.debug('[SlackSocket] Dropping self-bot message');
      }
      return;
    }

    // Info-level receipt log for observability
    try {
      const ch = String(ev.channel || '-');
      const ts = String(ev.ts || ev.event_ts || '-');
      const thread = String(ev.thread_ts || ev.ts || '');
      const user = String(ev.user || ev.bot_id || '-');
      logger.info(
        `[SlackSocket] event received: type=${type} channel=${ch} ts=${ts}` +
          (thread ? ` thread_ts=${thread}` : '') +
          ` user=${user}`
      );
    } catch {}

    // Gating: mentions / DM vs channel
    const channelId = String(ev.channel || '');
    // Only treat 1:1 DMs (D*) as DM-like; private channels/MPIMs (G*) require mentions.
    const isDmLike = channelId.startsWith('D');
    const text = String(ev.text || '');
    const hasBotMention = !!this.botUserId && text.includes(`<@${String(this.botUserId)}>`);

    // In public channels (C*) and private channels (G*), only react to app_mention
    // events or explicit mentions so we don't trigger on every message in a thread.
    // In 1:1 DMs we allow plain
    // message events when mentions=all.
    if (!isDmLike) {
      if (type !== 'app_mention' && !hasBotMention) {
        if (process.env.VISOR_DEBUG === 'true') {
          logger.debug(
            `[SlackSocket] Dropping public message: type=${type} hasBotMention=${hasBotMention}`
          );
        }
        return;
      }
    } else {
      if (this.mentions === 'direct' && type !== 'app_mention' && !hasBotMention) {
        if (process.env.VISOR_DEBUG === 'true') {
          logger.debug(
            `[SlackSocket] Dropping DM message: type=${type} hasBotMention=${hasBotMention}`
          );
        }
        return;
      }
    }
    // Gating: threads (accept root messages by treating ts as thread root)
    const rootOrThread = ev.thread_ts || ev.ts || ev.event_ts;
    if (this.threads === 'required' && !rootOrThread) {
      if (process.env.VISOR_DEBUG === 'true') {
        logger.debug('[SlackSocket] Dropping message: threads required but no thread_ts');
      }
      return;
    }
    // channel allowlist
    if (!this.matchesAllowlist(ev.channel)) {
      if (process.env.VISOR_DEBUG === 'true') {
        logger.debug(`[SlackSocket] Dropping message: channel not in allowlist`);
      }
      return;
    }

    // Deduplicate duplicate events (e.g., message + app_mention with same ts)
    try {
      const key = `${String(ev.channel || '-')}:${String(ev.ts || ev.event_ts || '-')}`;
      const now = Date.now();
      for (const [k, t] of this.processedKeys.entries())
        if (now - t > 10000) this.processedKeys.delete(k);
      if (this.processedKeys.has(key)) {
        if (process.env.VISOR_DEBUG === 'true') {
          logger.debug(`[SlackSocket] Dropping duplicate event key=${key}`);
        }
        return;
      }
      this.processedKeys.set(key, now);
    } catch {}

    // Prepare Slack conversation context (best-effort) for AI prompts and helpers
    let payloadForContext: any = env.payload;
    try {
      const adapter = this.getSlackAdapter();
      const channel = String(ev.channel || '');
      const rootTs = String(ev.thread_ts || ev.ts || ev.event_ts || '');
      const ts = String(ev.ts || ev.event_ts || '');
      const user = String(ev.user || 'unknown');
      const cleanedText = String(ev.text || '')
        .replace(/<@[A-Z0-9]+>/g, '')
        .trim();
      if (adapter && channel && rootTs && ts) {
        const conversation = await adapter.fetchConversation(channel, rootTs, {
          ts,
          user,
          text: cleanedText || String(ev.text || ''),
          timestamp: Date.now(),
        });
        payloadForContext = { ...env.payload, slack_conversation: conversation };
      }
    } catch {
      payloadForContext = env.payload;
    }

    // Prepare webhookContext map for http_input provider reuse
    const map = new Map<string, unknown>();
    map.set(this.endpoint, payloadForContext);

    // Determine checks to run: run http_input checks bound to this endpoint plus dependents
    // For simplicity and to ensure dependents run, request all checks; config-driven assume/if will gate.
    const allChecks = Object.keys(this.cfg.checks || {});
    if (allChecks.length === 0) return;

    // Ensure Slack frontend is enabled for this run so reactions/prompts are handled
    const cfgForRun: VisorConfig = (() => {
      try {
        const cfg = JSON.parse(JSON.stringify(this.cfg));
        const fronts = Array.isArray(cfg.frontends) ? cfg.frontends : [];
        if (!fronts.some((f: any) => f && f.name === 'slack')) fronts.push({ name: 'slack' });
        cfg.frontends = fronts;
        return cfg;
      } catch {
        return this.cfg;
      }
    })();

    // Seed first message for this thread to allow initial human-input to consume it exactly once
    try {
      const { getPromptStateManager } = await import('./prompt-state');
      const mgr = getPromptStateManager();
      const ch = String(ev.channel || '');
      const rootTs = String(ev.thread_ts || ev.ts || ev.event_ts || '');
      // Remove @mentions to get clean content
      const cleaned = String(ev.text || '')
        .replace(/<@[A-Z0-9]+>/g, '')
        .trim();
      if (ch && rootTs && cleaned) mgr.setFirstMessage(ch, rootTs, cleaned);
    } catch {}

    logger.info('[SlackSocket] Dispatching engine run for Slack event');
    try {
      // Rate limiting (optional)
      const userId = String(ev.user || 'unknown');
      const channelId = String(ev.channel || 'unknown');
      const botId = this.botUserId || 'bot';
      let rlReq: import('./rate-limiter').RateLimitRequest | undefined;
      if (this.limiter) {
        rlReq = { botId, userId, channelId };
        const res = await this.limiter.check(rlReq);
        if (!res.allowed) {
          logger.warn(
            `[SlackSocket] Rate limited (dim=${res.blocked_by}); remaining=${res.remaining} reset=${res.reset}`
          );
          return;
        }
      }
      // If we have a snapshot recorded for this thread, prefer resuming from it
      const { getPromptStateManager } = await import('./prompt-state');
      const mgr = getPromptStateManager();
      const channel = String(ev.channel || '');
      const threadTs = String(ev.thread_ts || ev.ts || ev.event_ts || '');
      const waiting = channel && threadTs ? mgr.getWaiting(channel, threadTs) : undefined;
      const path = waiting?.snapshotPath;
      const runEngine = new StateMachineExecutionEngine();
      // Ensure Slack client is initialized (lazy init for tests that don't call start())
      await this.ensureClient();
      // Inject Slack client into execution context so frontends/providers can use it
      // Also propagate any hooks from the parent engine (useful for testing with mock responses)
      try {
        const parentCtx: any = (this.engine as any).getExecutionContext?.() || {};
        const prevCtx: any = (runEngine as any).getExecutionContext?.() || {};
        (runEngine as any).setExecutionContext?.({
          ...parentCtx, // Propagate hooks and other context from parent engine
          ...prevCtx,
          slack: this.client || parentCtx.slack,
          slackClient: this.client || parentCtx.slackClient,
        });
      } catch {}
      try {
        await withActiveSpan(
          'visor.run',
          {
            'visor.run.source': 'slack',
            'slack.event.type': String(type || ''),
            'slack.channel': channelId,
            'slack.thread_ts': threadTs,
          },
          async () => {
            if (path) {
              try {
                const snapshot = await (runEngine as any).loadSnapshotFromFile(path);
                const { resumeFromSnapshot } = await import('../state-machine-execution-engine');
                logger.info(`[SlackSocket] Resuming from snapshot: ${path}`);
                await resumeFromSnapshot(runEngine, snapshot, cfgForRun, {
                  webhookContext: { webhookData: map, eventType: 'manual' },
                  debug: process.env.VISOR_DEBUG === 'true',
                });
                return;
              } catch (e) {
                logger.warn(
                  `[SlackSocket] Snapshot resume failed, falling back to cold run: ${
                    e instanceof Error ? e.message : String(e)
                  }`
                );
              }
            }

            // Cold run (no snapshot)
            await runEngine.executeChecks({
              checks: allChecks,
              showDetails: true,
              outputFormat: 'json',
              config: cfgForRun,
              webhookContext: { webhookData: map, eventType: 'manual' },
              debug: process.env.VISOR_DEBUG === 'true',
            } as any);
          }
        );
      } finally {
        if (this.limiter && rlReq) await this.limiter.release(rlReq);
      }
    } catch (e) {
      logger.error(
        `[SlackSocket] Engine execution failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /** Lazily construct a SlackAdapter for conversation context (cache-first thread fetch) */
  private getSlackAdapter(): SlackAdapter | undefined {
    if (!this.client) return undefined;
    if (this.adapter) return this.adapter;
    try {
      const slackAny: any = (this.cfg as any).slack || {};
      const botToken = slackAny.bot_token || process.env.SLACK_BOT_TOKEN;
      if (!botToken) return undefined;
      const botConfig: SlackBotConfig = {
        id: 'default',
        endpoint: this.endpoint,
        signing_secret: '',
        bot_token: botToken,
        fetch: {
          scope: 'thread',
          max_messages: slackAny.fetch?.max_messages || 40,
          cache: slackAny.fetch?.cache,
        },
        channel_allowlist: slackAny.channel_allowlist,
        response: slackAny.response,
        worker_pool: slackAny.worker_pool,
        cache_observability: slackAny.cache_observability,
        cache_prewarming: slackAny.cache_prewarming,
        rate_limiting: slackAny.rate_limiting,
        workflow: slackAny.workflow,
      };
      this.adapter = new SlackAdapter(this.client, botConfig, undefined, 'socket');
      return this.adapter;
    } catch {
      return undefined;
    }
  }
}
