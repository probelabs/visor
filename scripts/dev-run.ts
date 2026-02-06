import 'ts-node/register';
import { CheckExecutionEngine } from '../src/check-execution-engine';
import type { VisorConfig } from '../src/types/config';
import { MemoryStore } from '../src/memory-store';

(async () => {
  const engine = new CheckExecutionEngine();
  const config: Partial<VisorConfig> = {
    version: '1.0',
    checks: {
      'init-attempt': {
        type: 'memory', operation: 'set', namespace: 'fact-validation', key: 'attempt', value: 0,
      },
      'seed-facts': {
        type: 'memory', operation: 'set', namespace: 'fact-validation', key: 'facts',
        value_js: 'Array.from({length:6},(_,i)=>({id:`fact-${i+1}`, claim:`claim-${i+1}`}))',
        depends_on: ['init-attempt'],
      },
      'extract-facts': {
        type: 'memory', operation: 'get', namespace: 'fact-validation', key: 'facts', forEach: true,
        depends_on: ['seed-facts'],
        on_finish: {
          run: ['aggregate-validations'],
          goto_js: `
            const allValid = memory.get('all_valid', 'fact-validation') === true;
            let attempt = memory.get('attempt', 'fact-validation') || 0;
            if (!allValid && attempt < 1) {
              memory.increment('attempt', 1, 'fact-validation');
              return 'extract-facts';
            }
            return null;
          `,
        },
      },
      'validate-fact': {
        type: 'script', depends_on: ['extract-facts'],
        content: `
          const attempt = memory.get('attempt', 'fact-validation') || 0;
          const f = outputs['extract-facts'];
          const n = Number((f.id||'').split('-')[1]||'0');
          const invalidOnFirst = (n >= 1 && n <= 3);
          const is_valid = attempt >= 1 ? true : !invalidOnFirst;
          return { fact_id: f.id, claim: f.claim, is_valid, confidence: 'high', evidence: is_valid ? 'ok' : 'bad' };
        `,
      },
      'aggregate-validations': {
        type: 'script',
        content: `
          const nested = outputs.history['validate-fact'] || [];
          const vals = (Array.isArray(nested) && nested.length>0 && Array.isArray(nested[0])) ? nested.flat() : nested;
          const invalid = vals.filter(v => v && v.is_valid === false);
          const all_valid = invalid.length === 0;
          memory.set('all_valid', all_valid, 'fact-validation');
          memory.set('total_validations', vals.length, 'fact-validation');
          return { total: vals.length, invalid: invalid.length, all_valid };
        `,
      },
    },
  };

  const result = await engine.executeChecks({
    checks: ['extract-facts','validate-fact'],
    config: config as VisorConfig,
    debug: true,
    outputFormat: 'plain',
  });

  const store = MemoryStore.getInstance();
  console.error('Memory keys:', store.list('fact-validation'));
  console.error('attempt:', store.get('attempt','fact-validation'));
  console.error('total_validations:', store.get('total_validations','fact-validation'));
  console.error('all_valid:', store.get('all_valid','fact-validation'));
})();
