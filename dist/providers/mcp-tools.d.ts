/**
 * MCP Tools Support for Visor
 *
 * This module provides MCP (Model Context Protocol) tools integration
 * for the Claude Code check provider, enabling custom tools and
 * in-process MCP server creation.
 */
interface McpTool {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    handler?: (args: Record<string, unknown>) => Promise<unknown>;
}
interface McpServer {
    name: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    tools?: McpTool[];
}
interface McpServerInstance {
    name: string;
    listTools(): Promise<McpTool[]>;
    callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
    close(): Promise<void>;
}
/**
 * Built-in MCP tools for Visor code analysis
 */
export declare class VisorMcpTools {
    /**
     * Get built-in MCP tools for code analysis
     */
    static getBuiltInTools(): McpTool[];
    /**
     * Analyze file structure and organization
     */
    private static analyzeFileStructure;
    /**
     * Detect common code patterns and anti-patterns
     */
    private static detectPatterns;
    /**
     * Calculate code complexity metrics
     */
    private static calculateComplexity;
    /**
     * Suggest code improvements based on best practices
     */
    private static suggestImprovements;
    /**
     * Generate structure recommendations
     */
    private static generateStructureRecommendations;
    /**
     * Calculate cyclomatic complexity (simplified)
     */
    private static calculateCyclomaticComplexity;
    /**
     * Calculate nesting depth
     */
    private static calculateNestingDepth;
    /**
     * Generate complexity recommendations
     */
    private static generateComplexityRecommendations;
    /**
     * Calculate priority based on suggestions
     */
    private static calculatePriority;
}
/**
 * MCP Server Manager for handling external MCP servers
 */
export declare class McpServerManager {
    private servers;
    /**
     * Create and register an MCP server
     */
    createServer(config: McpServer): Promise<McpServerInstance>;
    /**
     * Get a registered server by name
     */
    getServer(name: string): McpServerInstance | undefined;
    /**
     * List all available tools from all servers
     */
    listAllTools(): Promise<Array<{
        serverName: string;
        tool: McpTool;
    }>>;
    /**
     * Close all servers
     */
    closeAll(): Promise<void>;
    /**
     * Create external MCP server instance
     */
    private createExternalServer;
}
/**
 * Default MCP tools configuration for Visor
 */
export declare const DEFAULT_MCP_TOOLS_CONFIG: McpServer[];
export {};
//# sourceMappingURL=mcp-tools.d.ts.map