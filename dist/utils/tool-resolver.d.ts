/**
 * Shared tool resolution utility.
 *
 * Resolves a list of tool references (string names or workflow references)
 * to a Map of CustomToolDefinition objects. Used by both the AI and script
 * check providers.
 */
import { CustomToolDefinition } from '../types/config';
import { WorkflowToolReference } from '../providers/workflow-tool-executor';
/**
 * Resolve tool items to CustomToolDefinition instances.
 *
 * Resolution order per item:
 * 1. Try workflow registry (via resolveWorkflowToolFromItem)
 * 2. Fall back to globalTools record
 */
export declare function resolveTools(toolItems: Array<string | WorkflowToolReference>, globalTools?: Record<string, CustomToolDefinition>, logPrefix?: string): Map<string, CustomToolDefinition>;
//# sourceMappingURL=tool-resolver.d.ts.map