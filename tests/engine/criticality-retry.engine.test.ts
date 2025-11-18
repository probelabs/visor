import { describe, it, expect } from '@jest/globals';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';

describe('Engine: criticality mapping for on_fail.retry', () => {
  it("suppresses retry on logical failure when criticality is 'external'", async () => {
    const config: VisorConfig = {
      version: '1.0',
      checks: {
        step: {
          type: 'log',
          message: 'hello',
          level: 'info',
          // Force a logical failure via fail_if
          fail_if: 'true',
          criticality: 'external',
          on_fail: {
            retry: { max: 3 },
          },
        },
      },
      output: { format: 'json' },
    } as any;

    const engine = new StateMachineExecutionEngine();
    const result = await engine.executeChecks({ checks: ['step'], config, debug: false });
    const st = (result.executionStatistics?.checks || []).find(s => s.checkName === 'step');
    expect(st?.totalRuns).toBe(1); // initial run only, retries suppressed
    expect(st?.successfulRuns || 0).toBe(0);
    expect(st?.failedRuns || 0).toBeGreaterThanOrEqual(1);
  });
});
