import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
/**
 * MCP Check Provider Configuration
 */
export interface McpCheckConfig extends CheckProviderConfig {
    /** Transport type: stdio (default), sse (legacy), or http (streamable HTTP) */
    transport?: 'stdio' | 'sse' | 'http';
    /** Command to execute (for stdio transport) */
    command?: string;
    /** Command arguments (for stdio transport) */
    args?: string[];
    /** Environment variables (for stdio transport) */
    env?: Record<string, string>;
    /** Working directory (for stdio transport) */
    workingDirectory?: string;
    /** URL for SSE/HTTP transport */
    url?: string;
    /** HTTP headers (for SSE/HTTP transport) */
    headers?: Record<string, string>;
    /** Session ID for HTTP transport (optional, server may generate one) */
    sessionId?: string;
    /** MCP method/tool to call */
    method: string;
    /** Arguments to pass to the MCP method (supports Liquid templates) */
    methodArgs?: Record<string, unknown>;
    /** Transform template for method arguments (Liquid) */
    argsTransform?: string;
    /** Transform template for output (Liquid) */
    transform?: string;
    /** Transform using JavaScript expressions */
    transform_js?: string;
    /** Timeout in seconds */
    timeout?: number;
}
/**
 * Check provider that calls MCP tools directly
 * Supports stdio, SSE (legacy), and Streamable HTTP transports
 */
export declare class McpCheckProvider extends CheckProvider {
    private liquid;
    private sandbox?;
    constructor();
    /**
     * Create a secure sandbox for JavaScript execution
     * - Uses Sandbox.SAFE_GLOBALS which excludes: Function, eval, require, process, etc.
     * - Only allows explicitly whitelisted prototype methods
     * - No access to filesystem, network, or system resources
     */
    private createSecureSandbox;
    getName(): string;
    getDescription(): string;
    validateConfig(config: unknown): Promise<boolean>;
    execute(prInfo: PRInfo, config: CheckProviderConfig, dependencyResults?: Map<string, ReviewSummary>): Promise<ReviewSummary>;
    /**
     * Execute an MCP method using the configured transport
     */
    private executeMcpMethod;
    /**
     * Generic method to execute MCP method with any transport
     */
    private executeWithTransport;
    /**
     * Execute MCP method using stdio transport
     */
    private executeStdioMethod;
    /**
     * Execute MCP method using SSE transport
     */
    private executeSseMethod;
    /**
     * Execute MCP method using Streamable HTTP transport
     */
    private executeHttpMethod;
    /**
     * Build output context from dependency results
     */
    private buildOutputContext;
    /**
     * Get safe environment variables
     */
    private getSafeEnvironmentVariables;
    /**
     * Extract issues from MCP output
     */
    private extractIssuesFromOutput;
    /**
     * Normalize an array of issues
     */
    private normalizeIssueArray;
    /**
     * Normalize a single issue
     */
    private normalizeIssue;
    private toTrimmedString;
    private toNumber;
    getSupportedConfigKeys(): string[];
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
}
//# sourceMappingURL=mcp-check-provider.d.ts.map