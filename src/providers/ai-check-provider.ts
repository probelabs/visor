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
import { safeImport } from './claude-code-types';
import type { AIProviderConfig } from '../types/config';

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

    // Validate focus if specified
    if (cfg.focus && !['security', 'performance', 'style', 'all'].includes(cfg.focus as string)) {
      return false;
    }

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
    dependencyResults?: Map<string, ReviewSummary>
  ): Promise<string> {
    let promptContent: string;

    // Auto-detect if it's a file path or inline content
    if (await this.isFilePath(promptConfig)) {
      promptContent = await this.loadPromptFromFile(promptConfig);
    } else {
      promptContent = promptConfig;
    }

    // Process Liquid templates in the prompt
    return await this.renderPromptTemplate(promptContent, prInfo, eventContext, dependencyResults);
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
    dependencyResults?: Map<string, ReviewSummary>
  ): Promise<string> {
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
    };

    try {
      return await this.liquidEngine.parseAndRender(promptContent, templateContext);
    } catch (error) {
      throw new Error(
        `Failed to render prompt template: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  /**
   * Setup MCP tools based on AI configuration
   */
  private async setupMcpTools(
    aiConfig: AIProviderConfig
  ): Promise<Array<{ name: string; [key: string]: unknown }>> {
    const tools: Array<{ name: string; [key: string]: unknown }> = [];

    // Setup custom MCP servers if configured
    if (aiConfig.mcpServers) {
      try {
        // Import MCP SDK for custom server creation using safe import
        const mcpModule = await safeImport<{
          createSdkMcpServer?: unknown;
          default?: { createSdkMcpServer?: unknown };
        }>('@modelcontextprotocol/sdk');

        if (!mcpModule) {
          console.warn('@modelcontextprotocol/sdk package not found. MCP servers disabled.');
          return tools;
        }

        const createSdkMcpServer =
          mcpModule.createSdkMcpServer || mcpModule.default?.createSdkMcpServer;

        if (typeof createSdkMcpServer === 'function') {
          for (const [serverName, serverConfig] of Object.entries(aiConfig.mcpServers)) {
            try {
              // Create MCP server instance
              const server = await createSdkMcpServer({
                name: serverName,
                command: serverConfig.command,
                args: serverConfig.args || [],
                env: { ...process.env, ...serverConfig.env },
              });

              // Add server tools to available tools
              const serverTools = (await server.listTools()) as Array<{ name: string }>;
              tools.push(
                ...serverTools.map(tool => ({
                  name: tool.name,
                  server: serverName,
                }))
              );
            } catch (serverError) {
              console.warn(
                `Failed to setup MCP server ${serverName}: ${serverError instanceof Error ? serverError.message : 'Unknown error'}`
              );
            }
          }
        } else {
          console.warn(
            'createSdkMcpServer function not found in @modelcontextprotocol/sdk. MCP servers disabled.'
          );
        }
      } catch (error) {
        console.warn(
          `Failed to import MCP SDK: ${error instanceof Error ? error.message : 'Unknown error'}. MCP servers disabled.`
        );
      }
    }

    return tools;
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
    sessionInfo?: { parentSessionId?: string; reuseSession?: boolean }
  ): Promise<ReviewSummary> {
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

    // Setup MCP tools if any servers are configured
    if (Object.keys(mcpServers).length > 0) {
      const mcpConfig: import('../types/config').AIProviderConfig = { mcpServers };
      const mcpTools = await this.setupMcpTools(mcpConfig);
      if (mcpTools.length > 0) {
        aiConfig.tools = mcpTools;
        if (aiConfig.debug) {
          console.error(
            `🔧 Debug: AI check configured with ${mcpTools.length} MCP tools from ${Object.keys(mcpServers).length} servers`
          );
        }
      }
    }

    // Process prompt with Liquid templates and file loading
    const processedPrompt = await this.processPrompt(
      customPrompt,
      prInfo,
      config.eventContext,
      _dependencyResults
    );

    // Create AI service with config - environment variables will be used if aiConfig is empty
    const service = new AIReviewService(aiConfig);

    // Pass the custom prompt and schema - no fallbacks
    const schema = config.schema as string | Record<string, unknown> | undefined;

    // Only output debug messages if debug mode is enabled
    if (aiConfig.debug) {
      console.error(
        `🔧 Debug: AICheckProvider using processed prompt: ${processedPrompt.substring(0, 100)}...`
      );
      console.error(`🔧 Debug: AICheckProvider schema from config: ${JSON.stringify(schema)}`);
      console.error(`🔧 Debug: AICheckProvider full config: ${JSON.stringify(config, null, 2)}`);
    }

    try {
      if (aiConfig.debug) {
        console.error(
          `🔧 Debug: AICheckProvider passing checkName: ${config.checkName} to service`
        );
      }

      let result: ReviewSummary;

      // Check if we should use session reuse
      if (sessionInfo?.reuseSession && sessionInfo.parentSessionId) {
        if (aiConfig.debug) {
          console.error(
            `🔄 Debug: Using session reuse with parent session: ${sessionInfo.parentSessionId}`
          );
        }
        result = await service.executeReviewWithSessionReuse(
          prInfo,
          processedPrompt,
          sessionInfo.parentSessionId,
          schema,
          config.checkName
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

      return {
        ...result,
        issues: filteredIssues,
      };
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
