import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';

describe('Schema validation for renderer string schemas (issue-assistant)', () => {
  it('emits contract/schema_validation_failed when required fields are missing', async () => {
    const cfg: VisorConfig = {
      version: '1.0',
      output: { pr_comment: { enabled: false } } as any,
      checks: {
        // Use script provider to return a deterministic object
        issue_step: {
          type: 'script',
          schema: 'issue-assistant',
          content: 'return { text: "hello" };', // missing intent
        } as any,
      },
    } as any;

    const engine = new StateMachineExecutionEngine();
    const res = await engine.executeChecks({ checks: ['issue_step'], config: cfg, debug: false });
    const issues = (res.reviewSummary.issues || []).filter(i =>
      String(i.ruleId || '').includes('contract/schema_validation_failed')
    );
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it('passes validation when output matches the renderer schema', async () => {
    const cfg: VisorConfig = {
      version: '1.0',
      output: { pr_comment: { enabled: false } } as any,
      checks: {
        issue_ok: {
          type: 'script',
          schema: 'issue-assistant',
          content: 'return { text: "ok", intent: "issue_triage" };',
        } as any,
      },
    } as any;

    const engine = new StateMachineExecutionEngine();
    const res = await engine.executeChecks({ checks: ['issue_ok'], config: cfg, debug: false });
    const issues = (res.reviewSummary.issues || []).filter(i =>
      String(i.ruleId || '').includes('contract/schema_validation_failed')
    );
    expect(issues.length).toBe(0);
  });
});
