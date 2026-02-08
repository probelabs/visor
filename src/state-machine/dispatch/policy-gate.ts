/**
 * Shared policy engine gating logic.
 *
 * Used by both execution-invoker and level-dispatch to evaluate whether
 * a check is allowed to run according to the policy engine.
 */

import type { PolicyEngine, PolicyDecision } from '../../policy/types';
import { logger } from '../../logger';

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
export async function applyPolicyGate(
  checkId: string,
  checkConfig: unknown,
  policyEngine: PolicyEngine
): Promise<PolicyGateResult> {
  let decision: PolicyDecision;
  try {
    decision = await policyEngine.evaluateCheckExecution(checkId, checkConfig);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[PolicyEngine] Evaluation failed for check '${checkId}': ${msg}`);
    decision = { allowed: false, reason: 'policy evaluation error' };
  }

  const auditReason = decision.reason || 'policy violation';

  if (decision.warn) {
    logger.warn(`[PolicyEngine] Audit: check '${checkId}' would be denied: ${auditReason}`);
  }

  if (!decision.allowed) {
    logger.info(`⛔ Skipped (policy: ${decision.reason || 'denied'})`);
    return {
      skip: true,
      reason: decision.reason || 'policy denied',
      warn: !!decision.warn,
      auditReason: decision.warn ? auditReason : undefined,
    };
  }

  return {
    skip: false,
    warn: !!decision.warn,
    auditReason: decision.warn ? auditReason : undefined,
  };
}
