import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';

describe('Schema validation (script provider)', () => {
  it('flags schema violations with contract/schema_validation_failed', async () => {
    const cfg: VisorConfig = {
      version: '1.0',
      output: { pr_comment: { enabled: false } } as any,
      checks: {
        s: {
          type: 'script',
          content: 'return { ok: false };',
          output_schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' }, count: { type: 'integer' } },
            required: ['ok', 'count'],
            additionalProperties: true,
          },
        },
      },
    } as any;

    const engine = new StateMachineExecutionEngine();
    const res = await engine.executeChecks({ checks: ['s'], config: cfg, debug: false });
    const issues = (res.reviewSummary.issues || []).filter(i =>
      String(i.ruleId || '').includes('contract/schema_validation_failed')
    );
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it('passes when script output satisfies the schema', async () => {
    const cfg: VisorConfig = {
      version: '1.0',
      output: { pr_comment: { enabled: false } } as any,
      checks: {
        s_ok: {
          type: 'script',
          content: 'return { ok: true, count: 1 };',
          output_schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' }, count: { type: 'integer' } },
            required: ['ok', 'count'],
            additionalProperties: true,
          },
        },
      },
    } as any;

    const engine = new StateMachineExecutionEngine();
    const res = await engine.executeChecks({ checks: ['s_ok'], config: cfg, debug: false });
    const issues = (res.reviewSummary.issues || []).filter(i =>
      String(i.ruleId || '').includes('contract/schema_validation_failed')
    );
    expect(issues.length).toBe(0);
  });
});

