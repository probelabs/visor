import * as fs from 'fs';
import * as path from 'path';

const listWorktrees = jest.fn();
const removeWorktree = jest.fn();
const getConfig = jest.fn();

jest.mock('../../src/utils/worktree-manager', () => ({
  worktreeManager: {
    listWorktrees,
    removeWorktree,
    getConfig,
  },
  WorktreeManager: {
    getInstance: jest.fn(),
  },
}));

jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('worktree cleanup utilities', () => {
  const workspaceBasePath = '/tmp/test-worktree-cleanup-workspaces';
  const managedBasePath = '/tmp/test-worktree-cleanup-managed';
  const managedWorktreesDir = path.join(managedBasePath, 'worktrees');
  const managedReposDir = path.join(managedBasePath, 'repos');
  const staleAgeMs = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    fs.rmSync(workspaceBasePath, { recursive: true, force: true });
    fs.rmSync(managedBasePath, { recursive: true, force: true });
    fs.mkdirSync(workspaceBasePath, { recursive: true });
    fs.mkdirSync(managedWorktreesDir, { recursive: true });
    fs.mkdirSync(managedReposDir, { recursive: true });
    getConfig.mockReturnValue({ base_path: managedBasePath });
  });

  afterEach(() => {
    fs.rmSync(workspaceBasePath, { recursive: true, force: true });
    fs.rmSync(managedBasePath, { recursive: true, force: true });
  });

  it('preserves stale workspaces that point at preserved repositories or local paths', async () => {
    const { cleanupStaleWorkspaceDirectories } =
      require('../../src/utils/worktree-cleanup') as typeof import('../../src/utils/worktree-cleanup');

    const visorWorkspace = path.join(workspaceBasePath, 'slack-preserve-visor');
    const probeWorkspace = path.join(workspaceBasePath, 'slack-preserve-probe');
    const staleWorkspace = path.join(workspaceBasePath, 'slack-remove-tyk');
    fs.mkdirSync(visorWorkspace, { recursive: true });
    fs.mkdirSync(probeWorkspace, { recursive: true });
    fs.mkdirSync(staleWorkspace, { recursive: true });

    const visorTarget = path.join(managedWorktreesDir, 'probelabs-visor-main-1234');
    fs.mkdirSync(visorTarget, { recursive: true });
    fs.writeFileSync(
      `${visorTarget}.metadata.json`,
      JSON.stringify({ repository: 'probelabs/visor', worktree_path: visorTarget })
    );
    fs.symlinkSync(visorTarget, path.join(visorWorkspace, 'visor'));

    const externalProbePath = '/tmp/test-local-probe-workspace';
    fs.mkdirSync(externalProbePath, { recursive: true });
    fs.symlinkSync(externalProbePath, path.join(probeWorkspace, 'probe'));

    const tykTarget = path.join(managedWorktreesDir, 'TykTechnologies-tyk-main-1234');
    fs.mkdirSync(tykTarget, { recursive: true });
    fs.writeFileSync(
      `${tykTarget}.metadata.json`,
      JSON.stringify({ repository: 'TykTechnologies/tyk', worktree_path: tykTarget })
    );
    fs.symlinkSync(tykTarget, path.join(staleWorkspace, 'tyk'));

    const oldDate = new Date(Date.now() - 2 * staleAgeMs);
    fs.utimesSync(visorWorkspace, oldDate, oldDate);
    fs.utimesSync(probeWorkspace, oldDate, oldDate);
    fs.utimesSync(staleWorkspace, oldDate, oldDate);

    const cleaned = await cleanupStaleWorkspaceDirectories({
      workspaceBasePath,
      maxAgeMs: staleAgeMs,
      preservePathPrefixes: [externalProbePath],
    });

    expect(cleaned).toBe(1);
    expect(fs.existsSync(visorWorkspace)).toBe(true);
    expect(fs.existsSync(probeWorkspace)).toBe(true);
    expect(fs.existsSync(staleWorkspace)).toBe(false);

    fs.rmSync(externalProbePath, { recursive: true, force: true });
  });

  it('preserves managed worktrees referenced by recent workspaces and protected repositories', async () => {
    const { cleanupStaleWorktreesPreservingRecentWorkspaces } =
      require('../../src/utils/worktree-cleanup') as typeof import('../../src/utils/worktree-cleanup');

    const recentWorkspace = path.join(workspaceBasePath, 'slack-recent');
    fs.mkdirSync(recentWorkspace, { recursive: true });

    const recentTarget = path.join(managedWorktreesDir, 'TykTechnologies-tyk-docs-main-recent');
    fs.mkdirSync(recentTarget, { recursive: true });
    fs.writeFileSync(
      `${recentTarget}.metadata.json`,
      JSON.stringify({ repository: 'TykTechnologies/tyk-docs', worktree_path: recentTarget })
    );
    fs.symlinkSync(recentTarget, path.join(recentWorkspace, 'tyk-docs'));

    const oldDate = new Date(Date.now() - 2 * staleAgeMs);
    fs.utimesSync(recentWorkspace, new Date(), new Date());

    listWorktrees.mockResolvedValue([
      {
        id: 'keep-recent',
        path: recentTarget,
        metadata: {
          created_at: oldDate.toISOString(),
          repository: 'TykTechnologies/tyk-docs',
        },
      },
      {
        id: 'keep-visor',
        path: path.join(managedWorktreesDir, 'probelabs-visor-main-old'),
        metadata: {
          created_at: oldDate.toISOString(),
          repository: 'probelabs/visor',
        },
      },
      {
        id: 'remove-tyk',
        path: path.join(managedWorktreesDir, 'TykTechnologies-tyk-main-old'),
        metadata: {
          created_at: oldDate.toISOString(),
          repository: 'TykTechnologies/tyk',
        },
      },
    ]);

    const cleaned = await cleanupStaleWorktreesPreservingRecentWorkspaces({
      workspaceBasePath,
      maxAgeMs: staleAgeMs,
    });

    expect(cleaned).toBe(1);
    expect(removeWorktree).toHaveBeenCalledTimes(1);
    expect(removeWorktree).toHaveBeenCalledWith('remove-tyk');
  });
});
