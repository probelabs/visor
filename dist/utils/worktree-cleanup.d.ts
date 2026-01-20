/**
 * Worktree Cleanup Utilities
 *
 * Provides utilities for cleaning up worktrees at various lifecycle points.
 */
/**
 * Cleanup worktrees for a specific workflow
 */
export declare function cleanupWorkflowWorktrees(workflowId: string): Promise<void>;
/**
 * Cleanup all worktrees for the current process
 */
export declare function cleanupCurrentProcessWorktrees(): Promise<void>;
/**
 * Cleanup all stale worktrees (older than configured max age)
 */
export declare function cleanupStaleWorktrees(): Promise<void>;
/**
 * Cleanup all worktrees (dangerous - use with caution)
 */
export declare function cleanupAllWorktrees(): Promise<void>;
/**
 * List all worktrees with details
 */
export declare function listWorktreesInfo(): Promise<void>;
/**
 * Initialize cleanup handlers
 *
 * This should be called early in the application lifecycle to ensure
 * cleanup happens on process exit.
 */
export declare function initializeCleanupHandlers(): void;
//# sourceMappingURL=worktree-cleanup.d.ts.map