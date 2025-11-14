interface AIDebugInfo {
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

interface ReviewIssue {
    file: string;
    line: number;
    endLine?: number;
    ruleId: string;
    message: string;
    severity: 'info' | 'warning' | 'error' | 'critical';
    category: 'security' | 'performance' | 'style' | 'logic' | 'documentation';
    checkName?: string;
    group?: string;
    schema?: string;
    timestamp?: number;
    suggestion?: string;
    replacement?: string;
}
interface ReviewSummary {
    issues?: ReviewIssue[];
    debug?: AIDebugInfo;
    /** Session ID created for this check (for cleanup tracking) */
    sessionId?: string;
}

/**
 * Types for Visor configuration system
 */

/**
 * Failure condition severity levels
 */
type FailureConditionSeverity = 'error' | 'warning' | 'info';
/**
 * Simple failure condition - just an expression string
 */
type SimpleFailureCondition = string;
/**
 * Complex failure condition with additional metadata
 */
interface ComplexFailureCondition {
    /** Expression to evaluate using Function Constructor */
    condition: string;
    /** Human-readable message when condition is met */
    message?: string;
    /** Severity level of the failure */
    severity?: FailureConditionSeverity;
    /** Whether this condition should halt execution */
    halt_execution?: boolean;
}
/**
 * Failure condition - can be a simple expression string or complex object
 */
type FailureCondition = SimpleFailureCondition | ComplexFailureCondition;
/**
 * Collection of failure conditions
 */
interface FailureConditions {
    [conditionName: string]: FailureCondition;
}
/**
 * Result of failure condition evaluation
 */
interface FailureConditionResult {
    /** Name of the condition that was evaluated */
    conditionName: string;
    /** Whether the condition evaluated to true (failure) */
    failed: boolean;
    /** The expression that was evaluated */
    expression: string;
    /** Human-readable message */
    message?: string;
    /** Severity of the failure */
    severity: FailureConditionSeverity;
    /** Whether execution should halt */
    haltExecution: boolean;
    /** Error message if evaluation failed */
    error?: string;
}
/**
 * Valid check types in configuration
 */
type ConfigCheckType = 'ai' | 'command' | 'script' | 'http' | 'http_input' | 'http_client' | 'noop' | 'log' | 'memory' | 'github' | 'claude-code' | 'mcp' | 'human-input';
/**
 * Valid event triggers for checks
 */
type EventTrigger = 'pr_opened' | 'pr_updated' | 'pr_closed' | 'issue_opened' | 'issue_comment' | 'manual' | 'schedule' | 'webhook_received';
/**
 * Valid output formats
 */
type ConfigOutputFormat = 'table' | 'json' | 'markdown' | 'sarif';
/**
 * Tag filter configuration for selective check execution
 */
interface TagFilter {
    /** Tags that checks must have to be included (ANY match) */
    include?: string[];
    /** Tags that will exclude checks if present (ANY match) */
    exclude?: string[];
}
/**
 * Valid grouping options
 */
type GroupByOption = 'check' | 'file' | 'severity' | 'group';
/**
 * Environment variable reference configuration
 */
interface EnvConfig {
    [key: string]: string | number | boolean;
}
/**
 * Retry configuration for AI provider calls
 */
interface AIRetryConfig {
    /** Maximum retry attempts (0-50) */
    maxRetries?: number;
    /** Initial delay in milliseconds (0-60000) */
    initialDelay?: number;
    /** Maximum delay cap in milliseconds (0-300000) */
    maxDelay?: number;
    /** Exponential backoff multiplier (1-10) */
    backoffFactor?: number;
    /** Custom error patterns to retry on */
    retryableErrors?: string[];
}
/**
 * Fallback provider configuration
 */
interface AIFallbackProviderConfig {
    /** AI provider to use */
    provider: 'google' | 'anthropic' | 'openai' | 'bedrock';
    /** Model name to use */
    model: string;
    /** API key for this provider */
    apiKey?: string;
    /** Per-provider retry override */
    maxRetries?: number;
    /** AWS region (for Bedrock) */
    region?: string;
    /** AWS access key ID (for Bedrock) */
    accessKeyId?: string;
    /** AWS secret access key (for Bedrock) */
    secretAccessKey?: string;
}
/**
 * Fallback configuration for AI providers
 */
interface AIFallbackConfig {
    /** Fallback strategy: 'same-model', 'same-provider', 'any', or 'custom' */
    strategy?: 'same-model' | 'same-provider' | 'any' | 'custom';
    /** Array of fallback provider configurations */
    providers?: AIFallbackProviderConfig[];
    /** Maximum total attempts across all providers */
    maxTotalAttempts?: number;
    /** Enable automatic fallback using available environment variables */
    auto?: boolean;
}
/**
 * Bash command execution configuration for ProbeAgent
 * Note: Use 'allowBash: true' in AIProviderConfig to enable bash execution
 */
interface BashConfig {
    /** Array of permitted command patterns (e.g., ['ls', 'git status']) */
    allow?: string[];
    /** Array of blocked command patterns (e.g., ['rm -rf', 'sudo']) */
    deny?: string[];
    /** Disable default safe command list (use with caution) */
    noDefaultAllow?: boolean;
    /** Disable default dangerous command blocklist (use with extreme caution) */
    noDefaultDeny?: boolean;
    /** Execution timeout in milliseconds */
    timeout?: number;
    /** Default working directory for command execution */
    workingDirectory?: string;
}
/**
 * AI provider configuration
 */
interface AIProviderConfig {
    /** AI provider to use */
    provider?: 'google' | 'anthropic' | 'openai' | 'bedrock' | 'mock';
    /** Model name to use */
    model?: string;
    /** API key (usually from environment variables) */
    apiKey?: string;
    /** Request timeout in milliseconds */
    timeout?: number;
    /** Enable debug mode */
    debug?: boolean;
    /** Probe promptType to use (e.g., engineer, code-review, architect) */
    prompt_type?: string;
    /** System prompt (baseline preamble). Replaces legacy custom_prompt. */
    system_prompt?: string;
    /** Probe customPrompt (baseline/system prompt) — deprecated, use system_prompt */
    custom_prompt?: string;
    /** Skip adding code context (diffs, files, PR info) to the prompt */
    skip_code_context?: boolean;
    /** MCP servers configuration */
    mcpServers?: Record<string, McpServerConfig>;
    /** Enable the delegate tool for task distribution to subagents */
    enableDelegate?: boolean;
    /** Retry configuration for this provider */
    retry?: AIRetryConfig;
    /** Fallback configuration for provider failures */
    fallback?: AIFallbackConfig;
    /** Enable Edit and Create tools for file modification (disabled by default for security) */
    allowEdit?: boolean;
    /** Filter allowed tools - supports whitelist, exclusion (!prefix), or raw AI mode (empty array) */
    allowedTools?: string[];
    /** Disable all tools for raw AI mode (alternative to allowedTools: []) */
    disableTools?: boolean;
    /** Enable bash command execution (shorthand for bashConfig.enabled) */
    allowBash?: boolean;
    /** Advanced bash command execution configuration */
    bashConfig?: BashConfig;
}
/**
 * MCP Server configuration
 */
interface McpServerConfig {
    /** Command to execute for the MCP server */
    command: string;
    /** Arguments to pass to the command */
    args?: string[];
    /** Environment variables for the MCP server */
    env?: Record<string, string>;
}
/**
 * Claude Code configuration
 */
interface ClaudeCodeConfig {
    /** List of allowed tools for Claude Code to use */
    allowedTools?: string[];
    /** Maximum number of turns in conversation */
    maxTurns?: number;
    /** System prompt for Claude Code */
    systemPrompt?: string;
    /** MCP servers configuration */
    mcpServers?: Record<string, McpServerConfig>;
    /** Path to subagent script */
    subagent?: string;
    /** Enable the delegate tool for task distribution to subagents */
    enableDelegate?: boolean;
    /** Event hooks for lifecycle management */
    hooks?: {
        /** Called when check starts */
        onStart?: string;
        /** Called when check ends */
        onEnd?: string;
        /** Called when check encounters an error */
        onError?: string;
    };
}
/**
 * Configuration for a single check
 */
interface CheckConfig {
    /** Type of check to perform (defaults to 'ai' if not specified) */
    type?: ConfigCheckType;
    /** AI prompt for the check - can be inline string or file path (auto-detected) - required for AI checks */
    prompt?: string;
    /** Additional prompt to append when extending configurations - merged with parent prompt */
    appendPrompt?: string;
    /** Command execution with Liquid template support - required for command checks */
    exec?: string;
    /** Stdin input for tools with Liquid template support - optional for tool checks */
    stdin?: string;
    /** HTTP URL - required for http output checks */
    url?: string;
    /** HTTP body template (Liquid) - required for http output checks */
    body?: string;
    /** HTTP method (defaults to POST) */
    method?: string;
    /** HTTP headers */
    headers?: Record<string, string>;
    /** HTTP endpoint path - required for http_input checks */
    endpoint?: string;
    /** Transform template for http_input data (Liquid) - optional */
    transform?: string;
    /** Transform using JavaScript expressions (evaluated in secure sandbox) - optional */
    transform_js?: string;
    /** Script content to execute for script checks */
    content?: string;
    /** Cron schedule expression (e.g., "0 2 * * *") - optional for any check type */
    schedule?: string;
    /** Focus area for the check (security/performance/style/architecture/all) - optional */
    focus?: string;
    /** Command that triggers this check (e.g., "review", "security-scan") - optional */
    command?: string;
    /** Events that trigger this check (defaults to ['manual'] if not specified) */
    on?: EventTrigger[];
    /** File patterns that trigger this check (optional) */
    triggers?: string[];
    /** AI provider configuration (optional) */
    ai?: AIProviderConfig;
    /** AI model to use for this check - overrides global setting */
    ai_model?: string;
    /** AI provider to use for this check - overrides global setting */
    ai_provider?: 'google' | 'anthropic' | 'openai' | 'bedrock' | 'mock' | string;
    /** Optional persona hint, prepended to the prompt as 'Persona: <value>' */
    ai_persona?: string;
    /** Probe promptType for this check (underscore style) */
    ai_prompt_type?: string;
    /** System prompt for this check (underscore style) */
    ai_system_prompt?: string;
    /** Legacy customPrompt (underscore style) — deprecated, use ai_system_prompt */
    ai_custom_prompt?: string;
    /** MCP servers for this AI check - overrides global setting */
    ai_mcp_servers?: Record<string, McpServerConfig>;
    /** Claude Code configuration (for claude-code type checks) */
    claude_code?: ClaudeCodeConfig;
    /** Environment variables for this check */
    env?: EnvConfig;
    /** Timeout in seconds for command execution (default: 60) */
    timeout?: number;
    /** Check IDs that this check depends on (optional) */
    depends_on?: string[];
    /** Group name for comment separation (e.g., "code-review", "pr-overview") - optional */
    group?: string;
    /** Schema type for template rendering (e.g., "code-review", "markdown") or inline JSON schema object - optional */
    schema?: string | Record<string, unknown>;
    /** Custom template configuration - optional */
    template?: CustomTemplateConfig;
    /** Condition to determine if check should run - runs if expression evaluates to true */
    if?: string;
    /** Check name to reuse AI session from, or true to use first dependency (only works with depends_on) */
    reuse_ai_session?: string | boolean;
    /** How to reuse AI session: 'clone' (default, copy history) or 'append' (share history) */
    session_mode?: 'clone' | 'append';
    /** Simple fail condition - fails check if expression evaluates to true */
    fail_if?: string;
    /** Check-specific failure conditions - optional (deprecated, use fail_if) */
    failure_conditions?: FailureConditions;
    /** Tags for categorizing and filtering checks (e.g., ["local", "fast", "security"]) */
    tags?: string[];
    /**
     * Allow dependents to run even if this step fails.
     * Defaults to false (dependents are gated when this step fails).
     * Similar to GitHub Actions' continue-on-error.
     */
    continue_on_failure?: boolean;
    /** Process output as array and run dependent checks for each item */
    forEach?: boolean;
    /**
     * Control scheduling behavior when this check is triggered via routing (run/goto)
     * from a forEach scope.
     * - 'map': schedule once per item (fan-out) using item scopes.
     * - 'reduce': schedule a single run at the parent scope (aggregation).
     * If unset, the current default is a single run (reduce) for backward compatibility.
     */
    fanout?: 'map' | 'reduce';
    /** Alias for fanout: 'reduce' */
    reduce?: boolean;
    /** Failure routing configuration for this check (retry/goto/run) */
    on_fail?: OnFailConfig;
    /** Success routing configuration for this check (post-actions and optional goto) */
    on_success?: OnSuccessConfig;
    /** Finish routing configuration for forEach checks (runs after ALL iterations complete) */
    on_finish?: OnFinishConfig;
    /**
     * Hard cap on how many times this check may execute within a single engine run.
     * Overrides global limits.max_runs_per_check. Set to 0 or negative to disable for this step.
     */
    max_runs?: number;
    /**
     * Log provider specific options (optional, only used when type === 'log').
     * Declared here to ensure JSON Schema allows these keys and Ajv does not warn.
     */
    /** Message template for log checks */
    message?: string;
    /** Log level for log checks */
    level?: 'debug' | 'info' | 'warn' | 'error';
    /** Include PR context in log output */
    include_pr_context?: boolean;
    /** Include dependency summaries in log output */
    include_dependencies?: boolean;
    /** Include execution metadata in log output */
    include_metadata?: boolean;
    /**
     * Output parsing hint for command provider (optional)
     * When set to 'json', command stdout is expected to be JSON. When 'text', treat as plain text.
     * Note: command provider attempts JSON parsing heuristically; this flag mainly suppresses schema warnings
     * and may be used by providers to alter parsing behavior in the future.
     */
    output_format?: 'json' | 'text';
    /**
     * Memory provider specific options (optional, only used when type === 'memory').
     */
    /** Memory operation to perform */
    /** Memory operation to perform. Use `type: 'script'` for custom JavaScript. */
    operation?: 'get' | 'set' | 'append' | 'increment' | 'delete' | 'clear' | 'list';
    /** Key for memory operation */
    key?: string;
    /** Value for set/append operations */
    value?: unknown;
    /** JavaScript expression to compute value dynamically */
    value_js?: string;
    /** Override namespace for this check */
    namespace?: string;
    /**
     * GitHub provider specific options (optional, only used when type === 'github').
     */
    /** GitHub operation to perform (e.g., 'labels.add', 'labels.remove', 'comment.create') */
    op?: string;
    /** Values for GitHub operations (can be array or single value) */
    values?: string[] | string;
    /**
     * MCP provider specific options (optional, only used when type === 'mcp').
     */
    /** Transport type for MCP: stdio (default), sse (legacy), or http (streamable HTTP) */
    transport?: 'stdio' | 'sse' | 'http';
    /** Arguments to pass to the MCP method (supports Liquid templates) */
    methodArgs?: Record<string, unknown>;
    /** Transform template for method arguments (Liquid) */
    argsTransform?: string;
    /** Session ID for HTTP transport (optional, server may generate one) */
    sessionId?: string;
    /** Command arguments (for stdio transport in MCP checks) */
    args?: string[];
    /** Working directory (for stdio transport in MCP checks) */
    workingDirectory?: string;
    /**
     * Human input provider specific options (optional, only used when type === 'human-input').
     */
    /** Placeholder text to show in input field */
    placeholder?: string;
    /** Allow empty input (default: false) */
    allow_empty?: boolean;
    /** Support multiline input (default: false) */
    multiline?: boolean;
    /** Default value if timeout occurs or empty input when allow_empty is true */
    default?: string;
}
/**
 * Backoff policy for retries
 */
interface BackoffPolicy {
    /** Backoff mode */
    mode?: 'fixed' | 'exponential';
    /** Initial delay in milliseconds */
    delay_ms?: number;
}
/**
 * Retry policy for a step
 */
interface RetryPolicy {
    /** Maximum retry attempts (excluding the first attempt) */
    max?: number;
    /** Backoff policy */
    backoff?: BackoffPolicy;
}
/**
 * Failure routing configuration per check
 */
interface OnFailConfig {
    /** Retry policy */
    retry?: RetryPolicy;
    /** Remediation steps to run before reattempt */
    run?: string[];
    /** Jump back to an ancestor step (by id) */
    goto?: string;
    /** Simulate a different event when performing goto (e.g., 'pr_updated') */
    goto_event?: EventTrigger;
    /** Dynamic goto: JS expression returning step id or null */
    goto_js?: string;
    /** Dynamic remediation list: JS expression returning string[] */
    run_js?: string;
}
/**
 * Success routing configuration per check
 */
interface OnSuccessConfig {
    /** Post-success steps to run */
    run?: string[];
    /** Optional jump back to ancestor step (by id) */
    goto?: string;
    /** Simulate a different event when performing goto (e.g., 'pr_updated') */
    goto_event?: EventTrigger;
    /** Dynamic goto: JS expression returning step id or null */
    goto_js?: string;
    /** Dynamic post-success steps: JS expression returning string[] */
    run_js?: string;
}
/**
 * Finish routing configuration for forEach checks
 * Runs once after ALL iterations of forEach and ALL dependent checks complete
 */
interface OnFinishConfig {
    /** Post-finish steps to run */
    run?: string[];
    /** Optional jump back to ancestor step (by id) */
    goto?: string;
    /** Simulate a different event when performing goto (e.g., 'pr_updated') */
    goto_event?: EventTrigger;
    /** Dynamic goto: JS expression returning step id or null */
    goto_js?: string;
    /** Dynamic post-finish steps: JS expression returning string[] */
    run_js?: string;
}
/**
 * Global routing defaults
 */
interface RoutingDefaults {
    /** Per-scope cap on routing transitions (success + failure) */
    max_loops?: number;
    /** Default policies applied to checks (step-level overrides take precedence) */
    defaults?: {
        on_fail?: OnFailConfig;
    };
}
/**
 * Global engine limits
 */
interface LimitsConfig {
    /**
     * Maximum number of executions per check within a single engine run.
     * Applies to each distinct scope independently for forEach item executions.
     * Set to 0 or negative to disable. Default: 50.
     */
    max_runs_per_check?: number;
}
/**
 * Custom template configuration
 */
interface CustomTemplateConfig {
    /** Path to custom template file (relative to config file or absolute) */
    file?: string;
    /** Raw template content as string */
    content?: string;
}
/**
 * Debug mode configuration
 */
interface DebugConfig {
    /** Enable debug mode */
    enabled: boolean;
    /** Include AI prompts in debug output */
    includePrompts: boolean;
    /** Include raw AI responses in debug output */
    includeRawResponses: boolean;
    /** Include timing information */
    includeTiming: boolean;
    /** Include provider information */
    includeProviderInfo: boolean;
}
/**
 * PR comment output configuration
 */
interface PrCommentOutput {
    /** Format of the output */
    format: ConfigOutputFormat;
    /** How to group the results */
    group_by: GroupByOption;
    /** Whether to collapse sections by default */
    collapse: boolean;
    /** Debug mode configuration (optional) */
    debug?: DebugConfig;
}
/**
 * File comment output configuration
 */
interface FileCommentOutput {
    /** Whether file comments are enabled */
    enabled: boolean;
    /** Whether to show inline comments */
    inline: boolean;
}
/**
 * GitHub Check Runs output configuration
 */
interface GitHubCheckOutput {
    /** Whether GitHub check runs are enabled */
    enabled: boolean;
    /** Whether to create individual check runs per configured check */
    per_check: boolean;
    /** Custom name prefix for check runs */
    name_prefix?: string;
}
/**
 * Output configuration
 */
interface OutputConfig {
    /** PR comment configuration */
    pr_comment: PrCommentOutput;
    /** File comment configuration (optional) */
    file_comment?: FileCommentOutput;
    /** GitHub check runs configuration (optional) */
    github_checks?: GitHubCheckOutput;
    /** Whether to enable issue suppression via visor-disable comments (default: true) */
    suppressionEnabled?: boolean;
}
/**
 * HTTP server authentication configuration
 */
interface HttpAuthConfig {
    /** Authentication type */
    type: 'bearer_token' | 'hmac' | 'basic' | 'none';
    /** Secret or token for authentication */
    secret?: string;
    /** Username for basic auth */
    username?: string;
    /** Password for basic auth */
    password?: string;
}
/**
 * HTTP server endpoint configuration
 */
interface HttpEndpointConfig {
    /** Path for the webhook endpoint */
    path: string;
    /** Optional transform template (Liquid) for the received data */
    transform?: string;
    /** Optional name/ID for this endpoint */
    name?: string;
}
/**
 * TLS/SSL configuration for HTTPS server
 */
interface TlsConfig {
    /** Enable TLS/HTTPS */
    enabled: boolean;
    /** Path to TLS certificate file or certificate content */
    cert?: string;
    /** Path to TLS key file or key content */
    key?: string;
    /** Path to CA certificate file or CA content (optional) */
    ca?: string;
    /** Reject unauthorized connections (default: true) */
    rejectUnauthorized?: boolean;
}
/**
 * HTTP server configuration for receiving webhooks
 */
interface HttpServerConfig {
    /** Whether HTTP server is enabled */
    enabled: boolean;
    /** Port to listen on */
    port: number;
    /** Host/IP to bind to (defaults to 0.0.0.0) */
    host?: string;
    /** TLS/SSL configuration for HTTPS */
    tls?: TlsConfig;
    /** Authentication configuration */
    auth?: HttpAuthConfig;
    /** HTTP endpoints configuration */
    endpoints?: HttpEndpointConfig[];
}
/**
 * Memory storage configuration
 */
interface MemoryConfig {
    /** Storage mode: "memory" (in-memory, default) or "file" (persistent) */
    storage?: 'memory' | 'file';
    /** Storage format (only for file storage, default: json) */
    format?: 'json' | 'csv';
    /** File path (required if storage: file) */
    file?: string;
    /** Default namespace (default: "default") */
    namespace?: string;
    /** Auto-load on startup (default: true if storage: file) */
    auto_load?: boolean;
    /** Auto-save after operations (default: true if storage: file) */
    auto_save?: boolean;
}
/**
 * Human input request passed to hooks
 */
interface HumanInputRequest {
    /** Check ID requesting input */
    checkId: string;
    /** Prompt to display to user */
    prompt: string;
    /** Placeholder text (optional) */
    placeholder?: string;
    /** Whether empty input is allowed */
    allowEmpty: boolean;
    /** Whether multiline input is supported */
    multiline: boolean;
    /** Timeout in milliseconds (optional) */
    timeout?: number;
    /** Default value if timeout or empty (optional) */
    default?: string;
}
/**
 * Hooks for runtime integration (SDK mode)
 */
interface VisorHooks {
    /** Called when human input is required */
    onHumanInput?: (request: HumanInputRequest) => Promise<string>;
}
/**
 * Custom tool definition for use in MCP blocks
 */
interface CustomToolDefinition {
    /** Tool name - used to reference the tool in MCP blocks */
    name: string;
    /** Description of what the tool does */
    description?: string;
    /** Input schema for the tool (JSON Schema format) */
    inputSchema?: {
        type: 'object';
        properties?: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
    };
    /** Command to execute - supports Liquid template */
    exec: string;
    /** Optional stdin input - supports Liquid template */
    stdin?: string;
    /** Transform the raw output - supports Liquid template */
    transform?: string;
    /** Transform the output using JavaScript - alternative to transform */
    transform_js?: string;
    /** Working directory for command execution */
    cwd?: string;
    /** Environment variables for the command */
    env?: Record<string, string>;
    /** Timeout in milliseconds */
    timeout?: number;
    /** Whether to parse output as JSON automatically */
    parseJson?: boolean;
    /** Expected output schema for validation */
    outputSchema?: Record<string, unknown>;
}
/**
 * Main Visor configuration
 */
interface VisorConfig {
    /** Configuration version */
    version: string;
    /** Extends from other configurations - can be file path, HTTP(S) URL, or "default" */
    extends?: string | string[];
    /** Custom tool definitions that can be used in MCP blocks */
    tools?: Record<string, CustomToolDefinition>;
    /** Step configurations (recommended) */
    steps?: Record<string, CheckConfig>;
    /** Check configurations (legacy, use 'steps' instead) - always populated after normalization */
    checks?: Record<string, CheckConfig>;
    /** Output configuration */
    output: OutputConfig;
    /** HTTP server configuration for receiving webhooks */
    http_server?: HttpServerConfig;
    /** Memory storage configuration */
    memory?: MemoryConfig;
    /** Runtime hooks for SDK integration */
    hooks?: VisorHooks;
    /** Global environment variables */
    env?: EnvConfig;
    /** Global AI model setting */
    ai_model?: string;
    /** Global AI provider setting */
    ai_provider?: 'google' | 'anthropic' | 'openai' | 'bedrock' | 'mock' | 'claude-code' | string;
    /** Global MCP servers configuration for AI checks */
    ai_mcp_servers?: Record<string, McpServerConfig>;
    /** Maximum number of checks to run in parallel (default: 3) */
    max_parallelism?: number;
    /** Stop execution when any check fails (default: false) */
    fail_fast?: boolean;
    /** Simple global fail condition - fails if expression evaluates to true */
    fail_if?: string;
    /** Global failure conditions - optional (deprecated, use fail_if) */
    failure_conditions?: FailureConditions;
    /** Tag filter for selective check execution */
    tag_filter?: TagFilter;
    /** Optional routing defaults for retry/goto/run policies */
    routing?: RoutingDefaults;
    /** Global execution limits */
    limits?: LimitsConfig;
}

/**
 * Execution context passed to check providers
 */
interface ExecutionContext {
    /** Session information for AI session reuse */
    parentSessionId?: string;
    reuseSession?: boolean;
    /** CLI message value (from --message argument) */
    cliMessage?: string;
    /**
     * Stage-local baseline of output history lengths per check name.
     * When present, providers should expose an `outputs_history_stage` object in
     * Liquid/JS contexts that slices the global history from this baseline.
     * This enables stage-scoped assertions in the YAML test runner without
     * relying on global execution history.
     */
    stageHistoryBase?: Record<string, number>;
    /** SDK hooks for human input */
    hooks?: {
        onHumanInput?: (request: HumanInputRequest) => Promise<string>;
        onPromptCaptured?: (info: {
            step: string;
            provider: string;
            prompt: string;
        }) => void;
        mockForStep?: (step: string) => unknown | undefined;
    };
    /**
     * Optional execution mode hints. The core engine does not read environment
     * variables directly; callers (CLI, test runner) can set these flags to
     * request certain behaviors without polluting core logic with test-specific
     * branches.
     */
    mode?: {
        /** true when running under the YAML test runner */
        test?: boolean;
        /** post review comments from grouped execution paths (used by tests) */
        postGroupedComments?: boolean;
        /** reset per-run guard state before grouped execution */
        resetPerRunState?: boolean;
    };
}

/**
 * Statistics for a single check execution
 */
interface CheckExecutionStats {
    checkName: string;
    totalRuns: number;
    successfulRuns: number;
    failedRuns: number;
    skipped: boolean;
    skipReason?: 'if_condition' | 'fail_fast' | 'dependency_failed';
    skipCondition?: string;
    totalDuration: number;
    providerDurationMs?: number;
    perIterationDuration?: number[];
    issuesFound: number;
    issuesBySeverity: {
        critical: number;
        error: number;
        warning: number;
        info: number;
    };
    outputsProduced?: number;
    errorMessage?: string;
    forEachPreview?: string[];
}
/**
 * Overall execution statistics for all checks
 */
interface ExecutionStatistics {
    totalChecksConfigured: number;
    totalExecutions: number;
    successfulExecutions: number;
    failedExecutions: number;
    skippedChecks: number;
    totalDuration: number;
    checks: CheckExecutionStats[];
}

interface GitFileChange {
    filename: string;
    status: 'added' | 'removed' | 'modified' | 'renamed';
    additions: number;
    deletions: number;
    changes: number;
    content?: string;
    patch?: string;
    truncated?: boolean;
}
interface GitRepositoryInfo {
    title: string;
    body: string;
    author: string;
    base: string;
    head: string;
    files: GitFileChange[];
    totalAdditions: number;
    totalDeletions: number;
    isGitRepository: boolean;
    workingDirectory: string;
}

interface AnalysisResult {
    repositoryInfo: GitRepositoryInfo;
    reviewSummary: ReviewSummary;
    executionTime: number;
    timestamp: string;
    checksExecuted: string[];
    executionStatistics?: ExecutionStatistics;
    debug?: DebugInfo;
    failureConditions?: FailureConditionResult[];
    isCodeReview?: boolean;
}
interface DebugInfo {
    provider?: string;
    model?: string;
    processingTime?: number;
    parallelExecution?: boolean;
    checksExecuted?: string[];
    totalApiCalls?: number;
    apiCallDetails?: Array<{
        checkName: string;
        provider: string;
        model: string;
        processingTime: number;
        success: boolean;
    }>;
}

interface VisorOptions {
    cwd?: string;
    debug?: boolean;
    maxParallelism?: number;
    failFast?: boolean;
    tagFilter?: TagFilter;
}
interface RunOptions extends VisorOptions {
    config?: VisorConfig;
    configPath?: string;
    checks?: string[];
    timeoutMs?: number;
    output?: {
        format?: 'table' | 'json' | 'markdown' | 'sarif';
    };
    /** Strict mode: treat config warnings (like unknown keys) as errors (default: false) */
    strictValidation?: boolean;
    /** Execution context for providers (CLI message, hooks, etc.) */
    executionContext?: ExecutionContext;
}
/**
 * Load and validate a Visor config.
 * @param configOrPath - Config object, file path, or omit to discover defaults
 * @param options - Validation options
 * @returns Validated config with defaults applied
 */
declare function loadConfig(configOrPath?: string | Partial<VisorConfig>, options?: {
    strict?: boolean;
}): Promise<VisorConfig>;
/** Expand check IDs by including their dependencies (shallow->deep). */
declare function resolveChecks(checkIds: string[], config: VisorConfig | undefined): string[];
/**
 * Run Visor checks programmatically. Returns the same AnalysisResult shape used by the CLI.
 * Thin wrapper around CheckExecutionEngine.executeChecks.
 */
declare function runChecks(opts?: RunOptions): Promise<AnalysisResult>;

export { type ExecutionContext, type HumanInputRequest, type RunOptions, type TagFilter, type VisorConfig, type VisorOptions, loadConfig, resolveChecks, runChecks };
