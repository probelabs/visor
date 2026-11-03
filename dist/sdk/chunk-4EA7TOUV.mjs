import {
  commandExecutor,
  init_command_executor
} from "./chunk-32S5FVFW.mjs";
import {
  init_logger,
  logger
} from "./chunk-6E625R3C.mjs";
import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/utils/workspace-manager.ts
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
function shellEscape(str) {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}
function sanitizePathComponent(name) {
  return name.replace(/\.\./g, "").replace(/[\/\\]/g, "-").replace(/^\.+/, "").trim() || "unnamed";
}
function setWorkspaceBranchCleanupPolicy(policy, reason) {
  branchCleanupPolicy = { policy, reason };
}
function getWorkspaceBranchCleanupPolicy() {
  return { ...branchCleanupPolicy };
}
var BRANCH_BASELINE_FILE, branchCleanupPolicy, WorkspaceManager;
var init_workspace_manager = __esm({
  "src/utils/workspace-manager.ts"() {
    init_command_executor();
    init_logger();
    BRANCH_BASELINE_FILE = "visor-branch-baseline.json";
    branchCleanupPolicy = {
      policy: "never",
      reason: "no automation runner opted in (local CLI or library use)"
    };
    WorkspaceManager = class _WorkspaceManager {
      static instances = /* @__PURE__ */ new Map();
      sessionId;
      basePath;
      workspacePath;
      originalPath;
      config;
      initialized = false;
      mainProjectInfo = null;
      projects = /* @__PURE__ */ new Map();
      cleanupHandlersRegistered = false;
      usedNames = /* @__PURE__ */ new Set();
      // Reference counting to prevent premature cleanup
      activeOperations = 0;
      cleanupRequested = false;
      cleanupResolvers = [];
      constructor(sessionId, originalPath, config) {
        this.sessionId = sessionId;
        this.originalPath = originalPath;
        const configuredName = config?.name || process.env.VISOR_WORKSPACE_NAME;
        const configuredMainProjectName = config?.mainProjectName || process.env.VISOR_WORKSPACE_PROJECT;
        this.config = {
          enabled: true,
          basePath: process.env.VISOR_WORKSPACE_PATH || "/tmp/visor-workspaces",
          cleanupOnExit: true,
          name: configuredName,
          mainProjectName: configuredMainProjectName,
          ...config
        };
        this.basePath = this.config.basePath;
        const workspaceDirName = sanitizePathComponent(this.config.name || this.sessionId);
        this.workspacePath = path.join(this.basePath, workspaceDirName);
      }
      /**
       * Get or create a WorkspaceManager instance for a session
       */
      static getInstance(sessionId, originalPath, config) {
        if (!_WorkspaceManager.instances.has(sessionId)) {
          _WorkspaceManager.instances.set(
            sessionId,
            new _WorkspaceManager(sessionId, originalPath, config)
          );
        }
        return _WorkspaceManager.instances.get(sessionId);
      }
      /**
       * Clear all instances (for testing)
       */
      static clearInstances() {
        _WorkspaceManager.instances.clear();
      }
      /**
       * Check if workspace isolation is enabled
       */
      isEnabled() {
        return this.config.enabled;
      }
      /**
       * Acquire a reference to the workspace (prevents cleanup while held)
       * Call release() when done with the operation.
       */
      acquire() {
        this.activeOperations++;
        logger.debug(
          `[Workspace] Acquired reference (active: ${this.activeOperations}) for ${this.workspacePath}`
        );
      }
      /**
       * Release a reference to the workspace.
       * If cleanup was requested and this was the last reference, cleanup will proceed.
       */
      release() {
        this.activeOperations = Math.max(0, this.activeOperations - 1);
        logger.debug(
          `[Workspace] Released reference (active: ${this.activeOperations}) for ${this.workspacePath}`
        );
        if (this.cleanupRequested && this.activeOperations === 0) {
          logger.debug(`[Workspace] All references released, proceeding with deferred cleanup`);
          for (const resolve2 of this.cleanupResolvers) {
            resolve2();
          }
          this.cleanupResolvers = [];
        }
      }
      /**
       * Get the number of active operations
       */
      getActiveOperations() {
        return this.activeOperations;
      }
      /**
       * Get the workspace path
       */
      getWorkspacePath() {
        return this.workspacePath;
      }
      /**
       * Get the original working directory
       */
      getOriginalPath() {
        return this.originalPath;
      }
      /**
       * Get workspace info (only available after initialize)
       */
      getWorkspaceInfo() {
        return this.mainProjectInfo;
      }
      /**
       * Initialize the workspace - creates workspace directory and main project worktree
       */
      async initialize() {
        if (!this.config.enabled) {
          throw new Error("Workspace isolation is not enabled");
        }
        if (this.initialized && this.mainProjectInfo) {
          return this.mainProjectInfo;
        }
        logger.info(`Initializing workspace: ${this.workspacePath}`);
        await fsp.mkdir(this.workspacePath, { recursive: true });
        logger.debug(`Created workspace directory: ${this.workspacePath}`);
        const configuredMainProjectName = this.config.mainProjectName;
        const mainProjectName = sanitizePathComponent(
          configuredMainProjectName || this.extractProjectName(this.originalPath)
        );
        this.usedNames.add(mainProjectName);
        let mainProjectPath = path.join(this.workspacePath, mainProjectName);
        const isGitRepo = await this.isGitRepository(this.originalPath);
        if (isGitRepo) {
          try {
            await this.pruneOwnStaleWorktrees();
          } catch {
          }
        }
        let subdirOffset = "";
        if (isGitRepo) {
          const gitRootResult = await commandExecutor.execute(
            `git -C ${shellEscape(this.originalPath)} rev-parse --show-toplevel`,
            { timeout: 5e3 }
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
          const exists = await this.pathExists(mainProjectPath);
          if (exists) {
            logger.info(`[Workspace] Reusing existing main project worktree: ${mainProjectPath}`);
            const isValid = await this.isGitRepository(mainProjectPath);
            if (!isValid) {
              logger.warn(`[Workspace] Existing path is not a valid git dir, recreating`);
              await fsp.rm(mainProjectPath, { recursive: true, force: true });
              try {
                await this.pruneOwnStaleWorktrees();
              } catch {
              }
              await this.createMainProjectWorktree(mainProjectPath);
            } else {
              await this.refreshWorktreeToUpstream(mainProjectPath);
            }
          } else {
            await this.createMainProjectWorktree(mainProjectPath);
          }
        } else {
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
        const worktreeRootPath = mainProjectPath;
        if (subdirOffset) {
          mainProjectPath = path.join(mainProjectPath, subdirOffset);
          logger.info(`[Workspace] Adjusted main project path to subdirectory: ${mainProjectPath}`);
          const subdirExists = await this.pathExists(mainProjectPath);
          if (!subdirExists) {
            logger.warn(
              `[Workspace] Subdirectory '${subdirOffset}' not found in worktree \u2014 falling back to worktree root`
            );
            mainProjectPath = path.join(this.workspacePath, mainProjectName);
          }
        }
        try {
          await this.loadExistingProjects(mainProjectName);
        } catch {
        }
        this.registerCleanupHandlers();
        this.mainProjectInfo = {
          sessionId: this.sessionId,
          workspacePath: this.workspacePath,
          mainProjectPath,
          mainProjectName,
          originalPath: this.originalPath,
          worktreeRootPath
        };
        this.initialized = true;
        logger.info(`Workspace initialized: ${this.workspacePath}`);
        return this.mainProjectInfo;
      }
      /**
       * Add a project to the workspace (creates symlink to worktree)
       * If the same repository already exists, updates the symlink to the new worktree path.
       */
      async addProject(repository, worktreePath, description) {
        if (!this.initialized) {
          throw new Error("Workspace not initialized. Call initialize() first.");
        }
        for (const [existingName, existingProject] of this.projects.entries()) {
          if (existingProject.repository === repository) {
            if (existingProject.worktreePath !== worktreePath) {
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
        let projectName = sanitizePathComponent(description || this.extractRepoName(repository));
        projectName = this.getUniqueName(projectName);
        this.usedNames.add(projectName);
        const workspacePath = path.join(this.workspacePath, projectName);
        await fsp.rm(workspacePath, { recursive: true, force: true });
        try {
          await fsp.symlink(worktreePath, workspacePath);
        } catch (error) {
          throw new Error(`Failed to create symlink for project ${projectName}: ${error}`);
        }
        this.projects.set(projectName, {
          name: projectName,
          path: workspacePath,
          worktreePath,
          repository
        });
        logger.info(`Added project to workspace: ${projectName} -> ${worktreePath}`);
        return workspacePath;
      }
      /**
       * List all projects in the workspace
       */
      listProjects() {
        return Array.from(this.projects.values());
      }
      /**
       * Cleanup the workspace.
       * If there are active operations, waits for them to complete before cleaning up.
       * @param timeout Maximum time to wait for active operations (default: 60s)
       */
      async cleanup(timeout = 6e4) {
        if (!this.config.cleanupOnExit) {
          logger.debug(`[Workspace] Skipping cleanup (cleanupOnExit=false): ${this.workspacePath}`);
          _WorkspaceManager.instances.delete(this.sessionId);
          this.initialized = false;
          this.mainProjectInfo = null;
          this.projects.clear();
          this.usedNames.clear();
          return;
        }
        logger.info(
          `Cleaning up workspace: ${this.workspacePath} (active operations: ${this.activeOperations})`
        );
        if (this.activeOperations > 0) {
          logger.info(
            `[Workspace] Waiting for ${this.activeOperations} active operations to complete before cleanup`
          );
          this.cleanupRequested = true;
          await Promise.race([
            new Promise((resolve2) => {
              if (this.activeOperations === 0) {
                resolve2();
              } else {
                this.cleanupResolvers.push(resolve2);
              }
            }),
            new Promise((resolve2) => {
              setTimeout(() => {
                logger.warn(
                  `[Workspace] Cleanup timeout after ${timeout}ms, proceeding anyway (${this.activeOperations} operations still active)`
                );
                resolve2();
              }, timeout);
            })
          ]);
        }
        try {
          if (this.mainProjectInfo) {
            const worktreePath = this.mainProjectInfo.worktreeRootPath || this.mainProjectInfo.mainProjectPath;
            try {
              const stats = await fsp.lstat(worktreePath);
              if (!stats.isSymbolicLink()) {
                await this.removeMainProjectWorktree(worktreePath);
              }
            } catch {
            }
          }
          await fsp.rm(this.workspacePath, { recursive: true, force: true });
          logger.debug(`Removed workspace directory: ${this.workspacePath}`);
          _WorkspaceManager.instances.delete(this.sessionId);
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
      async pathExists(p) {
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
      async loadExistingProjects(mainProjectName) {
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
            const metadataPath = `${targetPath.replace(/\/?$/, "")}.metadata.json`;
            if (!fs.existsSync(metadataPath)) {
              continue;
            }
            const metadata = JSON.parse(await fsp.readFile(metadataPath, "utf8"));
            if (!metadata.repository) {
              continue;
            }
            this.projects.set(entry.name, {
              name: entry.name,
              path: entryPath,
              worktreePath: metadata.worktree_path || targetPath,
              repository: metadata.repository
            });
          } catch {
          }
        }
      }
      /**
       * Clean up stale workspace directories older than maxAge.
       * Call periodically (e.g. at socket-runner startup) to prevent disk bloat.
       */
      static async cleanupStale(basePath = process.env.VISOR_WORKSPACE_PATH || "/tmp/visor-workspaces", maxAgeMs = 24 * 60 * 60 * 1e3) {
        let cleaned = 0;
        try {
          const entries = await fsp.readdir(basePath, { withFileTypes: true });
          const now = Date.now();
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const dirPath = path.join(basePath, entry.name);
            try {
              const stat2 = await fsp.stat(dirPath);
              if (now - stat2.mtimeMs > maxAgeMs) {
                const topGitPath = path.join(dirPath, ".git");
                try {
                  const topGitStat = await fsp.stat(topGitPath);
                  if (topGitStat.isDirectory()) {
                    logger.warn(
                      `[Workspace] Skipping ${dirPath} \u2014 it is a real git repository, not a visor workspace`
                    );
                    continue;
                  }
                } catch {
                }
                try {
                  const subdirs = await fsp.readdir(dirPath, { withFileTypes: true });
                  for (const sub of subdirs) {
                    if (!sub.isDirectory()) continue;
                    const subPath = path.join(dirPath, sub.name);
                    const gitFilePath = path.join(subPath, ".git");
                    try {
                      const gitContent = await fsp.readFile(gitFilePath, "utf-8");
                      const match = gitContent.match(/gitdir:\s*(.+)/);
                      if (match) {
                        const worktreeGitDir = match[1].trim();
                        if (!worktreeGitDir.includes("/.git/worktrees/")) {
                          logger.warn(
                            `[Workspace] Skipping worktree removal for ${subPath} \u2014 gitdir does not point to a worktree`
                          );
                          continue;
                        }
                        const repoGitDir = worktreeGitDir.replace(/\/\.git\/worktrees\/.*$/, "");
                        if (!repoGitDir.startsWith(basePath)) {
                          logger.warn(
                            `[Workspace] Skipping worktree removal for ${subPath} \u2014 parent repo ${repoGitDir} is outside workspace`
                          );
                          continue;
                        }
                        await commandExecutor.execute(
                          `git -C ${shellEscape(repoGitDir)} worktree remove ${shellEscape(subPath)} --force`,
                          { timeout: 1e4 }
                        );
                      }
                    } catch {
                    }
                  }
                } catch {
                }
                await fsp.rm(dirPath, { recursive: true, force: true });
                cleaned++;
              }
            } catch {
            }
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
      async resolveUpstreamRef() {
        const esc = shellEscape(this.originalPath);
        const symbolicResult = await commandExecutor.execute(
          `git -C ${esc} symbolic-ref refs/remotes/origin/HEAD 2>/dev/null`,
          { timeout: 1e4 }
        );
        if (symbolicResult.exitCode === 0 && symbolicResult.stdout.trim()) {
          const ref = symbolicResult.stdout.trim().replace("refs/remotes/", "");
          logger.debug(`[Workspace] Resolved upstream default branch via origin/HEAD: ${ref}`);
          return ref;
        }
        const mainResult = await commandExecutor.execute(
          `git -C ${esc} rev-parse --verify origin/main 2>/dev/null`,
          { timeout: 1e4 }
        );
        if (mainResult.exitCode === 0) {
          logger.debug(`[Workspace] Using origin/main as upstream ref`);
          return "origin/main";
        }
        const masterResult = await commandExecutor.execute(
          `git -C ${esc} rev-parse --verify origin/master 2>/dev/null`,
          { timeout: 1e4 }
        );
        if (masterResult.exitCode === 0) {
          logger.debug(`[Workspace] Using origin/master as upstream ref`);
          return "origin/master";
        }
        logger.warn(`[Workspace] No upstream remote found, falling back to local HEAD`);
        return "HEAD";
      }
      /**
       * Fetch latest from origin, resolve the upstream default branch, and return
       * both the ref name and the resolved commit SHA.
       */
      async fetchAndResolveUpstream() {
        logger.debug(`[Workspace] Fetching latest from origin`);
        const pruneFlag = this.getBranchCleanupPolicy().policy === "owned-only" ? " --prune" : " --no-prune";
        const fetchResult = await commandExecutor.execute(
          `git -C ${shellEscape(this.originalPath)} fetch origin${pruneFlag} 2>&1`,
          { timeout: 12e4 }
        );
        if (fetchResult.exitCode !== 0) {
          logger.warn(`[Workspace] fetch origin failed (will use cached refs): ${fetchResult.stderr}`);
        }
        const upstreamRef = await this.resolveUpstreamRef();
        const shaResult = await commandExecutor.execute(
          `git -C ${shellEscape(this.originalPath)} rev-parse ${shellEscape(upstreamRef)}`,
          { timeout: 1e4 }
        );
        if (shaResult.exitCode === 0) {
          return { upstreamRef, targetSha: shaResult.stdout.trim() };
        }
        logger.warn(
          `[Workspace] Could not resolve ${upstreamRef} (${shaResult.stderr.trim()}), falling back to HEAD`
        );
        const headResult = await commandExecutor.execute(
          `git -C ${shellEscape(this.originalPath)} rev-parse HEAD`,
          { timeout: 1e4 }
        );
        if (headResult.exitCode !== 0) {
          throw new Error(`Repository has no commits \u2014 cannot create worktree: ${headResult.stderr}`);
        }
        return { upstreamRef: "HEAD", targetSha: headResult.stdout.trim() };
      }
      /** Effective branch cleanup policy (instance override > process-wide policy). */
      getBranchCleanupPolicy() {
        if (this.config.branchCleanup) {
          return { policy: this.config.branchCleanup, reason: "workspace config" };
        }
        return getWorkspaceBranchCleanupPolicy();
      }
      /**
       * Remove stale worktree entries that VISOR created (their path is under the
       * workspace base path and no longer exists). Unlike a repo-wide
       * `git worktree prune`, this never touches the user's own worktrees (e.g. on
       * an unmounted drive).
       */
      async pruneOwnStaleWorktrees() {
        const list = await commandExecutor.execute(
          `git -C ${shellEscape(this.originalPath)} worktree list --porcelain`,
          { timeout: 15e3 }
        );
        if (list.exitCode !== 0) return;
        const bases = /* @__PURE__ */ new Set([path.resolve(this.basePath)]);
        try {
          bases.add(fs.realpathSync(this.basePath));
        } catch {
        }
        const isUnderBase = (p) => [...bases].some((b) => p === b || p.startsWith(b.endsWith(path.sep) ? b : b + path.sep));
        let current = null;
        for (const line of list.stdout.split("\n")) {
          if (line.startsWith("worktree ")) {
            current = line.slice("worktree ".length).trim();
          } else if (line.startsWith("prunable") && current && isUnderBase(current)) {
            await commandExecutor.execute(
              `git -C ${shellEscape(this.originalPath)} worktree remove --force ${shellEscape(current)}`,
              { timeout: 1e4 }
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
      async resetAndCleanWorktree(worktreePath, targetSha) {
        const escapedPath = shellEscape(worktreePath);
        const escapedSha = shellEscape(targetSha);
        const attachedBranch = await this.getCheckedOutBranch(worktreePath);
        if (attachedBranch) {
          await commandExecutor.execute(`git -C ${escapedPath} checkout --detach`, {
            timeout: 3e4
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
          { timeout: 1e4 }
        );
        if (resetResult.exitCode !== 0) {
          logger.warn(`[Workspace] reset --hard failed: ${resetResult.stderr}`);
        }
        const cleanResult = await commandExecutor.execute(`git -C ${escapedPath} clean -fdx`, {
          timeout: 3e4
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
      async getLinkedWorktreeGitDir(worktreePath) {
        const result = await commandExecutor.execute(
          `git -C ${shellEscape(worktreePath)} rev-parse --absolute-git-dir`,
          { timeout: 5e3 }
        );
        if (result.exitCode !== 0) return null;
        const gitDir = result.stdout.trim();
        if (!gitDir || !/[\\/]worktrees[\\/][^\\/]+$/.test(gitDir)) return null;
        return gitDir;
      }
      /** All local branch names (shared namespace of the repo and all its worktrees). */
      async listLocalBranches(repoPath) {
        const result = await commandExecutor.execute(
          `git -C ${shellEscape(repoPath)} for-each-ref --format='%(refname:short)' refs/heads`,
          { timeout: 1e4 }
        );
        if (result.exitCode !== 0) return null;
        return result.stdout.split("\n").map((b) => b.trim()).filter((b) => b.length > 0);
      }
      /**
       * Snapshot the branches that exist right now, so a later cleanup can tell
       * branches created inside Visor's worktree apart from the user's own branches.
       */
      async recordBranchBaseline(worktreePath) {
        try {
          const gitDir = await this.getLinkedWorktreeGitDir(worktreePath);
          if (!gitDir) return;
          const branches = await this.listLocalBranches(worktreePath);
          if (!branches) return;
          const baseline = {
            recordedAt: Math.floor(Date.now() / 1e3),
            branches
          };
          await fsp.writeFile(path.join(gitDir, BRANCH_BASELINE_FILE), JSON.stringify(baseline));
        } catch (error) {
          logger.debug(`[Workspace] Could not record branch baseline: ${error}`);
        }
      }
      async readBranchBaseline(worktreePath) {
        try {
          const gitDir = await this.getLinkedWorktreeGitDir(worktreePath);
          if (!gitDir) return null;
          const raw = await fsp.readFile(path.join(gitDir, BRANCH_BASELINE_FILE), "utf8");
          const parsed = JSON.parse(raw);
          if (typeof parsed?.recordedAt !== "number" || !Array.isArray(parsed?.branches)) return null;
          return parsed;
        } catch {
          return null;
        }
      }
      /** Branch currently checked out in the worktree, or null when HEAD is detached. */
      async getCheckedOutBranch(worktreePath) {
        const result = await commandExecutor.execute(
          `git -C ${shellEscape(worktreePath)} symbolic-ref -q --short HEAD`,
          { timeout: 5e3 }
        );
        if (result.exitCode !== 0) return null;
        return result.stdout.trim() || null;
      }
      /**
       * Branch names that were checked out IN THIS WORKTREE since `sinceEpoch`,
       * read from the worktree's private HEAD reflog (`git checkout -b`/`switch -c`
       * inside Visor's worktree is recorded there, never in the user's own HEAD log).
       */
      async branchesCheckedOutInWorktreeSince(worktreePath, sinceEpoch) {
        const names = /* @__PURE__ */ new Set();
        const result = await commandExecutor.execute(
          `git -C ${shellEscape(worktreePath)} reflog show --date=unix --format='%gd%x09%gs' HEAD`,
          { timeout: 1e4 }
        );
        if (result.exitCode !== 0) return names;
        for (const line of result.stdout.split("\n")) {
          const [selector, subject] = line.split("	");
          const ts = Number(/@\{(\d+)\}$/.exec(selector || "")?.[1]);
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
      async deleteBranchesCreatedInWorktree(worktreePath, headBranchBeforeReset) {
        const { policy, reason } = this.getBranchCleanupPolicy();
        if (policy !== "owned-only") {
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
        const protectedBranches = new Set(baseline.branches);
        const worktreeListResult = await commandExecutor.execute(
          `git -C ${shellEscape(worktreePath)} worktree list --porcelain`,
          { timeout: 1e4 }
        );
        if (worktreeListResult.exitCode !== 0) {
          logger.debug("[Workspace] worktree list failed; not deleting any branch");
          return;
        }
        for (const line of worktreeListResult.stdout.split("\n")) {
          const match = line.match(/^branch refs\/heads\/(.+)$/);
          if (match) protectedBranches.add(match[1]);
        }
        for (const branch of existing) {
          if (!touched.has(branch) || protectedBranches.has(branch)) continue;
          const deleteResult = await commandExecutor.execute(
            `git -C ${shellEscape(worktreePath)} branch -D ${shellEscape(branch)}`,
            { timeout: 1e4 }
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
      async refreshWorktreeToUpstream(worktreePath) {
        logger.info(`[Workspace] Refreshing worktree to latest upstream: ${worktreePath}`);
        try {
          const headBranchBeforeReset = await this.getCheckedOutBranch(worktreePath);
          const { upstreamRef, targetSha } = await this.fetchAndResolveUpstream();
          const checkoutResult = await commandExecutor.execute(
            `git -C ${shellEscape(worktreePath)} checkout --detach ${shellEscape(targetSha)}`,
            { timeout: 3e4 }
          );
          if (checkoutResult.exitCode !== 0) {
            logger.warn(
              `[Workspace] checkout --detach failed (worktree stays at current commit): ${checkoutResult.stderr}`
            );
            await this.resetAndCleanWorktree(worktreePath, "HEAD");
            return;
          }
          await this.resetAndCleanWorktree(worktreePath, targetSha);
          await this.deleteBranchesCreatedInWorktree(worktreePath, headBranchBeforeReset);
          await this.recordBranchBaseline(worktreePath);
          logger.info(`[Workspace] Worktree updated to ${upstreamRef} (${targetSha.slice(0, 8)})`);
        } catch (error) {
          logger.warn(`[Workspace] Failed to refresh worktree (continuing with stale state): ${error}`);
        }
      }
      /**
       * Create worktree for the main project.
       * See visor-disable comment above resolveUpstreamRef for why this doesn't use WorktreeManager.
       */
      async createMainProjectWorktree(targetPath) {
        logger.debug(`Creating main project worktree: ${targetPath}`);
        const { upstreamRef, targetSha } = await this.fetchAndResolveUpstream();
        const createCmd = `git -C ${shellEscape(this.originalPath)} worktree add --detach ${shellEscape(targetPath)} ${shellEscape(targetSha)}`;
        const result = await commandExecutor.execute(createCmd, { timeout: 6e4 });
        if (result.exitCode !== 0) {
          throw new Error(`Failed to create main project worktree: ${result.stderr}`);
        }
        await this.resetAndCleanWorktree(targetPath, targetSha);
        await this.recordBranchBaseline(targetPath);
        logger.info(
          `Created main project worktree at ${targetPath} (${upstreamRef} -> ${targetSha.slice(0, 8)})`
        );
      }
      /**
       * Remove main project worktree
       */
      async removeMainProjectWorktree(worktreePath) {
        logger.debug(`Removing main project worktree: ${worktreePath}`);
        const removeCmd = `git -C ${shellEscape(this.originalPath)} worktree remove ${shellEscape(worktreePath)} --force`;
        const result = await commandExecutor.execute(removeCmd, { timeout: 3e4 });
        if (result.exitCode !== 0) {
          logger.warn(`Failed to remove worktree via git: ${result.stderr}`);
        }
      }
      /**
       * Check if a path is a git repository
       */
      async isGitRepository(dirPath) {
        try {
          const result = await commandExecutor.execute(
            `git -C ${shellEscape(dirPath)} rev-parse --git-dir`,
            {
              timeout: 5e3
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
      extractProjectName(dirPath) {
        return path.basename(dirPath);
      }
      /**
       * Extract repository name from owner/repo format
       */
      extractRepoName(repository) {
        if (repository.includes("://") || repository.startsWith("git@")) {
          const match = repository.match(/[/:]([^/:]+\/[^/:]+?)(?:\.git)?$/);
          if (match) {
            return match[1].split("/").pop() || repository;
          }
        }
        if (repository.includes("/")) {
          return repository.split("/").pop() || repository;
        }
        return repository;
      }
      /**
       * Get a unique name by appending a number if needed
       */
      getUniqueName(baseName) {
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
      registerCleanupHandlers() {
        if (this.cleanupHandlersRegistered || !this.config.cleanupOnExit) {
          return;
        }
        this.cleanupHandlersRegistered = true;
      }
    };
  }
});

export {
  setWorkspaceBranchCleanupPolicy,
  getWorkspaceBranchCleanupPolicy,
  WorkspaceManager,
  init_workspace_manager
};
//# sourceMappingURL=chunk-4EA7TOUV.mjs.map