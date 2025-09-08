/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConfigManager } from '../../src/config';
import { VisorConfig } from '../../src/types/config';
import * as fs from 'fs';
import * as path from 'path';

// Mock fs module
jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

describe('Configuration System', () => {
  let configManager: ConfigManager;
  const testConfigDir = '/test/config/dir';

  beforeEach(() => {
    configManager = new ConfigManager();
    jest.clearAllMocks();
  });

  describe('YAML Config Loading', () => {
    it('should load valid YAML configuration', async () => {
      const validConfig = `
version: "1.0"
checks:
  performance:
    type: ai
    prompt: |
      Review for performance issues:
      - N+1 queries
      - Memory leaks
    on: [pr_opened, pr_updated]
  security:
    type: ai
    prompt: Check for security vulnerabilities
    on: [pr_opened]
output:
  pr_comment:
    format: table
    group_by: check
    collapse: true
`;

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(validConfig);

      const config = await configManager.loadConfig('/path/to/.visor.yaml');

      expect(config.version).toBe('1.0');
      expect(config.checks).toHaveProperty('performance');
      expect(config.checks).toHaveProperty('security');
      expect(config.output.pr_comment.format).toBe('table');
    });

    it('should handle missing config file gracefully', async () => {
      mockFs.existsSync.mockReturnValue(false);

      await expect(configManager.loadConfig('/nonexistent/config.yaml')).rejects.toThrow(
        'Configuration file not found: /nonexistent/config.yaml'
      );
    });

    it('should handle invalid YAML syntax', async () => {
      const invalidYaml = `
version: "1.0"
checks:
  performance:
    type: ai
    prompt: |
      Invalid YAML
      - missing closing
    on: [pr_opened
output:
  format: summary
`;

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(invalidYaml);

      await expect(configManager.loadConfig('/path/to/invalid.yaml')).rejects.toThrow(
        'Invalid YAML syntax'
      );
    });

    it('should handle file read errors', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      await expect(configManager.loadConfig('/path/to/config.yaml')).rejects.toThrow(
        'Failed to read configuration file'
      );
    });
  });

  describe('Schema Validation', () => {
    it('should validate required version field', async () => {
      const configWithoutVersion = `
checks:
  performance:
    type: ai
    prompt: "Check performance"
`;

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(configWithoutVersion);

      await expect(configManager.loadConfig('/path/to/config.yaml')).rejects.toThrow(
        'Missing required field: version'
      );
    });

    it('should validate required checks field', async () => {
      const configWithoutChecks = `
version: "1.0"
output:
  pr_comment:
    format: table
`;

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(configWithoutChecks);

      await expect(configManager.loadConfig('/path/to/config.yaml')).rejects.toThrow(
        'Missing required field: checks'
      );
    });

    it('should validate check configuration structure', async () => {
      const configWithInvalidCheck = `
version: "1.0"
checks:
  performance:
    prompt: "Missing type field"
    on: [pr_opened]
`;

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(configWithInvalidCheck);

      await expect(configManager.loadConfig('/path/to/config.yaml')).rejects.toThrow(
        'Invalid check configuration for "performance": missing type'
      );
    });

    it('should validate check type values', async () => {
      const configWithInvalidType = `
version: "1.0"
checks:
  performance:
    type: invalid_type
    prompt: "Check performance"
    on: [pr_opened]
`;

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(configWithInvalidType);

      await expect(configManager.loadConfig('/path/to/config.yaml')).rejects.toThrow(
        'Invalid check type "invalid_type". Must be: ai'
      );
    });

    it('should validate event triggers', async () => {
      const configWithInvalidEvent = `
version: "1.0"
checks:
  performance:
    type: ai
    prompt: "Check performance"
    on: [invalid_event]
`;

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(configWithInvalidEvent);

      await expect(configManager.loadConfig('/path/to/config.yaml')).rejects.toThrow(
        'Invalid event "invalid_event". Must be one of: pr_opened, pr_updated, pr_closed'
      );
    });

    it('should validate output format configuration', async () => {
      const configWithInvalidOutput = `
version: "1.0"
checks:
  performance:
    type: ai
    prompt: "Check performance"
    on: [pr_opened]
output:
  pr_comment:
    format: invalid_format
`;

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(configWithInvalidOutput);

      await expect(configManager.loadConfig('/path/to/config.yaml')).rejects.toThrow(
        'Invalid output format "invalid_format". Must be one of: table, json, markdown, sarif'
      );
    });
  });

  describe('Default Configuration', () => {
    it('should provide default configuration when no file specified', async () => {
      const config = await configManager.getDefaultConfig();

      expect(config.version).toBe('1.0');
      expect(config.checks).toEqual({});
      expect(config.output).toEqual({
        pr_comment: {
          format: 'markdown',
          group_by: 'check',
          collapse: true,
        },
      });
    });

    it('should merge with default values for missing optional fields', async () => {
      const minimalConfig = `
version: "1.0"
checks:
  performance:
    type: ai
    prompt: "Check performance"
    on: [pr_opened]
`;

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(minimalConfig);

      const config = await configManager.loadConfig('/path/to/minimal.yaml');

      // Should have default output configuration
      expect(config.output.pr_comment.format).toBe('markdown');
      expect(config.output.pr_comment.group_by).toBe('check');
      expect(config.output.pr_comment.collapse).toBe(true);
    });
  });

  describe('Configuration File Discovery', () => {
    it('should find .visor.yaml in current directory', async () => {
      const validConfig = `
version: "1.0"
checks:
  performance:
    type: ai
    prompt: "Check performance"
    on: [pr_opened]
`;

      // Mock process.cwd() to return our test directory
      jest.spyOn(process, 'cwd').mockReturnValue(testConfigDir);

      mockFs.existsSync.mockImplementation((filePath: any) => {
        return filePath === path.join(testConfigDir, '.visor.yaml');
      });
      mockFs.readFileSync.mockReturnValue(validConfig);

      const config = await configManager.findAndLoadConfig();

      expect(mockFs.existsSync).toHaveBeenCalledWith(path.join(testConfigDir, '.visor.yaml'));
      expect(config.version).toBe('1.0');
    });

    it('should find .visor.yml in current directory', async () => {
      const validConfig = `
version: "1.0"
checks:
  performance:
    type: ai
    prompt: "Check performance"
    on: [pr_opened]
`;

      jest.spyOn(process, 'cwd').mockReturnValue(testConfigDir);

      mockFs.existsSync.mockImplementation((filePath: any) => {
        // First check for .yaml fails, second check for .yml succeeds
        return filePath === path.join(testConfigDir, '.visor.yml');
      });
      mockFs.readFileSync.mockReturnValue(validConfig);

      const config = await configManager.findAndLoadConfig();

      expect(config.version).toBe('1.0');
    });

    it('should return default config when no file found', async () => {
      jest.spyOn(process, 'cwd').mockReturnValue(testConfigDir);
      mockFs.existsSync.mockReturnValue(false);

      const config = await configManager.findAndLoadConfig();

      // Should return default config
      expect(config.version).toBe('1.0');
      expect(config.checks).toEqual({});
    });
  });

  describe('Configuration Merging', () => {
    it('should merge CLI options with config file', async () => {
      const fileConfig: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          performance: {
            type: 'ai',
            prompt: 'Check performance',
            on: ['pr_opened'],
          },
        },
      };

      const cliOptions = {
        checks: ['security', 'architecture'] as any,
        output: 'json' as const,
        configPath: '/custom/path.yaml',
      };

      const merged = configManager.mergeWithCliOptions(fileConfig, cliOptions);

      // CLI checks should take precedence
      expect(merged.cliChecks).toEqual(['security', 'architecture']);
      expect(merged.cliOutput).toBe('json');
      expect(merged.config).toEqual(fileConfig);
    });

    it('should handle empty CLI options', async () => {
      const fileConfig: Partial<VisorConfig> = {
        version: '1.0',
        checks: {},
      };

      const cliOptions = {
        checks: [],
        output: 'table' as const,
      };

      const merged = configManager.mergeWithCliOptions(fileConfig, cliOptions);

      expect(merged.cliChecks).toEqual([]);
      expect(merged.cliOutput).toBe('table');
    });
  });

  describe('Environment Variable Support', () => {
    it('should support environment variable overrides', async () => {
      process.env.VISOR_CONFIG_PATH = '/env/config.yaml';
      process.env.VISOR_OUTPUT_FORMAT = 'json';

      const validConfig = `
version: "1.0"
checks:
  performance:
    type: ai
    prompt: "Check performance"
    on: [pr_opened]
`;

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(validConfig);

      const config = await configManager.loadConfigWithEnvOverrides();

      expect(config.environmentOverrides).toEqual({
        configPath: '/env/config.yaml',
        outputFormat: 'json',
      });

      // Clean up
      delete process.env.VISOR_CONFIG_PATH;
      delete process.env.VISOR_OUTPUT_FORMAT;
    });

    it('should handle missing environment variables', async () => {
      const config = await configManager.loadConfigWithEnvOverrides();

      expect(config.environmentOverrides).toEqual({});
    });
  });

  describe('Complex Configuration Scenarios', () => {
    it('should handle configuration with multiple check types and complex prompts', async () => {
      const complexConfig = `
version: "1.0"
checks:
  performance:
    type: ai
    prompt: |
      Review for performance issues:
      - Check for N+1 database queries
      - Look for memory leaks and excessive allocations
      - Identify inefficient algorithms (O(n²) or worse)
      - Check for missing caching opportunities
      - Review async/await usage
    on: [pr_opened, pr_updated]
  
  security:
    type: ai
    prompt: |
      Perform security analysis:
      - SQL injection vulnerabilities
      - XSS attack vectors
      - Authentication/authorization issues
      - Sensitive data exposure
      - Input validation problems
    on: [pr_opened]
  
  architecture:
    type: ai
    prompt: |
      Review architectural concerns:
      - Design patterns usage
      - SOLID principles adherence
      - Code organization and modularity
      - Dependency management
    on: [pr_opened, pr_updated]

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: false
  
  file_comment:
    enabled: true
    inline: true
`;

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(complexConfig);

      const config = await configManager.loadConfig('/path/to/complex.yaml');

      expect(config.checks.performance.prompt).toContain('N+1 database queries');
      expect(config.checks.security.prompt).toContain('SQL injection');
      expect(config.checks.architecture.prompt).toContain('SOLID principles');
      expect(config.output.pr_comment.format).toBe('markdown');
      expect(config.output.pr_comment.collapse).toBe(false);
    });
  });
});
