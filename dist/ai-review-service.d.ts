import { ProbeAgent } from '@probelabs/probe';
import { PRInfo } from './pr-analyzer';
import { ReviewSummary } from './reviewer';
export declare function createProbeTracerAdapter(fallbackTracer?: any): {
    withSpan: (name: string, fn: (...args: any[]) => Promise<any>, attrs?: Record<string, unknown>, onResult?: (span: any, result: any) => void) => Promise<any>;
    recordEvent: (name: string, attrs?: Record<string, unknown>) => void;
    addEvent: (name: string, attrs?: Record<string, unknown>) => void;
    recordToolResult: (toolName: string, result: unknown, success: boolean, durationMs: number, metadata?: Record<string, unknown>) => void;
    recordToolDecision: (toolName: string, params: unknown, metadata?: Record<string, unknown>) => void;
    recordDelegationEvent: (phase: string, attrs?: Record<string, unknown>) => void;
    recordMermaidValidationEvent: (phase: string, attrs?: Record<string, unknown>) => void;
    recordJsonValidationEvent: (phase: string, attrs?: Record<string, unknown>) => void;
    recordTaskEvent: (phase: string, attrs?: Record<string, unknown>) => void;
    createToolSpan: (toolName: string, attrs?: Record<string, unknown>) => {
        setAttributes: (spanAttrs?: Record<string, unknown>) => void;
        setStatus: (status: unknown) => void;
        addEvent: (eventName: string, eventAttrs?: Record<string, unknown>) => void;
        end: () => void;
    };
    createDelegationSpan: (sessionId: string, task: string) => any;
    recordIterationEvent: (phase: string, iteration: number, data?: Record<string, unknown>) => void;
    flush: () => Promise<void>;
    shutdown: () => Promise<void>;
};
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
    maxIterations?: number;
    provider?: 'google' | 'anthropic' | 'openai' | 'bedrock' | 'mock' | 'claude-code' | 'codex';
    /** Closed Probe/Codex execution profile for ordinary governed AI work. */
    codexExecutionProfile?: 'luna-xhigh-readonly-v1' | 'luna-xhigh-isolated-writer-v1';
    /** Explicit opt-in Probe transport selected by native onboarding. */
    governedCodexTransport?: 'exec-jsonl-default-auth-v1';
    /** Absolute caller-selected Codex executable for the selected transport. */
    codexBin?: string;
    /** Caller-supplied SHA-256 (bare or sha256:-prefixed). */
    codexSha256?: string;
    /** Internal provenance selector bound by AICheckProvider from a git-checkout dependency. */
    codexWorkingDirectoryFrom?: string;
    debug?: boolean;
    tools?: Array<{
        name: string;
        [key: string]: unknown;
    }>;
    mcpServers?: Record<string, import('./types/config').McpServerConfig>;
    enableDelegate?: boolean;
    enableTasks?: boolean;
    enableExecutePlan?: boolean;
    promptType?: string;
    systemPrompt?: string;
    customPrompt?: string;
    retry?: import('./types/config').AIRetryConfig;
    fallback?: import('./types/config').AIFallbackConfig;
    allowEdit?: boolean;
    allowedTools?: string[];
    disableTools?: boolean;
    allowBash?: boolean;
    bashConfig?: import('./types/config').BashConfig;
    search_delegate_provider?: string;
    search_delegate_model?: string;
    path?: string;
    cwd?: string;
    workspacePath?: string;
    allowedFolders?: string[];
    completionPrompt?: string;
    /** Shared concurrency limiter for global AI call gating */
    concurrencyLimiter?: any;
    aiTimeout?: number;
    timeoutBehavior?: 'graceful' | 'negotiated';
    negotiatedTimeoutBudget?: number;
    negotiatedTimeoutMaxRequests?: number;
    negotiatedTimeoutMaxPerRequest?: number;
    gracefulStopDeadline?: number;
    /** Custom headers to include in AI provider HTTP requests (e.g., for API gateway session tracking). */
    headers?: Record<string, string>;
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
    executeReview(prInfo: PRInfo, customPrompt: string, schema?: string | Record<string, unknown>, checkName?: string, sessionId?: string, nodeGenerationId?: string): Promise<ReviewSummary>;
    /**
     * Execute AI review using session reuse - reuses an existing ProbeAgent session
     * @param sessionMode - 'clone' (default) clones history, 'append' shares history
     */
    executeReviewWithSessionReuse(prInfo: PRInfo, customPrompt: string, parentSessionId: string, schema?: string | Record<string, unknown>, checkName?: string, sessionMode?: 'clone' | 'append'): Promise<ReviewSummary>;
    /**
     * Promise timeout helper that rejects after ms if unresolved.
     * When a sessionId is provided, triggers graceful wind-down on the
     * ProbeAgent before rejecting, giving it a chance to summarize.
     *
     * When an extender is provided, the deadline can be dynamically pushed
     * forward (e.g. when the agent's negotiated timeout observer grants an
     * extension and emits a `timeout.extended` event).
     */
    private withTimeout;
    /**
     * Wire ProbeAgent's timeout events to a TimeoutExtender so the parent's
     * withTimeout deadline dynamically tracks the agent's negotiated extensions.
     *
     * - `timeout.extended`: observer granted more time → push deadline forward
     * - `timeout.windingDown`: observer declined → agent is finishing, log it
     *
     * Safe to call on older Probe versions that don't emit these events.
     */
    private wireTimeoutEvents;
    /**
     * Close one newly-created ProbeAgent without allowing cleanup to replace the
     * caller's result or keep a timed-out review pending indefinitely.
     */
    private cleanupProbeAgent;
    /**
     * Register a new AI session in the session registry
     */
    registerSession(sessionId: string, agent: TracedProbeAgent): void;
    /**
     * Cleanup a session from the registry
     */
    cleanupSession(sessionId: string): Promise<void>;
    /**
     * Build a custom prompt for AI review with XML-formatted data
     */
    private buildCustomPrompt;
    /**
     * Format PR or Issue context for the AI using XML structure
     */
    private formatPRContext;
    /**
     * Format Slack conversation context (if attached to PRInfo) as XML
     */
    private formatSlackContextFromPRInfo;
    /** Render file attachment metadata as XML fragment for a message. */
    private formatFilesXml;
    /**
     * Build a normalized ConversationContext for GitHub (PR/issue + comments)
     * using the same contract as Slack's ConversationContext. This is exposed
     * to templates via the unified `conversation` object.
     */
    private buildGitHubConversationFromPRInfo;
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
     * Generate mock response for testing
     */
    private generateMockResponse;
    /**
     * Get the API key source for debugging (without revealing the key)
     */
    private getApiKeySource;
}
export {};
