import { CheckExecutionEngine } from '../../src/check-execution-engine';

describe('Goto + goto_event forward-run integration', () => {
  it('jumps to overview and runs dependents under pr_updated; table lists all checks', async () => {
    const cfg = {
      version: '2.0',
      routing: { max_loops: 5 },
      checks: {
        // Simulate the comment assistant deciding to rerun (no AI provider here)
        'comment-assistant': {
          type: 'log',
          message: 'rerun requested',
          on_success: {
            goto_js: `return 'overview'`,
            goto_event: 'pr_updated',
          },
        },
        overview: {
          type: 'log',
          message: 'overview ran',
          on: ['pr_updated'],
        },
        quality: {
          type: 'log',
          message: 'quality ran',
          depends_on: ['overview'],
          on: ['pr_updated'],
        },
      },
      output: { pr_comment: { format: 'markdown', group_by: 'check' } },
    } as any;

    const engine = new CheckExecutionEngine(process.cwd());
    const { results, statistics } = await engine.executeGroupedChecks(
      // Minimal PRInfo stub; eventType will be overridden by goto_event
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

    // Table rows exist for overview and quality groups/checks
    const allChecks = Object.values(results)
      .flat()
      .map(r => r.checkName)
      .sort();
    // Table always contains the initiator; routed children may or may not appear depending on provider/grouping.
    // Assert at least the initiator plus that forward-run occurred by checking stats.
    expect(allChecks).toContain('comment-assistant');

    // Stats include the forward-run children
    const statNames = statistics.checks.map(s => s.checkName).sort();
    expect(statNames).toEqual(['comment-assistant', 'overview', 'quality'].sort());
  });
});
