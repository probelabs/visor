/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { CLI } from '../../src/cli';
import { ConfigManager } from '../../src/config';
import { PRAnalyzer } from '../../src/pr-analyzer';
import { PRReviewer } from '../../src/reviewer';
import { CommentManager } from '../../src/github-comments';
import { EventMapper } from '../../src/event-mapper';
import {
  PerformanceTimer,
  MemoryProfiler,
  LoadTester,
  createLargePRFixture,
  createMockOctokit,
} from '../performance/test-utilities';

(process.env.CI === 'true' ? describe.skip : describe)('Stress Testing Framework', () => {
  let timer: PerformanceTimer;
  let memoryProfiler: MemoryProfiler;
  let mockOctokit: any;

  // Increase timeout for stress tests
  jest.setTimeout(300000); // 5 minutes

  beforeEach(() => {
    timer = new PerformanceTimer();
    memoryProfiler = new MemoryProfiler();
    mockOctokit = createMockOctokit();

    // Force garbage collection before each test
    if (global.gc) {
      global.gc();
    }
  });

  afterEach(async () => {
    // Cleanup and force GC after each test
    if (global.gc) {
      global.gc();
      // Wait a bit for cleanup
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  });

  describe('Concurrent Operations Stress Tests', () => {
    test('should handle 10+ concurrent PR analysis operations', async () => {
      const analyzer = new PRAnalyzer(mockOctokit);
      const reviewer = new PRReviewer(mockOctokit);
      const concurrency = 12;
      const totalOperations = 50;

      console.log(
        `Starting concurrent stress test: ${concurrency} concurrent operations, ${totalOperations} total`
      );

      // Setup mock responses for all operations
      const largePRData = createLargePRFixture({
        filesCount: 25,
        linesPerFile: 20,
        totalAdditions: 300,
        totalDeletions: 50,
      });

      mockOctokit.rest.pulls.get.mockResolvedValue({ data: largePRData.prInfo });
      mockOctokit.rest.pulls.listFiles.mockResolvedValue({ data: largePRData.files });

      let successfulOperations = 0;
      let failedOperations = 0;

      const operationFactory = async () => {
        try {
          const prNumber = Math.floor(Math.random() * 10000);
          const prInfo = await analyzer.fetchPRDiff('test-owner', 'test-repo', prNumber);
          const review = await reviewer.reviewPR('test-owner', 'test-repo', prNumber, prInfo);

          successfulOperations++;
          return { success: true, review, prInfo };
        } catch (error) {
          failedOperations++;
          console.error(`Operation failed:`, error);
          return { success: false, error };
        }
      };

      const memoryBefore = memoryProfiler.getCurrentUsage();

      const results = await LoadTester.measureConcurrentOperations(
        operationFactory,
        concurrency,
        totalOperations,
        timer
      );

      const memoryAfter = memoryProfiler.getCurrentUsage();
      const memoryGrowth = memoryAfter.heapUsed - memoryBefore.heapUsed;

      console.log(`Concurrent Operations Stress Test Results:`);
      console.log(`  Total operations: ${totalOperations}`);
      console.log(`  Successful: ${successfulOperations}`);
      console.log(`  Failed: ${failedOperations}`);
      console.log(
        `  Success rate: ${((successfulOperations / totalOperations) * 100).toFixed(2)}%`
      );
      console.log(`  Total duration: ${results.totalDuration.toFixed(2)}ms`);
      console.log(`  Operations per second: ${results.operationsPerSecond.toFixed(2)}`);
      console.log(`  Memory growth: ${(memoryGrowth / 1024 / 1024).toFixed(2)}MB`);

      // Stress test success criteria
      expect(successfulOperations).toBeGreaterThanOrEqual(totalOperations * 0.95); // 95% success rate
      expect(results.totalDuration).toBeLessThan(60000); // Complete within 60 seconds
      expect(memoryGrowth / 1024 / 1024).toBeLessThan(100); // Memory growth <100MB
    });

    test('should handle rapid comment updates without race conditions', async () => {
      const commentManager = new CommentManager(mockOctokit, {
        maxRetries: 3,
        baseDelay: 50,
      });

      const prNumber = 123;
      const commentId = 'stress-test-comment';
      const totalUpdates = 25;
      const concurrency = 8;

      console.log(
        `Testing rapid comment updates: ${concurrency} concurrent, ${totalUpdates} total`
      );

      // Track comment update order to detect race conditions
      const updateOrder: number[] = [];
      const updatePromises: Promise<any>[] = [];

      for (let i = 0; i < totalUpdates; i++) {
        const updatePromise = commentManager
          .updateOrCreateComment(
            'test-owner',
            'test-repo',
            prNumber,
            `Update #${i} - Timestamp: ${Date.now()} - Random: ${Math.random()}`,
            {
              commentId: `${commentId}-${i % concurrency}`, // Use multiple comment IDs to simulate concurrency
              triggeredBy: `stress_test_${i}`,
              allowConcurrentUpdates: true, // Allow concurrent updates for this test
            }
          )
          .then(result => {
            updateOrder.push(i);
            return result;
          });

        updatePromises.push(updatePromise);

        // Stagger the requests slightly to create realistic load
        if (i % concurrency === 0) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }

      const startTime = timer.start();
      const results = await Promise.allSettled(updatePromises);
      const duration = timer.end(startTime);

      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      console.log(`Comment Update Stress Test Results:`);
      console.log(`  Total updates: ${totalUpdates}`);
      console.log(`  Successful: ${successful}`);
      console.log(`  Failed: ${failed}`);
      console.log(`  Duration: ${duration.toFixed(2)}ms`);
      console.log(`  Updates per second: ${((totalUpdates * 1000) / duration).toFixed(2)}`);
      console.log(`  Update order length: ${updateOrder.length}`);

      // Validate no complete failures and reasonable performance
      expect(successful).toBeGreaterThanOrEqual(totalUpdates * 0.9); // 90% success rate
      expect(duration).toBeLessThan(30000); // Complete within 30 seconds
      expect(updateOrder.length).toBeGreaterThanOrEqual(totalUpdates * 0.9);
    });
  });

  describe('Memory Pressure Stress Tests', () => {
    test('should handle memory pressure gracefully', async () => {
      const analyzer = new PRAnalyzer(mockOctokit);
      const reviewer = new PRReviewer(mockOctokit);

      console.log('Testing memory pressure handling...');

      // Create progressively larger PRs to increase memory pressure
      const memoryReadings: number[] = [];
      const processingTimes: number[] = [];

      for (let size = 50; size <= 500; size += 50) {
        const largePR = createLargePRFixture({
          filesCount: size,
          linesPerFile: 25,
          totalAdditions: size * 20,
          totalDeletions: size * 5,
        });

        mockOctokit.rest.pulls.get.mockResolvedValue({ data: largePR.prInfo });
        mockOctokit.rest.pulls.listFiles.mockResolvedValue({ data: largePR.files });

        const _memoryBefore = memoryProfiler.getCurrentUsage().heapUsed;
        const startTime = timer.start();

        try {
          const prInfo = await analyzer.fetchPRDiff('test-owner', 'test-repo', size);
          const _review = await reviewer.reviewPR('test-owner', 'test-repo', size, prInfo);

          const duration = timer.end(startTime);
          const memoryAfter = memoryProfiler.getCurrentUsage().heapUsed;

          processingTimes.push(duration);
          memoryReadings.push(memoryAfter / 1024 / 1024); // Convert to MB

          console.log(
            `  PR size ${size}: ${duration.toFixed(2)}ms, Memory: ${(memoryAfter / 1024 / 1024).toFixed(2)}MB`
          );

          // Force garbage collection between iterations
          if (global.gc) {
            global.gc();
          }

          // Check if memory usage is getting excessive
          const currentMemoryMB = memoryAfter / 1024 / 1024;
          if (currentMemoryMB > 750) {
            // 750MB threshold
            console.log(
              `Memory usage getting high (${currentMemoryMB.toFixed(2)}MB), testing graceful degradation...`
            );
            break;
          }
        } catch (error) {
          console.log(`Memory pressure test failed at size ${size}:`, error);
          break;
        }
      }

      const maxMemory = Math.max(...memoryReadings);
      const avgProcessingTime = processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length;
      const maxProcessingTime = Math.max(...processingTimes);

      console.log(`Memory Pressure Test Results:`);
      console.log(`  Iterations completed: ${memoryReadings.length}`);
      console.log(`  Maximum memory: ${maxMemory.toFixed(2)}MB`);
      console.log(`  Average processing time: ${avgProcessingTime.toFixed(2)}ms`);
      console.log(`  Maximum processing time: ${maxProcessingTime.toFixed(2)}ms`);

      // Should handle reasonable memory pressure
      expect(memoryReadings.length).toBeGreaterThanOrEqual(3); // Complete at least 3 iterations
      expect(maxMemory).toBeLessThan(800); // Stay under 800MB
      expect(avgProcessingTime).toBeLessThan(5000); // Average processing <5 seconds
    });

    test('should detect and handle memory leaks during extended operations', async () => {
      console.log('Testing memory leak detection during extended operations...');

      const cli = new CLI();
      const configManager = new ConfigManager();

      // Baseline memory measurement
      if (global.gc) global.gc();
      await new Promise(resolve => setTimeout(resolve, 100));

      const baselineMemory = memoryProfiler.getCurrentUsage().heapUsed;
      const memoryReadings: number[] = [baselineMemory];

      // Perform many CLI operations to detect leaks
      for (let i = 0; i < 100; i++) {
        // Simulate various CLI operations
        cli.parseArgs(['--check', 'performance', '--output', 'json']);
        cli.parseArgs(['--check', 'security', '--check', 'style', '--output', 'table']);

        const config = await configManager.findAndLoadConfig();
        configManager.mergeWithCliOptions(config, {
          checks: ['performance' as any],
          output: 'json' as const,
          configPath: undefined,
          help: false,
          version: false,
        });

        // Take memory readings every 10 operations
        if (i % 10 === 0) {
          // Force garbage collection before measurement
          if (global.gc) global.gc();
          await new Promise(resolve => setTimeout(resolve, 50));

          const currentMemory = memoryProfiler.getCurrentUsage().heapUsed;
          memoryReadings.push(currentMemory);

          const growthMB = (currentMemory - baselineMemory) / 1024 / 1024;
          console.log(`  Iteration ${i}: Memory growth ${growthMB.toFixed(2)}MB`);
        }
      }

      const finalMemory = memoryReadings[memoryReadings.length - 1];
      const totalGrowth = (finalMemory - baselineMemory) / 1024 / 1024;
      const growthPerOperation = totalGrowth / 100;

      console.log(`Memory Leak Detection Results:`);
      console.log(`  Baseline memory: ${(baselineMemory / 1024 / 1024).toFixed(2)}MB`);
      console.log(`  Final memory: ${(finalMemory / 1024 / 1024).toFixed(2)}MB`);
      console.log(`  Total growth: ${totalGrowth.toFixed(2)}MB`);
      console.log(`  Growth per operation: ${(growthPerOperation * 1024).toFixed(2)}KB`);

      // Memory leak detection thresholds
      expect(totalGrowth).toBeLessThan(50); // Total growth <50MB
      expect(growthPerOperation * 1024).toBeLessThan(500); // <500KB per operation
    });
  });

  describe('Rate Limiting and Recovery Stress Tests', () => {
    test('should handle GitHub API rate limiting gracefully', async () => {
      const commentManager = new CommentManager(mockOctokit, {
        maxRetries: 3,
        baseDelay: 100,
      });

      console.log('Testing rate limiting recovery...');

      // Simulate rate limiting errors
      let rateLimitHit = 0;
      const rateLimitError = {
        status: 403,
        response: {
          data: { message: 'API rate limit exceeded' },
          headers: { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1) },
        },
      };

      // Mock to simulate rate limiting for some requests
      mockOctokit.rest.issues.listComments.mockImplementation(() => {
        if (Math.random() < 0.3) {
          // 30% chance of rate limit
          rateLimitHit++;
          return Promise.reject(rateLimitError);
        }
        return Promise.resolve({ data: [] });
      });

      const operations = 20;
      const results = [];

      const startTime = timer.start();

      // Perform operations that might hit rate limits
      for (let i = 0; i < operations; i++) {
        try {
          const result = await commentManager.findVisorComment('test-owner', 'test-repo', i);
          results.push({ success: true, result });
        } catch (error) {
          results.push({ success: false, error });
        }
      }

      const duration = timer.end(startTime);
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      console.log(`Rate Limiting Test Results:`);
      console.log(`  Total operations: ${operations}`);
      console.log(`  Rate limits hit: ${rateLimitHit}`);
      console.log(`  Successful: ${successful}`);
      console.log(`  Failed: ${failed}`);
      console.log(`  Duration: ${duration.toFixed(2)}ms`);
      console.log(`  Success rate: ${((successful / operations) * 100).toFixed(2)}%`);

      // Should handle some rate limiting gracefully
      expect(successful).toBeGreaterThanOrEqual(operations * 0.7); // 70% success rate minimum
      expect(rateLimitHit).toBeGreaterThan(0); // Should have hit some rate limits
    });
  });

  describe('Resource Exhaustion Stress Tests', () => {
    test('should handle file handle exhaustion gracefully', async () => {
      console.log('Testing file handle exhaustion handling...');

      const configManager = new ConfigManager();
      const operations = 50;
      let successfulOps = 0;
      let failedOps = 0;

      // Test rapid file operations that could exhaust file handles
      for (let i = 0; i < operations; i++) {
        try {
          // Try to load config multiple times rapidly
          const config = await configManager.findAndLoadConfig();
          expect(config).toBeDefined();
          successfulOps++;
        } catch (error) {
          console.log(`File operation ${i} failed:`, error);
          failedOps++;
        }
      }

      console.log(`File Handle Exhaustion Test Results:`);
      console.log(`  Total operations: ${operations}`);
      console.log(`  Successful: ${successfulOps}`);
      console.log(`  Failed: ${failedOps}`);
      console.log(`  Success rate: ${((successfulOps / operations) * 100).toFixed(2)}%`);

      // Should handle file operations without exhausting resources
      expect(successfulOps).toBeGreaterThanOrEqual(operations * 0.9); // 90% success rate
    });

    test('should cleanup resources properly after stress operations', async () => {
      console.log('Testing resource cleanup after stress...');

      const memoryBefore = memoryProfiler.getCurrentUsage();
      const operations = [];

      // Create many operation promises but don't await them all immediately
      for (let i = 0; i < 25; i++) {
        const op = (async () => {
          const analyzer = new PRAnalyzer(mockOctokit);
          const largePR = createLargePRFixture({
            filesCount: 20,
            linesPerFile: 10,
          });

          mockOctokit.rest.pulls.get.mockResolvedValue({ data: largePR.prInfo });
          mockOctokit.rest.pulls.listFiles.mockResolvedValue({ data: largePR.files });

          return analyzer.fetchPRDiff('test-owner', 'test-repo', i);
        })();

        operations.push(op);
      }

      // Wait for all operations to complete
      await Promise.allSettled(operations);

      // Force cleanup
      if (global.gc) {
        global.gc();
        await new Promise(resolve => setTimeout(resolve, 200));
        global.gc(); // Second pass
      }

      const memoryAfter = memoryProfiler.getCurrentUsage();
      const netMemoryGrowth = (memoryAfter.heapUsed - memoryBefore.heapUsed) / 1024 / 1024;

      console.log(`Resource Cleanup Test Results:`);
      console.log(`  Operations completed: ${operations.length}`);
      console.log(`  Memory before: ${(memoryBefore.heapUsed / 1024 / 1024).toFixed(2)}MB`);
      console.log(`  Memory after cleanup: ${(memoryAfter.heapUsed / 1024 / 1024).toFixed(2)}MB`);
      console.log(`  Net memory growth: ${netMemoryGrowth.toFixed(2)}MB`);

      // Should have minimal memory growth after cleanup
      expect(netMemoryGrowth).toBeLessThan(20); // <20MB net growth after cleanup
    });
  });

  describe('Configuration Stress Tests', () => {
    test('should handle complex configurations under load', async () => {
      console.log('Testing complex configuration handling under load...');

      const dummyConfig = {
        version: '1.0',
        checks: {},
        output: {
          pr_comment: { format: 'summary' as const, group_by: 'check' as const, collapse: true },
        },
      };
      const _eventMapper = new EventMapper(dummyConfig);
      const configManager = new ConfigManager();

      // Create an extremely complex configuration
      const ultraComplexConfig: any = {
        version: '1.0',
        checks: {},
        output: {
          pr_comment: {
            format: 'summary' as const,
            group_by: 'check' as const,
            collapse: true,
          },
        },
      };

      // Add 200 checks with complex conditions
      for (let i = 0; i < 200; i++) {
        ultraComplexConfig.checks[`ultra-complex-check-${i}`] = {
          type: 'ai' as const,
          prompt: `Ultra complex check ${i} with detailed analysis requirements: ${Array(50).fill(`requirement-${i}`).join(', ')}`,
          on: ['pr_opened' as const, 'pr_updated' as const, 'pr_closed' as const],
          triggers: Array(20)
            .fill(0)
            .map((_, j) => `**/*${i}-${j}.{js,ts,py,java,go,rb}`),
          conditions: {
            files_changed: { min: i % 10, max: (i % 50) + 100 },
            lines_changed: { min: i * 5, max: i * 50 },
            branch_patterns: Array(10)
              .fill(0)
              .map((_, j) => `pattern-${i}-${j}/*`),
            author_patterns: Array(5)
              .fill(0)
              .map((_, j) => `author-${i % 10}-${j}`),
          },
        };
      }

      const operations = 20;
      const processingTimes: number[] = [];

      for (let i = 0; i < operations; i++) {
        const startTime = timer.start();

        // Test configuration processing
        try {
          const cliOptions = {
            checks: [`ultra-complex-check-${i % 10}` as any],
            output: 'json' as const,
            configPath: undefined,
            help: false,
            version: false,
          };

          const merged = configManager.mergeWithCliOptions(ultraComplexConfig, cliOptions);
          expect(merged).toBeDefined();

          // Test event mapping with the complex config
          const mapper = new EventMapper(ultraComplexConfig);
          const event = {
            event_name: 'pull_request',
            action: 'opened',
            repository: { owner: { login: 'test' }, name: 'repo' },
            pull_request: {
              number: i,
              state: 'open',
              head: { sha: 'abc', ref: 'feature' },
              base: { sha: 'def', ref: 'main' },
              draft: false,
            },
          };

          const execution = mapper.mapEventToExecution(event, {
            changedFiles: [`file-${i}.js`, `file-${i}.ts`],
            modifiedFiles: [`file-${i}.js`],
          });

          expect(execution).toBeDefined();

          const duration = timer.end(startTime);
          processingTimes.push(duration);
        } catch (error) {
          console.log(`Complex config processing failed at iteration ${i}:`, error);
          const duration = timer.end(startTime);
          processingTimes.push(duration);
        }
      }

      const avgProcessing = processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length;
      const maxProcessing = Math.max(...processingTimes);

      console.log(`Complex Configuration Stress Test Results:`);
      console.log(`  Operations: ${operations}`);
      console.log(`  Config complexity: 200 checks with complex conditions`);
      console.log(`  Average processing: ${avgProcessing.toFixed(2)}ms`);
      console.log(`  Maximum processing: ${maxProcessing.toFixed(2)}ms`);

      // Should handle complex configurations reasonably
      expect(avgProcessing).toBeLessThan(1000); // Average <1 second
      expect(maxProcessing).toBeLessThan(5000); // Max <5 seconds
    });
  });
});
