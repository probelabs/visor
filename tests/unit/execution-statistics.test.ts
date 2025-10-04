import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { VisorConfig } from '../../src/types/config';

describe('Execution Statistics', () => {
  let engine: CheckExecutionEngine;

  beforeEach(() => {
    engine = new CheckExecutionEngine();
  });

  describe('Statistics Tracking', () => {
    it('should track single check execution', async () => {
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
      });

      expect(result.executionStatistics).toBeDefined();
      expect(result.executionStatistics?.totalChecksConfigured).toBe(1);
      expect(result.executionStatistics?.totalExecutions).toBe(1);
      expect(result.executionStatistics?.successfulExecutions).toBe(1);
      expect(result.executionStatistics?.failedExecutions).toBe(0);
      expect(result.executionStatistics?.skippedChecks).toBe(0);

      const checkStats = result.executionStatistics?.checks.find(c => c.checkName === 'test-check');
      expect(checkStats).toBeDefined();
      expect(checkStats?.totalRuns).toBe(1);
      expect(checkStats?.successfulRuns).toBe(1);
      expect(checkStats?.failedRuns).toBe(0);
      expect(checkStats?.skipped).toBe(false);
    });

    it('should track forEach check execution', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'list-items': {
            type: 'command',
            exec: 'echo \'["item1", "item2", "item3"]\'',
            forEach: true,
          },
          'process-item': {
            type: 'command',
            exec: 'echo "Processing {{ outputs.list-items }}"',
            depends_on: ['list-items'],
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['list-items', 'process-item'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
      });

      expect(result.executionStatistics).toBeDefined();
      expect(result.executionStatistics?.totalChecksConfigured).toBe(2);
      // list-items runs once, process-item runs 3 times (forEach)
      expect(result.executionStatistics?.totalExecutions).toBe(4);

      const processItemStats = result.executionStatistics?.checks.find(
        c => c.checkName === 'process-item'
      );
      expect(processItemStats).toBeDefined();
      expect(processItemStats?.totalRuns).toBe(3);
      expect(processItemStats?.perIterationDuration).toHaveLength(3);
    });

    it('should track skipped checks with if condition', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'conditional-check': {
            type: 'command',
            exec: 'echo "test"',
            if: 'always() && !always()', // Always false
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['conditional-check'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
      });

      expect(result.executionStatistics).toBeDefined();
      expect(result.executionStatistics?.totalChecksConfigured).toBe(1);
      expect(result.executionStatistics?.totalExecutions).toBe(0);
      expect(result.executionStatistics?.skippedChecks).toBe(1);

      const checkStats = result.executionStatistics?.checks.find(
        c => c.checkName === 'conditional-check'
      );
      expect(checkStats).toBeDefined();
      expect(checkStats?.skipped).toBe(true);
      expect(checkStats?.skipReason).toBe('if_condition');
      expect(checkStats?.skipCondition).toContain('always()');
    });

    it('should track command failures as issues not failed runs', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'failing-check': {
            type: 'command',
            exec: 'exit 1',
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['failing-check'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
      });

      expect(result.executionStatistics).toBeDefined();
      // Command failures are reported as issues, not failed executions
      expect(result.executionStatistics?.successfulExecutions).toBe(1);
      expect(result.executionStatistics?.failedExecutions).toBe(0);

      const checkStats = result.executionStatistics?.checks.find(
        c => c.checkName === 'failing-check'
      );
      expect(checkStats).toBeDefined();
      expect(checkStats?.successfulRuns).toBe(1);
      expect(checkStats?.failedRuns).toBe(0);
      expect(checkStats?.issuesFound).toBeGreaterThan(0);
    });

    it('should track outputs produced', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'output-check': {
            type: 'command',
            exec: 'echo \'["a", "b", "c"]\'',
            forEach: true,
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['output-check'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
      });

      const checkStats = result.executionStatistics?.checks.find(
        c => c.checkName === 'output-check'
      );
      expect(checkStats).toBeDefined();
      expect(checkStats?.outputsProduced).toBe(1);
    });

    it('should track execution duration', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'timed-check': {
            type: 'command',
            exec: 'sleep 0.1 && echo "done"',
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['timed-check'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
      });

      const checkStats = result.executionStatistics?.checks.find(
        c => c.checkName === 'timed-check'
      );
      expect(checkStats).toBeDefined();
      expect(checkStats?.totalDuration).toBeGreaterThan(0);
    });

    it('should track multiple checks with different outcomes', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'success-check': {
            type: 'command',
            exec: 'echo "success"',
          },
          'skip-check': {
            type: 'command',
            exec: 'echo "skip"',
            if: '!always()',
          },
          'fail-check': {
            type: 'command',
            exec: 'exit 1',
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['success-check', 'skip-check', 'fail-check'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
      });

      expect(result.executionStatistics).toBeDefined();
      expect(result.executionStatistics?.totalChecksConfigured).toBe(3);
      expect(result.executionStatistics?.successfulExecutions).toBe(2); // success-check and fail-check both succeed
      expect(result.executionStatistics?.failedExecutions).toBe(0); // Command failures are issues, not failed executions
      expect(result.executionStatistics?.skippedChecks).toBeGreaterThan(0);

      // fail-check should have issues
      const failStats = result.executionStatistics?.checks.find(c => c.checkName === 'fail-check');
      expect(failStats?.issuesFound).toBeGreaterThan(0);
    });
  });

  describe('Statistics in JSON Output', () => {
    it('should include execution statistics in JSON output', async () => {
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
      expect(result.executionStatistics?.checks).toHaveLength(1);
    });
  });

  describe('forEach Preview', () => {
    it('should store preview of forEach items', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'list-many': {
            type: 'command',
            exec: 'echo \'["item1", "item2", "item3", "item4", "item5", "item6"]\'',
            forEach: true,
          },
          'process-many': {
            type: 'command',
            exec: 'echo "{{ outputs.list-many }}"',
            depends_on: ['list-many'],
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['list-many', 'process-many'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
      });

      const checkStats = result.executionStatistics?.checks.find(
        c => c.checkName === 'process-many'
      );
      expect(checkStats).toBeDefined();
      expect(checkStats?.forEachPreview).toBeDefined();
      // Should show first 3 items + "...N more"
      expect(checkStats?.forEachPreview).toContain('...3 more');
    });
  });

  describe('Issue Severity Tracking', () => {
    it('should track issues by severity when using code-review schema', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'review-check': {
            type: 'command',
            exec: 'echo "test"',
            schema: 'code-review',
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['review-check'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
      });

      const checkStats = result.executionStatistics?.checks.find(
        c => c.checkName === 'review-check'
      );
      expect(checkStats).toBeDefined();
      expect(checkStats?.issuesBySeverity).toBeDefined();
      expect(checkStats?.issuesBySeverity.critical).toBeDefined();
      expect(checkStats?.issuesBySeverity.error).toBeDefined();
      expect(checkStats?.issuesBySeverity.warning).toBeDefined();
      expect(checkStats?.issuesBySeverity.info).toBeDefined();
    });
  });

  describe('Partial forEach Success/Failure', () => {
    it('should track partial forEach success when some iterations fail', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'list-items': {
            type: 'command',
            exec: 'echo \'["item1", "item2", "item3"]\'',
            forEach: true,
          },
          'process-with-failures': {
            type: 'command',
            // This will fail on certain items based on content
            exec: 'test "{{ outputs.list-items }}" != "item2" && echo "ok" || exit 1',
            depends_on: ['list-items'],
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['list-items', 'process-with-failures'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
      });

      const checkStats = result.executionStatistics?.checks.find(
        c => c.checkName === 'process-with-failures'
      );
      expect(checkStats).toBeDefined();
      expect(checkStats?.totalRuns).toBe(3);
      // Some should succeed, some should fail
      if (checkStats) {
        expect(checkStats.successfulRuns + checkStats.failedRuns).toBe(checkStats.totalRuns);
      }
    });
  });
});
