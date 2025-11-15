import { SlackConfig, SlackBotConfig } from '../types/bot';
import { logger } from '../logger';

/**
 * Normalize Slack configuration to support both single bot and multi-bot formats
 * Provides backward compatibility with existing single bot configurations
 */
export function normalizeSlackConfig(config: SlackConfig): SlackBotConfig[] {
  // Multi-bot format: return bots array as-is
  if (config.bots && config.bots.length > 0) {
    logger.info(`Multi-bot configuration detected: ${config.bots.length} bot(s)`);
    return config.bots;
  }

  // Legacy single bot format: convert to multi-bot format
  logger.info('Legacy single bot configuration detected, converting to multi-bot format');

  // Validate required fields for legacy format
  if (!config.signing_secret || !config.bot_token) {
    throw new Error(
      'Slack configuration requires either "bots" array or "signing_secret" and "bot_token" fields'
    );
  }

  // Convert legacy format to multi-bot format with default bot ID
  const legacyBot: SlackBotConfig = {
    id: 'default',
    endpoint: config.endpoint || '/bots/slack/events',
    signing_secret: config.signing_secret,
    bot_token: config.bot_token,
    mentions: config.mentions,
    threads: config.threads,
    fetch: config.fetch,
    channel_allowlist: config.channel_allowlist,
    response: config.response,
    worker_pool: config.worker_pool,
    cache_observability: config.cache_observability,
    cache_prewarming: config.cache_prewarming,
    workflow: config.workflow,
  };

  return [legacyBot];
}

/**
 * Validate bot identifier format (DNS-safe: lowercase, alphanumeric, hyphens)
 */
export function validateBotId(botId: string): boolean {
  const dnsPattern = /^[a-z0-9-]+$/;
  return dnsPattern.test(botId) && botId.length > 0 && botId.length <= 63;
}

/**
 * Validate multi-bot configuration
 * Checks for:
 * - Unique bot IDs
 * - Unique endpoint paths
 * - Valid bot ID format
 * - Required fields for each bot
 */
export function validateMultiBotConfig(bots: SlackBotConfig[]): void {
  if (bots.length === 0) {
    throw new Error('At least one bot configuration is required');
  }

  const botIds = new Set<string>();
  const endpoints = new Set<string>();

  for (const bot of bots) {
    // Validate bot ID
    if (!bot.id) {
      throw new Error('Bot configuration missing required field: id');
    }

    if (!validateBotId(bot.id)) {
      throw new Error(
        `Invalid bot ID "${bot.id}": must be DNS-safe (lowercase, alphanumeric, hyphens, 1-63 chars)`
      );
    }

    // Check for duplicate bot IDs
    if (botIds.has(bot.id)) {
      throw new Error(`Duplicate bot ID detected: ${bot.id}`);
    }
    botIds.add(bot.id);

    // Validate endpoint
    if (!bot.endpoint) {
      throw new Error(`Bot "${bot.id}" missing required field: endpoint`);
    }

    if (!bot.endpoint.startsWith('/')) {
      throw new Error(`Bot "${bot.id}" endpoint must start with "/": ${bot.endpoint}`);
    }

    // Check for duplicate endpoints
    if (endpoints.has(bot.endpoint)) {
      throw new Error(`Duplicate endpoint detected: ${bot.endpoint} (used by bot "${bot.id}")`);
    }
    endpoints.add(bot.endpoint);

    // Validate required credentials
    if (!bot.signing_secret) {
      throw new Error(`Bot "${bot.id}" missing required field: signing_secret`);
    }

    if (!bot.bot_token) {
      throw new Error(`Bot "${bot.id}" missing required field: bot_token`);
    }
  }

  logger.info(`Multi-bot configuration validated: ${bots.length} bot(s)`);
}
