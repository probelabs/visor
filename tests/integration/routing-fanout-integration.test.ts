import { CheckExecutionEngine } from '../../src/check-execution-engine';
import type { VisorConfig } from '../../src/types/config';

describe('Routing fanout (map) vs reduce', () => {
  it('on_success.run respects fanout: map (per-item) and reduce (single)', async () => {
    const cfg: VisorConfig = {
      version: '2.0',
      checks: {
        list: {
          type: 'command',
          exec: 'echo \'["a","b","c"]\'',
          forEach: true,
          on_success: {
            run: ['per-item', 'aggregate'],
          },
        },
        'per-item': {
          type: 'log',
          fanout: 'map',
          message: 'item: {{ outputs["list"] }}',
        },
        aggregate: {
          type: 'script',
          fanout: 'reduce',
          content: 'return { n: (outputs_raw["list"]||[]).length }',
        },
      },
    } as any;

    const engine = new CheckExecutionEngine(process.cwd());
    const res = await engine.executeChecks({
      checks: ['list'],
      config: cfg,
      workingDirectory: process.cwd(),
      eventType: 'manual',
    } as any);

    const stats = res.executionStatistics?.checks || [];
    const perItem = stats.find(c => c.checkName === 'per-item');
    const aggregate = stats.find(c => c.checkName === 'aggregate');
    expect(perItem?.totalRuns).toBe(3);
    expect(aggregate?.totalRuns).toBe(1);
  });
});
