import { PRInfo } from './pr-analyzer';
import { ReviewSummary } from './reviewer';
export interface AIReviewConfig {
    apiKey?: string;
    model?: string;
    timeout?: number;
    provider?: 'google' | 'anthropic' | 'openai' | 'mock';
    debug?: boolean;
}
export interface AIDebugInfo {
    /** The prompt sent to the AI */
    prompt: string;
    /** Raw response from the AI service */
    rawResponse: string;
    /** Provider used (google, anthropic, openai) */
    provider: string;
    /** Model used */
    model: string;
    /** API key source (for privacy, just show which env var) */
    apiKeySource: string;
    /** Processing time in milliseconds */
    processingTime: number;
    /** Prompt length in characters */
    promptLength: number;
    /** Response length in characters */
    responseLength: number;
    /** Any errors encountered */
    errors?: string[];
    /** Whether JSON parsing succeeded */
    jsonParseSuccess: boolean;
    /** Timestamp when request was made */
    timestamp: string;
    /** Total API calls made */
    totalApiCalls?: number;
    /** Details about API calls made */
    apiCallDetails?: Array<{
        checkName: string;
        provider: string;
        model: string;
        processingTime: number;
        success: boolean;
    }>;
}
export declare class AIReviewService {
    private config;
    constructor(config?: AIReviewConfig);
    /**
     * Execute AI review using probe agent
     */
    executeReview(prInfo: PRInfo, customPrompt: string, schema?: string): Promise<ReviewSummary>;
    /**
     * Build a custom prompt for AI review with XML-formatted data
     */
    private buildCustomPrompt;
    /**
     * Format PR context for the AI using XML structure
     */
    private formatPRContext;
    /**
     * Escape XML special characters
     */
    private escapeXml;
    /**
     * Call ProbeAgent SDK with built-in schema validation
     */
    private callProbeAgent;
    /**
     * Load schema content from schema files
     */
    private loadSchemaContent;
    /**
     * Parse AI response JSON
     */
    private parseAIResponse;
    /**
     * Generate mock response for testing
     */
    private generateMockResponse;
    /**
     * Get the API key source for debugging (without revealing the key)
     */
    private getApiKeySource;
}
//# sourceMappingURL=ai-review-service.d.ts.map