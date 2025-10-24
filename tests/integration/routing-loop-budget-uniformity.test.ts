import { CheckExecutionEngine } from '../../src/check-execution-engine';

describe('Routing loop budget uniformity (Phase 3)', () => {
  let engine: CheckExecutionEngine;

  beforeEach(() => {
    engine = new CheckExecutionEngine();
  });

  it('on_success.run respects routing.max_loops uniformly', async () => {
    const cfg = {
      version: '2.0',
      routing: { max_loops: 0 },
      checks: {
        base: { type: 'command', exec: 'echo base' },
        child: { type: 'command', exec: 'echo child' },
        parent: {
          type: 'command',
          depends_on: ['base'],
          exec: 'echo parent',
          on_success: {
            run: ['child'],
          },
        },
      },
      output: { pr_comment: { format: 'markdown', group_by: 'check' } },
    } as any;

    const result = await engine.executeChecks({
      checks: ['parent', 'base'],
      config: cfg,
      outputFormat: 'json',
      debug: true,
    });
    const msg = (result.reviewSummary.issues || []).map(i => i.message).join('\n');
    expect(msg).toMatch(/Routing loop budget exceeded .* on_success run/);
  });

  it('on_fail.goto respects routing.max_loops uniformly', async () => {
    const cfg = {
      version: '2.0',
      routing: { max_loops: 0 },
      checks: {
        base: { type: 'command', exec: 'echo base' },
        failing: {
          type: 'command',
          depends_on: ['base'],
          exec: 'exit 1',
          on_fail: {
            goto: 'base',
          },
        },
      },
      output: { pr_comment: { format: 'markdown', group_by: 'check' } },
    } as any;

    const result = await engine.executeChecks({
      checks: ['failing', 'base'],
      config: cfg,
      outputFormat: 'json',
      debug: true,
    });
    const msg = (result.reviewSummary.issues || []).map(i => i.message).join('\n');
    expect(msg).toMatch(/Routing loop budget exceeded .* on_fail goto/);
  });
});
