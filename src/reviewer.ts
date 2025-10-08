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
  focus?: 'security' | 'performance' | 'style' | 'all';
  format?: 'table' | 'json' | 'markdown' | 'sarif';
  debug?: boolean;
  config?: import('./types/config').VisorConfig;
  checks?: string[];
  parallelExecution?: boolean;
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
      const { CheckExecutionEngine } = await import('./check-execution-engine');
      const engine = new CheckExecutionEngine();
      const { results } = await engine.executeGroupedChecks(
        prInfo,
        checks,
        undefined,
        config,
        undefined,
        debug
      );
      return results;
    }

    throw new Error(
      'No configuration provided. Please create a .visor.yaml file with check definitions. ' +
        'Built-in prompts have been removed - all checks must be explicitly configured.'
    );
  }

  async postReviewComment(
    owner: string,
    repo: string,
    prNumber: number,
    groupedResults: GroupedCheckResults,
    options: ReviewOptions & { commentId?: string; triggeredBy?: string; commitSha?: string } = {}
  ): Promise<void> {
    // Post separate comments for each group
    for (const [groupName, checkResults] of Object.entries(groupedResults)) {
      const comment = await this.formatGroupComment(checkResults, options, {
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

      await this.commentManager.updateOrCreateComment(owner, repo, prNumber, comment, {
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
    let comment = '';
    comment += `## 🔍 Code Analysis Results\n\n`;

    // Simple concatenation of all check outputs in this group
    const checkContents = checkResults
      .map(result => result.content)
      .filter(content => content.trim());
    comment += checkContents.join('\n\n');

    // Add debug info if any check has it
    const debugInfo = checkResults.find(result => result.debug)?.debug;
    if (debugInfo) {
      comment += '\n\n' + this.formatDebugSection(debugInfo);
      comment += '\n\n';
    }

    comment += `\n\n---\n\n*Powered by [Visor](https://probelabs.com/visor) from [Probelabs](https://probelabs.com)*`;
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
