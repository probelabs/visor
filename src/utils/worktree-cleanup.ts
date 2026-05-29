/**
 * Worktree Cleanup Utilities
 *
 * Provides utilities for cleaning up worktrees at various lifecycle points.
 */

import { worktreeManager, WorktreeManager } from './worktree-manager';
import { logger } from '../logger';
import * as fsp from 'fs/promises';
import * as path from 'path';

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_PRESERVE_REPOSITORIES = ['probelabs/visor', 'probelabs/probe'];

/**
 * Cleanup worktrees for a specific workflow
 */
export async function cleanupWorkflowWorktrees(workflowId: string): Promise<void> {
  logger.info(`Cleaning up worktrees for workflow: ${workflowId}`);

  const worktrees = await worktreeManager.listWorktrees();
  let cleaned = 0;

  for (const worktree of worktrees) {
    if (worktree.metadata.workflow_id === workflowId) {
      try {
        await worktreeManager.removeWorktree(worktree.id);
        cleaned++;
      } catch (error) {
        logger.error(`Failed to remove worktree ${worktree.id}: ${error}`);
      }
    }
  }

  logger.info(`Cleaned up ${cleaned} worktree(s) for workflow ${workflowId}`);
}

/**
 * Cleanup all worktrees for the current process
 */
export async function cleanupCurrentProcessWorktrees(): Promise<void> {
  logger.info('Cleaning up worktrees for current process');
  await worktreeManager.cleanupProcessWorktrees();
}

/**
 * Cleanup all stale worktrees (older than configured max age)
 */
export async function cleanupStaleWorktrees(): Promise<void> {
  logger.info('Cleaning up stale worktrees');
  await cleanupStaleWorktreesPreservingRecentWorkspaces();
}

/**
 * Cleanup all worktrees (dangerous - use with caution)
 */
export async function cleanupAllWorktrees(): Promise<void> {
  logger.warn('Cleaning up ALL worktrees');

  const worktrees = await worktreeManager.listWorktrees();
  let cleaned = 0;

  for (const worktree of worktrees) {
    // Skip locked worktrees (active processes)
    if (worktree.locked) {
      logger.info(
        `Skipping locked worktree: ${worktree.id} (process ${worktree.metadata.pid} is alive)`
      );
      continue;
    }

    try {
      await worktreeManager.removeWorktree(worktree.id);
      cleaned++;
    } catch (error) {
      logger.error(`Failed to remove worktree ${worktree.id}: ${error}`);
    }
  }

  logger.info(`Cleaned up ${cleaned} worktree(s)`);
}

/**
 * List all worktrees with details
 */
export async function listWorktreesInfo(): Promise<void> {
  const worktrees = await worktreeManager.listWorktrees();

  if (worktrees.length === 0) {
    console.log('No worktrees found');
    return;
  }

  console.log(`\nFound ${worktrees.length} worktree(s):\n`);

  for (const worktree of worktrees) {
    const status = worktree.locked ? '🔒 LOCKED' : '✓ Available';
    const age = getAge(worktree.metadata.created_at);

    console.log(`${status} ${worktree.id}`);
    console.log(`  Path:       ${worktree.path}`);
    console.log(`  Repository: ${worktree.metadata.repository}`);
    console.log(`  Ref:        ${worktree.ref}`);
    console.log(`  Commit:     ${worktree.commit.substring(0, 8)}`);
    console.log(`  Age:        ${age}`);
    console.log(`  Workflow:   ${worktree.metadata.workflow_id || 'N/A'}`);
    console.log(`  PID:        ${worktree.metadata.pid}`);
    console.log('');
  }
}

/**
 * Get human-readable age string
 */
function getAge(createdAt: string): string {
  const now = new Date();
  const created = new Date(createdAt);
  const ageMs = now.getTime() - created.getTime();

  const minutes = Math.floor(ageMs / 1000 / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days} day${days === 1 ? '' : 's'}`;
  } else if (hours > 0) {
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  } else if (minutes > 0) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  } else {
    return 'just now';
  }
}

/**
 * Initialize cleanup handlers
 *
 * This should be called early in the application lifecycle to ensure
 * cleanup happens on process exit.
 */
export function initializeCleanupHandlers(): void {
  // The worktree manager already registers cleanup handlers in its constructor
  // This function is kept for explicit initialization if needed
  WorktreeManager.getInstance();
}

function isPathWithin(parentPath: string, targetPath: string): boolean {
  const relative = path.relative(parentPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function inspectWorkspaceEntry(
  entryPath: string,
  managedWorktreesDir: string,
  managedReposDir: string,
  preserveRepositories: Set<string>,
  preservePathPrefixes: string[]
): Promise<{ protectWorkspace: boolean; protectedWorktreePath?: string }> {
  try {
    const stat = await fsp.lstat(entryPath);

    if (stat.isSymbolicLink()) {
      const targetPath = await fsp.realpath(entryPath);
      const metadataPath = `${targetPath.replace(/\/?$/, '')}.metadata.json`;
      let repository: string | undefined;

      try {
        const metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf8')) as {
          repository?: string;
        };
        repository = metadata.repository;
      } catch {
        // Best-effort: metadata may not exist for non-managed symlinks.
      }

      return {
        protectWorkspace:
          preserveRepositories.has(repository || '') ||
          preservePathPrefixes.some(prefix => isPathWithin(prefix, targetPath)),
        protectedWorktreePath: targetPath,
      };
    }

    if (stat.isDirectory()) {
      const gitFilePath = path.join(entryPath, '.git');
      const gitContent = await fsp.readFile(gitFilePath, 'utf8').catch(() => null);
      if (!gitContent) {
        return { protectWorkspace: false };
      }

      const match = gitContent.match(/gitdir:\s*(.+)/);
      if (!match) {
        return { protectWorkspace: false };
      }

      const gitDir = match[1].trim();
      const resolvedGitDir = path.resolve(entryPath, gitDir);
      const repoGitDir = resolvedGitDir.replace(/\/worktrees\/.*$/, '');
      return {
        protectWorkspace: preservePathPrefixes.some(prefix => isPathWithin(prefix, repoGitDir)),
      };
    }
  } catch {
    // Best-effort: broken workspace entries should not block cleanup.
  }

  return { protectWorkspace: false };
}

async function collectWorkspaceProtection(
  workspaceBasePath: string,
  maxAgeMs: number,
  preserveRepositories: Set<string>,
  preservePathPrefixes: string[]
): Promise<{ protectedWorkspacePaths: Set<string>; protectedWorktreePaths: Set<string> }> {
  const managedBasePath = worktreeManager.getConfig().base_path;
  const managedWorktreesDir = path.join(managedBasePath, 'worktrees');
  const managedReposDir = path.join(managedBasePath, 'repos');
  const protectedWorkspacePaths = new Set<string>();
  const protectedPaths = new Set<string>();

  try {
    const entries = await fsp.readdir(workspaceBasePath, { withFileTypes: true });
    const now = Date.now();

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const workspacePath = path.join(workspaceBasePath, entry.name);
      const stat = await fsp.stat(workspacePath);
      const children = await fsp.readdir(workspacePath, { withFileTypes: true });
      const isRecent = now - stat.mtimeMs <= maxAgeMs;
      let protectWorkspace = isRecent;

      for (const child of children) {
        const childPath = path.join(workspacePath, child.name);
        const result = await inspectWorkspaceEntry(
          childPath,
          managedWorktreesDir,
          managedReposDir,
          preserveRepositories,
          preservePathPrefixes
        );

        if (result.protectWorkspace) {
          protectWorkspace = true;
        }
        if (result.protectedWorktreePath) {
          protectedPaths.add(result.protectedWorktreePath);
        }
      }

      if (protectWorkspace) {
        protectedWorkspacePaths.add(workspacePath);
      }
    }
  } catch {
    // Best-effort — no workspace protection available
  }

  return {
    protectedWorkspacePaths,
    protectedWorktreePaths: protectedPaths,
  };
}

export async function cleanupStaleWorkspaceDirectories(options?: {
  workspaceBasePath?: string;
  maxAgeMs?: number;
  preserveRepositories?: string[];
  preservePathPrefixes?: string[];
}): Promise<number> {
  const workspaceBasePath =
    options?.workspaceBasePath || process.env.VISOR_WORKSPACE_PATH || '/tmp/visor-workspaces';
  const maxAgeMs = options?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const preserveRepositories = new Set(
    options?.preserveRepositories || DEFAULT_PRESERVE_REPOSITORIES
  );
  const preservePathPrefixes = options?.preservePathPrefixes || [];
  const { protectedWorkspacePaths } = await collectWorkspaceProtection(
    workspaceBasePath,
    maxAgeMs,
    preserveRepositories,
    preservePathPrefixes
  );

  let cleaned = 0;
  try {
    const entries = await fsp.readdir(workspaceBasePath, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(workspaceBasePath, entry.name);
      const stat = await fsp.stat(dirPath);
      if (now - stat.mtimeMs <= maxAgeMs) {
        continue;
      }
      if (protectedWorkspacePaths.has(dirPath)) {
        continue;
      }

      await fsp.rm(dirPath, { recursive: true, force: true });
      cleaned++;
    }
  } catch (error) {
    logger.debug(`[Workspace] Stale cleanup error: ${error}`);
  }

  if (cleaned > 0) {
    logger.info(`[Workspace] Cleaned up ${cleaned} stale workspace(s) from ${workspaceBasePath}`);
  }

  return cleaned;
}

export async function cleanupStaleWorktreesPreservingRecentWorkspaces(options?: {
  workspaceBasePath?: string;
  maxAgeMs?: number;
  preserveRepositories?: string[];
  preservePathPrefixes?: string[];
}): Promise<number> {
  const workspaceBasePath =
    options?.workspaceBasePath || process.env.VISOR_WORKSPACE_PATH || '/tmp/visor-workspaces';
  const maxAgeMs = options?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const preserveRepositories = new Set(
    options?.preserveRepositories || DEFAULT_PRESERVE_REPOSITORIES
  );
  const preservePathPrefixes = options?.preservePathPrefixes || [];
  const { protectedWorktreePaths } = await collectWorkspaceProtection(
    workspaceBasePath,
    maxAgeMs,
    preserveRepositories,
    preservePathPrefixes
  );
  const worktrees = await worktreeManager.listWorktrees();
  const now = Date.now();
  let cleaned = 0;

  for (const worktree of worktrees) {
    const createdAt = new Date(worktree.metadata.created_at).getTime();
    if (!Number.isFinite(createdAt) || now - createdAt <= maxAgeMs) {
      continue;
    }
    if (protectedWorktreePaths.has(worktree.path)) {
      continue;
    }
    if (preserveRepositories.has(worktree.metadata.repository)) {
      continue;
    }

    try {
      await worktreeManager.removeWorktree(worktree.id);
      cleaned++;
    } catch (error) {
      logger.error(`Failed to remove stale worktree ${worktree.id}: ${error}`);
    }
  }

  if (cleaned > 0) {
    logger.info(`Cleaned up ${cleaned} stale worktree(s)`);
  }
  return cleaned;
}

export async function runPeriodicStorageCleanup(options?: {
  workspaceBasePath?: string;
  workspaceMaxAgeMs?: number;
  preserveRepositories?: string[];
  preservePathPrefixes?: string[];
}): Promise<{ workspaces: number; worktrees: number }> {
  const workspaceBasePath =
    options?.workspaceBasePath || process.env.VISOR_WORKSPACE_PATH || '/tmp/visor-workspaces';
  const workspaceMaxAgeMs = options?.workspaceMaxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const workspaces = await cleanupStaleWorkspaceDirectories({
    workspaceBasePath,
    maxAgeMs: workspaceMaxAgeMs,
    preserveRepositories: options?.preserveRepositories,
    preservePathPrefixes: options?.preservePathPrefixes,
  });
  const worktrees = await cleanupStaleWorktreesPreservingRecentWorkspaces({
    workspaceBasePath,
    maxAgeMs: workspaceMaxAgeMs,
    preserveRepositories: options?.preserveRepositories,
    preservePathPrefixes: options?.preservePathPrefixes,
  });
  return { workspaces, worktrees };
}

export function startPeriodicStorageCleanup(
  label: string,
  options?: {
    intervalMs?: number;
    workspaceBasePath?: string;
    workspaceMaxAgeMs?: number;
    preserveRepositories?: string[];
    preservePathPrefixes?: string[];
  }
): () => void {
  const intervalMs = options?.intervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
  const run = async () => {
    try {
      const result = await runPeriodicStorageCleanup(options);
      if (result.workspaces > 0 || result.worktrees > 0) {
        logger.info(
          `[${label}] periodic cleanup removed ${result.workspaces} workspace(s) and ${result.worktrees} worktree(s)`
        );
      }
    } catch (error) {
      logger.warn(`[${label}] periodic cleanup failed: ${error}`);
    }
  };

  run().catch(() => {});
  const timer = setInterval(() => {
    run().catch(() => {});
  }, intervalMs);
  timer.unref?.();

  return () => clearInterval(timer);
}
