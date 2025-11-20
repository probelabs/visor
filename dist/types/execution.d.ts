import type { GroupedCheckResults } from '../reviewer';
/**
 * Statistics for a single check execution
 */
export interface CheckExecutionStats {
    checkName: string;
    totalRuns: number;
    successfulRuns: number;
    failedRuns: number;
    skippedRuns: number;
    skipped: boolean;
    skipReason?: 'if_condition' | 'fail_fast' | 'dependency_failed' | 'forEach_empty' | 'assume';
    skipCondition?: string;
    totalDuration: number;
    providerDurationMs?: number;
    perIterationDuration?: number[];
    issuesFound: number;
    issuesBySeverity: {
        critical: number;
        error: number;
        warning: number;
        info: number;
    };
    outputsProduced?: number;
    errorMessage?: string;
    forEachPreview?: string[];
}
/**
 * Overall execution statistics for all checks
 */
export interface ExecutionStatistics {
    totalChecksConfigured: number;
    totalExecutions: number;
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
    maxParallelism?: number;
    failFast?: boolean;
    outputFormat?: string;
    config?: import('./config').VisorConfig;
    debug?: boolean;
    tagFilter?: import('./config').TagFilter;
    webhookContext?: {
        webhookData: Map<string, unknown>;
    };
    githubChecks?: {
        enabled: boolean;
        octokit?: import('@octokit/rest').Octokit;
        owner?: string;
        repo?: string;
        headSha?: string;
        prNumber?: number;
    };
}
//# sourceMappingURL=execution.d.ts.map