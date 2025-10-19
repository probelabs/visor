import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { VisorConfig } from '../../src/types/config';

describe('forEach Failure and Dependency Skip', () => {
  let engine: CheckExecutionEngine;

  beforeEach(() => {
    engine = new CheckExecutionEngine();
  });

  describe('forEach iteration error handling', () => {
    it('should continue processing remaining forEach items when one fails', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'list-items': {
            type: 'command',
            exec: 'echo \'["item1", "item2", "item3"]\'',
            forEach: true,
          },
          'process-items': {
            type: 'command',
            // Fail on item2
            exec: 'if [ "{{ outputs.list-items }}" = "item2" ]; then exit 1; else echo "processed: {{ outputs.list-items }}"; fi',
            depends_on: ['list-items'],
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['list-items', 'process-items'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
      });

      // Should have issues with command execution errors
      const allIssues = result.reviewSummary.issues || [];
      const commandErrors = allIssues.filter((issue: any) =>
        issue.ruleId?.includes('command/execution_error')
      );
      expect(commandErrors.length).toBeGreaterThan(0);

      // Check execution stats - should show partial success
      const processStats = result.executionStatistics?.checks!.find(
        c => c.checkName === 'process-items'
      );
      expect(processStats).toBeDefined();
      expect(processStats?.totalRuns).toBe(3); // Attempted all 3 items
      // At least one should fail (item2) and at least one should succeed
      expect(processStats?.failedRuns).toBeGreaterThan(0);
      expect(processStats?.successfulRuns).toBeGreaterThan(0);
    });

    it('should not throw when forEach iteration fails', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'list-items': {
            type: 'command',
            exec: 'echo \'["item1", "item2"]\'',
            forEach: true,
          },
          'failing-process': {
            type: 'command',
            exec: 'exit 1', // Always fail
            depends_on: ['list-items'],
          },
        },
      };

      // This should not throw even though all iterations fail
      await expect(
        engine.executeChecks({
          checks: ['list-items', 'failing-process'],
          config: config as VisorConfig,
          workingDirectory: process.cwd(),
        })
      ).resolves.toBeDefined();
    });
  });

  describe('dependency skip on forEach failure', () => {
    it('should skip dependent checks when forEach check fails', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'list-items': {
            type: 'command',
            exec: 'echo \'["item1", "item2"]\'',
            forEach: true,
          },
          'failing-foreach': {
            type: 'command',
            exec: 'exit 1', // Always fail
            depends_on: ['list-items'],
          },
          'dependent-check': {
            type: 'command',
            exec: 'echo "should be skipped"',
            depends_on: ['failing-foreach'],
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['list-items', 'failing-foreach', 'dependent-check'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
      });

      // failing-foreach should have command execution errors
      const allIssues = result.reviewSummary.issues || [];
      const hasExecutionError = allIssues.some((issue: any) =>
        issue.ruleId?.includes('command/execution_error')
      );
      expect(hasExecutionError).toBe(true);

      // dependent-check should be skipped
      const stats = result.executionStatistics?.checks!.find(
        c => c.checkName === 'dependent-check'
      );
      expect(stats?.skipped).toBe(true);
      expect(stats?.skipReason).toBe('dependency_failed');
    });

    it('should not skip dependent checks when forEach check succeeds', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'list-items': {
            type: 'command',
            exec: 'echo \'["item1", "item2"]\'',
            forEach: true,
          },
          'succeeding-foreach': {
            type: 'command',
            exec: 'echo "success: {{ outputs.list-items }}"',
            depends_on: ['list-items'],
          },
          'dependent-check': {
            type: 'command',
            exec: 'echo "should run"',
            depends_on: ['succeeding-foreach'],
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['list-items', 'succeeding-foreach', 'dependent-check'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
      });

      // succeeding-foreach should have no command execution errors
      const allIssues = result.reviewSummary.issues || [];
      const hasExecutionError = allIssues.some((issue: any) =>
        issue.ruleId?.includes('command/execution_error')
      );
      expect(hasExecutionError).toBe(false);

      // dependent-check should NOT be skipped
      const stats = result.executionStatistics?.checks!.find(
        c => c.checkName === 'dependent-check'
      );
      expect(stats?.skipped).toBe(false);
    });

    it('should continue dependent checks for successful branches when forEach partially fails', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'list-items': {
            type: 'command',
            exec: 'echo \'["item1", "item2", "item3"]\'',
            forEach: true,
          },
          'partial-fail-foreach': {
            type: 'command',
            // Fail on item2, succeed on others
            exec: 'if [ "{{ outputs.list-items }}" = "item2" ]; then exit 1; else echo "ok"; fi',
            depends_on: ['list-items'],
          },
          'dependent-check': {
            type: 'command',
            exec: 'echo "dependent ran for: {{ outputs["partial-fail-foreach"].item | default: outputs["partial-fail-foreach"] }}"',
            depends_on: ['partial-fail-foreach'],
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['list-items', 'partial-fail-foreach', 'dependent-check'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
      });

      // partial-fail-foreach should have command execution errors
      const allIssues = result.reviewSummary.issues || [];
      const hasExecutionError = allIssues.some((issue: any) =>
        issue.ruleId?.includes('command/execution_error')
      );
      expect(hasExecutionError).toBe(true);

      // dependent-check should NOT be skipped; it should execute for the successful items (item1 and item3)
      const stats = result.executionStatistics?.checks!.find(
        c => c.checkName === 'dependent-check'
      );
      expect(stats?.skipped).toBe(false);
      expect(stats?.totalRuns || 0).toBeGreaterThanOrEqual(2);
    });
  });

  describe('forEach failure with nested dependencies', () => {
    it('should cascade skip through multiple levels when forEach fails', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'list-items': {
            type: 'command',
            exec: 'echo \'["item1"]\'',
            forEach: true,
          },
          'failing-foreach': {
            type: 'command',
            exec: 'exit 1',
            depends_on: ['list-items'],
          },
          'level-2-check': {
            type: 'command',
            exec: 'echo "level 2"',
            depends_on: ['failing-foreach'],
          },
          'level-3-check': {
            type: 'command',
            exec: 'echo "level 3"',
            depends_on: ['level-2-check'],
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['list-items', 'failing-foreach', 'level-2-check', 'level-3-check'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
      });

      // level-2-check should be skipped
      const level2Stats = result.executionStatistics?.checks!.find(
        c => c.checkName === 'level-2-check'
      );
      expect(level2Stats?.skipped).toBe(true);

      // level-3-check should also be skipped
      const level3Stats = result.executionStatistics?.checks!.find(
        c => c.checkName === 'level-3-check'
      );
      expect(level3Stats?.skipped).toBe(true);
    });
  });
});
