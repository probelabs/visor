import type { ClaimConsumptionConfig, ClaimEmissionConfig, ClaimTypeConfig, VisorConfig } from '../../types/config';
import { type ClaimSchemaValidator } from './claim-kernel';
import { type ExpansionPlan } from './instance-plan';
export declare const CLAIM_REF_PATTERN: RegExp;
export declare class ClaimPlanError extends Error {
    readonly code: string;
    constructor(message: string, code?: string);
}
export interface ClaimPlan {
    readonly active: boolean;
    readonly expansionPlan: ExpansionPlan;
    readonly claimTypes: Readonly<Record<string, ClaimTypeConfig>>;
    readonly validatorsByClaim: Readonly<Record<string, ClaimSchemaValidator>>;
    readonly emitterByClaim: Readonly<Record<string, string>>;
    readonly emissionsByCheck: Readonly<Record<string, readonly ClaimEmissionConfig[]>>;
    readonly consumptionsByCheck: Readonly<Record<string, readonly ClaimConsumptionConfig[]>>;
    readonly effectiveDependenciesByCheck: Readonly<Record<string, readonly string[]>>;
}
/**
 * Compile authored claim declarations into immutable exact data bindings and
 * effective terminal dependencies. The authored configuration is never mutated.
 */
export declare function compileClaimPlan(config: Partial<VisorConfig>): ClaimPlan;
//# sourceMappingURL=claim-plan.d.ts.map