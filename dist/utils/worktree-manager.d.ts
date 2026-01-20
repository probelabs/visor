/**
 * Git Worktree Manager
 *
 * Manages git worktrees for efficient multi-workflow execution.
 * Uses a bare repository cache to share git objects between worktrees.
 */
import type { WorktreeCacheConfig, WorktreeInfo } from '../types/git-checkout';
export declare class WorktreeManager {
    private static instance;
    private config;
    private activeWorktrees;
    private cleanupHandlersRegistered;
    private constructor();
    static getInstance(): WorktreeManager;
    /**
     * Update configuration
     */
    configure(config: Partial<WorktreeCacheConfig>): void;
    getConfig(): WorktreeCacheConfig;
    /**
     * Ensure base directories exist
     */
    private ensureDirectories;
    private getReposDir;
    private getWorktreesDir;
    /**
     * Generate a unique worktree ID
     */
    private generateWorktreeId;
    /**
     * Get or create bare repository
     */
    getOrCreateBareRepo(repository: string, repoUrl: string, token?: string, fetchDepth?: number, cloneTimeoutMs?: number): Promise<string>;
    /**
     * Update bare repository refs
     */
    private updateBareRepo;
    /**
     * Verify that a bare repository has the correct remote URL.
     * This prevents reusing corrupted repos that were cloned from a different repository.
     * Returns: true (valid), false (invalid - should re-clone), or 'timeout' (use stale cache)
     */
    private verifyBareRepoRemote;
    /**
     * Create a new worktree for the given repository/ref.
     *
     * Important: we always create worktrees in a detached HEAD state pinned
     * to a specific commit SHA rather than a named branch like "main". Git
     * only allows a branch to be checked out in a single worktree at a time;
     * using the raw commit (plus --detach) lets multiple workflows safely
     * create independent worktrees for the same branch without hitting
     * errors like:
     *
     *   fatal: 'main' is already used by worktree at '.../TykTechnologies-tyk-docs-main-XXXX'
     */
    createWorktree(repository: string, repoUrl: string, ref: string, options?: {
        token?: string;
        workingDirectory?: string;
        clean?: boolean;
        workflowId?: string;
        fetchDepth?: number;
        cloneTimeoutMs?: number;
    }): Promise<WorktreeInfo>;
    /**
     * Fetch a specific ref in bare repository
     */
    private fetchRef;
    /**
     * Clean worktree (reset and remove untracked files)
     */
    private cleanWorktree;
    /**
     * Get commit SHA for a given ref inside a bare repository.
     *
     * This runs after fetchRef so that <ref> should resolve to either a
     * local branch, tag, or remote-tracking ref.
     */
    private getCommitShaForRef;
    /**
     * Remove a worktree
     */
    removeWorktree(worktreeId: string): Promise<void>;
    /**
     * Save worktree metadata
     */
    private saveMetadata;
    /**
     * Load worktree metadata
     */
    private loadMetadata;
    /**
     * List all worktrees
     */
    listWorktrees(): Promise<WorktreeInfo[]>;
    /**
     * Cleanup stale worktrees
     */
    cleanupStaleWorktrees(): Promise<void>;
    /**
     * Cleanup all worktrees for current process
     */
    cleanupProcessWorktrees(): Promise<void>;
    /**
     * Check if a process is alive
     */
    private isProcessAlive;
    /**
     * Register cleanup handlers
     */
    private registerCleanupHandlers;
    /**
     * Escape shell argument to prevent command injection
     *
     * Uses POSIX-standard single-quote escaping which prevents ALL shell metacharacter
     * interpretation (including $, `, \, ", ;, &, |, etc.)
     *
     * How it works:
     * - Everything is wrapped in single quotes: 'arg'
     * - Single quotes within are escaped as: ' → '\''
     *   (close quote, literal escaped quote, open quote)
     *
     * This is safer than double quotes which still allow $expansion and `backticks`
     *
     * Example: "foo'bar" → 'foo'\''bar'
     */
    private escapeShellArg;
    /**
     * Validate git ref to prevent command injection
     */
    private validateRef;
    /**
     * Validate path to prevent directory traversal
     */
    private validatePath;
    /**
     * Redact sensitive tokens from URLs for logging
     */
    private redactUrl;
    /**
     * Execute a git command
     */
    private executeGitCommand;
    /**
     * Build authenticated URL with token
     */
    private buildAuthenticatedUrl;
    /**
     * Get repository URL from repository identifier
     */
    getRepositoryUrl(repository: string, _token?: string): string;
}
export declare const worktreeManager: WorktreeManager;
//# sourceMappingURL=worktree-manager.d.ts.map