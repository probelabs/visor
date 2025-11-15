import {
  normalizeSlackConfig,
  validateMultiBotConfig,
  validateBotId,
} from '../../src/slack/config-normalizer';
import { SlackConfig, SlackBotConfig } from '../../src/types/bot';

describe('Slack Multi-Bot Configuration', () => {
  describe('validateBotId', () => {
    it('should accept valid bot IDs', () => {
      expect(validateBotId('production-bot')).toBe(true);
      expect(validateBotId('staging-bot')).toBe(true);
      expect(validateBotId('support-bot-1')).toBe(true);
      expect(validateBotId('default')).toBe(true);
      expect(validateBotId('eng')).toBe(true);
      expect(validateBotId('a')).toBe(true);
    });

    it('should reject invalid bot IDs', () => {
      expect(validateBotId('Production-Bot')).toBe(false); // uppercase
      expect(validateBotId('production_bot')).toBe(false); // underscore
      expect(validateBotId('production bot')).toBe(false); // space
      expect(validateBotId('production.bot')).toBe(false); // dot
      expect(validateBotId('')).toBe(false); // empty
      expect(validateBotId('a'.repeat(64))).toBe(false); // too long (>63 chars)
    });
  });

  describe('normalizeSlackConfig', () => {
    it('should convert legacy single bot format to multi-bot format', () => {
      const config: SlackConfig = {
        endpoint: '/slack/events',
        signing_secret: 'secret123',
        bot_token: 'xoxb-token',
        mentions: 'direct',
        threads: 'required',
      };

      const normalized = normalizeSlackConfig(config);

      expect(normalized).toHaveLength(1);
      expect(normalized[0]).toMatchObject({
        id: 'default',
        endpoint: '/slack/events',
        signing_secret: 'secret123',
        bot_token: 'xoxb-token',
        mentions: 'direct',
        threads: 'required',
      });
    });

    it('should use default endpoint for legacy format', () => {
      const config: SlackConfig = {
        signing_secret: 'secret123',
        bot_token: 'xoxb-token',
      };

      const normalized = normalizeSlackConfig(config);

      expect(normalized[0].endpoint).toBe('/bots/slack/events');
    });

    it('should pass through multi-bot format unchanged', () => {
      const bots: SlackBotConfig[] = [
        {
          id: 'production-bot',
          endpoint: '/bots/slack/production',
          signing_secret: 'secret1',
          bot_token: 'xoxb-token1',
        },
        {
          id: 'staging-bot',
          endpoint: '/bots/slack/staging',
          signing_secret: 'secret2',
          bot_token: 'xoxb-token2',
        },
      ];

      const config: SlackConfig = { bots };
      const normalized = normalizeSlackConfig(config);

      expect(normalized).toEqual(bots);
      expect(normalized).toHaveLength(2);
    });

    it('should throw error for legacy format missing required fields', () => {
      const config: SlackConfig = {
        endpoint: '/slack/events',
        // missing signing_secret and bot_token
      };

      expect(() => normalizeSlackConfig(config)).toThrow(
        'Slack configuration requires either "bots" array or "signing_secret" and "bot_token" fields'
      );
    });

    it('should preserve all bot configuration fields', () => {
      const config: SlackConfig = {
        endpoint: '/slack/events',
        signing_secret: 'secret123',
        bot_token: 'xoxb-token',
        mentions: 'direct',
        threads: 'required',
        fetch: {
          scope: 'thread',
          max_messages: 50,
          cache: {
            ttl_seconds: 900,
            max_threads: 500,
          },
        },
        channel_allowlist: ['CENG*', 'C_PROD_*'],
        response: {
          fallback: 'Error message',
        },
        worker_pool: {
          queue_capacity: 200,
          task_timeout: 600000,
        },
        cache_observability: {
          enable_cache_endpoints: true,
          cache_admin_token: 'admin123',
        },
        workflow: 'production-workflow',
      };

      const normalized = normalizeSlackConfig(config);

      expect(normalized[0]).toMatchObject({
        id: 'default',
        endpoint: '/slack/events',
        signing_secret: 'secret123',
        bot_token: 'xoxb-token',
        mentions: 'direct',
        threads: 'required',
        fetch: {
          scope: 'thread',
          max_messages: 50,
          cache: {
            ttl_seconds: 900,
            max_threads: 500,
          },
        },
        channel_allowlist: ['CENG*', 'C_PROD_*'],
        response: {
          fallback: 'Error message',
        },
        worker_pool: {
          queue_capacity: 200,
          task_timeout: 600000,
        },
        cache_observability: {
          enable_cache_endpoints: true,
          cache_admin_token: 'admin123',
        },
        workflow: 'production-workflow',
      });
    });
  });

  describe('validateMultiBotConfig', () => {
    it('should validate valid multi-bot configuration', () => {
      const bots: SlackBotConfig[] = [
        {
          id: 'production-bot',
          endpoint: '/bots/slack/production',
          signing_secret: 'secret1',
          bot_token: 'xoxb-token1',
        },
        {
          id: 'staging-bot',
          endpoint: '/bots/slack/staging',
          signing_secret: 'secret2',
          bot_token: 'xoxb-token2',
        },
      ];

      expect(() => validateMultiBotConfig(bots)).not.toThrow();
    });

    it('should throw error for empty bots array', () => {
      expect(() => validateMultiBotConfig([])).toThrow(
        'At least one bot configuration is required'
      );
    });

    it('should throw error for duplicate bot IDs', () => {
      const bots: SlackBotConfig[] = [
        {
          id: 'production-bot',
          endpoint: '/bots/slack/production',
          signing_secret: 'secret1',
          bot_token: 'xoxb-token1',
        },
        {
          id: 'production-bot', // duplicate
          endpoint: '/bots/slack/production2',
          signing_secret: 'secret2',
          bot_token: 'xoxb-token2',
        },
      ];

      expect(() => validateMultiBotConfig(bots)).toThrow(
        'Duplicate bot ID detected: production-bot'
      );
    });

    it('should throw error for duplicate endpoints', () => {
      const bots: SlackBotConfig[] = [
        {
          id: 'production-bot',
          endpoint: '/bots/slack/events',
          signing_secret: 'secret1',
          bot_token: 'xoxb-token1',
        },
        {
          id: 'staging-bot',
          endpoint: '/bots/slack/events', // duplicate
          signing_secret: 'secret2',
          bot_token: 'xoxb-token2',
        },
      ];

      expect(() => validateMultiBotConfig(bots)).toThrow(
        'Duplicate endpoint detected: /bots/slack/events'
      );
    });

    it('should throw error for invalid bot ID format', () => {
      const bots: SlackBotConfig[] = [
        {
          id: 'Production-Bot', // invalid (uppercase)
          endpoint: '/bots/slack/production',
          signing_secret: 'secret1',
          bot_token: 'xoxb-token1',
        },
      ];

      expect(() => validateMultiBotConfig(bots)).toThrow(
        'Invalid bot ID "Production-Bot": must be DNS-safe (lowercase, alphanumeric, hyphens, 1-63 chars)'
      );
    });

    it('should throw error for endpoint not starting with /', () => {
      const bots: SlackBotConfig[] = [
        {
          id: 'production-bot',
          endpoint: 'bots/slack/production', // missing leading /
          signing_secret: 'secret1',
          bot_token: 'xoxb-token1',
        },
      ];

      expect(() => validateMultiBotConfig(bots)).toThrow(
        'Bot "production-bot" endpoint must start with "/": bots/slack/production'
      );
    });

    it('should throw error for missing required fields', () => {
      const botsNoId = [
        {
          endpoint: '/bots/slack/production',
          signing_secret: 'secret1',
          bot_token: 'xoxb-token1',
        } as SlackBotConfig,
      ];

      expect(() => validateMultiBotConfig(botsNoId)).toThrow(
        'Bot configuration missing required field: id'
      );

      const botsNoEndpoint: SlackBotConfig[] = [
        {
          id: 'production-bot',
          endpoint: '', // empty
          signing_secret: 'secret1',
          bot_token: 'xoxb-token1',
        },
      ];

      expect(() => validateMultiBotConfig(botsNoEndpoint)).toThrow(
        'Bot "production-bot" missing required field: endpoint'
      );

      const botsNoSecret: SlackBotConfig[] = [
        {
          id: 'production-bot',
          endpoint: '/bots/slack/production',
          signing_secret: '', // empty
          bot_token: 'xoxb-token1',
        },
      ];

      expect(() => validateMultiBotConfig(botsNoSecret)).toThrow(
        'Bot "production-bot" missing required field: signing_secret'
      );

      const botsNoToken: SlackBotConfig[] = [
        {
          id: 'production-bot',
          endpoint: '/bots/slack/production',
          signing_secret: 'secret1',
          bot_token: '', // empty
        },
      ];

      expect(() => validateMultiBotConfig(botsNoToken)).toThrow(
        'Bot "production-bot" missing required field: bot_token'
      );
    });
  });

  describe('Multi-bot workflow routing', () => {
    it('should allow bot-specific workflow configuration', () => {
      const bots: SlackBotConfig[] = [
        {
          id: 'production-bot',
          endpoint: '/bots/slack/production',
          signing_secret: 'secret1',
          bot_token: 'xoxb-token1',
          workflow: 'production-workflow',
        },
        {
          id: 'staging-bot',
          endpoint: '/bots/slack/staging',
          signing_secret: 'secret2',
          bot_token: 'xoxb-token2',
          workflow: 'staging-workflow',
        },
      ];

      validateMultiBotConfig(bots);

      expect(bots[0].workflow).toBe('production-workflow');
      expect(bots[1].workflow).toBe('staging-workflow');
    });
  });

  describe('Multi-bot resource isolation', () => {
    it('should allow bot-specific worker pool configuration', () => {
      const bots: SlackBotConfig[] = [
        {
          id: 'production-bot',
          endpoint: '/bots/slack/production',
          signing_secret: 'secret1',
          bot_token: 'xoxb-token1',
          worker_pool: {
            queue_capacity: 200,
            task_timeout: 600000,
          },
        },
        {
          id: 'staging-bot',
          endpoint: '/bots/slack/staging',
          signing_secret: 'secret2',
          bot_token: 'xoxb-token2',
          worker_pool: {
            queue_capacity: 100,
            task_timeout: 300000,
          },
        },
      ];

      validateMultiBotConfig(bots);

      expect(bots[0].worker_pool?.queue_capacity).toBe(200);
      expect(bots[0].worker_pool?.task_timeout).toBe(600000);
      expect(bots[1].worker_pool?.queue_capacity).toBe(100);
      expect(bots[1].worker_pool?.task_timeout).toBe(300000);
    });

    it('should allow bot-specific cache configuration', () => {
      const bots: SlackBotConfig[] = [
        {
          id: 'production-bot',
          endpoint: '/bots/slack/production',
          signing_secret: 'secret1',
          bot_token: 'xoxb-token1',
          fetch: {
            scope: 'thread',
            max_messages: 50,
            cache: {
              ttl_seconds: 900,
              max_threads: 500,
            },
          },
        },
        {
          id: 'staging-bot',
          endpoint: '/bots/slack/staging',
          signing_secret: 'secret2',
          bot_token: 'xoxb-token2',
          fetch: {
            scope: 'thread',
            max_messages: 30,
            cache: {
              ttl_seconds: 600,
              max_threads: 200,
            },
          },
        },
      ];

      validateMultiBotConfig(bots);

      expect(bots[0].fetch?.max_messages).toBe(50);
      expect(bots[0].fetch?.cache?.max_threads).toBe(500);
      expect(bots[1].fetch?.max_messages).toBe(30);
      expect(bots[1].fetch?.cache?.max_threads).toBe(200);
    });
  });
});
