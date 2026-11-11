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
    /** Which change set `files` holds: the working tree vs HEAD, or the branch vs its base. */
    diffSource?: 'uncommitted' | 'branch';
}
/**
 * How a local (CLI) run picks the change set to review.
 * - `auto`: review tracked uncommitted changes when there are any (untracked files
 *   ride along when `includeUntracked`, but never decide the mode); on a feature
 *   branch with no tracked uncommitted changes, fall back to the branch diff when
 *   branch diff is enabled (e.g. auto-enabled for code-review schemas).
 * - `branch`: explicit `--analyze-branch-diff` — on a feature branch, always review
 *   the diff vs the base branch, even when there are uncommitted changes.
 * - `uncommitted`: explicit `--uncommitted` — always review only the uncommitted
 *   changes (staged, unstaged and untracked), on any branch.
 */
export type LocalDiffMode = 'auto' | 'branch' | 'uncommitted';
export interface AnalyzeRepositoryOptions {
    baseBranch?: string;
    /**
     * Defaults to 'branch' when `enableBranchDiff` is true (the historical "force the
     * branch diff" meaning of that argument) and 'auto' otherwise.
     */
    diffMode?: LocalDiffMode;
    /**
     * Review untracked files alongside tracked uncommitted edits (always on for
     * 'uncommitted'). Off by default so SDK/bot/scheduler callers keep their file set.
     */
    includeUntracked?: boolean;
    /** This run's --output-file; never reviewed as a change. */
    outputFile?: string;
}
/**
 * Map CLI flags to the analyzer's inputs. `--analyze-branch-diff` is the only thing that
 * forces the branch diff over uncommitted changes; a code-review schema merely enables it
 * as the clean-tree fallback; `--uncommitted` always reviews only the working tree.
 */
export declare function resolveLocalDiffSelection(opts: {
    analyzeBranchDiff?: boolean;
    uncommitted?: boolean;
    hasCodeReviewSchema: boolean;
    debugServer?: boolean;
}): {
    enableBranchDiff: boolean;
    diffMode: LocalDiffMode;
};
export interface PrContextOverrides {
    prTitle?: string;
    prBody?: string;
    prBodyFile?: string;
}
/**
 * Apply user-supplied PR title/description (CLI `--pr-title`, `--pr-body`,
 * `--pr-body-file`) on top of the generated local-analysis values, so a local
 * run sees the same `pr.title` / `pr.description` a GitHub-mode run would.
 */
export declare function applyPrContextOverrides(info: GitRepositoryInfo, overrides: PrContextOverrides): GitRepositoryInfo;
export declare class GitRepositoryAnalyzer {
    private git;
    private cwd;
    private fileExclusionHelper;
    constructor(workingDirectory?: string);
    /**
     * Analyze the current git repository state and return data compatible with PRInfo interface
     */
    analyzeRepository(includeContext?: boolean, enableBranchDiff?: boolean, options?: AnalyzeRepositoryOptions): Promise<GitRepositoryInfo>;
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
    /**
     * Paths Visor itself writes into the working directory before (or while) it analyzes
     * it: its state dir `.visor/` (config snapshot DB + WAL, schedules, tasks, worktrees,
     * snapshots), run traces (VISOR_TRACE_DIR, default `output/traces`), the fallback trace
     * file, and this run's `--output-file`. They are never review input, whether or not the
     * user's .gitignore covers them.
     */
    private visorOwnedMatcher;
    /**
     * Why an untracked file must not be read into a review (or count as uncommitted work),
     * or null when it may. Untracked files have never been looked at by git, so on top of
     * .gitignore + FileExclusionHelper they also skip dependency/build dirs, a root
     * `output/` dir (`--output-file` targets), secret-looking names, binaries and big files.
     */
    private untrackedSkipReason;
    /**
     * List the working-tree changes, split into tracked (staged/unstaged edits, deletes,
     * renames, staged new files) and untracked files. Visor-owned paths are dropped from
     * both; untracked files are additionally screened by untrackedSkipReason().
     */
    private listWorkingTreeChanges;
    private analyzeWorkingTreeEntries;
    private hasHeadCommit;
    /**
     * The uncommitted delta of one tracked path: `git diff HEAD` (staged + unstaged), with
     * rename detection across the old and new path. Works for paths that no longer exist.
     */
    private analyzeTrackedChangeVsHead;
    /**
     * Get diff between current branch and base branch (for feature branch analysis)
     */
    /**
     * Resolve the base branch ref to a revision that exists locally.
     * In CI (shallow clones), the local branch may not exist, so we try:
     *   1. The branch name as-is (e.g. "main")
     *   2. The remote-tracking ref (e.g. "origin/main")
     *   3. Fetch from origin then retry
     */
    private resolveBaseBranchRef;
    private getBranchDiff;
    private analyzeFileChange;
    /** Title from the change set actually reviewed (not raw `git status`). */
    private generateTitle;
    private generateDescription;
    private createEmptyRepositoryInfo;
}
