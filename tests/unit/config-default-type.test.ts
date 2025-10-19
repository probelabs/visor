import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ConfigManager } from '../../src/config';
import { ConfigMerger } from '../../src/utils/config-merger';
import { VisorConfig, CheckConfig } from '../../src/types/config';

describe('Default Check Type Behavior', () => {
  const testConfigDir = path.join(__dirname, '../fixtures/config-default-type');

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

  it('should default to "ai" type when type is not specified', async () => {
    const config: Partial<VisorConfig> = {
      version: '1.0',
      checks: {
        'test-check': {
          // No type specified - should default to 'ai'
          prompt: 'Test prompt',
          on: ['pr_opened'],
        } as CheckConfig, // Cast to CheckConfig to bypass TypeScript check
        'another-check': {
          // Explicitly set type
          type: 'command',
          exec: 'npm test',
          on: ['pr_opened'],
        },
      },
    };

    const configPath = path.join(testConfigDir, 'config-no-type.yaml');
    fs.writeFileSync(configPath, yaml.dump(config));

    const configManager = new ConfigManager();
    const loadedConfig = await configManager.loadConfig(configPath);

    // Check that the type defaulted to 'ai'
    expect(loadedConfig.checks!['test-check'].type).toBe('ai');
    // Check that explicitly set type is preserved
    expect(loadedConfig.checks!['another-check'].type).toBe('command');
  });

  it('should default to "ai" when merging configs without type', () => {
    const merger = new ConfigMerger();

    const parent: Partial<VisorConfig> = {
      version: '1.0',
      checks: {
        'parent-check': {
          type: 'ai',
          prompt: 'Parent prompt',
          on: ['pr_opened'],
        },
      },
    };

    const child: Partial<VisorConfig> = {
      checks: {
        'child-check': {
          // No type specified
          prompt: 'Child prompt',
          on: ['pr_opened'],
        } as CheckConfig,
      },
    };

    const merged = merger.merge(parent, child);

    // Parent check should remain
    expect(merged.checks?.['parent-check']?.type).toBe('ai');
    // Child check should default to 'ai'
    expect(merged.checks?.['child-check']?.type).toBe('ai');
  });

  it('should work with extends when type is not specified', async () => {
    // Create base config
    const baseConfig: Partial<VisorConfig> = {
      version: '1.0',
      checks: {
        'base-check': {
          type: 'ai',
          prompt: 'Base check',
          on: ['pr_opened'],
        },
      },
    };

    // Create extended config with no type specified
    const extendedConfig: Partial<VisorConfig> = {
      extends: './base-config.yaml',
      checks: {
        'extended-check': {
          // No type specified - should default to 'ai'
          prompt: 'Extended check',
          on: ['pr_opened', 'pr_updated'],
        } as CheckConfig,
      },
    };

    fs.writeFileSync(path.join(testConfigDir, 'base-config.yaml'), yaml.dump(baseConfig));
    fs.writeFileSync(path.join(testConfigDir, 'extended-config.yaml'), yaml.dump(extendedConfig));

    const configManager = new ConfigManager();
    const loadedConfig = await configManager.loadConfig(
      path.join(testConfigDir, 'extended-config.yaml')
    );

    // Both checks should exist
    expect(loadedConfig.checks!['base-check']).toBeDefined();
    expect(loadedConfig.checks!['extended-check']).toBeDefined();

    // Extended check should default to 'ai' type
    expect(loadedConfig.checks!['extended-check'].type).toBe('ai');
  });

  it('should work with minimal config (just prompt and on)', async () => {
    const minimalConfig = {
      version: '1.0',
      checks: {
        'simple-check': {
          prompt: 'Just a simple prompt',
          on: ['pr_opened'], // 'on' is required
          // No type specified - should default to 'ai'
        },
      },
    };

    const configPath = path.join(testConfigDir, 'minimal-config.yaml');
    fs.writeFileSync(configPath, yaml.dump(minimalConfig));

    const configManager = new ConfigManager();
    const loadedConfig = await configManager.loadConfig(configPath);

    // Should have defaulted to 'ai' type
    expect(loadedConfig.checks!['simple-check'].type).toBe('ai');
    // Should have the prompt
    expect(loadedConfig.checks!['simple-check'].prompt).toBe('Just a simple prompt');
  });

  it('should keep on field undefined when not specified', async () => {
    const config: Partial<VisorConfig> = {
      version: '1.0',
      checks: {
        'test-check': {
          type: 'ai',
          prompt: 'Test prompt',
          // No 'on' specified - remains undefined (can run on any event)
        } as CheckConfig,
        'another-check': {
          type: 'command',
          exec: 'npm test',
          on: ['pr_opened'], // Explicitly set
        },
      },
    };

    const configPath = path.join(testConfigDir, 'config-no-on.yaml');
    fs.writeFileSync(configPath, yaml.dump(config));

    const configManager = new ConfigManager();
    const loadedConfig = await configManager.loadConfig(configPath);

    // Check that the on field is undefined (not defaulted)
    expect(loadedConfig.checks!['test-check'].on).toBeUndefined();
    // Check that explicitly set on is preserved
    expect(loadedConfig.checks!['another-check'].on).toEqual(['pr_opened']);
  });

  it('should handle both type and on not specified', async () => {
    const config: Partial<VisorConfig> = {
      version: '1.0',
      checks: {
        'minimal-check': {
          // No type specified - should default to 'ai'
          // No on specified - remains undefined (can run on any event)
          prompt: 'Minimal check prompt',
        } as CheckConfig,
      },
    };

    const configPath = path.join(testConfigDir, 'config-minimal-fields.yaml');
    fs.writeFileSync(configPath, yaml.dump(config));

    const configManager = new ConfigManager();
    const loadedConfig = await configManager.loadConfig(configPath);

    // Check that type defaults to 'ai' but 'on' remains undefined
    expect(loadedConfig.checks!['minimal-check'].type).toBe('ai');
    expect(loadedConfig.checks!['minimal-check'].on).toBeUndefined();
    expect(loadedConfig.checks!['minimal-check'].prompt).toBe('Minimal check prompt');
  });

  it('should handle appendPrompt without type specified', async () => {
    const baseConfig: Partial<VisorConfig> = {
      version: '1.0',
      checks: {
        security: {
          type: 'ai',
          prompt: 'Security analysis',
          on: ['pr_opened'],
        },
      },
    };

    const extendedConfig: Partial<VisorConfig> = {
      extends: './base-security.yaml',
      checks: {
        security: {
          // No type specified, just appending to prompt
          appendPrompt: 'Also check for XSS',
          on: ['pr_opened', 'pr_updated'],
        } as CheckConfig,
        'new-check': {
          // New check without type
          appendPrompt: 'This becomes the prompt',
          on: ['pr_opened'],
        } as CheckConfig,
      },
    };

    fs.writeFileSync(path.join(testConfigDir, 'base-security.yaml'), yaml.dump(baseConfig));
    fs.writeFileSync(path.join(testConfigDir, 'extended-security.yaml'), yaml.dump(extendedConfig));

    const configManager = new ConfigManager();
    const loadedConfig = await configManager.loadConfig(
      path.join(testConfigDir, 'extended-security.yaml')
    );

    // Security check should maintain 'ai' type
    expect(loadedConfig.checks!.security.type).toBe('ai');
    // Should have merged prompts
    expect(loadedConfig.checks!.security.prompt).toContain('Security analysis');
    expect(loadedConfig.checks!.security.prompt).toContain('Also check for XSS');

    // New check should default to 'ai'
    expect(loadedConfig.checks!['new-check'].type).toBe('ai');
    expect(loadedConfig.checks!['new-check'].prompt).toBe('This becomes the prompt');
  });
});
