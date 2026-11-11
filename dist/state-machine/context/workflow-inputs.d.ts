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
export declare function resolveWorkflowInputs(checkConfig: CheckConfig | undefined, context: EngineContext): Record<string, unknown> | undefined;
//# sourceMappingURL=workflow-inputs.d.ts.map