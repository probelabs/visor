/**
 * Workspace Manager
 *
 * Provides full isolation between parallel visor runs with human-readable project names.
 * Each run gets its own workspace in /tmp containing worktrees for all projects.
 */
/**
 * Whether Visor may delete branches when it refreshes a reused workspace.
 *  - 'never'      : no branch is ever deleted (local CLI / library use on a developer checkout).
 *  - 'owned-only' : delete only branches created inside Visor's own worktree
 *                   (automation: GitHub Action, Slack/Telegram/MCP/... runners, scheduler daemon).
 */
export type WorkspaceBranchCleanupPolicy = 'never' | 'owned-only';
/**
 * Set the process-wide branch cleanup policy. Automation entry points opt in to
 * 'owned-only'; the local CLI sets 'never'. The default is 'never'.
 */
export declare function setWorkspaceBranchCleanupPolicy(policy: WorkspaceBranchCleanupPolicy, reason: string): void;
export declare function getWorkspaceBranchCleanupPolicy(): {
    policy: WorkspaceBranchCleanupPolicy;
    reason: string;
};
export interface WorkspaceConfig {
    enabled: boolean;
    basePath: string;
    cleanupOnExit: boolean;
    name?: string;
    mainProjectName?: string;
    /** Per-instance override of the process-wide branch cleanup policy. */
    branchCleanup?: WorkspaceBranchCleanupPolicy;
}
export interface WorkspaceInfo {
    sessionId: string;
    workspacePath: string;
    mainProjectPath: string;
    mainProjectName: string;
    originalPath: string;
    /** The git worktree root (before subdirectory offset). Used for cleanup. */
    worktreeRootPath?: string;
}
export interface ProjectInfo {
    name: string;
    path: string;
    worktreePath: string;
    repository: string;
}
/**
 * WorkspaceManager creates isolated workspaces for parallel visor runs.
 * Each run gets a unique workspace directory containing worktrees for all projects.
 */
export declare class WorkspaceManager {
    private static instances;
    private sessionId;
    private basePath;
    private workspacePath;
    private originalPath;
    private config;
    private initialized;
    private mainProjectInfo;
    private projects;
    private cleanupHandlersRegistered;
    private usedNames;
    private activeOperations;
    private cleanupRequested;
    private cleanupResolvers;
    private constructor();
    /**
     * Get or create a WorkspaceManager instance for a session
     */
    static getInstance(sessionId: string, originalPath: string, config?: Partial<WorkspaceConfig>): WorkspaceManager;
    /**
     * Clear all instances (for testing)
     */
    static clearInstances(): void;
    /**
     * Check if workspace isolation is enabled
     */
    isEnabled(): boolean;
    /**
     * Acquire a reference to the workspace (prevents cleanup while held)
     * Call release() when done with the operation.
     */
    acquire(): void;
    /**
     * Release a reference to the workspace.
     * If cleanup was requested and this was the last reference, cleanup will proceed.
     */
    release(): void;
    /**
     * Get the number of active operations
     */
    getActiveOperations(): number;
    /**
     * Get the workspace path
     */
    getWorkspacePath(): string;
    /**
     * Get the original working directory
     */
    getOriginalPath(): string;
    /**
     * Get workspace info (only available after initialize)
     */
    getWorkspaceInfo(): WorkspaceInfo | null;
    /**
     * Initialize the workspace - creates workspace directory and main project worktree
     */
    initialize(): Promise<WorkspaceInfo>;
    /**
     * Add a project to the workspace (creates symlink to worktree)
     * If the same repository already exists, updates the symlink to the new worktree path.
     */
    addProject(repository: string, worktreePath: string, description?: string): Promise<string>;
    /**
     * List all projects in the workspace
     */
    listProjects(): ProjectInfo[];
    /**
     * Cleanup the workspace.
     * If there are active operations, waits for them to complete before cleaning up.
     * @param timeout Maximum time to wait for active operations (default: 60s)
     */
    cleanup(timeout?: number): Promise<void>;
    /**
     * Check if a path exists (file or directory).
     */
    private pathExists;
    /**
     * Rehydrate existing symlinked projects in a persisted workspace so future
     * runs update them in place instead of allocating project-2, project-3, etc.
     */
    private loadExistingProjects;
    /**
     * Clean up stale workspace directories older than maxAge.
     * Call periodically (e.g. at socket-runner startup) to prevent disk bloat.
     */
    static cleanupStale(basePath?: string, maxAgeMs?: number): Promise<number>;
    /**
     * visor-disable: architecture - The helpers below (resolveUpstreamRef,
     * fetchAndResolveUpstream, resetAndCleanWorktree, refreshWorktreeToUpstream)
     * are NOT duplicates of WorktreeManager's fetchRef/getCommitShaForRef/cleanWorktree.
     * WorktreeManager operates on BARE repo caches cloned from remote URLs, while
     * WorkspaceManager operates on the LOCAL working repo the user already has checked out.
     * The git commands differ (e.g. `fetch origin --prune` vs `fetch origin <ref>:<ref>`)
     * and sharing code would require adding a "local mode" to WorktreeManager for no benefit.
     */
    /**
     * Resolve the upstream default branch ref.
     * Tries origin/HEAD (symbolic), then origin/main, then origin/master.
     * Falls back to local HEAD if no remote is configured.
     */
    private resolveUpstreamRef;
    /**
     * Fetch latest from origin, resolve the upstream default branch, and return
     * both the ref name and the resolved commit SHA.
     */
    private fetchAndResolveUpstream;
    /** Effective branch cleanup policy (instance override > process-wide policy). */
    private getBranchCleanupPolicy;
    /**
     * Remove stale worktree entries that VISOR created (their path is under the
     * workspace base path and no longer exists). Unlike a repo-wide
     * `git worktree prune`, this never touches the user's own worktrees (e.g. on
     * an unmounted drive).
     */
    private pruneOwnStaleWorktrees;
    /**
     * Reset a worktree to a specific commit and clean all modifications.
     *
     * NOTE: this deliberately does NOT touch branches. A linked worktree shares
     * `refs/heads/*` with the user's repository, so a blanket "delete local
     * branches" here deletes the user's real branches (see
     * deleteBranchesCreatedInWorktree for the narrowly-scoped cleanup).
     */
    private resetAndCleanWorktree;
    /**
     * Absolute path of the git admin dir private to a LINKED worktree
     * (`<repo>/.git/worktrees/<name>`). Files stored there are invisible to the
     * work tree (survive `clean -fdx`) and are removed by `git worktree remove`.
     * Returns null for anything that is not a linked worktree, so we never write
     * into a user's main `.git` directory.
     */
    private getLinkedWorktreeGitDir;
    /** All local branch names (shared namespace of the repo and all its worktrees). */
    private listLocalBranches;
    /**
     * Snapshot the branches that exist right now, so a later cleanup can tell
     * branches created inside Visor's worktree apart from the user's own branches.
     */
    private recordBranchBaseline;
    private readBranchBaseline;
    /** Branch currently checked out in the worktree, or null when HEAD is detached. */
    private getCheckedOutBranch;
    /**
     * Branch names that were checked out IN THIS WORKTREE since `sinceEpoch`,
     * read from the worktree's private HEAD reflog (`git checkout -b`/`switch -c`
     * inside Visor's worktree is recorded there, never in the user's own HEAD log).
     */
    private branchesCheckedOutInWorktreeSince;
    /**
     * Delete ONLY branches an AI agent / command created inside Visor's worktree.
     *
     * Git worktrees share the branch namespace with the user's repository, so a
     * branch is deleted only if ALL of the following hold:
     *  1. it did not exist when Visor recorded the baseline (worktree creation or
     *     the previous refresh) — so pre-existing user branches are never touched;
     *  2. it was checked out inside THIS worktree (its private HEAD reflog, or
     *     the branch HEAD pointed at before we re-detached it);
     *  3. it is not currently checked out in any worktree (including the main one).
     * Without a baseline (e.g. a worktree created by an older Visor) nothing is
     * deleted. Branches an agent created without checking them out are left
     * alone: they are inert refs, unlike a deleted user branch.
     */
    private deleteBranchesCreatedInWorktree;
    /**
     * Refresh an existing worktree to the latest upstream default branch
     * and ensure it has no modified or untracked files.
     */
    private refreshWorktreeToUpstream;
    /**
     * Create worktree for the main project.
     * See visor-disable comment above resolveUpstreamRef for why this doesn't use WorktreeManager.
     */
    private createMainProjectWorktree;
    /**
     * Remove main project worktree
     */
    private removeMainProjectWorktree;
    /**
     * Check if a path is a git repository
     */
    private isGitRepository;
    /**
     * Extract project name from path
     */
    private extractProjectName;
    /**
     * Extract repository name from owner/repo format
     */
    private extractRepoName;
    /**
     * Get a unique name by appending a number if needed
     */
    private getUniqueName;
    /**
     * Register cleanup handlers for process exit
     */
    private registerCleanupHandlers;
}
//# sourceMappingURL=workspace-manager.d.ts.map