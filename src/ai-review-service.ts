import { ProbeAgent } from '@probelabs/probe';
import type { ProbeAgentOptions } from '@probelabs/probe';
import { PRInfo } from './pr-analyzer';
import { ReviewSummary, ReviewIssue } from './reviewer';

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
  provider?: 'google' | 'anthropic' | 'openai';
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
  // For code-review schema - array of issues
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

  // For plain schema - just content field
  content?: string;
}

export class AIReviewService {
  private config: AIReviewConfig;

  constructor(config: AIReviewConfig = {}) {
    this.config = {
      timeout: 600000, // Increased timeout to 10 minutes for AI responses
      ...config,
    };

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
    schema?: string
  ): Promise<ReviewSummary> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    // Build prompt from custom instructions
    const prompt = await this.buildCustomPrompt(prInfo, customPrompt, schema);

    log(`Executing AI review with ${this.config.provider} provider...`);
    log(`🔧 Debug: Raw schema parameter: ${JSON.stringify(schema)} (type: ${typeof schema})`);
    log(`Schema type: ${schema || 'default (code-review)'}`);
    if (schema === 'plain') {
      log('Using plain schema - expecting JSON with content field');
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
      };
    }

    // Handle mock model first (no API key needed)
    if (this.config.model === 'mock') {
      log('🎭 Using mock AI model for testing - skipping API key validation');
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
      const response = await this.callProbeAgent(prompt, schema);
      const processingTime = Date.now() - startTime;

      if (debugInfo) {
        debugInfo.rawResponse = response;
        debugInfo.responseLength = response.length;
        debugInfo.processingTime = processingTime;
      }

      const result = this.parseAIResponse(response, debugInfo, schema);

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
   * Build a custom prompt for AI review with XML-formatted data
   */
  private async buildCustomPrompt(
    prInfo: PRInfo,
    customInstructions: string,
    _schema?: string
  ): Promise<string> {
    const prContext = this.formatPRContext(prInfo);
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
   * Format PR context for the AI using XML structure
   */
  private formatPRContext(prInfo: PRInfo): string {
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

    context += `
</pull_request>`;

    return context;
  }

  /**
   * Escape XML special characters
   */
  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Call ProbeAgent SDK with built-in schema validation
   */
  private async callProbeAgent(prompt: string, schema?: string): Promise<string> {
    // Handle mock model for testing
    if (this.config.model === 'mock') {
      log('🎭 Using mock AI model for testing');
      return this.generateMockResponse(prompt);
    }

    log('🤖 Creating ProbeAgent for AI review...');
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

      // Create ProbeAgent instance with proper options
      // For plain schema, use a simpler approach without tools
      const options: ProbeAgentOptions = {
        promptType: schema === 'plain' ? undefined : ('code-review-template' as 'code-review'),
        customPrompt:
          schema === 'plain'
            ? 'You are a helpful AI assistant. Respond only with valid JSON matching the provided schema. Do not use any tools or commands.'
            : undefined,
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
      // Load and pass the actual schema content if provided
      let schemaString: string | undefined = undefined;
      if (schema) {
        try {
          schemaString = await this.loadSchemaContent(schema);
          log(`📋 Loaded schema content for: ${schema}`);
        } catch (error) {
          log(`⚠️ Failed to load schema ${schema}, proceeding without schema:`, error);
          schemaString = undefined;
        }
      }

      // ProbeAgent now handles schema formatting internally!
      const response = await agent.answer(
        prompt,
        undefined,
        schemaString ? { schema: schemaString } : undefined
      );

      log('✅ ProbeAgent completed successfully');
      log(`📤 Response length: ${response.length} characters`);

      return response;
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
    schema?: string
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

      if (schema === 'plain') {
        // For plain schema, ProbeAgent returns JSON with a content field
        log('📝 Processing plain schema response (expect JSON with content field)');

        // Extract JSON using the same logic as other schemas
        // ProbeAgent's cleanSchemaResponse now strips code blocks, so we need to find JSON boundaries
        const trimmed = response.trim();
        const firstBrace = trimmed.indexOf('{');
        const firstBracket = trimmed.indexOf('[');
        const lastBrace = trimmed.lastIndexOf('}');
        const lastBracket = trimmed.lastIndexOf(']');

        let jsonStr = trimmed;
        let startIdx = -1;
        let endIdx = -1;

        // Prioritize {} if both exist
        if (firstBrace !== -1 && lastBrace !== -1) {
          if (
            firstBracket === -1 ||
            firstBrace < firstBracket ||
            (firstBrace < firstBracket && lastBrace > lastBracket)
          ) {
            startIdx = firstBrace;
            endIdx = lastBrace;
          }
        }

        // Fall back to [] if no valid {} or [] is better
        if (startIdx === -1 && firstBracket !== -1 && lastBracket !== -1) {
          startIdx = firstBracket;
          endIdx = lastBracket;
        }

        // If we found valid JSON boundaries, extract it
        if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
          jsonStr = trimmed.substring(startIdx, endIdx + 1);
          log(`🔍 Extracted JSON from response (chars ${startIdx} to ${endIdx + 1})`);
        }

        try {
          reviewData = JSON.parse(jsonStr);
          log('✅ Successfully parsed plain schema JSON response');
          if (debugInfo) debugInfo.jsonParseSuccess = true;
        } catch {
          // If JSON parsing fails, treat the entire response as content
          log('🔧 Plain schema fallback - treating entire response as content');
          reviewData = {
            content: response.trim(),
          };
          if (debugInfo) debugInfo.jsonParseSuccess = true;
        }
      } else {
        // For other schemas (code-review, etc.), extract and parse JSON with boundary detection
        log('🔍 Extracting JSON from AI response...');

        // Simple JSON extraction: find first { or [ and last } or ], with {} taking priority
        let jsonString = response.trim();

        // Find the first occurrence of { or [
        const firstBrace = jsonString.indexOf('{');
        const firstBracket = jsonString.indexOf('[');

        let startIndex = -1;
        let endChar = '';

        // Determine which comes first (or if only one exists), {} takes priority
        if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
          // Object comes first or only objects exist
          startIndex = firstBrace;
          endChar = '}';
        } else if (firstBracket !== -1) {
          // Array comes first or only arrays exist
          startIndex = firstBracket;
          endChar = ']';
        }

        if (startIndex !== -1) {
          // Find the last occurrence of the matching end character
          const lastEndIndex = jsonString.lastIndexOf(endChar);
          if (lastEndIndex !== -1 && lastEndIndex > startIndex) {
            jsonString = jsonString.substring(startIndex, lastEndIndex + 1);
          }
        }

        // Parse the extracted JSON
        try {
          reviewData = JSON.parse(jsonString);
          log('✅ Successfully parsed probe agent JSON response');
          if (debugInfo) debugInfo.jsonParseSuccess = true;
        } catch (initialError) {
          log('🔍 Initial parsing failed, trying to extract JSON from response...');

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

          // Try to find JSON within the response
          const jsonMatches = response.match(/\{[\s\S]*\}/g);
          if (jsonMatches && jsonMatches.length > 0) {
            log('🔧 Found potential JSON in response, attempting to parse...');
            // Try the largest JSON-like string (likely the complete response)
            const largestJson = jsonMatches.reduce((a, b) => (a.length > b.length ? a : b));
            log('🔧 Attempting to parse extracted JSON...');
            reviewData = JSON.parse(largestJson);
            log('✅ Successfully parsed extracted JSON');
            if (debugInfo) debugInfo.jsonParseSuccess = true;
          } else {
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
              throw initialError;
            }
          }
        }
      }

      // Handle different schemas
      if (schema === 'plain') {
        // For plain schema, we expect a content field with text (usually markdown)
        log('📝 Processing plain schema response');

        if (!reviewData.content) {
          console.error('❌ Plain schema response missing content field');
          console.error('🔍 Available fields:', Object.keys(reviewData));
          throw new Error('Invalid plain response: missing content field');
        }

        // Return a single "issue" that contains the text content
        // This will be rendered using the text template
        const result: ReviewSummary = {
          issues: [
            {
              file: 'PR',
              line: 1,
              ruleId: 'full-review/overview',
              message: reviewData.content,
              severity: 'info',
              category: 'documentation',
            },
          ],
          suggestions: [],
        };

        log('✅ Successfully created text ReviewSummary');
        return result;
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
      const criticalCount = result.issues.filter(i => i.severity === 'critical').length;
      if (criticalCount > 0) {
        log(`🚨 Found ${criticalCount} critical severity issue(s)`);
      }
      log(`📈 Total issues: ${result.issues.length}`);

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
   * Generate mock response for testing
   */
  private async generateMockResponse(_prompt: string): Promise<string> {
    // Simulate some processing time
    await new Promise(resolve => setTimeout(resolve, 500));

    // Generate mock response based on prompt content
    const mockResponse = {
      response: JSON.stringify({
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
