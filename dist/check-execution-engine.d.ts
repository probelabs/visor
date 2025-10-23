import { ReviewSummary, GroupedCheckResults } from './reviewer';
import { AnalysisResult } from './output-formatters';
import { PRInfo } from './pr-analyzer';
import { FailureConditionResult } from './types/config';
/**
 * Statistics for a single check execution
 */
export interface CheckExecutionStats {
    checkName: string;
    totalRuns: number;
    successfulRuns: number;
    failedRuns: number;
    skipped: boolean;
    skipReason?: 'if_condition' | 'fail_fast' | 'dependency_failed';
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
export interface MockOctokit {
    rest: {
        pulls: {
            get: () => Promise<{
                data: Record<string, unknown>;
            }>;
            listFiles: () => Promise<{
                data: Record<string, unknown>[];
            }>;
        };
        issues: {
            listComments: () => Promise<{
                data: Record<string, unknown>[];
            }>;
            createComment: () => Promise<{
                data: Record<string, unknown>;
            }>;
        };
    };
    request: () => Promise<{
        data: Record<string, unknown>;
    }>;
    graphql: () => Promise<Record<string, unknown>>;
    log: {
        debug: (...args: unknown[]) => void;
        info: (...args: unknown[]) => void;
        warn: (...args: unknown[]) => void;
        error: (...args: unknown[]) => void;
    };
    hook: {
        before: (...args: unknown[]) => void;
        after: (...args: unknown[]) => void;
        error: (...args: unknown[]) => void;
        wrap: (...args: unknown[]) => void;
    };
    auth: () => Promise<{
        token: string;
    }>;
}
export interface CheckExecutionOptions {
    checks: string[];
    workingDirectory?: string;
    showDetails?: boolean;
    timeout?: number;
    maxParallelism?: number;
    failFast?: boolean;
    outputFormat?: string;
    config?: import('./types/config').VisorConfig;
    debug?: boolean;
    tagFilter?: import('./types/config').TagFilter;
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
export declare class CheckExecutionEngine {
    private gitAnalyzer;
    private mockOctokit;
    private reviewer;
    private providerRegistry;
    private failureEvaluator;
    private githubCheckService?;
    private checkRunMap?;
    private githubContext?;
    private workingDirectory;
    private config?;
    private webhookContext?;
    private routingSandbox?;
    private executionStats;
    private outputHistory;
    private onFinishLoopCounts;
    private forEachWaveCounts;
    private journal;
    private sessionId;
    private routingEventOverride?;
    private executionContext?;
    private actionContext?;
    constructor(workingDirectory?: string, octokit?: import('@octokit/rest').Octokit);
    private sessionUUID;
    private commitJournal;
    /** Build dependencyResults from a snapshot of all committed results, optionally overlaying provided results. */
    private buildSnapshotDependencyResults;
    /** Drop any non-string keys from a results-like map (root-cause guard). */
    private sanitizeResultMapKeys;
    /**
     * Enrich event context with authenticated octokit instance
     * @param eventContext - The event context to enrich
     * @returns Enriched event context with octokit if available
     */
    private enrichEventContext;
    /**
     * Set execution context for providers (CLI message, hooks, etc.)
     * This allows passing state without using static properties
     */
    setExecutionContext(context: import('./providers/check-provider.interface').ExecutionContext): void;
    /**
     * Lazily create a secure sandbox for routing JS (goto_js, run_js)
     */
    private getRoutingSandbox;
    private redact;
    private sleep;
    private deterministicJitter;
    private computeBackoffDelay;
    /**
     * Execute a single named check inline (used by routing logic and on_finish)
     * This is extracted from executeWithRouting to be reusable
     */
    private executeCheckInline;
    /**
     * Phase 3: Unified scheduling helper
     * Runs a named check in the current session/scope and records results.
     * Used by on_success/on_fail/on_finish routing and internal inline execution.
     */
    private runNamedCheck;
    /**
     * Handle on_finish hooks for forEach checks after ALL dependents complete
     */
    private handleOnFinishHooks;
    /**
     * Execute a check with retry/backoff and routing semantics (on_fail/on_success)
     */
    private executeWithRouting;
    /**
     * Set webhook context on a provider if it supports it
     */
    private setProviderWebhookContext;
    /**
     * Filter checks based on tag filter configuration
     */
    private filterChecksByTags;
    /**
     * Execute checks on the local repository
     */
    executeChecks(options: CheckExecutionOptions): Promise<AnalysisResult>;
    /**
     * Execute tasks with controlled parallelism using a pool pattern
     */
    private executeWithLimitedParallelism;
    /**
     * Execute review checks using parallel execution for multiple AI checks
     */
    private executeReviewChecks;
    /**
     * Execute review checks and return grouped results with statistics for new architecture
     */
    executeGroupedChecks(prInfo: PRInfo, checks: string[], timeout?: number, config?: import('./types/config').VisorConfig, outputFormat?: string, debug?: boolean, maxParallelism?: number, failFast?: boolean, tagFilter?: import('./types/config').TagFilter, _pauseGate?: () => Promise<void>): Promise<ExecutionResult>;
    /**
     * Execute single check and return grouped result
     */
    private executeSingleGroupedCheck;
    /**
     * Validate and normalize forEach output
     * Returns normalized array or throws validation error result
     */
    private validateAndNormalizeForEachOutput;
    /**
     * Execute multiple checks with dependency awareness - return grouped results with statistics
     */
    private executeGroupedDependencyAwareChecks;
    /**
     * Convert ReviewSummary to GroupedCheckResults
     */
    private convertReviewSummaryToGroupedResults;
    /**
     * Validates that a file path is safe and within the project directory
     * Prevents path traversal attacks by:
     * - Blocking absolute paths
     * - Blocking paths with ".." segments
     * - Ensuring resolved path is within project directory
     * - Blocking special characters and null bytes
     * - Enforcing .liquid file extension
     */
    private validateTemplatePath;
    /**
     * Evaluate `if` condition for a check
     * @param checkName Name of the check
     * @param condition The condition string to evaluate
     * @param prInfo PR information
     * @param results Current check results
     * @param debug Whether debug mode is enabled
     * @returns true if the check should run, false if it should be skipped
     */
    private evaluateCheckCondition;
    /**
     * Render check content using the appropriate template
     */
    private renderCheckContent;
    /**
     * Attempt to elevate an issue/issue_comment context to full PR context when routing via goto_event.
     * Returns a new PRInfo with files/diff when possible; otherwise returns null.
     */
    private elevateContextToPullRequest;
    /**
     * Execute multiple checks with dependency awareness - intelligently parallel and sequential
     */
    private executeDependencyAwareChecks;
    /**
     * Execute multiple checks in parallel using controlled parallelism (legacy method)
     */
    private executeParallelChecks;
    /**
     * Execute a single configured check
     */
    private executeSingleConfiguredCheck;
    /**
     * Map check name to focus for AI provider
     * This is a fallback when focus is not explicitly configured
     */
    private mapCheckNameToFocus;
    /**
     * Aggregate results from dependency-aware check execution
     */
    private aggregateDependencyAwareResults;
    /**
     * Aggregate results from parallel check execution (legacy method)
     */
    private aggregateParallelResults;
    /**
     * Get available check types from providers
     * Note: Check names are now config-driven. This returns provider types only.
     */
    static getAvailableCheckTypes(): string[];
    /**
     * Validate check types
     */
    static validateCheckTypes(checks: string[]): {
        valid: string[];
        invalid: string[];
    };
    /**
     * List available providers with their status
     */
    listProviders(): Promise<Array<{
        name: string;
        description: string;
        available: boolean;
        requirements: string[];
    }>>;
    /**
     * Create a mock Octokit instance for local analysis
     */
    private createMockOctokit;
    /**
     * Create an error result
     */
    private createErrorResult;
    /**
     * Check if a task result should trigger fail-fast behavior
     */
    private isFailFastCandidate;
    private shouldFailFast;
    /**
     * Check if the working directory is a valid git repository
     */
    isGitRepository(): Promise<boolean>;
    /**
     * Evaluate failure conditions for a check result
     */
    evaluateFailureConditions(checkName: string, reviewSummary: ReviewSummary, config?: import('./types/config').VisorConfig, prInfo?: PRInfo, previousOutputs?: Record<string, ReviewSummary> | Map<string, ReviewSummary>): Promise<FailureConditionResult[]>;
    /**
     * Get repository status summary
     */
    getRepositoryStatus(): Promise<{
        isGitRepository: boolean;
        hasChanges: boolean;
        branch: string;
        filesChanged: number;
    }>;
    /**
     * Initialize GitHub check runs for each configured check
     */
    private initializeGitHubChecks;
    /**
     * Update GitHub check runs to in-progress status
     */
    private updateGitHubChecksInProgress;
    /**
     * Complete GitHub check runs with results
     */
    private completeGitHubChecksWithResults;
    /**
     * Complete GitHub check runs with error status
     */
    private completeGitHubChecksWithError;
    /**
     * Filter checks based on their event triggers to prevent execution of checks
     * that shouldn't run for the current event type
     */
    private filterChecksByEvent;
    /**
     * Determine the current event type from PR info
     */
    private getCurrentEventType;
    /**
     * Initialize execution statistics for a check
     */
    private initializeCheckStats;
    /**
     * Record the start of a check iteration
     * Returns the start timestamp for duration tracking
     */
    private recordIterationStart;
    /**
     * Record completion of a check iteration
     */
    private recordIterationComplete;
    /**
     * Record provider/self execution time (in milliseconds) for a check
     */
    private recordProviderDuration;
    /**
     * Track output in history for loop/goto scenarios
     */
    private trackOutputHistory;
    /**
     * Record that a check was skipped
     */
    private recordSkip;
    /**
     * Record forEach preview items
     */
    private recordForEachPreview;
    /**
     * Record an error for a check
     */
    private recordError;
    /**
     * Build the final execution statistics object
     */
    private buildExecutionStatistics;
    private isFatalRule;
    private hasFatal;
    private failIfTriggered;
    /**
     * Truncate a string to max length with ellipsis
     */
    private truncate;
    /**
     * Format the Status column for execution summary table
     */
    private formatStatusColumn;
    /**
     * Format the Details column for execution summary table
     */
    private formatDetailsColumn;
    /**
     * Log the execution summary table
     */
    private logExecutionSummary;
}
