import { SlackClient } from './client';
import { SlackAdapter } from './adapter';
import { SlackCachePrewarmingConfig } from '../types/bot';
import { logger } from '../logger';

export interface PrewarmingResult {
  totalThreads: number;
  durationMs: number;
  channels: Array<{ channel: string; threadsPrewarmed: number; errors: string[] }>;
  users: Array<{ user: string; threadsPrewarmed: number; errors: string[] }>;
  errors: string[];
}

export class CachePrewarmer {
  private client: SlackClient;
  private adapter: SlackAdapter;
  private cfg: Required<SlackCachePrewarmingConfig>;
  constructor(client: SlackClient, adapter: SlackAdapter, config: SlackCachePrewarmingConfig) {
    this.client = client;
    this.adapter = adapter;
    this.cfg = {
      enabled: config.enabled ?? false,
      channels: config.channels ?? [],
      users: config.users ?? [],
      max_threads_per_channel: config.max_threads_per_channel ?? 20,
      concurrency: config.concurrency ?? 5,
      rate_limit_ms: config.rate_limit_ms ?? 100,
    };
  }
  async prewarm(): Promise<PrewarmingResult> {
    if (!this.cfg.enabled) return { totalThreads: 0, durationMs: 0, channels: [], users: [], errors: [] };
    const start = Date.now();
    const out: PrewarmingResult = { totalThreads: 0, durationMs: 0, channels: [], users: [], errors: [] };
    try {
      if (this.cfg.channels.length) out.channels = await this.prewarmChannels();
      if (this.cfg.users.length) out.users = await this.prewarmUsers();
      out.totalThreads = out.channels.reduce((a, r) => a + r.threadsPrewarmed, 0) + out.users.reduce((a, r) => a + r.threadsPrewarmed, 0);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`[CachePrewarmer] failed: ${msg}`);
      out.errors.push(msg);
    }
    out.durationMs = Date.now() - start;
    return out;
  }
  private async prewarmChannels() {
    const res: Array<{ channel: string; threadsPrewarmed: number; errors: string[] }> = [];
    const chans = [...this.cfg.channels];
    while (chans.length) {
      const batch = chans.splice(0, this.cfg.concurrency);
      const br = await Promise.all(batch.map(c => this.prewarmChannel(c)));
      res.push(...br);
    }
    return res;
  }
  private async prewarmUsers() {
    const res: Array<{ user: string; threadsPrewarmed: number; errors: string[] }> = [];
    const users = [...this.cfg.users];
    while (users.length) {
      const batch = users.splice(0, this.cfg.concurrency);
      const br = await Promise.all(batch.map(u => this.prewarmUser(u)));
      res.push(...br);
    }
    return res;
  }
  private async prewarmChannel(channel: string) {
    const r = { channel, threadsPrewarmed: 0, errors: [] as string[] };
    try {
      const resp: any = await this.client.getWebClient().conversations.history({ channel, limit: this.cfg.max_threads_per_channel });
      const msgs = (resp && resp.messages) || [];
      const threaded = msgs.filter((m: any) => m.thread_ts && m.thread_ts === m.ts);
      for (const m of threaded) {
        if (r.threadsPrewarmed > 0) await this.sleep(this.cfg.rate_limit_ms);
        await this.adapter.fetchConversation(channel, String(m.thread_ts), { ts: String(m.ts), user: String(m.user || 'unknown'), text: String(m.text || ''), timestamp: Date.now() });
        r.threadsPrewarmed++;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      r.errors.push(msg);
    }
    return r;
  }
  private async prewarmUser(user: string) {
    const r = { user, threadsPrewarmed: 0, errors: [] as string[] };
    try {
      const open: any = await this.client.getWebClient().conversations.open({ users: user });
      if (!open || !open.ok || !open.channel?.id) return r;
      const channel = String(open.channel.id);
      const resp: any = await this.client.getWebClient().conversations.history({ channel, limit: this.cfg.max_threads_per_channel });
      const msgs = (resp && resp.messages) || [];
      const threaded = msgs.filter((m: any) => m.thread_ts && m.thread_ts === m.ts);
      for (const m of threaded) {
        if (r.threadsPrewarmed > 0) await this.sleep(this.cfg.rate_limit_ms);
        await this.adapter.fetchConversation(channel, String(m.thread_ts), { ts: String(m.ts), user: String(m.user || user), text: String(m.text || ''), timestamp: Date.now() });
        r.threadsPrewarmed++;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      r.errors.push(msg);
    }
    return r;
  }
  private sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }
}

