import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import { EnvironmentResolver } from '../utils/env-resolver';
import { IssueFilter } from '../issue-filter';
import { Liquid } from 'liquidjs';
import { createExtendedLiquid } from '../liquid-extensions';
import fs from 'fs/promises';
import path from 'path';
import {
  ClaudeCodeQuery,
  ClaudeCodeResponse,
  ClaudeCodeConfig,
  ClaudeCodeClient,
  safeImport,
} from './claude-code-types';

type ClaudeCodeConstructor = new (options: { apiKey: string }) => ClaudeCodeClient;

function isClaudeCodeConstructor(value: unknown): value is ClaudeCodeConstructor {
  return typeof value === 'function';
}

/**
 * Error thrown when Claude Code SDK is not installed
 */
export class ClaudeCodeSDKNotInstalledError extends Error {
  constructor() {
    super(
      'Claude Code SDK is not installed. Install with: npm install @anthropic/claude-code-sdk @modelcontextprotocol/sdk'
    );
    this.name = 'ClaudeCodeSDKNotInstalledError';
  }
}

/**
 * Error thrown when Claude Code API key is not configured
 */
export class ClaudeCodeAPIKeyMissingError extends Error {
  constructor() {
    super(
      'No API key found for Claude Code provider. Set CLAUDE_CODE_API_KEY or ANTHROPIC_API_KEY environment variable.'
    );
    this.name = 'ClaudeCodeAPIKeyMissingError';
  }
}

/**
 * Claude Code check provider using the Claude Code TypeScript SDK
 * Supports MCP tools and streaming responses
 */
export class ClaudeCodeCheckProvider extends CheckProvider {
  private liquidEngine: Liquid;
  private claudeCodeClient: ClaudeCodeClient | null = null;

  constructor() {
    super();
    this.liquidEngine = createExtendedLiquid();
  }

  getName(): string {
    return 'claude-code';
  }

  getDescription(): string {
    return 'AI-powered code review using Claude Code with MCP tools support';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    if (!config || typeof config !== 'object') {
      return false;
    }

    const cfg = config as CheckProviderConfig;

    // Type must be 'claude-code'
    if (cfg.type !== 'claude-code') {
      return false;
    }

    // Check for prompt
    if (!cfg.prompt || typeof cfg.prompt !== 'string') {
      return false;
    }

    // Validate Claude Code specific configuration
    if (cfg.claude_code) {
      const claudeCodeConfig = cfg.claude_code as ClaudeCodeConfig;

      // Validate allowedTools if present
      if (claudeCodeConfig.allowedTools && !Array.isArray(claudeCodeConfig.allowedTools)) {
        return false;
      }

      // Validate maxTurns if present
      if (claudeCodeConfig.maxTurns && typeof claudeCodeConfig.maxTurns !== 'number') {
        return false;
      }

      // Validate systemPrompt if present
      if (claudeCodeConfig.systemPrompt && typeof claudeCodeConfig.systemPrompt !== 'string') {
        return false;
      }

      // Validate mcpServers if present
      if (claudeCodeConfig.mcpServers) {
        if (typeof claudeCodeConfig.mcpServers !== 'object') {
          return false;
        }

        for (const serverConfig of Object.values(claudeCodeConfig.mcpServers)) {
          if (!serverConfig.command || typeof serverConfig.command !== 'string') {
            return false;
          }
          if (serverConfig.args && !Array.isArray(serverConfig.args)) {
            return false;
          }
        }
      }
    }

    return true;
  }

  /**
   * Initialize Claude Code SDK client
   */
  private async initializeClaudeCodeClient(): Promise<ClaudeCodeClient> {
    if (this.claudeCodeClient) {
      return this.claudeCodeClient;
    }

    // Use safe import to avoid TypeScript compilation errors
    const claudeCodeModule = await safeImport<{
      ClaudeCode?: unknown;
      default?: { ClaudeCode?: unknown };
    }>('@anthropic/claude-code-sdk');

    if (!claudeCodeModule) {
      throw new ClaudeCodeSDKNotInstalledError();
    }

    const ClaudeCodeCtor = claudeCodeModule.ClaudeCode || claudeCodeModule.default?.ClaudeCode;

    if (!isClaudeCodeConstructor(ClaudeCodeCtor)) {
      throw new Error('ClaudeCode class not found in @anthropic/claude-code-sdk');
    }

    // Initialize with API key from environment
    const apiKey = process.env.CLAUDE_CODE_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new ClaudeCodeAPIKeyMissingError();
    }

    try {
      const client = new ClaudeCodeCtor({
        apiKey,
      }) as ClaudeCodeClient;

      this.claudeCodeClient = client;
      return client;
    } catch (error) {
      throw new Error(
        `Failed to initialize Claude Code SDK: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
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
    if (
      /\s{2,}/.test(str) || // Multiple consecutive spaces
      /\n/.test(str) || // Contains newlines
      /^(please|analyze|review|check|find|identify|look|search)/i.test(str.trim()) || // Starts with command words
      str.split(' ').length > 8 // Too many words for a typical file path
    ) {
      return false;
    }

    // For strings with path separators, be more lenient about common words
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
      try {
        const stat = await fs.stat(resolvedPath);
        return stat.isFile();
      } catch {
        // File doesn't exist, but might still be a valid file path format
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
   * Render Liquid template in prompt with comprehensive context
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
            isPullRequest: !prInfo.isIssue,

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
              // If the result has a direct output field, use it directly
              // Otherwise, expose the entire result
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
   * Parse structured response from Claude Code
   */
  private parseStructuredResponse(content: string): ReviewSummary {
    try {
      // Try to parse as JSON first
      const parsed = JSON.parse(content);

      // Convert to ReviewSummary format
      return {
        issues: parsed.issues || [],
      };
    } catch {
      // If not JSON, treat as plain text comment
      return {
        issues: [],
      };
    }
  }

  async execute(
    prInfo: PRInfo,
    config: CheckProviderConfig,
    dependencyResults?: Map<string, ReviewSummary>,
    sessionInfo?: { parentSessionId?: string; reuseSession?: boolean }
  ): Promise<ReviewSummary> {
    // Apply environment configuration if present
    if (config.env) {
      const result = EnvironmentResolver.withTemporaryEnv(config.env, () => {
        return this.executeWithConfig(prInfo, config, dependencyResults, sessionInfo);
      });

      if (result instanceof Promise) {
        return result;
      }
      return result;
    }

    return this.executeWithConfig(prInfo, config, dependencyResults, sessionInfo);
  }

  private async executeWithConfig(
    prInfo: PRInfo,
    config: CheckProviderConfig,
    dependencyResults?: Map<string, ReviewSummary>,
    sessionInfo?: { parentSessionId?: string; reuseSession?: boolean }
  ): Promise<ReviewSummary> {
    // Extract Claude Code configuration
    const claudeCodeConfig = (config.claude_code as ClaudeCodeConfig) || {};

    // Get custom prompt from config - REQUIRED
    const customPrompt = config.prompt;
    if (!customPrompt) {
      throw new Error(
        `No prompt defined for check. All checks must have prompts defined in .visor.yaml configuration.`
      );
    }

    // Process prompt with Liquid templates and file loading
    const processedPrompt = await this.processPrompt(
      customPrompt,
      prInfo,
      config.eventContext,
      dependencyResults
    );

    const startTime = Date.now();

    try {
      // Initialize Claude Code client
      const client = await this.initializeClaudeCodeClient();

      // Prepare query object with MCP servers passed directly to SDK
      const query: ClaudeCodeQuery = {
        query: processedPrompt,
        maxTurns: claudeCodeConfig.maxTurns || 5,
        systemPrompt: claudeCodeConfig.systemPrompt,
        subagent: claudeCodeConfig.subagent,
      };

      // Add allowed tools if specified
      if (claudeCodeConfig.allowedTools && claudeCodeConfig.allowedTools.length > 0) {
        query.tools = claudeCodeConfig.allowedTools.map(name => ({ name }));
      }

      // Pass MCP servers directly to the SDK - let it handle spawning and tool discovery
      if (claudeCodeConfig.mcpServers && Object.keys(claudeCodeConfig.mcpServers).length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (query as any).mcpServers = claudeCodeConfig.mcpServers;
      }

      // Execute query with Claude Code
      let response: ClaudeCodeResponse;

      if (sessionInfo?.reuseSession && sessionInfo.parentSessionId) {
        // Use session reuse if available
        response = await client.query({
          ...query,
          sessionId: sessionInfo.parentSessionId,
        });
      } else {
        // Create new session
        response = await client.query(query);
      }

      // Parse the response
      const result = this.parseStructuredResponse(response.content) as ReviewSummary & {
        debug?: import('../ai-review-service').AIDebugInfo & {
          sessionId?: string;
          turnCount?: number;
          usage?: unknown;
          toolsUsed?: string[];
        };
      };

      result.debug = {
        prompt: processedPrompt,
        rawResponse: response.content,
        provider: 'claude-code',
        model: 'claude-code',
        apiKeySource: 'CLAUDE_CODE_API_KEY',
        processingTime: Date.now() - startTime,
        promptLength: processedPrompt.length,
        responseLength: response.content.length,
        jsonParseSuccess: true,
        errors: [],
        checksExecuted: [config.checkName || 'claude-code-check'],
        parallelExecution: false,
        timestamp: new Date().toISOString(),
        // Claude Code specific debug info
        sessionId: response.session_id,
        turnCount: response.turn_count,
        usage: response.usage,
      };

      // Apply issue suppression filtering
      const suppressionEnabled = config.suppressionEnabled !== false;
      const issueFilter = new IssueFilter(suppressionEnabled);
      const filteredIssues = issueFilter.filterIssues(result.issues || [], process.cwd());

      return {
        ...result,
        issues: filteredIssues,
      };
    } catch (error) {
      // Re-throw setup/configuration errors that should terminate the application
      if (
        error instanceof ClaudeCodeSDKNotInstalledError ||
        error instanceof ClaudeCodeAPIKeyMissingError
      ) {
        throw error;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);

      // Log detailed error information
      console.error(`❌ Claude Code Check Provider Error: ${errorMessage}`);

      // Check if this is a critical error
      const isCriticalError =
        errorMessage.includes('API rate limit') ||
        errorMessage.includes('403') ||
        errorMessage.includes('401') ||
        errorMessage.includes('authentication');

      if (isCriticalError) {
        console.error(
          `🚨 CRITICAL ERROR: Claude Code provider authentication or setup issue detected`
        );
        console.error(
          `🚨 This check cannot proceed without valid API credentials and SDK installation`
        );
      }

      // Re-throw with more context
      throw new Error(`Claude Code analysis failed: ${errorMessage}`);
    }
  }

  getSupportedConfigKeys(): string[] {
    return [
      'type',
      'prompt',
      'claude_code.allowedTools',
      'claude_code.maxTurns',
      'claude_code.systemPrompt',
      'claude_code.mcpServers',
      'claude_code.subagent',
      'claude_code.hooks',
      'env',
      'checkName',
      'sessionId',
      'suppressionEnabled',
    ];
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Check if Claude Code API key is available
      const hasApiKey = !!(process.env.CLAUDE_CODE_API_KEY || process.env.ANTHROPIC_API_KEY);

      if (!hasApiKey) {
        return false;
      }

      // Try to import the SDK to check if it's installed
      const claudeCodeModule = await safeImport<{
        ClaudeCode?: unknown;
        default?: { ClaudeCode?: unknown };
      }>('@anthropic/claude-code-sdk');
      if (!claudeCodeModule) {
        return false;
      }
      const ClaudeCode = claudeCodeModule.ClaudeCode || claudeCodeModule.default?.ClaudeCode;

      return !!ClaudeCode;
    } catch {
      // If import fails, the SDK is not installed
      return false;
    }
  }

  getRequirements(): string[] {
    return [
      'CLAUDE_CODE_API_KEY or ANTHROPIC_API_KEY environment variable',
      '@anthropic/claude-code-sdk npm package',
      '@modelcontextprotocol/sdk npm package (for MCP support)',
      'Network access to Claude Code API',
    ];
  }
}
