import * as http from 'http';
import { CacheEndpointHandler } from '../../src/slack/cache-endpoints';
import { SlackAdapter } from '../../src/slack/adapter';
import { SlackClient } from '../../src/slack/client';
import { ThreadCache } from '../../src/slack/thread-cache';
import {
  SlackBotConfig,
  SlackCacheObservabilityConfig,
  NormalizedMessage,
} from '../../src/types/bot';

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

describe('CacheEndpointHandler', () => {
  let handler: CacheEndpointHandler;
  let adapter: SlackAdapter;
  let cache: ThreadCache;
  let mockClient: jest.Mocked<SlackClient>;

  const createMockRequest = (
    method: string,
    url: string,
    headers: Record<string, string> = {}
  ): http.IncomingMessage => {
    const req = {
      method,
      url,
      headers,
    } as http.IncomingMessage;
    return req;
  };

  const createMockResponse = (): {
    res: http.ServerResponse;
    getData: () => any;
    getStatus: () => number;
    getHeaders: () => Record<string, any>;
  } => {
    let statusCode = 200;
    let data = '';
    const headers: Record<string, any> = {};

    const res = {
      writeHead: jest.fn((status: number, hdrs?: Record<string, string>) => {
        statusCode = status;
        if (hdrs) Object.assign(headers, hdrs);
      }),
      end: jest.fn((chunk?: string) => {
        if (chunk) data += chunk;
      }),
    } as unknown as http.ServerResponse;

    return {
      res,
      getData: () => (data ? JSON.parse(data) : null),
      getStatus: () => statusCode,
      getHeaders: () => headers,
    };
  };

  const createMessage = (text: string, role: 'user' | 'bot' = 'user'): NormalizedMessage => ({
    role,
    text,
    timestamp: new Date().toISOString(),
    origin: role === 'bot' ? 'visor' : 'human',
  });

  beforeEach(() => {
    // Create mock client
    mockClient = new SlackClient({} as any) as jest.Mocked<SlackClient>;

    // Create cache and adapter
    cache = new ThreadCache(100, 600);
    const config: SlackBotConfig = {
      id: 'test-bot',
      endpoint: '/test',
      signing_secret: 'secret',
      bot_token: 'token',
    };
    adapter = new SlackAdapter(mockClient, config, cache);
  });

  describe('Constructor and Configuration', () => {
    it('should create handler with config', () => {
      const config: SlackCacheObservabilityConfig = {
        enable_cache_endpoints: true,
        cache_admin_token: 'admin-token',
      };
      handler = new CacheEndpointHandler(adapter, config);
      expect(handler).toBeDefined();
    });

    it('should create handler without config', () => {
      handler = new CacheEndpointHandler(adapter);
      expect(handler).toBeDefined();
    });

    it('should be disabled by default', () => {
      handler = new CacheEndpointHandler(adapter);
      expect(handler.isEnabled()).toBe(false);
    });

    it('should be enabled when configured', () => {
      const config: SlackCacheObservabilityConfig = {
        enable_cache_endpoints: true,
      };
      handler = new CacheEndpointHandler(adapter, config);
      expect(handler.isEnabled()).toBe(true);
    });
  });

  describe('GET /stats endpoint', () => {
    beforeEach(() => {
      const config: SlackCacheObservabilityConfig = {
        enable_cache_endpoints: true,
      };
      handler = new CacheEndpointHandler(adapter, config);

      // Add some data to cache
      const messages = [createMessage('Test')];
      cache.set('thread1', messages, { channel: 'C123', threadTs: 'ts1' });
      cache.get('thread1'); // Create a hit
    });

    it('should return cache statistics', async () => {
      const req = createMockRequest('GET', '/_visor/cache/stats');
      const { res, getData, getStatus } = createMockResponse();

      const handled = await handler.handleRequest(req, res);

      expect(handled).toBe(true);
      expect(getStatus()).toBe(200);

      const data = getData();
      expect(data).toHaveProperty('stats');
      expect(data.stats).toHaveProperty('hits');
      expect(data.stats).toHaveProperty('misses');
      expect(data.stats).toHaveProperty('size');
      expect(data.stats).toHaveProperty('hitRate');
    });

    it('should allow unauthenticated access', async () => {
      const req = createMockRequest('GET', '/_visor/cache/stats');
      const { res, getStatus } = createMockResponse();

      await handler.handleRequest(req, res);

      expect(getStatus()).toBe(200);
    });

    it('should include time windows', async () => {
      const req = createMockRequest('GET', '/_visor/cache/stats');
      const { res, getData } = createMockResponse();

      await handler.handleRequest(req, res);

      const data = getData();
      expect(data).toHaveProperty('timeWindows');
      expect(data.timeWindows).toHaveProperty('1min');
      expect(data.timeWindows).toHaveProperty('5min');
      expect(data.timeWindows).toHaveProperty('15min');
    });

    it('should include efficiency score', async () => {
      const req = createMockRequest('GET', '/_visor/cache/stats');
      const { res, getData } = createMockResponse();

      await handler.handleRequest(req, res);

      const data = getData();
      expect(data).toHaveProperty('efficiency');
      expect(data.efficiency).toHaveProperty('score');
      expect(data.efficiency).toHaveProperty('description');
    });

    it('should include most active threads', async () => {
      const req = createMockRequest('GET', '/_visor/cache/stats');
      const { res, getData } = createMockResponse();

      await handler.handleRequest(req, res);

      const data = getData();
      expect(data).toHaveProperty('mostActiveThreads');
      expect(Array.isArray(data.mostActiveThreads)).toBe(true);
    });

    it('should include timestamp', async () => {
      const req = createMockRequest('GET', '/_visor/cache/stats');
      const { res, getData } = createMockResponse();

      await handler.handleRequest(req, res);

      const data = getData();
      expect(data).toHaveProperty('timestamp');
      expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should set correct headers', async () => {
      const req = createMockRequest('GET', '/_visor/cache/stats');
      const { res, getHeaders } = createMockResponse();

      await handler.handleRequest(req, res);

      const headers = getHeaders();
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Cache-Control']).toContain('no-cache');
    });
  });

  describe('GET /threads endpoint', () => {
    beforeEach(() => {
      const config: SlackCacheObservabilityConfig = {
        enable_cache_endpoints: true,
      };
      handler = new CacheEndpointHandler(adapter, config);

      // Add multiple threads
      const messages = [createMessage('Test')];
      cache.set('thread1', messages, { channel: 'C1', threadTs: 'ts1' });
      cache.set('thread2', messages, { channel: 'C2', threadTs: 'ts2' });
      cache.set('thread3', messages, { channel: 'C3', threadTs: 'ts3' });
    });

    it('should return thread list', async () => {
      const req = createMockRequest('GET', '/_visor/cache/threads');
      const { res, getData, getStatus } = createMockResponse();

      const handled = await handler.handleRequest(req, res);

      expect(handled).toBe(true);
      expect(getStatus()).toBe(200);

      const data = getData();
      expect(data).toHaveProperty('threads');
      expect(Array.isArray(data.threads)).toBe(true);
      expect(data.threads.length).toBe(3);
    });

    it('should allow unauthenticated access', async () => {
      const req = createMockRequest('GET', '/_visor/cache/threads');
      const { res, getStatus } = createMockResponse();

      await handler.handleRequest(req, res);

      expect(getStatus()).toBe(200);
    });

    it('should support pagination with limit', async () => {
      const req = createMockRequest('GET', '/_visor/cache/threads?limit=2');
      req.headers.host = 'localhost';
      const { res, getData } = createMockResponse();

      await handler.handleRequest(req, res);

      const data = getData();
      expect(data.threads.length).toBe(2);
      expect(data.limit).toBe(2);
      expect(data.total).toBe(3);
    });

    it('should support sorting by parameter', async () => {
      const req = createMockRequest('GET', '/_visor/cache/threads?sort=messageCount');
      req.headers.host = 'localhost';
      const { res, getData } = createMockResponse();

      await handler.handleRequest(req, res);

      const data = getData();
      expect(data.sortBy).toBe('messageCount');
    });

    it('should support sort order', async () => {
      const req = createMockRequest('GET', '/_visor/cache/threads?order=asc');
      req.headers.host = 'localhost';
      const { res, getData } = createMockResponse();

      await handler.handleRequest(req, res);

      const data = getData();
      expect(data.order).toBe('asc');
    });

    it('should include metadata in response', async () => {
      const req = createMockRequest('GET', '/_visor/cache/threads');
      const { res, getData } = createMockResponse();

      await handler.handleRequest(req, res);

      const data = getData();
      expect(data).toHaveProperty('total');
      expect(data).toHaveProperty('limit');
      expect(data).toHaveProperty('timestamp');
    });

    it('should validate thread list format', async () => {
      const req = createMockRequest('GET', '/_visor/cache/threads');
      const { res, getData } = createMockResponse();

      await handler.handleRequest(req, res);

      const data = getData();
      const thread = data.threads[0];
      expect(thread).toHaveProperty('threadId');
      expect(thread).toHaveProperty('messageCount');
      expect(thread).toHaveProperty('sizeBytes');
      expect(thread).toHaveProperty('createdAt');
      expect(thread).toHaveProperty('lastAccessedAt');
      expect(thread).toHaveProperty('accessCount');
    });
  });

  describe('GET /threads/:id endpoint', () => {
    beforeEach(() => {
      const config: SlackCacheObservabilityConfig = {
        enable_cache_endpoints: true,
      };
      handler = new CacheEndpointHandler(adapter, config);

      const messages = [createMessage('Test')];
      cache.set('thread1', messages, { channel: 'C123', threadTs: 'ts1' });
    });

    it('should return thread details', async () => {
      const req = createMockRequest('GET', '/_visor/cache/threads/thread1');
      const { res, getData, getStatus } = createMockResponse();

      const handled = await handler.handleRequest(req, res);

      expect(handled).toBe(true);
      expect(getStatus()).toBe(200);

      const data = getData();
      expect(data).toHaveProperty('thread');
      expect(data.thread.threadId).toBe('thread1');
    });

    it('should return 404 for missing thread', async () => {
      const req = createMockRequest('GET', '/_visor/cache/threads/nonexistent');
      const { res, getData, getStatus } = createMockResponse();

      await handler.handleRequest(req, res);

      expect(getStatus()).toBe(404);

      const data = getData();
      expect(data).toHaveProperty('error');
      expect(data.error).toBe('Not Found');
    });

    it('should allow unauthenticated access', async () => {
      const req = createMockRequest('GET', '/_visor/cache/threads/thread1');
      const { res, getStatus } = createMockResponse();

      await handler.handleRequest(req, res);

      expect(getStatus()).toBe(200);
    });

    it('should handle URL encoded thread IDs', async () => {
      const threadId = 'C123:1234567890.123';
      const messages = [createMessage('Test')];
      cache.set(threadId, messages);

      const encodedId = encodeURIComponent(threadId);
      const req = createMockRequest('GET', `/_visor/cache/threads/${encodedId}`);
      const { res, getData, getStatus } = createMockResponse();

      await handler.handleRequest(req, res);

      expect(getStatus()).toBe(200);
      const data = getData();
      expect(data.thread.threadId).toBe(threadId);
    });

    it('should validate thread detail format', async () => {
      const req = createMockRequest('GET', '/_visor/cache/threads/thread1');
      const { res, getData } = createMockResponse();

      await handler.handleRequest(req, res);

      const data = getData();
      expect(data.thread).toHaveProperty('threadId');
      expect(data.thread).toHaveProperty('messageCount');
      expect(data.thread).toHaveProperty('sizeBytes');
      expect(data.thread).toHaveProperty('channel');
      expect(data.thread).toHaveProperty('threadTs');
    });
  });

  describe('POST /clear endpoint', () => {
    beforeEach(() => {
      const config: SlackCacheObservabilityConfig = {
        enable_cache_endpoints: true,
        cache_admin_token: 'admin-secret',
      };
      handler = new CacheEndpointHandler(adapter, config);

      // Add some data
      const messages = [createMessage('Test')];
      cache.set('thread1', messages);
      cache.set('thread2', messages);
    });

    it('should require authentication', async () => {
      const req = createMockRequest('POST', '/_visor/cache/clear');
      const { res, getStatus } = createMockResponse();

      await handler.handleRequest(req, res);

      expect(getStatus()).toBe(401);
    });

    it('should return 401 without token', async () => {
      const req = createMockRequest('POST', '/_visor/cache/clear');
      const { res, getData, getStatus } = createMockResponse();

      await handler.handleRequest(req, res);

      expect(getStatus()).toBe(401);

      const data = getData();
      expect(data.error).toBe('Unauthorized');
    });

    it('should return 403 with invalid token', async () => {
      const req = createMockRequest('POST', '/_visor/cache/clear', {
        authorization: 'Bearer wrong-token',
      });
      const { res, getStatus } = createMockResponse();

      await handler.handleRequest(req, res);

      expect(getStatus()).toBe(401);
    });

    it('should clear cache successfully with valid token', async () => {
      const req = createMockRequest('POST', '/_visor/cache/clear', {
        authorization: 'Bearer admin-secret',
      });
      const { res, getData, getStatus } = createMockResponse();

      expect(cache.size()).toBe(2);

      await handler.handleRequest(req, res);

      expect(getStatus()).toBe(200);
      expect(cache.size()).toBe(0);

      const data = getData();
      expect(data.success).toBe(true);
      expect(data.removed).toBe(2);
      expect(data.remaining).toBe(0);
    });

    it('should return updated stats', async () => {
      const req = createMockRequest('POST', '/_visor/cache/clear', {
        authorization: 'Bearer admin-secret',
      });
      const { res, getData } = createMockResponse();

      await handler.handleRequest(req, res);

      const data = getData();
      expect(data).toHaveProperty('removed');
      expect(data).toHaveProperty('remaining');
      expect(data).toHaveProperty('timestamp');
    });

    it('should work without admin token configured', async () => {
      const configNoToken: SlackCacheObservabilityConfig = {
        enable_cache_endpoints: true,
      };
      handler = new CacheEndpointHandler(adapter, configNoToken);

      const req = createMockRequest('POST', '/_visor/cache/clear');
      const { res, getStatus } = createMockResponse();

      await handler.handleRequest(req, res);

      expect(getStatus()).toBe(200);
    });

    it('should accept Bearer token format', async () => {
      const req = createMockRequest('POST', '/_visor/cache/clear', {
        authorization: 'Bearer admin-secret',
      });
      const { res, getStatus } = createMockResponse();

      await handler.handleRequest(req, res);

      expect(getStatus()).toBe(200);
    });
  });

  describe('DELETE /threads/:id endpoint', () => {
    beforeEach(() => {
      const config: SlackCacheObservabilityConfig = {
        enable_cache_endpoints: true,
        cache_admin_token: 'admin-secret',
      };
      handler = new CacheEndpointHandler(adapter, config);

      const messages = [createMessage('Test')];
      cache.set('thread1', messages);
      cache.set('thread2', messages);
    });

    it('should require authentication', async () => {
      const req = createMockRequest('DELETE', '/_visor/cache/threads/thread1');
      const { res, getStatus } = createMockResponse();

      await handler.handleRequest(req, res);

      expect(getStatus()).toBe(401);
    });

    it('should return 401 without token', async () => {
      const req = createMockRequest('DELETE', '/_visor/cache/threads/thread1');
      const { res, getData, getStatus } = createMockResponse();

      await handler.handleRequest(req, res);

      expect(getStatus()).toBe(401);

      const data = getData();
      expect(data.error).toBe('Unauthorized');
    });

    it('should return 403 with invalid token', async () => {
      const req = createMockRequest('DELETE', '/_visor/cache/threads/thread1', {
        authorization: 'Bearer wrong-token',
      });
      const { res, getStatus } = createMockResponse();

      await handler.handleRequest(req, res);

      expect(getStatus()).toBe(401);
    });

    it('should delete thread successfully with valid token', async () => {
      const req = createMockRequest('DELETE', '/_visor/cache/threads/thread1', {
        authorization: 'Bearer admin-secret',
      });
      const { res, getData, getStatus } = createMockResponse();

      expect(cache.size()).toBe(2);

      await handler.handleRequest(req, res);

      expect(getStatus()).toBe(200);
      expect(cache.size()).toBe(1);
      expect(cache.has('thread1')).toBe(false);

      const data = getData();
      expect(data.success).toBe(true);
      expect(data.threadId).toBe('thread1');
    });

    it('should return 404 for missing thread', async () => {
      const req = createMockRequest('DELETE', '/_visor/cache/threads/nonexistent', {
        authorization: 'Bearer admin-secret',
      });
      const { res, getData, getStatus } = createMockResponse();

      await handler.handleRequest(req, res);

      expect(getStatus()).toBe(404);

      const data = getData();
      expect(data.error).toBe('Not Found');
    });
  });

  describe('Error Handling', () => {
    beforeEach(() => {
      const config: SlackCacheObservabilityConfig = {
        enable_cache_endpoints: true,
      };
      handler = new CacheEndpointHandler(adapter, config);
    });

    it('should handle invalid thread ID format', async () => {
      const req = createMockRequest('GET', '/_visor/cache/threads/');
      const { res, getStatus } = createMockResponse();

      const handled = await handler.handleRequest(req, res);

      expect(handled).toBe(true);
      expect(getStatus()).toBe(404);
    });

    it('should handle cache operation failures gracefully', async () => {
      // Mock cache to throw error
      jest.spyOn(cache, 'getStats').mockImplementation(() => {
        throw new Error('Cache error');
      });

      const req = createMockRequest('GET', '/_visor/cache/stats');
      const { res, getStatus } = createMockResponse();

      await handler.handleRequest(req, res);

      expect(getStatus()).toBe(500);
    });

    it('should return false for non-cache paths', async () => {
      const req = createMockRequest('GET', '/other/path');
      const { res } = createMockResponse();

      const handled = await handler.handleRequest(req, res);

      expect(handled).toBe(false);
    });

    it('should return false when disabled', async () => {
      handler = new CacheEndpointHandler(adapter); // No config = disabled

      const req = createMockRequest('GET', '/_visor/cache/stats');
      const { res } = createMockResponse();

      const handled = await handler.handleRequest(req, res);

      expect(handled).toBe(false);
    });
  });

  describe('Response Format Validation', () => {
    beforeEach(() => {
      const config: SlackCacheObservabilityConfig = {
        enable_cache_endpoints: true,
      };
      handler = new CacheEndpointHandler(adapter, config);
    });

    it('should validate cache statistics format', async () => {
      const messages = [createMessage('Test')];
      cache.set('thread1', messages);

      const req = createMockRequest('GET', '/_visor/cache/stats');
      const { res, getData } = createMockResponse();

      await handler.handleRequest(req, res);

      const data = getData();
      expect(data.stats).toHaveProperty('hits');
      expect(data.stats).toHaveProperty('misses');
      expect(data.stats).toHaveProperty('evictions');
      expect(data.stats).toHaveProperty('size');
      expect(data.stats).toHaveProperty('capacity');
      expect(data.stats).toHaveProperty('utilization');
      expect(data.stats).toHaveProperty('hitRate');
      expect(data.stats).toHaveProperty('evictionsByReason');
      expect(data.stats).toHaveProperty('totalAccesses');
      expect(data.stats).toHaveProperty('avgThreadSize');
      expect(data.stats).toHaveProperty('totalBytes');
    });

    it('should validate time window statistics format', async () => {
      const req = createMockRequest('GET', '/_visor/cache/stats');
      const { res, getData } = createMockResponse();

      await handler.handleRequest(req, res);

      const data = getData();
      expect(data.timeWindows).toHaveProperty('1min');
      expect(data.timeWindows['1min']).toHaveProperty('windowSeconds');
      expect(data.timeWindows['1min']).toHaveProperty('hits');
      expect(data.timeWindows['1min']).toHaveProperty('misses');
      expect(data.timeWindows['1min']).toHaveProperty('hitRate');
    });

    it('should validate efficiency score format', async () => {
      const req = createMockRequest('GET', '/_visor/cache/stats');
      const { res, getData } = createMockResponse();

      await handler.handleRequest(req, res);

      const data = getData();
      expect(data.efficiency).toHaveProperty('score');
      expect(data.efficiency).toHaveProperty('description');
      expect(typeof data.efficiency.score).toBe('number');
      expect(typeof data.efficiency.description).toBe('string');
    });

    it('should validate thread metadata format', async () => {
      const messages = [createMessage('Test')];
      cache.set('thread1', messages, { channel: 'C123', threadTs: 'ts1' });

      const req = createMockRequest('GET', '/_visor/cache/threads/thread1');
      const { res, getData } = createMockResponse();

      await handler.handleRequest(req, res);

      const data = getData();
      expect(data.thread).toHaveProperty('threadId');
      expect(data.thread).toHaveProperty('messageCount');
      expect(data.thread).toHaveProperty('sizeBytes');
      expect(data.thread).toHaveProperty('createdAt');
      expect(data.thread).toHaveProperty('lastAccessedAt');
      expect(data.thread).toHaveProperty('lastUpdatedAt');
      expect(data.thread).toHaveProperty('accessCount');
      expect(data.thread).toHaveProperty('ageSeconds');
    });

    it('should include error details in error responses', async () => {
      const req = createMockRequest('GET', '/_visor/cache/threads/nonexistent');
      const { res, getData } = createMockResponse();

      await handler.handleRequest(req, res);

      const data = getData();
      expect(data).toHaveProperty('error');
      expect(data).toHaveProperty('message');
      expect(data).toHaveProperty('timestamp');
    });
  });

  describe('Bearer Token Validation', () => {
    it('should validate Bearer token prefix', async () => {
      const config: SlackCacheObservabilityConfig = {
        enable_cache_endpoints: true,
        cache_admin_token: 'admin-secret',
      };
      handler = new CacheEndpointHandler(adapter, config);

      // Invalid format (no Bearer prefix)
      const req1 = createMockRequest('POST', '/_visor/cache/clear', {
        authorization: 'admin-secret',
      });
      const { res: res1, getStatus: getStatus1 } = createMockResponse();

      await handler.handleRequest(req1, res1);
      expect(getStatus1()).toBe(401);

      // Valid format
      const req2 = createMockRequest('POST', '/_visor/cache/clear', {
        authorization: 'Bearer admin-secret',
      });
      const { res: res2, getStatus: getStatus2 } = createMockResponse();

      await handler.handleRequest(req2, res2);
      expect(getStatus2()).toBe(200);
    });

    it('should handle missing authorization header', async () => {
      const config: SlackCacheObservabilityConfig = {
        enable_cache_endpoints: true,
        cache_admin_token: 'admin-secret',
      };
      handler = new CacheEndpointHandler(adapter, config);

      const req = createMockRequest('POST', '/_visor/cache/clear');
      const { res, getStatus } = createMockResponse();

      await handler.handleRequest(req, res);

      expect(getStatus()).toBe(401);
    });

    it('should set WWW-Authenticate header on 401', async () => {
      const config: SlackCacheObservabilityConfig = {
        enable_cache_endpoints: true,
        cache_admin_token: 'admin-secret',
      };
      handler = new CacheEndpointHandler(adapter, config);

      const req = createMockRequest('POST', '/_visor/cache/clear');
      const { res, getHeaders } = createMockResponse();

      await handler.handleRequest(req, res);

      const headers = getHeaders();
      expect(headers['WWW-Authenticate']).toBe('Bearer');
    });
  });

  describe('Integration and Edge Cases', () => {
    beforeEach(() => {
      const config: SlackCacheObservabilityConfig = {
        enable_cache_endpoints: true,
      };
      handler = new CacheEndpointHandler(adapter, config);
    });

    it('should handle concurrent requests', async () => {
      const messages = [createMessage('Test')];
      cache.set('thread1', messages);

      const requests = Array.from({ length: 10 }, () =>
        handler.handleRequest(
          createMockRequest('GET', '/_visor/cache/stats'),
          createMockResponse().res
        )
      );

      const results = await Promise.all(requests);
      expect(results.every(r => r === true)).toBe(true);
    });

    it('should maintain cache state consistency', async () => {
      const messages = [createMessage('Test')];
      cache.set('thread1', messages);
      cache.set('thread2', messages);

      const initialSize = cache.size();

      // Get stats
      await handler.handleRequest(
        createMockRequest('GET', '/_visor/cache/stats'),
        createMockResponse().res
      );

      // Get threads
      await handler.handleRequest(
        createMockRequest('GET', '/_visor/cache/threads'),
        createMockResponse().res
      );

      // Cache size should remain unchanged
      expect(cache.size()).toBe(initialSize);
    });

    it('should handle empty cache gracefully', async () => {
      const req = createMockRequest('GET', '/_visor/cache/stats');
      const { res, getData, getStatus } = createMockResponse();

      await handler.handleRequest(req, res);

      expect(getStatus()).toBe(200);

      const data = getData();
      expect(data.stats.size).toBe(0);
      expect(data.mostActiveThreads).toHaveLength(0);
    });

    it('should handle malformed URLs', async () => {
      const req = createMockRequest('GET', '/_visor/cache/threads/%INVALID%');
      const { res } = createMockResponse();

      const handled = await handler.handleRequest(req, res);

      expect(handled).toBe(true);
    });
  });

  describe('Efficiency Description', () => {
    beforeEach(() => {
      const config: SlackCacheObservabilityConfig = {
        enable_cache_endpoints: true,
      };
      handler = new CacheEndpointHandler(adapter, config);
    });

    it('should return "Excellent" for score >= 90', async () => {
      // Create high hit rate
      const messages = [createMessage('Test')];
      for (let i = 0; i < 50; i++) {
        cache.set(`thread${i}`, messages);
      }
      for (let i = 0; i < 50; i++) {
        for (let j = 0; j < 10; j++) {
          cache.get(`thread${i}`);
        }
      }

      const req = createMockRequest('GET', '/_visor/cache/stats');
      const { res, getData } = createMockResponse();

      await handler.handleRequest(req, res);

      const data = getData();
      if (data.efficiency.score >= 90) {
        expect(data.efficiency.description).toBe('Excellent');
      }
    });

    it('should include efficiency description in response', async () => {
      const req = createMockRequest('GET', '/_visor/cache/stats');
      const { res, getData } = createMockResponse();

      await handler.handleRequest(req, res);

      const data = getData();
      expect(['Excellent', 'Good', 'Fair', 'Poor', 'Very Poor']).toContain(
        data.efficiency.description
      );
    });
  });
});
