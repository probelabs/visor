import { describe, it, expect } from '@jest/globals';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import { MemoryStore } from '../../src/memory-store';
import type { VisorConfig } from '../../src/types/config';

describe('Engine: forEach with on_finish (native)', () => {
  // No filesystem or git needed; run engine natively with in-memory config

  it('all facts valid → direct post (no retry)', async () => {
    MemoryStore.resetInstance();
    // No shell exec needed for this native test

    const config: VisorConfig = {
      version: '1.0',
      checks: {
        'extract-facts': {
          type: 'script',
          content:
            'return [{id:"f1", claim:"Valid 1", valid:true}, {id:"f2", claim:"Valid 2", valid:true}];',
          forEach: true,
          on_finish: {
            run: ['aggregate'],
          },
        },
        'validate-fact': {
          type: 'script',
          depends_on: ['extract-facts'],
          fanout: 'map',
          content:
            'return { fact_id: outputs["extract-facts"].id, is_valid: outputs["extract-facts"].valid };',
        },
        aggregate: {
          type: 'script',
          namespace: 'fact-validation',
          // Compute all_valid from the most recent cycle of validate-fact.
          // Derive the last cycle size from the latest extract-facts array entry.
          content: [
            "const vf = (outputs.history['validate-fact']||[]).filter(v => v && typeof v === 'object');",
            "const ex = (outputs.history['extract-facts']||[]);",
            'let lastSize = 0; for (let i = ex.length - 1; i >= 0 && lastSize === 0; i--) { if (Array.isArray(ex[i])) { lastSize = ex[i].length; } }',
            'const recent = lastSize > 0 ? vf.slice(-lastSize) : vf;',
            'const allValid = recent.length > 0 && recent.every(i => i && i.is_valid === true);',
            "memory.set('all_valid', allValid, 'fact-validation');",
            'return { all_valid: allValid };',
          ].join('\n'),
        },
        'post-verified': {
          type: 'log',
          depends_on: ['extract-facts'],
          if: "memory.get('all_valid', 'fact-validation') === true",
          message: '✅ Posted verified response',
        },
      },
    } as any;

    const engine = new StateMachineExecutionEngine();
    const prInfo: any = {
      number: 1,
      title: 't',
      author: 'a',
      base: 'main',
      head: 'branch',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      eventType: 'manual',
    };
    const result = await engine.executeGroupedChecks(
      prInfo,
      // Do not request 'aggregate' explicitly; it runs via on_finish.run
      ['extract-facts', 'validate-fact', 'post-verified'],
      undefined,
      config,
      'table',
      false
    );

    // Validate statistics
    const stats = result.statistics!;
    const byName: Record<string, any> = {};
    for (const s of stats.checks || []) byName[s.checkName] = s;

    expect(byName['extract-facts']).toBeDefined();
    expect(byName['validate-fact']).toBeDefined();
    expect(byName['aggregate']).toBeDefined();
    expect(byName['post-verified']).toBeDefined();
    expect(byName['post-verified'].successfulRuns || 0).toBeGreaterThanOrEqual(1);

    // Validate output history: 2 validations
    const hist = engine.getOutputHistorySnapshot() as any;
    const entries = hist['validate-fact'] || [];
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBe(2);
  });

  it('some facts invalid → single retry → post', async () => {
    MemoryStore.resetInstance();
    const config: VisorConfig = {
      version: '1.0',
      checks: {
        'init-memory': {
          type: 'memory',
          operation: 'set',
          key: 'attempt',
          value: 0,
          namespace: 'fact-validation',
        },
        'extract-facts': {
          type: 'script',
          depends_on: ['init-memory'],
          content: [
            "const att = memory.get('attempt','fact-validation') || 0;",
            "if (att >= 1) return [{id:'f1', claim:'Corrected', valid:true}];",
            "return [{id:'f1', claim:'Wrong', valid:false}];",
          ].join('\n'),
          forEach: true,
          on_finish: {
            run: ['aggregate'],
            goto_js: [
              "const ok = memory.get('all_valid', 'fact-validation');",
              "const att = memory.get('attempt', 'fact-validation') || 0;",
              'if (ok) return null;',
              'if (att >= 1) return null;',
              "memory.increment('attempt', 1, 'fact-validation');",
              "return 'extract-facts';",
            ].join('\n'),
          },
        },
        'validate-fact': {
          type: 'script',
          depends_on: ['extract-facts'],
          fanout: 'map',
          content:
            'return { fact_id: outputs["extract-facts"].id, is_valid: outputs["extract-facts"].valid };',
        },
        aggregate: {
          type: 'script',
          namespace: 'fact-validation',
          content: [
            "const vf = (outputs.history['validate-fact']||[]).filter(v => v && typeof v === 'object');",
            "const ex = (outputs.history['extract-facts']||[]);",
            'let lastSize = 0; for (let i = ex.length - 1; i >= 0 && lastSize === 0; i--) { if (Array.isArray(ex[i])) { lastSize = ex[i].length; } }',
            'const recent = lastSize > 0 ? vf.slice(-lastSize) : vf;',
            'const allValid = recent.length > 0 && recent.every(i => i && i.is_valid === true);',
            "memory.set('all_valid', allValid, 'fact-validation');",
            'return { all_valid: allValid };',
          ].join('\n'),
        },
        'post-verified': {
          type: 'log',
          depends_on: ['extract-facts'],
          if: "memory.get('all_valid', 'fact-validation') === true",
          message: 'Posted after successful retry',
        },
      },
    } as any;

    const engine = new StateMachineExecutionEngine();
    const prInfo: any = {
      number: 1,
      title: 't',
      author: 'a',
      base: 'main',
      head: 'branch',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      eventType: 'manual',
    };
    const result = await engine.executeGroupedChecks(
      prInfo,
      // Do not request 'aggregate' explicitly; it runs via on_finish.run
      ['init-memory', 'extract-facts', 'validate-fact', 'post-verified'],
      undefined,
      config,
      'table',
      false
    );

    const stats = result.statistics!;
    const byName: Record<string, any> = {};
    for (const s of stats.checks || []) byName[s.checkName] = s;

    // extract-facts should be re-run at least once
    expect(byName['extract-facts'].totalRuns || 0).toBeGreaterThanOrEqual(1);
    // post should eventually run
    expect(byName['post-verified'].successfulRuns || 0).toBeGreaterThanOrEqual(1);

    // Validate history flipped to valid in the last entry
    const hist = engine.getOutputHistorySnapshot() as any;
    const vals = hist['validate-fact'] || [];
    expect(Array.isArray(vals)).toBe(true);
    expect(vals.length).toBeGreaterThanOrEqual(1);
    const last = vals[vals.length - 1];
    const lastItems = last && last.isForEach ? last.forEachItems || [] : last ? [last] : [];
    expect(lastItems.length).toBeGreaterThanOrEqual(1);
    expect(lastItems[lastItems.length - 1]?.is_valid).toBe(true);
  });
});
