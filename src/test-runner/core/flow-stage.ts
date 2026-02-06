// import type { PRInfo } from '../../pr-analyzer';
import type { ExpectBlock } from '../assertions';
import type { ExecutionStatistics } from '../../types/execution';
import { StateMachineExecutionEngine } from '../../state-machine-execution-engine';
import { RecordingOctokit } from '../recorders/github-recorder';
import { RecordingSlack } from '../recorders/slack-recorder';
import { EnvironmentManager } from './environment';
import { MockManager } from './mocks';
import { buildPrInfoFromFixture } from './fixture';
import { evaluateCase as evaluate } from '../evaluators';
import { TestExecutionWrapper } from './test-execution-wrapper';

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
    private readonly engine: StateMachineExecutionEngine,
    private readonly recorder: RecordingOctokit,
    private readonly cfg: any,
    private readonly prompts: Record<string, string[]>,
    private readonly promptCap: number | undefined,
    private readonly mapEventFromFixtureName: MapEventFn,
    private readonly computeChecksToRun: ComputeChecksFn,
    private readonly printStageHeader: PrintHeaderFn,
    private readonly printSelectedChecks: PrintChecksFn,
    private readonly warnUnmockedProviders: WarnUnmockedFn,
    private readonly defaultIncludeTags?: string[],
    private readonly defaultExcludeTags?: string[],
    private readonly defaultFrontends?: any[]
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

    // Hook execution context for prompts and mocks, preserving existing context and octokit
    const prevCtx: any = (this.engine as any).executionContext || {};
    this.engine.setExecutionContext({
      ...prevCtx,
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
    // Slack recorder baseline will be captured after we inject frontends/slack into executionContext
    let slackRecorder: any | undefined;
    let slackBase = 0;
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
      // Pass stage baseline to providers through execution context so they can
      // compute outputs_history_stage for template guards and assertions.
      try {
        const prev: any = (this.engine as any).executionContext || {};
        this.engine.setExecutionContext({
          ...prev,
          stageHistoryBase: histBase,
        } as any);
      } catch {}

      // Build tag filter from defaults + flow-level + stage-level overrides
      const parseTags = (v: unknown): string[] | undefined => {
        if (!v) return undefined;
        if (Array.isArray(v))
          return (v as unknown[])
            .map(String)
            .map(s => s.trim())
            .filter(Boolean);
        if (typeof v === 'string')
          return v
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);
        return undefined;
      };
      const flowInclude = parseTags((flowCase as any).tags);
      const flowExclude = parseTags((flowCase as any).exclude_tags);
      const stageInclude = parseTags((stage as any).tags);
      const stageExclude = parseTags((stage as any).exclude_tags);
      const include = Array.from(
        new Set([
          ...(this.defaultIncludeTags || []),
          ...(flowInclude || []),
          ...(stageInclude || []),
        ])
      );
      const exclude = Array.from(
        new Set([
          ...(this.defaultExcludeTags || []),
          ...(flowExclude || []),
          ...(stageExclude || []),
        ])
      );
      const tagFilter = {
        include: include.length ? include : undefined,
        exclude: exclude.length ? exclude : undefined,
      };

      // Merge stage-level routing configuration into config
      const stageConfig = { ...this.cfg };
      // Enable suite frontends only for PR events; disable GitHub for issue events
      try {
        const ev = (eventForStage || '').toLowerCase();
        const isPr = ev === 'pr_opened' || ev === 'pr_updated' || ev === 'pr_closed';
        if (Array.isArray(this.defaultFrontends) && this.defaultFrontends.length > 0) {
          if (isPr) {
            const norm = (this.defaultFrontends as any[]).map(x =>
              typeof x === 'string' ? { name: x } : x
            );
            (stageConfig as any).frontends = norm;
            // Seed octokit for frontends that need it (e.g., GitHub)
            const prev: any = (this.engine as any).executionContext || {};
            const wantsSlack = norm.some(f => (f && (f as any).name) === 'slack');
            const ctxPatch: any = { ...prev, octokit: this.recorder as unknown as any };
            if (wantsSlack) ctxPatch.slack = new RecordingSlack();
            this.engine.setExecutionContext(ctxPatch);
            // Capture Slack baseline now that we've injected it
            try {
              const ec: any = (this.engine as any).executionContext || {};
              slackRecorder = ec.slack || ec.slackClient;
              if (slackRecorder && Array.isArray(slackRecorder.calls))
                slackBase = slackRecorder.calls.length;
            } catch {}
          } else {
            // Remove GitHub frontend for issue events to satisfy no-comment expectations
            const curr = Array.isArray((stageConfig as any).frontends)
              ? ((stageConfig as any).frontends as any[])
              : [];
            (stageConfig as any).frontends = curr.filter(
              f => f && f.name !== 'github' && f.name !== 'slack'
            );
          }
        }
      } catch {}
      if ((stage as any).routing) {
        stageConfig.routing = {
          ...(this.cfg.routing || {}),
          ...(stage as any).routing,
        };
      }

      const wrapper = new TestExecutionWrapper(this.engine);
      const { res, outHistory } = await wrapper.execute(
        prInfo,
        checksToRun,
        stageConfig,
        process.env.VISOR_DEBUG === 'true',
        tagFilter
      );

      // No second-pass fallback in flows to avoid duplicate runs; rely on single execution and deltas
      const mergedStats: ExecutionStatistics | undefined = res.statistics as any;

      // Build stage deltas
      const stagePrompts: Record<string, string[]> = {};
      for (const [k, arr] of Object.entries(this.prompts)) {
        const start = promptBase[k] || 0;
        stagePrompts[k] = (arr as string[]).slice(start);
      }
      // Use the snapshot captured immediately after the grouped run.
      // The engine resets outputHistory at stage start, so deltas vs. histBase
      // are not meaningful; stageHist is exactly the run snapshot.
      const stageHist: Record<string, unknown[]> = {};
      for (const [k, arr] of Object.entries(outHistory || {})) {
        stageHist[k] = Array.isArray(arr) ? (arr as unknown[]) : [];
      }
      try {
        if (process.env.VISOR_DEBUG === 'true') {
          const parts = Object.entries(stageHist)
            .map(([k, a]) => `${k}:${Array.isArray(a) ? (a as any[]).length : 0}`)
            .join(', ');
          console.error(`[stage-hist] ${stageName} keys=${parts}`);
        }
      } catch {}

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
      // Also include any checks that produced results in this grouped run
      try {
        const resNames = Object.keys((res as any).results || {});
        for (const k of resNames) {
          if (!k) continue;
          const isRealCheck = Boolean(((this.cfg as any).checks || {})[k]);
          if (isRealCheck) names.add(k);
        }
      } catch {}
      // Include any checks that executed in this stage per executionStats delta
      try {
        const es: Map<string, any> | undefined = (this.engine as any).executionStats;
        if (es && typeof (es as any).forEach === 'function') {
          (es as any).forEach((v: any, k: string) => {
            const current = (v && v.totalRuns) || 0;
            const base = statBase[k] || 0;
            if (current > base) names.add(k);
          });
        }
      } catch {}

      // Pre-compute executionStats deltas per check
      const deltaMap: Record<string, number> = {};
      try {
        const es: Map<string, any> | undefined = (this.engine as any).executionStats;
        if (es && typeof (es as any).forEach === 'function') {
          (es as any).forEach((v: any, k: string) => {
            const current = (v && v.totalRuns) || 0;
            const base = statBase[k] || 0;
            const d = Math.max(0, current - base);
            if (d > 0) deltaMap[k] = d;
          });
        }
      } catch {}

      const presentInResults = new Set<string>();
      try {
        for (const k of Object.keys((res as any).results || {})) {
          if (!k) continue;
          const isRealCheck = Boolean(((this.cfg as any).checks || {})[k]);
          if (isRealCheck) presentInResults.add(k);
        }
      } catch {}
      // Prefer authoritative counts from res.statistics when available, then fall back to deltas/inferred
      const fromResStats: Record<string, number> = {};
      const resSkipped: Record<string, boolean> = {};
      try {
        for (const s of (res.statistics?.checks || []) as any[]) {
          const n = (s && s.checkName) || '';
          if (typeof n === 'string' && n) {
            fromResStats[n] = (s.totalRuns || 0) as number;
            resSkipped[n] = !!(s as any).skipped || !!(s as any).skipReason;
          }
        }
      } catch {}

      // Steps that have explicit expectations in this stage. We will use
      // this to avoid inflating run counts (via parent-alignment heuristics)
      // for checks that are not even expected in this stage.
      const expectedSteps = new Set<string>();
      const expectedZero = new Set<string>();
      try {
        const expCalls = ((stage.expect || {}).calls || []) as Array<{ step?: string }>;
        for (const c of expCalls) {
          if (c && typeof c.step === 'string' && c.step) expectedSteps.add(c.step);
          try {
            if (c && typeof c.step === 'string' && c.step && (c as any).exactly === 0)
              expectedZero.add(c.step);
          } catch {}
        }
      } catch {}

      const checks = Array.from(names).map(name => {
        const histArr = Array.isArray(stageHist[name]) ? (stageHist[name] as unknown[]) : [];
        const histRuns = histArr.length;
        const promptRuns = Array.isArray(stagePrompts[name]) ? stagePrompts[name].length : 0;
        const inferred = Math.max(histRuns, promptRuns);
        // Stage-local runs only: do not use global totals across the flow
        let isForEachLike = false;
        // Prefer configuration: if the check declares forEach, treat it as forEach-like
        try {
          const cfgCheck = ((this.cfg || {}) as any).checks?.[name];
          if (cfgCheck && cfgCheck.forEach === true) isForEachLike = true;
        } catch {}
        // Fallback to results heuristics (for providers that emit forEach metadata)
        if (!isForEachLike) {
          try {
            const r = (res.results as any)[name];
            if (r && (Array.isArray((r as any).forEachItems) || (r as any).isForEach === true))
              isForEachLike = true;
          } catch {}
        }
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
        // Prefer res.statistics delta if present, else engine.executionStats delta, else inferred
        let runs: number;
        const resTotal = fromResStats[name];
        if (typeof resTotal === 'number') {
          // If the wrapper reset per-run state, res.statistics totals are stage-only.
          // In that case, ignore baseline.
          const ctx: any = (this.engine as any).executionContext || {};
          const stageOnly = !!(ctx.mode && ctx.mode.resetPerRunState);
          const base = stageOnly ? 0 : statBase[name] || 0;
          const d = Math.max(0, resTotal - base);
          runs = d > 0 ? d : 0;
          // If the engine marked this check as skipped, force runs to 0
          // so parent-alignment heuristics below do not inflate it.
          if (resSkipped[name]) {
            runs = 0;
          }
        } else {
          runs = deltaMap[name] !== undefined ? deltaMap[name] : inferred;
        }
        if (runs === 0 && presentInResults.has(name) && !resSkipped[name]) runs = 1;
        if (!isForEachLike && histRuns > 0) runs = histRuns;
        // Only use per-item history counts for non-forEach checks. For forEach parents,
        // use aggregated totals from res.statistics to reflect number of parent executions.
        if (!isForEachLike && histPerItemRuns > 0) runs = histPerItemRuns;
        // Align to parent wave size only when we couldn't observe any
        // stage-local history for this check (avoid clobbering multi-wave counts).
        if (depWaveSize > 0 && histRuns === 0 && histPerItemRuns === 0) runs = depWaveSize;
        // Generic dependent alignment: if a check has direct parents that executed
        // more times in this stage (per statistics delta), align to the max parent delta.
        try {
          let parentMax = 0;
          const depList = ((this.cfg.checks || {})[name] || {}).depends_on || [];
          const parents: string[] = Array.isArray(depList)
            ? (depList as any[]).flatMap((t: any) =>
                typeof t === 'string' && t.includes('|')
                  ? t.split('|').map((s: string) => s.trim())
                  : [String(t)]
              )
            : [];
          for (const p of parents) {
            if (!p) continue;
            const baseP = statBase[p] || 0;
            const resTotP = fromResStats[p];
            const dP =
              typeof resTotP === 'number' ? Math.max(0, resTotP - baseP) : deltaMap[p] || 0;
            parentMax = Math.max(parentMax, dP);
          }
          // Apply only for non-forEach checks with no observable history in this stage
          if (
            !isForEachLike &&
            histRuns === 0 &&
            histPerItemRuns === 0 &&
            parentMax > 0 &&
            !resSkipped[name] &&
            (expectedSteps.size === 0 || expectedSteps.has(name)) &&
            !expectedZero.has(name)
          ) {
            runs = Math.max(runs, parentMax);
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

      try {
        if (process.env.VISOR_DEBUG === 'true') {
          const totals: Record<string, number> = {};
          for (const c of checks as any[]) totals[(c as any).checkName] = (c as any).totalRuns || 0;
          const resTotals: Record<string, number> = {};
          try {
            for (const s of (res.statistics?.checks || []) as any[]) {
              const n = (s && s.checkName) || '';
              if (typeof n === 'string' && n) resTotals[n] = (s.totalRuns || 0) as number;
            }
          } catch {}
          const baseTotals: Record<string, number> = {};
          for (const [n, b] of Object.entries(statBase)) baseTotals[n] = b || 0;

          console.error(
            `[stage-counts] ${stageName} totals=${JSON.stringify(totals)} resTotals=${JSON.stringify(resTotals)} base=${JSON.stringify(baseTotals)}`
          );
        }
      } catch {}

      // Evaluate stage
      const expect: ExpectBlock = stage.expect || {};
      // evaluation proceeds without ad-hoc stage prompt previews
      const errors = evaluate(
        stageName,
        stageStats,
        { calls: this.recorder.calls.slice(callBase) } as any,
        slackRecorder ? { calls: (slackRecorder.calls || []).slice(slackBase) } : undefined,
        expect,
        strict,
        stagePrompts,
        res.results,
        stageHist
      );
      try {
        if (process.env.VISOR_DEBUG === 'true' && slackRecorder) {
          // eslint-disable-next-line no-console
          console.log(
            `[debug] slack calls (stage delta) = ${(slackRecorder.calls || []).slice(slackBase).length}`
          );
        }
      } catch {}

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
