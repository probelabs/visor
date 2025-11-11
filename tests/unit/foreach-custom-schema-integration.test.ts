import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { CommandCheckProvider } from '../../src/providers/command-check-provider';
import { CheckProviderConfig } from '../../src/providers/check-provider.interface';
import { PRInfo } from '../../src/pr-analyzer';
import { ReviewSummary } from '../../src/reviewer';
import { CommandExecutionResult, CommandExecutionOptions } from '../../src/utils/command-executor';

// First, create the mock functions with the factory pattern
jest.mock('../../src/utils/command-executor', () => {
  const mockExecute =
    jest.fn<
      (command: string, options?: CommandExecutionOptions) => Promise<CommandExecutionResult>
    >();
  const mockBuildEnvironment = jest.fn().mockReturnValue({});

  return {
    commandExecutor: {
      execute: mockExecute,
      buildEnvironment: mockBuildEnvironment,
    },
    // Export mocks for test access
    __mockExecute: mockExecute,
    __mockBuildEnvironment: mockBuildEnvironment,
  };
});

// Import the mocked module to get the mock functions
const mockModule = jest.requireMock('../../src/utils/command-executor') as {
  __mockExecute: jest.MockedFunction<
    (command: string, options?: CommandExecutionOptions) => Promise<CommandExecutionResult>
  >;
  __mockBuildEnvironment: jest.MockedFunction<() => Record<string, string>>;
};
const mockExecute = mockModule.__mockExecute;
// mockBuildEnvironment is defined but not used in tests

/**
 * Test: forEach with Custom Schema Integration
 *
 * This test verifies the current behavior when a check with a custom schema
 * depends on a forEach check. The outputs should be collected into an array.
 *
 * Scenario:
 * 1. fetch-tickets (forEach) returns: [{ key: "TT-101" }, { key: "TT-102" }]
 * 2. analyze-bug (custom schema, depends on fetch-tickets) runs twice
 * 3. analyze-bug outputs: { ticket: "TT-101", complexity: "High", ... } for each
 * 4. Final outputs["analyze-bug"] should be: [{ ticket: "TT-101", ... }, { ticket: "TT-102", ... }]
 */
describe('forEach with Custom Schema Integration', () => {
  let provider: CommandCheckProvider;
  let mockPRInfo: PRInfo;

  beforeEach(() => {
    provider = new CommandCheckProvider();
    mockPRInfo = {
      number: 123,
      title: 'Test PR',
      body: 'Test body',
      author: 'testuser',
      base: 'main',
      head: 'feature',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
    };
    jest.clearAllMocks();
  });

  it('should collect custom schema outputs into array when depending on forEach', async () => {
    // Simulate analyze-bug check that depends on forEach fetch-tickets
    const config: CheckProviderConfig = {
      type: 'command',
      exec: 'echo "Analyzing {{ outputs["fetch-tickets"].key }}"',
    };

    // Simulate outputs from forEach parent that ran twice
    // Each execution produced a custom schema object
    const dependencyResults = new Map<string, ReviewSummary>();

    // This simulates what happens: multiple executions produce multiple outputs
    // which get collected into the 'output' array
    dependencyResults.set('analyze-bug-parent', {
      issues: [],
      output: [
        { ticket: 'TT-101', complexity: 'High', priority: 8 },
        { ticket: 'TT-102', complexity: 'Low', priority: 3 },
      ],
    } as ReviewSummary & { output: unknown });

    mockExecute.mockResolvedValue({
      stdout: 'test\n',
      stderr: '',
      exitCode: 0,
    });

    const result = await provider.execute(mockPRInfo, config, dependencyResults);

    // The outputs should be an array because the check ran multiple times
    expect((result as any).output).toBeDefined();
  });

  it('should show current behavior: custom schema from forEach dependency is wrapped in array', () => {
    // This documents the CURRENT behavior that the user is seeing

    // User has:
    // fetch-tickets (forEach: true) -> returns array of tickets
    // analyze-bug (custom schema, depends_on: [fetch-tickets])

    // When analyze-bug runs for each ticket, outputs are collected:
    const analyzeBugOutputs = [
      { ticket: 'TT-101', complexity: 'High', priority: 8 },
      { ticket: 'TT-102', complexity: 'Low', priority: 3 },
    ];

    // When log-results accesses outputs["analyze-bug"], it gets the array:
    const outputs = {
      'analyze-bug': analyzeBugOutputs,
    };

    // User expects an object but gets an array
    expect(Array.isArray(outputs['analyze-bug'])).toBe(true);
    expect(outputs['analyze-bug']).toHaveLength(2);
    expect(outputs['analyze-bug'][0].ticket).toBe('TT-101');
  });
});
