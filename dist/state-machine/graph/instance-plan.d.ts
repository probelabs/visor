import type { CheckConfig, ClaimConsumptionConfig, ClaimEmissionConfig, ClaimTypeConfig, VisorConfig, WaitForExpansionConfig } from '../../types/config';
import { type ClaimSchemaValidator } from './claim-kernel';
/** Reserved EXP-0205 admission profile identifiers. */
export declare const PROOF_CANDIDATE_CLAIM = "proof.candidate@1";
export declare const PROOF_ADMITTED_RECEIPT_CLAIM = "proof.admitted_receipt@1";
/** Reserved only for the opt-in staged component spec-review profile. */
export declare const PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM = "proof.component_spec_review_candidate@1";
export declare const PROOF_COMPONENT_SPEC_REVIEW_ADMITTED_RECEIPT_CLAIM = "proof.component_spec_review_admitted_receipt@1";
/** Reserved only for the opt-in discovery-admission egress suffix. */
export declare const PROOF_CATALOG_REVALIDATION_CLAIM = "proof.catalog_revalidation@1";
export declare const PROOF_STRUCTURAL_INVENTORY_CLAIM = "proof.structural_inventory@1";
export declare const PROOF_ADMITTED_CATALOG_PROVIDER_TYPE = "proof-admitted-catalog";
export declare const PROOF_CATALOG_REVALIDATION_PROVIDER_TYPE = "proof-catalog-revalidate";
export declare const PROOF_STRUCTURAL_INVENTORY_PROVIDER_TYPE = "proof-structural-inventory";
export declare const PROOF_ADMIT_PROVIDER_TYPE = "proof-admit";
export declare const GOVERNED_PROOF_INSPECT_PROVIDER_TYPE = "governed-proof-inspect";
export declare const PROOF_PROJECT_RECONCILE_PROVIDER_TYPE = "proof-project-reconcile";
export declare const PROOF_PROJECT_RECONCILE_NODE_KEY = "project_reconcile";
export declare const PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM = "proof.project_reconciliation_receipt@1";
export declare const PROOF_ADMIT_NODE_KEY = "proof_admit";
export declare class InstancePlanError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export interface CompiledJsonPointer {
    readonly source: string;
    readonly tokens: readonly string[];
}
export interface CompiledTemplateNode {
    readonly templateNodeKey: string;
    readonly check: CheckConfig;
    readonly emissions: readonly ClaimEmissionConfig[];
    readonly consumptions: readonly Required<ClaimConsumptionConfig>[];
    readonly dependencyNodeKeys: readonly string[];
    readonly executionConfigDigest: string;
    readonly waitForExpansion?: Readonly<WaitForExpansionConfig>;
}
export interface CompiledSubgraphTemplate {
    readonly name: string;
    readonly input: Readonly<{
        name: string;
        claim: string;
    }>;
    readonly templateDigest: string;
    readonly templateNodeKeys: readonly string[];
    readonly topology: readonly string[];
    readonly reverseTopology: readonly string[];
    readonly sourceNodeKeys: readonly string[];
    readonly nodesByKey: Readonly<Record<string, CompiledTemplateNode>>;
    readonly emitterByClaim: Readonly<Record<string, string>>;
    readonly dependentsByNode: Readonly<Record<string, readonly string[]>>;
}
export interface CompiledExpansion {
    readonly expansionOwnerCheck: string;
    /** Static nesting depth of the first reachable path to this declaration. */
    readonly depth: number;
    readonly parentTemplateName: string | null;
    readonly parentTemplateNodeKey: string | null;
    readonly catalogClaimRef: string;
    readonly catalogValidator: ClaimSchemaValidator;
    readonly templateName: string;
    readonly templateDigest: string;
    readonly expansionSpecDigest: string;
    readonly itemsPointer: CompiledJsonPointer;
    readonly keyPointer: CompiledJsonPointer;
    readonly itemClaimRef: string;
    readonly itemValidator: ClaimSchemaValidator;
    readonly template: CompiledSubgraphTemplate;
    readonly coverage?: Readonly<{
        outcomeClaimRef: string;
        classPointer: CompiledJsonPointer;
        emitterNodeKey: string;
    }>;
    readonly graphSemanticDigest: string;
}
export interface ExpansionPlan {
    readonly active: boolean;
    readonly graphSemanticDigest: string;
    readonly byOwner: Readonly<Record<string, CompiledExpansion>>;
    readonly byNestedOwner: Readonly<Record<string, CompiledExpansion>>;
    readonly templatesByName: Readonly<Record<string, CompiledSubgraphTemplate>>;
}
export interface ExpansionCompileAuthority {
    readonly claimTypes: Readonly<Record<string, ClaimTypeConfig>>;
    readonly validatorsByClaim: Readonly<Record<string, ClaimSchemaValidator>>;
    readonly rootEmitterByClaim: Readonly<Record<string, string>>;
}
/** Unambiguous static address for one generated expansion owner. */
export declare function qualifiedNestedExpansionOwner(parentTemplateName: string, parentTemplateNodeKey: string): string;
/** Strict RFC 6901 syntax compilation; no executable selector language is accepted. */
export declare function compileJsonPointer(pointer: unknown, field: string): CompiledJsonPointer;
/** Resolve a previously compiled pointer without coercion or fallback lookup. */
export declare function resolveJsonPointer(value: unknown, pointer: CompiledJsonPointer): unknown;
/** Compile all dynamic-instance authority once, before any provider can launch. */
export declare function compileExpansionPlan(config: Partial<VisorConfig>, authority: ExpansionCompileAuthority): ExpansionPlan;
//# sourceMappingURL=instance-plan.d.ts.map