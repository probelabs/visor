import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
/**
 * AI-powered check provider using probe agent
 */
export declare class AICheckProvider extends CheckProvider {
    private aiReviewService;
    private liquidEngine;
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
    execute(prInfo: PRInfo, config: CheckProviderConfig, _dependencyResults?: Map<string, ReviewSummary>, sessionInfo?: {
        parentSessionId?: string;
        reuseSession?: boolean;
    }): Promise<ReviewSummary>;
    private executeWithConfig;
    /**
     * Get custom tool names from check configuration
     */
    private getCustomToolsForAI;
    /**
     * Load custom tools from global configuration
     */
    private loadCustomTools;
    getSupportedConfigKeys(): string[];
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
}
//# sourceMappingURL=ai-check-provider.d.ts.map