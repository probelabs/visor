import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { VisorConfig } from '../../src/types/config';

describe('Command Check Failure Detection', () => {
  let engine: CheckExecutionEngine;

  beforeEach(() => {
    engine = new CheckExecutionEngine();
  });

  describe('Non-forEach command failures', () => {
    it('should detect command execution failures and skip dependent checks', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'failing-command': {
            type: 'command',
            exec: 'exit 1', // This will fail
          },
          'dependent-check': {
            type: 'command',
            exec: 'echo "should be skipped"',
            depends_on: ['failing-command'],
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['failing-command', 'dependent-check'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
      });

      // failing-command should have execution error (enriched with checkName prefix)
      const allIssues = result.reviewSummary.issues || [];
      const hasExecutionError = allIssues.some((issue: any) =>
        issue.ruleId?.endsWith('/command/execution_error')
      );
      expect(hasExecutionError).toBe(true);

      // dependent-check should be skipped
      const stats = result.executionStatistics?.checks!.find(
        c => c.checkName === 'dependent-check'
      );
      expect(stats?.skipped).toBe(true);
      expect(stats?.skipReason).toBe('dependency_failed');
    });

    it('should treat command timeouts as execution failures and skip dependents', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'timeout-command': {
            type: 'command',
            exec: 'node -e "setTimeout(()=>{}, 10000)"',
            timeout: 50,
          },
          'dependent-check': {
            type: 'command',
            exec: 'echo "should be skipped"',
            depends_on: ['timeout-command'],
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['timeout-command', 'dependent-check'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
      });

      const allIssues = result.reviewSummary.issues || [];
      const hasTimeoutError = allIssues.some((issue: any) =>
        issue.ruleId?.endsWith('/command/timeout')
      );
      expect(hasTimeoutError).toBe(true);

      const stats = result.executionStatistics?.checks!.find(
        c => c.checkName === 'dependent-check'
      );
      expect(stats?.skipped).toBe(true);
      expect(stats?.skipReason).toBe('dependency_failed');
    });

    it('should not skip dependent checks when command succeeds', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'succeeding-command': {
            type: 'command',
            exec: 'echo "success"',
          },
          'dependent-check': {
            type: 'command',
            exec: 'echo "should run"',
            depends_on: ['succeeding-command'],
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['succeeding-command', 'dependent-check'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
      });

      // succeeding-command should have no execution errors
      const allIssues = result.reviewSummary.issues || [];
      const hasExecutionError = allIssues.some(
        (issue: any) => issue.ruleId === 'command/execution_error'
      );
      expect(hasExecutionError).toBe(false);

      // dependent-check should NOT be skipped
      const stats = result.executionStatistics?.checks!.find(
        c => c.checkName === 'dependent-check'
      );
      expect(stats?.skipped).toBe(false);
    });

    it('should cascade skip through multiple levels on command failure', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'failing-command': {
            type: 'command',
            exec: 'exit 1',
          },
          'level-2': {
            type: 'command',
            exec: 'echo "level 2"',
            depends_on: ['failing-command'],
          },
          'level-3': {
            type: 'command',
            exec: 'echo "level 3"',
            depends_on: ['level-2'],
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['failing-command', 'level-2', 'level-3'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
      });

      // failing-command should have execution error (enriched with checkName prefix)
      const allIssues = result.reviewSummary.issues || [];
      const hasExecutionError = allIssues.some((issue: any) =>
        issue.ruleId?.endsWith('/command/execution_error')
      );
      expect(hasExecutionError).toBe(true);

      // level-2 should be skipped
      const level2Stats = result.executionStatistics?.checks!.find(c => c.checkName === 'level-2');
      expect(level2Stats?.skipped).toBe(true);
      expect(level2Stats?.skipReason).toBe('dependency_failed');

      // level-3 should also be skipped (cascade)
      const level3Stats = result.executionStatistics?.checks!.find(c => c.checkName === 'level-3');
      expect(level3Stats?.skipped).toBe(true);
      expect(level3Stats?.skipReason).toBe('dependency_failed');
    });

    it('should properly mark check as failed in stats when command fails', async () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'failing-command': {
            type: 'command',
            exec: 'exit 1',
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['failing-command'],
        config: config as VisorConfig,
        workingDirectory: process.cwd(),
      });

      const stats = result.executionStatistics?.checks!.find(
        c => c.checkName === 'failing-command'
      );
      expect(stats).toBeDefined();
      expect(stats?.totalRuns).toBe(1);
      expect(stats?.failedRuns).toBe(1);
      expect(stats?.successfulRuns).toBe(0);
    });
  });
});
