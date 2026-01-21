/**
 * MCP Server for Visor
 *
 * Exposes Visor workflows as MCP tools, allowing Claude Code and other
 * MCP clients to execute workflows programmatically via stdio transport.
 *
 * Usage:
 *   # Generic mode - workflow is a tool parameter
 *   visor mcp-server
 *
 *   # Fixed workflow mode - workflow is pre-configured
 *   visor mcp-server --config defaults/code-review.yaml
 *
 *   # Custom tool name and description
 *   visor mcp-server --config defaults/code-review.yaml \
 *     --mcp-tool-name "code_review" \
 *     --mcp-tool-description "Run a code review for current uncommitted changes"
 *
 * Claude Code config example (~/.claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "visor": {
 *         "command": "npx",
 *         "args": ["-y", "@probelabs/visor", "mcp-server"]
 *       }
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runChecks } from './sdk';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Configuration options for the MCP server.
 */
export interface McpServerOptions {
  /**
   * Path to a fixed workflow configuration file.
   * When provided, the tool will not accept a workflow parameter.
   */
  configPath?: string;

  /**
   * Custom tool name (default: "run_workflow").
   */
  toolName?: string;

  /**
   * Custom tool description.
   */
  toolDescription?: string;
}

/**
 * Available default workflows bundled with Visor.
 */
export const DEFAULT_WORKFLOWS = [
  'code-review',
  'visor',
  'task-refinement',
  'code-refiner',
] as const;

/**
 * Server metadata for MCP protocol.
 */
export const SERVER_INFO = {
  name: 'visor',
  version: '1.0.0',
  description:
    'Visor is an AI-powered code review and workflow automation tool. ' +
    'It analyzes code for security vulnerabilities, performance issues, architectural problems, ' +
    'and style violations. Visor can also orchestrate complex multi-step workflows with AI agents, ' +
    'external tools, and human-in-the-loop interactions.',
};

/**
 * Tool description for the run_workflow tool.
 */
export const RUN_WORKFLOW_DESCRIPTION =
  'Execute a Visor workflow to analyze code or run automation tasks. ' +
  'Visor workflows can perform code reviews, security audits, task refinement, ' +
  'and custom AI-powered analysis. The workflow runs in the current working directory ' +
  'and analyzes the git repository state (staged/unstaged changes, branch diffs). ' +
  'Returns structured results with issues, suggestions, and analysis output.';

/**
 * Check if a resolved path is within a base directory (path traversal protection).
 *
 * @param resolvedPath - The fully resolved absolute path
 * @param baseDir - The base directory to check against
 * @returns true if resolvedPath is within baseDir
 */
function isPathWithinDirectory(resolvedPath: string, baseDir: string): boolean {
  const normalizedResolved = path.normalize(resolvedPath);
  const normalizedBase = path.normalize(baseDir);
  // Ensure base ends with separator for proper prefix matching
  const baseWithSep = normalizedBase.endsWith(path.sep)
    ? normalizedBase
    : normalizedBase + path.sep;
  return normalizedResolved === normalizedBase || normalizedResolved.startsWith(baseWithSep);
}

/**
 * Resolve a workflow path from user input with path traversal protection.
 *
 * Resolution order:
 * 1. Default workflow name - look in bundled defaults (safest, checked first)
 * 2. Relative path with .yaml/.yml extension - resolve from cwd (validated to stay within cwd)
 * 3. Absolute path - only allowed if within cwd or bundled defaults
 *
 * @param workflow - Path to workflow YAML or default workflow name
 * @returns Resolved absolute path to the workflow file
 * @throws Error if workflow cannot be found or path traversal detected
 */
export function resolveWorkflowPath(workflow: string): string {
  const cwd = process.cwd();
  const packagedDefaultsDir = path.resolve(__dirname, 'defaults');
  const localDefaultsDir = path.resolve(cwd, 'defaults');

  // 1. Default workflow name (no extension) - look in bundled defaults first (safest)
  if (!workflow.endsWith('.yaml') && !workflow.endsWith('.yml') && !path.isAbsolute(workflow)) {
    // Sanitize: only allow alphanumeric, hyphens, underscores for default names
    if (!/^[a-zA-Z0-9_-]+$/.test(workflow)) {
      throw new Error(
        `Invalid workflow name "${workflow}". ` +
          `Default workflow names can only contain letters, numbers, hyphens, and underscores.`
      );
    }

    const packaged = path.join(packagedDefaultsDir, `${workflow}.yaml`);
    const localDev = path.join(localDefaultsDir, `${workflow}.yaml`);

    if (fs.existsSync(packaged)) {
      return packaged;
    }
    if (fs.existsSync(localDev)) {
      return localDev;
    }

    const availableDefaults = DEFAULT_WORKFLOWS.join(', ');
    throw new Error(
      `Workflow "${workflow}" not found. ` +
        `Available default workflows: ${availableDefaults}. ` +
        `You can also provide a path to a custom workflow file (e.g., "./my-workflow.yaml").`
    );
  }

  // 2. Relative path with extension - resolve from cwd with traversal protection
  if (!path.isAbsolute(workflow)) {
    const resolved = path.resolve(cwd, workflow);

    // Security: Ensure resolved path stays within cwd (prevent ../ traversal)
    if (!isPathWithinDirectory(resolved, cwd)) {
      throw new Error(
        `Path traversal detected: "${workflow}" resolves outside the current directory. ` +
          `Workflow paths must be within the project directory.`
      );
    }

    if (!fs.existsSync(resolved)) {
      throw new Error(`Workflow file not found: ${resolved}`);
    }
    return resolved;
  }

  // 3. Absolute path - only allow if within cwd or bundled defaults directory
  const normalizedWorkflow = path.normalize(workflow);

  // Check if within current working directory
  if (isPathWithinDirectory(normalizedWorkflow, cwd)) {
    if (!fs.existsSync(normalizedWorkflow)) {
      throw new Error(`Workflow file not found: ${normalizedWorkflow}`);
    }
    return normalizedWorkflow;
  }

  // Check if within bundled defaults directory
  if (isPathWithinDirectory(normalizedWorkflow, packagedDefaultsDir)) {
    if (!fs.existsSync(normalizedWorkflow)) {
      throw new Error(`Workflow file not found: ${normalizedWorkflow}`);
    }
    return normalizedWorkflow;
  }

  // Absolute path outside allowed directories - reject
  throw new Error(
    `Access denied: "${workflow}" is outside the allowed directories. ` +
      `Absolute paths must be within the current working directory or the bundled defaults.`
  );
}

/**
 * Format check results based on the requested format.
 *
 * @param results - The raw results from runChecks
 * @param format - Output format: json, markdown, or table
 * @returns Formatted string representation of results
 */
export function formatResults(
  results: Record<string, unknown>,
  format: 'json' | 'markdown' | 'table'
): string {
  if (format === 'json') {
    return JSON.stringify(results, null, 2);
  }

  if (format === 'markdown') {
    let md = '# Visor Workflow Results\n\n';

    for (const [checkName, checkResult] of Object.entries(results)) {
      const result = checkResult as { issues?: Array<{ severity?: string; message?: string }> };
      md += `## ${checkName}\n\n`;

      if (result.issues && Array.isArray(result.issues)) {
        if (result.issues.length === 0) {
          md += '_No issues found._\n\n';
        } else {
          for (const issue of result.issues) {
            const severity = issue.severity || 'info';
            const icon =
              severity === 'critical'
                ? '🔴'
                : severity === 'error'
                  ? '🟠'
                  : severity === 'warning'
                    ? '🟡'
                    : '🔵';
            md += `- ${icon} **${severity}**: ${issue.message || 'No message'}\n`;
          }
          md += '\n';
        }
      } else {
        md += `\`\`\`json\n${JSON.stringify(checkResult, null, 2)}\n\`\`\`\n\n`;
      }
    }

    return md;
  }

  // Table format - simple text table
  let table = 'Visor Workflow Results\n';
  table += '='.repeat(50) + '\n\n';

  for (const [checkName, checkResult] of Object.entries(results)) {
    const result = checkResult as { issues?: Array<{ severity?: string; message?: string }> };
    table += `Check: ${checkName}\n`;
    table += '-'.repeat(30) + '\n';

    if (result.issues && Array.isArray(result.issues)) {
      if (result.issues.length === 0) {
        table += '  No issues found.\n';
      } else {
        for (const issue of result.issues) {
          const severity = (issue.severity || 'info').toUpperCase().padEnd(8);
          table += `  [${severity}] ${issue.message || 'No message'}\n`;
        }
      }
    } else {
      table += `  ${JSON.stringify(checkResult)}\n`;
    }
    table += '\n';
  }

  return table;
}

/**
 * Zod schema for run_workflow tool parameters.
 */
export const RunWorkflowSchema = z.object({
  workflow: z
    .string()
    .describe(
      'The workflow to execute. Can be: (1) a default workflow name like "code-review", ' +
        '"task-refinement", "code-refiner", or "visor"; (2) a relative path to a YAML file ' +
        'like "./my-workflow.yaml"; or (3) an absolute path like "/path/to/workflow.yaml". ' +
        'Default workflows are bundled with Visor and cover common use cases.'
    ),
  message: z
    .string()
    .optional()
    .describe(
      'Optional human input message for workflows that include human-input checks. ' +
        'This is equivalent to the --message CLI argument. Use this to provide context, ' +
        'instructions, or answers to prompts that the workflow may request.'
    ),
  checks: z
    .array(z.string())
    .optional()
    .describe(
      'Optional list of specific check IDs to run from the workflow. ' +
        'If not provided, all checks defined in the workflow will be executed. ' +
        'Check IDs are the keys defined under the "checks:" section in the workflow YAML.'
    ),
  format: z
    .enum(['json', 'markdown', 'table'])
    .optional()
    .default('json')
    .describe(
      'Output format for the results. "json" (default) returns structured data suitable for ' +
        'programmatic processing. "markdown" returns human-readable formatted output with ' +
        'severity icons. "table" returns a simple text table format.'
    ),
});

/**
 * Type for run_workflow tool arguments (input type, before defaults are applied).
 */
export type RunWorkflowArgs = z.input<typeof RunWorkflowSchema>;

/**
 * Execute a workflow and return formatted results.
 *
 * @param args - The tool arguments
 * @returns MCP tool result with content
 */
export async function executeWorkflow(
  args: RunWorkflowArgs
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    // 1. Resolve workflow path
    const workflowPath = resolveWorkflowPath(args.workflow);

    // 2. Build execution context with message for human-input checks
    const executionContext: { cliMessage?: string } = {};
    if (args.message) {
      executionContext.cliMessage = args.message;
    }

    // 3. Call runChecks() from SDK
    const result = await runChecks({
      configPath: workflowPath,
      checks: args.checks,
      output: { format: args.format || 'json' },
      executionContext,
      cwd: process.cwd(),
    });

    // 4. Format output based on requested format
    const groupedResults = result as unknown as Record<string, unknown>;
    const formattedOutput = formatResults(groupedResults, args.format || 'json');

    return {
      content: [
        {
          type: 'text' as const,
          text: formattedOutput,
        },
      ],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error executing workflow: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Zod schema for fixed workflow tool parameters (no workflow parameter).
 */
export const FixedWorkflowSchema = z.object({
  message: z
    .string()
    .optional()
    .describe(
      'Optional human input message for workflows that include human-input checks. ' +
        'This is equivalent to the --message CLI argument. Use this to provide context, ' +
        'instructions, or answers to prompts that the workflow may request.'
    ),
  checks: z
    .array(z.string())
    .optional()
    .describe(
      'Optional list of specific check IDs to run from the workflow. ' +
        'If not provided, all checks defined in the workflow will be executed. ' +
        'Check IDs are the keys defined under the "checks:" section in the workflow YAML.'
    ),
  format: z
    .enum(['json', 'markdown', 'table'])
    .optional()
    .default('json')
    .describe(
      'Output format for the results. "json" (default) returns structured data suitable for ' +
        'programmatic processing. "markdown" returns human-readable formatted output with ' +
        'severity icons. "table" returns a simple text table format.'
    ),
});

/**
 * Type for fixed workflow tool arguments (input type).
 */
export type FixedWorkflowArgs = z.input<typeof FixedWorkflowSchema>;

/**
 * Execute a fixed workflow and return formatted results.
 *
 * @param args - The tool arguments (without workflow)
 * @param workflowPath - The pre-resolved workflow path
 * @returns MCP tool result with content
 */
export async function executeFixedWorkflow(
  args: FixedWorkflowArgs,
  workflowPath: string
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    // Build execution context with message for human-input checks
    const executionContext: { cliMessage?: string } = {};
    if (args.message) {
      executionContext.cliMessage = args.message;
    }

    // Call runChecks() from SDK
    const result = await runChecks({
      configPath: workflowPath,
      checks: args.checks,
      output: { format: args.format || 'json' },
      executionContext,
      cwd: process.cwd(),
    });

    // Format output based on requested format
    const groupedResults = result as unknown as Record<string, unknown>;
    const formattedOutput = formatResults(groupedResults, args.format || 'json');

    return {
      content: [
        {
          type: 'text' as const,
          text: formattedOutput,
        },
      ],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error executing workflow: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Start the MCP server with Visor tools.
 *
 * The server exposes the following tools:
 * - run_workflow (or custom name): Execute a Visor workflow and return results
 *
 * Communication is via stdio transport (stdin/stdout for JSON-RPC messages).
 *
 * @param options - Optional configuration for fixed workflow mode
 */
export async function startMcpServer(options: McpServerOptions = {}): Promise<void> {
  try {
    // If fixed workflow mode, validate config path at startup
    let resolvedWorkflowPath: string | undefined;
    if (options.configPath) {
      resolvedWorkflowPath = resolveWorkflowPath(options.configPath);
    }

    const server = new McpServer(
      {
        name: SERVER_INFO.name,
        version: SERVER_INFO.version,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Determine tool name and description
    const toolName = options.toolName || 'run_workflow';
    const toolDescription = options.toolDescription || RUN_WORKFLOW_DESCRIPTION;

    // Check if we're in fixed workflow mode
    if (resolvedWorkflowPath) {
      // Register the tool without workflow parameter
      server.tool(
        toolName,
        toolDescription,
        {
          message: FixedWorkflowSchema.shape.message,
          checks: FixedWorkflowSchema.shape.checks,
          format: FixedWorkflowSchema.shape.format,
        },
        async args => {
          return executeFixedWorkflow(args as FixedWorkflowArgs, resolvedWorkflowPath!);
        }
      );

      console.error(`Visor MCP server started with fixed workflow: ${resolvedWorkflowPath}`);
    } else {
      // Generic mode - workflow is a tool parameter
      server.tool(
        toolName,
        toolDescription,
        {
          workflow: RunWorkflowSchema.shape.workflow,
          message: RunWorkflowSchema.shape.message,
          checks: RunWorkflowSchema.shape.checks,
          format: RunWorkflowSchema.shape.format,
        },
        async args => {
          return executeWorkflow(args as RunWorkflowArgs);
        }
      );

      console.error('Visor MCP server started');
    }

    // Connect via stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Failed to start MCP server: ${errorMessage}`);
    process.exit(1);
  }
}
