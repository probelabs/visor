import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';

describe('Liquid template extensions in LevelDispatch', () => {
  it('renders template with custom filters (safe_label) using createExtendedLiquid', async () => {
    const engine = new StateMachineExecutionEngine();

    const cfg: VisorConfig = {
      version: '1.0',
      checks: {
        tmpl: {
          type: 'log',
          message: 'hello',
          // Use filter provided by createExtendedLiquid to prove we are not using raw Liquid
          template: { content: "{{ 'foo@bar' | safe_label }}" },
          group: 'default',
        },
      },
    } as any;

    const prInfo: any = {
      number: 0,
      title: 't',
      author: 'a',
      base: 'main',
      head: 'branch',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      eventType: 'manual',
    };

    const { results } = await engine.executeGroupedChecks(
      prInfo,
      ['tmpl'],
      undefined,
      cfg,
      'table',
      false
    );

    const group = results['default'];
    expect(Array.isArray(group)).toBe(true);
    expect(group![0].content).toContain('foobar'); // '@' removed by safe_label
  });
});
