/**
 * Types for Visor configuration system
 */

// Import types from reviewer
import type { ReviewIssue } from '../reviewer';
import type { PolicyConfig, StepPolicyOverride } from '../policy/types';

// Export Issue type for backward compatibility
export type Issue = ReviewIssue;

/**
 * Failure condition severity levels
 */
export type FailureConditionSeverity = 'error' | 'warning' | 'info';

/**
 * Simple failure condition - just an expression string
 */
export type SimpleFailureCondition = string;

/**
 * Complex failure condition with additional metadata
 */
export interface ComplexFailureCondition {
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
export type FailureCondition = SimpleFailureCondition | ComplexFailureCondition;

/**
 * Collection of failure conditions
 */
export interface FailureConditions {
  [conditionName: string]: FailureCondition;
}

/**
 * Context object available to expressions for failure condition evaluation
 */
export interface FailureConditionContext {
  /** Check results - raw output from the check/schema */
  output: {
    /** Check results */
    issues?: Array<{
      file: string;
      line: number;
      endLine?: number;
      ruleId: string;
      message: string;
      severity: 'info' | 'warning' | 'error' | 'critical';
      category: 'security' | 'performance' | 'style' | 'logic' | 'documentation';
      group?: string;
      schema?: string;
      suggestion?: string;
      replacement?: string;
    }>;

    /** Any additional fields provided by the check/schema */
    [key: string]: unknown;
  };

  /** Previous check outputs for dependencies - keyed by check name */
  outputs?: Record<string, unknown>;

  /** Check context information */
  checkName?: string;
  schema?: string;
  group?: string;

  /** Git context for if conditions */
  branch?: string;
  baseBranch?: string;
  filesChanged?: string[];
  filesCount?: number;
  hasChanges?: boolean;

  /** PR author information */
  authorAssociation?: string;

  /** GitHub event context */
  event?: {
    /** GitHub event name (e.g., 'pull_request', 'issues', 'push') */
    event_name: string;
    /** Action that triggered the event (e.g., 'opened', 'closed', 'synchronize') */
    action?: string;
    /** Repository information */
    repository?: {
      owner: { login: string };
      name: string;
    };
    /** Pull request data (for PR events) */
    pull_request?: {
      number: number;
      state: string;
      head: { sha: string; ref: string };
      base: { sha: string; ref: string };
    };
    /** Issue data (for issue events) */
    issue?: {
      number: number;
      pull_request?: { url: string };
    };
    /** Comment data (for comment events) */
    comment?: {
      body: string;
      user: { login: string };
    };
    /** Additional webhook payload data */
    [key: string]: unknown;
  };

  /** Environment variables */
  env?: Record<string, string>;

  /** Workflow inputs - values passed to the workflow */
  inputs?: Record<string, unknown>;

  /** Memory accessor for accessing memory store in expressions */
  memory?: {
    get: (key: string, namespace?: string) => unknown;
    has: (key: string, namespace?: string) => boolean;
    list: (namespace?: string) => string[];
    getAll: (namespace?: string) => Record<string, unknown>;
  };

  /** Utility metadata for backward compatibility */
  metadata?: {
    checkName: string;
    schema: string;
    group: string;
    criticalIssues: number;
    errorIssues: number;
    warningIssues: number;
    infoIssues: number;
    totalIssues: number;
    hasChanges: boolean;
    branch: string;
    event: string;
  };

  /** Debug information (if available) */
  debug?: {
    /** Any errors that occurred during processing */
    errors: string[];
    /** Processing time in milliseconds */
    processingTime: number;
    /** AI provider used */
    provider: string;
    /** AI model used */
    model: string;
  };

  /** Conversation context for TUI/CLI/Slack messages */
  conversation?: {
    /** Transport type (tui, cli, slack) */
    transport?: string;
    /** Thread information */
    thread?: { id: string };
    /** Message history */
    messages?: Array<{ role: string; text: string; timestamp: string }>;
    /** Current message being processed */
    current?: { role: string; text: string; timestamp: string };
    /** Additional attributes */
    attributes?: Record<string, unknown>;
  } | null;
}

/**
 * Result of failure condition evaluation
 */
export interface FailureConditionResult {
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
export type ConfigCheckType =
  | 'ai'
  | 'command'
  | 'script'
  | 'http'
  | 'http_input'
  | 'http_client'
  | 'noop'
  | 'log'
  | 'memory'
  | 'github'
  | 'claude-code'
  | 'mcp'
  | 'human-input'
  | 'workflow'
  | 'git-checkout';

/**
 * Valid event triggers for checks
 */
export type EventTrigger =
  | 'pr_opened'
  | 'pr_updated'
  | 'pr_closed'
  | 'issue_opened'
  | 'issue_comment'
  | 'manual'
  | 'schedule'
  | 'webhook_received';

/**
 * Valid output formats
 */
export type ConfigOutputFormat = 'table' | 'json' | 'markdown' | 'sarif';

/**
 * Tag filter configuration for selective check execution
 */
export interface TagFilter {
  /** Tags that checks must have to be included (ANY match) */
  include?: string[];
  /** Tags that will exclude checks if present (ANY match) */
  exclude?: string[];
}

/**
 * Valid grouping options
 */
export type GroupByOption = 'check' | 'file' | 'severity' | 'group';

/**
 * Environment variable reference configuration
 */
export interface EnvConfig {
  [key: string]: string | number | boolean;
}

/**
 * Retry configuration for AI provider calls
 */
export interface AIRetryConfig {
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
export interface AIFallbackProviderConfig {
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
export interface AIFallbackConfig {
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
export interface BashConfig {
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
export interface AIProviderConfig {
  /** AI provider to use */
  provider?: 'google' | 'anthropic' | 'openai' | 'bedrock' | 'mock';
  /** Model name to use */
  model?: string;
  /** API key (usually from environment variables) */
  apiKey?: string;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Maximum tool iterations for ProbeAgent */
  max_iterations?: number;
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
  /** Skip adding Slack conversation context to the prompt (when running under Slack) */
  skip_slack_context?: boolean;
  /**
   * Skip adding transport-specific context (e.g., GitHub PR/issue XML, Slack
   * conversation XML) to the prompt. When true, this behaves like setting both
   * skip_code_context and skip_slack_context to true, unless those are
   * explicitly overridden.
   */
  skip_transport_context?: boolean;
  /** MCP servers configuration */
  mcpServers?: Record<string, McpServerConfig>;
  /** Enable the delegate tool for task distribution to subagents */
  enableDelegate?: boolean;
  /** Enable task management for tracking multi-goal requests */
  enableTasks?: boolean;
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
  /** Completion prompt for post-completion validation/review (runs after attempt_completion) */
  completion_prompt?: string;
  /** Enable the schedule tool for scheduling workflow executions (requires scheduler configuration) */
  enable_scheduler?: boolean;
}

/**
 * Unified MCP server/tool entry - type detected by which properties are present
 *
 * Detection logic (priority order):
 * 1. Has `command` → stdio MCP server (external process)
 * 2. Has `url` → SSE/HTTP MCP server (external endpoint)
 * 3. Has `workflow` → workflow tool reference
 * 4. Empty `{}` or just key → auto-detect from `tools:` section
 */
export interface McpServerConfig {
  // === External stdio MCP server ===
  /** Command to execute (presence indicates stdio server) */
  command?: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Environment variables for the MCP server */
  env?: Record<string, string>;

  // === External SSE/HTTP MCP server ===
  /** URL endpoint (presence indicates external server) */
  url?: string;
  /** Transport type */
  transport?: 'stdio' | 'sse' | 'http';

  // === Workflow tool reference ===
  /** Workflow ID or path (presence indicates workflow tool) */
  workflow?: string;
  /** Inputs to pass to workflow */
  inputs?: Record<string, unknown>;
  /** Tool description for AI */
  description?: string;

  // === Access control ===
  /** Whitelist specific methods from this MCP server (supports wildcards like "search_*") */
  allowedMethods?: string[];
  /** Block specific methods from this MCP server (supports wildcards like "*_delete") */
  blockedMethods?: string[];
}

/**
 * Claude Code configuration
 */
export interface ClaudeCodeConfig {
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
export interface CheckConfig {
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
  /** Maximum tool iterations for ProbeAgent (underscore style) */
  ai_max_iterations?: number;
  /** System prompt for this check (underscore style) */
  ai_system_prompt?: string;
  /** Legacy customPrompt (underscore style) — deprecated, use ai_system_prompt */
  ai_custom_prompt?: string;
  /** MCP servers for this AI check - overrides global setting */
  ai_mcp_servers?: Record<string, McpServerConfig>;
  /**
   * JavaScript expression to dynamically compute MCP servers for this AI check.
   * Expression has access to: outputs, inputs, pr, files, env, memory
   * Must return an object mapping server names to McpServerConfig objects.
   *
   * Example:
   * ```
   * const servers = {};
   * const tags = outputs['route-intent']?.tags || [];
   * if (tags.includes('jira')) {
   *   servers.jira = {
   *     command: "npx",
   *     args: ["-y", "@aashari/mcp-server-atlassian-jira"],
   *     env: { ATLASSIAN_SITE_NAME: "mysite" }
   *   };
   * }
   * return servers;
   * ```
   */
  ai_mcp_servers_js?: string;
  /** List of custom tool names to expose to this AI check via ephemeral SSE MCP server */
  ai_custom_tools?: string[];
  /**
   * JavaScript expression to dynamically compute custom tools for this AI check.
   * Expression has access to: outputs, inputs, pr, files, env, memory
   * Must return an array of tool names (strings) or WorkflowToolReference objects
   * ({ workflow: string, args?: Record<string, unknown> })
   *
   * Example:
   * ```
   * const tools = [];
   * if (outputs['route-intent'].intent === 'engineer') {
   *   tools.push({ workflow: 'engineer', args: { projects: ['tyk'] } });
   * }
   * return tools;
   * ```
   */
  ai_custom_tools_js?: string;
  /** Claude Code configuration (for claude-code type checks) */
  claude_code?: ClaudeCodeConfig;
  /** Environment variables for this check */
  env?: EnvConfig;
  /** Timeout in milliseconds for command execution (default: 60000, i.e., 60 seconds) */
  timeout?: number;
  /** Check IDs that this check depends on (optional). Accepts single string or array. */
  depends_on?: string | string[];
  /** Group name for comment separation (e.g., "code-review", "pr-overview") - optional */
  group?: string;
  /** Schema type for template rendering (e.g., "code-review", "markdown") or inline JSON schema object - optional */
  schema?: string | Record<string, unknown>;
  /**
   * Optional JSON Schema to validate the produced output. If omitted and
   * `schema` is an object, the engine will treat that object as the
   * output_schema for validation purposes while still using string schemas
   * (e.g., 'code-review') for template selection.
   */
  output_schema?: Record<string, unknown>;
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
   * Operational criticality of this step. Drives default safety policies
   * (contracts, retries, loop budgets) at load time. Behavior can still be
   * overridden explicitly per step via on_*, fail_if, assume/guarantee, etc.
   *
   * - 'external': interacts with external systems (side effects). Highest safety.
   * - 'internal': modifies CI/config/state but not prod. High safety.
   * - 'policy': organizational checks (linting, style, doc). Moderate safety.
   * - 'info': informational checks. Lowest safety.
   */
  criticality?: 'external' | 'internal' | 'policy' | 'info';
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
  /** Init routing configuration for this check (runs before execution/preprocessing) */
  on_init?: OnInitConfig;
  /** Failure routing configuration for this check (retry/goto/run) */
  on_fail?: OnFailConfig;
  /** Success routing configuration for this check (post-actions and optional goto) */
  on_success?: OnSuccessConfig;
  /** Finish routing configuration for forEach checks (runs after ALL iterations complete) */
  on_finish?: OnFinishConfig;
  /**
   * Preconditions that must hold before executing the check. If any expression
   * evaluates to false, the check is skipped (skipReason='assume').
   */
  assume?: string | string[];
  /**
   * Postconditions that should hold after executing the check. Expressions are
   * evaluated against the produced result/output; violations are recorded as
   * error issues with ruleId "contract/guarantee_failed".
   */
  guarantee?: string | string[];
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
  // Custom JavaScript lives under the script provider using `content`
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
  command_args?: string[];
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
  /**
   * Workflow provider specific options (optional, only used when type === 'workflow').
   */
  /** Workflow ID or path to workflow file */
  workflow?: string;
  /** Arguments/inputs for the workflow */
  args?: Record<string, unknown>;
  /** Override specific step configurations in the workflow */
  overrides?: Record<string, Partial<CheckConfig>>;
  /** Map workflow outputs to check outputs */
  output_mapping?: Record<string, string>;

  // Workflow aliases for backward compatibility
  /** Alias for args - workflow inputs (backward compatibility) */
  workflow_inputs?: Record<string, unknown>;
  /** Config file path - alternative to workflow ID (loads a Visor config file as workflow) */
  config?: string;
  /** Alias for overrides - workflow step overrides (backward compatibility) */
  workflow_overrides?: Record<string, Partial<CheckConfig>>;

  /**
   * Git-checkout provider specific options (optional, only used when type === 'git-checkout').
   */
  /** Git reference to checkout (branch, tag, commit SHA) - supports templates */
  ref?: string;
  /** Repository URL or owner/repo format (defaults to current repository) */
  repository?: string;
  /** GitHub token for private repositories (defaults to GITHUB_TOKEN env) */
  token?: string;
  /** Number of commits to fetch (0 for full history, default: 1) */
  fetch_depth?: number;
  /** Whether to fetch tags (default: false) */
  fetch_tags?: boolean;
  /** Checkout submodules: false, true, or 'recursive' */
  submodules?: boolean | 'recursive';
  /** Working directory for the checkout (defaults to temp directory) */
  working_directory?: string;
  /** Use git worktree for efficient parallel checkouts (default: true) */
  use_worktree?: boolean;
  /** Clean the working directory before checkout (default: true) */
  clean?: boolean;
  /** Sparse checkout paths - only checkout specific directories/files */
  sparse_checkout?: string[];
  /** Enable Git LFS (Large File Storage) */
  lfs?: boolean;
  /** Timeout in ms for cloning the bare repository (default: 300000 = 5 min) */
  clone_timeout_ms?: number;
  /** Clean up worktree on failure (default: true) */
  cleanup_on_failure?: boolean;
  /** Keep worktree after workflow completion (default: false) */
  persist_worktree?: boolean;
  /** Sandbox name to use for this check (overrides workspace-level default) */
  sandbox?: string;
  /** Per-step policy override (enterprise) */
  policy?: StepPolicyOverride;
}

/**
 * Backoff policy for retries
 */
export interface BackoffPolicy {
  /** Backoff mode */
  mode?: 'fixed' | 'exponential';
  /** Initial delay in milliseconds */
  delay_ms?: number;
}

/**
 * Retry policy for a step
 */
export interface RetryPolicy {
  /** Maximum retry attempts (excluding the first attempt) */
  max?: number;
  /** Backoff policy */
  backoff?: BackoffPolicy;
}

/**
 * Failure routing configuration per check
 */
export interface OnFailConfig {
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
  /**
   * Declarative transitions. Evaluated in order; first matching rule wins.
   * If a rule's `to` is null, no goto occurs. When omitted or none match,
   * the engine falls back to goto_js/goto for backward compatibility.
   */
  transitions?: TransitionRule[];
}

/**
 * Success routing configuration per check
 */
export interface OnSuccessConfig {
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
  /** Declarative transitions (see OnFailConfig.transitions). */
  transitions?: TransitionRule[];
}

/**
 * Finish routing configuration for forEach checks
 * Runs once after ALL iterations of forEach and ALL dependent checks complete
 */
export interface OnFinishConfig {
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
  /** Declarative transitions (see OnFailConfig.transitions). */
  transitions?: TransitionRule[];
}

/**
 * Init routing configuration per check
 * Runs BEFORE the check executes (preprocessing/setup)
 */
export interface OnInitConfig {
  /** Items to run before this check executes */
  run?: OnInitRunItem[];
  /** Dynamic init items: JS expression returning OnInitRunItem[] */
  run_js?: string;
  /** Declarative transitions (optional, for advanced use cases) */
  transitions?: TransitionRule[];
}

/**
 * Unified on_init run item - can be tool, step, workflow, or plain string
 */
export type OnInitRunItem =
  | OnInitToolInvocation
  | OnInitStepInvocation
  | OnInitWorkflowInvocation
  | string; // Backward compatible: plain step name

/**
 * Invoke a custom tool (from tools: section)
 */
export interface OnInitToolInvocation {
  /** Tool name (must exist in tools: section) */
  tool: string;
  /** Arguments to pass to the tool (Liquid templates supported) */
  with?: Record<string, unknown>;
  /** Custom output name (defaults to tool name) */
  as?: string;
}

/**
 * Invoke a helper step (regular check)
 */
export interface OnInitStepInvocation {
  /** Step name (must exist in steps: section) */
  step: string;
  /** Arguments to pass to the step (Liquid templates supported) */
  with?: Record<string, unknown>;
  /** Custom output name (defaults to step name) */
  as?: string;
}

/**
 * Invoke a reusable workflow
 */
export interface OnInitWorkflowInvocation {
  /** Workflow ID or path */
  workflow: string;
  /** Workflow inputs (Liquid templates supported) */
  with?: Record<string, unknown>;
  /** Custom output name (defaults to workflow name) */
  as?: string;
  /** Step overrides */
  overrides?: Record<string, Partial<CheckConfig>>;
  /** Output mapping */
  output_mapping?: Record<string, string>;
}

/**
 * Declarative transition rule for on_* blocks.
 */
export interface TransitionRule {
  /** JavaScript expression evaluated in the same sandbox as goto_js; truthy enables the rule. */
  when: string;
  /** Target step ID, or null to explicitly prevent goto. */
  to?: string | null;
  /** Optional event override when performing goto. */
  goto_event?: EventTrigger;
}

/**
 * Global routing defaults
 */
export interface RoutingDefaults {
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
export interface LimitsConfig {
  /**
   * Maximum number of executions per check within a single engine run.
   * Applies to each distinct scope independently for forEach item executions.
   * Set to 0 or negative to disable. Default: 50.
   */
  max_runs_per_check?: number;
  /**
   * Maximum nesting depth for workflows executed by the state machine engine.
   * Nested workflows are invoked by the workflow provider; this limit prevents
   * accidental infinite recursion. Default: 3.
   */
  max_workflow_depth?: number;
}

/**
 * Custom template configuration
 */
export interface CustomTemplateConfig {
  /** Path to custom template file (relative to config file or absolute) */
  file?: string;
  /** Raw template content as string */
  content?: string;
}

/**
 * Prompt configuration - supports both string and file reference
 */
export interface PromptConfig {
  /** Raw prompt content as string (supports Liquid templates) */
  content?: string;
  /** Path to prompt file (relative to config file or absolute) */
  file?: string;
}

/**
 * Debug mode configuration
 */
export interface DebugConfig {
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
export interface PrCommentOutput {
  /** Whether PR comments are enabled */
  enabled?: boolean;
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
export interface FileCommentOutput {
  /** Whether file comments are enabled */
  enabled: boolean;
  /** Whether to show inline comments */
  inline: boolean;
}

/**
 * GitHub Check Runs output configuration
 */
export interface GitHubCheckOutput {
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
export interface OutputConfig {
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
export interface HttpAuthConfig {
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
export interface HttpEndpointConfig {
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
export interface TlsConfig {
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
export interface HttpServerConfig {
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
export interface MemoryConfig {
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
export interface HumanInputRequest {
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
export interface VisorHooks {
  /** Called when human input is required */
  onHumanInput?: (request: HumanInputRequest) => Promise<string>;
}

/**
 * Custom tool definition for use in MCP blocks
 */
export interface CustomToolDefinition {
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
 * Workflow input definition for standalone reusable workflows
 */
export interface WorkflowInput {
  /** Input parameter name */
  name: string;
  /** JSON Schema for the input */
  schema?: Record<string, unknown>;
  /** Whether this input is required */
  required?: boolean;
  /** Default value if not provided */
  default?: unknown;
  /** Human-readable description */
  description?: string;
}

/**
 * Workflow output definition for standalone reusable workflows
 */
export interface WorkflowOutput {
  /** Output name */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Value using Liquid template syntax (references step outputs) */
  value?: string;
  /** Value using JavaScript expression (alternative to value) */
  value_js?: string;
}

export interface SandboxDefaults {
  /** Base env var patterns for all sandboxes (replaces hardcoded defaults when set) */
  env_passthrough?: string[];
}

/**
 * Static cron job defined in YAML configuration
 * These are always executed by the scheduler daemon
 */
export interface StaticCronJob {
  /** Cron expression (e.g., "0 9 * * 1" for every Monday at 9am) */
  schedule: string;
  /** Workflow/check ID to run */
  workflow: string;
  /** Optional workflow inputs */
  inputs?: Record<string, unknown>;
  /** Output destination configuration */
  output?: {
    /** Output type: slack, github, webhook, or none */
    type: 'slack' | 'github' | 'webhook' | 'none';
    /** Target (channel name, repo, URL) */
    target?: string;
    /** Thread ID for threaded outputs */
    thread_id?: string;
  };
  /** Description for logging/display */
  description?: string;
  /** Enable/disable this job (default: true) */
  enabled?: boolean;
  /** Timezone for schedule (default: UTC or scheduler default) */
  timezone?: string;
}

/**
 * Scheduler limits configuration
 */
export interface SchedulerLimitsConfig {
  /** Maximum schedules per user (default: 25) */
  max_per_user?: number;
  /** Maximum recurring schedules per user (default: 10) */
  max_recurring_per_user?: number;
  /** Maximum total schedules (default: 1000) */
  max_global?: number;
}

/**
 * Scheduler permissions for dynamic schedule creation
 */
export interface SchedulerPermissionsConfig {
  /** Allow personal schedules (via DM or CLI) */
  allow_personal?: boolean;
  /** Allow channel schedules (in Slack channels) */
  allow_channel?: boolean;
  /** Allow DM schedules (to specific users) */
  allow_dm?: boolean;
  /** List of allowed workflow patterns (glob-style, e.g., "report-*") */
  allowed_workflows?: string[];
  /** List of denied workflow patterns */
  denied_workflows?: string[];
}

/**
 * Scheduler configuration for workflow scheduling
 */
export interface SchedulerConfig {
  /** Enable/disable the scheduler (default: true) */
  enabled?: boolean;
  /** Storage configuration */
  storage?: {
    /** Path to schedules JSON file (default: .visor/schedules.json) */
    path?: string;
  };
  /** Limits for dynamic schedules */
  limits?: SchedulerLimitsConfig;
  /** Default timezone (IANA format, e.g., "America/New_York") */
  default_timezone?: string;
  /** Check interval in milliseconds (default: 60000) */
  check_interval_ms?: number;
  /** Permissions for dynamic schedule creation (via AI tool) */
  permissions?: SchedulerPermissionsConfig;
  /** Static cron jobs defined in configuration (always executed) */
  cron?: Record<string, StaticCronJob>;
}

/**
 * Main Visor configuration
 */
export interface VisorConfig {
  /** Configuration version */
  version: string;
  /** Extends from other configurations - can be file path, HTTP(S) URL, or "default" */
  extends?: string | string[];
  /** Alias for extends - include from other configurations (backward compatibility) */
  include?: string | string[];
  /** Custom tool definitions that can be used in MCP blocks */
  tools?: Record<string, CustomToolDefinition>;
  /** Import workflow definitions from external files or URLs */
  imports?: string[];
  /** Workflow inputs (for standalone reusable workflows) */
  inputs?: WorkflowInput[];
  /** Workflow outputs (for standalone reusable workflows) */
  outputs?: WorkflowOutput[];
  /** Step configurations (recommended) */
  steps?: Record<string, CheckConfig>;
  /** Check configurations (legacy, use 'steps' instead) - always populated after normalization */
  checks?: Record<string, CheckConfig>;
  /** Output configuration (optional - defaults provided) */
  output?: OutputConfig;
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
  /** Optional integrations: event-driven frontends (e.g., ndjson-sink, github) */
  frontends?: Array<{
    /** Frontend name, e.g., 'ndjson-sink', 'github' */
    name: string;
    /** Frontend-specific configuration */
    config?: unknown;
  }>;
  /** Workspace isolation configuration for sandboxed execution */
  workspace?: WorkspaceConfig;
  /** Workspace-level default sandbox name (all checks use this unless overridden) */
  sandbox?: string;
  /** Named sandbox environment definitions */
  sandboxes?: Record<string, import('../sandbox/types').SandboxConfig>;
  /** Workspace-level sandbox defaults (env allowlist, etc.) */
  sandbox_defaults?: SandboxDefaults;
  /** Slack configuration */
  slack?: SlackConfig;
  /** Scheduler configuration for scheduled workflow execution */
  scheduler?: SchedulerConfig;
  /** Enterprise policy engine configuration */
  policy?: PolicyConfig;
}

/**
 * Workspace isolation configuration
 */
export interface WorkspaceConfig {
  /** Enable workspace isolation (default: true when config present) */
  enabled?: boolean;
  /** Base path for workspaces (default: /tmp/visor-workspaces) */
  base_path?: string;
  /** Workspace directory name (defaults to session id) */
  name?: string;
  /** Main project folder name inside the workspace (defaults to original directory name) */
  main_project_name?: string;
  /** Clean up workspace on exit (default: true) */
  cleanup_on_exit?: boolean;
  /** Include main project worktree in AI allowed folders (default: false) */
  include_main_project?: boolean;
}

/**
 * Slack configuration
 */
export interface SlackConfig {
  /** Slack API version */
  version?: string;
  /** Mention handling: 'all', 'direct', etc. */
  mentions?: string;
  /** Thread handling: 'required', 'optional', etc. */
  threads?: string;
  /** Allow bot_message events to trigger runs (default: false) */
  allow_bot_messages?: boolean;
  /** Show raw output in Slack responses */
  show_raw_output?: boolean;
  /**
   * Append telemetry identifiers to Slack replies.
   */
  telemetry?: SlackTelemetryConfig;
}

export interface SlackTelemetryConfig {
  /** Enable telemetry ID suffix in Slack messages */
  enabled?: boolean;
}

/**
 * Environment variable overrides
 */
export interface EnvironmentOverrides {
  /** Config file path from environment */
  configPath?: string;
  /** Output format from environment */
  outputFormat?: string;
  /** Additional environment overrides */
  [key: string]: string | undefined;
}

/**
 * Merged configuration result
 */
export interface MergedConfig {
  /** Base configuration from file */
  config: Partial<VisorConfig>;
  /** CLI-specified checks */
  cliChecks: string[];
  /** CLI-specified output format */
  cliOutput: string;
  /** Environment variable overrides */
  environmentOverrides?: EnvironmentOverrides;
}

/**
 * Configuration validation error
 */
export interface ConfigValidationError {
  /** Field that failed validation */
  field: string;
  /** Error message */
  message: string;
  /** Invalid value (if applicable) */
  value?: unknown;
}

/**
 * Configuration loading options
 */
export interface ConfigLoadOptions {
  /** Whether to validate the configuration */
  validate?: boolean;
  /** Whether to merge with defaults */
  mergeDefaults?: boolean;
  /** Allowed URL patterns for remote config extends */
  allowedRemotePatterns?: string[];
  /** Custom validation rules */
  customValidation?: (config: Partial<VisorConfig>) => ConfigValidationError[];
}
