import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import { AIReviewService, AIReviewConfig } from '../ai-review-service';
import { EnvironmentResolver } from '../utils/env-resolver';
import { IssueFilter } from '../issue-filter';
import { Liquid } from 'liquidjs';
import { createExtendedLiquid } from '../liquid-extensions';
import fs from 'fs/promises';
import path from 'path';
import { trace, context as otContext } from '../telemetry/lazy-otel';
import {
  captureCheckInputContext,
  captureCheckOutput,
  captureProviderCall,
} from '../telemetry/state-capture';

/**
 * AI-powered check provider using probe agent
 */
export class AICheckProvider extends CheckProvider {
  private aiReviewService: AIReviewService;
  private liquidEngine: Liquid;

  constructor() {
    super();
    this.aiReviewService = new AIReviewService();
    this.liquidEngine = createExtendedLiquid();
  }

  getName(): string {
    return 'ai';
  }

  getDescription(): string {
    return 'AI-powered code review using Google Gemini, Anthropic Claude, OpenAI GPT, or AWS Bedrock models';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    if (!config || typeof config !== 'object') {
      return false;
    }

    const cfg = config as CheckProviderConfig;

    // Type must be 'ai'
    if (cfg.type !== 'ai') {
      return false;
    }

    // Check for prompt or focus
    const prompt = cfg.prompt || cfg.focus;
    if (typeof prompt !== 'string') {
      return false;
    }

    // Focus is now config-driven - any string value is acceptable
    // No validation needed here as focus is just a hint to the AI

    // Validate AI provider config if present
    if (cfg.ai) {
      if (
        cfg.ai.provider &&
        !['google', 'anthropic', 'openai', 'bedrock', 'mock'].includes(cfg.ai.provider as string)
      ) {
        return false;
      }

      // Validate mcpServers if present
      if (cfg.ai.mcpServers) {
        if (!this.validateMcpServers(cfg.ai.mcpServers)) {
          return false;
        }
      }
    }

    // Validate check-level MCP servers if present
    const checkLevelMcpServers = (cfg as CheckProviderConfig & { ai_mcp_servers?: unknown })
      .ai_mcp_servers;
    if (checkLevelMcpServers) {
      if (!this.validateMcpServers(checkLevelMcpServers)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Validate MCP servers configuration
   */
  private validateMcpServers(mcpServers: unknown): boolean {
    if (typeof mcpServers !== 'object' || mcpServers === null) {
      return false;
    }

    for (const serverConfig of Object.values(mcpServers)) {
      if (!serverConfig || typeof serverConfig !== 'object') {
        return false;
      }
      const config = serverConfig as { command?: unknown; args?: unknown };
      if (typeof config.command !== 'string') {
        return false;
      }
      if (config.args !== undefined && !Array.isArray(config.args)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Group files by their file extension for template context
   */
  private groupFilesByExtension(
    files: import('../pr-analyzer').PRFile[]
  ): Record<string, import('../pr-analyzer').PRFile[]> {
    const grouped: Record<string, import('../pr-analyzer').PRFile[]> = {};

    files.forEach(file => {
      const parts = file.filename.split('.');
      const ext = parts.length > 1 ? parts.pop()?.toLowerCase() || 'noext' : 'noext';
      if (!grouped[ext]) {
        grouped[ext] = [];
      }
      grouped[ext].push(file);
    });

    return grouped;
  }

  /**
   * Process prompt configuration to resolve final prompt string
   */
  private async processPrompt(
    promptConfig: string,
    prInfo: PRInfo,
    eventContext?: Record<string, unknown>,
    dependencyResults?: Map<string, ReviewSummary>,
    outputHistory?: Map<string, unknown[]>
  ): Promise<string> {
    let promptContent: string;

    // Auto-detect if it's a file path or inline content
    if (await this.isFilePath(promptConfig)) {
      promptContent = await this.loadPromptFromFile(promptConfig);
    } else {
      promptContent = promptConfig;
    }

    // Process Liquid templates in the prompt
    return await this.renderPromptTemplate(
      promptContent,
      prInfo,
      eventContext,
      dependencyResults,
      outputHistory
    );
  }

  /**
   * Detect if a string is likely a file path and if the file exists
   */
  private async isFilePath(str: string): Promise<boolean> {
    // Quick checks to exclude obvious non-file-path content
    if (!str || str.trim() !== str || str.length > 512) {
      return false;
    }

    // Exclude strings that are clearly content (contain common content indicators)
    // But be more careful with paths that might contain common words as directory names
    if (
      /\s{2,}/.test(str) || // Multiple consecutive spaces
      /\n/.test(str) || // Contains newlines
      /^(please|analyze|review|check|find|identify|look|search)/i.test(str.trim()) || // Starts with command words
      str.split(' ').length > 8 // Too many words for a typical file path
    ) {
      return false;
    }

    // For strings with path separators, be more lenient about common words
    // as they might be legitimate directory names
    if (!/[\/\\]/.test(str)) {
      // Only apply strict English word filter to non-path strings
      if (/\b(the|and|or|but|for|with|by|from|in|on|at|as)\b/i.test(str)) {
        return false;
      }
    }

    // Positive indicators for file paths
    const hasFileExtension = /\.[a-zA-Z0-9]{1,10}$/i.test(str);
    const hasPathSeparators = /[\/\\]/.test(str);
    const isRelativePath = /^\.{1,2}\//.test(str);
    const isAbsolutePath = path.isAbsolute(str);
    const hasTypicalFileChars = /^[a-zA-Z0-9._\-\/\\:~]+$/.test(str);

    // Must have at least one strong indicator
    if (!(hasFileExtension || isRelativePath || isAbsolutePath || hasPathSeparators)) {
      return false;
    }

    // Must contain only typical file path characters
    if (!hasTypicalFileChars) {
      return false;
    }

    // Additional validation for suspected file paths
    try {
      // Try to resolve and check if file exists
      let resolvedPath: string;

      if (path.isAbsolute(str)) {
        resolvedPath = path.normalize(str);
      } else {
        // Resolve relative to current working directory
        resolvedPath = path.resolve(process.cwd(), str);
      }

      // Check if file exists
      const fs = require('fs').promises;
      try {
        const stat = await fs.stat(resolvedPath);
        return stat.isFile();
      } catch {
        // File doesn't exist, but might still be a valid file path format
        // Return true if it has strong file path indicators
        return hasFileExtension && (isRelativePath || isAbsolutePath || hasPathSeparators);
      }
    } catch {
      return false;
    }
  }

  /**
   * Load prompt content from file with security validation
   */
  private async loadPromptFromFile(promptPath: string): Promise<string> {
    // Enforce .liquid file extension for all prompt files
    if (!promptPath.endsWith('.liquid')) {
      throw new Error('Prompt file must have .liquid extension');
    }

    let resolvedPath: string;

    if (path.isAbsolute(promptPath)) {
      // Absolute path - use as-is
      resolvedPath = promptPath;
    } else {
      // Relative path - resolve relative to current working directory
      resolvedPath = path.resolve(process.cwd(), promptPath);
    }

    // Security: For relative paths, ensure they don't escape the current directory
    if (!path.isAbsolute(promptPath)) {
      const normalizedPath = path.normalize(resolvedPath);
      const currentDir = path.resolve(process.cwd());
      if (!normalizedPath.startsWith(currentDir)) {
        throw new Error('Invalid prompt file path: path traversal detected');
      }
    }

    // Security: Check for obvious path traversal patterns
    if (promptPath.includes('../..')) {
      throw new Error('Invalid prompt file path: path traversal detected');
    }

    try {
      const promptContent = await fs.readFile(resolvedPath, 'utf-8');
      return promptContent;
    } catch (error) {
      throw new Error(
        `Failed to load prompt from ${resolvedPath}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  /**
   * Render Liquid template in prompt with comprehensive event context
   */
  private async renderPromptTemplate(
    promptContent: string,
    prInfo: PRInfo,
    eventContext?: Record<string, unknown>,
    dependencyResults?: Map<string, ReviewSummary>,
    outputHistory?: Map<string, unknown[]>
  ): Promise<string> {
    // Build outputs_raw from -raw keys (aggregate parent values)
    const outputsRaw: Record<string, unknown> = {};
    if (dependencyResults) {
      for (const [k, v] of dependencyResults.entries()) {
        if (typeof k !== 'string') continue;
        if (k.endsWith('-raw')) {
          const name = k.slice(0, -4);
          const summary = v as ReviewSummary & { output?: unknown };
          outputsRaw[name] = summary.output !== undefined ? summary.output : summary;
        }
      }
    }

    // Note: We intentionally do NOT expose any special `fact_validation` object
    // in the template context. Templates should derive everything from
    // outputs / outputs_history / memory helpers to avoid hidden magic.

    // Create comprehensive template context with PR and event information
    const templateContext = {
      // PR Information
      pr: {
        number: prInfo.number,
        title: prInfo.title,
        body: prInfo.body,
        author: prInfo.author,
        baseBranch: prInfo.base,
        headBranch: prInfo.head,
        isIncremental: prInfo.isIncremental,
        filesChanged: prInfo.files?.map(f => f.filename) || [],
        totalAdditions: prInfo.files?.reduce((sum, f) => sum + f.additions, 0) || 0,
        totalDeletions: prInfo.files?.reduce((sum, f) => sum + f.deletions, 0) || 0,
        totalChanges: prInfo.files?.reduce((sum, f) => sum + f.changes, 0) || 0,
        base: prInfo.base,
        head: prInfo.head,
      },

      // File Details
      files: prInfo.files || [],
      description: prInfo.body || '',

      // GitHub Event Context
      event: eventContext
        ? {
            name: eventContext.event_name || 'unknown',
            action: eventContext.action,
            isPullRequest: !prInfo.isIssue, // Set based on whether this is a PR or an issue

            // Repository Info
            repository: eventContext.repository
              ? {
                  owner: (eventContext.repository as { owner?: { login?: string } })?.owner?.login,
                  name: (eventContext.repository as { name?: string })?.name,
                  fullName: eventContext.repository
                    ? `${(eventContext.repository as { owner?: { login?: string } })?.owner?.login}/${(eventContext.repository as { name?: string })?.name}`
                    : undefined,
                }
              : undefined,

            // Comment Data (for comment events)
            comment: eventContext.comment
              ? {
                  body: (eventContext.comment as { body?: string })?.body,
                  author: (eventContext.comment as { user?: { login?: string } })?.user?.login,
                }
              : undefined,

            // Issue Data (for issue events)
            issue: eventContext.issue
              ? {
                  number: (eventContext.issue as { number?: number })?.number,
                  title: (eventContext.issue as { title?: string })?.title,
                  body: (eventContext.issue as { body?: string })?.body,
                  state: (eventContext.issue as { state?: string })?.state,
                  author: (eventContext.issue as { user?: { login?: string } })?.user?.login,
                  labels: (eventContext.issue as { labels?: unknown[] })?.labels || [],
                  assignees:
                    (
                      eventContext as { issue?: { assignees?: Array<{ login: string }> } }
                    )?.issue?.assignees?.map(a => a.login) || [],
                  createdAt: (eventContext.issue as { created_at?: string })?.created_at,
                  updatedAt: (eventContext.issue as { updated_at?: string })?.updated_at,
                  isPullRequest: !!(eventContext.issue as { pull_request?: unknown })?.pull_request,
                }
              : undefined,

            // Pull Request Event Data
            pullRequest: eventContext.pull_request
              ? {
                  number: (eventContext.pull_request as { number?: number })?.number,
                  state: (eventContext.pull_request as { state?: string })?.state,
                  draft: (eventContext.pull_request as { draft?: boolean })?.draft,
                  headSha: (eventContext.pull_request as { head?: { sha?: string } })?.head?.sha,
                  headRef: (eventContext.pull_request as { head?: { ref?: string } })?.head?.ref,
                  baseSha: (eventContext.pull_request as { base?: { sha?: string } })?.base?.sha,
                  baseRef: (eventContext.pull_request as { base?: { ref?: string } })?.base?.ref,
                }
              : undefined,

            // Raw event payload for advanced use cases
            payload: eventContext,
          }
        : undefined,

      // Utility data for templates
      utils: {
        // Date/time helpers
        now: new Date().toISOString(),
        today: new Date().toISOString().split('T')[0],

        // Dynamic file grouping by extension
        filesByExtension: this.groupFilesByExtension(prInfo.files || []),

        // File status categorizations
        addedFiles: (prInfo.files || []).filter(f => f.status === 'added'),
        modifiedFiles: (prInfo.files || []).filter(f => f.status === 'modified'),
        removedFiles: (prInfo.files || []).filter(f => f.status === 'removed'),
        renamedFiles: (prInfo.files || []).filter(f => f.status === 'renamed'),

        // Change analysis
        hasLargeChanges: (prInfo.files || []).some(f => f.changes > 50),
        totalFiles: (prInfo.files || []).length,
      },

      // Previous check outputs (dependency results)
      // Expose raw output directly if available, otherwise expose the result as-is
      outputs: dependencyResults
        ? Object.fromEntries(
            Array.from(dependencyResults.entries()).map(([checkName, result]) => [
              checkName,
              (() => {
                const summary = result as ReviewSummary & { output?: unknown };
                return summary.output !== undefined ? summary.output : summary;
              })(),
            ])
          )
        : {},
      // Alias for consistency with other providers
      outputs_history: (() => {
        const hist: Record<string, unknown[]> = {};
        if (outputHistory) {
          for (const [k, v] of outputHistory.entries()) hist[k] = v;
        }
        return hist;
      })(),
      // Stage-scoped history slice calculated from baseline captured by the flow runner.
      outputs_history_stage: (() => {
        const stage: Record<string, unknown[]> = {};
        try {
          const base = (eventContext as any)?.__stageHistoryBase as
            | Record<string, number>
            | undefined;
          if (!outputHistory || !base) return stage;
          for (const [k, v] of outputHistory.entries()) {
            const start = base[k] || 0;
            const arr = Array.isArray(v) ? (v as unknown[]) : [];
            stage[k] = arr.slice(start);
          }
        } catch {}
        return stage;
      })(),
      // New: outputs_raw exposes aggregate values (e.g., full arrays for forEach parents)
      outputs_raw: outputsRaw,
    };

    try {
      if (process.env.VISOR_DEBUG === 'true') {
        console.error(
          `[prompt-ctx] outputs.keys=${Object.keys((templateContext as any).outputs || {}).join(', ')} hist.validate-fact.len=${(() => {
            try {
              const h = (templateContext as any).outputs_history || {};
              const v = h['validate-fact'];
              return Array.isArray(v) ? v.length : 0;
            } catch {
              return 0;
            }
          })()}`
        );
      }
    } catch {}

    try {
      return await this.liquidEngine.parseAndRender(promptContent, templateContext);
    } catch (error) {
      try {
        if (process.env.VISOR_DEBUG === 'true') {
          const lines = promptContent.split(/\r?\n/);
          const preview = lines
            .slice(0, 20)
            .map((l, i) => `${(i + 1).toString().padStart(3, ' ')}| ${l}`)
            .join('\n');
          try {
            process.stderr.write(
              '[prompt-error] First 20 lines of prompt before Liquid render:\n' + preview + '\n'
            );
          } catch {}
        }
      } catch {}
      throw new Error(
        `Failed to render prompt template: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  async execute(
    prInfo: PRInfo,
    config: CheckProviderConfig,
    _dependencyResults?: Map<string, ReviewSummary>,
    sessionInfo?: { parentSessionId?: string; reuseSession?: boolean }
  ): Promise<ReviewSummary> {
    // Apply environment configuration if present
    if (config.env) {
      const result = EnvironmentResolver.withTemporaryEnv(config.env, () => {
        // This will be executed with the temporary environment
        return this.executeWithConfig(prInfo, config, _dependencyResults, sessionInfo);
      });

      if (result instanceof Promise) {
        return result;
      }
      return result;
    }

    return this.executeWithConfig(prInfo, config, _dependencyResults, sessionInfo);
  }

  private async executeWithConfig(
    prInfo: PRInfo,
    config: CheckProviderConfig,
    _dependencyResults?: Map<string, ReviewSummary>,
    sessionInfo?: {
      parentSessionId?: string;
      reuseSession?: boolean;
    } & import('./check-provider.interface').ExecutionContext
  ): Promise<ReviewSummary> {
    try {
      if (process.env.VISOR_DEBUG === 'true') {
        console.error(`[ai-exec] step=${String((config as any).checkName || 'unknown')}`);
      }
    } catch {}
    // Extract AI configuration - only set properties that are explicitly provided
    const aiConfig: AIReviewConfig = {};

    // Check-level AI configuration (ai object)
    if (config.ai) {
      // Only set properties that are actually defined to avoid overriding env vars
      if (config.ai.apiKey !== undefined) {
        aiConfig.apiKey = config.ai.apiKey as string;
      }
      if (config.ai.model !== undefined) {
        aiConfig.model = config.ai.model as string;
      }
      if (config.ai.timeout !== undefined) {
        aiConfig.timeout = config.ai.timeout as number;
      }
      if (config.ai.provider !== undefined) {
        aiConfig.provider = config.ai.provider as
          | 'google'
          | 'anthropic'
          | 'openai'
          | 'bedrock'
          | 'mock';
      }
      if (config.ai.debug !== undefined) {
        aiConfig.debug = config.ai.debug as boolean;
      }
      if (config.ai.enableDelegate !== undefined) {
        aiConfig.enableDelegate = config.ai.enableDelegate as boolean;
      }
      if (config.ai.allowEdit !== undefined) {
        aiConfig.allowEdit = config.ai.allowEdit as boolean;
      }
      if (config.ai.allowedTools !== undefined) {
        aiConfig.allowedTools = config.ai.allowedTools as string[];
      }
      if (config.ai.disableTools !== undefined) {
        aiConfig.disableTools = config.ai.disableTools as boolean;
      }
      if (config.ai.allowBash !== undefined) {
        aiConfig.allowBash = config.ai.allowBash as boolean;
      }
      if (config.ai.bashConfig !== undefined) {
        aiConfig.bashConfig = config.ai.bashConfig as import('../types/config').BashConfig;
      }
      if (config.ai.skip_code_context !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (aiConfig as any).skip_code_context = config.ai.skip_code_context as boolean;
      }
      if (config.ai.retry !== undefined) {
        aiConfig.retry = config.ai.retry as import('../types/config').AIRetryConfig;
      }
      if (config.ai.fallback !== undefined) {
        aiConfig.fallback = config.ai.fallback as import('../types/config').AIFallbackConfig;
      }
    }

    // Check-level AI model and provider (top-level properties)
    if (config.ai_model !== undefined) {
      aiConfig.model = config.ai_model as string;
    }
    if (config.ai_provider !== undefined) {
      aiConfig.provider = config.ai_provider as
        | 'google'
        | 'anthropic'
        | 'openai'
        | 'bedrock'
        | 'mock';
    }

    // Get custom prompt from config - REQUIRED, no fallbacks
    const customPrompt = config.prompt;

    if (!customPrompt) {
      throw new Error(
        `No prompt defined for check. All checks must have prompts defined in .visor.yaml configuration.`
      );
    }

    // Setup MCP tools from multiple configuration levels
    const mcpServers: Record<string, import('../types/config').McpServerConfig> = {};

    // 1. Start with global MCP servers (from visor config root)
    const globalConfig = config as CheckProviderConfig & {
      ai_mcp_servers?: Record<string, import('../types/config').McpServerConfig>;
    };
    if (globalConfig.ai_mcp_servers) {
      Object.assign(mcpServers, globalConfig.ai_mcp_servers);
    }

    // 2. Add check-level MCP servers (overrides global)
    if (config.ai_mcp_servers) {
      Object.assign(mcpServers, config.ai_mcp_servers);
    }

    // 3. Add ai.mcpServers (overrides everything)
    if (config.ai?.mcpServers) {
      Object.assign(mcpServers, config.ai.mcpServers);
    }

    // Pass MCP server config directly to AI service (unless tools are disabled)
    if (Object.keys(mcpServers).length > 0 && !config.ai?.disableTools) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (aiConfig as any).mcpServers = mcpServers;
      // no noisy diagnostics here
    } else if (config.ai?.disableTools) {
      // silently skip MCP when tools disabled
    }

    // Build template context for state capture
    const templateContext = {
      pr: {
        number: prInfo.number,
        title: prInfo.title,
        author: prInfo.author,
        branch: prInfo.head,
        base: prInfo.base,
      },
      files: prInfo.files,
      outputs: _dependencyResults
        ? Object.fromEntries(
            Array.from(_dependencyResults.entries()).map(([checkName, result]) => [
              checkName,
              (result as any).output !== undefined ? (result as any).output : result,
            ])
          )
        : {},
    };

    // Capture input context in active OTEL span
    try {
      const span = trace.getSpan(otContext.active());
      if (span) {
        captureCheckInputContext(span, templateContext);
      }
    } catch {
      // Ignore telemetry errors
    }
    // Fallback NDJSON for input context (non-OTEL environments)
    try {
      const checkId = (config as any).checkName || (config as any).id || 'unknown';
      const ctxJson = JSON.stringify(templateContext);
      const { emitNdjsonSpanWithEvents } = require('../telemetry/fallback-ndjson');
      emitNdjsonSpanWithEvents(
        'visor.check',
        { 'visor.check.id': checkId, 'visor.check.input.context': ctxJson },
        []
      );
    } catch {}

    // Process prompt with Liquid templates and file loading
    // Skip event context (PR diffs, files, etc.) if requested
    const eventContext = config.ai?.skip_code_context ? {} : config.eventContext;
    // Thread stageHistoryBase via eventContext for prompt rendering so
    // Liquid templates can get outputs_history_stage (computed from baseline).
    const ctxWithStage = {
      ...(eventContext || {}),
      __stageHistoryBase: (sessionInfo as any)?.stageHistoryBase as
        | Record<string, number>
        | undefined,
    } as Record<string, unknown>;

    const processedPrompt = await this.processPrompt(
      customPrompt,
      prInfo,
      ctxWithStage,
      _dependencyResults,
      (config as any).__outputHistory as Map<string, unknown[]> | undefined
    );

    // No implicit prompt mutations here — prompts should come from YAML.

    // Test hook: capture the FINAL prompt (with PR context) before provider invocation
    try {
      const stepName = (config as any).checkName || 'unknown';
      const serviceForCapture = new AIReviewService(aiConfig);
      const finalPrompt = await (serviceForCapture as any).buildCustomPrompt(
        prInfo,
        processedPrompt,
        config.schema,
        { checkName: (config as any).checkName }
      );
      sessionInfo?.hooks?.onPromptCaptured?.({
        step: String(stepName),
        provider: 'ai',
        prompt: finalPrompt,
      });
      // capture hook retained; no extra console diagnostics
    } catch {}

    // Test hook: mock output for this step (short-circuit provider)
    try {
      const stepName = (config as any).checkName || 'unknown';
      const mock = sessionInfo?.hooks?.mockForStep?.(String(stepName));
      if (mock !== undefined) {
        return { issues: [], output: mock } as ReviewSummary & { output: unknown };
      }
    } catch {}

    // Create AI service with config - environment variables will be used if aiConfig is empty
    const service = new AIReviewService(aiConfig);

    // Pass the custom prompt and schema - no fallbacks
    const schema = config.schema as string | Record<string, unknown> | undefined;

    // Removed verbose AICheckProvider console diagnostics; rely on logger.debug when needed

    try {
      // No extra console diagnostics here

      let result: ReviewSummary;

      // Check if we should use session reuse (only if explicitly enabled on this check)
      // No extra reuse_ai_session console diagnostics
      const reuseEnabled =
        (config as any).reuse_ai_session === true ||
        typeof (config as any).reuse_ai_session === 'string';
      if (sessionInfo?.reuseSession && sessionInfo.parentSessionId && reuseEnabled) {
        // Safety: only reuse if the parent session actually exists
        try {
          const { SessionRegistry } = require('../session-registry');
          const reg = SessionRegistry.getInstance();
          if (!reg.hasSession(sessionInfo.parentSessionId)) {
            if (aiConfig.debug || process.env.VISOR_DEBUG === 'true') {
              console.warn(
                `⚠️  Parent session ${sessionInfo.parentSessionId} not found; creating a new session for ${config.checkName}`
              );
            }
            // Fall back to new session
            const fresh = await service.executeReview(
              prInfo,
              processedPrompt,
              schema,
              config.checkName,
              config.sessionId
            );
            return {
              ...fresh,
              issues: new IssueFilter(config.suppressionEnabled !== false).filterIssues(
                fresh.issues || [],
                process.cwd()
              ),
            };
          }
        } catch {}
        // Get session_mode from config, default to 'clone'
        const sessionMode = (config.session_mode as 'clone' | 'append') || 'clone';

        if (aiConfig.debug) {
          console.error(
            `🔄 Debug: Using session reuse with parent session: ${sessionInfo.parentSessionId} (mode: ${sessionMode})`
          );
        }
        result = await service.executeReviewWithSessionReuse(
          prInfo,
          processedPrompt,
          sessionInfo.parentSessionId,
          schema,
          config.checkName,
          sessionMode
        );
      } else {
        if (aiConfig.debug) {
          console.error(`🆕 Debug: Creating new AI session for check: ${config.checkName}`);
        }
        result = await service.executeReview(
          prInfo,
          processedPrompt,
          schema,
          config.checkName,
          config.sessionId
        );
      }

      // Apply issue suppression filtering
      const suppressionEnabled = config.suppressionEnabled !== false;
      const issueFilter = new IssueFilter(suppressionEnabled);
      const filteredIssues = issueFilter.filterIssues(result.issues || [], process.cwd());

      const finalResult = {
        ...result,
        issues: filteredIssues,
      };

      // Capture AI provider call and output in active OTEL span
      try {
        const span = trace.getSpan(otContext.active());
        if (span) {
          captureProviderCall(
            span,
            'ai',
            {
              prompt: processedPrompt.substring(0, 500), // Preview only
              model: aiConfig.model,
            },
            {
              content: JSON.stringify(finalResult).substring(0, 500),
              tokens: (result as any).usage?.totalTokens,
            }
          );
          const outputForSpan = (finalResult as { output?: unknown }).output ?? finalResult;
          captureCheckOutput(span, outputForSpan);
        }
      } catch {
        // Ignore telemetry errors
      }
      // Fallback NDJSON for output (non-OTEL environments)
      try {
        const checkId = (config as any).checkName || (config as any).id || 'unknown';
        const outJson = JSON.stringify((finalResult as any).output ?? finalResult);
        const { emitNdjsonSpanWithEvents } = require('../telemetry/fallback-ndjson');
        emitNdjsonSpanWithEvents(
          'visor.check',
          { 'visor.check.id': checkId, 'visor.check.output': outJson },
          []
        );
      } catch {}

      return finalResult;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Log detailed error information
      console.error(`❌ AI Check Provider Error for check: ${errorMessage}`);

      // Check if this is a critical error (authentication, rate limits, etc)
      const isCriticalError =
        errorMessage.includes('API rate limit') ||
        errorMessage.includes('403') ||
        errorMessage.includes('401') ||
        errorMessage.includes('authentication') ||
        errorMessage.includes('API key');

      if (isCriticalError) {
        console.error(`🚨 CRITICAL ERROR: AI provider authentication or rate limit issue detected`);
        console.error(`🚨 This check cannot proceed without valid API credentials`);
      }

      // Re-throw with more context
      throw new Error(`AI analysis failed: ${errorMessage}`);
    }
  }

  getSupportedConfigKeys(): string[] {
    return [
      'type',
      'prompt',
      'focus',
      'schema',
      'group',
      'ai.provider',
      'ai.model',
      'ai.apiKey',
      'ai.timeout',
      'ai.mcpServers',
      'ai.enableDelegate',
      'ai.retry',
      'ai.fallback',
      'ai.allowEdit',
      'ai.allowedTools',
      'ai.disableTools',
      'ai.allowBash',
      'ai.bashConfig',
      'ai_model',
      'ai_provider',
      'ai_mcp_servers',
      'env',
    ];
  }

  async isAvailable(): Promise<boolean> {
    // Check if any AI API key is available
    return !!(
      process.env.GOOGLE_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.OPENAI_API_KEY ||
      // AWS Bedrock credentials check
      (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
      process.env.AWS_BEDROCK_API_KEY
    );
  }

  getRequirements(): string[] {
    return [
      'At least one of: GOOGLE_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or AWS credentials (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY)',
      'Optional: MODEL_NAME environment variable',
      'Optional: AWS_REGION for Bedrock provider',
      'Network access to AI provider APIs',
    ];
  }
}
