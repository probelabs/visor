import { Octokit } from '@octokit/rest';
export interface PRDetectionResult {
    prNumber: number | null;
    confidence: 'high' | 'medium' | 'low';
    source: 'direct' | 'api_query' | 'comment' | 'branch_search' | 'commit_search';
    details?: string;
}
export interface GitHubEventContext {
    event_name: string;
    repository?: {
        owner: {
            login: string;
        };
        name: string;
    };
    event?: {
        pull_request?: {
            number: number;
            head?: {
                sha: string;
            };
        };
        issue?: {
            number: number;
            pull_request?: {
                url: string;
            };
        };
        comment?: {
            body: string;
            user: {
                login: string;
            };
        };
        action?: string;
        commits?: Array<{
            id: string;
            message: string;
        }>;
        head_commit?: {
            id: string;
        };
        ref?: string;
    };
    payload?: Record<string, unknown>;
}
/**
 * Robust PR detection utility that works across all GitHub event types
 */
export declare class PRDetector {
    private octokit;
    private debug;
    constructor(octokit: Octokit, debug?: boolean);
    private log;
    /**
     * Detect PR number from GitHub context with comprehensive fallback strategies
     */
    detectPRNumber(context: GitHubEventContext, owner?: string, repo?: string): Promise<PRDetectionResult>;
    /**
     * Strategy 1: Detect PR from direct PR events
     */
    private detectFromDirectPREvent;
    /**
     * Strategy 2: Detect PR from issue comment events
     */
    private detectFromIssueComment;
    /**
     * Strategy 3: Detect PR from push events by querying associated PRs
     */
    private detectFromPushEvent;
    /**
     * Strategy 4: Detect PR by searching current branch
     */
    private detectFromBranch;
    /**
     * Strategy 5: Detect PR by searching for commits
     */
    private detectFromCommit;
    /**
     * Search for PRs containing a specific commit
     */
    private searchPRsByCommit;
    /**
     * Get PR detection summary for debugging
     */
    getDetectionStrategies(): string[];
}
