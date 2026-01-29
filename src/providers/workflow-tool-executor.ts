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
import { WorkflowRegistry } from '../workflow-registry';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import { ExecutionContext } from './check-provider.interface';
import { logger } from '../logger';

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
}

/**
 * Workflow tool reference in ai_custom_tools config
 */
export interface WorkflowToolReference {
  workflow: string;
  args?: Record<string, unknown>;
}

/**
 * Convert workflow input parameters to JSON Schema for tool definition
 */
export function workflowInputsToJsonSchema(
  inputs?: WorkflowInputParam[]
): CustomToolDefinition['inputSchema'] {
  if (!inputs || inputs.length === 0) {
    return {
      type: 'object',
      properties: {},
      required: [],
    };
  }

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const input of inputs) {
    // Convert workflow JsonSchema to tool inputSchema property
    const propSchema: Record<string, unknown> = {};

    if (input.schema) {
      // Copy schema properties
      propSchema.type = input.schema.type || 'string';
      if (input.schema.description) propSchema.description = input.schema.description;
      if (input.schema.enum) propSchema.enum = input.schema.enum;
      if (input.schema.default !== undefined) propSchema.default = input.schema.default;
      if (input.schema.minimum !== undefined) propSchema.minimum = input.schema.minimum;
      if (input.schema.maximum !== undefined) propSchema.maximum = input.schema.maximum;
      if (input.schema.minLength !== undefined) propSchema.minLength = input.schema.minLength;
      if (input.schema.maxLength !== undefined) propSchema.maxLength = input.schema.maxLength;
      if (input.schema.pattern) propSchema.pattern = input.schema.pattern;
      if (input.schema.format) propSchema.format = input.schema.format;
      if (input.schema.properties) propSchema.properties = input.schema.properties;
      if (input.schema.items) propSchema.items = input.schema.items;
      if (input.schema.additionalProperties !== undefined) {
        propSchema.additionalProperties = input.schema.additionalProperties;
      }
    } else {
      // Default to string type
      propSchema.type = 'string';
    }

    // Use input-level description if schema doesn't have one
    if (!propSchema.description && input.description) {
      propSchema.description = input.description;
    }

    // Use input-level default if schema doesn't have one
    if (propSchema.default === undefined && input.default !== undefined) {
      propSchema.default = input.default;
    }

    properties[input.name] = propSchema;

    // Check if required (default is true if not specified)
    if (input.required !== false && input.default === undefined) {
      required.push(input.name);
    }
  }

  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

/**
 * Create a synthetic tool definition from a workflow
 */
export function createWorkflowToolDefinition(
  workflow: WorkflowDefinition,
  argsOverrides?: Record<string, unknown>
): WorkflowToolDefinition {
  const inputSchema = workflowInputsToJsonSchema(workflow.inputs);

  // Remove properties that are pre-filled via argsOverrides
  if (argsOverrides && inputSchema && typeof inputSchema === 'object') {
    const properties = inputSchema.properties as Record<string, unknown> | undefined;
    if (properties) {
      for (const key of Object.keys(argsOverrides)) {
        delete properties[key];
      }
    }
    const required = inputSchema.required as string[] | undefined;
    if (required) {
      (inputSchema as { required?: string[] }).required = required.filter(
        (r: string) => !argsOverrides[r]
      );
    }
  }

  return {
    name: workflow.id,
    description: workflow.description || `Execute the ${workflow.name} workflow`,
    inputSchema,
    // Workflow tools don't have an exec command - they're executed specially
    exec: '',
    // Marker properties
    __isWorkflowTool: true,
    __workflowId: workflow.id,
    __argsOverrides: argsOverrides,
  };
}

/**
 * Check if a tool definition is a workflow tool wrapper
 */
export function isWorkflowTool(tool: CustomToolDefinition): tool is WorkflowToolDefinition {
  return (tool as WorkflowToolDefinition).__isWorkflowTool === true;
}

/**
 * Check if a custom tool reference is a workflow reference
 */
export function isWorkflowToolReference(
  item: string | WorkflowToolReference
): item is WorkflowToolReference {
  return typeof item === 'object' && item !== null && 'workflow' in item;
}

/**
 * Execute a workflow as a tool
 */
export async function executeWorkflowAsTool(
  workflowId: string,
  args: Record<string, unknown>,
  context: WorkflowToolContext,
  argsOverrides?: Record<string, unknown>
): Promise<unknown> {
  const registry = WorkflowRegistry.getInstance();
  const workflow = registry.get(workflowId);

  if (!workflow) {
    throw new Error(`Workflow '${workflowId}' not found in registry`);
  }

  logger.debug(`[WorkflowToolExecutor] Executing workflow '${workflowId}' as tool`);

  // Merge args with overrides (overrides take precedence for pre-filled values)
  const mergedArgs = {
    ...args,
    ...argsOverrides,
  };

  // Dynamically import WorkflowCheckProvider to avoid circular dependencies
  const { WorkflowCheckProvider } = await import('./workflow-check-provider');
  const provider = new WorkflowCheckProvider();

  // Build the check config for the workflow provider
  const checkConfig = {
    type: 'workflow',
    workflow: workflowId,
    args: mergedArgs,
    checkName: `workflow-tool-${workflowId}`,
  };

  // Execute the workflow
  const result = await provider.execute(
    context.prInfo,
    checkConfig,
    context.outputs,
    context.executionContext
  );

  // Return the output from the workflow execution
  // The workflow output is the most useful part for AI tools
  const output = (result as any).output;
  if (output !== undefined) {
    return output;
  }

  // Fall back to content if no structured output
  if ((result as any).content) {
    return (result as any).content;
  }

  // Fall back to the full result
  return result;
}

/**
 * Resolve an ai_custom_tools item to a tool definition
 * Returns undefined if the item is not a workflow reference
 */
export function resolveWorkflowToolFromItem(
  item: string | WorkflowToolReference
): WorkflowToolDefinition | undefined {
  const registry = WorkflowRegistry.getInstance();

  if (typeof item === 'string') {
    // Check if string matches a registered workflow
    if (registry.has(item)) {
      const workflow = registry.get(item)!;
      return createWorkflowToolDefinition(workflow);
    }
    return undefined;
  }

  if (isWorkflowToolReference(item)) {
    const workflow = registry.get(item.workflow);
    if (!workflow) {
      logger.warn(`[WorkflowToolExecutor] Workflow '${item.workflow}' not found in registry`);
      return undefined;
    }
    return createWorkflowToolDefinition(workflow, item.args);
  }

  return undefined;
}
