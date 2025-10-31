// import type { PRInfo } from '../../pr-analyzer';
import type { ExpectBlock } from '../assertions';
import type { ExecutionStatistics } from '../../check-execution-engine';
import { CheckExecutionEngine } from '../../check-execution-engine';
import { RecordingOctokit } from '../recorders/github-recorder';
import { EnvironmentManager } from './environment';
import { MockManager } from './mocks';
import { buildPrInfoFromFixture } from './fixture';
import { evaluateCase as evaluate } from '../evaluators';

type PrintHeaderFn = (
  flowName: string,
  stageName: string,
  event?: string,
  fixture?: string
) => void;
type PrintChecksFn = (checks: string[]) => void;
type MapEventFn = (fixtureName?: string) => import('../../types/config').EventTrigger;
type ComputeChecksFn = (cfg: any, event: string, desired?: Set<string>) => string[];
type WarnUnmockedFn = (
  stats: ExecutionStatistics,
  cfg: any,
  mocks: Record<string, unknown>
) => void;

export class FlowStage {
  constructor(
    private readonly flowName: string,
    private readonly engine: CheckExecutionEngine,
    private readonly recorder: RecordingOctokit,
    private readonly cfg: any,
    private readonly prompts: Record<string, string[]>,
    private readonly promptCap: number | undefined,
    private readonly mapEventFromFixtureName: MapEventFn,
    private readonly computeChecksToRun: ComputeChecksFn,
    private readonly printStageHeader: PrintHeaderFn,
    private readonly printSelectedChecks: PrintChecksFn,
    private readonly warnUnmockedProviders: WarnUnmockedFn
  ) {}

  async run(
    stage: any,
    flowCase: any,
    strict: boolean
  ): Promise<{ name: string; errors?: string[]; stats?: ExecutionStatistics }> {
    const fixtureInput =
      typeof stage.fixture === 'object' && stage.fixture
        ? stage.fixture
        : { builtin: stage.fixture };
    const prInfo = buildPrInfoFromFixture(
      this.mapEventFromFixtureName,
      fixtureInput?.builtin,
      fixtureInput?.overrides
    );
    const eventForStage = this.mapEventFromFixtureName(fixtureInput?.builtin);
    const stageName = `${this.flowName}#${stage.name || 'stage'}`;

    // Stage env overrides
    const envOverrides =
      typeof stage.env === 'object' && stage.env
        ? (stage.env as Record<string, string>)
        : undefined;
    const envMgr = new EnvironmentManager();
    envMgr.apply(envOverrides);

    // Merge per-stage mocks over flow-level defaults (stage overrides flow)
    const mergedMocks = {
      ...(flowCase.mocks || {}),
      ...(typeof stage.mocks === 'object' && stage.mocks ? stage.mocks : {}),
    } as Record<string, unknown>;
    const mockMgr = new MockManager(mergedMocks);

    // Hook execution context for prompts and mocks
    this.engine.setExecutionContext({
      hooks: {
        onPromptCaptured: (info: { step: string; provider: string; prompt: string }) => {
          const k = info.step;
          if (!this.prompts[k]) this.prompts[k] = [];
          const p =
            this.promptCap && info.prompt.length > this.promptCap
              ? info.prompt.slice(0, this.promptCap)
              : info.prompt;
          this.prompts[k].push(p);
          // prompts are captured for assertions only — no ad-hoc console/file output
        },
        mockForStep: (step: string) => mockMgr.get(step),
      },
    } as any);

    // (debug cleanup) removed stage-debug prints

    // Baselines for stage deltas
    const promptBase: Record<string, number> = {};
    for (const [k, arr] of Object.entries(this.prompts)) promptBase[k] = arr.length;
    const callBase = this.recorder.calls.length;
    // Baseline engine execution stats for stage-local deltas
    const statBase: Record<string, number> = {};
    try {
      const es: Map<string, any> | undefined = (this.engine as any).executionStats;
      if (es && typeof (es as any).forEach === 'function') {
        (es as any).forEach((v: any, k: string) => {
          if (k) statBase[k] = (v && v.totalRuns) || 0;
        });
      }
    } catch {}
    const histBase: Record<string, number> = {};
    const baseHistSnap = (this.engine as any).outputHistory as Map<string, unknown[]> | undefined;
    if (baseHistSnap) {
      for (const [k, v] of baseHistSnap.entries()) histBase[k] = (v || []).length;
    }

    // Enable test mode to disable default tag filtering behavior
    const prevTestMode = process.env.VISOR_TEST_MODE;
    process.env.VISOR_TEST_MODE = 'true';
    try {
      // Header
      this.printStageHeader(
        this.flowName,
        stage.name || 'stage',
        eventForStage,
        fixtureInput?.builtin
      );

      // Select checks by event plus any explicitly expected steps (desired)
      let desired: Set<string> | undefined;
      try {
        const calls = ((stage.expect || {}).calls || []) as Array<{ step?: string }>;
        const steps = calls.map(c => c.step).filter(Boolean) as string[];
        if (steps.length > 0) desired = new Set(steps);
      } catch {}
      let checksToRun = this.computeChecksToRun(this.cfg, eventForStage, desired);
      try {
        this.printSelectedChecks(checksToRun);
      } catch {
        console.log(`  checks: ${checksToRun.join(', ')}`);
      }
      if (!checksToRun || checksToRun.length === 0)
        checksToRun = this.computeChecksToRun(this.cfg, eventForStage, desired);

      // Ensure eventContext carries octokit for recorded GitHub ops
      try {
        (prInfo as any).eventContext = {
          ...(prInfo as any).eventContext,
          octokit: this.recorder as unknown as any,
        };
      } catch {}

      // First pass
      const res = await this.engine.executeGroupedChecks(
        prInfo,
        checksToRun,
        120000,
        this.cfg,
        'json',
        process.env.VISOR_DEBUG === 'true',
        undefined,
        false,
        undefined
      );

      // No second-pass fallback in flows to avoid duplicate runs; rely on single execution and deltas
      const mergedStats: ExecutionStatistics | undefined = res.statistics as any;

      // Build stage deltas
      const stagePrompts: Record<string, string[]> = {};
      for (const [k, arr] of Object.entries(this.prompts)) {
        const start = promptBase[k] || 0;
        stagePrompts[k] = (arr as string[]).slice(start);
      }
      const outSnap = this.engine.getOutputHistorySnapshot();
      const stageHist: Record<string, unknown[]> = {};
      for (const [k, arr] of Object.entries(outSnap)) {
        const start = histBase[k] || 0;
        stageHist[k] = (arr as unknown[]).slice(start);
      }

      // Compute stage execution statistics
      const names = new Set<string>();
      try {
        for (const [k, arr] of Object.entries(stagePrompts))
          if (k && Array.isArray(arr) && arr.length > 0) names.add(k);
      } catch {}
      try {
        for (const [k, arr] of Object.entries(stageHist))
          if (k && Array.isArray(arr) && arr.length > 0) names.add(k);
      } catch {}
      try {
        for (const chk of res.statistics.checks || []) {
          if (chk && typeof chk.checkName === 'string' && (chk.totalRuns || 0) > 0)
            names.add(chk.checkName);
        }
      } catch {}
      // Include any merged fallback statistics
      try {
        if (mergedStats && mergedStats !== res.statistics) {
          for (const chk of mergedStats.checks || []) {
            if (chk && typeof chk.checkName === 'string' && (chk.totalRuns || 0) > 0)
              names.add(chk.checkName);
          }
        }
      } catch {}
      for (const n of checksToRun) names.add(n);

      const checks = Array.from(names).map(name => {
        const histArr = Array.isArray(stageHist[name]) ? (stageHist[name] as unknown[]) : [];
        const histRuns = histArr.length;
        const promptRuns = Array.isArray(stagePrompts[name]) ? stagePrompts[name].length : 0;
        const inferred = Math.max(histRuns, promptRuns);
        // Stage-local runs only: do not use global totals across the flow
        let isForEachLike = false;
        try {
          const r = (res.results as any)[name];
          if (r && (Array.isArray((r as any).forEachItems) || (r as any).isForEach === true))
            isForEachLike = true;
        } catch {}
        let depWaveSize = 0;
        try {
          const depList = ((this.cfg.checks || {})[name] || {}).depends_on || [];
          for (const d of depList) {
            const hist = stageHist[d];
            if (Array.isArray(hist) && hist.length > 0) {
              const last = hist[hist.length - 1];
              if (Array.isArray(last) && last.length > 0)
                depWaveSize = Math.max(depWaveSize, last.length);
            }
          }
        } catch {}
        let histPerItemRuns = 0;
        try {
          if (histArr.length > 0) {
            const nonArrays = histArr.filter(v => !Array.isArray(v));
            const arrays = histArr.filter(v => Array.isArray(v));
            if (nonArrays.length > 0 && arrays.length > 0) histPerItemRuns = nonArrays.length;
          }
        } catch {}
        let runs = inferred;
        // If no prompts/outputs, fall back to executionStats delta for this stage
        if (runs === 0) {
          try {
            const es: Map<string, any> | undefined = (this.engine as any).executionStats;
            let current = 0;
            if (es && typeof (es as any).get === 'function') {
              const v = (es as any).get(name);
              current = (v && v.totalRuns) || 0;
            }
            const base = statBase[name] || 0;
            const delta = Math.max(0, current - base);
            runs = Math.max(runs, delta);
          } catch {}
        }
        if (!isForEachLike && histRuns > 0) runs = histRuns;
        if (histPerItemRuns > 0) runs = histPerItemRuns;
        if (depWaveSize > 0) runs = depWaveSize;
        // Heuristic: aggregator runs once after extract-facts on_finish
        try {
          if (
            name === 'aggregate-validations' &&
            Array.isArray(stageHist['extract-facts']) &&
            (stageHist['extract-facts'] as unknown[]).length > 0 &&
            runs === 0
          ) {
            runs = 1;
          }
        } catch {}
        return {
          checkName: name,
          totalRuns: runs,
          successfulRuns: runs,
          failedRuns: 0,
          skipped: false,
          totalDuration: 0,
          issuesFound: 0,
          issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
          perIterationDuration: [],
        } as any;
      });
      const stageStats: ExecutionStatistics = {
        totalChecksConfigured: checks.length,
        totalExecutions: checks.reduce((a, c: any) => a + (c.totalRuns || 0), 0),
        successfulExecutions: checks.reduce((a, c: any) => a + (c.successfulRuns || 0), 0),
        failedExecutions: checks.reduce((a, c: any) => a + (c.failedRuns || 0), 0),
        skippedChecks: 0,
        totalDuration: 0,
        checks,
      } as any;

      // Evaluate stage
      const expect: ExpectBlock = stage.expect || {};
      // evaluation proceeds without ad-hoc stage prompt previews
      const errors = evaluate(
        stageName,
        stageStats,
        { calls: this.recorder.calls.slice(callBase) } as any,
        expect,
        strict,
        stagePrompts,
        res.results,
        stageHist
      );

      // Warn about unmocked AI/command steps that executed
      try {
        this.warnUnmockedProviders(stageStats, this.cfg, mergedMocks);
      } catch {}

      envMgr.restore();
      if (prevTestMode === undefined) delete process.env.VISOR_TEST_MODE;
      else process.env.VISOR_TEST_MODE = prevTestMode;
      if (errors.length === 0) return { name: stageName, stats: stageStats };
      return { name: stageName, errors, stats: stageStats };
    } catch (err) {
      envMgr.restore();
      if (prevTestMode === undefined) delete process.env.VISOR_TEST_MODE;
      else process.env.VISOR_TEST_MODE = prevTestMode;
      return { name: stageName, errors: [err instanceof Error ? err.message : String(err)] };
    }
  }
}
