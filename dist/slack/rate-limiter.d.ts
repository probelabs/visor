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
export interface RateLimitResult {
    allowed: boolean;
    blocked_by?: RateLimitDimension;
    remaining?: number;
    limit?: number;
    reset?: number;
    retry_after?: number;
    should_queue?: boolean;
}
export declare class RateLimiter {
    private cfg;
    private state;
    private cleanupInterval?;
    constructor(config: RateLimitConfig);
    check(req: RateLimitRequest): Promise<RateLimitResult>;
    release(req: RateLimitRequest): Promise<void>;
    private checkDim;
    private incConcurrent;
    private decConcurrent;
    private clean;
    private getState;
    private setState;
    private cleanup;
    shutdown(): Promise<void>;
}
//# sourceMappingURL=rate-limiter.d.ts.map