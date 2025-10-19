import { CheckExecutionEngine, CheckExecutionStats } from '../../src/check-execution-engine';
import { VisorConfig } from '../../src/types/config';

describe('Execution Statistics Formatting', () => {
  let engine: CheckExecutionEngine;

  beforeEach(() => {
    engine = new CheckExecutionEngine();
  });

  describe('formatStatusColumn', () => {
    it('should format single successful run', () => {
      const stats: CheckExecutionStats = {
        checkName: 'test',
        totalRuns: 1,
        successfulRuns: 1,
        failedRuns: 0,
        skipped: false,
        totalDuration: 1000,
        issuesFound: 0,
        issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
      };

      const formatted = (engine as any).formatStatusColumn(stats);
      expect(formatted).toBe('✔');
    });

    it('should format multiple successful runs (forEach)', () => {
      const stats: CheckExecutionStats = {
        checkName: 'test',
        totalRuns: 5,
        successfulRuns: 5,
        failedRuns: 0,
        skipped: false,
        totalDuration: 5000,
        issuesFound: 0,
        issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
      };

      const formatted = (engine as any).formatStatusColumn(stats);
      expect(formatted).toBe('✔ ×5');
    });

    it('should format failed runs', () => {
      const stats: CheckExecutionStats = {
        checkName: 'test',
        totalRuns: 3,
        successfulRuns: 0,
        failedRuns: 3,
        skipped: false,
        totalDuration: 3000,
        issuesFound: 0,
        issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
      };

      const formatted = (engine as any).formatStatusColumn(stats);
      expect(formatted).toBe('✖ ×3');
    });

    it('should format partial success (mixed results)', () => {
      const stats: CheckExecutionStats = {
        checkName: 'test',
        totalRuns: 5,
        successfulRuns: 3,
        failedRuns: 2,
        skipped: false,
        totalDuration: 5000,
        issuesFound: 0,
        issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
      };

      const formatted = (engine as any).formatStatusColumn(stats);
      expect(formatted).toBe('✔/✖ 3/5');
    });

    it('should format skipped check with if condition', () => {
      const stats: CheckExecutionStats = {
        checkName: 'test',
        totalRuns: 0,
        successfulRuns: 0,
        failedRuns: 0,
        skipped: true,
        skipReason: 'if_condition',
        totalDuration: 0,
        issuesFound: 0,
        issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
      };

      const formatted = (engine as any).formatStatusColumn(stats);
      expect(formatted).toBe('⏭ if');
    });

    it('should format skipped check with fail-fast', () => {
      const stats: CheckExecutionStats = {
        checkName: 'test',
        totalRuns: 0,
        successfulRuns: 0,
        failedRuns: 0,
        skipped: true,
        skipReason: 'fail_fast',
        totalDuration: 0,
        issuesFound: 0,
        issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
      };

      const formatted = (engine as any).formatStatusColumn(stats);
      expect(formatted).toBe('⏭ ff');
    });

    it('should format skipped check due to dependency failure', () => {
      const stats: CheckExecutionStats = {
        checkName: 'test',
        totalRuns: 0,
        successfulRuns: 0,
        failedRuns: 0,
        skipped: true,
        skipReason: 'dependency_failed',
        totalDuration: 0,
        issuesFound: 0,
        issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
      };

      const formatted = (engine as any).formatStatusColumn(stats);
      expect(formatted).toBe('⏭ dep');
    });
  });

  describe('formatDetailsColumn', () => {
    it('should format outputs produced', () => {
      const stats: CheckExecutionStats = {
        checkName: 'test',
        totalRuns: 1,
        successfulRuns: 1,
        failedRuns: 0,
        skipped: false,
        totalDuration: 1000,
        issuesFound: 0,
        issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        outputsProduced: 5,
      };

      const formatted = (engine as any).formatDetailsColumn(stats);
      expect(formatted).toContain('→5');
    });

    it('should format critical issues', () => {
      const stats: CheckExecutionStats = {
        checkName: 'test',
        totalRuns: 1,
        successfulRuns: 1,
        failedRuns: 0,
        skipped: false,
        totalDuration: 1000,
        issuesFound: 3,
        issuesBySeverity: { critical: 3, error: 0, warning: 0, info: 0 },
      };

      const formatted = (engine as any).formatDetailsColumn(stats);
      expect(formatted).toContain('3🔴');
    });

    it('should format warnings', () => {
      const stats: CheckExecutionStats = {
        checkName: 'test',
        totalRuns: 1,
        successfulRuns: 1,
        failedRuns: 0,
        skipped: false,
        totalDuration: 1000,
        issuesFound: 12,
        issuesBySeverity: { critical: 0, error: 0, warning: 12, info: 0 },
      };

      const formatted = (engine as any).formatDetailsColumn(stats);
      expect(formatted).toContain('12⚠️');
    });

    it('should format info issues only when no critical/warnings', () => {
      const stats: CheckExecutionStats = {
        checkName: 'test',
        totalRuns: 1,
        successfulRuns: 1,
        failedRuns: 0,
        skipped: false,
        totalDuration: 1000,
        issuesFound: 5,
        issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 5 },
      };

      const formatted = (engine as any).formatDetailsColumn(stats);
      expect(formatted).toContain('5💡');
    });

    it('should not format info when warnings exist', () => {
      const stats: CheckExecutionStats = {
        checkName: 'test',
        totalRuns: 1,
        successfulRuns: 1,
        failedRuns: 0,
        skipped: false,
        totalDuration: 1000,
        issuesFound: 7,
        issuesBySeverity: { critical: 0, error: 0, warning: 2, info: 5 },
      };

      const formatted = (engine as any).formatDetailsColumn(stats);
      expect(formatted).toContain('2⚠️');
      expect(formatted).not.toContain('💡');
    });

    it('should format error message', () => {
      const stats: CheckExecutionStats = {
        checkName: 'test',
        totalRuns: 1,
        successfulRuns: 0,
        failedRuns: 1,
        skipped: false,
        totalDuration: 1000,
        issuesFound: 0,
        issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        errorMessage: 'Connection timeout',
      };

      const formatted = (engine as any).formatDetailsColumn(stats);
      expect(formatted).toContain('Connection timeout');
    });

    it('should truncate long error messages', () => {
      const stats: CheckExecutionStats = {
        checkName: 'test',
        totalRuns: 1,
        successfulRuns: 0,
        failedRuns: 1,
        skipped: false,
        totalDuration: 1000,
        issuesFound: 0,
        issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        errorMessage: 'This is a very long error message that should be truncated to fit',
      };

      const formatted = (engine as any).formatDetailsColumn(stats);
      expect(formatted.length).toBeLessThanOrEqual(50); // Reasonable max
      expect(formatted).toContain('...');
    });

    it('should format skip condition', () => {
      const stats: CheckExecutionStats = {
        checkName: 'test',
        totalRuns: 0,
        successfulRuns: 0,
        failedRuns: 0,
        skipped: true,
        skipReason: 'if_condition',
        skipCondition: 'branch == "main"',
        totalDuration: 0,
        issuesFound: 0,
        issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
      };

      const formatted = (engine as any).formatDetailsColumn(stats);
      expect(formatted).toContain('branch == "main"');
    });

    it('should combine multiple details', () => {
      const stats: CheckExecutionStats = {
        checkName: 'test',
        totalRuns: 5,
        successfulRuns: 5,
        failedRuns: 0,
        skipped: false,
        totalDuration: 5000,
        issuesFound: 15,
        issuesBySeverity: { critical: 3, error: 0, warning: 12, info: 0 },
        outputsProduced: 5,
      };

      const formatted = (engine as any).formatDetailsColumn(stats);
      expect(formatted).toContain('→5');
      expect(formatted).toContain('3🔴');
      expect(formatted).toContain('12⚠️');
    });
  });

  describe('truncate', () => {
    it('should not truncate short strings', () => {
      const result = (engine as any).truncate('short', 20);
      expect(result).toBe('short');
    });

    it('should truncate long strings', () => {
      const result = (engine as any).truncate('This is a very long string', 10);
      expect(result).toBe('This is...');
      expect(result.length).toBe(10);
    });

    it('should handle exact length', () => {
      const result = (engine as any).truncate('exactly10!', 10);
      expect(result).toBe('exactly10!');
    });
  });

  describe('buildExecutionStatistics', () => {
    it('should aggregate statistics correctly', async () => {
      // Use a real execution to test buildExecutionStatistics
      const config = {
        version: '1.0' as const,
        checks: {
          check1: {
            type: 'command' as const,
            exec: 'echo "test1"',
          },
          check2: {
            type: 'command' as const,
            exec: 'echo "test2"',
          },
          check3: {
            type: 'command' as const,
            exec: 'exit 1',
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['check1', 'check2', 'check3'],
        config: config as unknown as VisorConfig,
        workingDirectory: process.cwd(),
      });

      const stats = result.executionStatistics;
      expect(stats).toBeDefined();
      expect(stats?.totalChecksConfigured).toBe(3);
      expect(stats?.totalExecutions).toBe(3);
      expect(stats?.successfulExecutions).toBe(2); // check1 and check2 succeed
      expect(stats?.failedExecutions).toBe(1); // check3 fails with exit 1
      expect(stats?.checks!.length).toBe(3);

      // Check3 should have issues from the failed command and be marked as failed
      const check3Stats = stats?.checks!.find(c => c.checkName === 'check3');
      expect(check3Stats?.issuesFound).toBeGreaterThan(0);
      expect(check3Stats?.failedRuns).toBe(1);
      expect(check3Stats?.successfulRuns).toBe(0);
    });
  });
});
