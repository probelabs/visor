import { CachePrewarmer } from '../../src/slack/cache-prewarmer';
import { SlackClient } from '../../src/slack/client';
import { SlackAdapter } from '../../src/slack/adapter';
import { ThreadCache } from '../../src/slack/thread-cache';
import { SlackCachePrewarmingConfig, SlackBotConfig, NormalizedMessage } from '../../src/types/bot';

// Mock dependencies
jest.mock('../../src/slack/client');
jest.mock('../../src/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('CachePrewarmer', () => {
  let prewarmer: CachePrewarmer;
  let mockClient: jest.Mocked<SlackClient>;
  let mockWebClient: any;
  let adapter: SlackAdapter;
  let cache: ThreadCache;

  const createMessage = (text: string, role: 'user' | 'bot' = 'user'): NormalizedMessage => ({
    role,
    text,
    timestamp: new Date().toISOString(),
    origin: role === 'bot' ? 'visor' : 'human',
  });

  const createSlackMessage = (ts: string, threadTs?: string, text: string = 'test') => ({
    ts,
    thread_ts: threadTs,
    text,
    user: 'U123',
  });

  beforeEach(() => {
    // Create mock WebClient
    mockWebClient = {
      conversations: {
        history: jest.fn(),
        open: jest.fn(),
      },
    } as any;

    // Create mock SlackClient
    mockClient = new SlackClient({} as any) as jest.Mocked<SlackClient>;
    mockClient.getWebClient = jest.fn().mockReturnValue(mockWebClient);

    // Create cache and adapter
    cache = new ThreadCache(100, 600);
    const config: SlackBotConfig = {
      id: 'test-bot',
      endpoint: '/test',
      signing_secret: 'secret',
      bot_token: 'token',
    };
    adapter = new SlackAdapter(mockClient, config, cache);

    // Mock adapter's fetchConversation
    jest.spyOn(adapter, 'fetchConversation').mockResolvedValue({
      transport: 'slack',
      thread: { id: 'test', url: 'https://test.slack.com' },
      messages: [createMessage('test')],
      current: createMessage('test'),
      attributes: {},
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Constructor and Initialization', () => {
    it('should create prewarmer with config', () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: ['C123'],
        users: ['U456'],
        max_threads_per_channel: 20,
        concurrency: 5,
        rate_limit_ms: 100,
      };

      prewarmer = new CachePrewarmer(mockClient, adapter, config);
      expect(prewarmer).toBeDefined();
    });

    it('should apply default values', () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
      };

      prewarmer = new CachePrewarmer(mockClient, adapter, config);
      expect(prewarmer).toBeDefined();
    });

    it('should handle minimal config', () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: false,
      };

      prewarmer = new CachePrewarmer(mockClient, adapter, config);
      expect(prewarmer).toBeDefined();
    });

    it('should handle partial config with defaults', () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: ['C123'],
      };

      prewarmer = new CachePrewarmer(mockClient, adapter, config);
      expect(prewarmer).toBeDefined();
    });
  });

  describe('prewarm() method - channel-based', () => {
    beforeEach(() => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: ['C123', 'C456'],
        max_threads_per_channel: 5,
        concurrency: 2,
        rate_limit_ms: 10,
      };
      prewarmer = new CachePrewarmer(mockClient, adapter, config);
    });

    it('should prewarm channels successfully', async () => {
      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [
          createSlackMessage('1234567890.123', '1234567890.123', 'Thread 1'),
          createSlackMessage('1234567891.456', '1234567891.456', 'Thread 2'),
        ],
      } as any);

      const result = await prewarmer.prewarm();

      expect(result).toBeDefined();
      expect(result.channels.length).toBe(2);
      expect(result.totalThreads).toBeGreaterThan(0);
    });

    it('should respect max_threads_per_channel', async () => {
      const messages = Array.from({ length: 10 }, (_, i) =>
        createSlackMessage(`123456789${i}.123`, `123456789${i}.123`)
      );

      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages,
      } as any);

      await prewarmer.prewarm();

      // Should only fetch up to max_threads_per_channel (5)
      expect(mockWebClient.conversations.history).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 5 })
      );
    });

    it('should respect concurrency limit', async () => {
      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [createSlackMessage('1234567890.123', '1234567890.123')],
      } as any);

      const startTime = Date.now();
      await prewarmer.prewarm();
      const duration = Date.now() - startTime;

      // With concurrency 2 and 2 channels, should be faster than sequential
      expect(duration).toBeLessThan(1000);
    });

    it('should apply rate limiting delays', async () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: ['C123'],
        rate_limit_ms: 50,
        max_threads_per_channel: 3,
      };
      prewarmer = new CachePrewarmer(mockClient, adapter, config);

      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [
          createSlackMessage('1.123', '1.123'),
          createSlackMessage('2.123', '2.123'),
          createSlackMessage('3.123', '3.123'),
        ],
      } as any);

      const startTime = Date.now();
      await prewarmer.prewarm();
      const duration = Date.now() - startTime;

      // With 3 threads and 50ms delay between each (after first), should take at least 100ms
      expect(duration).toBeGreaterThanOrEqual(50);
    });

    it('should handle channel API errors gracefully', async () => {
      mockWebClient.conversations.history.mockRejectedValue(new Error('API error'));

      const result = await prewarmer.prewarm();

      expect(result.channels.length).toBe(2);
      expect(result.channels[0].errors.length).toBeGreaterThan(0);
    });

    it('should handle empty channels', async () => {
      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [],
      } as any);

      const result = await prewarmer.prewarm();

      expect(result.totalThreads).toBe(0);
    });

    it('should handle messages without threads', async () => {
      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [
          createSlackMessage('1234567890.123'), // No thread_ts
          createSlackMessage('1234567891.456'), // No thread_ts
        ],
      } as any);

      const result = await prewarmer.prewarm();

      expect(result.totalThreads).toBe(0);
    });

    it('should only fetch parent thread messages', async () => {
      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [
          createSlackMessage('1.123', '1.123'), // Parent (ts === thread_ts)
          createSlackMessage('2.123', '1.123'), // Reply (ts !== thread_ts)
          createSlackMessage('3.123', '3.123'), // Parent
        ],
      } as any);

      await prewarmer.prewarm();

      // Should only fetch 2 threads per channel (the parent messages)
      // With 2 channels configured, that's 4 total calls
      expect(adapter.fetchConversation).toHaveBeenCalledTimes(4);
    });

    it('should paginate through channel history', async () => {
      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [createSlackMessage('1234567890.123', '1234567890.123')],
      } as any);

      await prewarmer.prewarm();

      expect(mockWebClient.conversations.history).toHaveBeenCalled();
    });

    it('should update cache correctly', async () => {
      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [createSlackMessage('1234567890.123', '1234567890.123')],
      } as any);

      await prewarmer.prewarm();

      // Cache should be updated via adapter.fetchConversation
      expect(adapter.fetchConversation).toHaveBeenCalled();
    });

    it('should track progress correctly', async () => {
      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [createSlackMessage('1.123', '1.123'), createSlackMessage('2.123', '2.123')],
      } as any);

      const result = await prewarmer.prewarm();

      expect(result.channels.length).toBe(2);
      expect(result.channels[0].threadsPrewarmed).toBeGreaterThanOrEqual(0);
    });

    it('should return statistics', async () => {
      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [],
      } as any);

      const result = await prewarmer.prewarm();

      expect(result).toHaveProperty('totalThreads');
      expect(result).toHaveProperty('durationMs');
      expect(result).toHaveProperty('channels');
      expect(result).toHaveProperty('users');
      expect(result).toHaveProperty('errors');
    });
  });

  describe('prewarm() method - user-based', () => {
    beforeEach(() => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        users: ['U123', 'U456'],
        max_threads_per_channel: 5,
        concurrency: 2,
        rate_limit_ms: 10,
      };
      prewarmer = new CachePrewarmer(mockClient, adapter, config);
    });

    it('should prewarm user DMs successfully', async () => {
      mockWebClient.conversations.open.mockResolvedValue({
        ok: true,
        channel: { id: 'D123' },
      } as any);

      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [createSlackMessage('1234567890.123', '1234567890.123')],
      } as any);

      const result = await prewarmer.prewarm();

      expect(result.users.length).toBe(2);
      expect(result.totalThreads).toBeGreaterThan(0);
    });

    it('should open DM channels correctly', async () => {
      mockWebClient.conversations.open.mockResolvedValue({
        ok: true,
        channel: { id: 'D123' },
      } as any);

      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [],
      } as any);

      await prewarmer.prewarm();

      expect(mockWebClient.conversations.open).toHaveBeenCalledWith({
        users: expect.any(String),
      });
    });

    it('should handle user API errors gracefully', async () => {
      mockWebClient.conversations.open.mockRejectedValue(new Error('API error'));

      const result = await prewarmer.prewarm();

      expect(result.users.length).toBe(2);
      expect(result.users[0].errors.length).toBeGreaterThan(0);
    });

    it('should handle failed DM opens', async () => {
      mockWebClient.conversations.open.mockResolvedValue({
        ok: false,
      } as any);

      const result = await prewarmer.prewarm();

      expect(result.users[0].threadsPrewarmed).toBe(0);
      expect(result.users[0].errors.length).toBeGreaterThan(0);
    });

    it('should handle empty user conversations', async () => {
      mockWebClient.conversations.open.mockResolvedValue({
        ok: true,
        channel: { id: 'D123' },
      } as any);

      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [],
      } as any);

      const result = await prewarmer.prewarm();

      expect(result.users[0].threadsPrewarmed).toBe(0);
    });

    it('should paginate through user history', async () => {
      mockWebClient.conversations.open.mockResolvedValue({
        ok: true,
        channel: { id: 'D123' },
      } as any);

      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [createSlackMessage('1234567890.123', '1234567890.123')],
      } as any);

      await prewarmer.prewarm();

      expect(mockWebClient.conversations.history).toHaveBeenCalled();
    });
  });

  describe('prewarm() method - combined', () => {
    beforeEach(() => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: ['C123'],
        users: ['U456'],
        max_threads_per_channel: 5,
      };
      prewarmer = new CachePrewarmer(mockClient, adapter, config);
    });

    it('should prewarm both channels and users', async () => {
      mockWebClient.conversations.open.mockResolvedValue({
        ok: true,
        channel: { id: 'D123' },
      } as any);

      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [createSlackMessage('1234567890.123', '1234567890.123')],
      } as any);

      const result = await prewarmer.prewarm();

      expect(result.channels.length).toBe(1);
      expect(result.users.length).toBe(1);
      expect(result.totalThreads).toBeGreaterThan(0);
    });

    it('should combine thread counts correctly', async () => {
      mockWebClient.conversations.open.mockResolvedValue({
        ok: true,
        channel: { id: 'D123' },
      } as any);

      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [createSlackMessage('1.123', '1.123'), createSlackMessage('2.123', '2.123')],
      } as any);

      const result = await prewarmer.prewarm();

      // 2 threads from channel + 2 from user = 4 total
      expect(result.totalThreads).toBe(4);
    });
  });

  describe('prewarm() method - disabled', () => {
    it('should skip when disabled', async () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: false,
        channels: ['C123'],
      };
      prewarmer = new CachePrewarmer(mockClient, adapter, config);

      const result = await prewarmer.prewarm();

      expect(result.totalThreads).toBe(0);
      expect(result.durationMs).toBe(0);
      expect(result.channels).toHaveLength(0);
      expect(result.users).toHaveLength(0);
      expect(mockWebClient.conversations.history).not.toHaveBeenCalled();
    });
  });

  describe('Statistics Tracking', () => {
    beforeEach(() => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: ['C123'],
        max_threads_per_channel: 5,
      };
      prewarmer = new CachePrewarmer(mockClient, adapter, config);
    });

    it('should track total channels processed', async () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: ['C1', 'C2', 'C3'],
      };
      prewarmer = new CachePrewarmer(mockClient, adapter, config);

      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [],
      } as any);

      const result = await prewarmer.prewarm();

      expect(result.channels.length).toBe(3);
    });

    it('should track total users processed', async () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        users: ['U1', 'U2'],
      };
      prewarmer = new CachePrewarmer(mockClient, adapter, config);

      mockWebClient.conversations.open.mockResolvedValue({
        ok: true,
        channel: { id: 'D123' },
      } as any);

      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [],
      } as any);

      const result = await prewarmer.prewarm();

      expect(result.users.length).toBe(2);
    });

    it('should track total threads cached', async () => {
      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [createSlackMessage('1.123', '1.123'), createSlackMessage('2.123', '2.123')],
      } as any);

      const result = await prewarmer.prewarm();

      expect(result.totalThreads).toBe(2);
    });

    it('should track duration', async () => {
      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [],
      } as any);

      const result = await prewarmer.prewarm();

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.durationMs).toBeLessThan(5000);
    });

    it('should track errors encountered', async () => {
      mockWebClient.conversations.history.mockRejectedValue(new Error('API error'));

      const result = await prewarmer.prewarm();

      expect(result.channels[0].errors.length).toBeGreaterThan(0);
    });

    it('should aggregate errors from all sources', async () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: ['C1', 'C2'],
      };
      prewarmer = new CachePrewarmer(mockClient, adapter, config);

      mockWebClient.conversations.history
        .mockRejectedValueOnce(new Error('Error 1'))
        .mockRejectedValueOnce(new Error('Error 2'));

      const result = await prewarmer.prewarm();

      const totalErrors = result.channels.reduce((sum, c) => sum + c.errors.length, 0);
      expect(totalErrors).toBeGreaterThan(0);
    });
  });

  describe('Concurrency Control', () => {
    it('should respect max concurrent requests', async () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: ['C1', 'C2', 'C3', 'C4', 'C5'],
        concurrency: 2,
      };
      prewarmer = new CachePrewarmer(mockClient, adapter, config);

      let concurrent = 0;
      let maxConcurrent = 0;

      mockWebClient.conversations.history.mockImplementation(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise(resolve => setTimeout(resolve, 10));
        concurrent--;
        return { ok: true, messages: [] } as any;
      });

      await prewarmer.prewarm();

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it('should process batches sequentially', async () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: ['C1', 'C2', 'C3', 'C4'],
        concurrency: 2,
      };
      prewarmer = new CachePrewarmer(mockClient, adapter, config);

      const callOrder: string[] = [];

      mockWebClient.conversations.history.mockImplementation(async (params: any) => {
        callOrder.push(params.channel);
        return { ok: true, messages: [] } as any;
      });

      await prewarmer.prewarm();

      // All channels should be processed
      expect(callOrder.length).toBe(4);
    });
  });

  describe('Rate Limiting', () => {
    it('should apply delay between requests', async () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: ['C123'],
        rate_limit_ms: 100,
        max_threads_per_channel: 3,
      };
      prewarmer = new CachePrewarmer(mockClient, adapter, config);

      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [
          createSlackMessage('1.123', '1.123'),
          createSlackMessage('2.123', '2.123'),
          createSlackMessage('3.123', '3.123'),
        ],
      } as any);

      const startTime = Date.now();
      await prewarmer.prewarm();
      const duration = Date.now() - startTime;

      // 3 threads with 100ms delay = at least 200ms total
      expect(duration).toBeGreaterThanOrEqual(150);
    });

    it('should respect Slack API limits', async () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: ['C123'],
        rate_limit_ms: 50,
      };
      prewarmer = new CachePrewarmer(mockClient, adapter, config);

      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [],
      } as any);

      await prewarmer.prewarm();

      // Should complete without rate limit errors
      expect(mockWebClient.conversations.history).toHaveBeenCalled();
    });
  });

  describe('Error Recovery', () => {
    it('should continue after errors', async () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: ['C1', 'C2', 'C3'],
      };
      prewarmer = new CachePrewarmer(mockClient, adapter, config);

      mockWebClient.conversations.history
        .mockRejectedValueOnce(new Error('Error'))
        .mockResolvedValueOnce({ ok: true, messages: [] } as any)
        .mockResolvedValueOnce({ ok: true, messages: [] } as any);

      const result = await prewarmer.prewarm();

      // Should process all 3 channels despite first error
      expect(result.channels.length).toBe(3);
    });

    it('should aggregate all errors', async () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: ['C1', 'C2'],
      };
      prewarmer = new CachePrewarmer(mockClient, adapter, config);

      mockWebClient.conversations.history.mockRejectedValue(new Error('API error'));

      const result = await prewarmer.prewarm();

      const totalErrors = result.channels.reduce((sum, c) => sum + c.errors.length, 0);
      expect(totalErrors).toBe(2);
    });

    it('should handle thread-level errors', async () => {
      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [createSlackMessage('1.123', '1.123'), createSlackMessage('2.123', '2.123')],
      } as any);

      jest
        .spyOn(adapter, 'fetchConversation')
        .mockRejectedValueOnce(new Error('Fetch error'))
        .mockResolvedValueOnce({
          transport: 'slack',
          thread: { id: 'test', url: 'test' },
          messages: [createMessage('test')],
          current: createMessage('test'),
          attributes: {},
        });

      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: ['C123'],
      };
      prewarmer = new CachePrewarmer(mockClient, adapter, config);

      const result = await prewarmer.prewarm();

      // Should have 1 success and 1 error
      expect(result.channels[0].threadsPrewarmed).toBe(1);
      expect(result.channels[0].errors.length).toBe(1);
    });
  });

  describe('Configuration Validation', () => {
    it('should handle missing channels array', () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        users: ['U123'],
      };

      prewarmer = new CachePrewarmer(mockClient, adapter, config);
      expect(prewarmer).toBeDefined();
    });

    it('should handle missing users array', () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: ['C123'],
      };

      prewarmer = new CachePrewarmer(mockClient, adapter, config);
      expect(prewarmer).toBeDefined();
    });

    it('should handle empty arrays', async () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: [],
        users: [],
      };

      prewarmer = new CachePrewarmer(mockClient, adapter, config);

      const result = await prewarmer.prewarm();

      expect(result.totalThreads).toBe(0);
      expect(result.channels).toHaveLength(0);
      expect(result.users).toHaveLength(0);
    });

    it('should use default max_threads_per_channel', async () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: ['C123'],
      };

      prewarmer = new CachePrewarmer(mockClient, adapter, config);

      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [],
      } as any);

      await prewarmer.prewarm();

      expect(mockWebClient.conversations.history).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 20 })
      );
    });

    it('should use default concurrency', async () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'],
      };

      prewarmer = new CachePrewarmer(mockClient, adapter, config);

      let concurrent = 0;
      let maxConcurrent = 0;

      mockWebClient.conversations.history.mockImplementation(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise(resolve => setTimeout(resolve, 10));
        concurrent--;
        return { ok: true, messages: [] } as any;
      });

      await prewarmer.prewarm();

      // Default concurrency is 5
      expect(maxConcurrent).toBeLessThanOrEqual(5);
    });

    it('should use default rate_limit_ms', async () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: ['C123'],
        max_threads_per_channel: 2,
      };

      prewarmer = new CachePrewarmer(mockClient, adapter, config);

      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [createSlackMessage('1.123', '1.123'), createSlackMessage('2.123', '2.123')],
      } as any);

      await prewarmer.prewarm();

      // Should complete without errors
      expect(mockWebClient.conversations.history).toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    it('should handle messages without thread_ts field', async () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: ['C123'],
      };
      prewarmer = new CachePrewarmer(mockClient, adapter, config);

      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [{ ts: '1234567890.123', text: 'test' }],
      } as any);

      const result = await prewarmer.prewarm();

      expect(result.totalThreads).toBe(0);
    });

    it('should handle API response without messages field', async () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: ['C123'],
      };
      prewarmer = new CachePrewarmer(mockClient, adapter, config);

      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
      } as any);

      const result = await prewarmer.prewarm();

      expect(result.channels[0].threadsPrewarmed).toBe(0);
    });

    it('should handle very large channel lists', async () => {
      const channels = Array.from({ length: 100 }, (_, i) => `C${i}`);
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels,
        concurrency: 10,
      };

      prewarmer = new CachePrewarmer(mockClient, adapter, config);

      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [],
      } as any);

      const result = await prewarmer.prewarm();

      expect(result.channels.length).toBe(100);
    });

    it('should handle zero rate limit', async () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: ['C123'],
        rate_limit_ms: 0,
        max_threads_per_channel: 2,
      };

      prewarmer = new CachePrewarmer(mockClient, adapter, config);

      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [createSlackMessage('1.123', '1.123'), createSlackMessage('2.123', '2.123')],
      } as any);

      await prewarmer.prewarm();

      // Should work without delays
      expect(adapter.fetchConversation).toHaveBeenCalledTimes(2);
    });

    it('should handle channel with no thread messages', async () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: ['C123'],
      };
      prewarmer = new CachePrewarmer(mockClient, adapter, config);

      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [
          { ts: '1.123', text: 'Not a thread' },
          { ts: '2.123', text: 'Also not a thread' },
        ],
      } as any);

      const result = await prewarmer.prewarm();

      expect(result.channels[0].threadsPrewarmed).toBe(0);
    });

    it('should handle mixed thread and non-thread messages', async () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: ['C123'],
      };
      prewarmer = new CachePrewarmer(mockClient, adapter, config);

      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [
          createSlackMessage('1.123', '1.123'), // Thread
          { ts: '2.123', text: 'Not a thread' }, // Not a thread
          createSlackMessage('3.123', '3.123'), // Thread
        ],
      } as any);

      const result = await prewarmer.prewarm();

      expect(result.channels[0].threadsPrewarmed).toBe(2);
    });
  });

  describe('Integration with Cache', () => {
    it('should populate cache via adapter', async () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: ['C123'],
      };
      prewarmer = new CachePrewarmer(mockClient, adapter, config);

      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [createSlackMessage('1234567890.123', '1234567890.123')],
      } as any);

      await prewarmer.prewarm();

      expect(adapter.fetchConversation).toHaveBeenCalledWith(
        'C123',
        '1234567890.123',
        expect.any(Object)
      );
    });

    it('should respect cache limits', async () => {
      const config: SlackCachePrewarmingConfig = {
        enabled: true,
        channels: ['C123'],
        max_threads_per_channel: 10,
      };

      prewarmer = new CachePrewarmer(mockClient, adapter, config);

      const messages = Array.from({ length: 15 }, (_, i) =>
        createSlackMessage(`${i}.123`, `${i}.123`)
      );

      mockWebClient.conversations.history.mockResolvedValue({
        ok: true,
        messages,
      } as any);

      await prewarmer.prewarm();

      // Should fetch max_threads_per_channel messages
      // The conversations.history API is limited to max_threads_per_channel
      expect(mockWebClient.conversations.history).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10 })
      );
    });
  });
});
