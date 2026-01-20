/**
 * Tests that resumeFromSnapshot properly initializes workspace isolation
 *
 * This test verifies the fix for GitHub issue #278:
 * Workspace isolation was not being initialized when resuming from a snapshot,
 * causing git checkouts to not be added to the workspace and AI providers
 * to not have access to checked-out repository paths.
 */

import * as fs from 'fs';
import { WorkspaceManager } from '../../src/utils/workspace-manager';

// Mock logger
jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    step: jest.fn(),
    success: jest.fn(),
    verbose: jest.fn(),
  },
}));

// Mock command executor (for workspace manager git operations)
jest.mock('../../src/utils/command-executor', () => ({
  commandExecutor: {
    execute: jest.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' }),
  },
}));

describe('resumeFromSnapshot workspace initialization', () => {
  const testBasePath = '/tmp/test-resume-workspace';
  const testWorkingDir = '/tmp/test-resume-working';

  beforeEach(() => {
    WorkspaceManager.clearInstances();
    jest.clearAllMocks();

    // Create test directories
    if (!fs.existsSync(testWorkingDir)) {
      fs.mkdirSync(testWorkingDir, { recursive: true });
    }

    // Set environment variable for workspace base path
    process.env.VISOR_WORKSPACE_PATH = testBasePath;
  });

  afterEach(() => {
    delete process.env.VISOR_WORKSPACE_PATH;
    delete process.env.VISOR_WORKSPACE_ENABLED;

    // Cleanup
    if (fs.existsSync(testBasePath)) {
      fs.rmSync(testBasePath, { recursive: true, force: true });
    }
    if (fs.existsSync(testWorkingDir)) {
      fs.rmSync(testWorkingDir, { recursive: true, force: true });
    }
  });

  test('resumeFromSnapshot calls initializeWorkspace when workspace is enabled', async () => {
    // Import the real implementation
    const { resumeFromSnapshot, StateMachineExecutionEngine } = await import(
      '../../src/state-machine-execution-engine'
    );

    // Spy on initializeWorkspace
    const initWorkspaceSpy = jest.spyOn(
      await import('../../src/state-machine/context/build-engine-context'),
      'initializeWorkspace'
    );

    const engine = new StateMachineExecutionEngine(testWorkingDir);

    // Create a minimal snapshot
    const snapshot = {
      version: 1,
      sessionId: 'test-session',
      state: {
        currentState: 'Routing',
        wave: 1,
        levelQueue: [],
        eventQueue: [],
        activeDispatches: [],
        completedChecks: [],
        stats: [],
        historyLog: [],
        forwardRunGuards: [],
        currentLevelChecks: [],
        pendingRunScopes: [],
      },
      journal: [],
      requestedChecks: ['test-check'],
    };

    // Config with workspace enabled
    const config = {
      version: '1.0',
      output: { format: 'json' },
      checks: {
        'test-check': {
          type: 'noop',
        },
      },
      workspace: {
        enabled: true,
      },
    };

    try {
      // Run resumeFromSnapshot - it should call initializeWorkspace
      await resumeFromSnapshot(engine, snapshot as any, config as any, {
        debug: true,
      });
    } catch {
      // Execution may fail due to mocking, but we just want to verify initializeWorkspace was called
    }

    // Verify that initializeWorkspace was called
    expect(initWorkspaceSpy).toHaveBeenCalled();

    // The context passed to initializeWorkspace should have workspace config
    const callArg = initWorkspaceSpy.mock.calls[0][0];
    expect(callArg).toBeDefined();
    expect(callArg.config).toBeDefined();
    expect((callArg.config as any).workspace?.enabled).toBe(true);

    initWorkspaceSpy.mockRestore();
  });

  test('resumeFromSnapshot creates workspace when config enables it', async () => {
    const { resumeFromSnapshot, StateMachineExecutionEngine } = await import(
      '../../src/state-machine-execution-engine'
    );

    const engine = new StateMachineExecutionEngine(testWorkingDir);

    const snapshot = {
      version: 1,
      sessionId: 'test-session-2',
      state: {
        currentState: 'Routing',
        wave: 1,
        levelQueue: [],
        eventQueue: [],
        activeDispatches: [],
        completedChecks: [],
        stats: [],
        historyLog: [],
        forwardRunGuards: [],
        currentLevelChecks: [],
        pendingRunScopes: [],
      },
      journal: [],
      requestedChecks: ['test-check'],
    };

    const config = {
      version: '1.0',
      output: { format: 'json' },
      checks: {
        'test-check': {
          type: 'noop',
        },
      },
      workspace: {
        enabled: true,
        base_path: testBasePath,
      },
    };

    try {
      await resumeFromSnapshot(engine, snapshot as any, config as any, {
        debug: true,
      });
    } catch {
      // Execution may fail, but workspace should still be created
    }

    // Verify workspace directory was created
    expect(fs.existsSync(testBasePath)).toBe(true);
  });
});
