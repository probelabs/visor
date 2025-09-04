import { Octokit } from '@octokit/rest';
import { PRInfo, PRDiff } from './pr-analyzer';
import { CommentManager } from './github-comments';

export interface ReviewComment {
  file: string;
  line: number;
  message: string;
  severity: 'info' | 'warning' | 'error';
  category: 'security' | 'performance' | 'style' | 'logic' | 'documentation';
}

export interface ReviewSummary {
  overallScore: number; // 0-100
  totalIssues: number;
  criticalIssues: number;
  suggestions: string[];
  comments: ReviewComment[];
}

export interface ReviewOptions {
  focus?: 'security' | 'performance' | 'style' | 'all';
  format?: 'summary' | 'detailed';
}

export class PRReviewer {
  private commentManager: CommentManager;
  
  constructor(private octokit: Octokit) {
    this.commentManager = new CommentManager(octokit);
  }

  async reviewPR(
    owner: string,
    repo: string,
    prNumber: number,
    prInfo: PRInfo,
    options: ReviewOptions = {}
  ): Promise<ReviewSummary> {
    const { focus = 'all', format = 'summary' } = options;

    // Mock analysis - in real implementation this would use AI or static analysis tools
    const comments = this.analyzePRFiles(prInfo.files, focus);
    const suggestions = this.generateSuggestions(prInfo, comments);

    const criticalIssues = comments.filter(c => c.severity === 'error').length;
    const totalIssues = comments.length;
    const overallScore = Math.max(0, 100 - criticalIssues * 20 - totalIssues * 5);

    return {
      overallScore,
      totalIssues,
      criticalIssues,
      suggestions,
      comments: format === 'detailed' ? comments : comments.slice(0, 5), // Limit for summary
    };
  }

  private analyzePRFiles(files: PRDiff[], focus: string): ReviewComment[] {
    const comments: ReviewComment[] = [];

    for (const file of files) {
      // Mock security analysis
      if ((focus === 'security' || focus === 'all') && this.hasSecurityConcerns(file)) {
        comments.push({
          file: file.filename,
          line: 1,
          message: 'Consider input validation and sanitization',
          severity: 'warning',
          category: 'security',
        });
      }

      // Mock performance analysis
      if ((focus === 'performance' || focus === 'all') && this.hasPerformanceConcerns(file)) {
        comments.push({
          file: file.filename,
          line: 10,
          message: 'This operation might be expensive - consider caching',
          severity: 'info',
          category: 'performance',
        });
      }

      // Mock style analysis
      if ((focus === 'style' || focus === 'all') && this.hasStyleIssues(file)) {
        comments.push({
          file: file.filename,
          line: 5,
          message: 'Consider consistent naming conventions',
          severity: 'info',
          category: 'style',
        });
      }

      // Mock large file warning
      if (file.additions > 100) {
        comments.push({
          file: file.filename,
          line: 1,
          message: 'Large file change detected - consider breaking into smaller commits',
          severity: 'warning',
          category: 'logic',
        });
      }

      // Mock missing documentation
      if (file.filename.endsWith('.ts') && !file.patch?.includes('/**')) {
        comments.push({
          file: file.filename,
          line: 1,
          message: 'Consider adding JSDoc comments for public functions',
          severity: 'info',
          category: 'documentation',
        });
      }
    }

    return comments;
  }

  private hasSecurityConcerns(file: PRDiff): boolean {
    if (!file.patch) return false;
    const securityKeywords = ['eval', 'innerHTML', 'dangerouslySetInnerHTML', 'exec', 'system'];
    return securityKeywords.some(keyword => file.patch!.includes(keyword));
  }

  private hasPerformanceConcerns(file: PRDiff): boolean {
    if (!file.patch) return false;
    const performanceKeywords = ['for', 'while', 'map', 'filter', 'reduce'];
    return performanceKeywords.some(keyword => file.patch!.includes(keyword));
  }

  private hasStyleIssues(file: PRDiff): boolean {
    if (!file.patch) return false;
    // Mock style check - inconsistent spacing, naming, etc.
    return file.patch.includes('  ') || file.patch.includes('\t');
  }

  private generateSuggestions(prInfo: PRInfo, comments: ReviewComment[]): string[] {
    const suggestions: string[] = [];

    if (prInfo.totalAdditions > 500) {
      suggestions.push('Consider breaking this large PR into smaller, more focused changes');
    }

    if (comments.some(c => c.category === 'security')) {
      suggestions.push('Run security audit tools like npm audit or Snyk');
    }

    if (comments.some(c => c.category === 'performance')) {
      suggestions.push('Consider performance profiling for critical paths');
    }

    if (prInfo.files.some(f => f.filename.includes('test'))) {
      suggestions.push('Great job including tests! Consider edge cases and error scenarios');
    } else {
      suggestions.push('Consider adding unit tests for the new functionality');
    }

    if (!prInfo.body.trim()) {
      suggestions.push('Add a detailed PR description explaining the changes and their purpose');
    }

    return suggestions;
  }

  async postReviewComment(
    owner: string,
    repo: string,
    prNumber: number,
    summary: ReviewSummary,
    options: ReviewOptions & { commentId?: string; triggeredBy?: string } = {}
  ): Promise<void> {
    const comment = this.formatReviewCommentWithVisorFormat(summary, options);

    await this.commentManager.updateOrCreateComment(
      owner,
      repo,
      prNumber,
      comment,
      {
        commentId: options.commentId,
        triggeredBy: options.triggeredBy || 'unknown',
        allowConcurrentUpdates: false,
      }
    );
  }

  private formatReviewCommentWithVisorFormat(summary: ReviewSummary, options: ReviewOptions): string {
    const { format = 'summary' } = options;

    // Create main summary section
    let comment = `# 🔍 Visor Code Review Results\n\n`;
    comment += `## 📊 Summary\n`;
    comment += `- **Overall Score**: ${summary.overallScore}/100\n`;
    comment += `- **Issues Found**: ${summary.totalIssues} (${summary.criticalIssues} Critical, ${summary.totalIssues - summary.criticalIssues} Other)\n`;
    comment += `- **Files Analyzed**: ${new Set(summary.comments.map(c => c.file)).size}\n\n`;

    // Group comments by category for collapsible sections
    const groupedComments = this.groupCommentsByCategory(summary.comments);

    for (const [category, comments] of Object.entries(groupedComments)) {
      const categoryScore = this.calculateCategoryScore(comments);
      const emoji = this.getCategoryEmoji(category);
      const issuesCount = comments.length;
      
      const title = `${emoji} ${category.charAt(0).toUpperCase() + category.slice(1)} Review (Score: ${categoryScore}/100)`;
      
      let sectionContent = '';
      if (comments.length > 0) {
        sectionContent += `### Issues Found:\n`;
        for (const reviewComment of comments.slice(0, format === 'detailed' ? comments.length : 3)) {
          const severityEmoji =
            reviewComment.severity === 'error' ? '🚨' :
            reviewComment.severity === 'warning' ? '⚠️' : 'ℹ️';
          sectionContent += `- **${reviewComment.severity.toUpperCase()}**: ${reviewComment.message}\n`;
          sectionContent += `  - **File**: \`${reviewComment.file}:${reviewComment.line}\`\n\n`;
        }
        
        if (format === 'summary' && comments.length > 3) {
          sectionContent += `*...and ${comments.length - 3} more issues. Use \`/review --format=detailed\` for complete analysis.*\n\n`;
        }
      } else {
        sectionContent += `No issues found in this category. Great job! ✅\n\n`;
      }
      
      comment += this.commentManager.createCollapsibleSection(title, sectionContent, issuesCount > 0);
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
    const { format = 'summary' } = options;

    let comment = `## 🤖 AI Code Review\n\n`;
    comment += `**Overall Score:** ${summary.overallScore}/100 `;

    if (summary.overallScore >= 80) comment += '✅\n';
    else if (summary.overallScore >= 60) comment += '⚠️\n';
    else comment += '❌\n';

    comment += `**Issues Found:** ${summary.totalIssues} (${summary.criticalIssues} critical)\n\n`;

    if (summary.suggestions.length > 0) {
      comment += `### 💡 Suggestions\n`;
      for (const suggestion of summary.suggestions) {
        comment += `- ${suggestion}\n`;
      }
      comment += '\n';
    }

    if (summary.comments.length > 0) {
      comment += `### 🔍 Code Issues\n`;
      for (const reviewComment of summary.comments) {
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

    if (format === 'summary' && summary.totalIssues > 5) {
      comment += `*Showing top 5 issues. Use \`/review --format=detailed\` for complete analysis.*\n\n`;
    }

    comment += `---\n*Review powered by Gates Action - Use \`/help\` for available commands*`;

    return comment;
  }

  private groupCommentsByCategory(comments: ReviewComment[]): Record<string, ReviewComment[]> {
    const grouped: Record<string, ReviewComment[]> = {
      security: [],
      performance: [],
      style: [],
      logic: [],
      documentation: []
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
      documentation: '📚'
    };
    return emojiMap[category] || '📝';
  }
}
