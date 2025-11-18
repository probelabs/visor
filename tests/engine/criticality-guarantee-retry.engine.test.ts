import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';

describe('Engine: guarantee + retry across criticality modes', () => {
  const baseCfg: Partial<VisorConfig> = {
    version: '1.0',
    output: { pr_comment: { enabled: false } } as any,
  };

  const makeCheck = (criticality?: 'external' | 'internal' | 'policy' | 'info') => ({
    type: 'script',
    content: 'return { ok: false };',
    // Logical failure (policy violation)
    fail_if: 'true',
    on_fail: { retry: { max: 2 } },
    ...(criticality ? { criticality } : {}),
  });

  it('policy: retries are honored for logical failure (fail_if)', async () => {
    const cfg = {
      ...baseCfg,
      checks: { p: makeCheck('policy' as any) },
    } as VisorConfig;
    const engine = new StateMachineExecutionEngine();
    const res = await engine.executeChecks({ checks: ['p'], config: cfg, debug: false });
    const st = (res.executionStatistics?.checks || []).find(s => s.checkName === 'p');
    expect(st?.totalRuns || 0).toBeGreaterThan(1); // retries occurred
  });

  it('internal: retries suppressed for logical failure', async () => {
    const cfg = {
      ...baseCfg,
      checks: { c: makeCheck('internal') },
    } as VisorConfig;
    const engine = new StateMachineExecutionEngine();
    const res = await engine.executeChecks({ checks: ['c'], config: cfg, debug: false });
    const st = (res.executionStatistics?.checks || []).find(s => s.checkName === 'c');
    expect(st?.totalRuns).toBe(1);
  });

  it('external: retries suppressed for logical failure', async () => {
    const cfg = {
      ...baseCfg,
      checks: { e: makeCheck('external') },
    } as VisorConfig;
    const engine = new StateMachineExecutionEngine();
    const res = await engine.executeChecks({ checks: ['e'], config: cfg, debug: false });
    const st = (res.executionStatistics?.checks || []).find(s => s.checkName === 'e');
    expect(st?.totalRuns).toBe(1);
  });
});
