/**
 * Types for Visor configuration system
 */

/**
 * Failure condition severity levels
 */
export type FailureConditionSeverity = 'error' | 'warning' | 'info';

/**
 * Simple failure condition - just a JEXL expression
 */
export type SimpleFailureCondition = string;

/**
 * Complex failure condition with additional metadata
 */
export interface ComplexFailureCondition {
  /** JEXL expression to evaluate */
  condition: string;
  /** Human-readable message when condition is met */
  message?: string;
  /** Severity level of the failure */
  severity?: FailureConditionSeverity;
  /** Whether this condition should halt execution */
  halt_execution?: boolean;
}

/**
 * Failure condition - can be a simple JEXL string or complex object
 */
export type FailureCondition = SimpleFailureCondition | ComplexFailureCondition;

/**
 * Collection of failure conditions
 */
export interface FailureConditions {
  [conditionName: string]: FailureCondition;
}

/**
 * Context object available to JEXL expressions for failure condition evaluation
 */
export interface FailureConditionContext {
  /** Check results */
  issues: Array<{
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
  suggestions: string[];

  /** Aggregated metadata for easy access */
  metadata: {
    /** Name of the check (e.g., "security-check") */
    checkName: string;
    /** Schema type (e.g., "code-review", "plain") */
    schema: string;
    /** Group name (e.g., "security-analysis") */
    group: string;
    /** Total number of issues found */
    totalIssues: number;
    /** Number of critical issues */
    criticalIssues: number;
    /** Number of error issues */
    errorIssues: number;
    /** Number of warning issues */
    warningIssues: number;
    /** Number of info issues */
    infoIssues: number;
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
  /** The JEXL expression that was evaluated */
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
export type ConfigCheckType = 'ai';

/**
 * Valid event triggers for checks
 */
export type EventTrigger = 'pr_opened' | 'pr_updated' | 'pr_closed';

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
  provider?: 'google' | 'anthropic' | 'openai';
  /** Model name to use */
  model?: string;
  /** API key (usually from environment variables) */
  apiKey?: string;
  /** Request timeout in milliseconds */
  timeout?: number;
}

/**
 * Configuration for a single check
 */
export interface CheckConfig {
  /** Type of check to perform */
  type: ConfigCheckType;
  /** AI prompt for the check - can be inline string or file path (auto-detected) */
  prompt: string;
  /** Focus area for the check (security/performance/style/architecture/all) - optional */
  focus?: string;
  /** Command that triggers this check (e.g., "review", "security-scan") - optional */
  command?: string;
  /** Events that trigger this check */
  on: EventTrigger[];
  /** File patterns that trigger this check (optional) */
  triggers?: string[];
  /** AI provider configuration (optional) */
  ai?: AIProviderConfig;
  /** AI model to use for this check - overrides global setting */
  ai_model?: string;
  /** AI provider to use for this check - overrides global setting */
  ai_provider?: 'google' | 'anthropic' | 'openai' | string;
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
}

/**
 * Main Visor configuration
 */
export interface VisorConfig {
  /** Configuration version */
  version: string;
  /** Check configurations */
  checks: Record<string, CheckConfig>;
  /** Output configuration */
  output: OutputConfig;
  /** Global environment variables */
  env?: EnvConfig;
  /** Global AI model setting */
  ai_model?: string;
  /** Global AI provider setting */
  ai_provider?: 'google' | 'anthropic' | 'openai' | string;
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
  /** Custom validation rules */
  customValidation?: (config: Partial<VisorConfig>) => ConfigValidationError[];
}
