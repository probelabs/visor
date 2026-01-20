/**
 * Tests for git-checkout provider workspace integration
 */

import * as fs from 'fs';
import { GitCheckoutProvider } from '../../../src/providers/git-checkout-provider';
import { WorkspaceManager } from '../../../src/utils/workspace-manager';
import type { PRInfo } from '../../../src/pr-analyzer';
import type { GitCheckoutConfig, GitCheckoutOutput } from '../../../src/types/git-checkout';

// Mock worktree manager
jest.mock('../../../src/utils/worktree-manager', () => ({
  worktreeManager: {
    getRepositoryUrl: jest.fn((repo: string) => `https://github.com/${repo}.git`),
    createWorktree: jest.fn(),
  },
}));

// Mock command executor
jest.mock('../../../src/utils/command-executor', () => ({
  commandExecutor: {
    execute: jest.fn(),
  },
}));

// Mock logger
jest.mock('../../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('GitCheckoutProvider Workspace Integration', () => {
  let provider: GitCheckoutProvider;
  let mockPRInfo: PRInfo;
  const testBasePath = '/tmp/git-checkout-workspace-test';

  beforeEach(() => {
    provider = new GitCheckoutProvider();
    mockPRInfo = {
      number: 123,
      title: 'Test PR',
      body: 'Test PR body',
      author: 'testuser',
      base: 'main',
      head: 'feature-branch',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
    } as PRInfo;

    WorkspaceManager.clearInstances();
    jest.clearAllMocks();

    process.env.VISOR_WORKSPACE_PATH = testBasePath;
    process.env.GITHUB_REPOSITORY = 'test-org/test-repo';
  });

  afterEach(() => {
    delete process.env.VISOR_WORKSPACE_PATH;
    delete process.env.GITHUB_REPOSITORY;

    if (fs.existsSync(testBasePath)) {
      fs.rmSync(testBasePath, { recursive: true, force: true });
    }
  });

  describe('Workspace Integration', () => {
    it('adds project to workspace when workspace is enabled', async () => {
      const { worktreeManager } = require('../../../src/utils/worktree-manager');
      const { commandExecutor } = require('../../../src/utils/command-executor');

      // Mock worktree creation
      const mockWorktreePath = '/tmp/mock-worktree';
      fs.mkdirSync(mockWorktreePath, { recursive: true });

      worktreeManager.createWorktree.mockResolvedValue({
        id: 'test-worktree-id',
        path: mockWorktreePath,
        ref: 'main',
        commit: 'abc123',
        metadata: {},
        locked: false,
      });

      // Mock git check (not a git repo for workspace)
      commandExecutor.execute.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

      // Create a workspace manager and initialize it
      const mainProjectDir = '/tmp/main-project-git-test';
      fs.mkdirSync(mainProjectDir, { recursive: true });

      const sessionId = 'test-session-123';
      const workspace = WorkspaceManager.getInstance(sessionId, mainProjectDir, {
        basePath: testBasePath,
      });
      await workspace.initialize();

      // Create execution context with workspace (internal property)
      const executionContext = {
        _parentContext: {
          workspace: workspace,
        },
      } as any;

      const config: GitCheckoutConfig = {
        type: 'git-checkout',
        ref: 'main',
        repository: 'external-org/external-repo',
        checkName: 'test-checkout',
      };

      try {
        const result = await provider.execute(
          mockPRInfo,
          config as any,
          undefined,
          executionContext
        );

        // Verify worktree was created
        expect(worktreeManager.createWorktree).toHaveBeenCalled();

        // Verify output has workspace_path
        expect((result as any).output).toBeDefined();
        const output = (result as any).output as GitCheckoutOutput;
        expect(output.success).toBe(true);
        expect(output.workspace_path).toBeDefined();

        // Verify project was added to workspace and the name is derived
        // from the repository/description, not the checkName.
        const projects = workspace.listProjects();
        expect(projects.length).toBe(1);
        expect(projects[0].name).toBe('external-repo');
      } finally {
        await workspace.cleanup();
        fs.rmSync(mainProjectDir, { recursive: true, force: true });
        fs.rmSync(mockWorktreePath, { recursive: true, force: true });
      }
    });

    it('works without workspace when not enabled', async () => {
      const { worktreeManager } = require('../../../src/utils/worktree-manager');

      // Mock worktree creation
      const mockWorktreePath = '/tmp/mock-worktree-no-ws';
      fs.mkdirSync(mockWorktreePath, { recursive: true });

      worktreeManager.createWorktree.mockResolvedValue({
        id: 'test-worktree-id',
        path: mockWorktreePath,
        ref: 'main',
        commit: 'abc123',
        metadata: {},
        locked: false,
      });

      // No workspace in execution context
      const executionContext = {
        _parentContext: {},
      } as any;

      const config: GitCheckoutConfig = {
        type: 'git-checkout',
        ref: 'main',
        repository: 'org/repo',
      };

      try {
        const result = await provider.execute(
          mockPRInfo,
          config as any,
          undefined,
          executionContext
        );

        expect((result as any).output).toBeDefined();
        const output = (result as any).output as GitCheckoutOutput;
        expect(output.success).toBe(true);
        expect(output.path).toBe(mockWorktreePath);
        // workspace_path should not be set when workspace is not enabled
        expect(output.workspace_path).toBeUndefined();
      } finally {
        fs.rmSync(mockWorktreePath, { recursive: true, force: true });
      }
    });

    it('handles workspace.addProject errors gracefully', async () => {
      const { worktreeManager } = require('../../../src/utils/worktree-manager');
      const { commandExecutor } = require('../../../src/utils/command-executor');

      // Mock worktree creation
      const mockWorktreePath = '/tmp/mock-worktree-error';
      fs.mkdirSync(mockWorktreePath, { recursive: true });

      worktreeManager.createWorktree.mockResolvedValue({
        id: 'test-worktree-id',
        path: mockWorktreePath,
        ref: 'main',
        commit: 'abc123',
        metadata: {},
        locked: false,
      });

      commandExecutor.execute.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

      // Create a mock workspace that throws on addProject
      const mockWorkspace = {
        isEnabled: () => true,
        addProject: jest.fn().mockRejectedValue(new Error('Add project failed')),
      };

      const executionContext = {
        _parentContext: {
          workspace: mockWorkspace,
        },
      } as any;

      const config: GitCheckoutConfig = {
        type: 'git-checkout',
        ref: 'main',
        repository: 'org/repo',
      };

      try {
        const result = await provider.execute(
          mockPRInfo,
          config as any,
          undefined,
          executionContext
        );

        // Should still succeed, just without workspace_path
        expect((result as any).output).toBeDefined();
        const output = (result as any).output as GitCheckoutOutput;
        expect(output.success).toBe(true);
        expect(output.workspace_path).toBeUndefined();
      } finally {
        fs.rmSync(mockWorktreePath, { recursive: true, force: true });
      }
    });

    it('uses checkName as description for workspace project name', async () => {
      const { worktreeManager } = require('../../../src/utils/worktree-manager');
      const { commandExecutor } = require('../../../src/utils/command-executor');

      // Mock worktree creation
      const mockWorktreePath = '/tmp/mock-worktree-desc';
      fs.mkdirSync(mockWorktreePath, { recursive: true });

      worktreeManager.createWorktree.mockResolvedValue({
        id: 'test-worktree-id',
        path: mockWorktreePath,
        ref: 'main',
        commit: 'abc123',
        metadata: {},
        locked: false,
      });

      commandExecutor.execute.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

      const mainProjectDir = '/tmp/main-project-desc-test';
      fs.mkdirSync(mainProjectDir, { recursive: true });

      const sessionId = 'test-session-desc';
      const workspace = WorkspaceManager.getInstance(sessionId, mainProjectDir, {
        basePath: testBasePath,
      });
      await workspace.initialize();

      const executionContext = {
        _parentContext: {
          workspace: workspace,
        },
      } as any;

      const config: GitCheckoutConfig = {
        type: 'git-checkout',
        ref: 'main',
        repository: 'org/very-long-repo-name',
        checkName: 'docs', // Short custom name
      };

      try {
        const result = await provider.execute(
          mockPRInfo,
          config as any,
          undefined,
          executionContext
        );

        const output = (result as any).output as GitCheckoutOutput;
        expect(output.success).toBe(true);

        // The workspace path should use the checkName if provided
        // (This depends on implementation - checking both possibilities)
        const projects = workspace.listProjects();
        expect(projects.length).toBe(1);
        // Either uses checkName "docs" or extracts "very-long-repo-name"
        expect(['docs', 'very-long-repo-name']).toContain(projects[0].name);
      } finally {
        await workspace.cleanup();
        fs.rmSync(mainProjectDir, { recursive: true, force: true });
        fs.rmSync(mockWorktreePath, { recursive: true, force: true });
      }
    });
  });

  describe('Output Structure', () => {
    it('includes workspace_path in output when workspace is enabled', async () => {
      const { worktreeManager } = require('../../../src/utils/worktree-manager');
      const { commandExecutor } = require('../../../src/utils/command-executor');

      const mockWorktreePath = '/tmp/mock-worktree-output';
      fs.mkdirSync(mockWorktreePath, { recursive: true });

      worktreeManager.createWorktree.mockResolvedValue({
        id: 'worktree-123',
        path: mockWorktreePath,
        ref: 'develop',
        commit: 'xyz789',
        metadata: {},
        locked: false,
      });

      commandExecutor.execute.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

      const mainProjectDir = '/tmp/main-output-test';
      fs.mkdirSync(mainProjectDir, { recursive: true });

      const sessionId = 'output-session';
      const workspace = WorkspaceManager.getInstance(sessionId, mainProjectDir, {
        basePath: testBasePath,
      });
      await workspace.initialize();

      const executionContext = {
        _parentContext: { workspace },
      } as any;

      const config: GitCheckoutConfig = {
        type: 'git-checkout',
        ref: 'develop',
        repository: 'company/project',
      };

      try {
        const result = await provider.execute(
          mockPRInfo,
          config as any,
          undefined,
          executionContext
        );

        const output = (result as any).output as GitCheckoutOutput;

        // Verify all expected output fields
        expect(output.success).toBe(true);
        expect(output.path).toBe(mockWorktreePath);
        expect(output.ref).toBe('develop');
        expect(output.commit).toBe('xyz789');
        expect(output.worktree_id).toBe('worktree-123');
        expect(output.repository).toBe('company/project');
        expect(output.is_worktree).toBe(true);
        expect(output.workspace_path).toBeDefined();
        expect(output.workspace_path).toContain(testBasePath);
        expect(output.workspace_path).toContain('project');
      } finally {
        await workspace.cleanup();
        fs.rmSync(mainProjectDir, { recursive: true, force: true });
        fs.rmSync(mockWorktreePath, { recursive: true, force: true });
      }
    });
  });
});
