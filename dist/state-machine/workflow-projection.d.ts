/**
 * Workflow Projection - Convert WorkflowDefinition to DependencyGraph
 *
 * This module handles projecting workflow definitions into dependency graphs
 * that can be executed by the state machine engine.
 */
import type { WorkflowDefinition } from '../types/workflow';
import type { CheckMetadata } from '../types/engine';
import type { VisorConfig } from '../types/config';
/**
 * Project a workflow definition into a dependency graph structure
 * that can be executed by the state machine
 */
export declare function projectWorkflowToGraph(workflow: WorkflowDefinition, workflowInputs: Record<string, unknown>, _parentCheckId: string): {
    config: VisorConfig;
    checks: Record<string, CheckMetadata>;
};
/**
 * Validate workflow depth to prevent infinite recursion
 */
export declare function validateWorkflowDepth(currentDepth: number, maxDepth: number, workflowId: string): void;
/**
 * Build a scoped path for workflow steps
 */
export declare function buildWorkflowScope(parentScope: Array<{
    check: string;
    index: number;
}> | undefined, workflowCheckId: string, stepId: string, foreachIndex?: number): Array<{
    check: string;
    index: number;
}>;
/**
 * Extract parent scope from a scoped check ID
 */
export declare function extractParentScope(scopedCheckId: string): {
    parentCheckId: string;
    stepId: string;
} | null;
/**
 * Check if a check ID represents a workflow step
 */
export declare function isWorkflowStep(checkId: string): boolean;
/**
 * Get the workflow ID from a scoped check ID
 */
export declare function getWorkflowIdFromScope(scopedCheckId: string): string | null;
//# sourceMappingURL=workflow-projection.d.ts.map