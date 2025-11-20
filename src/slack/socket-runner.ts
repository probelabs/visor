import WebSocket from 'ws';
import { logger } from '../logger';
import type { VisorConfig } from '../types/config';
import { StateMachineExecutionEngine } from '../state-machine-execution-engine';
import { SlackClient } from './client';
import { SlackAdapter } from './adapter';
import { CachePrewarmer } from './cache-prewarmer';

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

  async start(): Promise<void> {
    // Optional cache prewarming
    try {
      const slackAny: any = (this.cfg as any).slack || {};
      const botToken = slackAny.bot_token || process.env.SLACK_BOT_TOKEN;
      if (botToken && slackAny.cache_prewarming?.enabled) {
        const client = new SlackClient(botToken);
        const adapter = new SlackAdapter(client, {
          id: 'default',
          endpoint: this.endpoint,
          signing_secret: '',
          bot_token: botToken,
          fetch: { scope: 'thread', max_messages: slackAny.fetch?.max_messages || 40, cache: slackAny.fetch?.cache },
        });
        const pre = new CachePrewarmer(client, adapter, slackAny.cache_prewarming || {});
        const res = await pre.prewarm();
        logger.info(`[SlackSocket] Prewarmed ${res.totalThreads} threads in ${res.durationMs}ms`);
      }
    } catch (e) {
      logger.warn(`[SlackSocket] Prewarm skipped: ${e instanceof Error ? e.message : e}`);
    }
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
    this.ws.on('open', () => logger.info('[SlackSocket] WebSocket connected'));
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
      logger.error(`[SlackSocket] Restart failed: ${e instanceof Error ? e.message : e}`);
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
      return;
    }
    if (env.type === 'hello') return;
    if (env.envelope_id) this.send({ envelope_id: env.envelope_id }); // ack ASAP
    if (env.type !== 'events_api' || !env.payload) return;
    const p = env.payload;
    const ev = p.event || {};
    const type = ev.type as string;

    // Gating: mentions
    if (this.mentions === 'direct' && type !== 'app_mention') return;
    // Gating: threads
    if (this.threads === 'required' && !ev.thread_ts) return;
    // channel allowlist
    if (!this.matchesAllowlist(ev.channel)) return;

    // Prepare webhookContext map for http_input provider reuse
    const map = new Map<string, unknown>();
    map.set(this.endpoint, env.payload);

    // Determine checks to run: run http_input checks bound to this endpoint plus dependents
    // For simplicity and to ensure dependents run, request all checks; config-driven assume/if will gate.
    const allChecks = Object.keys(this.cfg.checks || {});
    if (allChecks.length === 0) return;

    logger.info('[SlackSocket] Dispatching engine run for Slack event');
    try {
      await this.engine.executeChecks({
        checks: allChecks,
        showDetails: true,
        outputFormat: 'json',
        config: this.cfg,
        webhookContext: { webhookData: map, eventType: 'slack_event' },
        debug: process.env.VISOR_DEBUG === 'true',
      } as any);
    } catch (e) {
      logger.error(
        `[SlackSocket] Engine execution failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
}
