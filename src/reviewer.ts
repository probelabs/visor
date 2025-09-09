import { Octokit } from '@octokit/rest';
import { PRInfo } from './pr-analyzer';
import { CommentManager } from './github-comments';
import { AIReviewService, ReviewFocus, AIDebugInfo } from './ai-review-service';

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

  // Optional enhancement
  suggestion?: string;
  replacement?: string;
}

// Keep old interface for backward compatibility during transition
export interface ReviewComment {
  file: string;
  line: number;
  message: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  category: 'security' | 'performance' | 'style' | 'logic' | 'documentation';
}

export interface ReviewSummary {
  // Simplified - only raw data, calculations done elsewhere
  issues: ReviewIssue[];
  suggestions: string[];
  /** Debug information (only included when debug mode is enabled) */
  debug?: AIDebugInfo;
}

export interface ReviewOptions {
  focus?: 'security' | 'performance' | 'style' | 'all';
  format?: 'table' | 'json' | 'markdown' | 'sarif';
  debug?: boolean;
  config?: import('./types/config').VisorConfig;
  checks?: string[];
  parallelExecution?: boolean;
}

// Helper functions for calculating metrics from issues
export function calculateTotalIssues(issues: ReviewIssue[]): number {
  return issues.length;
}

export function calculateCriticalIssues(issues: ReviewIssue[]): number {
  return issues.filter(i => i.severity === 'critical').length;
}

export function convertIssuesToComments(issues: ReviewIssue[]): ReviewComment[] {
  return issues.map(issue => ({
    file: issue.file,
    line: issue.line,
    message: issue.message,
    severity: issue.severity,
    category: issue.category,
  }));
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
  ): Promise<ReviewSummary> {
    const {
      focus = 'all',
      format = 'table',
      debug = false,
      config,
      checks,
      parallelExecution,
    } = options;

    // If we have a config and multiple checks, use CheckExecutionEngine for parallel execution
    if (config && checks && checks.length > 1 && parallelExecution) {
      console.error(
        `🔧 Debug: PRReviewer using CheckExecutionEngine for parallel execution of ${checks.length} checks`
      );

      // Import CheckExecutionEngine dynamically to avoid circular dependencies
      const { CheckExecutionEngine } = await import('./check-execution-engine');
      const engine = new CheckExecutionEngine();

      // Execute checks using the engine's parallel execution capability
      const reviewSummary = await engine['executeReviewChecks'](prInfo, checks, undefined, config);

      // Apply format filtering
      return {
        ...reviewSummary,
        issues: format === 'markdown' ? reviewSummary.issues : reviewSummary.issues.slice(0, 5),
      };
    }

    // If debug is enabled, create a new AI service with debug enabled
    if (debug) {
      this.aiReviewService = new AIReviewService({ debug: true });
    }

    // Execute AI review (no fallback) - single check or legacy mode
    const aiReview = await this.aiReviewService.executeReview(prInfo, focus as ReviewFocus);

    // Apply format filtering
    return {
      ...aiReview,
      issues: format === 'markdown' ? aiReview.issues : aiReview.issues.slice(0, 5),
    };
  }

  async postReviewComment(
    owner: string,
    repo: string,
    prNumber: number,
    summary: ReviewSummary,
    options: ReviewOptions & { commentId?: string; triggeredBy?: string } = {}
  ): Promise<void> {
    const comment = this.formatReviewCommentWithVisorFormat(summary, options);

    await this.commentManager.updateOrCreateComment(owner, repo, prNumber, comment, {
      commentId: options.commentId,
      triggeredBy: options.triggeredBy || 'unknown',
      allowConcurrentUpdates: false,
    });
  }

  private formatReviewCommentWithVisorFormat(
    summary: ReviewSummary,
    _options: ReviewOptions
  ): string {
    // Calculate metrics from issues
    const totalIssues = calculateTotalIssues(summary.issues);
    const comments = convertIssuesToComments(summary.issues);

    // Group comments by category for universal formatting
    const groupedComments = this.groupCommentsByCategory(comments);

    let comment = '';

    // If no issues, show success message
    if (totalIssues === 0) {
      comment += `## ✅ All Checks Passed\n\n`;
      comment += `**No issues found – changes LGTM.**\n\n`;
    } else {
      // Create a universal snapshot table for all categories
      for (const [category, categoryComments] of Object.entries(groupedComments)) {
        if (categoryComments.length === 0) continue;

        comment += this.formatUniversalCategoryTable(category, categoryComments);
        comment += '\n\n';
      }
    }

    // Add suggestions if any
    if (summary.suggestions.length > 0) {
      comment += this.commentManager.createCollapsibleSection(
        '💡 Recommendations',
        summary.suggestions.map(s => `- ${s}`).join('\n') + '\n',
        true
      );
      comment += '\n\n';
    }

    // Add debug section if debug information is available
    if (summary.debug) {
      comment += this.formatDebugSection(summary.debug);
      comment += '\n\n';
    }

    return comment;
  }

  private formatReviewComment(summary: ReviewSummary, options: ReviewOptions): string {
    const { format = 'table' } = options;

    // Calculate metrics from issues
    const totalIssues = calculateTotalIssues(summary.issues);
    const criticalIssues = calculateCriticalIssues(summary.issues);
    const comments = convertIssuesToComments(summary.issues);

    let comment = `## 🤖 AI Code Review\n\n`;
    comment += `**Issues Found:** ${totalIssues} (${criticalIssues} critical)\n\n`;

    if (summary.suggestions.length > 0) {
      comment += `### 💡 Suggestions\n`;
      for (const suggestion of summary.suggestions) {
        comment += `- ${suggestion}\n`;
      }
      comment += '\n';
    }

    if (comments.length > 0) {
      comment += `### 🔍 Code Issues\n`;
      for (const reviewComment of comments) {
        const emoji =
          reviewComment.severity === 'error'
            ? '❌'
            : reviewComment.severity === 'warning'
              ? '⚠️'
              : 'ℹ️';
        comment += `${emoji} **${reviewComment.file}:${reviewComment.line}** (${reviewComment.category})\n`;
        comment += `   ${reviewComment.message}\n\n`;
      }
    }

    if (format === 'table' && totalIssues > 5) {
      comment += `*Showing top 5 issues. Use \`/review --format=markdown\` for complete analysis.*\n\n`;
    }

    // Add debug section if debug information is available
    if (summary.debug) {
      comment += this.formatDebugSection(summary.debug);
      comment += '\n\n';
    }

    comment += `---\n*Review powered by Visor - Use \`/help\` for available commands*`;

    return comment;
  }

  private groupCommentsByCategory(comments: ReviewComment[]): Record<string, ReviewComment[]> {
    const grouped: Record<string, ReviewComment[]> = {
      security: [],
      performance: [],
      style: [],
      logic: [],
      documentation: [],
    };

    for (const comment of comments) {
      if (!grouped[comment.category]) {
        grouped[comment.category] = [];
      }
      grouped[comment.category].push(comment);
    }

    return grouped;
  }

  private getCategoryEmoji(category: string): string {
    const emojiMap: Record<string, string> = {
      security: '🔒',
      performance: '📈',
      style: '🎨',
      logic: '🧠',
      documentation: '📚',
    };
    return emojiMap[category] || '📝';
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
    ];

    if (debug.errors && debug.errors.length > 0) {
      formattedContent.push('', '### Errors');
      debug.errors.forEach(error => {
        formattedContent.push(`- ${error}`);
      });
    }

    return this.commentManager.createCollapsibleSection(
      '🐛 Debug Information',
      formattedContent.join('\n'),
      false // Start collapsed
    );
  }

  private formatUniversalCategoryTable(category: string, comments: ReviewComment[]): string {
    const criticalCount = comments.filter(c => c.severity === 'error').length;
    const warningCount = comments.filter(c => c.severity === 'warning').length;
    const infoCount = comments.filter(c => c.severity === 'info').length;

    // Determine overall status
    const status = criticalCount > 0 ? '🔴' : warningCount > 0 ? '🟡' : '🟢';

    // Get category emoji
    const categoryEmoji = this.getCategoryEmoji(category);
    const categoryTitle = category.charAt(0).toUpperCase() + category.slice(1);

    // Generate a concise summary
    const summary = this.generateCategorySummary(comments);

    // Build the table
    let content = `### ${categoryEmoji} ${categoryTitle} Analysis\n`;
    content += `| Status | Critical | Warnings | Info | Total | Summary |\n`;
    content += `|:------:|:--------:|:--------:|:----:|:-----:|---------|\n`;
    content += `| ${status} | ${criticalCount} | ${warningCount} | ${infoCount} | ${comments.length} | ${summary} |\n\n`;

    // Add collapsible details sections
    if (comments.length > 0) {
      // Impact Analysis section
      content += `<details>\n<summary><strong>Impact Analysis</strong></summary>\n\n`;
      content += this.formatIssuesList(comments.slice(0, 5));
      if (comments.length > 5) {
        content += `\n*...and ${comments.length - 5} more issues*\n`;
      }
      content += `\n</details>\n`;

      // Critical Issues section (only if there are critical issues)
      const criticalIssues = comments.filter(c => c.severity === 'error');
      if (criticalIssues.length > 0) {
        content += `\n<details>\n<summary><strong>Critical Issues</strong></summary>\n\n`;
        content += this.formatIssuesList(criticalIssues);
        content += `\n</details>\n`;
      }

      // Recommendations section
      content += `\n<details>\n<summary><strong>Recommendations</strong></summary>\n\n`;
      content += this.generateCategoryRecommendations(comments);
      content += `\n</details>\n`;
    }

    return content;
  }

  private formatIssuesList(comments: ReviewComment[]): string {
    let content = '';
    for (const comment of comments) {
      const emoji =
        comment.severity === 'error' ? '❌' : comment.severity === 'warning' ? '⚠️' : 'ℹ️';
      content += `${emoji} **${comment.file}:${comment.line}**\n`;
      content += `   ${comment.message}\n\n`;
    }
    return content;
  }

  private generateCategorySummary(comments: ReviewComment[]): string {
    if (comments.length === 0) {
      return 'No issues detected';
    }

    const critical = comments.filter(c => c.severity === 'error').length;
    const warnings = comments.filter(c => c.severity === 'warning').length;

    if (critical > 0) {
      return `${critical} critical issue${critical > 1 ? 's' : ''} requiring immediate attention`;
    }

    if (warnings > 0) {
      return `${warnings} warning${warnings > 1 ? 's' : ''} to review`;
    }

    return `${comments.length} informational item${comments.length > 1 ? 's' : ''} noted`;
  }

  private generateCategoryRecommendations(comments: ReviewComment[]): string {
    if (comments.length === 0) {
      return '**No suggestions to provide – changes LGTM.**\n';
    }

    const critical = comments.filter(c => c.severity === 'error');
    const warnings = comments.filter(c => c.severity === 'warning');
    const info = comments.filter(c => c.severity === 'info');

    let recommendations = '';

    // Priority-based recommendations
    if (critical.length > 0) {
      recommendations += `- **Priority 1:** Address ${critical.length} critical issue${critical.length > 1 ? 's' : ''} before merging\n`;
    }

    if (warnings.length > 0) {
      recommendations += `- **Priority 2:** Review ${warnings.length} warning${warnings.length > 1 ? 's' : ''} and consider fixes\n`;
    }

    if (info.length > 0) {
      recommendations += `- **Priority 3:** Consider ${info.length} informational suggestion${info.length > 1 ? 's' : ''} for code improvement\n`;
    }

    // Add generic best practice
    if (critical.length === 0 && warnings.length === 0) {
      recommendations += '- All issues are informational - consider addressing for code quality\n';
    }

    return recommendations || '**No suggestions to provide – changes LGTM.**\n';
  }
}
