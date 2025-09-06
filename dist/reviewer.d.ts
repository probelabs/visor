import { Octokit } from '@octokit/rest';
import { PRInfo } from './pr-analyzer';
import { AIDebugInfo } from './ai-review-service';
export interface ReviewIssue {
    file: string;
    line: number;
    endLine?: number;
    ruleId: string;
    message: string;
    severity: 'info' | 'warning' | 'error' | 'critical';
    category: 'security' | 'performance' | 'style' | 'logic' | 'documentation';
    suggestion?: string;
    replacement?: string;
}
export interface ReviewComment {
    file: string;
    line: number;
    message: string;
    severity: 'info' | 'warning' | 'error' | 'critical';
    category: 'security' | 'performance' | 'style' | 'logic' | 'documentation';
}
export interface ReviewSummary {
    issues: ReviewIssue[];
    suggestions: string[];
    /** Debug information (only included when debug mode is enabled) */
    debug?: AIDebugInfo;
}
export interface ReviewOptions {
    focus?: 'security' | 'performance' | 'style' | 'all';
    format?: 'table' | 'json' | 'markdown' | 'sarif';
    debug?: boolean;
}
export declare function calculateOverallScore(issues: ReviewIssue[]): number;
export declare function calculateTotalIssues(issues: ReviewIssue[]): number;
export declare function calculateCriticalIssues(issues: ReviewIssue[]): number;
export declare function convertIssuesToComments(issues: ReviewIssue[]): ReviewComment[];
export declare class PRReviewer {
    private octokit;
    private commentManager;
    private aiReviewService;
    constructor(octokit: Octokit);
    reviewPR(owner: string, repo: string, prNumber: number, prInfo: PRInfo, options?: ReviewOptions): Promise<ReviewSummary>;
    postReviewComment(owner: string, repo: string, prNumber: number, summary: ReviewSummary, options?: ReviewOptions & {
        commentId?: string;
        triggeredBy?: string;
    }): Promise<void>;
    private formatReviewCommentWithVisorFormat;
    private formatReviewComment;
    private groupCommentsByCategory;
    private calculateCategoryScore;
    private getCategoryEmoji;
    private formatDebugSection;
}
//# sourceMappingURL=reviewer.d.ts.map