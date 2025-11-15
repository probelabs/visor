/**
 * Bot transport types for Visor
 * Supports Slack, email, and other conversational interfaces
 */

/**
 * Transport types supported by bot integrations
 */
export type BotTransportType = 'slack' | 'email' | string;

/**
 * Normalized message format across all transports
 */
export interface NormalizedMessage {
  /** Message role: user or bot */
  role: 'user' | 'bot';
  /** Message text content */
  text: string;
  /** Message timestamp */
  timestamp: string;
  /** Origin identifier (e.g., 'visor', 'human') */
  origin?: string;
}

/**
 * Bot session context available to checks and templates
 */
export interface BotSessionContext {
  /** Unique session identifier */
  id: string;
  /** Bot identifier (for multi-bot deployments) */
  botId?: string;
  /** Transport type (slack, email, etc.) */
  transport: BotTransportType;
  /** Current message that triggered this execution */
  currentMessage: NormalizedMessage;
  /** Full message history in this conversation */
  history: NormalizedMessage[];
  /** Transport-specific attributes (e.g., channel, user) */
  attributes: Record<string, string>;
  /** Optional transport state (cache hints, dedupe ids) */
  state?: Record<string, unknown>;
}

/**
 * Conversation context provided by transport adapters
 * Similar structure to BotSessionContext but with thread information
 */
export interface ConversationContext {
  /** Transport type */
  transport: BotTransportType;
  /** Thread/conversation identifier */
  thread: {
    /** Unique thread ID */
    id: string;
    /** URL to the thread (if applicable) */
    url?: string;
  };
  /** Message history in this conversation */
  messages: NormalizedMessage[];
  /** Current message that triggered execution */
  current: NormalizedMessage;
  /** Transport-specific attributes */
  attributes: Record<string, string>;
}

/**
 * Slack-specific cache configuration
 */
export interface SlackCacheConfig {
  /** Cache TTL in seconds (default: 600) */
  ttl_seconds?: number;
  /** Maximum number of threads to cache (default: 200) */
  max_threads?: number;
}

/**
 * Slack fetch configuration for retrieving conversation history
 */
export interface SlackFetchConfig {
  /** Fetch scope: 'thread' (only supported option for now) */
  scope: 'thread';
  /** Maximum number of messages to fetch (default: 40) */
  max_messages?: number;
  /** Cache configuration */
  cache?: SlackCacheConfig;
}

/**
 * Slack response configuration
 */
export interface SlackResponseConfig {
  /** Fallback message on errors */
  fallback?: string;
}

/**
 * Slack worker pool configuration
 */
export interface SlackWorkerPoolConfig {
  /** Maximum queue size (default: 100). When full, new tasks are rejected with 503 */
  queue_capacity?: number;
  /** Task timeout in milliseconds (default: 5 minutes) */
  task_timeout?: number;
}

/**
 * Slack cache observability configuration
 */
export interface SlackCacheObservabilityConfig {
  /** Enable cache monitoring endpoints (default: false for security) */
  enable_cache_endpoints?: boolean;
  /** Optional bearer token for admin endpoints (POST/DELETE operations) */
  cache_admin_token?: string;
}

/**
 * Cache prewarming configuration
 */
export interface SlackCachePrewarmingConfig {
  /** Enable cache prewarming on bot startup (default: false) */
  enabled?: boolean;
  /** Channels to prewarm (fetch recent threads from these channels) */
  channels?: string[];
  /** Users to prewarm (fetch recent DMs/threads with these users) */
  users?: string[];
  /** Maximum number of threads to fetch per channel (default: 20) */
  max_threads_per_channel?: number;
  /** Concurrency for prewarming operations (default: 5) */
  concurrency?: number;
  /** Rate limit delay between API calls in milliseconds (default: 100) */
  rate_limit_ms?: number;
}

/**
 * Rate limit configuration for a single dimension
 */
export interface SlackRateLimitDimensionConfig {
  /** Maximum requests per minute (0 or undefined = unlimited) */
  requests_per_minute?: number;
  /** Maximum requests per hour (0 or undefined = unlimited) */
  requests_per_hour?: number;
  /** Maximum concurrent requests (0 or undefined = unlimited) */
  concurrent_requests?: number;
}

/**
 * Actions to take when rate limited
 */
export interface SlackRateLimitActionsConfig {
  /** Send ephemeral message to user when rate limited (default: true) */
  send_ephemeral_message?: boolean;
  /** Ephemeral message text */
  ephemeral_message?: string;
  /** Queue requests when near limit threshold (default: false) */
  queue_when_near_limit?: boolean;
  /** Queue threshold as percentage (0.0-1.0, default: 0.8) */
  queue_threshold?: number;
}

/**
 * Redis storage configuration for rate limiting
 */
export interface SlackRateLimitRedisConfig {
  /** Redis connection URL (e.g., redis://localhost:6379) */
  url: string;
  /** Key prefix for Redis keys (default: "visor:ratelimit:") */
  key_prefix?: string;
}

/**
 * Rate limit storage configuration
 */
export interface SlackRateLimitStorageConfig {
  /** Storage type (default: 'memory') */
  type?: 'memory' | 'redis';
  /** Redis configuration (required if type is 'redis') */
  redis?: SlackRateLimitRedisConfig;
}

/**
 * Complete rate limiting configuration
 */
export interface SlackRateLimitConfig {
  /** Enable rate limiting (default: false) */
  enabled?: boolean;
  /** Per-bot limits (all requests to this bot) */
  bot?: SlackRateLimitDimensionConfig;
  /** Per-user limits (per Slack user) */
  user?: SlackRateLimitDimensionConfig;
  /** Per-channel limits (per Slack channel) */
  channel?: SlackRateLimitDimensionConfig;
  /** Global limits (across all dimensions) */
  global?: SlackRateLimitDimensionConfig;
  /** Actions when rate limited */
  actions?: SlackRateLimitActionsConfig;
  /** Storage backend configuration */
  storage?: SlackRateLimitStorageConfig;
}

/**
 * Individual Slack bot configuration (for multi-bot deployments)
 */
export interface SlackBotConfig {
  /** Unique bot identifier (DNS-safe: lowercase, alphanumeric, hyphens) */
  id: string;
  /** HTTP endpoint path (must be unique across all bots) */
  endpoint: string;
  /** Slack signing secret for request verification */
  signing_secret: string;
  /** Slack bot token for API calls */
  bot_token: string;
  /** Mention handling: 'direct' (only supported option for now) */
  mentions?: 'direct';
  /** Thread handling: 'required' (only supported option for now) */
  threads?: 'required';
  /** Fetch configuration for conversation history */
  fetch?: SlackFetchConfig;
  /** Channel allowlist (glob patterns, e.g., ["CENG*", "CSUPPORT"]) */
  channel_allowlist?: string[];
  /** Response configuration */
  response?: SlackResponseConfig;
  /** Worker pool configuration for concurrent workflow execution */
  worker_pool?: SlackWorkerPoolConfig;
  /** Cache observability configuration */
  cache_observability?: SlackCacheObservabilityConfig;
  /** Cache prewarming configuration */
  cache_prewarming?: SlackCachePrewarmingConfig;
  /** Rate limiting configuration */
  rate_limiting?: SlackRateLimitConfig;
  /** Workflow to run for this bot (overrides global workflow selection) */
  workflow?: string;
}

/**
 * Slack bot configuration (supports both single bot and multi-bot formats)
 */
export interface SlackConfig {
  /** Multi-bot configuration (new format) */
  bots?: SlackBotConfig[];

  /** Legacy single bot configuration (backward compatibility) */
  /** HTTP endpoint path (auto-generated if omitted) */
  endpoint?: string;
  /** Slack signing secret for request verification */
  signing_secret?: string;
  /** Slack bot token for API calls */
  bot_token?: string;
  /** Mention handling: 'direct' (only supported option for now) */
  mentions?: 'direct';
  /** Thread handling: 'required' (only supported option for now) */
  threads?: 'required';
  /** Fetch configuration for conversation history */
  fetch?: SlackFetchConfig;
  /** Channel allowlist (glob patterns, e.g., ["CENG*", "CSUPPORT"]) */
  channel_allowlist?: string[];
  /** Response configuration */
  response?: SlackResponseConfig;
  /** Worker pool configuration for concurrent workflow execution */
  worker_pool?: SlackWorkerPoolConfig;
  /** Cache observability configuration */
  cache_observability?: SlackCacheObservabilityConfig;
  /** Cache prewarming configuration */
  cache_prewarming?: SlackCachePrewarmingConfig;
  /** Rate limiting configuration */
  rate_limiting?: SlackRateLimitConfig;
  /** Workflow to run for this bot (overrides global workflow selection) */
  workflow?: string;
}
