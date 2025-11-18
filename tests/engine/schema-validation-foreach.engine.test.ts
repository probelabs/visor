import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';

describe('Schema validation for forEach map (script -> script)', () => {
  it('adds schema_validation_failed for invalid per-item outputs and surfaces in summary', async () => {
    const cfg: VisorConfig = {
      version: '1.0',
      output: { pr_comment: { enabled: false } } as any,
      checks: {
        list: {
          type: 'script',
          forEach: true,
          content: 'return [{x:1},{x:"bad"}]',
        },
        mapStep: {
          type: 'script',
          depends_on: ['list'],
          fanout: 'map',
          content: 'return { x: outputs["list"].x };',
          output_schema: {
            type: 'object',
            properties: { x: { type: 'number' } },
            required: ['x'],
            additionalProperties: true,
          },
        },
      },
    } as any;

    const engine = new StateMachineExecutionEngine();
    const res = await engine.executeChecks({ checks: ['list', 'mapStep'], config: cfg, debug: false });
    const issues = (res.reviewSummary.issues || []).filter(i =>
      String(i.ruleId || '').includes('contract/schema_validation_failed') && i.checkName === 'mapStep'
    );
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

