import { spawn } from 'child_process';
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
  // Simplified format - only raw data
  issues: Array<{
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
   * Execute AI review using probe-chat
   */
  async executeReview(prInfo: PRInfo, customPrompt: string): Promise<ReviewSummary> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();
    
    // Build prompt from custom instructions
    const prompt = this.buildCustomPrompt(prInfo, customPrompt);

    log(`Executing AI review with ${this.config.provider} provider...`);

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
      const response = await this.callProbeChat(prompt);
      const processingTime = Date.now() - startTime;

      if (debugInfo) {
        debugInfo.rawResponse = response;
        debugInfo.responseLength = response.length;
        debugInfo.processingTime = processingTime;
      }

      const result = this.parseAIResponse(response, debugInfo);

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
  private buildCustomPrompt(prInfo: PRInfo, customInstructions: string): string {
    const prContext = this.formatPRContext(prInfo);
    const analysisType = prInfo.commitDiff ? 'INCREMENTAL' : 'FULL';

    return `You are a senior code reviewer. 

ANALYSIS TYPE: ${analysisType}
${
  analysisType === 'INCREMENTAL'
    ? '- You are analyzing a NEW COMMIT added to an existing PR. Focus on the <commit_diff> section for changes made in this specific commit.'
    : '- You are analyzing the COMPLETE PR. Review all changes in the <full_diff> section.'
}

REVIEW INSTRUCTIONS:
${customInstructions}

CRITICAL: You must respond with ONLY valid JSON. Do not include any explanations, markdown formatting, or text outside the JSON object. If you cannot analyze the code, return an empty issues array, but always return valid JSON.

Required JSON response format:
\`\`\`json
{
  "issues": [
    {
      "file": "path/to/file.ext",
      "line": 10,
      "endLine": 12,
      "ruleId": "category/specific-issue-type",
      "message": "Clear description of the issue",
      "severity": "info|warning|error|critical",
      "category": "security|performance|style|logic|documentation",
      "suggestion": "Optional: How to fix this issue",
      "replacement": "Optional: Exact code replacement if applicable"
    }
  ],
  "suggestions": [
    "Overall suggestion 1",
    "Overall suggestion 2"
  ]
}
\`\`\`

Field Guidelines:
- "file": The exact filename from the diff
- "line": Line number where the issue starts (from the file, not the diff)
- "endLine": Optional end line for multi-line issues
- "ruleId": Format as "category/specific-type" (e.g., "security/sql-injection", "performance/n-plus-one")
- "message": Clear, specific description of the issue
- "severity": 
  * "info": Low priority informational issues
  * "warning": Medium priority issues that should be addressed
  * "error": High priority issues that need fixing
  * "critical": Critical issues that must be fixed immediately
- "category": One of: security, performance, style, logic, documentation
- "suggestion": Clear, actionable explanation of HOW to fix the issue
- "replacement": EXACT code that should replace the problematic lines (complete, syntactically correct, properly indented)

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
    if (prInfo.commitDiff) {
      context += `
  <commit_diff>
${this.escapeXml(prInfo.commitDiff)}
  </commit_diff>`;
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
   * Call probe-chat CLI tool using stdin to avoid shell escaping issues
   */
  private async callProbeChat(prompt: string): Promise<string> {
    // Handle mock model for testing
    if (this.config.model === 'mock') {
      log('🎭 Using mock AI model for testing');
      return this.generateMockResponse(prompt);
    }

    log('🤖 Calling probe-chat for AI review...');
    log(`📝 Prompt length: ${prompt.length} characters`);
    log(`⚙️ Model: ${this.config.model || 'default'}, Provider: ${this.config.provider || 'auto'}`);

    return new Promise((resolve, reject) => {
      const env: Record<string, string | undefined> = {
        ...process.env,
      };

      // Set API key based on provider
      if (this.config.provider === 'google' && this.config.apiKey) {
        env.GOOGLE_API_KEY = this.config.apiKey;
        log('🔑 Using Google API key');
      } else if (this.config.provider === 'anthropic' && this.config.apiKey) {
        env.ANTHROPIC_API_KEY = this.config.apiKey;
        log('🔑 Using Anthropic API key');
      } else if (this.config.provider === 'openai' && this.config.apiKey) {
        env.OPENAI_API_KEY = this.config.apiKey;
        log('🔑 Using OpenAI API key');
      }

      // Set model if specified
      if (this.config.model) {
        env.MODEL_NAME = this.config.model;
        log(`🎯 Using model: ${this.config.model}`);
      }

      log('🚀 Spawning probe-chat process...');

      // Use stdin instead of -m flag to avoid shell escaping issues
      const child = spawn('npx', ['-y', '@buger/probe-chat@latest', '--json'], {
        env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'], // Enable stdin, stdout, stderr
      });

      let output = '';
      let error = '';
      let isResolved = false;

      child.stdout.on('data', data => {
        const chunk = data.toString();
        output += chunk;
        log(
          '📤 Received stdout chunk:',
          chunk.substring(0, 200) + (chunk.length > 200 ? '...' : '')
        );
      });

      child.stderr.on('data', data => {
        const chunk = data.toString();
        error += chunk;
        log('⚠️ Received stderr:', chunk);
      });

      child.on('error', err => {
        if (!isResolved) {
          isResolved = true;
          console.error('❌ Process error:', err.message);
          reject(new Error(`Failed to spawn probe-chat: ${err.message}`));
        }
      });

      // Write prompt to stdin and close it
      try {
        log('📝 Writing prompt to stdin...');
        child.stdin.write(prompt, 'utf8');
        child.stdin.end();
        log('✅ Prompt written to stdin and closed');
      } catch (err) {
        if (!isResolved) {
          isResolved = true;
          console.error('❌ Error writing to stdin:', err);
          reject(
            new Error(
              `Failed to write prompt to stdin: ${err instanceof Error ? err.message : 'Unknown error'}`
            )
          );
        }
        return;
      }

      // Set timeout
      const timeout = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          console.error('⏰ AI review timed out after', this.config.timeout || 30000, 'ms');
          child.kill('SIGKILL');
          reject(new Error(`AI review timed out after ${this.config.timeout || 30000}ms`));
        }
      }, this.config.timeout || 30000);

      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        if (!isResolved) {
          isResolved = true;

          log(`🏁 Process closed with code: ${code}, signal: ${signal}`);
          log(`📤 Final output length: ${output.length} characters`);
          log(`⚠️ Final error length: ${error.length} characters`);

          if (code === 0) {
            log('✅ probe-chat completed successfully');
            resolve(output.trim());
          } else {
            console.error('❌ probe-chat failed with code:', code);
            console.error('❌ Error output:', error);
            reject(
              new Error(
                `probe-chat exited with code ${code}: ${error || 'No error details available'}`
              )
            );
          }
        }
      });
    });
  }

  /**
   * Parse AI response JSON
   */
  private parseAIResponse(response: string, debugInfo?: AIDebugInfo): ReviewSummary {
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
      // First, try to parse as probe-chat response wrapper
      let probeChatResponse;
      try {
        probeChatResponse = JSON.parse(response);
        log('✅ Successfully parsed probe-chat JSON wrapper');
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

        // Check if response is plain text and doesn't contain structured data
        if (!response.includes('{') && !response.includes('}')) {
          log('🔧 Plain text response detected, creating structured fallback...');
          // Create a fallback response based on the plain text
          const isNoChanges =
            response.toLowerCase().includes('no') &&
            (response.toLowerCase().includes('changes') || response.toLowerCase().includes('code'));

          return {
            issues: [],
            suggestions: isNoChanges
              ? ['No code changes detected in this analysis']
              : [`AI response: ${response.substring(0, 200)}${response.length > 200 ? '...' : ''}`],
          };
        }

        // Try to find JSON within the response
        const jsonMatches = response.match(/\{[\s\S]*\}/g);
        if (jsonMatches && jsonMatches.length > 0) {
          log('🔧 Found potential JSON in response, attempting to parse...');
          // Try the largest JSON-like string (likely the complete response)
          const largestJson = jsonMatches.reduce((a, b) => (a.length > b.length ? a : b));
          log('🔧 Attempting to parse extracted JSON...');
          probeChatResponse = { response: largestJson };
        } else {
          // Re-throw the original error if we can't find JSON
          throw initialError;
        }
      }

      // Extract the actual review from the response field
      let reviewData: AIResponseFormat;

      if (probeChatResponse.response) {
        log('📝 Found response field in probe-chat output');
        const aiResponse = probeChatResponse.response;

        // Log the AI response for debugging
        log(
          '🤖 AI response content:',
          aiResponse.substring(0, 300) + (aiResponse.length > 300 ? '...' : '')
        );

        // The response might be wrapped in markdown code blocks
        const cleanResponse = aiResponse
          .replace(/^```json\n?/, '')
          .replace(/\n?```$/, '')
          .trim();

        log(
          '🧹 Cleaned response:',
          cleanResponse.substring(0, 300) + (cleanResponse.length > 300 ? '...' : '')
        );

        // Try to parse the cleaned response as JSON
        try {
          reviewData = JSON.parse(cleanResponse);
          log('✅ Successfully parsed AI review JSON');
          if (debugInfo) debugInfo.jsonParseSuccess = true;
        } catch (parseError) {
          console.error('❌ Failed to parse AI review JSON:', parseError);
          console.error('🔍 Attempting fallback parsing strategies...');

          // Check if the AI response is plain text without JSON structure
          if (!cleanResponse.includes('{') && !cleanResponse.includes('}')) {
            log('🔧 Plain text AI response detected, creating structured fallback...');
            const isNoChanges =
              cleanResponse.toLowerCase().includes('no') &&
              (cleanResponse.toLowerCase().includes('changes') ||
                cleanResponse.toLowerCase().includes('code'));

            reviewData = {
              issues: [],
              suggestions: isNoChanges
                ? ['No code changes detected in this analysis']
                : [
                    `AI response: ${cleanResponse.substring(0, 200)}${cleanResponse.length > 200 ? '...' : ''}`,
                  ],
            };
            log('✅ Created structured fallback from plain text response');
          } else {
            // Try to extract JSON from anywhere in the response
            const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              log('🔧 Found JSON pattern, attempting to parse...');
              reviewData = JSON.parse(jsonMatch[0]);
              log('✅ Successfully parsed JSON from pattern match');
              if (debugInfo) debugInfo.jsonParseSuccess = true;
            } else {
              throw parseError;
            }
          }
        }
      } else if (probeChatResponse.overallScore !== undefined) {
        // Direct response without wrapper
        log('📦 Direct response format detected');
        reviewData = probeChatResponse;
      } else {
        console.error('❌ No response field found and not direct format');
        console.error('🔍 Available fields:', Object.keys(probeChatResponse));
        throw new Error('Invalid probe-chat response format: no response field found');
      }

      // Validate the parsed data
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
              severity: this.validateSeverity(issue.severity),
              category: this.validateCategory(issue.category),
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
   * Validate severity value
   */
  private validateSeverity(severity: string): 'info' | 'warning' | 'error' | 'critical' {
    const valid = ['info', 'warning', 'error', 'critical'];
    if (valid.includes(severity)) {
      return severity as 'info' | 'warning' | 'error' | 'critical';
    }
    // Map common alternatives
    if (severity === 'major' || severity === 'high') {
      return 'error';
    }
    if (severity === 'medium') {
      return 'warning';
    }
    if (severity === 'minor' || severity === 'low') {
      return 'info';
    }
    return 'info';
  }

  /**
   * Validate category value
   */
  private validateCategory(
    category: string
  ): 'security' | 'performance' | 'style' | 'logic' | 'documentation' {
    const valid = ['security', 'performance', 'style', 'logic', 'documentation'];
    if (valid.includes(category)) {
      return category as 'security' | 'performance' | 'style' | 'logic' | 'documentation';
    }
    // Map common alternatives
    if (category === 'bug' || category === 'error') {
      return 'logic';
    }
    if (category === 'docs') {
      return 'documentation';
    }
    return 'logic';
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
