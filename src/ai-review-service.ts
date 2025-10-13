import { ProbeAgent } from '@probelabs/probe';
import type { ProbeAgentOptions } from '@probelabs/probe';
import { PRInfo } from './pr-analyzer';
import { ReviewSummary, ReviewIssue } from './reviewer';
import { SessionRegistry } from './session-registry';
import { logger } from './logger';

/**
 * Helper function to log debug messages using the centralized logger
 */
function log(...args: unknown[]): void {
  logger.debug(args.join(' '));
}

export interface AIReviewConfig {
  apiKey?: string; // From env: GOOGLE_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, CLAUDE_CODE_API_KEY, or AWS credentials
  model?: string; // From env: MODEL_NAME (e.g., gemini-2.5-pro-preview-06-05)
  timeout?: number; // Default: 600000ms (10 minutes)
  provider?: 'google' | 'anthropic' | 'openai' | 'bedrock' | 'mock' | 'claude-code';
  debug?: boolean; // Enable debug mode
  tools?: Array<{ name: string; [key: string]: unknown }>; // (unused) Legacy tool listing
  // Pass-through MCP server configuration for ProbeAgent
  mcpServers?: Record<string, import('./types/config').McpServerConfig>;
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
      timeout: 600000, // Increased timeout to 10 minutes for AI responses
      ...config,
    };

    this.sessionRegistry = SessionRegistry.getInstance();

    // Auto-detect provider and API key from environment
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
    schema?: string | Record<string, unknown>,
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
        schemaName: typeof schema === 'object' ? 'custom' : schema,
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
          'No API key configured. Please set GOOGLE_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY environment variable, or configure AWS credentials for Bedrock (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY).';

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

    // Get the existing session
    const existingAgent = this.sessionRegistry.getSession(parentSessionId);
    if (!existingAgent) {
      throw new Error(
        `Session not found for reuse: ${parentSessionId}. Ensure the parent check completed successfully.`
      );
    }

    // Build prompt from custom instructions
    const prompt = await this.buildCustomPrompt(prInfo, customPrompt, schema);

    // Determine which agent to use based on session mode
    let agentToUse: typeof existingAgent;
    let currentSessionId: string;

    if (sessionMode === 'clone') {
      // Clone the session - creates a new agent with copied history
      currentSessionId = `${parentSessionId}-clone-${Date.now()}`;
      log(`📋 Cloning AI session ${parentSessionId} → ${currentSessionId}...`);

      const clonedAgent = await this.sessionRegistry.cloneSession(
        parentSessionId,
        currentSessionId
      );
      if (!clonedAgent) {
        throw new Error(`Failed to clone session ${parentSessionId}. Falling back to append mode.`);
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
      const { response, effectiveSchema } = await this.callProbeAgentWithExistingSession(
        agentToUse,
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
   * Clean validation/correction messages and schema-formatted responses from ProbeAgent history
   * This prevents:
   * 1. Validation retry messages from polluting conversation
   * 2. Previous schema format from influencing next check's output format
   */
  private cleanValidationMessagesFromHistory(agent: ProbeAgent): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const history = (agent as any).history || [];

    if (!Array.isArray(history) || history.length === 0) {
      return;
    }

    // Patterns that identify validation/correction messages from ProbeAgent
    const validationPatterns = [
      /CRITICAL JSON ERROR:/i,
      /URGENT.*JSON PARSING FAILED:/i,
      /FINAL ATTEMPT.*CRITICAL JSON ERROR:/i,
      /Your previous response was not valid JSON/i,
      /The JSON response you provided/i,
      /must return.*valid JSON/i,
      /You returned a JSON schema definition instead of data/i,
    ];

    const originalLength = history.length;
    const cleanedHistory = [];

    // Keep system message and filter out validation rounds
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];

      // Always keep system messages
      if (msg.role === 'system') {
        cleanedHistory.push(msg);
        continue;
      }

      // Check if this is a validation correction prompt
      const isValidationMessage = validationPatterns.some(
        pattern => typeof msg.content === 'string' && pattern.test(msg.content)
      );

      if (isValidationMessage) {
        // Skip this message and the next assistant response (the correction)
        log(`🧹 Removing validation message from history (index ${i})`);
        i++; // Skip the assistant's corrected response too
        continue;
      }

      cleanedHistory.push(msg);
    }

    // IMPORTANT: Strip the final JSON response from the last assistant message
    // The JSON response contains schema-formatted output (e.g., overview with tags)
    // which will confuse the next check that uses a different schema (e.g., code-review with issues)
    // We keep the conversation (user prompt + assistant text) but remove the structured JSON
    if (cleanedHistory.length >= 2) {
      // Find the last assistant message
      let lastAssistantIndex = -1;
      for (let i = cleanedHistory.length - 1; i >= 0; i--) {
        if (cleanedHistory[i].role === 'assistant') {
          lastAssistantIndex = i;
          break;
        }
      }

      if (lastAssistantIndex >= 0) {
        const lastAssistantMsg = cleanedHistory[lastAssistantIndex];
        if (typeof lastAssistantMsg.content === 'string') {
          const originalLength = lastAssistantMsg.content.length;

          // Try to extract and remove JSON block from the end
          // ProbeAgent typically appends JSON in one of these formats:
          // 1. ```json\n{...}\n```
          // 2. Plain JSON starting with { or [
          let cleanedContent = lastAssistantMsg.content;

          // Pattern 1: Remove JSON code blocks at the end
          const jsonBlockPattern = /```json\s*\n[\s\S]*?\n```\s*$/;
          if (jsonBlockPattern.test(cleanedContent)) {
            cleanedContent = cleanedContent.replace(jsonBlockPattern, '').trim();
            log(`🧹 Removed JSON code block from assistant response`);
          } else {
            // Pattern 2: Try to find trailing JSON object/array
            // Look for the last occurrence of { or [ that might be the start of JSON
            const lines = cleanedContent.split('\n');
            let jsonStartLine = -1;

            for (let i = lines.length - 1; i >= 0; i--) {
              const line = lines[i].trim();
              if (line.startsWith('{') || line.startsWith('[')) {
                // Check if this looks like the start of a JSON response
                const possibleJson = lines.slice(i).join('\n');
                try {
                  JSON.parse(possibleJson);
                  jsonStartLine = i;
                  break;
                } catch {
                  // Not valid JSON, keep looking
                }
              }
            }

            if (jsonStartLine >= 0) {
              cleanedContent = lines.slice(0, jsonStartLine).join('\n').trim();
              log(`🧹 Removed trailing JSON from assistant response`);
            }
          }

          if (cleanedContent.length < originalLength) {
            lastAssistantMsg.content = cleanedContent;
            log(
              `🧹 Cleaned assistant response: ${originalLength} → ${cleanedContent.length} chars (removed ${originalLength - cleanedContent.length} chars)`
            );
          }
        }
      }
    }

    // Update the agent's history
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any).history = cleanedHistory;

    if (cleanedHistory.length < originalLength) {
      log(
        `🧹 Cleaned ${originalLength - cleanedHistory.length} messages from history (${originalLength} → ${cleanedHistory.length})`
      );
    }
  }

  /**
   * Build a custom prompt for AI review with XML-formatted data
   */
  private async buildCustomPrompt(
    prInfo: PRInfo,
    customInstructions: string,
    schema?: string | Record<string, unknown>
  ): Promise<string> {
    const prContext = this.formatPRContext(prInfo);
    const isIssue = (prInfo as PRInfo & { isIssue?: boolean }).isIssue === true;

    // Check if we're using the code-review schema
    const isCodeReviewSchema = schema === 'code-review';

    if (isIssue) {
      // Issue context - no code analysis needed
      return `<review_request>
  <instructions>
${customInstructions}
  </instructions>

  <context>
${prContext}
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
${prContext}
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
    return `<instructions>
${customInstructions}
</instructions>

<context>
${prContext}
</context>`;
  }

  // REMOVED: Built-in prompts - only use custom prompts from .visor.yaml

  // REMOVED: getFocusInstructions - only use custom prompts from .visor.yaml

  /**
   * Format PR or Issue context for the AI using XML structure
   */
  private formatPRContext(prInfo: PRInfo): string {
    // Check if this is an issue (not a PR)
    const prContextInfo = prInfo as PRInfo & {
      isPRContext?: boolean;
      includeCodeContext?: boolean;
    };
    const isIssue = prContextInfo.isIssue === true;

    // Check if we should include code context (diffs)
    const isPRContext = prContextInfo.isPRContext === true;
    // In PR context, always include diffs. Otherwise check the flag.
    const includeCodeContext = isPRContext || prContextInfo.includeCodeContext !== false;

    // Log the decision for transparency
    const log = this.config.debug ? console.error : () => {};
    if (isPRContext) {
      log('🔍 Including full code diffs in AI context (PR mode)');
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
        const historicalComments = triggeringComment
          ? issueComments.filter(c => c.id !== triggeringComment.id)
          : issueComments;

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
        context += `
  <!-- Complete unified diff showing all changes in the pull request -->
  <full_diff>
${this.escapeXml(prInfo.fullDiff)}
  </full_diff>`;
      }

      // Add incremental commit diff if available (for new commit analysis)
      if (prInfo.isIncremental) {
        if (prInfo.commitDiff && prInfo.commitDiff.length > 0) {
          context += `
  <!-- Diff of only the latest commit for incremental analysis -->
  <commit_diff>
${this.escapeXml(prInfo.commitDiff)}
  </commit_diff>`;
        } else {
          context += `
  <!-- Commit diff could not be retrieved - falling back to full diff analysis -->
  <commit_diff>
${prInfo.fullDiff ? this.escapeXml(prInfo.fullDiff) : ''}
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
      const historicalComments = triggeringComment
        ? prComments.filter(c => c.id !== triggeringComment.id)
        : prComments;

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
    schema?: string | Record<string, unknown>,
    debugInfo?: AIDebugInfo,
    _checkName?: string
  ): Promise<{ response: string; effectiveSchema?: string }> {
    // Handle mock model/provider for testing
    if (this.config.model === 'mock' || this.config.provider === 'mock') {
      log('🎭 Using mock AI model/provider for testing (session reuse)');
      const response = await this.generateMockResponse(prompt);
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
    schema?: string | Record<string, unknown>,
    debugInfo?: AIDebugInfo,
    _checkName?: string,
    providedSessionId?: string
  ): Promise<{ response: string; effectiveSchema?: string }> {
    // Handle mock model/provider for testing
    if (this.config.model === 'mock' || this.config.provider === 'mock') {
      log('🎭 Using mock AI model/provider for testing');
      const response = await this.generateMockResponse(prompt);
      return { response, effectiveSchema: typeof schema === 'object' ? 'custom' : schema };
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
      const options: ProbeAgentOptions = {
        sessionId: sessionId,
        promptType: schema ? ('code-review-template' as 'code-review') : undefined,
        allowEdit: false, // We don't want the agent to modify files
        debug: this.config.debug || false,
      };

      // Wire MCP configuration when provided
      if (this.config.mcpServers && Object.keys(this.config.mcpServers).length > 0) {
        (options as any).enableMcp = true;
        (options as any).mcpConfig = { mcpServers: this.config.mcpServers };
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
        // Clean validation/correction messages from history before registering
        this.cleanValidationMessagesFromHistory(agent);
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

    // Construct path to built-in schema file
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

    // Check for Liquid template syntax in response (critical bug prevention)
    if (_schema && _schema !== 'plain' && (response.includes('{%') || response.includes('{{'))) {
      console.error('⚠️ CRITICAL: AI returned Liquid template syntax when JSON was expected!');
      console.error(`Response that caused issue: "${response.substring(0, 100)}..."`);

      // Return error issue instead of trying to parse
      return {
        issues: [{
          file: 'system',
          line: 0,
          ruleId: 'system/liquid-template-in-json',
          message: 'AI returned Liquid template syntax instead of JSON. This indicates a prompt confusion error.',
          severity: 'error',
          category: 'logic',
        }],
        debug: debugInfo,
      };
    }

    try {
      // Handle different schema types differently
      let reviewData: AIResponseFormat;

      // Handle plain schema or no schema - no JSON parsing, return response as-is
      if (_schema === 'plain' || !_schema) {
        log(
          `📋 ${_schema === 'plain' ? 'Plain' : 'No'} schema detected - returning raw response without JSON parsing`
        );

        // For plain schema, return the raw response as an issue

        return {
          issues: [
            {
              file: 'AI_RESPONSE',
              line: 1,
              ruleId: 'ai/raw_response',
              message: response,
              severity: 'info',
              category: 'documentation',
            },
          ],
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

                reviewData = {
                  issues: [
                    {
                      file: 'AI_RESPONSE',
                      line: 1,
                      ruleId: 'ai/raw_response',
                      message: response,
                      severity: 'info',
                      category: 'documentation',
                    },
                  ],
                };
              } else {
                // Fallback: treat the entire response as an issue
                log('🔧 Creating fallback response from non-JSON content...');
                reviewData = {
                  issues: [
                    {
                      file: 'AI_RESPONSE',
                      line: 1,
                      ruleId: 'ai/raw_response',
                      message: response,
                      severity: 'info',
                      category: 'documentation',
                    },
                  ],
                };
              }
            }
          } else {
            // No JSON found at all - treat as plain text response
            log('🔧 No JSON found in response, treating as plain text...');
            reviewData = {
              issues: [
                {
                  file: 'AI_RESPONSE',
                  line: 1,
                  ruleId: 'ai/raw_response',
                  message: response,
                  severity: 'info',
                  category: 'documentation',
                },
              ],
            };
          }
        }
      }

      // Check if this is a custom schema (free-form data)
      // Custom schemas are:
      // 1. Inline schemas (effectiveSchema === 'custom')
      // 2. File-based custom schemas (starts with ./ or contains .json)
      // 3. Any schema that is NOT 'code-review' or other built-in schemas
      const isCustomSchema =
        _schema === 'custom' ||
        (_schema && (_schema.startsWith('./') || _schema.endsWith('.json'))) ||
        (_schema && _schema !== 'code-review' && !_schema.includes('output/'));

      if (isCustomSchema) {
        // For custom schemas, preserve ALL fields from the parsed JSON
        // Don't force the response into the standard ReviewSummary format
        log('📋 Custom schema detected - preserving all fields from parsed JSON');
        log(`📊 Schema: ${_schema}`);
        log(`📊 Custom schema keys: ${Object.keys(reviewData).join(', ')}`);

        // Return the full parsed data as the output, with an empty issues array
        // This allows downstream checks to access all custom fields via outputs
        const result: ReviewSummary & { output?: unknown } = {
          issues: [], // Empty array for custom schemas (no code review issues)
          output: reviewData, // Preserve ALL custom schema fields here
        };

        log('✅ Successfully created ReviewSummary with custom schema output');
        return result;
      }

      // Standard code-review schema processing
      log('🔍 Validating parsed review data...');
      log(`📊 Overall score: ${0}`);
      log(`📋 Total issues: ${reviewData.issues?.length || 0}`);
      log(
        `🚨 Critical issues: ${reviewData.issues?.filter((i: { severity?: string }) => i.severity === 'critical').length || 0}`
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
