/**
 * Tests for workspace initialization in build-engine-context.ts
 */

import * as fs from 'fs';
import {
  buildEngineContextForRun,
  initializeWorkspace,
} from '../../src/state-machine/context/build-engine-context';
import { WorkspaceManager } from '../../src/utils/workspace-manager';
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

describe('Workspace Initialization', () => {
  const testBasePath = '/tmp/test-visor-workspace-init';
  const testWorkingDir = '/tmp/test-project-workspace';

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

  beforeEach(() => {
    // Clear workspace instances
    WorkspaceManager.clearInstances();
    jest.clearAllMocks();

    // Create test directories
    if (!fs.existsSync(testWorkingDir)) {
      fs.mkdirSync(testWorkingDir, { recursive: true });
    }

    // Set environment variable to override base path
    process.env.VISOR_WORKSPACE_PATH = testBasePath;
  });

  afterEach(() => {
    // Cleanup
    delete process.env.VISOR_WORKSPACE_PATH;
    delete process.env.VISOR_WORKSPACE_ENABLED;

    if (fs.existsSync(testBasePath)) {
      fs.rmSync(testBasePath, { recursive: true, force: true });
    }
    if (fs.existsSync(testWorkingDir)) {
      fs.rmSync(testWorkingDir, { recursive: true, force: true });
    }
  });

  describe('buildEngineContextForRun', () => {
    it('sets originalWorkingDirectory to workingDirectory', () => {
      const cfg: VisorConfig = {
        version: '1',
        output: { format: 'json' },
        checks: {},
      } as any;

      const ctx = buildEngineContextForRun(testWorkingDir, cfg, mockPRInfo as any);

      expect(ctx.workingDirectory).toBe(testWorkingDir);
      expect(ctx.originalWorkingDirectory).toBe(testWorkingDir);
    });

    it('generates unique sessionId', () => {
      const cfg: VisorConfig = {
        version: '1',
        output: { format: 'json' },
        checks: {},
      } as any;

      const ctx1 = buildEngineContextForRun(testWorkingDir, cfg, mockPRInfo as any);
      const ctx2 = buildEngineContextForRun(testWorkingDir, cfg, mockPRInfo as any);

      expect(ctx1.sessionId).toBeDefined();
      expect(ctx2.sessionId).toBeDefined();
      expect(ctx1.sessionId).not.toBe(ctx2.sessionId);
    });
  });

  describe('initializeWorkspace', () => {
    it('skips initialization when VISOR_WORKSPACE_ENABLED is false', async () => {
      process.env.VISOR_WORKSPACE_ENABLED = 'false';

      const cfg: VisorConfig = {
        version: '1',
        output: { format: 'json' },
        checks: {},
      } as any;

      const ctx = buildEngineContextForRun(testWorkingDir, cfg, mockPRInfo as any);
      const result = await initializeWorkspace(ctx);

      expect(result.workspace).toBeUndefined();
      expect(result.workingDirectory).toBe(testWorkingDir);
    });

    it('skips initialization when config.workspace.enabled is false', async () => {
      const cfg: VisorConfig = {
        version: '1',
        output: { format: 'json' },
        checks: {},
        workspace: {
          enabled: false,
        },
      } as any;

      const ctx = buildEngineContextForRun(testWorkingDir, cfg, mockPRInfo as any);
      const result = await initializeWorkspace(ctx);

      expect(result.workspace).toBeUndefined();
      expect(result.workingDirectory).toBe(testWorkingDir);
    });

    it('initializes workspace when enabled (non-git directory)', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');
      // Mock: not a git repository
      commandExecutor.execute.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

      const cfg: VisorConfig = {
        version: '1',
        output: { format: 'json' },
        checks: {},
      } as any;

      const ctx = buildEngineContextForRun(testWorkingDir, cfg, mockPRInfo as any);
      const result = await initializeWorkspace(ctx);

      expect(result.workspace).toBeDefined();
      expect(result.workspace?.isEnabled()).toBe(true);
      expect(result.originalWorkingDirectory).toBe(testWorkingDir);
      // workingDirectory should be updated to workspace path
      expect(result.workingDirectory).toContain(testBasePath);
      expect(result.workingDirectory).toContain(ctx.sessionId);

      // Cleanup
      await result.workspace?.cleanup();
    });

    it('uses custom base_path from config', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');
      commandExecutor.execute.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

      const customBasePath = '/tmp/custom-visor-workspaces';
      const cfg: VisorConfig = {
        version: '1',
        output: { format: 'json' },
        checks: {},
        workspace: {
          enabled: true,
          base_path: customBasePath,
        },
      } as any;

      const ctx = buildEngineContextForRun(testWorkingDir, cfg, mockPRInfo as any);
      const result = await initializeWorkspace(ctx);

      expect(result.workspace).toBeDefined();
      expect(result.workspace?.getWorkspacePath()).toContain(customBasePath);

      // Cleanup
      await result.workspace?.cleanup();
      if (fs.existsSync(customBasePath)) {
        fs.rmSync(customBasePath, { recursive: true, force: true });
      }
    });

    it('handles initialization failure gracefully', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');
      // Mock: isGitRepository check fails
      commandExecutor.execute.mockRejectedValue(new Error('Command failed'));

      const cfg: VisorConfig = {
        version: '1',
        output: { format: 'json' },
        checks: {},
      } as any;

      // Use a directory path that triggers symlink failure (a file, not directory)
      const testFilePath = '/tmp/workspace-test-file';
      const fs = require('fs');
      fs.writeFileSync(testFilePath, 'not a directory');

      try {
        const ctx = buildEngineContextForRun(testFilePath, cfg, mockPRInfo as any);
        const result = await initializeWorkspace(ctx);

        // Should continue without workspace when initialization fails
        // Either workingDirectory stays original or workspace is undefined
        expect(result.originalWorkingDirectory).toBe(testFilePath);
      } finally {
        fs.unlinkSync(testFilePath);
      }
    });

    it('stores workspace manager in context', async () => {
      const { commandExecutor } = require('../../src/utils/command-executor');
      commandExecutor.execute.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

      const cfg: VisorConfig = {
        version: '1',
        output: { format: 'json' },
        checks: {},
      } as any;

      const ctx = buildEngineContextForRun(testWorkingDir, cfg, mockPRInfo as any);
      const result = await initializeWorkspace(ctx);

      expect(result.workspace).toBeInstanceOf(WorkspaceManager);
      expect(result.workspace?.getOriginalPath()).toBe(testWorkingDir);

      // Cleanup
      await result.workspace?.cleanup();
    });
  });
});
