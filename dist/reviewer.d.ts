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
    group?: string;
    schema?: string;
    timestamp?: number;
    suggestion?: string;
    replacement?: string;
}
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
export interface CheckResult {
    checkName: string;
    content: string;
    group: string;
    debug?: AIDebugInfo;
    issues?: ReviewIssue[];
}
export interface GroupedCheckResults {
    [groupName: string]: CheckResult[];
}
export interface ReviewSummary {
    issues?: ReviewIssue[];
    suggestions?: string[];
    debug?: AIDebugInfo;
}
export declare function convertReviewSummaryToGroupedResults(reviewSummary: ReviewSummary, checkName?: string, groupName?: string): GroupedCheckResults;
export declare function calculateTotalIssues(issues?: ReviewIssue[]): number;
export declare function calculateCriticalIssues(issues?: ReviewIssue[]): number;
export declare function convertIssuesToComments(issues: ReviewIssue[]): ReviewComment[];
export interface ReviewOptions {
    focus?: 'security' | 'performance' | 'style' | 'all';
    format?: 'table' | 'json' | 'markdown' | 'sarif';
    debug?: boolean;
    config?: import('./types/config').VisorConfig;
    checks?: string[];
    parallelExecution?: boolean;
}
export declare class PRReviewer {
    private octokit;
    private commentManager;
    private aiReviewService;
    constructor(octokit: Octokit);
    reviewPR(owner: string, repo: string, prNumber: number, prInfo: PRInfo, options?: ReviewOptions): Promise<GroupedCheckResults>;
    postReviewComment(owner: string, repo: string, prNumber: number, groupedResults: GroupedCheckResults, options?: ReviewOptions & {
        commentId?: string;
        triggeredBy?: string;
        commitSha?: string;
    }): Promise<void>;
    private formatGroupComment;
    private formatDebugSection;
    private saveDebugArtifact;
}
//# sourceMappingURL=reviewer.d.ts.map