/**
 * Shared tool resolution utility.
 *
 * Resolves a list of tool references (string names or workflow references)
 * to a Map of CustomToolDefinition objects. Used by both the AI and script
 * check providers.
 */

import { CustomToolDefinition } from '../types/config';
import {
  resolveWorkflowToolFromItem,
  isWorkflowToolReference,
  WorkflowToolReference,
} from '../providers/workflow-tool-executor';
import { logger } from '../logger';

/**
 * Resolve tool items to CustomToolDefinition instances.
 *
 * Resolution order per item:
 * 1. Try workflow registry (via resolveWorkflowToolFromItem)
 * 2. Fall back to globalTools record
 */
export function resolveTools(
  toolItems: Array<string | WorkflowToolReference>,
  globalTools?: Record<string, CustomToolDefinition>,
  logPrefix = '[ToolResolver]'
): Map<string, CustomToolDefinition> {
  const tools = new Map<string, CustomToolDefinition>();

  for (const item of toolItems) {
    // First, try to resolve as a workflow tool
    const workflowTool = resolveWorkflowToolFromItem(item);
    if (workflowTool) {
      logger.debug(`${logPrefix} Loaded workflow '${workflowTool.name}' as tool`);
      tools.set(workflowTool.name, workflowTool);
      continue;
    }

    // If it's not a workflow, try to load from global tools
    if (typeof item === 'string') {
      if (globalTools && globalTools[item]) {
        const tool = globalTools[item];
        tool.name = tool.name || item;
        tools.set(item, tool);
        continue;
      }

      logger.warn(`${logPrefix} Tool '${item}' not found in global tools or workflow registry`);
    } else if (isWorkflowToolReference(item)) {
      logger.warn(`${logPrefix} Workflow '${item.workflow}' referenced but not found in registry`);
    }
  }

  if (tools.size === 0 && toolItems.length > 0 && !globalTools) {
    logger.warn(
      `${logPrefix} Tools specified but no global tools found in configuration and no workflows matched`
    );
  }

  return tools;
}
