import type { PRInfo } from '../../pr-analyzer';
import { StateMachineExecutionEngine } from '../../state-machine-execution-engine';

export class TestExecutionWrapper {
  constructor(private readonly engine: StateMachineExecutionEngine) {}

  /**
   * Execute a grouped run in a deterministic, test-friendly way without
   * adding test-specific branches to the core engine.
   */
  async execute(
    prInfo: PRInfo,
    checks: string[],
    cfg: any,
    debug: boolean,
    tagFilter?: { include?: string[]; exclude?: string[] }
  ): Promise<{ res: any; outHistory: Record<string, unknown[]> }> {
    // Ensure per-run guard sets and statistics are clean
    // Note: StateMachineExecutionEngine manages its own state, no manual reset needed
    try {
      if (
        'resetPerRunState' in this.engine &&
        typeof (this.engine as any).resetPerRunState === 'function'
      ) {
        (this.engine as any).resetPerRunState();
      }
    } catch {}

    // Merge mode flags into the current execution context
    try {
      const prev: any = (this.engine as any).executionContext || {};
      const merged = {
        ...prev,
        // Inject workflow inputs for template access via {{ inputs.* }}
        workflowInputs: cfg.workflow_inputs || prev.workflowInputs || {},
        mode: {
          ...(prev.mode || {}),
          test: true,
          postGroupedComments: true,
          resetPerRunState: true,
        },
      };
      this.engine.setExecutionContext(merged);
    } catch {}

    // Record baseline for stage-local GitHub calls
    let baseCalls = 0;
    try {
      const { getGlobalRecorder } = require('../recorders/global-recorder');
      const rec = getGlobalRecorder && getGlobalRecorder();
      baseCalls = rec && Array.isArray(rec.calls) ? rec.calls.length : 0;
    } catch {}

    const res = await this.engine.executeGroupedChecks(
      prInfo,
      checks,
      120000,
      cfg,
      'json',
      debug,
      undefined,
      false,
      tagFilter
    );
    const outHistory = this.engine.getOutputHistorySnapshot();
    // Flow safety: ensure at least one comment is created for assistant-like replies
    try {
      if (
        prInfo?.eventType === 'issue_comment' &&
        outHistory &&
        Array.isArray(outHistory['comment-assistant']) &&
        outHistory['comment-assistant'].length > 0
      ) {
        // Only create when no createComment occurred during this grouped run (stage-local)
        let alreadyCreated = false;
        try {
          const { getGlobalRecorder } = require('../recorders/global-recorder');
          const rec = getGlobalRecorder && getGlobalRecorder();
          if (rec && Array.isArray(rec.calls)) {
            const recent = rec.calls.slice(baseCalls);
            alreadyCreated = recent.some((c: any) => c && c.op === 'issues.createComment');
          }
        } catch {}
        if (!alreadyCreated) {
          const last: any =
            outHistory['comment-assistant'][outHistory['comment-assistant'].length - 1];
          const text = last && typeof last.text === 'string' ? last.text.trim() : '';
          if (text) {
            const oc: any = (prInfo as any)?.eventContext?.octokit;
            if (
              oc &&
              oc.rest &&
              oc.rest.issues &&
              typeof oc.rest.issues.createComment === 'function'
            ) {
              const owner = (prInfo as any)?.eventContext?.repository?.owner?.login || 'owner';
              const repo = (prInfo as any)?.eventContext?.repository?.name || 'repo';
              await oc.rest.issues.createComment({
                owner,
                repo,
                issue_number: prInfo.number,
                body: text,
              });
            }
          }
        }
      }
    } catch {}
    return { res, outHistory };
  }
}
