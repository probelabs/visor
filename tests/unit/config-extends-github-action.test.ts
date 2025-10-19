import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ConfigManager } from '../../src/config';
import { VisorConfig } from '../../src/types/config';

describe('Config Extends in GitHub Action Context', () => {
  const testConfigDir = path.join(__dirname, '../fixtures/config-extends-action');

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

  it('should correctly load and merge config with extends: default in GitHub Action', async () => {
    // Create a user config that extends default and adds new checks
    const userConfig: Partial<VisorConfig> = {
      extends: 'default',
      checks: {
        // Add new checks
        'custom-check-1': {
          type: 'ai',
          prompt: 'Custom analysis for our project',
          on: ['pr_opened', 'pr_updated'],
        },
        'custom-check-2': {
          type: 'command',
          exec: 'npm run custom-lint',
          on: ['pr_opened', 'pr_updated'],
        },
        // Modify existing check with appendPrompt
        security: {
          type: 'ai',
          appendPrompt: 'Also check for our specific security patterns',
          on: ['pr_opened', 'pr_updated', 'manual'],
        },
      },
    };

    const configPath = path.join(testConfigDir, '.visor.yaml');
    fs.writeFileSync(configPath, yaml.dump(userConfig));

    const configManager = new ConfigManager();

    // Debug: Check if config file exists
    console.log('Config file exists:', fs.existsSync(configPath));
    console.log('Config file content:', fs.readFileSync(configPath, 'utf8'));

    // Change to test directory to simulate being in the project root
    const originalCwd = process.cwd();
    process.chdir(testConfigDir);

    try {
      // This simulates what happens in index.ts when finding config in project
      const loadedConfig = await configManager.findAndLoadConfig();

      // Verify the loaded config has both default and custom checks
      expect(loadedConfig).toBeDefined();
      expect(loadedConfig.checks).toBeDefined();

      const checkNames = Object.keys(loadedConfig.checks!);
      console.log('Loaded checks:', checkNames);

      // Should have default checks
      expect(checkNames).toContain('overview');
      expect(checkNames).toContain('security');
      expect(checkNames).toContain('performance');
      expect(checkNames).toContain('quality');

      // Should ALSO have the new custom checks
      expect(checkNames).toContain('custom-check-1');
      expect(checkNames).toContain('custom-check-2');

      // Verify the security check has the merged prompt
      const securityCheck = loadedConfig.checks!.security;
      expect(securityCheck).toBeDefined();
      expect(securityCheck.prompt).toContain('specific security patterns');

      // Verify custom checks are properly configured
      expect(loadedConfig.checks!['custom-check-1'].prompt).toBe('Custom analysis for our project');
      expect(loadedConfig.checks!['custom-check-2'].exec).toBe('npm run custom-lint');

      // Now simulate the event filtering that happens in handleEvent
      const eventType = 'pr_updated'; // Common GitHub event
      const eventChecks: string[] = [];

      for (const [checkName, checkConfig] of Object.entries(loadedConfig.checks || {})) {
        const checkEvents = checkConfig.on || ['pr_opened', 'pr_updated'];
        if (checkEvents.includes(eventType)) {
          eventChecks.push(checkName);
        }
      }

      console.log(`Checks that would run for ${eventType}:`, eventChecks);

      // Verify that both default and custom checks are in the list for pr_updated
      expect(eventChecks).toContain('overview');
      expect(eventChecks).toContain('security');
      expect(eventChecks).toContain('performance');
      expect(eventChecks).toContain('quality');
      expect(eventChecks).toContain('custom-check-1');
      expect(eventChecks).toContain('custom-check-2');

      // The list should have all 6+ checks, not just the 4 default ones
      expect(eventChecks.length).toBeGreaterThanOrEqual(6);
    } finally {
      // Restore original directory
      process.chdir(originalCwd);
    }
  });

  it('should handle config in current directory when searching', async () => {
    // Save current directory
    const originalCwd = process.cwd();

    try {
      // Create config in test directory
      const userConfig: Partial<VisorConfig> = {
        extends: 'default',
        checks: {
          'test-check': {
            type: 'ai',
            prompt: 'Test check',
            on: ['pr_opened'],
          },
        },
      };

      fs.writeFileSync(path.join(testConfigDir, '.visor.yaml'), yaml.dump(userConfig));

      // Change to test directory
      process.chdir(testConfigDir);

      const configManager = new ConfigManager();
      const loadedConfig = await configManager.findAndLoadConfig();

      // Should find and load the config with extends
      expect(loadedConfig.checks).toBeDefined();
      expect(Object.keys(loadedConfig.checks!)).toContain('test-check');
      // Should also have default checks
      expect(Object.keys(loadedConfig.checks!)).toContain('overview');
    } finally {
      // Restore original directory
      process.chdir(originalCwd);
    }
  });
});
