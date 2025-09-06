import { Octokit } from '@octokit/rest';
import { PRInfo } from './pr-analyzer';
import { CommentManager } from './github-comments';
import { AIReviewService, ReviewFocus } from './ai-review-service';

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
}

export interface ReviewOptions {
  focus?: 'security' | 'performance' | 'style' | 'all';
  format?: 'table' | 'json' | 'markdown' | 'sarif';
}

// Helper functions for calculating metrics from issues
export function calculateOverallScore(issues: ReviewIssue[]): number {
  if (issues.length === 0) return 100;

  const criticalCount = issues.filter(i => i.severity === 'critical').length;
  const errorCount = issues.filter(i => i.severity === 'error').length;
  const warningCount = issues.filter(i => i.severity === 'warning').length;
  const infoCount = issues.filter(i => i.severity === 'info').length;

  return Math.max(
    0,
    100 - criticalCount * 40 - errorCount * 25 - warningCount * 10 - infoCount * 5
  );
}

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
    const { focus = 'all', format = 'table' } = options;

    // Execute AI review (no fallback)
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
    options: ReviewOptions
  ): string {
    const { format = 'table' } = options;

    // Calculate metrics from issues
    const overallScore = calculateOverallScore(summary.issues);
    const totalIssues = calculateTotalIssues(summary.issues);
    const criticalIssues = calculateCriticalIssues(summary.issues);
    const comments = convertIssuesToComments(summary.issues);

    // Create main summary section
    let comment = `# 🔍 Visor Code Review Results\n\n`;
    comment += `## 📊 Summary\n`;
    comment += `- **Overall Score**: ${overallScore}/100\n`;
    comment += `- **Issues Found**: ${totalIssues} (${criticalIssues} Critical, ${totalIssues - criticalIssues} Other)\n`;
    comment += `- **Files Analyzed**: ${new Set(comments.map(c => c.file)).size}\n\n`;

    // Group comments by category for collapsible sections
    const groupedComments = this.groupCommentsByCategory(comments);

    for (const [category, comments] of Object.entries(groupedComments)) {
      const categoryScore = this.calculateCategoryScore(comments);
      const emoji = this.getCategoryEmoji(category);
      const issuesCount = comments.length;

      const title = `${emoji} ${category.charAt(0).toUpperCase() + category.slice(1)} Review (Score: ${categoryScore}/100)`;

      let sectionContent = '';
      if (comments.length > 0) {
        sectionContent += `### Issues Found:\n`;
        for (const reviewComment of comments.slice(
          0,
          format === 'markdown' ? comments.length : 3
        )) {
          sectionContent += `- **${reviewComment.severity.toUpperCase()}**: ${reviewComment.message}\n`;
          sectionContent += `  - **File**: \`${reviewComment.file}:${reviewComment.line}\`\n\n`;
        }

        if (format === 'table' && comments.length > 3) {
          sectionContent += `*...and ${comments.length - 3} more issues. Use \`/review --format=markdown\` for complete analysis.*\n\n`;
        }
      } else {
        sectionContent += `No issues found in this category. Great job! ✅\n\n`;
      }

      comment += this.commentManager.createCollapsibleSection(
        title,
        sectionContent,
        issuesCount > 0
      );
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

    return comment;
  }

  private formatReviewComment(summary: ReviewSummary, options: ReviewOptions): string {
    const { format = 'table' } = options;

    // Calculate metrics from issues
    const overallScore = calculateOverallScore(summary.issues);
    const totalIssues = calculateTotalIssues(summary.issues);
    const criticalIssues = calculateCriticalIssues(summary.issues);
    const comments = convertIssuesToComments(summary.issues);

    let comment = `## 🤖 AI Code Review\n\n`;
    comment += `**Overall Score:** ${overallScore}/100 `;

    if (overallScore >= 80) comment += '✅\n';
    else if (overallScore >= 60) comment += '⚠️\n';
    else comment += '❌\n';

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

  private calculateCategoryScore(comments: ReviewComment[]): number {
    if (comments.length === 0) return 100;

    const errorCount = comments.filter(c => c.severity === 'error').length;
    const warningCount = comments.filter(c => c.severity === 'warning').length;
    const infoCount = comments.filter(c => c.severity === 'info').length;

    return Math.max(0, 100 - errorCount * 25 - warningCount * 10 - infoCount * 5);
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
}
