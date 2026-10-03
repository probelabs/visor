/**
 * Regression tests (real git, no mocks): workspace isolation must never delete
 * the user's branches.
 *
 * The main-project worktree is a LINKED worktree of the user's repository, so it
 * shares `refs/heads/*` with it. Previously resetAndCleanWorktree() ran
 * `git branch -D` on every local branch not checked out in some worktree — on
 * every fresh workspace — which wiped the user's branches (including `main`)
 * whenever Visor ran from a local checkout.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  WorkspaceManager,
  getWorkspaceBranchCleanupPolicy,
  setWorkspaceBranchCleanupPolicy,
  type WorkspaceBranchCleanupPolicy,
} from '../../src/utils/workspace-manager';

jest.setTimeout(60_000);

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function branches(cwd: string): string[] {
  return git(cwd, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
    .split('\n')
    .filter(Boolean)
    .sort();
}

describe('WorkspaceManager branch safety (real git, automation mode: owned-only)', () => {
  let root: string;
  let repo: string;
  let basePath: string;

  beforeEach(() => {
    WorkspaceManager.clearInstances();
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'visor-branch-safety-')));
    repo = path.join(root, 'repo');
    basePath = path.join(root, 'workspaces');
    fs.mkdirSync(repo);
    git(repo, 'init', '--quiet', '-b', 'main');
    git(repo, 'config', 'user.email', 'visor-test@example.invalid');
    git(repo, 'config', 'user.name', 'Visor test');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '--quiet', '-m', 'base');
    // The user's own branches, including one with unmerged work.
    git(repo, 'branch', 'feature-wip');
    git(repo, 'branch', 'fix/old-thing');
    git(repo, 'checkout', '--quiet', '-b', 'unmerged-work');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    git(repo, 'add', 'b.txt');
    git(repo, 'commit', '--quiet', '-m', 'unmerged');
    // The branch under review is checked out in the main working tree.
    git(repo, 'checkout', '--quiet', '-b', 'pr-branch', 'main');
  });

  afterEach(() => {
    WorkspaceManager.clearInstances();
    try {
      git(repo, 'worktree', 'prune');
    } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Automation modes (Action, Slack/MCP runners, scheduler) use 'owned-only'.
  const config = (branchCleanup: WorkspaceBranchCleanupPolicy = 'owned-only') => ({
    enabled: true,
    basePath,
    cleanupOnExit: false,
    name: 'branch-safety',
    branchCleanup,
  });

  it('does not delete any user branch when creating a fresh workspace', async () => {
    const before = branches(repo);
    expect(before).toEqual(['feature-wip', 'fix/old-thing', 'main', 'pr-branch', 'unmerged-work']);

    const ws = WorkspaceManager.getInstance('s1', repo, config());
    const info = await ws.initialize();

    expect(branches(repo)).toEqual(before);
    // The worktree is detached, and a baseline was recorded in its private git dir.
    expect(() => git(info.mainProjectPath, 'symbolic-ref', '-q', 'HEAD')).toThrow();
    const gitDir = git(info.mainProjectPath, 'rev-parse', '--absolute-git-dir');
    expect(fs.existsSync(path.join(gitDir, 'visor-branch-baseline.json'))).toBe(true);
  });

  it('on reuse deletes only branches created inside the worktree, never user branches', async () => {
    const info = await WorkspaceManager.getInstance('s1', repo, config()).initialize();
    const wt = info.mainProjectPath;

    // An AI agent inside Visor's worktree creates and checks out branches...
    git(wt, 'checkout', '--quiet', '-b', 'agent-scratch');
    git(wt, 'checkout', '--quiet', '-b', 'agent-tmp');
    // ...and also checks out a pre-existing user branch.
    git(wt, 'checkout', '--quiet', 'feature-wip');
    git(wt, 'checkout', '--quiet', 'agent-tmp');
    // Meanwhile the user creates a new branch in their own checkout.
    git(repo, 'branch', 'user-new');

    // Next run reuses the same workspace (e.g. a Slack thread) -> refresh path.
    WorkspaceManager.clearInstances();
    await WorkspaceManager.getInstance('s2', repo, config()).initialize();

    expect(branches(repo)).toEqual([
      'feature-wip',
      'fix/old-thing',
      'main',
      'pr-branch',
      'unmerged-work',
      'user-new',
    ]);
    expect(() => git(wt, 'symbolic-ref', '-q', 'HEAD')).toThrow();
  });

  it('protects branches the user created between runs even if an agent later checks them out', async () => {
    const info = await WorkspaceManager.getInstance('s1', repo, config()).initialize();
    git(repo, 'branch', 'user-between-runs');

    WorkspaceManager.clearInstances();
    await WorkspaceManager.getInstance('s2', repo, config()).initialize(); // re-baselines

    git(info.mainProjectPath, 'checkout', '--quiet', 'user-between-runs');
    WorkspaceManager.clearInstances();
    await WorkspaceManager.getInstance('s3', repo, config()).initialize();

    expect(branches(repo)).toContain('user-between-runs');
  });

  it('deletes nothing for a reused worktree that has no baseline (created by an older Visor)', async () => {
    const info = await WorkspaceManager.getInstance('s1', repo, config()).initialize();
    const gitDir = git(info.mainProjectPath, 'rev-parse', '--absolute-git-dir');
    fs.unlinkSync(path.join(gitDir, 'visor-branch-baseline.json'));
    git(info.mainProjectPath, 'checkout', '--quiet', '-b', 'agent-tmp');

    WorkspaceManager.clearInstances();
    await WorkspaceManager.getInstance('s2', repo, config()).initialize();

    expect(branches(repo)).toContain('agent-tmp');
    expect(branches(repo)).toContain('feature-wip');
    expect(branches(repo)).toContain('main');
  });
});

describe('WorkspaceManager in local CLI mode (policy: never)', () => {
  let root: string;
  let repo: string;
  let basePath: string;
  const saved = getWorkspaceBranchCleanupPolicy();

  beforeEach(() => {
    WorkspaceManager.clearInstances();
    setWorkspaceBranchCleanupPolicy('never', 'local CLI run (--mode cli) on a developer checkout');
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'visor-cli-mode-')));
    const origin = path.join(root, 'origin');
    fs.mkdirSync(origin);
    git(origin, 'init', '--quiet', '-b', 'main');
    git(origin, 'config', 'user.email', 'visor-test@example.invalid');
    git(origin, 'config', 'user.name', 'Visor test');
    fs.writeFileSync(path.join(origin, 'a.txt'), 'a\n');
    git(origin, 'add', 'a.txt');
    git(origin, 'commit', '--quiet', '-m', 'base');
    git(origin, 'branch', 'gone-upstream');
    repo = path.join(root, 'repo');
    execFileSync('git', ['clone', '--quiet', origin, repo]);
    git(repo, 'config', 'user.email', 'visor-test@example.invalid');
    git(repo, 'config', 'user.name', 'Visor test');
    git(repo, 'branch', 'feature-wip');
    git(repo, 'branch', 'fix/old-thing');
    git(repo, 'checkout', '--quiet', '-b', 'pr-branch');
    // The branch disappears upstream; the developer still has origin/gone-upstream locally.
    git(origin, 'branch', '-D', 'gone-upstream');
    basePath = path.join(root, 'workspaces');
  });

  afterEach(() => {
    WorkspaceManager.clearInstances();
    setWorkspaceBranchCleanupPolicy(saved.policy, saved.reason);
    fs.rmSync(root, { recursive: true, force: true });
  });

  // No per-instance override: the process-wide CLI policy applies.
  const cliConfig = () => ({ enabled: true, basePath, cleanupOnExit: false, name: 'cli-ws' });

  it('defaults to never deleting branches', () => {
    setWorkspaceBranchCleanupPolicy(saved.policy, saved.reason);
    expect(saved.policy).toBe('never');
  });

  it('keeps every branch across fresh and reused workspaces, even agent-created ones', async () => {
    const before = branches(repo);
    expect(before).toEqual(['feature-wip', 'fix/old-thing', 'main', 'pr-branch']);

    const info = await WorkspaceManager.getInstance('c1', repo, cliConfig()).initialize();
    expect(branches(repo)).toEqual(before);

    git(info.mainProjectPath, 'checkout', '--quiet', '-b', 'agent-tmp');
    WorkspaceManager.clearInstances();
    await WorkspaceManager.getInstance('c2', repo, cliConfig()).initialize();

    expect(branches(repo)).toEqual([...before, 'agent-tmp'].sort());
    expect(() => git(info.mainProjectPath, 'symbolic-ref', '-q', 'HEAD')).toThrow();
  });

  it("does not prune the developer's remote-tracking refs", async () => {
    await WorkspaceManager.getInstance('c1', repo, cliConfig()).initialize();
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin')).toContain(
      'refs/remotes/origin/gone-upstream'
    );
  });

  it("only prunes Visor's own stale worktrees, never the developer's", async () => {
    // A developer worktree whose directory is temporarily missing (e.g. unmounted drive).
    const userWt = path.join(root, 'user-wt');
    git(repo, 'worktree', 'add', '--quiet', '--detach', userWt);
    fs.renameSync(userWt, userWt + '-away');
    // A stale worktree left behind by a crashed Visor run.
    const staleVisor = path.join(basePath, 'old-run', 'repo');
    fs.mkdirSync(path.dirname(staleVisor), { recursive: true });
    git(repo, 'worktree', 'add', '--quiet', '--detach', staleVisor);
    fs.rmSync(staleVisor, { recursive: true, force: true });

    await WorkspaceManager.getInstance('c1', repo, cliConfig()).initialize();

    const listed = git(repo, 'worktree', 'list', '--porcelain');
    expect(listed).toContain(`worktree ${userWt}`);
    expect(listed).not.toContain(`worktree ${staleVisor}`);
  });
});

describe('WorkspaceManager in automation mode prunes remote-tracking refs as before', () => {
  it('uses fetch --prune only when the policy is owned-only', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'visor-auto-mode-')));
    try {
      const origin = path.join(root, 'origin');
      fs.mkdirSync(origin);
      git(origin, 'init', '--quiet', '-b', 'main');
      git(origin, 'config', 'user.email', 'visor-test@example.invalid');
      git(origin, 'config', 'user.name', 'Visor test');
      git(origin, 'commit', '--quiet', '--allow-empty', '-m', 'base');
      git(origin, 'branch', 'gone-upstream');
      const repo = path.join(root, 'repo');
      execFileSync('git', ['clone', '--quiet', origin, repo]);
      git(origin, 'branch', '-D', 'gone-upstream');
      WorkspaceManager.clearInstances();
      await WorkspaceManager.getInstance('a1', repo, {
        enabled: true,
        basePath: path.join(root, 'ws'),
        cleanupOnExit: false,
        branchCleanup: 'owned-only',
      }).initialize();
      expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin')).not.toContain(
        'gone-upstream'
      );
    } finally {
      WorkspaceManager.clearInstances();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
