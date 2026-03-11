import { logger } from '../logger';

/**
 * Rate limit configuration for HTTP requests.
 */
export interface RateLimitConfig {
  /** Shared bucket name; defaults to URL origin */
  key?: string;
  /** Max requests per window */
  requests: number;
  /** Time window unit */
  per: 'second' | 'minute' | 'hour';
  /** Max retries on 429 (default: 3) */
  max_retries?: number;
  /** Backoff strategy (default: exponential) */
  backoff?: 'fixed' | 'exponential';
  /** Base delay for backoff in ms (default: 1000) */
  initial_delay_ms?: number;
}

/**
 * Token bucket rate limiter with FIFO wait queue.
 */
export class TokenBucket {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per ms
  private lastRefill: number;
  private readonly waitQueue: Array<{ resolve: () => void }> = [];

  constructor(capacity: number, windowMs: number) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = capacity / windowMs;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = elapsed * this.refillRate;
    this.tokens = Math.min(this.capacity, this.tokens + newTokens);
    this.lastRefill = now;
  }

  /**
   * Non-blocking: try to consume one token.
   */
  tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Blocking: wait until a token is available, then consume it.
   * Requests are served FIFO.
   */
  async acquire(): Promise<void> {
    if (this.tryConsume()) {
      return;
    }

    // Calculate wait time for next token
    const waitMs = Math.ceil((1 - this.tokens) / this.refillRate);

    return new Promise<void>(resolve => {
      const entry = { resolve };
      this.waitQueue.push(entry);

      setTimeout(() => {
        // Remove from queue
        const idx = this.waitQueue.indexOf(entry);
        if (idx >= 0) {
          this.waitQueue.splice(idx, 1);
        }
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
        }
        resolve();
      }, waitMs);
    });
  }
}

function windowToMs(per: 'second' | 'minute' | 'hour'): number {
  switch (per) {
    case 'second':
      return 1000;
    case 'minute':
      return 60_000;
    case 'hour':
      return 3_600_000;
  }
}

const REGISTRY_KEY = Symbol.for('visor.rateLimiterRegistry');

/**
 * Global singleton registry of named token buckets.
 */
export class RateLimiterRegistry {
  private buckets = new Map<string, TokenBucket>();

  static getInstance(): RateLimiterRegistry {
    const g = globalThis as Record<symbol, unknown>;
    if (!g[REGISTRY_KEY]) {
      g[REGISTRY_KEY] = new RateLimiterRegistry();
    }
    return g[REGISTRY_KEY] as RateLimiterRegistry;
  }

  getOrCreate(key: string, config: RateLimitConfig): TokenBucket {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      const windowMs = windowToMs(config.per);
      bucket = new TokenBucket(config.requests, windowMs);
      this.buckets.set(key, bucket);
      logger.verbose(
        `[rate-limiter] Created bucket "${key}": ${config.requests} req/${config.per}`
      );
    }
    return bucket;
  }

  cleanup(): void {
    this.buckets.clear();
  }
}

/**
 * Resolve the rate limit key from config and optional fallback URL.
 */
export function resolveRateLimitKey(config: RateLimitConfig, fallbackUrl?: string): string {
  if (config.key) {
    return config.key;
  }
  if (fallbackUrl) {
    try {
      const url = new URL(fallbackUrl);
      return url.origin;
    } catch {
      // not a valid URL, use as-is
      return fallbackUrl;
    }
  }
  return '__default__';
}

/**
 * Rate-limited fetch wrapper.
 *
 * If rateLimitConfig is provided, acquires a token before making the request
 * and retries on 429 responses with backoff.
 *
 * If no config is provided, behaves exactly like native fetch().
 */
export async function rateLimitedFetch(
  url: string,
  options?: RequestInit,
  rateLimitConfig?: RateLimitConfig
): Promise<Response> {
  if (!rateLimitConfig) {
    return fetch(url, options);
  }

  const key = resolveRateLimitKey(rateLimitConfig, url);
  const registry = RateLimiterRegistry.getInstance();
  const bucket = registry.getOrCreate(key, rateLimitConfig);

  const maxRetries = rateLimitConfig.max_retries ?? 3;
  const backoff = rateLimitConfig.backoff ?? 'exponential';
  const initialDelay = rateLimitConfig.initial_delay_ms ?? 1000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Acquire a token (waits if bucket is empty)
    await bucket.acquire();

    const response = await fetch(url, options);

    if (response.status !== 429) {
      return response;
    }

    // 429 — rate limited by server
    if (attempt === maxRetries) {
      logger.warn(`[rate-limiter] Exhausted ${maxRetries} retries for ${url} (bucket: ${key})`);
      return response;
    }

    // Calculate delay: respect Retry-After header if present
    let delayMs: number;
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const parsed = Number(retryAfter);
      if (!isNaN(parsed)) {
        // Retry-After in seconds
        delayMs = parsed * 1000;
      } else {
        // Retry-After as HTTP date
        const date = new Date(retryAfter).getTime();
        delayMs = Math.max(0, date - Date.now());
      }
    } else {
      delayMs = backoff === 'exponential' ? initialDelay * Math.pow(2, attempt) : initialDelay;
    }

    logger.verbose(
      `[rate-limiter] 429 on ${url} (bucket: ${key}), retry ${attempt + 1}/${maxRetries} in ${delayMs}ms`
    );
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  // Should not reach here, but satisfy TypeScript
  return fetch(url, options);
}
