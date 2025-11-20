import { logger } from '../logger';

export type RateLimitDimension = 'bot' | 'user' | 'channel' | 'global';

export interface RateLimitDimensionConfig {
  requests_per_minute?: number;
  requests_per_hour?: number;
  concurrent_requests?: number;
}

export interface RateLimitActionsConfig {
  send_ephemeral_message?: boolean;
  ephemeral_message?: string;
  queue_when_near_limit?: boolean;
  queue_threshold?: number;
}

export interface RateLimitStorageConfig {
  type?: 'memory';
}

export interface RateLimitConfig {
  enabled?: boolean;
  bot?: RateLimitDimensionConfig;
  user?: RateLimitDimensionConfig;
  channel?: RateLimitDimensionConfig;
  global?: RateLimitDimensionConfig;
  actions?: RateLimitActionsConfig;
  storage?: RateLimitStorageConfig;
}

export interface RateLimitRequest {
  botId: string;
  userId: string;
  channelId: string;
  timestamp?: number;
}

interface WindowEntry { timestamp: number }
interface RateLimitState {
  windows: { minute: WindowEntry[]; hour: WindowEntry[] };
  concurrent: number;
}

export interface RateLimitResult {
  allowed: boolean;
  blocked_by?: RateLimitDimension;
  remaining?: number;
  limit?: number;
  reset?: number;
  retry_after?: number;
  should_queue?: boolean;
}

export class RateLimiter {
  private cfg: RateLimitConfig;
  private state = new Map<string, RateLimitState>();
  private cleanupInterval?: NodeJS.Timeout;

  constructor(config: RateLimitConfig) {
    this.cfg = {
      enabled: config.enabled ?? false,
      bot: config.bot,
      user: config.user,
      channel: config.channel,
      global: config.global,
      actions: {
        send_ephemeral_message: config.actions?.send_ephemeral_message ?? true,
        ephemeral_message:
          config.actions?.ephemeral_message ??
          "You've exceeded the rate limit. Please wait before trying again.",
        queue_when_near_limit: config.actions?.queue_when_near_limit ?? false,
        queue_threshold: config.actions?.queue_threshold ?? 0.8,
      },
      storage: { type: 'memory' },
    };
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  async check(req: RateLimitRequest): Promise<RateLimitResult> {
    if (!this.cfg.enabled) return { allowed: true };
    const now = req.timestamp ?? Date.now();
    const dims: Array<{ type: RateLimitDimension; key: string; conf?: RateLimitDimensionConfig }> = [
      { type: 'global', key: 'global', conf: this.cfg.global },
      { type: 'bot', key: `bot:${req.botId}`, conf: this.cfg.bot },
      { type: 'user', key: `user:${req.userId}`, conf: this.cfg.user },
      { type: 'channel', key: `channel:${req.channelId}`, conf: this.cfg.channel },
    ];
    let mostRemaining: number | undefined;
    let mostLimit: number | undefined;
    for (const d of dims) {
      if (!d.conf) continue;
      const r = await this.checkDim(d.key, d.conf, now);
      if (!r.allowed) {
        logger.debug(
          `Rate limited: dim=${d.type} limit=${r.limit} remaining=${r.remaining} reset=${r.reset}`
        );
        return { ...r, blocked_by: d.type };
      }
      if (r.remaining !== undefined) {
        if (mostRemaining === undefined || r.remaining < mostRemaining) {
          mostRemaining = r.remaining;
          mostLimit = r.limit;
        }
      }
      if (this.cfg.actions?.queue_when_near_limit && r.remaining !== undefined) {
        const threshold = this.cfg.actions.queue_threshold ?? 0.8;
        const limit = r.limit ?? 0;
        if (limit > 0 && r.remaining / limit < 1 - threshold)
          return { allowed: false, blocked_by: d.type, remaining: r.remaining, limit: r.limit, reset: r.reset, should_queue: true };
      }
    }
    for (const d of dims) if (d.conf) await this.incConcurrent(d.key);
    return { allowed: true, remaining: mostRemaining, limit: mostLimit };
  }

  async release(req: RateLimitRequest): Promise<void> {
    if (!this.cfg.enabled) return;
    for (const key of ['global', `bot:${req.botId}`, `user:${req.userId}`, `channel:${req.channelId}`])
      await this.decConcurrent(key);
  }

  private async checkDim(key: string, conf: RateLimitDimensionConfig, now: number): Promise<RateLimitResult> {
    const st = await this.getState(key);
    if (conf.concurrent_requests && st.concurrent >= conf.concurrent_requests)
      return { allowed: false, remaining: 0, limit: conf.concurrent_requests, retry_after: 5 };
    this.clean(st.windows.minute, now, 60 * 1000);
    this.clean(st.windows.hour, now, 60 * 60 * 1000);
    if (conf.requests_per_minute && st.windows.minute.length >= conf.requests_per_minute) {
      const oldest = st.windows.minute[0];
      const reset = Math.ceil((oldest.timestamp + 60 * 1000) / 1000);
      return { allowed: false, remaining: 0, limit: conf.requests_per_minute, reset, retry_after: Math.max(1, reset - Math.floor(now / 1000)) };
    }
    if (conf.requests_per_hour && st.windows.hour.length >= conf.requests_per_hour) {
      const oldest = st.windows.hour[0];
      const reset = Math.ceil((oldest.timestamp + 60 * 60 * 1000) / 1000);
      return { allowed: false, remaining: 0, limit: conf.requests_per_hour, reset, retry_after: Math.max(1, reset - Math.floor(now / 1000)) };
    }
    let remaining: number | undefined;
    let limit: number | undefined;
    if (conf.requests_per_minute) {
      remaining = conf.requests_per_minute - st.windows.minute.length - 1;
      limit = conf.requests_per_minute;
    }
    if (conf.requests_per_hour) {
      const hrRem = conf.requests_per_hour - st.windows.hour.length - 1;
      if (remaining === undefined || hrRem < remaining) {
        remaining = hrRem;
        limit = conf.requests_per_hour;
      }
    }
    st.windows.minute.push({ timestamp: now });
    st.windows.hour.push({ timestamp: now });
    await this.setState(key, st);
    return { allowed: true, remaining, limit };
  }

  private async incConcurrent(key: string) {
    const st = await this.getState(key);
    st.concurrent++;
    await this.setState(key, st);
  }
  private async decConcurrent(key: string) {
    const st = await this.getState(key);
    st.concurrent = Math.max(0, st.concurrent - 1);
    await this.setState(key, st);
  }
  private clean(win: WindowEntry[], now: number, size: number) {
    const cutoff = now - size;
    let i = 0;
    while (i < win.length && win[i].timestamp < cutoff) i++;
    if (i > 0) win.splice(0, i);
  }
  private async getState(key: string): Promise<RateLimitState> {
    let st = this.state.get(key);
    if (!st) {
      st = { windows: { minute: [], hour: [] }, concurrent: 0 };
      this.state.set(key, st);
    }
    return st;
  }
  private async setState(key: string, st: RateLimitState): Promise<void> {
    this.state.set(key, st);
  }
  private cleanup() {
    const now = Date.now();
    const cutoff = now - 2 * 60 * 60 * 1000;
    for (const [key, st] of this.state.entries()) {
      const hasRecent = st.windows.hour.some(e => e.timestamp > cutoff);
      if (!hasRecent && st.concurrent === 0) this.state.delete(key);
    }
  }
  async shutdown(): Promise<void> {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
  }
}

