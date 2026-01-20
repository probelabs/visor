import { Octokit } from '@octokit/rest';
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
/**
 * Manages GitHub PR comments with dynamic updating capabilities
 */
export declare class CommentManager {
    private octokit;
    private retryConfig;
    constructor(octokit: Octokit, retryConfig?: Partial<RetryConfig>);
    /**
     * Find existing Visor comment by comment ID marker
     */
    findVisorComment(owner: string, repo: string, prNumber: number, commentId?: string): Promise<Comment | null>;
    /**
     * Update existing comment or create new one with collision detection
     */
    updateOrCreateComment(owner: string, repo: string, prNumber: number, content: string, options?: {
        commentId?: string;
        triggeredBy?: string;
        allowConcurrentUpdates?: boolean;
        commitSha?: string;
        /** Cached GitHub comment ID to use for updates when listComments may not return it yet (eventual consistency) */
        cachedGithubCommentId?: number;
    }): Promise<Comment>;
    /**
     * Format comment content with metadata markers
     */
    formatCommentWithMetadata(content: string, metadata: CommentMetadata): string;
    /**
     * Create collapsible sections for comment content
     */
    createCollapsibleSection(title: string, content: string, isExpanded?: boolean): string;
    /**
     * Group review results by check type with collapsible sections
     */
    formatGroupedResults(results: Array<{
        checkType: string;
        content: string;
        score?: number;
        issuesFound?: number;
    }>, groupBy?: 'check' | 'severity'): string;
    /**
     * Generate unique comment ID
     */
    private generateCommentId;
    /**
     * Check if comment is a Visor comment
     */
    private isVisorComment;
    /**
     * Extract comment ID from comment body
     */
    extractCommentId(body: string): string | null;
    /**
     * Handle rate limiting with exponential backoff
     */
    private handleRateLimit;
    /**
     * Check if error is a rate limit error
     */
    private isRateLimitError;
    /**
     * Check if error should not be retried (auth errors, not found, etc.)
     */
    private isNonRetryableError;
    /**
     * Retry wrapper with exponential backoff
     */
    private withRetry;
    /**
     * Sleep utility
     */
    private sleep;
    /**
     * Group results by specified criteria
     */
    private groupResults;
    /**
     * Get severity group based on score
     */
    private getSeverityGroup;
    /**
     * Format group title with score and issue count
     */
    private formatGroupTitle;
}
