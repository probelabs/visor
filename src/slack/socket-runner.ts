import WebSocket from 'ws';
import { logger } from '../logger';
import type { Runner } from '../runners/runner';
import type { VisorConfig, SchedulerConfig } from '../types/config';
import { StateMachineExecutionEngine } from '../state-machine-execution-engine';
import { SlackClient } from './client';
import { SlackAdapter } from './adapter';
import { CachePrewarmer } from './cache-prewarmer';
import { RateLimiter, type RateLimitConfig } from './rate-limiter';
import type { SlackBotConfig } from '../types/bot';
import { withActiveSpan, withVisorRun, getVisorRunAttributes } from '../telemetry/trace-helpers';
import { Scheduler } from '../scheduler/scheduler';
import { ScheduleStore, type Schedule } from '../scheduler/schedule-store';
import { createHash } from 'crypto';
import { createSlackOutputAdapter } from './slack-output-adapter';
import { WorkspaceManager } from '../utils/workspace-manager';
import { MessageTriggerEvaluator, type MatchedTrigger } from '../scheduler/message-trigger';
import type { SlackMessageTrigger } from '../types/config';
import { toSlackMessageTrigger, type MessageTrigger } from '../scheduler/store/types';

type SlackSocketConfig = {
  appToken?: string; // xapp- token
  endpoint?: string; // reuse http_input endpoint for injection
  mentions?: 'direct' | 'all';
  threads?: 'required' | 'any';
  channel_allowlist?: string[]; // simple wildcard prefix match, e.g., CENG*
  allowBotMessages?: boolean; // allow bot_message events (default: false)
  allowGuests?: boolean; // allow guest users (single/multi-channel guests) (default: false)
};

/**
 * Build enriched message text for task tracking.
 * Includes Slack thread context when available so evaluators have full conversation context.
 */
function buildSlackMessageText(ev: any, payloadForContext: any): string {
  let messageText = String(ev.text || 'Slack message');
  try {
    const messages = payloadForContext?.slack_conversation?.messages;
    if (Array.isArray(messages) && messages.length > 1) {
      const threadMessages = messages
        .map((m: any) => `[${m.user || 'unknown'}]: ${m.text || ''}`)
        .join('\n');
      messageText = `Thread context:\n${threadMessages}\n\nCurrent message: ${ev.text}`;
    }
  } catch {}
  return messageText;
}

export class SlackSocketRunner implements Runner {
  readonly name = 'slack';
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
  private allowBotMessages: boolean = false;
  private allowGuests: boolean = false;
  private processedKeys: Map<string, number> = new Map();
  private userInfoCache: Map<
    string,
    {
      isGuest: boolean;
      email?: string;
      name?: string;
      realName?: string;
      timestamp: number;
    }
  > = new Map();
  private adapter?: SlackAdapter;
  private retryCount = 0;
  private genericScheduler?: Scheduler;
  private messageTriggerEvaluator?: MessageTriggerEvaluator;
  private activeThreads = new Set<string>();
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private lastPong = 0;
  private closing = false; // prevent duplicate reconnects
  private draining = false; // drain mode: reject new work, wait for in-flight
  private taskStore?: import('../agent-protocol/task-store').TaskStore;
  private configPath?: string;
  private staleTaskTimer?: ReturnType<typeof setInterval>;

  constructor(engine: StateMachineExecutionEngine, cfg: VisorConfig, opts: SlackSocketConfig) {
    const app = opts.appToken || process.env.SLACK_APP_TOKEN || '';
    if (!app) throw new Error('SLACK_APP_TOKEN (xapp-…) is required for Socket Mode');
    this.appToken = app;
    this.endpoint = opts.endpoint || '/bots/slack/support';
    this.mentions = opts.mentions || 'direct';
    this.threads = opts.threads || 'any';
    this.allow = Array.isArray(opts.channel_allowlist) ? opts.channel_allowlist : [];
    const slackAny: any = (cfg as any).slack || {};
    this.allowBotMessages =
      opts.allowBotMessages === true ||
      slackAny.allow_bot_messages === true ||
      process.env.VISOR_SLACK_ALLOW_BOT_MESSAGES === 'true';
    this.allowGuests =
      opts.allowGuests === true ||
      slackAny.allow_guests === true ||
      process.env.VISOR_SLACK_ALLOW_GUESTS === 'true';
    this.engine = engine;
    this.cfg = cfg;
    this.initMessageTriggersFromConfig();
  }

  /** Set shared task store for execution tracking. */
  setTaskStore(store: import('../agent-protocol/task-store').TaskStore, configPath?: string): void {
    this.taskStore = store;
    this.configPath = configPath;
  }

  /** Hot-swap the config used for future requests (does not affect in-flight ones). */
  updateConfig(cfg: VisorConfig): void {
    this.cfg = cfg;
    this.initMessageTriggersAsync().catch(err => {
      logger.warn(
        `[SlackSocket] Failed to reload message triggers: ${err instanceof Error ? err.message : err}`
      );
    });
  }

  /**
   * Initialize message triggers from config only (sync, used in constructor).
   * Does not include DB triggers since the store may not be initialized yet.
   */
  private initMessageTriggersFromConfig(): void {
    const triggers = this.cfg.scheduler?.on_message;
    if (triggers && Object.keys(triggers).length > 0) {
      this.messageTriggerEvaluator = new MessageTriggerEvaluator(triggers);
      logger.debug(
        `[SlackSocket] Message triggers loaded (config only): ${Object.keys(triggers).length} trigger(s)`
      );
    } else {
      this.messageTriggerEvaluator = undefined;
    }
  }

  /**
   * Initialize or rebuild the message trigger evaluator by merging config + DB triggers.
   */
  private async initMessageTriggersAsync(): Promise<void> {
    const configTriggers = this.cfg.scheduler?.on_message || {};
    const dbTriggers: Record<string, SlackMessageTrigger> = {};

    try {
      const store = ScheduleStore.getInstance();
      if (store.isInitialized()) {
        const triggers = await store.getActiveTriggersAsync();
        for (const t of triggers) {
          dbTriggers[`db:${t.id}`] = toSlackMessageTrigger(t);
        }
      }
    } catch (err) {
      logger.warn(
        `[SlackSocket] Failed to load DB triggers (using config only): ${err instanceof Error ? err.message : err}`
      );
    }

    const all = { ...configTriggers, ...dbTriggers };

    if (Object.keys(all).length > 0) {
      this.messageTriggerEvaluator = new MessageTriggerEvaluator(all);
      logger.debug(
        `[SlackSocket] Message triggers loaded: ${Object.keys(configTriggers).length} config + ${Object.keys(dbTriggers).length} DB = ${Object.keys(all).length} total`
      );
    } else {
      this.messageTriggerEvaluator = undefined;
    }
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

    // Initialize generic scheduler
    try {
      const schedulerCfg = this.cfg.scheduler as SchedulerConfig | undefined;

      if (schedulerCfg?.enabled !== false && this.client) {
        this.genericScheduler = new Scheduler(this.cfg, {
          storagePath: schedulerCfg?.storage?.path,
          limits: schedulerCfg?.limits
            ? {
                maxPerUser: schedulerCfg.limits.max_per_user,
                maxRecurringPerUser: schedulerCfg.limits.max_recurring_per_user,
                maxGlobal: schedulerCfg.limits.max_global,
              }
            : undefined,
          defaultTimezone: schedulerCfg?.default_timezone,
        });
        this.genericScheduler.setEngine(this.engine);
        if (this.taskStore) this.genericScheduler.setTaskStore(this.taskStore, this.configPath);

        // Pass Slack client to scheduler so it can inject into workflow executions
        this.genericScheduler.setExecutionContext({
          slack: this.client,
          slackClient: this.client,
        });

        // Register Slack output adapter
        this.genericScheduler.registerOutputAdapter(createSlackOutputAdapter(this.client));

        await this.genericScheduler.start();
        logger.info('[SlackSocket] Scheduler enabled');

        // Register callback to rebuild triggers when they change via the schedule tool
        ScheduleStore.setTriggersChangedCallback(() => {
          this.initMessageTriggersAsync().catch(err => {
            logger.warn(
              `[SlackSocket] Failed to reload triggers after change: ${err instanceof Error ? err.message : err}`
            );
          });
        });

        // Now that the store is initialized, load DB triggers too
        await this.initMessageTriggersAsync();
      }
    } catch (e) {
      logger.warn(`[SlackSocket] Scheduler init failed: ${e instanceof Error ? e.message : e}`);
    }

    // Start background GitHub App token refresh timer (no-op if no App credentials)
    try {
      const { startTokenRefreshTimer } = await import('../github-auth');
      startTokenRefreshTimer();
    } catch {}

    const url = await this.openConnection();
    await this.connect(url);

    // Clean up stale workspace directories from previous runs
    WorkspaceManager.cleanupStale().catch(() => {});

    // Periodic stale task sweep — fail 'working' tasks with no heartbeat.
    // Tasks send a heartbeat every 60s, so 5 minutes without an update means
    // the owning process is dead. Works in multi-node deployments.
    if (this.taskStore) {
      const STALE_TASK_SWEEP_INTERVAL = 120_000; // 2 minutes
      const STALE_TASK_AGE = 120_000; // 2 minutes (2x the 60s heartbeat)
      this.staleTaskTimer = setInterval(() => {
        try {
          const failed = (this.taskStore as any).failStaleTasksByAge?.(
            STALE_TASK_AGE,
            'Owning process is no longer running (no heartbeat)'
          );
          if (failed > 0) {
            logger.info(`[SlackSocket] Marked ${failed} stale task(s) as failed`);
          }
        } catch {}
      }, STALE_TASK_SWEEP_INTERVAL);
    }
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
    // Close previous WebSocket to prevent ghost event handlers
    this.closeWebSocket();

    const ws = new WebSocket(url);
    this.ws = ws;
    this.closing = false;

    ws.on('open', () => {
      this.retryCount = 0; // Reset on successful connection
      this.lastPong = Date.now();
      logger.info('[SlackSocket] WebSocket connected');
      this.startHeartbeat();
    });
    ws.on('close', (code, reason) => {
      logger.warn(`[SlackSocket] WebSocket closed: ${code} ${reason}`);
      this.stopHeartbeat();
      // Only reconnect if this is still the active WebSocket
      if (this.ws === ws && !this.closing) {
        this.closing = true;
        setTimeout(() => this.restart(), 1000);
      }
    });
    ws.on('error', err => {
      logger.error(`[SlackSocket] WebSocket error: ${err}`);
    });
    ws.on('pong', () => {
      this.lastPong = Date.now();
    });
    ws.on('message', data => this.handleMessage(data.toString()).catch(() => {}));
  }

  /**
   * Close the current WebSocket connection and stop heartbeat.
   * Safe to call multiple times.
   */
  private closeWebSocket(): void {
    this.stopHeartbeat();
    if (this.ws) {
      const old = this.ws;
      this.ws = undefined;
      try {
        // Remove listeners to prevent ghost close/message handlers
        old.removeAllListeners();
        old.close();
      } catch {
        // best effort
      }
    }
  }

  /**
   * Start periodic WebSocket ping to detect dead connections.
   * If no pong is received within 60s, force a reconnect.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    const PING_INTERVAL_MS = 30_000; // ping every 30s
    const PONG_TIMEOUT_MS = 60_000; // dead if no pong for 60s

    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      // Check if last pong is stale
      const sincePong = Date.now() - this.lastPong;
      if (this.lastPong > 0 && sincePong > PONG_TIMEOUT_MS) {
        logger.warn(
          `[SlackSocket] No pong received for ${Math.round(sincePong / 1000)}s, forcing reconnect`
        );
        this.closeWebSocket();
        this.closing = true;
        this.restart();
        return;
      }

      try {
        this.ws.ping();
      } catch {
        // ping failed — connection is likely dead
        logger.warn('[SlackSocket] Ping failed, forcing reconnect');
        this.closeWebSocket();
        this.closing = true;
        this.restart();
      }
    }, PING_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private async restart(): Promise<void> {
    this.closing = false;
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
      setTimeout(() => this.restart(), delay);
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

  /**
   * Fetch and cache user info including guest status, email, and name.
   * Results are cached for 5 minutes to avoid excessive API calls.
   */
  private async fetchUserInfo(userId: string): Promise<{
    isGuest: boolean;
    email?: string;
    name?: string;
    realName?: string;
  } | null> {
    if (!userId || userId === 'unknown') return null;
    if (!this.client) return null;

    // Check cache first (5 minute TTL)
    const cached = this.userInfoCache.get(userId);
    const now = Date.now();
    if (cached && now - cached.timestamp < 5 * 60 * 1000) {
      return cached;
    }

    // Clean up old cache entries
    for (const [k, v] of this.userInfoCache.entries()) {
      if (now - v.timestamp > 5 * 60 * 1000) this.userInfoCache.delete(k);
    }

    try {
      const info = await this.client.getUserInfo(userId);
      if (!info.ok || !info.user) {
        return null;
      }
      // is_restricted = multi-channel guest, is_ultra_restricted = single-channel guest
      const userInfo = {
        isGuest: info.user.is_restricted === true || info.user.is_ultra_restricted === true,
        email: info.user.email,
        name: info.user.name,
        realName: info.user.real_name,
        timestamp: now,
      };
      this.userInfoCache.set(userId, userInfo);
      return userInfo;
    } catch {
      return null;
    }
  }

  /**
   * Check if user is a guest (single-channel or multi-channel guest).
   */
  private async isGuestUser(userId: string): Promise<boolean> {
    const info = await this.fetchUserInfo(userId);
    return info?.isGuest ?? false;
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

    // In drain mode, acknowledge messages but don't process new work
    if (this.draining) {
      // Still allow disconnect handling for clean shutdown
      if (env.type === 'disconnect') {
        // Don't reconnect during drain
        return;
      }
      // Optionally notify the user that the bot is restarting
      const ev = env.payload?.event;
      if (ev?.channel && ev?.ts) {
        try {
          await this.ensureClient();
          await this.client?.chat.postMessage({
            channel: String(ev.channel),
            thread_ts: String(ev.thread_ts || ev.ts),
            text: ':hourglass: The bot is restarting. Please retry your message shortly.',
          });
        } catch {}
      }
      return;
    }

    // Handle Slack disconnect events — proactively reconnect before the connection dies
    if (env.type === 'disconnect') {
      const reason = env.reason || 'unknown';
      logger.info(`[SlackSocket] Received disconnect event (reason: ${reason}), reconnecting`);
      // Slack will close the connection shortly; proactively reconnect now
      this.closeWebSocket();
      this.closing = true;
      this.restart();
      return;
    }

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

    // Extract text from attachments (monitoring tools like Logz.io, PagerDuty, Datadog
    // send messages with empty text and all content in attachments)
    const attachmentText = (() => {
      if (!Array.isArray(ev.attachments) || ev.attachments.length === 0) return '';
      const parts: string[] = [];
      for (const att of ev.attachments) {
        if (att.pretext) parts.push(att.pretext);
        if (att.title) parts.push(att.title);
        if (att.text) parts.push(att.text);
        if (Array.isArray(att.fields)) {
          for (const f of att.fields) {
            if (f.value) parts.push(f.title ? `${f.title}: ${f.value}` : f.value);
          }
        }
      }
      return parts.join('\n');
    })();
    // Full text: top-level text + attachment text (for trigger matching and context)
    const fullText = ev.text
      ? attachmentText
        ? `${ev.text}\n\n${attachmentText}`
        : String(ev.text)
      : attachmentText;

    // Ensure botUserId is available for mention detection when possible
    try {
      await this.ensureClient();
    } catch {}

    // Handle app_home_opened — publish Home tab view and return early
    if (type === 'app_home_opened') {
      await this.publishAppHome(String(ev.user || ''));
      return;
    }

    // Ignore edited/changed events to prevent loops (allow file_share — users can share attachments)
    if (
      subtype &&
      subtype !== 'thread_broadcast' &&
      subtype !== 'bot_message' &&
      subtype !== 'file_share'
    ) {
      if (process.env.VISOR_DEBUG === 'true') {
        logger.debug(`[SlackSocket] Dropping subtype=${subtype}`);
      }
      return;
    }
    // Ignore bot messages unless explicitly allowed OR message triggers are configured
    // (message triggers have their own from_bots filter per trigger)
    if (subtype === 'bot_message' && !this.allowBotMessages && !this.messageTriggerEvaluator) {
      if (process.env.VISOR_DEBUG === 'true') {
        logger.debug('[SlackSocket] Dropping bot_message (disabled)');
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

    // Filter out guest users (single-channel and multi-channel guests) unless explicitly allowed
    if (!this.allowGuests && ev.user) {
      const isGuest = await this.isGuestUser(String(ev.user));
      if (isGuest) {
        if (process.env.VISOR_DEBUG === 'true') {
          logger.debug(`[SlackSocket] Dropping message from guest user: ${String(ev.user)}`);
        }
        return;
      }
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

    // Evaluate message triggers (before mention gate so non-@mention messages can trigger workflows)
    if (this.messageTriggerEvaluator) {
      try {
        const matches = this.messageTriggerEvaluator.evaluate({
          channel: String(ev.channel || ''),
          user: String(ev.user || ''),
          text: fullText || String(ev.text || ''),
          isBot: subtype === 'bot_message',
          threadTs: ev.thread_ts ? String(ev.thread_ts) : undefined,
          ts: String(ev.ts || ev.event_ts || ''),
        });
        for (const match of matches) {
          // Dedup: use trigger-specific key
          const triggerKey = `trigger:${match.id}:${String(ev.channel || '-')}:${String(ev.ts || ev.event_ts || '-')}`;
          if (!this.processedKeys.has(triggerKey)) {
            this.processedKeys.set(triggerKey, Date.now());
            this.dispatchMessageTrigger(match, env.payload).catch(err => {
              logger.error(
                `[SlackSocket] Message trigger dispatch failed (${match.id}): ${err instanceof Error ? err.message : err}`
              );
            });
          }
        }
      } catch (err) {
        logger.warn(
          `[SlackSocket] Message trigger evaluation error: ${err instanceof Error ? err.message : err}`
        );
      }
    }

    // If this is a bot message that was only allowed through for trigger evaluation,
    // do not proceed to the mention-based dispatch path
    if (subtype === 'bot_message' && !this.allowBotMessages) {
      return;
    }

    // Gating: mentions / DM vs channel
    const channelId = String(ev.channel || '');
    // Only treat 1:1 DMs (D*) as DM-like; private channels/MPIMs (G*) require mentions.
    const isDmLike = channelId.startsWith('D');
    const text = String(ev.text || '');
    const hasBotMention = !!this.botUserId && text.includes(`<@${String(this.botUserId)}>`);
    const isMentionEvent = type === 'app_mention' || hasBotMention;

    // In public (C*) and private (G*) channels, require an explicit bot mention
    // so we don't trigger on every message in a thread.
    // In 1:1 DMs we allow plain message events when mentions=all.
    if (!isDmLike) {
      if (!isMentionEvent) {
        if (process.env.VISOR_DEBUG === 'true') {
          logger.debug(
            `[SlackSocket] Dropping channel message: type=${type} hasBotMention=${hasBotMention}`
          );
        }
        return;
      }
    } else {
      if (this.mentions === 'direct' && !isMentionEvent) {
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
          files: Array.isArray(ev.files) ? ev.files : undefined,
          attachments: Array.isArray(ev.attachments) ? ev.attachments : undefined,
        });
        payloadForContext = { ...env.payload, slack_conversation: conversation };
      }
    } catch {
      payloadForContext = env.payload;
    }

    // Stash Slack user info on payload for policy engine (pre-fetch to avoid duplicate API calls)
    try {
      const userId = String(ev.user || '');
      if (userId) {
        const userInfo = await this.fetchUserInfo(userId);
        if (userInfo) {
          payloadForContext = { ...payloadForContext, slack_user_info: userInfo };
        }
      }
    } catch {}

    // Attach active tasks context so the AI knows what's already in progress
    try {
      if (this.taskStore) {
        const channelId = String(ev.channel || '');
        const threadTs = String(ev.thread_ts || ev.ts || ev.event_ts || '');
        if (channelId && threadTs) {
          const { rows } = (this.taskStore as any).listTasksRaw?.({
            state: ['submitted', 'working'],
            metadata: { slack_channel: channelId, slack_thread_ts: threadTs },
            limit: 10,
          }) || { rows: [] };
          if (rows && rows.length > 0) {
            payloadForContext = {
              ...payloadForContext,
              active_tasks: rows.map((r: any) => ({
                id: r.id,
                state: r.state,
                created_at: r.created_at,
                workflow_id: r.workflow_id,
                trigger_message:
                  r.metadata?.slack_trigger_text || (r.request_message || '').slice(0, 300),
              })),
            };
          }
        }
      }
    } catch {}

    // Prepare webhookContext map for http_input provider reuse
    const map = new Map<string, unknown>();
    map.set(this.endpoint, payloadForContext);
    // Inject task store so built-in tools (task_progress) can access it
    if (this.taskStore) {
      map.set('__taskStore', this.taskStore);
    }

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

    // Derive stable workspace name from Slack thread identity so all messages
    // in the same thread share the same workspace directory (git checkouts persist).
    const wsChannel = String(ev.channel || '');
    const wsThreadTs = String(ev.thread_ts || ev.ts || ev.event_ts || '');
    if (wsChannel && wsThreadTs) {
      const hash = createHash('sha256')
        .update(`${wsChannel}:${wsThreadTs}`)
        .digest('hex')
        .slice(0, 8);
      const workspaceName = `slack-${hash}`;
      if (!(cfgForRun as any).workspace) {
        (cfgForRun as any).workspace = {};
      }
      (cfgForRun as any).workspace.name = workspaceName;
      (cfgForRun as any).workspace.cleanup_on_exit = false;
    }

    // Seed first message for this thread to allow initial human-input to consume it exactly once
    try {
      const { getPromptStateManager } = await import('./prompt-state');
      const mgr = getPromptStateManager();
      const ch = String(ev.channel || '');
      const rootTs = String(ev.thread_ts || ev.ts || ev.event_ts || '');
      // Remove @mentions to get clean content; include attachment text for monitoring messages
      const cleaned = (fullText || String(ev.text || '')).replace(/<@[A-Z0-9]+>/g, '').trim();
      if (ch && rootTs && cleaned) mgr.setFirstMessage(ch, rootTs, cleaned);
    } catch {}

    // Refresh GitHub App installation token before each run.
    // Installation tokens expire after 1 hour; this is a no-op if still fresh.
    try {
      const { refreshGitHubCredentials } = await import('../github-auth');
      await refreshGitHubCredentials();
    } catch {}

    logger.info('[SlackSocket] Dispatching engine run for Slack event');
    const trackChannel = String(ev.channel || '');
    const trackThreadTs = String(ev.thread_ts || ev.ts || ev.event_ts || '');
    const threadKey =
      trackChannel && trackThreadTs ? this.trackThread(trackChannel, trackThreadTs) : '';
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
      // Fetch user info for tracing (may already be cached from guest check)
      // Note: We intentionally exclude PII (email, real_name) from traces for privacy compliance
      const userInfo = await this.fetchUserInfo(userId);
      try {
        await withVisorRun(
          {
            ...getVisorRunAttributes(),
            'visor.run.source': 'slack',
            'slack.event.type': String(type || ''),
            'slack.channel_id': channelId,
            'slack.thread_ts': threadTs,
            'slack.user_id': userId,
            // Only include non-PII user info in traces (username is not PII, but email/real_name are)
            ...(userInfo?.name && { 'slack.user_name': userInfo.name }),
            ...(userInfo?.isGuest !== undefined && { 'slack.user_is_guest': userInfo.isGuest }),
          },
          {
            source: 'slack',
            userId,
            userName: userInfo?.name,
            workflowId: allChecks.join(','),
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
            const execFn = () =>
              runEngine.executeChecks({
                checks: allChecks,
                showDetails: true,
                outputFormat: 'json',
                config: cfgForRun,
                webhookContext: { webhookData: map, eventType: 'manual' },
                debug: process.env.VISOR_DEBUG === 'true',
              } as any);
            if (this.taskStore) {
              const { trackExecution } = await import('../agent-protocol/track-execution');
              await trackExecution(
                {
                  taskStore: this.taskStore,
                  source: 'slack',
                  workflowId: allChecks.join(','),
                  configPath: this.configPath,
                  messageText: buildSlackMessageText(ev, payloadForContext),
                  metadata: {
                    slack_channel: channelId,
                    slack_thread_ts: threadTs,
                    slack_user: userId,
                    slack_trigger_text: String(ev.text || '').slice(0, 500),
                  },
                },
                execFn
              );
            } else {
              await execFn();
            }
          }
        );
        // Force-flush telemetry to ensure visor.run span is exported promptly
        try {
          const { forceFlushTelemetry } = await import('../telemetry/opentelemetry');
          await forceFlushTelemetry();
        } catch {}
      } finally {
        if (this.limiter && rlReq) await this.limiter.release(rlReq);
      }
    } catch (e) {
      logger.error(
        `[SlackSocket] Engine execution failed: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      if (threadKey) this.untrackThread(threadKey);
    }
  }

  /**
   * Dispatch a matched message trigger as an asynchronous workflow execution.
   */
  private async dispatchMessageTrigger(match: MatchedTrigger, payload: any): Promise<void> {
    const { id, trigger } = match;
    const ev = payload.event || {};
    const channel = String(ev.channel || '');
    const ts = String(ev.ts || ev.event_ts || '');
    const threadTs = ev.thread_ts ? String(ev.thread_ts) : undefined;
    const user = String(ev.user || 'unknown');

    const replyTs = threadTs || ts;
    const threadKey = channel && replyTs ? this.trackThread(channel, replyTs) : '';

    logger.info(
      `[SlackSocket] Message trigger '${id}' matched → workflow="${trigger.workflow}" channel=${channel} ts=${ts}`
    );

    try {
      // Resolve workflow: "default" means run all checks (same as normal message flow)
      const allChecks = Object.keys(this.cfg.checks || {});
      const checksToRun = trigger.workflow === 'default' ? allChecks : [trigger.workflow];

      if (checksToRun.length === 0) {
        logger.error(`[SlackSocket] Message trigger '${id}': no checks configured`);
        return;
      }
      if (trigger.workflow !== 'default' && !allChecks.includes(trigger.workflow)) {
        logger.error(
          `[SlackSocket] Message trigger '${id}': workflow "${trigger.workflow}" not found in configuration`
        );
        return;
      }

      // Build conversation context
      let conversationContext: any = undefined;
      try {
        const isThreadReply = !!threadTs && threadTs !== ts;
        if (isThreadReply) {
          // Thread reply: fetch full thread history
          const adapter = this.getSlackAdapter();
          if (adapter && channel && threadTs) {
            const cleanedText = String(ev.text || '')
              .replace(/<@[A-Z0-9]+>/g, '')
              .trim();
            conversationContext = await adapter.fetchConversation(channel, threadTs, {
              ts,
              user,
              text: cleanedText || String(ev.text || ''),
              timestamp: Date.now(),
              files: Array.isArray(ev.files) ? ev.files : undefined,
            });
          }
        }
      } catch (err) {
        logger.warn(
          `[SlackSocket] Message trigger '${id}': conversation context fetch failed: ${err instanceof Error ? err.message : err}`
        );
      }

      // For root messages without thread context, build a minimal conversation
      // so that {{ conversation.current.text }} works in templates
      if (!conversationContext) {
        const cleanedText = String(ev.text || '')
          .replace(/<@[A-Z0-9]+>/g, '')
          .trim();
        conversationContext = {
          current: {
            user,
            text: cleanedText || String(ev.text || ''),
            timestamp: Date.now(),
            files: Array.isArray(ev.files) ? ev.files : undefined,
          },
          messages: [],
        };
      }

      // Attach active tasks context so the AI knows what's already in progress
      let activeTasks: any[] | undefined;
      try {
        if (this.taskStore) {
          const queryThreadTs = threadTs || ts;
          if (channel && queryThreadTs) {
            const { rows } = (this.taskStore as any).listTasksRaw?.({
              state: ['submitted', 'working'],
              metadata: { slack_channel: channel, slack_thread_ts: queryThreadTs },
              limit: 10,
            }) || { rows: [] };
            if (rows && rows.length > 0) {
              activeTasks = rows.map((r: any) => ({
                id: r.id,
                state: r.state,
                created_at: r.created_at,
                workflow_id: r.workflow_id,
                trigger_message:
                  r.metadata?.slack_trigger_text || (r.request_message || '').slice(0, 300),
              }));
            }
          }
        }
      } catch {}

      // Build synthetic webhook payload
      const triggerPayload = {
        ...payload,
        trigger: {
          id,
          type: 'on_message',
          workflow: trigger.workflow,
        },
        slack_conversation: conversationContext,
        ...(activeTasks ? { active_tasks: activeTasks } : {}),
      };

      const webhookData = new Map<string, unknown>();
      webhookData.set(this.endpoint, triggerPayload);
      // Inject task store so built-in tools (task_progress) can access it
      if (this.taskStore) {
        webhookData.set('__taskStore', this.taskStore);
      }

      // Clone config for this run with Slack frontend
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

      // Derive stable workspace name from thread identity
      const wsThreadTs = threadTs || ts;
      if (channel && wsThreadTs) {
        const hash = createHash('sha256')
          .update(`${channel}:${wsThreadTs}`)
          .digest('hex')
          .slice(0, 8);
        const workspaceName = `slack-trigger-${hash}`;
        if (!(cfgForRun as any).workspace) {
          (cfgForRun as any).workspace = {};
        }
        (cfgForRun as any).workspace.name = workspaceName;
        (cfgForRun as any).workspace.cleanup_on_exit = false;
      }

      // Create a dedicated engine instance for this trigger
      const runEngine = new StateMachineExecutionEngine();
      await this.ensureClient();
      try {
        const parentCtx: any = (this.engine as any).getExecutionContext?.() || {};
        const prevCtx: any = (runEngine as any).getExecutionContext?.() || {};
        (runEngine as any).setExecutionContext?.({
          ...parentCtx,
          ...prevCtx,
          slack: this.client || parentCtx.slack,
          slackClient: this.client || parentCtx.slackClient,
        });
      } catch {}

      // Refresh GitHub credentials
      try {
        const { refreshGitHubCredentials } = await import('../github-auth');
        await refreshGitHubCredentials();
      } catch {}

      await withActiveSpan(
        'visor.run',
        {
          ...getVisorRunAttributes(),
          'visor.run.source': 'slack_message_trigger',
          'visor.trigger.id': id,
          'visor.trigger.workflow': trigger.workflow,
          'slack.channel_id': channel,
          'slack.thread_ts': threadTs || ts,
          'slack.user_id': user,
        },
        async () => {
          const triggerExecFn = () =>
            runEngine.executeChecks({
              checks: checksToRun,
              showDetails: true,
              outputFormat: 'json',
              config: cfgForRun,
              webhookContext: { webhookData, eventType: 'slack_message' },
              debug: process.env.VISOR_DEBUG === 'true',
              inputs: trigger.inputs,
            } as any);
          if (this.taskStore) {
            const { trackExecution } = await import('../agent-protocol/track-execution');
            await trackExecution(
              {
                taskStore: this.taskStore,
                source: 'slack',
                workflowId: trigger.workflow || checksToRun.join(','),
                configPath: this.configPath,
                messageText: String(ev.text || `Trigger: ${id}`),
                metadata: {
                  slack_channel: channel,
                  slack_thread_ts: threadTs || ts,
                  slack_user: user,
                  slack_trigger_text: String(ev.text || '').slice(0, 500),
                  trigger_id: id,
                },
              },
              triggerExecFn
            );
          } else {
            await triggerExecFn();
          }
        }
      );

      // Force-flush telemetry to ensure visor.run span is exported promptly
      try {
        const { forceFlushTelemetry } = await import('../telemetry/opentelemetry');
        await forceFlushTelemetry();
      } catch {}

      logger.info(`[SlackSocket] Message trigger '${id}' workflow completed`);
    } finally {
      if (threadKey) this.untrackThread(threadKey);
    }
  }

  private trackThread(channel: string, threadTs: string): string {
    const key = `${channel}:${threadTs}`;
    this.activeThreads.add(key);
    return key;
  }

  private untrackThread(key: string): void {
    this.activeThreads.delete(key);
  }

  /**
   * Send a best-effort shutdown notice to all active Slack threads.
   * Bounded by timeoutMs so we never block process exit indefinitely.
   */
  async notifyActiveThreadsOfShutdown(timeoutMs = 5000): Promise<void> {
    if (this.activeThreads.size === 0 || !this.client) return;

    const msg =
      ':warning: The bot was restarted. Your request was interrupted and could not be completed. Please retry by sending your message again.';

    const promises = [...this.activeThreads].map(key => {
      const [channel, threadTs] = key.split(':');
      return this.client!.chat.postMessage({ channel, thread_ts: threadTs, text: msg }).catch(
        err => {
          logger.warn(
            `[SlackSocket] Failed to notify thread ${key} of shutdown: ${err instanceof Error ? err.message : err}`
          );
        }
      );
    });

    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(promises),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
    } catch {
      // best effort
    }
  }

  /**
   * Publish the App Home tab for the given user.
   * Shows the user's schedules, message triggers, and available workflows.
   */
  private async publishAppHome(userId: string): Promise<void> {
    if (!userId || !this.client) return;
    try {
      const userInfo = await this.fetchUserInfo(userId);

      // Fetch user's schedules and triggers from the store (best-effort)
      let schedules: Schedule[] = [];
      let triggers: MessageTrigger[] = [];
      try {
        const store = ScheduleStore.getInstance();
        if (store.isInitialized()) {
          schedules = await store.getByCreatorAsync(userId);
          triggers = await store.getTriggersByCreatorAsync(userId);
        }
      } catch (err) {
        logger.warn(
          `[SlackSocket] Failed to fetch schedules/triggers for Home tab: ${err instanceof Error ? err.message : err}`
        );
      }

      // Get available workflows
      let workflows: { id: string; name: string; description?: string }[] = [];
      try {
        const { WorkflowRegistry } = await import('../workflow-registry');
        const registry = WorkflowRegistry.getInstance();
        workflows = registry
          .list()
          .map(w => ({ id: w.id, name: w.name, description: w.description }));
      } catch (err) {
        logger.warn(
          `[SlackSocket] Failed to fetch workflows for Home tab: ${err instanceof Error ? err.message : err}`
        );
      }

      const blocks = this.buildHomeBlocks(userInfo, schedules, triggers, workflows);

      await this.client.views.publish({
        user_id: userId,
        view: { type: 'home', blocks },
      });
    } catch (err) {
      logger.error(
        `[SlackSocket] app_home_opened failed: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  /**
   * Build Slack Block Kit blocks for the App Home tab.
   * Exposed as a separate method for testability.
   */
  buildHomeBlocks(
    userInfo: { realName?: string; name?: string } | null,
    schedules: Schedule[],
    triggers: MessageTrigger[],
    workflows: { id: string; name: string; description?: string }[]
  ): unknown[] {
    const blocks: unknown[] = [];

    // Header
    const greeting = userInfo?.realName || userInfo?.name || 'there';
    blocks.push({
      type: 'header',
      text: { type: 'plain_text', text: `Hi, ${greeting}!` },
    });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: "Here's an overview of your Visor activity." },
    });
    blocks.push({ type: 'divider' });

    // --- Schedules section ---
    blocks.push({
      type: 'header',
      text: { type: 'plain_text', text: 'Your Schedules' },
    });

    const activeSchedules = schedules.filter(s => s.status === 'active' || s.status === 'paused');
    if (activeSchedules.length === 0) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '_No active schedules. Message the bot to create one._' },
      });
    } else {
      for (const s of activeSchedules.slice(0, 15)) {
        const statusIcon = s.status === 'paused' ? ':double_vertical_bar:' : ':clock1:';
        const desc = s.originalExpression || s.workflow || s.id;
        const nextRun = s.nextRunAt
          ? `<!date^${Math.floor(s.nextRunAt / 1000)}^{date_short_pretty} at {time}|${new Date(s.nextRunAt).toISOString()}>`
          : 'N/A';
        const recurring = s.isRecurring ? `\`${s.schedule}\`` : 'one-time';
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${statusIcon} *${desc}*\n${recurring} · Next: ${nextRun} · Status: \`${s.status}\``,
          },
        });
      }
      if (activeSchedules.length > 15) {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `_…and ${activeSchedules.length - 15} more_` }],
        });
      }
    }
    blocks.push({ type: 'divider' });

    // --- Triggers section ---
    blocks.push({
      type: 'header',
      text: { type: 'plain_text', text: 'Your Message Triggers' },
    });

    const activeTriggers = triggers.filter(t => t.status === 'active');
    if (activeTriggers.length === 0) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '_No active message triggers._' },
      });
    } else {
      for (const t of activeTriggers.slice(0, 10)) {
        const enabledIcon = t.enabled ? ':large_green_circle:' : ':white_circle:';
        const desc = t.description || t.workflow;
        const filters: string[] = [];
        if (t.channels?.length) filters.push(`channels: ${t.channels.join(', ')}`);
        if (t.contains?.length) filters.push(`contains: ${t.contains.join(', ')}`);
        if (t.matchPattern) filters.push(`pattern: \`${t.matchPattern}\``);
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${enabledIcon} *${desc}*\n${filters.join(' · ') || 'no filters'} → \`${t.workflow}\``,
          },
        });
      }
      if (activeTriggers.length > 10) {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `_…and ${activeTriggers.length - 10} more_` }],
        });
      }
    }
    blocks.push({ type: 'divider' });

    // --- Workflows section ---
    blocks.push({
      type: 'header',
      text: { type: 'plain_text', text: 'Available Workflows' },
    });

    if (workflows.length === 0) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '_No workflows registered._' },
      });
    } else {
      for (const w of workflows.slice(0, 15)) {
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${w.name || w.id}*${w.description ? `\n${w.description}` : ''}`,
          },
        });
      }
      if (workflows.length > 15) {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `_…and ${workflows.length - 15} more_` }],
        });
      }
    }

    return blocks;
  }

  /**
   * Stop listening for new messages. Closes the WebSocket and stops the scheduler,
   * but does NOT wait for in-flight work to complete. Frees the connection so
   * a new process can connect to Slack immediately.
   */
  async stopListening(): Promise<void> {
    this.draining = true;
    logger.info(
      `[SlackSocket] Stopping listener (${this.activeThreads.size} active thread(s) will continue)`
    );

    // Stop the scheduler — no new scheduled jobs
    if (this.genericScheduler) {
      try {
        await this.genericScheduler.stop();
      } catch {}
    }

    // Stop stale task sweep timer
    if (this.staleTaskTimer) {
      clearInterval(this.staleTaskTimer);
      this.staleTaskTimer = undefined;
    }

    // Close WebSocket so new process can connect to Slack
    this.closing = true;
    this.closeWebSocket();
  }

  /**
   * Enter drain mode: stop accepting new messages, wait for active threads to complete.
   * @param timeoutMs - Max wait time. 0 = unlimited (default).
   */
  async drain(timeoutMs = 0): Promise<void> {
    // If stopListening wasn't called yet, do it now
    if (!this.draining) {
      await this.stopListening();
    }

    logger.info(
      `[SlackSocket] Draining (${this.activeThreads.size} active thread(s), timeout=${timeoutMs || 'unlimited'})`
    );

    // Wait for all active threads to complete
    const startedAt = Date.now();
    while (this.activeThreads.size > 0) {
      if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
        logger.warn(
          `[SlackSocket] Drain timeout reached with ${this.activeThreads.size} active thread(s) remaining`
        );
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    logger.info('[SlackSocket] Drain complete');
  }

  /**
   * Stop the socket runner and clean up resources
   */
  async stop(): Promise<void> {
    // Stop stale task sweep timer
    if (this.staleTaskTimer) {
      clearInterval(this.staleTaskTimer);
      this.staleTaskTimer = undefined;
    }
    // Notify active threads before tearing down
    await this.notifyActiveThreadsOfShutdown();
    // Stop background GitHub App token refresh
    try {
      const { stopTokenRefreshTimer } = await import('../github-auth');
      stopTokenRefreshTimer();
    } catch {}

    // Stop the generic scheduler if active
    if (this.genericScheduler) {
      try {
        await this.genericScheduler.stop();
        logger.info('[SlackSocket] Generic scheduler stopped');
      } catch (e) {
        logger.warn(
          `[SlackSocket] Error stopping generic scheduler: ${e instanceof Error ? e.message : e}`
        );
      }
    }

    // Close WebSocket connection and stop heartbeat
    this.closing = true; // prevent reconnect on close
    this.closeWebSocket();
    logger.info('[SlackSocket] WebSocket closed');
  }

  /**
   * Get the scheduler instance
   */
  getScheduler(): Scheduler | undefined {
    return this.genericScheduler;
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
