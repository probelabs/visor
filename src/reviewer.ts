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
  suggestion?: string;
  replacement?: string;
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
    suggestion: issue.suggestion,
    replacement: issue.replacement,
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

      // Return all issues - no filtering needed
      return reviewSummary;
    }

    // If debug is enabled, create a new AI service with debug enabled
    if (debug) {
      this.aiReviewService = new AIReviewService({ debug: true });
    }

    // Execute AI review (no fallback) - single check or legacy mode
    const aiReview = await this.aiReviewService.executeReview(prInfo, focus as ReviewFocus);

    // Return all issues - no filtering needed
    return aiReview;
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
      // Create main issues table with each row being an issue
      comment += this.formatIssuesTable(comments);
      comment += '\n\n';
      
      // Add summary and recommendations
      comment += this.formatSummaryAndRecommendations(comments);
      comment += '\n\n';
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

  private formatIssuesTable(comments: ReviewComment[]): string {
    let content = `## 🔍 Code Analysis Results\n\n`;
    
    // Start HTML table
    content += `<table>\n`;
    content += `  <thead>\n`;
    content += `    <tr>\n`;
    content += `      <th>Severity</th>\n`;
    content += `      <th>Category</th>\n`;
    content += `      <th>File</th>\n`;
    content += `      <th>Line</th>\n`;
    content += `      <th>Issue</th>\n`;
    content += `    </tr>\n`;
    content += `  </thead>\n`;
    content += `  <tbody>\n`;

    // Sort by severity first (critical > error > warning > info), then by file
    const sortedComments = comments.sort((a, b) => {
      const severityOrder = { critical: 0, error: 1, warning: 2, info: 3 };
      const severityDiff = (severityOrder[a.severity] || 4) - (severityOrder[b.severity] || 4);
      if (severityDiff !== 0) return severityDiff;
      return a.file.localeCompare(b.file);
    });

    for (const comment of sortedComments) {
      const severityEmoji = comment.severity === 'critical' ? '🔴' :
                           comment.severity === 'error' ? '🔴' : 
                           comment.severity === 'warning' ? '🟡' : '🟢';
      const categoryEmoji = this.getCategoryEmoji(comment.category);
      const severityText = comment.severity.charAt(0).toUpperCase() + comment.severity.slice(1);
      
      // Build the issue description with suggestion/replacement if available
      let issueDescription = comment.message;
      
      if (comment.suggestion) {
        issueDescription += `<br/><details><summary>💡 <strong>Suggestion</strong></summary>${comment.suggestion}</details>`;
      }
      
      if (comment.replacement) {
        // Extract language hint from file extension
        const fileExt = comment.file.split('.').pop()?.toLowerCase() || 'text';
        const languageHint = this.getLanguageHint(fileExt);
        issueDescription += `<br/><details><summary>🔧 <strong>Suggested Fix</strong></summary><pre><code class="language-${languageHint}">${comment.replacement}</code></pre></details>`;
      }
      
      content += `    <tr>\n`;
      content += `      <td>${severityEmoji} ${severityText}</td>\n`;
      content += `      <td>${categoryEmoji} ${comment.category}</td>\n`;
      content += `      <td><code>${comment.file}</code></td>\n`;
      content += `      <td>${comment.line}</td>\n`;
      content += `      <td>${issueDescription}</td>\n`;
      content += `    </tr>\n`;
    }

    // Close HTML table
    content += `  </tbody>\n`;
    content += `</table>\n`;

    return content;
  }

  private formatSummaryAndRecommendations(comments: ReviewComment[]): string {
    const critical = comments.filter(c => c.severity === 'critical' || c.severity === 'error').length;
    const warnings = comments.filter(c => c.severity === 'warning').length;
    const info = comments.filter(c => c.severity === 'info').length;
    const total = comments.length;

    let content = `<details>\n<summary><strong>📊 Summary</strong></summary>\n\n`;
    content += `**Total Issues Found:** ${total}\n\n`;
    content += `- 🔴 **Critical:** ${critical} issue${critical !== 1 ? 's' : ''}\n`;
    content += `- 🟡 **Warnings:** ${warnings} issue${warnings !== 1 ? 's' : ''}\n`;
    content += `- 🟢 **Info:** ${info} item${info !== 1 ? 's' : ''}\n\n`;

    // Group by category for summary
    const groupedComments = this.groupCommentsByCategory(comments);
    content += `**By Category:**\n`;
    for (const [category, categoryComments] of Object.entries(groupedComments)) {
      if (categoryComments.length > 0) {
        const emoji = this.getCategoryEmoji(category);
        content += `- ${emoji} **${category.charAt(0).toUpperCase() + category.slice(1)}:** ${categoryComments.length} issue${categoryComments.length !== 1 ? 's' : ''}\n`;
      }
    }

    content += `\n</details>\n\n`;

    // Add recommendations
    content += `<details>\n<summary><strong>💡 Recommendations</strong></summary>\n\n`;
    
    if (critical > 0) {
      content += `🚨 **Immediate Action Required:** ${critical} critical issue${critical !== 1 ? 's' : ''} must be addressed before merging.\n\n`;
    }
    
    if (warnings > 0) {
      content += `⚠️  **Review Needed:** ${warnings} warning${warnings !== 1 ? 's' : ''} should be reviewed and potentially fixed.\n\n`;
    }
    
    if (info > 0) {
      content += `ℹ️  **Consider:** ${info} informational suggestion${info !== 1 ? 's' : ''} for code quality improvement.\n\n`;
    }

    if (critical === 0 && warnings === 0) {
      content += `✅ **Great Job!** Only informational items found. Consider addressing them for optimal code quality.\n\n`;
    }

    content += `</details>`;

    return content;
  }

  private getLanguageHint(fileExtension: string): string {
    const langMap: Record<string, string> = {
      'ts': 'typescript',
      'tsx': 'typescript',
      'js': 'javascript', 
      'jsx': 'javascript',
      'py': 'python',
      'java': 'java',
      'kt': 'kotlin',
      'swift': 'swift',
      'go': 'go',
      'rs': 'rust',
      'cpp': 'cpp',
      'c': 'c',
      'cs': 'csharp',
      'php': 'php',
      'rb': 'ruby',
      'scala': 'scala',
      'sh': 'bash',
      'bash': 'bash',
      'zsh': 'bash',
      'sql': 'sql',
      'json': 'json',
      'yaml': 'yaml',
      'yml': 'yaml',
      'xml': 'xml',
      'html': 'html',
      'css': 'css',
      'scss': 'scss',
      'sass': 'sass',
      'md': 'markdown',
      'dockerfile': 'dockerfile',
      'tf': 'hcl',
    };
    
    return langMap[fileExtension] || fileExtension;
  }
}
