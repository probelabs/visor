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
     * Generate a worktree ID based on repository, ref, and session.
     *
     * When a sessionId is provided, the ID is scoped to that session so each
     * agent run gets its own isolated worktree. Steps within the same session
     * that checkout the same repo+ref will reuse the worktree (efficient).
     *
     * Without sessionId, falls back to deterministic repo+ref hashing
     * (legacy behavior).
     */
    private generateWorktreeId;
    /**
     * Generate an ID while preserving the historical identity when no explicit
     * working directory was requested.  A rendered directory is part of the
     * worktree identity because two components can legitimately use the same
     * repository/ref/session but must never reuse each other's checkout.
     */
    private generateWorktreeIdForDirectory;
    /**
     * Get or create bare repository
     */
    getOrCreateBareRepo(repository: string, repoUrl: string, _token?: string, fetchDepth?: number, cloneTimeoutMs?: number): Promise<string>;
    /**
     * Update bare repository refs.
     *
     * Retries once on failure to handle transient network issues.
     * If the bare repo is shallow, unshallow it first so that branch-tip
     * fetches always succeed.
     */
    private updateBareRepo;
    /**
     * Consolidate pack files after fetch to prevent unbounded pack accumulation.
     * Each `git fetch` creates a new pack file; without periodic repacking these
     * pile up and waste disk (especially on COW filesystems like BTRFS).
     */
    private gcBareRepo;
    /**
     * Verify that a bare repository has the correct remote URL.
     * This prevents reusing corrupted repos that were cloned from a different repository.
     * Returns: true (valid), false (invalid - should re-clone), or 'timeout' (use stale cache)
     */
    private verifyBareRepoRemote;
    /**
     * Ensure the origin remote URL of a bare repo is a plain URL (no embedded token).
     *
     * Older bare repos may have been cloned with a token in the URL
     * (https://x-access-token:TOKEN@github.com/...). This causes stale-token
     * failures because GIT_CONFIG insteadOf rules can't rewrite URLs that
     * already have credentials. Resetting to the plain URL lets insteadOf
     * handle auth with the freshest token.
     */
    private resetBareRepoRemoteUrl;
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
        sessionId?: string;
        fetchDepth?: number;
        cloneTimeoutMs?: number;
        persistWorktree?: boolean;
    }): Promise<WorktreeInfo>;
    /**
     * Prune stale worktree entries from a bare repository.
     * This removes entries for worktrees whose directories no longer exist.
     */
    private pruneWorktrees;
    /**
     * Fetch a specific ref in bare repository.
     *
     * Uses --force to overwrite local refs that may have diverged (e.g. after
     * a force-push on main). Retries once on failure.
     */
    private fetchRef;
    /**
     * Clean worktree (reset and remove untracked files).
     *
     * When `expectedCommit` is provided the worktree is first forced back to a
     * detached HEAD at that commit.  This is essential because AI agents or user
     * commands may have created local branches inside the worktree, switching
     * HEAD away from the detached state.  A plain `reset --hard HEAD` would
     * then reset to the *wrong* commit.  After resetting, any local branches
     * that were created inside the worktree are deleted so they cannot leak
     * into future runs or PRs.
     */
    private cleanWorktree;
    /**
     * Delete local branches in a worktree that are safe to remove.
     * Worktrees are always used in detached HEAD state, so any local branches
     * were unintentionally created and should be cleaned up.
     * IMPORTANT: Git worktrees share the branch namespace with the main repo
     * and all other worktrees. We must NOT delete branches that are checked out
     * in the main working tree or any other worktree — doing so would destroy
     * the user's work.
     */
    private deleteLocalBranches;
    /**
     * Get commit SHA for a given ref inside a bare repository.
     *
     * This runs after fetchRef so that <ref> should resolve to either a
     * local branch, tag, or remote-tracking ref.
     *
     * If the ref is "main" or "master" and doesn't exist, automatically
     * falls back to the other common default branch name.
     */
    private getCommitShaForRef;
    /**
     * Remove a worktree
     */
    removeWorktree(worktreeId: string): Promise<void>;
    /**
     * Get the metadata file path for a worktree.
     * Stored as a sibling file OUTSIDE the worktree to avoid being committed
     * when agents run `git add .` inside the checked-out repo.
     */
    private getMetadataPath;
    /**
     * Resolve the deterministic managed bare-repository cache path.
     * Remote repository identities retain their historical names. Local paths
     * use a bounded basename plus a hash of the canonical path so long paths
     * and same-basename repositories cannot collide or exceed NAME_MAX.
     */
    private getBareRepoPath;
    /**
     * Reject an explicit existing target unless its manager metadata proves
     * exact ownership. The caller's directory and bytes remain untouched on
     * every rejection path.
     */
    private assertExplicitWorktreeOwnership;
    /**
     * Metadata fields are not sufficient proof of ownership: a caller could
     * place a forged metadata file beside an unrelated checkout. Verify Git's
     * common directory before any refresh, reset, or cleanup operation.
     */
    private assertExplicitWorktreeGitOwnership;
    /**
     * Resolve an explicit destination without following an untrusted target
     * into a different tree. Existing targets use their real path; new targets
     * canonicalize only the already-existing parent and retain the final name.
     */
    private canonicalizeWorktreeDestination;
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
    private static _stableEnv;
    /**
     * Return the process's initial environment from /proc/self/environ,
     * plus dynamic vars set after startup (GitHub auth, GIT_CONFIG).
     */
    private static getStableEnv;
    /**
     * Build authenticated URL with token
     */
    private buildAuthenticatedUrl;
    /**
     * Get repository URL from repository identifier
     */
    getRepositoryUrl(repository: string, _token?: string): string;
    /**
     * Resolve an absolute path or file:// URL to a real Git repository root.
     * Returns undefined for ordinary owner/repository and network URLs so the
     * existing remote checkout behavior remains unchanged.
     */
    private tryCanonicalizeLocalRepository;
}
export declare const worktreeManager: WorktreeManager;
//# sourceMappingURL=worktree-manager.d.ts.map