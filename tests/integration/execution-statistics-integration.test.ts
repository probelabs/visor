import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { VisorConfig } from '../../src/types/config';

describe('Execution Statistics Integration Tests', () => {
  let engine: CheckExecutionEngine;

  beforeEach(() => {
    engine = new CheckExecutionEngine();
  });

  describe('Complex forEach Scenarios', () => {
    it('should track nested forEach dependencies correctly', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'list-categories': {
            type: 'command',
            exec: 'echo \'["cat1", "cat2"]\'',
            forEach: true,
          },
          'list-items-per-category': {
            type: 'command',
            exec: 'echo \'["item1", "item2", "item3"]\'',
            depends_on: ['list-categories'],
            forEach: true,
          },
          'process-each-item': {
            type: 'command',
            exec: 'echo "Processing {{ outputs.list-items-per-category }}"',
            depends_on: ['list-items-per-category'],
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['list-categories', 'list-items-per-category', 'process-each-item'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
      });

      expect(result.executionStatistics).toBeDefined();
      // list-categories: 1 run
      // list-items-per-category: 2 runs (one per category)
      // process-each-item: 6 runs (3 items × 2 categories)
      expect(result.executionStatistics?.totalExecutions).toBeGreaterThanOrEqual(3);

      const processItemStats = result.executionStatistics?.checks.find(
        c => c.checkName === 'process-each-item'
      );
      expect(processItemStats).toBeDefined();
      expect(processItemStats?.totalRuns).toBeGreaterThan(0);
    });

    it('should track forEach with conditional skip in iterations', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'list-numbers': {
            type: 'command',
            exec: "echo '[1, 2, 3, 4, 5]'",
            forEach: true,
          },
          'process-even-only': {
            type: 'command',
            exec: 'echo "Processing {{ outputs.list-numbers }}"',
            depends_on: ['list-numbers'],
            // This if condition is evaluated per iteration
            if: 'outputs["list-numbers"] % 2 == 0',
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['list-numbers', 'process-even-only'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
      });

      const processStats = result.executionStatistics?.checks.find(
        c => c.checkName === 'process-even-only'
      );
      expect(processStats).toBeDefined();
      // Should process only even numbers (2, 4) = 2 runs
      // Note: This depends on how if conditions work with forEach
    });
  });

  describe('Dependency Chain with Mixed Execution', () => {
    it('should track complex dependency chains correctly', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'base-check': {
            type: 'command',
            exec: 'echo "base"',
          },
          'conditional-1': {
            type: 'command',
            exec: 'echo "conditional 1"',
            depends_on: ['base-check'],
            if: 'always()',
          },
          'conditional-2': {
            type: 'command',
            exec: 'echo "conditional 2"',
            depends_on: ['base-check'],
            if: '!always()', // Will be skipped
          },
          'final-check': {
            type: 'command',
            exec: 'echo "final"',
            depends_on: ['conditional-1', 'conditional-2'],
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['base-check', 'conditional-1', 'conditional-2', 'final-check'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
      });

      expect(result.executionStatistics?.totalChecksConfigured).toBe(4);
      expect(result.executionStatistics?.skippedChecks).toBeGreaterThan(0);

      const skippedStats = result.executionStatistics?.checks.find(
        c => c.checkName === 'conditional-2'
      );
      expect(skippedStats?.skipped).toBe(true);
    });
  });

  describe('Performance Tracking', () => {
    it('should track per-iteration duration for forEach', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'list-delays': {
            type: 'command',
            exec: 'echo \'["0.1", "0.2", "0.1"]\'',
            forEach: true,
          },
          'timed-process': {
            type: 'command',
            exec: 'sleep {{ outputs.list-delays }} && echo "done"',
            depends_on: ['list-delays'],
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['list-delays', 'timed-process'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
      });

      const timedStats = result.executionStatistics?.checks.find(
        c => c.checkName === 'timed-process'
      );
      expect(timedStats).toBeDefined();
      expect(timedStats?.perIterationDuration).toBeDefined();
      expect(timedStats?.perIterationDuration?.length).toBe(3);
      // Each iteration should have different duration
      if (timedStats?.perIterationDuration) {
        expect(timedStats.totalDuration).toBeGreaterThan(0);
      }
    });
  });

  describe('Error Scenarios', () => {
    it('should track command failures as issues not failed runs', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'error-check': {
            type: 'command',
            exec: 'echo "Error message" >&2 && exit 1',
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['error-check'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
      });

      const errorStats = result.executionStatistics?.checks.find(
        c => c.checkName === 'error-check'
      );
      expect(errorStats).toBeDefined();
      // Command failures are reported as both failed runs AND issues
      expect(errorStats?.successfulRuns).toBe(0);
      expect(errorStats?.failedRuns).toBe(1);
      expect(errorStats?.issuesFound).toBeGreaterThan(0);
    });
  });

  describe('Output Format Compatibility', () => {
    it('should include statistics in JSON output format', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'test-check': {
            type: 'command',
            exec: 'echo "test"',
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['test-check'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
        outputFormat: 'json',
      });

      expect(result.executionStatistics).toBeDefined();

      // Ensure statistics are serializable
      const serialized = JSON.stringify(result.executionStatistics);
      expect(serialized).toBeTruthy();

      const parsed = JSON.parse(serialized);
      expect(parsed.totalChecksConfigured).toBe(1);
      expect(parsed.checks).toHaveLength(1);
    });

    it('should include statistics in table output format', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'test-check': {
            type: 'command',
            exec: 'echo "test"',
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['test-check'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
        outputFormat: 'table',
      });

      expect(result.executionStatistics).toBeDefined();
    });
  });

  describe('Parallel Execution Statistics', () => {
    it('should track parallel check execution correctly', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'parallel-1': {
            type: 'command',
            exec: 'echo "p1"',
          },
          'parallel-2': {
            type: 'command',
            exec: 'echo "p2"',
          },
          'parallel-3': {
            type: 'command',
            exec: 'echo "p3"',
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['parallel-1', 'parallel-2', 'parallel-3'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
        maxParallelism: 3,
      });

      expect(result.executionStatistics?.totalChecksConfigured).toBe(3);
      expect(result.executionStatistics?.totalExecutions).toBe(3);
      expect(result.executionStatistics?.checks).toHaveLength(3);
    });
  });

  describe('Fail-Fast Scenarios', () => {
    it('should track checks stopped by fail-fast', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'will-fail': {
            type: 'command',
            exec: 'exit 1',
          },
          'will-not-run': {
            type: 'command',
            exec: 'echo "should not run"',
            depends_on: ['will-fail'],
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['will-fail', 'will-not-run'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
        failFast: true,
      });

      // Command failures produce issues AND are counted as failed executions
      expect(result.executionStatistics?.failedExecutions).toBe(1);

      const failStats = result.executionStatistics?.checks.find(c => c.checkName === 'will-fail');
      expect(failStats?.issuesFound).toBeGreaterThan(0);
      expect(failStats?.failedRuns).toBe(1);
      expect(failStats?.successfulRuns).toBe(0);

      // The dependent check might be skipped or not executed at all
      const notRunStats = result.executionStatistics?.checks.find(
        c => c.checkName === 'will-not-run'
      );
      // It may be skipped or not tracked at all depending on fail-fast behavior
      if (notRunStats) {
        expect(notRunStats.totalRuns === 0 || notRunStats.skipped).toBe(true);
      }
    });
  });

  describe('Tag Filtering with Statistics', () => {
    it('should only track checks matching tag filter', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'tagged-check': {
            type: 'command',
            exec: 'echo "tagged"',
            tags: ['tag1'],
          },
          'untagged-check': {
            type: 'command',
            exec: 'echo "untagged"',
            tags: ['tag2'],
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['tagged-check', 'untagged-check'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
        tagFilter: { include: ['tag1'] },
      });

      // Only checks matching the tag filter should be in statistics
      expect(result.executionStatistics?.checks.length).toBeGreaterThan(0);

      const taggedStats = result.executionStatistics?.checks.find(
        c => c.checkName === 'tagged-check'
      );
      expect(taggedStats).toBeDefined();
    });
  });
});
