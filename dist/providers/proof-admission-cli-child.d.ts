import type { ManagedAgentRun } from './check-provider.interface';
import type { ManagedRunBindingV1 } from '../state-machine/graph/instance-kernel';
import { type GovernedWireMode } from './proof-wire';
export { immutableProofCanonicalValue, proofCanonicalJson, proofGovernedResultDigest, proofPayloadFingerprint, proofTopLevelJson } from './proof-wire';
export declare const PROOF_ADMISSION_UNAVAILABLE = "PROOF_ADMISSION_UNAVAILABLE";
export declare const PROOF_ADMISSION_CLEANUP_FAILED = "PROOF_ADMISSION_CLEANUP_FAILED";
/** The exact decision wire retained beside the complete admitted receipt. */
export declare const PROOF_ADMISSION_WIRE_FIELD = "__proof_admission_wire";
/** Proof roles constants: request max includes bytes before execution; output max includes LF. */
export declare const PROOF_ONBOARDING_STAGE_CONTEXT_VERSION = "proof.onboarding-stage-context/v1";
export declare const PROOF_ONBOARDING_STAGE_SPEC_REVIEW = "spec_review";
export declare const PROOF_ADMISSION_OUTPUT_MAX_BYTES = 2097152;
export declare const PROOF_ONBOARDING_STAGE_MAX_BYTES = 2097152;
export declare const PROOF_C0_LEGACY_REQUEST_MAX_BYTES = 1463640;
export declare const PROOF_C0_REQUEST_MAX_BYTES: number;
export declare const PROOF_C0_RESPONSE_MAX_BYTES = 8388608;
export declare const PROOF_ADMISSION_REQUEST_MAX_BYTES = 2162688;
type ProofAdmissionCliChildRequest = Readonly<{
    binding: ManagedRunBindingV1;
    workingDirectory: string;
    proofAdmissionRequest: string;
}>;
export type OnboardingStageContextV1 = Readonly<{
    version: typeof PROOF_ONBOARDING_STAGE_CONTEXT_VERSION;
    stage_id: typeof PROOF_ONBOARDING_STAGE_SPEC_REVIEW;
    prior_candidate: Record<string, unknown> | string;
    prior_admission: Record<string, unknown> | string;
    prior_admission_claim_id: string;
    prior_admission_payload_fingerprint: string;
}>;
export declare function validateOnboardingStageContext(value: unknown): OnboardingStageContextV1;
export declare function proofOnboardingStageContextJson(value: unknown): string;
/**
 * Return the exact Proof receipt preimage encoding used for a catalog
 * revalidation identity.  Keep this boundary beside the existing Go-shaped
 * serializer: callers must not reconstruct the v2 map/struct nesting with a
 * generic JSON encoder.
 *
 * This is deliberately a shape validator, not a second semantic receipt
 * validator.  The catalog provider validates project/component lineage when
 * it has the corresponding inventory, work-items, and claims available.
 */
export declare function proofCatalogRevalidationReceiptIdentityJson(value: unknown): string;
export declare function proofComponentCandidateEnvelopeJson(value: Record<string, unknown>): string;
/** Serialize the complete candidate-admission request without erasing
 * Proof-owned nested numeric/UTF-8 identity in a component authority. */
export declare function proofCandidateAdmissionRequestJson(value: Record<string, unknown>): string;
export interface ProofAdmissionCandidateExtraction {
    /** The decoded candidate object is only for shape/identity validation. */
    readonly candidate: Record<string, unknown>;
    /** Exact candidate bytes as they appeared inside the admission request. */
    readonly candidateRaw: Buffer;
    readonly wireMode: GovernedWireMode;
}
/** The authenticated component admission projection exposed to onboarding. */
export interface ProofComponentAdmissionOutcome {
    readonly candidateId: string;
    readonly resultDigest: string;
    readonly subject: Readonly<{
        readonly kind: string;
        readonly id: string;
        readonly fingerprint: string;
    }>;
    readonly scope: readonly Readonly<{
        readonly kind: string;
        readonly expansion_owner_check: string;
        readonly key: string;
        readonly subgraph_instance_id: string;
    }>[];
    readonly receiptId: string;
}
/**
 * Extract the exact Proof candidate RawMessage from an admission request.
 * Consumers that need candidate identity must use candidateRaw; serializing
 * the decoded candidate can erase Proof-owned numeric or UTF-8 identity.
 */
export declare function extractProofAdmissionCandidate(request: string): ProofAdmissionCandidateExtraction;
/**
 * Reconstruct the historical v1 admission decision wire emitted by Proof's
 * Go structs.  The decision itself is a struct (rather than CanonicalJSON),
 * and its receipt contains nested typed structs whose field order is part of
 * the compatibility contract.  This is used only as an exact byte
 * compatibility check; the original accepted bytes are retained by the
 * caller.
 */
export declare function proofV1DecisionJson(value: Record<string, unknown>): string;
/** Compute the v1 Go-struct receipt ID without reordering or canonicalizing
 * its nested typed fields. The receipt_id field is omitted from this
 * historical preimage (matching encoding/json's omitempty behavior). */
export declare function proofV1AdmissionReceiptID(receipt: Record<string, unknown>): string;
/**
 * Validate and project one admitted Proof component candidate. The candidate
 * and decision remain independent wire inputs so their authenticated byte
 * boundaries are retained by parseRequest and acceptedAdmissionDecisionWire.
 */
export declare function validateProofComponentAdmissionOutcome(candidateWire: string | Buffer, admissionWire: string | Buffer): ProofComponentAdmissionOutcome;
export declare function proofAdmissionCapabilityValid(value: unknown): value is object;
export declare function goCompatibleProofJson(value: unknown): string;
export declare function proofExecutableAvailable(path: string | undefined): boolean;
export declare function createProofAdmissionCapability(path: string): object;
export declare function createProofAdmissionCliChildForFocusedTest(path: string): object;
/** Resolve authored role authority with the same opaque executable capability used by admission. */
export declare function resolveProofRoleInvocation(capability: unknown, request: Readonly<Record<string, unknown>>, workingDirectory: string, signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>;
type ProofManagedCommand = readonly ['admit-candidate'] | readonly ['onboarding', 'inventory'] | readonly ['onboarding', 'revalidate'] | readonly ['onboarding', 'work-items'] | readonly ['onboarding', 'reconcile'];
interface ProofManagedCliRequest {
    readonly binding: ManagedRunBindingV1;
    readonly workingDirectory: string;
    readonly command: ProofManagedCommand;
    readonly input: string;
    readonly inputLimit: number;
    readonly outputLimit: number;
    /** Proof onboarding projections are emitted by its human-readable CLI as
     * indented JSON. Candidate admission remains byte-canonical. */
    readonly outputCanonical: boolean;
    readonly projectOutput: (value: unknown, raw: string) => unknown;
}
/** Shared bounded, cancellable Proof process boundary for governed graph providers. */
export declare function startProofManagedCliChild(request: ProofManagedCliRequest, executablePath: unknown): ManagedAgentRun;
export declare function startProofAdmissionCliChild(request: ProofAdmissionCliChildRequest, executablePath: unknown): ManagedAgentRun;
//# sourceMappingURL=proof-admission-cli-child.d.ts.map