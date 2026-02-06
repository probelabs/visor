import {
  decideRouting,
  projectOutputs,
  computeAllValid,
} from '../../src/engine/on-finish/orchestrator';

describe('OnFinish orchestrator helpers', () => {
  test('projectOutputs returns stable shapes', () => {
    const res = new Map<string, any>([['a', { output: { x: 1 } }]]);
    const hist = { a: [{ x: 0 }] } as Record<string, unknown[]>;
    const p = projectOutputs(res as any, hist);
    expect(p.outputsForContext.a).toEqual({ x: 1 });
    expect(Array.isArray(p.outputsHistoryForContext.a)).toBe(true);
  });

  test('computeAllValid mirrors history verdicts', () => {
    const hist = { 'validate-fact': [{ is_valid: true }, { is_valid: true }] } as Record<
      string,
      unknown[]
    >;
    expect(computeAllValid(hist, 2)).toBe(true);
  });

  test('decideRouting evaluates goto_js', () => {
    const prInfo = {
      number: 1,
      title: '',
      author: '',
      head: '',
      base: '',
      files: [],
      eventType: 'issue_comment',
    } as any;
    const cfg = {
      version: '1.0',
      checks: { a: { type: 'ai', on_finish: { goto_js: "return 'a'" } } },
    } as any;
    const out = decideRouting(
      'a',
      cfg.checks.a,
      {},
      {},
      { items: [] } as any,
      prInfo,
      cfg,
      false,
      () => {}
    );
    expect(out.gotoTarget).toBe('a');
  });
});
