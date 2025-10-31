import {
  buildProjectionFrom,
  composeOnFinishContext,
  evaluateOnFinishGoto,
  recomputeAllValidFromHistory,
} from '../../src/engine/on-finish/utils';

describe('OnFinish utils', () => {
  test('buildProjectionFrom projects outputs and history', () => {
    const results = new Map<string, any>([
      ['a', { output: { x: 1 } }],
      ['b', { issues: [], content: 'raw' }],
    ]);
    const hist = { a: [{ x: 0 }], b: [] } as Record<string, unknown[]>;
    const p = buildProjectionFrom(results as any, hist);
    expect(p.outputsForContext.a).toEqual({ x: 1 });
    // falls back to raw result if no output present
    expect((p.outputsForContext.b as any).content).toEqual('raw');
    expect(p.outputsHistoryForContext.a).toHaveLength(1);
  });

  test('composeOnFinishContext includes memory/env and step metadata', () => {
    const ctx = composeOnFinishContext(
      undefined,
      'extract-facts',
      { type: 'ai', prompt: 'p', tags: ['t'] } as any,
      { validate: true },
      { validate: [] },
      { items: [] },
      {
        number: 1,
        title: 't',
        author: 'a',
        head: 'h',
        base: 'b',
        files: [],
        eventType: 'issue_opened',
      } as any
    );
    expect(ctx.step.id).toBe('extract-facts');
    expect(Array.isArray(ctx.outputs_history.validate)).toBe(true);
    expect(typeof ctx.memory.get).toBe('function');
    expect(ctx.event.name).toBe('issue_opened');
  });

  test('evaluateOnFinishGoto returns target from goto_js', () => {
    const target = evaluateOnFinishGoto(
      { goto_js: "return 'comment-assistant'" } as any,
      { step: { id: 'extract-facts' } },
      false,
      () => {}
    );
    expect(target).toBe('comment-assistant');
  });

  test('recomputeAllValidFromHistory detects all-true verdicts', () => {
    const hist = {
      'validate-fact': [
        { is_valid: true },
        { is_valid: false },
        { is_valid: true },
        { is_valid: true },
      ],
    } as Record<string, unknown[]>;
    // last 3 items -> false present
    expect(recomputeAllValidFromHistory(hist, 3)).toBe(false);
    // last 2 items -> all true
    expect(recomputeAllValidFromHistory(hist, 2)).toBe(true);
  });
});
