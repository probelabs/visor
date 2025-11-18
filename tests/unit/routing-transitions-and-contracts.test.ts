import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';

describe('Routing transitions and contracts', () => {
  it('on_finish transitions route to assistant when any validation invalid', async () => {
    const cfg = {
      version: '1.0',
      output: { pr_comment: { enabled: false } },
      checks: {
        extract: {
          type: 'command',
          exec: 'node -e "console.log(\'[{\\"id\\":1},{\\"id\\":2}]\')"',
          forEach: true,
          on_finish: {
            transitions: [
              {
                when: "any(outputs_history['validate'], v => v && v.is_valid === false) && event.name === 'manual'",
                to: 'assistant',
              },
            ],
          },
        },
        validate: {
          type: 'command',
          depends_on: ['extract'],
          // For each item, emit { is_valid: false }
          exec: 'node -e "console.log(\'{\\"is_valid\\":false}\')"',
        },
        assistant: {
          type: 'log',
          message: 'assistant routed',
          level: 'info',
        },
      },
    } as any;

    const engine = new StateMachineExecutionEngine();
    const res = await engine.executeChecks({
      checks: ['extract', 'validate', 'assistant'],
      config: cfg,
      debug: false,
    });

    // Expect assistant to have run due to transition
    const stats = res.executionStatistics?.checks || [];
    const routed = stats.find(s => s.checkName === 'assistant');
    expect(routed?.totalRuns || 0).toBeGreaterThanOrEqual(1);
  });

  it('assume=false skips check with skipReason=assume', async () => {
    const cfg = {
      version: '1.0',
      checks: {
        c1: {
          type: 'log',
          message: 'should not run',
          level: 'info',
          assume: 'false',
        },
      },
    } as any;

    const engine = new StateMachineExecutionEngine();
    const res = await engine.executeChecks({ checks: ['c1'], config: cfg, debug: false });
    const st = (res.executionStatistics?.checks || []).find(s => s.checkName === 'c1');
    expect(st?.skipped).toBe(true);
    expect(st?.skipReason).toBe('assume');
    expect(st?.totalRuns).toBe(0);
  });

  it('guarantee violation adds a contract/guarantee_failed issue', async () => {
    const cfg = {
      version: '1.0',
      checks: {
        c2: {
          type: 'command',
          exec: 'node -e "console.log(\'{\\"ok\\":false}\')"',
          guarantee: 'output.ok === true',
        },
      },
    } as any;

    const engine = new StateMachineExecutionEngine();
    const res = await engine.executeChecks({ checks: ['c2'], config: cfg, debug: false });
    const issues = (res.reviewSummary.issues || []).filter((i: any) =>
      String(i.ruleId || '').includes('contract/guarantee_failed')
    );
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});
