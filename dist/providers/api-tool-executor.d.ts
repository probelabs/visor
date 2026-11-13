import type { CustomToolDefinition } from '../types/config';
import { type RateLimitConfig } from '../utils/rate-limiter';
type JsonSchemaObject = Record<string, unknown>;
interface ApiToolConfig {
    customHeaders: Record<string, string>;
    disableXMcp: boolean;
    apiKey?: string;
    securitySchemeName?: string;
    securityCredentials: Record<string, string>;
    requestTimeoutMs: number;
    rateLimitConfig?: RateLimitConfig;
}
interface ApiCallDetails {
    method: string;
    pathTemplate: string;
    serverUrl: string;
    parameters: Array<Record<string, any>>;
    requestBody?: Record<string, any>;
    securityRequirements: Array<Record<string, string[]>> | null;
    securitySchemes?: Record<string, Record<string, any>>;
    apiToolConfig: ApiToolConfig;
}
export interface ApiMappedTool {
    sourceToolName: string;
    mcpToolDefinition: {
        name: string;
        description: string;
        inputSchema: JsonSchemaObject;
        outputSchema?: JsonSchemaObject;
    };
    apiCallDetails: ApiCallDetails;
}
export declare function isApiToolDefinition(tool: CustomToolDefinition | undefined): boolean;
export declare function executeMappedApiTool(mappedTool: ApiMappedTool, args: Record<string, unknown>): Promise<unknown>;
export declare class ApiToolRegistry {
    private bundleCache;
    private operationCache;
    private registerMappedTools;
    ensureBundle(sourceToolName: string, tool: CustomToolDefinition): Promise<ApiMappedTool[]>;
    ensureAll(toolMap: Map<string, CustomToolDefinition>): Promise<void>;
    listMappedTools(toolMap: Map<string, CustomToolDefinition>): Promise<ApiMappedTool[]>;
    getMappedTool(toolName: string, toolMap: Map<string, CustomToolDefinition>): Promise<ApiMappedTool | undefined>;
}
export {};
//# sourceMappingURL=api-tool-executor.d.ts.map