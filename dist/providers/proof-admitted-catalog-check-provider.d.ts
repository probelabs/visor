import type { PRInfo } from '../pr-analyzer';
import type { ReviewSummary } from '../reviewer';
import type { CheckProviderConfig, ExecutionContext, ManagedAgentRun, ManagedRunStartRequest } from './check-provider.interface';
import { CheckProvider } from './check-provider.interface';
declare const INTERNAL: unique symbol;
export declare class ProofAdmittedCatalogCheckProvider extends CheckProvider {
    private readonly capability;
    constructor(capability?: object, token?: typeof INTERNAL);
    getName(): string;
    getDescription(): string;
    validateConfig(config: unknown): Promise<boolean>;
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
    getSupportedConfigKeys(): string[];
    execute(_prInfo: PRInfo, _config: CheckProviderConfig, _dependencyResults?: Map<string, ReviewSummary>, _context?: ExecutionContext): Promise<ReviewSummary>;
    /**
     * The expansion egress is activation-safe only when Proof recomputes the
     * WorkItems immediately before Visor emits the component catalog. The
     * revalidation.work_items member is evidence, never an activation source.
     */
    startManaged(request: ManagedRunStartRequest): ManagedAgentRun;
}
/** Internal-only factory for focused zero-model tests. */
export declare function createProofAdmittedCatalogProviderForFocusedTest(): ProofAdmittedCatalogCheckProvider;
export declare function createProofAdmittedCatalogProviderFromCapability(capability: object): ProofAdmittedCatalogCheckProvider;
export {};
//# sourceMappingURL=proof-admitted-catalog-check-provider.d.ts.map