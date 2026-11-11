import type { ExecutionJournal } from './snapshot-store';
export { PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM } from './state-machine/graph/instance-plan';
export declare const GOVERNED_GRAPH_TERMINAL_RECEIPT_SCHEMA = "visor.governed-graph-terminal-receipt/v1";
/** Multi-component extension; v1 remains the wire shape for one-component callers. */
export declare const GOVERNED_GRAPH_MULTI_TERMINAL_RECEIPT_SCHEMA = "visor.governed-graph-terminal-receipt/v2";
export declare const PROOF_DISCOVERY_CATALOG_CANDIDATE_CLAIM = "proof.component_catalog_candidate@1";
export declare const PROOF_ONBOARDING_CANDIDATE_CLAIM = "proof.onboarding_candidate@1";
export interface GovernedGraphTerminalReceipt {
    readonly version: typeof GOVERNED_GRAPH_TERMINAL_RECEIPT_SCHEMA;
    readonly status: 'passed' | 'failed';
    readonly sourceConfigSha256: string;
    readonly sessionId: string;
    readonly graphSemanticDigest: string;
    readonly componentCount: number;
    readonly nodes: Readonly<Record<'inspect' | 'proof_admit' | 'verify', {
        terminalCount: number;
        status: 'completed' | 'failed' | 'nonterminal' | 'absent';
    }>>;
    readonly attestation: Readonly<{
        version: string;
        profileId: string;
        dispatch: {
            source: string;
            tool: string;
        };
        eventCount: number;
        usage: {
            status: 'unavailable' | 'observed';
        };
    }> | null;
    readonly candidateClaimId: string | null;
    readonly admittedReceiptClaimId: string | null;
    readonly verifyInputClaimIds: readonly string[];
    readonly providerCleanupStatus: 'clean' | 'unclean';
    readonly managedUncleanTerminalCount: number;
    readonly activeChildren: number;
    readonly activeResources: number;
    readonly memoryStatus: 'clean' | 'failed';
    readonly projectionReplayEqual: boolean;
    readonly failureCode: string | null;
    readonly exitStatus: 0 | 1;
}
export interface GovernedGraphComponentTerminalReceiptEntry {
    readonly componentKey: string;
    readonly scope: readonly unknown[];
    readonly workItemClaimId: string;
    readonly candidateClaimId: string;
    readonly admittedReceiptClaimId: string | null;
    readonly generation: Readonly<Record<'inspect' | 'proof_admit' | 'verify', {
        generationId: string | null;
        status: 'completed' | 'failed' | 'nonterminal' | 'absent';
    }>>;
    readonly verifyInputClaimIds: readonly string[];
    readonly attestation: GovernedGraphTerminalReceipt['attestation'];
    readonly status: 'passed' | 'failed';
    readonly cleanupStatus: 'clean';
}
export interface GovernedGraphDiscoveryTerminalReceiptEntry {
    readonly candidateClaimId: string;
    readonly admittedReceiptClaimId: string;
    readonly verifyInputClaimIds: readonly string[];
    readonly structuralInventoryClaimId: string;
    readonly catalogRevalidationClaimId: string;
    readonly projectReconciliationClaimId: string;
    readonly projectReconciliationInputClaimIds: readonly string[];
    readonly attestation: GovernedGraphTerminalReceipt['attestation'];
    readonly status: 'completed';
}
export interface GovernedGraphMultiTerminalReceipt {
    readonly version: typeof GOVERNED_GRAPH_MULTI_TERMINAL_RECEIPT_SCHEMA;
    readonly status: 'passed' | 'failed';
    readonly sourceConfigSha256: string;
    readonly sessionId: string;
    readonly graphSemanticDigest: string;
    readonly componentCount: number;
    readonly nodes: GovernedGraphTerminalReceipt['nodes'];
    readonly discovery: GovernedGraphDiscoveryTerminalReceiptEntry;
    readonly components: readonly GovernedGraphComponentTerminalReceiptEntry[];
    readonly providerCleanupStatus: 'clean' | 'unclean';
    readonly managedUncleanTerminalCount: number;
    readonly activeChildren: number;
    readonly activeResources: number;
    readonly memoryStatus: 'clean' | 'failed';
    readonly projectionReplayEqual: boolean;
    readonly failureCode: string | null;
    readonly exitStatus: 0 | 1;
}
export type GovernedGraphTerminalReceiptDraft = Omit<GovernedGraphTerminalReceipt, 'status' | 'memoryStatus' | 'exitStatus'>;
export type GovernedGraphMultiTerminalReceiptDraft = Omit<GovernedGraphMultiTerminalReceipt, 'status' | 'memoryStatus' | 'exitStatus'>;
export type GovernedGraphAnyTerminalReceipt = GovernedGraphTerminalReceipt | GovernedGraphMultiTerminalReceipt;
export type GovernedGraphAnyTerminalReceiptDraft = GovernedGraphTerminalReceiptDraft | GovernedGraphMultiTerminalReceiptDraft;
interface GovernedReceiptPlanAuthority {
    readonly active: boolean;
    readonly expansionPlan: {
        readonly graphSemanticDigest?: unknown;
    };
}
export interface GovernedReceiptProjectionInput {
    readonly journal: ExecutionJournal;
    readonly claimPlan: GovernedReceiptPlanAuthority;
    readonly sourceConfigSha256: string;
}
export declare function projectGovernedGraphTerminalReceipt(input: GovernedReceiptProjectionInput): GovernedGraphAnyTerminalReceiptDraft;
export declare function finalizeGovernedGraphTerminalReceipt(draft: GovernedGraphAnyTerminalReceiptDraft, status: 'passed' | 'failed', memoryStatus: 'clean' | 'failed', exitStatus: 0 | 1): GovernedGraphAnyTerminalReceipt;
export declare function validateGovernedGraphTerminalReceipt(value: unknown): asserts value is GovernedGraphAnyTerminalReceipt;
export declare function serializeGovernedGraphTerminalReceipt(value: GovernedGraphAnyTerminalReceipt): Buffer;
export declare function publishGovernedGraphTerminalReceipt(value: GovernedGraphAnyTerminalReceipt, target: string): void;
