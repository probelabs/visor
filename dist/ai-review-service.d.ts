import { ProbeAgent } from '@probelabs/probe';
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
    /** Schema used for response validation */
    schema?: string;
    /** Schema name/type requested */
    schemaName?: string;
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
    private sessionRegistry;
    constructor(config?: AIReviewConfig);
    /**
     * Execute AI review using probe agent
     */
    executeReview(prInfo: PRInfo, customPrompt: string, schema?: string, _checkName?: string, sessionId?: string): Promise<ReviewSummary>;
    /**
     * Execute AI review using session reuse - reuses an existing ProbeAgent session
     */
    executeReviewWithSessionReuse(prInfo: PRInfo, customPrompt: string, parentSessionId: string, schema?: string, checkName?: string): Promise<ReviewSummary>;
    /**
     * Register a new AI session in the session registry
     */
    registerSession(sessionId: string, agent: ProbeAgent): void;
    /**
     * Cleanup a session from the registry
     */
    cleanupSession(sessionId: string): void;
    /**
     * Build a custom prompt for AI review with XML-formatted data
     */
    private buildCustomPrompt;
    /**
     * Format PR context for the AI using XML structure
     */
    private formatPRContext;
    /**
     * No longer escaping XML - returning text as-is
     */
    private escapeXml;
    /**
     * Call ProbeAgent with an existing session
     */
    private callProbeAgentWithExistingSession;
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