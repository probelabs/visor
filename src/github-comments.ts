import { Octokit } from '@octokit/rest';
import { v4 as uuidv4 } from 'uuid';
import { logger } from './logger';
import { generateFooter } from './footer';

export interface Comment {
  id: number;
  body: string;
  user: {
    login: string;
  };
  created_at: string;
  updated_at: string;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  backoffFactor: number;
}

export interface CommentMetadata {
  commentId: string;
  lastUpdated: string;
  triggeredBy: string;
  commitSha?: string;
}

interface GitHubApiError {
  status?: number;
  response?: {
    status?: number;
    data?: {
      message?: string;
    };
  };
}

/**
 * Manages GitHub PR comments with dynamic updating capabilities
 */
export class CommentManager {
  private octokit: Octokit;
  private retryConfig: RetryConfig;

  constructor(octokit: Octokit, retryConfig?: Partial<RetryConfig>) {
    this.octokit = octokit;
    this.retryConfig = {
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 10000,
      backoffFactor: 2,
      ...retryConfig,
    };
  }

  /**
   * Find existing Visor comment by comment ID marker
   */
  public async findVisorComment(
    owner: string,
    repo: string,
    prNumber: number,
    commentId?: string
  ): Promise<Comment | null> {
    try {
      const comments = await this.octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: prNumber,
        per_page: 100, // GitHub default max
      });

      for (const comment of comments.data) {
        if (comment.body && this.isVisorComment(comment.body, commentId)) {
          return comment as Comment;
        }
      }

      return null;
    } catch (error) {
      if (
        this.isRateLimitError(
          error as { status?: number; response?: { data?: { message?: string } } }
        )
      ) {
        await this.handleRateLimit(error as { response?: { headers?: Record<string, string> } });
        return this.findVisorComment(owner, repo, prNumber, commentId);
      }
      throw error;
    }
  }

  /**
   * Update existing comment or create new one with collision detection
   */
  public async updateOrCreateComment(
    owner: string,
    repo: string,
    prNumber: number,
    content: string,
    options: {
      commentId?: string;
      triggeredBy?: string;
      allowConcurrentUpdates?: boolean;
      commitSha?: string;
    } = {}
  ): Promise<Comment> {
    const {
      commentId = this.generateCommentId(),
      triggeredBy = 'unknown',
      allowConcurrentUpdates = false,
      commitSha,
    } = options;

    return this.withRetry(async () => {
      const existingComment = await this.findVisorComment(owner, repo, prNumber, commentId);

      const formattedContent = this.formatCommentWithMetadata(content, {
        commentId,
        lastUpdated: new Date().toISOString(),
        triggeredBy,
        commitSha,
      });

      if (existingComment) {
        // Check for collision if not allowing concurrent updates
        if (!allowConcurrentUpdates) {
          const currentComment = await this.octokit.rest.issues.getComment({
            owner,
            repo,
            comment_id: existingComment.id,
          });

          if (currentComment.data.updated_at !== existingComment.updated_at) {
            throw new Error(
              `Comment collision detected for comment ${commentId}. Another process may have updated it.`
            );
          }
        }

        const updatedComment = await this.octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: existingComment.id,
          body: formattedContent,
        });

        logger.info(
          `✅ Successfully updated comment (ID: ${commentId}, GitHub ID: ${existingComment.id}) on PR #${prNumber} in ${owner}/${repo}`
        );

        return updatedComment.data as Comment;
      } else {
        const newComment = await this.octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: prNumber,
          body: formattedContent,
        });

        logger.info(
          `✅ Successfully created comment (ID: ${commentId}, GitHub ID: ${newComment.data.id}) on PR #${prNumber} in ${owner}/${repo}`
        );

        return newComment.data as Comment;
      }
    });
  }

  /**
   * Format comment content with metadata markers
   */
  public formatCommentWithMetadata(content: string, metadata: CommentMetadata): string {
    const { commentId, lastUpdated, triggeredBy, commitSha } = metadata;

    const footer = generateFooter({
      includeMetadata: {
        lastUpdated,
        triggeredBy,
        commitSha,
      },
    });

    return `<!-- visor-comment-id:${commentId} -->
${content}

${footer}
<!-- /visor-comment-id:${commentId} -->`;
  }

  /**
   * Create collapsible sections for comment content
   */
  public createCollapsibleSection(
    title: string,
    content: string,
    isExpanded: boolean = false
  ): string {
    const openAttribute = isExpanded ? ' open' : '';
    return `<details${openAttribute}>
<summary>${title}</summary>

${content}

</details>`;
  }

  /**
   * Group review results by check type with collapsible sections
   */
  public formatGroupedResults(
    results: Array<{ checkType: string; content: string; score?: number; issuesFound?: number }>,
    groupBy: 'check' | 'severity' = 'check'
  ): string {
    const grouped = this.groupResults(results, groupBy);
    const sections: string[] = [];

    for (const [groupKey, items] of Object.entries(grouped)) {
      const totalScore = items.reduce((sum, item) => sum + (item.score || 0), 0) / items.length;
      const totalIssues = items.reduce((sum, item) => sum + (item.issuesFound || 0), 0);

      const title = this.formatGroupTitle(groupKey, totalScore, totalIssues);

      const sectionContent = items.map(item => item.content).join('\n\n');
      sections.push(this.createCollapsibleSection(title, sectionContent, totalIssues > 0));
    }

    return sections.join('\n\n');
  }

  /**
   * Generate unique comment ID
   */
  private generateCommentId(): string {
    return uuidv4().substring(0, 8);
  }

  /**
   * Check if comment is a Visor comment
   */
  private isVisorComment(body: string, commentId?: string): boolean {
    if (commentId) {
      // Check for the new format with exact matching - look for the exact ID followed by space or " -->"
      if (
        body.includes(`visor-comment-id:${commentId} `) ||
        body.includes(`visor-comment-id:${commentId} -->`)
      ) {
        return true;
      }
      // Check for legacy format (visor-review-* pattern) for backwards compatibility
      if (commentId.startsWith('pr-review-') && body.includes('visor-review-')) {
        return true;
      }
      // If we have a specific commentId but no exact match, return false
      return false;
    }
    // General Visor comment detection (only when no specific commentId provided)
    return (
      (body.includes('visor-comment-id:') && body.includes('<!-- /visor-comment-id:')) ||
      body.includes('visor-review-')
    );
  }

  /**
   * Extract comment ID from comment body
   */
  public extractCommentId(body: string): string | null {
    const match = body.match(/visor-comment-id:([a-f0-9-]+)/);
    return match ? match[1] : null;
  }

  /**
   * Handle rate limiting with exponential backoff
   */
  private async handleRateLimit(error: {
    response?: { headers?: Record<string, string> };
  }): Promise<void> {
    const resetTime = error.response?.headers?.['x-ratelimit-reset'];
    if (resetTime) {
      const resetDate = new Date(parseInt(resetTime) * 1000);
      const waitTime = Math.max(resetDate.getTime() - Date.now(), this.retryConfig.baseDelay);
      console.log(`Rate limit exceeded. Waiting ${Math.round(waitTime / 1000)}s until reset...`);
      await this.sleep(Math.min(waitTime, this.retryConfig.maxDelay));
    } else {
      await this.sleep(this.retryConfig.baseDelay);
    }
  }

  /**
   * Check if error is a rate limit error
   */
  private isRateLimitError(error: GitHubApiError): boolean {
    return error.status === 403 && (error.response?.data?.message?.includes('rate limit') ?? false);
  }

  /**
   * Check if error should not be retried (auth errors, not found, etc.)
   */
  private isNonRetryableError(error: GitHubApiError): boolean {
    // Don't retry auth errors, not found, etc., but allow rate limit errors to be handled separately
    const nonRetryableStatuses = [401, 404, 422]; // Unauthorized, Not Found, Unprocessable Entity
    const status = error.status || error.response?.status;

    // 403 is non-retryable unless it's a rate limit error
    if (status === 403) {
      return !this.isRateLimitError(error);
    }

    return status !== undefined && nonRetryableStatuses.includes(status);
  }

  /**
   * Retry wrapper with exponential backoff
   */
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error = new Error('Unknown error');

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt === this.retryConfig.maxRetries) {
          break;
        }

        if (
          this.isRateLimitError(
            error as { status?: number; response?: { data?: { message?: string } } }
          )
        ) {
          await this.handleRateLimit(error as { response?: { headers?: Record<string, string> } });
        } else if (this.isNonRetryableError(error as GitHubApiError)) {
          // Don't retry auth errors, not found errors, etc.
          throw error;
        } else {
          const computed =
            this.retryConfig.baseDelay * Math.pow(this.retryConfig.backoffFactor, attempt);
          const delay =
            computed > this.retryConfig.maxDelay
              ? Math.max(0, this.retryConfig.maxDelay - 1)
              : computed;
          await this.sleep(delay);
        }
      }
    }

    throw lastError;
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const t = setTimeout(resolve, ms);
      if (typeof (t as any).unref === 'function') {
        try {
          (t as any).unref();
        } catch {}
      }
    });
  }

  /**
   * Group results by specified criteria
   */
  private groupResults(
    results: Array<{ checkType: string; content: string; score?: number; issuesFound?: number }>,
    groupBy: 'check' | 'severity'
  ): Record<
    string,
    Array<{ checkType: string; content: string; score?: number; issuesFound?: number }>
  > {
    const grouped: Record<
      string,
      Array<{ checkType: string; content: string; score?: number; issuesFound?: number }>
    > = {};

    for (const result of results) {
      const key = groupBy === 'check' ? result.checkType : this.getSeverityGroup(result.score);
      if (!grouped[key]) {
        grouped[key] = [];
      }
      grouped[key].push(result);
    }

    return grouped;
  }

  /**
   * Get severity group based on score
   */
  private getSeverityGroup(score?: number): string {
    if (!score) return 'Unknown';
    if (score >= 90) return 'Excellent';
    if (score >= 75) return 'Good';
    if (score >= 50) return 'Needs Improvement';
    return 'Critical Issues';
  }

  // Emoji helper removed: plain titles are used in group headers

  /**
   * Format group title with score and issue count
   */
  private formatGroupTitle(groupKey: string, score: number, issuesFound: number): string {
    const formattedScore = Math.round(score);
    return `${groupKey} Review (Score: ${formattedScore}/100)${issuesFound > 0 ? ` - ${issuesFound} issues found` : ''}`;
  }
}
