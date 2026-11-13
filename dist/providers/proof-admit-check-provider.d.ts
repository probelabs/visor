import type { PRInfo } from '../pr-analyzer';
import { CheckProvider, type CheckProviderConfig, type ExecutionContext, type ManagedAgentRun, type ManagedRunStartRequest } from './check-provider.interface';
import type { ReviewSummary } from '../reviewer';
export declare const PROOF_ADMIT_PROVIDER_NAME = "proof-admit";
declare const INTERNAL: unique symbol;
export declare function createProofAdmitProviderForFocusedTest(path: string): ProofAdmitCheckProvider;
export declare function createProofAdmitProviderFromCapability(capability: object): ProofAdmitCheckProvider;
export declare class ProofAdmitCheckProvider extends CheckProvider {
    private readonly executableCapability;
    constructor(executablePath?: string | object, token?: typeof INTERNAL);
    getName(): string;
    getDescription(): string;
    validateConfig(config: unknown): Promise<boolean>;
    execute(_pr: PRInfo, config: CheckProviderConfig, _deps?: Map<string, ReviewSummary>, _context?: ExecutionContext): Promise<ReviewSummary>;
    getSupportedConfigKeys(): string[];
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
    startManaged(request: ManagedRunStartRequest): ManagedAgentRun;
}
export {};
//# sourceMappingURL=proof-admit-check-provider.d.ts.map