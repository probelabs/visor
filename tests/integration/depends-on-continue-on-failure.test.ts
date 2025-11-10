import { CheckExecutionEngine } from '../../src/check-execution-engine';
import type { VisorConfig } from '../../src/types/config';

describe('depends_on gating with continue_on_failure', () => {
  test('blocks dependent when dependency fails by default', async () => {
    const engine = new CheckExecutionEngine(process.cwd());
    const cfg: VisorConfig = {
      version: '1.0',
      checks: {
        failer: {
          type: 'command',
          // Emit a non-zero exit via node process.exit(1)
          exec: "node -e 'process.exit(1)'",
          on: ['manual'],
        },
        dep: {
          type: 'command',
          exec: 'node -e "console.log(JSON.stringify({\\"ok\\":true}))"',
          depends_on: ['failer'],
          on: ['manual'],
        },
      },
      output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: false } },
    } as any;

    const res = await engine.executeChecks({
      checks: ['failer', 'dep'],
      config: cfg,
      webhookContext: { eventType: 'manual' } as any,
    });

    const hist = (res.reviewSummary as any).history || {};
    const depHist = Array.isArray(hist['dep']) ? hist['dep'] : [];
    expect(depHist.length).toBe(0);
  });

  test('allows dependent when dependency has continue_on_failure: true', async () => {
    const engine = new CheckExecutionEngine(process.cwd());
    const cfg: VisorConfig = {
      version: '1.0',
      checks: {
        failer: {
          type: 'command',
          exec: "node -e 'process.exit(1)'",
          on: ['manual'],
          continue_on_failure: true,
        },
        dep: {
          type: 'command',
          exec: 'node -e "console.log(JSON.stringify({\\"ok\\":true}))"',
          depends_on: ['failer'],
          on: ['manual'],
        },
      },
      output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: false } },
    } as any;

    const res = await engine.executeChecks({
      checks: ['failer', 'dep'],
      config: cfg,
      webhookContext: { eventType: 'manual' } as any,
    });

    const hist = (res.reviewSummary as any).history || {};
    const depHist = Array.isArray(hist['dep']) ? hist['dep'] : [];
    expect(depHist.length).toBe(1);
  });
});
