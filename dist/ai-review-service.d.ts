import { ProbeAgent } from '@probelabs/probe';
import { PRInfo } from './pr-analyzer';
import { ReviewSummary } from './reviewer';
/**
 * Extended ProbeAgent interface that includes tracing properties
 */
interface TracedProbeAgent extends ProbeAgent {
    tracer?: unknown;
    _telemetryConfig?: unknown;
    _traceFilePath?: string;
}
export interface AIReviewConfig {
    apiKey?: string;
    model?: string;
    timeout?: number;
    provider?: 'google' | 'anthropic' | 'openai' | 'bedrock' | 'mock' | 'claude-code';
    debug?: boolean;
    tools?: Array<{
        name: string;
        [key: string]: unknown;
    }>;
    mcpServers?: Record<string, import('./types/config').McpServerConfig>;
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
    /** Checks executed during this review */
    checksExecuted?: string[];
    /** Whether parallel execution was used */
    parallelExecution?: boolean;
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
    executeReview(prInfo: PRInfo, customPrompt: string, schema?: string | Record<string, unknown>, checkName?: string, sessionId?: string): Promise<ReviewSummary>;
    /**
     * Execute AI review using session reuse - reuses an existing ProbeAgent session
     * @param sessionMode - 'clone' (default) clones history, 'append' shares history
     */
    executeReviewWithSessionReuse(prInfo: PRInfo, customPrompt: string, parentSessionId: string, schema?: string | Record<string, unknown>, checkName?: string, sessionMode?: 'clone' | 'append'): Promise<ReviewSummary>;
    /**
     * Promise timeout helper that rejects after ms if unresolved
     */
    private withTimeout;
    /**
     * Register a new AI session in the session registry
     */
    registerSession(sessionId: string, agent: TracedProbeAgent): void;
    /**
     * Cleanup a session from the registry
     */
    cleanupSession(sessionId: string): void;
    /**
     * Build a custom prompt for AI review with XML-formatted data
     */
    private buildCustomPrompt;
    /**
     * Format PR or Issue context for the AI using XML structure
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
     * Load schema content from schema files or inline definitions
     */
    private loadSchemaContent;
    /**
     * Parse AI response JSON
     */
    private parseAIResponse;
    /**
     * Extract JSON from a response that might contain surrounding text
     * Uses proper bracket matching to find valid JSON objects or arrays
     */
    private extractJsonFromResponse;
    /**
     * Find JSON with proper bracket matching to avoid false positives
     */
    private findJsonWithBracketMatching;
    /**
     * Generate mock response for testing
     */
    private generateMockResponse;
    /**
     * Get the API key source for debugging (without revealing the key)
     */
    private getApiKeySource;
}
export {};
