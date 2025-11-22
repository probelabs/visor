/**
 * Types and interfaces for git-checkout provider
 */

export interface GitCheckoutConfig {
  type: 'git-checkout';

  // Git reference to checkout (supports dynamic variables)
  ref: string;

  // Repository configuration
  repository?: string;
  token?: string;

  // Fetch configuration
  fetch_depth?: number;
  fetch_tags?: boolean;
  submodules?: boolean | 'recursive';

  // Worktree configuration
  working_directory?: string;
  use_worktree?: boolean;
  clean?: boolean;

  // Advanced options
  sparse_checkout?: string[];
  lfs?: boolean;

  // Standard check options
  timeout?: number;
  criticality?: string;
  assume?: string | string[];
  guarantee?: string | string[];

  // Cleanup behavior
  cleanup_on_failure?: boolean;
  persist_worktree?: boolean;

  // Internal tracking (not user-facing)
  checkName?: string;
  __outputHistory?: Map<string, unknown[]>;
}

export interface GitCheckoutOutput {
  success: boolean;
  path?: string;
  ref?: string;
  commit?: string;
  worktree_id?: string;
  repository?: string;
  is_worktree?: boolean;
  error?: string;
}

export interface WorktreeMetadata {
  worktree_id: string;
  created_at: string;
  workflow_id?: string;
  ref: string;
  commit: string;
  repository: string;
  pid: number;
  cleanup_on_exit: boolean;
  bare_repo_path: string;
  worktree_path: string;
}

export interface WorktreeCacheConfig {
  enabled: boolean;
  base_path: string;
  cleanup_on_exit: boolean;
  max_age_hours: number;
}

export interface BareRepositoryInfo {
  path: string;
  url: string;
  last_updated: Date;
}

export interface WorktreeInfo {
  id: string;
  path: string;
  ref: string;
  commit: string;
  metadata: WorktreeMetadata;
  locked: boolean;
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
