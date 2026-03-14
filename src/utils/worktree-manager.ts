/**
 * Git Worktree Manager
 *
 * Manages git worktrees for efficient multi-workflow execution.
 * Uses a bare repository cache to share git objects between worktrees.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { commandExecutor } from './command-executor';
import { logger } from '../logger';
import type {
  WorktreeMetadata,
  WorktreeCacheConfig,
  WorktreeInfo,
  GitCommandResult,
} from '../types/git-checkout';

export class WorktreeManager {
  private static instance: WorktreeManager;
  private config: WorktreeCacheConfig;
  private activeWorktrees: Map<string, WorktreeMetadata>;
  private cleanupHandlersRegistered: boolean = false;

  private constructor() {
    // Default configuration - use project-local .visor/worktrees/ by default
    // Handle test environment where process.cwd() may be undefined or return undefined
    let cwd: string;
    try {
      cwd = process.cwd() || '/tmp';
    } catch {
      cwd = '/tmp';
    }
    const defaultBasePath =
      process.env.VISOR_WORKTREE_PATH || path.join(cwd, '.visor', 'worktrees');

    this.config = {
      enabled: true,
      base_path: defaultBasePath,
      cleanup_on_exit: true,
      max_age_hours: 24,
    };
    this.activeWorktrees = new Map();
    this.ensureDirectories();
    this.registerCleanupHandlers();
  }

  static getInstance(): WorktreeManager {
    if (!WorktreeManager.instance) {
      WorktreeManager.instance = new WorktreeManager();
    }
    return WorktreeManager.instance;
  }

  /**
   * Update configuration
   */
  configure(config: Partial<WorktreeCacheConfig>): void {
    this.config = { ...this.config, ...config };
    this.ensureDirectories();
  }

  getConfig(): WorktreeCacheConfig {
    return { ...this.config };
  }

  /**
   * Ensure base directories exist
   */
  private ensureDirectories(): void {
    // Skip directory creation if base_path is not properly initialized
    // (can happen in test environments)
    if (!this.config.base_path) {
      logger.debug('Skipping directory creation: base_path not initialized');
      return;
    }

    const reposDir = this.getReposDir();
    const worktreesDir = this.getWorktreesDir();

    if (!fs.existsSync(reposDir)) {
      fs.mkdirSync(reposDir, { recursive: true });
      logger.debug(`Created repos directory: ${reposDir}`);
    }

    if (!fs.existsSync(worktreesDir)) {
      fs.mkdirSync(worktreesDir, { recursive: true });
      logger.debug(`Created worktrees directory: ${worktreesDir}`);
    }
  }

  private getReposDir(): string {
    return path.join(this.config.base_path, 'repos');
  }

  private getWorktreesDir(): string {
    return path.join(this.config.base_path, 'worktrees');
  }

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
  private generateWorktreeId(repository: string, ref: string, sessionId?: string): string {
    const sanitizedRepo = repository.replace(/[^a-zA-Z0-9-]/g, '-');
    const sanitizedRef = ref.replace(/[^a-zA-Z0-9-]/g, '-');
    const hashInput = sessionId ? `${repository}:${ref}:${sessionId}` : `${repository}:${ref}`;
    const hash = crypto.createHash('md5').update(hashInput).digest('hex').substring(0, 8);
    return `${sanitizedRepo}-${sanitizedRef}-${hash}`;
  }

  /**
   * Get or create bare repository
   */
  async getOrCreateBareRepo(
    repository: string,
    repoUrl: string,
    _token?: string,
    fetchDepth?: number,
    cloneTimeoutMs?: number
  ): Promise<string> {
    const reposDir = this.getReposDir();
    const repoName = repository.replace(/\//g, '-');
    const bareRepoPath = path.join(reposDir, `${repoName}.git`);

    // Check if bare repo exists
    if (fs.existsSync(bareRepoPath)) {
      logger.debug(`Bare repository already exists: ${bareRepoPath}`);

      // Verify the bare repo has the correct remote URL to prevent using corrupted repos
      const verifyResult = await this.verifyBareRepoRemote(bareRepoPath, repoUrl);
      if (verifyResult === 'timeout') {
        // Timeout during verification — still try to update refs so we don't serve stale data
        logger.warn(`Bare repo verification timed out, attempting ref update: ${bareRepoPath}`);
        await this.updateBareRepo(bareRepoPath);
        return bareRepoPath;
      } else if (verifyResult === false) {
        logger.warn(
          `Bare repository at ${bareRepoPath} has incorrect remote, removing and re-cloning`
        );
        await fsp.rm(bareRepoPath, { recursive: true, force: true });
        // Fall through to clone below
      } else {
        // Refresh the remote URL with the current token so that fetch/push
        // use valid credentials. The bare repo may have been cloned with a
        // token that has since expired (GitHub App installation tokens live
        // only 1 hour). Without this, git operations inside worktrees
        // derived from this bare repo will fail with "Authentication failed".
        // If the bare repo was cloned with a token embedded in the URL,
        // reset it to the plain URL so git uses GIT_CONFIG insteadOf rules
        // for auth (which always have the freshest token).
        await this.resetBareRepoRemoteUrl(bareRepoPath, repoUrl);
        // Update remote refs
        await this.updateBareRepo(bareRepoPath);
        return bareRepoPath;
      }
    }

    // Clone as bare repository — use the plain URL, not buildAuthenticatedUrl().
    // Auth is handled by GIT_CONFIG insteadOf rules (set by injectGitHubCredentials),
    // which keeps the stored origin URL token-free. This prevents stale tokens from
    // being baked into the bare repo's remote config.
    const cloneUrl = repoUrl;
    const redactedUrl = this.redactUrl(cloneUrl);

    logger.info(
      `Cloning bare repository: ${redactedUrl}${fetchDepth ? ` (depth: ${fetchDepth})` : ''}`
    );

    // Build clone command with optional depth
    let cloneCmd = `git clone --bare`;
    if (fetchDepth && fetchDepth > 0) {
      const depth = parseInt(String(fetchDepth), 10);
      if (isNaN(depth) || depth < 1) {
        throw new Error('fetch_depth must be a positive integer');
      }
      cloneCmd += ` --depth ${depth}`;
    }
    cloneCmd += ` ${this.escapeShellArg(cloneUrl)} ${this.escapeShellArg(bareRepoPath)}`;

    const result = await this.executeGitCommand(cloneCmd, {
      timeout: cloneTimeoutMs || 300000, // default 5 minutes
    });

    if (result.exitCode !== 0) {
      // Redact tokens from error messages
      const redactedStderr = this.redactUrl(result.stderr);
      throw new Error(`Failed to clone bare repository: ${redactedStderr}`);
    }

    logger.info(`Successfully cloned bare repository to ${bareRepoPath}`);
    return bareRepoPath;
  }

  /**
   * Update bare repository refs.
   *
   * Retries once on failure to handle transient network issues.
   * If the bare repo is shallow, unshallow it first so that branch-tip
   * fetches always succeed.
   */
  private async updateBareRepo(bareRepoPath: string): Promise<void> {
    logger.debug(`Updating bare repository: ${bareRepoPath}`);

    // Unshallow if this is a shallow bare clone — shallow repos can't
    // reliably fetch branch tips that are outside the original depth.
    try {
      const isShallowCmd = `git -C ${this.escapeShellArg(bareRepoPath)} rev-parse --is-shallow-repository`;
      const isShallowResult = await this.executeGitCommand(isShallowCmd, { timeout: 10000 });
      if (isShallowResult.exitCode === 0 && isShallowResult.stdout.trim() === 'true') {
        logger.info(`Unshallowing bare repository to ensure fresh refs: ${bareRepoPath}`);
        const unshallowCmd = `git -C ${this.escapeShellArg(bareRepoPath)} fetch --unshallow origin`;
        await this.executeGitCommand(unshallowCmd, { timeout: 120000 });
      }
    } catch (error) {
      // Non-fatal: if unshallow fails we still try the normal update
      logger.debug(`Unshallow attempt failed (non-fatal): ${error}`);
    }

    // Try up to 2 attempts for the remote update
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const updateCmd = `git -C ${this.escapeShellArg(bareRepoPath)} fetch --all --prune --force`;
        const result = await this.executeGitCommand(updateCmd, { timeout: 90000 });

        if (result.exitCode === 0) {
          logger.debug(`Successfully updated bare repository`);
          return;
        }

        logger.warn(`Bare repo update attempt ${attempt}/2 failed: ${result.stderr}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(`Bare repo update attempt ${attempt}/2 error: ${errorMessage}`);
      }

      if (attempt < 2) {
        // Brief pause before retry
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Both attempts failed — log a warning but don't throw.
    // fetchRef() will also try to fetch the specific ref, giving another chance.
    logger.warn(`Failed to update bare repository after 2 attempts (will rely on per-ref fetch)`);
  }

  /**
   * Verify that a bare repository has the correct remote URL.
   * This prevents reusing corrupted repos that were cloned from a different repository.
   * Returns: true (valid), false (invalid - should re-clone), or 'timeout' (use stale cache)
   */
  private async verifyBareRepoRemote(
    bareRepoPath: string,
    expectedUrl: string
  ): Promise<boolean | 'timeout'> {
    try {
      const cmd = `git -C ${this.escapeShellArg(bareRepoPath)} remote get-url origin`;
      const result = await this.executeGitCommand(cmd, { timeout: 10000 });

      if (result.exitCode !== 0) {
        logger.warn(`Failed to get remote URL for ${bareRepoPath}: ${result.stderr}`);
        return false;
      }

      const actualUrl = result.stdout.trim();

      // Normalize URLs for comparison:
      // - remove credentials (tokens/username)
      // - remove .git suffix if present
      // - trim trailing slash
      // - lowercase for case‑insensitive match
      const normalizeUrl = (url: string): string => {
        // Convert common SSH form to https for comparison
        if (url.startsWith('git@github.com:')) {
          url = url.replace('git@github.com:', 'https://github.com/');
        }
        return (
          url
            // strip userinfo part to avoid mismatches when the cached bare
            // repo was cloned with an access token but the expected URL is
            // tokenless (or vice‑versa)
            .replace(/:\/\/[^@]+@/, '://')
            .replace(/\.git$/, '')
            .replace(/\/$/, '')
            .toLowerCase()
        );
      };

      const normalizedExpected = normalizeUrl(expectedUrl);
      const normalizedActual = normalizeUrl(actualUrl);

      if (normalizedExpected !== normalizedActual) {
        logger.warn(`Bare repo remote mismatch: expected ${expectedUrl}, got ${actualUrl}`);
        return false;
      }

      logger.debug(`Bare repo remote verified: ${actualUrl}`);
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // If it's a timeout, return 'timeout' so caller can use stale cache instead of re-cloning
      if (errorMessage.includes('timed out')) {
        logger.warn(`Timeout verifying bare repo remote (will use stale cache): ${errorMessage}`);
        return 'timeout';
      }
      logger.warn(`Error verifying bare repo remote: ${error}`);
      return false;
    }
  }

  /**
   * Ensure the origin remote URL of a bare repo is a plain URL (no embedded token).
   *
   * Older bare repos may have been cloned with a token in the URL
   * (https://x-access-token:TOKEN@github.com/...). This causes stale-token
   * failures because GIT_CONFIG insteadOf rules can't rewrite URLs that
   * already have credentials. Resetting to the plain URL lets insteadOf
   * handle auth with the freshest token.
   */
  private async resetBareRepoRemoteUrl(bareRepoPath: string, plainRepoUrl: string): Promise<void> {
    try {
      const cmd = `git -C ${this.escapeShellArg(bareRepoPath)} remote set-url origin ${this.escapeShellArg(plainRepoUrl)}`;
      const result = await this.executeGitCommand(cmd, { timeout: 10000 });
      if (result.exitCode !== 0) {
        logger.warn(
          `Failed to reset bare repo remote URL: ${result.stderr}. ` +
            'Git operations may fail with stale token if the URL has embedded credentials.'
        );
      } else {
        logger.debug(`Reset bare repo remote URL to plain URL for ${bareRepoPath}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(
        `Error resetting bare repo remote URL: ${msg}. ` +
          'Git operations may fail with stale token if the URL has embedded credentials.'
      );
    }
  }

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
  async createWorktree(
    repository: string,
    repoUrl: string,
    ref: string,
    options: {
      token?: string;
      workingDirectory?: string;
      clean?: boolean;
      workflowId?: string;
      sessionId?: string;
      fetchDepth?: number;
      cloneTimeoutMs?: number;
    } = {}
  ): Promise<WorktreeInfo> {
    // Validate ref to prevent command injection
    this.validateRef(ref);

    // Get or create bare repository
    const bareRepoPath = await this.getOrCreateBareRepo(
      repository,
      repoUrl,
      options.token,
      options.fetchDepth,
      options.cloneTimeoutMs
    );

    // Generate worktree ID and path — scoped by sessionId for cross-run isolation
    const worktreeId = this.generateWorktreeId(repository, ref, options.sessionId);
    let worktreePath = options.workingDirectory || path.join(this.getWorktreesDir(), worktreeId);

    // Validate path if user-provided
    if (options.workingDirectory) {
      worktreePath = this.validatePath(options.workingDirectory);
    }

    // Flag: set to true when a stale worktree for a common branch (main/master)
    // fails to refresh — triggers removal + fresh creation instead of serving stale data
    let refreshFailedNeedsRecreate = false;

    // Check if worktree already exists
    if (fs.existsSync(worktreePath)) {
      logger.debug(`Worktree already exists: ${worktreePath}`);

      // Load existing metadata
      const metadata = await this.loadMetadata(worktreePath);
      if (metadata) {
        // Check if the requested ref matches the existing ref
        if (metadata.ref === ref) {
          // Same ref - refresh commit in case the branch moved
          try {
            const bareRepoPath =
              metadata.bare_repo_path ||
              (await this.getOrCreateBareRepo(
                repository,
                repoUrl,
                options.token,
                options.fetchDepth,
                options.cloneTimeoutMs
              ));
            const fetched = await this.fetchRef(bareRepoPath, ref);
            if (fetched) {
              const latestCommit = await this.getCommitShaForRef(bareRepoPath, ref);
              if (latestCommit && latestCommit !== metadata.commit) {
                logger.info(
                  `Worktree ref ${ref} advanced (${metadata.commit} -> ${latestCommit}), updating...`
                );
                const checkoutCmd = `git -C ${this.escapeShellArg(worktreePath)} checkout --detach ${this.escapeShellArg(latestCommit)}`;
                const checkoutResult = await this.executeGitCommand(checkoutCmd, {
                  timeout: 60000,
                });
                if (checkoutResult.exitCode !== 0) {
                  throw new Error(`Failed to checkout updated ref: ${checkoutResult.stderr}`);
                }

                const updatedMetadata: WorktreeMetadata = {
                  ...metadata,
                  commit: latestCommit,
                  created_at: new Date().toISOString(),
                };
                await this.saveMetadata(worktreePath, updatedMetadata);
                if (options.clean) {
                  logger.debug(`Cleaning updated worktree`);
                  await this.cleanWorktree(worktreePath, latestCommit);
                }
                this.activeWorktrees.set(worktreeId, updatedMetadata);
                return {
                  id: worktreeId,
                  path: worktreePath,
                  ref: updatedMetadata.ref,
                  commit: updatedMetadata.commit,
                  metadata: updatedMetadata,
                  locked: false,
                };
              }
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const commonBranches = ['main', 'master', 'develop', 'dev'];
            if (commonBranches.includes(ref)) {
              logger.error(
                `Failed to refresh worktree for default branch '${ref}': ${errorMessage}. ` +
                  `Refusing to serve stale worktree — removing and re-creating.`
              );
              // Remove stale worktree and fall through to create a fresh one below
              try {
                const rmCmd = `git -C ${this.escapeShellArg(bareRepoPath)} worktree remove ${this.escapeShellArg(worktreePath)} --force`;
                await this.executeGitCommand(rmCmd, { timeout: 30000 });
                await fsp.rm(worktreePath, { recursive: true, force: true });
              } catch (rmErr) {
                logger.debug(`Cleanup of stale worktree failed: ${rmErr}`);
              }
              // Don't return — fall through to "create new worktree" at end of method
              refreshFailedNeedsRecreate = true;
            } else {
              logger.warn(`Failed to refresh worktree, will reuse existing: ${errorMessage}`);
            }
          }

          if (!refreshFailedNeedsRecreate) {
            // Same ref - reuse existing worktree (already up to date or refresh failed)
            if (options.clean) {
              logger.debug(`Cleaning existing worktree`);
              await this.cleanWorktree(worktreePath, metadata.commit);
            }
            this.activeWorktrees.set(worktreeId, metadata);
            return {
              id: worktreeId,
              path: worktreePath,
              ref: metadata.ref,
              commit: metadata.commit,
              metadata,
              locked: false,
            };
          }
        } else {
          // Different ref requested - update the worktree to the new ref
          logger.info(
            `Worktree exists with different ref (${metadata.ref} -> ${ref}), updating...`
          );

          try {
            // Get or ensure bare repo exists
            const bareRepoPath =
              metadata.bare_repo_path ||
              (await this.getOrCreateBareRepo(
                repository,
                repoUrl,
                options.token,
                options.fetchDepth,
                options.cloneTimeoutMs
              ));

            // Fetch the new ref and get its commit SHA
            const fetched = await this.fetchRef(bareRepoPath, ref);
            const newCommit = await this.getCommitShaForRef(bareRepoPath, ref);
            if (!fetched) {
              logger.warn(`Using cached ref ${ref} for update; fetch failed`);
            }

            // Checkout the new commit in the worktree (detached HEAD)
            const checkoutCmd = `git -C ${this.escapeShellArg(worktreePath)} checkout --detach ${this.escapeShellArg(newCommit)}`;
            const checkoutResult = await this.executeGitCommand(checkoutCmd, { timeout: 60000 });

            if (checkoutResult.exitCode !== 0) {
              throw new Error(`Failed to checkout new ref: ${checkoutResult.stderr}`);
            }

            // Update metadata with new ref/commit
            const updatedMetadata: WorktreeMetadata = {
              ...metadata,
              ref,
              commit: newCommit,
              created_at: new Date().toISOString(),
            };

            await this.saveMetadata(worktreePath, updatedMetadata);

            if (options.clean) {
              logger.debug(`Cleaning updated worktree`);
              await this.cleanWorktree(worktreePath, newCommit);
            }

            this.activeWorktrees.set(worktreeId, updatedMetadata);
            logger.info(`Successfully updated worktree to ${ref} (${newCommit})`);

            return {
              id: worktreeId,
              path: worktreePath,
              ref,
              commit: newCommit,
              metadata: updatedMetadata,
              locked: false,
            };
          } catch (error) {
            // If update fails, remove and recreate
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.warn(`Failed to update worktree, will recreate: ${errorMessage}`);
            await fsp.rm(worktreePath, { recursive: true, force: true });
            // Fall through to create new worktree below
          }
        }
      } else {
        // Directory exists but is not a valid worktree (no metadata)
        // Remove it so we can create a fresh worktree
        logger.info(`Removing stale directory (no metadata): ${worktreePath}`);
        await fsp.rm(worktreePath, { recursive: true, force: true });
      }
    }

    // Fetch the ref if needed, then resolve it to a concrete commit SHA.
    // We use the commit (detached HEAD) instead of the branch name so we
    // can have multiple worktrees for the same branch without git refusing
    // with "branch X is already checked out".
    const fetched = await this.fetchRef(bareRepoPath, ref);
    if (!fetched) {
      const commonBranches = ['main', 'master', 'develop', 'dev'];
      if (commonBranches.includes(ref)) {
        logger.warn(
          `Failed to fetch latest '${ref}' — will attempt to use cached ref. ` +
            `Check network connectivity and repository access.`
        );
      } else {
        logger.warn(`Using cached ref ${ref}; fetch failed (non-default branch, proceeding)`);
      }
    }
    const commit = await this.getCommitShaForRef(bareRepoPath, ref);

    // Prune stale worktree entries before creating a new one.
    // This handles the case where a worktree directory was manually deleted
    // but git still has it registered in its metadata.
    await this.pruneWorktrees(bareRepoPath);

    // Create worktree in detached HEAD state at the resolved commit
    logger.info(`Creating worktree for ${repository}@${ref} (${commit})`);
    const createCmd = `git -C ${this.escapeShellArg(
      bareRepoPath
    )} worktree add --detach ${this.escapeShellArg(worktreePath)} ${this.escapeShellArg(commit)}`;
    const result = await this.executeGitCommand(createCmd, { timeout: 60000 });

    if (result.exitCode !== 0) {
      throw new Error(`Failed to create worktree: ${result.stderr}`);
    }

    // Create metadata
    const metadata: WorktreeMetadata = {
      worktree_id: worktreeId,
      created_at: new Date().toISOString(),
      workflow_id: options.workflowId,
      ref,
      commit,
      repository,
      pid: process.pid,
      cleanup_on_exit: true,
      bare_repo_path: bareRepoPath,
      worktree_path: worktreePath,
    };

    // Save metadata
    await this.saveMetadata(worktreePath, metadata);

    // Track active worktree
    this.activeWorktrees.set(worktreeId, metadata);

    logger.info(`Successfully created worktree: ${worktreePath}`);

    return {
      id: worktreeId,
      path: worktreePath,
      ref,
      commit,
      metadata,
      locked: false,
    };
  }

  /**
   * Prune stale worktree entries from a bare repository.
   * This removes entries for worktrees whose directories no longer exist.
   */
  private async pruneWorktrees(bareRepoPath: string): Promise<void> {
    logger.debug(`Pruning stale worktrees for ${bareRepoPath}`);
    const pruneCmd = `git -C ${this.escapeShellArg(bareRepoPath)} worktree prune`;
    const result = await this.executeGitCommand(pruneCmd, { timeout: 10000 });

    if (result.exitCode !== 0) {
      logger.warn(`Failed to prune worktrees: ${result.stderr}`);
      // Don't throw - we can try to continue anyway
    } else {
      logger.debug(`Successfully pruned stale worktrees`);
    }
  }

  /**
   * Fetch a specific ref in bare repository.
   *
   * Uses --force to overwrite local refs that may have diverged (e.g. after
   * a force-push on main). Retries once on failure.
   */
  private async fetchRef(bareRepoPath: string, ref: string): Promise<boolean> {
    // Validate ref (already validated in createWorktree, but double-check for safety)
    this.validateRef(ref);

    logger.debug(`Fetching ref: ${ref}`);

    for (let attempt = 1; attempt <= 2; attempt++) {
      // Fetch into refs/remotes/origin/<ref> instead of refs/heads/<ref>.
      // Using refs/heads/<ref> conflicts with worktrees: git refuses to update
      // a local branch that exists in any worktree's branch namespace, even when
      // the worktree is in detached HEAD mode.
      const fetchCmd = `git -C ${this.escapeShellArg(bareRepoPath)} fetch --force origin ${this.escapeShellArg(ref + ':refs/remotes/origin/' + ref)}`;
      const result = await this.executeGitCommand(fetchCmd, { timeout: 60000 });
      if (result.exitCode === 0) {
        return true;
      }

      logger.warn(
        `Failed to fetch ref ${ref} (attempt ${attempt}/2): ${result.stderr || result.stdout}`
      );
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    return false;
  }

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
  private async cleanWorktree(worktreePath: string, expectedCommit?: string): Promise<void> {
    if (expectedCommit) {
      // Force-checkout the expected commit in detached HEAD state.
      // This undoes any branch creation / checkout the AI might have done.
      const detachCmd = `git -C ${this.escapeShellArg(worktreePath)} checkout --detach ${this.escapeShellArg(expectedCommit)}`;
      const detachResult = await this.executeGitCommand(detachCmd, { timeout: 30000 });
      if (detachResult.exitCode !== 0) {
        // If checkout fails (e.g. merge conflicts), do a hard reset first then retry
        await this.executeGitCommand(`git -C ${this.escapeShellArg(worktreePath)} reset --hard`, {
          timeout: 10000,
        });
        await this.executeGitCommand(detachCmd, { timeout: 30000 });
      }
    }

    // Reset to HEAD (now correctly pointing to expected commit)
    const resetCmd = `git -C ${this.escapeShellArg(worktreePath)} reset --hard HEAD`;
    await this.executeGitCommand(resetCmd);

    // Clean untracked files
    const cleanCmd = `git -C ${this.escapeShellArg(worktreePath)} clean -fdx`;
    await this.executeGitCommand(cleanCmd);

    // Delete all local branches to prevent leakage between runs.
    // Worktrees should always be in detached HEAD state; any local branches
    // were created by AI agents or user commands and must not persist.
    await this.deleteLocalBranches(worktreePath);
  }

  /**
   * Delete local branches in a worktree that are safe to remove.
   * Worktrees are always used in detached HEAD state, so any local branches
   * were unintentionally created and should be cleaned up.
   * IMPORTANT: Git worktrees share the branch namespace with the main repo
   * and all other worktrees. We must NOT delete branches that are checked out
   * in the main working tree or any other worktree — doing so would destroy
   * the user's work.
   */
  private async deleteLocalBranches(worktreePath: string): Promise<void> {
    // First, discover which branches are checked out in ANY worktree (including main).
    // `git worktree list --porcelain` output contains "branch refs/heads/<name>" lines.
    const worktreeListCmd = `git -C ${this.escapeShellArg(worktreePath)} worktree list --porcelain`;
    const worktreeListResult = await this.executeGitCommand(worktreeListCmd, { timeout: 10000 });
    const protectedBranches = new Set<string>();
    if (worktreeListResult.exitCode === 0) {
      for (const line of worktreeListResult.stdout.split('\n')) {
        const match = line.match(/^branch refs\/heads\/(.+)$/);
        if (match) {
          protectedBranches.add(match[1]);
        }
      }
    }

    const listCmd = `git -C ${this.escapeShellArg(worktreePath)} branch --list --format='%(refname:short)'`;
    const listResult = await this.executeGitCommand(listCmd, { timeout: 10000 });
    if (listResult.exitCode !== 0 || !listResult.stdout.trim()) {
      return; // No branches or command failed — nothing to clean
    }

    const branches = listResult.stdout
      .trim()
      .split('\n')
      .map(b => b.trim())
      .filter(b => b.length > 0);

    for (const branch of branches) {
      if (protectedBranches.has(branch)) {
        logger.debug(`Skipping branch '${branch}' — checked out in another worktree`);
        continue;
      }
      const deleteCmd = `git -C ${this.escapeShellArg(worktreePath)} branch -D ${this.escapeShellArg(branch)}`;
      const deleteResult = await this.executeGitCommand(deleteCmd, { timeout: 10000 });
      if (deleteResult.exitCode === 0) {
        logger.debug(`Deleted local branch '${branch}' from worktree`);
      } else {
        logger.warn(`Failed to delete branch '${branch}': ${deleteResult.stderr}`);
      }
    }
  }

  /**
   * Get commit SHA for a given ref inside a bare repository.
   *
   * This runs after fetchRef so that <ref> should resolve to either a
   * local branch, tag, or remote-tracking ref.
   *
   * If the ref is "main" or "master" and doesn't exist, automatically
   * falls back to the other common default branch name.
   */
  private async getCommitShaForRef(bareRepoPath: string, ref: string): Promise<string> {
    // Prefer refs/remotes/origin/<ref> — that's where fetchRef writes.
    // Fall back to the bare ref name for tags, SHAs, and legacy local branches.
    const candidates = [`refs/remotes/origin/${ref}`, ref];

    for (const candidate of candidates) {
      const cmd = `git -C ${this.escapeShellArg(bareRepoPath)} rev-parse ${this.escapeShellArg(candidate)}`;
      const result = await this.executeGitCommand(cmd);
      if (result.exitCode === 0) {
        return result.stdout.trim();
      }
    }

    // If main/master doesn't exist, try the other common default branch
    const fallbackRefs: Record<string, string> = {
      main: 'master',
      master: 'main',
    };

    const fallbackRef = fallbackRefs[ref];
    if (fallbackRef) {
      logger.debug(`Ref '${ref}' not found, trying fallback '${fallbackRef}'`);

      // Fetch the fallback ref
      await this.fetchRef(bareRepoPath, fallbackRef);

      for (const candidate of [`refs/remotes/origin/${fallbackRef}`, fallbackRef]) {
        const cmd = `git -C ${this.escapeShellArg(bareRepoPath)} rev-parse ${this.escapeShellArg(candidate)}`;
        const result = await this.executeGitCommand(cmd);
        if (result.exitCode === 0) {
          logger.info(`Using fallback branch '${fallbackRef}' instead of '${ref}'`);
          return result.stdout.trim();
        }
      }
    }

    throw new Error(`Failed to get commit SHA for ref ${ref}`);
  }

  /**
   * Remove a worktree
   */
  async removeWorktree(worktreeId: string): Promise<void> {
    const metadata = this.activeWorktrees.get(worktreeId);

    if (!metadata) {
      logger.warn(`Worktree not found in active list: ${worktreeId}`);
      return;
    }

    const { bare_repo_path, worktree_path } = metadata;

    logger.info(`Removing worktree: ${worktree_path}`);

    // Remove worktree via git
    const removeCmd = `git -C ${this.escapeShellArg(bare_repo_path)} worktree remove ${this.escapeShellArg(worktree_path)} --force`;
    const result = await this.executeGitCommand(removeCmd, { timeout: 30000 });

    if (result.exitCode !== 0) {
      logger.warn(`Failed to remove worktree via git: ${result.stderr}`);

      // Fallback: manually remove directory
      if (fs.existsSync(worktree_path)) {
        logger.debug(`Manually removing worktree directory`);
        fs.rmSync(worktree_path, { recursive: true, force: true });
      }
    }

    // Clean up sibling metadata file
    const metadataPath = this.getMetadataPath(worktree_path);
    try {
      if (fs.existsSync(metadataPath)) {
        fs.unlinkSync(metadataPath);
      }
    } catch {
      // best-effort cleanup
    }

    // Remove from active list
    this.activeWorktrees.delete(worktreeId);

    logger.info(`Successfully removed worktree: ${worktreeId}`);
  }

  /**
   * Get the metadata file path for a worktree.
   * Stored as a sibling file OUTSIDE the worktree to avoid being committed
   * when agents run `git add .` inside the checked-out repo.
   */
  private getMetadataPath(worktreePath: string): string {
    return worktreePath.replace(/\/?$/, '') + '.metadata.json';
  }

  /**
   * Save worktree metadata
   */
  private async saveMetadata(worktreePath: string, metadata: WorktreeMetadata): Promise<void> {
    const metadataPath = this.getMetadataPath(worktreePath);
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
  }

  /**
   * Load worktree metadata
   */
  private async loadMetadata(worktreePath: string): Promise<WorktreeMetadata | null> {
    const metadataPath = this.getMetadataPath(worktreePath);

    // Also check legacy location (inside worktree) for backwards compatibility
    const legacyPath = path.join(worktreePath, '.visor-metadata.json');

    const pathToRead = fs.existsSync(metadataPath)
      ? metadataPath
      : fs.existsSync(legacyPath)
        ? legacyPath
        : null;

    if (!pathToRead) {
      return null;
    }

    try {
      const content = fs.readFileSync(pathToRead, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      logger.warn(`Failed to load metadata: ${error}`);
      return null;
    }
  }

  /**
   * List all worktrees
   */
  async listWorktrees(): Promise<WorktreeInfo[]> {
    const worktreesDir = this.getWorktreesDir();

    if (!fs.existsSync(worktreesDir)) {
      return [];
    }

    const entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
    const worktrees: WorktreeInfo[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const worktreePath = path.join(worktreesDir, entry.name);
      const metadata = await this.loadMetadata(worktreePath);

      if (metadata) {
        worktrees.push({
          id: metadata.worktree_id,
          path: worktreePath,
          ref: metadata.ref,
          commit: metadata.commit,
          metadata,
          locked: this.isProcessAlive(metadata.pid),
        });
      }
    }

    return worktrees;
  }

  /**
   * Cleanup stale worktrees
   */
  async cleanupStaleWorktrees(): Promise<void> {
    logger.debug('Cleaning up stale worktrees');

    const worktrees = await this.listWorktrees();
    const now = new Date();
    const maxAgeMs = this.config.max_age_hours * 60 * 60 * 1000;

    for (const worktree of worktrees) {
      const createdAt = new Date(worktree.metadata.created_at);
      const ageMs = now.getTime() - createdAt.getTime();

      // Skip if process is still alive
      if (worktree.locked) {
        continue;
      }

      // Remove if too old
      if (ageMs > maxAgeMs) {
        logger.info(
          `Removing stale worktree: ${worktree.id} (age: ${Math.round(ageMs / 1000 / 60)} minutes)`
        );
        await this.removeWorktree(worktree.id);
      }
    }
  }

  /**
   * Cleanup all worktrees for current process
   */
  async cleanupProcessWorktrees(): Promise<void> {
    logger.debug('Cleaning up worktrees for current process');

    const currentPid = process.pid;
    const worktrees = await this.listWorktrees();

    for (const worktree of worktrees) {
      if (worktree.metadata.pid === currentPid && worktree.metadata.cleanup_on_exit) {
        logger.info(`Cleaning up worktree: ${worktree.id}`);
        await this.removeWorktree(worktree.id);
      }
    }
  }

  /**
   * Check if a process is alive
   */
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (_error) {
      return false;
    }
  }

  /**
   * Register cleanup handlers
   */
  private registerCleanupHandlers(): void {
    if (this.cleanupHandlersRegistered) {
      return;
    }

    if (this.config.cleanup_on_exit) {
      // Cleanup on normal exit
      process.on('exit', () => {
        // Synchronous cleanup
        logger.debug('Process exiting, cleanup handler triggered');
      });

      // Cleanup on SIGINT (Ctrl+C)
      process.on('SIGINT', async () => {
        logger.info('SIGINT received, cleaning up worktrees');
        await this.cleanupProcessWorktrees();
        process.exit(130);
      });

      // Cleanup on SIGTERM
      process.on('SIGTERM', async () => {
        logger.info('SIGTERM received, cleaning up worktrees');
        await this.cleanupProcessWorktrees();
        process.exit(143);
      });

      // Cleanup on uncaught exception
      process.on('uncaughtException', async error => {
        logger.error(`Uncaught exception, cleaning up worktrees: ${error}`);
        await this.cleanupProcessWorktrees();
        process.exit(1);
      });
    }

    this.cleanupHandlersRegistered = true;
  }

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
  private escapeShellArg(arg: string): string {
    // POSIX shell escaping: wrap in single quotes, escape embedded single quotes
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }

  /**
   * Validate git ref to prevent command injection
   */
  private validateRef(ref: string): void {
    // Restrictive pattern for git refs in our use case
    // Allow: alphanumeric, dots, underscores, slashes, hyphens
    // Allow: colons for refspecs like "refs/pull/123/head:pr-123"
    // Disallow: @, ^, ~, and other special characters to minimize attack surface
    const safeRefPattern = /^[a-zA-Z0-9._/:-]+$/;

    if (!safeRefPattern.test(ref)) {
      throw new Error(
        `Invalid git ref: ${ref}. Refs must only contain alphanumeric characters, dots, underscores, slashes, colons, and hyphens.`
      );
    }

    // Additional checks for dangerous patterns
    if (ref.includes('..') || ref.startsWith('-') || ref.endsWith('.lock')) {
      throw new Error(
        `Invalid git ref: ${ref}. Refs cannot contain '..', start with '-', or end with '.lock'.`
      );
    }

    // Length check to prevent DoS
    if (ref.length > 256) {
      throw new Error(`Invalid git ref: ${ref}. Refs cannot exceed 256 characters.`);
    }
  }

  /**
   * Validate path to prevent directory traversal
   */
  private validatePath(userPath: string): string {
    const resolvedPath = path.resolve(userPath);

    // Ensure path is absolute and resolved
    // For working_directory, users can specify absolute paths outside base_path
    if (!path.isAbsolute(resolvedPath)) {
      throw new Error('Path must be absolute');
    }

    // Additional security: prevent access to sensitive system directories
    const sensitivePatterns = [
      '/etc',
      '/root',
      '/boot',
      '/sys',
      '/proc',
      '/dev',
      'C:\\Windows\\System32',
      'C:\\Program Files',
    ];

    for (const pattern of sensitivePatterns) {
      if (resolvedPath.startsWith(pattern)) {
        throw new Error(`Access to system directory ${pattern} is not allowed`);
      }
    }

    return resolvedPath;
  }

  /**
   * Redact sensitive tokens from URLs for logging
   */
  private redactUrl(url: string): string {
    return url
      .replace(/x-access-token:[^@]+@/g, 'x-access-token:[REDACTED]@')
      .replace(/:\/\/[^:]+:[^@]+@/g, '://[REDACTED]:[REDACTED]@');
  }

  /**
   * Execute a git command
   */
  private async executeGitCommand(
    command: string,
    options: { timeout?: number; env?: Record<string, string> } = {}
  ): Promise<GitCommandResult> {
    // Merge provided env with process.env and add git-specific settings
    // These settings prevent git from hanging on interactive prompts while
    // still allowing OS-level credential helpers to work:
    // - GIT_TERMINAL_PROMPT=0: Prevents terminal credential prompts
    // - GIT_SSH_COMMAND: Disables SSH password prompts (BatchMode)
    const gitEnv = {
      ...process.env,
      ...options.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=no',
    };

    const result = await commandExecutor.execute(command, {
      timeout: options.timeout || 30000,
      env: gitEnv,
    } as any);

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  /**
   * Build authenticated URL with token
   */
  private buildAuthenticatedUrl(repoUrl: string, token?: string): string {
    if (!token) {
      return repoUrl;
    }

    // Handle GitHub URLs
    if (repoUrl.includes('github.com')) {
      // Convert SSH to HTTPS if needed
      if (repoUrl.startsWith('git@github.com:')) {
        repoUrl = repoUrl.replace('git@github.com:', 'https://github.com/');
      }

      // Add token
      if (repoUrl.startsWith('https://')) {
        return repoUrl.replace('https://', `https://x-access-token:${token}@`);
      }
    }

    return repoUrl;
  }

  /**
   * Get repository URL from repository identifier
   */
  getRepositoryUrl(repository: string, _token?: string): string {
    // If it looks like a URL, return as-is
    if (
      repository.startsWith('http://') ||
      repository.startsWith('https://') ||
      repository.startsWith('git@')
    ) {
      return repository;
    }

    // Assume it's a GitHub repository (owner/repo format)
    return `https://github.com/${repository}.git`;
  }
}

// Export singleton instance
export const worktreeManager = WorktreeManager.getInstance();
