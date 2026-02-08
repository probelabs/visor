import { PolicyEngine, PolicyConfig, PolicyDecision } from './types';

/**
 * Default (no-op) policy engine — always allows everything.
 * Used when no enterprise license is present or policy is disabled.
 */
export class DefaultPolicyEngine implements PolicyEngine {
  async initialize(_config: PolicyConfig): Promise<void> {}

  async evaluateCheckExecution(_checkId: string, _checkConfig: unknown): Promise<PolicyDecision> {
    return { allowed: true };
  }

  async evaluateToolInvocation(
    _serverName: string,
    _methodName: string,
    _transport?: string
  ): Promise<PolicyDecision> {
    return { allowed: true };
  }

  async evaluateCapabilities(
    _checkId: string,
    _capabilities: {
      allowEdit?: boolean;
      allowBash?: boolean;
      allowedTools?: string[];
    }
  ): Promise<PolicyDecision> {
    return { allowed: true };
  }

  async shutdown(): Promise<void> {}
}
