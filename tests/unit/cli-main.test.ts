/* eslint-disable @typescript-eslint/no-explicit-any */
import { main } from '../../src/cli-main';

// Mock process.argv and console methods for testing
const originalArgv = process.argv;
const originalExit = process.exit;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

describe('CLI Main Entry Point', () => {
  let mockConsoleLog: jest.Mock;
  let mockConsoleError: jest.Mock;
  let mockProcessExit: jest.Mock;

  beforeEach(() => {
    mockConsoleLog = jest.fn();
    mockConsoleError = jest.fn();
    mockProcessExit = jest.fn();

    console.log = mockConsoleLog;
    console.error = mockConsoleError;
    process.exit = mockProcessExit as any;
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
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

    expect(mockConsoleError).toHaveBeenCalledWith('🔍 Visor - AI-powered code review tool');
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('Configuration version: 1.0')
    );
    // CLI now shows repository status instead of config summary
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('Repository:'));
  });

  it('should run CLI with check arguments', async () => {
    process.argv = ['node', 'visor', '--check', 'performance', '--output', 'json'];

    await main();

    // For JSON output, decorative messages go to stderr
    expect(mockConsoleError).toHaveBeenCalledWith('🔍 Visor - AI-powered code review tool');
    // CLI now performs actual analysis, so expect JSON output in stdout
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('"review"'));
  });

  it('should handle CLI errors gracefully', async () => {
    process.argv = ['node', 'visor', '--check', 'invalid-type'];

    await main();

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('No configuration found for check: invalid-type')
    );
    expect(mockProcessExit).toHaveBeenCalledWith(1);
  });

  it('should handle config file path', async () => {
    process.argv = ['node', 'visor', '--config', './tests/fixtures/valid-config.yaml'];

    await main();

    expect(mockConsoleError).toHaveBeenCalledWith('🔍 Visor - AI-powered code review tool');
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('Configuration version: 1.0')
    );
  });
});
