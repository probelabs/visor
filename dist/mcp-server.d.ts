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
import { z } from 'zod';
import * as http from 'http';
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
    /** Long poll timeout in seconds for get_job (default: 59). */
    longPollTimeout?: number;
    /** TaskStore for async job mode persistence. If not provided, one will be created. */
    taskStore?: import('./agent-protocol/task-store').TaskStore;
}
/**
 * Available default workflows bundled with Visor.
 */
export declare const DEFAULT_WORKFLOWS: readonly ["code-review", "visor", "task-refinement", "code-refiner"];
/**
 * Server metadata for MCP protocol.
 */
export declare const SERVER_INFO: {
    name: string;
    readonly version: string;
    description: string;
};
/**
 * Tool description for the run_workflow tool.
 */
export declare const RUN_WORKFLOW_DESCRIPTION: string;
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
export declare function resolveWorkflowPath(workflow: string): string;
/**
 * Format check results based on the requested format.
 *
 * @param results - The raw results from runChecks
 * @param format - Output format: json, markdown, or table
 * @returns Formatted string representation of results
 */
export declare function formatResults(results: Record<string, unknown>, format: 'json' | 'markdown' | 'table'): string;
/**
 * Zod schema for run_workflow tool parameters.
 */
export declare const RunWorkflowSchema: z.ZodObject<{
    workflow: z.ZodString;
    message: z.ZodOptional<z.ZodString>;
    checks: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    format: z.ZodDefault<z.ZodOptional<z.ZodEnum<["json", "markdown", "table"]>>>;
}, "strip", z.ZodTypeAny, {
    workflow: string;
    format: "table" | "json" | "markdown";
    checks?: string[] | undefined;
    message?: string | undefined;
}, {
    workflow: string;
    checks?: string[] | undefined;
    message?: string | undefined;
    format?: "table" | "json" | "markdown" | undefined;
}>;
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
export declare function executeWorkflow(args: RunWorkflowArgs): Promise<{
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
}>;
/**
 * Zod schema for fixed workflow tool parameters (no workflow parameter).
 */
export declare const FixedWorkflowSchema: z.ZodObject<{
    message: z.ZodOptional<z.ZodString>;
    checks: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    format: z.ZodDefault<z.ZodOptional<z.ZodEnum<["json", "markdown", "table"]>>>;
}, "strip", z.ZodTypeAny, {
    format: "table" | "json" | "markdown";
    checks?: string[] | undefined;
    message?: string | undefined;
}, {
    checks?: string[] | undefined;
    message?: string | undefined;
    format?: "table" | "json" | "markdown" | undefined;
}>;
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
export declare function executeFixedWorkflow(args: FixedWorkflowArgs, workflowPath: string): Promise<{
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
}>;
/**
 * Validate a Bearer token from an HTTP request using timing-safe comparison.
 */
export declare function validateBearerToken(req: http.IncomingMessage, expectedToken: string): boolean;
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
export declare function createHttpMcpServer(options: McpServerOptions): Promise<McpServerHandle>;
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
export declare function startMcpServer(options?: McpServerOptions): Promise<void>;
