import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { VisorConfig } from '../../src/types/config';

/**
 * E2E: Branch-first order with multi-parent join
 * Graph:
 *   root(forEach) -> A
 *   root(forEach) -> B (item 2 fails via fail_if)
 *   C depends_on: [A, B]
 * With max_parallelism: 1, expected per-branch sequence:
 *   Branch 1: A1 -> B1 -> C1
 *   Branch 2: A2 -> B2(fail) -> (no C2)
 *   Branch 3: A3 -> B3 -> C3
 */
describe('E2E: forEach branch-first with join', () => {
  it('executes A,B then C per item; failure on B2 skips only C2', async () => {
    const engine = new CheckExecutionEngine();

    const config: VisorConfig = {
      version: '1.0',
      max_parallelism: 1,
      checks: {
        root: {
          type: 'command',
          exec: "bash -lc \"printf '[\\\"ISSUE-1\\\",\\\"ISSUE-2\\\",\\\"ISSUE-3\\\"]'\"",
          forEach: true,
        },
        A: {
          type: 'command',
          exec: 'bash -lc "true"',
          transform_js: '({ issues: [{ message: `A:${outputs["root"]}`, severity: "info", category: "logic", ruleId: "a" }], item: outputs["root"] })',
          depends_on: ['root'],
        },
        B: {
          type: 'command',
          exec: 'bash -lc "true"',
          transform_js: '(() => { const ITEM = outputs["root"]; const error = ITEM === "ISSUE-2"; const issues = [{ message: `B:${ITEM}`, severity: "info", category: "logic", ruleId: "b" }]; if (error) issues.push({ message: "fail_if", severity: "error", category: "logic", ruleId: "B_fail_if" }); return { issues, error, item: ITEM }; })()',
          depends_on: ['root'],
          fail_if: 'output.error',
        },
        C: {
          type: 'command',
          exec: 'bash -lc "true"',
          transform_js: '({ issues: [{ message: `C:${outputs["A"].item}`, severity: "info", category: "logic", ruleId: "c" }] })',
          depends_on: ['A', 'B'],
        },
      },
      output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: true } },
    };

    const execResult = await engine.executeChecks({
      checks: ['root', 'A', 'B', 'C'],
      workingDirectory: process.cwd(),
      showDetails: false,
      outputFormat: 'json',
      config,
    });

    // Validate via execution statistics
    const allStats = execResult.executionStatistics?.checks || [];
    const aStats = allStats.find(c => c.checkName === 'A');
    const bStats = allStats.find(c => c.checkName === 'B');
    const cStats = allStats.find(c => c.checkName === 'C');
    expect(aStats?.totalRuns).toBe(3);
    expect(bStats?.totalRuns).toBe(3);
    expect(cStats?.totalRuns).toBe(2);
  });
});
