import { PRInfo } from './pr-analyzer';
export interface GitFileChange {
    filename: string;
    status: 'added' | 'removed' | 'modified' | 'renamed';
    additions: number;
    deletions: number;
    changes: number;
    content?: string;
    patch?: string;
    truncated?: boolean;
}
export interface GitRepositoryInfo {
    title: string;
    body: string;
    author: string;
    base: string;
    head: string;
    files: GitFileChange[];
    totalAdditions: number;
    totalDeletions: number;
    isGitRepository: boolean;
    workingDirectory: string;
}
export declare class GitRepositoryAnalyzer {
    private git;
    private cwd;
    private fileExclusionHelper;
    constructor(workingDirectory?: string);
    /**
     * Analyze the current git repository state and return data compatible with PRInfo interface
     */
    analyzeRepository(includeContext?: boolean, enableBranchDiff?: boolean): Promise<GitRepositoryInfo>;
    /**
     * Convert GitRepositoryInfo to PRInfo format for compatibility with existing PRReviewer
     */
    toPRInfo(repositoryInfo: GitRepositoryInfo, includeContext?: boolean): PRInfo;
    private isGitRepository;
    private getCurrentBranch;
    private getBaseBranch;
    /**
     * Truncate a patch if it exceeds MAX_PATCH_SIZE
     */
    private truncatePatch;
    private getRemoteInfo;
    private getUncommittedChanges;
    /**
     * Get diff between current branch and base branch (for feature branch analysis)
     */
    private getBranchDiff;
    private analyzeFileChange;
    private generateTitle;
    private generateDescription;
    private createEmptyRepositoryInfo;
}
