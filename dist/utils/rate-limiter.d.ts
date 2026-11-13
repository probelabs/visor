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
export declare class TokenBucket {
    private tokens;
    private readonly capacity;
    private readonly refillRate;
    private lastRefill;
    private readonly waitQueue;
    constructor(capacity: number, windowMs: number);
    private refill;
    /**
     * Non-blocking: try to consume one token.
     */
    tryConsume(): boolean;
    /**
     * Blocking: wait until a token is available, then consume it.
     * Requests are served FIFO.
     */
    acquire(): Promise<void>;
}
/**
 * Global singleton registry of named token buckets.
 */
export declare class RateLimiterRegistry {
    private buckets;
    static getInstance(): RateLimiterRegistry;
    getOrCreate(key: string, config: RateLimitConfig): TokenBucket;
    cleanup(): void;
}
/**
 * Resolve the rate limit key from config and optional fallback URL.
 */
export declare function resolveRateLimitKey(config: RateLimitConfig, fallbackUrl?: string): string;
/**
 * Rate-limited fetch wrapper.
 *
 * If rateLimitConfig is provided, acquires a token before making the request
 * and retries on 429 responses with backoff.
 *
 * If no config is provided, behaves exactly like native fetch().
 */
export declare function rateLimitedFetch(url: string, options?: RequestInit, rateLimitConfig?: RateLimitConfig): Promise<Response>;
//# sourceMappingURL=rate-limiter.d.ts.map