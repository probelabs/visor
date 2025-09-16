import { Octokit } from '@octokit/rest';
import { PRInfo } from './pr-analyzer';
import { AIDebugInfo } from './ai-review-service';
import { CustomTemplateConfig } from './types/config';
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
    template?: CustomTemplateConfig;
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
    config?: import('./types/config').VisorConfig;
    checks?: string[];
    parallelExecution?: boolean;
}
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
        commitSha?: string;
    }): Promise<void>;
    private formatReviewCommentWithVisorFormat;
    private renderWithSchemaTemplate;
    private generateGitHubDiffHash;
    private enhanceIssuesWithGitHubLinks;
    private renderSingleCheckTemplate;
    private groupIssuesByCheck;
    private extractCheckNameFromRuleId;
    private groupIssuesByGroup;
    private formatReviewComment;
    private groupCommentsByCategory;
    private groupCommentsByCheck;
    private formatDebugSection;
    private saveDebugArtifact;
    private formatDebugAsMarkdown;
    private parseCheckSections;
    private formatIssuesTable;
    private getLanguageHint;
    /**
     * Load custom template content from file or raw content
     */
    private loadCustomTemplate;
    /**
     * Detect if a string is likely a file path and if the file exists
     */
    private isFilePath;
    /**
     * Safely load template from file with security checks
     */
    private loadTemplateFromFile;
}
//# sourceMappingURL=reviewer.d.ts.map