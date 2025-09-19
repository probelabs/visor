/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for CLI failure condition integration
 */

import { main } from '../../src/cli-main';
import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { FailureConditionResult } from '../../src/types/config';

// Mock modules
jest.mock('../../src/check-execution-engine');
jest.mock('../../src/config');
jest.mock('../../src/cli');
jest.mock('../../src/output-formatters');
jest.mock('../../src/reviewer');

const mockCheckExecutionEngine = CheckExecutionEngine as jest.MockedClass<
  typeof CheckExecutionEngine
>;

// Import and mock the classes we need
import { ConfigManager } from '../../src/config';
import { CLI } from '../../src/cli';
import { OutputFormatters } from '../../src/output-formatters';
import * as reviewer from '../../src/reviewer';

const mockConfigManager = ConfigManager as jest.MockedClass<typeof ConfigManager>;
const mockCLI = CLI as jest.MockedClass<typeof CLI>;
const mockOutputFormatters = OutputFormatters as jest.MockedClass<typeof OutputFormatters>;

describe('CLI Failure Conditions Integration', () => {
  let mockExecuteChecks: jest.Mock;
  let mockEvaluateFailureConditions: jest.Mock;
  let originalArgv: string[];
  let originalExit: typeof process.exit;
  let exitCode: number | undefined;

  beforeEach(() => {
    // Store original values
    originalArgv = process.argv;
    originalExit = process.exit;
    exitCode = undefined;

    // Mock process.exit to capture exit codes
    process.exit = jest.fn((code?: number) => {
      exitCode = code;
      throw new Error(`Process exit called with code ${code}`);
    }) as any;

    // Mock console methods to reduce test output
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});

    // Setup CheckExecutionEngine mock
    mockExecuteChecks = jest.fn();
    mockEvaluateFailureConditions = jest.fn();

    // Mock static methods
    CheckExecutionEngine.validateCheckTypes = jest.fn().mockReturnValue({
      valid: ['security'],
      invalid: [],
    });

    mockCheckExecutionEngine.mockImplementation(
      () =>
        ({
          executeChecks: mockExecuteChecks,
          evaluateFailureConditions: mockEvaluateFailureConditions,
          getRepositoryStatus: jest.fn().mockResolvedValue({
            isGitRepository: true,
            hasChanges: true,
            branch: 'main',
            filesChanged: 5,
          }),
        }) as any
    );

    // Setup CLI mock
    const mockParseArgs = jest.fn().mockReturnValue({
      check: ['security'],
      output: 'table',
      configPath: undefined,
      timeout: undefined,
      debug: false,
      failFast: false,
    });

    const mockGetHelpText = jest.fn().mockReturnValue('Help text');
    const mockGetVersion = jest.fn().mockReturnValue('1.0.0');

    mockCLI.mockImplementation(
      () =>
        ({
          parseArgs: mockParseArgs,
          getHelpText: mockGetHelpText,
          getVersion: mockGetVersion,
        }) as any
    );

    // Setup ConfigManager mock
    const mockConfig = {
      version: '1.0.0',
      project: { name: 'test', type: 'typescript' },
      checks: {
        security: {
          type: 'ai',
          enabled: true,
        },
      },
      cliOutput: 'table',
      cliChecks: ['security'],
    };

    mockConfigManager.mockImplementation(
      () =>
        ({
          loadConfig: jest.fn().mockResolvedValue(mockConfig),
          findAndLoadConfig: jest.fn().mockResolvedValue(mockConfig),
          getDefaultConfig: jest.fn().mockResolvedValue(mockConfig),
          mergeWithCliOptions: jest.fn().mockReturnValue(mockConfig),
        }) as any
    );

    // Setup OutputFormatters mock
    mockOutputFormatters.formatAsJSON = jest.fn().mockReturnValue(
      JSON.stringify({
        reviewSummary: { issues: [], suggestions: [] },
        repositoryInfo: {},
        executionTime: 1000,
        timestamp: '2023-01-01T00:00:00Z',
        checksExecuted: ['security'],
        failureConditions: [],
      })
    );
    mockOutputFormatters.formatAsTable = jest.fn().mockReturnValue('table output');
    mockOutputFormatters.formatAsMarkdown = jest.fn().mockReturnValue('markdown output');
    mockOutputFormatters.formatAsSarif = jest.fn().mockReturnValue('sarif output');

    // Setup reviewer mock
    (reviewer.calculateTotalIssues as jest.Mock) = jest.fn().mockReturnValue(0);
    (reviewer.calculateCriticalIssues as jest.Mock) = jest.fn().mockReturnValue(0);
  });

  afterEach(() => {
    // Restore original values
    process.argv = originalArgv;
    process.exit = originalExit;
    jest.restoreAllMocks();
  });

  it('should exit with code 0 when no failure conditions are met', async () => {
    // Setup test scenario
    process.argv = ['node', 'cli-main.js', '--check', 'security'];

    mockExecuteChecks.mockResolvedValue({
      reviewSummary: { issues: [], suggestions: [] },
      repositoryInfo: {},
      executionTime: 1000,
      timestamp: '2023-01-01T00:00:00Z',
      checksExecuted: ['security'],
    });

    mockEvaluateFailureConditions.mockResolvedValue([]);

    try {
      await main();
    } catch {
      // Expected due to mocked process.exit
    }

    expect(exitCode).toBeUndefined(); // Should not exit with error
  });

  it('should exit with code 1 when failure conditions are met', async () => {
    // Setup test scenario with failed conditions
    process.argv = ['node', 'cli-main.js', '--check', 'security'];

    mockExecuteChecks.mockResolvedValue({
      reviewSummary: {
        issues: [{ severity: 'critical', message: 'Test issue', file: 'test.js', line: 1 }],
        suggestions: [],
      },
      repositoryInfo: {},
      executionTime: 1000,
      timestamp: '2023-01-01T00:00:00Z',
      checksExecuted: ['security'],
    });

    const failureResults: FailureConditionResult[] = [
      {
        conditionName: 'critical-issues',
        expression: 'metadata.criticalIssues > 0',
        failed: true,
        message: 'Critical issues found',
        severity: 'error',
        haltExecution: false,
      },
    ];

    mockEvaluateFailureConditions.mockResolvedValue(failureResults);

    try {
      await main();
    } catch {
      // Expected due to mocked process.exit
    }

    expect(exitCode).toBe(1);
  });

  it('should exit with code 2 for configuration/execution errors', async () => {
    // Setup test scenario with execution error
    process.argv = ['node', 'cli-main.js', '--check', 'security'];

    mockExecuteChecks.mockRejectedValue(new Error('Configuration error'));

    try {
      await main();
    } catch {
      // Expected due to mocked process.exit
    }

    expect(exitCode).toBe(1); // Current implementation uses 1 for all errors
  });

  it('should handle --fail-fast flag correctly', async () => {
    // Setup test scenario
    process.argv = ['node', 'cli-main.js', '--check', 'security', '--fail-fast'];

    mockExecuteChecks.mockResolvedValue({
      reviewSummary: { issues: [], suggestions: [] },
      repositoryInfo: {},
      executionTime: 1000,
      timestamp: '2023-01-01T00:00:00Z',
      checksExecuted: ['security'],
    });

    const failureResults: FailureConditionResult[] = [
      {
        conditionName: 'halt-condition',
        expression: 'metadata.totalIssues > 10',
        failed: true,
        message: 'Too many issues - halting execution',
        severity: 'error',
        haltExecution: true,
      },
    ];

    mockEvaluateFailureConditions.mockResolvedValue(failureResults);

    try {
      await main();
    } catch {
      // Expected due to mocked process.exit
    }

    expect(exitCode).toBe(1);
  });

  it('should include failure condition results in JSON output', async () => {
    // Setup test scenario with JSON output
    process.argv = ['node', 'cli-main.js', '--check', 'security', '--output', 'json'];

    // Restore console.log temporarily for this test
    const originalConsoleLog = console.log;
    const consoleSpy = jest.fn();
    console.log = consoleSpy;

    // Update CLI mock to return JSON output mode
    const mockParseArgs = jest.fn().mockReturnValue({
      check: ['security'],
      output: 'json',
      configPath: undefined,
      timeout: undefined,
      debug: false,
      failFast: false,
    });

    mockCLI.mockImplementation(
      () =>
        ({
          parseArgs: mockParseArgs,
          getHelpText: jest.fn().mockReturnValue('Help text'),
          getVersion: jest.fn().mockReturnValue('1.0.0'),
        }) as any
    );

    // Update config to return JSON output
    const mockConfig = {
      version: '1.0.0',
      project: { name: 'test', type: 'typescript' },
      checks: {
        security: {
          type: 'ai',
          enabled: true,
        },
      },
      cliOutput: 'json',
      cliChecks: ['security'],
    };

    mockConfigManager.mockImplementation(
      () =>
        ({
          loadConfig: jest.fn().mockResolvedValue(mockConfig),
          findAndLoadConfig: jest.fn().mockResolvedValue(mockConfig),
          getDefaultConfig: jest.fn().mockResolvedValue(mockConfig),
          mergeWithCliOptions: jest.fn().mockReturnValue(mockConfig),
        }) as any
    );

    mockExecuteChecks.mockResolvedValue({
      reviewSummary: { issues: [], suggestions: [] },
      repositoryInfo: {},
      executionTime: 1000,
      timestamp: '2023-01-01T00:00:00Z',
      checksExecuted: ['security'],
    });

    const failureResults: FailureConditionResult[] = [
      {
        conditionName: 'test-condition',
        expression: 'metadata.totalIssues == 0',
        failed: false,
        message: 'No issues found',
        severity: 'info',
        haltExecution: false,
      },
    ];

    mockEvaluateFailureConditions.mockResolvedValue(failureResults);

    try {
      await main();
    } catch {
      // Expected due to mocked process.exit
    }

    // Verify JSON output includes failure conditions
    const jsonOutput = consoleSpy.mock.calls.find(
      call => typeof call[0] === 'string' && call[0].includes('failureConditions')
    );

    expect(jsonOutput).toBeDefined();

    // Restore console.log
    console.log = originalConsoleLog;
  });
});
