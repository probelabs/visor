import { ProbeAgent } from '@probelabs/probe';
import type { ProbeAgentOptions } from '@probelabs/probe';
import { PRInfo } from './pr-analyzer';
import { ReviewSummary, ReviewIssue } from './reviewer';
import { SessionRegistry } from './session-registry';
import { logger } from './logger';
import { trace as otTrace } from './telemetry/lazy-otel';
import { withActiveSpan } from './telemetry/trace-helpers';
import { initializeTracer } from './utils/tracer-init';
import { processDiffWithOutline } from './utils/diff-processor';
import { shouldFilterVisorReviewComment } from './utils/comment-metadata';

/**
 * Helper function to log debug messages using the centralized logger
 */
function log(...args: unknown[]): void {
  logger.debug(args.join(' '));
}

/**
 * Generate current date XML tag for AI context
 */
function getCurrentDateXml(): string {
  const now = new Date();
  return `<current_date>${now.toISOString().split('T')[0]}</current_date>`;
}

function createProbeTracerAdapter(fallbackTracer?: any) {
  const fallback = fallbackTracer && typeof fallbackTracer === 'object' ? fallbackTracer : null;
  const emitEvent = (name: string, attrs?: Record<string, unknown>) => {
    try {
      const span = otTrace.getActiveSpan();
      if (span && typeof span.addEvent === 'function') {
        span.addEvent(name, attrs as Record<string, unknown>);
      }
    } catch {}
  };
  return {
    withSpan: async (
      name: string,
      fn: (...args: any[]) => Promise<any>,
      attrs?: Record<string, unknown>
    ) =>
      withActiveSpan(name, attrs as Record<string, unknown>, async span => {
        if (fallback && typeof fallback.withSpan === 'function') {
          return await fallback.withSpan(name, async () => fn(span), attrs);
        }
        return await fn(span);
      }),
    recordEvent: (name: string, attrs?: Record<string, unknown>) => {
      emitEvent(name, attrs);
      if (fallback && typeof fallback.recordEvent === 'function') {
        try {
          fallback.recordEvent(name, attrs);
        } catch {}
      }
    },
    addEvent: (name: string, attrs?: Record<string, unknown>) => {
      // Alias for ProbeAgent versions that call tracer.addEvent directly.
      emitEvent(name, attrs);
      if (fallback && typeof fallback.addEvent === 'function') {
        try {
          fallback.addEvent(name, attrs);
        } catch {}
      } else if (fallback && typeof fallback.recordEvent === 'function') {
        try {
          fallback.recordEvent(name, attrs);
        } catch {}
      }
    },
    recordDelegationEvent: (phase: string, attrs?: Record<string, unknown>) => {
      emitEvent(`delegation.${phase}`, attrs);
      if (fallback && typeof fallback.recordDelegationEvent === 'function') {
        try {
          fallback.recordDelegationEvent(phase, attrs);
        } catch {}
      }
    },
    recordMermaidValidationEvent: (phase: string, attrs?: Record<string, unknown>) => {
      emitEvent(`mermaid.${phase}`, attrs);
      if (fallback && typeof fallback.recordMermaidValidationEvent === 'function') {
        try {
          fallback.recordMermaidValidationEvent(phase, attrs);
        } catch {}
      }
    },
    recordJsonValidationEvent: (phase: string, attrs?: Record<string, unknown>) => {
      emitEvent(`json.${phase}`, attrs);
      if (fallback && typeof fallback.recordJsonValidationEvent === 'function') {
        try {
          fallback.recordJsonValidationEvent(phase, attrs);
        } catch {}
      }
    },
    createDelegationSpan: (sessionId: string, task: string) => {
      let fallbackSpan: any = null;
      if (fallback && typeof fallback.createDelegationSpan === 'function') {
        try {
          fallbackSpan = fallback.createDelegationSpan(sessionId, task);
        } catch {}
      }
      let span: any = null;
      try {
        const tracer = otTrace.getTracer('visor');
        span = tracer.startSpan('probe.delegation', {
          attributes: {
            'delegation.session_id': sessionId,
            'delegation.task': task,
          },
        });
      } catch {}
      if (!span && fallbackSpan) return fallbackSpan;
      if (!span) return null;
      return {
        setAttributes: (attrs?: Record<string, unknown>) => {
          try {
            if (attrs) span.setAttributes(attrs as Record<string, unknown>);
          } catch {}
          if (fallbackSpan && typeof fallbackSpan.setAttributes === 'function') {
            try {
              fallbackSpan.setAttributes(attrs);
            } catch {}
          }
        },
        setStatus: (status: unknown) => {
          try {
            span.setStatus(status as never);
          } catch {}
          if (fallbackSpan && typeof fallbackSpan.setStatus === 'function') {
            try {
              fallbackSpan.setStatus(status);
            } catch {}
          }
        },
        end: () => {
          try {
            span.end();
          } catch {}
          if (fallbackSpan && typeof fallbackSpan.end === 'function') {
            try {
              fallbackSpan.end();
            } catch {}
          }
        },
      };
    },
    flush: async () => {
      if (fallback && typeof fallback.flush === 'function') {
        await fallback.flush();
      }
    },
    shutdown: async () => {
      if (fallback && typeof fallback.shutdown === 'function') {
        await fallback.shutdown();
      }
    },
  };
}

/**
 * Extended ProbeAgent interface that includes tracing properties
 */
interface TracedProbeAgent extends ProbeAgent {
  tracer?: unknown; // SimpleTelemetry tracer (probe removed AppTracer)
  _telemetryConfig?: unknown; // SimpleTelemetry config (probe removed TelemetryConfig)
  _traceFilePath?: string;
}

/**
 * Extended ProbeAgentOptions interface that includes tracing properties
 */
interface TracedProbeAgentOptions extends ProbeAgentOptions {
  tracer?: unknown; // SimpleTelemetry tracer
  _telemetryConfig?: unknown; // SimpleTelemetry config
  _traceFilePath?: string;
  customPrompt?: string;
  maxIterations?: number;
}

export interface AIReviewConfig {
  apiKey?: string; // From env: GOOGLE_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, CLAUDE_CODE_API_KEY, or AWS credentials
  model?: string; // From env: MODEL_NAME (e.g., gemini-2.5-pro-preview-06-05)
  timeout?: number; // Default: 1800000ms (30 minutes)
  maxIterations?: number; // Maximum tool iterations for ProbeAgent
  provider?: 'google' | 'anthropic' | 'openai' | 'bedrock' | 'mock' | 'claude-code';
  debug?: boolean; // Enable debug mode
  tools?: Array<{ name: string; [key: string]: unknown }>; // (unused) Legacy tool listing
  // Pass-through MCP server configuration for ProbeAgent
  mcpServers?: Record<string, import('./types/config').McpServerConfig>;
  // Enable delegate tool for task distribution to subagents
  enableDelegate?: boolean;
  // Enable task management for tracking multi-goal requests
  enableTasks?: boolean;
  // ProbeAgent persona/prompt family (e.g., 'engineer', 'code-review', 'architect')
  promptType?: string;
  // System prompt to prepend (baseline/preamble). Replaces legacy customPrompt
  systemPrompt?: string;
  // Backward-compat: legacy key still accepted internally
  customPrompt?: string;
  // Retry configuration for AI provider calls
  retry?: import('./types/config').AIRetryConfig;
  // Fallback configuration for provider failures
  fallback?: import('./types/config').AIFallbackConfig;
  // Enable Edit and Create tools for file modification
  allowEdit?: boolean;
  // Filter allowed tools - supports whitelist, exclusion (!prefix), or raw AI mode (empty array)
  allowedTools?: string[];
  // Disable all tools for raw AI mode (alternative to allowedTools: [])
  disableTools?: boolean;
  // Enable bash command execution (shorthand for bashConfig.enabled)
  allowBash?: boolean;
  // Advanced bash command execution configuration
  bashConfig?: import('./types/config').BashConfig;
  // Optional workspace root and allowed folders for ProbeAgent.
  // When provided, these are forwarded to ProbeAgent so tools like search/query
  // operate inside the isolated workspace/projects instead of the Visor repo root.
  path?: string;
  allowedFolders?: string[];
  // Completion prompt for post-completion validation/review (runs after attempt_completion)
  completionPrompt?: string;
  /** Shared concurrency limiter for global AI call gating */
  concurrencyLimiter?: any;
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

// REMOVED: ReviewFocus type - only use custom prompts from .visor.yaml

interface AIResponseFormat {
  // Array of issues for code review
  issues?: Array<{
    file: string;
    line: number;
    endLine?: number;
    ruleId: string;
    message: string;
    severity: 'info' | 'warning' | 'error' | 'critical';
    category: 'security' | 'performance' | 'style' | 'logic' | 'documentation';
    suggestion?: string;
    replacement?: string;
  }>;
}

export class AIReviewService {
  private config: AIReviewConfig;
  private sessionRegistry: SessionRegistry;

  constructor(config: AIReviewConfig = {}) {
    this.config = {
      timeout: 1800000, // Increased timeout to 30 minutes for AI responses
      ...config,
    };

    this.sessionRegistry = SessionRegistry.getInstance();

    // If debug was not explicitly provided, honor standard env flags so tests/CLI
    // can enable provider-level debug without modifying per-check configs.
    if (typeof this.config.debug === 'undefined') {
      try {
        if (process.env.VISOR_PROVIDER_DEBUG === 'true' || process.env.VISOR_DEBUG === 'true') {
          this.config.debug = true;
        }
      } catch {}
    }

    // Respect explicit provider if set (e.g., 'mock' during tests) — do not override from env
    const providerExplicit =
      typeof this.config.provider === 'string' && this.config.provider.length > 0;

    // Auto-detect provider and API key from environment only when provider not explicitly set
    if (!providerExplicit) {
      if (!this.config.apiKey) {
        if (process.env.CLAUDE_CODE_API_KEY) {
          this.config.apiKey = process.env.CLAUDE_CODE_API_KEY;
          this.config.provider = 'claude-code';
        } else if (process.env.GOOGLE_API_KEY) {
          this.config.apiKey = process.env.GOOGLE_API_KEY;
          this.config.provider = 'google';
        } else if (process.env.ANTHROPIC_API_KEY) {
          this.config.apiKey = process.env.ANTHROPIC_API_KEY;
          this.config.provider = 'anthropic';
        } else if (process.env.OPENAI_API_KEY) {
          this.config.apiKey = process.env.OPENAI_API_KEY;
          this.config.provider = 'openai';
        } else if (
          // Check for AWS Bedrock credentials
          (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
          process.env.AWS_BEDROCK_API_KEY
        ) {
          // For Bedrock, we don't set apiKey as it uses AWS credentials
          // ProbeAgent will handle the authentication internally
          this.config.provider = 'bedrock';
          // Set a placeholder to pass validation
          this.config.apiKey = 'AWS_CREDENTIALS';
        }
      }
    }

    // Auto-detect model from environment
    if (!this.config.model && process.env.MODEL_NAME) {
      this.config.model = process.env.MODEL_NAME;
    }
  }

  // NOTE: per request, no additional redaction/encryption helpers are used.

  /**
   * Execute AI review using probe agent
   */
  async executeReview(
    prInfo: PRInfo,
    customPrompt: string,
    schema?: string | Record<string, unknown>,
    checkName?: string,
    sessionId?: string
  ): Promise<ReviewSummary> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    // Build prompt from custom instructions
    // Respect provider-level skip_code_context by skipping PR context wrapper when requested
    const cfgAny: any = this.config as any;
    const skipTransport = cfgAny?.skip_transport_context === true;
    const skipPRContext =
      cfgAny?.skip_code_context === true || (skipTransport && cfgAny?.skip_code_context !== false);
    const skipSlackContext =
      cfgAny?.skip_slack_context === true ||
      (skipTransport && cfgAny?.skip_slack_context !== false);

    const prompt = await this.buildCustomPrompt(prInfo, customPrompt, schema, {
      skipPRContext,
      skipSlackContext,
    });

    log(`Executing AI review with ${this.config.provider} provider...`);
    log(`🔧 Debug: Raw schema parameter: ${JSON.stringify(schema)} (type: ${typeof schema})`);
    log(`Schema type: ${schema || 'none (no schema)'}`);

    let debugInfo: AIDebugInfo | undefined;
    if (this.config.debug) {
      debugInfo = {
        prompt,
        rawResponse: '',
        provider: this.config.provider || 'unknown',
        model: this.config.model || 'default',
        apiKeySource: this.getApiKeySource(),
        processingTime: 0,
        promptLength: prompt.length,
        responseLength: 0,
        errors: [],
        jsonParseSuccess: false,
        timestamp,
        schemaName: typeof schema === 'object' ? 'custom' : schema,
        schema: undefined, // Will be populated when schema is loaded
      };
    }

    // Handle mock model/provider first (no API key needed)
    if (this.config.model === 'mock' || this.config.provider === 'mock') {
      log('🎭 Using mock AI model/provider for testing - skipping API key validation');
    } else {
      // Hydrate API key from environment even when provider is explicitly set
      if (!this.config.apiKey) {
        try {
          if (this.config.provider === 'google' && process.env.GOOGLE_API_KEY) {
            this.config.apiKey = process.env.GOOGLE_API_KEY;
          } else if (this.config.provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
            this.config.apiKey = process.env.ANTHROPIC_API_KEY;
          } else if (this.config.provider === 'openai' && process.env.OPENAI_API_KEY) {
            this.config.apiKey = process.env.OPENAI_API_KEY;
          } else if (this.config.provider === 'claude-code' && process.env.CLAUDE_CODE_API_KEY) {
            this.config.apiKey = process.env.CLAUDE_CODE_API_KEY;
          }
        } catch {}
      }
      // Check if API key is available for real AI models
      // Note: If no API key, ProbeAgent.initialize() will attempt CLI fallback (claude-code/codex)
      if (!this.config.apiKey) {
        log('⚠️ No API key configured - ProbeAgent will attempt CLI fallback (claude-code/codex)');
        if (debugInfo) {
          debugInfo.errors = debugInfo.errors || [];
          debugInfo.errors.push('No API key configured - attempting CLI fallback');
        }
      }
    }

    try {
      const call = this.callProbeAgent(prompt, schema, debugInfo, checkName, sessionId);
      const timeoutMs = Math.max(0, this.config.timeout || 0);
      const {
        response,
        effectiveSchema,
        sessionId: usedSessionId,
      } = timeoutMs > 0 ? await this.withTimeout(call, timeoutMs, 'AI review') : await call;
      const processingTime = Date.now() - startTime;

      if (debugInfo) {
        debugInfo.rawResponse = response;
        debugInfo.responseLength = response.length;
        debugInfo.processingTime = processingTime;
      }

      const result = this.parseAIResponse(response, debugInfo, effectiveSchema);

      // Expose the session ID used for this call so the engine can reuse it later
      try {
        (result as any).sessionId = usedSessionId;
      } catch {}

      if (debugInfo) {
        result.debug = debugInfo;
      }

      return result;
    } catch (error) {
      if (debugInfo) {
        debugInfo.errors = [error instanceof Error ? error.message : String(error)];
        debugInfo.processingTime = Date.now() - startTime;

        // In debug mode, return a review with the error captured
        return {
          issues: [
            {
              file: 'system',
              line: 0,
              ruleId: 'system/ai-execution-error',
              message: error instanceof Error ? error.message : String(error),
              severity: 'error',
              category: 'logic',
            },
          ],
          debug: debugInfo,
        };
      }
      throw error;
    }
  }

  /**
   * Execute AI review using session reuse - reuses an existing ProbeAgent session
   * @param sessionMode - 'clone' (default) clones history, 'append' shares history
   */
  async executeReviewWithSessionReuse(
    prInfo: PRInfo,
    customPrompt: string,
    parentSessionId: string,
    schema?: string | Record<string, unknown>,
    checkName?: string,
    sessionMode: 'clone' | 'append' = 'clone'
  ): Promise<ReviewSummary> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    // Ensure API key is hydrated from environment for explicit providers
    if (!this.config.apiKey) {
      try {
        if (this.config.provider === 'google' && process.env.GOOGLE_API_KEY) {
          this.config.apiKey = process.env.GOOGLE_API_KEY;
        } else if (this.config.provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
          this.config.apiKey = process.env.ANTHROPIC_API_KEY;
        } else if (this.config.provider === 'openai' && process.env.OPENAI_API_KEY) {
          this.config.apiKey = process.env.OPENAI_API_KEY;
        } else if (this.config.provider === 'claude-code' && process.env.CLAUDE_CODE_API_KEY) {
          this.config.apiKey = process.env.CLAUDE_CODE_API_KEY;
        }
      } catch {}
    }
    // Get the existing session
    const existingAgent = this.sessionRegistry.getSession(parentSessionId);
    if (!existingAgent) {
      throw new Error(
        `Session not found for reuse: ${parentSessionId}. Ensure the parent check completed successfully.`
      );
    }

    // Build prompt from custom instructions
    // When reusing session, skip PR context since it's already in the conversation history
    const cfgAny: any = this.config as any;
    const skipTransport = cfgAny?.skip_transport_context === true;
    const skipSlackContext =
      cfgAny?.skip_slack_context === true ||
      (skipTransport && cfgAny?.skip_slack_context !== false);

    const prompt = await this.buildCustomPrompt(prInfo, customPrompt, schema, {
      // When reusing sessions we always skip PR context, regardless of flags
      skipPRContext: true,
      skipSlackContext,
    });

    // Determine which agent to use based on session mode
    let agentToUse: typeof existingAgent;
    let currentSessionId: string;

    if (sessionMode === 'clone') {
      // Clone the session - creates a new agent with copied history
      // Include check name in the session ID for better tracing
      currentSessionId = `${checkName}-session-${Date.now()}`;
      log(
        `📋 Cloning AI session ${parentSessionId} → ${currentSessionId} for ${checkName} check...`
      );

      const clonedAgent = await this.sessionRegistry.cloneSession(
        parentSessionId,
        currentSessionId,
        checkName // Pass checkName for tracing
      );
      if (!clonedAgent) {
        throw new Error(`Failed to clone session ${parentSessionId}`);
      }
      agentToUse = clonedAgent;
    } else {
      // Append mode - use the same agent instance
      log(`🔄 Appending to AI session ${parentSessionId} (shared history)...`);
      agentToUse = existingAgent;
      currentSessionId = parentSessionId;
    }

    log(`🔧 Debug: Raw schema parameter: ${JSON.stringify(schema)} (type: ${typeof schema})`);
    log(`📋 Schema for this check: ${schema || 'none (no schema)'}`);
    if (sessionMode === 'clone') {
      log(`✅ Cloned agent will use NEW schema (${schema}) - parent schema does not persist`);
      log(`🔄 Clone operation ensures fresh agent with copied history but new configuration`);
    } else {
      log(`🔄 Append mode - using existing agent instance with shared history and configuration`);
    }

    let debugInfo: AIDebugInfo | undefined;
    if (this.config.debug) {
      debugInfo = {
        prompt,
        rawResponse: '',
        provider: this.config.provider || 'unknown',
        model: this.config.model || 'default',
        apiKeySource: this.getApiKeySource(),
        processingTime: 0,
        promptLength: prompt.length,
        responseLength: 0,
        errors: [],
        jsonParseSuccess: false,
        timestamp,
        schemaName: typeof schema === 'object' ? 'custom' : schema,
        schema: undefined, // Will be populated when schema is loaded
      };
    }

    try {
      // Use the determined agent (cloned or original)
      const call = this.callProbeAgentWithExistingSession(
        agentToUse,
        prompt,
        schema,
        debugInfo,
        checkName
      );
      const timeoutMs = Math.max(0, this.config.timeout || 0);
      const { response, effectiveSchema } =
        timeoutMs > 0 ? await this.withTimeout(call, timeoutMs, 'AI review (session)') : await call;
      const processingTime = Date.now() - startTime;

      if (debugInfo) {
        debugInfo.rawResponse = response;
        debugInfo.responseLength = response.length;
        debugInfo.processingTime = processingTime;
      }

      const result = this.parseAIResponse(response, debugInfo, effectiveSchema);

      // Expose the session ID used for this call so the engine can clean it up
      try {
        (result as any).sessionId = currentSessionId;
      } catch {}

      if (debugInfo) {
        result.debug = debugInfo;
      }

      // Include the session ID in the result for cleanup tracking
      // Only include if we created a new cloned session
      if (sessionMode === 'clone' && currentSessionId !== parentSessionId) {
        result.sessionId = currentSessionId;
      }

      return result;
    } catch (error) {
      if (debugInfo) {
        debugInfo.errors = [error instanceof Error ? error.message : String(error)];
        debugInfo.processingTime = Date.now() - startTime;

        // In debug mode, return a review with the error captured
        return {
          issues: [
            {
              file: 'system',
              line: 0,
              ruleId: 'system/ai-session-reuse-error',
              message: error instanceof Error ? error.message : String(error),
              severity: 'error',
              category: 'logic',
            },
          ],
          debug: debugInfo,
        };
      }
      throw error;
    }
  }

  /**
   * Promise timeout helper that rejects after ms if unresolved
   */
  private async withTimeout<T>(p: Promise<T>, ms: number, label = 'operation'): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      });
      return (await Promise.race([p, timeout])) as T;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Register a new AI session in the session registry
   */
  registerSession(sessionId: string, agent: TracedProbeAgent): void {
    this.sessionRegistry.registerSession(sessionId, agent);
  }

  /**
   * Cleanup a session from the registry
   */
  cleanupSession(sessionId: string): void {
    this.sessionRegistry.unregisterSession(sessionId);
  }

  /**
   * Build a custom prompt for AI review with XML-formatted data
   */
  private async buildCustomPrompt(
    prInfo: PRInfo,
    customInstructions: string,
    schema?: string | Record<string, unknown>,
    options?: { skipPRContext?: boolean; checkName?: string; skipSlackContext?: boolean }
  ): Promise<string> {
    // When reusing sessions, skip PR context to avoid sending duplicate diff data
    const skipPRContext = options?.skipPRContext === true;
    const skipSlackContext = options?.skipSlackContext === true;

    // Check if we're using the code-review schema
    const isCodeReviewSchema = schema === 'code-review';

    const prContext = skipPRContext ? '' : await this.formatPRContext(prInfo, isCodeReviewSchema);
    const slackContextXml =
      skipSlackContext === true ? '' : this.formatSlackContextFromPRInfo(prInfo);
    const traceIdXml = (prInfo as any).otelTraceId
      ? `\n    <trace_id>${this.escapeXml(String((prInfo as any).otelTraceId))}</trace_id>`
      : '';
    const isIssue = (prInfo as PRInfo & { isIssue?: boolean }).isIssue === true;

    if (isIssue) {
      // Issue context - no code analysis needed
      if (skipPRContext && !slackContextXml) {
        // Session reuse: just send new instructions (no context at all)
        return `<instructions>
${customInstructions}
</instructions>`;
      }

      return `<review_request>
  <instructions>
${customInstructions}
  </instructions>

  <context>
    ${getCurrentDateXml()}${traceIdXml}
${prContext}${slackContextXml}
  </context>

  <rules>
    <rule>Understand the issue context and requirements from the XML data structure</rule>
    <rule>Provide helpful, actionable guidance based on the issue details</rule>
    <rule>Be constructive and supportive in your analysis</rule>
    <rule>Consider project conventions and patterns when making recommendations</rule>
    <rule>Suggest practical solutions or next steps that address the specific concern</rule>
    <rule>Focus on addressing the specific concern raised in the issue</rule>
    <rule>Reference relevant XML elements like metadata, description, labels, assignees when providing context</rule>
  </rules>
</review_request>`;
    }

    // Only add review_request wrapper and PR-specific rules for code-review schema
    if (isCodeReviewSchema) {
      // PR context with code-review schema - structured XML format
      const analysisType = prInfo.isIncremental ? 'INCREMENTAL' : 'FULL';

      if (skipPRContext && !slackContextXml) {
        // Session reuse: just send new instructions without repeating the context
        return `<instructions>
${customInstructions}
</instructions>

<reminder>
  <rule>The code context and diff were provided in the previous message</rule>
  <rule>Focus on the new analysis instructions above</rule>
  <rule>Only analyze code that appears with + (additions) or - (deletions) in the diff sections</rule>
  <rule>STRICT OUTPUT POLICY: Report only actual problems, risks, or deficiencies</rule>
  <rule>SEVERITY ASSIGNMENT: Assign severity ONLY to problems introduced or left unresolved by this change</rule>
</reminder>`;
      }

      return `<review_request>
  <analysis_type>${analysisType}</analysis_type>

  <analysis_focus>
    ${
      analysisType === 'INCREMENTAL'
        ? 'You are analyzing a NEW COMMIT added to an existing PR. Focus on the changes in the commit_diff section for this specific commit.'
        : 'You are analyzing the COMPLETE PR. Review all changes in the full_diff section.'
    }
  </analysis_focus>

  <instructions>
${customInstructions}
  </instructions>

  <context>
    ${getCurrentDateXml()}${traceIdXml}
${prContext}${slackContextXml}
  </context>

  <rules>
    <rule>Only analyze code that appears with + (additions) or - (deletions) in the diff sections</rule>
    <rule>Ignore unchanged code unless directly relevant to understanding a change</rule>
    <rule>Line numbers in your response should match actual file line numbers from the diff</rule>
    <rule>Focus on real issues, not nitpicks or cosmetic concerns</rule>
    <rule>Provide actionable, specific feedback with clear remediation steps</rule>
    <rule>For INCREMENTAL analysis, ONLY review changes in commit_diff section</rule>
    <rule>For FULL analysis, review all changes in full_diff section</rule>
    <rule>Reference specific XML elements like files_summary, metadata when providing context</rule>
    <rule>STRICT OUTPUT POLICY: Report only actual problems, risks, or deficiencies. Do not write praise, congratulations, or celebratory text. Do not create issues that merely restate improvements or say "no action needed".</rule>
    <rule>SEVERITY ASSIGNMENT: Assign severity ONLY to problems introduced or left unresolved by this change (critical/error/warning/info as appropriate). Do NOT create issue entries solely to acknowledge improvements; if no problems exist, return zero issues.</rule>
  </rules>
</review_request>`;
    }

    // For non-code-review schemas, just provide instructions and context without review-specific wrapper
    if (skipPRContext && !slackContextXml) {
      // Session reuse: just send new instructions (no context)
      return `<instructions>
${customInstructions}
</instructions>`;
    }

    return `<instructions>
${customInstructions}
</instructions>

<context>
  ${getCurrentDateXml()}${traceIdXml}
${prContext}${slackContextXml}
</context>`;
  }

  // REMOVED: Built-in prompts - only use custom prompts from .visor.yaml

  // REMOVED: getFocusInstructions - only use custom prompts from .visor.yaml

  /**
   * Format PR or Issue context for the AI using XML structure
   */
  private async formatPRContext(prInfo: PRInfo, isCodeReviewSchema?: boolean): Promise<string> {
    // Check if this is an issue (not a PR)
    const prContextInfo = prInfo as PRInfo & {
      isPRContext?: boolean;
      includeCodeContext?: boolean;
      slackConversation?: unknown;
    };
    const isIssue = prContextInfo.isIssue === true;

    // Check if we should include code context (diffs)
    const isPRContext = prContextInfo.isPRContext === true;
    const isSlackMode = prContextInfo.slackConversation !== undefined;

    // Determine whether to include code context:
    // - In explicit PR context (GitHub PR events), always include diffs
    // - In Slack mode, default to NO code context unless explicitly requested
    // - Otherwise, include code context unless explicitly disabled
    let includeCodeContext: boolean;
    if (isPRContext) {
      includeCodeContext = true;
    } else if (isSlackMode) {
      // In Slack mode, only include code context if explicitly set to true
      includeCodeContext = prContextInfo.includeCodeContext === true;
    } else {
      // Default: include unless explicitly disabled
      includeCodeContext = prContextInfo.includeCodeContext !== false;
    }

    // Log the decision for transparency (debug level)
    if (isPRContext) {
      log('🔍 Including full code diffs in AI context (PR mode)');
    } else if (isSlackMode && !includeCodeContext) {
      log('💬 Slack mode: excluding code diffs (use includeCodeContext: true to enable)');
    } else if (!includeCodeContext) {
      log('📊 Including only file summary in AI context (no diffs)');
    } else {
      log('🔍 Including code diffs in AI context');
    }

    if (isIssue) {
      // Format as issue context
      let context = `<issue>
  <!-- Core issue metadata including identification, status, and timeline information -->
  <metadata>
    <number>${prInfo.number}</number>
    <title>${this.escapeXml(prInfo.title)}</title>
    <author>${prInfo.author}</author>
    <state>${(prInfo as PRInfo & { eventContext?: { issue?: { state?: string; created_at?: string; updated_at?: string; comments?: number } } }).eventContext?.issue?.state || 'open'}</state>
    <created_at>${(prInfo as PRInfo & { eventContext?: { issue?: { state?: string; created_at?: string; updated_at?: string; comments?: number } } }).eventContext?.issue?.created_at || ''}</created_at>
    <updated_at>${(prInfo as PRInfo & { eventContext?: { issue?: { state?: string; updated_at?: string; comments?: number } } }).eventContext?.issue?.updated_at || ''}</updated_at>
    <comments_count>${(prInfo as PRInfo & { eventContext?: { issue?: { comments?: number } } }).eventContext?.issue?.comments || 0}</comments_count>
  </metadata>`;

      // Add issue body/description if available
      if (prInfo.body) {
        context += `
  <!-- Full issue description and body text provided by the issue author -->
  <description>
${this.escapeXml(prInfo.body)}
  </description>`;
      }

      // Add labels if available
      const eventContext = prInfo as PRInfo & {
        eventContext?: { issue?: { labels?: Array<{ name?: string } | string> } };
      };
      const labels = eventContext.eventContext?.issue?.labels;
      if (labels && labels.length > 0) {
        context += `
  <!-- Applied labels for issue categorization and organization -->
  <labels>`;
        labels.forEach((label: { name?: string } | string) => {
          const labelName = typeof label === 'string' ? label : label.name || 'unknown';
          context += `
    <label>${this.escapeXml(labelName)}</label>`;
        });
        context += `
  </labels>`;
      }

      // Add assignees if available
      const assignees = (
        prInfo as PRInfo & {
          eventContext?: { issue?: { assignees?: Array<{ login?: string } | string> } };
        }
      ).eventContext?.issue?.assignees;
      if (assignees && assignees.length > 0) {
        context += `
  <!-- Users assigned to work on this issue -->
  <assignees>`;
        assignees.forEach((assignee: { login?: string } | string) => {
          const assigneeName =
            typeof assignee === 'string' ? assignee : assignee.login || 'unknown';
          context += `
    <assignee>${this.escapeXml(assigneeName)}</assignee>`;
        });
        context += `
  </assignees>`;
      }

      // Add milestone if available
      const milestone = (
        prInfo as PRInfo & {
          eventContext?: {
            issue?: { milestone?: { title?: string; state?: string; due_on?: string } };
          };
        }
      ).eventContext?.issue?.milestone;
      if (milestone) {
        context += `
  <!-- Associated project milestone information -->
  <milestone>
    <title>${this.escapeXml(milestone.title || '')}</title>
    <state>${milestone.state || 'open'}</state>
    <due_on>${milestone.due_on || ''}</due_on>
  </milestone>`;
      }

      // Add current/triggering comment if this is a comment event
      const triggeringComment = (
        prInfo as PRInfo & {
          eventContext?: {
            comment?: {
              user?: { login?: string };
              created_at?: string;
              body?: string;
              id?: number;
            };
          };
        }
      ).eventContext?.comment;
      if (triggeringComment) {
        context += `
  <!-- The comment that triggered this analysis -->
  <triggering_comment>
    <author>${this.escapeXml(triggeringComment.user?.login || 'unknown')}</author>
    <created_at>${triggeringComment.created_at || ''}</created_at>
    <body>${this.escapeXml(triggeringComment.body || '')}</body>
  </triggering_comment>`;
      }

      // Add comment history (excluding the current comment if it exists)
      const issueComments = (
        prInfo as PRInfo & {
          comments?: Array<{ id?: number; author?: string; body?: string; createdAt?: string }>;
        }
      ).comments;
      if (issueComments && issueComments.length > 0) {
        // Filter out the triggering comment from history if present
        let historicalComments = triggeringComment
          ? issueComments.filter(c => c.id !== triggeringComment.id)
          : issueComments;

        // For code-review schema checks, filter out previous Visor code-review comments to avoid self-bias
        // Old format: <!-- visor-comment-id:pr-review-244-review -->
        // New format: <!-- visor:thread={"key":"...","group":"review",...} -->
        if (isCodeReviewSchema) {
          historicalComments = historicalComments.filter(
            c => !shouldFilterVisorReviewComment(c.body)
          );
        }

        if (historicalComments.length > 0) {
          context += `
  <!-- Previous comments in chronological order (excluding triggering comment) -->
  <comment_history>`;
          historicalComments.forEach(comment => {
            context += `
    <comment>
      <author>${this.escapeXml(comment.author || 'unknown')}</author>
      <created_at>${comment.createdAt || ''}</created_at>
      <body>${this.escapeXml(comment.body || '')}</body>
    </comment>`;
          });
          context += `
  </comment_history>`;
        }
      }

      // Close the issue tag
      context += `
</issue>`;

      return context;
    }

    // Original PR context formatting
    let context = `<pull_request>
  <!-- Core pull request metadata including identification, branches, and change statistics -->
  <metadata>
    <number>${prInfo.number}</number>
    <title>${this.escapeXml(prInfo.title)}</title>
    <author>${prInfo.author}</author>
    <base_branch>${prInfo.base}</base_branch>
    <target_branch>${prInfo.head}</target_branch>
    <total_additions>${prInfo.totalAdditions}</total_additions>
    <total_deletions>${prInfo.totalDeletions}</total_deletions>
    <files_changed_count>${prInfo.files.length}</files_changed_count>
  </metadata>`;

    // Include a small raw diff header snippet for compatibility with tools/tests
    try {
      const firstFile = (prInfo.files || [])[0];
      if (firstFile && firstFile.filename) {
        context += `\n  <raw_diff_header>\n${this.escapeXml(`diff --git a/${firstFile.filename} b/${firstFile.filename}`)}\n  </raw_diff_header>`;
      }
    } catch {}

    // Add PR description if available
    if (prInfo.body) {
      context += `
  <!-- Full pull request description provided by the author -->
  <description>
${this.escapeXml(prInfo.body)}
  </description>`;
    }

    // Add diffs only if includeCodeContext is true (or in PR mode)
    if (includeCodeContext) {
      // Add full diff if available (for complete PR review)
      if (prInfo.fullDiff) {
        // Process the diff with outline-diff format for better structure
        const processedFullDiff = await processDiffWithOutline(prInfo.fullDiff);
        context += `
  <!-- Complete unified diff showing all changes in the pull request (processed with outline-diff) -->
  <full_diff>
${this.escapeXml(processedFullDiff)}
  </full_diff>`;
      }

      // Add incremental commit diff if available (for new commit analysis)
      if (prInfo.isIncremental) {
        if (prInfo.commitDiff && prInfo.commitDiff.length > 0) {
          // Process the commit diff with outline-diff format for better structure
          const processedCommitDiff = await processDiffWithOutline(prInfo.commitDiff);
          context += `
  <!-- Diff of only the latest commit for incremental analysis (processed with outline-diff) -->
  <commit_diff>
${this.escapeXml(processedCommitDiff)}
  </commit_diff>`;
        } else {
          // Process the fallback full diff with outline-diff format
          const processedFallbackDiff = prInfo.fullDiff
            ? await processDiffWithOutline(prInfo.fullDiff)
            : '';
          context += `
  <!-- Commit diff could not be retrieved - falling back to full diff analysis (processed with outline-diff) -->
  <commit_diff>
${this.escapeXml(processedFallbackDiff)}
  </commit_diff>`;
        }
      }
    } else {
      // When not including diffs, add a note about it
      context += `
  <!-- Code diffs excluded to reduce token usage (no code-review schema detected or disabled by flag) -->`;
    }

    // Add file summary for context
    if (prInfo.files.length > 0) {
      context += `
  <!-- Summary of all files changed with statistics -->
  <files_summary>`;
      prInfo.files.forEach(file => {
        context += `
    <file>
      <filename>${this.escapeXml(file.filename)}</filename>
      <status>${file.status}</status>
      <additions>${file.additions}</additions>
      <deletions>${file.deletions}</deletions>
    </file>`;
      });
      context += `
  </files_summary>`;
    }

    // Add current/triggering comment if this is a comment event
    const triggeringComment = (
      prInfo as PRInfo & {
        eventContext?: {
          comment?: { user?: { login?: string }; created_at?: string; body?: string; id?: number };
        };
      }
    ).eventContext?.comment;
    if (triggeringComment) {
      context += `
  <!-- The comment that triggered this analysis -->
  <triggering_comment>
    <author>${this.escapeXml(triggeringComment.user?.login || 'unknown')}</author>
    <created_at>${triggeringComment.created_at || ''}</created_at>
    <body>${this.escapeXml(triggeringComment.body || '')}</body>
  </triggering_comment>`;
    }

    // Add comment history (excluding the current comment if it exists)
    const prComments = (
      prInfo as PRInfo & {
        comments?: Array<{ id?: number; author?: string; body?: string; createdAt?: string }>;
      }
    ).comments;
    if (prComments && prComments.length > 0) {
      // Filter out the triggering comment from history if present
      let historicalComments = triggeringComment
        ? prComments.filter(c => c.id !== triggeringComment.id)
        : prComments;

      // For code-review schema checks, filter out previous Visor code-review comments to avoid self-bias
      // Old format: <!-- visor-comment-id:pr-review-244-review -->
      // New format: <!-- visor:thread={"key":"...","group":"review",...} -->
      if (isCodeReviewSchema) {
        historicalComments = historicalComments.filter(
          c => !shouldFilterVisorReviewComment(c.body)
        );
      }

      if (historicalComments.length > 0) {
        context += `
  <!-- Previous PR comments in chronological order (excluding triggering comment) -->
  <comment_history>`;
        historicalComments.forEach(comment => {
          context += `
    <comment>
      <author>${this.escapeXml(comment.author || 'unknown')}</author>
      <created_at>${comment.createdAt || ''}</created_at>
      <body>${this.escapeXml(comment.body || '')}</body>
    </comment>`;
        });
        context += `
  </comment_history>`;
      }
    }

    context += `
</pull_request>`;

    return context;
  }

  /**
   * Format Slack conversation context (if attached to PRInfo) as XML
   */
  private formatSlackContextFromPRInfo(prInfo: PRInfo): string {
    try {
      const anyInfo: any = prInfo as any;
      const conv = anyInfo.slackConversation;
      if (!conv || typeof conv !== 'object') return '';

      const transport = conv.transport || 'slack';
      const thread = conv.thread || {};
      const messages = Array.isArray(conv.messages) ? conv.messages : [];
      const current = conv.current || {};
      const attrs = conv.attributes || {};

      let xml = `
<slack_context>
  <transport>${this.escapeXml(String(transport))}</transport>
  <thread>
    <id>${this.escapeXml(String(thread.id || ''))}</id>
    <url>${this.escapeXml(String(thread.url || ''))}</url>
  </thread>`;

      // Attributes (channel, user, thread_ts, etc.)
      const attrKeys = Object.keys(attrs);
      if (attrKeys.length > 0) {
        xml += `
  <attributes>`;
        for (const k of attrKeys) {
          const v = attrs[k];
          xml += `
    <attribute>
      <key>${this.escapeXml(String(k))}</key>
      <value>${this.escapeXml(String(v ?? ''))}</value>
    </attribute>`;
        }
        xml += `
  </attributes>`;
      }

      // Message history
      if (messages.length > 0) {
        xml += `
  <messages>`;
        for (const m of messages) {
          xml += `
    <message>
      <role>${this.escapeXml(String(m.role || 'user'))}</role>
      <user>${this.escapeXml(String((m as any).user || ''))}</user>
      <text>${this.escapeXml(String(m.text || ''))}</text>
      <timestamp>${this.escapeXml(String(m.timestamp || ''))}</timestamp>
      <origin>${this.escapeXml(String(m.origin || ''))}</origin>
    </message>`;
        }
        xml += `
  </messages>`;
      }

      // Current message (the one that triggered this run)
      xml += `
  <current>
    <role>${this.escapeXml(String(current.role || 'user'))}</role>
    <user>${this.escapeXml(String((current as any).user || ''))}</user>
    <text>${this.escapeXml(String(current.text || ''))}</text>
    <timestamp>${this.escapeXml(String(current.timestamp || ''))}</timestamp>
    <origin>${this.escapeXml(String(current.origin || ''))}</origin>
  </current>
</slack_context>`;

      return xml;
    } catch {
      return '';
    }
  }

  /**
   * Build a normalized ConversationContext for GitHub (PR/issue + comments)
   * using the same contract as Slack's ConversationContext. This is exposed
   * to templates via the unified `conversation` object.
   */
  private buildGitHubConversationFromPRInfo(
    prInfo: PRInfo
  ): import('./types/bot').ConversationContext | undefined {
    try {
      const anyInfo: any = prInfo as any;
      const eventCtx: any = anyInfo.eventContext || {};
      const comments: Array<import('./pr-analyzer').PRComment> = anyInfo.comments || [];

      // Basic repo + thread identity from eventContext if available
      const repoOwner: string | undefined =
        eventCtx.repository?.owner?.login || process.env.GITHUB_REPOSITORY?.split('/')?.[0];
      const repoName: string | undefined =
        eventCtx.repository?.name || process.env.GITHUB_REPOSITORY?.split('/')?.[1];

      const number = prInfo.number;
      const threadId =
        repoOwner && repoName ? `${repoOwner}/${repoName}#${number}` : `github#${number}`;
      const threadUrl =
        eventCtx.issue?.html_url ||
        eventCtx.pull_request?.html_url ||
        (repoOwner && repoName
          ? `https://github.com/${repoOwner}/${repoName}/pull/${number}`
          : undefined);

      const messages: import('./types/bot').NormalizedMessage[] = [];

      // Synthetic root message: PR/issue body
      if (prInfo.body && prInfo.body.trim().length > 0) {
        messages.push({
          role: 'user',
          user: prInfo.author || 'unknown',
          text: prInfo.body,
          timestamp: (eventCtx.pull_request?.created_at ||
            eventCtx.issue?.created_at ||
            '') as string,
          origin: 'github',
        });
      }

      // Historical comments in chronological order (already sorted by PRAnalyzer)
      for (const c of comments) {
        messages.push({
          role: 'user',
          user: c.author || 'unknown',
          text: c.body || '',
          timestamp: c.createdAt || '',
          origin: 'github',
        });
      }

      // Current / triggering comment, if present
      const triggeringComment = eventCtx.comment as
        | { user?: { login?: string }; created_at?: string; body?: string }
        | undefined;

      let current: import('./types/bot').NormalizedMessage;
      if (triggeringComment) {
        current = {
          role: 'user',
          user: (triggeringComment.user && triggeringComment.user.login) || 'unknown',
          text: triggeringComment.body || '',
          timestamp: triggeringComment.created_at || '',
          origin: 'github',
        };
      } else if (messages.length > 0) {
        current = messages[messages.length - 1];
      } else {
        // Fallback synthetic current message from title if body/comments are empty
        current = {
          role: 'user',
          user: prInfo.author || 'unknown',
          text: prInfo.title || '',
          timestamp: '',
          origin: 'github',
        };
      }

      // Attributes: useful metadata for templates/tooling
      const attributes: Record<string, string> = {};
      if (repoOwner) attributes.owner = repoOwner;
      if (repoName) attributes.repo = repoName;
      attributes.number = String(number);
      if (eventCtx.event_name) attributes.event_name = String(eventCtx.event_name);
      if (eventCtx.action) attributes.action = String(eventCtx.action);

      const ctx: import('./types/bot').ConversationContext = {
        transport: 'github',
        thread: { id: threadId, url: threadUrl },
        messages,
        current,
        attributes,
      };
      return ctx;
    } catch {
      return undefined;
    }
  }

  /**
   * No longer escaping XML - returning text as-is
   */
  private escapeXml(text: string): string {
    return text;
  }

  /**
   * Call ProbeAgent with an existing session
   */
  private async callProbeAgentWithExistingSession(
    agent: TracedProbeAgent,
    prompt: string,
    schema?: string | Record<string, unknown>,
    debugInfo?: AIDebugInfo,
    _checkName?: string
  ): Promise<{ response: string; effectiveSchema?: string }> {
    // Handle mock model/provider for testing
    if (this.config.model === 'mock' || this.config.provider === 'mock') {
      log('🎭 Using mock AI model/provider for testing (session reuse)');
      const response = await this.generateMockResponse(prompt, _checkName, schema);
      return { response, effectiveSchema: typeof schema === 'object' ? 'custom' : schema };
    }

    log('🔄 Reusing existing ProbeAgent session for AI review...');
    log(`📝 Prompt length: ${prompt.length} characters`);
    log(`⚙️ Model: ${this.config.model || 'default'}, Provider: ${this.config.provider || 'auto'}`);

    try {
      log('🚀 Calling existing ProbeAgent with answer()...');

      // Load and pass the actual schema content if provided (skip for plain schema)
      let schemaString: string | undefined = undefined;
      let effectiveSchema: string | undefined = typeof schema === 'object' ? 'custom' : schema;

      if (schema && schema !== 'plain') {
        try {
          schemaString = await this.loadSchemaContent(schema);
          log(`📋 Loaded schema content for: ${schema}`);
          log(`📄 Raw schema JSON:\n${schemaString}`);
        } catch (error) {
          log(`⚠️ Failed to load schema ${schema}, proceeding without schema:`, error);
          schemaString = undefined;
          effectiveSchema = undefined; // Schema loading failed, treat as no schema
          if (debugInfo && debugInfo.errors) {
            debugInfo.errors.push(`Failed to load schema: ${error}`);
          }
        }
      } else if (schema === 'plain') {
        log(`📋 Using plain schema - no JSON validation will be applied`);
      }

      // Pass schema in options object with 'schema' property
      const schemaOptions = schemaString ? { schema: schemaString } : undefined;

      // Store the exact schema options being passed to ProbeAgent in debug info
      if (debugInfo && schemaOptions) {
        debugInfo.schema = JSON.stringify(schemaOptions, null, 2);
      }

      // Log the schema options being passed to ProbeAgent
      if (schemaOptions) {
        log(`🎯 Schema options passed to ProbeAgent.answer() (session reuse):`);
        log(JSON.stringify(schemaOptions, null, 2));
      }

      // Save prompt and debug info for session reuse too (only if debug enabled)
      if (process.env.VISOR_DEBUG_AI_SESSIONS === 'true') {
        try {
          const fs = require('fs');
          const path = require('path');
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const provider = this.config.provider || 'auto';
          const model = this.config.model || 'default';

          // Try to extract conversation history from ProbeAgent
          let conversationHistory: any[] = [];
          try {
            // ProbeAgent stores history in different ways depending on version
            const agentAny = agent as any;
            if (agentAny.history) {
              conversationHistory = agentAny.history;
            } else if (agentAny.messages) {
              conversationHistory = agentAny.messages;
            } else if (agentAny._messages) {
              conversationHistory = agentAny._messages;
            }
          } catch {
            // Ignore if we can't access history
          }

          const debugData = {
            timestamp: timestamp,
            checkName: _checkName || 'unknown',
            provider: provider,
            model: model,
            schema: effectiveSchema,
            schemaOptions: schemaOptions || 'none',
            sessionInfo: {
              isSessionReuse: true,
              historyMessageCount: conversationHistory.length,
            },
            currentPromptLength: prompt.length,
            currentPrompt: prompt,
            conversationHistory: conversationHistory,
          };

          const debugJson = JSON.stringify(debugData, null, 2);

          // Also create a human-readable version with clear separators
          let readableVersion = `=============================================================\n`;
          readableVersion += `VISOR DEBUG REPORT - SESSION REUSE\n`;
          readableVersion += `=============================================================\n`;
          readableVersion += `Timestamp: ${timestamp}\n`;
          readableVersion += `Check Name: ${_checkName || 'unknown'}\n`;
          readableVersion += `Provider: ${provider}\n`;
          readableVersion += `Model: ${model}\n`;
          readableVersion += `Schema: ${effectiveSchema}\n`;
          readableVersion += `Schema Options: ${schemaOptions ? 'provided' : 'none'}\n`;
          readableVersion += `History Messages: ${conversationHistory.length}\n`;
          readableVersion += `=============================================================\n\n`;

          // Add schema details if provided
          if (schemaOptions) {
            readableVersion += `\n${'='.repeat(60)}\n`;
            readableVersion += `SCHEMA CONFIGURATION\n`;
            readableVersion += `${'='.repeat(60)}\n`;
            readableVersion += JSON.stringify(schemaOptions, null, 2);
            readableVersion += `\n`;
          }

          // Add conversation history with clear separators
          if (conversationHistory.length > 0) {
            readableVersion += `\n${'='.repeat(60)}\n`;
            readableVersion += `CONVERSATION HISTORY (${conversationHistory.length} messages)\n`;
            readableVersion += `${'='.repeat(60)}\n`;
            conversationHistory.forEach((msg: any, index: number) => {
              readableVersion += `\n${'-'.repeat(60)}\n`;
              readableVersion += `MESSAGE #${index + 1}\n`;
              readableVersion += `Role: ${msg.role || 'unknown'}\n`;
              if (msg.content) {
                const contentStr =
                  typeof msg.content === 'string'
                    ? msg.content
                    : JSON.stringify(msg.content, null, 2);
                readableVersion += `Length: ${contentStr.length} characters\n`;
                readableVersion += `${'-'.repeat(60)}\n`;
                readableVersion += `${contentStr}\n`;
              }
            });
          }

          // Add current prompt
          readableVersion += `\n${'='.repeat(60)}\n`;
          readableVersion += `CURRENT PROMPT (NEW MESSAGE)\n`;
          readableVersion += `${'='.repeat(60)}\n`;
          readableVersion += `Length: ${prompt.length} characters\n`;
          readableVersion += `${'-'.repeat(60)}\n`;
          readableVersion += `${prompt}\n`;
          readableVersion += `\n${'='.repeat(60)}\n`;
          readableVersion += `END OF DEBUG REPORT\n`;
          readableVersion += `${'='.repeat(60)}\n`;

          const debugArtifactsDir =
            process.env.VISOR_DEBUG_ARTIFACTS || path.join(process.cwd(), 'debug-artifacts');
          if (!fs.existsSync(debugArtifactsDir)) {
            fs.mkdirSync(debugArtifactsDir, { recursive: true });
          }

          // Save JSON version
          const debugFile = path.join(
            debugArtifactsDir,
            `prompt-${_checkName || 'unknown'}-${timestamp}.json`
          );
          fs.writeFileSync(debugFile, debugJson, 'utf-8');

          // Save readable version
          const readableFile = path.join(
            debugArtifactsDir,
            `prompt-${_checkName || 'unknown'}-${timestamp}.txt`
          );
          fs.writeFileSync(readableFile, readableVersion, 'utf-8');

          log(`\n💾 Full debug info saved to:`);
          log(`   JSON: ${debugFile}`);
          log(`   TXT:  ${readableFile}`);
          log(`   - Includes: full conversation history, schema, current prompt`);
        } catch (error) {
          log(`⚠️ Could not save debug file: ${error}`);
        }
      }

      // Use existing agent's answer method - this reuses the conversation context
      // Wrap in a span for hierarchical tracing
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agentAny = agent as any;
      // Ensure Probe spans are emitted as children of the active Visor span.
      agentAny.tracer = createProbeTracerAdapter(agentAny.tracer);
      let response: string;
      if (agentAny.tracer && typeof agentAny.tracer.withSpan === 'function') {
        response = await agentAny.tracer.withSpan(
          'visor.ai_check_reuse',
          async () => {
            return await agent.answer(prompt, undefined, schemaOptions);
          },
          {
            'check.name': _checkName || 'unknown',
            'check.mode': 'session_reuse',
            'prompt.length': prompt.length,
            'schema.type': effectiveSchema || 'none',
          }
        );
      } else {
        response = schemaOptions
          ? await agent.answer(prompt, undefined, schemaOptions)
          : await agent.answer(prompt);
      }

      log('✅ ProbeAgent session reuse completed successfully');
      log(`📤 Response length: ${response.length} characters`);

      // Save COMPLETE conversation history AFTER AI response (only if debug enabled)
      if (process.env.VISOR_DEBUG_AI_SESSIONS === 'true') {
        try {
          const fs = require('fs');
          const path = require('path');
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

          // Extract FULL conversation history AFTER the AI call
          const agentAny = agent as any;
          let fullHistory: any[] = [];

          // Try multiple properties to get complete history
          if (agentAny.history) {
            fullHistory = agentAny.history;
          } else if (agentAny.messages) {
            fullHistory = agentAny.messages;
          } else if (agentAny._messages) {
            fullHistory = agentAny._messages;
          }

          const debugArtifactsDir =
            process.env.VISOR_DEBUG_ARTIFACTS || path.join(process.cwd(), 'debug-artifacts');
          // do not enforce directory perms here

          // Save complete session history (all messages sent and received)
          const sessionBase = path.join(
            debugArtifactsDir,
            `session-${_checkName || 'unknown'}-${timestamp}`
          );
          const sessionData = {
            timestamp,
            checkName: _checkName || 'unknown',
            provider: this.config.provider || 'auto',
            model: this.config.model || 'default',
            schema: effectiveSchema,
            totalMessages: fullHistory.length,
          };
          fs.writeFileSync(sessionBase + '.json', JSON.stringify(sessionData, null, 2), 'utf-8');

          // Redacted textual summary
          let readable = `=============================================================
`;
          readable += `COMPLETE AI SESSION HISTORY (AFTER RESPONSE)
`;
          readable += `=============================================================
`;
          readable += `Timestamp: ${timestamp}
`;
          readable += `Check: ${_checkName || 'unknown'}
`;
          readable += `Total Messages: ${fullHistory.length}
`;
          readable += `=============================================================

`;
          fullHistory.forEach((msg: any, idx: number) => {
            const role = msg.role || 'unknown';
            const content =
              typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
            readable += `
${'='.repeat(60)}
MESSAGE ${idx + 1}/${fullHistory.length}
Role: ${role}
${'='.repeat(60)}
`;
            readable += content + '\n';
          });
          fs.writeFileSync(sessionBase + '.summary.txt', readable, 'utf-8');

          log(`💾 Complete session history saved:`);
          // (paths omitted)
          log(`   - Contains ALL ${fullHistory.length} messages (prompts + responses)`);
        } catch (error) {
          log(`⚠️ Could not save complete session history: ${error}`);
        }
      }

      // Save response if debug is enabled
      if (process.env.VISOR_DEBUG_AI_SESSIONS === 'true') {
        try {
          const fs = require('fs');
          const path = require('path');
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

          const debugArtifactsDir =
            process.env.VISOR_DEBUG_ARTIFACTS || path.join(process.cwd(), 'debug-artifacts');

          // Create a response file with the same timestamp pattern
          const responseFile = path.join(
            debugArtifactsDir,
            `response-${_checkName || 'unknown'}-${timestamp}.txt`
          );

          let responseContent = `=============================================================\n`;
          responseContent += `VISOR AI RESPONSE - SESSION REUSE\n`;
          responseContent += `=============================================================\n`;
          responseContent += `Timestamp: ${timestamp}\n`;
          responseContent += `Check Name: ${_checkName || 'unknown'}\n`;
          responseContent += `Response Length: ${response.length} characters\n`;
          responseContent += `=============================================================\n\n`;
          responseContent += `${'='.repeat(60)}\n`;
          responseContent += `AI RESPONSE\n`;
          responseContent += `${'='.repeat(60)}\n`;
          responseContent += response;
          responseContent += `\n${'='.repeat(60)}\n`;
          responseContent += `END OF RESPONSE\n`;
          responseContent += `${'='.repeat(60)}\n`;

          fs.writeFileSync(responseFile, responseContent, 'utf-8');
          log(`💾 Response saved to: ${responseFile}`);
        } catch (error) {
          log(`⚠️ Could not save response file: ${error}`);
        }
      }

      // Finalize and save trace if this is a cloned session with tracing enabled
      // Properly flush and shutdown OpenTelemetry to ensure all spans are exported
      if (agentAny._traceFilePath && agentAny._telemetryConfig) {
        try {
          // First flush the tracer to export pending spans
          if (agentAny.tracer && typeof agentAny.tracer.flush === 'function') {
            await agentAny.tracer.flush();
            log(`🔄 Flushed tracer spans for cloned session`);
          }

          // Then shutdown the telemetry config to finalize all exporters
          if (
            agentAny._telemetryConfig &&
            typeof agentAny._telemetryConfig.shutdown === 'function'
          ) {
            await agentAny._telemetryConfig.shutdown();
            log(`📊 OpenTelemetry trace saved to: ${agentAny._traceFilePath}`);

            // In GitHub Actions, also log file size for verification
            if (process.env.GITHUB_ACTIONS) {
              const fs = require('fs');
              if (fs.existsSync(agentAny._traceFilePath)) {
                const stats = fs.statSync(agentAny._traceFilePath);
                console.log(
                  `::notice title=AI Trace Saved::${agentAny._traceFilePath} (${stats.size} bytes)`
                );
              }
            }
          } else if (agentAny.tracer && typeof agentAny.tracer.shutdown === 'function') {
            // Fallback for SimpleTelemetry
            await agentAny.tracer.shutdown();
            log(`📊 Trace saved to: ${agentAny._traceFilePath}`);
          }
        } catch (exportError) {
          logger.warn(`⚠️  Warning: Failed to export trace for cloned session: ${exportError}`);
        }
      }

      return { response, effectiveSchema };
    } catch (error) {
      logger.error(
        `❌ ProbeAgent session reuse failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      throw new Error(
        `ProbeAgent session reuse failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Call ProbeAgent SDK with built-in schema validation
   */
  private async callProbeAgent(
    prompt: string,
    schema?: string | Record<string, unknown>,
    debugInfo?: AIDebugInfo,
    _checkName?: string,
    providedSessionId?: string
  ): Promise<{ response: string; effectiveSchema?: string; sessionId: string }> {
    // Derive a stable session ID for this call so the engine can reuse it later
    const sessionId =
      providedSessionId ||
      (() => {
        const timestamp = new Date().toISOString();
        return `visor-${timestamp.replace(/[:.]/g, '-')}-${_checkName || 'unknown'}`;
      })();

    // Handle mock model/provider
    if (this.config.model === 'mock' || this.config.provider === 'mock') {
      const inJest = !!process.env.JEST_WORKER_ID;
      log('🎭 Using mock AI model/provider');
      if (!inJest) {
        // Fast path for CLI/integration: synthesize a mock response without invoking ProbeAgent
        const response = await this.generateMockResponse(prompt, _checkName, schema);
        return {
          response,
          effectiveSchema: typeof schema === 'object' ? 'custom' : schema,
          sessionId,
        };
      }
      // In unit tests, still invoke ProbeAgent so tests can assert on options (schema) passed in
      // Fall through to normal flow below
    }

    // Create ProbeAgent instance with proper options

    log('🤖 Creating ProbeAgent for AI review...');
    log(`🆔 Session ID: ${sessionId}`);
    log(`📝 Prompt length: ${prompt.length} characters`);
    log(`⚙️ Model: ${this.config.model || 'default'}, Provider: ${this.config.provider || 'auto'}`);

    // Store original env vars to restore later
    const originalEnv: Record<string, string | undefined> = {
      CLAUDE_CODE_API_KEY: process.env.CLAUDE_CODE_API_KEY,
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };

    try {
      // Set environment variables for ProbeAgent
      // ProbeAgent SDK expects these to be in the environment
      if (this.config.provider === 'claude-code' && this.config.apiKey) {
        process.env.CLAUDE_CODE_API_KEY = this.config.apiKey;
        // Also set ANTHROPIC_API_KEY as fallback since Claude Code uses Anthropic API
        process.env.ANTHROPIC_API_KEY = this.config.apiKey;
      } else if (this.config.provider === 'google' && this.config.apiKey) {
        process.env.GOOGLE_API_KEY = this.config.apiKey;
      } else if (this.config.provider === 'anthropic' && this.config.apiKey) {
        process.env.ANTHROPIC_API_KEY = this.config.apiKey;
      } else if (this.config.provider === 'openai' && this.config.apiKey) {
        process.env.OPENAI_API_KEY = this.config.apiKey;
      } else if (this.config.provider === 'bedrock') {
        // For Bedrock, ProbeAgent will use AWS credentials from environment
        // No need to set apiKey as it uses AWS SDK authentication
        // ProbeAgent will check for AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, etc.
      }
      const explicitPromptType = (process.env.VISOR_PROMPT_TYPE || '').trim();

      // Derive a default system prompt for non-code-review flows when none is configured.
      // This keeps code-review schema using its specialized prompt template.
      let systemPrompt = this.config.systemPrompt;
      if (!systemPrompt && schema !== 'code-review') {
        systemPrompt = 'You are general assistant, follow user instructions.';
      }

      const options: TracedProbeAgentOptions = {
        sessionId: sessionId,
        // Prefer config promptType, then env override, else fallback to code-review when schema is set
        promptType:
          this.config.promptType && this.config.promptType.trim()
            ? (this.config.promptType.trim() as any)
            : explicitPromptType
              ? (explicitPromptType as any)
              : schema === 'code-review'
                ? ('code-review-template' as any)
                : undefined,
        allowEdit: false, // We don't want the agent to modify files
        debug: this.config.debug || false,
        // Use systemPrompt (native in rc168+) with fallback to customPrompt for backward compat
        systemPrompt: systemPrompt || this.config.systemPrompt || this.config.customPrompt,
      };
      if (this.config.maxIterations !== undefined) {
        options.maxIterations = this.config.maxIterations;
      }

      // Enable tracing in debug mode for better diagnostics
      // This uses SimpleTelemetry for lightweight tracing
      let traceFilePath = '';
      let telemetryConfig: unknown = null;
      let probeFileTracer: unknown = null;
      if (this.config.debug) {
        const tracerResult = await initializeTracer(sessionId, _checkName);
        if (tracerResult) {
          probeFileTracer = tracerResult.tracer;
          telemetryConfig = tracerResult.telemetryConfig;
          traceFilePath = tracerResult.filePath;
        }
      }
      options.tracer = createProbeTracerAdapter(probeFileTracer);

      // Wire MCP configuration when provided
      if (this.config.mcpServers && Object.keys(this.config.mcpServers).length > 0) {
        (options as any).enableMcp = true;
        (options as any).mcpConfig = { mcpServers: this.config.mcpServers };
      }

      // Enable delegate tool if configured
      if (this.config.enableDelegate !== undefined) {
        (options as any).enableDelegate = this.config.enableDelegate;
      }

      // Enable task management if configured
      if (this.config.enableTasks !== undefined) {
        (options as any).enableTasks = this.config.enableTasks;
      }

      // Pass retry configuration to ProbeAgent
      if (this.config.retry) {
        (options as any).retry = this.config.retry;
      }

      // Pass fallback configuration to ProbeAgent
      if (this.config.fallback) {
        (options as any).fallback = this.config.fallback;
      }

      // Enable Edit and Create tools if configured
      if (this.config.allowEdit !== undefined) {
        (options as any).allowEdit = this.config.allowEdit;
      }

      // Pass tool filtering options to ProbeAgent (native in rc168+)
      if (this.config.allowedTools !== undefined) {
        options.allowedTools = this.config.allowedTools;
        log(`🔧 Setting allowedTools: ${JSON.stringify(this.config.allowedTools)}`);
      }
      if (this.config.disableTools !== undefined) {
        options.disableTools = this.config.disableTools;
        log(`🔧 Setting disableTools: ${this.config.disableTools}`);
      }

      // Pass bash command execution configuration to ProbeAgent
      // Pass enableBash and bashConfig separately (following allowEdit pattern)
      // Note: Probe expects 'enableBash' property, not 'allowBash'
      if (this.config.allowBash !== undefined) {
        (options as any).enableBash = this.config.allowBash;
      }
      if (this.config.bashConfig !== undefined) {
        (options as any).bashConfig = this.config.bashConfig;
      }

      // Pass completion prompt for post-completion validation/review
      if (this.config.completionPrompt !== undefined) {
        (options as any).completionPrompt = this.config.completionPrompt;
      }

      // Pass shared concurrency limiter for global AI call gating
      if (this.config.concurrencyLimiter) {
        (options as any).concurrencyLimiter = this.config.concurrencyLimiter;
      }

      // Propagate workspace / allowed folders to ProbeAgent so that tools
      // operate inside the isolated workspace and project checkouts instead
      // of the Visor repository root.
      try {
        const cfgAny: any = this.config as any;
        const allowedFolders = cfgAny.allowedFolders as string[] | undefined;
        const preferredPath =
          cfgAny.workspacePath ||
          (Array.isArray(allowedFolders) && allowedFolders.length > 0
            ? allowedFolders[0]
            : undefined) ||
          cfgAny.path;
        if (Array.isArray(allowedFolders) && allowedFolders.length > 0) {
          (options as any).allowedFolders = allowedFolders;
          if (!options.path && preferredPath) {
            (options as any).path = preferredPath;
          }
          log(`🗂️ ProbeAgent workspace config:`);
          log(`   path (cwd): ${(options as any).path}`);
          log(`   allowedFolders[0]: ${allowedFolders[0]}`);
        } else if (preferredPath) {
          (options as any).path = preferredPath;
          log(`🗂️ ProbeAgent path: ${preferredPath} (no allowedFolders)`);
        }
      } catch {
        // Best-effort only; fall back to ProbeAgent defaults on error.
      }

      // Add provider-specific options if configured
      if (this.config.provider) {
        // Map claude-code to anthropic for ProbeAgent compatibility
        // Map bedrock to anthropic temporarily until ProbeAgent adds bedrock type
        const providerOverride: ProbeAgentOptions['provider'] | undefined =
          this.config.provider === 'claude-code' || this.config.provider === 'bedrock'
            ? 'anthropic'
            : this.config.provider === 'anthropic' ||
                this.config.provider === 'openai' ||
                this.config.provider === 'google'
              ? this.config.provider
              : undefined;

        if (providerOverride) {
          options.provider = providerOverride;
        }
      }
      if (this.config.model) {
        options.model = this.config.model;
      }

      const agent = new ProbeAgent(options);

      // Initialize agent to enable CLI fallback detection (claude-code/codex)
      // This must be called before agent.answer() for auto-fallback to work.
      // Newer ProbeAgent versions may not expose initialize(); guard to avoid crash.
      if (typeof (agent as any).initialize === 'function') {
        await (agent as any).initialize();
      }

      log('🚀 Calling ProbeAgent...');
      // Load and pass the actual schema content if provided (skip for plain schema)
      let schemaString: string | undefined = undefined;
      let effectiveSchema: string | undefined = typeof schema === 'object' ? 'custom' : schema;

      if (schema && schema !== 'plain') {
        try {
          schemaString = await this.loadSchemaContent(schema);
          log(`📋 Loaded schema content for: ${schema}`);
          log(`📄 Raw schema JSON:\n${schemaString}`);
        } catch (error) {
          log(`⚠️ Failed to load schema ${schema}, proceeding without schema:`, error);
          schemaString = undefined;
          effectiveSchema = undefined; // Schema loading failed, treat as no schema
          if (debugInfo && debugInfo.errors) {
            debugInfo.errors.push(`Failed to load schema: ${error}`);
          }
        }
      } else if (schema === 'plain') {
        log(`📋 Using plain schema - no JSON validation will be applied`);
      }

      // ProbeAgent now handles schema formatting internally!
      // Pass schema in options object with 'schema' property
      const schemaOptions = schemaString ? { schema: schemaString } : undefined;

      // Store the exact schema options being passed to ProbeAgent in debug info
      if (debugInfo && schemaOptions) {
        debugInfo.schema = JSON.stringify(schemaOptions, null, 2);
      }

      // Log the schema options being passed to ProbeAgent
      if (schemaOptions) {
        log(`🎯 Schema options passed to ProbeAgent.answer():`);
        log(JSON.stringify(schemaOptions, null, 2));
      }

      // Log the equivalent CLI command for local reproduction
      const provider = this.config.provider || 'auto';
      const model = this.config.model || 'default';

      // Save prompt to a temp file AND debug artifacts for easier reproduction (only if debug enabled)
      if (process.env.VISOR_DEBUG_AI_SESSIONS === 'true') {
        try {
          const fs = require('fs');
          const path = require('path');
          const os = require('os');
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

          // Prepare debug info with full details
          const debugData = {
            timestamp,
            checkName: _checkName || 'unknown',
            provider,
            model,
            schema: effectiveSchema,
            schemaOptions: schemaOptions || 'none',
            sessionInfo: {
              isSessionReuse: false,
              isNewSession: true,
            },
            promptLength: prompt.length,
            prompt: prompt,
          };

          const debugJson = JSON.stringify(debugData, null, 2);

          // Create human-readable version with clear separators
          let readableVersion = `=============================================================\n`;
          readableVersion += `VISOR DEBUG REPORT - NEW SESSION\n`;
          readableVersion += `=============================================================\n`;
          readableVersion += `Timestamp: ${timestamp}\n`;
          readableVersion += `Check Name: ${_checkName || 'unknown'}\n`;
          readableVersion += `Provider: ${provider}\n`;
          readableVersion += `Model: ${model}\n`;
          readableVersion += `Schema: ${effectiveSchema}\n`;
          readableVersion += `Schema Options: ${schemaOptions ? 'provided' : 'none'}\n`;
          readableVersion += `Session Type: New Session (no history)\n`;
          readableVersion += `=============================================================\n\n`;

          // Add schema details if provided
          if (schemaOptions) {
            readableVersion += `\n${'='.repeat(60)}\n`;
            readableVersion += `SCHEMA CONFIGURATION\n`;
            readableVersion += `${'='.repeat(60)}\n`;
            readableVersion += JSON.stringify(schemaOptions, null, 2);
            readableVersion += `\n`;
          }

          // Add prompt
          readableVersion += `\n${'='.repeat(60)}\n`;
          readableVersion += `PROMPT\n`;
          readableVersion += `${'='.repeat(60)}\n`;
          readableVersion += `Length: ${prompt.length} characters\n`;
          readableVersion += `${'-'.repeat(60)}\n`;
          readableVersion += `${prompt}\n`;
          readableVersion += `\n${'='.repeat(60)}\n`;
          readableVersion += `END OF DEBUG REPORT\n`;
          readableVersion += `${'='.repeat(60)}\n`;

          // Save to temp directory
          const tempDir = os.tmpdir();
          const promptFile = path.join(tempDir, `visor-prompt-${timestamp}.txt`);
          fs.writeFileSync(promptFile, prompt, 'utf-8');
          log(`\n💾 Prompt saved to: ${promptFile}`);

          // Also save to debug-artifacts directory if available
          const debugArtifactsDir =
            process.env.VISOR_DEBUG_ARTIFACTS || path.join(process.cwd(), 'debug-artifacts');
          try {
            // do not enforce fs permissions here
            const base = path.join(
              debugArtifactsDir,
              `prompt-${_checkName || 'unknown'}-${timestamp}`
            );
            fs.writeFileSync(base + '.json', debugJson, 'utf-8');
            fs.writeFileSync(base + '.summary.txt', readableVersion, 'utf-8');
            log(`
💾 Full debug info saved to directory: ${debugArtifactsDir}`);
          } catch {
            // Ignore if we can't write to debug-artifacts
          }

          log(`\n📝 To reproduce locally, run:`);

          let cliCommand = `npx @probelabs/probe@latest agent`;
          cliCommand += ` --provider ${provider}`;
          if (model !== 'default') {
            cliCommand += ` --model ${model}`;
          }
          if (schema) {
            cliCommand += ` --schema output/${schema}/schema.json`;
          }
          cliCommand += ` "${promptFile}"`;

          log(`\n$ ${cliCommand}\n`);
        } catch (error) {
          log(`⚠️ Could not save prompt file: ${error}`);
        }
      }

      // Wrap the agent.answer() call in a span for hierarchical tracing
      // This creates a parent span that will contain all ProbeAgent's child spans
      let response: string;
      const tracer = options.tracer as {
        withSpan?: (
          name: string,
          fn: () => Promise<string>,
          attrs?: Record<string, unknown>
        ) => Promise<string>;
      };
      if (tracer && typeof tracer.withSpan === 'function') {
        response = await tracer.withSpan(
          'visor.ai_check',
          async () => {
            return await agent.answer(prompt, undefined, schemaOptions);
          },
          {
            'check.name': _checkName || 'unknown',
            'check.session_id': sessionId,
            'prompt.length': prompt.length,
            'schema.type': effectiveSchema || 'none',
          }
        );
      } else {
        response = schemaOptions
          ? await agent.answer(prompt, undefined, schemaOptions)
          : await agent.answer(prompt);
      }

      log('✅ ProbeAgent completed successfully');
      log(`📤 Response length: ${response.length} characters`);

      // Save COMPLETE conversation history AFTER AI response (only if debug enabled)
      if (process.env.VISOR_DEBUG_AI_SESSIONS === 'true') {
        try {
          const fs = require('fs');
          const path = require('path');
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

          // Extract FULL conversation history AFTER the AI call
          const agentAny = agent as any;
          let fullHistory: any[] = [];

          // Try multiple properties to get complete history
          if (agentAny.history) {
            fullHistory = agentAny.history;
          } else if (agentAny.messages) {
            fullHistory = agentAny.messages;
          } else if (agentAny._messages) {
            fullHistory = agentAny._messages;
          }

          const debugArtifactsDir =
            process.env.VISOR_DEBUG_ARTIFACTS || path.join(process.cwd(), 'debug-artifacts');
          // do not enforce fs permissions here

          // Save complete session history (all messages sent and received)
          const sessionBase = path.join(
            debugArtifactsDir,
            `session-${_checkName || 'unknown'}-${timestamp}`
          );
          const sessionData = {
            timestamp,
            checkName: _checkName || 'unknown',
            provider: this.config.provider || 'auto',
            model: this.config.model || 'default',
            schema: effectiveSchema,
            totalMessages: fullHistory.length,
          };
          fs.writeFileSync(sessionBase + '.json', JSON.stringify(sessionData, null, 2), 'utf-8');

          // Redacted textual summary
          let readable = `=============================================================
`;
          readable += `COMPLETE AI SESSION HISTORY (AFTER RESPONSE)
`;
          readable += `=============================================================
`;
          readable += `Timestamp: ${timestamp}
`;
          readable += `Check: ${_checkName || 'unknown'}
`;
          readable += `Total Messages: ${fullHistory.length}
`;
          readable += `=============================================================

`;
          fullHistory.forEach((msg: any, idx: number) => {
            const role = msg.role || 'unknown';
            const content =
              typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
            readable += `
${'='.repeat(60)}
MESSAGE ${idx + 1}/${fullHistory.length}
Role: ${role}
${'='.repeat(60)}
`;
            readable += content + '\n';
          });
          fs.writeFileSync(sessionBase + '.summary.txt', readable, 'utf-8');

          log(`💾 Complete session history saved:`);
          // (paths omitted)
          log(`   - Contains ALL ${fullHistory.length} messages (prompts + responses)`);
        } catch (error) {
          log(`⚠️ Could not save complete session history: ${error}`);
        }
      }

      // Save response if debug is enabled
      if (process.env.VISOR_DEBUG_AI_SESSIONS === 'true') {
        try {
          const fs = require('fs');
          const path = require('path');
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

          const debugArtifactsDir =
            process.env.VISOR_DEBUG_ARTIFACTS || path.join(process.cwd(), 'debug-artifacts');

          // Create a response file
          const responseFile = path.join(
            debugArtifactsDir,
            `response-${_checkName || 'unknown'}-${timestamp}.txt`
          );

          let responseContent = `=============================================================\n`;
          responseContent += `VISOR AI RESPONSE - NEW SESSION\n`;
          responseContent += `=============================================================\n`;
          responseContent += `Timestamp: ${timestamp}\n`;
          responseContent += `Check Name: ${_checkName || 'unknown'}\n`;
          responseContent += `Response Length: ${response.length} characters\n`;
          responseContent += `=============================================================\n\n`;
          responseContent += `${'='.repeat(60)}\n`;
          responseContent += `AI RESPONSE\n`;
          responseContent += `${'='.repeat(60)}\n`;
          responseContent += response;
          responseContent += `\n${'='.repeat(60)}\n`;
          responseContent += `END OF RESPONSE\n`;
          responseContent += `${'='.repeat(60)}\n`;

          fs.writeFileSync(responseFile, responseContent, 'utf-8');
          log(`💾 Response saved to: ${responseFile}`);
        } catch (error) {
          log(`⚠️ Could not save response file: ${error}`);
        }
      }

      // Finalize and save trace if enabled
      // Properly flush and shutdown telemetry to ensure all spans are exported
      if (traceFilePath && telemetryConfig) {
        try {
          // Cast telemetryConfig to have optional methods
          const telemetry = telemetryConfig as {
            flush?: () => Promise<void>;
            shutdown?: () => Promise<void>;
          };
          const tracerWithMethods = tracer as {
            flush?: () => Promise<void>;
            shutdown?: () => Promise<void>;
          };

          // First flush the tracer to export pending spans
          if (tracerWithMethods && typeof tracerWithMethods.flush === 'function') {
            await tracerWithMethods.flush();
            log(`🔄 Flushed tracer spans`);
          }

          // Then shutdown the telemetry config to finalize all exporters
          if (telemetry && typeof telemetry.shutdown === 'function') {
            await telemetry.shutdown();
            log(`📊 OpenTelemetry trace saved to: ${traceFilePath}`);

            // In GitHub Actions, also log file size for verification
            if (process.env.GITHUB_ACTIONS) {
              const fs = require('fs');
              if (fs.existsSync(traceFilePath)) {
                const stats = fs.statSync(traceFilePath);
                console.log(
                  `::notice title=AI Trace Saved::OpenTelemetry trace file size: ${stats.size} bytes`
                );
              }
            }
          } else if (tracerWithMethods && typeof tracerWithMethods.shutdown === 'function') {
            // Fallback for SimpleTelemetry
            await tracerWithMethods.shutdown();
            log(`📊 Trace saved to: ${traceFilePath}`);
          }
        } catch (exportError) {
          logger.warn(`⚠️  Warning: Failed to export trace: ${exportError}`);
        }
      }

      // Register the session for potential reuse by dependent checks
      if (_checkName) {
        // ProbeAgent.clone() will handle history filtering when this session is cloned
        this.registerSession(sessionId, agent);
        log(`🔧 Debug: Registered AI session for potential reuse: ${sessionId}`);
      }

      return { response, effectiveSchema, sessionId };
    } catch (error) {
      console.error('❌ ProbeAgent failed:', error);
      throw new Error(
        `ProbeAgent execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } finally {
      // Restore original environment variables
      Object.keys(originalEnv).forEach(key => {
        if (originalEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalEnv[key];
        }
      });
    }
  }

  /**
   * Load schema content from schema files or inline definitions
   */
  private async loadSchemaContent(schema: string | Record<string, unknown>): Promise<string> {
    const fs = require('fs').promises;
    const path = require('path');

    // Check if schema is already an object (inline definition from YAML)
    if (typeof schema === 'object' && schema !== null) {
      // It's already a schema object, convert to JSON string
      log('📋 Using inline schema object from configuration');
      return JSON.stringify(schema);
    }

    // Check if schema string is already a JSON schema (inline JSON string)
    // This happens when a schema is passed directly as JSON instead of a reference
    try {
      const parsed = JSON.parse(schema);
      if (typeof parsed === 'object' && parsed !== null) {
        // It's already a valid JSON schema, return it as-is
        log('📋 Using inline schema JSON string');
        return schema;
      }
    } catch {
      // Not JSON, treat as schema name reference or file path
    }

    // Check if it's a file path (starts with ./ or contains .json but not absolute paths)
    if ((schema.startsWith('./') || schema.includes('.json')) && !path.isAbsolute(schema)) {
      // It's a relative file path to a custom schema
      // Validate the path to prevent traversal attacks
      if (schema.includes('..') || schema.includes('\x00')) {
        throw new Error('Invalid schema path: path traversal not allowed');
      }

      try {
        const schemaPath = path.resolve(process.cwd(), schema);
        log(`📋 Loading custom schema from file: ${schemaPath}`);
        const schemaContent = await fs.readFile(schemaPath, 'utf-8');
        return schemaContent.trim();
      } catch (error) {
        throw new Error(
          `Failed to load custom schema from ${schema}: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }

    // Otherwise, treat as a built-in schema name
    // Sanitize schema name to prevent path traversal attacks
    const sanitizedSchemaName = schema.replace(/[^a-zA-Z0-9-]/g, '');
    if (!sanitizedSchemaName || sanitizedSchemaName !== schema) {
      throw new Error('Invalid schema name');
    }

    // Built-in schemas are bundled under dist/output when running as a GitHub Action.
    // In local dev (ts-node/jest), schemas may live under project/output.
    // Try dist-relative first, then fall back to CWD.
    const candidatePaths = [
      // GitHub Action bundle location
      path.join(__dirname, 'output', sanitizedSchemaName, 'schema.json'),
      // Historical fallback when src/output was inadvertently bundled as output1/
      path.join(__dirname, 'output1', sanitizedSchemaName, 'schema.json'),
      // Local dev (repo root)
      path.join(process.cwd(), 'output', sanitizedSchemaName, 'schema.json'),
    ];

    for (const schemaPath of candidatePaths) {
      try {
        const schemaContent = await fs.readFile(schemaPath, 'utf-8');
        return schemaContent.trim();
      } catch {
        // try next
      }
    }

    // If neither path works, surface a helpful error
    const distPath = path.join(__dirname, 'output', sanitizedSchemaName, 'schema.json');
    const distAltPath = path.join(__dirname, 'output1', sanitizedSchemaName, 'schema.json');
    const cwdPath = path.join(process.cwd(), 'output', sanitizedSchemaName, 'schema.json');
    throw new Error(
      `Failed to load schema '${sanitizedSchemaName}'. Tried: ${distPath}, ${distAltPath}, and ${cwdPath}. ` +
        `Ensure build copies 'output/' into dist (build:cli), or provide a custom schema file/path.`
    );
  }

  /**
   * Parse AI response JSON
   */
  private parseAIResponse(
    response: string,
    debugInfo?: AIDebugInfo,
    _schema?: string
  ): ReviewSummary & { output?: unknown } {
    log('🔍 Parsing AI response...');
    log(`📊 Raw response length: ${response.length} characters`);

    // Log first and last 200 chars for debugging
    if (response.length > 400) {
      log('📋 Response preview (first 200 chars):', response.substring(0, 200));
      log('📋 Response preview (last 200 chars):', response.substring(response.length - 200));
    } else {
      log('📋 Full response preview:', response);
    }

    // Note: Removed overly aggressive Liquid template check that was causing false positives
    // JSON parsing below will catch actual malformed responses

    try {
      // Handle different schema types differently
      let reviewData: AIResponseFormat;

      // Handle plain schema or no schema - no JSON parsing, treat as assistant-style text output
      if (_schema === 'plain' || !_schema) {
        log(
          `📋 ${_schema === 'plain' ? 'Plain' : 'No'} schema detected - treating raw response as text output`
        );

        // For plain schema / no schema, return the raw response as a text-like output
        // instead of a synthetic AI_RESPONSE issue. This is more natural for chat-style
        // integrations (Slack, GitHub comments, CLI assistant mode).
        const trimmed = typeof response === 'string' ? response.trim() : '';
        const out: any = trimmed ? { text: trimmed } : {};

        return {
          issues: [],
          // Expose assistant-style content via output.text so downstream formatters
          // (Slack frontend, CLI "Assistant Response" section, templates) can render it.
          output: out,
          debug: debugInfo,
        };
      }

      {
        // For other schemas (code-review, etc.), extract and parse JSON with boundary detection
        log('🔍 Extracting JSON from AI response...');

        // Sanitize response: strip BOM, zero-width chars, and other invisible characters
        // that can cause JSON parsing to fail even when the text looks valid
        const sanitizedResponse = response
          .replace(/^\uFEFF/, '') // BOM
          .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '') // Zero-width chars, NBSP
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Control chars (except \t \n \r)
          .trim();

        // Try direct JSON parsing - no bracket-matching extraction
        // JSON validation is offloaded to Probe agent when schema is provided
        try {
          reviewData = JSON.parse(sanitizedResponse);
          log('✅ Successfully parsed direct JSON response');
          if (debugInfo) debugInfo.jsonParseSuccess = true;
        } catch (parseErr) {
          const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          log(`🔍 Direct JSON parsing failed: ${errMsg}`);

          // If the response indicates refusal, return it as plain text output
          if (
            response.toLowerCase().includes('i cannot') ||
            response.toLowerCase().includes('unable to')
          ) {
            console.error('🚫 AI refused to analyze - returning refusal as output');
            const trimmed = response.trim();
            return {
              issues: [],
              output: trimmed ? { text: trimmed } : {},
              debug: debugInfo,
            };
          }

          // Not valid JSON - treat entire response as text output
          // This allows Probe (or other AI providers) to handle JSON validation
          // and avoids false positives from bracket-matching (e.g., mermaid diagrams)
          log('🔧 Treating response as plain text (no JSON extraction)');
          const trimmed = response.trim();
          return {
            issues: [],
            output: { text: trimmed },
            debug: debugInfo,
          };
        }
      }

      // Decide how to interpret the parsed JSON based on the effective schema and the shape of data
      // Built-ins:
      //  - 'code-review' → expects { issues: [...] }
      //  - 'overview' / assistants → expects { text: string, ... }
      //  - 'plain' → handled earlier
      //  - custom (object/file path) → free-form object, ensure output.text fallback
      const looksLikeTextOutput =
        reviewData &&
        typeof reviewData === 'object' &&
        typeof (reviewData as any).text === 'string' &&
        String((reviewData as any).text).trim().length > 0;

      // Treat as custom/text-style when:
      //  - explicit custom schema
      //  - schema is any non code-review built-in like 'overview', 'issue-assistant', 'comment-assistant'
      //  - or schema is unknown/undefined but the payload clearly contains a text field
      const isCustomSchema =
        _schema === 'custom' ||
        (_schema && (_schema.startsWith('./') || _schema.endsWith('.json'))) ||
        (_schema && _schema !== 'code-review' && !_schema.includes('output/')) ||
        (!_schema && looksLikeTextOutput);

      const _debugSchemaLogging =
        this.config.debug === true || process.env.VISOR_DEBUG_AI_SESSIONS === 'true';
      if (_debugSchemaLogging) {
        const details = {
          schema: _schema,
          isCustomSchema,
          isCustomLiteral: _schema === 'custom',
          startsWithDotSlash: typeof _schema === 'string' ? _schema.startsWith('./') : false,
          endsWithJson: typeof _schema === 'string' ? _schema.endsWith('.json') : false,
          notCodeReview: _schema !== 'code-review',
          noOutputPrefix: typeof _schema === 'string' ? !_schema.includes('output/') : false,
        };
        try {
          log(`🔍 Schema detection: ${JSON.stringify(details)}`);
        } catch {
          // Fallback if JSON.stringify throws on unexpected values
          log(
            `🔍 Schema detection: _schema="${String(_schema)}", isCustomSchema=${isCustomSchema}`
          );
        }
      }

      if (isCustomSchema) {
        // For custom schemas, preserve ALL fields from the parsed JSON and make sure
        // we always have something renderable in templates (e.g., output.text).
        log('📋 Custom schema detected - preserving all fields from parsed JSON');
        log(`📊 Schema: ${_schema}`);
        try {
          log(`📊 Custom schema keys: ${Object.keys(reviewData).join(', ')}`);
        } catch {}

        // Ensure "output" is an object and has a sensible text fallback for templates
        const out: Record<string, unknown> =
          reviewData && typeof reviewData === 'object' ? (reviewData as any) : ({} as any);

        const hasText =
          typeof (out as any).text === 'string' && String((out as any).text).trim().length > 0;
        if (!hasText) {
          // Build a fallback string from the raw response or issue messages if available
          let fallbackText = '';
          try {
            if (
              Array.isArray((reviewData as any)?.issues) &&
              (reviewData as any).issues.length > 0
            ) {
              // Join issue messages into a readable block
              fallbackText = (reviewData as any).issues
                .map((i: any) => (i && (i.message || i.text || i.response)) as string)
                .filter((s: any) => typeof s === 'string' && s.trim().length > 0)
                .join('\n');
            }
          } catch {}
          if (!fallbackText && typeof response === 'string' && response.trim()) {
            // Use raw provider response (trim and bound length for safety)
            fallbackText = response.trim().slice(0, 60000);
          }
          if (fallbackText) {
            (out as any).text = fallbackText;
          }
        }

        const result: ReviewSummary & { output?: unknown } = {
          // Keep issues empty for custom-schema rendering; consumers read from output.*
          issues: [],
          output: out,
        };

        log(
          '✅ Successfully created ReviewSummary with custom schema output (with fallback text when needed)'
        );
        return result;
      }

      // Standard code-review schema processing (only when schema is explicitly code-review
      // or when the payload clearly has an issues array)
      log('🔍 Validating parsed review data...');
      log(`📊 Overall score: ${0}`);
      log(`📋 Total issues: ${reviewData.issues?.length || 0}`);
      log(
        `🚨 Critical issues: ${reviewData.issues?.filter((i: { severity?: string }) => i.severity === 'critical').length || 0}`
      );
      log(`💬 Comments count: ${Array.isArray(reviewData.issues) ? reviewData.issues.length : 0}`);

      // Process issues from the simplified format; if we don't have issues and the
      // data looks like a text-style output, route through the custom path above.
      const processedIssues = Array.isArray((reviewData as any).issues)
        ? (reviewData as any).issues.map((issue: any, index: number) => {
            log(`🔍 Processing issue ${index + 1}:`, issue);
            return {
              file: issue.file || 'unknown',
              line: issue.line || 1,
              endLine: issue.endLine,
              ruleId: issue.ruleId || `${issue.category || 'general'}/unknown`,
              message: issue.message || '',
              severity: issue.severity,
              category: issue.category,
              suggestion: issue.suggestion,
              replacement: issue.replacement,
            } as ReviewIssue;
          })
        : [];

      // Validate and convert to ReviewSummary format
      const result: ReviewSummary = {
        issues: processedIssues,
      };

      // Log issue counts
      const criticalCount = (result.issues || []).filter(i => i.severity === 'critical').length;
      if (criticalCount > 0) {
        log(`🚨 Found ${criticalCount} critical severity issue(s)`);
      }
      log(`📈 Total issues: ${(result.issues || []).length}`);

      log('✅ Successfully created ReviewSummary');
      return result;
    } catch (error) {
      const detailed = this.config.debug === true || process.env.VISOR_DEBUG_AI_SESSIONS === 'true';
      const message = error instanceof Error ? error.message : String(error);

      if (detailed) {
        logger.debug(`❌ Failed to parse AI response: ${message}`);
        logger.debug('📄 FULL RAW RESPONSE:');
        logger.debug('='.repeat(80));
        logger.debug(response);
        logger.debug('='.repeat(80));
        logger.debug(`📏 Response length: ${response.length} characters`);

        if (error instanceof SyntaxError) {
          logger.debug('🔍 JSON parsing error - the response may not be valid JSON');
          logger.debug(`🔍 Error details: ${error.message}`);

          const errorMatch = error.message.match(/position (\d+)/);
          if (errorMatch) {
            const position = parseInt(errorMatch[1]);
            logger.debug(`🔍 Error at position ${position}:`);
            const start = Math.max(0, position - 50);
            const end = Math.min(response.length, position + 50);
            logger.debug(`🔍 Context: "${response.substring(start, end)}"`);
            logger.debug(`🔍 Response beginning: "${response.substring(0, 100)}"`);
          }

          if (response.includes('I cannot')) {
            logger.debug('🔍 Response appears to be a refusal/explanation rather than JSON');
          }
          if (response.includes('```')) {
            logger.debug('🔍 Response appears to contain markdown code blocks');
          }
          if (response.startsWith('<')) {
            logger.debug('🔍 Response appears to start with XML/HTML');
          }
        }
      } else {
        logger.error(`❌ Failed to parse AI response: ${message}`);
      }

      throw new Error(
        `Invalid AI response format: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Generate mock response for testing
   */
  private async generateMockResponse(
    _prompt: string,
    _checkName?: string,
    _schema?: string | Record<string, unknown>
  ): Promise<string> {
    // Simulate some processing time
    await new Promise(resolve => setTimeout(resolve, 500));

    // Schema-accurate mocks for default flows
    const name = (_checkName || '').toLowerCase();
    if (name.includes('extract-facts')) {
      const arr = Array.from({ length: 6 }, (_, i) => ({
        id: `fact-${i + 1}`,
        category: 'Feature',
        claim: `claim-${i + 1}`,
        verifiable: true,
        refs: [{ path: 'src/check-execution-engine.ts', lines: '6400-6460' }],
      }));
      return JSON.stringify(arr);
    }
    if (name.includes('validate-fact')) {
      const idMatch = _prompt.match(/Fact ID:\s*([\w\-]+)/i);
      const claimMatch = _prompt.match(/\*\*Claim:\*\*\s*(.+)/i);
      const attemptMatch = _prompt.match(/Attempt:\s*(\d+)/i);
      const factId = idMatch ? idMatch[1] : 'fact-1';
      const claim = claimMatch ? claimMatch[1].trim() : 'unknown-claim';
      const n = Number(factId.split('-')[1] || '0');
      const attempt = attemptMatch ? Number(attemptMatch[1]) : 0;
      const isValid = attempt >= 1 ? true : !(n >= 1 && n <= 3);
      return JSON.stringify({
        fact_id: factId,
        claim,
        is_valid: isValid,
        confidence: 'high',
        evidence: isValid ? 'verified' : 'not found',
        correction: isValid ? null : `correct ${claim}`,
      });
    }
    if (name.includes('issue-assistant') || name.includes('comment-assistant')) {
      const text = '### Assistant Reply';
      const intent = name.includes('issue') ? 'issue_triage' : 'comment_reply';
      return JSON.stringify({ text, intent });
    }
    // Fallback
    const mockResponse = { content: JSON.stringify({ issues: [], summary: { totalIssues: 0 } }) };
    return JSON.stringify(mockResponse);
  }

  /**
   * Get the API key source for debugging (without revealing the key)
   */
  private getApiKeySource(): string {
    if (process.env.CLAUDE_CODE_API_KEY && this.config.provider === 'claude-code') {
      return 'CLAUDE_CODE_API_KEY';
    }
    if (process.env.GOOGLE_API_KEY && this.config.provider === 'google') {
      return 'GOOGLE_API_KEY';
    }
    if (process.env.ANTHROPIC_API_KEY && this.config.provider === 'anthropic') {
      return 'ANTHROPIC_API_KEY';
    }
    if (process.env.OPENAI_API_KEY && this.config.provider === 'openai') {
      return 'OPENAI_API_KEY';
    }
    if (this.config.provider === 'bedrock') {
      if (process.env.AWS_BEDROCK_API_KEY) {
        return 'AWS_BEDROCK_API_KEY';
      }
      if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
        return 'AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY';
      }
    }
    return 'unknown';
  }
}
