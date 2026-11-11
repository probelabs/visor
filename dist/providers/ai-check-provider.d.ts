import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
/**
 * AI-powered check provider using probe agent
 */
export declare class AICheckProvider extends CheckProvider {
    private aiReviewService;
    private liquidEngine;
    private sandbox;
    constructor();
    getName(): string;
    getDescription(): string;
    /** Lightweight debug helper to avoid importing logger here */
    private logDebug;
    /** Detect Slack webhook payload and build a lightweight slack context for templates */
    private buildSlackEventContext;
    validateConfig(config: unknown): Promise<boolean>;
    /**
     * Validate MCP servers configuration
     */
    private validateMcpServers;
    /**
     * Group files by their file extension for template context
     */
    private groupFilesByExtension;
    /**
     * Process prompt configuration to resolve final prompt string
     */
    private processPrompt;
    /**
     * Detect if a string is likely a file path and if the file exists
     */
    private isFilePath;
    /**
     * Load prompt content from file with security validation
     */
    private loadPromptFromFile;
    /**
     * Render Liquid template in prompt with comprehensive event context
     */
    private renderPromptTemplate;
    /**
     * Render Liquid templates in schema definitions
     * Supports dynamic enum values and other template-driven schema properties
     */
    private renderSchema;
    execute(prInfo: PRInfo, config: CheckProviderConfig, _dependencyResults?: Map<string, ReviewSummary>, sessionInfo?: {
        parentSessionId?: string;
        reuseSession?: boolean;
        /** Journal-owned identity used only to disambiguate generated diagnostics. */
        nodeGenerationId?: string;
    }): Promise<ReviewSummary>;
    private executeWithConfig;
    /**
     * Get custom tool items from check configuration
     * Returns an array of tool items (string names or workflow references)
     */
    private getCustomToolsForAI;
    /**
     * Evaluate ai_custom_tools_js expression to dynamically compute custom tools.
     * Returns an array of tool names or workflow references.
     */
    private evaluateCustomToolsJs;
    /**
     * Evaluate ai_mcp_servers_js expression to dynamically compute MCP servers.
     * Returns a record mapping server names to McpServerConfig objects.
     */
    private evaluateMcpServersJs;
    /**
     * Evaluate ai_bash_config_js expression to dynamically compute bash configuration.
     * Returns a partial BashConfig object with optional allow/deny arrays.
     */
    private evaluateBashConfigJs;
    /**
     * Evaluate ai_allowed_tools_js expression to dynamically compute allowed tools list.
     * Returns a string array of tool names, or null if the expression returns a non-array.
     */
    private evaluateAllowedToolsJs;
    /**
     * Build a safe subset of environment variables for sandbox access.
     * Excludes sensitive keys like API keys, secrets, tokens.
     */
    private static _stableEnvForSafe;
    /**
     * Build a safe env for sandboxed expressions (no secrets).
     * Uses /proc/self/environ as the base to avoid copying transient vars
     * that concurrent withTemporaryEnv() calls may have injected.
     */
    private buildSafeEnv;
    /**
     * Load custom tools from global configuration and workflow registry
     * Supports both traditional custom tools and workflow-as-tool references
     */
    private loadCustomTools;
    /**
     * Intersect config-level allowedTools with policy-level allowedTools.
     * When the config list contains glob patterns ("*", "!" exclusions),
     * it is passed through unchanged — ProbeAgent resolves those patterns.
     * Literal tool name lists are intersected normally.
     */
    static intersectAllowedTools(configTools: string[] | undefined, policyTools: string[]): string[];
    getSupportedConfigKeys(): string[];
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
}
//# sourceMappingURL=ai-check-provider.d.ts.map