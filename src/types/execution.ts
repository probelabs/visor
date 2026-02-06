import type { GroupedCheckResults } from '../reviewer';

/**
 * Statistics for a single check execution
 */
export interface CheckExecutionStats {
  checkName: string;
  totalRuns: number; // How many times the check executed (1 or forEach iterations)
  successfulRuns: number;
  failedRuns: number;
  skippedRuns: number; // Number of runs that were skipped (for forEach iterations)
  skipped: boolean;
  skipReason?: 'if_condition' | 'fail_fast' | 'dependency_failed' | 'forEach_empty' | 'assume';
  skipCondition?: string; // The actual if condition text
  totalDuration: number; // Total duration in milliseconds
  // Provider/self time (excludes time spent running routed children/descendants)
  providerDurationMs?: number;
  perIterationDuration?: number[]; // Duration for each iteration (if forEach)
  issuesFound: number;
  issuesBySeverity: {
    critical: number;
    error: number;
    warning: number;
    info: number;
  };
  outputsProduced?: number; // Number of outputs for forEach checks
  errorMessage?: string; // Error message if failed
  forEachPreview?: string[]; // Preview of forEach items processed (first few)
}

/**
 * Overall execution statistics for all checks
 */
export interface ExecutionStatistics {
  totalChecksConfigured: number;
  totalExecutions: number; // Sum of all runs including forEach iterations
  successfulExecutions: number;
  failedExecutions: number;
  skippedChecks: number;
  totalDuration: number;
  checks: CheckExecutionStats[];
}

/**
 * Result of executing checks, including both the grouped results and execution statistics
 */
export interface ExecutionResult {
  results: GroupedCheckResults;
  statistics: ExecutionStatistics;
}

/**
 * Options for executing checks
 */
export interface CheckExecutionOptions {
  checks: string[];
  workingDirectory?: string;
  showDetails?: boolean;
  timeout?: number;
  maxParallelism?: number; // Maximum number of checks to run in parallel (default: 3)
  failFast?: boolean; // Stop execution when any check fails (default: false)
  outputFormat?: string;
  config?: import('./config').VisorConfig;
  debug?: boolean; // Enable debug mode to collect AI execution details
  // Tag filter for selective check execution
  tagFilter?: import('./config').TagFilter;
  // Webhook context for passing webhook data to http_input providers
  webhookContext?: {
    webhookData: Map<string, unknown>;
  };
  // GitHub Check integration options
  githubChecks?: {
    enabled: boolean;
    octokit?: import('@octokit/rest').Octokit;
    owner?: string;
    repo?: string;
    headSha?: string;
    prNumber?: number;
  };
}
