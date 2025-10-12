import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { deriveExecutedCheckNames } from '../../src/utils/ui-helpers';

describe('Executed checks list includes forward-run children', () => {
  it('returns names for both initiator and routed child', async () => {
    const cfg = {
      version: '2.0',
      routing: { max_loops: 3 },
      checks: {
        'comment-assistant': {
          type: 'log',
          message: 'rerun requested',
          on_success: { goto_js: `return 'overview'`, goto_event: 'pr_updated' },
        },
        overview: {
          type: 'command',
          exec: 'exit 1',
          on: ['pr_updated'],
        },
      },
      output: { pr_comment: { format: 'markdown', group_by: 'check' } },
    } as any;

    const engine = new CheckExecutionEngine(process.cwd());
    const { results } = await engine.executeGroupedChecks(
      {
        number: 1,
        title: 't',
        author: 'a',
        base: 'main',
        head: 'branch',
        files: [{ filename: 'x', status: 'modified', additions: 1, deletions: 0, changes: 1 }],
        totalAdditions: 1,
        totalDeletions: 0,
        fullDiff: '',
        eventType: 'issue_comment',
      } as any,
      ['comment-assistant'],
      undefined,
      cfg,
      undefined,
      true,
      1,
      false
    );

    const names = deriveExecutedCheckNames(results).sort();
    expect(names).toEqual(['comment-assistant', 'overview'].sort());
  });
});
