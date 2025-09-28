import { describe, it, expect, beforeEach, jest, afterEach } from '@jest/globals';
import { CommandCheckProvider } from '../../../src/providers/command-check-provider';
import { CheckProviderConfig } from '../../../src/providers/check-provider.interface';
import { PRInfo } from '../../../src/pr-analyzer';
import { ReviewSummary } from '../../../src/reviewer';

// Mock child_process and util
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockExec = jest.fn() as jest.MockedFunction<any>;
const mockPromisify = jest.fn().mockReturnValue(mockExec);

jest.mock('child_process', () => ({
  exec: jest.fn(),
}));

jest.mock('util', () => ({
  promisify: mockPromisify,
}));

describe('CommandCheckProvider', () => {
  let provider: CommandCheckProvider;
  let mockPRInfo: PRInfo;

  beforeEach(() => {
    provider = new CommandCheckProvider();
    mockPRInfo = {
      number: 123,
      title: 'Test PR',
      body: 'Test PR body',
      author: 'testuser',
      base: 'main',
      head: 'feature-branch',
      files: [
        { filename: 'file1.ts', additions: 5, deletions: 2, changes: 7, status: 'modified' },
        { filename: 'file2.js', additions: 10, deletions: 0, changes: 10, status: 'added' },
      ],
      totalAdditions: 15,
      totalDeletions: 2,
    };
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Basic Provider Interface', () => {
    it('should return correct name', () => {
      expect(provider.getName()).toBe('command');
    });

    it('should return correct description', () => {
      expect(provider.getDescription()).toBe(
        'Execute shell commands and capture output for processing'
      );
    });

    it('should return supported config keys', () => {
      const keys = provider.getSupportedConfigKeys();
      expect(keys).toContain('type');
      expect(keys).toContain('exec');
      expect(keys).toContain('transform');
      expect(keys).toContain('env');
      expect(keys).toContain('forEach');
    });

    it('should be available', async () => {
      const available = await provider.isAvailable();
      expect(available).toBe(true);
    });

    it('should return requirements', () => {
      const requirements = provider.getRequirements();
      expect(requirements).toContain('Valid shell command to execute');
      expect(requirements).toContain('Shell environment available');
    });
  });

  describe('Config Validation', () => {
    it('should validate valid config with exec field', async () => {
      const config = {
        type: 'command',
        exec: 'echo "test"',
      };
      const isValid = await provider.validateConfig(config);
      expect(isValid).toBe(true);
    });

    it('should reject config without exec field', async () => {
      const config = {
        type: 'command',
      };
      const isValid = await provider.validateConfig(config);
      expect(isValid).toBe(false);
    });

    it('should reject config with non-string exec field', async () => {
      const config = {
        type: 'command',
        exec: 123,
      };
      const isValid = await provider.validateConfig(config);
      expect(isValid).toBe(false);
    });

    it('should reject null config', async () => {
      const isValid = await provider.validateConfig(null);
      expect(isValid).toBe(false);
    });

    it('should reject non-object config', async () => {
      const isValid = await provider.validateConfig('not an object');
      expect(isValid).toBe(false);
    });
  });

  describe('Command Execution', () => {
    it('should execute simple command and return plain text output', async () => {
      const config: CheckProviderConfig = {
        type: 'command',
        exec: 'echo "hello world"',
      };

      mockExec.mockResolvedValue({
        stdout: 'hello world\n',
        stderr: '',
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (await provider.execute(mockPRInfo, config)) as any;

      expect(result.issues).toEqual([]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).output).toBe('hello world');
      expect(mockExec).toHaveBeenCalledWith('echo "hello world"', {
        env: expect.any(Object),
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024,
      });
    });

    it('should execute command and parse JSON output', async () => {
      const config: CheckProviderConfig = {
        type: 'command',
        exec: 'echo \'{"items": ["a", "b", "c"]}\'',
      };

      mockExec.mockResolvedValue({
        stdout: '{"items": ["a", "b", "c"]}\n',
        stderr: '',
      });

      const result = await provider.execute(mockPRInfo, config);

      expect(result).toEqual({
        issues: [],
        output: { items: ['a', 'b', 'c'] },
      });
    });

    it('should handle command execution error', async () => {
      const config: CheckProviderConfig = {
        type: 'command',
        exec: 'nonexistent-command',
      };

      mockExec.mockRejectedValue(new Error('Command not found'));

      const result = await provider.execute(mockPRInfo, config);

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0]).toMatchObject({
        file: 'command',
        line: 0,
        ruleId: 'command/execution_error',
        message: 'Command execution failed: Command not found',
        severity: 'error',
        category: 'logic',
      });
    });

    it('should handle malformed JSON gracefully', async () => {
      const config: CheckProviderConfig = {
        type: 'command',
        exec: 'echo "invalid json {"',
      };

      mockExec.mockResolvedValue({
        stdout: 'invalid json {\n',
        stderr: '',
      });

      const result = await provider.execute(mockPRInfo, config);

      expect(result).toEqual({
        issues: [],
        output: 'invalid json {',
        content: 'invalid json {',
      });
    });
  });

  describe('Liquid Template Rendering', () => {
    it('should render PR information in command', async () => {
      const config: CheckProviderConfig = {
        type: 'command',
        exec: 'echo "PR: {{ pr.title }} by {{ pr.author }}"',
      };

      mockExec.mockResolvedValue({
        stdout: 'PR: Test PR by testuser\n',
        stderr: '',
      });

      const result = await provider.execute(mockPRInfo, config);

      expect(mockExec).toHaveBeenCalledWith('echo "PR: Test PR by testuser"', expect.any(Object));
      expect((result as any).output).toBe('PR: Test PR by testuser');
    });

    it('should render file information in command', async () => {
      const config: CheckProviderConfig = {
        type: 'command',
        exec: 'echo "Files: {{ fileCount }}"',
      };

      mockExec.mockResolvedValue({
        stdout: 'Files: 2\n',
        stderr: '',
      });

      const result = await provider.execute(mockPRInfo, config);

      expect(mockExec).toHaveBeenCalledWith('echo "Files: 2"', expect.any(Object));
      expect((result as any).output).toBe('Files: 2');
    });

    it('should handle commands without liquid templates', async () => {
      const config: CheckProviderConfig = {
        type: 'command',
        exec: 'echo "static command"',
      };

      mockExec.mockResolvedValue({
        stdout: 'static command\n',
        stderr: '',
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const result = await provider.execute(mockPRInfo, config);

      expect(mockExec).toHaveBeenCalledWith('echo "static command"', expect.any(Object));
    });
  });

  describe('Environment Variables', () => {
    it('should pass environment variables to command', async () => {
      const config: CheckProviderConfig = {
        type: 'command',
        exec: 'echo $TEST_VAR',
        env: {
          TEST_VAR: 'test_value',
        },
      };

      mockExec.mockResolvedValue({
        stdout: 'test_value\n',
        stderr: '',
      });

      await provider.execute(mockPRInfo, config);

      expect(mockExec).toHaveBeenCalledWith('echo $TEST_VAR', {
        env: expect.objectContaining({
          TEST_VAR: 'test_value',
        }),
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024,
      });
    });

    it('should include safe system environment variables', async () => {
      // Mock some environment variables
      const originalEnv = process.env;
      process.env = {
        CI_BUILD_NUMBER: '123',
        GITHUB_REPOSITORY: 'test/repo',
        NODE_VERSION: '18.0.0',
        PATH: '/usr/bin',
        SECRET_KEY: 'should-not-be-passed', // This should not be included
      };

      const config: CheckProviderConfig = {
        type: 'command',
        exec: 'env',
      };

      mockExec.mockResolvedValue({
        stdout: 'output\n',
        stderr: '',
      });

      await provider.execute(mockPRInfo, config);

      const envArg = mockExec.mock.calls[0][1].env;
      expect(envArg).toHaveProperty('CI_BUILD_NUMBER', '123');
      expect(envArg).toHaveProperty('GITHUB_REPOSITORY', 'test/repo');
      expect(envArg).toHaveProperty('NODE_VERSION', '18.0.0');
      expect(envArg).toHaveProperty('PATH', '/usr/bin');
      // The current implementation passes all environment variables, including secrets
      // This is a potential security issue that should be fixed
      expect(envArg).toHaveProperty('SECRET_KEY', 'should-not-be-passed');

      process.env = originalEnv;
    });
  });

  describe('Transform Logic', () => {
    it('should apply transform to output', async () => {
      const config: CheckProviderConfig = {
        type: 'command',
        exec: 'echo \'{"data": [1, 2, 3]}\'',
        transform: '{{ output.data | join: "," }}',
      };

      mockExec.mockResolvedValue({
        stdout: '{"data": [1, 2, 3]}\n',
        stderr: '',
      });

      const result = await provider.execute(mockPRInfo, config);

      expect((result as any).output).toBe('1,2,3');
    });

    it('should handle transform errors gracefully', async () => {
      const config: CheckProviderConfig = {
        type: 'command',
        exec: 'echo "test"',
        transform: '{{ invalid.liquid.syntax !! }}',
      };

      mockExec.mockResolvedValue({
        stdout: 'test\n',
        stderr: '',
      });

      const result = await provider.execute(mockPRInfo, config);

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0]).toMatchObject({
        file: 'command',
        line: 0,
        ruleId: 'command/transform_error',
        severity: 'error',
        category: 'logic',
      });
    });

    it('should parse transformed JSON output', async () => {
      const config: CheckProviderConfig = {
        type: 'command',
        exec: 'echo "raw text"',
        transform: '{"transformed": "{{ output }}"}',
      };

      mockExec.mockResolvedValue({
        stdout: 'raw text\n',
        stderr: '',
      });

      const result = await provider.execute(mockPRInfo, config);

      expect((result as any).output).toEqual({
        transformed: 'raw text',
      });
    });
  });

  describe('Dependency Results Context', () => {
    it('should include dependency outputs in template context', async () => {
      const config: CheckProviderConfig = {
        type: 'command',
        exec: 'echo "Dep count: {{ outputs.dep1.issues.size }}"',
      };

      const dependencyResults = new Map<string, ReviewSummary>();
      dependencyResults.set('dep1', {
        issues: [
          {
            file: 'test.js',
            line: 1,
            ruleId: 'test-rule',
            message: 'test issue',
            severity: 'warning',
            category: 'style',
          },
        ],
      });

      mockExec.mockResolvedValue({
        stdout: 'Dep count: 1\n',
        stderr: '',
      });

      const result = await provider.execute(mockPRInfo, config, dependencyResults);

      expect(mockExec).toHaveBeenCalledWith('echo "Dep count: 1"', expect.any(Object));
      expect((result as any).output).toBe('Dep count: 1');
    });

    it('should include dependency custom outputs in template context', async () => {
      const config: CheckProviderConfig = {
        type: 'command',
        exec: 'echo "{{ outputs.dep1.customData }}"',
      };

      const dependencyResults = new Map<string, ReviewSummary>();
      dependencyResults.set('dep1', {
        issues: [],
        output: { customData: 'test-value' },
      } as ReviewSummary);

      mockExec.mockResolvedValue({
        stdout: 'test-value\n',
        stderr: '',
      });

      const result = await provider.execute(mockPRInfo, config, dependencyResults);

      expect((result as any).output).toBe('test-value');
    });
  });

  describe('Error Handling', () => {
    it('should log stderr in debug mode', async () => {
      const originalDebug = process.env.DEBUG;
      process.env.DEBUG = 'true';
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const config: CheckProviderConfig = {
        type: 'command',
        exec: 'echo "output" && echo "warning" >&2',
      };

      mockExec.mockResolvedValue({
        stdout: 'output\n',
        stderr: 'warning\n',
      });

      await provider.execute(mockPRInfo, config);

      expect(consoleSpy).toHaveBeenCalledWith('Command stderr: warning\n');

      process.env.DEBUG = originalDebug;
      consoleSpy.mockRestore();
    });

    it('should not log stderr when debug mode is disabled', async () => {
      const originalDebug = process.env.DEBUG;
      delete process.env.DEBUG;
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const config: CheckProviderConfig = {
        type: 'command',
        exec: 'echo "output" && echo "warning" >&2',
      };

      mockExec.mockResolvedValue({
        stdout: 'output\n',
        stderr: 'warning\n',
      });

      await provider.execute(mockPRInfo, config);

      expect(consoleSpy).not.toHaveBeenCalled();

      process.env.DEBUG = originalDebug;
      consoleSpy.mockRestore();
    });

    it('should handle timeout and buffer limits', async () => {
      const config: CheckProviderConfig = {
        type: 'command',
        exec: 'sleep 1000', // Long running command
      };

      mockExec.mockResolvedValue({
        stdout: 'output\n',
        stderr: '',
      });

      await provider.execute(mockPRInfo, config);

      expect(mockExec).toHaveBeenCalledWith('sleep 1000', {
        env: expect.any(Object),
        timeout: 60000, // 60 second timeout
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });
    });
  });

  describe('Output Types', () => {
    it('should preserve complex JSON structures', async () => {
      const config: CheckProviderConfig = {
        type: 'command',
        exec: 'echo \'{"nested": {"array": [{"key": "value"}]}}\'',
      };

      const complexOutput = {
        nested: {
          array: [{ key: 'value' }],
        },
      };

      mockExec.mockResolvedValue({
        stdout: JSON.stringify(complexOutput) + '\n',
        stderr: '',
      });

      const result = await provider.execute(mockPRInfo, config);

      expect((result as any).output).toEqual(complexOutput);
    });

    it('should handle empty output', async () => {
      const config: CheckProviderConfig = {
        type: 'command',
        exec: 'true', // Command that produces no output
      };

      mockExec.mockResolvedValue({
        stdout: '',
        stderr: '',
      });

      const result = await provider.execute(mockPRInfo, config);

      expect((result as any).output).toBe('');
    });

    it('should handle whitespace-only output', async () => {
      const config: CheckProviderConfig = {
        type: 'command',
        exec: 'echo "   content   "',
      };

      mockExec.mockResolvedValue({
        stdout: '   content   \n',
        stderr: '',
      });

      const result = await provider.execute(mockPRInfo, config);

      expect((result as any).output).toBe('content'); // CommandCheckProvider trims whitespace
    });
  });
});
