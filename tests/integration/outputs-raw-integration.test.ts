import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { deriveExecutedCheckNames } from '../../src/utils/ui-helpers';

describe('outputs_raw exposure across providers and routing', () => {
  it('provides aggregate array via outputs_raw in providers and routing JS', async () => {
    const cfg = {
      version: '2.0',
      routing: { max_loops: 3 },
      checks: {
        list: { type: 'command', exec: 'echo \'["a","b","c"]\'', forEach: true },
        'use-raw-memory': {
          type: 'memory',
          depends_on: ['list'],
          operation: 'exec_js',
          memory_js: `
            const arr = outputs_raw["list"];
            if (!Array.isArray(arr)) throw new Error('outputs_raw.list not array');
            return { rawLength: arr.length, first: arr[0], last: arr[arr.length-1] };
          `,
        },
        'route-by-raw': {
          type: 'memory',
          depends_on: ['list'],
          operation: 'exec_js',
          memory_js: `return 'ok';`,
          on_success: {
            goto_js: `
              const n = (outputs_raw["list"] || []).length;
              return n >= 3 ? 'after-route' : null;
            `,
          },
        },
        'after-route': {
          type: 'memory',
          operation: 'exec_js',
          memory_js: `return { reached: true };`,
        },
      },
      output: { pr_comment: { format: 'markdown', group_by: 'check' } },
    } as any;

    const engine = new CheckExecutionEngine(process.cwd());
    const prInfo = {
      number: 1,
      title: 't',
      author: 'a',
      base: 'main',
      head: 'branch',
      files: [{ filename: 'x', status: 'modified', additions: 1, deletions: 0, changes: 1 }],
      totalAdditions: 1,
      totalDeletions: 0,
      fullDiff: '',
      eventType: 'manual',
    } as any;
    const { results } = await engine.executeGroupedChecks(
      prInfo,
      ['list', 'use-raw-memory', 'route-by-raw', 'after-route'],
      undefined,
      cfg,
      undefined,
      true,
      1,
      false
    );

    const names = deriveExecutedCheckNames(results as any).sort();
    expect(names).toEqual(['list', 'use-raw-memory', 'route-by-raw', 'after-route'].sort());
  });
});
