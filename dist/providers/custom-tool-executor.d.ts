import { CustomToolDefinition } from '../types/config';
/**
 * Check if a tool definition is an inline workflow tool (type: 'workflow')
 */
export declare function isInlineWorkflowTool(tool: CustomToolDefinition | undefined): boolean;
/**
 * Executes custom tools defined in YAML configuration
 * These tools can be used in MCP blocks as if they were native MCP tools
 */
export declare class CustomToolExecutor {
    private liquid;
    private sandbox?;
    private tools;
    private ajv;
    private apiToolRegistry;
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
     * Validate input against a JSON schema object
     */
    private validateInputSchema;
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
     * Check if a tool exists (direct or API-generated)
     */
    hasTool(toolName: string): Promise<boolean>;
    /**
     * Get all available tool names, including API-generated operations
     */
    getToolNames(): Promise<string[]>;
    /**
     * List MCP-compatible tool definitions including API-generated operations
     */
    listMcpTools(): Promise<Array<{
        name: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
    }>>;
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