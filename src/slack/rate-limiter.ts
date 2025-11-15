/**
 * Rate limiting for Slack bot webhooks
 * Implements sliding window algorithm with multiple dimensions
 */

import { logger } from '../logger';

/**
 * Rate limit dimension types
 */
export type RateLimitDimension = 'bot' | 'user' | 'channel' | 'global';

/**
 * Rate limit configuration for a single dimension
 */
export interface RateLimitDimensionConfig {
  /** Maximum requests per minute (0 = unlimited) */
  requests_per_minute?: number;
  /** Maximum requests per hour (0 = unlimited) */
  requests_per_hour?: number;
  /** Maximum concurrent requests (0 = unlimited) */
  concurrent_requests?: number;
}

/**
 * Actions to take when rate limited
 */
export interface RateLimitActionsConfig {
  /** Send ephemeral message to user when rate limited (default: true) */
  send_ephemeral_message?: boolean;
  /** Ephemeral message text */
  ephemeral_message?: string;
  /** Queue requests when near limit threshold (default: false) */
  queue_when_near_limit?: boolean;
  /** Queue threshold as percentage (0.0-1.0, default: 0.8) */
  queue_threshold?: number;
}

/**
 * Rate limit storage backend type
 */
export type RateLimitStorageType = 'memory';

/**
 * Rate limit storage configuration
 */
export interface RateLimitStorageConfig {
  /** Storage type (default: 'memory') */
  type?: RateLimitStorageType;
}

/**
 * Complete rate limiting configuration
 */
export interface RateLimitConfig {
  /** Enable rate limiting (default: false) */
  enabled?: boolean;
  /** Per-bot limits */
  bot?: RateLimitDimensionConfig;
  /** Per-user limits */
  user?: RateLimitDimensionConfig;
  /** Per-channel limits */
  channel?: RateLimitDimensionConfig;
  /** Global limits (across all dimensions) */
  global?: RateLimitDimensionConfig;
  /** Actions when rate limited */
  actions?: RateLimitActionsConfig;
  /** Storage backend configuration */
  storage?: RateLimitStorageConfig;
}

/**
 * Rate limit check result
 */
export interface RateLimitResult {
  /** Whether request is allowed */
  allowed: boolean;
  /** Dimension that blocked the request (if blocked) */
  blocked_by?: RateLimitDimension;
  /** Remaining requests in this window */
  remaining?: number;
  /** Limit for this dimension */
  limit?: number;
  /** Reset time (Unix timestamp in seconds) */
  reset?: number;
  /** Retry after seconds (if blocked) */
  retry_after?: number;
  /** Whether request should be queued instead of rejected */
  should_queue?: boolean;
}

/**
 * Request metadata for rate limiting
 */
export interface RateLimitRequest {
  /** Bot ID */
  botId: string;
  /** User ID */
  userId: string;
  /** Channel ID */
  channelId: string;
  /** Timestamp of request */
  timestamp?: number;
}

/**
 * Sliding window entry
 */
interface WindowEntry {
  /** Request timestamp in milliseconds */
  timestamp: number;
}

/**
 * Rate limit state for a single key
 */
interface RateLimitState {
  /** Sliding window entries */
  windows: {
    minute: WindowEntry[];
    hour: WindowEntry[];
  };
  /** Current concurrent request count */
  concurrent: number;
}

/**
 * Rate limit metrics
 */
export interface RateLimitMetrics {
  /** Total requests checked */
  total_requests: number;
  /** Total requests allowed */
  allowed_requests: number;
  /** Total requests blocked */
  blocked_requests: number;
  /** Blocks by dimension */
  blocks_by_dimension: Record<RateLimitDimension, number>;
  /** Current state sizes */
  state_sizes: {
    bot: number;
    user: number;
    channel: number;
    global: number;
  };
}

/**
 * In-memory rate limiter implementation
 * Uses sliding window algorithm for accurate rate limiting
 */
export class RateLimiter {
  private config: RateLimitConfig;
  private state: Map<string, RateLimitState>;
  private metrics: RateLimitMetrics;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(config: RateLimitConfig) {
    this.config = {
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
      storage: {
        type: config.storage?.type ?? 'memory',
      },
    };

    this.state = new Map();
    this.metrics = {
      total_requests: 0,
      allowed_requests: 0,
      blocked_requests: 0,
      blocks_by_dimension: {
        bot: 0,
        user: 0,
        channel: 0,
        global: 0,
      },
      state_sizes: {
        bot: 0,
        user: 0,
        channel: 0,
        global: 0,
      },
    };

    // Start cleanup interval (every 60 seconds)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  /**
   * Check if a request should be rate limited
   */
  async check(request: RateLimitRequest): Promise<RateLimitResult> {
    if (!this.config.enabled) {
      return { allowed: true };
    }

    this.metrics.total_requests++;

    const now = request.timestamp ?? Date.now();

    // Check each dimension in order of priority
    const dimensions: Array<{
      type: RateLimitDimension;
      key: string;
      config?: RateLimitDimensionConfig;
    }> = [
      { type: 'global', key: 'global', config: this.config.global },
      { type: 'bot', key: `bot:${request.botId}`, config: this.config.bot },
      { type: 'user', key: `user:${request.userId}`, config: this.config.user },
      {
        type: 'channel',
        key: `channel:${request.channelId}`,
        config: this.config.channel,
      },
    ];

    // Track the most restrictive remaining across all dimensions
    let mostRestrictiveRemaining: number | undefined;
    let mostRestrictiveLimit: number | undefined;

    for (const dimension of dimensions) {
      if (!dimension.config) continue;

      const result = await this.checkDimension(dimension.key, dimension.config, now);

      if (!result.allowed) {
        this.metrics.blocked_requests++;
        this.metrics.blocks_by_dimension[dimension.type]++;

        logger.debug(
          `Request rate limited: dimension=${dimension.type}, key=${dimension.key}, limit=${result.limit}, remaining=${result.remaining}, reset=${result.reset}`
        );

        return {
          ...result,
          blocked_by: dimension.type,
        };
      }

      // Track most restrictive remaining
      if (result.remaining !== undefined) {
        if (mostRestrictiveRemaining === undefined || result.remaining < mostRestrictiveRemaining) {
          mostRestrictiveRemaining = result.remaining;
          mostRestrictiveLimit = result.limit;
        }
      }

      // Check if we should queue instead of allowing
      if (this.config.actions?.queue_when_near_limit && result.remaining !== undefined) {
        const threshold = this.config.actions.queue_threshold ?? 0.8;
        const limit = result.limit ?? 0;
        if (limit > 0 && result.remaining / limit < 1 - threshold) {
          return {
            allowed: false,
            blocked_by: dimension.type,
            remaining: result.remaining,
            limit: result.limit,
            reset: result.reset,
            should_queue: true,
          };
        }
      }
    }

    // All checks passed - increment concurrent counter
    for (const dimension of dimensions) {
      if (!dimension.config) continue;
      await this.incrementConcurrent(dimension.key);
    }

    this.metrics.allowed_requests++;
    return {
      allowed: true,
      remaining: mostRestrictiveRemaining,
      limit: mostRestrictiveLimit,
    };
  }

  /**
   * Release concurrent request slot
   */
  async release(request: RateLimitRequest): Promise<void> {
    if (!this.config.enabled) return;

    const dimensions = [
      { key: 'global', config: this.config.global },
      { key: `bot:${request.botId}`, config: this.config.bot },
      { key: `user:${request.userId}`, config: this.config.user },
      { key: `channel:${request.channelId}`, config: this.config.channel },
    ];

    for (const dimension of dimensions) {
      if (!dimension.config) continue;
      await this.decrementConcurrent(dimension.key);
    }
  }

  /**
   * Check a single dimension
   */
  private async checkDimension(
    key: string,
    config: RateLimitDimensionConfig,
    now: number
  ): Promise<RateLimitResult> {
    const state = await this.getState(key);

    // Check concurrent requests limit
    if (config.concurrent_requests && config.concurrent_requests > 0) {
      if (state.concurrent >= config.concurrent_requests) {
        return {
          allowed: false,
          remaining: 0,
          limit: config.concurrent_requests,
          retry_after: 5, // Retry after 5 seconds for concurrent limit
        };
      }
    }

    // Clean expired entries
    this.cleanWindow(state.windows.minute, now, 60 * 1000);
    this.cleanWindow(state.windows.hour, now, 60 * 60 * 1000);

    // Check per-minute limit
    if (config.requests_per_minute && config.requests_per_minute > 0) {
      if (state.windows.minute.length >= config.requests_per_minute) {
        const oldestEntry = state.windows.minute[0];
        const resetTime = Math.ceil((oldestEntry.timestamp + 60 * 1000) / 1000);
        const retryAfter = Math.max(1, resetTime - Math.floor(now / 1000));

        return {
          allowed: false,
          remaining: 0,
          limit: config.requests_per_minute,
          reset: resetTime,
          retry_after: retryAfter,
        };
      }
    }

    // Check per-hour limit
    if (config.requests_per_hour && config.requests_per_hour > 0) {
      if (state.windows.hour.length >= config.requests_per_hour) {
        const oldestEntry = state.windows.hour[0];
        const resetTime = Math.ceil((oldestEntry.timestamp + 60 * 60 * 1000) / 1000);
        const retryAfter = Math.max(1, resetTime - Math.floor(now / 1000));

        return {
          allowed: false,
          remaining: 0,
          limit: config.requests_per_hour,
          reset: resetTime,
          retry_after: retryAfter,
        };
      }
    }

    // Calculate remaining before adding entry (use most restrictive limit)
    let remaining: number | undefined;
    let limit: number | undefined;

    if (config.requests_per_minute && config.requests_per_minute > 0) {
      remaining = config.requests_per_minute - state.windows.minute.length - 1;
      limit = config.requests_per_minute;
    }

    if (config.requests_per_hour && config.requests_per_hour > 0) {
      const hourRemaining = config.requests_per_hour - state.windows.hour.length - 1;
      if (remaining === undefined || hourRemaining < remaining) {
        remaining = hourRemaining;
        limit = config.requests_per_hour;
      }
    }

    // Add entry to windows
    state.windows.minute.push({ timestamp: now });
    state.windows.hour.push({ timestamp: now });

    await this.setState(key, state);

    return {
      allowed: true,
      remaining,
      limit,
    };
  }

  /**
   * Get state for a key
   */
  private async getState(key: string): Promise<RateLimitState> {
    let state = this.state.get(key);
    if (!state) {
      state = {
        windows: {
          minute: [],
          hour: [],
        },
        concurrent: 0,
      };
      this.state.set(key, state);
    }
    return state;
  }

  /**
   * Set state for a key
   */
  private async setState(key: string, state: RateLimitState): Promise<void> {
    this.state.set(key, state);
  }

  /**
   * Increment concurrent counter
   */
  private async incrementConcurrent(key: string): Promise<void> {
    const state = await this.getState(key);
    state.concurrent++;
    await this.setState(key, state);
  }

  /**
   * Decrement concurrent counter
   */
  private async decrementConcurrent(key: string): Promise<void> {
    const state = await this.getState(key);
    state.concurrent = Math.max(0, state.concurrent - 1);
    await this.setState(key, state);
  }

  /**
   * Clean expired entries from a window
   */
  private cleanWindow(window: WindowEntry[], now: number, windowSize: number): void {
    const cutoff = now - windowSize;
    let i = 0;
    while (i < window.length && window[i].timestamp < cutoff) {
      i++;
    }
    if (i > 0) {
      window.splice(0, i);
    }
  }

  /**
   * Clean up old state entries
   */
  private cleanup(): void {
    const now = Date.now();
    const cutoff = now - 2 * 60 * 60 * 1000; // 2 hours

    for (const [key, state] of this.state.entries()) {
      // Remove if no entries in last 2 hours
      const hasRecentEntries =
        state.windows.hour.length > 0 && state.windows.hour.some(entry => entry.timestamp > cutoff);

      if (!hasRecentEntries && state.concurrent === 0) {
        this.state.delete(key);
      }
    }

    // Update metrics
    this.updateMetrics();
  }

  /**
   * Update metrics
   */
  private updateMetrics(): void {
    const stateSizes: Record<RateLimitDimension, number> = {
      bot: 0,
      user: 0,
      channel: 0,
      global: 0,
    };

    for (const key of this.state.keys()) {
      if (key === 'global') {
        stateSizes.global++;
      } else if (key.startsWith('bot:')) {
        stateSizes.bot++;
      } else if (key.startsWith('user:')) {
        stateSizes.user++;
      } else if (key.startsWith('channel:')) {
        stateSizes.channel++;
      }
    }

    this.metrics.state_sizes = stateSizes;
  }

  /**
   * Get current metrics
   */
  getMetrics(): RateLimitMetrics {
    this.updateMetrics();
    return { ...this.metrics };
  }

  /**
   * Reset metrics
   */
  resetMetrics(): void {
    this.metrics = {
      total_requests: 0,
      allowed_requests: 0,
      blocked_requests: 0,
      blocks_by_dimension: {
        bot: 0,
        user: 0,
        channel: 0,
        global: 0,
      },
      state_sizes: this.metrics.state_sizes,
    };
  }

  /**
   * Get ephemeral message configuration
   */
  getEphemeralMessageConfig(): {
    enabled: boolean;
    message: string;
  } {
    return {
      enabled: this.config.actions?.send_ephemeral_message ?? true,
      message:
        this.config.actions?.ephemeral_message ??
        "You've exceeded the rate limit. Please wait before trying again.",
    };
  }

  /**
   * Shutdown the rate limiter
   */
  async shutdown(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
  }
}
