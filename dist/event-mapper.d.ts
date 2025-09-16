import { VisorConfig, EventTrigger } from './types/config';
export interface GitHubEventContext {
    event_name: string;
    action?: string;
    repository?: {
        owner: {
            login: string;
        };
        name: string;
    };
    pull_request?: {
        number: number;
        state: string;
        head: {
            sha: string;
            ref: string;
        };
        base: {
            sha: string;
            ref: string;
        };
        draft: boolean;
    };
    issue?: {
        number: number;
        title?: string;
        body?: string;
        state?: string;
        user?: {
            login: string;
        };
        labels?: Array<{
            name: string;
            color: string;
        }>;
        assignees?: Array<{
            login: string;
        }>;
        created_at?: string;
        updated_at?: string;
        pull_request?: Record<string, unknown>;
    };
    comment?: {
        body: string;
        user: {
            login: string;
        };
    };
}
export interface MappedExecution {
    shouldExecute: boolean;
    checksToRun: string[];
    executionContext: {
        eventType: EventTrigger;
        prNumber?: number;
        repository: string;
        triggeredBy: string;
    };
}
export interface FileChangeContext {
    changedFiles?: string[];
    addedFiles?: string[];
    modifiedFiles?: string[];
    deletedFiles?: string[];
}
/**
 * Maps GitHub events to Visor check executions based on configuration
 */
export declare class EventMapper {
    private config;
    constructor(config: VisorConfig);
    /**
     * Map GitHub event to execution plan
     */
    mapEventToExecution(eventContext: GitHubEventContext, fileContext?: FileChangeContext): MappedExecution;
    /**
     * Map GitHub event to Visor event trigger
     */
    private mapGitHubEventToTrigger;
    /**
     * Get checks that should run for a specific event
     */
    private getChecksForEvent;
    /**
     * Determine if a specific check should run
     */
    private shouldRunCheck;
    /**
     * Check if file changes match trigger patterns
     */
    private matchesFilePatterns;
    /**
     * Convert glob pattern to RegExp
     */
    private convertGlobToRegex;
    /**
     * Extract PR number from event context
     */
    private extractPRNumber;
    /**
     * Get repository name from event context
     */
    private getRepositoryName;
    /**
     * Get triggered by information
     */
    private getTriggeredBy;
    /**
     * Get selective execution plan for specific checks
     */
    getSelectiveExecution(eventContext: GitHubEventContext, requestedChecks: string[], fileContext?: FileChangeContext): MappedExecution;
    /**
     * Check if event should trigger any executions
     */
    shouldProcessEvent(eventContext: GitHubEventContext): boolean;
    /**
     * Get available checks for display purposes
     */
    getAvailableChecks(): Array<{
        name: string;
        description: string;
        triggers: EventTrigger[];
    }>;
    /**
     * Validate event context
     */
    validateEventContext(eventContext: GitHubEventContext): {
        isValid: boolean;
        errors: string[];
    };
}
/**
 * Utility function to create EventMapper from config
 */
export declare function createEventMapper(config: VisorConfig): EventMapper;
/**
 * Utility function to extract file context from GitHub PR
 */
export declare function extractFileContext(octokit: import('@octokit/rest').Octokit, owner: string, repo: string, prNumber: number): Promise<FileChangeContext>;
//# sourceMappingURL=event-mapper.d.ts.map