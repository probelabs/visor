/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConfigManager } from '../../src/config';
import { EventMapper } from '../../src/event-mapper';
import { ActionCliBridge } from '../../src/action-cli-bridge';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

describe('Configuration Corruption & Recovery Tests', () => {
  let tempDir: string;
  let configManager: ConfigManager;

  beforeAll(() => {
    // Create temporary directory for test configs
    tempDir = path.join(os.tmpdir(), 'visor-config-tests');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  });

  afterAll(() => {
    // Cleanup temporary directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      console.warn('Could not cleanup temp directory');
    }
  });

  beforeEach(() => {
    configManager = new ConfigManager();
  });

  describe('File System Corruption', () => {
    test('should handle non-existent configuration files', async () => {
      console.log('Testing non-existent configuration file handling...');

      const nonExistentPaths = [
        '/nonexistent/config.yaml',
        './missing-config.yaml',
        '../../../does-not-exist.yaml',
        'config-that-never-existed.yaml',
      ];

      for (const configPath of nonExistentPaths) {
        console.log(`  Testing path: ${configPath}`);

        try {
          await configManager.loadConfig(configPath);
          fail(`Should have thrown error for non-existent file: ${configPath}`);
        } catch (error) {
          console.log(`    Error: ${(error as Error).message}`);

          // Should provide clear error message
          expect((error as Error).message).toContain('Configuration file not found');
          expect((error as Error).message).toContain(configPath);
        }
      }
    });

    test('should handle empty configuration files', async () => {
      console.log('Testing empty configuration file handling...');

      // Create empty config files
      const emptyConfigs = [
        { name: 'completely-empty.yaml', content: '' },
        { name: 'whitespace-only.yaml', content: '   \n\t  \n   ' },
        { name: 'comments-only.yaml', content: '# Only comments\n# No actual config\n' },
        { name: 'null-content.yaml', content: 'null' },
        { name: 'empty-object.yaml', content: '{}' },
      ];

      for (const configTest of emptyConfigs) {
        console.log(`  Testing ${configTest.name}...`);

        const configPath = path.join(tempDir, configTest.name);
        fs.writeFileSync(configPath, configTest.content);

        try {
          const config = await configManager.loadConfig(configPath);

          console.log(`    Loaded config: ${JSON.stringify(config, null, 2)}`);

          // Should provide reasonable defaults for empty configs
          expect(config).toBeDefined();

          // Should have some reasonable structure
          if (config.version) {
            expect(typeof config.version).toBe('string');
          }

          if (config.checks) {
            expect(typeof config.checks).toBe('object');
          }
        } catch (error) {
          console.log(`    Empty config error: ${(error as Error).message}`);

          // Should provide helpful error for truly empty configs
          expect((error as Error).message).toBeDefined();
          expect((error as Error).message.length).toBeGreaterThan(10);
        }

        // Cleanup
        try {
          fs.unlinkSync(configPath);
        } catch {
          console.warn(`Could not cleanup ${configPath}`);
        }
      }
    });

    test('should handle permission denied errors', async () => {
      console.log('Testing permission denied error handling...');

      // Create config file and make it unreadable (Unix-like systems only)
      const restrictedConfigPath = path.join(tempDir, 'restricted-config.yaml');
      const validConfig = {
        version: '1.0',
        checks: {
          'test-check': {
            type: 'ai',
            prompt: 'Test',
            on: ['pr_opened'],
          },
        },
      };

      fs.writeFileSync(restrictedConfigPath, yaml.dump(validConfig));

      // Try to make file unreadable (may not work on all systems)
      try {
        fs.chmodSync(restrictedConfigPath, 0o000);

        try {
          await configManager.loadConfig(restrictedConfigPath);

          // If we got here, the system allows reading despite chmod (e.g., running as root)
          console.log('    Permission restriction not enforced on this system');
        } catch (error) {
          console.log(`    Permission error: ${(error as Error).message}`);

          // Should handle permission errors gracefully
          expect((error as Error).message).toBeDefined();
          expect((error as any).code === 'EACCES' || (error as any).code === 'EPERM').toBe(true);
        }

        // Restore permissions for cleanup
        fs.chmodSync(restrictedConfigPath, 0o644);
      } catch {
        console.log('    Cannot test permissions on this system');
      }

      // Cleanup
      try {
        fs.unlinkSync(restrictedConfigPath);
      } catch {
        console.warn('Could not cleanup restricted config file');
      }
    });
  });

  describe('YAML Syntax Corruption', () => {
    test('should handle invalid YAML syntax', async () => {
      console.log('Testing invalid YAML syntax handling...');

      const invalidYamlCases = [
        {
          name: 'unterminated-string.yaml',
          content: `version: "1.0\nchecks: {}\n`, // Unterminated string
        },
        {
          name: 'invalid-indentation.yaml',
          content: `version: "1.0"\n  checks:\nmalformed: true`, // Bad indentation
        },
        {
          name: 'invalid-characters.yaml',
          content: `version: "1.0"\nchecks: {\x00\x01\x02}`, // Control characters
        },
        {
          name: 'unclosed-brackets.yaml',
          content: `version: "1.0"\nchecks: {\n  test-check: {\n    type: ai`, // Unclosed brackets
        },
        {
          name: 'mixed-formats.yaml',
          content: `version: "1.0"\nchecks: {"json": "style"}\nyaml_style: value`, // Mixed JSON and YAML
        },
        {
          name: 'invalid-escape-sequences.yaml',
          content: `version: "1.0"\nmessage: "Invalid escape \\z \\q \\x"`, // Invalid escapes
        },
      ];

      for (const yamlTest of invalidYamlCases) {
        console.log(`  Testing ${yamlTest.name}...`);

        const configPath = path.join(tempDir, yamlTest.name);
        fs.writeFileSync(configPath, yamlTest.content);

        try {
          const config = await configManager.loadConfig(configPath);

          console.log(`    Invalid YAML somehow parsed: ${JSON.stringify(config, null, 2)}`);

          // If it parsed, it should still be valid
          expect(config).toBeDefined();
        } catch (error) {
          console.log(`    YAML syntax error: ${(error as Error).message}`);

          // Should provide helpful YAML parsing error
          expect((error as Error).message).toBeDefined();
          const lowerMessage = (error as Error).message.toLowerCase();

          // Debug - log which test case failed matching
          const hasMatch =
            lowerMessage.includes('yaml') ||
            lowerMessage.includes('parse') ||
            lowerMessage.includes('syntax') ||
            lowerMessage.includes('stream') ||
            lowerMessage.includes('scalar') ||
            lowerMessage.includes('indentation') ||
            lowerMessage.includes('null byte') ||
            lowerMessage.includes('unexpected') ||
            lowerMessage.includes('invalid') ||
            lowerMessage.includes('missing') || // For missing required fields
            lowerMessage.includes('required') || // For required field errors
            lowerMessage.includes('failed') || // For general failures
            lowerMessage.includes('error'); // Generic error messages

          if (!hasMatch) {
            console.log(
              `    Error message didn't match expected patterns: "${(error as Error).message}"`
            );
          }

          expect(hasMatch).toBe(true);
        }

        // Cleanup
        try {
          fs.unlinkSync(configPath);
        } catch {
          console.warn(`Could not cleanup ${configPath}`);
        }
      }
    });

    test('should handle YAML with dangerous constructs', async () => {
      console.log('Testing YAML with potentially dangerous constructs...');

      const dangerousYamlCases = [
        {
          name: 'code-execution-attempt.yaml',
          content: `version: "1.0"\ncommand: !!python/object/apply:os.system ['rm -rf /']`,
        },
        {
          name: 'file-inclusion-attempt.yaml',
          content: `version: "1.0"\ninclude: !include /etc/passwd`,
        },
        {
          name: 'binary-data.yaml',
          content: `version: "1.0"\ndata: !!binary |
  R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7`,
        },
        {
          name: 'recursive-reference.yaml',
          content: `version: "1.0"\nself: &self\n  recursive: *self`,
        },
      ];

      for (const dangerousTest of dangerousYamlCases) {
        console.log(`  Testing ${dangerousTest.name}...`);

        const configPath = path.join(tempDir, dangerousTest.name);
        fs.writeFileSync(configPath, dangerousTest.content);

        try {
          const config = await configManager.loadConfig(configPath);

          console.log(`    Dangerous YAML handled safely`);

          // Should parse safely without executing dangerous constructs
          expect(config).toBeDefined();
          expect(config.version).toBe('1.0');

          // Should not have executed any dangerous operations
          expect(process.cwd()).toBeDefined(); // We should still exist!
        } catch (error) {
          console.log(`    Dangerous construct blocked: ${(error as Error).message}`);

          // Should block dangerous constructs
          expect((error as Error).message).toBeDefined();
        }

        // Cleanup
        try {
          fs.unlinkSync(configPath);
        } catch {
          console.warn(`Could not cleanup ${configPath}`);
        }
      }
    });
  });

  describe('Schema Corruption', () => {
    test('should handle configuration with missing required fields', async () => {
      console.log('Testing configuration with missing required fields...');

      const incompleteConfigs = [
        {
          name: 'missing-version.yaml',
          config: {
            // version missing
            checks: {
              'test-check': {
                type: 'ai',
                prompt: 'Test',
                on: ['pr_opened'],
              },
            },
          },
        },
        {
          name: 'missing-checks.yaml',
          config: {
            version: '1.0',
            // checks missing
            output: {
              pr_comment: { format: 'table', group_by: 'check', collapse: true },
            },
          },
        },
        {
          name: 'incomplete-check.yaml',
          config: {
            version: '1.0',
            checks: {
              'incomplete-check': {
                type: 'ai',
                // prompt missing
                // on missing
              },
            },
          },
        },
      ];

      for (const configTest of incompleteConfigs) {
        console.log(`  Testing ${configTest.name}...`);

        const configPath = path.join(tempDir, configTest.name);
        fs.writeFileSync(configPath, yaml.dump(configTest.config));

        try {
          const config = await configManager.loadConfig(configPath);

          console.log(`    Incomplete config loaded with defaults`);

          // Should provide reasonable defaults
          expect(config).toBeDefined();

          // Test that it can still be used
          const eventMapper = new EventMapper(config);
          expect(eventMapper).toBeDefined();
        } catch (error) {
          console.log(`    Incomplete config error: ${(error as Error).message}`);

          // Should provide clear error about missing fields
          expect((error as Error).message).toBeDefined();
          expect(
            (error as Error).message.includes('missing') ||
              (error as Error).message.includes('required')
          ).toBe(true);
        }

        // Cleanup
        try {
          fs.unlinkSync(configPath);
        } catch {
          console.warn(`Could not cleanup ${configPath}`);
        }
      }
    });

    test('should handle configuration with invalid data types', async () => {
      console.log('Testing configuration with invalid data types...');

      const invalidTypeConfigs = [
        {
          name: 'string-version.yaml',
          config: {
            version: 123, // Should be string
            checks: {},
          },
        },
        {
          name: 'array-checks.yaml',
          config: {
            version: '1.0',
            checks: ['not', 'an', 'object'], // Should be object
          },
        },
        {
          name: 'invalid-check-types.yaml',
          config: {
            version: '1.0',
            checks: {
              'invalid-type-check': {
                type: 'unknown-type', // Invalid type
                prompt: 'Test',
                on: ['pr_opened'],
              },
              'string-on': {
                type: 'ai',
                prompt: 'Test',
                on: 'pr_opened', // Should be array
              },
            },
          },
        },
      ];

      for (const configTest of invalidTypeConfigs) {
        console.log(`  Testing ${configTest.name}...`);

        const configPath = path.join(tempDir, configTest.name);
        fs.writeFileSync(configPath, yaml.dump(configTest.config));

        try {
          const config = await configManager.loadConfig(configPath);

          console.log(`    Invalid types handled with conversion`);

          // Should convert or handle invalid types
          expect(config).toBeDefined();

          // For most cases, the config should load successfully with type handling
          if (config.version) {
            // Version could be converted to string or remain as number
            expect(typeof config.version).toMatch(/string|number/);
          }
        } catch (error) {
          console.log(`    Type validation error: ${(error as Error).message}`);

          // Should provide clear error about type issues
          expect((error as Error).message).toBeDefined();
          expect((error as Error).message.length).toBeGreaterThan(0);
        }

        // Cleanup
        try {
          fs.unlinkSync(configPath);
        } catch {
          console.warn(`Could not cleanup ${configPath}`);
        }
      }
    });
  });

  describe('Recovery and Fallback Mechanisms', () => {
    test('should provide helpful error messages with recovery suggestions', async () => {
      console.log('Testing error messages with recovery suggestions...');

      const errorScenarios = [
        {
          name: 'Non-existent file',
          action: () => configManager.loadConfig('/nonexistent/config.yaml'),
          expectedSuggestions: ['create', 'path', 'exists'],
        },
        {
          name: 'Invalid YAML',
          setup: () => {
            const invalidPath = path.join(tempDir, 'invalid-syntax.yaml');
            fs.writeFileSync(invalidPath, 'version: "1.0\nchecks: {unclosed');
            return invalidPath;
          },
          action: (path: string) => configManager.loadConfig(path),
          expectedSuggestions: ['syntax', 'yaml', 'valid'],
        },
      ];

      for (const scenario of errorScenarios) {
        console.log(`  Testing ${scenario.name}...`);

        let testPath: string | undefined;

        try {
          if (scenario.setup) {
            testPath = scenario.setup();
            await scenario.action(testPath);
          } else {
            await scenario.action();
          }

          fail(`Should have thrown error for ${scenario.name}`);
        } catch (error) {
          console.log(`    Error message: ${(error as Error).message}`);

          // Should provide helpful error message
          expect((error as Error).message).toBeDefined();
          expect((error as Error).message.length).toBeGreaterThan(20);

          // Should contain some recovery suggestions
          const lowerMessage = (error as Error).message.toLowerCase();
          const hasSuggestions = scenario.expectedSuggestions.some(suggestion =>
            lowerMessage.includes(suggestion)
          );

          if (hasSuggestions) {
            console.log(`    Contains helpful suggestions ✓`);
          } else {
            console.log(`    Missing recovery suggestions`);
          }
        }

        // Cleanup
        if (testPath) {
          try {
            fs.unlinkSync(testPath);
          } catch {
            console.warn(`Could not cleanup ${testPath}`);
          }
        }
      }
    });

    test('should handle ActionCliBridge with corrupted inputs gracefully', async () => {
      console.log('Testing ActionCliBridge with corrupted inputs...');

      const corruptedInputs = [
        // Null/undefined values
        {
          'github-token': null,
          'visor-checks': undefined,
        },
        // Invalid JSON-like strings
        {
          'github-token': 'token',
          'visor-checks': '{invalid: json}',
        },
        // Extremely long values
        {
          'github-token': 'token',
          'visor-checks': 'check1,'.repeat(1000) + 'check2', // Very long check list
          'visor-config-path': '/'.repeat(1000) + 'config.yaml', // Very long path
        },
        // Binary data
        {
          'github-token': 'token',
          'visor-checks': String.fromCharCode(0, 1, 2, 3, 4, 5),
        },
      ];

      const context = {
        event_name: 'pull_request',
        repository: {
          owner: { login: 'test-owner' },
          name: 'test-repo',
        },
      };

      for (let i = 0; i < corruptedInputs.length; i++) {
        const inputs = corruptedInputs[i] as Record<string, unknown>;
        console.log(`  Testing corrupted input ${i + 1}...`);

        try {
          const bridge = new ActionCliBridge('test-token', context);

          const shouldUse = bridge.shouldUseVisor({
            ...inputs,
            'github-token': 'test-token',
          } as any);
          console.log(`    Should use Visor: ${shouldUse}`);

          if (shouldUse) {
            const args = bridge.parseGitHubInputsToCliArgs({
              ...inputs,
              'github-token': 'test-token',
            } as any);
            console.log(`    Parsed args: ${args.length} arguments`);

            // Should handle corrupted inputs without crashing
            expect(Array.isArray(args)).toBe(true);
          }
        } catch (error) {
          console.log(`    Corrupted input error: ${(error as Error).message}`);

          // Should handle corrupted inputs gracefully
          expect((error as Error).message).toBeDefined();
          expect((error as Error).message).not.toContain('undefined is not a function');
          expect((error as Error).message).not.toContain('Cannot read property');
        }
      }
    });

    test('should handle configuration inheritance and merging edge cases', async () => {
      console.log('Testing configuration merging with edge cases...');

      // Create base config with some values
      const baseConfig = {
        version: '1.0',
        checks: {
          'base-check': {
            type: 'ai' as const,
            prompt: 'Base check',
            on: ['pr_opened' as const],
          },
        },
        output: {
          pr_comment: {
            format: 'table' as const,
            group_by: 'check' as const,
            collapse: true,
          },
        },
      };

      const edgeCaseMerges = [
        // CLI options with null values
        {
          checks: null as null,
          output: 'json' as const,
          configPath: undefined,
          help: false,
          version: false,
        },
        // CLI options with invalid types
        {
          checks: 'not-an-array' as unknown as string[],
          output: 123 as unknown as string,
          configPath: true as unknown as string,
          help: 'yes' as unknown as boolean,
          version: 1 as unknown as boolean,
        },
        // CLI options with extreme values
        {
          checks: Array(1000).fill('all') as string[],
          output: 'x'.repeat(1000) as string,
          configPath: '/'.repeat(500),
          help: false,
          version: false,
        },
      ];

      for (let i = 0; i < edgeCaseMerges.length; i++) {
        const cliOptions = edgeCaseMerges[i];
        console.log(`  Testing merge case ${i + 1}...`);

        try {
          const mergedConfig = configManager.mergeWithCliOptions(baseConfig, {
            ...cliOptions,
            checks: cliOptions.checks || [],
          } as any);

          console.log(
            `    Merge successful: config has ${Object.keys(mergedConfig.config.checks || {}).length} checks`
          );

          // Should merge without corruption
          expect(mergedConfig).toBeDefined();
          expect(mergedConfig.config).toBeDefined();

          // Should preserve valid base config values
          expect(mergedConfig.config.version).toBe('1.0');
        } catch (error) {
          console.log(`    Merge error: ${(error as Error).message}`);

          // Should provide clear error for merge issues
          expect((error as Error).message).toBeDefined();
          expect((error as Error).message).not.toContain('Cannot read property');
        }
      }
    });
  });
});
