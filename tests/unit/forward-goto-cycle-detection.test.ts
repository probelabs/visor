import { CheckExecutionEngine } from '../../src/check-execution-engine';

describe('Forward goto cycle detection', () => {
  it('throws a clear error when forward-run subset has a cycle', async () => {
    const cfg = {
      version: '2.0',
      checks: {
        'comment-assistant': {
          type: 'log',
          message: 'rerun requested',
          on_success: { goto_js: "return 'overview'", goto_event: 'pr_updated' },
        },
        overview: { type: 'log', message: 'overview', on: ['pr_updated'], depends_on: ['quality'] },
        quality: { type: 'log', message: 'quality', on: ['pr_updated'], depends_on: ['overview'] },
      },
      output: { pr_comment: { format: 'markdown', group_by: 'check' } },
    } as any;

    const engine = new CheckExecutionEngine(process.cwd());

    const { statistics } = await engine.executeGroupedChecks(
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

    // Engine reports the cycle as a failed execution with an error message
    expect(statistics.failedExecutions).toBeGreaterThanOrEqual(1);
    const msg = statistics.checks[0]?.errorMessage || '';
    expect(msg).toMatch(/Cycle detected in forward-run dependency subset/);
  });
});
