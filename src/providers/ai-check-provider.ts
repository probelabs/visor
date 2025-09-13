import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import { AIReviewService, AIReviewConfig } from '../ai-review-service';
import { PromptConfig } from '../types/config';
import { Liquid } from 'liquidjs';
import fs from 'fs/promises';
import path from 'path';

/**
 * AI-powered check provider using probe agent
 */
export class AICheckProvider extends CheckProvider {
  private aiReviewService: AIReviewService;
  private liquidEngine: Liquid;

  constructor() {
    super();
    this.aiReviewService = new AIReviewService();
    this.liquidEngine = new Liquid();
  }

  getName(): string {
    return 'ai';
  }

  getDescription(): string {
    return 'AI-powered code review using Google Gemini, Anthropic Claude, or OpenAI GPT models';
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
        !['google', 'anthropic', 'openai'].includes(cfg.ai.provider as string)
      ) {
        return false;
      }
    }

    return true;
  }

  /**
   * Group files by their file extension for template context
   */
  private groupFilesByExtension(files: any[]): Record<string, any[]> {
    const grouped: Record<string, any[]> = {};

    files.forEach(file => {
      const parts = file.filename.split('.');
      const ext = parts.length > 1 ? parts.pop()?.toLowerCase() : 'noext';
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
    promptConfig: string | PromptConfig,
    prInfo: PRInfo,
    eventContext?: any,
    dependencyResults?: Map<string, ReviewSummary>
  ): Promise<string> {
    let promptContent: string;

    // Handle string prompt (backward compatibility)
    if (typeof promptConfig === 'string') {
      promptContent = promptConfig;
    } else {
      // Handle PromptConfig object
      if (promptConfig.content) {
        promptContent = promptConfig.content;
      } else if (promptConfig.file) {
        promptContent = await this.loadPromptFromFile(promptConfig.file);
      } else {
        throw new Error('Prompt configuration must specify either "file" or "content"');
      }
    }

    // Process Liquid templates in the prompt
    return await this.renderPromptTemplate(promptContent, prInfo, eventContext, dependencyResults);
  }

  /**
   * Load prompt content from file with security validation
   */
  private async loadPromptFromFile(promptPath: string): Promise<string> {
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
    eventContext?: any,
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

            // Repository Info
            repository: eventContext.repository
              ? {
                  owner: eventContext.repository.owner?.login,
                  name: eventContext.repository.name,
                  fullName: eventContext.repository
                    ? `${eventContext.repository.owner?.login}/${eventContext.repository.name}`
                    : undefined,
                }
              : undefined,

            // Comment Data (for comment events)
            comment: eventContext.comment
              ? {
                  body: eventContext.comment.body,
                  author: eventContext.comment.user?.login,
                }
              : undefined,

            // Issue Data (for issue events)
            issue: eventContext.issue
              ? {
                  number: eventContext.issue.number,
                  isPullRequest: !!eventContext.issue.pull_request,
                }
              : undefined,

            // Pull Request Event Data
            pullRequest: eventContext.pull_request
              ? {
                  number: eventContext.pull_request.number,
                  state: eventContext.pull_request.state,
                  draft: eventContext.pull_request.draft,
                  headSha: eventContext.pull_request.head?.sha,
                  headRef: eventContext.pull_request.head?.ref,
                  baseSha: eventContext.pull_request.base?.sha,
                  baseRef: eventContext.pull_request.base?.ref,
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
      outputs: dependencyResults
        ? Object.fromEntries(
            Array.from(dependencyResults.entries()).map(([checkName, result]) => [
              checkName,
              {
                // Summary data
                totalIssues: result.issues?.length || 0,
                criticalIssues: result.issues?.filter(i => i.severity === 'critical').length || 0,
                errorIssues: result.issues?.filter(i => i.severity === 'error').length || 0,
                warningIssues: result.issues?.filter(i => i.severity === 'warning').length || 0,
                infoIssues: result.issues?.filter(i => i.severity === 'info').length || 0,

                // Issues grouped by category
                securityIssues: result.issues?.filter(i => i.category === 'security') || [],
                performanceIssues: result.issues?.filter(i => i.category === 'performance') || [],
                styleIssues: result.issues?.filter(i => i.category === 'style') || [],
                logicIssues: result.issues?.filter(i => i.category === 'logic') || [],
                documentationIssues:
                  result.issues?.filter(i => i.category === 'documentation') || [],

                // All issues and suggestions
                issues: result.issues || [],
                suggestions: result.suggestions || [],

                // Debug information if available
                debug: result.debug,

                // Raw data for advanced use
                raw: result,
              },
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

  async execute(
    prInfo: PRInfo,
    config: CheckProviderConfig,
    _dependencyResults?: Map<string, ReviewSummary>
  ): Promise<ReviewSummary> {
    // Extract AI configuration - only set properties that are explicitly provided
    const aiConfig: AIReviewConfig = {};

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
        aiConfig.provider = config.ai.provider as 'google' | 'anthropic' | 'openai';
      }
      if (config.ai.debug !== undefined) {
        aiConfig.debug = config.ai.debug as boolean;
      }
    }

    // Get custom prompt from config - REQUIRED, no fallbacks
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
      _dependencyResults
    );

    // Create AI service with config - environment variables will be used if aiConfig is empty
    const service = new AIReviewService(aiConfig);

    console.error(
      `🔧 Debug: AICheckProvider using processed prompt: ${processedPrompt.substring(0, 100)}...`
    );

    // Pass the custom prompt and schema - no fallbacks
    const schema = config.schema as string | undefined;
    console.error(`🔧 Debug: AICheckProvider schema from config: ${JSON.stringify(schema)}`);
    console.error(`🔧 Debug: AICheckProvider full config: ${JSON.stringify(config, null, 2)}`);

    try {
      return await service.executeReview(prInfo, processedPrompt, schema);
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
    ];
  }

  async isAvailable(): Promise<boolean> {
    // Check if any AI API key is available
    return !!(
      process.env.GOOGLE_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.OPENAI_API_KEY
    );
  }

  getRequirements(): string[] {
    return [
      'At least one of: GOOGLE_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY',
      'Optional: MODEL_NAME environment variable',
      'Network access to AI provider APIs',
    ];
  }
}
