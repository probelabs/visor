/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { CLI } from '../../src/cli';
import { ConfigManager } from '../../src/config';
import { PRAnalyzer } from '../../src/pr-analyzer';
import { PRReviewer } from '../../src/reviewer';
import { CommentManager } from '../../src/github-comments';
import { ActionCliBridge } from '../../src/action-cli-bridge';
import { EventMapper } from '../../src/event-mapper';
import {
  PerformanceTimer,
  MemoryProfiler,
  createLargePRFixture,
  createMockOctokit,
} from '../performance/test-utilities';

(process.env.CI === 'true' ? describe.skip : describe)('Memory Leak Detection Tests', () => {
  let timer: PerformanceTimer;
  let memoryProfiler: MemoryProfiler;
  let mockOctokit: any;

  // Extended timeout for memory tests
  jest.setTimeout(600000); // 10 minutes

  beforeEach(() => {
    timer = new PerformanceTimer();
    memoryProfiler = new MemoryProfiler();
    mockOctokit = createMockOctokit();

    // Force garbage collection before each test
    if (global.gc) {
      global.gc();
      // Wait for GC to complete
      return new Promise<void>(resolve => setTimeout(resolve, 100));
    }
  });

  afterEach(async () => {
    // Cleanup after each test
    if (global.gc) {
      global.gc();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  });

  describe('Long-Running Operation Memory Tests', () => {
    test('should not leak memory during 1000+ CLI operations', async () => {
      console.log('Testing memory leaks during extended CLI operations...');

      if (!global.gc) {
        console.log('Garbage collection not available, skipping memory leak test');
        return;
      }

      const cli = new CLI();
      const configManager = new ConfigManager();

      // Establish baseline
      global.gc();
      await new Promise(resolve => setTimeout(resolve, 200));
      const baselineMemory = memoryProfiler.getCurrentUsage().heapUsed;

      const memoryReadings: Array<{
        iteration: number;
        memoryMB: number;
        growthMB: number;
      }> = [];

      console.log(`Baseline memory: ${(baselineMemory / 1024 / 1024).toFixed(2)}MB`);

      const totalOperations = 1000;
      const checkInterval = 50;

      // Perform many CLI operations
      for (let i = 0; i < totalOperations; i++) {
        // Vary the operations to simulate real usage
        const checkType = ['performance', 'security', 'style', 'architecture'][i % 4];
        const outputFormat = ['table', 'json', 'markdown'][i % 3];

        try {
          // CLI parsing operations
          const options = cli.parseArgs(['--check', checkType, '--output', outputFormat]);
          expect(options).toBeDefined();

          // Config operations
          const config = await configManager.findAndLoadConfig();
          const merged = configManager.mergeWithCliOptions(config, options);
          expect(merged).toBeDefined();

          // Create temporary objects that should be garbage collected
          const tempData = {
            iteration: i,
            largeArray: Array(100).fill(`data-${i}`),
            options,
            config: merged,
            timestamp: new Date(),
          };

          // Simulate processing
          JSON.stringify(tempData);
        } catch (error) {
          console.log(`Operation ${i} failed:`, error);
        }

        // Check memory periodically
        if (i % checkInterval === 0) {
          // Force GC before measurement
          global.gc();
          await new Promise(resolve => setTimeout(resolve, 50));

          const currentMemory = memoryProfiler.getCurrentUsage().heapUsed;
          const memoryMB = currentMemory / 1024 / 1024;
          const growthMB = (currentMemory - baselineMemory) / 1024 / 1024;

          memoryReadings.push({
            iteration: i,
            memoryMB,
            growthMB,
          });

          console.log(
            `  Iteration ${i}: ${memoryMB.toFixed(2)}MB (growth: ${growthMB >= 0 ? '+' : ''}${growthMB.toFixed(2)}MB)`
          );

          // Early termination if memory growth is excessive
          if (growthMB > 100) {
            // More than 100MB growth
            console.log(`Stopping early due to excessive memory growth: ${growthMB.toFixed(2)}MB`);
            break;
          }
        }
      }

      // Final measurement after cleanup
      global.gc();
      await new Promise(resolve => setTimeout(resolve, 200));
      const finalMemory = memoryProfiler.getCurrentUsage().heapUsed;
      const finalGrowthMB = (finalMemory - baselineMemory) / 1024 / 1024;

      // Analysis
      const avgGrowth =
        memoryReadings.reduce((sum, r) => sum + r.growthMB, 0) / memoryReadings.length;
      const maxGrowth = Math.max(...memoryReadings.map(r => r.growthMB));
      const growthPerOperation = (finalGrowthMB / totalOperations) * 1024; // KB per operation

      console.log(`Memory Leak Detection Results:`);
      console.log(`  Operations completed: ${totalOperations}`);
      console.log(`  Baseline memory: ${(baselineMemory / 1024 / 1024).toFixed(2)}MB`);
      console.log(`  Final memory: ${(finalMemory / 1024 / 1024).toFixed(2)}MB`);
      console.log(`  Final growth: ${finalGrowthMB.toFixed(2)}MB`);
      console.log(`  Average growth: ${avgGrowth.toFixed(2)}MB`);
      console.log(`  Maximum growth: ${maxGrowth.toFixed(2)}MB`);
      console.log(`  Growth per operation: ${growthPerOperation.toFixed(2)}KB`);

      // Memory leak thresholds
      expect(finalGrowthMB).toBeLessThan(50); // Final growth <50MB
      expect(growthPerOperation).toBeLessThan(50); // <50KB per operation
      expect(maxGrowth).toBeLessThan(100); // Peak growth <100MB
    });

    test('should handle memory pressure during PR analysis cycles', async () => {
      console.log('Testing memory pressure during PR analysis cycles...');

      if (!global.gc) {
        console.log('Garbage collection not available, skipping test');
        return;
      }

      const analyzer = new PRAnalyzer(mockOctokit);
      const reviewer = new PRReviewer(mockOctokit);

      // Establish baseline
      global.gc();
      await new Promise(resolve => setTimeout(resolve, 100));
      const baselineMemory = memoryProfiler.getCurrentUsage().heapUsed;

      const cycles = 100;
      const memoryCheckpoints: number[] = [];

      console.log(`Starting ${cycles} PR analysis cycles...`);
      console.log(`Baseline memory: ${(baselineMemory / 1024 / 1024).toFixed(2)}MB`);

      for (let cycle = 0; cycle < cycles; cycle++) {
        // Create varied PR data for each cycle
        const prSize = 10 + (cycle % 20); // 10-30 files
        const largePR = createLargePRFixture({
          filesCount: prSize,
          linesPerFile: 15,
          totalAdditions: prSize * 10,
          totalDeletions: prSize * 2,
        });

        mockOctokit.rest.pulls.get.mockResolvedValue({ data: largePR.prInfo });
        mockOctokit.rest.pulls.listFiles.mockResolvedValue({ data: largePR.files });

        try {
          // Perform analysis
          const prInfo = await analyzer.fetchPRDiff('test-owner', 'test-repo', cycle);
          const review = await reviewer.reviewPR('test-owner', 'test-repo', cycle, prInfo);

          // Validate results
          expect(prInfo).toBeDefined();
          expect(review).toBeDefined();
          expect(Array.isArray(review.issues)).toBe(true);

          // Create some temporary large objects that should be GC'd
          const tempAnalysis = {
            cycle,
            prInfo,
            review,
            largeBuffer: Buffer.alloc(1024 * 10), // 10KB buffer
            processingData: Array(100)
              .fill(0)
              .map((_, i) => ({
                id: `${cycle}-${i}`,
                data: `processing-data-${cycle}-${i}`.repeat(10),
              })),
          };

          // Use the data briefly
          JSON.stringify({
            cycle,
            issues: review.issues.length,
            dataSize: tempAnalysis.largeBuffer.length,
          });
        } catch (error) {
          console.log(`Cycle ${cycle} failed:`, error);
        }

        // Check memory every 10 cycles
        if (cycle % 10 === 0) {
          global.gc();
          await new Promise(resolve => setTimeout(resolve, 50));

          const currentMemory = memoryProfiler.getCurrentUsage().heapUsed;
          memoryCheckpoints.push(currentMemory);

          const growthMB = (currentMemory - baselineMemory) / 1024 / 1024;
          console.log(
            `  Cycle ${cycle}: ${(currentMemory / 1024 / 1024).toFixed(2)}MB (growth: ${growthMB >= 0 ? '+' : ''}${growthMB.toFixed(2)}MB)`
          );
        }
      }

      // Final cleanup and measurement
      global.gc();
      await new Promise(resolve => setTimeout(resolve, 200));
      const finalMemory = memoryProfiler.getCurrentUsage().heapUsed;

      // Analysis
      const totalGrowthMB = (finalMemory - baselineMemory) / 1024 / 1024;
      const avgMemoryMB =
        memoryCheckpoints.reduce((sum, m) => sum + m, 0) / memoryCheckpoints.length / 1024 / 1024;
      const maxMemoryMB = Math.max(...memoryCheckpoints) / 1024 / 1024;

      console.log(`PR Analysis Memory Pressure Results:`);
      console.log(`  Cycles completed: ${cycles}`);
      console.log(`  Final growth: ${totalGrowthMB.toFixed(2)}MB`);
      console.log(`  Average memory: ${avgMemoryMB.toFixed(2)}MB`);
      console.log(`  Peak memory: ${maxMemoryMB.toFixed(2)}MB`);
      console.log(`  Growth per cycle: ${((totalGrowthMB / cycles) * 1024).toFixed(2)}KB`);

      // Memory pressure thresholds
      expect(totalGrowthMB).toBeLessThan(30); // Total growth <30MB
      expect(maxMemoryMB).toBeLessThan(600); // Peak memory <600MB
    });
  });

  describe('Resource Cleanup Validation', () => {
    test('should properly cleanup comment manager resources', async () => {
      console.log('Testing comment manager resource cleanup...');

      if (!global.gc) {
        console.log('Garbage collection not available, skipping test');
        return;
      }

      const initialMemory = memoryProfiler.getCurrentUsage().heapUsed;
      const commentManagers: CommentManager[] = [];

      // Create many comment managers with operations
      const numManagers = 50;
      console.log(`Creating ${numManagers} comment managers...`);

      for (let i = 0; i < numManagers; i++) {
        const manager = new CommentManager(mockOctokit, {
          maxRetries: 2,
          baseDelay: 50,
        });

        // Perform operations that create internal state
        try {
          await manager.findVisorComment('test-owner', `test-repo-${i}`, i);
          await manager.updateOrCreateComment(
            'test-owner',
            `test-repo-${i}`,
            i,
            `Test comment ${i} with content that takes memory`,
            {
              commentId: `test-comment-${i}`,
              triggeredBy: `cleanup_test_${i}`,
            }
          );
        } catch (error: any) {
          // Expected for mock failures
        }

        commentManagers.push(manager);
      }

      const afterCreationMemory = memoryProfiler.getCurrentUsage().heapUsed;
      const creationGrowthMB = (afterCreationMemory - initialMemory) / 1024 / 1024;

      console.log(
        `After creation: ${(afterCreationMemory / 1024 / 1024).toFixed(2)}MB (growth: ${creationGrowthMB.toFixed(2)}MB)`
      );

      // Clear references
      commentManagers.length = 0;

      // Force garbage collection
      global.gc();
      await new Promise(resolve => setTimeout(resolve, 200));
      global.gc(); // Second pass
      await new Promise(resolve => setTimeout(resolve, 100));

      const afterCleanupMemory = memoryProfiler.getCurrentUsage().heapUsed;
      const cleanupGrowthMB = (afterCleanupMemory - initialMemory) / 1024 / 1024;
      const recoveredMemoryMB = (afterCreationMemory - afterCleanupMemory) / 1024 / 1024;
      const recoveryPercentage = (recoveredMemoryMB / creationGrowthMB) * 100;

      console.log(`Resource Cleanup Results:`);
      console.log(`  Initial memory: ${(initialMemory / 1024 / 1024).toFixed(2)}MB`);
      console.log(`  After creation: ${(afterCreationMemory / 1024 / 1024).toFixed(2)}MB`);
      console.log(`  After cleanup: ${(afterCleanupMemory / 1024 / 1024).toFixed(2)}MB`);
      console.log(`  Creation growth: ${creationGrowthMB.toFixed(2)}MB`);
      console.log(`  Final growth: ${cleanupGrowthMB.toFixed(2)}MB`);
      console.log(`  Memory recovered: ${recoveredMemoryMB.toFixed(2)}MB`);
      console.log(`  Recovery percentage: ${recoveryPercentage.toFixed(2)}%`);

      // Resource cleanup validation
      expect(recoveryPercentage).toBeGreaterThan(60); // Recover >60% of created memory
      expect(cleanupGrowthMB).toBeLessThan(10); // Final growth <10MB
      expect(recoveredMemoryMB).toBeGreaterThan(5); // Recover at least 5MB
    });

    test('should cleanup ActionCliBridge temporary resources', async () => {
      console.log('Testing ActionCliBridge resource cleanup...');

      if (!global.gc) {
        console.log('Garbage collection not available, skipping test');
        return;
      }

      const initialMemory = memoryProfiler.getCurrentUsage().heapUsed;
      const bridges: ActionCliBridge[] = [];

      console.log('Creating multiple ActionCliBridge instances with temp configs...');

      // Create many bridge instances with temporary configs
      for (let i = 0; i < 30; i++) {
        const context = {
          event_name: 'pull_request',
          action: 'opened',
          repository: {
            owner: { login: `test-owner-${i}` },
            name: `test-repo-${i}`,
          },
          event: {
            pull_request: { number: i },
          },
        };

        const bridge = new ActionCliBridge(`test-token-${i}`, context);

        // Create temporary configurations
        const inputs = {
          'github-token': `test-token-${i}`,
          'visor-checks': `check-${i % 5},security,performance`,
          owner: `test-owner-${i}`,
          repo: `test-repo-${i}`,
        };

        try {
          // Operations that might create temporary resources
          const shouldUse = bridge.shouldUseVisor(inputs);
          if (shouldUse) {
            const args = bridge.parseGitHubInputsToCliArgs(inputs);
            expect(args).toBeDefined();

            // Simulate config creation (would normally create temp files)
            await bridge.createTempConfigFromInputs(inputs);
          }
        } catch (error: any) {
          // Expected for some mock scenarios
        }

        bridges.push(bridge);
      }

      const afterCreationMemory = memoryProfiler.getCurrentUsage().heapUsed;
      const creationGrowthMB = (afterCreationMemory - initialMemory) / 1024 / 1024;

      console.log(
        `After creation: ${(afterCreationMemory / 1024 / 1024).toFixed(2)}MB (growth: ${creationGrowthMB.toFixed(2)}MB)`
      );

      // Cleanup bridge resources
      for (const bridge of bridges) {
        try {
          await bridge.cleanup();
        } catch (error: any) {
          // Cleanup errors are logged but not fatal
        }
      }

      // Clear references
      bridges.length = 0;

      // Force garbage collection
      global.gc();
      await new Promise(resolve => setTimeout(resolve, 200));

      const afterCleanupMemory = memoryProfiler.getCurrentUsage().heapUsed;
      const cleanupGrowthMB = (afterCleanupMemory - initialMemory) / 1024 / 1024;
      const recoveredMemoryMB = (afterCreationMemory - afterCleanupMemory) / 1024 / 1024;

      console.log(`ActionCliBridge Cleanup Results:`);
      console.log(`  Creation growth: ${creationGrowthMB.toFixed(2)}MB`);
      console.log(`  Final growth: ${cleanupGrowthMB.toFixed(2)}MB`);
      console.log(`  Memory recovered: ${recoveredMemoryMB.toFixed(2)}MB`);

      // Should cleanup resources effectively
      expect(cleanupGrowthMB).toBeLessThan(20); // Final growth <20MB
      expect(recoveredMemoryMB).toBeGreaterThan(0); // Some memory should be recovered
    });
  });

  describe('Garbage Collection Monitoring', () => {
    test('should monitor GC efficiency during intensive operations', async () => {
      console.log('Testing garbage collection efficiency monitoring...');

      if (!global.gc) {
        console.log('Garbage collection not available, skipping GC monitoring test');
        return;
      }

      const cli = new CLI();
      const configManager = new ConfigManager();

      // Track GC metrics
      const gcMetrics = {
        forcedCollections: 0,
        memoryBeforeGC: [] as number[],
        memoryAfterGC: [] as number[],
        gcEfficiency: [] as number[],
      };

      const operations = 200;
      console.log(`Monitoring GC efficiency across ${operations} operations...`);

      for (let i = 0; i < operations; i++) {
        // Create memory pressure with large temporary objects
        const largeTempData = Array(500)
          .fill(0)
          .map((_, idx) => ({
            id: `${i}-${idx}`,
            data: `large-data-string-${i}-${idx}`.repeat(20),
            metadata: {
              created: new Date(),
              operation: i,
              random: Math.random(),
            },
          }));

        // Perform CLI operations
        const options = cli.parseArgs(['--check', 'all', '--output', 'json']);
        const config = await configManager.findAndLoadConfig();
        const merged = configManager.mergeWithCliOptions(config, options);

        // Simulate processing with the large data
        const processed = largeTempData.map(item => ({
          ...item,
          processed: true,
          result: JSON.stringify(merged).length,
        }));

        // Force GC every 20 operations and measure efficiency
        if (i % 20 === 0) {
          const memoryBefore = memoryProfiler.getCurrentUsage().heapUsed;
          gcMetrics.memoryBeforeGC.push(memoryBefore);

          global.gc();
          gcMetrics.forcedCollections++;

          await new Promise(resolve => setTimeout(resolve, 50));

          const memoryAfter = memoryProfiler.getCurrentUsage().heapUsed;
          gcMetrics.memoryAfterGC.push(memoryAfter);

          const collected = memoryBefore - memoryAfter;
          const efficiency = collected > 0 ? (collected / memoryBefore) * 100 : 0;
          gcMetrics.gcEfficiency.push(efficiency);

          console.log(
            `  GC ${gcMetrics.forcedCollections}: ${(memoryBefore / 1024 / 1024).toFixed(2)}MB → ${(memoryAfter / 1024 / 1024).toFixed(2)}MB (${efficiency.toFixed(2)}% efficiency)`
          );
        }

        // Clear temp references explicitly
        largeTempData.length = 0;
        processed.length = 0;
      }

      // Final analysis
      const avgEfficiency =
        gcMetrics.gcEfficiency.reduce((sum, eff) => sum + eff, 0) / gcMetrics.gcEfficiency.length;
      const minEfficiency = Math.min(...gcMetrics.gcEfficiency);
      const maxEfficiency = Math.max(...gcMetrics.gcEfficiency);
      const totalMemoryCollected =
        gcMetrics.memoryBeforeGC.reduce((sum, before, i) => {
          const after = gcMetrics.memoryAfterGC[i];
          return sum + Math.max(0, before - after);
        }, 0) /
        1024 /
        1024;

      console.log(`GC Efficiency Monitoring Results:`);
      console.log(`  Forced collections: ${gcMetrics.forcedCollections}`);
      console.log(`  Average efficiency: ${avgEfficiency.toFixed(2)}%`);
      console.log(
        `  Efficiency range: ${minEfficiency.toFixed(2)}% - ${maxEfficiency.toFixed(2)}%`
      );
      console.log(`  Total memory collected: ${totalMemoryCollected.toFixed(2)}MB`);

      // GC efficiency validation
      expect(avgEfficiency).toBeGreaterThan(10); // Average efficiency >10%
      expect(maxEfficiency).toBeGreaterThan(30); // Peak efficiency >30%
      expect(totalMemoryCollected).toBeGreaterThan(10); // Collected >10MB total
      expect(gcMetrics.forcedCollections).toBeGreaterThan(5); // Multiple GC cycles
    });
  });

  describe('Memory Growth Pattern Analysis', () => {
    test('should analyze memory growth patterns and detect anomalies', async () => {
      console.log('Testing memory growth pattern analysis...');

      if (!global.gc) {
        console.log('Garbage collection not available, skipping pattern analysis');
        return;
      }

      const analyzer = new PRAnalyzer(mockOctokit);

      // Collect memory data over time
      const memoryPattern: Array<{
        timestamp: number;
        memory: number;
        operation: string;
        growth: number;
      }> = [];

      const startTime = Date.now();
      global.gc();
      const baselineMemory = memoryProfiler.getCurrentUsage().heapUsed;

      console.log(`Analyzing memory growth patterns over varied operations...`);
      console.log(`Baseline memory: ${(baselineMemory / 1024 / 1024).toFixed(2)}MB`);

      // Perform different types of operations to see growth patterns
      const operationTypes = [
        { name: 'small-pr', files: 5, lines: 10 },
        { name: 'medium-pr', files: 20, lines: 25 },
        { name: 'large-pr', files: 50, lines: 50 },
        { name: 'huge-pr', files: 100, lines: 30 },
      ];

      for (let cycle = 0; cycle < 40; cycle++) {
        const opType = operationTypes[cycle % operationTypes.length];

        // Create PR of specific size
        const prData = createLargePRFixture({
          filesCount: opType.files,
          linesPerFile: opType.lines,
        });

        mockOctokit.rest.pulls.get.mockResolvedValue({ data: prData.prInfo });
        mockOctokit.rest.pulls.listFiles.mockResolvedValue({ data: prData.files });

        const operationStart = Date.now();

        try {
          await analyzer.fetchPRDiff('test-owner', 'test-repo', cycle);
        } catch (error: any) {
          // Continue with memory analysis even if operation fails
        }

        const currentMemory = memoryProfiler.getCurrentUsage().heapUsed;
        const growth = currentMemory - baselineMemory;

        memoryPattern.push({
          timestamp: Date.now() - startTime,
          memory: currentMemory,
          operation: opType.name,
          growth,
        });

        // Force GC every 10 operations for pattern analysis
        if (cycle % 10 === 0 && cycle > 0) {
          global.gc();
          await new Promise(resolve => setTimeout(resolve, 50));

          const postGCMemory = memoryProfiler.getCurrentUsage().heapUsed;
          memoryPattern.push({
            timestamp: Date.now() - startTime,
            memory: postGCMemory,
            operation: 'gc-cleanup',
            growth: postGCMemory - baselineMemory,
          });
        }
      }

      // Analyze growth patterns
      const operationGroups = memoryPattern.reduce(
        (groups, point) => {
          if (!groups[point.operation]) groups[point.operation] = [];
          groups[point.operation].push(point.growth / 1024 / 1024); // Convert to MB
          return groups;
        },
        {} as Record<string, number[]>
      );

      console.log(`Memory Growth Pattern Analysis:`);

      for (const [operation, growths] of Object.entries(operationGroups)) {
        const avgGrowth = growths.reduce((sum, g) => sum + g, 0) / growths.length;
        const maxGrowth = Math.max(...growths);
        const minGrowth = Math.min(...growths);

        console.log(
          `  ${operation}: avg=${avgGrowth.toFixed(2)}MB, range=${minGrowth.toFixed(2)}-${maxGrowth.toFixed(2)}MB (${growths.length} samples)`
        );

        // Validate reasonable growth patterns
        if (operation !== 'gc-cleanup') {
          expect(avgGrowth).toBeLessThan(100); // Average growth <100MB per operation type
        }
      }

      // Check for memory growth correlation with operation complexity
      const smallPRGrowth = operationGroups['small-pr']
        ? operationGroups['small-pr'].reduce((sum, g) => sum + g, 0) /
          operationGroups['small-pr'].length
        : 0;
      const hugePRGrowth = operationGroups['huge-pr']
        ? operationGroups['huge-pr'].reduce((sum, g) => sum + g, 0) /
          operationGroups['huge-pr'].length
        : 0;

      if (smallPRGrowth > 0 && hugePRGrowth > 0) {
        const growthRatio = hugePRGrowth / smallPRGrowth;
        console.log(`  Memory growth ratio (huge/small PR): ${growthRatio.toFixed(2)}x`);

        // Memory usage should correlate somewhat with operation complexity
        expect(growthRatio).toBeGreaterThan(1); // Larger operations should use more memory
        expect(growthRatio).toBeLessThan(20); // But not excessively more
      }

      // Final cleanup and validation
      global.gc();
      await new Promise(resolve => setTimeout(resolve, 200));
      const finalMemory = memoryProfiler.getCurrentUsage().heapUsed;
      const finalGrowthMB = (finalMemory - baselineMemory) / 1024 / 1024;

      console.log(`  Final memory growth after cleanup: ${finalGrowthMB.toFixed(2)}MB`);
      expect(finalGrowthMB).toBeLessThan(50); // Final growth should be reasonable
    });
  });
});
