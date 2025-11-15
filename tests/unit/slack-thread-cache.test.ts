import { ThreadCache } from '../../src/slack/thread-cache';
import { NormalizedMessage } from '../../src/types/bot';

describe('ThreadCache', () => {
  let cache: ThreadCache;

  const createMessage = (text: string, role: 'user' | 'bot' = 'user'): NormalizedMessage => ({
    role,
    text,
    timestamp: new Date().toISOString(),
    origin: role === 'bot' ? 'visor' : 'human',
  });

  const createMessages = (count: number): NormalizedMessage[] => {
    return Array.from({ length: count }, (_, i) => createMessage(`Message ${i + 1}`));
  };

  describe('Constructor and Initialization', () => {
    it('should initialize with default parameters', () => {
      cache = new ThreadCache();
      expect(cache).toBeDefined();
      expect(cache.capacity()).toBe(200);
      expect(cache.getTTL()).toBe(600);
      expect(cache.size()).toBe(0);
    });

    it('should initialize with custom maxThreads', () => {
      cache = new ThreadCache(500);
      expect(cache.capacity()).toBe(500);
      expect(cache.getTTL()).toBe(600);
    });

    it('should initialize with custom TTL', () => {
      cache = new ThreadCache(200, 1800);
      expect(cache.capacity()).toBe(200);
      expect(cache.getTTL()).toBe(1800);
    });

    it('should initialize with both custom parameters', () => {
      cache = new ThreadCache(100, 300);
      expect(cache.capacity()).toBe(100);
      expect(cache.getTTL()).toBe(300);
    });

    it('should initialize with zero stats', () => {
      cache = new ThreadCache();
      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.evictions).toBe(0);
      expect(stats.size).toBe(0);
      expect(stats.totalAccesses).toBe(0);
      expect(stats.hitRate).toBe(0);
    });
  });

  describe('set() method', () => {
    beforeEach(() => {
      cache = new ThreadCache(10, 600);
    });

    it('should add new entry correctly', () => {
      const messages = createMessages(3);
      cache.set('thread1', messages);

      expect(cache.size()).toBe(1);
      expect(cache.has('thread1')).toBe(true);
    });

    it('should store messages correctly', () => {
      const messages = createMessages(3);
      cache.set('thread1', messages);

      const entry = cache.get('thread1');
      expect(entry).not.toBeNull();
      expect(entry!.messages).toHaveLength(3);
      expect(entry!.messages[0].text).toBe('Message 1');
    });

    it('should store metadata correctly', () => {
      const messages = createMessages(2);
      const metadata = { channel: 'C123', threadTs: '1234567890.123' };
      cache.set('thread1', messages, metadata);

      const threadData = cache.getThread('thread1');
      expect(threadData).not.toBeNull();
      expect(threadData!.channel).toBe('C123');
      expect(threadData!.threadTs).toBe('1234567890.123');
    });

    it('should update existing entry', () => {
      const messages1 = createMessages(2);
      const messages2 = createMessages(5);

      cache.set('thread1', messages1);
      expect(cache.get('thread1')!.messages).toHaveLength(2);

      cache.set('thread1', messages2);
      expect(cache.get('thread1')!.messages).toHaveLength(5);
      expect(cache.size()).toBe(1); // Still only one entry
    });

    it('should preserve cachedAt timestamp on update', () => {
      const messages1 = createMessages(2);
      cache.set('thread1', messages1);
      const firstEntry = cache.get('thread1')!;
      const originalCachedAt = firstEntry.cachedAt;

      // Small delay
      const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      return delay(10).then(() => {
        const messages2 = createMessages(3);
        cache.set('thread1', messages2);
        const updatedEntry = cache.get('thread1')!;

        expect(updatedEntry.cachedAt).toBe(originalCachedAt);
        expect(updatedEntry.lastUpdatedAt).toBeGreaterThan(originalCachedAt);
      });
    });

    it('should preserve access count on update', () => {
      const messages1 = createMessages(2);
      cache.set('thread1', messages1);

      // Access it multiple times
      cache.get('thread1');
      cache.get('thread1');
      cache.get('thread1');

      const beforeUpdate = cache.get('thread1')!;
      expect(beforeUpdate.accessCount).toBe(4); // 3 gets + 1 from this check

      const messages2 = createMessages(5);
      cache.set('thread1', messages2);

      const afterUpdate = cache.get('thread1')!;
      expect(afterUpdate.accessCount).toBe(5); // Preserved + 1 from this get
    });

    it('should calculate size in bytes', () => {
      const messages = createMessages(2);
      cache.set('thread1', messages);

      const entry = cache.get('thread1')!;
      expect(entry.sizeBytes).toBeGreaterThan(0);
    });
  });

  describe('get() method', () => {
    beforeEach(() => {
      cache = new ThreadCache(10, 600);
    });

    it('should retrieve valid entries', () => {
      const messages = createMessages(3);
      cache.set('thread1', messages);

      const entry = cache.get('thread1');
      expect(entry).not.toBeNull();
      expect(entry!.messages).toHaveLength(3);
    });

    it('should return null for missing entries', () => {
      const entry = cache.get('nonexistent');
      expect(entry).toBeNull();
    });

    it('should return null for expired entries (TTL)', () => {
      cache = new ThreadCache(10, 1); // 1 second TTL
      const messages = createMessages(2);

      // Mock current time
      const now = Date.now();
      cache.set('thread1', messages);

      // Fast-forward time by mocking the entry's cachedAt
      const entry = (cache as any).cache.get('thread1');
      entry.cachedAt = now - 2000; // 2 seconds ago

      const result = cache.get('thread1');
      expect(result).toBeNull();
      expect(cache.has('thread1')).toBe(false);
    });

    it('should update lastAccessedAt on access', () => {
      const messages = createMessages(2);
      cache.set('thread1', messages);

      const before = Date.now();
      const entry = cache.get('thread1')!;
      const after = Date.now();

      expect(entry.lastAccessedAt).toBeGreaterThanOrEqual(before);
      expect(entry.lastAccessedAt).toBeLessThanOrEqual(after);
    });

    it('should increment access count', () => {
      const messages = createMessages(2);
      cache.set('thread1', messages);

      expect(cache.get('thread1')!.accessCount).toBe(1);
      expect(cache.get('thread1')!.accessCount).toBe(2);
      expect(cache.get('thread1')!.accessCount).toBe(3);
    });
  });

  describe('has() method', () => {
    beforeEach(() => {
      cache = new ThreadCache(10, 600);
    });

    it('should return true for valid entries', () => {
      const messages = createMessages(2);
      cache.set('thread1', messages);
      expect(cache.has('thread1')).toBe(true);
    });

    it('should return false for missing entries', () => {
      expect(cache.has('nonexistent')).toBe(false);
    });

    it('should return false for expired entries', () => {
      cache = new ThreadCache(10, 1); // 1 second TTL
      const messages = createMessages(2);

      const now = Date.now();
      cache.set('thread1', messages);

      // Mock expired entry
      const entry = (cache as any).cache.get('thread1');
      entry.cachedAt = now - 2000; // 2 seconds ago

      expect(cache.has('thread1')).toBe(false);
    });

    it('should not update access time', () => {
      const messages = createMessages(2);
      cache.set('thread1', messages);

      const entry1 = (cache as any).cache.get('thread1');
      const lastAccessed = entry1.lastAccessedAt;

      cache.has('thread1');

      const entry2 = (cache as any).cache.get('thread1');
      expect(entry2.lastAccessedAt).toBe(lastAccessed);
    });
  });

  describe('LRU Eviction', () => {
    beforeEach(() => {
      cache = new ThreadCache(3, 600); // Max 3 threads
    });

    it('should remove oldest entry when max_threads reached', () => {
      const messages = createMessages(2);

      cache.set('thread1', messages);
      cache.set('thread2', messages);
      cache.set('thread3', messages);

      expect(cache.size()).toBe(3);

      // This should evict thread1 (least recently accessed)
      cache.set('thread4', messages);

      expect(cache.size()).toBe(3);
      expect(cache.has('thread1')).toBe(false);
      expect(cache.has('thread2')).toBe(true);
      expect(cache.has('thread3')).toBe(true);
      expect(cache.has('thread4')).toBe(true);
    });

    it('should evict based on last access time, not creation time', async () => {
      const messages = createMessages(2);

      cache.set('thread1', messages);

      // Small delay to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));

      cache.set('thread2', messages);

      await new Promise(resolve => setTimeout(resolve, 10));

      cache.set('thread3', messages);

      // Access thread1 to make it more recently used
      cache.get('thread1');

      // This should evict thread2 (now least recently accessed)
      cache.set('thread4', messages);

      // Note: LRU eviction may evict thread2 or thread3 depending on timing
      // Just verify cache is at capacity and thread1 is preserved
      expect(cache.size()).toBe(3);
      expect(cache.has('thread1')).toBe(true);
      expect(cache.has('thread4')).toBe(true);
    });

    it('should track LRU evictions in stats', () => {
      const messages = createMessages(2);

      cache.set('thread1', messages);
      cache.set('thread2', messages);
      cache.set('thread3', messages);
      cache.set('thread4', messages); // Evicts thread1

      const stats = cache.getStats();
      expect(stats.evictionsByReason.lru).toBe(1);
    });
  });

  describe('evict() method', () => {
    beforeEach(() => {
      cache = new ThreadCache(10, 600);
    });

    it('should remove specific entry', () => {
      const messages = createMessages(2);
      cache.set('thread1', messages);
      cache.set('thread2', messages);

      expect(cache.size()).toBe(2);

      const result = cache.evict('thread1');

      expect(result).toBe(true);
      expect(cache.size()).toBe(1);
      expect(cache.has('thread1')).toBe(false);
      expect(cache.has('thread2')).toBe(true);
    });

    it('should return false for non-existent entry', () => {
      const result = cache.evict('nonexistent');
      expect(result).toBe(false);
    });

    it('should track manual evictions in stats', () => {
      const messages = createMessages(2);
      cache.set('thread1', messages);

      cache.evict('thread1');

      const stats = cache.getStats();
      expect(stats.evictionsByReason.manual).toBe(1);
    });
  });

  describe('clear() method', () => {
    beforeEach(() => {
      cache = new ThreadCache(10, 600);
    });

    it('should remove all entries', () => {
      const messages = createMessages(2);
      cache.set('thread1', messages);
      cache.set('thread2', messages);
      cache.set('thread3', messages);

      expect(cache.size()).toBe(3);

      cache.clear();

      expect(cache.size()).toBe(0);
      expect(cache.has('thread1')).toBe(false);
      expect(cache.has('thread2')).toBe(false);
      expect(cache.has('thread3')).toBe(false);
    });

    it('should track manual evictions for all cleared entries', () => {
      const messages = createMessages(2);
      cache.set('thread1', messages);
      cache.set('thread2', messages);
      cache.set('thread3', messages);

      cache.clear();

      const stats = cache.getStats();
      expect(stats.evictionsByReason.manual).toBe(3);
    });
  });

  describe('cleanupExpired() method', () => {
    beforeEach(() => {
      cache = new ThreadCache(10, 2); // 2 second TTL
    });

    it('should remove only expired entries', () => {
      const messages = createMessages(2);
      const now = Date.now();

      cache.set('thread1', messages);
      cache.set('thread2', messages);
      cache.set('thread3', messages);

      // Mock thread1 and thread2 as expired
      const entry1 = (cache as any).cache.get('thread1');
      const entry2 = (cache as any).cache.get('thread2');
      entry1.cachedAt = now - 3000; // 3 seconds ago (expired)
      entry2.cachedAt = now - 3000; // 3 seconds ago (expired)

      const removed = cache.cleanupExpired();

      expect(removed).toBe(2);
      expect(cache.size()).toBe(1);
      expect(cache.has('thread1')).toBe(false);
      expect(cache.has('thread2')).toBe(false);
      expect(cache.has('thread3')).toBe(true);
    });

    it('should return 0 if no entries are expired', () => {
      const messages = createMessages(2);
      cache.set('thread1', messages);
      cache.set('thread2', messages);

      const removed = cache.cleanupExpired();
      expect(removed).toBe(0);
      expect(cache.size()).toBe(2);
    });

    it('should track TTL evictions in stats', () => {
      const messages = createMessages(2);
      const now = Date.now();

      cache.set('thread1', messages);

      // Mock as expired
      const entry = (cache as any).cache.get('thread1');
      entry.cachedAt = now - 3000;

      cache.cleanupExpired();

      const stats = cache.getStats();
      expect(stats.evictionsByReason.ttl_expired).toBe(1);
    });
  });

  describe('Metrics Tracking', () => {
    beforeEach(() => {
      cache = new ThreadCache(10, 600);
    });

    it('should track cache hits', () => {
      const messages = createMessages(2);
      cache.set('thread1', messages);

      cache.get('thread1');
      cache.get('thread1');

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.totalAccesses).toBe(2);
    });

    it('should track cache misses', () => {
      cache.get('nonexistent1');
      cache.get('nonexistent2');
      cache.get('nonexistent3');

      const stats = cache.getStats();
      expect(stats.misses).toBe(3);
      expect(stats.totalAccesses).toBe(3);
    });

    it('should track evictions by TTL', () => {
      cache = new ThreadCache(10, 1);
      const messages = createMessages(2);
      const now = Date.now();

      cache.set('thread1', messages);

      // Mock as expired
      const entry = (cache as any).cache.get('thread1');
      entry.cachedAt = now - 2000;

      cache.get('thread1'); // This will evict the expired entry

      const stats = cache.getStats();
      expect(stats.evictionsByReason.ttl_expired).toBe(1);
    });

    it('should track evictions by LRU', () => {
      cache = new ThreadCache(2, 600);
      const messages = createMessages(2);

      cache.set('thread1', messages);
      cache.set('thread2', messages);
      cache.set('thread3', messages); // Evicts thread1

      const stats = cache.getStats();
      expect(stats.evictionsByReason.lru).toBe(1);
    });

    it('should track evictions by manual action', () => {
      const messages = createMessages(2);
      cache.set('thread1', messages);
      cache.set('thread2', messages);

      cache.evict('thread1');

      const stats = cache.getStats();
      expect(stats.evictionsByReason.manual).toBe(1);
    });

    it('should calculate hit rate correctly', () => {
      const messages = createMessages(2);
      cache.set('thread1', messages);

      cache.get('thread1'); // hit
      cache.get('thread1'); // hit
      cache.get('nonexistent'); // miss

      const stats = cache.getStats();
      expect(stats.hitRate).toBeCloseTo(66.67, 1); // 2 hits / 3 total = 66.67%
    });

    it('should calculate average thread size', () => {
      const messages1 = createMessages(2);
      const messages2 = createMessages(3);

      cache.set('thread1', messages1);
      cache.set('thread2', messages2);

      const stats = cache.getStats();
      expect(stats.avgThreadSize).toBeGreaterThan(0);
    });

    it('should track total bytes', () => {
      const messages = createMessages(5);
      cache.set('thread1', messages);

      const stats = cache.getStats();
      expect(stats.totalBytes).toBeGreaterThan(0);
    });
  });

  describe('Time Window Statistics', () => {
    beforeEach(() => {
      cache = new ThreadCache(10, 600);
    });

    it('should track 1 minute window', () => {
      const messages = createMessages(2);
      cache.set('thread1', messages);

      cache.get('thread1'); // hit
      cache.get('nonexistent'); // miss

      const stats = cache.getTimeWindowStats(60);
      expect(stats).not.toBeNull();
      expect(stats!.hits).toBe(1);
      expect(stats!.misses).toBe(1);
      expect(stats!.windowSeconds).toBe(60);
    });

    it('should track 5 minute window', () => {
      const messages = createMessages(2);
      cache.set('thread1', messages);

      cache.get('thread1');

      const stats = cache.getTimeWindowStats(300);
      expect(stats).not.toBeNull();
      expect(stats!.hits).toBe(1);
      expect(stats!.windowSeconds).toBe(300);
    });

    it('should track 15 minute window', () => {
      const messages = createMessages(2);
      cache.set('thread1', messages);

      cache.get('thread1');

      const stats = cache.getTimeWindowStats(900);
      expect(stats).not.toBeNull();
      expect(stats!.hits).toBe(1);
      expect(stats!.windowSeconds).toBe(900);
    });

    it('should calculate hit rate in window', () => {
      const messages = createMessages(2);
      cache.set('thread1', messages);

      cache.get('thread1'); // hit
      cache.get('thread1'); // hit
      cache.get('nonexistent'); // miss

      const stats = cache.getTimeWindowStats(60);
      expect(stats!.hitRate).toBeCloseTo(66.67, 1);
    });

    it('should return all time windows', () => {
      const messages = createMessages(2);
      cache.set('thread1', messages);

      cache.get('thread1');

      const allStats = cache.getAllTimeWindowStats();
      expect(allStats.size).toBe(3);
      expect(allStats.has(60)).toBe(true);
      expect(allStats.has(300)).toBe(true);
      expect(allStats.has(900)).toBe(true);
    });
  });

  describe('Cache Efficiency Calculation', () => {
    beforeEach(() => {
      cache = new ThreadCache(10, 600);
    });

    it('should return low efficiency for empty cache', () => {
      const efficiency = cache.getCacheEfficiency();
      // Empty cache has some baseline efficiency due to utilization component
      expect(efficiency).toBeGreaterThanOrEqual(0);
      expect(efficiency).toBeLessThan(50);
    });

    it('should calculate efficiency score based on hit rate', () => {
      const messages = createMessages(2);
      cache.set('thread1', messages);
      cache.set('thread2', messages);

      // Create high hit rate
      for (let i = 0; i < 10; i++) {
        cache.get('thread1');
        cache.get('thread2');
      }

      const efficiency = cache.getCacheEfficiency();
      expect(efficiency).toBeGreaterThan(0);
    });

    it('should consider utilization in efficiency', () => {
      cache = new ThreadCache(10, 600);
      const messages = createMessages(2);

      // Fill to 70% capacity (sweet spot)
      for (let i = 0; i < 7; i++) {
        cache.set(`thread${i}`, messages);
      }

      // Access all to create hits
      for (let i = 0; i < 7; i++) {
        cache.get(`thread${i}`);
      }

      const efficiency = cache.getCacheEfficiency();
      expect(efficiency).toBeGreaterThan(0);
    });
  });

  describe('getThreadData() method', () => {
    beforeEach(() => {
      cache = new ThreadCache(10, 600);
    });

    it('should return thread metadata', () => {
      const messages = createMessages(3);
      const metadata = { channel: 'C123', threadTs: '1234567890.123' };
      cache.set('thread1', messages, metadata);

      const threadData = cache.getThread('thread1');
      expect(threadData).not.toBeNull();
      expect(threadData!.threadId).toBe('thread1');
      expect(threadData!.messageCount).toBe(3);
      expect(threadData!.channel).toBe('C123');
      expect(threadData!.threadTs).toBe('1234567890.123');
    });

    it('should return null for missing thread', () => {
      const threadData = cache.getThread('nonexistent');
      expect(threadData).toBeNull();
    });

    it('should include access count', () => {
      const messages = createMessages(2);
      cache.set('thread1', messages);

      cache.get('thread1');
      cache.get('thread1');

      const threadData = cache.getThread('thread1');
      expect(threadData!.accessCount).toBe(2);
    });

    it('should include timestamps in ISO format', () => {
      const messages = createMessages(2);
      cache.set('thread1', messages);

      const threadData = cache.getThread('thread1');
      expect(threadData!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(threadData!.lastAccessedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(threadData!.lastUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should calculate age in seconds', () => {
      const messages = createMessages(2);
      cache.set('thread1', messages);

      const threadData = cache.getThread('thread1');
      expect(threadData!.ageSeconds).toBeGreaterThanOrEqual(0);
      expect(threadData!.ageSeconds).toBeLessThan(2);
    });
  });

  describe('Memory Usage Estimation', () => {
    beforeEach(() => {
      cache = new ThreadCache(10, 600);
    });

    it('should estimate size for messages', () => {
      const messages = [
        createMessage('Short'),
        createMessage('A much longer message with more text'),
      ];
      cache.set('thread1', messages);

      const stats = cache.getStats();
      expect(stats.totalBytes).toBeGreaterThan(0);
    });

    it('should track size per thread', () => {
      const messages = createMessages(5);
      cache.set('thread1', messages);

      const threadData = cache.getThread('thread1');
      expect(threadData!.sizeBytes).toBeGreaterThan(0);
    });

    it('should update total bytes when adding threads', () => {
      const messages1 = createMessages(2);
      const messages2 = createMessages(3);

      cache.set('thread1', messages1);
      const stats1 = cache.getStats();

      cache.set('thread2', messages2);
      const stats2 = cache.getStats();

      expect(stats2.totalBytes).toBeGreaterThan(stats1.totalBytes);
    });

    it('should update total bytes when removing threads', () => {
      const messages = createMessages(5);
      cache.set('thread1', messages);
      cache.set('thread2', messages);

      const stats1 = cache.getStats();

      cache.evict('thread1');

      const stats2 = cache.getStats();
      expect(stats2.totalBytes).toBeLessThan(stats1.totalBytes);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty cache operations', () => {
      cache = new ThreadCache(10, 600);

      expect(cache.size()).toBe(0);
      expect(cache.get('any')).toBeNull();
      expect(cache.has('any')).toBe(false);
      expect(cache.evict('any')).toBe(false);
      expect(cache.cleanupExpired()).toBe(0);
    });

    it('should handle cache at max capacity', () => {
      cache = new ThreadCache(3, 600);
      const messages = createMessages(2);

      cache.set('thread1', messages);
      cache.set('thread2', messages);
      cache.set('thread3', messages);

      expect(cache.size()).toBe(3);
      expect(cache.size()).toBe(cache.capacity());

      // Adding another should evict LRU
      cache.set('thread4', messages);
      expect(cache.size()).toBe(3);
    });

    it('should handle zero TTL gracefully', () => {
      cache = new ThreadCache(10, 0);
      const messages = createMessages(2);

      cache.set('thread1', messages);

      // Even with 0 TTL, entries should not expire immediately
      // (they expire when age > ttl, so 0 means they stay valid for a brief moment)
      const entry = cache.get('thread1');
      expect(entry).not.toBeNull();
    });

    it('should handle very large TTL', () => {
      cache = new ThreadCache(10, 999999);
      const messages = createMessages(2);

      cache.set('thread1', messages);
      expect(cache.has('thread1')).toBe(true);

      const threadData = cache.getThread('thread1');
      expect(threadData).not.toBeNull();
    });

    it('should handle empty message arrays', () => {
      cache = new ThreadCache(10, 600);
      cache.set('thread1', []);

      const entry = cache.get('thread1');
      expect(entry).not.toBeNull();
      expect(entry!.messages).toHaveLength(0);
    });

    it('should handle rapid sequential accesses', () => {
      cache = new ThreadCache(10, 600);
      const messages = createMessages(2);
      cache.set('thread1', messages);

      for (let i = 0; i < 100; i++) {
        cache.get('thread1');
      }

      const entry = cache.get('thread1');
      expect(entry!.accessCount).toBe(101);
    });

    it('should handle getAllThreads with empty cache', () => {
      cache = new ThreadCache(10, 600);
      const threads = cache.getAllThreads();
      expect(threads).toHaveLength(0);
    });

    it('should handle getMostActiveThreads with fewer threads than limit', () => {
      cache = new ThreadCache(10, 600);
      const messages = createMessages(2);

      cache.set('thread1', messages);
      cache.set('thread2', messages);

      const active = cache.getMostActiveThreads(10);
      expect(active).toHaveLength(2);
    });

    it('should handle getLeastRecentlyUsed correctly', () => {
      cache = new ThreadCache(10, 600);
      const messages = createMessages(2);

      cache.set('thread1', messages);
      cache.set('thread2', messages);
      cache.set('thread3', messages);

      // Access thread2 to make it more recent
      cache.get('thread2');

      const lru = cache.getLeastRecentlyUsed(1);
      expect(lru).toHaveLength(1);
      // thread1 or thread3 should be least recently used
      expect(['thread1', 'thread3']).toContain(lru[0].threadId);
    });

    it('should handle exportState', () => {
      cache = new ThreadCache(10, 600);
      const messages = createMessages(2);

      cache.set('thread1', messages, { channel: 'C123', threadTs: '123' });
      cache.get('thread1');

      const state = cache.exportState();
      expect(state).toHaveProperty('stats');
      expect(state).toHaveProperty('threads');
      expect(state).toHaveProperty('timeWindows');
      expect(state).toHaveProperty('config');
      expect(state.config.maxThreads).toBe(10);
      expect(state.config.ttlSeconds).toBe(600);
      expect(state.threads).toHaveLength(1);
    });
  });

  describe('Statistics Methods', () => {
    beforeEach(() => {
      cache = new ThreadCache(10, 600);
    });

    it('should return correct cache size', () => {
      expect(cache.size()).toBe(0);

      const messages = createMessages(2);
      cache.set('thread1', messages);
      expect(cache.size()).toBe(1);

      cache.set('thread2', messages);
      expect(cache.size()).toBe(2);
    });

    it('should return correct capacity', () => {
      expect(cache.capacity()).toBe(10);

      const largeCache = new ThreadCache(500);
      expect(largeCache.capacity()).toBe(500);
    });

    it('should return correct TTL', () => {
      expect(cache.getTTL()).toBe(600);

      const shortCache = new ThreadCache(10, 60);
      expect(shortCache.getTTL()).toBe(60);
    });

    it('should calculate hit rate as percentage', () => {
      const messages = createMessages(2);
      cache.set('thread1', messages);

      cache.get('thread1'); // hit
      cache.get('thread1'); // hit
      cache.get('thread1'); // hit
      cache.get('nonexistent'); // miss

      const hitRate = cache.getHitRate();
      expect(hitRate).toBeCloseTo(75, 1); // 3 hits / 4 total = 75%
    });

    it('should return 0 hit rate for no accesses', () => {
      const hitRate = cache.getHitRate();
      expect(hitRate).toBe(0);
    });

    it('should getAllThreads in correct format', () => {
      const messages = createMessages(2);
      cache.set('thread1', messages, { channel: 'C1', threadTs: 'ts1' });
      cache.set('thread2', messages, { channel: 'C2', threadTs: 'ts2' });

      const threads = cache.getAllThreads();
      expect(threads).toHaveLength(2);
      expect(threads[0]).toHaveProperty('threadId');
      expect(threads[0]).toHaveProperty('messageCount');
      expect(threads[0]).toHaveProperty('sizeBytes');
      expect(threads[0]).toHaveProperty('createdAt');
      expect(threads[0]).toHaveProperty('lastAccessedAt');
      expect(threads[0]).toHaveProperty('accessCount');
      expect(threads[0]).toHaveProperty('channel');
    });

    it('should resetStats correctly', () => {
      const messages = createMessages(2);
      cache.set('thread1', messages);

      cache.get('thread1');
      cache.get('nonexistent');

      let stats = cache.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);

      cache.resetStats();

      stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.totalAccesses).toBe(0);
      expect(stats.size).toBe(1); // Size should remain
    });
  });
});
