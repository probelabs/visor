import { ReviewSummary } from './reviewer';
import { AnalysisResult } from './output-formatters';
import { FailureConditionResult } from './types/config';
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
    outputFormat?: string;
    config?: import('./types/config').VisorConfig;
    debug?: boolean;
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
    constructor(workingDirectory?: string);
    /**
     * Execute checks on the local repository
     */
    executeChecks(options: CheckExecutionOptions): Promise<AnalysisResult>;
    /**
     * Execute review checks using parallel execution for multiple AI checks
     */
    private executeReviewChecks;
    /**
     * Execute multiple checks with dependency awareness - intelligently parallel and sequential
     */
    private executeDependencyAwareChecks;
    /**
     * Execute multiple checks in parallel using Promise.allSettled (legacy method)
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
     * Get available check types
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
     * Check if the working directory is a valid git repository
     */
    isGitRepository(): Promise<boolean>;
    /**
     * Evaluate failure conditions for a check result
     */
    evaluateFailureConditions(checkName: string, reviewSummary: ReviewSummary, config?: import('./types/config').VisorConfig): Promise<FailureConditionResult[]>;
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
}
//# sourceMappingURL=check-execution-engine.d.ts.map