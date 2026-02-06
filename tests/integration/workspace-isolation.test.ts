/**
 * Integration tests for workspace isolation feature
 *
 * Tests the complete flow of workspace isolation including:
 * - Workspace creation and cleanup
 * - Main project worktree/symlink creation
 * - Project addition via git-checkout
 * - Human-readable project naming
 * - Parallel run isolation
 */

import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceManager } from '../../src/utils/workspace-manager';
import {
  buildEngineContextForRun,
  initializeWorkspace,
} from '../../src/state-machine/context/build-engine-context';
import type { VisorConfig } from '../../src/types/config';

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

describe('Workspace Isolation Integration', () => {
  const testBasePath = '/tmp/visor-workspace-integration-test';

  beforeEach(() => {
    WorkspaceManager.clearInstances();
    jest.clearAllMocks();
    process.env.VISOR_WORKSPACE_PATH = testBasePath;
  });

  afterEach(() => {
    delete process.env.VISOR_WORKSPACE_PATH;
    delete process.env.VISOR_WORKSPACE_ENABLED;

    // Cleanup test directories
    if (fs.existsSync(testBasePath)) {
      fs.rmSync(testBasePath, { recursive: true, force: true });
    }
  });

  describe('Complete Workspace Lifecycle', () => {
    it('creates isolated workspace with main project and adds external projects', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');
      // Mock: not a git repo (will create symlink instead of worktree)
      commandExecutor.execute.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

      // Create test directories
      const mainProjectDir = '/tmp/main-project-test';
      const externalProject1 = '/tmp/external-project-1';
      const externalProject2 = '/tmp/external-project-2';

      fs.mkdirSync(mainProjectDir, { recursive: true });
      fs.mkdirSync(externalProject1, { recursive: true });
      fs.mkdirSync(externalProject2, { recursive: true });

      // Create some test files
      fs.writeFileSync(path.join(mainProjectDir, 'README.md'), '# Main Project');
      fs.writeFileSync(path.join(externalProject1, 'index.js'), 'console.log("ext1")');
      fs.writeFileSync(path.join(externalProject2, 'index.js'), 'console.log("ext2")');

      try {
        // Step 1: Build engine context
        const cfg: VisorConfig = {
          version: '1',
          output: { format: 'json' },
          checks: {},
        } as any;

        const mockPRInfo = {
          eventType: 'manual' as const,
          owner: 'test-owner',
          repo: 'test-repo',
          prNumber: 1,
          branch: 'main',
          baseSha: 'abc123',
          headSha: 'def456',
          commitMessage: 'Test commit',
        };

        const ctx = buildEngineContextForRun(mainProjectDir, cfg, mockPRInfo as any);

        // Step 2: Initialize workspace
        const initializedCtx = await initializeWorkspace(ctx);

        expect(initializedCtx.workspace).toBeDefined();
        const workspace = initializedCtx.workspace!;

        // Verify workspace structure
        const workspacePath = workspace.getWorkspacePath();
        expect(fs.existsSync(workspacePath)).toBe(true);

        // Verify main project is in workspace
        const mainProjectInWorkspace = path.join(workspacePath, 'main-project-test');
        expect(fs.existsSync(mainProjectInWorkspace)).toBe(true);

        // Step 3: Add external projects (simulating git-checkout)
        const ext1Path = await workspace.addProject('org/external-repo-1', externalProject1);
        const ext2Path = await workspace.addProject('org/external-repo-2', externalProject2);

        // Verify human-readable project names
        expect(ext1Path).toBe(path.join(workspacePath, 'external-repo-1'));
        expect(ext2Path).toBe(path.join(workspacePath, 'external-repo-2'));

        // Verify symlinks work
        expect(fs.existsSync(ext1Path)).toBe(true);
        expect(fs.existsSync(ext2Path)).toBe(true);

        // Verify files are accessible through symlinks
        const ext1Content = fs.readFileSync(path.join(ext1Path, 'index.js'), 'utf-8');
        expect(ext1Content).toBe('console.log("ext1")');

        // Step 4: List projects
        const projects = workspace.listProjects();
        expect(projects.length).toBe(2);
        expect(projects.map(p => p.name)).toContain('external-repo-1');
        expect(projects.map(p => p.name)).toContain('external-repo-2');

        // Step 5: Cleanup
        await workspace.cleanup();

        // Verify cleanup removed workspace
        expect(fs.existsSync(workspacePath)).toBe(false);
      } finally {
        // Cleanup test directories
        fs.rmSync(mainProjectDir, { recursive: true, force: true });
        fs.rmSync(externalProject1, { recursive: true, force: true });
        fs.rmSync(externalProject2, { recursive: true, force: true });
      }
    });
  });

  describe('Parallel Run Isolation', () => {
    it('creates separate workspaces for concurrent sessions', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');
      commandExecutor.execute.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

      const projectDir = '/tmp/parallel-test-project';
      fs.mkdirSync(projectDir, { recursive: true });

      try {
        const cfg: VisorConfig = {
          version: '1',
          output: { format: 'json' },
          checks: {},
        } as any;

        const mockPRInfo = {
          eventType: 'manual' as const,
          owner: 'test-owner',
          repo: 'test-repo',
          prNumber: 1,
          branch: 'main',
          baseSha: 'abc123',
          headSha: 'def456',
          commitMessage: 'Test commit',
        };

        // Create two separate contexts (simulating parallel runs)
        const ctx1 = buildEngineContextForRun(projectDir, cfg, mockPRInfo as any);
        const ctx2 = buildEngineContextForRun(projectDir, cfg, mockPRInfo as any);

        // Initialize both workspaces
        const initialized1 = await initializeWorkspace(ctx1);
        const initialized2 = await initializeWorkspace(ctx2);

        // Verify they have different session IDs
        expect(ctx1.sessionId).not.toBe(ctx2.sessionId);

        // Verify they have different workspace paths
        const workspace1Path = initialized1.workspace?.getWorkspacePath();
        const workspace2Path = initialized2.workspace?.getWorkspacePath();

        expect(workspace1Path).toBeDefined();
        expect(workspace2Path).toBeDefined();
        expect(workspace1Path).not.toBe(workspace2Path);

        // Verify both workspaces exist
        expect(fs.existsSync(workspace1Path!)).toBe(true);
        expect(fs.existsSync(workspace2Path!)).toBe(true);

        // Add different projects to each workspace
        const ext1Dir = '/tmp/ext1-parallel';
        const ext2Dir = '/tmp/ext2-parallel';
        fs.mkdirSync(ext1Dir, { recursive: true });
        fs.mkdirSync(ext2Dir, { recursive: true });
        fs.writeFileSync(path.join(ext1Dir, 'file1.txt'), 'workspace1');
        fs.writeFileSync(path.join(ext2Dir, 'file2.txt'), 'workspace2');

        await initialized1.workspace?.addProject('org/repo-a', ext1Dir);
        await initialized2.workspace?.addProject('org/repo-b', ext2Dir);

        // Verify isolation - each workspace has only its own project
        const projects1 = initialized1.workspace?.listProjects() || [];
        const projects2 = initialized2.workspace?.listProjects() || [];

        expect(projects1.map(p => p.name)).toContain('repo-a');
        expect(projects1.map(p => p.name)).not.toContain('repo-b');

        expect(projects2.map(p => p.name)).toContain('repo-b');
        expect(projects2.map(p => p.name)).not.toContain('repo-a');

        // Cleanup
        await initialized1.workspace?.cleanup();
        await initialized2.workspace?.cleanup();

        fs.rmSync(ext1Dir, { recursive: true, force: true });
        fs.rmSync(ext2Dir, { recursive: true, force: true });
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    });
  });

  describe('Human-Readable Project Naming', () => {
    it('extracts project name from owner/repo format', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');
      commandExecutor.execute.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

      const projectDir = '/tmp/naming-test-project';
      const extDir = '/tmp/naming-ext';
      fs.mkdirSync(projectDir, { recursive: true });
      fs.mkdirSync(extDir, { recursive: true });

      try {
        const cfg: VisorConfig = {
          version: '1',
          output: { format: 'json' },
          checks: {},
        } as any;

        const mockPRInfo = {
          eventType: 'manual' as const,
          owner: 'test',
          repo: 'test',
          prNumber: 1,
          branch: 'main',
          baseSha: 'x',
          headSha: 'y',
          commitMessage: '',
        };

        const ctx = buildEngineContextForRun(projectDir, cfg, mockPRInfo as any);
        const initialized = await initializeWorkspace(ctx);

        // Test various repository formats
        const testCases = [
          { input: 'myorg/my-repo', expected: 'my-repo' },
          { input: 'https://github.com/owner/repo-name.git', expected: 'repo-name' },
          { input: 'git@github.com:org/another-repo.git', expected: 'another-repo' },
        ];

        for (const testCase of testCases) {
          const tmpDir = `/tmp/naming-test-${Date.now()}`;
          fs.mkdirSync(tmpDir, { recursive: true });

          const workspacePath = await initialized.workspace?.addProject(testCase.input, tmpDir);
          expect(workspacePath).toContain(testCase.expected);

          fs.rmSync(tmpDir, { recursive: true, force: true });
        }

        await initialized.workspace?.cleanup();
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
        fs.rmSync(extDir, { recursive: true, force: true });
      }
    });

    it('handles duplicate repository names with suffixes', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');
      commandExecutor.execute.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

      const projectDir = '/tmp/dupe-test-project';
      fs.mkdirSync(projectDir, { recursive: true });

      const ext1 = '/tmp/dupe-ext-1';
      const ext2 = '/tmp/dupe-ext-2';
      const ext3 = '/tmp/dupe-ext-3';
      fs.mkdirSync(ext1, { recursive: true });
      fs.mkdirSync(ext2, { recursive: true });
      fs.mkdirSync(ext3, { recursive: true });

      try {
        const cfg: VisorConfig = {
          version: '1',
          output: { format: 'json' },
          checks: {},
        } as any;

        const mockPRInfo = {
          eventType: 'manual' as const,
          owner: 'test',
          repo: 'test',
          prNumber: 1,
          branch: 'main',
          baseSha: 'x',
          headSha: 'y',
          commitMessage: '',
        };

        const ctx = buildEngineContextForRun(projectDir, cfg, mockPRInfo as any);
        const initialized = await initializeWorkspace(ctx);
        const workspace = initialized.workspace!;

        // Add three repos with the same name from different orgs
        const path1 = await workspace.addProject('org-a/common-name', ext1);
        const path2 = await workspace.addProject('org-b/common-name', ext2);
        const path3 = await workspace.addProject('org-c/common-name', ext3);

        // First should be just the name
        expect(path1).toContain('common-name');
        expect(path1).not.toContain('common-name-2');

        // Second should have suffix -2
        expect(path2).toContain('common-name-2');

        // Third should have suffix -3
        expect(path3).toContain('common-name-3');

        // All three should exist and be different
        expect(path1).not.toBe(path2);
        expect(path2).not.toBe(path3);

        await workspace.cleanup();
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
        fs.rmSync(ext1, { recursive: true, force: true });
        fs.rmSync(ext2, { recursive: true, force: true });
        fs.rmSync(ext3, { recursive: true, force: true });
      }
    });
  });

  describe('Workspace Info', () => {
    it('provides workspace information after initialization', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');
      commandExecutor.execute.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

      const projectDir = '/tmp/info-test-project';
      fs.mkdirSync(projectDir, { recursive: true });

      try {
        const cfg: VisorConfig = {
          version: '1',
          output: { format: 'json' },
          checks: {},
        } as any;

        const mockPRInfo = {
          eventType: 'manual' as const,
          owner: 'test',
          repo: 'test',
          prNumber: 1,
          branch: 'main',
          baseSha: 'x',
          headSha: 'y',
          commitMessage: '',
        };

        const ctx = buildEngineContextForRun(projectDir, cfg, mockPRInfo as any);
        const initialized = await initializeWorkspace(ctx);
        const workspace = initialized.workspace!;

        const info = workspace.getWorkspaceInfo();

        expect(info).toBeDefined();
        expect(info?.sessionId).toBe(ctx.sessionId);
        expect(info?.originalPath).toBe(projectDir);
        expect(info?.workspacePath).toContain(testBasePath);
        expect(info?.mainProjectName).toBe('info-test-project');
        expect(info?.mainProjectPath).toBe(path.join(info!.workspacePath, 'info-test-project'));

        await workspace.cleanup();
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    });
  });

  describe('Error Recovery', () => {
    it('continues without workspace when initialization fails', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');
      // Make all commands fail
      commandExecutor.execute.mockRejectedValue(new Error('Git error'));

      const cfg: VisorConfig = {
        version: '1',
        output: { format: 'json' },
        checks: {},
      } as any;

      const mockPRInfo = {
        eventType: 'manual' as const,
        owner: 'test',
        repo: 'test',
        prNumber: 1,
        branch: 'main',
        baseSha: 'x',
        headSha: 'y',
        commitMessage: '',
      };

      // Use a file path (not directory) to trigger symlink failure
      const testFilePath = '/tmp/workspace-error-test-file';
      fs.writeFileSync(testFilePath, 'not a directory');

      try {
        const ctx = buildEngineContextForRun(testFilePath, cfg, mockPRInfo as any);
        const initialized = await initializeWorkspace(ctx);

        // Should gracefully continue - originalWorkingDirectory preserves original
        expect(initialized.originalWorkingDirectory).toBe(testFilePath);
      } finally {
        fs.unlinkSync(testFilePath);
      }
    });
  });
});
