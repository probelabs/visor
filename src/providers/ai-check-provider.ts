import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import { AIReviewService, AIReviewConfig } from '../ai-review-service';
import { EnvironmentResolver } from '../utils/env-resolver';
import { IssueFilter } from '../issue-filter';
import { createExtendedLiquid } from '../liquid-extensions';
import fs from 'fs/promises';
import path from 'path';
import { trace, context as otContext } from '../telemetry/lazy-otel';
import {
  captureCheckInputContext,
  captureCheckOutput,
  captureProviderCall,
  sanitizeContextForTelemetry,
} from '../telemetry/state-capture';
import { CustomToolsSSEServer } from './mcp-custom-sse-server';
import { CustomToolDefinition } from '../types/config';
import { logger } from '../logger';
import {
  resolveWorkflowToolFromItem,
  isWorkflowToolReference,
  WorkflowToolReference,
  WorkflowToolContext,
} from './workflow-tool-executor';
import { createSecureSandbox, compileAndRun } from '../utils/sandbox';
import type Sandbox from '@nyariv/sandboxjs';

/**
 * AI-powered check provider using probe agent
 */
export class AICheckProvider extends CheckProvider {
  private aiReviewService: AIReviewService;
  private liquidEngine: ReturnType<typeof createExtendedLiquid>;
  private sandbox: Sandbox | null = null;

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

  /** Lightweight debug helper to avoid importing logger here */
  private logDebug(msg: string): void {
    try {
      if (process.env.VISOR_DEBUG === 'true') {
        // eslint-disable-next-line no-console
        console.debug(msg);
      }
    } catch {
      // Best-effort only
    }
  }

  /** Detect Slack webhook payload and build a lightweight slack context for templates */
  private buildSlackEventContext(
    context?: import('./check-provider.interface').ExecutionContext,
    config?: CheckProviderConfig,
    prInfo?: PRInfo
  ): Record<string, unknown> {
    try {
      const aiCfg: any = config?.ai || {};
      if (aiCfg.skip_slack_context === true) return {};
      const webhook = context?.webhookContext;
      const map = webhook?.webhookData;
      if (!map || !(map instanceof Map)) return {};
      // In Slack socket mode we store the payload under the configured endpoint key.
      // For template purposes, it is sufficient to inspect the first payload.
      const first = Array.from(map.values())[0] as any;
      if (!first || typeof first !== 'object') return {};
      const ev = first.event;
      const conv = first.slack_conversation;
      if (!ev && !conv) return {};
      // Attach conversation to prInfo so downstream helpers (XML context) can use it
      if (conv && prInfo) {
        try {
          (prInfo as any).slackConversation = conv;
        } catch {
          // best-effort only
        }
      }
      return { slack: { event: ev, conversation: conv } };
    } catch {
      return {};
    }
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
    outputHistory?: Map<string, unknown[]>,
    args?: Record<string, unknown>,
    workflowInputs?: Record<string, unknown>
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
      outputHistory,
      args,
      workflowInputs
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
    outputHistory?: Map<string, unknown[]>,
    args?: Record<string, unknown>,
    workflowInputs?: Record<string, unknown>
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

      // GitHub / webhook Event Context
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

      // Slack conversation context (if provided via eventContext.slack)
      slack: (() => {
        try {
          const anyCtx = eventContext as any;
          const slack = anyCtx?.slack;
          if (slack && typeof slack === 'object') return slack;
        } catch {
          // ignore
        }
        return undefined;
      })(),

      // Unified conversation context across transports (Slack & GitHub)
      conversation: (() => {
        try {
          const anyCtx = eventContext as any;
          if (anyCtx?.slack?.conversation) return anyCtx.slack.conversation;
          if (anyCtx?.github?.conversation) return anyCtx.github.conversation;
          if (anyCtx?.conversation) return anyCtx.conversation;
        } catch {
          // ignore
        }
        return undefined;
      })(),

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

      // Checks metadata for helpers like chat_history
      checks_meta: (() => {
        try {
          return (eventContext as any)?.__checksMeta || undefined;
        } catch {
          return undefined;
        }
      })(),

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
      // Custom arguments from on_init 'with' directive
      args: args || {},
      // Workflow inputs (for nested workflow steps to access parent inputs like {{ inputs.context }})
      inputs: workflowInputs || {},
    };

    try {
      if (process.env.VISOR_DEBUG === 'true') {
        const outKeys = Object.keys((templateContext as any).outputs || {}).join(', ');
        const histKeys = Object.keys((templateContext as any).outputs_history || {}).join(', ');
        const inputsKeys = Object.keys((templateContext as any).inputs || {}).join(', ');
        console.error(
          `[prompt-ctx] outputs.keys=${outKeys} hist.keys=${histKeys} inputs.keys=${inputsKeys}`
        );
        // Log projects specifically if present
        const projects = (templateContext as any).inputs?.projects;
        if (projects) {
          console.error(
            `[prompt-ctx] inputs.projects has ${Array.isArray(projects) ? projects.length : 'N/A'} items`
          );
        }
      }
    } catch {}

    try {
      return await this.liquidEngine.parseAndRender(promptContent, templateContext);
    } catch (error) {
      // Always show a helpful snippet with a caret, similar to YAML errors
      const err: any = error || {};
      const lines = String(promptContent || '').split(/\r?\n/);
      const lineNum: number = Number(err.line || err?.token?.line || err?.location?.line || 0);
      const colNum: number = Number(err.col || err?.token?.col || err?.location?.col || 0);
      let snippet = '';
      if (lineNum > 0) {
        const start = Math.max(1, lineNum - 3);
        const end = Math.max(lineNum + 2, lineNum);
        const width = String(end).length;
        for (let i = start; i <= Math.min(end, lines.length); i++) {
          const ln = `${String(i).padStart(width, ' ')} | ${lines[i - 1] ?? ''}`;
          snippet += ln + '\n';
          if (i === lineNum) {
            const caretPad = ' '.repeat(Math.max(0, colNum > 1 ? colNum - 1 : 0) + width + 3);
            snippet += caretPad + '^\n';
          }
        }
      } else {
        // Fallback preview of the first 20 lines
        const preview = lines
          .slice(0, 20)
          .map((l, i) => `${(i + 1).toString().padStart(3, ' ')} | ${l}`)
          .join('\n');
        snippet = preview + '\n';
      }
      const msg = `Failed to render prompt template: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`;
      // Print a clear, user-friendly error with context
      try {
        console.error('\n[prompt-error] ' + msg + '\n' + snippet);
      } catch {}
      throw new Error(msg);
    }
  }

  /**
   * Render Liquid templates in schema definitions
   * Supports dynamic enum values and other template-driven schema properties
   */
  private async renderSchema(
    schema: string | Record<string, unknown> | undefined,
    prInfo: PRInfo,
    _eventContext?: Record<string, unknown>,
    dependencyResults?: Map<string, ReviewSummary>,
    outputHistory?: Map<string, unknown[]>,
    args?: Record<string, unknown>,
    workflowInputs?: Record<string, unknown>
  ): Promise<string | Record<string, unknown> | undefined> {
    if (!schema) return schema;

    let schemaStr: string;

    if (typeof schema === 'string') {
      // Check if string schema contains Liquid templates
      if (!schema.includes('{{') && !schema.includes('{%')) {
        // No Liquid templates, return as-is (could be a schema reference like 'code-review')
        return schema;
      }
      // String schema with Liquid templates (e.g., JSON string in YAML)
      schemaStr = schema;
    } else {
      // For object schemas, check if they contain Liquid templates
      schemaStr = JSON.stringify(schema);
      if (!schemaStr.includes('{{') && !schemaStr.includes('{%')) {
        // No Liquid templates, return as-is
        return schema;
      }
    }

    // Build the same template context as renderPromptTemplate
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

    const templateContext = {
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
      files: prInfo.files || [],
      description: prInfo.body || '',
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
      outputs_history: (() => {
        const hist: Record<string, unknown[]> = {};
        if (outputHistory) {
          for (const [k, v] of outputHistory.entries()) hist[k] = v;
        }
        return hist;
      })(),
      outputs_raw: outputsRaw,
      args: args || {},
      inputs: workflowInputs || {},
    };

    try {
      if (process.env.VISOR_DEBUG === 'true') {
        logger.debug(`[schema-render] Rendering schema with Liquid templates`);
        logger.debug(
          `[schema-render] inputs.projects count: ${Array.isArray((templateContext as any).inputs?.projects) ? (templateContext as any).inputs.projects.length : 'N/A'}`
        );
      }

      const renderedStr = await this.liquidEngine.parseAndRender(schemaStr, templateContext);

      // Parse the rendered JSON back to an object
      try {
        const parsed = JSON.parse(renderedStr);
        if (process.env.VISOR_DEBUG === 'true') {
          logger.debug(`[schema-render] Successfully rendered schema`);
        }
        return parsed;
      } catch (parseError) {
        const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
        // Log full rendered string for debugging (up to 2000 chars to avoid log flooding)
        const preview =
          renderedStr.length > 2000
            ? renderedStr.substring(0, 2000) + '...[truncated]'
            : renderedStr;
        logger.error(`[schema-render] JSON_PARSE_ERROR: Failed to parse rendered schema as JSON`);
        logger.error(`[schema-render] Parse error: ${errorMsg}`);
        logger.error(`[schema-render] Original schema type: ${typeof schema}`);
        logger.error(`[schema-render] Rendered output (${renderedStr.length} chars):\n${preview}`);
        // Throw error to make configuration issues visible rather than silently falling back
        throw new Error(
          `Schema template rendered invalid JSON: ${errorMsg}. ` +
            `Check Liquid template syntax. Rendered output starts with: "${renderedStr.substring(0, 100)}..."`
        );
      }
    } catch (error) {
      // Re-throw JSON parse errors (already formatted above)
      if (
        error instanceof Error &&
        error.message.includes('Schema template rendered invalid JSON')
      ) {
        throw error;
      }
      // Handle Liquid rendering errors
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[schema-render] LIQUID_RENDER_ERROR: Failed to render schema template`);
      logger.error(`[schema-render] Error: ${errorMsg}`);
      logger.error(
        `[schema-render] Original schema: ${schemaStr.substring(0, 500)}${schemaStr.length > 500 ? '...[truncated]' : ''}`
      );
      // Throw error to make template syntax issues visible
      throw new Error(
        `Schema Liquid template error: ${errorMsg}. ` +
          `Check template syntax in schema definition.`
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
    // Extract AI configuration - only set properties that are explicitly provided.
    // Workspace / allowedFolders will be derived below from the execution context.
    const aiConfig: AIReviewConfig = {};

    // Check-level AI configuration (ai object)
    if (config.ai) {
      const aiAny: any = config.ai;
      const skipTransport: boolean = aiAny.skip_transport_context === true;
      // Only set properties that are actually defined to avoid overriding env vars
      if (aiAny.apiKey !== undefined) {
        aiConfig.apiKey = aiAny.apiKey as string;
      }
      if (aiAny.model !== undefined) {
        aiConfig.model = aiAny.model as string;
      }
      if (aiAny.timeout !== undefined) {
        aiConfig.timeout = aiAny.timeout as number;
      }
      if (aiAny.max_iterations !== undefined || aiAny.maxIterations !== undefined) {
        const raw = aiAny.max_iterations ?? aiAny.maxIterations;
        aiConfig.maxIterations = Number(raw);
      }
      if (aiAny.provider !== undefined) {
        aiConfig.provider = aiAny.provider as
          | 'google'
          | 'anthropic'
          | 'openai'
          | 'bedrock'
          | 'mock';
      }
      if (aiAny.debug !== undefined) {
        aiConfig.debug = aiAny.debug as boolean;
      }
      if (aiAny.enableDelegate !== undefined) {
        aiConfig.enableDelegate = aiAny.enableDelegate as boolean;
      }
      if (aiAny.enableTasks !== undefined) {
        aiConfig.enableTasks = aiAny.enableTasks as boolean;
      }
      if (aiAny.allowEdit !== undefined) {
        aiConfig.allowEdit = aiAny.allowEdit as boolean;
      }
      if (aiAny.allowedTools !== undefined) {
        aiConfig.allowedTools = aiAny.allowedTools as string[];
        this.logDebug(
          `[AI Provider] Read allowedTools from YAML: ${JSON.stringify(aiAny.allowedTools)}`
        );
      }
      if (aiAny.disableTools !== undefined) {
        aiConfig.disableTools = aiAny.disableTools as boolean;
        this.logDebug(`[AI Provider] Read disableTools from YAML: ${aiAny.disableTools}`);
      }
      if (aiAny.allowBash !== undefined) {
        aiConfig.allowBash = aiAny.allowBash as boolean;
      }
      if (aiAny.bashConfig !== undefined) {
        aiConfig.bashConfig = aiAny.bashConfig as import('../types/config').BashConfig;
      }
      if (aiAny.completion_prompt !== undefined) {
        aiConfig.completionPrompt = aiAny.completion_prompt as string;
      }
      if (aiAny.skip_code_context !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (aiConfig as any).skip_code_context = aiAny.skip_code_context as boolean;
      } else if (skipTransport) {
        (aiConfig as any).skip_code_context = true;
      }
      // Optional: allow disabling Slack context separately from PR/code context
      if (aiAny.skip_slack_context !== undefined) {
        (aiConfig as any).skip_slack_context = aiAny.skip_slack_context as boolean;
      } else if (skipTransport) {
        (aiConfig as any).skip_slack_context = true;
      }
      if (aiAny.retry !== undefined) {
        aiConfig.retry = aiAny.retry as import('../types/config').AIRetryConfig;
      }
      if (aiAny.fallback !== undefined) {
        aiConfig.fallback = aiAny.fallback as import('../types/config').AIFallbackConfig;
      }
    }

    // Derive workspace-aware allowedFolders for ProbeAgent when workspace
    // isolation is enabled. This ensures tools like search/query operate
    // inside the isolated workspace (and its project symlinks) instead of
    // the Visor repository root.
    // Folder names are human-readable (tyk-docs, visor2) thanks to WorkspaceManager.
    try {
      const ctxAny: any = sessionInfo as any;
      const parentCtx = ctxAny?._parentContext;
      const workspace = parentCtx?.workspace;

      // Enhanced debug logging for workspace propagation diagnosis
      logger.debug(
        `[AI Provider] Workspace detection for check '${(config as any).checkName || 'unknown'}':`
      );
      logger.debug(`[AI Provider]   sessionInfo exists: ${!!sessionInfo}`);
      logger.debug(`[AI Provider]   _parentContext exists: ${!!parentCtx}`);
      logger.debug(`[AI Provider]   workspace exists: ${!!workspace}`);
      if (workspace) {
        logger.debug(
          `[AI Provider]   workspace.isEnabled exists: ${typeof workspace.isEnabled === 'function'}`
        );
        logger.debug(
          `[AI Provider]   workspace.isEnabled(): ${typeof workspace.isEnabled === 'function' ? workspace.isEnabled() : 'N/A'}`
        );
        const projectCount =
          typeof workspace.listProjects === 'function' ? workspace.listProjects()?.length : 'N/A';
        logger.debug(`[AI Provider]   workspace.listProjects() count: ${projectCount}`);
      }

      if (workspace && typeof workspace.isEnabled === 'function' && workspace.isEnabled()) {
        const folders: string[] = [];
        let workspaceRoot: string | undefined;
        let mainProjectPath: string | undefined;
        try {
          const info = workspace.getWorkspaceInfo?.();
          if (info && typeof info.workspacePath === 'string') {
            workspaceRoot = info.workspacePath;
            mainProjectPath = info.mainProjectPath;
            // Add workspace root first so allowedFolders[0] is the workspace root.
            // This keeps compatibility with ProbeAgent's legacy default cwd behavior,
            // while we also set explicit path/cwd below.
            folders.push(info.workspacePath);
            // NOTE: We intentionally do NOT add mainProjectPath here.
            // Inclusion of the main project is controlled below via
            // workspace.include_main_project / VISOR_WORKSPACE_INCLUDE_MAIN_PROJECT.
          }
        } catch {
          // ignore workspace info errors
        }
        // Collect checked-out projects (these are the user's actual projects)
        const projectPaths: string[] = [];
        try {
          const projects = workspace.listProjects?.() || [];
          for (const proj of projects as any[]) {
            if (proj && typeof proj.path === 'string') {
              // Project paths have human-readable names (tyk-docs, not checkout-tyk-docs)
              folders.push(proj.path);
              projectPaths.push(proj.path);
            }
          }
        } catch {
          // ignore project listing errors
        }
        // Only include the main project when explicitly enabled.
        const workspaceCfg = parentCtx?.config?.workspace as
          | { include_main_project?: boolean }
          | undefined;
        const includeMainProject =
          workspaceCfg?.include_main_project === true ||
          process.env.VISOR_WORKSPACE_INCLUDE_MAIN_PROJECT === 'true';
        if (includeMainProject && mainProjectPath) {
          folders.push(mainProjectPath);
          logger.debug(`[AI Provider] Including main project (enabled): ${mainProjectPath}`);
        } else if (mainProjectPath) {
          logger.debug(`[AI Provider] Excluding main project (disabled): ${mainProjectPath}`);
        }
        const unique = Array.from(new Set(folders.filter(p => typeof p === 'string' && p)));
        if (unique.length > 0 && workspaceRoot) {
          if (unique[0] !== workspaceRoot) {
            logger.warn(
              `[AI Provider] allowedFolders[0] is not workspaceRoot; tooling defaults may be mis-scoped`
            );
          }
          (aiConfig as any).allowedFolders = unique;
          // Use workspace root as cwd so tools default to the workspace root.
          // Both are set for compatibility: path for older probe versions, cwd for rc175+.
          const aiCwd = workspaceRoot;
          (aiConfig as any).path = aiCwd;
          (aiConfig as any).cwd = aiCwd;
          (aiConfig as any).workspacePath = aiCwd;
          logger.debug(`[AI Provider] Workspace isolation enabled:`);
          logger.debug(`[AI Provider]   cwd (workspaceRoot): ${aiCwd}`);
          logger.debug(`[AI Provider]   workspaceRoot: ${workspaceRoot}`);
          logger.debug(`[AI Provider]   allowedFolders: ${JSON.stringify(unique)}`);
        }
      } else if (parentCtx && typeof parentCtx.workingDirectory === 'string') {
        // Fallback: when workspace is not available (or disabled), still
        // constrain tools to the engine's working directory so ProbeAgent
        // operates inside the same logical root as the state machine. This
        // also ensures nested workflows (e.g. code-question-helper) use the
        // workspace main project path once initializeWorkspace has updated
        // the parent context.
        if (!(aiConfig as any).allowedFolders) {
          (aiConfig as any).allowedFolders = [parentCtx.workingDirectory];
        }
        if (!(aiConfig as any).path) {
          (aiConfig as any).path = parentCtx.workingDirectory;
          (aiConfig as any).cwd = parentCtx.workingDirectory;
        }
      }
    } catch {
      // Best-effort only; fall back to defaults on error.
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
    if (config.ai_max_iterations !== undefined && aiConfig.maxIterations === undefined) {
      aiConfig.maxIterations = config.ai_max_iterations as number;
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

    // 4. Evaluate ai_mcp_servers_js for dynamic MCP server selection (overrides all static configs)
    const mcpServersJsExpr = (config as any).ai_mcp_servers_js as string | undefined;
    if (mcpServersJsExpr && _dependencyResults) {
      try {
        const dynamicServers = this.evaluateMcpServersJs(
          mcpServersJsExpr,
          prInfo,
          _dependencyResults,
          config
        );
        if (Object.keys(dynamicServers).length > 0) {
          Object.assign(mcpServers, dynamicServers);
        }
      } catch (error) {
        logger.error(
          `[AICheckProvider] Failed to evaluate ai_mcp_servers_js: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
        // Continue without dynamic servers
      }
    }

    // 5. Resolve environment variable placeholders in MCP server env configs
    // Supports ${VAR} and ${{ env.VAR }} syntax
    for (const serverConfig of Object.values(mcpServers)) {
      if (serverConfig.env) {
        const resolvedEnv: Record<string, string> = {};
        for (const [key, value] of Object.entries(serverConfig.env)) {
          if (typeof value === 'string') {
            resolvedEnv[key] = String(EnvironmentResolver.resolveValue(value));
          } else {
            resolvedEnv[key] = String(value);
          }
        }
        serverConfig.env = resolvedEnv;
      }
    }

    // 6. Setup custom tools SSE server if MCP servers reference custom tools
    // Check for ai_custom_tools_js (dynamic), ai_custom_tools (static), and tools: in MCP servers
    let customToolsServer: CustomToolsSSEServer | null = null;
    let customToolsToLoad: Array<string | WorkflowToolReference> = [];
    let customToolsServerName: string | null = null;

    // Option 1: Check for ai_custom_tools_js (dynamic JavaScript expression)
    const customToolsJsExpr = (config as any).ai_custom_tools_js as string | undefined;
    if (customToolsJsExpr && _dependencyResults) {
      try {
        const dynamicTools = this.evaluateCustomToolsJs(
          customToolsJsExpr,
          prInfo,
          _dependencyResults,
          config
        );
        if (dynamicTools.length > 0) {
          customToolsToLoad = dynamicTools;
          customToolsServerName = '__custom_tools__';
          logger.debug(
            `[AICheckProvider] ai_custom_tools_js evaluated to ${dynamicTools.length} tools`
          );
        }
      } catch (error) {
        logger.error(
          `[AICheckProvider] Failed to evaluate ai_custom_tools_js: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
        // Continue without dynamic tools, fallback to static
      }
    }

    // Option 2: Check for ai_custom_tools (static - backward compatible)
    // Merge with dynamic tools if both are specified
    const staticCustomTools = this.getCustomToolsForAI(config);
    if (staticCustomTools.length > 0) {
      if (customToolsToLoad.length > 0) {
        // Merge dynamic and static tools (avoid duplicates by name)
        const existingNames = new Set(
          customToolsToLoad.map(item => (typeof item === 'string' ? item : item.workflow))
        );
        for (const tool of staticCustomTools) {
          const name = typeof tool === 'string' ? tool : tool.workflow;
          if (!existingNames.has(name)) {
            customToolsToLoad.push(tool);
          }
        }
      } else {
        customToolsToLoad = staticCustomTools;
        customToolsServerName = '__custom_tools__';
      }
    }

    // Option 3: Check if any MCP server uses "tools:" format (preferred - reuses ai_mcp_servers)
    // Note: This format only supports string tool names, not workflow references
    for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
      if ((serverConfig as any).tools && Array.isArray((serverConfig as any).tools)) {
        customToolsToLoad = (serverConfig as any).tools as string[];
        customToolsServerName = serverName;
        break; // Only support one custom tools server per check
      }
    }

    // Option 4: Extract workflow entries directly from ai_mcp_servers/ai_mcp_servers_js
    // Entries with 'workflow' property are workflow tool references that need SSE server
    const workflowEntriesFromMcp: WorkflowToolReference[] = [];
    const mcpEntriesToRemove: string[] = [];
    for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
      // Cast to any to check for workflow property (extends McpServerConfig)
      const cfg = serverConfig as unknown as Record<string, unknown>;
      if (cfg.workflow && typeof cfg.workflow === 'string') {
        // This is a workflow tool entry - extract it
        workflowEntriesFromMcp.push({
          workflow: cfg.workflow as string,
          args: cfg.inputs as Record<string, unknown> | undefined,
        });
        mcpEntriesToRemove.push(serverName);
        logger.debug(
          `[AICheckProvider] Extracted workflow tool '${serverName}' from ai_mcp_servers`
        );
      }
    }
    // Remove workflow entries from mcpServers (they'll be exposed via SSE server)
    for (const name of mcpEntriesToRemove) {
      delete mcpServers[name];
    }
    // Merge workflow entries with other custom tools
    if (workflowEntriesFromMcp.length > 0) {
      if (customToolsToLoad.length > 0) {
        // Avoid duplicates
        const existingNames = new Set(
          customToolsToLoad.map(item => (typeof item === 'string' ? item : item.workflow))
        );
        for (const wf of workflowEntriesFromMcp) {
          if (!existingNames.has(wf.workflow)) {
            customToolsToLoad.push(wf);
          }
        }
      } else {
        customToolsToLoad = workflowEntriesFromMcp;
      }
      customToolsServerName = '__tools__';
    }

    if (customToolsToLoad.length > 0 && customToolsServerName && !config.ai?.disableTools) {
      try {
        // Load custom tools from global config (now supports workflows too)
        const customTools = this.loadCustomTools(customToolsToLoad, config);

        if (customTools.size > 0) {
          const sessionId = (config as any).checkName || `ai-check-${Date.now()}`;
          const debug = aiConfig.debug || process.env.VISOR_DEBUG === 'true';

          // Build workflow context for workflow tools
          const workflowContext: WorkflowToolContext = {
            prInfo,
            outputs: _dependencyResults,
            executionContext: sessionInfo as import('./check-provider.interface').ExecutionContext,
          };

          customToolsServer = new CustomToolsSSEServer(
            customTools,
            sessionId,
            debug,
            workflowContext
          );
          const port = await customToolsServer.start();

          if (debug) {
            logger.debug(
              `[AICheckProvider] Started custom tools SSE server '${customToolsServerName}' on port ${port} for ${customTools.size} tools`
            );
          }

          // Update the server config to use the ephemeral SSE endpoint
          // Use 10-minute timeout for workflow tools since they can run complex operations
          mcpServers[customToolsServerName] = {
            command: '',
            args: [],
            url: `http://localhost:${port}/sse`,
            transport: 'sse',
            timeout: 600000, // 10 minutes for workflow tools
          } as any;
        }
      } catch (error) {
        logger.error(
          `[AICheckProvider] Failed to start custom tools SSE server '${customToolsServerName}': ${error instanceof Error ? error.message : 'Unknown error'}`
        );
        // Continue without custom tools
      }
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
      args: (sessionInfo as any)?.args || {},
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
      // Sanitize context to avoid leaking API keys in traces
      const ctxJson = JSON.stringify(sanitizeContextForTelemetry(templateContext));
      const { emitNdjsonSpanWithEvents } = require('../telemetry/fallback-ndjson');
      emitNdjsonSpanWithEvents(
        'visor.check',
        { 'visor.check.id': checkId, 'visor.check.input.context': ctxJson },
        []
      );
    } catch {}

    // Process prompt with Liquid templates and file loading
    // Do NOT strip event context on skip_code_context — that flag only controls
    // whether we embed PR diffs/large code context later in AIReviewService.
    // Keep repository/comment metadata available for prompts and tests.
    const baseEventContext = (config.eventContext || {}) as Record<string, unknown>;
    const checksMeta = (config as any).checksMeta as
      | Record<string, { type?: string; group?: string }>
      | undefined;
    // Inject Slack context into eventContext when running under Slack (best-effort)
    const slackCtx = this.buildSlackEventContext(
      sessionInfo as
        | (typeof sessionInfo & import('./check-provider.interface').ExecutionContext)
        | undefined,
      config,
      prInfo
    );
    const baseWithSlack = { ...baseEventContext, ...slackCtx };
    const eventContext = checksMeta
      ? { ...baseWithSlack, __checksMeta: checksMeta }
      : baseWithSlack;
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
      (config as any).__outputHistory as Map<string, unknown[]> | undefined,
      (sessionInfo as any)?.args,
      (config as any).workflowInputs as Record<string, unknown> | undefined
    );

    // Process schema with Liquid templates (supports dynamic enum values)
    const processedSchema = await this.renderSchema(
      config.schema as string | Record<string, unknown> | undefined,
      prInfo,
      ctxWithStage,
      _dependencyResults,
      (config as any).__outputHistory as Map<string, unknown[]> | undefined,
      (sessionInfo as any)?.args,
      (config as any).workflowInputs as Record<string, unknown> | undefined
    );

    // Optional persona (vendor extension): ai.ai_persona or ai_persona.
    // This is a light-weight preamble, not a rewriting of the user's prompt.
    const aiAny = (config.ai || {}) as any;
    // Persona (underscore only)
    const persona = (aiAny?.ai_persona || (config as any).ai_persona || '').toString().trim();
    const finalPrompt = persona ? `Persona: ${persona}\n\n${processedPrompt}` : processedPrompt;
    const promptTypeOverride = (
      (aiAny?.prompt_type ||
        (config.ai as any)?.promptType ||
        (config as any).ai_prompt_type ||
        '') as string
    )
      .toString()
      .trim();

    // Test hook: capture the FINAL prompt (with PR context) before provider invocation
    try {
      const stepName = (config as any).checkName || 'unknown';
      const serviceForCapture = new AIReviewService(aiConfig);
      const finalPromptCapture = await (serviceForCapture as any).buildCustomPrompt(
        prInfo,
        finalPrompt,
        processedSchema,
        {
          checkName: (config as any).checkName,
          skipPRContext: (config.ai as any)?.skip_code_context === true,
        }
      );
      sessionInfo?.hooks?.onPromptCaptured?.({
        step: String(stepName),
        provider: 'ai',
        prompt: finalPromptCapture,
      });
      // capture hook retained; no extra console diagnostics
    } catch {}

    // Test hook: mock output for this step (short-circuit provider)
    try {
      const stepName = (config as any).checkName || 'unknown';
      const mock = sessionInfo?.hooks?.mockForStep?.(String(stepName));
      if (mock !== undefined) {
        const ms = mock as any;
        const issuesArr = Array.isArray(ms?.issues) ? (ms.issues as any[]) : [];
        // Prefer explicit output if provided; otherwise treat the mock itself as output
        const out = ms && typeof ms === 'object' && 'output' in ms ? ms.output : ms;
        const summary: ReviewSummary & { output?: unknown; content?: string } = {
          issues: issuesArr,
          output: out,
          ...(typeof ms?.content === 'string' ? { content: String(ms.content) } : {}),
        } as any;
        return summary;
      }
    } catch {}

    // Create AI service with config - environment variables will be used if aiConfig is empty
    try {
      if (promptTypeOverride) (aiConfig as any).promptType = promptTypeOverride;
      // Prefer new system_prompt; fall back to legacy custom_prompt for backward compatibility
      const sys = (aiAny?.system_prompt || (config as any).ai_system_prompt || '')
        .toString()
        .trim();
      const legacy = (aiAny?.custom_prompt || (config as any).ai_custom_prompt || '')
        .toString()
        .trim();
      if (sys) (aiConfig as any).systemPrompt = sys;
      else if (legacy) (aiConfig as any).systemPrompt = legacy;
    } catch {}
    const service = new AIReviewService(aiConfig);

    // Use the processed schema (with Liquid templates rendered)
    const schema = processedSchema;

    // Removed verbose AICheckProvider console diagnostics; rely on logger.debug when needed

    try {
      // No extra console diagnostics here

      let result: ReviewSummary;
      const prevPromptTypeEnv = process.env.VISOR_PROMPT_TYPE;
      const shouldIgnoreEnvPromptType = aiAny?.disableTools === true;
      let didAdjustPromptTypeEnv = false;
      if (promptTypeOverride) {
        process.env.VISOR_PROMPT_TYPE = promptTypeOverride;
        didAdjustPromptTypeEnv = true;
      } else if (shouldIgnoreEnvPromptType && prevPromptTypeEnv !== undefined) {
        delete process.env.VISOR_PROMPT_TYPE;
        didAdjustPromptTypeEnv = true;
      }
      try {
        // Check if we should use session reuse (only if explicitly enabled on this check)
        // No extra reuse_ai_session console diagnostics
        const reuseEnabled =
          (config as any).reuse_ai_session === true ||
          typeof (config as any).reuse_ai_session === 'string';
        let promptUsed = finalPrompt;
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
              promptUsed = processedPrompt;
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
          promptUsed = processedPrompt;
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
          promptUsed = finalPrompt;
          result = await service.executeReview(
            prInfo,
            finalPrompt,
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
                prompt: promptUsed,
                model: aiConfig.model,
              },
              {
                content: JSON.stringify(finalResult),
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
      } finally {
        if (didAdjustPromptTypeEnv) {
          if (prevPromptTypeEnv === undefined) {
            delete process.env.VISOR_PROMPT_TYPE;
          } else {
            process.env.VISOR_PROMPT_TYPE = prevPromptTypeEnv;
          }
        }
      }
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
    } finally {
      // Cleanup custom tools server
      if (customToolsServer) {
        try {
          await customToolsServer.stop();
          if (aiConfig.debug || process.env.VISOR_DEBUG === 'true') {
            logger.debug('[AICheckProvider] Custom tools SSE server stopped');
          }
        } catch (error) {
          logger.error(
            `[AICheckProvider] Error stopping custom tools SSE server: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }
    }
  }

  /**
   * Get custom tool items from check configuration
   * Returns an array of tool items (string names or workflow references)
   */
  private getCustomToolsForAI(config: CheckProviderConfig): Array<string | WorkflowToolReference> {
    const aiCustomTools = (config as any).ai_custom_tools;

    if (!aiCustomTools) {
      return [];
    }

    if (Array.isArray(aiCustomTools)) {
      // Filter to only string names and workflow references
      return aiCustomTools.filter(
        item => typeof item === 'string' || isWorkflowToolReference(item)
      );
    }

    if (typeof aiCustomTools === 'string') {
      return [aiCustomTools];
    }

    // Support single workflow reference object
    if (isWorkflowToolReference(aiCustomTools)) {
      return [aiCustomTools];
    }

    return [];
  }

  /**
   * Evaluate ai_custom_tools_js expression to dynamically compute custom tools.
   * Returns an array of tool names or workflow references.
   */
  private evaluateCustomToolsJs(
    expression: string,
    prInfo: PRInfo,
    dependencyResults: Map<string, ReviewSummary>,
    config: CheckProviderConfig
  ): Array<string | WorkflowToolReference> {
    if (!this.sandbox) {
      this.sandbox = createSecureSandbox();
    }

    // Build outputs object from dependency results (same pattern as template rendering)
    const outputs: Record<string, unknown> = {};
    for (const [checkId, result] of dependencyResults.entries()) {
      // Extract structured output if available, otherwise use result as-is
      const summary = result as ReviewSummary & { output?: unknown };
      outputs[checkId] = summary.output !== undefined ? summary.output : summary;
    }

    // Build context for the expression
    const jsContext: Record<string, unknown> = {
      outputs,
      inputs: (config as any).inputs || {},
      pr: {
        number: prInfo.number,
        title: prInfo.title,
        description: prInfo.body,
        author: prInfo.author,
        branch: prInfo.head,
        base: prInfo.base,
        authorAssociation: prInfo.authorAssociation,
      },
      files:
        prInfo.files?.map(f => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
        })) || [],
      env: this.buildSafeEnv(),
      memory: (config as any).__memoryAccessor || {},
    };

    try {
      const result = compileAndRun<unknown>(this.sandbox, expression, jsContext, {
        injectLog: true,
        wrapFunction: true,
        logPrefix: '[ai_custom_tools_js]',
      });

      // Validate result is an array
      if (!Array.isArray(result)) {
        logger.warn(
          `[AICheckProvider] ai_custom_tools_js must return an array, got ${typeof result}`
        );
        return [];
      }

      // Filter to valid items (strings or workflow references)
      return result.filter(
        (item: unknown) => typeof item === 'string' || isWorkflowToolReference(item as any)
      ) as Array<string | WorkflowToolReference>;
    } catch (error) {
      logger.error(
        `[AICheckProvider] Failed to evaluate ai_custom_tools_js: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return [];
    }
  }

  /**
   * Evaluate ai_mcp_servers_js expression to dynamically compute MCP servers.
   * Returns a record mapping server names to McpServerConfig objects.
   */
  private evaluateMcpServersJs(
    expression: string,
    prInfo: PRInfo,
    dependencyResults: Map<string, ReviewSummary>,
    config: CheckProviderConfig
  ): Record<string, import('../types/config').McpServerConfig> {
    if (!this.sandbox) {
      this.sandbox = createSecureSandbox();
    }

    // Build outputs object from dependency results (same pattern as template rendering)
    const outputs: Record<string, unknown> = {};
    for (const [checkId, result] of dependencyResults.entries()) {
      const summary = result as ReviewSummary & { output?: unknown };
      outputs[checkId] = summary.output !== undefined ? summary.output : summary;
    }

    // Build context for the expression
    const jsContext: Record<string, unknown> = {
      outputs,
      inputs: (config as any).inputs || {},
      pr: {
        number: prInfo.number,
        title: prInfo.title,
        description: prInfo.body,
        author: prInfo.author,
        branch: prInfo.head,
        base: prInfo.base,
        authorAssociation: prInfo.authorAssociation,
      },
      files:
        prInfo.files?.map(f => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
        })) || [],
      env: this.buildSafeEnv(),
      memory: (config as any).__memoryAccessor || {},
    };

    try {
      const result = compileAndRun<unknown>(this.sandbox, expression, jsContext, {
        injectLog: true,
        wrapFunction: true,
        logPrefix: '[ai_mcp_servers_js]',
      });

      // Validate result is an object (not array, not null)
      if (typeof result !== 'object' || result === null || Array.isArray(result)) {
        logger.warn(
          `[AICheckProvider] ai_mcp_servers_js must return an object, got ${Array.isArray(result) ? 'array' : typeof result}`
        );
        return {};
      }

      // Validate each server config - accepts multiple entry types:
      // 1. External stdio MCP server: has 'command'
      // 2. External SSE/HTTP MCP server: has 'url'
      // 3. Workflow tool reference: has 'workflow'
      // 4. Auto-detect from tools: section: empty object {}
      const validServers: Record<string, import('../types/config').McpServerConfig> = {};
      for (const [serverName, serverConfig] of Object.entries(result as Record<string, unknown>)) {
        if (typeof serverConfig !== 'object' || serverConfig === null) {
          logger.warn(
            `[AICheckProvider] ai_mcp_servers_js: server "${serverName}" config must be an object`
          );
          continue;
        }
        const cfg = serverConfig as Record<string, unknown>;
        // Accept: command (stdio), url (sse/http), workflow (workflow tool), or empty {} (auto-detect)
        const isValid = cfg.command || cfg.url || cfg.workflow || Object.keys(cfg).length === 0;
        if (!isValid) {
          logger.warn(
            `[AICheckProvider] ai_mcp_servers_js: server "${serverName}" must have command, url, or workflow`
          );
          continue;
        }
        validServers[serverName] = cfg as unknown as import('../types/config').McpServerConfig;
      }

      logger.debug(
        `[AICheckProvider] ai_mcp_servers_js evaluated to ${Object.keys(validServers).length} servers: ${Object.keys(validServers).join(', ')}`
      );
      return validServers;
    } catch (error) {
      logger.error(
        `[AICheckProvider] Failed to evaluate ai_mcp_servers_js: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return {};
    }
  }

  /**
   * Build a safe subset of environment variables for sandbox access.
   * Excludes sensitive keys like API keys, secrets, tokens.
   */
  private buildSafeEnv(): Record<string, string> {
    const sensitivePatterns = [
      /api.?key/i,
      /secret/i,
      /token/i,
      /password/i,
      /credential/i,
      /auth/i,
      /private/i,
    ];
    const safeEnv: Record<string, string> = {};

    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      const isSensitive = sensitivePatterns.some(pattern => pattern.test(key));
      if (!isSensitive) {
        safeEnv[key] = value;
      }
    }

    return safeEnv;
  }

  /**
   * Load custom tools from global configuration and workflow registry
   * Supports both traditional custom tools and workflow-as-tool references
   */
  private loadCustomTools(
    toolItems: Array<string | WorkflowToolReference>,
    config: CheckProviderConfig
  ): Map<string, CustomToolDefinition> {
    const tools = new Map<string, CustomToolDefinition>();

    // Get tools from global config (passed through check config)
    const globalTools = (config as any).__globalTools as
      | Record<string, CustomToolDefinition>
      | undefined;

    for (const item of toolItems) {
      // First, try to resolve as a workflow tool
      const workflowTool = resolveWorkflowToolFromItem(item);
      if (workflowTool) {
        logger.debug(`[AICheckProvider] Loaded workflow '${workflowTool.name}' as custom tool`);
        tools.set(workflowTool.name, workflowTool);
        continue;
      }

      // If it's not a workflow, try to load from global tools
      if (typeof item === 'string') {
        // Check global tools
        if (globalTools && globalTools[item]) {
          const tool = globalTools[item];
          tool.name = tool.name || item;
          tools.set(item, tool);
          continue;
        }

        // Not found in either location
        logger.warn(
          `[AICheckProvider] Custom tool '${item}' not found in global tools or workflow registry`
        );
      } else if (isWorkflowToolReference(item)) {
        // Workflow reference that wasn't found in registry
        logger.warn(
          `[AICheckProvider] Workflow '${item.workflow}' referenced but not found in registry`
        );
      }
    }

    // Warn if no tools were loaded but items were specified
    if (tools.size === 0 && toolItems.length > 0 && !globalTools) {
      logger.warn(
        `[AICheckProvider] ai_custom_tools specified but no global tools found in configuration and no workflows matched`
      );
    }

    return tools;
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
      'ai.max_iterations',
      'ai.mcpServers',
      'ai.enableDelegate',
      'ai.enableTasks',
      // legacy persona/prompt keys supported in config
      'ai_persona',
      'ai_prompt_type',
      'ai_custom_prompt',
      'ai_system_prompt',
      'ai_max_iterations',
      // new provider resilience and tools toggles
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
      'ai_mcp_servers_js',
      'ai_custom_tools',
      'ai_custom_tools_js',
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
