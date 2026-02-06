import { CheckExecutionEngine } from '../../src/check-execution-engine';
import type { VisorConfig } from '../../src/types/config';

describe('reuse_ai_session with OR parent token', () => {
  it.skip('executes child with reuse_ai_session=true and depends_on="a|b" when one parent ran', async () => {
    // TODO: Enable after executionStatistics exposes all requested checks reliably.
    const engine = new CheckExecutionEngine();
    const config: VisorConfig = {
      version: '1.0',
      checks: {
        a: { type: 'noop' },
        b: { type: 'noop', if: 'false' },
        child: {
          type: 'noop',
          depends_on: ['a|b'],
          reuse_ai_session: true,
        },
      },
      output: {
        pr_comment: { format: 'markdown', group_by: 'check', collapse: false },
      },
    };

    const res = await engine.executeChecks({
      checks: ['a', 'child'],
      config,
      debug: true,
      maxParallelism: 3,
      webhookContext: { eventType: 'manual' } as any,
    });
    const checks = res.executionStatistics!.checks;
    const a = checks.find(s => s.checkName === 'a');
    const child = checks.find(s => s.checkName === 'child');
    // Both the satisfied parent and the child should execute; no crash
    expect(a && a.skipped === false).toBe(true);
    expect(child && child.skipped === false).toBe(true);
  });
});
