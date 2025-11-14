import { CheckExecutionEngine } from '../../src/check-execution-engine';
import type { VisorConfig } from '../../src/types/config';

describe('on_fail forward-run does not cascade success chains', () => {
  it('skips finish when refine fails via fail_if', async () => {
    const engine = new CheckExecutionEngine(process.cwd());
    const cfg: VisorConfig = {
      version: '1.0',
      checks: {
        ask: { type: 'command', exec: 'echo ask', on_success: { goto: 'refine' }, on: ['manual'] },
        refine: {
          type: 'command',
          depends_on: ['ask'],
          exec: 'node -e "console.log(JSON.stringify({refined:false}))"',
          fail_if: 'output && output.refined !== true',
          on_fail: { goto: 'ask' },
          on_success: { goto: 'finish' },
          on: ['manual'],
        },
        finish: { type: 'command', depends_on: ['refine'], exec: 'echo done', on: ['manual'] },
      },
      output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: false } },
      routing: { max_loops: 0 },
    } as any;

    const res = await engine.executeChecks({
      checks: ['ask', 'refine', 'finish'],
      config: cfg,
      webhookContext: { eventType: 'manual' } as any,
    });
    const hist = (res.reviewSummary as any).history || {};
    const finishHist = Array.isArray(hist['finish']) ? hist['finish'] : [];
    expect(finishHist.length).toBe(0);
  });
});
