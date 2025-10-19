import { ConfigManager } from '../../src/config';
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';

describe('Config - Steps/Checks Backward Compatibility', () => {
  let configManager: ConfigManager;
  const testConfigDir = path.join(__dirname, '..', 'fixtures', 'test-configs');

  beforeEach(() => {
    configManager = new ConfigManager();
    // Ensure test config directory exists
    if (!fs.existsSync(testConfigDir)) {
      fs.mkdirSync(testConfigDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test configs
    if (fs.existsSync(testConfigDir)) {
      const files = fs.readdirSync(testConfigDir);
      files.forEach(file => {
        if (file.startsWith('test-steps-')) {
          fs.unlinkSync(path.join(testConfigDir, file));
        }
      });
    }
  });

  describe('Config with "steps" key', () => {
    it('should load config with steps key', async () => {
      const configPath = path.join(testConfigDir, 'test-steps-only.yaml');
      const configContent = {
        version: '1.0',
        steps: {
          'test-step': {
            type: 'ai',
            prompt: 'Test prompt',
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

      fs.writeFileSync(configPath, yaml.dump(configContent));

      const config = await configManager.loadConfig(configPath);

      expect(config.steps).toBeDefined();
      expect(config.checks).toBeDefined(); // Should be normalized
      expect(config.steps!['test-step']).toBeDefined();
      expect(config.checks!['test-step']).toBeDefined();
      expect(config.steps!['test-step']).toEqual(config.checks!['test-step']);
    });
  });

  describe('Config with "checks" key (legacy)', () => {
    it('should load config with checks key', async () => {
      const configPath = path.join(testConfigDir, 'test-checks-only.yaml');
      const configContent = {
        version: '1.0',
        checks: {
          'test-check': {
            type: 'ai',
            prompt: 'Test prompt',
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

      fs.writeFileSync(configPath, yaml.dump(configContent));

      const config = await configManager.loadConfig(configPath);

      expect(config.checks).toBeDefined();
      expect(config.steps).toBeDefined(); // Should be normalized
      expect(config.checks!['test-check']).toBeDefined();
      expect(config.steps!['test-check']).toBeDefined();
      expect(config.steps!['test-check']).toEqual(config.checks!['test-check']);
    });
  });

  describe('Config with both "steps" and "checks"', () => {
    it('should use steps when both are present', async () => {
      const configPath = path.join(testConfigDir, 'test-both-keys.yaml');
      const configContent = {
        version: '1.0',
        steps: {
          'step-one': {
            type: 'ai',
            prompt: 'Step prompt',
          },
        },
        checks: {
          'check-one': {
            type: 'command',
            exec: 'echo test',
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

      fs.writeFileSync(configPath, yaml.dump(configContent));

      const config = await configManager.loadConfig(configPath);

      // When both present, steps takes precedence
      expect(config.steps).toBeDefined();
      expect(config.checks).toBeDefined();
      expect(config.steps!['step-one']).toBeDefined();
      expect(config.checks!['step-one']).toBeDefined(); // Should copy from steps
      expect(config.checks!['check-one']).toBeUndefined(); // Should be overwritten
    });
  });

  describe('Config with neither key', () => {
    it('should fail validation when neither steps nor checks is present', async () => {
      const configPath = path.join(testConfigDir, 'test-no-steps-or-checks.yaml');
      const configContent = {
        version: '1.0',
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      fs.writeFileSync(configPath, yaml.dump(configContent));

      await expect(configManager.loadConfig(configPath)).rejects.toThrow(
        'either "checks" or "steps" must be defined. "steps" is recommended for new configurations.'
      );
    });
  });

  describe('Default config', () => {
    it('should use steps in default config', async () => {
      const defaultConfig = await configManager.getDefaultConfig();

      expect(defaultConfig.steps).toBeDefined();
      expect(defaultConfig.checks).toBeDefined(); // Both should be present
      expect(Object.keys(defaultConfig.steps!).length).toBe(0); // Empty by default
      expect(Object.keys(defaultConfig.checks!).length).toBe(0);
    });
  });
});
