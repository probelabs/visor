/**
 * MCP Server for Visor
 *
 * Exposes Visor workflows as MCP tools, allowing Claude Code and other
 * MCP clients to execute workflows programmatically via stdio or HTTP transport.
 *
 * Usage:
 *   # Generic mode - workflow is a tool parameter (stdio)
 *   visor mcp-server
 *
 *   # Fixed workflow mode - workflow is pre-configured (stdio)
 *   visor mcp-server --config defaults/code-review.yaml
 *
 *   # Custom tool name and description
 *   visor mcp-server --config defaults/code-review.yaml \
 *     --mcp-tool-name "code_review" \
 *     --mcp-tool-description "Run a code review for current uncommitted changes"
 *
 *   # Remote HTTP mode with Bearer token auth
 *   visor mcp-server --transport http --port 8080 --auth-token "my-secret"
 *
 *   # HTTP with token from environment variable
 *   VISOR_MCP_TOKEN=secret visor mcp-server --transport http --auth-token-env VISOR_MCP_TOKEN
 *
 *   # HTTPS with TLS certificates
 *   visor mcp-server --transport http --port 443 \
 *     --tls-cert /path/to/cert.pem --tls-key /path/to/key.pem \
 *     --auth-token-env VISOR_MCP_TOKEN
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
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { runChecks } from './sdk';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';

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

  /** Transport type: 'stdio' (default) or 'http' for remote access. */
  transport?: 'stdio' | 'http';

  /** Port for HTTP transport (default: 8080). */
  port?: number;

  /** Host/bind address for HTTP transport (default: '0.0.0.0'). */
  host?: string;

  /** Bearer token for HTTP transport authentication. */
  authToken?: string;

  /** Environment variable name containing the Bearer token. */
  authTokenEnv?: string;

  /** Path to TLS certificate PEM file. */
  tlsCert?: string;

  /** Path to TLS private key PEM file. */
  tlsKey?: string;

  /** Enable async job mode (start_job/get_job instead of blocking tool). */
  asyncMode?: boolean;
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
 * Resolve the Visor version from package.json or environment.
 */
function getVisorVersion(): string {
  if (process.env.VISOR_VERSION) return process.env.VISOR_VERSION;
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.version) return pkg.version;
    }
  } catch {}
  return 'unknown';
}

/**
 * Server metadata for MCP protocol.
 */
export const SERVER_INFO = {
  name: 'visor',
  get version() {
    return getVisorVersion();
  },
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
 * Register async job tools (start_job / get_job) on an MCP server instance.
 * Used by both standalone and createHttpMcpServer when asyncMode is enabled.
 */
function registerAsyncJobTools(
  server: McpServer,
  resolvedWorkflowPath: string | undefined,
  toolName: string
): void {
  const { JobManager } = require('./mcp-job-manager') as typeof import('./mcp-job-manager');
  const jobManager = new JobManager();

  const startJobName =
    toolName === 'run_workflow' || toolName === 'send_message' ? 'start_job' : `start_${toolName}`;
  const getJobName = 'get_job';

  // Build start_job schema based on whether we have a fixed workflow
  if (resolvedWorkflowPath) {
    (server as any).tool(
      startJobName,
      'Start a long-running job. Returns immediately with a job_id. ' +
        'You MUST then call get_job with this job_id repeatedly (every 10 seconds) until done is true.',
      {
        message: FixedWorkflowSchema.shape.message,
        checks: FixedWorkflowSchema.shape.checks,
        format: FixedWorkflowSchema.shape.format,
        idempotency_key: z
          .string()
          .optional()
          .describe('Optional stable key to prevent duplicate jobs for the same request.'),
      },
      async (args: any) => {
        const response = jobManager.startJob(async () => {
          const result = await executeFixedWorkflow(
            args as FixedWorkflowArgs,
            resolvedWorkflowPath!
          );
          return result;
        }, args.idempotency_key);
        return { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }] };
      }
    );
  } else {
    (server as any).tool(
      startJobName,
      'Start a long-running job. Returns immediately with a job_id. ' +
        'You MUST then call get_job with this job_id repeatedly (every 10 seconds) until done is true.',
      {
        workflow: RunWorkflowSchema.shape.workflow,
        message: RunWorkflowSchema.shape.message,
        checks: RunWorkflowSchema.shape.checks,
        format: RunWorkflowSchema.shape.format,
        idempotency_key: z
          .string()
          .optional()
          .describe('Optional stable key to prevent duplicate jobs for the same request.'),
      },
      async (args: any) => {
        const response = jobManager.startJob(async () => {
          const result = await executeWorkflow(args as RunWorkflowArgs);
          return result;
        }, args.idempotency_key);
        return { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }] };
      }
    );
  }

  // Register get_job tool
  (server as any).tool(
    getJobName,
    'Check the status of a running job. Returns the current progress and, when done, the final result. ' +
      'Call this every 10 seconds until done is true.',
    {
      job_id: z.string().describe('The job ID returned by start_job.'),
    },
    async (args: { job_id: string }) => {
      const response = jobManager.getJob(args.job_id);
      return { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }] };
    }
  );
}

/**
 * Validate a Bearer token from an HTTP request using timing-safe comparison.
 */
export function validateBearerToken(req: http.IncomingMessage, expectedToken: string): boolean {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  if (token.length !== expectedToken.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expectedToken));
  } catch {
    return false;
  }
}

/**
 * Read and parse JSON body from an HTTP request.
 */
function readBody(req: http.IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk));
    req.on('end', () => {
      if (!data.trim()) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Handle returned by createHttpMcpServer for non-blocking lifecycle management.
 */
export interface McpServerHandle {
  close(): void;
}

/**
 * Create and start an MCP HTTP/HTTPS server, returning a handle for lifecycle control.
 *
 * Unlike startHttpMcpServer (used internally by startMcpServer), this function
 * does NOT register process signal handlers — the caller is responsible for
 * calling handle.close() during shutdown.
 */
export async function createHttpMcpServer(options: McpServerOptions): Promise<McpServerHandle> {
  // If fixed workflow mode, validate config path at startup
  let resolvedWorkflowPath: string | undefined;
  if (options.configPath) {
    resolvedWorkflowPath = resolveWorkflowPath(options.configPath);
  }

  const server = new McpServer(
    { name: SERVER_INFO.name, version: SERVER_INFO.version },
    { capabilities: { tools: {} } }
  );

  const toolName = options.toolName || 'run_workflow';
  const toolDescription = options.toolDescription || RUN_WORKFLOW_DESCRIPTION;

  if (options.asyncMode) {
    registerAsyncJobTools(server, resolvedWorkflowPath, toolName);
  } else if (resolvedWorkflowPath) {
    (server as any).tool(
      toolName,
      toolDescription,
      {
        message: FixedWorkflowSchema.shape.message,
        checks: FixedWorkflowSchema.shape.checks,
        format: FixedWorkflowSchema.shape.format,
      },
      async (args: any) => executeFixedWorkflow(args as FixedWorkflowArgs, resolvedWorkflowPath!)
    );
  } else {
    (server as any).tool(
      toolName,
      toolDescription,
      {
        workflow: RunWorkflowSchema.shape.workflow,
        message: RunWorkflowSchema.shape.message,
        checks: RunWorkflowSchema.shape.checks,
        format: RunWorkflowSchema.shape.format,
      },
      async (args: any) => executeWorkflow(args as RunWorkflowArgs)
    );
  }

  return startHttpMcpServerInternal(server, options);
}

/**
 * Start the MCP server over HTTP/HTTPS with StreamableHTTPServerTransport.
 * Returns a handle for non-blocking shutdown.
 */
async function startHttpMcpServerInternal(
  server: McpServer,
  options: McpServerOptions
): Promise<McpServerHandle> {
  const port = options.port || 8080;
  const host = options.host || '0.0.0.0';

  // Resolve auth token
  const authToken =
    options.authToken || (options.authTokenEnv ? process.env[options.authTokenEnv] : undefined);
  if (!authToken) {
    throw new Error(
      'HTTP transport requires --auth-token or --auth-token-env for security. ' +
        'Refusing to start an unauthenticated remote MCP endpoint.'
    );
  }

  // Per-session transport map
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      await handleRequestInner(req, res);
    } catch (err) {
      console.error(`[MCP] Request handler error: ${err}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  };

  const handleRequestInner = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-session-id',
      });
      res.end();
      return;
    }

    // Auth check on all requests (per MCP spec → OAuth 2.1 § 5.3 → RFC 6750 § 3)
    if (!validateBearerToken(req, authToken)) {
      const hasAuthHeader = !!req.headers['authorization'];
      // RFC 6750 §3.1: invalid_token when a token is present but wrong;
      // omit error param when no credentials are provided at all.
      const wwwAuth = hasAuthHeader
        ? 'Bearer error="invalid_token", error_description="The access token is invalid or expired"'
        : 'Bearer';
      res.writeHead(401, {
        'WWW-Authenticate': wwwAuth,
        'Content-Type': 'application/json',
      });
      res.end(
        JSON.stringify({
          error: hasAuthHeader ? 'invalid_token' : 'unauthorized',
          error_description: hasAuthHeader
            ? 'The access token is invalid or expired'
            : 'Authentication required. Provide a Bearer token in the Authorization header.',
        })
      );
      return;
    }

    // Only serve /mcp endpoint
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/mcp') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (req.method === 'POST' && !sessionId) {
      // New session — sessionId is assigned during handleRequest (not connect)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          console.error(`[MCP] Session closed: ${transport.sessionId}`);
          transports.delete(transport.sessionId);
        }
      };
      await server.connect(transport);
      const body = await readBody(req);
      await transport.handleRequest(req, res, body);
      if (transport.sessionId) {
        transports.set(transport.sessionId, transport);
        console.error(`[MCP] New session created: ${transport.sessionId}`);
      }
      return;
    }

    if (sessionId) {
      const transport = transports.get(sessionId);
      if (!transport) {
        console.error(
          `[MCP] Session ${sessionId} not found, active: [${[...transports.keys()].join(', ')}]`
        );
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      if (req.method === 'DELETE') {
        await transport.handleRequest(req, res);
        return;
      }
      const body = await readBody(req);
      await transport.handleRequest(req, res, body);
      return;
    }

    // GET without session (standalone SSE stream)
    if (req.method === 'GET') {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      await server.connect(transport);
      if (transport.sessionId) transports.set(transport.sessionId, transport);
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405);
    res.end('Method not allowed');
  };

  // Create HTTP or HTTPS server
  let httpServer: http.Server | https.Server;
  if (options.tlsCert && options.tlsKey) {
    const cert = fs.readFileSync(options.tlsCert);
    const key = fs.readFileSync(options.tlsKey);
    httpServer = https.createServer({ cert, key }, handleRequest);
    console.error(`Visor MCP server (HTTPS) listening on ${host}:${port}`);
  } else {
    httpServer = http.createServer(handleRequest);
    console.error(`Visor MCP server (HTTP) listening on ${host}:${port}`);
    if (host !== '127.0.0.1' && host !== 'localhost') {
      console.error(
        '⚠️  WARNING: Running without TLS on a non-localhost address. Use --tls-cert and --tls-key for production.'
      );
    }
  }

  httpServer.listen(port, host);

  return {
    close() {
      console.error('Shutting down MCP server...');
      for (const transport of transports.values()) {
        transport.close();
      }
      httpServer.close();
    },
  };
}

/**
 * Start the MCP server with Visor tools.
 *
 * The server exposes the following tools:
 * - run_workflow (or custom name): Execute a Visor workflow and return results
 *
 * Supports stdio (default) and HTTP transports.
 *
 * @param options - Optional configuration for fixed workflow mode and transport
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

    // Register tools based on mode
    if (options.asyncMode) {
      registerAsyncJobTools(server, resolvedWorkflowPath, toolName);
      console.error(
        `Visor MCP server started in async mode${resolvedWorkflowPath ? ` with fixed workflow: ${resolvedWorkflowPath}` : ''}`
      );
    } else if (resolvedWorkflowPath) {
      // Fixed workflow mode - tool without workflow parameter
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

    // Connect via selected transport
    if (options.transport === 'http') {
      const handle = await startHttpMcpServerInternal(server, options);
      // Register signal handlers for standalone mode (visor mcp-server subcommand)
      const shutdown = () => handle.close();
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } else {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Failed to start MCP server: ${errorMessage}`);
    process.exit(1);
  }
}
