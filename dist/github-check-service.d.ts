/**
 * GitHub Check Service for creating and managing check runs based on failure conditions
 */
import { Octokit } from '@octokit/rest';
import { FailureConditionResult } from './types/config';
import { ReviewIssue } from './reviewer';
export interface CheckRunOptions {
    owner: string;
    repo: string;
    head_sha: string;
    name: string;
    details_url?: string;
    external_id?: string;
    engine_mode?: 'legacy' | 'state-machine';
}
export interface CheckRunAnnotation {
    path: string;
    start_line: number;
    end_line: number;
    annotation_level: 'notice' | 'warning' | 'failure';
    message: string;
    title?: string;
    raw_details?: string;
}
export interface CheckRunSummary {
    title: string;
    summary: string;
    text?: string;
}
export type CheckRunStatus = 'queued' | 'in_progress' | 'completed';
export type CheckRunConclusion = 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'action_required';
/**
 * Service for managing GitHub Check Runs based on Visor failure conditions
 */
export declare class GitHubCheckService {
    private octokit;
    private maxAnnotations;
    constructor(octokit: Octokit);
    /**
     * Create a new check run in queued status
     * M4: Includes engine_mode metadata in summary
     */
    createCheckRun(options: CheckRunOptions, summary?: CheckRunSummary): Promise<{
        id: number;
        url: string;
    }>;
    /**
     * Update check run to in_progress status
     */
    updateCheckRunInProgress(owner: string, repo: string, check_run_id: number, summary?: CheckRunSummary): Promise<void>;
    /**
     * Complete a check run with results based on failure conditions
     */
    completeCheckRun(owner: string, repo: string, check_run_id: number, checkName: string, failureResults: FailureConditionResult[], reviewIssues?: ReviewIssue[], executionError?: string, filesChangedInCommit?: string[], prNumber?: number, currentCommitSha?: string): Promise<void>;
    /**
     * Determine check run conclusion based on failure conditions and issues
     */
    private determineCheckRunConclusion;
    /**
     * Format detailed check results for the check run summary
     */
    private formatCheckDetails;
    /**
     * Convert review issues to GitHub check run annotations
     */
    private convertIssuesToAnnotations;
    /**
     * Map Visor issue severity to GitHub annotation level
     */
    private mapSeverityToAnnotationLevel;
    /**
     * Group issues by category
     */
    private groupIssuesByCategory;
    /**
     * Get emoji for issue severity (allowed; step/category emojis are removed)
     */
    private getSeverityEmoji;
    /**
     * Create multiple check runs for different checks with failure condition support
     */
    createMultipleCheckRuns(options: CheckRunOptions, checkResults: Array<{
        checkName: string;
        failureResults: FailureConditionResult[];
        reviewIssues: ReviewIssue[];
        executionError?: string;
    }>): Promise<Array<{
        checkName: string;
        id: number;
        url: string;
    }>>;
    /**
     * Get check runs for a specific commit
     */
    getCheckRuns(owner: string, repo: string, ref: string): Promise<Array<{
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
    }>>;
    /**
     * Get check runs for a specific commit SHA
     * Returns all check runs with the given name on this commit
     */
    getCheckRunsForCommit(owner: string, repo: string, commitSha: string, checkName: string): Promise<Array<{
        id: number;
        head_sha: string;
    }>>;
    /**
     * Clear annotations from old check runs on the current commit
     * This prevents annotation accumulation when a check runs multiple times on the same commit
     * (e.g., force push, re-running checks)
     */
    clearOldAnnotations(owner: string, repo: string, prNumber: number, // Not used, kept for backward compatibility
    checkName: string, currentCommitSha: string, currentCheckRunId: number): Promise<void>;
}
