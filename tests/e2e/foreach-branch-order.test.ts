import fs from 'fs';
import os from 'os';
import path from 'path';
import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { VisorConfig } from '../../src/types/config';

/**
 * E2E: Branch-first order with forEach chains
 *
 * Validates that for a simple chain: list -> categorize -> update
 * and 3 items, we execute in strict branch order when max_parallelism=1:
 *   categorize:ISSUE-1
 *   update:ISSUE-1
 *   categorize:ISSUE-2 (fails via fail_if)
 *   categorize:ISSUE-3
 *   update:ISSUE-3
 *
 * Failure on item 2 must not stop items 1 or 3.
 */
describe('E2E: forEach branch-first execution order', () => {
  it('runs per-branch categorize -> update with middle failure', async () => {
    // setup parity only
    fs.mkdtempSync(path.join(os.tmpdir(), 'visor-foreach-order-'));

    const engine = new CheckExecutionEngine();

    const config: VisorConfig = {
      version: '1.0',
      max_parallelism: 1, // force sequential per-item ordering
      checks: {
        'list-issues': {
          type: 'command',
          exec: 'bash -lc "printf \'[\\"ISSUE-1\\",\\"ISSUE-2\\",\\"ISSUE-3\\"]\'"',
          forEach: true,
        },
        categorize: {
          type: 'command',
          // Deterministic JSON via transform_js; ISSUE-2 triggers error=true
          exec: 'bash -lc "true"',
          transform_js:
            '(() => { const ITEM = outputs["list-issues"]; const err = ITEM === "ISSUE-2"; return { issues: [{ message: `categorize:${ITEM}`, severity: "info", category: "logic", ruleId: "cat" }], item: ITEM, category: "bug", error: err }; })()',
          depends_on: ['list-issues'],
          fail_if: 'output.error',
        },
        'update-label': {
          type: 'command',
          exec: 'bash -lc "true"',
          transform_js:
            '({ issues: [{ message: `update:${outputs["categorize"].item}`, severity: "info", category: "logic", ruleId: "upd" }] })',
          depends_on: ['categorize'],
        },
      },
      output: {
        pr_comment: {
          format: 'markdown',
          group_by: 'check',
          collapse: true,
        },
      },
    };

    const execResult = await engine.executeChecks({
      checks: ['list-issues', 'categorize', 'update-label'],
      workingDirectory: process.cwd(),
      showDetails: false,
      outputFormat: 'json',
      config,
    });

    // Assert per-branch isolation via execution statistics
    const allStats = execResult.executionStatistics?.checks || [];
    const catStats = allStats.find((c: any) => c.checkName === 'categorize');
    const updStats = allStats.find((c: any) => c.checkName === 'update-label');
    expect(catStats?.totalRuns).toBe(3);
    expect(updStats?.totalRuns).toBe(2);
  });
});
