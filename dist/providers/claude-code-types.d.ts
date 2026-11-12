/**
 * Type definitions for Claude Code SDK and MCP SDK
 * These are placeholder types for when the packages aren't installed
 */
export interface ClaudeCodeQuery {
    query: string;
    tools?: Array<{
        name: string;
        [key: string]: unknown;
    }>;
    subagent?: string;
    maxTurns?: number;
    systemPrompt?: string;
    sessionId?: string;
}
export interface ClaudeCodeResponse {
    content: string;
    usage?: {
        input_tokens: number;
        output_tokens: number;
    };
    turn_count?: number;
    session_id?: string;
}
export interface ClaudeCodeClient {
    query(options: ClaudeCodeQuery): Promise<ClaudeCodeResponse>;
}
export interface McpServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
}
export interface McpTool {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    handler?: (args: Record<string, unknown>) => Promise<unknown>;
}
export interface McpServer {
    name: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    tools?: McpTool[];
}
export interface McpServerInstance {
    name: string;
    listTools(): Promise<McpTool[]>;
    callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
    close(): Promise<void>;
}
export interface ClaudeCodeConfig {
    allowedTools?: string[];
    maxTurns?: number;
    systemPrompt?: string;
    mcpServers?: Record<string, McpServerConfig>;
    subagent?: string;
    hooks?: {
        onStart?: string;
        onEnd?: string;
        onError?: string;
    };
}
/**
 * Utility function to safely import optional dependencies
 */
export declare function safeImport<T>(moduleName: string): Promise<T | null>;
//# sourceMappingURL=claude-code-types.d.ts.map