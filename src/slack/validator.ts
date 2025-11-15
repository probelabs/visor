import { SlackConfig, SlackBotConfig } from '../types/bot';
import { WebClient } from '@slack/web-api';
import { logger } from '../logger';

/**
 * Validation result for a single check
 */
export interface ValidationIssue {
  level: 'error' | 'warning' | 'info';
  category: string;
  message: string;
  fix?: string;
}

/**
 * Environment variable check result
 */
export interface EnvVarCheck {
  variable: string;
  present: boolean;
  value?: string;
}

/**
 * Performance recommendation
 */
export interface PerformanceRecommendation {
  level: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  message: string;
  impact: string;
  suggestion: string;
  estimatedImprovement?: string;
}

/**
 * Security audit result
 */
export interface SecurityAudit {
  level: 'critical' | 'high' | 'medium' | 'low' | 'pass';
  category: string;
  message: string;
  fix?: string;
}

/**
 * Production readiness check result
 */
export interface ProductionReadiness {
  passed: boolean;
  critical: string[];
  warnings: string[];
  recommendations: string[];
}

/**
 * Memory estimation result
 */
export interface MemoryEstimation {
  totalMB: number;
  breakdown: {
    cache: number;
    workerPool: number;
    rateLimit: number;
    overhead: number;
  };
}

/**
 * Complete validation result
 */
export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  envVars: EnvVarCheck[];
  config?: SlackConfig;
  performance?: PerformanceRecommendation[];
  security?: SecurityAudit[];
  production?: ProductionReadiness;
  memoryEstimation?: MemoryEstimation;
}

/**
 * Extract environment variable references from a string
 */
function extractEnvVars(value: string | undefined): string[] {
  if (!value) return [];
  const matches = value.match(/\$\{([^}]+)\}/g);
  if (!matches) return [];
  return matches.map(m => m.slice(2, -1)); // Remove ${ and }
}

/**
 * Check if a value contains environment variable placeholders
 */
function hasEnvVars(value: string | undefined): boolean {
  if (!value) return false;
  return /\$\{[^}]+\}/.test(value);
}

/**
 * Resolve environment variable value
 */
function resolveEnvVar(varName: string): string | undefined {
  return process.env[varName];
}

/**
 * Validate required fields in Slack configuration
 */
function checkRequiredFields(config: SlackConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Check signing_secret
  if (!config.signing_secret) {
    issues.push({
      level: 'error',
      category: 'required_field',
      message: 'Missing required field: signing_secret',
      fix: 'Add signing_secret to your Slack configuration. Example: signing_secret: "${SLACK_SIGNING_SECRET}"',
    });
  }

  // Check bot_token
  if (!config.bot_token) {
    issues.push({
      level: 'error',
      category: 'required_field',
      message: 'Missing required field: bot_token',
      fix: 'Add bot_token to your Slack configuration. Example: bot_token: "${SLACK_BOT_TOKEN}"',
    });
  }

  // Check endpoint
  if (!config.endpoint) {
    issues.push({
      level: 'info',
      category: 'optional_field',
      message: 'No endpoint specified, will use default: /slack/events',
      fix: 'Consider adding explicit endpoint: endpoint: "/bots/slack/my-bot"',
    });
  }

  return issues;
}

/**
 * Check environment variables and track which are missing
 */
function checkEnvironmentVariables(config: SlackConfig): {
  issues: ValidationIssue[];
  envVars: EnvVarCheck[];
} {
  const issues: ValidationIssue[] = [];
  const envVars: EnvVarCheck[] = [];
  const checked = new Set<string>();

  // Extract all env var references from config
  const fields = [
    { name: 'signing_secret', value: config.signing_secret },
    { name: 'bot_token', value: config.bot_token },
  ];

  for (const field of fields) {
    const vars = extractEnvVars(field.value);
    for (const varName of vars) {
      if (checked.has(varName)) continue;
      checked.add(varName);

      const value = resolveEnvVar(varName);
      const present = value !== undefined;

      envVars.push({
        variable: varName,
        present,
        value: present ? '***' : undefined, // Mask actual value
      });

      if (!present) {
        issues.push({
          level: 'error',
          category: 'environment',
          message: `Environment variable not set: ${varName}`,
          fix: `Set ${varName} in your environment before starting Visor. Example: export ${varName}="your-value"`,
        });
      }
    }
  }

  return { issues, envVars };
}

/**
 * Validate endpoint path format
 */
function validateEndpoint(endpoint: string | undefined): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!endpoint) {
    return issues; // Already handled in required fields check
  }

  // Check if endpoint starts with /
  if (!endpoint.startsWith('/')) {
    issues.push({
      level: 'warning',
      category: 'endpoint_format',
      message: `Endpoint should start with /: ${endpoint}`,
      fix: `Change endpoint to: /${endpoint}`,
    });
  }

  // Check for common mistakes
  if (endpoint.includes(' ')) {
    issues.push({
      level: 'error',
      category: 'endpoint_format',
      message: 'Endpoint contains spaces',
      fix: 'Remove spaces from endpoint path',
    });
  }

  if (endpoint.includes('//')) {
    issues.push({
      level: 'warning',
      category: 'endpoint_format',
      message: 'Endpoint contains double slashes',
      fix: 'Remove extra slashes from endpoint path',
    });
  }

  // Recommend specific path structure
  if (endpoint === '/slack' || endpoint === '/slack/') {
    issues.push({
      level: 'info',
      category: 'endpoint_format',
      message: 'Generic endpoint path detected',
      fix: 'Consider using a more specific path like /slack/events or /bots/slack/my-bot',
    });
  }

  return issues;
}

/**
 * Validate cache configuration
 */
function validateCacheConfig(config: SlackConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!config.fetch?.cache) {
    return issues; // Cache is optional
  }

  const cache = config.fetch.cache;

  // Check ttl_seconds
  if (cache.ttl_seconds !== undefined) {
    if (typeof cache.ttl_seconds !== 'number' || cache.ttl_seconds < 0) {
      issues.push({
        level: 'error',
        category: 'cache_config',
        message: `Invalid cache ttl_seconds: ${cache.ttl_seconds}`,
        fix: 'Set ttl_seconds to a positive number (e.g., 600 for 10 minutes)',
      });
    } else if (cache.ttl_seconds < 60) {
      issues.push({
        level: 'warning',
        category: 'cache_config',
        message: `Cache TTL is very short: ${cache.ttl_seconds} seconds`,
        fix: 'Consider increasing TTL to at least 60 seconds to reduce API calls',
      });
    } else if (cache.ttl_seconds > 3600) {
      issues.push({
        level: 'warning',
        category: 'cache_config',
        message: `Cache TTL is very long: ${cache.ttl_seconds} seconds`,
        fix: 'Consider reducing TTL to avoid stale conversation data',
      });
    }
  }

  // Check max_threads
  if (cache.max_threads !== undefined) {
    if (typeof cache.max_threads !== 'number' || cache.max_threads < 1) {
      issues.push({
        level: 'error',
        category: 'cache_config',
        message: `Invalid cache max_threads: ${cache.max_threads}`,
        fix: 'Set max_threads to a positive number (e.g., 200)',
      });
    } else if (cache.max_threads < 10) {
      issues.push({
        level: 'warning',
        category: 'cache_config',
        message: `Cache max_threads is very small: ${cache.max_threads}`,
        fix: 'Consider increasing max_threads to at least 10 for better caching',
      });
    }
  }

  return issues;
}

/**
 * Validate fetch configuration
 */
function validateFetchConfig(config: SlackConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!config.fetch) {
    return issues; // Fetch config has defaults
  }

  const fetch = config.fetch;

  // Check max_messages
  if (fetch.max_messages !== undefined) {
    if (typeof fetch.max_messages !== 'number' || fetch.max_messages < 1) {
      issues.push({
        level: 'error',
        category: 'fetch_config',
        message: `Invalid max_messages: ${fetch.max_messages}`,
        fix: 'Set max_messages to a positive number (e.g., 40)',
      });
    } else if (fetch.max_messages > 100) {
      issues.push({
        level: 'warning',
        category: 'fetch_config',
        message: `max_messages is very large: ${fetch.max_messages}`,
        fix: 'Consider reducing max_messages to avoid token budget issues',
      });
    }
  }

  // Check scope
  if (fetch.scope && fetch.scope !== 'thread') {
    issues.push({
      level: 'error',
      category: 'fetch_config',
      message: `Invalid scope: ${fetch.scope}. Only "thread" is supported`,
      fix: 'Set scope to "thread" or remove it to use the default',
    });
  }

  return issues;
}

/**
 * Validate channel allowlist patterns
 */
function validateChannelAllowlist(patterns: string[] | undefined): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!patterns || patterns.length === 0) {
    issues.push({
      level: 'warning',
      category: 'channel_allowlist',
      message: 'No channel allowlist configured - bot will respond in ALL channels',
      fix: 'Consider adding channel_allowlist to restrict bot to specific channels. Example: ["C123*", "CSUPPORT"]',
    });
    return issues;
  }

  // Validate each pattern
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') {
      issues.push({
        level: 'error',
        category: 'channel_allowlist',
        message: `Invalid channel pattern (not a string): ${pattern}`,
        fix: 'Ensure all channel patterns are strings',
      });
      continue;
    }

    // Check for common mistakes
    if (pattern.includes(' ')) {
      issues.push({
        level: 'warning',
        category: 'channel_allowlist',
        message: `Channel pattern contains spaces: "${pattern}"`,
        fix: 'Remove spaces from channel pattern',
      });
    }

    // Validate wildcard usage
    const asteriskCount = (pattern.match(/\*/g) || []).length;
    if (asteriskCount > 1) {
      issues.push({
        level: 'warning',
        category: 'channel_allowlist',
        message: `Channel pattern has multiple wildcards: "${pattern}"`,
        fix: 'Use only one wildcard (*) per pattern, typically at the end',
      });
    }

    // Check if pattern is just "*" (matches everything)
    if (pattern === '*') {
      issues.push({
        level: 'warning',
        category: 'channel_allowlist',
        message: 'Channel allowlist contains "*" which matches all channels',
        fix: 'Remove "*" pattern or use more specific patterns like "C123*"',
      });
    }
  }

  return issues;
}

/**
 * Verify bot token format
 */
function verifyBotTokenFormat(token: string | undefined): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!token) {
    return issues; // Already handled in required fields check
  }

  // Check if token contains env var placeholder
  if (hasEnvVars(token)) {
    issues.push({
      level: 'info',
      category: 'token_format',
      message: 'Bot token uses environment variable placeholder',
      fix: 'Make sure the environment variable is set before running Visor',
    });
    return issues;
  }

  // Resolve env var if present
  const resolvedToken = token.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    return resolveEnvVar(varName) || '';
  });

  // Check if token starts with xoxb-
  if (!resolvedToken.startsWith('xoxb-')) {
    issues.push({
      level: 'error',
      category: 'token_format',
      message: 'Bot token does not start with "xoxb-"',
      fix: 'Ensure you are using a bot token, not a user token. Bot tokens start with "xoxb-"',
    });
  }

  return issues;
}

/**
 * Validate rate limiting configuration
 */
function validateRateLimitConfig(config: SlackConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!config.rate_limiting || !config.rate_limiting.enabled) {
    return issues; // Rate limiting is optional
  }

  const rl = config.rate_limiting;

  // Validate bot limits
  if (rl.bot) {
    if (rl.bot.requests_per_minute && rl.bot.requests_per_minute < 0) {
      issues.push({
        level: 'error',
        category: 'rate_limiting',
        message: 'bot.requests_per_minute cannot be negative',
        fix: 'Set to 0 for unlimited or a positive number for the limit',
      });
    }
    if (rl.bot.requests_per_hour && rl.bot.requests_per_hour < 0) {
      issues.push({
        level: 'error',
        category: 'rate_limiting',
        message: 'bot.requests_per_hour cannot be negative',
        fix: 'Set to 0 for unlimited or a positive number for the limit',
      });
    }
    if (rl.bot.concurrent_requests && rl.bot.concurrent_requests < 0) {
      issues.push({
        level: 'error',
        category: 'rate_limiting',
        message: 'bot.concurrent_requests cannot be negative',
        fix: 'Set to 0 for unlimited or a positive number for the limit',
      });
    }
    // Warn if limits are very high
    if (rl.bot.requests_per_minute && rl.bot.requests_per_minute > 1000) {
      issues.push({
        level: 'warning',
        category: 'rate_limiting',
        message: 'bot.requests_per_minute is very high (>1000)',
        fix: 'Consider if this limit is appropriate for your use case',
      });
    }
  }

  // Validate user limits
  if (rl.user) {
    if (rl.user.requests_per_minute && rl.user.requests_per_minute < 0) {
      issues.push({
        level: 'error',
        category: 'rate_limiting',
        message: 'user.requests_per_minute cannot be negative',
      });
    }
    if (rl.user.requests_per_hour && rl.user.requests_per_hour < 0) {
      issues.push({
        level: 'error',
        category: 'rate_limiting',
        message: 'user.requests_per_hour cannot be negative',
      });
    }
    if (rl.user.concurrent_requests && rl.user.concurrent_requests < 0) {
      issues.push({
        level: 'error',
        category: 'rate_limiting',
        message: 'user.concurrent_requests cannot be negative',
      });
    }
    // Warn if per-user limits are too restrictive
    if (rl.user.requests_per_minute && rl.user.requests_per_minute < 1) {
      issues.push({
        level: 'warning',
        category: 'rate_limiting',
        message: 'user.requests_per_minute is very low (<1)',
        fix: 'This may block legitimate users. Consider increasing the limit.',
      });
    }
  }

  // Validate channel limits
  if (rl.channel) {
    if (rl.channel.requests_per_minute && rl.channel.requests_per_minute < 0) {
      issues.push({
        level: 'error',
        category: 'rate_limiting',
        message: 'channel.requests_per_minute cannot be negative',
      });
    }
    if (rl.channel.requests_per_hour && rl.channel.requests_per_hour < 0) {
      issues.push({
        level: 'error',
        category: 'rate_limiting',
        message: 'channel.requests_per_hour cannot be negative',
      });
    }
    if (rl.channel.concurrent_requests && rl.channel.concurrent_requests < 0) {
      issues.push({
        level: 'error',
        category: 'rate_limiting',
        message: 'channel.concurrent_requests cannot be negative',
      });
    }
  }

  // Validate global limits
  if (rl.global) {
    if (rl.global.requests_per_minute && rl.global.requests_per_minute < 0) {
      issues.push({
        level: 'error',
        category: 'rate_limiting',
        message: 'global.requests_per_minute cannot be negative',
      });
    }
    if (rl.global.requests_per_hour && rl.global.requests_per_hour < 0) {
      issues.push({
        level: 'error',
        category: 'rate_limiting',
        message: 'global.requests_per_hour cannot be negative',
      });
    }
    if (rl.global.concurrent_requests && rl.global.concurrent_requests < 0) {
      issues.push({
        level: 'error',
        category: 'rate_limiting',
        message: 'global.concurrent_requests cannot be negative',
      });
    }
  }

  // Validate actions config
  if (rl.actions) {
    if (
      rl.actions.queue_threshold !== undefined &&
      (rl.actions.queue_threshold < 0 || rl.actions.queue_threshold > 1)
    ) {
      issues.push({
        level: 'error',
        category: 'rate_limiting',
        message: 'actions.queue_threshold must be between 0.0 and 1.0',
        fix: 'Set a value between 0.0 (queue immediately) and 1.0 (queue only when full)',
      });
    }
  }

  // Validate storage config
  if (rl.storage) {
    if (rl.storage.type !== 'memory') {
      issues.push({
        level: 'warning',
        category: 'rate_limiting',
        message: `Unknown storage type: ${rl.storage.type}`,
        fix: 'Supported type: "memory"',
      });
    }
  }

  // Warn if rate limiting is enabled but no limits are configured
  if (!rl.bot && !rl.user && !rl.channel && !rl.global) {
    issues.push({
      level: 'warning',
      category: 'rate_limiting',
      message: 'Rate limiting is enabled but no limits are configured',
      fix: 'Add at least one of: bot, user, channel, or global limits',
    });
  }

  return issues;
}

/**
 * Test Slack API connectivity (optional check)
 */
async function checkSlackConnectivity(
  token: string | undefined,
  checkApi: boolean
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  if (!checkApi) {
    return issues; // Skip connectivity test
  }

  if (!token || hasEnvVars(token)) {
    issues.push({
      level: 'info',
      category: 'connectivity',
      message: 'Skipping API connectivity test (token contains env var placeholder)',
    });
    return issues;
  }

  // Resolve env var if present
  const resolvedToken = token.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    return resolveEnvVar(varName) || '';
  });

  if (!resolvedToken) {
    issues.push({
      level: 'warning',
      category: 'connectivity',
      message: 'Cannot test API connectivity (token not resolved)',
    });
    return issues;
  }

  try {
    logger.debug('Testing Slack API connectivity...');
    const client = new WebClient(resolvedToken);
    const response = await client.auth.test();

    if (response.ok) {
      issues.push({
        level: 'info',
        category: 'connectivity',
        message: `Successfully connected to Slack workspace: ${response.team}`,
        fix: `Bot user: ${response.user} (ID: ${response.user_id})`,
      });
    } else {
      issues.push({
        level: 'error',
        category: 'connectivity',
        message: 'Slack API connection failed',
        fix: 'Check that your bot token is valid and has not been revoked',
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push({
      level: 'error',
      category: 'connectivity',
      message: `Slack API error: ${message}`,
      fix: 'Verify your bot token is correct and has not expired. Check network connectivity.',
    });
  }

  return issues;
}

/**
 * Main validation function
 */
export async function validateSlackConfig(
  config: SlackConfig | undefined,
  options: { checkApi?: boolean } = {}
): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];
  const envVars: EnvVarCheck[] = [];

  // Check if Slack config exists
  if (!config) {
    return {
      valid: false,
      issues: [
        {
          level: 'error',
          category: 'config',
          message: 'No Slack configuration found',
          fix: 'Add a "slack:" section to your .visor.yaml configuration file',
        },
      ],
      envVars: [],
    };
  }

  // Run all validation checks
  issues.push(...checkRequiredFields(config));

  const envResult = checkEnvironmentVariables(config);
  issues.push(...envResult.issues);
  envVars.push(...envResult.envVars);

  issues.push(...validateEndpoint(config.endpoint));
  issues.push(...validateCacheConfig(config));
  issues.push(...validateFetchConfig(config));
  issues.push(...validateChannelAllowlist(config.channel_allowlist));
  issues.push(...verifyBotTokenFormat(config.bot_token));
  issues.push(...validateRateLimitConfig(config));

  // Optional API connectivity test
  if (options.checkApi) {
    const connectivityIssues = await checkSlackConnectivity(config.bot_token, true);
    issues.push(...connectivityIssues);
  }

  // Determine overall validity
  const hasErrors = issues.some(issue => issue.level === 'error');
  const valid = !hasErrors;

  return {
    valid,
    issues,
    envVars,
    config,
  };
}

/**
 * Format validation result for console output with colors
 */
export function formatValidationResult(result: ValidationResult, useColors = true): string {
  const lines: string[] = [];

  // Color codes
  const red = useColors ? '\x1b[31m' : '';
  const yellow = useColors ? '\x1b[33m' : '';
  const green = useColors ? '\x1b[32m' : '';
  const blue = useColors ? '\x1b[34m' : '';
  const gray = useColors ? '\x1b[90m' : '';
  const reset = useColors ? '\x1b[0m' : '';
  const bold = useColors ? '\x1b[1m' : '';

  // Header
  lines.push('');
  lines.push(`${bold}Slack Bot Configuration Validation${reset}`);
  lines.push('═'.repeat(60));
  lines.push('');

  // Overall status
  if (result.valid) {
    lines.push(`${green}✓ Configuration is valid${reset}`);
  } else {
    lines.push(`${red}✗ Configuration has errors${reset}`);
  }
  lines.push('');

  // Environment variables
  if (result.envVars.length > 0) {
    lines.push(`${bold}Environment Variables:${reset}`);
    for (const envVar of result.envVars) {
      const status = envVar.present ? `${green}✓${reset}` : `${red}✗${reset}`;
      const value = envVar.present ? `${gray}(set)${reset}` : `${red}(missing)${reset}`;
      lines.push(`  ${status} ${envVar.variable} ${value}`);
    }
    lines.push('');
  }

  // Issues grouped by level
  const errors = result.issues.filter(i => i.level === 'error');
  const warnings = result.issues.filter(i => i.level === 'warning');
  const infos = result.issues.filter(i => i.level === 'info');

  if (errors.length > 0) {
    lines.push(`${red}${bold}Errors (${errors.length}):${reset}`);
    for (const issue of errors) {
      lines.push(`  ${red}✗${reset} ${issue.message}`);
      if (issue.fix) {
        lines.push(`    ${gray}→ ${issue.fix}${reset}`);
      }
    }
    lines.push('');
  }

  if (warnings.length > 0) {
    lines.push(`${yellow}${bold}Warnings (${warnings.length}):${reset}`);
    for (const issue of warnings) {
      lines.push(`  ${yellow}⚠${reset} ${issue.message}`);
      if (issue.fix) {
        lines.push(`    ${gray}→ ${issue.fix}${reset}`);
      }
    }
    lines.push('');
  }

  if (infos.length > 0) {
    lines.push(`${blue}${bold}Info (${infos.length}):${reset}`);
    for (const issue of infos) {
      lines.push(`  ${blue}ℹ${reset} ${issue.message}`);
      if (issue.fix) {
        lines.push(`    ${gray}→ ${issue.fix}${reset}`);
      }
    }
    lines.push('');
  }

  // Configuration summary
  if (result.config) {
    lines.push(`${bold}Configuration Summary:${reset}`);
    lines.push(`  Endpoint: ${result.config.endpoint || '(default: /slack/events)'}`);
    lines.push(`  Signing Secret: ${result.config.signing_secret ? '(configured)' : '(missing)'}`);
    lines.push(`  Bot Token: ${result.config.bot_token ? '(configured)' : '(missing)'}`);

    if (result.config.fetch) {
      lines.push(`  Max Messages: ${result.config.fetch.max_messages || 40}`);
      if (result.config.fetch.cache) {
        lines.push(`  Cache TTL: ${result.config.fetch.cache.ttl_seconds || 600} seconds`);
        lines.push(`  Cache Size: ${result.config.fetch.cache.max_threads || 200} threads`);
      }
    }

    if (result.config.channel_allowlist && result.config.channel_allowlist.length > 0) {
      lines.push(`  Channel Allowlist: ${result.config.channel_allowlist.join(', ')}`);
    } else {
      lines.push(`  Channel Allowlist: ${yellow}(none - bot responds in all channels)${reset}`);
    }
    lines.push('');
  }

  // Next steps
  if (!result.valid) {
    lines.push(`${bold}Next Steps:${reset}`);
    lines.push('  1. Fix all errors listed above');
    lines.push('  2. Set missing environment variables');
    lines.push('  3. Run "visor bot validate" again');
    lines.push('  4. Start Visor with "visor --http"');
    lines.push('');
  } else {
    lines.push(`${bold}Next Steps:${reset}`);
    lines.push('  1. Set up your Slack app (see docs/slack-bot-setup.md)');
    lines.push('  2. Configure event subscriptions in Slack app settings');
    lines.push('  3. Start Visor with: visor --http');
    lines.push(
      `  4. Point Slack webhook to: http://your-server:8080${result.config?.endpoint || '/slack/events'}`
    );
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Enhanced token format validation
 */
function validateTokenFormats(botConfig: SlackBotConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Validate bot token format
  if (botConfig.bot_token && !hasEnvVars(botConfig.bot_token)) {
    const token = botConfig.bot_token;

    if (!token.startsWith('xoxb-')) {
      issues.push({
        level: 'error',
        category: 'token_format',
        message: `Bot token must start with 'xoxb-' (got: ${token.substring(0, 10)}...)`,
        fix: 'Ensure you are using a bot token, not a user token or other credential type',
      });
    }

    // Check token length (typical Slack tokens are 40-70 characters)
    if (token.length < 40) {
      issues.push({
        level: 'error',
        category: 'token_format',
        message: 'Bot token appears to be too short',
        fix: 'Verify the token is complete and not truncated',
      });
    }
  }

  // Validate signing secret format
  if (botConfig.signing_secret && !hasEnvVars(botConfig.signing_secret)) {
    const secret = botConfig.signing_secret;

    // Signing secrets are typically 32 hex characters
    if (secret.length < 20) {
      issues.push({
        level: 'warning',
        category: 'secret_format',
        message: 'Signing secret appears to be too short',
        fix: 'Verify the signing secret from Slack app settings is complete',
      });
    }
  }

  return issues;
}

/**
 * Validate endpoint URLs for production
 */
function validateEndpointUrls(botConfig: SlackBotConfig, isProduction: boolean): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!botConfig.endpoint) {
    return issues;
  }

  // In production, recommend HTTPS-friendly paths
  if (isProduction) {
    if (botConfig.endpoint.startsWith('http://')) {
      issues.push({
        level: 'error',
        category: 'production_security',
        message: 'Endpoint should use HTTPS in production',
        fix: 'Configure your load balancer/reverse proxy to use HTTPS',
      });
    }

    // Check for localhost or private IPs
    if (botConfig.endpoint.includes('localhost') || botConfig.endpoint.includes('127.0.0.1')) {
      issues.push({
        level: 'error',
        category: 'production_config',
        message: 'Endpoint contains localhost - not accessible from Slack',
        fix: 'Use a publicly accessible domain or IP address',
      });
    }
  }

  return issues;
}

/**
 * Validate configuration value ranges
 */
function validateConfigRanges(botConfig: SlackBotConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Validate cache TTL ranges
  if (botConfig.fetch?.cache?.ttl_seconds !== undefined) {
    const ttl = botConfig.fetch.cache.ttl_seconds;
    if (ttl < 300) {
      issues.push({
        level: 'warning',
        category: 'cache_tuning',
        message: `Cache TTL is low (${ttl}s). Recommended: 600-3600s for better performance`,
        fix: `Consider increasing TTL to 600s or higher to reduce API calls`,
      });
    }
    if (ttl > 7200) {
      issues.push({
        level: 'warning',
        category: 'cache_tuning',
        message: `Cache TTL is very high (${ttl}s). Data may become stale`,
        fix: 'Consider reducing TTL to 3600s or lower for fresher data',
      });
    }
  }

  // Validate cache size ranges
  if (botConfig.fetch?.cache?.max_threads !== undefined) {
    const maxThreads = botConfig.fetch.cache.max_threads;
    if (maxThreads < 50) {
      issues.push({
        level: 'warning',
        category: 'cache_tuning',
        message: `Cache size is small (${maxThreads} threads). May have low hit rate`,
        fix: 'Consider increasing to 100-500 threads for better caching',
      });
    }
    if (maxThreads > 10000) {
      issues.push({
        level: 'warning',
        category: 'cache_tuning',
        message: `Cache size is very large (${maxThreads} threads). High memory usage`,
        fix: 'Consider reducing to 1000-5000 threads to conserve memory',
      });
    }
  }

  // Validate worker pool queue capacity
  if (botConfig.worker_pool?.queue_capacity !== undefined) {
    const queueSize = botConfig.worker_pool.queue_capacity;
    const poolSize = 3; // Default pool size from visor config

    if (queueSize < poolSize * 10) {
      issues.push({
        level: 'warning',
        category: 'worker_pool',
        message: `Queue capacity (${queueSize}) is small for pool size (${poolSize})`,
        fix: `Recommended: queue_capacity >= ${poolSize * 10} for smooth operation`,
      });
    }
  }

  return issues;
}

/**
 * Cross-field validation
 */
function validateCrossFieldDependencies(botConfig: SlackBotConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Check worker pool queue capacity vs rate limiting alignment
  if (botConfig.worker_pool && botConfig.rate_limiting?.enabled) {
    const queueCapacity = botConfig.worker_pool.queue_capacity || 100;
    const botConcurrent = botConfig.rate_limiting.bot?.concurrent_requests;

    if (botConcurrent && queueCapacity < botConcurrent * 5) {
      issues.push({
        level: 'info',
        category: 'config_alignment',
        message: `Queue capacity (${queueCapacity}) is small relative to concurrent limit (${botConcurrent})`,
        fix: `Consider setting queue_capacity to at least ${botConcurrent * 5} for smoother operation`,
      });
    }
  }

  // Check cache TTL vs prewarming
  if (botConfig.cache_prewarming?.enabled && botConfig.fetch?.cache?.ttl_seconds) {
    const ttl = botConfig.fetch.cache.ttl_seconds;
    if (ttl < 600) {
      issues.push({
        level: 'info',
        category: 'cache_prewarming',
        message: 'Cache prewarming enabled with short TTL. Prewarmed data expires quickly',
        fix: 'Consider increasing cache TTL for better prewarming benefits',
      });
    }
  }

  return issues;
}

/**
 * Analyze performance and provide tuning recommendations
 */
export function analyzePerformance(
  botConfig: SlackBotConfig,
  deploymentSize: 'small' | 'medium' | 'large' = 'medium'
): PerformanceRecommendation[] {
  const recommendations: PerformanceRecommendation[] = [];

  const queueCapacity = botConfig.worker_pool?.queue_capacity || 100;
  const cacheSize = botConfig.fetch?.cache?.max_threads || 200;
  const cacheTTL = botConfig.fetch?.cache?.ttl_seconds || 600;

  // Deployment-specific recommendations
  const optimalCacheSize =
    deploymentSize === 'small' ? 200 : deploymentSize === 'medium' ? 500 : 1000;
  const optimalQueueSize =
    deploymentSize === 'small' ? 50 : deploymentSize === 'medium' ? 100 : 200;

  // Note: Worker pool size is controlled by Visor's max_parallelism, not bot config

  // Cache sizing
  if (cacheSize < optimalCacheSize) {
    recommendations.push({
      level: 'medium',
      category: 'cache_sizing',
      message: `Cache size (${cacheSize} threads) may be too small for ${deploymentSize} deployment`,
      impact: 'Lower cache hit rate, more API calls to Slack',
      suggestion: `Increase fetch.cache.max_threads to ${optimalCacheSize}`,
      estimatedImprovement: 'Estimated 20-30% improvement in cache hit rate',
    });
  }

  // Queue capacity
  if (queueCapacity < optimalQueueSize) {
    recommendations.push({
      level: 'medium',
      category: 'queue_sizing',
      message: `Queue capacity (${queueCapacity}) may be too small, risk of 503 errors`,
      impact: 'Requests may be rejected during traffic spikes',
      suggestion: `Increase worker_pool.queue_capacity to ${optimalQueueSize}`,
      estimatedImprovement: 'Better handling of traffic bursts',
    });
  }

  // Cache TTL optimization
  if (cacheTTL < 600) {
    recommendations.push({
      level: 'high',
      category: 'cache_ttl',
      message: `Cache TTL (${cacheTTL}s) is short, causing frequent API calls`,
      impact: 'Higher API usage, slower response times, risk of rate limiting',
      suggestion: 'Increase fetch.cache.ttl_seconds to 900-1800 for better performance',
      estimatedImprovement: '40-60% reduction in Slack API calls',
    });
  }

  // Rate limiting recommendations
  if (!botConfig.rate_limiting?.enabled) {
    recommendations.push({
      level: 'high',
      category: 'rate_limiting',
      message: 'Rate limiting is not enabled',
      impact: 'Vulnerable to API abuse and resource exhaustion',
      suggestion: 'Enable rate_limiting to protect your bot from abuse',
      estimatedImprovement: 'Protection against denial-of-service and resource exhaustion',
    });
  }

  return recommendations;
}

/**
 * Perform security audit
 */
export function performSecurityAudit(
  botConfig: SlackBotConfig,
  isProduction: boolean
): SecurityAudit[] {
  const audits: SecurityAudit[] = [];

  // Check for hardcoded secrets
  if (botConfig.bot_token && !hasEnvVars(botConfig.bot_token)) {
    audits.push({
      level: 'critical',
      category: 'hardcoded_secrets',
      message: 'Bot token appears to be hardcoded in configuration',
      fix: 'Use environment variables: bot_token: "${SLACK_BOT_TOKEN}"',
    });
  }

  if (botConfig.signing_secret && !hasEnvVars(botConfig.signing_secret)) {
    audits.push({
      level: 'critical',
      category: 'hardcoded_secrets',
      message: 'Signing secret appears to be hardcoded in configuration',
      fix: 'Use environment variables: signing_secret: "${SLACK_SIGNING_SECRET}"',
    });
  }

  // Check HTTPS in production
  if (isProduction && botConfig.endpoint?.startsWith('http://')) {
    audits.push({
      level: 'high',
      category: 'transport_security',
      message: 'HTTP endpoint in production (should use HTTPS)',
      fix: 'Configure TLS/SSL on your load balancer or reverse proxy',
    });
  }

  // Check rate limiting in production
  if (isProduction && !botConfig.rate_limiting?.enabled) {
    audits.push({
      level: 'high',
      category: 'dos_protection',
      message: 'Rate limiting disabled in production',
      fix: 'Enable rate_limiting to prevent abuse and resource exhaustion',
    });
  }

  // Check cache admin token
  if (botConfig.cache_observability?.enable_cache_endpoints) {
    if (!botConfig.cache_observability.cache_admin_token) {
      audits.push({
        level: 'medium',
        category: 'api_security',
        message: 'Cache endpoints enabled without admin token',
        fix: 'Set cache_admin_token to protect write operations',
      });
    } else if (!hasEnvVars(botConfig.cache_observability.cache_admin_token)) {
      audits.push({
        level: 'high',
        category: 'hardcoded_secrets',
        message: 'Cache admin token appears to be hardcoded',
        fix: 'Use environment variable: cache_admin_token: "${CACHE_ADMIN_TOKEN}"',
      });
    }
  }

  // Check channel allowlist
  if (!botConfig.channel_allowlist || botConfig.channel_allowlist.length === 0) {
    audits.push({
      level: isProduction ? 'medium' : 'low',
      category: 'access_control',
      message: 'No channel allowlist configured - bot responds in ALL channels',
      fix: 'Add channel_allowlist to restrict bot access to specific channels',
    });
  }

  // All checks passed
  if (audits.length === 0) {
    audits.push({
      level: 'pass',
      category: 'security',
      message: 'No security issues detected',
    });
  }

  return audits;
}

/**
 * Check production readiness
 */
export function checkProductionReadiness(
  botConfig: SlackBotConfig,
  envVars: EnvVarCheck[]
): ProductionReadiness {
  const critical: string[] = [];
  const warnings: string[] = [];
  const recommendations: string[] = [];

  // Critical checks
  const missingEnvVars = envVars.filter(v => !v.present);
  if (missingEnvVars.length > 0) {
    critical.push(
      `Missing environment variables: ${missingEnvVars.map(v => v.variable).join(', ')}`
    );
  }

  if (!botConfig.bot_token) {
    critical.push('Bot token not configured');
  }

  if (!botConfig.signing_secret) {
    critical.push('Signing secret not configured');
  }

  // Warning checks
  if (!botConfig.rate_limiting?.enabled) {
    warnings.push('Rate limiting not enabled (recommended for production)');
  }

  if (!botConfig.channel_allowlist || botConfig.channel_allowlist.length === 0) {
    warnings.push('No channel allowlist (bot responds in all channels)');
  }

  if (botConfig.endpoint?.startsWith('http://')) {
    warnings.push('HTTP endpoint (HTTPS recommended for production)');
  }

  // Note: Worker pool size comes from Visor's max_parallelism config, not bot config
  const queueCapacityProd = botConfig.worker_pool?.queue_capacity || 100;
  if (queueCapacityProd < 50) {
    warnings.push(`Worker pool queue capacity too small (${queueCapacityProd}, recommended: 100+)`);
  }

  // Recommendations
  if (!botConfig.cache_observability?.enable_cache_endpoints) {
    recommendations.push('Enable cache observability for monitoring');
  }

  if (!botConfig.cache_prewarming?.enabled) {
    recommendations.push('Consider cache prewarming for faster startup');
  }

  const cacheTTL = botConfig.fetch?.cache?.ttl_seconds || 600;
  if (cacheTTL < 600) {
    recommendations.push('Increase cache TTL to 600s+ for better performance');
  }

  return {
    passed: critical.length === 0,
    critical,
    warnings,
    recommendations,
  };
}

/**
 * Estimate memory usage
 */
export function estimateMemoryUsage(botConfig: SlackBotConfig): MemoryEstimation {
  const maxThreads = botConfig.fetch?.cache?.max_threads || 200;
  const avgMessagesPerThread = botConfig.fetch?.max_messages || 40;
  const queueCapacity = botConfig.worker_pool?.queue_capacity || 100;

  // Estimate cache memory (rough approximation)
  // Each message: ~2KB average (text + metadata)
  const bytesPerMessage = 2048;
  const cacheMemoryBytes = maxThreads * avgMessagesPerThread * bytesPerMessage;
  const cacheMB = Math.round(cacheMemoryBytes / (1024 * 1024));

  // Worker pool memory
  // Assume default 3 workers from Visor config + queued work items
  const workerPoolMB = Math.round(3 * 10 + queueCapacity * 0.5);

  // Rate limit state (if enabled)
  const rateLimitMB = botConfig.rate_limiting?.enabled ? 5 : 0;

  // Base overhead (Node.js runtime, dependencies, etc.)
  const overheadMB = 50;

  const totalMB = cacheMB + workerPoolMB + rateLimitMB + overheadMB;

  return {
    totalMB,
    breakdown: {
      cache: cacheMB,
      workerPool: workerPoolMB,
      rateLimit: rateLimitMB,
      overhead: overheadMB,
    },
  };
}

/**
 * Enhanced validation with all features
 */
export async function validateSlackConfigEnhanced(
  config: SlackConfig | undefined,
  options: {
    checkApi?: boolean;
    strict?: boolean;
    performance?: boolean;
    security?: boolean;
    production?: boolean;
    deploymentSize?: 'small' | 'medium' | 'large';
  } = {}
): Promise<ValidationResult> {
  // Start with basic validation
  const basicResult = await validateSlackConfig(config, { checkApi: options.checkApi });

  // If we don't have config, return early
  if (!config) {
    return basicResult;
  }

  // For enhanced validation, continue even if basic validation failed
  // We want to provide additional insights even for invalid configs

  // Get bot config (handle both legacy and multi-bot formats)
  const botConfigs: SlackBotConfig[] = config.bots || [];
  if (botConfigs.length === 0 && config.endpoint) {
    // Legacy format - create a synthetic bot config
    botConfigs.push({
      id: 'default',
      endpoint: config.endpoint,
      signing_secret: config.signing_secret || '',
      bot_token: config.bot_token || '',
      mentions: config.mentions,
      threads: config.threads,
      fetch: config.fetch,
      channel_allowlist: config.channel_allowlist,
      response: config.response,
      worker_pool: config.worker_pool,
      cache_observability: config.cache_observability,
      cache_prewarming: config.cache_prewarming,
      rate_limiting: config.rate_limiting,
    });
  }

  // Enhanced validation for each bot
  const allIssues = [...basicResult.issues];
  for (const botConfig of botConfigs) {
    allIssues.push(...validateTokenFormats(botConfig));
    allIssues.push(...validateEndpointUrls(botConfig, options.production || false));
    allIssues.push(...validateConfigRanges(botConfig));
    allIssues.push(...validateCrossFieldDependencies(botConfig));
  }

  // Performance analysis
  const performanceRecs: PerformanceRecommendation[] = [];
  if (options.performance || options.strict) {
    for (const botConfig of botConfigs) {
      performanceRecs.push(...analyzePerformance(botConfig, options.deploymentSize || 'medium'));
    }
  }

  // Security audit
  const securityAudits: SecurityAudit[] = [];
  if (options.security || options.strict || options.production) {
    for (const botConfig of botConfigs) {
      securityAudits.push(...performSecurityAudit(botConfig, options.production || false));
    }
  }

  // Production readiness
  let prodReadiness: ProductionReadiness | undefined;
  if (options.production || options.strict) {
    const criticalList: string[] = [];
    const warningsList: string[] = [];
    const recommendationsList: string[] = [];

    for (const botConfig of botConfigs) {
      const readiness = checkProductionReadiness(botConfig, basicResult.envVars);
      criticalList.push(...readiness.critical);
      warningsList.push(...readiness.warnings);
      recommendationsList.push(...readiness.recommendations);
    }

    prodReadiness = {
      passed: criticalList.length === 0,
      critical: criticalList,
      warnings: warningsList,
      recommendations: recommendationsList,
    };
  }

  // Memory estimation
  let memoryEst: MemoryEstimation | undefined;
  if (options.performance || options.strict) {
    // Estimate for first bot (or aggregate for multi-bot)
    if (botConfigs.length > 0) {
      const estimates = botConfigs.map(estimateMemoryUsage);
      memoryEst = estimates.reduce((acc, est) => ({
        totalMB: acc.totalMB + est.totalMB,
        breakdown: {
          cache: acc.breakdown.cache + est.breakdown.cache,
          workerPool: acc.breakdown.workerPool + est.breakdown.workerPool,
          rateLimit: acc.breakdown.rateLimit + est.breakdown.rateLimit,
          overhead: acc.breakdown.overhead,
        },
      }));
    }
  }

  // Add security issues as regular issues in strict mode
  if (options.strict && securityAudits.length > 0) {
    for (const audit of securityAudits) {
      if (audit.level !== 'pass') {
        allIssues.push({
          level: audit.level === 'critical' ? 'error' : 'warning',
          category: audit.category,
          message: audit.message,
          fix: audit.fix,
        });
      }
    }
  }

  // Determine overall validity (in strict mode, warnings also fail)
  const hasErrors = allIssues.some(i => i.level === 'error');
  const hasWarnings = allIssues.some(i => i.level === 'warning');
  const valid = options.strict ? !hasErrors && !hasWarnings : !hasErrors;

  return {
    valid,
    issues: allIssues,
    envVars: basicResult.envVars,
    config: basicResult.config,
    performance: performanceRecs.length > 0 ? performanceRecs : undefined,
    security: securityAudits.length > 0 ? securityAudits : undefined,
    production: prodReadiness,
    memoryEstimation: memoryEst,
  };
}

/**
 * Format enhanced validation result for console output
 */
export function formatEnhancedValidationResult(result: ValidationResult, useColors = true): string {
  const lines: string[] = [];

  // Color codes
  const red = useColors ? '\x1b[31m' : '';
  const yellow = useColors ? '\x1b[33m' : '';
  const green = useColors ? '\x1b[32m' : '';
  const blue = useColors ? '\x1b[34m' : '';
  const cyan = useColors ? '\x1b[36m' : '';
  const magenta = useColors ? '\x1b[35m' : '';
  const gray = useColors ? '\x1b[90m' : '';
  const reset = useColors ? '\x1b[0m' : '';
  const bold = useColors ? '\x1b[1m' : '';

  // Header
  lines.push('');
  lines.push(`${bold}Enhanced Slack Bot Validation Report${reset}`);
  lines.push('═'.repeat(80));
  lines.push('');

  // Overall status
  if (result.valid) {
    lines.push(`${green}✓ Configuration is valid${reset}`);
  } else {
    lines.push(`${red}✗ Configuration has errors${reset}`);
  }
  lines.push('');

  // Issues section (existing)
  const errors = result.issues.filter(i => i.level === 'error');
  const warnings = result.issues.filter(i => i.level === 'warning');
  const infos = result.issues.filter(i => i.level === 'info');

  if (errors.length > 0) {
    lines.push(`${red}${bold}Errors (${errors.length}):${reset}`);
    for (const issue of errors) {
      lines.push(`  ${red}✗${reset} ${issue.message}`);
      if (issue.fix) {
        lines.push(`    ${gray}→ ${issue.fix}${reset}`);
      }
    }
    lines.push('');
  }

  if (warnings.length > 0) {
    lines.push(`${yellow}${bold}Warnings (${warnings.length}):${reset}`);
    for (const issue of warnings) {
      lines.push(`  ${yellow}⚠${reset} ${issue.message}`);
      if (issue.fix) {
        lines.push(`    ${gray}→ ${issue.fix}${reset}`);
      }
    }
    lines.push('');
  }

  if (infos.length > 0) {
    lines.push(`${blue}${bold}Info (${infos.length}):${reset}`);
    for (const issue of infos) {
      lines.push(`  ${blue}ℹ${reset} ${issue.message}`);
      if (issue.fix) {
        lines.push(`    ${gray}→ ${issue.fix}${reset}`);
      }
    }
    lines.push('');
  }

  // Performance recommendations
  if (result.performance && result.performance.length > 0) {
    lines.push(`${cyan}${bold}Performance Recommendations (${result.performance.length}):${reset}`);
    const criticalPerf = result.performance.filter(p => p.level === 'critical');
    const highPerf = result.performance.filter(p => p.level === 'high');
    const mediumPerf = result.performance.filter(p => p.level === 'medium');
    const lowPerf = result.performance.filter(p => p.level === 'low');

    for (const perf of [...criticalPerf, ...highPerf, ...mediumPerf, ...lowPerf]) {
      const levelColor =
        perf.level === 'critical'
          ? red
          : perf.level === 'high'
            ? yellow
            : perf.level === 'medium'
              ? cyan
              : gray;
      const levelIcon =
        perf.level === 'critical'
          ? '🔴'
          : perf.level === 'high'
            ? '🟡'
            : perf.level === 'medium'
              ? '🔵'
              : '⚪';

      lines.push(
        `  ${levelIcon} ${levelColor}[${perf.level.toUpperCase()}]${reset} ${perf.message}`
      );
      lines.push(`    ${gray}Impact: ${perf.impact}${reset}`);
      lines.push(`    ${green}→ ${perf.suggestion}${reset}`);
      if (perf.estimatedImprovement) {
        lines.push(`    ${cyan}✓ ${perf.estimatedImprovement}${reset}`);
      }
      lines.push('');
    }
  }

  // Security audit
  if (result.security && result.security.length > 0) {
    const securityIssues = result.security.filter(s => s.level !== 'pass');
    if (securityIssues.length > 0) {
      lines.push(`${magenta}${bold}Security Audit (${securityIssues.length} issues):${reset}`);

      const criticalSec = securityIssues.filter(s => s.level === 'critical');
      const highSec = securityIssues.filter(s => s.level === 'high');
      const mediumSec = securityIssues.filter(s => s.level === 'medium');
      const lowSec = securityIssues.filter(s => s.level === 'low');

      for (const sec of [...criticalSec, ...highSec, ...mediumSec, ...lowSec]) {
        const levelColor =
          sec.level === 'critical'
            ? red
            : sec.level === 'high'
              ? yellow
              : sec.level === 'medium'
                ? cyan
                : gray;
        const levelIcon =
          sec.level === 'critical'
            ? '⛔'
            : sec.level === 'high'
              ? '⚠️'
              : sec.level === 'medium'
                ? '🔸'
                : 'ℹ️';

        lines.push(
          `  ${levelIcon} ${levelColor}[${sec.level.toUpperCase()}]${reset} ${sec.message}`
        );
        if (sec.fix) {
          lines.push(`    ${green}→ ${sec.fix}${reset}`);
        }
      }
      lines.push('');
    } else {
      lines.push(`${green}${bold}Security Audit:${reset}`);
      lines.push(`  ${green}✓ No security issues detected${reset}`);
      lines.push('');
    }
  }

  // Production readiness
  if (result.production) {
    lines.push(`${bold}Production Readiness:${reset}`);

    if (result.production.passed) {
      lines.push(`  ${green}✓ Passed all critical checks${reset}`);
    } else {
      lines.push(`  ${red}✗ Failed critical checks${reset}`);
    }

    if (result.production.critical.length > 0) {
      lines.push(`  ${red}${bold}Critical Issues:${reset}`);
      for (const issue of result.production.critical) {
        lines.push(`    ${red}⛔ ${issue}${reset}`);
      }
    }

    if (result.production.warnings.length > 0) {
      lines.push(`  ${yellow}${bold}Warnings:${reset}`);
      for (const warning of result.production.warnings) {
        lines.push(`    ${yellow}⚠ ${warning}${reset}`);
      }
    }

    if (result.production.recommendations.length > 0) {
      lines.push(`  ${blue}${bold}Recommendations:${reset}`);
      for (const rec of result.production.recommendations) {
        lines.push(`    ${blue}ℹ ${rec}${reset}`);
      }
    }
    lines.push('');
  }

  // Memory estimation
  if (result.memoryEstimation) {
    lines.push(`${bold}Estimated Memory Usage:${reset}`);
    lines.push(`  Total: ${cyan}${result.memoryEstimation.totalMB} MB${reset}`);
    lines.push(`  Breakdown:`);
    lines.push(`    Cache:       ${result.memoryEstimation.breakdown.cache} MB`);
    lines.push(`    Worker Pool: ${result.memoryEstimation.breakdown.workerPool} MB`);
    lines.push(`    Rate Limit:  ${result.memoryEstimation.breakdown.rateLimit} MB`);
    lines.push(`    Overhead:    ${result.memoryEstimation.breakdown.overhead} MB`);
    lines.push('');
  }

  // Environment variables (if present)
  if (result.envVars.length > 0) {
    lines.push(`${bold}Environment Variables:${reset}`);
    for (const envVar of result.envVars) {
      const status = envVar.present ? `${green}✓${reset}` : `${red}✗${reset}`;
      const value = envVar.present ? `${gray}(set)${reset}` : `${red}(missing)${reset}`;
      lines.push(`  ${status} ${envVar.variable} ${value}`);
    }
    lines.push('');
  }

  // Next steps
  if (!result.valid) {
    lines.push(`${bold}Next Steps:${reset}`);
    lines.push('  1. Fix all errors and warnings listed above');
    lines.push('  2. Set missing environment variables');
    lines.push('  3. Run validation again');
    lines.push('');
  } else if (result.production && !result.production.passed) {
    lines.push(`${bold}Next Steps:${reset}`);
    lines.push('  1. Address critical production readiness issues');
    lines.push('  2. Review and implement performance recommendations');
    lines.push('  3. Run validation with --production flag');
    lines.push('');
  } else {
    lines.push(`${green}${bold}✓ Configuration is production-ready!${reset}`);
    lines.push('');
  }

  return lines.join('\n');
}
