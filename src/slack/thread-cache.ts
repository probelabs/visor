import { logger } from '../logger';
import { NormalizedMessage } from '../types/bot';

/**
 * Eviction reason tracking
 */
export type EvictionReason = 'ttl_expired' | 'lru' | 'manual';

/**
 * Cached thread data structure
 */
export interface CachedThread {
  /** Thread messages */
  messages: NormalizedMessage[];
  /** Timestamp when cached */
  cachedAt: number;
  /** Last access timestamp for LRU eviction */
  lastAccessedAt: number;
  /** Last update timestamp */
  lastUpdatedAt: number;
  /** Number of times accessed */
  accessCount: number;
  /** Estimated byte size */
  sizeBytes: number;
  /** Thread metadata */
  metadata?: {
    channel: string;
    threadTs: string;
  };
}

/**
 * Cache statistics for monitoring
 */
export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  /** Evictions by reason */
  evictionsByReason: Record<EvictionReason, number>;
  /** Total accesses (hits + misses) */
  totalAccesses: number;
  /** Hit rate percentage */
  hitRate: number;
  /** Average thread size in bytes */
  avgThreadSize: number;
  /** Total cache size in bytes */
  totalBytes: number;
}

/**
 * Thread metadata for observability
 */
export interface ThreadMetadata {
  threadId: string;
  messageCount: number;
  sizeBytes: number;
  createdAt: string;
  lastAccessedAt: string;
  lastUpdatedAt: string;
  accessCount: number;
  ageSeconds: number;
  channel?: string;
  threadTs?: string;
}

/**
 * Time window statistics for monitoring
 */
export interface TimeWindowStats {
  /** Window duration in seconds */
  windowSeconds: number;
  /** Hit count in this window */
  hits: number;
  /** Miss count in this window */
  misses: number;
  /** Hit rate in this window */
  hitRate: number;
  /** Window start timestamp */
  startTime: number;
}

/**
 * LRU (Least Recently Used) cache for Slack thread history
 *
 * This cache uses a Map to store thread data with LRU eviction policy.
 * When the cache is full and a new item needs to be added, the least
 * recently accessed item is removed.
 *
 * Features:
 * - Configurable max_threads (default: 200)
 * - Configurable TTL in seconds (default: 600 = 10 minutes)
 * - Thread-safe operations using synchronous code
 * - Cache hit/miss metrics for debugging
 * - Automatic eviction of expired entries
 */
export class ThreadCache {
  private cache: Map<string, CachedThread>;
  private maxThreads: number;
  private ttlSeconds: number;
  private stats: CacheStats;
  private timeWindows: Map<number, TimeWindowStats>; // window size -> stats
  private windowStartTimes: Map<number, number>; // window size -> start time

  /**
   * Create a new thread cache
   * @param maxThreads Maximum number of threads to cache (default: 200)
   * @param ttlSeconds TTL in seconds for cached entries (default: 600)
   */
  constructor(maxThreads: number = 200, ttlSeconds: number = 600) {
    this.cache = new Map();
    this.maxThreads = maxThreads;
    this.ttlSeconds = ttlSeconds;
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      size: 0,
      evictionsByReason: {
        ttl_expired: 0,
        lru: 0,
        manual: 0,
      },
      totalAccesses: 0,
      hitRate: 0,
      avgThreadSize: 0,
      totalBytes: 0,
    };

    // Initialize time windows (1min, 5min, 15min)
    this.timeWindows = new Map();
    this.windowStartTimes = new Map();
    const now = Date.now();
    for (const windowSize of [60, 300, 900]) {
      this.timeWindows.set(windowSize, {
        windowSeconds: windowSize,
        hits: 0,
        misses: 0,
        hitRate: 0,
        startTime: now,
      });
      this.windowStartTimes.set(windowSize, now);
    }

    logger.debug(`Initialized ThreadCache with maxThreads=${maxThreads}, ttlSeconds=${ttlSeconds}`);
  }

  /**
   * Get thread data from cache
   * @param threadId Thread identifier (e.g., "C123:1700.55")
   * @returns Cached thread data or null if not found or expired
   */
  get(threadId: string): CachedThread | null {
    const entry = this.cache.get(threadId);

    if (!entry) {
      this.recordMiss();
      logger.debug(`Cache miss for thread ${threadId}`);
      return null;
    }

    // Check if entry has expired
    const now = Date.now();
    const age = (now - entry.cachedAt) / 1000; // age in seconds

    if (age > this.ttlSeconds) {
      // Entry expired, remove it
      this.cache.delete(threadId);
      this.recordMiss();
      this.recordEviction('ttl_expired');
      this.updateCacheSize();
      logger.debug(`Cache miss for thread ${threadId} (expired after ${age}s)`);
      return null;
    }

    // Update last accessed timestamp and access count for LRU
    entry.lastAccessedAt = now;
    entry.accessCount++;
    this.recordHit();

    logger.debug(`Cache hit for thread ${threadId} (age: ${age}s, accesses: ${entry.accessCount})`);
    return entry;
  }

  /**
   * Store thread data in cache
   * @param threadId Thread identifier
   * @param messages Thread messages
   * @param metadata Optional thread metadata
   */
  set(
    threadId: string,
    messages: NormalizedMessage[],
    metadata?: { channel: string; threadTs: string }
  ): void {
    const now = Date.now();
    const isUpdate = this.cache.has(threadId);

    // If cache is at capacity and this is a new entry, evict LRU entry
    if (!isUpdate && this.cache.size >= this.maxThreads) {
      this.evictLRU();
    }

    // Calculate estimated byte size
    const sizeBytes = this.estimateSize(messages);

    const entry: CachedThread = {
      messages,
      cachedAt: isUpdate ? this.cache.get(threadId)!.cachedAt : now,
      lastAccessedAt: now,
      lastUpdatedAt: now,
      accessCount: isUpdate ? this.cache.get(threadId)!.accessCount : 0,
      sizeBytes,
      metadata,
    };

    this.cache.set(threadId, entry);
    this.updateCacheSize();

    logger.debug(
      `${isUpdate ? 'Updated' : 'Cached'} thread ${threadId} with ${messages.length} messages (${sizeBytes} bytes, cache size: ${this.cache.size}/${this.maxThreads})`
    );
  }

  /**
   * Check if thread exists in cache (without updating access time)
   * @param threadId Thread identifier
   * @returns true if thread exists and not expired
   */
  has(threadId: string): boolean {
    const entry = this.cache.get(threadId);

    if (!entry) {
      return false;
    }

    // Check if expired
    const now = Date.now();
    const age = (now - entry.cachedAt) / 1000;

    if (age > this.ttlSeconds) {
      this.cache.delete(threadId);
      return false;
    }

    return true;
  }

  /**
   * Clear all cached entries
   */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    this.stats.evictionsByReason.manual += size;
    this.updateCacheSize();

    logger.debug(`Cleared cache (removed ${size} entries)`);
  }

  /**
   * Evict a specific thread from cache
   * @param threadId Thread identifier
   * @returns true if thread was evicted, false if not found
   */
  evict(threadId: string): boolean {
    const existed = this.cache.delete(threadId);
    if (existed) {
      this.recordEviction('manual');
      this.updateCacheSize();

      logger.debug(`Manually evicted thread ${threadId}`);
    }
    return existed;
  }

  /**
   * Get cache statistics
   * @returns Cache statistics object
   */
  getStats(): CacheStats {
    this.updateStats();
    return { ...this.stats };
  }

  /**
   * Reset cache statistics (but preserve evictions by reason)
   */
  resetStats(): void {
    const evictionsByReason = { ...this.stats.evictionsByReason };
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      size: this.cache.size,
      evictionsByReason,
      totalAccesses: 0,
      hitRate: 0,
      avgThreadSize: 0,
      totalBytes: 0,
    };
    this.updateStats();
    logger.debug('Reset cache statistics');
  }

  /**
   * Get cache hit rate
   * @returns Hit rate as a percentage (0-100)
   */
  getHitRate(): number {
    const total = this.stats.hits + this.stats.misses;
    if (total === 0) return 0;
    return (this.stats.hits / total) * 100;
  }

  /**
   * Remove expired entries from cache
   * @returns Number of entries removed
   */
  cleanupExpired(): number {
    const now = Date.now();
    let removed = 0;

    for (const [threadId, entry] of this.cache.entries()) {
      const age = (now - entry.cachedAt) / 1000;
      if (age > this.ttlSeconds) {
        this.cache.delete(threadId);
        removed++;
      }
    }

    if (removed > 0) {
      this.stats.evictionsByReason.ttl_expired += removed;
      this.updateCacheSize();
      logger.debug(`Cleaned up ${removed} expired entries from cache`);
    }

    return removed;
  }

  /**
   * Evict the least recently used entry
   */
  private evictLRU(): void {
    let oldestThreadId: string | null = null;
    let oldestAccessTime = Infinity;

    // Find the least recently accessed entry
    for (const [threadId, entry] of this.cache.entries()) {
      if (entry.lastAccessedAt < oldestAccessTime) {
        oldestAccessTime = entry.lastAccessedAt;
        oldestThreadId = threadId;
      }
    }

    if (oldestThreadId) {
      this.cache.delete(oldestThreadId);
      this.recordEviction('lru');
      logger.debug(
        `Evicted LRU thread ${oldestThreadId} (last accessed: ${new Date(oldestAccessTime).toISOString()})`
      );
    }
  }

  /**
   * Get current cache size
   * @returns Number of entries in cache
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Get cache capacity
   * @returns Maximum number of threads that can be cached
   */
  capacity(): number {
    return this.maxThreads;
  }

  /**
   * Get TTL in seconds
   * @returns TTL in seconds
   */
  getTTL(): number {
    return this.ttlSeconds;
  }

  /**
   * Get all cached thread metadata
   * @returns Array of thread metadata objects
   */
  getAllThreads(): ThreadMetadata[] {
    const now = Date.now();
    const threads: ThreadMetadata[] = [];

    for (const [threadId, entry] of this.cache.entries()) {
      const ageSeconds = (now - entry.cachedAt) / 1000;
      threads.push({
        threadId,
        messageCount: entry.messages.length,
        sizeBytes: entry.sizeBytes,
        createdAt: new Date(entry.cachedAt).toISOString(),
        lastAccessedAt: new Date(entry.lastAccessedAt).toISOString(),
        lastUpdatedAt: new Date(entry.lastUpdatedAt).toISOString(),
        accessCount: entry.accessCount,
        ageSeconds: Math.round(ageSeconds),
        channel: entry.metadata?.channel,
        threadTs: entry.metadata?.threadTs,
      });
    }

    return threads;
  }

  /**
   * Get thread metadata by ID
   * @param threadId Thread identifier
   * @returns Thread metadata or null if not found
   */
  getThread(threadId: string): ThreadMetadata | null {
    const entry = this.cache.get(threadId);
    if (!entry) {
      return null;
    }

    const now = Date.now();
    const ageSeconds = (now - entry.cachedAt) / 1000;

    return {
      threadId,
      messageCount: entry.messages.length,
      sizeBytes: entry.sizeBytes,
      createdAt: new Date(entry.cachedAt).toISOString(),
      lastAccessedAt: new Date(entry.lastAccessedAt).toISOString(),
      lastUpdatedAt: new Date(entry.lastUpdatedAt).toISOString(),
      accessCount: entry.accessCount,
      ageSeconds: Math.round(ageSeconds),
      channel: entry.metadata?.channel,
      threadTs: entry.metadata?.threadTs,
    };
  }

  /**
   * Get time window statistics
   * @param windowSeconds Window size in seconds (60, 300, or 900)
   * @returns Time window statistics or null if window not found
   */
  getTimeWindowStats(windowSeconds: number): TimeWindowStats | null {
    this.resetExpiredWindows();
    const stats = this.timeWindows.get(windowSeconds);
    return stats ? { ...stats } : null;
  }

  /**
   * Get all time window statistics
   * @returns Map of window size to statistics
   */
  getAllTimeWindowStats(): Map<number, TimeWindowStats> {
    this.resetExpiredWindows();
    const result = new Map<number, TimeWindowStats>();
    for (const [windowSize, stats] of this.timeWindows.entries()) {
      result.set(windowSize, { ...stats });
    }
    return result;
  }

  /**
   * Get cache efficiency score (0-100)
   * Based on hit rate, utilization, and eviction rate
   */
  getCacheEfficiency(): number {
    const hitRate = this.getHitRate();
    const utilization = (this.cache.size / this.maxThreads) * 100;
    const totalEvictions = Object.values(this.stats.evictionsByReason).reduce((a, b) => a + b, 0);
    const evictionRate =
      this.stats.totalAccesses > 0 ? (totalEvictions / this.stats.totalAccesses) * 100 : 0;

    // Efficiency formula: weighted average
    // - Hit rate (50%): higher is better
    // - Utilization (30%): sweet spot around 70-80%
    // - Eviction rate (20%): lower is better
    const hitScore = hitRate;
    const utilizationScore = utilization < 70 ? utilization : 100 - Math.abs(utilization - 75);
    const evictionScore = Math.max(0, 100 - evictionRate * 10);

    return Math.round(hitScore * 0.5 + utilizationScore * 0.3 + evictionScore * 0.2);
  }

  /**
   * Get most active threads (by access count)
   * @param limit Maximum number of threads to return (default: 10)
   * @returns Array of thread metadata sorted by access count
   */
  getMostActiveThreads(limit: number = 10): ThreadMetadata[] {
    const threads = this.getAllThreads();
    threads.sort((a, b) => b.accessCount - a.accessCount);
    return threads.slice(0, limit);
  }

  /**
   * Get least recently used threads
   * @param limit Maximum number of threads to return (default: 10)
   * @returns Array of thread metadata sorted by last access time
   */
  getLeastRecentlyUsed(limit: number = 10): ThreadMetadata[] {
    const threads = this.getAllThreads();
    threads.sort(
      (a, b) => new Date(a.lastAccessedAt).getTime() - new Date(b.lastAccessedAt).getTime()
    );
    return threads.slice(0, limit);
  }

  /**
   * Export cache state for debugging/monitoring
   * @returns Complete cache state as JSON-serializable object
   */
  exportState(): {
    stats: CacheStats;
    threads: ThreadMetadata[];
    timeWindows: Record<number, TimeWindowStats>;
    config: {
      maxThreads: number;
      ttlSeconds: number;
    };
  } {
    this.updateStats();
    const timeWindowsObj: Record<number, TimeWindowStats> = {};
    for (const [windowSize, stats] of this.getAllTimeWindowStats().entries()) {
      timeWindowsObj[windowSize] = stats;
    }

    return {
      stats: this.getStats(),
      threads: this.getAllThreads(),
      timeWindows: timeWindowsObj,
      config: {
        maxThreads: this.maxThreads,
        ttlSeconds: this.ttlSeconds,
      },
    };
  }

  /**
   * Record a cache hit and update time windows
   */
  private recordHit(): void {
    this.stats.hits++;
    this.stats.totalAccesses++;
    this.updateTimeWindows('hit');
  }

  /**
   * Record a cache miss and update time windows
   */
  private recordMiss(): void {
    this.stats.misses++;
    this.stats.totalAccesses++;
    this.updateTimeWindows('miss');
  }

  /**
   * Record an eviction
   */
  private recordEviction(reason: EvictionReason): void {
    this.stats.evictions++;
    this.stats.evictionsByReason[reason]++;
  }

  /**
   * Update aggregate cache statistics
   */
  private updateStats(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? (this.stats.hits / total) * 100 : 0;
    this.stats.size = this.cache.size;

    // Calculate total bytes and average thread size
    let totalBytes = 0;
    for (const entry of this.cache.values()) {
      totalBytes += entry.sizeBytes;
    }
    this.stats.totalBytes = totalBytes;
    this.stats.avgThreadSize = this.cache.size > 0 ? totalBytes / this.cache.size : 0;
  }

  /**
   * Update cache size metrics
   */
  private updateCacheSize(): void {
    this.stats.size = this.cache.size;
    let totalBytes = 0;
    for (const entry of this.cache.values()) {
      totalBytes += entry.sizeBytes;
    }
    this.stats.totalBytes = totalBytes;
    this.stats.avgThreadSize = this.cache.size > 0 ? totalBytes / this.cache.size : 0;
  }

  /**
   * Update time window statistics
   */
  private updateTimeWindows(type: 'hit' | 'miss'): void {
    const now = Date.now();

    for (const [windowSize, stats] of this.timeWindows.entries()) {
      const windowStartTime = this.windowStartTimes.get(windowSize) || now;
      const windowAge = (now - windowStartTime) / 1000;

      // Reset window if expired
      if (windowAge > windowSize) {
        this.resetWindow(windowSize);
      }

      // Update stats
      if (type === 'hit') {
        stats.hits++;
      } else {
        stats.misses++;
      }

      const total = stats.hits + stats.misses;
      stats.hitRate = total > 0 ? (stats.hits / total) * 100 : 0;
    }
  }

  /**
   * Reset a specific time window
   */
  private resetWindow(windowSize: number): void {
    const now = Date.now();
    this.timeWindows.set(windowSize, {
      windowSeconds: windowSize,
      hits: 0,
      misses: 0,
      hitRate: 0,
      startTime: now,
    });
    this.windowStartTimes.set(windowSize, now);
  }

  /**
   * Reset expired time windows
   */
  private resetExpiredWindows(): void {
    const now = Date.now();

    for (const [windowSize] of this.timeWindows.entries()) {
      const windowStartTime = this.windowStartTimes.get(windowSize) || now;
      const windowAge = (now - windowStartTime) / 1000;

      if (windowAge > windowSize) {
        this.resetWindow(windowSize);
      }
    }
  }

  /**
   * Estimate size of messages in bytes
   */
  private estimateSize(messages: NormalizedMessage[]): number {
    let size = 0;
    for (const msg of messages) {
      // Rough estimation: text length + metadata overhead
      size += msg.text.length * 2; // UTF-16 encoding
      size += msg.role.length * 2;
      size += msg.timestamp.length * 2;
      size += (msg.origin?.length || 0) * 2;
      size += 100; // overhead for object structure
    }
    return size;
  }
}
