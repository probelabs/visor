import { ReviewIssue } from './reviewer';
/**
 * Filter for suppressing Visor issues based on special comments in code
 */
export declare class IssueFilter {
    private fileCache;
    private suppressionEnabled;
    constructor(suppressionEnabled?: boolean);
    /**
     * Filter out issues that have suppression comments
     * @param issues Array of issues to filter
     * @param workingDir Working directory for resolving file paths
     * @returns Filtered array of issues with suppressed ones removed
     */
    filterIssues(issues: ReviewIssue[], workingDir?: string): ReviewIssue[];
    /**
     * Check if an issue should be suppressed based on comments in the file
     */
    private shouldSuppressIssue;
    /**
     * Get file lines from cache or read from disk
     */
    private getFileLines;
    /**
     * Clear the file cache (useful for testing or long-running processes)
     */
    clearCache(): void;
}
