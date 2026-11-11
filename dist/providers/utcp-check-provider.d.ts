import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
/**
 * UTCP Check Provider Configuration
 */
export interface UtcpCheckConfig extends CheckProviderConfig {
    /** UTCP manual source: URL string, file path string, or inline call template object */
    manual: string | Record<string, unknown>;
    /** Tool method name to call (format: manual_name.tool_name or just tool_name) */
    method: string;
    /** Arguments to pass to the UTCP tool (supports Liquid templates) */
    methodArgs?: Record<string, unknown>;
    /** Transform template for method arguments (Liquid) - overrides methodArgs */
    argsTransform?: string;
    /** UTCP variables for manual authentication/configuration */
    variables?: Record<string, string>;
    /** UTCP plugins to load (default: ['http']) */
    plugins?: string[];
    /** Transform template for output (Liquid) */
    transform?: string;
    /** Transform using JavaScript expressions */
    transform_js?: string;
    /** Timeout in seconds (default: 60) */
    timeout?: number;
}
/**
 * Check provider that calls UTCP (Universal Tool Calling Protocol) tools directly.
 * UTCP is a client-side protocol where tools publish JSON "manuals" describing
 * how to call them via their native protocols (HTTP, CLI, SSE, etc.).
 *
 * Supports manual discovery from:
 * - HTTP/HTTPS URLs (GET endpoint returning UTCP manual)
 * - Local JSON files
 * - Inline call template objects
 */
export declare class UtcpCheckProvider extends CheckProvider {
    private liquid;
    private sandbox?;
    private sdkAvailable;
    constructor();
    getName(): string;
    getDescription(): string;
    validateConfig(config: unknown): Promise<boolean>;
    execute(prInfo: PRInfo, config: CheckProviderConfig, dependencyResults?: Map<string, ReviewSummary>, sessionInfo?: any): Promise<ReviewSummary>;
    /**
     * Resolve manual config to a UTCP call template object.
     * Shared utility used by both the standalone UTCP provider and the AI check provider's UTCP-to-MCP bridge.
     */
    static resolveManualCallTemplate(manual: string | Record<string, unknown>): Promise<Record<string, unknown>>;
    /**
     * Derive a manual name from a URL.
     * Shared utility for UTCP manual name derivation.
     */
    static deriveManualName(url: string): string;
    /**
     * Call a UTCP tool directly. Shared by both the standalone provider and the MCP-bridge SSE server.
     * Handles SDK import, plugin loading, client creation, tool calling, and cleanup.
     */
    static callTool(manual: string | Record<string, unknown>, toolName: string, args: Record<string, unknown>, options?: {
        variables?: Record<string, string>;
        plugins?: string[];
        timeoutMs?: number;
    }): Promise<unknown>;
    /**
     * Check if an error is a timeout error
     */
    private isTimeoutError;
    /**
     * Build output context from dependency results
     */
    private buildOutputContext;
    /**
     * Get safe environment variables
     */
    private getSafeEnvironmentVariables;
    getSupportedConfigKeys(): string[];
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
}
//# sourceMappingURL=utcp-check-provider.d.ts.map