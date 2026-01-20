import type { CheckExecutionOptions, ExecutionResult } from './types/execution';
import { AnalysisResult } from './output-formatters';
import type { VisorConfig } from './types/config';
import type { PRInfo } from './pr-analyzer';
import type { DebugVisualizerServer } from './debug-visualizer/ws-server';
/**
 * State machine-based execution engine
 *
 * Production-ready state machine implementation with full observability support.
 * M4: Includes OTEL telemetry and debug visualizer event streaming.
 */
export declare class StateMachineExecutionEngine {
    private workingDirectory;
    private executionContext?;
    private debugServer?;
    private _lastContext?;
    private _lastRunner?;
    constructor(workingDirectory?: string, octokit?: import('@octokit/rest').Octokit, debugServer?: DebugVisualizerServer);
    /**
     * Execute checks using the state machine engine
     *
     * Converts CheckExecutionOptions -> executeGroupedChecks() -> AnalysisResult
     */
    executeChecks(options: CheckExecutionOptions): Promise<AnalysisResult>;
    /**
     * Get execution context (used by state machine to propagate hooks)
     */
    protected getExecutionContext(): import('./providers/check-provider.interface').ExecutionContext | undefined;
    /**
     * Set execution context for external callers
     */
    setExecutionContext(context: import('./providers/check-provider.interface').ExecutionContext | undefined): void;
    /**
     * Reset per-run state (no-op for state machine engine)
     *
     * The state machine engine is stateless per-run by design.
     * Each execution creates a fresh journal and context.
     * This method exists only for backward compatibility with test framework.
     *
     * @deprecated This is a no-op. State machine engine doesn't maintain per-run state.
     */
    resetPerRunState(): void;
    /**
     * Execute grouped checks using the state machine engine
     *
     * M4: Production-ready with full telemetry and debug server support
     */
    executeGroupedChecks(prInfo: PRInfo, checks: string[], timeout?: number, config?: VisorConfig, outputFormat?: string, debug?: boolean, maxParallelism?: number, failFast?: boolean, tagFilter?: import('./types/config').TagFilter, _pauseGate?: () => Promise<void>): Promise<ExecutionResult>;
    /**
     * Build the engine context for state machine execution
     */
    private buildEngineContext;
    /**
     * Get output history snapshot for test framework compatibility
     * Extracts output history from the journal
     */
    getOutputHistorySnapshot(): Record<string, unknown[]>;
    /**
     * Save a JSON snapshot of the last run's state and journal to a file (experimental).
     * Does not include secrets. Intended for debugging and future resume support.
     */
    saveSnapshotToFile(filePath: string): Promise<void>;
    /**
     * Load a snapshot JSON from file and return it. Resume support can build on this.
     */
    loadSnapshotFromFile<T = unknown>(filePath: string): Promise<T>;
    /**
     * Filter checks by tag filter
     */
    private filterChecksByTags;
    /**
     * Create an error result in AnalysisResult format
     */
    private createErrorResult;
    /**
     * Convert GroupedCheckResults to ReviewSummary
     * Aggregates all check results into a single ReviewSummary
     */
    private convertGroupedResultsToReviewSummary;
    /**
     * Evaluate failure conditions for a check result
     *
     * This method provides backward compatibility with the legacy engine by
     * delegating to the FailureConditionEvaluator.
     *
     * @param checkName - The name of the check being evaluated
     * @param reviewSummary - The review summary containing check results
     * @param config - The Visor configuration containing failure conditions
     * @param previousOutputs - Optional previous check outputs for cross-check conditions
     * @param authorAssociation - Optional GitHub author association for permission checks
     * @returns Array of failure condition evaluation results
     */
    evaluateFailureConditions(checkName: string, reviewSummary: import('./reviewer').ReviewSummary, config: VisorConfig, previousOutputs?: Record<string, import('./reviewer').ReviewSummary>, authorAssociation?: string): Promise<import('./types/config').FailureConditionResult[]>;
    /**
     * Get repository status
     * @returns Repository status information
     */
    getRepositoryStatus(): Promise<{
        isGitRepository: boolean;
        branch?: string;
        hasChanges: boolean;
        filesChanged?: number;
    }>;
    /**
     * Check if current directory is a git repository
     * @returns True if git repository, false otherwise
     */
    isGitRepository(): Promise<boolean>;
    /**
     * Get list of available check types
     * @returns Array of check type names
     */
    static getAvailableCheckTypes(): string[];
    /**
     * Validate check types and return valid/invalid lists
     * @param checks - Array of check type names to validate
     * @returns Object with valid and invalid check types
     */
    static validateCheckTypes(checks: string[]): {
        valid: string[];
        invalid: string[];
    };
    /**
     * Format the status column for execution statistics
     * Used by execution-statistics-formatting tests
     */
    private formatStatusColumn;
    /**
     * Format the details column for execution statistics
     * Used by execution-statistics-formatting tests
     */
    private formatDetailsColumn;
    /**
     * Truncate a string to a maximum length
     * Used by formatDetailsColumn
     */
    private truncate;
}
export type SnapshotJson = {
    version: number;
    sessionId: string;
    event?: import('./types/config').EventTrigger;
    wave?: number;
    state: any;
    journal: import('./snapshot-store').JournalEntry[];
    requestedChecks?: string[];
    meta?: Record<string, unknown>;
};
/**
 * Resume execution from a previously saved snapshot (experimental).
 * Frontends are started to mirror executeGroupedChecks behavior so integrations
 * like Slack can handle CheckCompleted/HumanInputRequested events during resume.
 */
export declare function resumeFromSnapshot(engine: StateMachineExecutionEngine, snapshot: SnapshotJson, config: VisorConfig, opts?: {
    debug?: boolean;
    maxParallelism?: number;
    failFast?: boolean;
    webhookContext?: any;
}): Promise<import('./types/execution').ExecutionResult>;
