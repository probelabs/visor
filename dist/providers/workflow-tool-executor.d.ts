/**
 * Workflow Tool Executor - enables workflows to be used as AI custom tools
 *
 * This module provides functions to:
 * 1. Convert workflow inputs to JSON Schema for tool definitions
 * 2. Create synthetic tool definitions from workflows
 * 3. Check if a tool is a workflow wrapper
 * 4. Execute workflows as tools
 */
import { CustomToolDefinition } from '../types/config';
import type { WorkflowDefinition, WorkflowInputParam } from '../types/workflow';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import { ExecutionContext } from './check-provider.interface';
/**
 * Marker interface for workflow-based tools
 */
export interface WorkflowToolDefinition extends CustomToolDefinition {
    /** Indicates this is a workflow tool */
    __isWorkflowTool: true;
    /** The workflow ID */
    __workflowId: string;
    /** Pre-filled args to merge with tool call args */
    __argsOverrides?: Record<string, unknown>;
}
/**
 * Context for workflow tool execution
 */
export interface WorkflowToolContext {
    prInfo: PRInfo;
    outputs?: Map<string, ReviewSummary>;
    executionContext?: ExecutionContext;
    /** Workspace manager for reference counting during async operations */
    workspace?: import('../utils/workspace-manager').WorkspaceManager;
}
/**
 * Workflow tool reference in ai_custom_tools config
 */
export interface WorkflowToolReference {
    workflow: string;
    args?: Record<string, unknown>;
    /** Optional name override. When set, the tool is registered under this name
     *  instead of workflow.id. Used when ai_mcp_servers_js maps a server entry
     *  name (e.g. "code-explorer") to a workflow with a different id. */
    name?: string;
}
/**
 * Convert workflow input parameters to JSON Schema for tool definition
 */
export declare function workflowInputsToJsonSchema(inputs?: WorkflowInputParam[]): CustomToolDefinition['inputSchema'];
/**
 * Create a synthetic tool definition from a workflow
 *
 * Note: This function creates a new schema object and does not mutate the input.
 */
export declare function createWorkflowToolDefinition(workflow: WorkflowDefinition, argsOverrides?: Record<string, unknown>, nameOverride?: string): WorkflowToolDefinition;
/**
 * Check if a tool definition is a workflow tool wrapper
 */
export declare function isWorkflowTool(tool: CustomToolDefinition): tool is WorkflowToolDefinition;
/**
 * Check if a custom tool reference is a workflow reference
 */
export declare function isWorkflowToolReference(item: string | WorkflowToolReference): item is WorkflowToolReference;
/**
 * Execute a workflow as a tool
 */
export declare function executeWorkflowAsTool(workflowId: string, args: Record<string, unknown>, context: WorkflowToolContext, argsOverrides?: Record<string, unknown>): Promise<unknown>;
/**
 * Resolve an ai_custom_tools item to a tool definition
 * Returns undefined if the item is not a workflow reference
 */
export declare function resolveWorkflowToolFromItem(item: string | WorkflowToolReference): WorkflowToolDefinition | undefined;
//# sourceMappingURL=workflow-tool-executor.d.ts.map