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
