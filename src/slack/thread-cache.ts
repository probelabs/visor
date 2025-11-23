import { logger } from '../logger';
import { NormalizedMessage } from '../types/bot';

export type EvictionReason = 'ttl_expired' | 'lru' | 'manual';

export interface CachedThread {
  messages: NormalizedMessage[];
  cachedAt: number;
  lastAccessedAt: number;
  lastUpdatedAt: number;
  accessCount: number;
  sizeBytes: number;
  metadata?: { channel: string; threadTs: string };
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

export class ThreadCache {
  private cache = new Map<string, CachedThread>();
  private maxThreads: number;
  private ttlSeconds: number;
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    size: 0,
    evictionsByReason: { ttl_expired: 0, lru: 0, manual: 0 },
    totalAccesses: 0,
    hitRate: 0,
    avgThreadSize: 0,
    totalBytes: 0,
  };

  constructor(maxThreads = 200, ttlSeconds = 600) {
    this.maxThreads = maxThreads;
    this.ttlSeconds = ttlSeconds;
    logger.debug(`Initialized ThreadCache max=${maxThreads} ttl=${ttlSeconds}s`);
  }

  get(threadId: string): CachedThread | null {
    const entry = this.cache.get(threadId);
    if (!entry) {
      this.recordMiss();
      return null;
    }
    const now = Date.now();
    const age = (now - entry.cachedAt) / 1000;
    if (age > this.ttlSeconds) {
      this.cache.delete(threadId);
      this.recordMiss();
      this.recordEviction('ttl_expired');
      this.updateCacheSize();
      return null;
    }
    entry.lastAccessedAt = now;
    entry.accessCount++;
    this.recordHit();
    return entry;
  }

  set(
    threadId: string,
    messages: NormalizedMessage[],
    metadata?: { channel: string; threadTs: string }
  ): void {
    const now = Date.now();
    const isUpdate = this.cache.has(threadId);
    if (!isUpdate && this.cache.size >= this.maxThreads) this.evictLRU();
    const sizeBytes = this.estimateSize(messages);
    const prev = this.cache.get(threadId);
    const entry: CachedThread = {
      messages,
      cachedAt: prev ? prev.cachedAt : now,
      lastAccessedAt: now,
      lastUpdatedAt: now,
      accessCount: prev ? prev.accessCount : 0,
      sizeBytes,
      metadata,
    };
    this.cache.set(threadId, entry);
    this.updateCacheSize();
  }

  has(threadId: string): boolean {
    const entry = this.cache.get(threadId);
    if (!entry) return false;
    const now = Date.now();
    const age = (now - entry.cachedAt) / 1000;
    if (age > this.ttlSeconds) {
      this.cache.delete(threadId);
      return false;
    }
    return true;
  }

  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    this.stats.evictionsByReason.manual += size;
    this.updateCacheSize();
  }

  evict(threadId: string): boolean {
    const existed = this.cache.delete(threadId);
    if (existed) {
      this.recordEviction('manual');
      this.updateCacheSize();
    }
    return existed;
  }

  getStats(): CacheStats {
    this.updateStats();
    return { ...this.stats };
  }

  getHitRate(): number {
    const total = this.stats.hits + this.stats.misses;
    return total === 0 ? 0 : (this.stats.hits / total) * 100;
  }

  cleanupExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, entry] of this.cache.entries()) {
      const age = (now - entry.cachedAt) / 1000;
      if (age > this.ttlSeconds) {
        this.cache.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      this.stats.evictionsByReason.ttl_expired += removed;
      this.updateCacheSize();
    }
    return removed;
  }

  private evictLRU(): void {
    let oldestId: string | null = null;
    let oldest = Infinity;
    for (const [id, entry] of this.cache.entries()) {
      if (entry.lastAccessedAt < oldest) {
        oldest = entry.lastAccessedAt;
        oldestId = id;
      }
    }
    if (oldestId) {
      this.cache.delete(oldestId);
      this.recordEviction('lru');
      this.updateCacheSize();
    }
  }

  private recordHit(): void {
    this.stats.hits++;
    this.stats.totalAccesses++;
  }
  private recordMiss(): void {
    this.stats.misses++;
    this.stats.totalAccesses++;
  }
  private recordEviction(reason: EvictionReason): void {
    this.stats.evictions++;
    this.stats.evictionsByReason[reason]++;
  }

  private updateStats(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? (this.stats.hits / total) * 100 : 0;
    this.stats.size = this.cache.size;
    let totalBytes = 0;
    for (const v of this.cache.values()) totalBytes += v.sizeBytes;
    this.stats.totalBytes = totalBytes;
    this.stats.avgThreadSize = this.cache.size > 0 ? totalBytes / this.cache.size : 0;
  }

  private updateCacheSize(): void {
    this.stats.size = this.cache.size;
    let totalBytes = 0;
    for (const v of this.cache.values()) totalBytes += v.sizeBytes;
    this.stats.totalBytes = totalBytes;
    this.stats.avgThreadSize = this.cache.size > 0 ? totalBytes / this.cache.size : 0;
  }

  private estimateSize(messages: NormalizedMessage[]): number {
    let size = 0;
    for (const m of messages) {
      size += (m.text?.length || 0) * 2;
      size += (m.role?.length || 0) * 2;
      size += (m.timestamp?.length || 0) * 2;
      size += (m.user?.length || 0) * 2;
      size += 64; // overhead
    }
    return size;
  }
}
