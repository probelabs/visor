import { CheckExecutionEngine } from '../../src/check-execution-engine';
import type { VisorConfig } from '../../src/types/config';

describe('Fact Validation Flow (memory, fast e2e)', () => {
  let engine: CheckExecutionEngine;

  beforeEach(() => {
    engine = new CheckExecutionEngine();
  });

  it('runs forEach validations across one retry, counts runs, and stops after single retry', async () => {
    const config: Partial<VisorConfig> = {
      version: '1.0',
      checks: {
        'init-attempt': {
          type: 'memory',
          operation: 'set',
          namespace: 'fact-validation',
          key: 'attempt',
          value: 0,
        },
        'seed-facts': {
          type: 'memory',
          operation: 'set',
          namespace: 'fact-validation',
          key: 'facts',
          value_js: 'Array.from({length:6},(_,i)=>({id:`fact-${i+1}`, claim:`claim-${i+1}`}))',
          depends_on: ['init-attempt'],
        },

        'extract-facts': {
          type: 'memory',
          operation: 'get',
          namespace: 'fact-validation',
          key: 'facts',
          forEach: true,
          depends_on: ['seed-facts'],
          on_finish: {
            run: ['aggregate-validations'],
            goto_js: `
              const allValid = memory.get('all_valid', 'fact-validation') === true;
              let attempt = memory.get('attempt', 'fact-validation') || 0;
              if (!allValid && attempt < 1) {
                memory.increment('attempt', 1, 'fact-validation');
                log('retrying extract-facts, attempt:', attempt + 1);
                return 'extract-facts';
              }
              return null;
            `,
          },
        },

        'validate-fact': {
          type: 'memory',
          operation: 'exec_js',
          namespace: 'fact-validation',
          depends_on: ['extract-facts'],
          memory_js: `
            const attempt = memory.get('attempt', 'fact-validation') || 0;
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
          namespace: 'fact-validation',
          memory_js: `
            const vals = outputs.history['validate-fact'] || [];
            const invalid = vals.filter(v => v && v.is_valid === false);
            const all_valid = invalid.length === 0;
            memory.set('all_valid', all_valid, 'fact-validation');
            memory.set('total_validations', vals.length, 'fact-validation');
            return { total: vals.length, invalid: invalid.length, all_valid, attempt };
          `,
        },
      },
    };

    const res = await engine.executeChecks({
      checks: ['extract-facts', 'validate-fact'],
      config: config as VisorConfig,
      workingDirectory: process.cwd(),
      outputFormat: 'json',
    });

    const { MemoryStore } = require('../../src/memory-store');
    const store = MemoryStore.getInstance();
    const allValid = store.get('all_valid', 'fact-validation');
    const totalValidations = store.get('total_validations', 'fact-validation');
    const attempt = store.get('attempt', 'fact-validation');
    expect(allValid).toBe(true);
    expect(totalValidations).toBe(12);
    expect(attempt).toBe(1);
  });
});
