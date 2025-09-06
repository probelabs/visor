/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { CLI } from '../../src/cli';
import { ConfigManager } from '../../src/config';
import { CommentManager } from '../../src/github-comments';
import { ActionCliBridge } from '../../src/action-cli-bridge';
import { EventMapper } from '../../src/event-mapper';
import { PerformanceTimer, MemoryProfiler, createMockOctokit } from '../performance/test-utilities';
import { RaceConditionSimulator, RaceConditionTestBuilder } from './race-condition-simulator';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

(process.env.CI === 'true' ? describe.skip : describe)('Resource Exhaustion Tests', () => {
  let timer: PerformanceTimer;
  let memoryProfiler: MemoryProfiler;
  let mockOctokit: any;
  let raceSimulator: RaceConditionSimulator;
  let tempDir: string;

  // Extended timeout for resource exhaustion tests
  jest.setTimeout(600000); // 10 minutes

  beforeAll(() => {
    // Create temporary directory for testing
    tempDir = path.join(os.tmpdir(), 'visor-resource-tests');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  });

  afterAll(() => {
    // Cleanup temporary directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.warn('Could not cleanup temp directory:', error);
    }
  });

  beforeEach(() => {
    timer = new PerformanceTimer();
    memoryProfiler = new MemoryProfiler();
    mockOctokit = createMockOctokit();
    raceSimulator = new RaceConditionSimulator();

    // Force garbage collection before each test
    if (global.gc) {
      global.gc();
    }
  });

  afterEach(() => {
    // Cleanup after each test
    if (global.gc) {
      global.gc();
    }
  });

  describe('File Handle Exhaustion Tests', () => {
    test('should handle rapid file operations without exhausting handles', async () => {
      console.log('Testing file handle exhaustion resistance...');

      const configManager = new ConfigManager();
      const totalOperations = 100;
      const concurrentOperations = 20;
      let successfulOperations = 0;
      let failedOperations = 0;
      const operationTimes: number[] = [];

      // Create test config files
      const testConfigs = Array(10)
        .fill(0)
        .map((_, i) => {
          const configPath = path.join(tempDir, `test-config-${i}.yaml`);
          const configContent = {
            version: '1.0',
            checks: {
              [`test-check-${i}`]: {
                type: 'ai',
                prompt: `Test prompt ${i}`,
                on: ['pr_opened'],
              },
            },
          };

          fs.writeFileSync(configPath, JSON.stringify(configContent));
          return configPath;
        });

      const operationPromises: Promise<any>[] = [];

      // Launch concurrent file operations
      for (let i = 0; i < totalOperations; i++) {
        const operation = async () => {
          const startTime = timer.start();
          try {
            const configPath = testConfigs[i % testConfigs.length];

            // Perform multiple file operations that could exhaust handles
            await configManager.loadConfig(configPath);

            // Additional file operations
            const stats = fs.statSync(configPath);
            const content = fs.readFileSync(configPath, 'utf8');

            const duration = timer.end(startTime);
            operationTimes.push(duration);
            successfulOperations++;

            return { success: true, configPath, stats, content: content.length };
          } catch (error) {
            const duration = timer.end(startTime);
            operationTimes.push(duration);
            failedOperations++;

            console.error(`File operation ${i} failed:`, error);
            return { success: false, error: (error as Error).message || String(error) };
          }
        };

        operationPromises.push(operation());

        // Throttle operations to create sustained load
        if (operationPromises.length >= concurrentOperations) {
          await Promise.allSettled(operationPromises.splice(0, concurrentOperations / 2));
        }
      }

      // Wait for remaining operations
      await Promise.allSettled(operationPromises);

      const avgOperationTime = operationTimes.reduce((a, b) => a + b, 0) / operationTimes.length;
      const maxOperationTime = Math.max(...operationTimes);

      console.log(`File Handle Exhaustion Test Results:`);
      console.log(`  Total operations: ${totalOperations}`);
      console.log(`  Successful: ${successfulOperations}`);
      console.log(`  Failed: ${failedOperations}`);
      console.log(
        `  Success rate: ${((successfulOperations / totalOperations) * 100).toFixed(2)}%`
      );
      console.log(`  Average operation time: ${avgOperationTime.toFixed(2)}ms`);
      console.log(`  Max operation time: ${maxOperationTime.toFixed(2)}ms`);

      // Cleanup test files
      testConfigs.forEach(configPath => {
        try {
          fs.unlinkSync(configPath);
        } catch (error) {
          console.warn(`Could not cleanup ${configPath}:`, error);
        }
      });

      // Should handle file operations without significant failures
      expect(successfulOperations).toBeGreaterThanOrEqual(totalOperations * 0.9); // 90% success rate
      expect(avgOperationTime).toBeLessThan(1000); // Average <1 second
    });
  });

  describe('Memory Exhaustion Tests', () => {
    test('should handle progressive memory pressure gracefully', async () => {
      console.log('Testing progressive memory pressure handling...');

      const initialMemory = memoryProfiler.getCurrentUsage().heapUsed;
      const memoryReadings: Array<{ iteration: number; memory: number; operations: number }> = [];

      let currentIteration = 0;
      let totalOperations = 0;
      const maxIterations = 20;
      const memoryLimitMB = 600; // 600MB limit

      while (currentIteration < maxIterations) {
        const iterationStart = timer.start();

        try {
          // Create progressively more memory-intensive operations
          const operationsPerIteration = (currentIteration + 1) * 10;
          const largeDataSets = [];

          for (let i = 0; i < operationsPerIteration; i++) {
            // Create large data structures that consume memory
            const largeArray = Array(1000)
              .fill(0)
              .map((_, idx) => ({
                id: `${currentIteration}-${i}-${idx}`,
                data: `${'x'.repeat(100)}`, // 100 character string per item
                metadata: {
                  created: new Date(),
                  iteration: currentIteration,
                  operation: i,
                  large_field: Array(50).fill(`data-${idx}`),
                },
              }));

            largeDataSets.push(largeArray);
            totalOperations++;

            // Simulate some processing
            const cli = new CLI();
            cli.parseArgs(['--check', 'performance', '--output', 'json']);

            // Check memory periodically
            if (i % 10 === 0) {
              const currentMemory = memoryProfiler.getCurrentUsage().heapUsed;
              const memoryMB = currentMemory / 1024 / 1024;

              if (memoryMB > memoryLimitMB) {
                console.log(
                  `Memory limit reached at iteration ${currentIteration}, operation ${i}: ${memoryMB.toFixed(2)}MB`
                );
                break;
              }
            }
          }

          const iterationDuration = timer.end(iterationStart);
          const currentMemory = memoryProfiler.getCurrentUsage().heapUsed;
          const memoryMB = currentMemory / 1024 / 1024;

          memoryReadings.push({
            iteration: currentIteration,
            memory: memoryMB,
            operations: operationsPerIteration,
          });

          console.log(
            `  Iteration ${currentIteration}: ${operationsPerIteration} ops, ${memoryMB.toFixed(2)}MB, ${iterationDuration.toFixed(2)}ms`
          );

          // Break if memory is getting too high
          if (memoryMB > memoryLimitMB) {
            console.log(`Stopping due to memory limit: ${memoryMB.toFixed(2)}MB`);
            break;
          }

          // Force garbage collection between iterations
          if (global.gc) {
            global.gc();
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        } catch (error) {
          console.log(`Memory pressure test failed at iteration ${currentIteration}:`, error);
          break;
        }

        currentIteration++;
      }

      const finalMemory = memoryProfiler.getCurrentUsage().heapUsed;
      const totalMemoryGrowth = (finalMemory - initialMemory) / 1024 / 1024;
      const maxMemoryReading = Math.max(...memoryReadings.map(r => r.memory));

      console.log(`Progressive Memory Pressure Test Results:`);
      console.log(`  Iterations completed: ${currentIteration}`);
      console.log(`  Total operations: ${totalOperations}`);
      console.log(`  Initial memory: ${(initialMemory / 1024 / 1024).toFixed(2)}MB`);
      console.log(`  Final memory: ${(finalMemory / 1024 / 1024).toFixed(2)}MB`);
      console.log(`  Total growth: ${totalMemoryGrowth.toFixed(2)}MB`);
      console.log(`  Peak memory: ${maxMemoryReading.toFixed(2)}MB`);

      // Should handle progressive memory pressure
      expect(currentIteration).toBeGreaterThanOrEqual(5); // Complete at least 5 iterations
      expect(maxMemoryReading).toBeLessThan(700); // Stay under 700MB
      expect(totalOperations).toBeGreaterThan(50); // Complete substantial work
    });

    test('should recover from memory pressure with garbage collection', async () => {
      console.log('Testing memory recovery through garbage collection...');

      if (!global.gc) {
        console.log('Garbage collection not available, skipping test');
        return;
      }

      const baselineMemory = memoryProfiler.getCurrentUsage().heapUsed;
      const recoveryTestResults: Array<{ phase: string; memory: number }> = [];

      // Phase 1: Create memory pressure
      console.log('Phase 1: Creating memory pressure...');
      const largeObjects = [];
      for (let i = 0; i < 100; i++) {
        largeObjects.push({
          id: i,
          largeData: Array(10000)
            .fill(0)
            .map((_, j) => ({
              index: j,
              data: 'x'.repeat(200),
              metadata: { created: new Date(), random: Math.random() },
            })),
        });
      }

      const pressureMemory = memoryProfiler.getCurrentUsage().heapUsed;
      recoveryTestResults.push({ phase: 'pressure', memory: pressureMemory });

      // Phase 2: Clear references
      console.log('Phase 2: Clearing references...');
      largeObjects.length = 0;

      const clearedMemory = memoryProfiler.getCurrentUsage().heapUsed;
      recoveryTestResults.push({ phase: 'cleared', memory: clearedMemory });

      // Phase 3: Force garbage collection
      console.log('Phase 3: Forcing garbage collection...');
      global.gc();
      await new Promise(resolve => setTimeout(resolve, 200));
      global.gc(); // Second pass

      const gcMemory = memoryProfiler.getCurrentUsage().heapUsed;
      recoveryTestResults.push({ phase: 'gc', memory: gcMemory });

      // Calculate recovery metrics
      const memoryGrowth = (pressureMemory - baselineMemory) / 1024 / 1024;
      const memoryRecovered = (pressureMemory - gcMemory) / 1024 / 1024;
      const recoveryPercentage = (memoryRecovered / memoryGrowth) * 100;
      const finalGrowth = (gcMemory - baselineMemory) / 1024 / 1024;

      console.log(`Memory Recovery Test Results:`);
      console.log(`  Baseline memory: ${(baselineMemory / 1024 / 1024).toFixed(2)}MB`);
      console.log(`  Peak memory: ${(pressureMemory / 1024 / 1024).toFixed(2)}MB`);
      console.log(`  After GC memory: ${(gcMemory / 1024 / 1024).toFixed(2)}MB`);
      console.log(`  Memory growth: ${memoryGrowth.toFixed(2)}MB`);
      console.log(`  Memory recovered: ${memoryRecovered.toFixed(2)}MB`);
      console.log(`  Recovery percentage: ${recoveryPercentage.toFixed(2)}%`);
      console.log(`  Final growth: ${finalGrowth.toFixed(2)}MB`);

      // Should recover significant amount of memory
      expect(recoveryPercentage).toBeGreaterThan(50); // Recover >50% of allocated memory
      expect(finalGrowth).toBeLessThan(50); // Final growth <50MB
      expect(memoryRecovered).toBeGreaterThan(10); // Recover at least 10MB
    });
  });

  describe('Concurrent Operation Race Conditions', () => {
    test('should detect and handle race conditions in comment management', async () => {
      console.log('Testing race conditions in comment management...');

      const commentTests = [
        RaceConditionTestBuilder.createCounterTest('comment-counter-test', 0, 15),
        RaceConditionTestBuilder.createResourceAllocationTest('comment-allocation-test', 5, 12),
      ];

      // Add specific comment management race condition test
      const commentManager = new CommentManager(mockOctokit);
      const sharedCommentData = { updateCount: 0, lastUpdate: null };

      const commentRaceTest = {
        name: 'comment-update-race-test',
        setup: async () => {
          sharedCommentData.updateCount = 0;
          sharedCommentData.lastUpdate = null;
          return { commentManager, sharedCommentData };
        },
        operations: Array(10)
          .fill(0)
          .map((_, i) => async () => {
            await new Promise(resolve => setTimeout(resolve, Math.random() * 20));

            const updateTime = new Date().toISOString();
            sharedCommentData.updateCount++;
            sharedCommentData.lastUpdate = updateTime as any;

            return commentManager.updateOrCreateComment(
              'test-owner',
              'test-repo',
              123,
              `Update ${i} at ${updateTime}`,
              {
                commentId: `race-test-${i % 3}`, // Use limited comment IDs to create conflicts
                triggeredBy: `race_test_${i}`,
                allowConcurrentUpdates: true,
              }
            );
          }),
        validation: async (results: any) => {
          const successful = results.filter((r: any) => r && r.id).length;
          const expectedUpdates = 10;

          // Check that all operations completed
          const allCompleted = successful === expectedUpdates;

          // Check that update counter is correct
          const counterCorrect = sharedCommentData.updateCount === expectedUpdates;

          return allCompleted && counterCorrect;
        },
      };

      commentTests.push(commentRaceTest);

      // Run all race condition tests
      const results = await raceSimulator.runTestSuite(commentTests);
      const summary = raceSimulator.getSummary();

      console.log(`Race Condition Test Summary:`);
      console.log(`  Total tests: ${summary.totalTests}`);
      console.log(`  Passed: ${summary.passed}`);
      console.log(`  Failed: ${summary.failed}`);
      console.log(`  Race conditions detected: ${summary.totalRaceConditions}`);
      console.log(`  Average duration: ${summary.averageDuration.toFixed(2)}ms`);

      // Should pass most race condition tests
      expect(summary.passed).toBeGreaterThanOrEqual(Math.floor(summary.totalTests * 0.7)); // 70% pass rate
      expect(summary.totalRaceConditions).toBeLessThan(5); // Limited race conditions
    });

    test('should handle concurrent configuration loading', async () => {
      console.log('Testing concurrent configuration loading race conditions...');

      const configManager = new ConfigManager();

      // Create test configuration
      const testConfigPath = path.join(tempDir, 'concurrent-test-config.yaml');
      const testConfig = {
        version: '1.0',
        checks: {
          'test-check': {
            type: 'ai',
            prompt: 'Test concurrent loading',
            on: ['pr_opened'],
          },
        },
      };

      fs.writeFileSync(testConfigPath, JSON.stringify(testConfig));

      const concurrentLoads = 15;
      const loadPromises = [];
      let successfulLoads = 0;
      let failedLoads = 0;

      // Launch concurrent configuration loading
      for (let i = 0; i < concurrentLoads; i++) {
        const loadPromise = (async () => {
          try {
            await new Promise(resolve => setTimeout(resolve, Math.random() * 30));
            const config = await configManager.loadConfig(testConfigPath);
            successfulLoads++;
            return { success: true, config, loadId: i };
          } catch (error) {
            failedLoads++;
            return { success: false, error, loadId: i };
          }
        })();

        loadPromises.push(loadPromise);
      }

      const results = await Promise.allSettled(loadPromises);
      const successfulResults = results.filter(r => r.status === 'fulfilled').length;

      console.log(`Concurrent Configuration Loading Results:`);
      console.log(`  Total loads: ${concurrentLoads}`);
      console.log(`  Successful: ${successfulLoads}`);
      console.log(`  Failed: ${failedLoads}`);
      console.log(`  Promise results: ${successfulResults}`);

      // Cleanup
      try {
        fs.unlinkSync(testConfigPath);
      } catch (error) {
        console.warn('Could not cleanup test config:', error);
      }

      // Should handle concurrent configuration loading
      expect(successfulLoads).toBeGreaterThanOrEqual(concurrentLoads * 0.8); // 80% success rate
      expect(successfulResults).toBeGreaterThanOrEqual(concurrentLoads * 0.8);
    });
  });

  describe('System Resource Limits', () => {
    test('should handle system resource limits gracefully', async () => {
      console.log('Testing system resource limit handling...');

      const cli = new CLI();
      const dummyConfig = {
        version: '1.0',
        checks: {},
        output: {
          pr_comment: { format: 'table' as const, group_by: 'check' as const, collapse: true },
        },
      };
      const eventMapper = new EventMapper(dummyConfig);

      // Test with extremely large configurations that might hit limits
      const massiveConfig: any = {
        version: '1.0',
        checks: {},
        output: { pr_comment: { format: 'table', group_by: 'check', collapse: true } },
      };

      // Create massive configuration
      for (let i = 0; i < 1000; i++) {
        massiveConfig.checks[`massive-check-${i}`] = {
          type: 'ai',
          prompt: `Massive check ${i}: ${Array(500).fill('word').join(' ')}`,
          on: ['pr_opened', 'pr_updated'],
          triggers: Array(100)
            .fill(0)
            .map((_, j) => `**/*-${i}-${j}.*`),
        };
      }

      let processedChecks = 0;
      let processingStopped = false;
      const processingTimes: number[] = [];

      try {
        // Test processing large configuration chunks
        const checkEntries = Object.entries(massiveConfig.checks);
        const chunkSize = 50;

        for (let chunk = 0; chunk < checkEntries.length / chunkSize; chunk++) {
          const chunkStart = chunk * chunkSize;
          const chunkEnd = Math.min(chunkStart + chunkSize, checkEntries.length);
          const chunkChecks = checkEntries.slice(chunkStart, chunkEnd);

          const chunkStartTime = timer.start();

          // Process chunk
          const chunkConfig = {
            ...massiveConfig,
            checks: Object.fromEntries(chunkChecks),
          };

          // Test CLI processing
          cli.parseArgs(['--check', 'performance', '--output', 'json']);

          // Test event mapping
          const mapper = new EventMapper(chunkConfig);
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

          mapper.mapEventToExecution(event);

          const chunkDuration = timer.end(chunkStartTime);
          processingTimes.push(chunkDuration);
          processedChecks += chunkChecks.length;

          // Check if processing is taking too long (resource limit indicator)
          if (chunkDuration > 10000) {
            // 10 seconds per chunk
            console.log(`Processing time exceeded limit at chunk ${chunk}: ${chunkDuration}ms`);
            processingStopped = true;
            break;
          }

          // Force GC between chunks
          if (global.gc && chunk % 5 === 0) {
            global.gc();
          }
        }
      } catch (error) {
        console.log(
          'System resource limit encountered:',
          (error as Error).message || String(error)
        );
        processingStopped = true;
      }

      const avgProcessingTime = processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length;
      const maxProcessingTime = Math.max(...processingTimes);

      console.log(`System Resource Limit Test Results:`);
      console.log(`  Processed checks: ${processedChecks}/1000`);
      console.log(`  Processing stopped: ${processingStopped}`);
      console.log(`  Chunks processed: ${processingTimes.length}`);
      console.log(`  Average chunk time: ${avgProcessingTime.toFixed(2)}ms`);
      console.log(`  Max chunk time: ${maxProcessingTime.toFixed(2)}ms`);

      // Should handle reasonable amount of processing before hitting limits
      expect(processedChecks).toBeGreaterThan(100); // Process at least 100 checks
      expect(avgProcessingTime).toBeLessThan(5000); // Average processing <5 seconds per chunk
    });
  });
});
