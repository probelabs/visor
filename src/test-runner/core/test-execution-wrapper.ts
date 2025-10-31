import type { PRInfo } from '../../pr-analyzer';
import { CheckExecutionEngine } from '../../check-execution-engine';

export class TestExecutionWrapper {
  constructor(private readonly engine: CheckExecutionEngine) {}

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
    try {
      this.engine.resetPerRunState();
    } catch {}

    // Merge mode flags into the current execution context
    try {
      const prev: any = (this.engine as any).executionContext || {};
      const merged = {
        ...prev,
        mode: {
          ...(prev.mode || {}),
          test: true,
          postGroupedComments: true,
          resetPerRunState: true,
        },
      };
      this.engine.setExecutionContext(merged);
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
    return { res, outHistory };
  }
}
