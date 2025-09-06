import { PRInfo } from './pr-analyzer';
export interface GitFileChange {
    filename: string;
    status: 'added' | 'removed' | 'modified' | 'renamed';
    additions: number;
    deletions: number;
    changes: number;
    content?: string;
    patch?: string;
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
    constructor(workingDirectory?: string);
    /**
     * Analyze the current git repository state and return data compatible with PRInfo interface
     */
    analyzeRepository(): Promise<GitRepositoryInfo>;
    /**
     * Convert GitRepositoryInfo to PRInfo format for compatibility with existing PRReviewer
     */
    toPRInfo(repositoryInfo: GitRepositoryInfo): PRInfo;
    private isGitRepository;
    private getCurrentBranch;
    private getBaseBranch;
    private getRemoteInfo;
    private getUncommittedChanges;
    private analyzeFileChange;
    private generateTitle;
    private generateDescription;
    private createEmptyRepositoryInfo;
}
//# sourceMappingURL=git-repository-analyzer.d.ts.map