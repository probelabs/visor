import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
/**
 * Error thrown when Claude Code SDK is not installed
 */
export declare class ClaudeCodeSDKNotInstalledError extends Error {
    constructor();
}
/**
 * Error thrown when Claude Code API key is not configured
 */
export declare class ClaudeCodeAPIKeyMissingError extends Error {
    constructor();
}
/**
 * Claude Code check provider using the Claude Code TypeScript SDK
 * Supports MCP tools and streaming responses
 */
export declare class ClaudeCodeCheckProvider extends CheckProvider {
    private liquidEngine;
    private claudeCodeClient;
    constructor();
    getName(): string;
    getDescription(): string;
    validateConfig(config: unknown): Promise<boolean>;
    /**
     * Initialize Claude Code SDK client
     */
    private initializeClaudeCodeClient;
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
     * Render Liquid template in prompt with comprehensive context
     */
    private renderPromptTemplate;
    /**
     * Parse structured response from Claude Code
     */
    private parseStructuredResponse;
    execute(prInfo: PRInfo, config: CheckProviderConfig, dependencyResults?: Map<string, ReviewSummary>, sessionInfo?: {
        parentSessionId?: string;
        reuseSession?: boolean;
    }): Promise<ReviewSummary>;
    private executeWithConfig;
    getSupportedConfigKeys(): string[];
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
}
//# sourceMappingURL=claude-code-check-provider.d.ts.map