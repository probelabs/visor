/**
 * Types for Visor configuration system
 */

// Import ReviewSummary for type definitions
import type { ReviewSummary, ReviewIssue } from '../reviewer';

// Export Issue type for backward compatibility
export type Issue = ReviewIssue;

/**
 * Failure condition severity levels
 */
export type FailureConditionSeverity = 'error' | 'warning' | 'info';

/**
 * Simple failure condition - just an expression string
 */
export type SimpleFailureCondition = string;

/**
 * Complex failure condition with additional metadata
 */
export interface ComplexFailureCondition {
  /** Expression to evaluate using Function Constructor */
  condition: string;
  /** Human-readable message when condition is met */
  message?: string;
  /** Severity level of the failure */
  severity?: FailureConditionSeverity;
  /** Whether this condition should halt execution */
  halt_execution?: boolean;
}

/**
 * Failure condition - can be a simple expression string or complex object
 */
export type FailureCondition = SimpleFailureCondition | ComplexFailureCondition;

/**
 * Collection of failure conditions
 */
export interface FailureConditions {
  [conditionName: string]: FailureCondition;
}

/**
 * Context object available to expressions for failure condition evaluation
 */
export interface FailureConditionContext {
  /** Check results - raw output from the check/schema */
  output: {
    /** Check results */
    issues?: Array<{
      file: string;
      line: number;
      endLine?: number;
      ruleId: string;
      message: string;
      severity: 'info' | 'warning' | 'error' | 'critical';
      category: 'security' | 'performance' | 'style' | 'logic' | 'documentation';
      group?: string;
      schema?: string;
      suggestion?: string;
      replacement?: string;
    }>;

    /** Array of suggestions from the check */
    suggestions?: string[];

    /** Any additional fields provided by the check/schema */
    [key: string]: unknown;
  };

  /** Previous check outputs for dependencies - keyed by check name */
  outputs?: Record<string, ReviewSummary>;

  /** Check context information */
  checkName?: string;
  schema?: string;
  group?: string;

  /** Git context for if conditions */
  branch?: string;
  baseBranch?: string;
  filesChanged?: string[];
  filesCount?: number;
  hasChanges?: boolean;

  /** GitHub event context */
  event?: {
    /** GitHub event name (e.g., 'pull_request', 'issues', 'push') */
    event_name: string;
    /** Action that triggered the event (e.g., 'opened', 'closed', 'synchronize') */
    action?: string;
    /** Repository information */
    repository?: {
      owner: { login: string };
      name: string;
    };
    /** Pull request data (for PR events) */
    pull_request?: {
      number: number;
      state: string;
      head: { sha: string; ref: string };
      base: { sha: string; ref: string };
    };
    /** Issue data (for issue events) */
    issue?: {
      number: number;
      pull_request?: { url: string };
    };
    /** Comment data (for comment events) */
    comment?: {
      body: string;
      user: { login: string };
    };
    /** Additional webhook payload data */
    [key: string]: unknown;
  };

  /** Environment variables */
  env?: Record<string, string>;

  /** Utility metadata for backward compatibility */
  metadata?: {
    checkName: string;
    schema: string;
    group: string;
    criticalIssues: number;
    errorIssues: number;
    warningIssues: number;
    infoIssues: number;
    totalIssues: number;
    hasChanges: boolean;
    branch: string;
    event: string;
  };

  /** Debug information (if available) */
  debug?: {
    /** Any errors that occurred during processing */
    errors: string[];
    /** Processing time in milliseconds */
    processingTime: number;
    /** AI provider used */
    provider: string;
    /** AI model used */
    model: string;
  };
}

/**
 * Result of failure condition evaluation
 */
export interface FailureConditionResult {
  /** Name of the condition that was evaluated */
  conditionName: string;
  /** Whether the condition evaluated to true (failure) */
  failed: boolean;
  /** The expression that was evaluated */
  expression: string;
  /** Human-readable message */
  message?: string;
  /** Severity of the failure */
  severity: FailureConditionSeverity;
  /** Whether execution should halt */
  haltExecution: boolean;
  /** Error message if evaluation failed */
  error?: string;
}

/**
 * Valid check types in configuration
 */
export type ConfigCheckType =
  | 'ai'
  | 'tool'
  | 'http'
  | 'http_input'
  | 'http_client'
  | 'noop'
  | 'claude-code';

/**
 * Valid event triggers for checks
 */
export type EventTrigger =
  | 'pr_opened'
  | 'pr_updated'
  | 'pr_closed'
  | 'issue_opened'
  | 'issue_comment'
  | 'manual'
  | 'schedule'
  | 'webhook_received';

/**
 * Valid output formats
 */
export type ConfigOutputFormat = 'table' | 'json' | 'markdown' | 'sarif';

/**
 * Valid grouping options
 */
export type GroupByOption = 'check' | 'file' | 'severity';

/**
 * Environment variable reference configuration
 */
export interface EnvConfig {
  [key: string]: string | number | boolean;
}

/**
 * AI provider configuration
 */
export interface AIProviderConfig {
  /** AI provider to use */
  provider?: 'google' | 'anthropic' | 'openai' | 'mock';
  /** Model name to use */
  model?: string;
  /** API key (usually from environment variables) */
  apiKey?: string;
  /** Request timeout in milliseconds */
  timeout?: number;
}

/**
 * MCP Server configuration
 */
export interface McpServerConfig {
  /** Command to execute for the MCP server */
  command: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Environment variables for the MCP server */
  env?: Record<string, string>;
}

/**
 * Claude Code configuration
 */
export interface ClaudeCodeConfig {
  /** List of allowed tools for Claude Code to use */
  allowedTools?: string[];
  /** Maximum number of turns in conversation */
  maxTurns?: number;
  /** System prompt for Claude Code */
  systemPrompt?: string;
  /** MCP servers configuration */
  mcpServers?: Record<string, McpServerConfig>;
  /** Path to subagent script */
  subagent?: string;
  /** Event hooks for lifecycle management */
  hooks?: {
    /** Called when check starts */
    onStart?: string;
    /** Called when check ends */
    onEnd?: string;
    /** Called when check encounters an error */
    onError?: string;
  };
}

/**
 * Configuration for a single check
 */
export interface CheckConfig {
  /** Type of check to perform (defaults to 'ai' if not specified) */
  type?: ConfigCheckType;
  /** AI prompt for the check - can be inline string or file path (auto-detected) - required for AI checks */
  prompt?: string;
  /** Additional prompt to append when extending configurations - merged with parent prompt */
  appendPrompt?: string;
  /** Tool execution command with Liquid template support - required for tool checks */
  exec?: string;
  /** Stdin input for tools with Liquid template support - optional for tool checks */
  stdin?: string;
  /** HTTP URL - required for http output checks */
  url?: string;
  /** HTTP body template (Liquid) - required for http output checks */
  body?: string;
  /** HTTP method (defaults to POST) */
  method?: string;
  /** HTTP headers */
  headers?: Record<string, string>;
  /** HTTP endpoint path - required for http_input checks */
  endpoint?: string;
  /** Transform template for http_input data (Liquid) - optional */
  transform?: string;
  /** Cron schedule expression (e.g., "0 2 * * *") - optional for any check type */
  schedule?: string;
  /** Focus area for the check (security/performance/style/architecture/all) - optional */
  focus?: string;
  /** Command that triggers this check (e.g., "review", "security-scan") - optional */
  command?: string;
  /** Events that trigger this check (defaults to ['manual'] if not specified) */
  on?: EventTrigger[];
  /** File patterns that trigger this check (optional) */
  triggers?: string[];
  /** AI provider configuration (optional) */
  ai?: AIProviderConfig;
  /** AI model to use for this check - overrides global setting */
  ai_model?: string;
  /** AI provider to use for this check - overrides global setting */
  ai_provider?: 'google' | 'anthropic' | 'openai' | 'mock' | string;
  /** Claude Code configuration (for claude-code type checks) */
  claude_code?: ClaudeCodeConfig;
  /** Environment variables for this check */
  env?: EnvConfig;
  /** Check IDs that this check depends on (optional) */
  depends_on?: string[];
  /** Group name for comment separation (e.g., "code-review", "pr-overview") - optional */
  group?: string;
  /** Schema type for template rendering (e.g., "code-review", "markdown") - optional */
  schema?: string;
  /** Custom template configuration - optional */
  template?: CustomTemplateConfig;
  /** Condition to determine if check should run - runs if expression evaluates to true */
  if?: string;
  /** Whether to reuse AI session from dependency checks (only works with depends_on) */
  reuse_ai_session?: boolean;
  /** Simple fail condition - fails check if expression evaluates to true */
  fail_if?: string;
  /** Check-specific failure conditions - optional (deprecated, use fail_if) */
  failure_conditions?: FailureConditions;
}

/**
 * Custom template configuration
 */
export interface CustomTemplateConfig {
  /** Path to custom template file (relative to config file or absolute) */
  file?: string;
  /** Raw template content as string */
  content?: string;
}

/**
 * Prompt configuration - supports both string and file reference
 */
export interface PromptConfig {
  /** Raw prompt content as string (supports Liquid templates) */
  content?: string;
  /** Path to prompt file (relative to config file or absolute) */
  file?: string;
}

/**
 * Debug mode configuration
 */
export interface DebugConfig {
  /** Enable debug mode */
  enabled: boolean;
  /** Include AI prompts in debug output */
  includePrompts: boolean;
  /** Include raw AI responses in debug output */
  includeRawResponses: boolean;
  /** Include timing information */
  includeTiming: boolean;
  /** Include provider information */
  includeProviderInfo: boolean;
}

/**
 * PR comment output configuration
 */
export interface PrCommentOutput {
  /** Format of the output */
  format: ConfigOutputFormat;
  /** How to group the results */
  group_by: GroupByOption;
  /** Whether to collapse sections by default */
  collapse: boolean;
  /** Debug mode configuration (optional) */
  debug?: DebugConfig;
}

/**
 * File comment output configuration
 */
export interface FileCommentOutput {
  /** Whether file comments are enabled */
  enabled: boolean;
  /** Whether to show inline comments */
  inline: boolean;
}

/**
 * GitHub Check Runs output configuration
 */
export interface GitHubCheckOutput {
  /** Whether GitHub check runs are enabled */
  enabled: boolean;
  /** Whether to create individual check runs per configured check */
  per_check: boolean;
  /** Custom name prefix for check runs */
  name_prefix?: string;
}

/**
 * Output configuration
 */
export interface OutputConfig {
  /** PR comment configuration */
  pr_comment: PrCommentOutput;
  /** File comment configuration (optional) */
  file_comment?: FileCommentOutput;
  /** GitHub check runs configuration (optional) */
  github_checks?: GitHubCheckOutput;
  /** Whether to enable issue suppression via visor-disable comments (default: true) */
  suppressionEnabled?: boolean;
}

/**
 * HTTP server authentication configuration
 */
export interface HttpAuthConfig {
  /** Authentication type */
  type: 'bearer_token' | 'hmac' | 'basic' | 'none';
  /** Secret or token for authentication */
  secret?: string;
  /** Username for basic auth */
  username?: string;
  /** Password for basic auth */
  password?: string;
}

/**
 * HTTP server endpoint configuration
 */
export interface HttpEndpointConfig {
  /** Path for the webhook endpoint */
  path: string;
  /** Optional transform template (Liquid) for the received data */
  transform?: string;
  /** Optional name/ID for this endpoint */
  name?: string;
}

/**
 * TLS/SSL configuration for HTTPS server
 */
export interface TlsConfig {
  /** Enable TLS/HTTPS */
  enabled: boolean;
  /** Path to TLS certificate file or certificate content */
  cert?: string;
  /** Path to TLS key file or key content */
  key?: string;
  /** Path to CA certificate file or CA content (optional) */
  ca?: string;
  /** Reject unauthorized connections (default: true) */
  rejectUnauthorized?: boolean;
}

/**
 * HTTP server configuration for receiving webhooks
 */
export interface HttpServerConfig {
  /** Whether HTTP server is enabled */
  enabled: boolean;
  /** Port to listen on */
  port: number;
  /** Host/IP to bind to (defaults to 0.0.0.0) */
  host?: string;
  /** TLS/SSL configuration for HTTPS */
  tls?: TlsConfig;
  /** Authentication configuration */
  auth?: HttpAuthConfig;
  /** HTTP endpoints configuration */
  endpoints?: HttpEndpointConfig[];
}

/**
 * Main Visor configuration
 */
export interface VisorConfig {
  /** Configuration version */
  version: string;
  /** Extends from other configurations - can be file path, HTTP(S) URL, or "default" */
  extends?: string | string[];
  /** Check configurations */
  checks: Record<string, CheckConfig>;
  /** Output configuration */
  output: OutputConfig;
  /** HTTP server configuration for receiving webhooks */
  http_server?: HttpServerConfig;
  /** Global environment variables */
  env?: EnvConfig;
  /** Global AI model setting */
  ai_model?: string;
  /** Global AI provider setting */
  ai_provider?: 'google' | 'anthropic' | 'openai' | 'mock' | 'claude-code' | string;
  /** Maximum number of checks to run in parallel (default: 3) */
  max_parallelism?: number;
  /** Stop execution when any check fails (default: false) */
  fail_fast?: boolean;
  /** Simple global fail condition - fails if expression evaluates to true */
  fail_if?: string;
  /** Global failure conditions - optional (deprecated, use fail_if) */
  failure_conditions?: FailureConditions;
}

/**
 * Environment variable overrides
 */
export interface EnvironmentOverrides {
  /** Config file path from environment */
  configPath?: string;
  /** Output format from environment */
  outputFormat?: string;
  /** Additional environment overrides */
  [key: string]: string | undefined;
}

/**
 * Merged configuration result
 */
export interface MergedConfig {
  /** Base configuration from file */
  config: Partial<VisorConfig>;
  /** CLI-specified checks */
  cliChecks: string[];
  /** CLI-specified output format */
  cliOutput: string;
  /** Environment variable overrides */
  environmentOverrides?: EnvironmentOverrides;
}

/**
 * Configuration validation error
 */
export interface ConfigValidationError {
  /** Field that failed validation */
  field: string;
  /** Error message */
  message: string;
  /** Invalid value (if applicable) */
  value?: unknown;
}

/**
 * Configuration loading options
 */
export interface ConfigLoadOptions {
  /** Whether to validate the configuration */
  validate?: boolean;
  /** Whether to merge with defaults */
  mergeDefaults?: boolean;
  /** Allowed URL patterns for remote config extends */
  allowedRemotePatterns?: string[];
  /** Custom validation rules */
  customValidation?: (config: Partial<VisorConfig>) => ConfigValidationError[];
}
