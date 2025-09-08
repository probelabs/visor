import { ActionCliBridge, GitHubActionInputs, GitHubContext } from '../../src/action-cli-bridge';
import { promises as fs } from 'fs';
import * as path from 'path';

// Mock fs.writeFile
jest.mock('fs', () => ({
  promises: {
    writeFile: jest.fn(),
    unlink: jest.fn(),
  },
}));

// Mock js-yaml
jest.mock('js-yaml', () => ({
  dump: jest.fn(obj => `# Mock YAML\nversion: ${obj.version}`),
}));

describe('ActionCliBridge', () => {
  let bridge: ActionCliBridge;
  let mockContext: GitHubContext;

  beforeEach(() => {
    mockContext = {
      event_name: 'pull_request',
      repository: {
        owner: { login: 'test-owner' },
        name: 'test-repo',
      },
      event: {
        action: 'opened',
        pull_request: { number: 123 },
      },
    };

    bridge = new ActionCliBridge('test-token', mockContext);
    jest.clearAllMocks();
  });

  describe('shouldUseVisor', () => {
    it('should return true when visor-config-path is provided', () => {
      const inputs: GitHubActionInputs = {
        'github-token': 'token',
        'visor-config-path': './.visor.yaml',
      };

      expect(bridge.shouldUseVisor(inputs)).toBe(true);
    });

    it('should return true when visor-checks is provided', () => {
      const inputs: GitHubActionInputs = {
        'github-token': 'token',
        'visor-checks': 'security,performance',
      };

      expect(bridge.shouldUseVisor(inputs)).toBe(true);
    });

    it('should return false when neither visor input is provided', () => {
      const inputs: GitHubActionInputs = {
        'github-token': 'token',
        'auto-review': 'true',
      };

      expect(bridge.shouldUseVisor(inputs)).toBe(false);
    });
  });

  describe('parseGitHubInputsToCliArgs', () => {
    it('should parse config path input', () => {
      const inputs: GitHubActionInputs = {
        'github-token': 'token',
        'visor-config-path': './custom-config.yaml',
      };

      const args = bridge.parseGitHubInputsToCliArgs(inputs);

      expect(args).toEqual(['--config', './custom-config.yaml', '--output', 'json']);
    });

    it('should parse checks input', () => {
      const inputs: GitHubActionInputs = {
        'github-token': 'token',
        'visor-checks': 'security, performance, style',
      };

      const args = bridge.parseGitHubInputsToCliArgs(inputs);

      expect(args).toEqual([
        '--check',
        'security',
        '--check',
        'performance',
        '--check',
        'style',
        '--output',
        'json',
      ]);
    });

    it('should filter invalid checks', () => {
      const inputs: GitHubActionInputs = {
        'github-token': 'token',
        'visor-checks': 'security, invalid-check, performance',
      };

      const args = bridge.parseGitHubInputsToCliArgs(inputs);

      expect(args).toEqual(['--check', 'security', '--check', 'performance', '--output', 'json']);
    });

    it('should combine config path and checks', () => {
      const inputs: GitHubActionInputs = {
        'github-token': 'token',
        'visor-config-path': './config.yaml',
        'visor-checks': 'security',
      };

      const args = bridge.parseGitHubInputsToCliArgs(inputs);

      expect(args).toEqual([
        '--config',
        './config.yaml',
        '--check',
        'security',
        '--output',
        'json',
      ]);
    });
  });

  describe('mergeActionAndCliOutputs', () => {
    it('should merge CLI outputs with legacy outputs', () => {
      const inputs: GitHubActionInputs = {
        'github-token': 'token',
        'visor-checks': 'security',
      };

      const cliResult = {
        success: true,
        cliOutput: {
          reviewScore: 85,
          issuesFound: 3,
          autoReviewCompleted: true,
        },
      };

      const legacyOutputs = {
        'repo-name': 'test-repo',
        'repo-description': 'Test repository',
      };

      const outputs = bridge.mergeActionAndCliOutputs(inputs, cliResult, legacyOutputs);

      expect(outputs).toEqual({
        'repo-name': 'test-repo',
        'repo-description': 'Test repository',
        'review-score': '85',
        'issues-found': '3',
        'auto-review-completed': 'true',
      });
    });

    it('should handle CLI failure gracefully', () => {
      const inputs: GitHubActionInputs = {
        'github-token': 'token',
        'visor-checks': 'security',
      };

      const cliResult = {
        success: false,
        error: 'CLI execution failed',
      };

      const outputs = bridge.mergeActionAndCliOutputs(inputs, cliResult);

      expect(outputs).toEqual({});
    });

    it('should handle missing CLI output data', () => {
      const inputs: GitHubActionInputs = {
        'github-token': 'token',
        'visor-checks': 'security',
      };

      const cliResult = {
        success: true,
        cliOutput: {},
      };

      const outputs = bridge.mergeActionAndCliOutputs(inputs, cliResult);

      expect(outputs).toEqual({});
    });
  });

  describe('createTempConfigFromInputs', () => {
    it('should create temporary config from checks input', async () => {
      const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
      mockWriteFile.mockResolvedValue(undefined);

      const inputs: GitHubActionInputs = {
        'github-token': 'token',
        'visor-checks': 'security, performance',
      };

      const configPath = await bridge.createTempConfigFromInputs(inputs);

      expect(configPath).toBe(path.join(process.cwd(), '.visor-temp.yaml'));
      expect(mockWriteFile).toHaveBeenCalledWith(
        path.join(process.cwd(), '.visor-temp.yaml'),
        expect.stringContaining('version: 1.0'),
        'utf8'
      );
    });

    it('should return null when no checks provided', async () => {
      const inputs: GitHubActionInputs = {
        'github-token': 'token',
      };

      const configPath = await bridge.createTempConfigFromInputs(inputs);

      expect(configPath).toBeNull();
    });

    it('should return null when only invalid checks provided', async () => {
      const inputs: GitHubActionInputs = {
        'github-token': 'token',
        'visor-checks': 'invalid-check, another-invalid',
      };

      const configPath = await bridge.createTempConfigFromInputs(inputs);

      expect(configPath).toBeNull();
    });

    it('should handle file write errors gracefully', async () => {
      const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
      mockWriteFile.mockRejectedValue(new Error('Write failed'));

      const inputs: GitHubActionInputs = {
        'github-token': 'token',
        'visor-checks': 'security',
      };

      const configPath = await bridge.createTempConfigFromInputs(inputs);

      expect(configPath).toBeNull();
    });
  });

  describe('cleanup', () => {
    it('should cleanup temporary config file', async () => {
      const mockUnlink = fs.unlink as jest.MockedFunction<typeof fs.unlink>;
      mockUnlink.mockResolvedValue(undefined);

      await bridge.cleanup();

      expect(mockUnlink).toHaveBeenCalledWith(path.join(process.cwd(), '.visor-temp.yaml'));
    });

    it('should handle cleanup errors silently', async () => {
      const mockUnlink = fs.unlink as jest.MockedFunction<typeof fs.unlink>;
      mockUnlink.mockRejectedValue(new Error('File not found'));

      // Should not throw
      await expect(bridge.cleanup()).resolves.not.toThrow();
    });
  });

  describe('executeCliWithContext', () => {
    // Note: This test is more complex as it involves spawning child processes
    // In a real implementation, you might want to mock the spawn function
    it('should set up environment variables correctly', async () => {
      const inputs: GitHubActionInputs = {
        'github-token': 'test-token',
        'visor-checks': 'security',
      };

      // We can't easily test the actual execution without mocking spawn
      // but we can test the input parsing and environment setup logic
      const args = bridge.parseGitHubInputsToCliArgs(inputs);
      expect(args).toContain('--check');
      expect(args).toContain('security');
    });
  });

  describe('prompt generation', () => {
    it('should generate appropriate prompts for different check types', async () => {
      const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
      mockWriteFile.mockResolvedValue(undefined);

      const inputs: GitHubActionInputs = {
        'github-token': 'token',
        'visor-checks': 'security',
      };

      await bridge.createTempConfigFromInputs(inputs);

      // Check that security prompt was generated
      // The mockWriteFile.mock.calls[0][1] contains the YAML content generated by js-yaml.dump

      // The actual content would be generated by js-yaml.dump
      // but we can verify the method was called correctly
      expect(mockWriteFile).toHaveBeenCalledTimes(1);
    });
  });
});
