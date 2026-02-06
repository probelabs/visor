import { CheckRunner } from '../../src/sandbox/check-runner';
import { SandboxManager } from '../../src/sandbox/sandbox-manager';
import { SandboxConfig } from '../../src/sandbox/types';
import { PRInfo } from '../../src/pr-analyzer';

describe('CheckRunner', () => {
  let mockManager: jest.Mocked<SandboxManager>;

  const makePRInfo = (): PRInfo => ({
    number: 42,
    title: 'Test PR',
    body: 'Description',
    author: 'user',
    base: 'main',
    head: 'feature',
    files: [
      {
        filename: 'src/index.ts',
        status: 'modified' as const,
        additions: 10,
        deletions: 5,
        changes: 15,
        patch: '@@ -1,5 +1,10 @@',
      },
    ],
    totalAdditions: 10,
    totalDeletions: 5,
  });

  beforeEach(() => {
    mockManager = {
      exec: jest.fn(),
      resolveSandbox: jest.fn(),
      getOrStart: jest.fn(),
      stopAll: jest.fn(),
      getRepoPath: jest.fn().mockReturnValue('/tmp/visor-test-repo'),
    } as unknown as jest.Mocked<SandboxManager>;
  });

  it('should execute check and parse JSON result from stdout', async () => {
    const checkResult = {
      issues: [
        {
          file: 'src/index.ts',
          line: 5,
          ruleId: 'no-unused-vars',
          message: 'Unused variable',
          severity: 'warning',
          category: 'style',
        },
      ],
      output: 'lint complete',
    };

    mockManager.exec.mockResolvedValue({
      stdout: JSON.stringify(checkResult),
      stderr: '',
      exitCode: 0,
    });

    const sandboxConfig: SandboxConfig = {
      image: 'node:20',
      visor_path: '/opt/visor',
    };

    const result = await CheckRunner.runCheck(
      mockManager,
      'node-env',
      sandboxConfig,
      { type: 'command', exec: 'eslint src/' },
      makePRInfo()
    );

    expect(result.issues).toHaveLength(1);
    expect(result.issues![0].ruleId).toBe('no-unused-vars');
    expect(mockManager.exec).toHaveBeenCalledTimes(1);

    // Verify the command includes visor path
    const execCall = mockManager.exec.mock.calls[0];
    expect(execCall[0]).toBe('node-env');
    expect(execCall[1].command).toContain('/opt/visor/index.js --run-check');
  });

  it('should return error issue on sandbox execution failure', async () => {
    mockManager.exec.mockResolvedValue({
      stdout: '',
      stderr: 'Container crashed',
      exitCode: 137,
    });

    const sandboxConfig: SandboxConfig = { image: 'node:20' };

    const result = await CheckRunner.runCheck(
      mockManager,
      'node-env',
      sandboxConfig,
      { type: 'command', exec: 'exit 1' },
      makePRInfo()
    );

    expect(result.issues).toHaveLength(1);
    expect(result.issues![0].ruleId).toBe('sandbox-execution-error');
    expect(result.issues![0].severity).toBe('error');
  });

  it('should return error on invalid JSON output', async () => {
    mockManager.exec.mockResolvedValue({
      stdout: 'not json at all',
      stderr: '',
      exitCode: 0,
    });

    const sandboxConfig: SandboxConfig = { image: 'node:20' };

    const result = await CheckRunner.runCheck(
      mockManager,
      'node-env',
      sandboxConfig,
      { type: 'command', exec: 'echo test' },
      makePRInfo()
    );

    expect(result.issues).toHaveLength(1);
    expect(result.issues![0].ruleId).toBe('sandbox-parse-error');
  });

  it('should find JSON on last line when stdout has mixed output', async () => {
    const checkResult = { issues: [], output: 'ok' };
    const stdout = `Some log line\nAnother log\n${JSON.stringify(checkResult)}`;

    mockManager.exec.mockResolvedValue({
      stdout,
      stderr: '',
      exitCode: 0,
    });

    const sandboxConfig: SandboxConfig = { image: 'node:20' };

    const result = await CheckRunner.runCheck(
      mockManager,
      'node-env',
      sandboxConfig,
      { type: 'command', exec: 'echo test' },
      makePRInfo()
    );

    expect(result.issues).toHaveLength(0);
  });

  it('should pass dependency results to the sandbox', async () => {
    const checkResult = { issues: [], output: 'depends-ok' };

    mockManager.exec.mockResolvedValue({
      stdout: JSON.stringify(checkResult),
      stderr: '',
      exitCode: 0,
    });

    const sandboxConfig: SandboxConfig = { image: 'node:20' };
    const depResults = new Map<string, any>();
    depResults.set('prev-check', { issues: [], output: 'prev-output' });

    await CheckRunner.runCheck(
      mockManager,
      'node-env',
      sandboxConfig,
      { type: 'command', exec: 'echo test' },
      makePRInfo(),
      depResults
    );

    // Verify the payload includes dependency outputs
    const execCall = mockManager.exec.mock.calls[0];
    const command = execCall[1].command as string;
    expect(command).toContain('dependencyOutputs');
  });

  it('should forward env from sandbox config passthrough', async () => {
    const checkResult = { issues: [] };

    mockManager.exec.mockResolvedValue({
      stdout: JSON.stringify(checkResult),
      stderr: '',
      exitCode: 0,
    });

    const sandboxConfig: SandboxConfig = {
      image: 'node:20',
      env_passthrough: ['GITHUB_*'],
    };

    // Set a test env var
    const origEnv = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';

    try {
      await CheckRunner.runCheck(
        mockManager,
        'node-env',
        sandboxConfig,
        { type: 'command', exec: 'echo test' },
        makePRInfo()
      );

      const execCall = mockManager.exec.mock.calls[0];
      const env = execCall[1].env as Record<string, string>;
      expect(env.GITHUB_TOKEN).toBe('test-token');
    } finally {
      if (origEnv === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = origEnv;
      }
    }
  });
});
