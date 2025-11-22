/**
 * Worktree Cleanup Utilities
 *
 * Provides utilities for cleaning up worktrees at various lifecycle points.
 */

import { worktreeManager, WorktreeManager } from './worktree-manager';
import { logger } from '../logger';

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
  await worktreeManager.cleanupStaleWorktrees();
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
      logger.info(`Skipping locked worktree: ${worktree.id} (process ${worktree.metadata.pid} is alive)`);
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
