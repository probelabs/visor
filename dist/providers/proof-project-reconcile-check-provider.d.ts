import type { PRInfo } from '../pr-analyzer';
import type { ReviewSummary } from '../reviewer';
import { CheckProvider, type CheckProviderConfig, type ExecutionContext, type ManagedAgentRun, type ManagedRunStartRequest } from './check-provider.interface';
export { PROOF_PROJECT_RECONCILE_PROVIDER_TYPE } from '../state-machine/graph/instance-plan';
/** The registry name is deliberately local to this sealed provider boundary. */
export declare const PROOF_PROJECT_RECONCILE_PROVIDER_NAME = "proof-project-reconcile";
export declare const PROOF_PROJECT_RECONCILIATION_REQUEST_VERSION = "proof.project-reconciliation-request/v1";
export declare const PROOF_PROJECT_RECONCILIATION_RECEIPT_VERSION = "proof.project-reconciliation-receipt/v1";
export declare const PROOF_PROJECT_RECONCILIATION_INPUT_MAX_BYTES: number;
export declare const PROOF_PROJECT_RECONCILIATION_OUTPUT_MAX_BYTES: number;
declare const INTERNAL: unique symbol;
export declare class ProofProjectReconcileCheckProvider extends CheckProvider {
    private readonly capability;
    constructor(capability?: object, token?: typeof INTERNAL);
    getName(): string;
    getDescription(): string;
    validateConfig(config: unknown): Promise<boolean>;
    execute(_pr: PRInfo, _config: CheckProviderConfig, _deps?: Map<string, ReviewSummary>, _context?: ExecutionContext): Promise<ReviewSummary>;
    getSupportedConfigKeys(): string[];
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
    startManaged(request: ManagedRunStartRequest): ManagedAgentRun;
}
export declare function createProofProjectReconcileProviderFromCapability(capability: object): ProofProjectReconcileCheckProvider;
export declare function createProofProjectReconcileProviderForFocusedTest(path: string): ProofProjectReconcileCheckProvider;
//# sourceMappingURL=proof-project-reconcile-check-provider.d.ts.map