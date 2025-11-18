import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';

describe('Criticality integration: non-critical continues despite failure', () => {
  it('dependent runs when dependency is non-critical and fails logically', async () => {
    const cfg: VisorConfig = {
      version: '1.0',
      output: { format: 'json' },
      checks: {
        a: {
          type: 'log',
          message: 'A running',
          level: 'info',
          fail_if: 'true', // logical failure
          criticality: 'non-critical',
        },
        b: {
          type: 'log',
          message: 'B should still run',
          level: 'info',
          depends_on: ['a'],
        },
      },
    } as any;

    const engine = new StateMachineExecutionEngine();
    const res = await engine.executeChecks({ checks: ['a', 'b'], config: cfg, debug: false });
    const stats = res.executionStatistics?.checks || [];
    const by = Object.fromEntries(stats.map(s => [s.checkName, s]));

    expect(by['a']?.totalRuns).toBe(1);
    expect((by['a']?.failedRuns || 0)).toBeGreaterThanOrEqual(1);
    // non-critical should allow dependent b to run
    expect(by['b']?.totalRuns).toBe(1);
  });
});

