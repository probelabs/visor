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
   * Generate a unique worktree ID
   */
  private generateWorktreeId(repository: string, ref: string): string {
    const sanitizedRepo = repository.replace(/[^a-zA-Z0-9-]/g, '-');
    const sanitizedRef = ref.replace(/[^a-zA-Z0-9-]/g, '-');
    const hash = crypto
      .createHash('md5')
      .update(`${repository}:${ref}:${Date.now()}`)
      .digest('hex')
      .substring(0, 8);
    return `${sanitizedRepo}-${sanitizedRef}-${hash}`;
  }

  /**
   * Get or create bare repository
   */
  async getOrCreateBareRepo(
    repository: string,
    repoUrl: string,
    token?: string,
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
        // Timeout during verification - use stale cache to avoid hanging on re-clone
        logger.info(`Using stale bare repository (verification timed out): ${bareRepoPath}`);
        return bareRepoPath;
      } else if (verifyResult === false) {
        logger.warn(
          `Bare repository at ${bareRepoPath} has incorrect remote, removing and re-cloning`
        );
        await fsp.rm(bareRepoPath, { recursive: true, force: true });
        // Fall through to clone below
      } else {
        // Update remote refs
        await this.updateBareRepo(bareRepoPath);
        return bareRepoPath;
      }
    }

    // Clone as bare repository
    const cloneUrl = this.buildAuthenticatedUrl(repoUrl, token);
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
   * Update bare repository refs
   */
  private async updateBareRepo(bareRepoPath: string): Promise<void> {
    logger.debug(`Updating bare repository: ${bareRepoPath}`);

    try {
      const updateCmd = `git -C ${this.escapeShellArg(bareRepoPath)} remote update --prune`;
      const result = await this.executeGitCommand(updateCmd, { timeout: 60000 }); // 1 minute timeout

      if (result.exitCode !== 0) {
        logger.warn(`Failed to update bare repository: ${result.stderr}`);
        // Don't throw - we can continue with stale refs
      } else {
        logger.debug(`Successfully updated bare repository`);
      }
    } catch (error) {
      // Handle timeout or other errors gracefully - we can continue with stale refs
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to update bare repository (will use stale refs): ${errorMessage}`);
    }
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

    // Generate worktree ID and path
    const worktreeId = this.generateWorktreeId(repository, ref);
    let worktreePath = options.workingDirectory || path.join(this.getWorktreesDir(), worktreeId);

    // Validate path if user-provided
    if (options.workingDirectory) {
      worktreePath = this.validatePath(options.workingDirectory);
    }

    // Check if worktree already exists
    if (fs.existsSync(worktreePath)) {
      logger.debug(`Worktree already exists: ${worktreePath}`);

      // Load existing metadata
      const metadata = await this.loadMetadata(worktreePath);
      if (metadata) {
        if (options.clean) {
          logger.debug(`Cleaning existing worktree`);
          await this.cleanWorktree(worktreePath);
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
    await this.fetchRef(bareRepoPath, ref);
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
   * Fetch a specific ref in bare repository
   */
  private async fetchRef(bareRepoPath: string, ref: string): Promise<void> {
    // Validate ref (already validated in createWorktree, but double-check for safety)
    this.validateRef(ref);

    logger.debug(`Fetching ref: ${ref}`);

    // Try to fetch the ref (might be a PR ref or branch)
    const fetchCmd = `git -C ${this.escapeShellArg(bareRepoPath)} fetch origin ${this.escapeShellArg(ref + ':' + ref)} 2>&1 || true`;
    await this.executeGitCommand(fetchCmd, { timeout: 60000 });
  }

  /**
   * Clean worktree (reset and remove untracked files)
   */
  private async cleanWorktree(worktreePath: string): Promise<void> {
    // Reset to HEAD
    const resetCmd = `git -C ${this.escapeShellArg(worktreePath)} reset --hard HEAD`;
    await this.executeGitCommand(resetCmd);

    // Clean untracked files
    const cleanCmd = `git -C ${this.escapeShellArg(worktreePath)} clean -fdx`;
    await this.executeGitCommand(cleanCmd);
  }

  /**
   * Get commit SHA for a given ref inside a bare repository.
   *
   * This runs after fetchRef so that <ref> should resolve to either a
   * local branch, tag, or remote-tracking ref.
   */
  private async getCommitShaForRef(bareRepoPath: string, ref: string): Promise<string> {
    const cmd = `git -C ${this.escapeShellArg(bareRepoPath)} rev-parse ${this.escapeShellArg(ref)}`;
    const result = await this.executeGitCommand(cmd);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to get commit SHA for ref ${ref}: ${result.stderr}`);
    }

    return result.stdout.trim();
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

    // Remove from active list
    this.activeWorktrees.delete(worktreeId);

    logger.info(`Successfully removed worktree: ${worktreeId}`);
  }

  /**
   * Save worktree metadata
   */
  private async saveMetadata(worktreePath: string, metadata: WorktreeMetadata): Promise<void> {
    const metadataPath = path.join(worktreePath, '.visor-metadata.json');
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
  }

  /**
   * Load worktree metadata
   */
  private async loadMetadata(worktreePath: string): Promise<WorktreeMetadata | null> {
    const metadataPath = path.join(worktreePath, '.visor-metadata.json');

    if (!fs.existsSync(metadataPath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(metadataPath, 'utf8');
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
