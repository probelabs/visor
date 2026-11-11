import { PolicyEngine, PolicyConfig, PolicyDecision } from './types';
/**
 * Default (no-op) policy engine — always allows everything.
 * Used when no enterprise license is present or policy is disabled.
 */
export declare class DefaultPolicyEngine implements PolicyEngine {
    initialize(_config: PolicyConfig): Promise<void>;
    evaluateCheckExecution(_checkId: string, _checkConfig: unknown): Promise<PolicyDecision>;
    evaluateToolInvocation(_serverName: string, _methodName: string, _transport?: string): Promise<PolicyDecision>;
    evaluateCapabilities(_checkId: string, _capabilities: {
        allowEdit?: boolean;
        allowBash?: boolean;
        allowedTools?: string[];
    }): Promise<PolicyDecision>;
    shutdown(): Promise<void>;
}
//# sourceMappingURL=default-engine.d.ts.map