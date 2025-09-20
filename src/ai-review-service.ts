import { ProbeAgent } from '@probelabs/probe';
import type { ProbeAgentOptions } from '@probelabs/probe';
import { PRInfo } from './pr-analyzer';
import { ReviewSummary, ReviewIssue } from './reviewer';
import { SessionRegistry } from './session-registry';

/**
 * Helper function to log messages respecting JSON/SARIF output format
 * Routes to stderr for JSON/SARIF to avoid contaminating structured output
 */
function log(...args: unknown[]): void {
  const isStructuredOutput =
    process.env.VISOR_OUTPUT_FORMAT === 'json' || process.env.VISOR_OUTPUT_FORMAT === 'sarif';
  const logFn = isStructuredOutput ? console.error : console.log;
  logFn(...args);
}

export interface AIReviewConfig {
  apiKey?: string; // From env: GOOGLE_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY
  model?: string; // From env: MODEL_NAME (e.g., gemini-2.5-pro-preview-06-05)
  timeout?: number; // Default: 600000ms (10 minutes)
  provider?: 'google' | 'anthropic' | 'openai' | 'mock';
  debug?: boolean; // Enable debug mode
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
  suggestions?: string[];
}

export class AIReviewService {
  private config: AIReviewConfig;
  private sessionRegistry: SessionRegistry;

  constructor(config: AIReviewConfig = {}) {
    this.config = {
      timeout: 600000, // Increased timeout to 10 minutes for AI responses
      ...config,
    };

    this.sessionRegistry = SessionRegistry.getInstance();

    // Auto-detect provider and API key from environment
    if (!this.config.apiKey) {
      if (process.env.GOOGLE_API_KEY) {
        this.config.apiKey = process.env.GOOGLE_API_KEY;
        this.config.provider = 'google';
      } else if (process.env.ANTHROPIC_API_KEY) {
        this.config.apiKey = process.env.ANTHROPIC_API_KEY;
        this.config.provider = 'anthropic';
      } else if (process.env.OPENAI_API_KEY) {
        this.config.apiKey = process.env.OPENAI_API_KEY;
        this.config.provider = 'openai';
      }
    }

    // Auto-detect model from environment
    if (!this.config.model && process.env.MODEL_NAME) {
      this.config.model = process.env.MODEL_NAME;
    }
  }

  /**
   * Execute AI review using probe agent
   */
  async executeReview(
    prInfo: PRInfo,
    customPrompt: string,
    schema?: string,
    _checkName?: string,
    sessionId?: string
  ): Promise<ReviewSummary> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    // Build prompt from custom instructions
    const prompt = await this.buildCustomPrompt(prInfo, customPrompt, schema);

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
        schemaName: schema,
        schema: undefined, // Will be populated when schema is loaded
      };
    }

    // Handle mock model/provider first (no API key needed)
    if (this.config.model === 'mock' || this.config.provider === 'mock') {
      log('🎭 Using mock AI model/provider for testing - skipping API key validation');
    } else {
      // Check if API key is available for real AI models
      if (!this.config.apiKey) {
        const errorMessage =
          'No API key configured. Please set GOOGLE_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY environment variable.';

        // In debug mode, return a review with the error captured
        if (debugInfo) {
          debugInfo.errors = [errorMessage];
          debugInfo.processingTime = Date.now() - startTime;
          debugInfo.rawResponse = 'API call not attempted - no API key configured';

          return {
            issues: [
              {
                file: 'system',
                line: 0,
                ruleId: 'system/api-key-missing',
                message: errorMessage,
                severity: 'error',
                category: 'logic',
              },
            ],
            suggestions: [
              'Configure API keys in your GitHub repository secrets or environment variables',
            ],
            debug: debugInfo,
          };
        }

        throw new Error(errorMessage);
      }
    }

    try {
      const { response, effectiveSchema } = await this.callProbeAgent(
        prompt,
        schema,
        debugInfo,
        _checkName,
        sessionId
      );
      const processingTime = Date.now() - startTime;

      if (debugInfo) {
        debugInfo.rawResponse = response;
        debugInfo.responseLength = response.length;
        debugInfo.processingTime = processingTime;
      }

      const result = this.parseAIResponse(response, debugInfo, effectiveSchema);

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
          suggestions: ['Check AI service configuration and API key validity'],
          debug: debugInfo,
        };
      }
      throw error;
    }
  }

  /**
   * Execute AI review using session reuse - reuses an existing ProbeAgent session
   */
  async executeReviewWithSessionReuse(
    prInfo: PRInfo,
    customPrompt: string,
    parentSessionId: string,
    schema?: string,
    checkName?: string
  ): Promise<ReviewSummary> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    // Get the existing session
    const existingAgent = this.sessionRegistry.getSession(parentSessionId);
    if (!existingAgent) {
      throw new Error(
        `Session not found for reuse: ${parentSessionId}. Ensure the parent check completed successfully.`
      );
    }

    // Build prompt from custom instructions
    const prompt = await this.buildCustomPrompt(prInfo, customPrompt, schema);

    log(`🔄 Reusing AI session ${parentSessionId} for review...`);
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
        schemaName: schema,
        schema: undefined, // Will be populated when schema is loaded
      };
    }

    try {
      // Use existing agent's answer method instead of creating new agent
      const { response, effectiveSchema } = await this.callProbeAgentWithExistingSession(
        existingAgent,
        prompt,
        schema,
        debugInfo,
        checkName
      );
      const processingTime = Date.now() - startTime;

      if (debugInfo) {
        debugInfo.rawResponse = response;
        debugInfo.responseLength = response.length;
        debugInfo.processingTime = processingTime;
      }

      const result = this.parseAIResponse(response, debugInfo, effectiveSchema);

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
              ruleId: 'system/ai-session-reuse-error',
              message: error instanceof Error ? error.message : String(error),
              severity: 'error',
              category: 'logic',
            },
          ],
          suggestions: [
            'Check session reuse configuration and ensure parent check completed successfully',
          ],
          debug: debugInfo,
        };
      }
      throw error;
    }
  }

  /**
   * Register a new AI session in the session registry
   */
  registerSession(sessionId: string, agent: ProbeAgent): void {
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
    _schema?: string
  ): Promise<string> {
    const prContext = this.formatPRContext(prInfo);
    const isIssue = (prInfo as any).isIssue === true;

    if (isIssue) {
      // Issue context - no code analysis needed
      return `You are an intelligent GitHub issue assistant.

REVIEW INSTRUCTIONS:
${customInstructions}

Analyze the following GitHub issue:

${prContext}

XML Data Structure Guide:
- <issue>: Root element containing all issue information
- <metadata>: Issue metadata (number, title, author, state, timestamps, comments count)
- <description>: Issue description/body text
- <labels>: Applied labels for categorization
- <assignees>: Users assigned to work on this issue
- <milestone>: Associated project milestone if any

IMPORTANT RULES:
1. Understand the issue context and requirements
2. Provide helpful, actionable guidance
3. Be constructive and supportive
4. Consider project conventions and patterns
5. Suggest practical solutions or next steps
6. Focus on addressing the specific concern raised in the issue`;
    }

    // PR context - original logic
    const analysisType = prInfo.isIncremental ? 'INCREMENTAL' : 'FULL';

    return `You are a senior code reviewer.

ANALYSIS TYPE: ${analysisType}
${
  analysisType === 'INCREMENTAL'
    ? '- You are analyzing a NEW COMMIT added to an existing PR. Focus on the <commit_diff> section for changes made in this specific commit.'
    : '- You are analyzing the COMPLETE PR. Review all changes in the <full_diff> section.'
}

REVIEW INSTRUCTIONS:
${customInstructions}

Analyze the following structured pull request data:

${prContext}

XML Data Structure Guide:
- <pull_request>: Root element containing all PR information
- <metadata>: PR metadata (number, title, author, branches, statistics)
- <description>: PR description text if provided
- <full_diff>: Complete unified diff of all changes (for FULL analysis)
- <commit_diff>: Diff of only the latest commit (for INCREMENTAL analysis)
- <files_summary>: List of all files changed with statistics

IMPORTANT RULES:
1. Only analyze code that appears with + (additions) or - (deletions) in the diff
2. Ignore unchanged code unless it's directly relevant to understanding a change
3. Line numbers in your response should match the actual file line numbers
4. Focus on real issues, not nitpicks
5. Provide actionable, specific feedback
6. For INCREMENTAL analysis, ONLY review changes in <commit_diff>
7. For FULL analysis, review all changes in <full_diff>`;
  }

  // REMOVED: Built-in prompts - only use custom prompts from .visor.yaml

  // REMOVED: getFocusInstructions - only use custom prompts from .visor.yaml

  /**
   * Format PR or Issue context for the AI using XML structure
   */
  private formatPRContext(prInfo: PRInfo): string {
    // Check if this is an issue (not a PR)
    const isIssue = (prInfo as any).isIssue === true;

    if (isIssue) {
      // Format as issue context
      let context = `<issue>
  <metadata>
    <number>${prInfo.number}</number>
    <title>${this.escapeXml(prInfo.title)}</title>
    <author>${prInfo.author}</author>
    <state>${(prInfo as any).eventContext?.issue?.state || 'open'}</state>
    <created_at>${(prInfo as any).eventContext?.issue?.created_at || ''}</created_at>
    <updated_at>${(prInfo as any).eventContext?.issue?.updated_at || ''}</updated_at>
    <comments_count>${(prInfo as any).eventContext?.issue?.comments || 0}</comments_count>
  </metadata>`;

      // Add issue body/description if available
      if (prInfo.body) {
        context += `
  <description>
${this.escapeXml(prInfo.body)}
  </description>`;
      }

      // Add labels if available
      const labels = (prInfo as any).eventContext?.issue?.labels;
      if (labels && labels.length > 0) {
        context += `
  <labels>`;
        labels.forEach((label: any) => {
          context += `
    <label>${this.escapeXml(label.name || label)}</label>`;
        });
        context += `
  </labels>`;
      }

      // Add assignees if available
      const assignees = (prInfo as any).eventContext?.issue?.assignees;
      if (assignees && assignees.length > 0) {
        context += `
  <assignees>`;
        assignees.forEach((assignee: any) => {
          context += `
    <assignee>${this.escapeXml(assignee.login || assignee)}</assignee>`;
        });
        context += `
  </assignees>`;
      }

      // Add milestone if available
      const milestone = (prInfo as any).eventContext?.issue?.milestone;
      if (milestone) {
        context += `
  <milestone>
    <title>${this.escapeXml(milestone.title || '')}</title>
    <state>${milestone.state || 'open'}</state>
    <due_on>${milestone.due_on || ''}</due_on>
  </milestone>`;
      }

      // Add current/triggering comment if this is a comment event
      const triggeringComment = (prInfo as any).eventContext?.comment;
      if (triggeringComment) {
        context += `
  <triggering_comment>
    <author>${this.escapeXml(triggeringComment.user?.login || 'unknown')}</author>
    <created_at>${triggeringComment.created_at || ''}</created_at>
    <body>${this.escapeXml(triggeringComment.body || '')}</body>
  </triggering_comment>`;
      }

      // Add comment history (excluding the current comment if it exists)
      const issueComments = (prInfo as any).comments;
      if (issueComments && issueComments.length > 0) {
        // Filter out the triggering comment from history if present
        const historicalComments = triggeringComment
          ? issueComments.filter((c: any) => c.id !== triggeringComment.id)
          : issueComments;

        if (historicalComments.length > 0) {
          context += `
  <comment_history>`;
          historicalComments.forEach((comment: any, index: number) => {
            context += `
    <comment index="${index + 1}">
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

    // Add PR description if available
    if (prInfo.body) {
      context += `
  <description>
${this.escapeXml(prInfo.body)}
  </description>`;
    }

    // Add full diff if available (for complete PR review)
    if (prInfo.fullDiff) {
      context += `
  <full_diff>
${this.escapeXml(prInfo.fullDiff)}
  </full_diff>`;
    }

    // Add incremental commit diff if available (for new commit analysis)
    if (prInfo.isIncremental) {
      if (prInfo.commitDiff && prInfo.commitDiff.length > 0) {
        context += `
  <commit_diff>
${this.escapeXml(prInfo.commitDiff)}
  </commit_diff>`;
      } else {
        context += `
  <commit_diff>
<!-- Commit diff could not be retrieved - falling back to full diff analysis -->
${prInfo.fullDiff ? this.escapeXml(prInfo.fullDiff) : ''}
  </commit_diff>`;
      }
    }

    // Add file summary for context
    if (prInfo.files.length > 0) {
      context += `
  <files_summary>`;
      prInfo.files.forEach((file, index) => {
        context += `
    <file index="${index + 1}">
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
    const triggeringComment = (prInfo as any).eventContext?.comment;
    if (triggeringComment) {
      context += `
  <triggering_comment>
    <author>${this.escapeXml(triggeringComment.user?.login || 'unknown')}</author>
    <created_at>${triggeringComment.created_at || ''}</created_at>
    <body>${this.escapeXml(triggeringComment.body || '')}</body>
  </triggering_comment>`;
    }

    // Add comment history (excluding the current comment if it exists)
    const prComments = (prInfo as any).comments;
    if (prComments && prComments.length > 0) {
      // Filter out the triggering comment from history if present
      const historicalComments = triggeringComment
        ? prComments.filter((c: any) => c.id !== triggeringComment.id)
        : prComments;

      if (historicalComments.length > 0) {
        context += `
  <comment_history>`;
        historicalComments.forEach((comment: any, index: number) => {
          context += `
    <comment index="${index + 1}">
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
   * No longer escaping XML - returning text as-is
   */
  private escapeXml(text: string): string {
    return text;
  }

  /**
   * Call ProbeAgent with an existing session
   */
  private async callProbeAgentWithExistingSession(
    agent: ProbeAgent,
    prompt: string,
    schema?: string,
    debugInfo?: AIDebugInfo,
    _checkName?: string
  ): Promise<{ response: string; effectiveSchema?: string }> {
    // Handle mock model/provider for testing
    if (this.config.model === 'mock' || this.config.provider === 'mock') {
      log('🎭 Using mock AI model/provider for testing (session reuse)');
      const response = await this.generateMockResponse(prompt);
      return { response, effectiveSchema: schema };
    }

    log('🔄 Reusing existing ProbeAgent session for AI review...');
    log(`📝 Prompt length: ${prompt.length} characters`);
    log(`⚙️ Model: ${this.config.model || 'default'}, Provider: ${this.config.provider || 'auto'}`);

    try {
      log('🚀 Calling existing ProbeAgent with answer()...');

      // Load and pass the actual schema content if provided (skip for plain schema)
      let schemaString: string | undefined = undefined;
      let effectiveSchema = schema;

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

      // Use existing agent's answer method - this reuses the conversation context
      const response = await agent.answer(prompt, undefined, schemaOptions);

      log('✅ ProbeAgent session reuse completed successfully');
      log(`📤 Response length: ${response.length} characters`);

      return { response, effectiveSchema };
    } catch (error) {
      console.error('❌ ProbeAgent session reuse failed:', error);
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
    schema?: string,
    debugInfo?: AIDebugInfo,
    _checkName?: string,
    providedSessionId?: string
  ): Promise<{ response: string; effectiveSchema?: string }> {
    // Handle mock model/provider for testing
    if (this.config.model === 'mock' || this.config.provider === 'mock') {
      log('🎭 Using mock AI model/provider for testing');
      const response = await this.generateMockResponse(prompt);
      return { response, effectiveSchema: schema };
    }

    // Create ProbeAgent instance with proper options
    const sessionId =
      providedSessionId ||
      (() => {
        const timestamp = new Date().toISOString();
        return `visor-${timestamp.replace(/[:.]/g, '-')}-${_checkName || 'unknown'}`;
      })();

    log('🤖 Creating ProbeAgent for AI review...');
    log(`🆔 Session ID: ${sessionId}`);
    log(`📝 Prompt length: ${prompt.length} characters`);
    log(`⚙️ Model: ${this.config.model || 'default'}, Provider: ${this.config.provider || 'auto'}`);

    // Store original env vars to restore later
    const originalEnv: Record<string, string | undefined> = {
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };

    try {
      // Set environment variables for ProbeAgent
      // ProbeAgent SDK expects these to be in the environment
      if (this.config.provider === 'google' && this.config.apiKey) {
        process.env.GOOGLE_API_KEY = this.config.apiKey;
      } else if (this.config.provider === 'anthropic' && this.config.apiKey) {
        process.env.ANTHROPIC_API_KEY = this.config.apiKey;
      } else if (this.config.provider === 'openai' && this.config.apiKey) {
        process.env.OPENAI_API_KEY = this.config.apiKey;
      }
      const options: ProbeAgentOptions = {
        sessionId: sessionId,
        promptType: schema ? ('code-review-template' as 'code-review') : undefined,
        allowEdit: false, // We don't want the agent to modify files
        debug: this.config.debug || false,
      };

      // Add provider-specific options if configured
      if (this.config.provider) {
        options.provider = this.config.provider;
      }
      if (this.config.model) {
        options.model = this.config.model;
      }

      const agent = new ProbeAgent(options);

      log('🚀 Calling ProbeAgent...');
      // Load and pass the actual schema content if provided (skip for plain schema)
      let schemaString: string | undefined = undefined;
      let effectiveSchema = schema;

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

      // Save prompt to a temp file for easier reproduction
      try {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const tempDir = os.tmpdir();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const promptFile = path.join(tempDir, `visor-prompt-${timestamp}.txt`);

        fs.writeFileSync(promptFile, prompt, 'utf-8');
        log(`\n💾 Prompt saved to: ${promptFile}`);

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

      const response = await agent.answer(prompt, undefined, schemaOptions);

      log('✅ ProbeAgent completed successfully');
      log(`📤 Response length: ${response.length} characters`);

      // Register the session for potential reuse by dependent checks
      if (_checkName) {
        this.registerSession(sessionId, agent);
        log(`🔧 Debug: Registered AI session for potential reuse: ${sessionId}`);
      }

      return { response, effectiveSchema };
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
   * Load schema content from schema files
   */
  private async loadSchemaContent(schemaName: string): Promise<string> {
    const fs = require('fs').promises;
    const path = require('path');

    // Sanitize schema name to prevent path traversal attacks
    const sanitizedSchemaName = schemaName.replace(/[^a-zA-Z0-9-]/g, '');
    if (!sanitizedSchemaName || sanitizedSchemaName !== schemaName) {
      throw new Error('Invalid schema name');
    }

    // Construct path to schema file using sanitized name
    const schemaPath = path.join(process.cwd(), 'output', sanitizedSchemaName, 'schema.json');

    try {
      // Return the schema as a string, not parsed JSON
      const schemaContent = await fs.readFile(schemaPath, 'utf-8');
      return schemaContent.trim();
    } catch (error) {
      throw new Error(
        `Failed to load schema from ${schemaPath}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Parse AI response JSON
   */
  private parseAIResponse(
    response: string,
    debugInfo?: AIDebugInfo,
    _schema?: string
  ): ReviewSummary {
    log('🔍 Parsing AI response...');
    log(`📊 Raw response length: ${response.length} characters`);

    // Log first and last 200 chars for debugging
    if (response.length > 400) {
      log('📋 Response preview (first 200 chars):', response.substring(0, 200));
      log('📋 Response preview (last 200 chars):', response.substring(response.length - 200));
    } else {
      log('📋 Full response preview:', response);
    }

    try {
      // Handle different schema types differently
      let reviewData: AIResponseFormat;

      // Handle plain schema or no schema - no JSON parsing, return response as-is
      if (_schema === 'plain' || !_schema) {
        log(
          `📋 ${_schema === 'plain' ? 'Plain' : 'No'} schema detected - returning raw response without JSON parsing`
        );
        return {
          issues: [],
          suggestions: [response.trim()],
          debug: debugInfo,
        };
      }

      {
        // For other schemas (code-review, etc.), extract and parse JSON with boundary detection
        log('🔍 Extracting JSON from AI response...');

        // Try direct parsing first - if AI returned pure JSON
        try {
          reviewData = JSON.parse(response.trim());
          log('✅ Successfully parsed direct JSON response');
          if (debugInfo) debugInfo.jsonParseSuccess = true;
        } catch {
          log('🔍 Direct parsing failed, trying to extract JSON from response...');

          // If the response starts with "I cannot" or similar, it's likely a refusal
          if (
            response.toLowerCase().includes('i cannot') ||
            response.toLowerCase().includes('unable to')
          ) {
            console.error('🚫 AI refused to analyze - returning empty result');
            return {
              issues: [],
              suggestions: [
                'AI was unable to analyze this code. Please check the content or try again.',
              ],
            };
          }

          // Try to extract JSON using improved method with proper bracket matching
          const jsonString = this.extractJsonFromResponse(response);

          if (jsonString) {
            try {
              reviewData = JSON.parse(jsonString);
              log('✅ Successfully parsed extracted JSON');
              if (debugInfo) debugInfo.jsonParseSuccess = true;
            } catch {
              log('🔧 Extracted JSON parsing failed, falling back to plain text handling...');

              // Check if response is plain text and doesn't contain structured data
              if (!response.includes('{') && !response.includes('}')) {
                log('🔧 Plain text response detected, creating structured fallback...');

                const isNoChanges =
                  response.toLowerCase().includes('no') &&
                  (response.toLowerCase().includes('changes') ||
                    response.toLowerCase().includes('code'));

                reviewData = {
                  issues: [],
                  suggestions: isNoChanges
                    ? ['No code changes detected in this analysis']
                    : [
                        `AI response: ${response.substring(0, 200)}${response.length > 200 ? '...' : ''}`,
                      ],
                };
              } else {
                // Fallback: treat the entire response as a suggestion
                log('🔧 Creating fallback response from non-JSON content...');
                reviewData = {
                  issues: [],
                  suggestions: [response.trim()],
                };
              }
            }
          } else {
            // No JSON found at all - treat as plain text response
            log('🔧 No JSON found in response, treating as plain text...');
            reviewData = {
              issues: [],
              suggestions: [response.trim()],
            };
          }
        }
      }

      // Standard code-review schema processing
      log('🔍 Validating parsed review data...');
      log(`📊 Overall score: ${0}`);
      log(`📋 Total issues: ${reviewData.issues?.length || 0}`);
      log(
        `🚨 Critical issues: ${reviewData.issues?.filter((i: { severity?: string }) => i.severity === 'critical').length || 0}`
      );
      log(
        `💡 Suggestions count: ${Array.isArray(reviewData.suggestions) ? reviewData.suggestions.length : 0}`
      );
      log(`💬 Comments count: ${Array.isArray(reviewData.issues) ? reviewData.issues.length : 0}`);

      // Process issues from the simplified format
      const processedIssues = Array.isArray(reviewData.issues)
        ? reviewData.issues.map((issue, index) => {
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
        suggestions: Array.isArray(reviewData.suggestions) ? reviewData.suggestions : [],
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
      console.error('❌ Failed to parse AI response:', error);
      console.error('📄 FULL RAW RESPONSE:');
      console.error('='.repeat(80));
      console.error(response);
      console.error('='.repeat(80));
      console.error(`📏 Response length: ${response.length} characters`);

      // Try to provide more helpful error information
      if (error instanceof SyntaxError) {
        console.error('🔍 JSON parsing error - the response may not be valid JSON');
        console.error('🔍 Error details:', error.message);

        // Try to identify where the parsing failed
        const errorMatch = error.message.match(/position (\d+)/);
        if (errorMatch) {
          const position = parseInt(errorMatch[1]);
          console.error(`🔍 Error at position ${position}:`);
          const start = Math.max(0, position - 50);
          const end = Math.min(response.length, position + 50);
          console.error(`🔍 Context: "${response.substring(start, end)}"`);

          // Show the first 100 characters to understand what format the AI returned
          console.error(`🔍 Response beginning: "${response.substring(0, 100)}"`);
        }

        // Check if response contains common non-JSON patterns
        if (response.includes('I cannot')) {
          console.error('🔍 Response appears to be a refusal/explanation rather than JSON');
        }
        if (response.includes('```')) {
          console.error('🔍 Response appears to contain markdown code blocks');
        }
        if (response.startsWith('<')) {
          console.error('🔍 Response appears to start with XML/HTML');
        }
      }

      throw new Error(
        `Invalid AI response format: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Extract JSON from a response that might contain surrounding text
   * Uses proper bracket matching to find valid JSON objects or arrays
   */
  private extractJsonFromResponse(response: string): string | null {
    const text = response.trim();

    // Try to find JSON objects first (higher priority)
    let bestJson = this.findJsonWithBracketMatching(text, '{', '}');

    // If no object found, try arrays
    if (!bestJson) {
      bestJson = this.findJsonWithBracketMatching(text, '[', ']');
    }

    return bestJson;
  }

  /**
   * Find JSON with proper bracket matching to avoid false positives
   */
  private findJsonWithBracketMatching(
    text: string,
    openChar: string,
    closeChar: string
  ): string | null {
    const firstIndex = text.indexOf(openChar);
    if (firstIndex === -1) return null;

    let depth = 0;
    let inString = false;
    let escaping = false;

    for (let i = firstIndex; i < text.length; i++) {
      const char = text[i];

      if (escaping) {
        escaping = false;
        continue;
      }

      if (char === '\\' && inString) {
        escaping = true;
        continue;
      }

      if (char === '"' && !escaping) {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === openChar) {
          depth++;
        } else if (char === closeChar) {
          depth--;
          if (depth === 0) {
            // Found matching closing bracket
            const candidate = text.substring(firstIndex, i + 1);
            try {
              JSON.parse(candidate); // Validate it's actually valid JSON
              return candidate;
            } catch {
              // This wasn't valid JSON, keep looking
              break;
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Generate mock response for testing
   */
  private async generateMockResponse(_prompt: string): Promise<string> {
    // Simulate some processing time
    await new Promise(resolve => setTimeout(resolve, 500));

    // Generate mock response based on prompt content
    const mockResponse = {
      content: JSON.stringify({
        issues: [
          {
            file: 'test.ts',
            line: 7,
            endLine: 11,
            ruleId: 'security/sql-injection',
            message: 'SQL injection vulnerability detected in dynamic query construction',
            severity: 'critical',
            category: 'security',
            suggestion: 'Use parameterized queries or ORM methods to prevent SQL injection',
          },
          {
            file: 'test.ts',
            line: 14,
            endLine: 23,
            ruleId: 'performance/nested-loops',
            message: 'Inefficient nested loops with O(n²) complexity',
            severity: 'warning',
            category: 'performance',
            suggestion: 'Consider using more efficient algorithms or caching mechanisms',
          },
          {
            file: 'test.ts',
            line: 28,
            ruleId: 'style/inconsistent-naming',
            message: 'Inconsistent variable naming and formatting',
            severity: 'info',
            category: 'style',
            suggestion: 'Use consistent camelCase naming and proper spacing',
          },
        ],
        summary: {
          totalIssues: 3,
          criticalIssues: 1,
        },
      }),
    };

    return JSON.stringify(mockResponse);
  }

  /**
   * Get the API key source for debugging (without revealing the key)
   */
  private getApiKeySource(): string {
    if (process.env.GOOGLE_API_KEY && this.config.provider === 'google') {
      return 'GOOGLE_API_KEY';
    }
    if (process.env.ANTHROPIC_API_KEY && this.config.provider === 'anthropic') {
      return 'ANTHROPIC_API_KEY';
    }
    if (process.env.OPENAI_API_KEY && this.config.provider === 'openai') {
      return 'OPENAI_API_KEY';
    }
    return 'unknown';
  }
}
