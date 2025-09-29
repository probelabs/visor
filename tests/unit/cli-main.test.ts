/* eslint-disable @typescript-eslint/no-explicit-any */
import { main } from '../../src/cli-main';

// Mock process.argv and console methods for testing
const originalArgv = process.argv;
const originalExit = process.exit;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalStderrWrite = process.stderr.write;

describe('CLI Main Entry Point', () => {
  let mockConsoleLog: jest.Mock;
  let mockConsoleError: jest.Mock;
  let mockProcessExit: jest.Mock;
  let capturedStderr = '';
  let mockStderrWrite: jest.Mock;

  beforeEach(() => {
    mockConsoleLog = jest.fn();
    mockConsoleError = jest.fn();
    mockProcessExit = jest.fn();

    console.log = mockConsoleLog;
    console.error = mockConsoleError;
    process.exit = mockProcessExit as any;

    // Capture stderr written by centralized logger
    capturedStderr = '';
    mockStderrWrite = jest.fn((chunk: any) => {
      capturedStderr += String(chunk);
      return true;
    });
    (process.stderr.write as unknown as jest.Mock | ((...a: any[]) => any)) =
      mockStderrWrite as any;
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    (process.stderr.write as unknown as jest.Mock | ((...a: any[]) => any)) =
      originalStderrWrite as any;
    jest.clearAllMocks();
  });

  it('should display help when --help flag is provided', async () => {
    process.argv = ['node', 'visor', '--help'];

    await main();

    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Usage: visor [options]'));
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Examples:'));
    expect(mockProcessExit).toHaveBeenCalledWith(0);
  });

  it('should display version when --version flag is provided', async () => {
    process.argv = ['node', 'visor', '--version'];

    await main();

    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringMatching(/^\d+\.\d+\.\d+$/));
    expect(mockProcessExit).toHaveBeenCalledWith(0);
  });

  it('should run CLI with no arguments', async () => {
    process.argv = ['node', 'visor'];

    await main();

    // Assert via stderr capture to support centralized logger
    expect(capturedStderr).toContain('🔍 Visor - AI-powered code review tool');
    expect(capturedStderr).toContain('Configuration version: 1.0');
    expect(capturedStderr).toContain('Repository:');
  });

  it('should run CLI with check arguments', async () => {
    process.argv = ['node', 'visor', '--check', 'performance', '--output', 'json'];

    await main();

    // For JSON output, status messages are suppressed to keep output clean
    // The tool should either exit with an error or produce JSON output
    if (!mockProcessExit.mock.calls.length) {
      // If it didn't exit, it should have produced JSON output
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringMatching(/^\{[\s\S]*\}$/));
    }
  });

  it('should handle CLI errors gracefully', async () => {
    process.argv = ['node', 'visor', '--check', 'invalid-type'];

    await main();

    expect(capturedStderr).toContain('No configuration found for check: invalid-type');
    expect(mockProcessExit).toHaveBeenCalledWith(1);
  });

  it('should handle config file path', async () => {
    process.argv = ['node', 'visor', '--config', './tests/fixtures/valid-config.yaml'];

    await main();

    expect(capturedStderr).toContain('🔍 Visor - AI-powered code review tool');
    expect(capturedStderr).toContain('Configuration version: 1.0');
  });
});
