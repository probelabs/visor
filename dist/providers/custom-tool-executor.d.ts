import { CustomToolDefinition } from '../types/config';
/**
 * Executes custom tools defined in YAML configuration
 * These tools can be used in MCP blocks as if they were native MCP tools
 */
export declare class CustomToolExecutor {
    private liquid;
    private sandbox?;
    private tools;
    private ajv;
    constructor(tools?: Record<string, CustomToolDefinition>);
    /**
     * Register a custom tool
     */
    registerTool(tool: CustomToolDefinition): void;
    /**
     * Register multiple tools
     */
    registerTools(tools: Record<string, CustomToolDefinition>): void;
    /**
     * Get all registered tools
     */
    getTools(): CustomToolDefinition[];
    /**
     * Get a specific tool by name
     */
    getTool(name: string): CustomToolDefinition | undefined;
    /**
     * Validate tool input against schema using ajv
     */
    private validateInput;
    /**
     * Execute a custom tool
     */
    execute(toolName: string, args: Record<string, unknown>, context?: {
        pr?: {
            number: number;
            title: string;
            author: string;
            branch: string;
            base: string;
        };
        files?: unknown[];
        outputs?: Record<string, unknown>;
        env?: Record<string, string>;
    }): Promise<unknown>;
    /**
     * Apply JavaScript transform to output
     */
    private applyJavaScriptTransform;
    /**
     * Convert custom tools to MCP tool format
     */
    toMcpTools(): Array<{
        name: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
        handler: (args: Record<string, unknown>) => Promise<unknown>;
    }>;
}
//# sourceMappingURL=custom-tool-executor.d.ts.map