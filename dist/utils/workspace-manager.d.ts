/**
 * Workspace Manager
 *
 * Provides full isolation between parallel visor runs with human-readable project names.
 * Each run gets its own workspace in /tmp containing worktrees for all projects.
 */
export interface WorkspaceConfig {
    enabled: boolean;
    basePath: string;
    cleanupOnExit: boolean;
}
export interface WorkspaceInfo {
    sessionId: string;
    workspacePath: string;
    mainProjectPath: string;
    mainProjectName: string;
    originalPath: string;
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
     */
    addProject(repository: string, worktreePath: string, description?: string): Promise<string>;
    /**
     * List all projects in the workspace
     */
    listProjects(): ProjectInfo[];
    /**
     * Cleanup the workspace
     */
    cleanup(): Promise<void>;
    /**
     * Create worktree for the main project
     *
     * visor-disable: architecture - Not using WorktreeManager here because:
     * 1. WorktreeManager expects remote URLs and clones to bare repos first
     * 2. This operates on the LOCAL repo we're already in (no cloning needed)
     * 3. Adding a "local mode" to WorktreeManager would add complexity for minimal benefit
     * The git commands here are simpler (just rev-parse + worktree add) vs WorktreeManager's
     * full clone/bare-repo/fetch/worktree pipeline.
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