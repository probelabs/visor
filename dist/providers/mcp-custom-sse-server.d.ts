import { CustomToolDefinition } from '../types/config';
import { WorkflowToolContext } from './workflow-tool-executor';
/**
 * Custom MCP Server interface
 */
export interface CustomMCPServer {
    start(): Promise<number>;
    stop(options?: {
        graceMs?: number;
        drainTimeoutMs?: number;
    }): Promise<void>;
    getUrl(): string;
}
/**
 * SSE-based MCP server that exposes custom tools from YAML configuration
 * Implements the Model Context Protocol over Server-Sent Events
 */
export declare class CustomToolsSSEServer implements CustomMCPServer {
    private server;
    private port;
    private connections;
    private toolExecutor;
    private sessionId;
    private debug;
    private eventBus;
    private messageQueue;
    private tools;
    private workflowContext?;
    private keepaliveInterval;
    private activeToolCalls;
    private inFlightToolCalls;
    private lastActivityAt;
    private gracefulStopRequested;
    private static readonly KEEPALIVE_INTERVAL_MS;
    constructor(tools: Map<string, CustomToolDefinition>, sessionId: string, debug?: boolean, workflowContext?: WorkflowToolContext);
    /**
     * Start the SSE server on an ephemeral port
     * Returns the actual bound port number
     */
    start(): Promise<number>;
    /**
     * Start sending periodic keepalive pings to all connections
     * This prevents the SSE connection from being closed during long idle periods
     */
    private startKeepalive;
    /**
     * Stop the keepalive interval
     */
    private stopKeepalive;
    private beginToolCall;
    private finalizeToolCall;
    private forceDrainToolCalls;
    /**
     * Stop the server and cleanup resources
     */
    stop(options?: {
        graceMs?: number;
        drainTimeoutMs?: number;
    }): Promise<void>;
    /**
     * Get the SSE endpoint URL
     */
    getUrl(): string;
    /**
     * Handle incoming HTTP requests
     */
    private handleRequest;
    /**
     * Handle legacy POST /sse pattern (connection + message in one request)
     * This maintains backward compatibility with tests
     */
    private handleLegacySSEPost;
    /**
     * Handle SSE connection establishment (GET /sse)
     */
    private handleSSEConnection;
    /**
     * Handle MCP message (POST /message)
     */
    private handleMessage;
    /**
     * Handle CORS headers
     */
    private handleCORS;
    /**
     * Send SSE message to client
     */
    private sendSSE;
    /**
     * Handle MCP protocol messages
     */
    private handleMCPMessage;
    /**
     * Handle tools/list MCP request
     */
    private handleToolsList;
    /**
     * Handle tools/call MCP request
     */
    private handleToolCall;
    /**
     * Execute an http_client tool — proxy REST API calls through the configured base URL.
     */
    private executeHttpClientTool;
    /**
     * Execute a UTCP tool — delegates to UtcpCheckProvider.callTool() for shared lifecycle.
     */
    private executeUtcpTool;
    /**
     * Convert a type: 'workflow' tool definition into a WorkflowToolDefinition marker.
     *
     * For inline workflow tools (with `steps`), registers a synthetic workflow in
     * WorkflowRegistry so it can be executed via WorkflowCheckProvider.
     *
     * For file-referenced workflow tools (with `workflow` field), resolves from
     * WorkflowRegistry by ID.
     */
    private convertInlineWorkflowTool;
    private getEnvNumber;
    /**
     * Send error response via SSE
     */
    private sendErrorResponse;
}
//# sourceMappingURL=mcp-custom-sse-server.d.ts.map