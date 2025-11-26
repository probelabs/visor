/**
 * Workspace Manager
 *
 * Provides full isolation between parallel visor runs with human-readable project names.
 * Each run gets its own workspace in /tmp containing worktrees for all projects.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { commandExecutor } from './command-executor';
import { logger } from '../logger';

/**
 * Escape a string for safe use in shell commands.
 * Uses single quotes and escapes any embedded single quotes.
 */
function shellEscape(str: string): string {
  // Replace single quotes with '\'' (end quote, escaped quote, start quote)
  // Then wrap the whole thing in single quotes
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

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
export class WorkspaceManager {
  private static instances: Map<string, WorkspaceManager> = new Map();

  private sessionId: string;
  private basePath: string;
  private workspacePath: string;
  private originalPath: string;
  private config: WorkspaceConfig;
  private initialized: boolean = false;
  private mainProjectInfo: WorkspaceInfo | null = null;
  private projects: Map<string, ProjectInfo> = new Map();
  private cleanupHandlersRegistered: boolean = false;
  private usedNames: Set<string> = new Set();

  private constructor(sessionId: string, originalPath: string, config?: Partial<WorkspaceConfig>) {
    this.sessionId = sessionId;
    this.originalPath = originalPath;

    // Default configuration
    this.config = {
      enabled: true,
      basePath: process.env.VISOR_WORKSPACE_PATH || '/tmp/visor-workspaces',
      cleanupOnExit: true,
      ...config,
    };

    this.basePath = this.config.basePath;
    this.workspacePath = path.join(this.basePath, this.sessionId);
  }

  /**
   * Get or create a WorkspaceManager instance for a session
   */
  static getInstance(
    sessionId: string,
    originalPath: string,
    config?: Partial<WorkspaceConfig>
  ): WorkspaceManager {
    if (!WorkspaceManager.instances.has(sessionId)) {
      WorkspaceManager.instances.set(
        sessionId,
        new WorkspaceManager(sessionId, originalPath, config)
      );
    }
    return WorkspaceManager.instances.get(sessionId)!;
  }

  /**
   * Clear all instances (for testing)
   */
  static clearInstances(): void {
    WorkspaceManager.instances.clear();
  }

  /**
   * Check if workspace isolation is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get the workspace path
   */
  getWorkspacePath(): string {
    return this.workspacePath;
  }

  /**
   * Get the original working directory
   */
  getOriginalPath(): string {
    return this.originalPath;
  }

  /**
   * Get workspace info (only available after initialize)
   */
  getWorkspaceInfo(): WorkspaceInfo | null {
    return this.mainProjectInfo;
  }

  /**
   * Initialize the workspace - creates workspace directory and main project worktree
   */
  async initialize(): Promise<WorkspaceInfo> {
    if (!this.config.enabled) {
      throw new Error('Workspace isolation is not enabled');
    }

    if (this.initialized && this.mainProjectInfo) {
      return this.mainProjectInfo;
    }

    logger.info(`Initializing workspace: ${this.workspacePath}`);

    // Create workspace directory (mkdir with recursive handles existing dirs)
    await fsp.mkdir(this.workspacePath, { recursive: true });
    logger.debug(`Created workspace directory: ${this.workspacePath}`);

    // Extract main project name from original path
    const mainProjectName = this.extractProjectName(this.originalPath);
    this.usedNames.add(mainProjectName);

    // Create worktree for main project
    const mainProjectPath = path.join(this.workspacePath, mainProjectName);

    // Check if original path is a git repository
    const isGitRepo = await this.isGitRepository(this.originalPath);

    if (isGitRepo) {
      // Create worktree for main project
      await this.createMainProjectWorktree(mainProjectPath);
    } else {
      // If not a git repo, create a symlink instead
      logger.debug(`Original path is not a git repo, creating symlink`);
      try {
        await fsp.symlink(this.originalPath, mainProjectPath);
      } catch (error) {
        throw new Error(`Failed to create symlink for main project: ${error}`);
      }
    }

    // Register cleanup handlers
    this.registerCleanupHandlers();

    this.mainProjectInfo = {
      sessionId: this.sessionId,
      workspacePath: this.workspacePath,
      mainProjectPath,
      mainProjectName,
      originalPath: this.originalPath,
    };

    this.initialized = true;
    logger.info(`Workspace initialized: ${this.workspacePath}`);

    return this.mainProjectInfo;
  }

  /**
   * Add a project to the workspace (creates symlink to worktree)
   */
  async addProject(
    repository: string,
    worktreePath: string,
    description?: string
  ): Promise<string> {
    if (!this.initialized) {
      throw new Error('Workspace not initialized. Call initialize() first.');
    }

    // Extract project name
    let projectName = description || this.extractRepoName(repository);

    // Handle duplicate names
    projectName = this.getUniqueName(projectName);
    this.usedNames.add(projectName);

    // Create symlink in workspace
    const workspacePath = path.join(this.workspacePath, projectName);

    // Remove existing symlink/directory if present (rm with force handles non-existent)
    await fsp.rm(workspacePath, { recursive: true, force: true });

    try {
      await fsp.symlink(worktreePath, workspacePath);
    } catch (error) {
      throw new Error(`Failed to create symlink for project ${projectName}: ${error}`);
    }

    // Track project
    this.projects.set(projectName, {
      name: projectName,
      path: workspacePath,
      worktreePath,
      repository,
    });

    logger.info(`Added project to workspace: ${projectName} -> ${worktreePath}`);

    return workspacePath;
  }

  /**
   * List all projects in the workspace
   */
  listProjects(): ProjectInfo[] {
    return Array.from(this.projects.values());
  }

  /**
   * Cleanup the workspace
   */
  async cleanup(): Promise<void> {
    logger.info(`Cleaning up workspace: ${this.workspacePath}`);

    try {
      // Remove main project worktree if it exists
      if (this.mainProjectInfo) {
        const mainProjectPath = this.mainProjectInfo.mainProjectPath;

        // Check if path exists and if it's a worktree (not a symlink)
        try {
          const stats = await fsp.lstat(mainProjectPath);
          if (!stats.isSymbolicLink()) {
            await this.removeMainProjectWorktree(mainProjectPath);
          }
        } catch {
          // Path doesn't exist, nothing to clean up
        }
      }

      // Remove workspace directory
      await fsp.rm(this.workspacePath, { recursive: true, force: true });
      logger.debug(`Removed workspace directory: ${this.workspacePath}`);

      // Remove from instances
      WorkspaceManager.instances.delete(this.sessionId);

      this.initialized = false;
      this.mainProjectInfo = null;
      this.projects.clear();
      this.usedNames.clear();

      logger.info(`Workspace cleanup completed: ${this.sessionId}`);
    } catch (error) {
      logger.warn(`Failed to cleanup workspace: ${error}`);
    }
  }

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
  private async createMainProjectWorktree(targetPath: string): Promise<void> {
    logger.debug(`Creating main project worktree: ${targetPath}`);

    // Get current HEAD
    const headResult = await commandExecutor.execute(
      `git -C ${shellEscape(this.originalPath)} rev-parse HEAD`,
      {
        timeout: 10000,
      }
    );

    if (headResult.exitCode !== 0) {
      throw new Error(`Failed to get HEAD: ${headResult.stderr}`);
    }

    const headRef = headResult.stdout.trim();

    // Create worktree using detached HEAD to avoid branch conflicts
    const createCmd = `git -C ${shellEscape(this.originalPath)} worktree add --detach ${shellEscape(targetPath)} ${shellEscape(headRef)}`;
    const result = await commandExecutor.execute(createCmd, { timeout: 60000 });

    if (result.exitCode !== 0) {
      throw new Error(`Failed to create main project worktree: ${result.stderr}`);
    }

    logger.debug(`Created main project worktree at ${targetPath}`);
  }

  /**
   * Remove main project worktree
   */
  private async removeMainProjectWorktree(worktreePath: string): Promise<void> {
    logger.debug(`Removing main project worktree: ${worktreePath}`);

    const removeCmd = `git -C ${shellEscape(this.originalPath)} worktree remove ${shellEscape(worktreePath)} --force`;
    const result = await commandExecutor.execute(removeCmd, { timeout: 30000 });

    if (result.exitCode !== 0) {
      logger.warn(`Failed to remove worktree via git: ${result.stderr}`);
      // Directory will be removed with the workspace anyway
    }
  }

  /**
   * Check if a path is a git repository
   */
  private async isGitRepository(dirPath: string): Promise<boolean> {
    try {
      const result = await commandExecutor.execute(
        `git -C ${shellEscape(dirPath)} rev-parse --git-dir`,
        {
          timeout: 5000,
        }
      );
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  /**
   * Extract project name from path
   */
  private extractProjectName(dirPath: string): string {
    return path.basename(dirPath);
  }

  /**
   * Extract repository name from owner/repo format
   */
  private extractRepoName(repository: string): string {
    // Handle URLs
    if (repository.includes('://') || repository.startsWith('git@')) {
      // Extract from URL
      const match = repository.match(/[/:]([^/:]+\/[^/:]+?)(?:\.git)?$/);
      if (match) {
        return match[1].split('/').pop() || repository;
      }
    }

    // Handle owner/repo format
    if (repository.includes('/')) {
      return repository.split('/').pop() || repository;
    }

    return repository;
  }

  /**
   * Get a unique name by appending a number if needed
   */
  private getUniqueName(baseName: string): string {
    if (!this.usedNames.has(baseName)) {
      return baseName;
    }

    let counter = 2;
    let uniqueName = `${baseName}-${counter}`;
    while (this.usedNames.has(uniqueName)) {
      counter++;
      uniqueName = `${baseName}-${counter}`;
    }

    return uniqueName;
  }

  /**
   * Register cleanup handlers for process exit
   */
  private registerCleanupHandlers(): void {
    if (this.cleanupHandlersRegistered || !this.config.cleanupOnExit) {
      return;
    }

    // Note: We don't register on 'exit' as it must be synchronous
    // SIGINT and SIGTERM handlers are already registered by WorktreeManager
    // We rely on explicit cleanup call or process handlers from the engine

    this.cleanupHandlersRegistered = true;
  }
}
