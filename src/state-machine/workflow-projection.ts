/**
 * Workflow Projection - Convert WorkflowDefinition to DependencyGraph
 *
 * This module handles projecting workflow definitions into dependency graphs
 * that can be executed by the state machine engine.
 */

import type { WorkflowDefinition } from '../types/workflow';
import type { CheckMetadata } from '../types/engine';
import type { VisorConfig } from '../types/config';
import { logger } from '../logger';

/**
 * Project a workflow definition into a dependency graph structure
 * that can be executed by the state machine
 */
export function projectWorkflowToGraph(
  workflow: WorkflowDefinition,
  workflowInputs: Record<string, unknown>,
  _parentCheckId: string
): {
  config: VisorConfig;
  checks: Record<string, CheckMetadata>;
} {
  if (!workflow.steps || Object.keys(workflow.steps).length === 0) {
    throw new Error(`Workflow '${workflow.id}' has no steps`);
  }

  // Build a pseudo-config that represents the workflow as checks
  const checks: Record<string, any> = {};
  const checksMetadata: Record<string, CheckMetadata> = {};

  for (const [stepId, step] of Object.entries(workflow.steps)) {
    // Inside a nested workflow engine instance, step IDs do not need parent scoping.
    // Keep them unscoped to provide a clean, black‑box view.
    const scopedCheckId = stepId;

    // Build check configuration from workflow step
    checks[scopedCheckId] = {
      type: step.type || 'ai',
      ...step,
      // Store workflow inputs in the check config so they're accessible
      workflowInputs,
      // Mark this as a workflow step
      _workflowStep: true,
      _workflowId: workflow.id,
      _stepId: stepId,
    };

    // Build check metadata
    checksMetadata[scopedCheckId] = {
      tags: step.tags || workflow.tags || [],
      triggers: step.on || workflow.on || [],
      group: step.group,
      providerType: step.type || 'ai',
      // Normalize depends_on to array (supports string | string[])
      dependencies: (Array.isArray(step.depends_on)
        ? step.depends_on
        : step.depends_on
          ? [step.depends_on]
          : []
      ).map((dep: string) => dep),
    };
  }

  // Create a synthetic config for this workflow
  const config: VisorConfig = {
    checks,
    tools: workflow.tools,
    version: '1.0',
    output: {
      pr_comment: {
        format: 'table',
        group_by: 'check',
        collapse: false,
      },
    },
  };

  if ((logger as any).isDebugEnabled?.()) {
    logger.debug(
      `[WorkflowProjection] Projected workflow '${workflow.id}' with ${Object.keys(checks).length} steps`
    );
  }

  return { config, checks: checksMetadata };
}

/**
 * Validate workflow depth to prevent infinite recursion
 */
export function validateWorkflowDepth(
  currentDepth: number,
  maxDepth: number,
  workflowId: string
): void {
  if (currentDepth >= maxDepth) {
    throw new Error(
      `Workflow nesting depth limit exceeded (${maxDepth}) for workflow '${workflowId}'. ` +
        `This may indicate a circular workflow reference or excessive nesting.`
    );
  }
}

/**
 * Build a scoped path for workflow steps
 */
export function buildWorkflowScope(
  parentScope: Array<{ check: string; index: number }> | undefined,
  workflowCheckId: string,
  stepId: string,
  foreachIndex?: number
): Array<{ check: string; index: number }> {
  const scope = parentScope ? [...parentScope] : [];
  scope.push({
    check: `${workflowCheckId}:${stepId}`,
    index: foreachIndex ?? 0,
  });
  return scope;
}

/**
 * Extract parent scope from a scoped check ID
 */
export function extractParentScope(
  scopedCheckId: string
): { parentCheckId: string; stepId: string } | null {
  const lastColonIndex = scopedCheckId.lastIndexOf(':');
  if (lastColonIndex === -1) {
    return null; // Not a scoped check
  }

  return {
    parentCheckId: scopedCheckId.substring(0, lastColonIndex),
    stepId: scopedCheckId.substring(lastColonIndex + 1),
  };
}

/**
 * Check if a check ID represents a workflow step
 */
export function isWorkflowStep(checkId: string): boolean {
  return checkId.includes(':');
}

/**
 * Get the workflow ID from a scoped check ID
 */
export function getWorkflowIdFromScope(scopedCheckId: string): string | null {
  const parts = scopedCheckId.split(':');
  if (parts.length >= 2) {
    return parts[0]; // First part is the parent workflow check ID
  }
  return null;
}
