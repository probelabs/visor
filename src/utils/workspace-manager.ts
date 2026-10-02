/**
 * Workspace Manager
 *
 * Provides full isolation between parallel visor runs with human-readable project names.
 * Each run gets its own workspace in /tmp containing worktrees for all projects.
 */

import * as fs from 'fs';
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

/**
 * Sanitize a path component to prevent path traversal attacks.
 * Removes directory separators and parent directory references.
 */
function sanitizePathComponent(name: string): string {
  return (
    name
      .replace(/\.\./g, '') // Remove parent directory references
      .replace(/[\/\\]/g, '-') // Replace path separators with dashes
      .replace(/^\.+/, '') // Remove leading dots
      .trim() || 'unnamed'
  ); // Ensure non-empty result
}

/** File (inside a linked worktree's private git dir) holding the branch baseline. */
const BRANCH_BASELINE_FILE = 'visor-branch-baseline.json';

interface BranchBaseline {
  /** Unix seconds when the snapshot was taken. */
  recordedAt: number;
  /** Local branches that existed at that moment (never deleted by cleanup). */
  branches: string[];
}

/**
 * Whether Visor may delete branches when it refreshes a reused workspace.
 *  - 'never'      : no branch is ever deleted (local CLI / library use on a developer checkout).
 *  - 'owned-only' : delete only branches created inside Visor's own worktree
 *                   (automation: GitHub Action, Slack/Telegram/MCP/... runners, scheduler daemon).
 */
export type WorkspaceBranchCleanupPolicy = 'never' | 'owned-only';

let branchCleanupPolicy: { policy: WorkspaceBranchCleanupPolicy; reason: string } = {
  policy: 'never',
  reason: 'no automation runner opted in (local CLI or library use)',
};

/**
 * Set the process-wide branch cleanup policy. Automation entry points opt in to
 * 'owned-only'; the local CLI sets 'never'. The default is 'never'.
 */
export function setWorkspaceBranchCleanupPolicy(
  policy: WorkspaceBranchCleanupPolicy,
  reason: string
): void {
  branchCleanupPolicy = { policy, reason };
}

export function getWorkspaceBranchCleanupPolicy(): {
  policy: WorkspaceBranchCleanupPolicy;
  reason: string;
} {
  return { ...branchCleanupPolicy };
}

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

  // Reference counting to prevent premature cleanup
  private activeOperations: number = 0;
  private cleanupRequested: boolean = false;
  private cleanupResolvers: Array<() => void> = [];

  private constructor(sessionId: string, originalPath: string, config?: Partial<WorkspaceConfig>) {
    this.sessionId = sessionId;
    this.originalPath = originalPath;

    const configuredName = config?.name || process.env.VISOR_WORKSPACE_NAME;
    const configuredMainProjectName =
      config?.mainProjectName || process.env.VISOR_WORKSPACE_PROJECT;

    // Default configuration
    this.config = {
      enabled: true,
      basePath: process.env.VISOR_WORKSPACE_PATH || '/tmp/visor-workspaces',
      cleanupOnExit: true,
      name: configuredName,
      mainProjectName: configuredMainProjectName,
      ...config,
    };

    this.basePath = this.config.basePath;
    const workspaceDirName = sanitizePathComponent(this.config.name || this.sessionId);
    this.workspacePath = path.join(this.basePath, workspaceDirName);
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
   * Acquire a reference to the workspace (prevents cleanup while held)
   * Call release() when done with the operation.
   */
  acquire(): void {
    this.activeOperations++;
    logger.debug(
      `[Workspace] Acquired reference (active: ${this.activeOperations}) for ${this.workspacePath}`
    );
  }

  /**
   * Release a reference to the workspace.
   * If cleanup was requested and this was the last reference, cleanup will proceed.
   */
  release(): void {
    this.activeOperations = Math.max(0, this.activeOperations - 1);
    logger.debug(
      `[Workspace] Released reference (active: ${this.activeOperations}) for ${this.workspacePath}`
    );

    // If cleanup was requested and no more active operations, proceed with cleanup
    if (this.cleanupRequested && this.activeOperations === 0) {
      logger.debug(`[Workspace] All references released, proceeding with deferred cleanup`);
      // Resolve all waiting cleanup promises
      for (const resolve of this.cleanupResolvers) {
        resolve();
      }
      this.cleanupResolvers = [];
    }
  }

  /**
   * Get the number of active operations
   */
  getActiveOperations(): number {
    return this.activeOperations;
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

    // Extract main project name from original path (sanitize for defense in depth)
    const configuredMainProjectName = this.config.mainProjectName;
    const mainProjectName = sanitizePathComponent(
      configuredMainProjectName || this.extractProjectName(this.originalPath)
    );
    this.usedNames.add(mainProjectName);

    // Create worktree for main project
    let mainProjectPath = path.join(this.workspacePath, mainProjectName);

    // Check if original path is a git repository
    const isGitRepo = await this.isGitRepository(this.originalPath);

    // Prune stale worktree references (from previous runs that were cleaned up).
    // Without this, the worktree list grows unboundedly and can slow git operations.
    if (isGitRepo) {
      try {
        await this.pruneOwnStaleWorktrees();
      } catch {
        // Best-effort — don't fail workspace init if prune fails
      }
    }

    // Detect if originalPath is a subdirectory of a git repo.
    // `git worktree add` always checks out the full repo, so if the user runs
    // visor from a subdirectory (e.g. /repo/subdir), the worktree will contain
    // the entire repo and we need to adjust mainProjectPath to point to the
    // corresponding subdirectory inside the worktree.
    let subdirOffset = '';
    if (isGitRepo) {
      const gitRootResult = await commandExecutor.execute(
        `git -C ${shellEscape(this.originalPath)} rev-parse --show-toplevel`,
        { timeout: 5000 }
      );
      if (gitRootResult.exitCode === 0) {
        const gitRoot = gitRootResult.stdout.trim();
        const normalizedOriginal = path.resolve(this.originalPath);
        const normalizedRoot = path.resolve(gitRoot);
        if (normalizedOriginal !== normalizedRoot) {
          subdirOffset = path.relative(normalizedRoot, normalizedOriginal);
          logger.info(`[Workspace] Original path is a subdirectory of git repo: ${subdirOffset}`);
        }
      }
    }

    if (isGitRepo) {
      // Check if main project worktree already exists (reused workspace, e.g. Slack thread)
      const exists = await this.pathExists(mainProjectPath);
      if (exists) {
        logger.info(`[Workspace] Reusing existing main project worktree: ${mainProjectPath}`);
        const isValid = await this.isGitRepository(mainProjectPath);
        if (!isValid) {
          logger.warn(`[Workspace] Existing path is not a valid git dir, recreating`);
          await fsp.rm(mainProjectPath, { recursive: true, force: true });
          try {
            await this.pruneOwnStaleWorktrees();
          } catch {}
          await this.createMainProjectWorktree(mainProjectPath);
        } else {
          // Worktree exists and is valid — update to latest upstream and clean
          await this.refreshWorktreeToUpstream(mainProjectPath);
        }
      } else {
        await this.createMainProjectWorktree(mainProjectPath);
      }
    } else {
      // If not a git repo, create a symlink instead
      logger.debug(`Original path is not a git repo, creating symlink`);
      const exists = await this.pathExists(mainProjectPath);
      if (!exists) {
        try {
          await fsp.symlink(this.originalPath, mainProjectPath);
        } catch (error) {
          throw new Error(`Failed to create symlink for main project: ${error}`);
        }
      }
    }

    // Remember the worktree root before any subdirectory adjustment.
    // Cleanup needs the actual worktree path (not the subdirectory inside it).
    const worktreeRootPath = mainProjectPath;

    // If the original path was a subdirectory, adjust mainProjectPath to
    // point to the corresponding subdirectory inside the worktree.
    // e.g. worktree at /tmp/ws/Oel contains full repo; if originalPath was
    // /repo/Oel, then mainProjectPath becomes /tmp/ws/Oel/Oel
    if (subdirOffset) {
      mainProjectPath = path.join(mainProjectPath, subdirOffset);
      logger.info(`[Workspace] Adjusted main project path to subdirectory: ${mainProjectPath}`);
      // Ensure the subdirectory exists in the worktree
      const subdirExists = await this.pathExists(mainProjectPath);
      if (!subdirExists) {
        logger.warn(
          `[Workspace] Subdirectory '${subdirOffset}' not found in worktree — falling back to worktree root`
        );
        mainProjectPath = path.join(this.workspacePath, mainProjectName);
      }
    }

    // Rehydrate existing entries in persisted workspaces (e.g. Slack threads)
    // so repeated runs update the same symlink names instead of growing suffixes.
    try {
      await this.loadExistingProjects(mainProjectName);
    } catch {
      // Best-effort — workspace just created, nothing to scan
    }

    // Register cleanup handlers
    this.registerCleanupHandlers();

    this.mainProjectInfo = {
      sessionId: this.sessionId,
      workspacePath: this.workspacePath,
      mainProjectPath,
      mainProjectName,
      originalPath: this.originalPath,
      worktreeRootPath,
    };

    this.initialized = true;
    logger.info(`Workspace initialized: ${this.workspacePath}`);

    return this.mainProjectInfo;
  }

  /**
   * Add a project to the workspace (creates symlink to worktree)
   * If the same repository already exists, updates the symlink to the new worktree path.
   */
  async addProject(
    repository: string,
    worktreePath: string,
    description?: string
  ): Promise<string> {
    if (!this.initialized) {
      throw new Error('Workspace not initialized. Call initialize() first.');
    }

    // Check if this repository is already added (dedup by repository, not worktree path).
    // Worktree paths change across sessions (session-scoped hashing) and across
    // nested workflow invocations (each gets a fresh sessionId), but the workspace
    // symlink should always point to the latest worktree for a given repo.
    for (const [existingName, existingProject] of this.projects.entries()) {
      if (existingProject.repository === repository) {
        if (existingProject.worktreePath !== worktreePath) {
          // Worktree path changed (new session/invocation) — update symlink
          logger.debug(
            `Updating project symlink: ${existingName} (${repository}) -> ${worktreePath}`
          );
          await fsp.rm(existingProject.path, { recursive: true, force: true });
          try {
            await fsp.symlink(worktreePath, existingProject.path);
          } catch (error) {
            throw new Error(`Failed to update symlink for project ${existingName}: ${error}`);
          }
          existingProject.worktreePath = worktreePath;
        } else {
          logger.debug(`Reusing existing project: ${existingName} (${repository})`);
        }
        return existingProject.path;
      }
    }

    // Extract project name and sanitize to prevent path traversal
    let projectName = sanitizePathComponent(description || this.extractRepoName(repository));

    // Handle duplicate names (only if not reusing existing)
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
   * Cleanup the workspace.
   * If there are active operations, waits for them to complete before cleaning up.
   * @param timeout Maximum time to wait for active operations (default: 60s)
   */
  async cleanup(timeout: number = 60000): Promise<void> {
    // Respect cleanupOnExit flag — persisted workspaces (e.g. Slack threads) should not be cleaned up
    if (!this.config.cleanupOnExit) {
      logger.debug(`[Workspace] Skipping cleanup (cleanupOnExit=false): ${this.workspacePath}`);
      WorkspaceManager.instances.delete(this.sessionId);
      this.initialized = false;
      this.mainProjectInfo = null;
      this.projects.clear();
      this.usedNames.clear();
      return;
    }

    logger.info(
      `Cleaning up workspace: ${this.workspacePath} (active operations: ${this.activeOperations})`
    );

    // If there are active operations, wait for them to complete
    if (this.activeOperations > 0) {
      logger.info(
        `[Workspace] Waiting for ${this.activeOperations} active operations to complete before cleanup`
      );
      this.cleanupRequested = true;

      // Wait for all operations to complete (with timeout)
      await Promise.race([
        new Promise<void>(resolve => {
          if (this.activeOperations === 0) {
            resolve();
          } else {
            this.cleanupResolvers.push(resolve);
          }
        }),
        new Promise<void>(resolve => {
          setTimeout(() => {
            logger.warn(
              `[Workspace] Cleanup timeout after ${timeout}ms, proceeding anyway (${this.activeOperations} operations still active)`
            );
            resolve();
          }, timeout);
        }),
      ]);
    }

    try {
      // Remove main project worktree if it exists.
      // Use worktreeRootPath (the actual git worktree) rather than mainProjectPath
      // which may include a subdirectory offset (e.g. Oel/Oel instead of Oel).
      if (this.mainProjectInfo) {
        const worktreePath =
          this.mainProjectInfo.worktreeRootPath || this.mainProjectInfo.mainProjectPath;

        // Check if path exists and if it's a worktree (not a symlink)
        try {
          const stats = await fsp.lstat(worktreePath);
          if (!stats.isSymbolicLink()) {
            await this.removeMainProjectWorktree(worktreePath);
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
      this.cleanupRequested = false;
      this.cleanupResolvers = [];

      logger.info(`Workspace cleanup completed: ${this.sessionId}`);
    } catch (error) {
      logger.warn(`Failed to cleanup workspace: ${error}`);
    }
  }

  /**
   * Check if a path exists (file or directory).
   */
  private async pathExists(p: string): Promise<boolean> {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Rehydrate existing symlinked projects in a persisted workspace so future
   * runs update them in place instead of allocating project-2, project-3, etc.
   */
  private async loadExistingProjects(mainProjectName: string): Promise<void> {
    const entries = await fsp.readdir(this.workspacePath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === mainProjectName) {
        continue;
      }

      const entryPath = path.join(this.workspacePath, entry.name);
      this.usedNames.add(entry.name);

      if (!entry.isSymbolicLink()) {
        continue;
      }

      try {
        const targetPath = await fsp.realpath(entryPath);
        const metadataPath = `${targetPath.replace(/\/?$/, '')}.metadata.json`;
        if (!fs.existsSync(metadataPath)) {
          continue;
        }

        const metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf8')) as {
          repository?: string;
          worktree_path?: string;
        };
        if (!metadata.repository) {
          continue;
        }

        this.projects.set(entry.name, {
          name: entry.name,
          path: entryPath,
          worktreePath: metadata.worktree_path || targetPath,
          repository: metadata.repository,
        });
      } catch {
        // Best-effort — leave unknown entries untouched.
      }
    }
  }

  /**
   * Clean up stale workspace directories older than maxAge.
   * Call periodically (e.g. at socket-runner startup) to prevent disk bloat.
   */
  static async cleanupStale(
    basePath: string = process.env.VISOR_WORKSPACE_PATH || '/tmp/visor-workspaces',
    maxAgeMs: number = 24 * 60 * 60 * 1000
  ): Promise<number> {
    let cleaned = 0;
    try {
      const entries = await fsp.readdir(basePath, { withFileTypes: true });
      const now = Date.now();
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dirPath = path.join(basePath, entry.name);
        try {
          const stat = await fsp.stat(dirPath);
          if (now - stat.mtimeMs > maxAgeMs) {
            // Safety: skip directories that are real git repos (have a .git directory),
            // not visor-created worktree directories. Worktrees have a .git *file*
            // (containing "gitdir: ..."), not a .git directory.
            const topGitPath = path.join(dirPath, '.git');
            try {
              const topGitStat = await fsp.stat(topGitPath);
              if (topGitStat.isDirectory()) {
                logger.warn(
                  `[Workspace] Skipping ${dirPath} — it is a real git repository, not a visor workspace`
                );
                continue;
              }
            } catch {
              // .git doesn't exist — safe to proceed
            }

            // Prune any git worktrees before removing the directory
            try {
              const subdirs = await fsp.readdir(dirPath, { withFileTypes: true });
              for (const sub of subdirs) {
                if (!sub.isDirectory()) continue;
                const subPath = path.join(dirPath, sub.name);
                const gitFilePath = path.join(subPath, '.git');
                try {
                  const gitContent = await fsp.readFile(gitFilePath, 'utf-8');
                  const match = gitContent.match(/gitdir:\s*(.+)/);
                  if (match) {
                    const worktreeGitDir = match[1].trim();
                    // Only proceed if this is actually a worktree (gitdir points into .git/worktrees/)
                    if (!worktreeGitDir.includes('/.git/worktrees/')) {
                      logger.warn(
                        `[Workspace] Skipping worktree removal for ${subPath} — gitdir does not point to a worktree`
                      );
                      continue;
                    }
                    const repoGitDir = worktreeGitDir.replace(/\/\.git\/worktrees\/.*$/, '');
                    // Don't remove worktrees from repos outside the workspace basePath
                    if (!repoGitDir.startsWith(basePath)) {
                      logger.warn(
                        `[Workspace] Skipping worktree removal for ${subPath} — parent repo ${repoGitDir} is outside workspace`
                      );
                      continue;
                    }
                    await commandExecutor.execute(
                      `git -C ${shellEscape(repoGitDir)} worktree remove ${shellEscape(subPath)} --force`,
                      { timeout: 10000 }
                    );
                  }
                } catch {}
              }
            } catch {}
            await fsp.rm(dirPath, { recursive: true, force: true });
            cleaned++;
          }
        } catch {}
      }
      if (cleaned > 0) {
        logger.info(`[Workspace] Cleaned up ${cleaned} stale workspace(s) from ${basePath}`);
      }
    } catch (error) {
      logger.debug(`[Workspace] Stale cleanup error: ${error}`);
    }
    return cleaned;
  }

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
  private async resolveUpstreamRef(): Promise<string> {
    const esc = shellEscape(this.originalPath);

    // First, try to resolve origin/HEAD (follows the remote's default branch)
    const symbolicResult = await commandExecutor.execute(
      `git -C ${esc} symbolic-ref refs/remotes/origin/HEAD 2>/dev/null`,
      { timeout: 10000 }
    );
    if (symbolicResult.exitCode === 0 && symbolicResult.stdout.trim()) {
      // Returns something like "refs/remotes/origin/main"
      const ref = symbolicResult.stdout.trim().replace('refs/remotes/', '');
      logger.debug(`[Workspace] Resolved upstream default branch via origin/HEAD: ${ref}`);
      return ref;
    }

    // Try origin/main
    const mainResult = await commandExecutor.execute(
      `git -C ${esc} rev-parse --verify origin/main 2>/dev/null`,
      { timeout: 10000 }
    );
    if (mainResult.exitCode === 0) {
      logger.debug(`[Workspace] Using origin/main as upstream ref`);
      return 'origin/main';
    }

    // Try origin/master
    const masterResult = await commandExecutor.execute(
      `git -C ${esc} rev-parse --verify origin/master 2>/dev/null`,
      { timeout: 10000 }
    );
    if (masterResult.exitCode === 0) {
      logger.debug(`[Workspace] Using origin/master as upstream ref`);
      return 'origin/master';
    }

    // Fallback: no remote configured, use local HEAD
    logger.warn(`[Workspace] No upstream remote found, falling back to local HEAD`);
    return 'HEAD';
  }

  /**
   * Fetch latest from origin, resolve the upstream default branch, and return
   * both the ref name and the resolved commit SHA.
   */
  private async fetchAndResolveUpstream(): Promise<{ upstreamRef: string; targetSha: string }> {
    // Fetch latest from origin
    logger.debug(`[Workspace] Fetching latest from origin`);
    // Never prune the user's remote-tracking refs from a developer checkout
    // (`--no-prune` also overrides a global fetch.prune=true); `--prune` is only
    // used by automation that owns its checkout.
    const pruneFlag =
      this.getBranchCleanupPolicy().policy === 'owned-only' ? ' --prune' : ' --no-prune';
    const fetchResult = await commandExecutor.execute(
      `git -C ${shellEscape(this.originalPath)} fetch origin${pruneFlag} 2>&1`,
      { timeout: 120000 }
    );
    if (fetchResult.exitCode !== 0) {
      logger.warn(`[Workspace] fetch origin failed (will use cached refs): ${fetchResult.stderr}`);
    }

    // Resolve the upstream ref
    const upstreamRef = await this.resolveUpstreamRef();

    // Get the commit SHA for the upstream ref
    const shaResult = await commandExecutor.execute(
      `git -C ${shellEscape(this.originalPath)} rev-parse ${shellEscape(upstreamRef)}`,
      { timeout: 10000 }
    );
    if (shaResult.exitCode === 0) {
      return { upstreamRef, targetSha: shaResult.stdout.trim() };
    }

    // Upstream ref unresolvable — fall back to local HEAD
    logger.warn(
      `[Workspace] Could not resolve ${upstreamRef} (${shaResult.stderr.trim()}), falling back to HEAD`
    );
    const headResult = await commandExecutor.execute(
      `git -C ${shellEscape(this.originalPath)} rev-parse HEAD`,
      { timeout: 10000 }
    );
    if (headResult.exitCode !== 0) {
      throw new Error(`Repository has no commits — cannot create worktree: ${headResult.stderr}`);
    }
    return { upstreamRef: 'HEAD', targetSha: headResult.stdout.trim() };
  }

  /** Effective branch cleanup policy (instance override > process-wide policy). */
  private getBranchCleanupPolicy(): { policy: WorkspaceBranchCleanupPolicy; reason: string } {
    if (this.config.branchCleanup) {
      return { policy: this.config.branchCleanup, reason: 'workspace config' };
    }
    return getWorkspaceBranchCleanupPolicy();
  }

  /**
   * Remove stale worktree entries that VISOR created (their path is under the
   * workspace base path and no longer exists). Unlike a repo-wide
   * `git worktree prune`, this never touches the user's own worktrees (e.g. on
   * an unmounted drive).
   */
  private async pruneOwnStaleWorktrees(): Promise<void> {
    const list = await commandExecutor.execute(
      `git -C ${shellEscape(this.originalPath)} worktree list --porcelain`,
      { timeout: 15000 }
    );
    if (list.exitCode !== 0) return;
    const bases = new Set<string>([path.resolve(this.basePath)]);
    try {
      bases.add(fs.realpathSync(this.basePath));
    } catch {}
    const isUnderBase = (p: string) =>
      [...bases].some(b => p === b || p.startsWith(b.endsWith(path.sep) ? b : b + path.sep));
    let current: string | null = null;
    for (const line of list.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        current = line.slice('worktree '.length).trim();
      } else if (line.startsWith('prunable') && current && isUnderBase(current)) {
        await commandExecutor.execute(
          `git -C ${shellEscape(this.originalPath)} worktree remove --force ${shellEscape(current)}`,
          { timeout: 10000 }
        );
      }
    }
  }

  /**
   * Reset a worktree to a specific commit and clean all modifications.
   *
   * NOTE: this deliberately does NOT touch branches. A linked worktree shares
   * `refs/heads/*` with the user's repository, so a blanket "delete local
   * branches" here deletes the user's real branches (see
   * deleteBranchesCreatedInWorktree for the narrowly-scoped cleanup).
   */
  private async resetAndCleanWorktree(worktreePath: string, targetSha: string): Promise<void> {
    const escapedPath = shellEscape(worktreePath);
    const escapedSha = shellEscape(targetSha);

    // `reset --hard` moves whatever branch HEAD is on. Visor's worktree must be
    // detached; if something left it on a (possibly user-owned) branch, detach
    // first and refuse to reset if that fails, so no branch is ever moved.
    const attachedBranch = await this.getCheckedOutBranch(worktreePath);
    if (attachedBranch) {
      await commandExecutor.execute(`git -C ${escapedPath} checkout --detach`, {
        timeout: 30000,
      });
      if (await this.getCheckedOutBranch(worktreePath)) {
        logger.warn(
          `[Workspace] Worktree ${worktreePath} is on branch '${attachedBranch}' and could not be detached; skipping reset to avoid moving that branch`
        );
        return;
      }
    }

    const resetResult = await commandExecutor.execute(
      `git -C ${escapedPath} reset --hard ${escapedSha}`,
      { timeout: 10000 }
    );
    if (resetResult.exitCode !== 0) {
      logger.warn(`[Workspace] reset --hard failed: ${resetResult.stderr}`);
    }

    const cleanResult = await commandExecutor.execute(`git -C ${escapedPath} clean -fdx`, {
      timeout: 30000,
    });
    if (cleanResult.exitCode !== 0) {
      logger.warn(`[Workspace] clean -fdx failed: ${cleanResult.stderr}`);
    }
  }

  /**
   * Absolute path of the git admin dir private to a LINKED worktree
   * (`<repo>/.git/worktrees/<name>`). Files stored there are invisible to the
   * work tree (survive `clean -fdx`) and are removed by `git worktree remove`.
   * Returns null for anything that is not a linked worktree, so we never write
   * into a user's main `.git` directory.
   */
  private async getLinkedWorktreeGitDir(worktreePath: string): Promise<string | null> {
    const result = await commandExecutor.execute(
      `git -C ${shellEscape(worktreePath)} rev-parse --absolute-git-dir`,
      { timeout: 5000 }
    );
    if (result.exitCode !== 0) return null;
    const gitDir = result.stdout.trim();
    if (!gitDir || !/[\\/]worktrees[\\/][^\\/]+$/.test(gitDir)) return null;
    return gitDir;
  }

  /** All local branch names (shared namespace of the repo and all its worktrees). */
  private async listLocalBranches(repoPath: string): Promise<string[] | null> {
    const result = await commandExecutor.execute(
      `git -C ${shellEscape(repoPath)} for-each-ref --format='%(refname:short)' refs/heads`,
      { timeout: 10000 }
    );
    if (result.exitCode !== 0) return null;
    return result.stdout
      .split('\n')
      .map(b => b.trim())
      .filter(b => b.length > 0);
  }

  /**
   * Snapshot the branches that exist right now, so a later cleanup can tell
   * branches created inside Visor's worktree apart from the user's own branches.
   */
  private async recordBranchBaseline(worktreePath: string): Promise<void> {
    try {
      const gitDir = await this.getLinkedWorktreeGitDir(worktreePath);
      if (!gitDir) return;
      const branches = await this.listLocalBranches(worktreePath);
      if (!branches) return;
      const baseline: BranchBaseline = {
        recordedAt: Math.floor(Date.now() / 1000),
        branches,
      };
      await fsp.writeFile(path.join(gitDir, BRANCH_BASELINE_FILE), JSON.stringify(baseline));
    } catch (error) {
      logger.debug(`[Workspace] Could not record branch baseline: ${error}`);
    }
  }

  private async readBranchBaseline(worktreePath: string): Promise<BranchBaseline | null> {
    try {
      const gitDir = await this.getLinkedWorktreeGitDir(worktreePath);
      if (!gitDir) return null;
      const raw = await fsp.readFile(path.join(gitDir, BRANCH_BASELINE_FILE), 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed?.recordedAt !== 'number' || !Array.isArray(parsed?.branches)) return null;
      return parsed as BranchBaseline;
    } catch {
      return null;
    }
  }

  /** Branch currently checked out in the worktree, or null when HEAD is detached. */
  private async getCheckedOutBranch(worktreePath: string): Promise<string | null> {
    const result = await commandExecutor.execute(
      `git -C ${shellEscape(worktreePath)} symbolic-ref -q --short HEAD`,
      { timeout: 5000 }
    );
    if (result.exitCode !== 0) return null;
    return result.stdout.trim() || null;
  }

  /**
   * Branch names that were checked out IN THIS WORKTREE since `sinceEpoch`,
   * read from the worktree's private HEAD reflog (`git checkout -b`/`switch -c`
   * inside Visor's worktree is recorded there, never in the user's own HEAD log).
   */
  private async branchesCheckedOutInWorktreeSince(
    worktreePath: string,
    sinceEpoch: number
  ): Promise<Set<string>> {
    const names = new Set<string>();
    const result = await commandExecutor.execute(
      `git -C ${shellEscape(worktreePath)} reflog show --date=unix --format='%gd%x09%gs' HEAD`,
      { timeout: 10000 }
    );
    if (result.exitCode !== 0) return names;
    for (const line of result.stdout.split('\n')) {
      const [selector, subject] = line.split('\t');
      const ts = Number(/@\{(\d+)\}$/.exec(selector || '')?.[1]);
      if (!subject || !Number.isFinite(ts) || ts < sinceEpoch) continue;
      const moving = /^checkout: moving from (\S+) to (\S+)$/.exec(subject);
      if (moving) {
        names.add(moving[1]);
        names.add(moving[2]);
      }
      const returning = /returning to refs\/heads\/(\S+)$/.exec(subject);
      if (returning) names.add(returning[1]);
    }
    return names;
  }

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
  private async deleteBranchesCreatedInWorktree(
    worktreePath: string,
    headBranchBeforeReset: string | null
  ): Promise<void> {
    const { policy, reason } = this.getBranchCleanupPolicy();
    if (policy !== 'owned-only') {
      logger.debug(
        `[Workspace] Branch cleanup skipped for ${worktreePath}: policy '${policy}' (${reason}); no branch will be deleted`
      );
      return;
    }
    const baseline = await this.readBranchBaseline(worktreePath);
    if (!baseline) {
      logger.debug(`[Workspace] No branch baseline for ${worktreePath}; not deleting any branch`);
      return;
    }
    const existing = await this.listLocalBranches(worktreePath);
    if (!existing || existing.length === 0) return;

    const touched = await this.branchesCheckedOutInWorktreeSince(worktreePath, baseline.recordedAt);
    if (headBranchBeforeReset) touched.add(headBranchBeforeReset);

    const protectedBranches = new Set<string>(baseline.branches);
    const worktreeListResult = await commandExecutor.execute(
      `git -C ${shellEscape(worktreePath)} worktree list --porcelain`,
      { timeout: 10000 }
    );
    if (worktreeListResult.exitCode !== 0) {
      logger.debug('[Workspace] worktree list failed; not deleting any branch');
      return;
    }
    for (const line of worktreeListResult.stdout.split('\n')) {
      const match = line.match(/^branch refs\/heads\/(.+)$/);
      if (match) protectedBranches.add(match[1]);
    }

    for (const branch of existing) {
      if (!touched.has(branch) || protectedBranches.has(branch)) continue;
      const deleteResult = await commandExecutor.execute(
        `git -C ${shellEscape(worktreePath)} branch -D ${shellEscape(branch)}`,
        { timeout: 10000 }
      );
      if (deleteResult.exitCode === 0) {
        logger.info(`[Workspace] Deleted branch '${branch}' created inside Visor's worktree`);
      }
    }
  }

  /**
   * Refresh an existing worktree to the latest upstream default branch
   * and ensure it has no modified or untracked files.
   */
  private async refreshWorktreeToUpstream(worktreePath: string): Promise<void> {
    logger.info(`[Workspace] Refreshing worktree to latest upstream: ${worktreePath}`);

    try {
      // Remember which branch (if any) an agent left the worktree on, before re-detaching.
      const headBranchBeforeReset = await this.getCheckedOutBranch(worktreePath);
      const { upstreamRef, targetSha } = await this.fetchAndResolveUpstream();

      // Point worktree to the upstream commit
      const checkoutResult = await commandExecutor.execute(
        `git -C ${shellEscape(worktreePath)} checkout --detach ${shellEscape(targetSha)}`,
        { timeout: 30000 }
      );
      if (checkoutResult.exitCode !== 0) {
        logger.warn(
          `[Workspace] checkout --detach failed (worktree stays at current commit): ${checkoutResult.stderr}`
        );
        // Still clean even if checkout failed — the worktree is valid, just at old commit
        await this.resetAndCleanWorktree(worktreePath, 'HEAD');
        return;
      }

      // Reset and clean
      await this.resetAndCleanWorktree(worktreePath, targetSha);

      // Remove only branches created inside this worktree since the last baseline,
      // then re-baseline so branches the user created meanwhile are protected.
      await this.deleteBranchesCreatedInWorktree(worktreePath, headBranchBeforeReset);
      await this.recordBranchBaseline(worktreePath);

      logger.info(`[Workspace] Worktree updated to ${upstreamRef} (${targetSha.slice(0, 8)})`);
    } catch (error) {
      // Best-effort: a stale worktree is better than failing initialization entirely
      logger.warn(`[Workspace] Failed to refresh worktree (continuing with stale state): ${error}`);
    }
  }

  /**
   * Create worktree for the main project.
   * See visor-disable comment above resolveUpstreamRef for why this doesn't use WorktreeManager.
   */
  private async createMainProjectWorktree(targetPath: string): Promise<void> {
    logger.debug(`Creating main project worktree: ${targetPath}`);

    const { upstreamRef, targetSha } = await this.fetchAndResolveUpstream();

    // Create worktree using detached HEAD at the upstream commit
    const createCmd = `git -C ${shellEscape(this.originalPath)} worktree add --detach ${shellEscape(targetPath)} ${shellEscape(targetSha)}`;
    const result = await commandExecutor.execute(createCmd, { timeout: 60000 });

    if (result.exitCode !== 0) {
      throw new Error(`Failed to create main project worktree: ${result.stderr}`);
    }

    // Clean (shouldn't be needed in a fresh worktree, but defense in depth).
    // A fresh detached worktree has created no branches, so nothing is deleted here.
    await this.resetAndCleanWorktree(targetPath, targetSha);
    await this.recordBranchBaseline(targetPath);

    logger.info(
      `Created main project worktree at ${targetPath} (${upstreamRef} -> ${targetSha.slice(0, 8)})`
    );
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
