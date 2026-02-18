/** Bot transport types (trimmed for Slack v1) */

export type BotTransportType = 'slack' | string;

/** Slack file attachment metadata */
export interface SlackFileAttachment {
  id: string;
  name?: string;
  mimetype?: string;
  filetype?: string;
  url_private?: string;
  permalink?: string;
  size?: number;
}

export interface NormalizedMessage {
  role: 'user' | 'bot';
  text: string;
  timestamp: string;
  origin?: string;
  /** Optional user identifier (e.g., Slack user id, GitHub login) */
  user?: string;
  /** File attachments from Slack messages */
  files?: SlackFileAttachment[];
}

export interface ConversationContext {
  transport: BotTransportType;
  thread: { id: string; url?: string };
  messages: NormalizedMessage[];
  current: NormalizedMessage;
  attributes: Record<string, string>;
}

export interface SlackCacheConfig {
  ttl_seconds?: number;
  max_threads?: number;
}

export interface SlackFetchConfig {
  scope: 'thread';
  max_messages?: number;
  cache?: SlackCacheConfig;
}

export interface SlackResponseConfig {
  fallback?: string;
}

export interface SlackWorkerPoolConfig {
  queue_capacity?: number;
  task_timeout?: number;
}

export interface SlackCacheObservabilityConfig {
  enable_cache_endpoints?: boolean;
  cache_admin_token?: string;
}

export interface SlackCachePrewarmingConfig {
  enabled?: boolean;
  channels?: string[];
  users?: string[];
  max_threads_per_channel?: number;
  concurrency?: number;
  rate_limit_ms?: number;
}

export interface SlackRateLimitDimensionConfig {
  requests_per_minute?: number;
  requests_per_hour?: number;
  concurrent_requests?: number;
}

export interface SlackRateLimitActionsConfig {
  send_ephemeral_message?: boolean;
  ephemeral_message?: string;
  queue_when_near_limit?: boolean;
  queue_threshold?: number;
}

export interface SlackRateLimitRedisConfig {
  url: string;
  key_prefix?: string;
}

export interface SlackRateLimitStorageConfig {
  type?: 'memory' | 'redis';
  redis?: SlackRateLimitRedisConfig;
}

export interface SlackRateLimitConfig {
  enabled?: boolean;
  bot?: SlackRateLimitDimensionConfig;
  user?: SlackRateLimitDimensionConfig;
  channel?: SlackRateLimitDimensionConfig;
  global?: SlackRateLimitDimensionConfig;
  actions?: SlackRateLimitActionsConfig;
  storage?: SlackRateLimitStorageConfig;
}

/**
 * Limits configuration for Slack reminders
 */
export interface SlackReminderLimitsConfig {
  /** Maximum reminders per user (default: 25) */
  max_per_user?: number;
  /** Maximum recurring reminders per user (default: 10) */
  max_recurring_per_user?: number;
  /** Maximum reminders per channel (default: 100) */
  max_per_channel?: number;
  /** Maximum total reminders (default: 1000) */
  max_global?: number;
}

/**
 * Storage configuration for Slack reminders
 */
export interface SlackReminderStorageConfig {
  /** Path to the reminders JSON file (default: .visor/reminders.json) */
  path?: string;
}

/**
 * Configuration for Slack reminders/scheduling feature
 */
export interface SlackRemindersConfig {
  /** Enable/disable reminders feature (default: true) */
  enabled?: boolean;
  /** Storage configuration */
  storage?: SlackReminderStorageConfig;
  /** Reminder limits */
  limits?: SlackReminderLimitsConfig;
  /** Default timezone for reminders (default: UTC) */
  default_timezone?: string;
}

export interface SlackBotConfig {
  id: string;
  endpoint: string;
  signing_secret: string;
  bot_token: string;
  mentions?: 'direct';
  threads?: 'required';
  fetch?: SlackFetchConfig;
  channel_allowlist?: string[];
  response?: SlackResponseConfig;
  worker_pool?: SlackWorkerPoolConfig;
  cache_observability?: SlackCacheObservabilityConfig;
  cache_prewarming?: SlackCachePrewarmingConfig;
  rate_limiting?: SlackRateLimitConfig;
  workflow?: string;
}

export interface SlackConfig {
  bots?: SlackBotConfig[];
  endpoint?: string;
  signing_secret?: string;
  bot_token?: string;
  mentions?: 'direct';
  threads?: 'required' | 'any';
  fetch?: SlackFetchConfig;
  channel_allowlist?: string[];
  response?: SlackResponseConfig;
  worker_pool?: SlackWorkerPoolConfig;
  cache_observability?: SlackCacheObservabilityConfig;
  cache_prewarming?: SlackCachePrewarmingConfig;
  rate_limiting?: SlackRateLimitConfig;
  workflow?: string;
  /** Reminders/scheduling configuration */
  reminders?: SlackRemindersConfig;
}
