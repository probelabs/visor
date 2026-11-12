/**
 * Shared policy engine gating logic.
 *
 * Used by both execution-invoker and level-dispatch to evaluate whether
 * a check is allowed to run according to the policy engine.
 */
import type { PolicyEngine } from '../../policy/types';
export interface PolicyGateResult {
    /** Whether the check should be skipped (policy denied and not in warn-only mode) */
    skip: boolean;
    /** Human-readable reason for the decision */
    reason?: string;
    /** Whether a warn/audit message was emitted (allowed but flagged) */
    warn?: boolean;
    /** The audit reason string when warn is true */
    auditReason?: string;
}
/**
 * Evaluate the policy engine for a given check and return a gating result.
 *
 * This function:
 * - Calls policyEngine.evaluateCheckExecution
 * - On evaluation error, treats the check as denied
 * - Logs audit warnings when decision.warn is true
 * - Returns a simple result indicating skip/allow and any audit info
 */
export declare function applyPolicyGate(checkId: string, checkConfig: unknown, policyEngine: PolicyEngine): Promise<PolicyGateResult>;
//# sourceMappingURL=policy-gate.d.ts.map