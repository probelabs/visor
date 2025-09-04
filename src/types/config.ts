/**
 * Types for Visor configuration system
 */

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
export type ConfigOutputFormat = 'summary' | 'detailed';

/**
 * Valid grouping options
 */
export type GroupByOption = 'check' | 'file' | 'severity';

/**
 * Configuration for a single check
 */
export interface CheckConfig {
  /** Type of check to perform */
  type: ConfigCheckType;
  /** AI prompt for the check */
  prompt: string;
  /** Events that trigger this check */
  on: EventTrigger[];
  /** File patterns that trigger this check (optional) */
  triggers?: string[];
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
 * Output configuration
 */
export interface OutputConfig {
  /** PR comment configuration */
  pr_comment: PrCommentOutput;
  /** File comment configuration (optional) */
  file_comment?: FileCommentOutput;
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