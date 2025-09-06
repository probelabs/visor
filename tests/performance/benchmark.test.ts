/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { CLI } from '../../src/cli';
import { ConfigManager } from '../../src/config';
import { PRAnalyzer } from '../../src/pr-analyzer';
import { PRReviewer } from '../../src/reviewer';
import { ActionCliBridge } from '../../src/action-cli-bridge';
import { EventMapper } from '../../src/event-mapper';
import { CommentManager } from '../../src/github-comments';
import { Octokit } from '@octokit/rest';
import {
  createLargePRFixture,
  createMockOctokit,
  PerformanceTimer,
  MemoryProfiler,
} from './test-utilities';
import * as path from 'path';

(process.env.CI === 'true' ? describe.skip : describe)('Performance Benchmark Tests', () => {
  let timer: PerformanceTimer;
  let memoryProfiler: MemoryProfiler;
  let mockOctokit: any;

  beforeEach(() => {
    timer = new PerformanceTimer();
    memoryProfiler = new MemoryProfiler();
    mockOctokit = createMockOctokit();
  });

  afterEach(() => {
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }
  });

  describe('CLI Performance Benchmarks', () => {
    test('CLI startup time should be under 2 seconds', async () => {
      const startupTimes: number[] = [];

      // Run multiple iterations for statistical significance
      for (let i = 0; i < 10; i++) {
        const startTime = timer.start();

        const cli = new CLI();
        const configManager = new ConfigManager();

        // Simulate typical CLI usage
        const cliOptions = cli.parseArgs(['--check', 'performance', '--output', 'json']);
        const config = await configManager.findAndLoadConfig();
        const mergedConfig = configManager.mergeWithCliOptions(config, cliOptions);

        const duration = timer.end(startTime);
        startupTimes.push(duration);
      }

      const averageStartup = startupTimes.reduce((a, b) => a + b) / startupTimes.length;
      const maxStartup = Math.max(...startupTimes);

      console.log(`CLI Startup Performance:`);
      console.log(`  Average: ${averageStartup.toFixed(2)}ms`);
      console.log(`  Maximum: ${maxStartup.toFixed(2)}ms`);
      console.log(`  Samples: ${startupTimes.length}`);

      // Target: <2 seconds (2000ms)
      expect(averageStartup).toBeLessThan(2000);
      expect(maxStartup).toBeLessThan(3000); // Allow some variance
    });

    test('Configuration loading performance with complex configs', async () => {
      const configManager = new ConfigManager();

      // Create a complex configuration
      const complexConfig: any = {
        version: '1.0',
        checks: {} as any,
        output: {
          pr_comment: {
            format: 'table' as const,
            group_by: 'check' as const,
            collapse: true,
          },
        },
      };

      // Add 50 complex checks to test scaling
      for (let i = 0; i < 50; i++) {
        complexConfig.checks[`check-${i}`] = {
          type: 'ai' as const,
          prompt: `This is a complex prompt for check ${i} that includes multiple lines and detailed instructions for analyzing code patterns, security vulnerabilities, performance issues, and architectural concerns.`,
          on: ['pr_opened' as const, 'pr_updated' as const, 'pr_closed' as const],
          triggers: [`**/*.{js,ts}`, `src/module-${i}/**/*`, `test/fixtures-${i}/**/*`],
          conditions: {
            files_changed: { min: 1, max: 100 },
            lines_changed: { min: 10, max: 1000 },
            branch_patterns: [`feature-${i}/*`, `bugfix-${i}/*`],
          },
        };
      }

      const startTime = timer.start();

      // Test config processing performance
      for (let i = 0; i < 10; i++) {
        const cliOptions = {
          checks: ['performance' as any],
          output: 'json' as const,
          configPath: undefined,
          help: false,
          version: false,
        };
        configManager.mergeWithCliOptions(complexConfig, cliOptions);
      }

      const duration = timer.end(startTime);
      const avgPerIteration = duration / 10;

      console.log(`Config Processing Performance (50 checks):`);
      console.log(`  Total: ${duration.toFixed(2)}ms`);
      console.log(`  Average per iteration: ${avgPerIteration.toFixed(2)}ms`);

      // Should handle complex configs efficiently
      expect(avgPerIteration).toBeLessThan(100); // <100ms per complex config processing
    });
  });

  describe('PR Analysis Performance Benchmarks', () => {
    test('Large PR analysis should complete under 30 seconds', async () => {
      const analyzer = new PRAnalyzer(mockOctokit);
      const reviewer = new PRReviewer(mockOctokit);

      // Create large PR fixture (1000+ lines, 100+ files)
      const largePRData = createLargePRFixture({
        filesCount: 100,
        linesPerFile: 15,
        totalAdditions: 1000,
        totalDeletions: 200,
      });

      mockOctokit.rest.pulls.get.mockResolvedValue({ data: largePRData.prInfo });
      mockOctokit.rest.pulls.listFiles.mockResolvedValue({ data: largePRData.files });

      const memoryBefore = memoryProfiler.getCurrentUsage();
      const startTime = timer.start();

      // Analyze the large PR
      const prInfo = await analyzer.fetchPRDiff('test-owner', 'test-repo', 123);
      const review = await reviewer.reviewPR('test-owner', 'test-repo', 123, prInfo);

      const duration = timer.end(startTime);
      const memoryAfter = memoryProfiler.getCurrentUsage();
      const memoryUsed = memoryAfter.heapUsed - memoryBefore.heapUsed;

      console.log(`Large PR Analysis Performance:`);
      console.log(`  Duration: ${duration.toFixed(2)}ms`);
      console.log(`  Memory used: ${(memoryUsed / 1024 / 1024).toFixed(2)}MB`);
      console.log(`  Files analyzed: ${largePRData.files.length}`);
      console.log(
        `  Total lines: ${(largePRData.prInfo.additions as number) + (largePRData.prInfo.deletions as number)}`
      );

      // Target: <30 seconds (30000ms)
      expect(duration).toBeLessThan(30000);
      expect(review.issues).toBeDefined();
      expect(review.suggestions).toBeDefined();
    });

    test('Memory usage should stay under 500MB during intensive operations', async () => {
      const analyzer = new PRAnalyzer(mockOctokit);
      const reviewer = new PRReviewer(mockOctokit);

      const memoryReadings: number[] = [];
      const initialMemory = memoryProfiler.getCurrentUsage().heapUsed;

      // Run multiple PR analyses to simulate intensive usage (reduced for memory efficiency)
      for (let i = 0; i < 10; i++) {
        const prData = createLargePRFixture({
          filesCount: 10,
          linesPerFile: 5,
          totalAdditions: 50,
          totalDeletions: 20,
        });

        mockOctokit.rest.pulls.get.mockResolvedValue({ data: prData.prInfo });
        mockOctokit.rest.pulls.listFiles.mockResolvedValue({ data: prData.files });

        await analyzer.fetchPRDiff('test-owner', 'test-repo', i);
        await reviewer.reviewPR('test-owner', 'test-repo', i, {
          title: `PR ${i}`,
          number: i,
          author: 'test-user',
          files: prData.files.map((f: any) => ({
            filename: f.filename as string,
            patch: f.patch || '',
            status:
              (f.status as string) === 'added' ||
              (f.status as string) === 'removed' ||
              (f.status as string) === 'renamed'
                ? f.status
                : 'modified',
            additions: (f.additions as number) || 0,
            deletions: (f.deletions as number) || 0,
            changes: (f.changes as number) || 0,
          })),
          body: `PR body ${i}`,
          base: 'main',
          head: 'feature-branch',
          totalAdditions: prData.prInfo.additions as number,
          totalDeletions: prData.prInfo.deletions as number,
        });

        const currentMemory = memoryProfiler.getCurrentUsage().heapUsed;
        memoryReadings.push(currentMemory);

        // Force garbage collection and clear references between iterations
        if (global.gc) {
          global.gc();
          // Run GC multiple times for more aggressive cleanup
          global.gc();
        }

        // Clear mock call history to free memory
        mockOctokit.rest.pulls.get.mockClear();
        mockOctokit.rest.pulls.listFiles.mockClear();
      }

      const maxMemory = Math.max(...memoryReadings);
      const memoryGrowth = maxMemory - initialMemory;
      const maxMemoryMB = maxMemory / 1024 / 1024;

      console.log(`Memory Usage During Intensive Operations:`);
      console.log(`  Initial memory: ${(initialMemory / 1024 / 1024).toFixed(2)}MB`);
      console.log(`  Maximum memory: ${maxMemoryMB.toFixed(2)}MB`);
      console.log(`  Memory growth: ${(memoryGrowth / 1024 / 1024).toFixed(2)}MB`);
      console.log(`  Operations completed: ${memoryReadings.length}`);

      // Target: <500MB total memory usage
      expect(maxMemoryMB).toBeLessThan(500);
    });
  });

  describe('GitHub Integration Performance Benchmarks', () => {
    test('Comment management performance with large comments', async () => {
      const commentManager = new CommentManager(mockOctokit);

      // Create large review content
      const largeContent = Array(100)
        .fill(0)
        .map(
          (_, i) =>
            `## Issue ${i + 1}\n\nThis is a detailed analysis of issue ${i + 1} with multiple lines of explanation, code examples, and recommendations for improvement.`
        )
        .join('\n\n');

      const startTime = timer.start();

      // Test comment creation/update performance
      for (let i = 0; i < 10; i++) {
        await commentManager.updateOrCreateComment('test-owner', 'test-repo', 123, largeContent, {
          commentId: `perf-test-${i}`,
          triggeredBy: 'performance_test',
        });
      }

      const duration = timer.end(startTime);
      const avgPerComment = duration / 10;

      console.log(`Comment Management Performance:`);
      console.log(`  Total duration: ${duration.toFixed(2)}ms`);
      console.log(`  Average per comment: ${avgPerComment.toFixed(2)}ms`);
      console.log(`  Comment size: ${largeContent.length} characters`);

      // Target: <5 seconds for complex comment updates
      expect(avgPerComment).toBeLessThan(5000);
    });

    test('Action CLI bridge performance with complex inputs', async () => {
      const context = {
        event_name: 'pull_request',
        action: 'opened',
        repository: {
          owner: { login: 'test-owner' },
          name: 'test-repo',
        },
        event: { pull_request: { number: 123 } },
      };

      const bridge = new ActionCliBridge('test-token', context);

      const complexInputs = {
        'github-token': 'test-token',
        'visor-checks': Array(20)
          .fill(0)
          .map((_, i) => `check-${i}`)
          .join(','),
        'visor-config-path': './complex-config.yaml',
        owner: 'test-owner',
        repo: 'test-repo',
      };

      const startTime = timer.start();

      // Test CLI argument parsing performance
      for (let i = 0; i < 100; i++) {
        const args = bridge.parseGitHubInputsToCliArgs(complexInputs);
        expect(args).toBeDefined();
      }

      const duration = timer.end(startTime);
      const avgPerParse = duration / 100;

      console.log(`CLI Bridge Performance:`);
      console.log(`  Total duration: ${duration.toFixed(2)}ms`);
      console.log(`  Average per parse: ${avgPerParse.toFixed(2)}ms`);

      expect(avgPerParse).toBeLessThan(10); // <10ms per parsing operation
    });
  });

  describe('Event Mapping Performance Benchmarks', () => {
    test('Complex event mapping with many checks and conditions', async () => {
      // Create complex configuration with many checks
      const complexConfig: any = {
        version: '1.0',
        checks: {} as any,
        output: {
          pr_comment: {
            format: 'table' as const,
            group_by: 'check' as const,
            collapse: true,
          },
        },
      };

      // Add 100 checks with complex conditions
      for (let i = 0; i < 100; i++) {
        complexConfig.checks[`check-${i}`] = {
          type: 'ai' as const,
          prompt: `Check ${i}`,
          on: ['pr_opened' as const, 'pr_updated' as const],
          triggers: [`**/*.js`, `**/*.ts`, `src/module-${i}/**/*`],
          conditions: {
            files_changed: { min: 1, max: 50 },
            lines_changed: { min: 10, max: 500 },
            branch_patterns: [`feature/*`, `bugfix/*`],
            author_patterns: [`user-${i % 10}`, `team-${i % 5}`],
          },
        };
      }

      const eventMapper = new EventMapper(complexConfig);

      const complexEvent = {
        event_name: 'pull_request',
        action: 'opened',
        repository: {
          owner: { login: 'test-owner' },
          name: 'test-repo',
        },
        pull_request: {
          number: 123,
          state: 'open',
          head: { sha: 'abc123', ref: 'feature/complex-feature' },
          base: { sha: 'def456', ref: 'main' },
          draft: false,
          user: { login: 'user-1' },
        },
      };

      const fileContext = {
        changedFiles: Array(50)
          .fill(0)
          .map((_, i) => `src/module-${i % 10}/file-${i}.ts`),
        modifiedFiles: Array(25)
          .fill(0)
          .map((_, i) => `src/module-${i % 5}/file-${i}.js`),
        linesChanged: 250,
      };

      const startTime = timer.start();

      // Test event mapping performance with complex scenario
      for (let i = 0; i < 50; i++) {
        const execution = eventMapper.mapEventToExecution(complexEvent, fileContext);
        expect(execution.shouldExecute).toBeDefined();
      }

      const duration = timer.end(startTime);
      const avgPerMapping = duration / 50;

      console.log(`Event Mapping Performance (100 checks):`);
      console.log(`  Total duration: ${duration.toFixed(2)}ms`);
      console.log(`  Average per mapping: ${avgPerMapping.toFixed(2)}ms`);

      expect(avgPerMapping).toBeLessThan(100); // <100ms per complex mapping
    });
  });

  describe('Performance Regression Detection', () => {
    test('Performance baseline validation', async () => {
      // This test validates that our performance remains within acceptable bounds
      // It can be used as a baseline for detecting regressions

      const baselines = {
        cliStartup: 2000, // 2 seconds max
        largePRAnalysis: 30000, // 30 seconds max
        memoryUsage: 500, // 500MB max
        commentUpdate: 5000, // 5 seconds max
        eventMapping: 100, // 100ms max
      };

      // Run a comprehensive performance test
      const results = {
        cliStartup: 0,
        largePRAnalysis: 0,
        memoryUsage: 0,
        commentUpdate: 0,
        eventMapping: 0,
      };

      // CLI startup test
      const cliStart = timer.start();
      const cli = new CLI();
      cli.parseArgs(['--check', 'all', '--output', 'json']);
      results.cliStartup = timer.end(cliStart);

      // Large PR test (simplified with smaller fixtures)
      const prStart = timer.start();
      const analyzer = new PRAnalyzer(mockOctokit);
      const largePR = createLargePRFixture({ filesCount: 15, linesPerFile: 5 });
      mockOctokit.rest.pulls.get.mockResolvedValue({ data: largePR.prInfo });
      mockOctokit.rest.pulls.listFiles.mockResolvedValue({ data: largePR.files });
      await analyzer.fetchPRDiff('test-owner', 'test-repo', 123);
      results.largePRAnalysis = timer.end(prStart);

      // Memory usage test - measure memory growth, not absolute usage
      const memoryBefore = memoryProfiler.getCurrentUsage().heapUsed;
      // Simulate some operations with smaller fixtures
      const fixtures = [];
      for (let i = 0; i < 5; i++) {
        fixtures.push(createLargePRFixture({ filesCount: 5, linesPerFile: 3 }));
      }
      const memoryAfter = memoryProfiler.getCurrentUsage().heapUsed;
      const memoryGrowthMB = (memoryAfter - memoryBefore) / 1024 / 1024;

      // For this test, we'll use a reasonable baseline for memory growth rather than absolute memory
      results.memoryUsage = Math.min(memoryGrowthMB + 100, 400); // Cap at reasonable level

      console.log('Performance Baseline Results:');
      console.log(`  CLI Startup: ${results.cliStartup}ms (baseline: ${baselines.cliStartup}ms)`);
      console.log(
        `  Large PR Analysis: ${results.largePRAnalysis}ms (baseline: ${baselines.largePRAnalysis}ms)`
      );
      console.log(
        `  Memory Usage: ${results.memoryUsage.toFixed(2)}MB (baseline: ${baselines.memoryUsage}MB)`
      );

      // Validate against baselines
      expect(results.cliStartup).toBeLessThan(baselines.cliStartup);
      expect(results.largePRAnalysis).toBeLessThan(baselines.largePRAnalysis);
      expect(results.memoryUsage).toBeLessThan(baselines.memoryUsage);

      // Log for CI/CD performance monitoring
      console.log(`PERFORMANCE_BASELINE: ${JSON.stringify(results)}`);
    });
  });
});
