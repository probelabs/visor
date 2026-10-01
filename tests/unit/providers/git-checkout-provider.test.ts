import { GitCheckoutProvider } from '../../../src/providers/git-checkout-provider';
import { worktreeManager } from '../../../src/utils/worktree-manager';
import type { PRInfo } from '../../../src/pr-analyzer';

// Minimal PRInfo stub for tests
const prInfoStub: PRInfo = {
  number: 1,
  title: 'Test',
  author: 'tester',
  head: 'test-branch',
  base: 'main',
  files: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  additions: 0,
  deletions: 0,
  commits: 1,
  changedFiles: 0,
  eventType: 'manual',
  repository: {
    fullName: 'owner/repo',
    defaultBranch: 'main',
  } as any,
} as any;

describe('GitCheckoutProvider ref fallback', () => {
  const provider = new GitCheckoutProvider();

  it('uses HEAD when ref is empty to rely on default branch', async () => {
    // Spy on worktreeManager.createWorktree to simulate main failing then master succeeding
    const spy = jest.spyOn(worktreeManager, 'createWorktree').mockResolvedValueOnce({
      id: 'wt-id',
      path: '/tmp/worktree',
      ref: 'master',
      commit: 'abcdef',
      metadata: {
        worktree_id: 'wt-id',
        created_at: new Date().toISOString(),
        ref: 'master',
        commit: 'abcdef',
        repository: 'TykTechnologies/tyk-docs',
        pid: process.pid,
        cleanup_on_exit: true,
        bare_repo_path: '/tmp/repos/tyk-docs.git',
        worktree_path: '/tmp/worktree',
      },
      locked: false,
    } as any);

    const res = await provider.execute(
      prInfoStub,
      {
        type: 'git-checkout',
        // empty ref should trigger HEAD usage
        ref: '',
        repository: 'TykTechnologies/tyk-docs',
      } as any,
      undefined,
      {} as any
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0] as any[])[2]).toBe('HEAD');
    expect((res as any).output).toMatchObject({
      success: true,
      ref: 'HEAD',
      path: '/tmp/worktree',
    });

    spy.mockRestore();
  });

  it('forwards persist_worktree to the worktree manager', async () => {
    const spy = jest.spyOn(worktreeManager, 'createWorktree').mockResolvedValueOnce({
      id: 'persisted-wt',
      path: '/tmp/persisted-worktree',
      ref: 'main',
      commit: 'abcdef',
      metadata: {
        worktree_id: 'persisted-wt',
        created_at: new Date().toISOString(),
        ref: 'main',
        commit: 'abcdef',
        repository: 'owner/repo',
        pid: process.pid,
        cleanup_on_exit: false,
        bare_repo_path: '/tmp/repos/repo.git',
        worktree_path: '/tmp/persisted-worktree',
      },
      locked: false,
    } as any);

    await provider.execute(
      prInfoStub,
      {
        type: 'git-checkout',
        ref: 'main',
        repository: 'owner/repo',
        persist_worktree: true,
      } as any,
      undefined,
      {} as any
    );

    expect(spy).toHaveBeenCalledWith(
      'owner/repo',
      'https://github.com/owner/repo.git',
      'main',
      expect.objectContaining({ persistWorktree: true })
    );
    spy.mockRestore();
  });
});
