/**
 * Tests for enhanced Slack bot validation
 * Phase 2 Milestone 6: Enhanced Validation and Performance Tuning
 */

import {
  validateSlackConfigEnhanced,
  analyzePerformance,
  performSecurityAudit,
  checkProductionReadiness,
  estimateMemoryUsage,
} from '../../src/slack/validator';
import { SlackBotConfig, SlackConfig } from '../../src/types/bot';

describe('Enhanced Slack Validation', () => {
  describe('validateSlackConfigEnhanced', () => {
    it('should perform enhanced validation with all flags', async () => {
      const config: SlackConfig = {
        endpoint: '/slack/events',
        signing_secret: '${SLACK_SIGNING_SECRET}',
        bot_token: '${SLACK_BOT_TOKEN}',
        fetch: {
          scope: 'thread',
          max_messages: 40,
          cache: {
            ttl_seconds: 600,
            max_threads: 200,
          },
        },
        rate_limiting: {
          enabled: true,
          bot: {
            requests_per_minute: 60,
            concurrent_requests: 10,
          },
        },
      };

      const result = await validateSlackConfigEnhanced(config, {
        strict: true,
        performance: true,
        security: true,
        production: true,
        deploymentSize: 'medium',
      });

      expect(result).toBeDefined();
      expect(result.issues).toBeDefined();
      expect(result.performance).toBeDefined();
      expect(result.security).toBeDefined();
      expect(result.production).toBeDefined();
      expect(result.memoryEstimation).toBeDefined();
    });

    it('should detect hardcoded secrets in security audit', async () => {
      const config: SlackConfig = {
        endpoint: '/slack/events',
        signing_secret: 'hardcoded-secret-12345',
        bot_token: 'xoxb-hardcoded-token',
      };

      const result = await validateSlackConfigEnhanced(config, {
        security: true,
      });

      expect(result.security).toBeDefined();
      const criticalIssues = result.security?.filter(s => s.level === 'critical');
      expect(criticalIssues && criticalIssues.length).toBeGreaterThan(0);
    });

    it('should recommend HTTPS in production mode', async () => {
      const config: SlackConfig = {
        endpoint: 'http://example.com/slack/events',
        signing_secret: '${SLACK_SIGNING_SECRET}',
        bot_token: '${SLACK_BOT_TOKEN}',
      };

      const result = await validateSlackConfigEnhanced(config, {
        production: true,
      });

      expect(result.security).toBeDefined();
      const httpsIssues = result.security?.filter(s => s.category === 'transport_security');
      expect(httpsIssues && httpsIssues.length).toBeGreaterThan(0);
    });

    it('should validate configuration value ranges', async () => {
      const config: SlackConfig = {
        endpoint: '/slack/events',
        signing_secret: '${SLACK_SIGNING_SECRET}',
        bot_token: '${SLACK_BOT_TOKEN}',
        fetch: {
          scope: 'thread',
          cache: {
            ttl_seconds: 100, // Too low
            max_threads: 10, // Too small
          },
        },
      };

      const result = await validateSlackConfigEnhanced(config, {
        performance: true,
      });

      const rangeIssues = result.issues.filter(i => i.category === 'cache_tuning');
      expect(rangeIssues.length).toBeGreaterThan(0);
    });

    it('should validate multi-bot configurations', async () => {
      const config: SlackConfig = {
        bots: [
          {
            id: 'bot1',
            endpoint: '/bots/slack/bot1',
            signing_secret: '${SECRET1}',
            bot_token: '${TOKEN1}',
          },
          {
            id: 'bot2',
            endpoint: '/bots/slack/bot2',
            signing_secret: '${SECRET2}',
            bot_token: 'xoxb-hardcoded-token-12345678', // Hardcoded token
          },
        ],
      };

      const result = await validateSlackConfigEnhanced(config, {
        security: true,
      });

      expect(result.security).toBeDefined();
      const hardcodedIssues = result.security?.filter(s => s.category === 'hardcoded_secrets');
      expect(hardcodedIssues).toBeDefined();
      expect(hardcodedIssues!.length).toBeGreaterThan(0);
    });
  });

  describe('analyzePerformance', () => {
    it('should provide recommendations for small deployment', () => {
      const botConfig: SlackBotConfig = {
        id: 'test-bot',
        endpoint: '/slack/events',
        signing_secret: '${SECRET}',
        bot_token: '${TOKEN}',
        fetch: {
          scope: 'thread',
          cache: {
            ttl_seconds: 300,
            max_threads: 50,
          },
        },
        worker_pool: {
          queue_capacity: 30,
        },
      };

      const recommendations = analyzePerformance(botConfig, 'small');

      expect(recommendations.length).toBeGreaterThan(0);
      const cacheRecs = recommendations.filter(r => r.category === 'cache_sizing');
      expect(cacheRecs.length).toBeGreaterThan(0);
    });

    it('should recommend cache TTL optimization', () => {
      const botConfig: SlackBotConfig = {
        id: 'test-bot',
        endpoint: '/slack/events',
        signing_secret: '${SECRET}',
        bot_token: '${TOKEN}',
        fetch: {
          scope: 'thread',
          cache: {
            ttl_seconds: 300, // Low TTL
          },
        },
      };

      const recommendations = analyzePerformance(botConfig, 'medium');

      const ttlRecs = recommendations.filter(r => r.category === 'cache_ttl');
      expect(ttlRecs.length).toBeGreaterThan(0);
      expect(ttlRecs[0].level).toBe('high');
    });

    it('should recommend rate limiting when disabled', () => {
      const botConfig: SlackBotConfig = {
        id: 'test-bot',
        endpoint: '/slack/events',
        signing_secret: '${SECRET}',
        bot_token: '${TOKEN}',
        // No rate_limiting configured
      };

      const recommendations = analyzePerformance(botConfig, 'medium');

      const rateLimitRecs = recommendations.filter(r => r.category === 'rate_limiting');
      expect(rateLimitRecs.length).toBeGreaterThan(0);
      expect(rateLimitRecs[0].level).toBe('high');
    });
  });

  describe('performSecurityAudit', () => {
    it('should detect hardcoded bot token', () => {
      const botConfig: SlackBotConfig = {
        id: 'test-bot',
        endpoint: '/slack/events',
        signing_secret: '${SECRET}',
        bot_token: 'xoxb-1234567890-hardcoded-token',
      };

      const audits = performSecurityAudit(botConfig, false);

      const tokenIssues = audits.filter(a => a.category === 'hardcoded_secrets');
      expect(tokenIssues.length).toBeGreaterThan(0);
      expect(tokenIssues[0].level).toBe('critical');
    });

    it('should detect hardcoded signing secret', () => {
      const botConfig: SlackBotConfig = {
        id: 'test-bot',
        endpoint: '/slack/events',
        signing_secret: 'abc123hardcodedsecrethash456', // Hardcoded, long enough
        bot_token: '${TOKEN}',
      };

      const audits = performSecurityAudit(botConfig, false);

      const secretIssues = audits.filter(
        a => a.category === 'hardcoded_secrets' && a.message.includes('Signing secret')
      );
      expect(secretIssues.length).toBeGreaterThan(0);
      expect(secretIssues[0].level).toBe('critical');
    });

    it('should flag HTTP endpoint in production', () => {
      const botConfig: SlackBotConfig = {
        id: 'test-bot',
        endpoint: 'http://example.com/slack/events',
        signing_secret: '${SECRET}',
        bot_token: '${TOKEN}',
      };

      const audits = performSecurityAudit(botConfig, true);

      const httpsIssues = audits.filter(a => a.category === 'transport_security');
      expect(httpsIssues.length).toBeGreaterThan(0);
      expect(httpsIssues[0].level).toBe('high');
    });

    it('should flag missing rate limiting in production', () => {
      const botConfig: SlackBotConfig = {
        id: 'test-bot',
        endpoint: '/slack/events',
        signing_secret: '${SECRET}',
        bot_token: '${TOKEN}',
        // No rate_limiting
      };

      const audits = performSecurityAudit(botConfig, true);

      const rateLimitIssues = audits.filter(a => a.category === 'dos_protection');
      expect(rateLimitIssues.length).toBeGreaterThan(0);
      expect(rateLimitIssues[0].level).toBe('high');
    });

    it('should flag hardcoded cache admin token', () => {
      const botConfig: SlackBotConfig = {
        id: 'test-bot',
        endpoint: '/slack/events',
        signing_secret: '${SECRET}',
        bot_token: '${TOKEN}',
        cache_observability: {
          enable_cache_endpoints: true,
          cache_admin_token: 'hardcoded-admin-token',
        },
      };

      const audits = performSecurityAudit(botConfig, false);

      const tokenIssues = audits.filter(
        a => a.category === 'hardcoded_secrets' && a.message.includes('admin token')
      );
      expect(tokenIssues.length).toBeGreaterThan(0);
      expect(tokenIssues[0].level).toBe('high');
    });

    it('should warn about missing channel allowlist', () => {
      const botConfig: SlackBotConfig = {
        id: 'test-bot',
        endpoint: '/slack/events',
        signing_secret: '${SECRET}',
        bot_token: '${TOKEN}',
        // No channel_allowlist
      };

      const audits = performSecurityAudit(botConfig, true);

      const allowlistIssues = audits.filter(a => a.category === 'access_control');
      expect(allowlistIssues.length).toBeGreaterThan(0);
    });

    it('should pass with proper configuration', () => {
      const botConfig: SlackBotConfig = {
        id: 'test-bot',
        endpoint: '/slack/events',
        signing_secret: '${SECRET}',
        bot_token: '${TOKEN}',
        channel_allowlist: ['C123*'],
        rate_limiting: {
          enabled: true,
        },
      };

      const audits = performSecurityAudit(botConfig, false);

      const passAudits = audits.filter(a => a.level === 'pass');
      expect(passAudits.length).toBeGreaterThan(0);
    });
  });

  describe('checkProductionReadiness', () => {
    it('should fail with missing environment variables', () => {
      const botConfig: SlackBotConfig = {
        id: 'test-bot',
        endpoint: '/slack/events',
        signing_secret: '${MISSING_SECRET}',
        bot_token: '${MISSING_TOKEN}',
      };

      const envVars = [
        { variable: 'MISSING_SECRET', present: false },
        { variable: 'MISSING_TOKEN', present: false },
      ];

      const readiness = checkProductionReadiness(botConfig, envVars);

      expect(readiness.passed).toBe(false);
      expect(readiness.critical.length).toBeGreaterThan(0);
    });

    it('should warn about missing rate limiting', () => {
      const botConfig: SlackBotConfig = {
        id: 'test-bot',
        endpoint: '/slack/events',
        signing_secret: '${SECRET}',
        bot_token: '${TOKEN}',
        // No rate_limiting
      };

      const readiness = checkProductionReadiness(botConfig, []);

      expect(readiness.warnings.length).toBeGreaterThan(0);
      const rateLimitWarning = readiness.warnings.find(w => w.includes('Rate limiting'));
      expect(rateLimitWarning).toBeDefined();
    });

    it('should recommend cache observability', () => {
      const botConfig: SlackBotConfig = {
        id: 'test-bot',
        endpoint: '/slack/events',
        signing_secret: '${SECRET}',
        bot_token: '${TOKEN}',
        // No cache_observability
      };

      const readiness = checkProductionReadiness(botConfig, []);

      expect(readiness.recommendations.length).toBeGreaterThan(0);
      const obsRec = readiness.recommendations.find(r => r.includes('observability'));
      expect(obsRec).toBeDefined();
    });

    it('should pass with production-ready configuration', () => {
      const botConfig: SlackBotConfig = {
        id: 'test-bot',
        endpoint: '/slack/events',
        signing_secret: '${SECRET}',
        bot_token: '${TOKEN}',
        channel_allowlist: ['C123*'],
        rate_limiting: {
          enabled: true,
        },
        fetch: {
          scope: 'thread',
          cache: {
            ttl_seconds: 900,
          },
        },
      };

      const envVars = [
        { variable: 'SECRET', present: true, value: '***' },
        { variable: 'TOKEN', present: true, value: '***' },
      ];

      const readiness = checkProductionReadiness(botConfig, envVars);

      expect(readiness.passed).toBe(true);
      expect(readiness.critical.length).toBe(0);
    });
  });

  describe('estimateMemoryUsage', () => {
    it('should estimate memory for default configuration', () => {
      const botConfig: SlackBotConfig = {
        id: 'test-bot',
        endpoint: '/slack/events',
        signing_secret: '${SECRET}',
        bot_token: '${TOKEN}',
      };

      const estimation = estimateMemoryUsage(botConfig);

      expect(estimation.totalMB).toBeGreaterThan(0);
      expect(estimation.breakdown.cache).toBeGreaterThan(0);
      expect(estimation.breakdown.workerPool).toBeGreaterThan(0);
      expect(estimation.breakdown.overhead).toBe(50);
    });

    it('should estimate higher memory for large cache', () => {
      const smallConfig: SlackBotConfig = {
        id: 'test-bot',
        endpoint: '/slack/events',
        signing_secret: '${SECRET}',
        bot_token: '${TOKEN}',
        fetch: {
          scope: 'thread',
          cache: {
            max_threads: 100,
          },
        },
      };

      const largeConfig: SlackBotConfig = {
        id: 'test-bot',
        endpoint: '/slack/events',
        signing_secret: '${SECRET}',
        bot_token: '${TOKEN}',
        fetch: {
          scope: 'thread',
          cache: {
            max_threads: 1000,
          },
        },
      };

      const smallEst = estimateMemoryUsage(smallConfig);
      const largeEst = estimateMemoryUsage(largeConfig);

      expect(largeEst.totalMB).toBeGreaterThan(smallEst.totalMB);
      expect(largeEst.breakdown.cache).toBeGreaterThan(smallEst.breakdown.cache);
    });

    it('should include rate limiting memory when enabled', () => {
      const withoutRL: SlackBotConfig = {
        id: 'test-bot',
        endpoint: '/slack/events',
        signing_secret: '${SECRET}',
        bot_token: '${TOKEN}',
      };

      const withRL: SlackBotConfig = {
        id: 'test-bot',
        endpoint: '/slack/events',
        signing_secret: '${SECRET}',
        bot_token: '${TOKEN}',
        rate_limiting: {
          enabled: true,
        },
      };

      const withoutEst = estimateMemoryUsage(withoutRL);
      const withEst = estimateMemoryUsage(withRL);

      expect(withEst.breakdown.rateLimit).toBe(5);
      expect(withoutEst.breakdown.rateLimit).toBe(0);
    });

    it('should provide reasonable estimates for production config', () => {
      const productionConfig: SlackBotConfig = {
        id: 'prod-bot',
        endpoint: '/slack/events',
        signing_secret: '${SECRET}',
        bot_token: '${TOKEN}',
        fetch: {
          scope: 'thread',
          max_messages: 40,
          cache: {
            ttl_seconds: 900,
            max_threads: 500,
          },
        },
        worker_pool: {
          queue_capacity: 100,
        },
        rate_limiting: {
          enabled: true,
        },
      };

      const estimation = estimateMemoryUsage(productionConfig);

      // Should be reasonable for a production deployment
      expect(estimation.totalMB).toBeGreaterThan(50);
      expect(estimation.totalMB).toBeLessThan(500);
    });
  });
});
