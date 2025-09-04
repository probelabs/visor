/**
 * Valid check types that can be performed by Visor
 */
export type CheckType = 'performance' | 'architecture' | 'security' | 'style' | 'all';

/**
 * Valid output formats for CLI results
 */
export type OutputFormat = 'table' | 'json' | 'markdown' | 'sarif';

/**
 * CLI options parsed from command line arguments
 */
export interface CliOptions {
  /** Array of check types to perform */
  checks: CheckType[];
  /** Output format for results */
  output: OutputFormat;
  /** Path to configuration file */
  configPath?: string;
  /** Show help text */
  help?: boolean;
  /** Show version */
  version?: boolean;
}

/**
 * CLI command configuration
 */
export interface CliCommand {
  /** Command name */
  name: string;
  /** Command description */
  description: string;
  /** Command options */
  options: CliOptions;
}
