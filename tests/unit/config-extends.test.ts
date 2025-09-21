import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ConfigManager } from '../../src/config';
import { ConfigLoader } from '../../src/utils/config-loader';
import { ConfigMerger } from '../../src/utils/config-merger';
import { VisorConfig } from '../../src/types/config';

// Mock fetch for remote config tests
global.fetch = jest.fn();

describe('Config Extends Functionality', () => {
  const testConfigDir = path.join(__dirname, '../fixtures/config-extends');

  beforeAll(() => {
    // Create test directory
    if (!fs.existsSync(testConfigDir)) {
      fs.mkdirSync(testConfigDir, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up test files
    if (fs.existsSync(testConfigDir)) {
      fs.rmSync(testConfigDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Reset environment variables
    delete process.env.VISOR_NO_REMOTE_EXTENDS;
    // Clear fetch mock
    (global.fetch as jest.Mock).mockClear();
  });

  describe('ConfigLoader', () => {
    let loader: ConfigLoader;

    beforeEach(() => {
      loader = new ConfigLoader({ baseDir: testConfigDir });
    });

    it('should load local configuration file', async () => {
      const configPath = path.join(testConfigDir, 'local-config.yaml');
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          test: {
            type: 'ai',
            prompt: 'Test prompt',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      fs.writeFileSync(configPath, yaml.dump(config));

      const loaded = await loader.fetchConfig('./local-config.yaml');
      expect(loaded.version).toBe('1.0');
      expect(loaded.checks?.test).toBeDefined();
    });

    it('should load default configuration', async () => {
      const loaded = await loader.fetchConfig('default');
      expect(loaded.version).toBeDefined();
      expect(loaded.checks).toBeDefined();
    });

    it('should load remote configuration', async () => {
      const remoteConfig: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          remote: {
            type: 'http',
            url: 'https://example.com/webhook',
            body: '{"test": "data"}',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'json',
            group_by: 'file',
            collapse: true,
          },
        },
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => yaml.dump(remoteConfig),
      });

      const loaded = await loader.fetchConfig('https://example.com/config.yaml');
      expect(loaded.checks?.remote?.type).toBe('http');
      expect(loaded.output?.pr_comment?.format).toBe('json');
    });

    it('should throw error for remote configs when disabled', async () => {
      const loader = new ConfigLoader({
        baseDir: testConfigDir,
        allowRemote: false,
      });

      await expect(loader.fetchConfig('https://example.com/config.yaml')).rejects.toThrow(
        'Remote extends are disabled'
      );
    });

    it('should detect circular dependencies', async () => {
      // Create two configs that reference each other
      const config1Path = path.join(testConfigDir, 'circular1.yaml');
      const config2Path = path.join(testConfigDir, 'circular2.yaml');

      const config1: Partial<VisorConfig> = {
        extends: './circular2.yaml',
        version: '1.0',
        checks: {},
        output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: true } },
      };

      const config2: Partial<VisorConfig> = {
        extends: './circular1.yaml',
        version: '1.0',
        checks: {},
        output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: true } },
      };

      fs.writeFileSync(config1Path, yaml.dump(config1));
      fs.writeFileSync(config2Path, yaml.dump(config2));

      await expect(loader.fetchConfig('./circular1.yaml')).rejects.toThrow('Circular dependency');
    });

    it('should enforce maximum recursion depth', async () => {
      const loader = new ConfigLoader({
        baseDir: testConfigDir,
        maxDepth: 2,
      });

      // Create a chain of configs
      const config1: Partial<VisorConfig> = {
        extends: './deep2.yaml',
        version: '1.0',
        checks: {},
        output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: true } },
      };

      const config2: Partial<VisorConfig> = {
        extends: './deep3.yaml',
        version: '1.0',
        checks: {},
        output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: true } },
      };

      const config3: Partial<VisorConfig> = {
        version: '1.0',
        checks: {},
        output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: true } },
      };

      fs.writeFileSync(path.join(testConfigDir, 'deep1.yaml'), yaml.dump(config1));
      fs.writeFileSync(path.join(testConfigDir, 'deep2.yaml'), yaml.dump(config2));
      fs.writeFileSync(path.join(testConfigDir, 'deep3.yaml'), yaml.dump(config3));

      await expect(loader.fetchConfig('./deep1.yaml')).rejects.toThrow('Maximum extends depth');
    });
  });

  describe('ConfigMerger', () => {
    let merger: ConfigMerger;

    beforeEach(() => {
      merger = new ConfigMerger();
    });

    it('should merge configurations with child overriding parent', () => {
      const parent: Partial<VisorConfig> = {
        version: '1.0',
        ai_model: 'gpt-3.5',
        checks: {
          security: {
            type: 'ai',
            prompt: 'Check security',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const child: Partial<VisorConfig> = {
        version: '2.0',
        ai_model: 'gpt-4',
        checks: {
          security: {
            type: 'ai',
            prompt: 'Enhanced security check',
            on: ['pr_opened', 'pr_updated'],
          },
          performance: {
            type: 'tool',
            exec: 'npm run perf',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'json',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const merged = merger.merge(parent, child);

      expect(merged.version).toBe('2.0');
      expect(merged.ai_model).toBe('gpt-4');
      expect(merged.checks?.security?.prompt).toBe('Enhanced security check');
      expect(merged.checks?.security?.on).toEqual(['pr_opened', 'pr_updated']);
      expect(merged.checks?.performance).toBeDefined();
      expect(merged.output?.pr_comment?.format).toBe('json');
    });

    it('should disable checks with empty on array', () => {
      const parent: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          security: {
            type: 'ai',
            prompt: 'Check security',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const child: Partial<VisorConfig> = {
        checks: {
          security: {
            type: 'ai',
            prompt: 'Check security',
            on: [],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const merged = merger.merge(parent, child);
      expect(merged.checks?.security?.on).toEqual([]);

      const filtered = merger.removeDisabledChecks(merged);
      expect(filtered.checks?.security).toBeUndefined();
    });

    it('should merge environment variables', () => {
      const parent: Partial<VisorConfig> = {
        version: '1.0',
        env: {
          API_KEY: 'parent-key',
          TIMEOUT: 5000,
        },
        checks: {},
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const child: Partial<VisorConfig> = {
        env: {
          API_KEY: 'child-key',
          NEW_VAR: 'new-value',
        },
        checks: {},
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const merged = merger.merge(parent, child);

      expect(merged.env?.API_KEY).toBe('child-key');
      expect(merged.env?.TIMEOUT).toBe(5000);
      expect(merged.env?.NEW_VAR).toBe('new-value');
    });

    it('should handle appendPrompt correctly', () => {
      const parent: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          security: {
            type: 'ai',
            prompt: 'Perform basic security analysis',
            on: ['pr_opened'],
          },
          quality: {
            type: 'ai',
            prompt: 'Check code quality',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const child: Partial<VisorConfig> = {
        checks: {
          security: {
            type: 'ai',
            appendPrompt: 'Also check for OWASP Top 10 vulnerabilities.',
            on: ['pr_opened', 'pr_updated'],
          },
          quality: {
            type: 'ai',
            prompt: 'Completely new quality check', // This overrides, not appends
            on: ['pr_opened'],
          },
          performance: {
            type: 'ai',
            appendPrompt: 'Check performance metrics', // No parent, becomes the prompt
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const merged = merger.merge(parent, child);

      // appendPrompt should be appended to parent prompt
      expect(merged.checks?.security?.prompt).toBe(
        'Perform basic security analysis\n\nAlso check for OWASP Top 10 vulnerabilities.'
      );

      // Direct prompt override should replace
      expect(merged.checks?.quality?.prompt).toBe('Completely new quality check');

      // appendPrompt with no parent becomes the prompt
      expect(merged.checks?.performance?.prompt).toBe('Check performance metrics');

      // appendPrompt should not be in final config
      expect(merged.checks?.security?.appendPrompt).toBeUndefined();
      expect(merged.checks?.performance?.appendPrompt).toBeUndefined();
    });

    it('should replace arrays not concatenate them', () => {
      const parent: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          test: {
            type: 'ai',
            prompt: 'Test',
            on: ['pr_opened'],
            depends_on: ['check1', 'check2'],
            triggers: ['*.js', '*.ts'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const child: Partial<VisorConfig> = {
        checks: {
          test: {
            type: 'ai',
            prompt: 'Test',
            on: ['pr_updated'],
            depends_on: ['check3'],
            triggers: ['*.tsx'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const merged = merger.merge(parent, child);

      expect(merged.checks?.test?.on).toEqual(['pr_updated']);
      expect(merged.checks?.test?.depends_on).toEqual(['check3']);
      expect(merged.checks?.test?.triggers).toEqual(['*.tsx']);
    });
  });

  describe('ConfigManager with extends', () => {
    let configManager: ConfigManager;

    beforeEach(() => {
      configManager = new ConfigManager();
    });

    it('should load configuration with single extends', async () => {
      const baseConfig: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          base: {
            type: 'ai',
            prompt: 'Base check',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const childConfig: Partial<VisorConfig> = {
        extends: './base.yaml',
        checks: {
          child: {
            type: 'tool',
            exec: 'npm test',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      fs.writeFileSync(path.join(testConfigDir, 'base.yaml'), yaml.dump(baseConfig));
      fs.writeFileSync(path.join(testConfigDir, 'child.yaml'), yaml.dump(childConfig));

      const config = await configManager.loadConfig(path.join(testConfigDir, 'child.yaml'));

      expect(config.checks.base).toBeDefined();
      expect(config.checks.child).toBeDefined();
      expect(config.checks.base.prompt).toBe('Base check');
      expect(config.checks.child.exec).toBe('npm test');
    });

    it('should load configuration with multiple extends', async () => {
      const base1: Partial<VisorConfig> = {
        version: '1.0',
        ai_model: 'gpt-3.5',
        checks: {
          security: {
            type: 'ai',
            prompt: 'Security check',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const base2: Partial<VisorConfig> = {
        version: '1.0',
        ai_provider: 'openai',
        checks: {
          performance: {
            type: 'tool',
            exec: 'npm run perf',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const childConfig: Partial<VisorConfig> = {
        extends: ['./base1.yaml', './base2.yaml'],
        checks: {
          custom: {
            type: 'http',
            url: 'https://example.com',
            body: '{"test": "data"}',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'json',
            group_by: 'file',
            collapse: true,
          },
        },
      };

      fs.writeFileSync(path.join(testConfigDir, 'base1.yaml'), yaml.dump(base1));
      fs.writeFileSync(path.join(testConfigDir, 'base2.yaml'), yaml.dump(base2));
      fs.writeFileSync(path.join(testConfigDir, 'multi.yaml'), yaml.dump(childConfig));

      const config = await configManager.loadConfig(path.join(testConfigDir, 'multi.yaml'));

      expect(config.ai_model).toBe('gpt-3.5');
      expect(config.ai_provider).toBe('openai');
      expect(config.checks.security).toBeDefined();
      expect(config.checks.performance).toBeDefined();
      expect(config.checks.custom).toBeDefined();
      expect(config.output.pr_comment.format).toBe('json');
    });

    it('should extend from default configuration', async () => {
      const config: Partial<VisorConfig> = {
        extends: 'default',
        checks: {
          custom: {
            type: 'ai',
            prompt: 'Custom check',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      fs.writeFileSync(path.join(testConfigDir, 'extends-default.yaml'), yaml.dump(config));

      const loaded = await configManager.loadConfig(
        path.join(testConfigDir, 'extends-default.yaml')
      );

      expect(loaded.checks.custom).toBeDefined();
      // Should have some default checks if default config exists
      expect(Object.keys(loaded.checks).length).toBeGreaterThan(1);
    });

    it('should respect VISOR_NO_REMOTE_EXTENDS environment variable', async () => {
      process.env.VISOR_NO_REMOTE_EXTENDS = 'true';

      const config: Partial<VisorConfig> = {
        extends: 'https://example.com/config.yaml',
        version: '1.0',
        checks: {},
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      fs.writeFileSync(path.join(testConfigDir, 'remote-extends.yaml'), yaml.dump(config));

      await expect(
        configManager.loadConfig(path.join(testConfigDir, 'remote-extends.yaml'))
      ).rejects.toThrow('Remote extends are disabled');
    });

    it('should override parent check configuration', async () => {
      const parent: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          security: {
            type: 'ai',
            prompt: 'Basic security check',
            ai_model: 'gpt-3.5',
            on: ['pr_opened'],
            group: 'basic',
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const child: Partial<VisorConfig> = {
        extends: './parent.yaml',
        checks: {
          security: {
            type: 'ai',
            prompt: 'Advanced security check',
            ai_model: 'gpt-4',
            on: ['pr_opened', 'pr_updated'],
            group: 'advanced',
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      fs.writeFileSync(path.join(testConfigDir, 'parent.yaml'), yaml.dump(parent));
      fs.writeFileSync(path.join(testConfigDir, 'override.yaml'), yaml.dump(child));

      const config = await configManager.loadConfig(path.join(testConfigDir, 'override.yaml'));

      expect(config.checks.security.prompt).toBe('Advanced security check');
      expect(config.checks.security.ai_model).toBe('gpt-4');
      expect(config.checks.security.on).toEqual(['pr_opened', 'pr_updated']);
      expect(config.checks.security.group).toBe('advanced');
    });

    it('should handle CLI --no-remote-extends flag through environment variable', async () => {
      // Save original value
      const originalValue = process.env.VISOR_NO_REMOTE_EXTENDS;

      try {
        // Test with '1' as well as 'true'
        process.env.VISOR_NO_REMOTE_EXTENDS = '1';

        const config: Partial<VisorConfig> = {
          extends: 'https://example.com/config.yaml',
          version: '1.0',
          checks: {},
          output: {
            pr_comment: {
              format: 'markdown',
              group_by: 'check',
              collapse: true,
            },
          },
        };

        fs.writeFileSync(path.join(testConfigDir, 'remote-flag-test.yaml'), yaml.dump(config));

        await expect(
          configManager.loadConfig(path.join(testConfigDir, 'remote-flag-test.yaml'))
        ).rejects.toThrow('Remote extends are disabled');
      } finally {
        // Restore original value
        if (originalValue !== undefined) {
          process.env.VISOR_NO_REMOTE_EXTENDS = originalValue;
        } else {
          delete process.env.VISOR_NO_REMOTE_EXTENDS;
        }
      }
    });
  });

  describe('Error Handling', () => {
    let configManager: ConfigManager;
    let loader: ConfigLoader;

    beforeEach(() => {
      configManager = new ConfigManager();
      loader = new ConfigLoader({ baseDir: testConfigDir });
    });

    it('should handle network failures for remote configs', async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

      await expect(loader.fetchConfig('https://example.com/config.yaml')).rejects.toThrow(
        'Failed to fetch remote configuration from https://example.com/config.yaml: Network error'
      );
    });

    it('should handle HTTP error responses for remote configs', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      await expect(loader.fetchConfig('https://example.com/config.yaml')).rejects.toThrow(
        'Failed to fetch config: 404 Not Found'
      );
    });

    it('should handle timeout for remote configs', async () => {
      const loader = new ConfigLoader({
        baseDir: testConfigDir,
        timeout: 100, // Very short timeout
      });

      // Mock abort error for timeout
      (global.fetch as jest.Mock).mockImplementationOnce(() => {
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        return Promise.reject(error);
      });

      await expect(loader.fetchConfig('https://example.com/slow-config.yaml')).rejects.toThrow(
        'Timeout fetching configuration from https://example.com/slow-config.yaml (100ms)'
      );
    });

    it('should handle malformed YAML in remote configs', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => 'invalid: yaml: content: [unclosed',
      });

      await expect(loader.fetchConfig('https://example.com/malformed.yaml')).rejects.toThrow(
        'Failed to fetch remote configuration from https://example.com/malformed.yaml'
      );
    });

    it('should handle malformed YAML in local configs', async () => {
      const malformedPath = path.join(testConfigDir, 'malformed.yaml');
      fs.writeFileSync(malformedPath, 'invalid: yaml: content: [unclosed');

      await expect(loader.fetchConfig('./malformed.yaml')).rejects.toThrow(
        'Failed to load configuration from'
      );
    });

    it('should handle missing local config files', async () => {
      await expect(loader.fetchConfig('./nonexistent.yaml')).rejects.toThrow(
        'Configuration file not found'
      );
    });

    it('should handle non-object YAML content', async () => {
      const invalidPath = path.join(testConfigDir, 'invalid-content.yaml');
      fs.writeFileSync(invalidPath, 'just a string, not an object');

      await expect(loader.fetchConfig('./invalid-content.yaml')).rejects.toThrow(
        'Invalid YAML in configuration file'
      );
    });

    it('should handle invalid URLs', async () => {
      // Test with an invalid HTTP URL that would be detected as remote but has invalid protocol
      const loader = new ConfigLoader({
        baseDir: testConfigDir,
        allowRemote: true,
      });

      // Test the URL validation by mocking fetch to return immediately and checking the validation
      (global.fetch as jest.Mock).mockImplementationOnce(() => {
        throw new Error('This should not be called');
      });

      // Use reflection to access the private method for testing
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fetchRemoteConfig = (loader as any).fetchRemoteConfig.bind(loader);
      await expect(fetchRemoteConfig('ftp://invalid-protocol.com/config.yaml')).rejects.toThrow(
        'Invalid URL: ftp://invalid-protocol.com/config.yaml. Only HTTP and HTTPS protocols are supported.'
      );
    });

    it('should handle missing parent configs in extends chain', async () => {
      const childConfig: Partial<VisorConfig> = {
        extends: './missing-parent.yaml',
        version: '1.0',
        checks: {},
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      fs.writeFileSync(
        path.join(testConfigDir, 'child-with-missing-parent.yaml'),
        yaml.dump(childConfig)
      );

      await expect(
        configManager.loadConfig(path.join(testConfigDir, 'child-with-missing-parent.yaml'))
      ).rejects.toThrow('Configuration file not found');
    });

    it('should handle empty/null response from remote config', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => '',
      });

      await expect(loader.fetchConfig('https://example.com/empty.yaml')).rejects.toThrow(
        'Failed to fetch remote configuration from https://example.com/empty.yaml'
      );
    });
  });

  describe('Edge Cases', () => {
    let configManager: ConfigManager;
    let merger: ConfigMerger;

    beforeEach(() => {
      configManager = new ConfigManager();
      merger = new ConfigMerger();
    });

    it('should handle empty extends array', async () => {
      const config: Partial<VisorConfig> = {
        extends: [],
        version: '1.0',
        checks: {
          test: {
            type: 'ai',
            prompt: 'Test',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      fs.writeFileSync(path.join(testConfigDir, 'empty-extends.yaml'), yaml.dump(config));

      const loaded = await configManager.loadConfig(path.join(testConfigDir, 'empty-extends.yaml'));
      expect(loaded.checks.test).toBeDefined();
      expect(loaded.version).toBe('1.0');
    });

    it('should handle null/undefined values in configs during merge', () => {
      const parent: Partial<VisorConfig> = {
        version: '1.0',
        ai_model: 'gpt-3.5',
        max_parallelism: 5,
        env: {
          API_KEY: 'parent-key',
          TIMEOUT: 30,
        },
        checks: {},
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const child: Partial<VisorConfig> = {
        // Don't set ai_model - it should be inherited
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        max_parallelism: null as any, // Should remove this field
        env: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          API_KEY: null as any, // Should remove this key
          NEW_KEY: 'new-value',
        },
        checks: {},
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const merged = merger.merge(parent, child);

      expect(merged.ai_model).toBe('gpt-3.5'); // Should be inherited from parent
      expect(merged.max_parallelism).toBe(null); // Should be set to null by child
      expect('API_KEY' in (merged.env || {})).toBe(false); // Should be removed by null
      expect(merged.env?.NEW_KEY).toBe('new-value');
      expect(merged.env?.TIMEOUT).toBe(30); // Should remain from parent
    });

    it('should handle complex inheritance chains (A extends B extends C)', async () => {
      const baseConfig: Partial<VisorConfig> = {
        version: '1.0',
        ai_model: 'gpt-3.5',
        checks: {
          base: {
            type: 'ai',
            prompt: 'Base check',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const middleConfig: Partial<VisorConfig> = {
        extends: './base.yaml',
        ai_model: 'gpt-4',
        checks: {
          middle: {
            type: 'tool',
            exec: 'npm test',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const topConfig: Partial<VisorConfig> = {
        extends: './middle.yaml',
        checks: {
          top: {
            type: 'http',
            url: 'https://example.com',
            body: '{"test": "data"}',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'json',
            group_by: 'file',
            collapse: true,
          },
        },
      };

      fs.writeFileSync(path.join(testConfigDir, 'base.yaml'), yaml.dump(baseConfig));
      fs.writeFileSync(path.join(testConfigDir, 'middle.yaml'), yaml.dump(middleConfig));
      fs.writeFileSync(path.join(testConfigDir, 'top.yaml'), yaml.dump(topConfig));

      const loaded = await configManager.loadConfig(path.join(testConfigDir, 'top.yaml'));

      expect(loaded.version).toBe('1.0'); // From base
      expect(loaded.ai_model).toBe('gpt-4'); // From middle
      expect(loaded.checks.base).toBeDefined(); // From base
      expect(loaded.checks.middle).toBeDefined(); // From middle
      expect(loaded.checks.top).toBeDefined(); // From top
      expect(loaded.output.pr_comment.format).toBe('json'); // From top
    });

    it('should handle mixed local and remote extends', async () => {
      const localConfig: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          local: {
            type: 'ai',
            prompt: 'Local check',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const remoteConfig: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          remote: {
            type: 'http',
            url: 'https://example.com',
            body: '{"test": "data"}',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const childConfig: Partial<VisorConfig> = {
        extends: ['./local.yaml', 'https://example.com/remote.yaml'],
        checks: {
          child: {
            type: 'tool',
            exec: 'npm test',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'json',
            group_by: 'file',
            collapse: true,
          },
        },
      };

      fs.writeFileSync(path.join(testConfigDir, 'local.yaml'), yaml.dump(localConfig));
      fs.writeFileSync(path.join(testConfigDir, 'mixed.yaml'), yaml.dump(childConfig));

      // Reset and configure fetch mock for this test
      jest.resetAllMocks();
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => yaml.dump(remoteConfig),
      });

      const loaded = await configManager.loadConfig(path.join(testConfigDir, 'mixed.yaml'));

      expect(loaded.checks.local).toBeDefined();
      expect(loaded.checks.remote).toBeDefined();
      expect(loaded.checks.child).toBeDefined();
      expect(loaded.output.pr_comment.format).toBe('json');
    });

    it('should handle extends with relative path resolution', async () => {
      // Create a subdirectory structure
      const subDir = path.join(testConfigDir, 'subdir');
      if (!fs.existsSync(subDir)) {
        fs.mkdirSync(subDir);
      }

      const parentConfig: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          parent: {
            type: 'ai',
            prompt: 'Parent check',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const childConfig: Partial<VisorConfig> = {
        extends: '../parent.yaml',
        checks: {
          child: {
            type: 'tool',
            exec: 'npm test',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      fs.writeFileSync(path.join(testConfigDir, 'parent.yaml'), yaml.dump(parentConfig));
      fs.writeFileSync(path.join(subDir, 'child.yaml'), yaml.dump(childConfig));

      const loaded = await configManager.loadConfig(path.join(subDir, 'child.yaml'));

      expect(loaded.checks.parent).toBeDefined();
      expect(loaded.checks.child).toBeDefined();
    });

    it('should handle deeply nested object merging', () => {
      const parent: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          complex: {
            type: 'ai',
            prompt: 'Test',
            on: ['pr_opened'],
            ai: {
              model: 'gpt-3.5',
              provider: 'openai',
              timeout: 30000,
            },
            template: {
              content: 'parent template content',
            },
            env: {
              PARENT_VAR: 'parent-value',
              SHARED_VAR: 'parent-shared',
            },
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const child: Partial<VisorConfig> = {
        checks: {
          complex: {
            type: 'ai',
            prompt: 'Test',
            on: ['pr_opened'],
            ai: {
              model: 'gpt-4', // Override model
              apiKey: 'child-api-key', // Add new property
              // timeout inherited from parent
            },
            template: {
              file: 'child-template.txt', // Add file reference
              // content should be overridden if both exist
            },
            env: {
              SHARED_VAR: 'child-shared', // Override shared var
              CHILD_VAR: 'child-value', // Add new var
            },
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const merged = merger.merge(parent, child);

      // Verify AI config merging
      expect(merged.checks?.complex?.ai?.model).toBe('gpt-4'); // Overridden
      expect(merged.checks?.complex?.ai?.provider).toBe('openai'); // Inherited
      expect(merged.checks?.complex?.ai?.timeout).toBe(30000); // Inherited
      expect(merged.checks?.complex?.ai?.apiKey).toBe('child-api-key'); // Added

      // Verify template config merging
      expect(merged.checks?.complex?.template?.content).toBe('parent template content'); // Inherited
      expect(merged.checks?.complex?.template?.file).toBe('child-template.txt'); // Added

      // Verify environment variable merging
      expect(merged.checks?.complex?.env?.PARENT_VAR).toBe('parent-value'); // Inherited
      expect(merged.checks?.complex?.env?.SHARED_VAR).toBe('child-shared'); // Overridden
      expect(merged.checks?.complex?.env?.CHILD_VAR).toBe('child-value'); // Added
    });
  });

  describe('Cache Behavior', () => {
    let loader: ConfigLoader;

    beforeEach(() => {
      loader = new ConfigLoader({
        baseDir: testConfigDir,
        cacheTTL: 1000, // 1 second for testing
      });
    });

    it('should cache remote configurations', async () => {
      const remoteConfig: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          cached: {
            type: 'ai',
            prompt: 'Cached check',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      // Create a fresh loader instance for this test to avoid cache conflicts
      const freshLoader = new ConfigLoader({
        baseDir: testConfigDir,
        cacheTTL: 1000,
      });

      // Reset all mocks to get accurate call count
      jest.resetAllMocks();
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        text: async () => yaml.dump(remoteConfig),
      });

      // First call
      const config1 = await freshLoader.fetchConfig('https://example.com/cached.yaml');
      expect(config1.checks?.cached).toBeDefined();

      // Second call should use cache (fetch should only be called once)
      const config2 = await freshLoader.fetchConfig('https://example.com/cached.yaml');
      expect(config2.checks?.cached).toBeDefined();

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should respect cache TTL and refetch after expiration', async () => {
      const loader = new ConfigLoader({
        baseDir: testConfigDir,
        cacheTTL: 50, // Very short TTL for testing
      });

      const remoteConfig: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          ttl: {
            type: 'ai',
            prompt: 'TTL check',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        text: async () => yaml.dump(remoteConfig),
      });

      // First call
      await loader.fetchConfig('https://example.com/ttl.yaml');
      expect(global.fetch).toHaveBeenCalledTimes(1);

      // Wait for TTL to expire
      await new Promise(resolve => setTimeout(resolve, 60));

      // Second call should refetch
      await loader.fetchConfig('https://example.com/ttl.yaml');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should clear cache when requested', async () => {
      const remoteConfig: Partial<VisorConfig> = {
        version: '1.0',
        checks: {},
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        text: async () => yaml.dump(remoteConfig),
      });

      // First call
      await loader.fetchConfig('https://example.com/clear-test.yaml');
      expect(global.fetch).toHaveBeenCalledTimes(1);

      // Clear cache
      loader.clearCache();

      // Second call should refetch
      await loader.fetchConfig('https://example.com/clear-test.yaml');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should reset loaded configs tracking', async () => {
      const remoteConfig: Partial<VisorConfig> = {
        version: '1.0',
        checks: {},
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        text: async () => yaml.dump(remoteConfig),
      });

      await loader.fetchConfig('https://example.com/reset-test.yaml');

      // Reset should clear both cache and tracking
      loader.reset();

      await loader.fetchConfig('https://example.com/reset-test.yaml');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('Security and Validation', () => {
    let configManager: ConfigManager;
    let loader: ConfigLoader;

    beforeEach(() => {
      configManager = new ConfigManager();
      loader = new ConfigLoader({ baseDir: testConfigDir });
    });

    it('should validate extends sources', async () => {
      // Test invalid extends types
      const config: Partial<VisorConfig> = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        extends: 123 as any, // Invalid type
        version: '1.0',
        checks: {},
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      fs.writeFileSync(path.join(testConfigDir, 'invalid-extends.yaml'), yaml.dump(config));

      // The config manager should handle this gracefully
      await expect(
        configManager.loadConfig(path.join(testConfigDir, 'invalid-extends.yaml'))
      ).rejects.toThrow();
    });

    it('should handle user agent in remote requests', async () => {
      const remoteConfig: Partial<VisorConfig> = {
        version: '1.0',
        checks: {},
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        text: async () => yaml.dump(remoteConfig),
      });

      await loader.fetchConfig('https://example.com/user-agent-test.yaml');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://example.com/user-agent-test.yaml',
        expect.objectContaining({
          headers: {
            'User-Agent': 'Visor/1.0',
          },
        })
      );
    });

    it('should validate maximum depth against actual recursion', async () => {
      const loader = new ConfigLoader({
        baseDir: testConfigDir,
        maxDepth: 3,
      });

      // Create a chain that exceeds max depth
      const configs = [];
      for (let i = 1; i <= 5; i++) {
        const config: Partial<VisorConfig> = {
          extends: i < 5 ? `./depth${i + 1}.yaml` : undefined,
          version: '1.0',
          checks: {
            [`check${i}`]: {
              type: 'ai',
              prompt: `Check ${i}`,
              on: ['pr_opened'],
            },
          },
          output: {
            pr_comment: {
              format: 'markdown',
              group_by: 'check',
              collapse: true,
            },
          },
        };
        configs.push(config);
        fs.writeFileSync(path.join(testConfigDir, `depth${i}.yaml`), yaml.dump(config));
      }

      await expect(loader.fetchConfig('./depth1.yaml')).rejects.toThrow('Maximum extends depth');
    });

    it('should handle malformed extends in nested configs', async () => {
      const validParent: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          parent: {
            type: 'ai',
            prompt: 'Parent check',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const childWithMalformedExtends: Partial<VisorConfig> = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        extends: { invalid: 'object' } as any, // Invalid extends format
        version: '1.0',
        checks: {},
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      fs.writeFileSync(path.join(testConfigDir, 'valid-parent.yaml'), yaml.dump(validParent));
      fs.writeFileSync(
        path.join(testConfigDir, 'malformed-child.yaml'),
        yaml.dump(childWithMalformedExtends)
      );

      await expect(
        configManager.loadConfig(path.join(testConfigDir, 'malformed-child.yaml'))
      ).rejects.toThrow();
    });
  });

  describe('Integration Tests', () => {
    let configManager: ConfigManager;

    beforeEach(() => {
      configManager = new ConfigManager();
    });

    it('should handle complete configuration loading flow with validation', async () => {
      const baseConfig: Partial<VisorConfig> = {
        version: '1.0',
        ai_model: 'gpt-3.5',
        max_parallelism: 2,
        checks: {
          security: {
            type: 'ai',
            prompt: 'Check for security issues',
            on: ['pr_opened'],
            group: 'security',
          },
          style: {
            type: 'tool',
            exec: 'eslint --format json',
            on: ['pr_opened'],
            group: 'quality',
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const childConfig: Partial<VisorConfig> = {
        extends: './base-integration.yaml',
        ai_model: 'gpt-4', // Override
        checks: {
          security: {
            type: 'ai',
            prompt: 'Enhanced security check with AI',
            on: ['pr_opened', 'pr_updated'], // Override
            group: 'security',
          },
          performance: {
            type: 'http',
            url: 'https://perf.example.com/analyze',
            body: '{"test": "data"}',
            on: ['pr_opened'],
            group: 'performance',
          },
        },
        output: {
          pr_comment: {
            format: 'json', // Override
            group_by: 'file', // Override
            collapse: false, // Override
          },
        },
      };

      fs.writeFileSync(path.join(testConfigDir, 'base-integration.yaml'), yaml.dump(baseConfig));
      fs.writeFileSync(path.join(testConfigDir, 'child-integration.yaml'), yaml.dump(childConfig));

      const config = await configManager.loadConfig(
        path.join(testConfigDir, 'child-integration.yaml'),
        { validate: true, mergeDefaults: true }
      );

      // Verify inheritance and overrides
      expect(config.version).toBe('1.0'); // From base
      expect(config.ai_model).toBe('gpt-4'); // Overridden
      expect(config.max_parallelism).toBe(2); // From base

      // Verify checks
      expect(config.checks.security.prompt).toBe('Enhanced security check with AI'); // Overridden
      expect(config.checks.security.on).toEqual(['pr_opened', 'pr_updated']); // Overridden
      expect(config.checks.style).toBeDefined(); // From base
      expect(config.checks.performance).toBeDefined(); // Added in child

      // Verify output
      expect(config.output.pr_comment.format).toBe('json'); // Overridden
      expect(config.output.pr_comment.group_by).toBe('file'); // Overridden
      expect(config.output.pr_comment.collapse).toBe(false); // Overridden
    });

    it('should handle configuration with disabled checks removal', async () => {
      const baseConfig: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          enabled: {
            type: 'ai',
            prompt: 'Enabled check',
            on: ['pr_opened'],
          },
          disabled: {
            type: 'ai',
            prompt: 'Disabled check',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const childConfig: Partial<VisorConfig> = {
        extends: './base-disabled.yaml',
        checks: {
          disabled: {
            type: 'ai',
            prompt: 'Disabled check',
            on: [], // Disable this check
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      fs.writeFileSync(path.join(testConfigDir, 'base-disabled.yaml'), yaml.dump(baseConfig));
      fs.writeFileSync(path.join(testConfigDir, 'child-disabled.yaml'), yaml.dump(childConfig));

      const config = await configManager.loadConfig(
        path.join(testConfigDir, 'child-disabled.yaml')
      );

      expect(config.checks.enabled).toBeDefined();
      expect(config.checks.disabled).toBeUndefined(); // Should be removed
    });

    it('should handle extends from default with custom overrides', async () => {
      const config: Partial<VisorConfig> = {
        extends: 'default',
        ai_model: 'custom-model',
        checks: {
          custom: {
            type: 'ai',
            prompt: 'Custom check',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      fs.writeFileSync(path.join(testConfigDir, 'default-override.yaml'), yaml.dump(config));

      const loaded = await configManager.loadConfig(
        path.join(testConfigDir, 'default-override.yaml')
      );

      expect(loaded.ai_model).toBe('custom-model');
      expect(loaded.checks.custom).toBeDefined();
      // Should have some checks from default config
      expect(Object.keys(loaded.checks).length).toBeGreaterThan(1);
    });
  });

  describe('Path Resolution', () => {
    let configManager: ConfigManager;

    beforeEach(() => {
      configManager = new ConfigManager();
    });

    it('should resolve absolute paths correctly', async () => {
      const parentConfig: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          absolute: {
            type: 'ai',
            prompt: 'Absolute path test',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const childConfig: Partial<VisorConfig> = {
        extends: path.join(testConfigDir, 'absolute-parent.yaml'), // Absolute path
        checks: {
          child: {
            type: 'tool',
            exec: 'echo test',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      fs.writeFileSync(path.join(testConfigDir, 'absolute-parent.yaml'), yaml.dump(parentConfig));
      fs.writeFileSync(path.join(testConfigDir, 'absolute-child.yaml'), yaml.dump(childConfig));

      const loaded = await configManager.loadConfig(
        path.join(testConfigDir, 'absolute-child.yaml')
      );

      expect(loaded.checks.absolute).toBeDefined();
      expect(loaded.checks.child).toBeDefined();
    });

    it('should handle complex relative path scenarios', async () => {
      // Create nested directory structure
      const level1Dir = path.join(testConfigDir, 'level1');
      const level2Dir = path.join(level1Dir, 'level2');

      if (!fs.existsSync(level1Dir)) fs.mkdirSync(level1Dir);
      if (!fs.existsSync(level2Dir)) fs.mkdirSync(level2Dir);

      const rootConfig: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          root: {
            type: 'ai',
            prompt: 'Root check',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const level1Config: Partial<VisorConfig> = {
        extends: '../root-config.yaml',
        checks: {
          level1: {
            type: 'tool',
            exec: 'echo level1',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const level2Config: Partial<VisorConfig> = {
        extends: '../level1-config.yaml',
        checks: {
          level2: {
            type: 'http',
            url: 'https://example.com',
            body: '{"test": "data"}',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'json',
            group_by: 'file',
            collapse: true,
          },
        },
      };

      fs.writeFileSync(path.join(testConfigDir, 'root-config.yaml'), yaml.dump(rootConfig));
      fs.writeFileSync(path.join(level1Dir, 'level1-config.yaml'), yaml.dump(level1Config));
      fs.writeFileSync(path.join(level2Dir, 'level2-config.yaml'), yaml.dump(level2Config));

      const loaded = await configManager.loadConfig(path.join(level2Dir, 'level2-config.yaml'));

      expect(loaded.checks.root).toBeDefined(); // From root
      expect(loaded.checks.level1).toBeDefined(); // From level1
      expect(loaded.checks.level2).toBeDefined(); // From level2
      expect(loaded.output.pr_comment.format).toBe('json'); // From level2
    });

    it('should handle mixed absolute and relative paths in extends array', async () => {
      const config1: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          config1: {
            type: 'ai',
            prompt: 'Config 1',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const config2: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          config2: {
            type: 'tool',
            exec: 'echo config2',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const childConfig: Partial<VisorConfig> = {
        extends: ['./relative-config1.yaml', path.join(testConfigDir, 'absolute-config2.yaml')],
        checks: {
          child: {
            type: 'http',
            url: 'https://example.com',
            body: '{"test": "data"}',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'json',
            group_by: 'file',
            collapse: true,
          },
        },
      };

      fs.writeFileSync(path.join(testConfigDir, 'relative-config1.yaml'), yaml.dump(config1));
      fs.writeFileSync(path.join(testConfigDir, 'absolute-config2.yaml'), yaml.dump(config2));
      fs.writeFileSync(path.join(testConfigDir, 'mixed-paths.yaml'), yaml.dump(childConfig));

      const loaded = await configManager.loadConfig(path.join(testConfigDir, 'mixed-paths.yaml'));

      expect(loaded.checks.config1).toBeDefined();
      expect(loaded.checks.config2).toBeDefined();
      expect(loaded.checks.child).toBeDefined();
    });
  });
});
