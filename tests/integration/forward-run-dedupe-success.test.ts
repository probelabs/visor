import { CheckExecutionEngine } from '../../src/check-execution-engine';
import type { VisorConfig } from '../../src/types/config';

describe('forward-run dedupe after success (multi-turn)', () => {
  test('finish runs exactly once after final refine success', async () => {
    const engine = new CheckExecutionEngine(process.cwd());

    const cfg: VisorConfig = {
      version: '1.0',
      checks: {
        ask: {
          type: 'script',
          content: `({ ok: true })`,
          on: ['manual']
        },
        refine: {
          type: 'script',
          depends_on: ['ask'],
          on: ['manual'],
          // Compute attempt from refine.history; flip refined=true on 3rd run
          content: `
(() => {
  const histRef = (outputs && outputs.history && outputs.history['refine']) || [];
  const attempt = Array.isArray(histRef) ? histRef.length + 1 : 1;
  log('[refine.content]', 'histRefLen=', Array.isArray(histRef) ? histRef.length : 'NA', 'attempt=', attempt);
  if (attempt === 1) return { refined: false, text: 'Which CI platform and trigger conditions?' };
  if (attempt === 2) return { refined: false, text: 'What Node version and commands should run?' };
  return { refined: true, text: 'Set up GitHub Actions workflow: on push to main, use Node 18.x, cache npm, run npm ci && npm test.' };
})()
`,
          fail_if: `
            log('[refine.fail_if]', 'refined?', output && output.refined, 'text=', output && output.text);
            output && output.refined !== true
          `,
          on_fail: { goto: 'ask' },
        },
        finish: {
          type: 'script',
          depends_on: ['refine'],
          on: ['manual'],
          content: `({ text: (outputs['refine'] && outputs['refine'].text) || '' })`,
        },
      },
      output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: false } },
    } as any;

    const res = await engine.executeChecks({
      checks: ['ask', 'refine', 'finish'],
      config: cfg,
      webhookContext: { eventType: 'manual' } as any,
    });

    const hist = (res.reviewSummary as any).history || {};
    const askRuns = Array.isArray(hist['ask']) ? hist['ask'].length : 0;
    const refineRuns = Array.isArray(hist['refine']) ? hist['refine'].length : 0;
    const finishRuns = Array.isArray(hist['finish']) ? hist['finish'].length : 0;

    expect(askRuns).toBeGreaterThanOrEqual(3);
    expect(refineRuns).toBe(3);
    expect(finishRuns).toBe(1);
  });
});
