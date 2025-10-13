import { CheckExecutionEngine } from '../../src/check-execution-engine';
import type { VisorConfig } from '../../src/types/config';

describe('Forward-run stats isolation', () => {
  it('does not attribute child issues to the parent check', async () => {
    const cfg: VisorConfig = {
      version: '2.0',
      checks: {
        'comment-assistant': {
          type: 'log',
          message: 'rerun requested',
          on_success: {
            goto_js: `return 'overview'`,
            goto_event: 'pr_updated',
          },
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

    // Stats should be present for both checks
    const parent = statistics.checks.find(c => c.checkName === 'comment-assistant');
    const child = statistics.checks.find(c => c.checkName === 'overview');
    expect(parent).toBeDefined();
    expect(child).toBeDefined();

    // The child has an issue due to fail_if
    expect(child!.issuesFound).toBeGreaterThanOrEqual(1);

    // The parent should NOT accumulate the child's issues
    expect(parent!.issuesFound).toBe(0);
    expect(parent!.issuesBySeverity.warning).toBe(0);
    expect(parent!.issuesBySeverity.error).toBe(0);
    expect(parent!.issuesBySeverity.critical).toBe(0);
  });
});
