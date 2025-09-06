import { PRInfo } from './pr-analyzer';
import { ReviewSummary } from './reviewer';
export interface AIReviewConfig {
    apiKey?: string;
    model?: string;
    timeout?: number;
    provider?: 'google' | 'anthropic' | 'openai';
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
}
export type ReviewFocus = 'security' | 'performance' | 'style' | 'all';
export declare class AIReviewService {
    private config;
    constructor(config?: AIReviewConfig);
    /**
     * Execute AI review using probe-chat
     */
    executeReview(prInfo: PRInfo, focus: ReviewFocus): Promise<ReviewSummary>;
    /**
     * Build the prompt for AI review with XML-formatted data
     */
    private buildPrompt;
    /**
     * Get focus-specific instructions
     */
    private getFocusInstructions;
    /**
     * Format PR context for the AI using XML structure
     */
    private formatPRContext;
    /**
     * Escape XML special characters
     */
    private escapeXml;
    /**
     * Call probe-chat CLI tool using stdin to avoid shell escaping issues
     */
    private callProbeChat;
    /**
     * Parse AI response JSON
     */
    private parseAIResponse;
    /**
     * Validate severity value
     */
    private validateSeverity;
    /**
     * Validate category value
     */
    private validateCategory;
    /**
     * Calculate a simple score based on issue severity
     */
    private calculateScore;
    /**
     * Get the API key source for debugging (without revealing the key)
     */
    private getApiKeySource;
}
//# sourceMappingURL=ai-review-service.d.ts.map