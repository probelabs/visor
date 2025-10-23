import { CheckExecutionEngine } from '../../src/check-execution-engine';
import type { VisorConfig } from '../../src/types/config';

describe('Fact Validation Flow (memory, fast e2e)', () => {
  const makeConfig = (retryLimit: number, ns = 'fact-validation'): Partial<VisorConfig> => ({
    version: '1.0',
    checks: {
      'init-attempt': {
        type: 'memory',
        operation: 'set',
        namespace: ns,
        key: 'attempt',
        value: 0,
      },
      'init-limit': {
        type: 'memory',
        operation: 'set',
        namespace: ns,
        key: 'retry_limit',
        value: retryLimit,
        depends_on: ['init-attempt'],
      },
      'seed-facts': {
        type: 'memory',
        operation: 'set',
        namespace: ns,
        key: 'facts',
        value_js: 'Array.from({length:6},(_,i)=>({id:`fact-${i+1}`, claim:`claim-${i+1}`}))',
        depends_on: ['init-limit'],
      },

      'extract-facts': {
        type: 'memory',
        operation: 'get',
        namespace: ns,
        key: 'facts',
        forEach: true,
        depends_on: ['seed-facts'],
        on_finish: {
          run: ['comment-assistant', 'aggregate-validations'],
          goto_js: `
            const NS = '${ns}';
            const allValid = memory.get('all_valid', NS) === true;
            const limit = Number(memory.get('retry_limit', NS) || 0);
            let attempt = Number(memory.get('attempt', NS) || 0);
            if (!allValid && attempt < limit) {
              memory.increment('attempt', 1, NS);
              return 'extract-facts';
            }
            return null;
          `,
        },
      },

      'validate-fact': {
        type: 'memory',
        operation: 'exec_js',
        namespace: ns,
        depends_on: ['extract-facts'],
        fanout: 'map',
        memory_js: `
          const NS = '${ns}';
          const attempt = memory.get('attempt', NS) || 0;
          const f = outputs['extract-facts'];
          const n = Number((f.id||'').split('-')[1]||'0');
          const invalidOnFirst = (n >= 1 && n <= 3);
          const is_valid = attempt >= 1 ? true : !invalidOnFirst;
          return { fact_id: f.id, claim: f.claim, is_valid, confidence: 'high', evidence: is_valid ? 'ok' : 'bad' };
        `,
      },

      'aggregate-validations': {
        type: 'memory',
        operation: 'exec_js',
        namespace: ns,
        memory_js: `
          const NS = '${ns}';
          const nested = outputs.history['validate-fact'] || [];
          const vals = Array.isArray(nested) ? nested.flatMap(x => Array.isArray(x) ? x : [x]) : [];
          const byId = new Map(); for (const v of vals) { if (v && v.fact_id) byId.set(v.fact_id, v); }
          const uniq = Array.from(byId.values());
          const invalid = uniq.filter(v => v && ((v.is_valid === false) || (v.evidence === 'bad')));
          const all_valid = invalid.length === 0;
          memory.set('all_valid', all_valid, NS);
          { const prev = Number(memory.get('total_validations', NS) || 0); memory.set('total_validations', prev + uniq.length, NS); }
          const attempt = memory.get('attempt', NS) || 0;
          return { total: uniq.length, invalid: invalid.length, all_valid, attempt };
        `,
      },

      'comment-assistant': {
        type: 'memory',
        operation: 'exec_js',
        namespace: ns,
        memory_js: `
          const NS = '${ns}';
          const prev = outputs.history['comment-assistant'] || [];
          const allFactsNested = outputs.history['validate-fact'] || [];
          const allFacts = Array.isArray(allFactsNested) ? allFactsNested.flatMap(x => Array.isArray(x) ? x : [x]) : [];
          // Collect unique set of fact_ids that were ever invalid across waves
          const failedIds = new Set();
          for (const f of allFacts) {
            if (f && f.fact_id && (f.is_valid === false || f.evidence === 'bad')) failedIds.add(f.fact_id);
          }
          const failed = Array.from(failedIds);
          memory.set('comment_prev_count', Array.isArray(prev) ? prev.length : 0, NS);
          memory.set('failed_from_history', failed.length, NS);
          return { prev_count: Array.isArray(prev) ? prev.length : 0, failed_total: failed.length };
        `,
      },
    },
  });

  it('no retry: per-item validations run once (×6), attempt=0', async () => {
    // Clean memory between tests
    const { MemoryStore } = require('../../src/memory-store');
    MemoryStore.resetInstance();
    const engine = new CheckExecutionEngine();
    const cfg = makeConfig(0, 'fact-validation-n0');
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
    const store = MemoryStore.getInstance();
    expect(store.get('total_validations', 'fact-validation-n0')).toBe(6);
    expect(store.get('attempt', 'fact-validation-n0')).toBe(0);
  });

  it('one retry: per-item validations run twice (×12), attempt=1', async () => {
    const { MemoryStore } = require('../../src/memory-store');
    MemoryStore.resetInstance();
    const engine = new CheckExecutionEngine();
    const cfg = makeConfig(1, 'fact-validation-n1');
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
    const store = MemoryStore.getInstance();
    expect(store.get('total_validations', 'fact-validation-n1')).toBeGreaterThanOrEqual(6);
    expect(store.get('attempt', 'fact-validation-n1')).toBe(1);
    // Comment assistant should have seen its previous result on retry
    expect(store.get('comment_prev_count', 'fact-validation-n1')).toBeGreaterThanOrEqual(0);
    // And it should have access to all failed facts across history (3 invalid on first wave)
    expect(store.get('failed_from_history', 'fact-validation-n1')).toBe(3);
  });
});
