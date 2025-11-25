import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { VisorConfig } from '../../src/types/config';

/**
 * E2E: Branch-first order on deep DAG
 * Graph: root(forEach) -> A -> B(fail at item 2) -> C
 * With max_parallelism: 1, expected per-branch sequence:
 *  Branch 1: A1 -> B1 -> C1
 *  Branch 2: A2 -> B2(fail) -> (no C2)
 *  Branch 3: A3 -> B3 -> C3
 */
describe('E2E: forEach branch-first deep DAG', () => {
  it('executes chain A->B->C per item with mid failure', async () => {
    const engine = new CheckExecutionEngine();

    const config: VisorConfig = {
      version: '1.0',
      max_parallelism: 1,
      checks: {
        root: {
          type: 'command',
          exec: 'bash -lc "printf \'[\\"ISSUE-1\\",\\"ISSUE-2\\",\\"ISSUE-3\\"]\'"',
          forEach: true,
        },
        A: {
          type: 'command',
          exec: 'bash -lc "true"',
          transform_js:
            '({ issues: [{ message: `A:${outputs["root"]}`, severity: "info", category: "logic", ruleId: "a" }], item: outputs["root"] })',
          depends_on: ['root'],
        },
        B: {
          type: 'command',
          exec: 'bash -lc "true"',
          transform_js:
            '(() => { const ITEM = outputs["A"].item; const error = ITEM === "ISSUE-2"; const issues = [{ message: `B:${ITEM}`, severity: "info", category: "logic", ruleId: "b" }]; if (error) issues.push({ message: "fail_if", severity: "error", category: "logic", ruleId: "B_fail_if" }); return { issues, error, item: ITEM }; })()',
          depends_on: ['A'],
          fail_if: 'output.error',
        },
        C: {
          type: 'command',
          exec: 'bash -lc "true"',
          transform_js:
            '({ issues: [{ message: `C:${outputs["B"].item}`, severity: "info", category: "logic", ruleId: "c" }] })',
          depends_on: ['B'],
        },
        D: {
          type: 'command',
          exec: 'bash -lc "true"',
          transform_js:
            '({ issues: [{ message: `D:${outputs["B"].item}`, severity: "info", category: "logic", ruleId: "d" }] })',
          depends_on: ['C'],
        },
      },
      output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: true } },
    };

    const execResult = await engine.executeChecks({
      checks: ['root', 'A', 'B', 'C', 'D'],
      workingDirectory: process.cwd(),
      showDetails: false,
      outputFormat: 'json',
      config,
    });

    const allStats = execResult.executionStatistics?.checks || [];
    const aStats = allStats.find(c => c.checkName === 'A');
    const bStats = allStats.find(c => c.checkName === 'B');
    const cStats = allStats.find(c => c.checkName === 'C');
    const dStats = allStats.find(c => c.checkName === 'D');
    expect(aStats?.totalRuns).toBe(3);
    expect(bStats?.totalRuns).toBe(3);
    expect(cStats?.totalRuns).toBe(2);
    expect(dStats?.totalRuns).toBe(2);
  }, 30000); // Increased timeout due to async operations
});
