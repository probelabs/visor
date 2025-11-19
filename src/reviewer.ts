import { Octokit } from '@octokit/rest';
import { PRInfo } from './pr-analyzer';
import { CommentManager } from './github-comments';
import { AIReviewService, AIDebugInfo } from './ai-review-service';

export interface ReviewIssue {
  // Location
  file: string;
  line: number;
  endLine?: number;
  // Issue details
  ruleId: string;
  message: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  category: 'security' | 'performance' | 'style' | 'logic' | 'documentation';
  // Check identification - which check created this issue
  checkName?: string;
  // Group and schema for comment separation
  group?: string;
  schema?: string;
  // Timestamp when the issue was created (for ordering)
  timestamp?: number;
  // Optional enhancement
  suggestion?: string;
  replacement?: string;
}

// Legacy interface - ONLY for GitHub integration compatibility
export interface ReviewComment {
  file: string;
  line: number;
  message: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  category: 'security' | 'performance' | 'style' | 'logic' | 'documentation';
  suggestion?: string;
  replacement?: string;
  ruleId?: string;
}

// Individual check result - each check produces one of these
export interface CheckResult {
  checkName: string;
  content: string; // Rendered output for this specific check
  group: string; // Which group this check belongs to
  // Optional structured output for custom schemas (e.g., overview, issue-assistant)
  output?: unknown;
  debug?: AIDebugInfo;
  issues?: ReviewIssue[]; // Structured issues alongside rendered content
}

// Results grouped by group name
export interface GroupedCheckResults {
  [groupName: string]: CheckResult[];
}

// Legacy interface - only for backward compatibility
export interface ReviewSummary {
  issues?: ReviewIssue[];
  debug?: AIDebugInfo;
  /** Session ID created for this check (for cleanup tracking) */
  sessionId?: string;
}

// Test utility function - Convert old ReviewSummary to new GroupedCheckResults format
// This is for backward compatibility with tests only
export function convertReviewSummaryToGroupedResults(
  reviewSummary: ReviewSummary,
  checkName: string = 'test-check',
  groupName: string = 'default'
): GroupedCheckResults {
  // Create a simple content string from issues
  let content = '';

  if (reviewSummary.issues && reviewSummary.issues.length > 0) {
    content += `## Issues Found (${reviewSummary.issues.length})\n\n`;
    reviewSummary.issues.forEach(issue => {
      content += `- **${issue.severity.toUpperCase()}**: ${issue.message} (${issue.file}:${issue.line})\n`;
    });
    content += '\n';
  }

  if (!content) {
    content = 'No issues found.';
  }

  const checkResult: CheckResult = {
    checkName,
    content: content.trim(),
    group: groupName,
    debug: reviewSummary.debug,
    issues: reviewSummary.issues, // Include structured issues
  };

  const groupedResults: GroupedCheckResults = {};
  groupedResults[groupName] = [checkResult];

  return groupedResults;
}

// Helper functions for GitHub checks - ONLY for structured schemas that have issues
// These are the ONLY acceptable hardcoded schema dependencies, and only for GitHub integration
export function calculateTotalIssues(issues?: ReviewIssue[]): number {
  return (issues || []).length;
}

export function calculateCriticalIssues(issues?: ReviewIssue[]): number {
  return (issues || []).filter(i => i.severity === 'critical').length;
}

// Legacy converter - ONLY for GitHub integration compatibility
export function convertIssuesToComments(issues: ReviewIssue[]): ReviewComment[] {
  return issues.map(issue => ({
    file: issue.file,
    line: issue.line,
    message: issue.message,
    severity: issue.severity,
    category: issue.category,
    suggestion: issue.suggestion,
    replacement: issue.replacement,
    ruleId: issue.ruleId,
  }));
}

export interface ReviewOptions {
  focus?: string;
  format?: 'table' | 'json' | 'markdown' | 'sarif';
  debug?: boolean;
  config?: import('./types/config').VisorConfig;
  checks?: string[];
  parallelExecution?: boolean;
  // Optional tag filter to include/exclude checks by tags when running via GitHub Action path
  tagFilter?: import('./types/config').TagFilter;
}

export class PRReviewer {
  private commentManager: CommentManager;
  private aiReviewService: AIReviewService;

  constructor(private octokit: Octokit) {
    this.commentManager = new CommentManager(octokit);
    this.aiReviewService = new AIReviewService();
  }

  async reviewPR(
    owner: string,
    repo: string,
    prNumber: number,
    prInfo: PRInfo,
    options: ReviewOptions = {}
  ): Promise<GroupedCheckResults> {
    const { debug = false, config, checks } = options;

    if (config && checks && checks.length > 0) {
      const { StateMachineExecutionEngine } = await import('./state-machine-execution-engine');
      const engine = new StateMachineExecutionEngine();
      const { results } = await engine.executeGroupedChecks(
        prInfo,
        checks,
        undefined,
        config,
        undefined,
        debug,
        undefined,
        undefined,
        options.tagFilter
      );
      return results;
    }

    throw new Error(
      'No configuration provided. Please create a .visor.yaml file with check definitions. ' +
        'Built-in prompts have been removed - all checks must be explicitly configured.'
    );
  }

  /**
   * Helper to check if a schema is comment-generating
   * Comment-generating schemas include:
   * - Built-in schemas: code-review, overview, plain, text
   * - Custom schemas with a "text" field in properties
   */
  private async isCommentGeneratingSchema(
    schema: string | Record<string, unknown>
  ): Promise<boolean> {
    try {
      // Check for built-in comment-generating schemas
      if (typeof schema === 'string') {
        // Well-known comment-generating schemas
        if (['code-review', 'overview', 'plain', 'text'].includes(schema)) {
          return true;
        }

        // Try to load and check custom string schema
        const fs = require('fs').promises;
        const path = require('path');

        // Sanitize schema name
        const sanitizedSchemaName = schema.replace(/[^a-zA-Z0-9-]/g, '');
        if (!sanitizedSchemaName || sanitizedSchemaName !== schema) {
          return false;
        }

        // Locate built-in schema JSON. In Actions, schemas live under dist/output (relative to __dirname).
        // In local dev/tests, schemas live under project/output (relative to CWD).
        const candidatePaths = [
          path.join(__dirname, 'output', sanitizedSchemaName, 'schema.json'),
          path.join(process.cwd(), 'output', sanitizedSchemaName, 'schema.json'),
        ];

        for (const schemaPath of candidatePaths) {
          try {
            const schemaContent = await fs.readFile(schemaPath, 'utf-8');
            const schemaObj = JSON.parse(schemaContent);

            // Check if schema has a "text" field in properties
            const properties = schemaObj.properties as Record<string, unknown> | undefined;
            return !!(properties && 'text' in properties);
          } catch {
            // try next location
          }
        }
        // Schema file not found in any known location, not comment-generating
        return false;
      } else {
        // Inline schema object - check if it has a "text" field in properties
        const properties = schema.properties as Record<string, unknown> | undefined;
        return !!(properties && 'text' in properties);
      }
    } catch {
      return false;
    }
  }

  /**
   * Filter check results to only include those that should post GitHub comments
   */
  private async filterCommentGeneratingChecks(
    checkResults: CheckResult[],
    config: import('./types/config').VisorConfig
  ): Promise<CheckResult[]> {
    const filtered: CheckResult[] = [];

    for (const r of checkResults) {
      const cfg = config.checks?.[r.checkName];
      const type = cfg?.type || 'ai'; // Default to 'ai' if not specified
      const schema = cfg?.schema;

      // Determine if this check should generate a comment
      // Include checks with:
      // 1. type: 'ai' or 'claude-code' with no schema or comment-generating schemas
      // 2. Other types ONLY if they have explicit comment-generating schemas
      let shouldPostComment = false;

      // AI-powered checks generate comments by default
      const isAICheck = type === 'ai' || type === 'claude-code';

      if (!schema || schema === '') {
        // No schema specified - only AI checks generate comments by default
        // Other types (github, command, http, etc.) without schema are for orchestration
        shouldPostComment = isAICheck;
      } else {
        // Check if the schema is comment-generating (built-in or custom with text field)
        shouldPostComment = await this.isCommentGeneratingSchema(schema);
      }

      if (shouldPostComment) {
        filtered.push(r);
      }
    }

    return filtered;
  }

  async postReviewComment(
    owner: string,
    repo: string,
    prNumber: number,
    groupedResults: GroupedCheckResults,
    options: ReviewOptions & {
      commentId?: string;
      triggeredBy?: string;
      commitSha?: string;
      octokitOverride?: Octokit;
    } = {}
  ): Promise<void> {
    // Post separate comments for each group
    for (const [groupName, checkResults] of Object.entries(groupedResults)) {
      // Only checks with comment-generating schemas should post PR comments
      // AI checks (ai, claude-code) generate comments by default
      // Other types need explicit comment-generating schemas
      let filteredResults = options.config
        ? await this.filterCommentGeneratingChecks(checkResults, options.config)
        : checkResults;

      // Collapse results to avoid concatenating mutually-exclusive or duplicate posts.
      // For fact-validation flow, both 'post-verified-response' and 'post-unverified-warning'
      // can appear across waves. Prefer the final intended output and drop earlier entries.
      if (groupName === 'github-output' && filteredResults && filteredResults.length > 1) {
        // Keep only the last occurrence per checkName.
        const byName = new Map<string, any>();
        for (const cr of filteredResults) byName.set(cr.checkName, cr);
        let collapsed = Array.from(byName.values());
        const hasVerified = collapsed.some((r: any) => r.checkName === 'post-verified-response');
        if (hasVerified) {
          collapsed = collapsed.filter((r: any) => r.checkName !== 'post-unverified-warning');
        }
        filteredResults = collapsed as any;
      }

      // If nothing to report after filtering, skip this group
      if (!filteredResults || filteredResults.length === 0) {
        continue;
      }

      const comment = await this.formatGroupComment(filteredResults, options, {
        owner,
        repo,
        prNumber,
        commitSha: options.commitSha,
      });

      // Generate comment ID - use unique ID for "dynamic" group
      let commentId: string;
      if (groupName === 'dynamic') {
        // Dynamic group creates a new comment each time with timestamp-based ID
        const timestamp = Date.now();
        commentId = `visor-dynamic-${timestamp}`;
      } else {
        // Regular groups use static IDs that get updated
        commentId = options.commentId
          ? `${options.commentId}-${groupName}`
          : `visor-review-${groupName}`;
      }

      // Do not post empty comments (possible if content is blank after fallbacks)
      if (!comment || !comment.trim()) continue;

      const manager = options.octokitOverride
        ? new CommentManager(options.octokitOverride)
        : this.commentManager;
      await manager.updateOrCreateComment(owner, repo, prNumber, comment, {
        commentId,
        triggeredBy: options.triggeredBy || 'unknown',
        allowConcurrentUpdates: false,
        commitSha: options.commitSha,
      });
    }
  }

  private async formatGroupComment(
    checkResults: CheckResult[],
    _options: ReviewOptions,
    _githubContext?: { owner: string; repo: string; prNumber: number; commitSha?: string }
  ): Promise<string> {
    // Concatenate all check outputs in this group; fall back to structured output fields
    const normalize = (s: string) => s.replace(/\\n/g, '\n');
    const checkContents = checkResults
      .map(result => {
        const trimmed = result.content?.trim();
        if (trimmed) return normalize(trimmed);
        // Fallback: if provider returned structured output with a common text field
        const out = (result as unknown as { debug?: unknown; issues?: unknown; output?: any })
          .output;
        if (out) {
          if (typeof out === 'string' && out.trim()) return normalize(out.trim());
          if (typeof out === 'object') {
            const txt = (out.text || out.response || out.message) as unknown;
            if (typeof txt === 'string' && txt.trim()) return normalize(txt.trim());
          }
        }
        return '';
      })
      .filter(content => content && content.trim());

    // Add debug info if any check has it
    const debugInfo = checkResults.find(result => result.debug)?.debug;

    // Only generate comment if there's actual content or debug info
    if (checkContents.length === 0 && !debugInfo) {
      return '';
    }

    let comment = '';
    comment += `## 🔍 Code Analysis Results\n\n`;
    comment += checkContents.join('\n\n');

    if (debugInfo) {
      comment += '\n\n' + this.formatDebugSection(debugInfo);
      comment += '\n\n';
    }

    // Footer will be added by formatCommentWithMetadata in github-comments.ts
    return comment;
  }

  private formatDebugSection(debug: AIDebugInfo): string {
    const formattedContent = [
      `**Provider:** ${debug.provider}`,
      `**Model:** ${debug.model}`,
      `**API Key Source:** ${debug.apiKeySource}`,
      `**Processing Time:** ${debug.processingTime}ms`,
      `**Timestamp:** ${debug.timestamp}`,
      `**Prompt Length:** ${debug.promptLength} characters`,
      `**Response Length:** ${debug.responseLength} characters`,
      `**JSON Parse Success:** ${debug.jsonParseSuccess ? '✅' : '❌'}`,
    ];

    if (debug.errors && debug.errors.length > 0) {
      formattedContent.push('', '### Errors');
      debug.errors.forEach(error => {
        formattedContent.push(`- ${error}`);
      });
    }

    const fullDebugContent = [
      ...formattedContent,
      '',
      '### AI Prompt',
      '```',
      debug.prompt,
      '```',
      '',
      '### Raw AI Response',
      '```json',
      debug.rawResponse,
      '```',
    ].join('\n');

    if (fullDebugContent.length > 60000) {
      const artifactPath = this.saveDebugArtifact(debug);
      formattedContent.push('');
      formattedContent.push('### Debug Details');
      formattedContent.push('⚠️ Debug information is too large for GitHub comments.');
      if (artifactPath) {
        formattedContent.push(
          `📁 **Full debug information saved to artifact:** \`${artifactPath}\``
        );
        formattedContent.push('');
        const runId = process.env.GITHUB_RUN_ID;
        const repoUrl =
          process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
            ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`
            : null;
        if (runId && repoUrl) {
          formattedContent.push(
            `🔗 **Download Link:** [visor-debug-${process.env.GITHUB_RUN_NUMBER || runId}](${repoUrl}/actions/runs/${runId})`
          );
        }
        formattedContent.push(
          '💡 Go to the GitHub Action run above and download the debug artifact to view complete prompts and responses.'
        );
      } else {
        formattedContent.push('📝 **Prompt preview:** ' + debug.prompt.substring(0, 500) + '...');
        formattedContent.push(
          '📝 **Response preview:** ' + debug.rawResponse.substring(0, 500) + '...'
        );
      }
    } else {
      formattedContent.push('');
      formattedContent.push('### AI Prompt');
      formattedContent.push('```');
      formattedContent.push(debug.prompt);
      formattedContent.push('```');
      formattedContent.push('');
      formattedContent.push('### Raw AI Response');
      formattedContent.push('```json');
      formattedContent.push(debug.rawResponse);
      formattedContent.push('```');
    }

    return this.commentManager.createCollapsibleSection(
      '🐛 Debug Information',
      formattedContent.join('\n'),
      false
    );
  }

  private saveDebugArtifact(debug: AIDebugInfo): string | null {
    try {
      const fs = require('fs');
      const path = require('path');
      const debugDir = path.join(process.cwd(), 'debug-artifacts');
      if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `visor-debug-${timestamp}.md`;
      const filepath = path.join(debugDir, filename);

      const content = [
        `# Visor Debug Information`,
        ``,
        `**Timestamp:** ${debug.timestamp}`,
        `**Provider:** ${debug.provider}`,
        `**Model:** ${debug.model}`,
        `**Processing Time:** ${debug.processingTime}ms`,
        ``,
        `## AI Prompt`,
        ``,
        '```',
        debug.prompt,
        '```',
        ``,
        `## Raw AI Response`,
        ``,
        '```json',
        debug.rawResponse,
        '```',
      ].join('\n');

      fs.writeFileSync(filepath, content, 'utf8');
      return filename;
    } catch (error) {
      console.error('Failed to save debug artifact:', error);
      return null;
    }
  }
}
