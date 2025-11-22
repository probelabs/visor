/**
 * Git Worktree Manager
 *
 * Manages git worktrees for efficient multi-workflow execution.
 * Uses a bare repository cache to share git objects between worktrees.
 */

import * as fs from 'fs';
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
    const defaultBasePath =
      process.env.VISOR_WORKTREE_PATH || path.join(process.cwd(), '.visor', 'worktrees');

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
    fetchDepth?: number
  ): Promise<string> {
    const reposDir = this.getReposDir();
    const repoName = repository.replace(/\//g, '-');
    const bareRepoPath = path.join(reposDir, `${repoName}.git`);

    // Check if bare repo exists
    if (fs.existsSync(bareRepoPath)) {
      logger.debug(`Bare repository already exists: ${bareRepoPath}`);

      // Update remote refs
      await this.updateBareRepo(bareRepoPath);
      return bareRepoPath;
    }

    // Clone as bare repository
    logger.info(
      `Cloning bare repository: ${repository}${fetchDepth ? ` (depth: ${fetchDepth})` : ''}`
    );

    const cloneUrl = this.buildAuthenticatedUrl(repoUrl, token);

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

    const result = await this.executeGitCommand(cloneCmd, { timeout: 300000 }); // 5 minute timeout

    if (result.exitCode !== 0) {
      throw new Error(`Failed to clone bare repository: ${result.stderr}`);
    }

    logger.info(`Successfully cloned bare repository to ${bareRepoPath}`);
    return bareRepoPath;
  }

  /**
   * Update bare repository refs
   */
  private async updateBareRepo(bareRepoPath: string): Promise<void> {
    logger.debug(`Updating bare repository: ${bareRepoPath}`);

    const updateCmd = `git -C ${this.escapeShellArg(bareRepoPath)} remote update --prune`;
    const result = await this.executeGitCommand(updateCmd, { timeout: 60000 }); // 1 minute timeout

    if (result.exitCode !== 0) {
      logger.warn(`Failed to update bare repository: ${result.stderr}`);
      // Don't throw - we can continue with stale refs
    } else {
      logger.debug(`Successfully updated bare repository`);
    }
  }

  /**
   * Create a new worktree
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
    } = {}
  ): Promise<WorktreeInfo> {
    // Get or create bare repository
    const bareRepoPath = await this.getOrCreateBareRepo(
      repository,
      repoUrl,
      options.token,
      options.fetchDepth
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

      if (options.clean) {
        logger.debug(`Cleaning existing worktree`);
        await this.cleanWorktree(worktreePath);
      }

      // Load existing metadata
      const metadata = await this.loadMetadata(worktreePath);
      if (metadata) {
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
    }

    // Fetch the ref if needed
    await this.fetchRef(bareRepoPath, ref);

    // Create worktree
    logger.info(`Creating worktree for ${repository}@${ref}`);
    const createCmd = `git -C ${this.escapeShellArg(bareRepoPath)} worktree add ${this.escapeShellArg(worktreePath)} ${this.escapeShellArg(ref)}`;
    const result = await this.executeGitCommand(createCmd, { timeout: 60000 });

    if (result.exitCode !== 0) {
      throw new Error(`Failed to create worktree: ${result.stderr}`);
    }

    // Get commit SHA
    const commit = await this.getCommitSha(worktreePath);

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
   * Fetch a specific ref in bare repository
   */
  private async fetchRef(bareRepoPath: string, ref: string): Promise<void> {
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
   * Get commit SHA for worktree
   */
  private async getCommitSha(worktreePath: string): Promise<string> {
    const cmd = `git -C ${this.escapeShellArg(worktreePath)} rev-parse HEAD`;
    const result = await this.executeGitCommand(cmd);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to get commit SHA: ${result.stderr}`);
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
   */
  private escapeShellArg(arg: string): string {
    // Replace single quotes with '\'' and wrap in single quotes
    return `'${arg.replace(/'/g, "'\\''")}'`;
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

    return resolvedPath;
  }

  /**
   * Execute a git command
   */
  private async executeGitCommand(
    command: string,
    options: { timeout?: number; env?: Record<string, string> } = {}
  ): Promise<GitCommandResult> {
    const result = await commandExecutor.execute(command, {
      timeout: options.timeout || 30000,
      env: options.env || process.env,
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
