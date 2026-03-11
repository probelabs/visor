import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';

describe('assume: boolean coercion from YAML', () => {
  it('runs when assume is boolean true (YAML unquoted true)', async () => {
    const cfg: VisorConfig = {
      version: '1.0',
      output: { pr_comment: { enabled: false } } as any,
      checks: {
        a: {
          type: 'script',
          // YAML `assume: [true]` (unquoted) produces boolean true, not string "true"
          assume: [true as any],
          content: 'return { ok: true };',
        } as any,
      },
    } as any;

    const engine = new StateMachineExecutionEngine();
    const res = await engine.executeChecks({ checks: ['a'], config: cfg, debug: false });
    const byName: Record<string, any> = {};
    for (const s of res.executionStatistics?.checks || []) byName[s.checkName] = s;
    expect(byName['a']?.totalRuns).toBe(1);
  });

  it('skips when assume is boolean false', async () => {
    const cfg: VisorConfig = {
      version: '1.0',
      output: { pr_comment: { enabled: false } } as any,
      checks: {
        a: {
          type: 'script',
          // YAML `assume: [false]` (unquoted) produces boolean false
          assume: [false as any],
          content: 'return { ok: true };',
        } as any,
      },
    } as any;

    const engine = new StateMachineExecutionEngine();
    const res = await engine.executeChecks({ checks: ['a'], config: cfg, debug: false });
    const byName: Record<string, any> = {};
    for (const s of res.executionStatistics?.checks || []) byName[s.checkName] = s;
    expect(byName['a']?.totalRuns || 0).toBe(0);
    expect(byName['a']?.skipped).toBe(true);
  });

  it('runs when assume is string "true" (YAML quoted)', async () => {
    const cfg: VisorConfig = {
      version: '1.0',
      output: { pr_comment: { enabled: false } } as any,
      checks: {
        a: {
          type: 'script',
          assume: ['true'],
          content: 'return { ok: true };',
        } as any,
      },
    } as any;

    const engine = new StateMachineExecutionEngine();
    const res = await engine.executeChecks({ checks: ['a'], config: cfg, debug: false });
    const byName: Record<string, any> = {};
    for (const s of res.executionStatistics?.checks || []) byName[s.checkName] = s;
    expect(byName['a']?.totalRuns).toBe(1);
  });

  it('runs when assume is a single boolean true (not array)', async () => {
    const cfg: VisorConfig = {
      version: '1.0',
      output: { pr_comment: { enabled: false } } as any,
      checks: {
        a: {
          type: 'script',
          // YAML `assume: true` (scalar, not array) produces boolean true
          assume: true as any,
          content: 'return { ok: true };',
        } as any,
      },
    } as any;

    const engine = new StateMachineExecutionEngine();
    const res = await engine.executeChecks({ checks: ['a'], config: cfg, debug: false });
    const byName: Record<string, any> = {};
    for (const s of res.executionStatistics?.checks || []) byName[s.checkName] = s;
    expect(byName['a']?.totalRuns).toBe(1);
  });
});
