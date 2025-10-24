import { CheckExecutionEngine } from '../../src/check-execution-engine';
import type { VisorConfig } from '../../src/types/config';

describe('on_finish non-converging loop (pre-fix repro)', () => {
  const ITEMS = 6;
  const SAFETY_MAX = 8; // stop after 8 waves so the test finishes deterministically
  const NS = 'nonconverge';

  const makeConfig = (): Partial<VisorConfig> => ({
    version: '1.0',
    routing: { max_loops: 3 }, // small budget we expect to be exceeded pre-fix
    checks: {
      'seed-facts': {
        type: 'memory',
        operation: 'set',
        namespace: NS,
        key: 'facts',
        value_js: `Array.from({length:${ITEMS}},(_,i)=>({id:\`fact-\${i+1}\`, claim:\`claim-\${i+1}\`}))`,
      },
      'extract-facts': {
        type: 'memory',
        operation: 'get',
        namespace: NS,
        key: 'facts',
        forEach: true,
        depends_on: ['seed-facts'],
        on_finish: {
          run: ['aggregate'],
          goto_js: `
            const nested = outputs.history['validate'] || [];
            const total = Array.isArray(nested) ? nested.flatMap(x => Array.isArray(x) ? x : [x]).length : 0;
            const wave = Math.floor(total / ${ITEMS});
            if (wave < ${SAFETY_MAX}) return 'extract-facts';
            return null;
          `,
        },
      },
      // Always invalid; ensures aggregator never flips to "all valid"
      validate: {
        type: 'memory',
        operation: 'exec_js',
        namespace: NS,
        depends_on: ['extract-facts'],
        fanout: 'map',
        memory_js: `
          const f = outputs['extract-facts'];
          return { fact_id: f.id, claim: f.claim, is_valid: false, evidence: 'bad' };
        `,
      },
      // Aggregator computes wave from history so we count each full fan-out once
      aggregate: {
        type: 'memory',
        operation: 'exec_js',
        namespace: NS,
        memory_js: `
          const nested = outputs.history['validate'] || [];
          const flat = Array.isArray(nested) ? nested.flatMap(x => Array.isArray(x) ? x : [x]) : [];
          const total = flat.length;
          const wave = Math.floor(total / ${ITEMS});
          memory.set('wave', wave, '${NS}');
          return { wave, total };
        `,
      },
    },
  });

  it('reproduces repeated fan-out waves before fix (exceeds routing.max_loops)', async () => {
    // Reset memory store between runs
    const { MemoryStore } = require('../../src/memory-store');
    MemoryStore.resetInstance();

    const engine = new CheckExecutionEngine();
    const config = makeConfig() as VisorConfig;

    const result = await engine.executeChecks({
      checks: ['extract-facts', 'validate'],
      config,
      workingDirectory: process.cwd(),
      outputFormat: 'json',
      debug: true,
      maxParallelism: 1,
    });

    const statsBy = Object.fromEntries(
      (result.executionStatistics?.checks || []).map((s: any) => [s.checkName, s])
    );
    const validateRuns = statsBy['validate']?.totalRuns || 0;
    const wave = MemoryStore.getInstance().get('wave', NS) || 0;

    // After fix: wave should not exceed routing.max_loops (3)
    expect(wave).toBeLessThanOrEqual(3);
    // Validate total runs should not exceed ITEMS * routing.max_loops
    expect(validateRuns).toBeLessThanOrEqual(ITEMS * 3);
    expect(validateRuns).toBeGreaterThan(0);
  });
});
