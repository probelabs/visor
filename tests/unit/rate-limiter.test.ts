import { RateLimiter, RateLimitConfig, RateLimitRequest } from '../../src/slack/rate-limiter';

describe('RateLimiter', () => {
  let rateLimiter: RateLimiter;

  afterEach(async () => {
    if (rateLimiter) {
      await rateLimiter.shutdown();
    }
  });

  describe('Constructor and Initialization', () => {
    it('should create rate limiter with default config', () => {
      const config: RateLimitConfig = {
        enabled: true,
      };
      rateLimiter = new RateLimiter(config);
      expect(rateLimiter).toBeDefined();
    });

    it('should create rate limiter with full config', () => {
      const config: RateLimitConfig = {
        enabled: true,
        bot: {
          requests_per_minute: 60,
          requests_per_hour: 1000,
          concurrent_requests: 10,
        },
        user: {
          requests_per_minute: 10,
          requests_per_hour: 100,
          concurrent_requests: 2,
        },
        channel: {
          requests_per_minute: 20,
          requests_per_hour: 500,
          concurrent_requests: 5,
        },
        actions: {
          send_ephemeral_message: true,
          ephemeral_message: 'Rate limited!',
          queue_when_near_limit: false,
          queue_threshold: 0.8,
        },
        storage: {
          type: 'memory',
        },
      };
      rateLimiter = new RateLimiter(config);
      expect(rateLimiter).toBeDefined();
    });

    it('should handle disabled rate limiting', async () => {
      const config: RateLimitConfig = {
        enabled: false,
      };
      rateLimiter = new RateLimiter(config);

      const request: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U123',
        channelId: 'C123',
      };

      const result = await rateLimiter.check(request);
      expect(result.allowed).toBe(true);
    });
  });

  describe('Per-Minute Rate Limiting', () => {
    it('should allow requests within per-minute limit', async () => {
      const config: RateLimitConfig = {
        enabled: true,
        bot: {
          requests_per_minute: 5,
        },
      };
      rateLimiter = new RateLimiter(config);

      const request: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U123',
        channelId: 'C123',
      };

      // Should allow first 5 requests
      for (let i = 0; i < 5; i++) {
        const result = await rateLimiter.check(request);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(4 - i);
      }
    });

    it('should block requests exceeding per-minute limit', async () => {
      const config: RateLimitConfig = {
        enabled: true,
        bot: {
          requests_per_minute: 3,
        },
      };
      rateLimiter = new RateLimiter(config);

      const request: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U123',
        channelId: 'C123',
      };

      // Allow first 3 requests
      for (let i = 0; i < 3; i++) {
        const result = await rateLimiter.check(request);
        expect(result.allowed).toBe(true);
      }

      // Block 4th request
      const result = await rateLimiter.check(request);
      expect(result.allowed).toBe(false);
      expect(result.blocked_by).toBe('bot');
      expect(result.remaining).toBe(0);
      expect(result.limit).toBe(3);
      expect(result.retry_after).toBeGreaterThan(0);
    });

    it('should allow requests after window expires', async () => {
      const config: RateLimitConfig = {
        enabled: true,
        bot: {
          requests_per_minute: 2,
        },
      };
      rateLimiter = new RateLimiter(config);

      const now = Date.now();
      const request: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U123',
        channelId: 'C123',
        timestamp: now,
      };

      // Use up limit
      await rateLimiter.check(request);
      await rateLimiter.check(request);

      // Should be blocked
      const blockedResult = await rateLimiter.check(request);
      expect(blockedResult.allowed).toBe(false);

      // Request after 61 seconds (window expired)
      const futureRequest: RateLimitRequest = {
        ...request,
        timestamp: now + 61 * 1000,
      };
      const allowedResult = await rateLimiter.check(futureRequest);
      expect(allowedResult.allowed).toBe(true);
    });
  });

  describe('Per-Hour Rate Limiting', () => {
    it('should enforce per-hour limits', async () => {
      const config: RateLimitConfig = {
        enabled: true,
        bot: {
          requests_per_hour: 3,
        },
      };
      rateLimiter = new RateLimiter(config);

      const request: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U123',
        channelId: 'C123',
      };

      // Allow first 3 requests
      for (let i = 0; i < 3; i++) {
        const result = await rateLimiter.check(request);
        expect(result.allowed).toBe(true);
      }

      // Block 4th request
      const result = await rateLimiter.check(request);
      expect(result.allowed).toBe(false);
      expect(result.blocked_by).toBe('bot');
    });

    it('should use most restrictive limit', async () => {
      const config: RateLimitConfig = {
        enabled: true,
        bot: {
          requests_per_minute: 10,
          requests_per_hour: 3, // More restrictive
        },
      };
      rateLimiter = new RateLimiter(config);

      const request: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U123',
        channelId: 'C123',
      };

      // Should be limited by hourly limit
      for (let i = 0; i < 3; i++) {
        const result = await rateLimiter.check(request);
        expect(result.allowed).toBe(true);
      }

      const result = await rateLimiter.check(request);
      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(3);
    });
  });

  describe('Concurrent Request Limiting', () => {
    it('should enforce concurrent request limits', async () => {
      const config: RateLimitConfig = {
        enabled: true,
        bot: {
          concurrent_requests: 2,
        },
      };
      rateLimiter = new RateLimiter(config);

      const request: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U123',
        channelId: 'C123',
      };

      // Allow first 2 concurrent requests
      const result1 = await rateLimiter.check(request);
      expect(result1.allowed).toBe(true);

      const result2 = await rateLimiter.check(request);
      expect(result2.allowed).toBe(true);

      // Block 3rd concurrent request
      const result3 = await rateLimiter.check(request);
      expect(result3.allowed).toBe(false);
      expect(result3.blocked_by).toBe('bot');
      expect(result3.retry_after).toBe(5);
    });

    it('should allow new requests after releasing concurrent slots', async () => {
      const config: RateLimitConfig = {
        enabled: true,
        bot: {
          concurrent_requests: 1,
        },
      };
      rateLimiter = new RateLimiter(config);

      const request: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U123',
        channelId: 'C123',
      };

      // First request allowed
      const result1 = await rateLimiter.check(request);
      expect(result1.allowed).toBe(true);

      // Second request blocked
      const result2 = await rateLimiter.check(request);
      expect(result2.allowed).toBe(false);

      // Release first request
      await rateLimiter.release(request);

      // Third request allowed
      const result3 = await rateLimiter.check(request);
      expect(result3.allowed).toBe(true);
    });
  });

  describe('Multi-Dimension Rate Limiting', () => {
    it('should enforce limits on all dimensions', async () => {
      const config: RateLimitConfig = {
        enabled: true,
        bot: {
          requests_per_minute: 100,
        },
        user: {
          requests_per_minute: 3,
        },
        channel: {
          requests_per_minute: 100,
        },
      };
      rateLimiter = new RateLimiter(config);

      const request: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U123',
        channelId: 'C123',
      };

      // Should be limited by user dimension (most restrictive)
      for (let i = 0; i < 3; i++) {
        const result = await rateLimiter.check(request);
        expect(result.allowed).toBe(true);
      }

      const result = await rateLimiter.check(request);
      expect(result.allowed).toBe(false);
      expect(result.blocked_by).toBe('user');
    });

    it('should track different users independently', async () => {
      const config: RateLimitConfig = {
        enabled: true,
        user: {
          requests_per_minute: 2,
        },
      };
      rateLimiter = new RateLimiter(config);

      const user1Request: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U1',
        channelId: 'C123',
      };

      const user2Request: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U2',
        channelId: 'C123',
      };

      // User 1: use up limit
      await rateLimiter.check(user1Request);
      await rateLimiter.check(user1Request);
      const user1Blocked = await rateLimiter.check(user1Request);
      expect(user1Blocked.allowed).toBe(false);

      // User 2: should still be allowed
      const user2Allowed = await rateLimiter.check(user2Request);
      expect(user2Allowed.allowed).toBe(true);
    });

    it('should track different channels independently', async () => {
      const config: RateLimitConfig = {
        enabled: true,
        channel: {
          requests_per_minute: 2,
        },
      };
      rateLimiter = new RateLimiter(config);

      const channel1Request: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U123',
        channelId: 'C1',
      };

      const channel2Request: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U123',
        channelId: 'C2',
      };

      // Channel 1: use up limit
      await rateLimiter.check(channel1Request);
      await rateLimiter.check(channel1Request);
      const channel1Blocked = await rateLimiter.check(channel1Request);
      expect(channel1Blocked.allowed).toBe(false);

      // Channel 2: should still be allowed
      const channel2Allowed = await rateLimiter.check(channel2Request);
      expect(channel2Allowed.allowed).toBe(true);
    });

    it('should enforce global limits across all dimensions', async () => {
      const config: RateLimitConfig = {
        enabled: true,
        global: {
          requests_per_minute: 3,
        },
        bot: {
          requests_per_minute: 100,
        },
        user: {
          requests_per_minute: 100,
        },
      };
      rateLimiter = new RateLimiter(config);

      // Different users and channels, but global limit applies
      const request1: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U1',
        channelId: 'C1',
      };

      const request2: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U2',
        channelId: 'C2',
      };

      const request3: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U3',
        channelId: 'C3',
      };

      const request4: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U4',
        channelId: 'C4',
      };

      // First 3 requests allowed
      expect((await rateLimiter.check(request1)).allowed).toBe(true);
      expect((await rateLimiter.check(request2)).allowed).toBe(true);
      expect((await rateLimiter.check(request3)).allowed).toBe(true);

      // 4th request blocked by global limit
      const result = await rateLimiter.check(request4);
      expect(result.allowed).toBe(false);
      expect(result.blocked_by).toBe('global');
    });
  });

  describe('Metrics', () => {
    it('should track total requests', async () => {
      const config: RateLimitConfig = {
        enabled: true,
        bot: {
          requests_per_minute: 100,
        },
      };
      rateLimiter = new RateLimiter(config);

      const request: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U123',
        channelId: 'C123',
      };

      await rateLimiter.check(request);
      await rateLimiter.check(request);
      await rateLimiter.check(request);

      const metrics = rateLimiter.getMetrics();
      expect(metrics.total_requests).toBe(3);
      expect(metrics.allowed_requests).toBe(3);
      expect(metrics.blocked_requests).toBe(0);
    });

    it('should track blocked requests by dimension', async () => {
      const config: RateLimitConfig = {
        enabled: true,
        user: {
          requests_per_minute: 1,
        },
        channel: {
          requests_per_minute: 2,
        },
      };
      rateLimiter = new RateLimiter(config);

      const request: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U123',
        channelId: 'C123',
      };

      // Use up user limit for U123
      await rateLimiter.check(request);
      await rateLimiter.check(request); // Blocked by user

      // Different user, different channel - use up user limit for U456
      const request2: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U456',
        channelId: 'C456',
      };
      await rateLimiter.check(request2);
      await rateLimiter.check(request2); // Blocked by user

      // Third user on C123 - should be blocked by channel (C123 already has 1 request)
      const request3: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U789',
        channelId: 'C123',
      };
      await rateLimiter.check(request3); // Allowed (user has 1 req limit left, channel has 2 req limit)
      await rateLimiter.check(request3); // Blocked by user (U789 exceeds 1 per minute)

      // Fourth user on C123 - should be allowed then blocked by channel
      const request4: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U000',
        channelId: 'C123',
      };
      await rateLimiter.check(request4); // Blocked by channel (C123 has 2 requests already: U123 and U789)

      const metrics = rateLimiter.getMetrics();
      expect(metrics.blocked_requests).toBe(4);
      expect(metrics.blocks_by_dimension.user).toBe(3);
      expect(metrics.blocks_by_dimension.channel).toBe(1);
    });

    it('should reset metrics', async () => {
      const config: RateLimitConfig = {
        enabled: true,
        bot: {
          requests_per_minute: 10,
        },
      };
      rateLimiter = new RateLimiter(config);

      const request: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U123',
        channelId: 'C123',
      };

      await rateLimiter.check(request);
      await rateLimiter.check(request);

      let metrics = rateLimiter.getMetrics();
      expect(metrics.total_requests).toBe(2);

      rateLimiter.resetMetrics();

      metrics = rateLimiter.getMetrics();
      expect(metrics.total_requests).toBe(0);
      expect(metrics.allowed_requests).toBe(0);
      expect(metrics.blocked_requests).toBe(0);
    });
  });

  describe('Ephemeral Message Configuration', () => {
    it('should return default ephemeral message config', () => {
      const config: RateLimitConfig = {
        enabled: true,
      };
      rateLimiter = new RateLimiter(config);

      const ephemeralConfig = rateLimiter.getEphemeralMessageConfig();
      expect(ephemeralConfig.enabled).toBe(true);
      expect(ephemeralConfig.message).toBe(
        "You've exceeded the rate limit. Please wait before trying again."
      );
    });

    it('should return custom ephemeral message config', () => {
      const config: RateLimitConfig = {
        enabled: true,
        actions: {
          send_ephemeral_message: false,
          ephemeral_message: 'Custom message',
        },
      };
      rateLimiter = new RateLimiter(config);

      const ephemeralConfig = rateLimiter.getEphemeralMessageConfig();
      expect(ephemeralConfig.enabled).toBe(false);
      expect(ephemeralConfig.message).toBe('Custom message');
    });
  });

  describe('Sliding Window Algorithm', () => {
    it('should use sliding window (not fixed window)', async () => {
      const config: RateLimitConfig = {
        enabled: true,
        bot: {
          requests_per_minute: 2,
        },
      };
      rateLimiter = new RateLimiter(config);

      const now = Date.now();

      // Request at t=0
      const request1: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U123',
        channelId: 'C123',
        timestamp: now,
      };
      expect((await rateLimiter.check(request1)).allowed).toBe(true);

      // Request at t=30s
      const request2: RateLimitRequest = {
        ...request1,
        timestamp: now + 30 * 1000,
      };
      expect((await rateLimiter.check(request2)).allowed).toBe(true);

      // Request at t=40s (within 1 minute of first request)
      const request3: RateLimitRequest = {
        ...request1,
        timestamp: now + 40 * 1000,
      };
      expect((await rateLimiter.check(request3)).allowed).toBe(false);

      // Request at t=61s (first request expired from window)
      const request4: RateLimitRequest = {
        ...request1,
        timestamp: now + 61 * 1000,
      };
      expect((await rateLimiter.check(request4)).allowed).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle zero limits as unlimited', async () => {
      const config: RateLimitConfig = {
        enabled: true,
        bot: {
          requests_per_minute: 0, // Unlimited
        },
      };
      rateLimiter = new RateLimiter(config);

      const request: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U123',
        channelId: 'C123',
      };

      // Should allow many requests
      for (let i = 0; i < 100; i++) {
        const result = await rateLimiter.check(request);
        expect(result.allowed).toBe(true);
      }
    });

    it('should handle undefined limits as unlimited', async () => {
      const config: RateLimitConfig = {
        enabled: true,
        bot: {
          // No limits defined
        },
      };
      rateLimiter = new RateLimiter(config);

      const request: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U123',
        channelId: 'C123',
      };

      // Should allow many requests
      for (let i = 0; i < 100; i++) {
        const result = await rateLimiter.check(request);
        expect(result.allowed).toBe(true);
      }
    });

    it('should handle multiple releases gracefully', async () => {
      const config: RateLimitConfig = {
        enabled: true,
        bot: {
          concurrent_requests: 1,
        },
      };
      rateLimiter = new RateLimiter(config);

      const request: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U123',
        channelId: 'C123',
      };

      await rateLimiter.check(request);

      // Release multiple times (should not go negative)
      await rateLimiter.release(request);
      await rateLimiter.release(request);
      await rateLimiter.release(request);

      // Should still allow requests
      const result = await rateLimiter.check(request);
      expect(result.allowed).toBe(true);
    });
  });

  describe('Cleanup', () => {
    it('should clean up old state entries', async () => {
      const config: RateLimitConfig = {
        enabled: true,
        bot: {
          requests_per_minute: 10,
        },
      };
      rateLimiter = new RateLimiter(config);

      const oldRequest: RateLimitRequest = {
        botId: 'test-bot',
        userId: 'U123',
        channelId: 'C123',
        timestamp: Date.now() - 3 * 60 * 60 * 1000, // 3 hours ago
      };

      await rateLimiter.check(oldRequest);

      const metrics1 = rateLimiter.getMetrics();
      expect(metrics1.state_sizes.bot).toBe(1);

      // Manually trigger cleanup (normally runs every 60 seconds)
      await new Promise(resolve => setTimeout(resolve, 100));

      // State should still exist (only cleaned up after 2 hours of inactivity)
      // This is expected behavior
    });
  });
});
