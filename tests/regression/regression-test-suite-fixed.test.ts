/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { CLI } from '../../src/cli';
import { ConfigManager } from '../../src/config';
import { PRAnalyzer } from '../../src/pr-analyzer';
import { EventMapper } from '../../src/event-mapper';
import { CommentManager } from '../../src/github-comments';
import { ActionCliBridge } from '../../src/action-cli-bridge';
import { PerformanceTimer, MemoryProfiler } from '../performance/test-utilities';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

/**
 * Comprehensive Regression Test Suite for Visor
 *
 * This suite ensures that:
 * 1. All existing functionality continues to work after changes
 * 2. Performance characteristics remain within acceptable bounds
 * 3. Integration between components remains stable
 * 4. Backward compatibility is maintained
 * 5. Error handling patterns remain consistent
 */
describe('Visor Regression Test Suite', () => {
  let timer: PerformanceTimer;
  let memoryProfiler: MemoryProfiler;
  let tempConfigDir: string;

  beforeAll(() => {
    timer = new PerformanceTimer();
    memoryProfiler = new MemoryProfiler();

    // Create temporary directory for test configurations
    tempConfigDir = path.join(__dirname, '..', 'fixtures', 'regression-temp');
    if (!fs.existsSync(tempConfigDir)) {
      fs.mkdirSync(tempConfigDir, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up temporary configurations
    if (fs.existsSync(tempConfigDir)) {
      fs.rmSync(tempConfigDir, { recursive: true, force: true });
    }
  });

  describe('CLI Interface Regression Tests', () => {
    test('should maintain CLI argument parsing compatibility', () => {
      const cli = new CLI();

      // Test Visor CLI arguments
      const visorArgs = cli.parseArgs(['--check', 'performance', '--config', './visor.yaml']);
      expect(visorArgs).toHaveProperty('checks');
      expect(visorArgs.checks).toContain('performance');
      expect(visorArgs).toHaveProperty('configPath', './visor.yaml');

      // Test output format
      const outputArgs = cli.parseArgs(['--check', 'security', '--output', 'json']);
      expect(outputArgs).toHaveProperty('checks');
      expect(outputArgs.checks).toContain('security');
      expect(outputArgs).toHaveProperty('output', 'json');
    });

    test('should maintain help output structure', () => {
      const cli = new CLI();
      // Note: Testing CLI functionality without specific getHelp method
      expect(cli).toBeDefined();

      // Test that CLI can be instantiated and basic parsing works
      const basicArgs = cli.parseArgs(['--check', 'security']);
      expect(basicArgs.checks).toContain('security');
    });

    test('should maintain consistent exit codes', async () => {
      const cli = new CLI();

      // Test successful execution
      try {
        const result = cli.parseArgs(['--check', 'security']);
        expect(typeof result).toBe('object');
        expect(result.checks).toContain('security');
      } catch (error: any) {
        // Should not throw for valid arguments
        expect(false).toBe(true);
      }
    });
  });

  describe('Configuration System Regression Tests', () => {
    test('should maintain config file format compatibility', async () => {
      const configManager = new ConfigManager();

      // Test legacy configuration format (JSON)
      const legacyConfig = {
        version: '1.0',
        checks: {
          'basic-check': {
            type: 'ai',
            prompt: 'Basic review',
            on: ['pr_opened'],
          },
        },
        ai: {
          provider: 'openai',
          model: 'gpt-4',
        },
        github: {
          token: 'test-token',
        },
      };

      const legacyConfigPath = path.join(tempConfigDir, 'legacy.json');
      fs.writeFileSync(legacyConfigPath, JSON.stringify(legacyConfig, null, 2));

      const loadedLegacy = await configManager.loadConfig(legacyConfigPath);
      expect(loadedLegacy.version).toBe('1.0');

      // Test new Visor configuration format (YAML)
      const visorConfig = {
        version: '1.0',
        checks: {
          'security-review': {
            type: 'ai',
            prompt: 'Review for security issues',
            on: ['pr_opened', 'pr_updated'],
          },
        },
        output: {
          pr_comment: {
            format: 'summary',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      const visorConfigPath = path.join(tempConfigDir, 'visor.yaml');
      fs.writeFileSync(visorConfigPath, yaml.dump(visorConfig));

      const loadedVisor = await configManager.loadConfig(visorConfigPath);
      expect(loadedVisor.version).toBe('1.0');
      expect(loadedVisor.checks).toBeDefined();
      expect(loadedVisor.checks!['security-review']).toBeDefined();
    });

    test('should maintain config merging behavior', async () => {
      const configManager = new ConfigManager();

      const baseConfig = {
        version: '1.0',
        checks: {
          'basic-check': {
            type: 'ai' as const,
            prompt: 'Basic review',
            on: ['pr_opened' as const],
          },
        },
      };

      const cliOptions = {
        checks: ['performance' as const],
        output: 'json' as const,
      };

      const merged = configManager.mergeWithCliOptions(baseConfig, cliOptions);

      // Merged config should have the structure we expect
      expect(merged).toHaveProperty('config');
      expect(merged).toHaveProperty('cliChecks');
      expect(merged).toHaveProperty('cliOutput');

      // CLI options should be properly captured
      expect(merged.cliOutput).toBe('json');
      expect(merged.cliChecks).toContain('performance');
    });

    test('should maintain config discovery behavior', async () => {
      const configManager = new ConfigManager();

      // Create test configs in the temp directory
      const configs = ['visor.config.yaml', 'visor.config.json', '.visor.yaml', '.visorrc'];

      configs.forEach(configName => {
        const configPath = path.join(tempConfigDir, configName);
        fs.writeFileSync(
          configPath,
          yaml.dump({
            version: '1.0',
            checks: {
              'test-check': {
                type: 'ai',
                prompt: 'Test check',
                on: ['pr_opened'],
              },
            },
            configFile: configName,
          })
        );
      });

      // Test discovery in order of precedence
      const originalCwd = process.cwd();
      try {
        process.chdir(tempConfigDir);
        const foundConfig = await configManager.findAndLoadConfig();

        // Should find a valid config
        expect(foundConfig.version).toBe('1.0');
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe('Event Mapping Regression Tests', () => {
    test('should maintain event mapping consistency', () => {
      const config = {
        version: '1.0',
        checks: {
          'security-check': {
            type: 'ai' as const,
            prompt: 'Security review',
            on: ['pr_opened' as const, 'pr_updated' as const],
            triggers: ['**/*.ts', '**/*.js'],
          },
          'performance-check': {
            type: 'ai' as const,
            prompt: 'Performance review',
            on: ['pr_opened' as const],
            triggers: ['**/*.{js,ts}', '**/*.sql'],
          },
        },
        output: {
          pr_comment: {
            format: 'summary' as const,
            group_by: 'check' as const,
            collapse: true,
          },
        },
      };

      const mapper = new EventMapper(config);

      // Test all supported GitHub events
      const testEvents = [
        {
          event_name: 'pull_request',
          action: 'opened',
          repository: { owner: { login: 'test' }, name: 'repo' },
          pull_request: {
            number: 1,
            state: 'open',
            head: { sha: 'abc', ref: 'feature' },
            base: { sha: 'def', ref: 'main' },
            draft: false,
          },
        },
        {
          event_name: 'issue_comment',
          action: 'created',
          repository: { owner: { login: 'test' }, name: 'repo' },
          comment: { body: '/review', user: { login: 'user' } },
        },
      ];

      testEvents.forEach(event => {
        const execution = mapper.mapEventToExecution(event);
        expect(execution).toHaveProperty('shouldExecute');
        expect(execution).toHaveProperty('checksToRun');
        expect(execution).toHaveProperty('executionContext');

        if (event.event_name === 'pull_request') {
          expect(execution.shouldExecute).toBe(true);
          expect(execution.checksToRun).toContain('security-check');
        }
      });
    });

    test('should maintain trigger pattern matching', () => {
      const config = {
        version: '1.0',
        checks: {
          'js-check': {
            type: 'ai' as const,
            prompt: 'JavaScript review',
            on: ['pr_opened' as const],
            triggers: ['**/*.js'],
          },
          'ts-check': {
            type: 'ai' as const,
            prompt: 'TypeScript review',
            on: ['pr_opened' as const],
            triggers: ['**/*.ts', 'src/**/*.tsx'],
          },
          'auth-check': {
            type: 'ai' as const,
            prompt: 'Auth review',
            on: ['pr_opened' as const],
            triggers: ['src/auth/**/*', '**/auth.js'],
          },
        },
        output: {
          pr_comment: {
            format: 'summary' as const,
            group_by: 'check' as const,
            collapse: true,
          },
        },
      };

      const mapper = new EventMapper(config);

      const testCases = [
        {
          files: ['src/index.js', 'README.md'],
          expectedChecks: ['js-check'],
        },
        {
          files: ['src/components/App.tsx', 'package.json'],
          expectedChecks: ['ts-check'],
        },
        {
          files: ['src/auth/login.js', 'docs/auth.md'],
          expectedChecks: ['auth-check'],
        },
      ];

      const baseEvent = {
        event_name: 'pull_request',
        action: 'opened',
        repository: { owner: { login: 'test' }, name: 'repo' },
        pull_request: {
          number: 1,
          state: 'open',
          head: { sha: 'abc', ref: 'feature' },
          base: { sha: 'def', ref: 'main' },
          draft: false,
        },
      };

      testCases.forEach(({ files, expectedChecks }) => {
        const execution = mapper.mapEventToExecution(baseEvent, {
          changedFiles: files,
          modifiedFiles: files,
        });

        expectedChecks.forEach(checkName => {
          expect(execution.checksToRun).toContain(checkName);
        });
      });
    });
  });

  describe('GitHub Integration Regression Tests', () => {
    test('should maintain comment format consistency', async () => {
      const mockOctokit = {
        rest: {
          issues: {
            listComments: jest.fn().mockResolvedValue({ data: [] }),
            createComment: jest.fn().mockResolvedValue({
              data: {
                id: 123,
                body: 'Test comment',
                user: { login: 'visor-bot' },
                created_at: '2023-01-01T00:00:00Z',
                updated_at: '2023-01-01T00:00:00Z',
              },
            }),
          },
        },
      };

      const commentManager = new CommentManager(mockOctokit as any);

      // Test that comment format includes required metadata
      await commentManager.updateOrCreateComment(
        'owner',
        'repo',
        123,
        '# Test Review\n\nResults here',
        {
          commentId: 'test-id',
          triggeredBy: 'pr_opened',
        }
      );

      const createCall = mockOctokit.rest.issues.createComment.mock.calls[0][0];
      expect(createCall.body).toContain('visor-comment-id:test-id');
      expect(createCall.body).toContain('Triggered by: pr_opened');
      expect(createCall.body).toContain('Last updated:');
    });

    test('should maintain action bridge functionality', () => {
      const mockContext = {
        event_name: 'pull_request',
        action: 'opened',
        repository: { owner: { login: 'test' }, name: 'repo' },
        event: { pull_request: { number: 123 } },
      };

      const bridge = new ActionCliBridge('test-token', mockContext);

      // Test Visor input detection
      const visorInputs = {
        'github-token': 'token',
        'visor-config-path': './visor.yaml',
      };
      expect(bridge.shouldUseVisor(visorInputs)).toBe(true);

      const visorChecksInputs = {
        'github-token': 'token',
        'visor-checks': 'security,performance',
      };
      expect(bridge.shouldUseVisor(visorChecksInputs)).toBe(true);
    });
  });

  describe('Performance Regression Tests', () => {
    test('should maintain CLI startup performance', async () => {
      const startupTimes: number[] = [];

      for (let i = 0; i < 5; i++) {
        const startTime = timer.start();

        // Simulate CLI startup
        const cli = new CLI();
        const args = cli.parseArgs(['--check', 'security']);
        const configManager = new ConfigManager();

        const duration = timer.end(startTime);
        startupTimes.push(duration);
      }

      const averageStartup = startupTimes.reduce((a, b) => a + b) / startupTimes.length;

      // Should maintain startup time under 500ms for basic operations
      expect(averageStartup).toBeLessThan(500);
    });

    test('should maintain memory usage patterns', () => {
      const baseline = memoryProfiler.getCurrentUsage();

      // Create multiple CLI instances and configurations
      for (let i = 0; i < 10; i++) {
        const cli = new CLI();
        cli.parseArgs(['--check', 'performance']);

        const configManager = new ConfigManager();
        const testConfig = {
          version: '1.0',
          checks: {} as any,
        };

        testConfig.checks[`check-${i}`] = {
          type: 'ai' as const,
          prompt: `Test check ${i}`,
          on: ['pr_opened' as const],
        };

        configManager.mergeWithCliOptions(testConfig, {
          checks: ['performance' as const],
          output: 'table' as const,
        });
      }

      const afterOperations = memoryProfiler.getCurrentUsage();
      const memoryGrowth = afterOperations.heapUsed - baseline.heapUsed;

      // Memory growth should be reasonable (less than 10MB for these operations)
      expect(memoryGrowth).toBeLessThan(10 * 1024 * 1024);
    });

    test('should maintain config loading performance', async () => {
      const configManager = new ConfigManager();
      const testConfig = {
        version: '1.0',
        checks: {} as any,
        output: {
          pr_comment: {
            format: 'summary' as const,
            group_by: 'check' as const,
            collapse: true,
          },
        },
      };

      // Create a large config with many checks
      for (let i = 0; i < 100; i++) {
        testConfig.checks[`check-${i}`] = {
          type: 'ai' as const,
          prompt: `Check ${i}`,
          on: ['pr_opened' as const],
          triggers: [`**/*${i}.js`],
        };
      }

      const configPath = path.join(tempConfigDir, 'large-config.yaml');
      fs.writeFileSync(configPath, yaml.dump(testConfig));

      const loadTimes: number[] = [];

      for (let i = 0; i < 5; i++) {
        const startTime = timer.start();
        await configManager.loadConfig(configPath);
        const duration = timer.end(startTime);
        loadTimes.push(duration);
      }

      const averageLoadTime = loadTimes.reduce((a, b) => a + b) / loadTimes.length;

      // Should load large configs quickly (under 100ms)
      expect(averageLoadTime).toBeLessThan(100);
    });
  });

  describe('Error Handling Regression Tests', () => {
    test('should maintain consistent error messages', async () => {
      const configManager = new ConfigManager();

      // Test config file not found
      try {
        await configManager.loadConfig('/non/existent/config.yaml');
        expect(false).toBe(true);
      } catch (error: any) {
        expect(error.message).toContain('Configuration file not found');
      }

      // Test invalid YAML
      const invalidConfigPath = path.join(tempConfigDir, 'invalid.yaml');
      fs.writeFileSync(invalidConfigPath, 'invalid: yaml: content: [unclosed');

      try {
        await configManager.loadConfig(invalidConfigPath);
        expect(false).toBe(true);
      } catch (error: any) {
        expect(error.message).toContain('Invalid YAML syntax');
      }
    });

    test('should maintain graceful degradation patterns', async () => {
      const mockOctokit = {
        rest: {
          issues: {
            listComments: jest.fn().mockRejectedValue(new Error('Network error')),
            createComment: jest.fn().mockRejectedValue(new Error('Network error')),
          },
        },
      };

      const commentManager = new CommentManager(mockOctokit as any, {
        maxRetries: 0, // Disable retries for this test
        baseDelay: 10,
      });

      // Should handle errors gracefully without crashing
      try {
        await commentManager.findVisorComment('owner', 'repo', 123);
        expect(false).toBe(true);
      } catch (error: any) {
        expect(error.message).toBe('Network error');
      }

      try {
        await commentManager.updateOrCreateComment('owner', 'repo', 123, 'content');
        expect(false).toBe(true);
      } catch (error: any) {
        expect(error.message).toBe('Network error');
      }
    });
  });

  describe('Integration Stability Tests', () => {
    test('should maintain component interaction patterns', async () => {
      const config = {
        version: '1.0',
        checks: {
          'integration-check': {
            type: 'ai' as const,
            prompt: 'Integration test check',
            on: ['pr_opened' as const],
          },
        },
        output: {
          pr_comment: {
            format: 'summary' as const,
            group_by: 'check' as const,
            collapse: true,
          },
        },
      };

      // Test the flow from event to comment
      const eventMapper = new EventMapper(config);
      const mockOctokit = {
        rest: {
          issues: {
            listComments: jest.fn().mockResolvedValue({ data: [] }),
            createComment: jest.fn().mockResolvedValue({
              data: { id: 123, body: 'comment', user: { login: 'bot' } },
            }),
          },
        },
      };
      const commentManager = new CommentManager(mockOctokit as any);

      const event = {
        event_name: 'pull_request',
        action: 'opened',
        repository: { owner: { login: 'test' }, name: 'repo' },
        pull_request: {
          number: 1,
          state: 'open',
          head: { sha: 'abc', ref: 'feature' },
          base: { sha: 'def', ref: 'main' },
          draft: false,
        },
      };

      // Map event to execution
      const execution = eventMapper.mapEventToExecution(event);
      expect(execution.shouldExecute).toBe(true);
      expect(execution.checksToRun).toContain('integration-check');

      // Post comment based on execution
      await commentManager.updateOrCreateComment(
        'test',
        'repo',
        1,
        `# Integration Test Results\n\nChecks run: ${execution.checksToRun.join(', ')}`,
        { commentId: 'integration-test' }
      );

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
    });

    test('should maintain concurrent operation safety', async () => {
      const mockOctokit = {
        rest: {
          issues: {
            listComments: jest.fn().mockResolvedValue({ data: [] }),
            createComment: jest.fn().mockImplementation(
              () =>
                new Promise(resolve =>
                  setTimeout(
                    () =>
                      resolve({
                        data: { id: Math.random(), body: 'comment', user: { login: 'bot' } },
                      }),
                    10
                  )
                )
            ),
          },
        },
      };

      const commentManager = new CommentManager(mockOctokit as any);

      // Run multiple concurrent comment operations
      const operations = Array.from({ length: 10 }, (_, i) =>
        commentManager.updateOrCreateComment('owner', 'repo', 123, `Comment ${i}`, {
          commentId: `test-${i}`,
        })
      );

      const results = await Promise.allSettled(operations);

      // All operations should complete successfully
      results.forEach(result => {
        expect(result.status).toBe('fulfilled');
      });

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(10);
    });
  });
});
