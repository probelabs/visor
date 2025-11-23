import { describe, it, expect } from '@jest/globals';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';

describe('Engine: awaiting human input halts downstream execution', () => {
  it('does not execute dependents when a check reports awaitingHumanInput', async () => {
    const cfg: VisorConfig = {
      version: '1.0',
      // Disable PR comment output for test runs
      output: { format: 'json' } as any,
      checks: {
        // Simulate a human-input style check that pauses the run
        ask: {
          type: 'script',
          // Script provider will wrap this object under result.output; the engine
          // detects output.awaitingHumanInput === true and marks the run as paused.
          content: 'return { awaitingHumanInput: true };',
        },
        // Dependent check that MUST NOT run once ask has entered awaiting state
        next: {
          type: 'log',
          depends_on: ['ask'],
          message: 'should not execute when awaiting human input',
        },
      },
    } as any;

    const engine = new StateMachineExecutionEngine();
    const res = await engine.executeChecks({
      checks: ['ask', 'next'],
      config: cfg,
      debug: false,
    });

    const stats = res.executionStatistics?.checks || [];
    const byName: Record<string, any> = {};
    for (const s of stats) byName[s.checkName] = s;

    // ask should have a single execution recorded
    expect(byName['ask']).toBeDefined();
    expect(byName['ask'].totalRuns).toBeGreaterThanOrEqual(1);

    // next must never execute once the engine enters awaitingHumanInput mode
    expect(byName['next']).toBeUndefined();
  });
});
