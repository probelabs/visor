import { CheckExecutionEngine } from '../../src/check-execution-engine';
import type { VisorConfig } from '../../src/types/config';

describe('depends_on OR-groups (pipe syntax)', () => {
  let engine: CheckExecutionEngine;

  beforeEach(() => {
    engine = new CheckExecutionEngine();
  });

  it.skip('runs dependent when any member of an OR group succeeds', async () => {
    // TODO: Enable after executionStatistics exposes all requested checks reliably.
    // Current engine returns a minimal stats set in AnalysisResult when called via executeChecks.
    const config: VisorConfig = {
      version: '1.0',
      checks: {
        a: { type: 'noop', if: 'false' }, // skipped
        b: { type: 'noop' }, // succeeds
        c: { type: 'noop' }, // required ALL-OF dep
        final: { type: 'noop', depends_on: ['a|b', 'c'] },
      },
      output: {
        pr_comment: { format: 'markdown', group_by: 'check', collapse: false },
      },
    };

    const res = await engine.executeChecks({
      checks: ['b', 'c', 'final'],
      config,
      debug: true,
      maxParallelism: 2,
      webhookContext: { eventType: 'manual' } as any,
    });
    const checks = res.executionStatistics!.checks;
    const b = checks.find(s => s.checkName === 'b');
    const c = checks.find(s => s.checkName === 'c');
    const final = checks.find(s => s.checkName === 'final');
    // Expect final to execute because b+c satisfied dependencies
    expect(b && b.skipped === false).toBe(true);
    expect(c && c.skipped === false).toBe(true);
    expect(final && final.skipped === false).toBe(true);
  });

  it.skip('skips dependent when none of the OR members succeed', async () => {
    // TODO: Enable after executionStatistics exposes all requested checks reliably.
    const config: VisorConfig = {
      version: '1.0',
      checks: {
        a: { type: 'noop', if: 'false' },
        b: { type: 'noop', if: 'false' },
        c: { type: 'noop' },
        final: { type: 'noop', depends_on: ['a|b', 'c'] },
      },
      output: {
        pr_comment: { format: 'markdown', group_by: 'check', collapse: false },
      },
    };

    const res = await engine.executeChecks({
      checks: ['c', 'final'],
      config,
      debug: true,
      maxParallelism: 2,
      webhookContext: { eventType: 'manual' } as any,
    });
    const checks = res.executionStatistics!.checks;
    const c = checks.find(s => s.checkName === 'c');
    const final = checks.find(s => s.checkName === 'final');
    // a|b unsatisfied → final should be skipped by dependency gating; c still executes
    expect(c && c.skipped === false).toBe(true);
    expect(final && final.skipped === true).toBe(true);
    expect(final?.skipReason).toBe('dependency_failed');
  });
});
