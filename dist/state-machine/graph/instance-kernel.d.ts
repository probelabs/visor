import { type ClaimProjection } from './claim-kernel';
import { type CompiledExpansion } from './instance-plan';
import { type ProofCandidateEvidenceV1 } from '../../providers/governed-proof-inspect-check-provider';
import { type GovernedWireMode } from '../../providers/proof-wire';
export interface IndexedScopeSegment {
    readonly kind: 'indexed';
    readonly check: string;
    readonly index: number;
}
export interface KeyedScopeSegment {
    readonly kind: 'keyed';
    readonly expansionOwnerCheck: string;
    readonly key: string;
    readonly subgraphInstanceId: string;
}
export type TaggedScopeSegment = IndexedScopeSegment | KeyedScopeSegment;
export type TaggedScopePath = readonly TaggedScopeSegment[];
export type RootScopePath = readonly [];
export type LevelOneKeyedScopePath = readonly [KeyedScopeSegment];
export type LevelTwoKeyedScopePath = readonly [KeyedScopeSegment, KeyedScopeSegment];
/** A generated instance has one keyed segment per expansion ancestor. */
export type KeyedScopePath = readonly [KeyedScopeSegment, ...KeyedScopeSegment[]];
export type NodeGenerationStatus = 'ready' | 'running' | 'completed' | 'failed' | 'inactive';
export type CatalogRequestStatus = 'pending' | 'running' | 'completed' | 'failed';
export declare class InstanceKernelError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** Canonical catalog keys deliberately collapse a number and its string form. */
export declare function canonicalCatalogKey(value: unknown): string;
/**
 * Validate and clone a tagged scope. Root and legacy indexed paths are valid;
 * a graph-v2 keyed path has one segment per reachable expansion ancestor.
 * Mixed paths fail closed.
 */
export declare function validateTaggedScopePath(value: unknown): TaggedScopePath;
export declare function requireRootScopePath(value: unknown): RootScopePath;
export declare function requireKeyedScopePath(value: unknown, expected?: KeyedScopeSegment | KeyedScopePath): KeyedScopePath;
export declare function scopePathEquals(left: unknown, right: unknown): boolean;
export declare function deriveSubgraphInstanceId(input: {
    readonly graphSemanticDigest: string;
    readonly expansionOwnerCheck: string;
    readonly parentSubgraphInstanceId: null;
    readonly templateDigest: string;
    readonly itemKey: string;
} | {
    readonly graphSemanticDigest: string;
    readonly parentSubgraphInstanceId: string;
    readonly expansionOwnerNodeInstanceId: string;
    readonly templateDigest: string;
    readonly itemKey: string;
}): string;
export declare function deriveNodeInstanceId(input: {
    readonly subgraphInstanceId: string;
    readonly templateNodeKey: string;
}): string;
export declare function deriveItemFingerprint(payload: unknown): string;
export declare function deriveNodeGenerationId(input: {
    readonly nodeInstanceId: string;
    readonly incarnation: number;
    readonly itemFingerprint: string;
    readonly executionConfigDigest: string;
    readonly activeInputClaimIds: readonly string[];
    readonly expansionBarrierDigest?: string;
}): string;
/** Stable semantic identity of one nested-expansion completion barrier. */
export interface ExpansionBarrierChildState {
    readonly itemKey: string;
    readonly workItemFingerprint: string | null;
    readonly terminalGenerationId: string | null;
    readonly terminalGenerationStatus: NodeGenerationStatus | 'missing' | 'detached';
    readonly nestedCatalogClaimId: string;
    readonly nestedCatalogProducerGenerationId: string | null;
}
export declare function deriveExpansionBarrierDigest(input: {
    readonly expansionOwnerCheck: string;
    readonly terminalNode: string;
    readonly nestedExpansionSpecDigest: string;
    readonly nestedTemplateDigest: string;
    readonly nestedCatalogClaimId: string;
    readonly children: readonly ExpansionBarrierChildState[];
}): string;
export declare function deriveControllerItemClaimId(input: {
    readonly claim: string;
    readonly payloadFingerprint: string;
    readonly expansionSpecDigest: string;
    readonly catalogClaimId: string;
    readonly subgraphInstanceId: string;
    readonly incarnation: number;
    readonly scope: KeyedScopePath;
}): string;
export declare function deriveCatalogRequestId(input: {
    readonly sessionId: string;
    readonly expansionOwnerCheck: string;
    readonly ordinal: number;
}): string;
/** Identity of one current Proof catalog authority record. Only immutable
 * envelope fields and exact base64 bytes enter this graph identity. */
export declare function deriveProofCurrentCatalogAuthorityId(input: {
    readonly sessionId: string;
    readonly scope: KeyedScopePath;
    readonly projectSubgraphInstanceId: string;
    readonly sourceCatalogClaimId: string;
    readonly previousAuthorityId: string;
    readonly revalidationBytesBase64: string;
    readonly workItemsBytesBase64: string;
}): string;
/** Identity of the exact mutation suffix which applies one current Proof
 * authority. Proof-owned controller payloads are represented by their Proof
 * canonical bytes so a signed-zero or UTF-8 ordering change cannot be hidden
 * by the graph canonicalizer. */
export declare function deriveProofCurrentCatalogAuthorityMutationDigest(input: {
    readonly authorityId: string;
    readonly mutations: readonly InstanceRuntimeEvent[];
}): string;
export interface ManagedRunBindingV1 {
    readonly managedRunId: string;
    readonly sessionId: string;
    readonly checkId: string;
    readonly scope: KeyedScopePath;
    readonly nodeInstanceId: string;
    readonly nodeGenerationId: string;
    readonly attemptId: string;
    readonly fence: number;
}
export type ManagedRunCleanupStatus = 'clean' | 'unverified';
export type ManagedRunControllerDecision = 'completed' | 'failed';
export type ManagedRunFailureCode = 'MANAGED_HANDLE_INVALID' | 'MANAGED_BINDING_MISMATCH' | 'MANAGED_START_FAILED' | 'MANAGED_STARTED_RECEIPT_INVALID' | 'MANAGED_OUTCOME_FAILED' | 'MANAGED_OUTCOME_RECEIPT_INVALID' | 'MANAGED_DEADLINE_EXCEEDED' | 'MANAGED_CANCEL_FAILED' | 'MANAGED_CANCEL_RECEIPT_INVALID' | 'MANAGED_CLOSE_FAILED' | 'MANAGED_CLEANUP_RECEIPT_INVALID' | 'MANAGED_SANDBOX_UNSUPPORTED' | 'MANAGED_DEBOUNCE_UNSUPPORTED' | 'MANAGED_FATAL_SUMMARY' | 'MANAGED_FAIL_IF' | 'MANAGED_HALT_EXECUTION' | 'MANAGED_CLAIM_VALIDATION_FAILED' | 'MANAGED_POST_PROVIDER_FAILED';
export type ManagedRunAcquisitionFailureCode = 'MANAGED_HANDLE_INVALID' | 'MANAGED_BINDING_MISMATCH' | 'MANAGED_START_FAILED' | 'MANAGED_SANDBOX_UNSUPPORTED' | 'MANAGED_DEBOUNCE_UNSUPPORTED';
export declare function deriveManagedRunId(input: Omit<ManagedRunBindingV1, 'managedRunId'>): string;
interface InstanceEventBase {
    readonly version: 1;
    readonly eventId: number;
    readonly sessionId: string;
    readonly scope: TaggedScopePath;
}
export interface CatalogReconciliationRequestedEvent extends InstanceEventBase {
    readonly type: 'CatalogReconciliationRequested';
    readonly scope: RootScopePath;
    readonly requestId: string;
    readonly requestOrdinal: number;
    readonly expansionOwnerCheck: string;
    readonly status: 'pending';
}
export interface SubgraphExpandedEvent extends InstanceEventBase {
    readonly type: 'SubgraphExpanded';
    readonly scope: KeyedScopePath;
    readonly expansionOwnerCheck: string;
    readonly graphSemanticDigest: string;
    readonly expansionSpecDigest: string;
    readonly templateDigest: string;
    readonly parentSubgraphInstanceId: string | null;
    readonly expansionOwnerNodeInstanceId?: string;
    readonly catalogClaimRef?: string;
    readonly catalogClaimId: string;
    readonly itemKey: string;
    readonly subgraphInstanceId: string;
    readonly nodeInstanceIdsByTemplateNode: Readonly<Record<string, string>>;
}
/** One authenticated aggregate record for the current Proof catalog. */
export interface ProofCurrentCatalogAuthorityRecordedEvent extends InstanceEventBase {
    readonly type: 'ProofCurrentCatalogAuthorityRecorded';
    readonly scope: LevelOneKeyedScopePath;
    readonly projectSubgraphInstanceId: string;
    readonly sourceCatalogClaimId: string;
    readonly previousAuthorityId: string;
    readonly authorityId: string;
    readonly revalidationBytesBase64: string;
    readonly workItemsBytesBase64: string;
}
/** Atomic marker for the replacement suffix derived from one current Proof
 * authority. The following mutationEventCount events are part of this batch. */
export interface ProofCurrentCatalogAuthorityAppliedEvent extends InstanceEventBase {
    readonly type: 'ProofCurrentCatalogAuthorityApplied';
    readonly scope: LevelOneKeyedScopePath;
    readonly projectSubgraphInstanceId: string;
    readonly authorityId: string;
    readonly mutationEventCount: number;
    readonly mutationEventsDigest: string;
}
export interface ControllerItemClaimPublishedEvent extends InstanceEventBase {
    readonly type: 'ControllerItemClaimPublished';
    readonly scope: KeyedScopePath;
    readonly expansionOwnerCheck: string;
    readonly expansionSpecDigest: string;
    readonly catalogClaimId: string;
    readonly itemKey: string;
    readonly subgraphInstanceId: string;
    readonly incarnation: number;
    readonly claimId: string;
    readonly claim: string;
    readonly payload: unknown;
    readonly payloadFingerprint: string;
    readonly parentClaimIds: readonly [string];
}
export interface NodeGenerationInactivatedEvent extends InstanceEventBase {
    readonly type: 'NodeGenerationInactivated';
    readonly scope: KeyedScopePath;
    readonly subgraphInstanceId: string;
    readonly nodeInstanceId: string;
    readonly nodeGenerationId: string;
    readonly incarnation: number;
    readonly outputClaimIds: readonly string[];
    readonly reason: 'superseded';
}
export interface NodeGenerationActivatedEvent extends InstanceEventBase {
    readonly type: 'NodeGenerationActivated';
    readonly scope: KeyedScopePath;
    readonly subgraphInstanceId: string;
    readonly nodeInstanceId: string;
    readonly nodeGenerationId: string;
    readonly templateNodeKey: string;
    readonly checkId: string;
    readonly incarnation: number;
    readonly itemFingerprint: string;
    readonly executionConfigDigest: string;
    readonly activeInputClaimIds: readonly string[];
    readonly nestedExpansionCatalogClaimRef?: string;
    readonly expansionBarrierDigest?: string;
}
export interface SubgraphTombstonedEvent extends InstanceEventBase {
    readonly type: 'SubgraphTombstoned';
    readonly scope: KeyedScopePath;
    readonly expansionOwnerCheck: string;
    readonly sourceCatalogClaimId: string;
    readonly itemKey: string;
    readonly subgraphInstanceId: string;
    readonly lastIncarnation: number;
    readonly nodeGenerationIds: readonly string[];
    readonly outputClaimIds: readonly string[];
}
interface BoundAttemptEventBase extends InstanceEventBase {
    readonly checkId: string;
    readonly attemptId: string;
    readonly fence: number;
}
export interface GeneratedAttemptStartedEvent extends BoundAttemptEventBase {
    readonly type: 'AttemptStarted';
    readonly scope: KeyedScopePath;
    readonly nodeInstanceId: string;
    readonly nodeGenerationId: string;
}
export interface GeneratedCheckScheduledEvent extends BoundAttemptEventBase {
    readonly type: 'CheckScheduled';
    readonly scope: KeyedScopePath;
    readonly nodeInstanceId: string;
    readonly nodeGenerationId: string;
    readonly claimIds: readonly string[];
}
export interface GeneratedClaimPublishedEvent extends BoundAttemptEventBase {
    readonly type: 'ClaimPublished';
    readonly scope: KeyedScopePath;
    readonly nodeInstanceId: string;
    readonly nodeGenerationId: string;
    readonly claimId: string;
    readonly claim: string;
    readonly payload: unknown;
    readonly payloadFingerprint: string;
    readonly producerCheckId: string;
    readonly parentClaimIds: readonly string[];
    readonly wireMode: GovernedWireMode;
    readonly proofCandidateEvidence?: ProofCandidateEvidenceV1;
    readonly proofCandidateEvidenceFingerprint?: string;
}
export interface GeneratedAttemptCompletedEvent extends BoundAttemptEventBase {
    readonly type: 'AttemptCompleted';
    readonly scope: KeyedScopePath;
    readonly nodeInstanceId: string;
    readonly nodeGenerationId: string;
}
export interface GeneratedAttemptFailedEvent extends BoundAttemptEventBase {
    readonly type: 'AttemptFailed';
    readonly scope: KeyedScopePath;
    readonly nodeInstanceId: string;
    readonly nodeGenerationId: string;
    readonly reason: string;
}
/**
 * Explicit operator-authorized retry of one failed generated attempt.  This
 * event never rewrites the failed attempt: it records the exact failed
 * generation/input identity and only reopens that generation for a fresh
 * allocator-issued attempt.  The caller must explicitly classify the prior
 * boundary as absent, safely idempotent, or an isolated draft replay.  The
 * latter records a retained disposable writer checkout; it does not claim
 * byte convergence, approval, or absence of side effects.
 */
export type GeneratedAttemptRetrySideEffects = 'absent' | 'safely_idempotent' | 'isolated_draft_replay';
export interface GeneratedAttemptRetryRequestedEvent extends InstanceEventBase {
    readonly type: 'AttemptRetryRequested';
    readonly scope: KeyedScopePath;
    readonly nodeInstanceId: string;
    readonly nodeGenerationId: string;
    readonly checkId: string;
    readonly incarnation: number;
    readonly itemFingerprint: string;
    readonly executionConfigDigest: string;
    readonly activeInputClaimIds: readonly string[];
    readonly priorAttemptId: string;
    readonly priorFence: number;
    readonly priorFailureReason: string;
    readonly externalSideEffects: GeneratedAttemptRetrySideEffects;
}
interface ManagedRunEventBase extends InstanceEventBase {
    readonly scope: KeyedScopePath;
    readonly binding: ManagedRunBindingV1;
}
export interface ManagedRunAcquisitionFailedEvent extends ManagedRunEventBase {
    readonly type: 'ManagedRunAcquisitionFailed';
    readonly failureCode: ManagedRunAcquisitionFailureCode;
}
export interface ManagedRunAcquiredEvent extends ManagedRunEventBase {
    readonly type: 'ManagedRunAcquired';
}
export interface ManagedRunStartedEvent extends ManagedRunEventBase {
    readonly type: 'ManagedRunStarted';
}
export interface ManagedRunCancelRequestedEvent extends ManagedRunEventBase {
    readonly type: 'ManagedRunCancelRequested';
    readonly reason: 'deadline';
}
export interface ManagedRunTerminatedEvent extends ManagedRunEventBase {
    readonly type: 'ManagedRunTerminated';
    readonly cleanupStatus: ManagedRunCleanupStatus;
    readonly controllerDecision: ManagedRunControllerDecision;
    readonly failureCode: ManagedRunFailureCode | null;
}
export interface CatalogRequestAttemptStartedEvent extends BoundAttemptEventBase {
    readonly type: 'AttemptStarted';
    readonly scope: RootScopePath;
    readonly requestId: string;
}
export interface CatalogRequestCheckScheduledEvent extends BoundAttemptEventBase {
    readonly type: 'CheckScheduled';
    readonly scope: RootScopePath;
    readonly requestId: string;
    readonly claimIds: readonly string[];
}
export interface CatalogRequestAttemptCompletedEvent extends BoundAttemptEventBase {
    readonly type: 'AttemptCompleted';
    readonly scope: RootScopePath;
    readonly requestId: string;
    readonly catalogClaimId: string;
}
export interface CatalogRequestAttemptFailedEvent extends BoundAttemptEventBase {
    readonly type: 'AttemptFailed';
    readonly scope: RootScopePath;
    readonly requestId: string;
    readonly reason: string;
}
export type InstanceRuntimeEvent = CatalogReconciliationRequestedEvent | SubgraphExpandedEvent | ProofCurrentCatalogAuthorityRecordedEvent | ProofCurrentCatalogAuthorityAppliedEvent | ControllerItemClaimPublishedEvent | NodeGenerationInactivatedEvent | NodeGenerationActivatedEvent | SubgraphTombstonedEvent | GeneratedAttemptStartedEvent | GeneratedCheckScheduledEvent | GeneratedClaimPublishedEvent | GeneratedAttemptCompletedEvent | GeneratedAttemptFailedEvent | GeneratedAttemptRetryRequestedEvent | ManagedRunAcquisitionFailedEvent | ManagedRunAcquiredEvent | ManagedRunStartedEvent | ManagedRunCancelRequestedEvent | ManagedRunTerminatedEvent | CatalogRequestAttemptStartedEvent | CatalogRequestCheckScheduledEvent | CatalogRequestAttemptCompletedEvent | CatalogRequestAttemptFailedEvent;
export interface CatalogSelectedItem {
    readonly key: string;
    readonly itemFingerprint: string;
}
export interface CatalogRequestProjection {
    readonly requestId: string;
    readonly requestOrdinal: number;
    readonly sessionId: string;
    readonly expansionOwnerCheck: string;
    readonly status: CatalogRequestStatus;
    readonly catalogClaimId?: string;
    readonly attemptId?: string;
    readonly fence?: number;
    readonly reason?: string;
}
export interface SubgraphInstanceProjection {
    readonly sessionId: string;
    readonly expansionOwnerCheck: string;
    readonly graphSemanticDigest: string;
    readonly expansionSpecDigest: string;
    readonly templateDigest: string;
    readonly itemKey: string;
    readonly subgraphInstanceId: string;
    readonly scope: KeyedScopePath;
    readonly catalogClaimId: string;
    readonly parentSubgraphInstanceId?: string;
    readonly expansionOwnerNodeInstanceId?: string;
    readonly catalogClaimRef?: string;
    readonly catalogProducerNodeGenerationId?: string;
    readonly nodeInstanceIdsByTemplateNode: Readonly<Record<string, string>>;
    readonly status: 'active' | 'tombstoned';
    readonly incarnation: number;
    readonly activeItemClaimId?: string;
    readonly tombstoneCatalogClaimId?: string;
}
export interface NodeInstanceProjection {
    readonly nodeInstanceId: string;
    readonly subgraphInstanceId: string;
    readonly templateNodeKey: string;
    readonly scope: KeyedScopePath;
}
export interface NodeGenerationProjection {
    readonly nodeGenerationId: string;
    readonly nodeInstanceId: string;
    readonly subgraphInstanceId: string;
    readonly templateNodeKey: string;
    readonly checkId: string;
    readonly scope: KeyedScopePath;
    readonly incarnation: number;
    readonly itemFingerprint: string;
    readonly executionConfigDigest: string;
    readonly activeInputClaimIds: readonly string[];
    readonly nestedExpansionCatalogClaimRef?: string;
    readonly expansionBarrierDigest?: string;
    readonly status: NodeGenerationStatus;
    readonly attemptId?: string;
    readonly fence?: number;
    readonly scheduled: boolean;
    readonly completedOutputClaimIds: readonly string[];
    readonly reason?: string;
}
export interface InstanceClaimProjection {
    readonly claimId: string;
    readonly claim: string;
    readonly payload: unknown;
    readonly payloadFingerprint: string;
    readonly producerCheckId: string;
    readonly producerAttemptId?: string;
    readonly producerFence?: number;
    readonly controllerCatalogClaimId?: string;
    readonly parentClaimIds: readonly string[];
    readonly wireMode: GovernedWireMode;
    readonly scope: KeyedScopePath;
    readonly active: boolean;
    readonly kind: 'controller-item' | 'generated-output';
    readonly subgraphInstanceId: string;
    readonly incarnation: number;
    readonly nodeGenerationId?: string;
    readonly proofCandidateEvidence?: ProofCandidateEvidenceV1;
    readonly proofCandidateEvidenceFingerprint?: string;
}
export interface ManagedRunProjection {
    readonly binding: ManagedRunBindingV1;
    readonly status: 'acquisition_failed' | 'acquired' | 'started' | 'cancel_requested' | 'terminated';
    readonly cleanupStatus?: ManagedRunCleanupStatus;
    readonly controllerDecision?: ManagedRunControllerDecision;
    readonly failureCode?: ManagedRunFailureCode;
    readonly cancellationRequested?: true;
}
export interface InstanceProjection {
    readonly lastEventId: number;
    readonly requestsById: Readonly<Record<string, CatalogRequestProjection>>;
    readonly requestOrder: readonly string[];
    readonly instancesById: Readonly<Record<string, SubgraphInstanceProjection>>;
    readonly instanceIdByOwnerAndKey: Readonly<Record<string, string>>;
    readonly nodesById: Readonly<Record<string, NodeInstanceProjection>>;
    readonly generationsById: Readonly<Record<string, NodeGenerationProjection>>;
    readonly activeGenerationIdByNode: Readonly<Record<string, string>>;
    readonly claimsById: Readonly<Record<string, InstanceClaimProjection>>;
    readonly attemptBindingsById: Readonly<Record<string, string>>;
    readonly managedRunsByAttemptId: Readonly<Record<string, ManagedRunProjection>>;
    readonly currentProofCatalogAuthorityByProject: Readonly<Record<string, ProofCurrentCatalogAuthorityProjection>>;
    /** The exact authority accepted by the last sealed application. Keeping the
     * immutable projection here avoids having to scan journal events when a
     * later authority is recorded. */
    readonly appliedProofCatalogAuthorityByProject: Readonly<Record<string, ProofCurrentCatalogAuthorityProjection>>;
    /** Claim IDs admitted by the sealed application suffix. This is narrowly
     * scoped provenance for Proof WorkItems, not a claim-name based mode. */
    readonly proofApplicationClaimIds: Readonly<Record<string, true>>;
}
export interface ProofCurrentCatalogAuthorityComponentProjection {
    readonly componentId: string;
    readonly subgraphInstanceId: string;
    readonly historicalItemClaimId: string;
    readonly historicalItemFingerprint: string;
    readonly currentItemFingerprint: string;
    readonly comparison: 'unchanged' | 'changed';
}
export interface ProofCurrentCatalogAuthorityProjection {
    readonly projectSubgraphInstanceId: string;
    readonly sourceCatalogClaimId: string;
    readonly previousAuthorityId: string;
    readonly authorityId: string;
    readonly revalidationBytesBase64: string;
    readonly workItemsBytesBase64: string;
    readonly components: readonly ProofCurrentCatalogAuthorityComponentProjection[];
}
/**
 * Derive the only dynamic parent set allowed by graph v2: one current project
 * revalidation plus every current component admission closed by the nested
 * completion barrier. No authored aggregate or provider output selects these
 * parents; they are recovered exclusively from current immutable graph facts.
 */
export declare function deriveProofProjectReconciliationParentClaimIds(projection: InstanceProjection, generation: NodeGenerationProjection): readonly string[];
export type ExpansionCoverageClass = 'completed_clean' | 'completed_with_findings' | 'error' | 'guardrail_blocked' | 'cancelled';
export interface ExpansionCoverageProjection {
    readonly requestId: string;
    readonly expansionOwnerCheck: string;
    readonly denominator: readonly CatalogSelectedItem[];
    readonly items: readonly Readonly<{
        key: string;
        itemFingerprint: string;
        terminalClass: ExpansionCoverageClass | null;
        outcomeClaimId: string | null;
        outcomePayloadFingerprint: string | null;
    }>[];
    readonly closure: 'open' | 'closed';
    readonly disposition: 'clean' | 'findings' | 'unverifiable';
    readonly terminalItems: number;
    readonly diagnostics: readonly string[];
    readonly semanticDigest: string;
    readonly provenance: Readonly<{
        catalogClaimId?: string;
        lastEventId: number;
    }>;
}
/** Derive one request-bound coverage read model from immutable C2 facts. */
export declare function projectExpansionCoverage(claimProjection: ClaimProjection, projection: InstanceProjection, expansion: CompiledExpansion, requestId: string): ExpansionCoverageProjection;
export declare function createInitialInstanceProjection(): InstanceProjection;
export declare function immutableInstanceEvent<T extends InstanceRuntimeEvent>(event: T): T;
/** Proof-aware freezing is reserved for the sealed application suffix. */
export declare function immutableProofApplicationEvent<T extends InstanceRuntimeEvent>(event: T): T;
export declare function immutableInstanceProjection(projection: InstanceProjection): InstanceProjection;
/**
 * A retry is blocked only by active instances directly owned by the selected
 * expansion node.  Other expansion nodes may leave their completed children
 * active in the same component subgraph while an independent fan-in retries.
 */
export declare function hasActiveDescendantInstance(projection: InstanceProjection, generation: Pick<NodeGenerationProjection, 'subgraphInstanceId' | 'nodeInstanceId'>): boolean;
export declare function reduceInstanceEvent(projection: InstanceProjection, event: InstanceRuntimeEvent): InstanceProjection;
/**
 * Pure atomic-batch validator/reducer. Callers publish none of the input events
 * unless this function returns the fully reduced immutable projection.
 */
export declare function reduceInstanceEventBatch(projection: InstanceProjection, events: readonly InstanceRuntimeEvent[]): InstanceProjection;
/**
 * Pure replay preserves the atomic terminal boundaries encoded by contiguous
 * journal order. Batch-only managed terminals are never reduced as singles.
 */
export declare function replayInstanceEvents(events: readonly InstanceRuntimeEvent[]): InstanceProjection;
export declare function queryReadyGenerations(projection: InstanceProjection): readonly NodeGenerationProjection[];
export {};
//# sourceMappingURL=instance-kernel.d.ts.map