import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceManager } from '../../src/utils/workspace-manager';

// Mock command executor
jest.mock('../../src/utils/command-executor', () => ({
  commandExecutor: {
    execute: jest.fn(),
  },
}));

// Mock logger
jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('WorkspaceManager', () => {
  const testSessionId = 'test-session-12345';
  const testOriginalPath = '/tmp/test-project';
  const testBasePath = '/tmp/test-visor-workspaces';

  beforeEach(() => {
    // Clear instances between tests
    WorkspaceManager.clearInstances();
    jest.clearAllMocks();
  });

  afterEach(async () => {
    // Cleanup any created directories
    const workspacePath = path.join(testBasePath, testSessionId);
    if (fs.existsSync(workspacePath)) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
    if (fs.existsSync(testBasePath)) {
      try {
        fs.rmSync(testBasePath, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('getInstance', () => {
    it('returns the same instance for the same sessionId', () => {
      const instance1 = WorkspaceManager.getInstance(testSessionId, testOriginalPath, {
        basePath: testBasePath,
      });
      const instance2 = WorkspaceManager.getInstance(testSessionId, testOriginalPath, {
        basePath: testBasePath,
      });

      expect(instance1).toBe(instance2);
    });

    it('returns different instances for different sessionIds', () => {
      const instance1 = WorkspaceManager.getInstance('session-1', testOriginalPath, {
        basePath: testBasePath,
      });
      const instance2 = WorkspaceManager.getInstance('session-2', testOriginalPath, {
        basePath: testBasePath,
      });

      expect(instance1).not.toBe(instance2);
    });
  });

  describe('isEnabled', () => {
    it('returns true by default', () => {
      const manager = WorkspaceManager.getInstance(testSessionId, testOriginalPath, {
        basePath: testBasePath,
      });

      expect(manager.isEnabled()).toBe(true);
    });

    it('returns false when disabled in config', () => {
      const manager = WorkspaceManager.getInstance(testSessionId, testOriginalPath, {
        enabled: false,
        basePath: testBasePath,
      });

      expect(manager.isEnabled()).toBe(false);
    });
  });

  describe('getWorkspacePath', () => {
    it('returns the correct workspace path', () => {
      const manager = WorkspaceManager.getInstance(testSessionId, testOriginalPath, {
        basePath: testBasePath,
      });

      expect(manager.getWorkspacePath()).toBe(path.join(testBasePath, testSessionId));
    });
  });

  describe('getOriginalPath', () => {
    it('returns the original working directory', () => {
      const manager = WorkspaceManager.getInstance(testSessionId, testOriginalPath, {
        basePath: testBasePath,
      });

      expect(manager.getOriginalPath()).toBe(testOriginalPath);
    });
  });

  describe('initialize', () => {
    it('throws error when not enabled', async () => {
      const manager = WorkspaceManager.getInstance(testSessionId, testOriginalPath, {
        enabled: false,
        basePath: testBasePath,
      });

      await expect(manager.initialize()).rejects.toThrow('Workspace isolation is not enabled');
    });

    it('creates workspace directory', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');

      // Mock git commands - first check fails (not a git repo)
      commandExecutor.execute.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

      // Create test original path
      if (!fs.existsSync(testOriginalPath)) {
        fs.mkdirSync(testOriginalPath, { recursive: true });
      }

      const manager = WorkspaceManager.getInstance(testSessionId, testOriginalPath, {
        basePath: testBasePath,
      });

      const info = await manager.initialize();

      expect(info.sessionId).toBe(testSessionId);
      expect(info.workspacePath).toBe(path.join(testBasePath, testSessionId));
      expect(fs.existsSync(info.workspacePath)).toBe(true);

      // Cleanup
      fs.rmSync(testOriginalPath, { recursive: true, force: true });
    });

    it('returns cached result on subsequent calls', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');
      commandExecutor.execute.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

      if (!fs.existsSync(testOriginalPath)) {
        fs.mkdirSync(testOriginalPath, { recursive: true });
      }

      const manager = WorkspaceManager.getInstance(testSessionId, testOriginalPath, {
        basePath: testBasePath,
      });

      const info1 = await manager.initialize();
      const info2 = await manager.initialize();

      expect(info1).toEqual(info2);

      fs.rmSync(testOriginalPath, { recursive: true, force: true });
    });
  });

  describe('addProject', () => {
    it('throws error if not initialized', async () => {
      const manager = WorkspaceManager.getInstance(testSessionId, testOriginalPath, {
        basePath: testBasePath,
      });

      await expect(manager.addProject('owner/repo', '/some/path')).rejects.toThrow(
        'Workspace not initialized'
      );
    });

    it('creates symlink for project', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');
      commandExecutor.execute.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

      if (!fs.existsSync(testOriginalPath)) {
        fs.mkdirSync(testOriginalPath, { recursive: true });
      }

      const worktreePath = '/tmp/test-worktree';
      if (!fs.existsSync(worktreePath)) {
        fs.mkdirSync(worktreePath, { recursive: true });
      }

      const manager = WorkspaceManager.getInstance(testSessionId, testOriginalPath, {
        basePath: testBasePath,
      });

      await manager.initialize();
      const workspacePath = await manager.addProject('owner/test-repo', worktreePath);

      expect(workspacePath).toBe(path.join(testBasePath, testSessionId, 'test-repo'));
      expect(fs.lstatSync(workspacePath).isSymbolicLink()).toBe(true);

      // Cleanup
      fs.rmSync(testOriginalPath, { recursive: true, force: true });
      fs.rmSync(worktreePath, { recursive: true, force: true });
    });

    it('handles duplicate project names', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');
      commandExecutor.execute.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

      if (!fs.existsSync(testOriginalPath)) {
        fs.mkdirSync(testOriginalPath, { recursive: true });
      }

      const worktreePath1 = '/tmp/test-worktree-1';
      const worktreePath2 = '/tmp/test-worktree-2';
      fs.mkdirSync(worktreePath1, { recursive: true });
      fs.mkdirSync(worktreePath2, { recursive: true });

      const manager = WorkspaceManager.getInstance(testSessionId, testOriginalPath, {
        basePath: testBasePath,
      });

      await manager.initialize();
      const path1 = await manager.addProject('owner/repo', worktreePath1);
      const path2 = await manager.addProject('other/repo', worktreePath2);

      expect(path1).toContain('repo');
      expect(path2).toContain('repo-2');

      // Cleanup
      fs.rmSync(testOriginalPath, { recursive: true, force: true });
      fs.rmSync(worktreePath1, { recursive: true, force: true });
      fs.rmSync(worktreePath2, { recursive: true, force: true });
    });
  });

  describe('listProjects', () => {
    it('returns empty array initially', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');
      commandExecutor.execute.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

      if (!fs.existsSync(testOriginalPath)) {
        fs.mkdirSync(testOriginalPath, { recursive: true });
      }

      const manager = WorkspaceManager.getInstance(testSessionId, testOriginalPath, {
        basePath: testBasePath,
      });

      await manager.initialize();
      const projects = manager.listProjects();

      expect(projects).toEqual([]);

      fs.rmSync(testOriginalPath, { recursive: true, force: true });
    });

    it('returns added projects', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');
      commandExecutor.execute.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

      if (!fs.existsSync(testOriginalPath)) {
        fs.mkdirSync(testOriginalPath, { recursive: true });
      }

      const worktreePath = '/tmp/test-worktree';
      fs.mkdirSync(worktreePath, { recursive: true });

      const manager = WorkspaceManager.getInstance(testSessionId, testOriginalPath, {
        basePath: testBasePath,
      });

      await manager.initialize();
      await manager.addProject('owner/test-repo', worktreePath);

      const projects = manager.listProjects();

      expect(projects.length).toBe(1);
      expect(projects[0].name).toBe('test-repo');
      expect(projects[0].repository).toBe('owner/test-repo');

      fs.rmSync(testOriginalPath, { recursive: true, force: true });
      fs.rmSync(worktreePath, { recursive: true, force: true });
    });
  });

  describe('cleanup', () => {
    it('removes workspace directory', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');
      commandExecutor.execute.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

      if (!fs.existsSync(testOriginalPath)) {
        fs.mkdirSync(testOriginalPath, { recursive: true });
      }

      const manager = WorkspaceManager.getInstance(testSessionId, testOriginalPath, {
        basePath: testBasePath,
      });

      await manager.initialize();
      const workspacePath = manager.getWorkspacePath();

      expect(fs.existsSync(workspacePath)).toBe(true);

      await manager.cleanup();

      expect(fs.existsSync(workspacePath)).toBe(false);

      fs.rmSync(testOriginalPath, { recursive: true, force: true });
    });
  });

  describe('cleanup with cleanupOnExit=false', () => {
    it('preserves workspace directory but clears in-memory state', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');
      commandExecutor.execute.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

      if (!fs.existsSync(testOriginalPath)) {
        fs.mkdirSync(testOriginalPath, { recursive: true });
      }

      const manager = WorkspaceManager.getInstance(testSessionId, testOriginalPath, {
        basePath: testBasePath,
        cleanupOnExit: false,
      });

      await manager.initialize();
      const workspacePath = manager.getWorkspacePath();

      expect(fs.existsSync(workspacePath)).toBe(true);

      await manager.cleanup();

      // Workspace directory should still exist
      expect(fs.existsSync(workspacePath)).toBe(true);
      // In-memory state should be cleared
      expect(manager.getWorkspaceInfo()).toBeNull();
      expect(manager.listProjects()).toEqual([]);

      fs.rmSync(testOriginalPath, { recursive: true, force: true });
    });

    it('removes instance from the map', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');
      commandExecutor.execute.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

      if (!fs.existsSync(testOriginalPath)) {
        fs.mkdirSync(testOriginalPath, { recursive: true });
      }

      const sid = 'persist-session';
      const manager = WorkspaceManager.getInstance(sid, testOriginalPath, {
        basePath: testBasePath,
        cleanupOnExit: false,
      });

      await manager.initialize();
      await manager.cleanup();

      // Getting instance again should create a new one (old was removed from map)
      const manager2 = WorkspaceManager.getInstance(sid, testOriginalPath, {
        basePath: testBasePath,
        cleanupOnExit: false,
      });
      expect(manager2).not.toBe(manager);

      fs.rmSync(testOriginalPath, { recursive: true, force: true });
    });
  });

  describe('initialize with existing workspace (reuse)', () => {
    it('reuses existing symlink for non-git project', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');
      // Not a git repo
      commandExecutor.execute.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

      if (!fs.existsSync(testOriginalPath)) {
        fs.mkdirSync(testOriginalPath, { recursive: true });
      }

      // First initialization
      const manager1 = WorkspaceManager.getInstance('reuse-session-1', testOriginalPath, {
        basePath: testBasePath,
        name: 'shared-workspace',
        cleanupOnExit: false,
      });

      const info1 = await manager1.initialize();
      expect(fs.existsSync(info1.mainProjectPath)).toBe(true);

      // Cleanup in-memory state (simulates end of first Slack message)
      await manager1.cleanup();

      // Second initialization with same workspace name (simulates second Slack message)
      const manager2 = WorkspaceManager.getInstance('reuse-session-2', testOriginalPath, {
        basePath: testBasePath,
        name: 'shared-workspace',
        cleanupOnExit: false,
      });

      const info2 = await manager2.initialize();

      // Should reuse same workspace path
      expect(info2.workspacePath).toBe(info1.workspacePath);
      // Symlink should still exist (wasn't recreated)
      expect(fs.existsSync(info2.mainProjectPath)).toBe(true);

      // Cleanup
      fs.rmSync(manager2.getWorkspacePath(), { recursive: true, force: true });
      fs.rmSync(testOriginalPath, { recursive: true, force: true });
    });

    it('reuses existing git worktree when valid', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');

      if (!fs.existsSync(testOriginalPath)) {
        fs.mkdirSync(testOriginalPath, { recursive: true });
      }

      // First call: isGitRepository(originalPath) = true
      // Second call: rev-parse HEAD = success
      // Third call: worktree add = success
      // Fourth call (on re-init): isGitRepository(originalPath) = true
      // Fifth call (on re-init): isGitRepository(mainProjectPath) = true (valid existing)
      commandExecutor.execute
        .mockResolvedValueOnce({ exitCode: 0, stdout: '.git', stderr: '' }) // isGitRepository(original)
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc123\n', stderr: '' }) // rev-parse HEAD
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // worktree add
        .mockResolvedValueOnce({ exitCode: 0, stdout: '.git', stderr: '' }) // isGitRepository(original) on 2nd init
        .mockResolvedValueOnce({ exitCode: 0, stdout: '.git', stderr: '' }); // isGitRepository(mainProject) valid

      const manager1 = WorkspaceManager.getInstance('reuse-git-1', testOriginalPath, {
        basePath: testBasePath,
        name: 'shared-git-ws',
        cleanupOnExit: false,
      });

      await manager1.initialize();
      const workspacePath = manager1.getWorkspacePath();

      // Simulate creating the mainProjectPath directory (worktree would have created it)
      const mainProjectPath = path.join(workspacePath, 'test-project');
      fs.mkdirSync(mainProjectPath, { recursive: true });

      await manager1.cleanup(); // Preserves directory (cleanupOnExit=false)

      // Second initialization
      const manager2 = WorkspaceManager.getInstance('reuse-git-2', testOriginalPath, {
        basePath: testBasePath,
        name: 'shared-git-ws',
        cleanupOnExit: false,
      });

      await manager2.initialize();

      // Should NOT have called worktree add again (only 3 git commands initially, then 2 for re-check)
      // The worktree add command should have been called only once (the 3rd mock)
      const executeCalls = commandExecutor.execute.mock.calls;
      const worktreeAddCalls = executeCalls.filter((call: any[]) =>
        String(call[0]).includes('worktree add')
      );
      expect(worktreeAddCalls.length).toBe(1);

      // Cleanup
      fs.rmSync(workspacePath, { recursive: true, force: true });
      fs.rmSync(testOriginalPath, { recursive: true, force: true });
    });

    it('recreates worktree when existing path is invalid', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');

      if (!fs.existsSync(testOriginalPath)) {
        fs.mkdirSync(testOriginalPath, { recursive: true });
      }

      // First init: git repo, HEAD, worktree add
      // Second init: git repo, pathExists=true, isGitRepository(mainProject)=false, worktree prune, HEAD, worktree add
      commandExecutor.execute
        .mockResolvedValueOnce({ exitCode: 0, stdout: '.git', stderr: '' }) // isGitRepository(original)
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc123\n', stderr: '' }) // rev-parse HEAD
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // worktree add
        .mockResolvedValueOnce({ exitCode: 0, stdout: '.git', stderr: '' }) // isGitRepository(original) 2nd
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' }) // isGitRepository(mainProject) = INVALID
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // worktree prune
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc123\n', stderr: '' }) // rev-parse HEAD
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // worktree add (recreate)

      const manager1 = WorkspaceManager.getInstance('invalid-wt-1', testOriginalPath, {
        basePath: testBasePath,
        name: 'invalid-wt-ws',
        cleanupOnExit: false,
      });

      await manager1.initialize();
      const workspacePath = manager1.getWorkspacePath();

      // Create an invalid directory at mainProjectPath (not a valid git dir)
      const mainProjectPath = path.join(workspacePath, 'test-project');
      fs.mkdirSync(mainProjectPath, { recursive: true });
      // Write a dummy file so it exists but is not a valid git repo
      fs.writeFileSync(path.join(mainProjectPath, 'dummy'), 'not-git');

      await manager1.cleanup();

      // Second initialization
      const manager2 = WorkspaceManager.getInstance('invalid-wt-2', testOriginalPath, {
        basePath: testBasePath,
        name: 'invalid-wt-ws',
        cleanupOnExit: false,
      });

      await manager2.initialize();

      // Should have called worktree add twice (original + recreate after invalid)
      const executeCalls = commandExecutor.execute.mock.calls;
      const worktreeAddCalls = executeCalls.filter((call: any[]) =>
        String(call[0]).includes('worktree add')
      );
      expect(worktreeAddCalls.length).toBe(2);

      // Should have called worktree prune
      const pruneCalls = executeCalls.filter((call: any[]) =>
        String(call[0]).includes('worktree prune')
      );
      expect(pruneCalls.length).toBe(1);

      // Cleanup
      fs.rmSync(workspacePath, { recursive: true, force: true });
      fs.rmSync(testOriginalPath, { recursive: true, force: true });
    });
  });

  describe('cleanupStale', () => {
    const staleBasePath = '/tmp/test-visor-stale-workspaces';

    afterEach(() => {
      if (fs.existsSync(staleBasePath)) {
        fs.rmSync(staleBasePath, { recursive: true, force: true });
      }
    });

    it('removes directories older than maxAge', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');
      commandExecutor.execute.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

      // Create base and stale directory
      fs.mkdirSync(staleBasePath, { recursive: true });
      const staleDir = path.join(staleBasePath, 'slack-C123-old-thread');
      fs.mkdirSync(staleDir, { recursive: true });

      // Backdate mtime to 2 days ago
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      fs.utimesSync(staleDir, twoDaysAgo, twoDaysAgo);

      const cleaned = await WorkspaceManager.cleanupStale(staleBasePath, 24 * 60 * 60 * 1000);

      expect(cleaned).toBe(1);
      expect(fs.existsSync(staleDir)).toBe(false);
    });

    it('preserves directories newer than maxAge', async () => {
      // Create base and recent directory
      fs.mkdirSync(staleBasePath, { recursive: true });
      const recentDir = path.join(staleBasePath, 'slack-C456-recent-thread');
      fs.mkdirSync(recentDir, { recursive: true });

      const cleaned = await WorkspaceManager.cleanupStale(staleBasePath, 24 * 60 * 60 * 1000);

      expect(cleaned).toBe(0);
      expect(fs.existsSync(recentDir)).toBe(true);
    });

    it('returns 0 when base path does not exist', async () => {
      const cleaned = await WorkspaceManager.cleanupStale('/tmp/nonexistent-visor-workspaces');

      expect(cleaned).toBe(0);
    });

    it('handles mixed stale and recent directories', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');
      commandExecutor.execute.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

      fs.mkdirSync(staleBasePath, { recursive: true });

      const staleDir = path.join(staleBasePath, 'slack-C123-stale');
      const recentDir = path.join(staleBasePath, 'slack-C456-recent');
      fs.mkdirSync(staleDir, { recursive: true });
      fs.mkdirSync(recentDir, { recursive: true });

      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      fs.utimesSync(staleDir, twoDaysAgo, twoDaysAgo);

      const cleaned = await WorkspaceManager.cleanupStale(staleBasePath, 24 * 60 * 60 * 1000);

      expect(cleaned).toBe(1);
      expect(fs.existsSync(staleDir)).toBe(false);
      expect(fs.existsSync(recentDir)).toBe(true);
    });

    it('prunes git worktrees in stale directories before removal', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');
      commandExecutor.execute.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

      fs.mkdirSync(staleBasePath, { recursive: true });

      const staleDir = path.join(staleBasePath, 'slack-C123-with-worktree');
      const subDir = path.join(staleDir, 'my-project');
      fs.mkdirSync(subDir, { recursive: true });

      // Simulate a git worktree .git file
      fs.writeFileSync(
        path.join(subDir, '.git'),
        'gitdir: /home/user/repo/.git/worktrees/my-project'
      );

      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      fs.utimesSync(staleDir, twoDaysAgo, twoDaysAgo);

      await WorkspaceManager.cleanupStale(staleBasePath, 24 * 60 * 60 * 1000);

      // Should have called git worktree remove
      const executeCalls = commandExecutor.execute.mock.calls;
      const worktreeRemoveCalls = executeCalls.filter((call: any[]) =>
        String(call[0]).includes('worktree remove')
      );
      expect(worktreeRemoveCalls.length).toBe(1);
      expect(worktreeRemoveCalls[0][0]).toContain('/home/user/repo');
    });
  });

  describe('repository name extraction', () => {
    it('extracts name from owner/repo format', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');
      commandExecutor.execute.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

      if (!fs.existsSync(testOriginalPath)) {
        fs.mkdirSync(testOriginalPath, { recursive: true });
      }

      const worktreePath = '/tmp/test-worktree';
      fs.mkdirSync(worktreePath, { recursive: true });

      const manager = WorkspaceManager.getInstance(testSessionId, testOriginalPath, {
        basePath: testBasePath,
      });

      await manager.initialize();
      const workspacePath = await manager.addProject('myorg/my-awesome-repo', worktreePath);

      expect(workspacePath).toContain('my-awesome-repo');

      fs.rmSync(testOriginalPath, { recursive: true, force: true });
      fs.rmSync(worktreePath, { recursive: true, force: true });
    });

    it('extracts name from git URL', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');
      commandExecutor.execute.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

      if (!fs.existsSync(testOriginalPath)) {
        fs.mkdirSync(testOriginalPath, { recursive: true });
      }

      const worktreePath = '/tmp/test-worktree';
      fs.mkdirSync(worktreePath, { recursive: true });

      const manager = WorkspaceManager.getInstance(testSessionId, testOriginalPath, {
        basePath: testBasePath,
      });

      await manager.initialize();
      const workspacePath = await manager.addProject(
        'https://github.com/owner/repo-name.git',
        worktreePath
      );

      expect(workspacePath).toContain('repo-name');

      fs.rmSync(testOriginalPath, { recursive: true, force: true });
      fs.rmSync(worktreePath, { recursive: true, force: true });
    });
  });
});
