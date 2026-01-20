import { NormalizedMessage } from '../types/bot';
export type EvictionReason = 'ttl_expired' | 'lru' | 'manual';
export interface CachedThread {
    messages: NormalizedMessage[];
    cachedAt: number;
    lastAccessedAt: number;
    lastUpdatedAt: number;
    accessCount: number;
    sizeBytes: number;
    metadata?: {
        channel: string;
        threadTs: string;
    };
}
export interface CacheStats {
    hits: number;
    misses: number;
    evictions: number;
    size: number;
    evictionsByReason: Record<EvictionReason, number>;
    totalAccesses: number;
    hitRate: number;
    avgThreadSize: number;
    totalBytes: number;
}
export declare class ThreadCache {
    private cache;
    private maxThreads;
    private ttlSeconds;
    private stats;
    constructor(maxThreads?: number, ttlSeconds?: number);
    get(threadId: string): CachedThread | null;
    set(threadId: string, messages: NormalizedMessage[], metadata?: {
        channel: string;
        threadTs: string;
    }): void;
    has(threadId: string): boolean;
    clear(): void;
    evict(threadId: string): boolean;
    getStats(): CacheStats;
    getHitRate(): number;
    cleanupExpired(): number;
    private evictLRU;
    private recordHit;
    private recordMiss;
    private recordEviction;
    private updateStats;
    private updateCacheSize;
    private estimateSize;
}
//# sourceMappingURL=thread-cache.d.ts.map