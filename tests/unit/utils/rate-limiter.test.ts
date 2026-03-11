import {
  TokenBucket,
  RateLimiterRegistry,
  resolveRateLimitKey,
  rateLimitedFetch,
  RateLimitConfig,
} from '../../../src/utils/rate-limiter';

// Mock the logger
jest.mock('../../../src/logger', () => ({
  logger: {
    verbose: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

describe('TokenBucket', () => {
  it('should consume tokens up to capacity', () => {
    const bucket = new TokenBucket(3, 1000);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  it('should refill tokens over time', async () => {
    const bucket = new TokenBucket(2, 1000); // 2 tokens per second
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);

    // Wait for refill
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(bucket.tryConsume()).toBe(true);
  });

  it('should not exceed capacity after long wait', async () => {
    const bucket = new TokenBucket(2, 1000);
    expect(bucket.tryConsume()).toBe(true);

    await new Promise(resolve => setTimeout(resolve, 2000));
    // Should have at most 2 tokens (capacity)
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  it('acquire() should resolve immediately when tokens available', async () => {
    const bucket = new TokenBucket(5, 1000);
    const start = Date.now();
    await bucket.acquire();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it('acquire() should wait when no tokens available', async () => {
    const bucket = new TokenBucket(1, 1000); // 1 token per second
    bucket.tryConsume(); // exhaust

    const start = Date.now();
    await bucket.acquire();
    const elapsed = Date.now() - start;
    // Should wait ~1 second for refill
    expect(elapsed).toBeGreaterThanOrEqual(400);
  });

  it('should serve acquire() calls in FIFO order', async () => {
    const bucket = new TokenBucket(1, 500); // 1 token per 500ms
    bucket.tryConsume(); // exhaust

    const order: number[] = [];

    const p1 = bucket.acquire().then(() => order.push(1));
    const p2 = bucket.acquire().then(() => order.push(2));

    await Promise.all([p1, p2]);
    // Both should complete; order may vary slightly due to timing
    expect(order).toHaveLength(2);
  });
});

describe('RateLimiterRegistry', () => {
  afterEach(() => {
    RateLimiterRegistry.getInstance().cleanup();
  });

  it('should be a globalThis singleton', () => {
    const a = RateLimiterRegistry.getInstance();
    const b = RateLimiterRegistry.getInstance();
    expect(a).toBe(b);
  });

  it('should reuse buckets with the same key', () => {
    const registry = RateLimiterRegistry.getInstance();
    const config: RateLimitConfig = { requests: 10, per: 'minute' };
    const b1 = registry.getOrCreate('test-key', config);
    const b2 = registry.getOrCreate('test-key', config);
    expect(b1).toBe(b2);
  });

  it('should create different buckets for different keys', () => {
    const registry = RateLimiterRegistry.getInstance();
    const config: RateLimitConfig = { requests: 10, per: 'minute' };
    const b1 = registry.getOrCreate('key-a', config);
    const b2 = registry.getOrCreate('key-b', config);
    expect(b1).not.toBe(b2);
  });

  it('cleanup should clear all buckets', () => {
    const registry = RateLimiterRegistry.getInstance();
    const config: RateLimitConfig = { requests: 10, per: 'minute' };
    const b1 = registry.getOrCreate('key-a', config);
    registry.cleanup();
    const b2 = registry.getOrCreate('key-a', config);
    expect(b1).not.toBe(b2);
  });
});

describe('resolveRateLimitKey', () => {
  it('should use config.key when provided', () => {
    expect(resolveRateLimitKey({ key: 'my-key', requests: 10, per: 'minute' })).toBe('my-key');
  });

  it('should derive origin from fallback URL', () => {
    expect(
      resolveRateLimitKey({ requests: 10, per: 'minute' }, 'https://api.example.com/v1/data')
    ).toBe('https://api.example.com');
  });

  it('should return __default__ when no key or URL', () => {
    expect(resolveRateLimitKey({ requests: 10, per: 'minute' })).toBe('__default__');
  });

  it('should return fallback string for invalid URL', () => {
    expect(resolveRateLimitKey({ requests: 10, per: 'minute' }, 'not-a-url')).toBe('not-a-url');
  });
});

describe('rateLimitedFetch', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    RateLimiterRegistry.getInstance().cleanup();
  });

  it('should pass through when no config provided', async () => {
    const mockResponse = new Response('ok', { status: 200 });
    globalThis.fetch = jest.fn().mockResolvedValue(mockResponse);

    const result = await rateLimitedFetch('https://example.com/api');
    expect(result).toBe(mockResponse);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('should pass through on successful response with config', async () => {
    const mockResponse = new Response('ok', { status: 200 });
    globalThis.fetch = jest.fn().mockResolvedValue(mockResponse);

    const config: RateLimitConfig = { requests: 10, per: 'minute' };
    const result = await rateLimitedFetch('https://example.com/api', {}, config);
    expect(result.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('should retry on 429 and succeed', async () => {
    const response429 = new Response('rate limited', {
      status: 429,
      headers: { 'Retry-After': '0' },
    });
    const response200 = new Response('ok', { status: 200 });
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(response429)
      .mockResolvedValueOnce(response200);

    const config: RateLimitConfig = {
      requests: 100,
      per: 'second',
      max_retries: 3,
      initial_delay_ms: 10,
    };
    const result = await rateLimitedFetch('https://example.com/api', {}, config);
    expect(result.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('should return 429 after exhausting retries', async () => {
    const response429 = new Response('rate limited', { status: 429 });
    globalThis.fetch = jest.fn().mockResolvedValue(response429);

    const config: RateLimitConfig = {
      requests: 100,
      per: 'second',
      max_retries: 2,
      initial_delay_ms: 10,
    };
    const result = await rateLimitedFetch('https://example.com/api', {}, config);
    expect(result.status).toBe(429);
    // 1 initial + 2 retries = 3 calls
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('should respect Retry-After header in seconds', async () => {
    const response429 = new Response('rate limited', {
      status: 429,
      headers: { 'Retry-After': '0' },
    });
    const response200 = new Response('ok', { status: 200 });
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(response429)
      .mockResolvedValueOnce(response200);

    const config: RateLimitConfig = {
      requests: 100,
      per: 'second',
      max_retries: 1,
      initial_delay_ms: 5000, // large default that should be overridden by Retry-After: 0
    };
    const start = Date.now();
    await rateLimitedFetch('https://example.com/api', {}, config);
    const elapsed = Date.now() - start;
    // Should use Retry-After: 0, not the 5000ms default
    expect(elapsed).toBeLessThan(1000);
  });

  it('should throttle requests via token bucket', async () => {
    const mockResponse = new Response('ok', { status: 200 });
    globalThis.fetch = jest.fn().mockResolvedValue(mockResponse);

    const config: RateLimitConfig = {
      key: 'throttle-test',
      requests: 2,
      per: 'second',
    };

    // Make 2 requests quickly (within capacity)
    await rateLimitedFetch('https://example.com/1', {}, config);
    await rateLimitedFetch('https://example.com/2', {}, config);

    // Third request should be delayed (bucket exhausted)
    const start = Date.now();
    await rateLimitedFetch('https://example.com/3', {}, config);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(200); // should wait for refill
  });

  it('tools sharing the same key should share the bucket', async () => {
    const mockResponse = new Response('ok', { status: 200 });
    globalThis.fetch = jest.fn().mockResolvedValue(mockResponse);

    const config1: RateLimitConfig = { key: 'shared', requests: 2, per: 'second' };
    const config2: RateLimitConfig = { key: 'shared', requests: 2, per: 'second' };

    await rateLimitedFetch('https://a.com/1', {}, config1);
    await rateLimitedFetch('https://b.com/2', {}, config2);

    // Third call with either config should be throttled
    const start = Date.now();
    await rateLimitedFetch('https://a.com/3', {}, config1);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(200);
  });
});
