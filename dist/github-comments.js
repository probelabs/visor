"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CommentManager = void 0;
const uuid_1 = require("uuid");
/**
 * Manages GitHub PR comments with dynamic updating capabilities
 */
class CommentManager {
    octokit;
    retryConfig;
    constructor(octokit, retryConfig) {
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
    async findVisorComment(owner, repo, prNumber, commentId) {
        try {
            const comments = await this.octokit.rest.issues.listComments({
                owner,
                repo,
                issue_number: prNumber,
                per_page: 100, // GitHub default max
            });
            for (const comment of comments.data) {
                if (comment.body && this.isVisorComment(comment.body, commentId)) {
                    return comment;
                }
            }
            return null;
        }
        catch (error) {
            if (this.isRateLimitError(error)) {
                await this.handleRateLimit(error);
                return this.findVisorComment(owner, repo, prNumber, commentId);
            }
            throw error;
        }
    }
    /**
     * Update existing comment or create new one with collision detection
     */
    async updateOrCreateComment(owner, repo, prNumber, content, options = {}) {
        const { commentId = this.generateCommentId(), triggeredBy = 'unknown', allowConcurrentUpdates = false, commitSha, } = options;
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
                        throw new Error(`Comment collision detected for comment ${commentId}. Another process may have updated it.`);
                    }
                }
                const updatedComment = await this.octokit.rest.issues.updateComment({
                    owner,
                    repo,
                    comment_id: existingComment.id,
                    body: formattedContent,
                });
                return updatedComment.data;
            }
            else {
                const newComment = await this.octokit.rest.issues.createComment({
                    owner,
                    repo,
                    issue_number: prNumber,
                    body: formattedContent,
                });
                return newComment.data;
            }
        });
    }
    /**
     * Format comment content with metadata markers
     */
    formatCommentWithMetadata(content, metadata) {
        const { commentId, lastUpdated, triggeredBy, commitSha } = metadata;
        const commitInfo = commitSha ? ` | Commit: ${commitSha.substring(0, 7)}` : '';
        return `<!-- visor-comment-id:${commentId} -->
${content}

*Last updated: ${lastUpdated} | Triggered by: ${triggeredBy}${commitInfo}*
<!-- /visor-comment-id:${commentId} -->`;
    }
    /**
     * Create collapsible sections for comment content
     */
    createCollapsibleSection(title, content, isExpanded = false) {
        const openAttribute = isExpanded ? ' open' : '';
        return `<details${openAttribute}>
<summary>${title}</summary>

${content}

</details>`;
    }
    /**
     * Group review results by check type with collapsible sections
     */
    formatGroupedResults(results, groupBy = 'check') {
        const grouped = this.groupResults(results, groupBy);
        const sections = [];
        for (const [groupKey, items] of Object.entries(grouped)) {
            const totalScore = items.reduce((sum, item) => sum + (item.score || 0), 0) / items.length;
            const totalIssues = items.reduce((sum, item) => sum + (item.issuesFound || 0), 0);
            const emoji = this.getCheckTypeEmoji(groupKey);
            const title = `${emoji} ${this.formatGroupTitle(groupKey, totalScore, totalIssues)}`;
            const sectionContent = items.map(item => item.content).join('\n\n');
            sections.push(this.createCollapsibleSection(title, sectionContent, totalIssues > 0));
        }
        return sections.join('\n\n');
    }
    /**
     * Generate unique comment ID
     */
    generateCommentId() {
        return (0, uuid_1.v4)().substring(0, 8);
    }
    /**
     * Check if comment is a Visor comment
     */
    isVisorComment(body, commentId) {
        if (commentId) {
            // Check for the new format with exact matching - look for the exact ID followed by space or " -->"
            if (body.includes(`visor-comment-id:${commentId} `) ||
                body.includes(`visor-comment-id:${commentId} -->`)) {
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
        return ((body.includes('visor-comment-id:') && body.includes('<!-- /visor-comment-id:')) ||
            body.includes('visor-review-'));
    }
    /**
     * Extract comment ID from comment body
     */
    extractCommentId(body) {
        const match = body.match(/visor-comment-id:([a-f0-9-]+)/);
        return match ? match[1] : null;
    }
    /**
     * Handle rate limiting with exponential backoff
     */
    async handleRateLimit(error) {
        const resetTime = error.response?.headers?.['x-ratelimit-reset'];
        if (resetTime) {
            const resetDate = new Date(parseInt(resetTime) * 1000);
            const waitTime = Math.max(resetDate.getTime() - Date.now(), this.retryConfig.baseDelay);
            console.log(`Rate limit exceeded. Waiting ${Math.round(waitTime / 1000)}s until reset...`);
            await this.sleep(Math.min(waitTime, this.retryConfig.maxDelay));
        }
        else {
            await this.sleep(this.retryConfig.baseDelay);
        }
    }
    /**
     * Check if error is a rate limit error
     */
    isRateLimitError(error) {
        return error.status === 403 && (error.response?.data?.message?.includes('rate limit') ?? false);
    }
    /**
     * Check if error should not be retried (auth errors, not found, etc.)
     */
    isNonRetryableError(error) {
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
    async withRetry(operation) {
        let lastError = new Error('Unknown error');
        for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
            try {
                return await operation();
            }
            catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                if (attempt === this.retryConfig.maxRetries) {
                    break;
                }
                if (this.isRateLimitError(error)) {
                    await this.handleRateLimit(error);
                }
                else if (this.isNonRetryableError(error)) {
                    // Don't retry auth errors, not found errors, etc.
                    throw error;
                }
                else {
                    const delay = Math.min(this.retryConfig.baseDelay * Math.pow(this.retryConfig.backoffFactor, attempt), this.retryConfig.maxDelay);
                    await this.sleep(delay);
                }
            }
        }
        throw lastError;
    }
    /**
     * Sleep utility
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    /**
     * Group results by specified criteria
     */
    groupResults(results, groupBy) {
        const grouped = {};
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
    getSeverityGroup(score) {
        if (!score)
            return 'Unknown';
        if (score >= 90)
            return 'Excellent';
        if (score >= 75)
            return 'Good';
        if (score >= 50)
            return 'Needs Improvement';
        return 'Critical Issues';
    }
    /**
     * Get emoji for check type
     */
    getCheckTypeEmoji(checkType) {
        const emojiMap = {
            performance: '📈',
            security: '🔒',
            architecture: '🏗️',
            style: '🎨',
            all: '🔍',
            Excellent: '✅',
            Good: '👍',
            'Needs Improvement': '⚠️',
            'Critical Issues': '🚨',
            Unknown: '❓',
        };
        return emojiMap[checkType] || '📝';
    }
    /**
     * Format group title with score and issue count
     */
    formatGroupTitle(groupKey, score, issuesFound) {
        const formattedScore = Math.round(score);
        return `${groupKey} Review (Score: ${formattedScore}/100)${issuesFound > 0 ? ` - ${issuesFound} issues found` : ''}`;
    }
}
exports.CommentManager = CommentManager;
//# sourceMappingURL=github-comments.js.map