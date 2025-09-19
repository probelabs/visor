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
            type: 'webhook',
            url: 'https://example.com/webhook',
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
      expect(loaded.checks?.remote?.type).toBe('webhook');
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
            type: 'webhook',
            url: 'https://example.com',
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

      const loaded = await configManager.loadConfig(path.join(testConfigDir, 'extends-default.yaml'));

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
  });
});