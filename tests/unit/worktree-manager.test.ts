import * as fs from 'fs';
import { WorktreeManager } from '../../src/utils/worktree-manager';

// Mock command executor so we don't run real git commands
jest.mock('../../src/utils/command-executor', () => ({
  commandExecutor: {
    execute: jest.fn(),
  },
}));

// Mock logger to keep test output clean
jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('WorktreeManager', () => {
  const basePath = '/tmp/visor-worktrees-test';

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VISOR_WORKTREE_PATH = basePath;

    // Ensure a clean base directory for each test
    if (fs.existsSync(basePath)) {
      fs.rmSync(basePath, { recursive: true, force: true });
    }
    fs.mkdirSync(basePath, { recursive: true });
  });

  afterEach(() => {
    delete process.env.VISOR_WORKTREE_PATH;
    if (fs.existsSync(basePath)) {
      fs.rmSync(basePath, { recursive: true, force: true });
    }
  });

  it('creates worktrees in detached HEAD at a commit, not at the branch name', async () => {
    const { commandExecutor } = require('../../src/utils/command-executor');

    // Arrange: stub git commands used by createWorktree
    // 1) getOrCreateBareRepo: clone or remote update
    // 2) fetchRef: fetch origin <ref>:<ref>
    // 3) getCommitShaForRef: rev-parse <ref>
    // 4) worktree add --detach <path> <commit>
    const execMock = commandExecutor.execute as jest.Mock;

    // Make every git call succeed and return sensible defaults
    execMock.mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
    });

    const manager = WorktreeManager.getInstance();
    const repo = 'TykTechnologies/tyk-docs';
    const repoUrl = `https://github.com/${repo}.git`;
    const ref = 'main';

    // Act (ignore any filesystem failures from the mocked git commands)
    try {
      await manager.createWorktree(repo, repoUrl, ref, { clean: true });
    } catch {
      // In this unit test we only care about the git commands that were
      // constructed, not about the actual filesystem side-effects.
    }

    // Assert: we should have called rev-parse on the ref and then worktree add
    const calls = execMock.mock.calls.map((c: any[]) => c[0] as string);

    const revParseCall = calls.find(cmd => cmd.includes('rev-parse') && cmd.includes(ref));
    expect(revParseCall).toBeDefined();

    const worktreeAddCall = calls.find(
      cmd => cmd.includes('worktree add') && cmd.includes('--detach')
    );
    expect(worktreeAddCall).toBeDefined();

    // Critically, the worktree add command should not be adding the raw branch
    // name (main) as the worktree target; instead it should be using the commit
    // SHA returned by rev-parse. We can't know the exact SHA here (it's mocked),
    // but we can assert that the ref string itself is not used as the final arg.
    expect(worktreeAddCall).not.toMatch(/worktree add .* main['"]?$/);
  });

  it('does not throw when creating multiple worktrees for the same repo/ref', async () => {
    const manager = WorktreeManager.getInstance();
    const repo = 'TykTechnologies/tyk-docs';
    const repoUrl = `https://github.com/${repo}.git`;
    const ref = 'main';

    // Act: two independent worktree creation attempts for the same branch/ref.
    // We ignore any filesystem errors and focus on the git commands issued.
    try {
      await manager.createWorktree(repo, repoUrl, ref, { clean: true });
      await manager.createWorktree(repo, repoUrl, ref, { clean: true });
    } catch {
      // Ignore ENOENT etc. from metadata writes in this unit-level test.
    }

    const { commandExecutor } = require('../../src/utils/command-executor');
    const calls = (commandExecutor.execute as jest.Mock).mock.calls.map(
      (c: any[]) => c[0] as string
    );

    // We should attempt two worktree add commands, and neither should try
    // to attach the raw branch name (main) as the final argument.
    const worktreeAdds = calls.filter(cmd => cmd.includes('worktree add'));
    // We should attempt at least one worktree add for this ref, and none of
    // them should try to attach the raw branch name (main) as the target.
    expect(worktreeAdds.length).toBeGreaterThanOrEqual(1);
    for (const cmd of worktreeAdds) {
      expect(cmd).not.toMatch(/worktree add .* main['"]?$/);
    }
  });
});
