import type { PRInfo } from '../pr-analyzer';
import type { ReviewSummary } from '../reviewer';
import { CheckProvider, type CheckProviderConfig, type ExecutionContext, type ManagedAgentRun, type ManagedRunStartRequest } from './check-provider.interface';
import type { ManagedRunBindingV1 } from '../state-machine/graph/instance-kernel';
import type { GovernedIdentifiedAnswerResult } from '@probelabs/probe';
export declare const GOVERNED_PROOF_INSPECT_PROVIDER_NAME = "governed-proof-inspect";
export declare const GOVERNED_PROBE_UNAVAILABLE = "GOVERNED_PROBE_UNAVAILABLE";
export declare const GOVERNED_PROOF_INSPECT_MESSAGE: string;
/** Runtime claims used by the onboarding component context contract. */
export declare const COMPONENT_WORK_ITEM_CLAIM = "component.work_item@1";
export declare const PROOF_ROLE_AUTHORITY_CLAIM = "proof.component_role_authority@1";
export declare const GOVERNED_PROOF_CONTEXT_VERSION = "visor.proof-runtime-context/v1";
export declare const GOVERNED_PROOF_REINSPECTION_CONTEXT_VERSION = "visor.proof-component-reinspection-context/v1";
/** Closed context used by the native component admission suffix.  It is
 * deliberately separate from the legacy one-WorkItem envelope so old
 * checkpoints cannot acquire a reviewed aggregate implicitly. */
export declare const GOVERNED_PROOF_REVIEWED_COMPONENT_CONTEXT_VERSION = "visor.proof-reviewed-component-context/v1";
export declare const PROJECT_DISCOVERY_CLAIM = "project.discovery_item@1";
export declare const PROOF_STRUCTURAL_INVENTORY_CLAIM = "proof.structural_inventory@1";
export declare const GOVERNED_PROOF_PROJECT_CONTEXT_VERSION = "visor.proof-project-discovery-context/v1";
export declare const NATIVE_COMPONENT_REVIEWED_CLAIM = "native.component.reviewed@1";
export declare const GOVERNED_PROOF_CONTEXT_MAX_BYTES = 131072;
export interface ProofComponentInvocationAuthorityV1 {
    readonly work_item_digest: string;
    readonly subject: Readonly<Record<string, unknown>>;
    readonly candidate: unknown;
    readonly admission: unknown;
    readonly work_item: unknown;
    readonly catalog_revalidation_receipt: unknown;
}
/** Authored component checks are selectors; all component identity and Proof
 * lineage is supplied by the controller at activation time. */
export declare function isGovernedProofComponentSelector(value: unknown): boolean;
/** Authored selector for the sole later component onboarding stage.  The
 * controller supplies the component authority and the authenticated prior
 * onboarding context at activation time. */
export declare function isGovernedProofSpecReviewSelector(value: unknown): boolean;
/** Authored selector for project discovery.  Project identity is deliberately
 * omitted here: the current authenticated inventory and project item claims
 * supply it at managed-run acquisition time. */
export declare function isGovernedProofProjectSelector(value: unknown): boolean;
export declare function validateProofComponentInvocationAuthority(value: unknown): ProofComponentInvocationAuthorityV1;
/** Proof's domain-separated identity digest: domain || NUL || uint64BE(len) || canonical UTF-8 bytes. */
export declare function governedResultDigest(value: unknown): string;
export { proofCanonicalJson, proofGovernedResultDigest } from './proof-wire';
export declare function projectGovernedProofInspectConfig(value: unknown): CheckProviderConfig;
export interface GovernedProofRuntimeContextClaimV1 {
    readonly claimId: string;
    readonly claim: string;
    readonly payloadFingerprint: string;
    readonly scope: Readonly<ManagedRunBindingV1['scope']>;
    readonly payload: unknown;
}
/** Minimal parent-claim view needed to bind candidate evidence. */
export interface GovernedProofRuntimeParentClaimV1 {
    readonly claimId: string;
    readonly claim: string;
    readonly payloadFingerprint: string;
    readonly scope: unknown;
    readonly payload: unknown;
}
export interface GovernedProofRuntimeContextV1 {
    readonly version: typeof GOVERNED_PROOF_CONTEXT_VERSION;
    readonly component: GovernedProofRuntimeContextClaimV1;
    readonly authority: GovernedProofRuntimeContextClaimV1;
}
export interface GovernedProofComponentReinspectionContextV1 {
    readonly version: typeof GOVERNED_PROOF_REINSPECTION_CONTEXT_VERSION;
    readonly component_id: string;
    readonly changed_paths: readonly string[];
    readonly historical_work_item: {
        readonly claim_id: string;
        readonly payload_fingerprint: string;
    };
    readonly current_work_item: {
        readonly claim_id: string;
        readonly payload_fingerprint: string;
    };
    readonly prior_candidate: {
        readonly claim_id: string;
        readonly payload_fingerprint: string;
        readonly result_digest: string;
        readonly payload: unknown;
    };
    readonly prior_admission: {
        readonly claim_id: string;
        readonly payload_fingerprint: string;
    };
}
export interface GovernedProofProjectDiscoveryContextV1 {
    readonly version: typeof GOVERNED_PROOF_PROJECT_CONTEXT_VERSION;
    readonly project: GovernedProofRuntimeContextClaimV1;
    readonly current_inventory: GovernedProofRuntimeContextClaimV1;
}
export interface GovernedProofReviewedComponentContextV1 {
    readonly version: typeof GOVERNED_PROOF_REVIEWED_COMPONENT_CONTEXT_VERSION;
    readonly component: GovernedProofRuntimeContextClaimV1;
    readonly reviewed: GovernedProofRuntimeContextClaimV1;
}
export type GovernedProofRuntimeContext = GovernedProofRuntimeContextV1 | GovernedProofProjectDiscoveryContextV1 | GovernedProofReviewedComponentContextV1;
export declare function validateGovernedProofComponentReinspectionContext(value: unknown): GovernedProofComponentReinspectionContextV1;
export declare function governedProofComponentReinspectionContextDigest(value: GovernedProofComponentReinspectionContextV1): string;
/**
 * Candidate evidence remains v1 for wire compatibility; the optional context
 * fields are mandatory for the two-claim onboarding profile. Legacy one-claim
 * EXP-0208 runs intentionally continue to validate without them.
 */
export interface ProofCandidateEvidenceV1 {
    readonly version: 'visor.proof-candidate-evidence/v1';
    readonly role: {
        readonly invocation: Record<string, unknown>;
        readonly invocationDigest: string;
    };
    readonly probe: {
        readonly attestation: Record<string, unknown>;
        readonly resultIdentity: Record<string, unknown>;
    };
    readonly context?: GovernedProofRuntimeContext;
    readonly contextDigest?: string;
    readonly reinspectionContext?: GovernedProofComponentReinspectionContextV1;
    readonly reinspectionContextDigest?: string;
}
export interface GovernedProbeRunnerRequest {
    readonly message: string;
    readonly instructions: string;
    readonly invocation: Record<string, unknown>;
    readonly invocationDigest: string;
    readonly resultSchema: string;
    readonly executionConfigDigest: string;
    readonly binding: ManagedRunBindingV1;
    readonly workingDirectory: string;
    /** Explicit opt-in transport selected by the native onboarding runner. */
    readonly governedCodexTransport?: 'exec-jsonl-default-auth-v1';
    /** Caller-validated executable identity; Probe rechecks it before launch. */
    readonly codexBin?: string;
    readonly codexSha256?: string;
    /** Sealed runtime context; present only for the canonical onboarding profiles. */
    readonly context?: GovernedProofRuntimeContext;
    readonly contextDigest?: string;
    /** Controller-derived only; caller execution context is never consulted. */
    readonly reinspectionContext?: GovernedProofComponentReinspectionContextV1;
    readonly reinspectionContextDigest?: string;
}
export interface GovernedProbeDispatchPreview {
    readonly source: 'probe-host-tools-call' | 'probe-host-exec';
    readonly tool: 'codex' | 'codex-exec';
    readonly promptDigest: string;
    readonly promptBytes: number;
}
export interface GovernedProbeRunner {
    answer(request: GovernedProbeRunnerRequest): Promise<GovernedIdentifiedAnswerResult> | GovernedIdentifiedAnswerResult;
    /** Preview must be the same Probe dispatch that answer() will attest. */
    preview?(request: GovernedProbeRunnerRequest): Promise<GovernedProbeDispatchPreview> | GovernedProbeDispatchPreview;
    cancel(reason: 'deadline'): Promise<void> | void;
    close(): Promise<void> | void;
}
type GovernedProbeRunnerFactory = (request: GovernedProbeRunnerRequest) => GovernedProbeRunner;
/**
 * Project the exact generated input claims into the only runtime context that
 * the governed Probe runner may receive. Graph-v2 supplies one external
 * component WorkItem claim; its canonical payload envelope carries the
 * same-scope Proof component-role authority claim.
 */
export declare function projectGovernedProofRuntimeContext(claims: unknown, binding: ManagedRunBindingV1): GovernedProofRuntimeContextV1 | GovernedProofReviewedComponentContextV1;
/** Project the exact project and structural-inventory inputs for discovery. */
export declare function projectGovernedProofProjectDiscoveryContext(claims: unknown, binding: ManagedRunBindingV1, expectedSubject?: {
    projectId: string;
    fingerprint: string;
}): GovernedProofProjectDiscoveryContextV1;
export declare function governedProofRuntimeContextDigest(context: GovernedProofRuntimeContext): string;
export declare function governedProofRuntimePrompt(context: GovernedProofRuntimeContext): string;
/** Validate that candidate evidence still names the exact activated inputs. */
export declare function validateGovernedProofRuntimeContextAgainstClaims(evidence: ProofCandidateEvidenceV1, parentClaims: readonly GovernedProofRuntimeParentClaimV1[], binding: ManagedRunBindingV1): void;
export declare function validateProofCandidateEvidence(value: unknown): ProofCandidateEvidenceV1;
declare const INTERNAL: unique symbol;
export declare function createGovernedProofInspectProviderForFocusedTest(factory: GovernedProbeRunnerFactory, capability?: object): GovernedProofInspectCheckProvider;
export declare function createGovernedProofInspectProviderFromCapability(capability: object): GovernedProofInspectCheckProvider;
export declare class GovernedProofInspectCheckProvider extends CheckProvider {
    private readonly factory;
    private readonly capability?;
    constructor(factory?: GovernedProbeRunnerFactory, token?: typeof INTERNAL, capability?: object);
    getName(): string;
    getDescription(): string;
    validateConfig(config: unknown): Promise<boolean>;
    execute(_pr: PRInfo, _config: CheckProviderConfig, _deps?: Map<string, ReviewSummary>, _ctx?: ExecutionContext): Promise<ReviewSummary>;
    getSupportedConfigKeys(): string[];
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
    startManaged(request: ManagedRunStartRequest): ManagedAgentRun;
}
//# sourceMappingURL=governed-proof-inspect-check-provider.d.ts.map