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
    validateConfig(config: unknown): Promise<boolean>;
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
    execute(prInfo: PRInfo, config: CheckProviderConfig, _dependencyResults?: Map<string, ReviewSummary>): Promise<ReviewSummary>;
    private executeWithConfig;
    getSupportedConfigKeys(): string[];
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
}
//# sourceMappingURL=ai-check-provider.d.ts.map