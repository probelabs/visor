import { Octokit } from '@octokit/rest';
export interface PRFile {
    filename: string;
    additions: number;
    deletions: number;
    changes: number;
    patch?: string;
    status: 'added' | 'removed' | 'modified' | 'renamed';
}
export interface PRDiff {
    filename: string;
    additions: number;
    deletions: number;
    changes: number;
    patch?: string;
    status: 'added' | 'removed' | 'modified' | 'renamed';
}
export interface PRComment {
    id: number;
    author: string;
    body: string;
    createdAt: string;
    updatedAt: string;
}
export interface PRInfo {
    number: number;
    title: string;
    body: string;
    author: string;
    authorAssociation?: string;
    base: string;
    head: string;
    files: PRDiff[];
    totalAdditions: number;
    totalDeletions: number;
    eventType?: import('./types/config').EventTrigger;
    fullDiff?: string;
    commitDiff?: string;
    isIncremental?: boolean;
    isIssue?: boolean;
    eventContext?: Record<string, unknown>;
    comments?: PRComment[];
    labels?: string[];
}
export declare class PRAnalyzer {
    private octokit;
    private maxRetries;
    private fileExclusionHelper;
    constructor(octokit: Octokit, maxRetries?: number, workingDirectory?: string);
    /**
     * Fetch commit diff for incremental analysis
     */
    fetchCommitDiff(owner: string, repo: string, commitSha: string): Promise<string>;
    /**
     * Generate unified diff for all PR files
     */
    private generateFullDiff;
    fetchPRDiff(owner: string, repo: string, prNumber: number, commitSha?: string, eventType?: import('./types/config').EventTrigger): Promise<PRInfo>;
    fetchPRComments(owner: string, repo: string, prNumber: number): Promise<{
        id: number;
        author: string;
        body: string;
        createdAt: string;
        updatedAt: string;
    }[]>;
    private withRetry;
    private isRetryableError;
}
