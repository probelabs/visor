import { CheckExecutionEngine } from '../../src/check-execution-engine';
import type { VisorConfig } from '../../src/types/config';

describe('Fact Validation Flow (history-driven, fast e2e)', () => {
  const makeConfig = (retryWaves: number): Partial<VisorConfig> => ({
    version: '1.0',
    checks: {
      'extract-facts': {
        type: 'script',
        forEach: true,
        content: `
          // Produce 6 facts
          return Array.from({length:6},(_,i)=>({ id: 'fact-'+(i+1), claim: 'claim-'+(i+1) }));
        `,
        on_finish: {
          goto_js: `
            // Re-run until the last wave is all valid, capped by one retry.
            const hist = outputs.history || {};
            const items = (forEach && forEach.last_wave_size) ? forEach.last_wave_size : 1;
            const perAll = (hist['validate-fact'] || []).filter((x) => !Array.isArray(x));
            const waves = items > 0 ? Math.floor(perAll.length / items) : 0;
            const last = items > 0 ? perAll.slice(-items) : [];
            const allOk = last.length === items && last.every(v => v && (v.is_valid === true || v.valid === true));
            log('[goto_js] items=', items, 'perAll=', perAll.length, 'waves=', waves, 'lastOk=', allOk);
            const maxWaves = 1 + ${retryWaves};
            return (!allOk && waves < maxWaves) ? 'extract-facts' : null;
          `,
        },
      },

      'validate-fact': {
        type: 'script',
        depends_on: ['extract-facts'],
        fanout: 'map',
        content: `
          // Determine current wave from history
          const arrs = outputs.history['extract-facts'] || [];
          const lastArr = arrs.filter(Array.isArray).slice(-1)[0] || [];
          const items = lastArr.length || 1;
          const per = (outputs.history['validate-fact'] || []).filter(x => !Array.isArray(x));
          const waves = Math.floor(per.length / items);

          // Current item
          const f = outputs['extract-facts'];
          const n = Number((f.id||'').split('-')[1]||'0');

          // First wave: facts 1..3 are invalid, rest valid. Later waves: all valid.
          const invalidOnFirst = (n >= 1 && n <= 3);
          const is_valid = waves >= 1 ? true : !invalidOnFirst;
          return { fact_id: f.id, claim: f.claim, is_valid, confidence: 'high', evidence: is_valid ? 'ok' : 'bad' };
        `,
      },
      // no aggregator step needed in this variant
    },
  });

  it('no retry: per-item validations run once (×6)', async () => {
    const engine = new CheckExecutionEngine();
    const cfg = makeConfig(0);
    const result = await engine.executeChecks({
      checks: ['extract-facts', 'validate-fact'],
      config: cfg as VisorConfig,
      workingDirectory: process.cwd(),
      outputFormat: 'json',
      debug: true,
    });
    const byName: Record<string, any> = {};
    for (const c of (result as any).executionStatistics?.checks || []) byName[c.checkName] = c;
    expect(byName['extract-facts'].outputsProduced).toBe(6);
    expect(byName['validate-fact'].totalRuns).toBe(6);
  });

  it('one retry: per-item validations run twice (×12)', async () => {
    const engine = new CheckExecutionEngine();
    const cfg = makeConfig(1);
    const result = await engine.executeChecks({
      checks: ['extract-facts', 'validate-fact'],
      config: cfg as VisorConfig,
      workingDirectory: process.cwd(),
      outputFormat: 'json',
      debug: true,
    });
    const byName: Record<string, any> = {};
    for (const c of (result as any).executionStatistics?.checks || []) byName[c.checkName] = c;
    expect(byName['extract-facts'].outputsProduced).toBe(6);
    expect(byName['validate-fact'].totalRuns).toBe(12);
  });
});
