/**
 * Utility functions for resolving workflow inputs from various context sources.
 *
 * This centralizes the workflow inputs resolution logic that was duplicated
 * across execution-invoker.ts, foreach-processor.ts, and level-dispatch.ts.
 */

import type { EngineContext } from '../../types/engine';
import type { CheckConfig } from '../../types/config';

/**
 * Resolve workflow inputs from multiple sources with priority order:
 * 1. Check config (for nested workflows with inline inputs)
 * 2. Config-level workflow_inputs (for standalone workflow execution)
 * 3. Execution context workflowInputs (for programmatic invocation)
 *
 * @param checkConfig - The check configuration (may contain workflowInputs)
 * @param context - The engine context
 * @returns Resolved workflow inputs or undefined
 */
export function resolveWorkflowInputs(
  checkConfig: CheckConfig | undefined,
  context: EngineContext
): Record<string, unknown> | undefined {
  // Check config first (for nested workflows with inline inputs)
  if ((checkConfig as any)?.workflowInputs) {
    return (checkConfig as any).workflowInputs;
  }

  // Then check config-level workflow_inputs (for standalone workflow execution)
  if ((context.config as any)?.workflow_inputs) {
    return (context.config as any).workflow_inputs;
  }

  // Finally check execution context (for programmatic invocation)
  if ((context.executionContext as any)?.workflowInputs) {
    return (context.executionContext as any).workflowInputs;
  }

  return undefined;
}
