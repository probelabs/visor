import { CustomToolDefinition } from '../types/config';
/**
 * Custom MCP Server interface
 */
export interface CustomMCPServer {
    start(): Promise<number>;
    stop(): Promise<void>;
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
    constructor(tools: Map<string, CustomToolDefinition>, sessionId: string, debug?: boolean);
    /**
     * Start the SSE server on an ephemeral port
     * Returns the actual bound port number
     */
    start(): Promise<number>;
    /**
     * Stop the server and cleanup resources
     */
    stop(): Promise<void>;
    /**
     * Get the SSE endpoint URL
     */
    getUrl(): string;
    /**
     * Handle incoming HTTP requests
     */
    private handleRequest;
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
     * Send error response via SSE
     */
    private sendErrorResponse;
}
//# sourceMappingURL=mcp-custom-sse-server.d.ts.map