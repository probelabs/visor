import type { PRInfo } from '../pr-analyzer';
import type { ReviewSummary } from '../reviewer';
import type { CandidateClaimInput, CheckProviderConfig, ExecutionContext, ManagedAgentRun, ManagedRunStartRequest } from './check-provider.interface';
import { CheckProvider } from './check-provider.interface';
export { proofCatalogRevalidationReceiptIdentityJson } from './proof-admission-cli-child';
import { type ProofCandidateEvidenceV1 } from './governed-proof-inspect-check-provider';
declare const INTERNAL: unique symbol;
export declare const STRUCTURAL_INVENTORY_VERSION = "proof.structural-inventory/v1";
export declare const CATALOG_REVALIDATION_VERSION = "proof.catalog-revalidation/v2";
export declare const CATALOG_REVALIDATION_RECEIPT_VERSION = "proof.catalog-revalidation-receipt/v2";
export declare const COMPONENT_CATALOG_CANDIDATE_VERSION = "proof.component-catalog-candidate/v1";
/** These are the bounds enforced by Proof's onboarding commands. */
export declare const PROOF_CATALOG_INPUT_MAX_BYTES: number;
export declare const PROOF_INVENTORY_OUTPUT_MAX_BYTES: number;
export declare const PROOF_REVALIDATION_REQUEST_MAX_BYTES: number;
export declare const PROOF_REVALIDATION_OUTPUT_MAX_BYTES: number;
export declare const PROOF_WORK_ITEMS_OUTPUT_MAX_BYTES: number;
type PlainRecord = Record<string, unknown>;
/** Proof's sort.Strings order compares the UTF-8 bytes of Go strings. */
export declare function compareProofStrings(left: string, right: string): number;
/** The catalog lane is the only caller allowed to consume Proof's project
 * catalog candidate.  Its schema/role/subject are authority, not caller
 * supplied labels, and component candidates deliberately fail this wrapper. */
export declare function validateGovernedProofCandidateClaim(value: unknown, label?: string): {
    readonly evidence: ProofCandidateEvidenceV1;
    readonly wireMode: 'proof';
    readonly snapshot: PlainRecord;
};
/** Component onboarding uses the generic candidate wire and Proof's v1
 * receipt, but remains governed by the exact component selector and runtime
 * authority.  This wrapper is intentionally separate from the catalog lane. */
export declare function validateProofComponentCandidateClaim(value: unknown, label?: string): {
    readonly evidence: ProofCandidateEvidenceV1;
    readonly wireMode: 'generic';
    readonly snapshot: PlainRecord;
};
/** Bind a generic component candidate to its exact Proof v1 admission. This
 * is used only by component lineage assembly; catalog/admitted-catalog stay
 * on validateProofCandidateAdmissionBinding and v2 project receipts. */
export declare function validateProofComponentCandidateAdmissionBinding(candidate: CandidateClaimInput, admission: CandidateClaimInput): {
    receipt: PlainRecord;
    wire: string;
    candidate: CandidateClaimInput;
};
/** Bind the admission receipt to the candidate's attested invocation/result. */
export declare function validateProofCandidateAdmissionBinding(candidate: CandidateClaimInput, admission: CandidateClaimInput): {
    receipt: PlainRecord;
    wire: string;
    candidate: CandidateClaimInput;
};
export declare function validateStructuralInventory(value: unknown, projectID: string): PlainRecord;
/** Validate the activation-safe work-items projection as a complete Proof
 * output. This is deliberately separate from the revalidation projection:
 * activation consumes only the fresh command result, never its embedded
 * revalidation.work_items member. */
export declare function validateProofWorkItemsProjection(value: unknown, revalidation: PlainRecord, inventory: PlainRecord, candidate: CandidateClaimInput, admission: CandidateClaimInput, projectID: string): PlainRecord;
export interface ProofCurrentCatalogAuthorityBytes {
    readonly revalidation: PlainRecord;
    readonly workItems: PlainRecord;
    /** Exact compact materialization rows emitted by the admitted-catalog provider. */
    readonly items: readonly PlainRecord[];
    readonly components: readonly Readonly<{
        componentId: string;
        workItemDigest: string;
        subject: PlainRecord;
    }>[];
}
/**
 * Validate the two exact Proof outputs retained by a current-catalog
 * authority record. The event stores only the original bytes; this helper is
 * the sole parser/materializer used by reducer and journal paths.
 */
export declare function validateProofCurrentCatalogAuthorityBytes(input: {
    readonly revalidationBytesBase64: unknown;
    readonly workItemsBytesBase64: unknown;
    readonly candidate: CandidateClaimInput;
    readonly admission: CandidateClaimInput;
}): ProofCurrentCatalogAuthorityBytes;
/** Validate and hash a Proof WorkItem using its reconciliation wire. */
export declare function proofWorkItemDigestForReconciliation(value: unknown, projectID: string): string;
export declare function validateProofCatalogRevalidationProjection(value: unknown, inventory: PlainRecord, candidate: CandidateClaimInput, admission: CandidateClaimInput, projectID: string, revalidationClaim?: CandidateClaimInput, inventoryClaimId?: string): PlainRecord;
declare abstract class ProofCatalogCliProvider extends CheckProvider {
    protected readonly capability: object | undefined;
    constructor(capability?: object, token?: typeof INTERNAL);
    execute(_pr: PRInfo, _config: CheckProviderConfig, _deps?: Map<string, ReviewSummary>, _context?: ExecutionContext): Promise<ReviewSummary>;
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
    getSupportedConfigKeys(): string[];
}
export declare class ProofStructuralInventoryCheckProvider extends ProofCatalogCliProvider {
    getName(): string;
    getDescription(): string;
    validateConfig(config: unknown): Promise<boolean>;
    startManaged(request: ManagedRunStartRequest): ManagedAgentRun;
}
export declare class ProofCatalogRevalidationCheckProvider extends ProofCatalogCliProvider {
    getName(): string;
    getDescription(): string;
    validateConfig(config: unknown): Promise<boolean>;
    startManaged(request: ManagedRunStartRequest): ManagedAgentRun;
}
export declare function createProofStructuralInventoryProviderFromCapability(capability: object): ProofStructuralInventoryCheckProvider;
export declare function createProofCatalogRevalidationProviderFromCapability(capability: object): ProofCatalogRevalidationCheckProvider;
//# sourceMappingURL=proof-catalog-check-providers.d.ts.map