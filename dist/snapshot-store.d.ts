import type { ReviewSummary } from './reviewer';
import type { EventTrigger } from './types/config';
import type { CandidateClaimInput } from './providers/check-provider.interface';
import { type AttemptCompletedEvent, type AttemptFailedEvent, type AttemptStartedEvent, type CheckScheduledEvent, type ClaimProjection, type ClaimRuntimeEvent } from './state-machine/graph/claim-kernel';
import type { ClaimPlan } from './state-machine/graph/claim-plan';
import { type CatalogReconciliationRequestedEvent, type CatalogRequestAttemptStartedEvent, type CatalogRequestCheckScheduledEvent, type InstanceProjection, type InstanceRuntimeEvent, type ExpansionCoverageProjection, type NodeGenerationProjection, type GeneratedAttemptStartedEvent, type GeneratedAttemptRetryRequestedEvent, type GeneratedAttemptRetrySideEffects, type GeneratedCheckScheduledEvent, type ManagedRunAcquisitionFailureCode, type ManagedRunBindingV1, type ManagedRunCleanupStatus, type ManagedRunFailureCode, type ProofCurrentCatalogAuthorityRecordedEvent, type ProofCurrentCatalogAuthorityAppliedEvent } from './state-machine/graph/instance-kernel';
import { type OnboardingStageContextV1 } from './providers/proof-admission-cli-child';
import { type GovernedWireMode } from './providers/proof-wire';
import { type GovernedProofComponentReinspectionContextV1, type ProofCandidateEvidenceV1, type ProofComponentInvocationAuthorityV1 } from './providers/governed-proof-inspect-check-provider';
import { type CompiledTemplateNode } from './state-machine/graph/instance-plan';
export type ScopePath = Array<{
    check: string;
    index: number;
}>;
type CatalogAttemptStartedEvent = AttemptStartedEvent & CatalogRequestAttemptStartedEvent;
type CatalogCheckScheduledEvent = CheckScheduledEvent & CatalogRequestCheckScheduledEvent;
type CatalogScheduleAuthority = Pick<CatalogRequestAttemptStartedEvent, 'requestId' | 'attemptId' | 'fence'>;
type GeneratedScheduleAuthority = Pick<GeneratedAttemptStartedEvent, 'nodeGenerationId' | 'attemptId' | 'fence'>;
/** The portable, canonical Graph-v2 runtime prefix. */
export interface GraphJournalCheckpointV1 {
    readonly kind: 'visor.graph-journal-checkpoint';
    readonly version: 1;
    readonly sessionId: string;
    readonly graphSemanticDigest: string;
    readonly frontier: {
        readonly eventCount: number;
        readonly lastEventId: number;
    };
    readonly events: readonly (ClaimRuntimeEvent | InstanceRuntimeEvent)[];
    readonly integrity: {
        readonly algorithm: 'sha256';
        readonly digest: string;
    };
}
export declare class GraphJournalCheckpointError extends Error {
    readonly code: 'INVALID_CHECKPOINT_ENVELOPE' | 'CHECKPOINT_INTEGRITY_MISMATCH' | 'CHECKPOINT_GRAPH_MISMATCH' | 'INVALID_CHECKPOINT_PREFIX' | 'CHECKPOINT_SESSION_MISMATCH' | 'CHECKPOINT_PLAN_AUTHORITY_MISMATCH' | 'CHECKPOINT_NOT_QUIESCENT';
    constructor(code: GraphJournalCheckpointError['code'], message: string, options?: {
        cause?: unknown;
    });
}
/** Canonical bytes used for both checkpoint integrity and file publication. */
export declare function canonicalGraphCheckpointJson(value: unknown): string;
export interface JournalEntry {
    commitId: number;
    sessionId: string;
    scope: ScopePath;
    checkId: string;
    event: EventTrigger | undefined;
    result: ReviewSummary & {
        output?: unknown;
        content?: string;
    };
}
export declare class ExecutionJournal {
    private readonly claimPlan?;
    private commit;
    private entries;
    private runtimeEvents;
    private claimProjection;
    private instanceProjection;
    private nextFence;
    private attemptOrdinals;
    private requestOrdinals;
    constructor(claimPlan?: ClaimPlan | undefined);
    /**
     * Validate the self-authenticating checkpoint envelope before any external
     * authority or provider is consulted. Graph-plan authority is checked later
     * by restoreGraphCheckpoint once the trusted configuration is available.
     */
    static validateGraphCheckpointIntegrity(input: unknown): GraphJournalCheckpointV1;
    /** Export the immutable Graph-v2 runtime prefix and its canonical integrity digest. */
    exportGraphCheckpoint(sessionId: string): GraphJournalCheckpointV1;
    /** Restore a fresh journal only after complete envelope, authority, replay, and frontier validation. */
    static restoreGraphCheckpoint(claimPlan: ClaimPlan, input: unknown): ExecutionJournal;
    beginSnapshot(): number;
    commitEntry(entry: {
        sessionId: string;
        scope: ScopePath;
        checkId: string;
        result: ReviewSummary & {
            output?: unknown;
            content?: string;
        };
        event?: EventTrigger;
    }): JournalEntry;
    readVisible(sessionId: string, commitMax: number, event?: EventTrigger): JournalEntry[];
    private requireClaimPlan;
    private appendRuntimeEvent;
    private nextRuntimeEventId;
    private appendInstanceEvent;
    requestCatalogReconciliation(input: {
        sessionId: string;
        ownerCheck: string;
    }): CatalogReconciliationRequestedEvent;
    getOldestPendingCatalogRequest(): import("./state-machine/graph/instance-kernel").CatalogRequestProjection | undefined;
    startCatalogRequestAttempt(requestId: string): CatalogAttemptStartedEvent;
    scheduleCatalogRequestAttempt(input: CatalogScheduleAuthority): CatalogCheckScheduledEvent;
    startGeneratedAttempt(nodeGenerationId: string): GeneratedAttemptStartedEvent;
    /**
     * Atomically reopen explicitly selected failed generated generations.  All
     * candidates are validated against the same immutable projection before any
     * retry event is appended, so a stale or mixed selection cannot partially
     * advance the journal.
     */
    retryFailedGeneratedAttempts(input: {
        readonly sessionId: string;
        readonly nodeGenerationIds: readonly string[];
        readonly externalSideEffects: GeneratedAttemptRetrySideEffects;
    }): readonly GeneratedAttemptRetryRequestedEvent[];
    scheduleGeneratedAttempt(input: GeneratedScheduleAuthority): GeneratedCheckScheduledEvent;
    private compiledExpansionForInstance;
    /**
     * Compute the readiness and semantic identity of a bounded nested
     * expansion barrier. The selected set is derived solely from the current
     * active catalog children of the parent owner; no caller can provide a
     * denominator or a completion claim list.
     */
    private expansionBarrierForNode;
    /** Revalidate every completed component selector against the current exact
     * WorkItem/catalog/Proof lineage. This is shared by normal replay and
     * checkpoint restore, so a rehashed substitution cannot survive projection
     * rebuilding. */
    private validateComponentAuthorityLineage;
    private currentProjectOutput;
    private assembleProofProjectReconciliationAuthority;
    /** Return the exact Go Request bytes consumed by onboarding reconcile. */
    getProofProjectReconciliationRequest(nodeGenerationId: string): string;
    private validateProofProjectReconciliationReceipt;
    getGeneratedExecution(nodeGenerationId: string): Readonly<{
        generation: NodeGenerationProjection;
        node: CompiledTemplateNode;
        claims: Readonly<Record<string, CandidateClaimInput>>;
    }>;
    isGovernedProofCandidateProducer(nodeGenerationId: string): boolean;
    /** Assemble the complete controller-owned authority for a component C0
     * activation. The catalog item carries only the compact subject/digest;
     * the raw candidate, admission, WorkItem and current receipt are recovered
     * from the journal's authenticated claims and Proof admission wire. */
    getProofComponentInvocationAuthority(nodeGenerationId: string): ProofComponentInvocationAuthorityV1;
    /** Derive the exact predecessor evidence for the sole later component
     * onboarding stage.  This is journal authority, never an inherited
     * provider option: all three active aliases and their provenance are
     * checked before the bounded context is frozen. */
    getProofComponentOnboardingStageContext(nodeGenerationId: string): OnboardingStageContextV1;
    /** Derive the bounded prior-inspection context only for an authenticated
     * replacement generation. The inactive generation and its claims remain in
     * the journal, so no caller-supplied history can participate. */
    getProofComponentReinspectionContext(nodeGenerationId: string): GovernedProofComponentReinspectionContextV1 | undefined;
    /** Project the exact controller-owned candidate envelope consumed by Proof. */
    getProofAdmissionRequest(nodeGenerationId: string): string;
    deriveManagedRunBinding(attempt: GeneratedAttemptStartedEvent): ManagedRunBindingV1;
    private appendInstanceEventBatch;
    failManagedRunAcquisition(input: {
        attempt: GeneratedAttemptStartedEvent;
        binding: ManagedRunBindingV1;
        failureCode: ManagedRunAcquisitionFailureCode;
    }): void;
    recordManagedRunAcquired(binding: ManagedRunBindingV1): void;
    recordManagedRunStarted(binding: ManagedRunBindingV1): void;
    recordManagedRunCancelRequested(binding: ManagedRunBindingV1): void;
    failManagedGeneratedAttempt(input: {
        attempt: GeneratedAttemptStartedEvent;
        binding: ManagedRunBindingV1;
        cleanupStatus: ManagedRunCleanupStatus;
        failureCode: ManagedRunFailureCode;
    }): void;
    completeGeneratedAttempt(input: {
        attempt: GeneratedAttemptStartedEvent;
        payload: unknown;
        proofCandidateEvidence?: ProofCandidateEvidenceV1;
        wireMode?: GovernedWireMode;
    }): void;
    completeManagedGeneratedAttempt(input: {
        attempt: GeneratedAttemptStartedEvent;
        binding: ManagedRunBindingV1;
        payload: unknown;
        executionConfigDigest: string;
        proofCandidateEvidence?: ProofCandidateEvidenceV1;
        wireMode?: GovernedWireMode;
    }): void;
    /**
     * Record one current Proof catalog authority without rewriting any
     * historical catalog, item, or generation. Inputs are snapshotted to bytes
     * before validation, so a caller cannot mutate a value between identity and
     * reducer validation. The reducer is staged before the journal is changed.
     */
    recordProofCurrentCatalogAuthority(input: {
        readonly projectSubgraphInstanceId: string;
        readonly revalidationBytes: string | Uint8Array;
        readonly workItemsBytes: string | Uint8Array;
    }): ProofCurrentCatalogAuthorityRecordedEvent;
    /**
     * Atomically apply the latest authenticated Proof catalog authority to the
     * changed component instances.  The mutation suffix is built exclusively
     * from the current projection and the already-validated Proof WorkItems
     * bytes; callers cannot supply a disposition, item, or generation.
     */
    applyProofCurrentCatalogAuthority(input: {
        readonly projectSubgraphInstanceId: string;
        readonly authorityId: string;
    }): ProofCurrentCatalogAuthorityAppliedEvent;
    private stageGeneratedCompletion;
    failGeneratedAttempt(attempt: GeneratedAttemptStartedEvent, reason: string): void;
    queryReadyWork(): readonly NodeGenerationProjection[];
    getInstanceProjection(): InstanceProjection;
    getExpansionCoverageProjection(requestId: string): ExpansionCoverageProjection;
    getExpansionCoverageRequestIds(ownerCheck?: string): readonly string[];
    replayExpansionCoverageProjection(requestId: string): ExpansionCoverageProjection;
    replayInstanceProjection(): InstanceProjection;
    startAttempt(input: {
        sessionId: string;
        checkId: string;
        scope: ScopePath;
    }): AttemptStartedEvent;
    scheduleCheck(input: {
        sessionId: string;
        checkId: string;
        scope: ScopePath;
        attemptId: string;
        fence: number;
    }): CheckScheduledEvent;
    private reconcileCatalog;
    completeAttempt(input: {
        sessionId: string;
        checkId: string;
        scope: ScopePath;
        attemptId: string;
        fence: number;
        payload: unknown;
    }): {
        readonly claims: readonly CandidateClaimInput[];
        readonly completed: AttemptCompletedEvent;
    };
    failAttempt(input: {
        sessionId: string;
        checkId: string;
        scope: ScopePath;
        attemptId: string;
        fence: number;
        reason: string;
    }): AttemptFailedEvent;
    readRuntimeEvents(): readonly (ClaimRuntimeEvent | InstanceRuntimeEvent)[];
    getClaimProjection(): ClaimProjection;
    replayClaimProjection(): ClaimProjection;
    isCheckReady(checkId: string): boolean;
    readCheckClaims(checkId: string): Readonly<Record<string, CandidateClaimInput>>;
    size(): number;
}
export declare class ContextView {
    private journal;
    private sessionId;
    private snapshotId;
    private scope;
    private event?;
    constructor(journal: ExecutionJournal, sessionId: string, snapshotId: number, scope: ScopePath, event?: EventTrigger | undefined);
    /** Return the nearest result for a check in this scope (exact item → ancestor → latest). */
    get(checkId: string): (ReviewSummary & {
        output?: unknown;
        content?: string;
    }) | undefined;
    /** Return an aggregate (raw) result – the shallowest scope for this check. */
    getRaw(checkId: string): (ReviewSummary & {
        output?: unknown;
        content?: string;
    }) | undefined;
    /** All results for a check up to this snapshot. */
    getHistory(checkId: string): Array<ReviewSummary & {
        output?: unknown;
        content?: string;
    }>;
    private sameScope;
    private ancestorDistance;
}
export {};
