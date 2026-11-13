import type { CheckExecutionOptions, ExecutionResult } from './types/execution';
import { AnalysisResult } from './output-formatters';
import type { VisorConfig } from './types/config';
import type { PRInfo } from './pr-analyzer';
import type { GeneratedDispatchGate } from './types/engine';
import type { GraphJournalCheckpointV1 } from './snapshot-store';
import type { InstanceProjection, GeneratedAttemptRetrySideEffects } from './state-machine/graph/instance-kernel';
import type { DebugVisualizerServer } from './debug-visualizer/ws-server';
import { type GovernedGraphAnyTerminalReceiptDraft } from './governed-graph-terminal-receipt';
export interface GraphCheckpointContinuationInput {
    checkpoint: unknown;
    expansionOwnerCheck: string;
    config: VisorConfig;
    prInfo: PRInfo;
    debug?: boolean;
    maxParallelism?: number;
    failFast?: boolean;
}
export interface GraphCheckpointContinuationResult {
    requestId: string;
    result: ExecutionResult;
    checkpoint: GraphJournalCheckpointV1;
}
export interface GraphCheckpointResumeInput {
    checkpoint: unknown;
    config: VisorConfig;
    prInfo: PRInfo;
    generatedDispatchGate?: GeneratedDispatchGate;
    debug?: boolean;
    maxParallelism?: number;
    failFast?: boolean;
    /** Explicit CLI/runtime timeout override; omitted preserves authored/default behavior. */
    timeout?: number;
}
export type GraphCheckpointResumeResult = Omit<GraphCheckpointContinuationResult, 'requestId'>;
export interface GraphCheckpointRetryInput extends GraphCheckpointResumeInput {
    /** Exact failed generated node-generation IDs selected by the operator. */
    retryGenerationIds: readonly string[];
    /** External side effects were checked before reopening the generation. */
    externalSideEffects: GeneratedAttemptRetrySideEffects;
    /** Persist the retry prefix before resumed dispatch is allowed to start. */
    onRetryCheckpoint: (checkpoint: GraphJournalCheckpointV1) => void | Promise<void>;
}
export interface GraphCheckpointRetryResult extends GraphCheckpointResumeResult {
    /** The immutable old checkpoint prefix plus retry transition events, before dispatch. */
    retryCheckpoint: GraphJournalCheckpointV1;
}
export interface ProofCurrentCatalogCheckpointInput {
    checkpoint: unknown;
    projectSubgraphInstanceId: string;
    /** Exact Proof CanonicalJSON bytes returned by Proof revalidation. */
    revalidationBytes: string | Uint8Array;
    /** Exact Proof CanonicalJSON bytes returned by Proof work-items materialization. */
    workItemsBytes: string | Uint8Array;
    config: VisorConfig;
    prInfo: PRInfo;
    debug?: boolean;
    maxParallelism?: number;
    failFast?: boolean;
}
export interface ProofCurrentCatalogCheckpointResult {
    authorityId: string;
    mutationEventCount: number;
    result: ExecutionResult;
    checkpoint: GraphJournalCheckpointV1;
}
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
    executeGroupedChecks(prInfo: PRInfo, checks: string[], timeout?: number, config?: VisorConfig, outputFormat?: string, debug?: boolean, maxParallelism?: number, failFast?: boolean, tagFilter?: import('./types/config').TagFilter, generatedDispatchGate?: GeneratedDispatchGate): Promise<ExecutionResult>;
    private executeGroupedChecksInternal;
    /**
     * Build the engine context for state machine execution
     */
    private buildEngineContext;
    /**
     * Reconcile one compiled catalog owner from a quiescent Graph-v2 checkpoint.
     * This operation intentionally has no legacy snapshot or runner-state path.
     */
    continueGraphCheckpoint(input: GraphCheckpointContinuationInput): Promise<GraphCheckpointContinuationResult>;
    /** Restore and dispatch a ready-only checkpoint without appending a request
     * or Proof authority event. The journal owns all checkpoint validation. */
    resumeGraphCheckpoint(input: GraphCheckpointResumeInput): Promise<GraphCheckpointResumeResult>;
    /**
     * Explicitly reopen selected failed generated leaves, then use the normal
     * ready-frontier runner in a fresh engine process.  No failed author or
     * arbitrary generation is inferred; the journal validates the exact IDs and
     * side-effect confirmation before any provider dispatch.
     */
    retryGraphCheckpoint(input: GraphCheckpointRetryInput): Promise<GraphCheckpointRetryResult>;
    /**
     * Continue a quiescent Proof-backed graph checkpoint with exact Proof
     * outputs.  The private bootstrap restores and validates the checkpoint,
     * records the supplied bytes, and applies the journal-owned replacement
     * batch before the runner or any provider is visible.  Only the changed
     * component generations released by that batch are dispatched.
     */
    continueProofCurrentCatalogCheckpoint(input: ProofCurrentCatalogCheckpointInput): Promise<ProofCurrentCatalogCheckpointResult>;
    /**
     * Export the last Graph-v2 run through the public engine boundary.
     *
     * ExecutionJournal deliberately keeps its low-level export primitive
     * available to the state machine and tests.  The public engine contract is
     * stricter: it re-validates the exported prefix through the same restore
     * path, which enforces graph authority, replay, allocator, and quiescence
     * checks before callers are allowed to persist it.
     */
    exportGraphCheckpoint(): GraphJournalCheckpointV1;
    /**
     * Validate and canonicalize an imported checkpoint before any provider or
     * run service is initialized. This is intentionally separate from
     * continueGraphCheckpoint so CLI/SDK callers can fail closed early.
     */
    validateGraphCheckpoint(input: unknown, config: VisorConfig): GraphJournalCheckpointV1;
    /** Queue a compiled catalog owner on the currently active runner/journal. */
    requestCatalogReconciliation(ownerCheck: string): import("./state-machine/graph/instance-kernel").CatalogReconciliationRequestedEvent;
    getInstanceProjection(): InstanceProjection;
    replayInstanceProjection(): InstanceProjection;
    /** Narrow, read-only terminal receipt projection; never exposes the journal. */
    getGovernedGraphTerminalReceiptDraft(sourceConfigSha256: string): GovernedGraphAnyTerminalReceiptDraft;
    /** Read the deterministic request-bound expansion coverage projection. */
    getExpansionCoverageProjection(requestId: string): import("./state-machine/graph/instance-kernel").ExpansionCoverageProjection;
    getExpansionCoverageRequestIds(ownerCheck?: string): readonly string[];
    replayExpansionCoverageProjection(requestId: string): import("./state-machine/graph/instance-kernel").ExpansionCoverageProjection;
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
    private webhookContextHasConversation;
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
