import { EventTrigger } from './config';

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
  /** Timeout for check operations in milliseconds (default: 600000ms / 10 minutes) */
  timeout?: number;
  /** Maximum number of checks to run in parallel (default: 3) */
  maxParallelism?: number;
  /** Enable debug mode for detailed output */
  debug?: boolean;
  /** Increase verbosity (more than info, less than debug) */
  verbose?: boolean;
  /** Reduce verbosity to warnings and errors */
  quiet?: boolean;
  /** Stop execution on first failure condition */
  failFast?: boolean;
  /** Tags to include - checks must have at least one of these tags */
  tags?: string[];
  /** Tags to exclude - checks with any of these tags will be skipped */
  excludeTags?: string[];
  /** Allowed URL patterns for remote config extends */
  allowedRemotePatterns?: string[];
  /** Show help text */
  help?: boolean;
  /** Show version */
  version?: boolean;
  /** Code context mode: auto (default), enabled (force include), disabled (force exclude) */
  codeContext?: 'auto' | 'enabled' | 'disabled';
  /** When set, write formatted output to this file instead of stdout */
  outputFile?: string;
  /** Analyze diff vs base branch when on feature branch (auto-enabled for code-review schemas) */
  analyzeBranchDiff?: boolean;
  /** Simulate GitHub event type for event-based filtering ('all' runs checks regardless of event triggers) */
  event?: EventTrigger | 'all';
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
