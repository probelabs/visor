import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ConfigManager } from '../../src/config';
import { ConfigMerger } from '../../src/utils/config-merger';
import { VisorConfig } from '../../src/types/config';

describe('Comprehensive Config Extends with appendPrompt', () => {
  const testConfigDir = path.join(__dirname, '../fixtures/config-extends-comprehensive');

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

  describe('Complete extends scenario with default config', () => {
    it('should properly extend default config with new checks and appendPrompt', async () => {
      // Create a config that extends default and modifies existing checks
      const extendedConfig: Partial<VisorConfig> = {
        extends: 'default',
        ai_model: 'gpt-4', // Override default model
        checks: {
          // Modify an existing check from default config with appendPrompt
          security: {
            type: 'ai',
            appendPrompt:
              'Additionally, check for SQL injection and XSS vulnerabilities specific to our React app.',
            on: ['pr_opened', 'pr_updated', 'manual'], // Add more triggers
          },
          // Add a completely new check
          'custom-react-check': {
            type: 'ai',
            prompt: 'Analyze React components for best practices and performance issues.',
            on: ['pr_opened', 'pr_updated'],
          },
          // Another new check that uses appendPrompt without parent
          'database-migration': {
            type: 'ai',
            appendPrompt: 'Verify database migration scripts are safe and reversible.',
            on: ['pr_opened'],
          },
        },
      };

      const configPath = path.join(testConfigDir, 'extended-config.yaml');
      fs.writeFileSync(configPath, yaml.dump(extendedConfig));

      const configManager = new ConfigManager();
      const loadedConfig = await configManager.loadConfig(configPath);

      // Verify that we have checks from both default and extended config
      expect(loadedConfig.checks).toBeDefined();
      const checkNames = Object.keys(loadedConfig.checks!);

      // Should have original checks from default config
      expect(checkNames).toContain('security');
      expect(checkNames).toContain('performance');
      expect(checkNames).toContain('quality');

      // Should have new checks from extended config
      expect(checkNames).toContain('custom-react-check');
      expect(checkNames).toContain('database-migration');

      // Verify security check has merged prompt (original + appended)
      const securityCheck = loadedConfig.checks!.security;
      expect(securityCheck).toBeDefined();
      expect(securityCheck.prompt).toContain('SQL injection and XSS vulnerabilities');
      // The original prompt should still be there (from default config)
      // Note: We'll check if it contains both parts

      // Verify appendPrompt is not in the final config
      expect('appendPrompt' in securityCheck).toBe(false);

      // Verify new check with direct prompt
      const reactCheck = loadedConfig.checks!['custom-react-check'];
      expect(reactCheck).toBeDefined();
      expect(reactCheck.prompt).toBe(
        'Analyze React components for best practices and performance issues.'
      );

      // Verify new check where appendPrompt becomes prompt (no parent)
      const dbCheck = loadedConfig.checks!['database-migration'];
      expect(dbCheck).toBeDefined();
      expect(dbCheck.prompt).toBe('Verify database migration scripts are safe and reversible.');
      expect('appendPrompt' in dbCheck).toBe(false);

      // Verify ai_model was overridden
      expect(loadedConfig.ai_model).toBe('gpt-4');
    });

    it('should properly handle multiple extends with appendPrompt', async () => {
      // Create base config
      const baseConfig: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          security: {
            type: 'ai',
            prompt: 'Basic security check',
            on: ['pr_opened'],
          },
          performance: {
            type: 'ai',
            prompt: 'Check performance',
            on: ['pr_opened'],
          },
        },
      };

      // Create team config that extends base
      const teamConfig: Partial<VisorConfig> = {
        extends: './base-config.yaml',
        checks: {
          security: {
            type: 'ai',
            appendPrompt: 'Follow OWASP guidelines',
            on: ['pr_opened', 'pr_updated'],
          },
          'team-specific': {
            type: 'ai',
            prompt: 'Team-specific checks',
            on: ['pr_opened'],
          },
        },
      };

      // Create project config that extends team config
      const projectConfig: Partial<VisorConfig> = {
        extends: './team-config.yaml',
        checks: {
          security: {
            type: 'ai',
            appendPrompt: 'Check for project-specific security patterns',
            on: ['pr_opened', 'pr_updated', 'manual'],
          },
          'project-feature': {
            type: 'ai',
            prompt: 'Project-specific feature check',
            on: ['pr_opened'],
          },
        },
      };

      // Write configs to files
      fs.writeFileSync(path.join(testConfigDir, 'base-config.yaml'), yaml.dump(baseConfig));
      fs.writeFileSync(path.join(testConfigDir, 'team-config.yaml'), yaml.dump(teamConfig));
      fs.writeFileSync(path.join(testConfigDir, 'project-config.yaml'), yaml.dump(projectConfig));

      const configManager = new ConfigManager();
      const loadedConfig = await configManager.loadConfig(
        path.join(testConfigDir, 'project-config.yaml')
      );

      // Verify all checks are present
      expect(loadedConfig.checks).toBeDefined();
      const checkNames = Object.keys(loadedConfig.checks!);
      expect(checkNames).toContain('security');
      expect(checkNames).toContain('performance');
      expect(checkNames).toContain('team-specific');
      expect(checkNames).toContain('project-feature');

      // Verify security check has all appended prompts combined
      const securityCheck = loadedConfig.checks!.security;
      expect(securityCheck.prompt).toContain('Basic security check');
      expect(securityCheck.prompt).toContain('Follow OWASP guidelines');
      expect(securityCheck.prompt).toContain('Check for project-specific security patterns');

      // Verify the prompts are properly separated
      const promptParts = securityCheck.prompt?.split('\n\n') || [];
      expect(promptParts.length).toBe(3);

      // Verify triggers are from the last config
      expect(securityCheck.on).toEqual(['pr_opened', 'pr_updated', 'manual']);

      // Verify performance check is unchanged from base
      expect(loadedConfig.checks!.performance.prompt).toBe('Check performance');
    });
  });

  describe('ConfigMerger direct tests', () => {
    let merger: ConfigMerger;

    beforeEach(() => {
      merger = new ConfigMerger();
    });

    it('should handle appendPrompt with both prompt and appendPrompt in child', () => {
      const parent: Partial<VisorConfig> = {
        checks: {
          test: {
            type: 'ai',
            prompt: 'Parent prompt',
            on: ['pr_opened'],
          },
        },
      };

      const child: Partial<VisorConfig> = {
        checks: {
          test: {
            type: 'ai',
            prompt: 'Child prompt',
            appendPrompt: 'Additional instructions',
            on: ['pr_opened'],
          },
        },
      };

      const merged = merger.merge(parent, child);

      // When child has both prompt and appendPrompt, prompt should override parent
      // and appendPrompt should be appended to the new prompt
      expect(merged.checks?.test?.prompt).toBe('Child prompt\n\nAdditional instructions');
      expect(merged.checks?.test && 'appendPrompt' in merged.checks!.test).toBe(false);
    });

    it('should handle new check with only appendPrompt', () => {
      const parent: Partial<VisorConfig> = {
        checks: {},
      };

      const child: Partial<VisorConfig> = {
        checks: {
          newCheck: {
            type: 'ai',
            appendPrompt: 'This becomes the prompt',
            on: ['pr_opened'],
          },
        },
      };

      const merged = merger.merge(parent, child);

      // appendPrompt should become prompt when there's no parent
      expect(merged.checks?.newCheck?.prompt).toBe('This becomes the prompt');
      expect(merged.checks?.newCheck && 'appendPrompt' in merged.checks!.newCheck).toBe(false);
    });

    it('should merge check fields correctly', () => {
      const parent: Partial<VisorConfig> = {
        checks: {
          test: {
            type: 'ai',
            prompt: 'Original prompt',
            on: ['pr_opened'],
            env: {
              VAR1: 'value1',
              VAR2: 'value2',
            },
          },
        },
      };

      const child: Partial<VisorConfig> = {
        checks: {
          test: {
            type: 'ai',
            appendPrompt: 'Additional checks',
            on: ['pr_opened', 'pr_updated'],
            env: {
              VAR2: 'updated',
              VAR3: 'new',
            },
          },
        },
      };

      const merged = merger.merge(parent, child);

      const testCheck = merged.checks?.test;
      expect(testCheck).toBeDefined();

      // Prompt should be combined
      expect(testCheck?.prompt).toBe('Original prompt\n\nAdditional checks');

      // on array should be replaced, not merged
      expect(testCheck?.on).toEqual(['pr_opened', 'pr_updated']);

      // env should be deep merged
      expect(testCheck?.env).toEqual({
        VAR1: 'value1',
        VAR2: 'updated',
        VAR3: 'new',
      });
    });
  });
});
