import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';

describe('assume: optional chaining and nullish coalescing', () => {
  it('runs when (outputs[dep]?.x?.length ?? 0) > 0 is true', async () => {
    const cfg: VisorConfig = {
      version: '1.0',
      output: { pr_comment: { enabled: false } } as any,
      checks: {
        dep: { type: 'script', content: 'return { x: ["y"] };' } as any,
        a: {
          type: 'script',
          depends_on: ['dep'],
          assume: "(outputs['dep']?.x?.length ?? 0) > 0",
          content: 'return { ok: true };',
        } as any,
      },
    } as any;

    const engine = new StateMachineExecutionEngine();
    const res = await engine.executeChecks({ checks: ['dep', 'a'], config: cfg, debug: false });
    const byName: Record<string, any> = {};
    for (const s of (res.executionStatistics?.checks || [])) byName[s.checkName] = s;
    expect(byName['a']?.totalRuns).toBe(1);
  });

  it('skips when expression evaluates to 0', async () => {
    const cfg: VisorConfig = {
      version: '1.0',
      output: { pr_comment: { enabled: false } } as any,
      checks: {
        dep: { type: 'script', content: 'return { };' } as any,
        a: {
          type: 'script',
          depends_on: ['dep'],
          assume: "(outputs['dep']?.x?.length ?? 0) > 0",
          content: 'return { ok: true };',
        } as any,
      },
    } as any;

    const engine = new StateMachineExecutionEngine();
    const res = await engine.executeChecks({ checks: ['dep', 'a'], config: cfg, debug: false });
    const byName: Record<string, any> = {};
    for (const s of (res.executionStatistics?.checks || [])) byName[s.checkName] = s;
    // totalRuns stays undefined or 0 when skipped via assume
    expect((byName['a']?.totalRuns || 0)).toBe(0);
  });
});

