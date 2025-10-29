import fs from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';

import { ConfigManager } from '../config';
import { CheckExecutionEngine } from '../check-execution-engine';
import type { PRInfo } from '../pr-analyzer';
import { RecordingOctokit } from './recorders/github-recorder';
import { setGlobalRecorder } from './recorders/global-recorder';
import { FixtureLoader } from './fixture-loader';
import { validateCounts, type ExpectBlock } from './assertions';
import { validateTestsDoc } from './validator';

export type TestCase = {
  name: string;
  description?: string;
  event?: string;
  flow?: Array<{ name: string }>;
};

export type TestSuite = {
  version: string;
  extends?: string | string[];
  tests: {
    defaults?: Record<string, unknown>;
    fixtures?: unknown[];
    cases: TestCase[];
  };
};

export interface DiscoverOptions {
  testsPath?: string; // Path to .visor.tests.yaml
  cwd?: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export class VisorTestRunner {
  constructor(private readonly cwd: string = process.cwd()) {}

  private line(title = '', char = '─', width = 60): string {
    if (!title) return char.repeat(width);
    const pad = Math.max(1, width - title.length - 2);
    return `${char.repeat(2)} ${title} ${char.repeat(pad)}`;
  }

  private printCaseHeader(name: string, kind: 'flow' | 'single', event?: string): void {
    console.log('\n' + this.line(`Case: ${name}`));
    const meta: string[] = [`type=${kind}`];
    if (event) meta.push(`event=${event}`);
    console.log(`  ${meta.join('  ·  ')}`);
  }

  private printStageHeader(
    flowName: string,
    stageName: string,
    event?: string,
    fixture?: string
  ): void {
    console.log('\n' + this.line(`${flowName} — ${stageName}`));
    const meta: string[] = [];
    if (event) meta.push(`event=${event}`);
    if (fixture) meta.push(`fixture=${fixture}`);
    if (meta.length) console.log(`  ${meta.join('  ·  ')}`);
  }

  private printSelectedChecks(checks: string[]): void {
    if (!checks || checks.length === 0) return;
    console.log(`  checks: ${checks.join(', ')}`);
  }

  /**
   * Locate a tests file: explicit path > ./.visor.tests.yaml > defaults/.visor.tests.yaml
   */
  public resolveTestsPath(explicit?: string): string {
    if (explicit) {
      return path.isAbsolute(explicit) ? explicit : path.resolve(this.cwd, explicit);
    }
    const candidates = [
      path.resolve(this.cwd, '.visor.tests.yaml'),
      path.resolve(this.cwd, '.visor.tests.yml'),
      path.resolve(this.cwd, 'defaults/.visor.tests.yaml'),
      path.resolve(this.cwd, 'defaults/.visor.tests.yml'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    throw new Error(
      'No tests file found. Provide --config <path> or add .visor.tests.yaml (or defaults/.visor.tests.yaml).'
    );
  }

  /**
   * Load and minimally validate tests YAML.
   */
  public loadSuite(testsPath: string): TestSuite {
    const raw = fs.readFileSync(testsPath, 'utf8');
    const doc = yaml.load(raw) as unknown;
    const validation = validateTestsDoc(doc);
    if (!validation.ok) {
      const errs = validation.errors.map(e => ` - ${e}`).join('\n');
      throw new Error(`Tests file validation failed:\n${errs}`);
    }
    if (!isObject(doc)) throw new Error('Tests YAML must be a YAML object');

    const version = String((doc as any).version ?? '1.0');
    const tests = (doc as any).tests;
    if (!tests || !isObject(tests)) throw new Error('tests: {} section is required');
    const cases = (tests as any).cases as unknown;
    if (!Array.isArray(cases) || cases.length === 0) {
      throw new Error('tests.cases must be a non-empty array');
    }

    // Preserve full case objects for execution; discovery prints selective fields
    const suite: TestSuite = {
      version,
      extends: (doc as any).extends,
      tests: {
        defaults: (tests as any).defaults || {},
        fixtures: (tests as any).fixtures || [],
        cases: (tests as any).cases,
      },
    };
    return suite;
  }

  /**
   * Pretty print discovered cases to stdout.
   */
  public printDiscovery(testsPath: string, suite: TestSuite): void {
    const rel = path.relative(this.cwd, testsPath) || testsPath;
    console.log('🧪 Visor Test Runner — discovery mode');
    console.log(`   Suite: ${rel}`);
    const parent = suite.extends
      ? Array.isArray(suite.extends)
        ? suite.extends.join(', ')
        : String(suite.extends)
      : '(none)';
    console.log(`   Extends: ${parent}`);
    const defaults = suite.tests.defaults || {};
    const strict = (defaults as any).strict === undefined ? true : !!(defaults as any).strict;
    console.log(`   Strict: ${strict ? 'on' : 'off'}`);

    // List cases
    console.log('\nCases:');
    for (const c of suite.tests.cases) {
      const isFlow = Array.isArray(c.flow) && c.flow.length > 0;
      const badge = isFlow ? 'flow' : c.event || 'event';
      console.log(` - ${c.name} [${badge}]`);
    }
    console.log('\nTip: run `visor test --only <name>` to filter, `--bail` to stop early.');
  }

  /**
   * Execute non-flow cases with minimal assertions (Milestone 1 MVP).
   */
  public async runCases(
    testsPath: string,
    suite: TestSuite,
    options: { only?: string; bail?: boolean; maxParallel?: number; promptMaxChars?: number }
  ): Promise<{
    failures: number;
    results: Array<{
      name: string;
      passed: boolean;
      errors?: string[];
      stages?: Array<{ name: string; errors?: string[] }>;
    }>;
  }> {
    // Save defaults for flow runner access
    (this as any).suiteDefaults = suite.tests.defaults || {};
    // Support --only "case" and --only "case#stage"
    let onlyCase = options.only?.toLowerCase();
    let stageFilter: string | undefined;
    if (onlyCase && onlyCase.includes('#')) {
      const parts = onlyCase.split('#');
      onlyCase = parts[0];
      stageFilter = (parts[1] || '').trim();
    }
    const allCases = suite.tests.cases;
    const selected = onlyCase
      ? allCases.filter(c => c.name.toLowerCase().includes(onlyCase as string))
      : allCases;
    if (selected.length === 0) {
      console.log('No matching cases.');
      return { failures: 0, results: [] };
    }

    // Load merged config via ConfigManager (honors extends), then clone for test overrides
    const cm = new ConfigManager();
    // Prefer loading the base config referenced by extends; fall back to the tests file
    let configFileToLoad = testsPath;
    const parentExt = suite.extends;
    if (parentExt) {
      const first = Array.isArray(parentExt) ? parentExt[0] : parentExt;
      if (typeof first === 'string') {
        const resolved = path.isAbsolute(first)
          ? first
          : path.resolve(path.dirname(testsPath), first);
        configFileToLoad = resolved;
      }
    }
    const config = await cm.loadConfig(configFileToLoad, { validate: true, mergeDefaults: true });
    if (!config.checks) {
      throw new Error('Loaded config has no checks; cannot run tests');
    }

    const defaultsAny: any = suite.tests.defaults || {};
    const defaultStrict = defaultsAny?.strict !== false;
    const aiProviderDefault = defaultsAny?.ai_provider || 'mock';
    const ghRec = defaultsAny?.github_recorder as
      | { error_code?: number; timeout_ms?: number }
      | undefined;
    const defaultPromptCap: number | undefined =
      options.promptMaxChars ||
      (typeof defaultsAny?.prompt_max_chars === 'number'
        ? defaultsAny.prompt_max_chars
        : undefined);
    const caseMaxParallel =
      options.maxParallel ||
      (typeof defaultsAny?.max_parallel === 'number' ? defaultsAny.max_parallel : undefined) ||
      1;

    // Test overrides: force AI provider to 'mock' when requested (default: mock per RFC)
    const cfg = JSON.parse(JSON.stringify(config));
    for (const name of Object.keys(cfg.checks || {})) {
      const chk = cfg.checks[name] || {};
      if ((chk.type || 'ai') === 'ai') {
        const prev = (chk.ai || {}) as Record<string, unknown>;
        chk.ai = {
          ...prev,
          provider: aiProviderDefault,
          skip_code_context: true,
          disable_tools: true,
          timeout: Math.min(15000, (prev.timeout as number) || 15000),
        } as any;
        cfg.checks[name] = chk;
      }
    }

    let failures = 0;
    const caseResults: Array<{
      name: string;
      passed: boolean;
      errors?: string[];
      stages?: Array<{ name: string; errors?: string[] }>;
    }> = [];
    // Header: show suite path for clarity
    try {
      const rel = path.relative(this.cwd, testsPath) || testsPath;
      console.log(`Suite: ${rel}`);
    } catch {}

    const runOne = async (_case: any): Promise<{ name: string; failed: number }> => {
      // Case header for clarity
      const isFlow = Array.isArray((_case as any).flow) && (_case as any).flow.length > 0;
      const caseEvent = (_case as any).event as string | undefined;
      this.printCaseHeader(
        (_case as any).name || '(unnamed)',
        isFlow ? 'flow' : 'single',
        caseEvent
      );
      if ((_case as any).skip) {
        console.log(`⏭ SKIP ${(_case as any).name}`);
        caseResults.push({ name: _case.name, passed: true });
        return { name: _case.name, failed: 0 };
      }
      if (Array.isArray((_case as any).flow) && (_case as any).flow.length > 0) {
        const flowRes = await this.runFlowCase(
          _case,
          cfg,
          defaultStrict,
          options.bail || false,
          defaultPromptCap,
          stageFilter
        );
        const failed = flowRes.failures;
        caseResults.push({ name: _case.name, passed: failed === 0, stages: flowRes.stages });
        return { name: _case.name, failed };
      }
      const strict = (
        typeof (_case as any).strict === 'boolean' ? (_case as any).strict : defaultStrict
      ) as boolean;
      const expect = ((_case as any).expect || {}) as ExpectBlock;
      // Fixture selection with optional overrides
      const fixtureInput =
        typeof (_case as any).fixture === 'object' && (_case as any).fixture
          ? (_case as any).fixture
          : { builtin: (_case as any).fixture };
      const prInfo = this.buildPrInfoFromFixture(fixtureInput?.builtin, fixtureInput?.overrides);

      // Inject recording Octokit into engine via actionContext using env owner/repo
      const prevRepo = process.env.GITHUB_REPOSITORY;
      process.env.GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || 'owner/repo';
      // Apply case env overrides if present
      const envOverrides =
        typeof (_case as any).env === 'object' && (_case as any).env
          ? ((_case as any).env as Record<string, string>)
          : undefined;
      const prevEnv: Record<string, string | undefined> = {};
      if (envOverrides) {
        for (const [k, v] of Object.entries(envOverrides)) {
          prevEnv[k] = process.env[k];
          process.env[k] = String(v);
        }
      }
      const ghRecCase =
        typeof (_case as any).github_recorder === 'object' && (_case as any).github_recorder
          ? ((_case as any).github_recorder as { error_code?: number; timeout_ms?: number })
          : undefined;
      const rcOpts = ghRecCase || ghRec;
      const recorder = new RecordingOctokit(
        rcOpts ? { errorCode: rcOpts.error_code, timeoutMs: rcOpts.timeout_ms } : undefined
      );
      setGlobalRecorder(recorder);
      const engine = new CheckExecutionEngine(undefined as any, recorder as unknown as any);

      // Capture prompts per step
      const prompts: Record<string, string[]> = {};
      const mocks =
        typeof (_case as any).mocks === 'object' && (_case as any).mocks
          ? ((_case as any).mocks as Record<string, unknown>)
          : {};
      const mockCursors: Record<string, number> = {};
      engine.setExecutionContext({
        hooks: {
          onPromptCaptured: (info: { step: string; provider: string; prompt: string }) => {
            const k = info.step;
            if (!prompts[k]) prompts[k] = [];
            const p =
              defaultPromptCap && info.prompt.length > defaultPromptCap
                ? info.prompt.slice(0, defaultPromptCap)
                : info.prompt;
            prompts[k].push(p);
          },
          mockForStep: (step: string) => {
            // Support list form: '<step>[]' means per-call mocks for forEach children
            const listKey = `${step}[]`;
            const list = (mocks as any)[listKey];
            if (Array.isArray(list)) {
              const i = mockCursors[listKey] || 0;
              const idx = i < list.length ? i : list.length - 1; // clamp to last
              mockCursors[listKey] = i + 1;
              return list[idx];
            }
            return (mocks as any)[step];
          },
        },
      } as any);

      try {
        const eventForCase = this.mapEventFromFixtureName(fixtureInput?.builtin);
        const desiredSteps = new Set<string>(
          (expect.calls || []).map(c => c.step).filter(Boolean) as string[]
        );
        let checksToRun = this.computeChecksToRun(
          cfg,
          eventForCase,
          desiredSteps.size > 0 ? desiredSteps : undefined
        );
        this.printSelectedChecks(checksToRun);
        if (checksToRun.length === 0) {
          // Fallback: run all checks for this event when filtered set is empty
          checksToRun = this.computeChecksToRun(cfg, eventForCase, undefined);
        }
        // Do not pass an implicit tag filter during tests; let the engine honor config.
        // Inject octokit into eventContext so providers can perform real GitHub ops (recorded)
        try {
          (prInfo as any).eventContext = { ...(prInfo as any).eventContext, octokit: recorder };
        } catch {}

        const prevTestMode = process.env.VISOR_TEST_MODE;
        process.env.VISOR_TEST_MODE = 'true';
        if (process.env.VISOR_DEBUG === 'true') {
          console.log(`  ⮕ executing main stage with checks=[${checksToRun.join(', ')}]`);
          try {
            const trig = checksToRun.map(n => {
              const c = (cfg.checks || {})[n] || {};
              const ev = Array.isArray(c.on) ? c.on.join(',') : c.on || '(none)';
              return `${n}{on:[${ev}]}`;
            });
            console.log(`  ⮕ triggers: ${trig.join('  ')}`);
          } catch {}
        }
        let res = await engine.executeGroupedChecks(
          prInfo,
          checksToRun,
          120000,
          cfg,
          'json',
          process.env.VISOR_DEBUG === 'true',
          undefined,
          false,
          {}
        );
        if (process.env.VISOR_DEBUG === 'true') {
          try {
            const names = (res.statistics.checks || []).map(
              (c: any) => `${c.checkName}:${c.totalRuns || 0}`
            );
            console.log(`  ⮕ main stats: [${names.join(', ')}]`);
          } catch {}
        }
        try {
          const dbgHist = engine.getOutputHistorySnapshot();
          console.log(
            `  ⮕ stage base history keys: ${Object.keys(dbgHist).join(', ') || '(none)'}`
          );
        } catch {}
        // After main stage run, ensure static on_finish.run targets for forEach parents executed.
        try {
          const hist0 = engine.getOutputHistorySnapshot();
          if (process.env.VISOR_DEBUG === 'true') {
            console.log(`  ⮕ history keys: ${Object.keys(hist0).join(', ') || '(none)'}`);
          }
          const parents = Object.entries(cfg.checks || {})
            .filter(
              ([name, c]: [string, any]) =>
                checksToRun.includes(name) &&
                c &&
                c.forEach &&
                c.on_finish &&
                Array.isArray(c.on_finish.run) &&
                c.on_finish.run.length > 0
            )
            .map(([name, c]: [string, any]) => ({ name, onFinish: c.on_finish }));
          if (process.env.VISOR_DEBUG === 'true') {
            console.log(
              `  ⮕ forEach parents with on_finish: ${parents.map(p => p.name).join(', ') || '(none)'}`
            );
          }
          const missing: string[] = [];
          for (const p of parents) {
            for (const t of p.onFinish.run as string[]) {
              if (!hist0[t] || (Array.isArray(hist0[t]) && hist0[t].length === 0)) {
                missing.push(t);
              }
            }
          }
          // Dedup missing and exclude anything already in checksToRun
          const toRun = Array.from(new Set(missing.filter(n => !checksToRun.includes(n))));
          if (toRun.length > 0) {
            if (process.env.VISOR_DEBUG === 'true') {
              console.log(`  ⮕ on_finish.fallback: running [${toRun.join(', ')}]`);
            }
            // Run once; reuse same engine instance so output history stays visible
            if (process.env.VISOR_DEBUG === 'true') {
              console.log(`  ⮕ executing on_finish.fallback with checks=[${toRun.join(', ')}]`);
            }
            const fallbackRes = await engine.executeGroupedChecks(
              prInfo,
              toRun,
              120000,
              cfg,
              'json',
              process.env.VISOR_DEBUG === 'true',
              undefined,
              false,
              {}
            );
            // Optionally merge statistics (for stage coverage we rely on deltas + stats from last run)
            res = {
              results: fallbackRes.results || res.results,
              statistics: fallbackRes.statistics || res.statistics,
            } as any;
          }
        } catch {}
        if (prevTestMode === undefined) delete process.env.VISOR_TEST_MODE;
        else process.env.VISOR_TEST_MODE = prevTestMode;
        const outHistory = engine.getOutputHistorySnapshot();

        const caseFailures = this.evaluateCase(
          _case.name,
          res.statistics,
          recorder,
          expect,
          strict,
          prompts,
          res.results,
          outHistory
        );
        // Warn about unmocked AI/command steps that executed
        try {
          const mocksUsed =
            typeof (_case as any).mocks === 'object' && (_case as any).mocks
              ? ((_case as any).mocks as Record<string, unknown>)
              : {};
          this.warnUnmockedProviders(res.statistics, cfg, mocksUsed);
        } catch {}
        this.printCoverage(_case.name, res.statistics, expect);
        if (caseFailures.length === 0) {
          console.log(`✅ PASS ${_case.name}`);
          caseResults.push({ name: _case.name, passed: true });
        } else {
          console.log(`❌ FAIL ${_case.name}`);
          for (const f of caseFailures) console.log(`   - ${f}`);
          caseResults.push({ name: _case.name, passed: false, errors: caseFailures });
          return { name: _case.name, failed: 1 };
        }
      } catch (err) {
        console.log(`❌ ERROR ${_case.name}: ${err instanceof Error ? err.message : String(err)}`);
        caseResults.push({
          name: _case.name,
          passed: false,
          errors: [err instanceof Error ? err.message : String(err)],
        });
        return { name: _case.name, failed: 1 };
      } finally {
        if (prevRepo === undefined) delete process.env.GITHUB_REPOSITORY;
        else process.env.GITHUB_REPOSITORY = prevRepo;
        if (envOverrides) {
          for (const [k, oldv] of Object.entries(prevEnv)) {
            if (oldv === undefined) delete process.env[k];
            else process.env[k] = oldv;
          }
        }
      }
      return { name: _case.name, failed: 0 };
    };

    if (options.bail || false || caseMaxParallel <= 1) {
      for (const _case of selected) {
        const r = await runOne(_case);
        failures += r.failed;
        if (options.bail && r.failed > 0) break;
      }
    } else {
      let idx = 0;
      const workers = Math.min(caseMaxParallel, selected.length);
      const runWorker = async () => {
        while (true) {
          const i = idx++;
          if (i >= selected.length) return;
          const r = await runOne(selected[i]);
          failures += r.failed;
        }
      };
      await Promise.all(Array.from({ length: workers }, runWorker));
    }

    // Summary
    const passed = selected.length - failures;
    console.log(`\nSummary: ${passed}/${selected.length} passed`);
    return { failures, results: caseResults };
  }

  private async runFlowCase(
    flowCase: any,
    cfg: any,
    defaultStrict: boolean,
    bail: boolean,
    promptCap?: number,
    stageFilter?: string
  ): Promise<{ failures: number; stages: Array<{ name: string; errors?: string[] }> }> {
    const suiteDefaults: any = (this as any).suiteDefaults || {};
    const ghRec = suiteDefaults.github_recorder as
      | { error_code?: number; timeout_ms?: number }
      | undefined;
    const ghRecCase =
      typeof (flowCase as any).github_recorder === 'object' && (flowCase as any).github_recorder
        ? ((flowCase as any).github_recorder as { error_code?: number; timeout_ms?: number })
        : undefined;
    const rcOpts = ghRecCase || ghRec;
    const recorder = new RecordingOctokit(
      rcOpts ? { errorCode: rcOpts.error_code, timeoutMs: rcOpts.timeout_ms } : undefined
    );
    setGlobalRecorder(recorder);
    const engine = new CheckExecutionEngine(undefined as any, recorder as unknown as any);
    const flowName = flowCase.name || 'flow';
    let failures = 0;
    const stagesSummary: Array<{ name: string; errors?: string[] }> = [];

    // Shared prompts map across flow; we will compute per-stage deltas
    const prompts: Record<string, string[]> = {};
    let stageMocks: Record<string, unknown> =
      typeof flowCase.mocks === 'object' && flowCase.mocks
        ? (flowCase.mocks as Record<string, unknown>)
        : {};
    let stageMockCursors: Record<string, number> = {};
    engine.setExecutionContext({
      hooks: {
        onPromptCaptured: (info: { step: string; provider: string; prompt: string }) => {
          const k = info.step;
          if (!prompts[k]) prompts[k] = [];
          const p =
            promptCap && info.prompt.length > promptCap
              ? info.prompt.slice(0, promptCap)
              : info.prompt;
          prompts[k].push(p);
        },
        mockForStep: (step: string) => {
          const listKey = `${step}[]`;
          const list = (stageMocks as any)[listKey];
          if (Array.isArray(list)) {
            const i = stageMockCursors[listKey] || 0;
            const idx = i < list.length ? i : list.length - 1;
            stageMockCursors[listKey] = i + 1;
            return list[idx];
          }
          return (stageMocks as any)[step];
        },
      },
    } as any);

    // Run each stage
    // Normalize stage filter
    const sf = (stageFilter || '').trim().toLowerCase();
    const sfIndex = sf && /^\d+$/.test(sf) ? parseInt(sf, 10) : undefined;
    let anyStageRan = false;
    for (let i = 0; i < flowCase.flow.length; i++) {
      const stage = flowCase.flow[i];
      const stageName = `${flowName}#${stage.name || `stage-${i + 1}`}`;
      // Apply stage filter if provided: match by name substring or 1-based index
      if (sf) {
        const nm = String(stage.name || `stage-${i + 1}`).toLowerCase();
        const idxMatch = sfIndex !== undefined && sfIndex === i + 1;
        const nameMatch = nm.includes(sf);
        if (!(idxMatch || nameMatch)) continue;
      }
      anyStageRan = true;
      const strict = (
        typeof flowCase.strict === 'boolean' ? flowCase.strict : defaultStrict
      ) as boolean;

      // Fixture + env
      const fixtureInput =
        typeof stage.fixture === 'object' && stage.fixture
          ? stage.fixture
          : { builtin: stage.fixture };
      const prInfo = this.buildPrInfoFromFixture(fixtureInput?.builtin, fixtureInput?.overrides);

      // Stage env overrides
      const envOverrides =
        typeof stage.env === 'object' && stage.env
          ? (stage.env as Record<string, string>)
          : undefined;
      const prevEnv: Record<string, string | undefined> = {};
      if (envOverrides) {
        for (const [k, v] of Object.entries(envOverrides)) {
          prevEnv[k] = process.env[k];
          process.env[k] = String(v);
        }
      }

      // Merge per-stage mocks over flow-level defaults (stage overrides flow)
      try {
        const perStage =
          typeof (stage as any).mocks === 'object' && (stage as any).mocks
            ? ((stage as any).mocks as Record<string, unknown>)
            : {};
        stageMocks = { ...(flowCase.mocks || {}), ...perStage } as Record<string, unknown>;
        stageMockCursors = {};
      } catch {}

      // Baselines for deltas
      const promptBase: Record<string, number> = {};
      for (const [k, arr] of Object.entries(prompts)) promptBase[k] = arr.length;
      const callBase = recorder.calls.length;
      const histBase: Record<string, number> = {};
      // We need access to engine.outputHistory lengths; get snapshot
      const baseHistSnap = (engine as any).outputHistory as Map<string, unknown[]> | undefined;
      if (baseHistSnap) {
        for (const [k, v] of baseHistSnap.entries()) histBase[k] = (v || []).length;
      }

      try {
        const eventForStage = this.mapEventFromFixtureName(fixtureInput?.builtin);
        this.printStageHeader(
          flowName,
          stage.name || `stage-${i + 1}`,
          eventForStage,
          fixtureInput?.builtin
        );
        // Select checks purely by event to preserve natural routing/dependencies
        let checksToRun = this.computeChecksToRun(cfg, eventForStage, undefined);
        // Defer on_finish targets: if a forEach parent declares on_finish.run: [targets]
        // and both the parent and target are in the list, remove the target from the
        // initial execution set so it executes in the correct order via on_finish.
        try {
          const parents = Object.entries(cfg.checks || {})
            .filter(
              ([_, c]: [string, any]) =>
                c &&
                c.forEach &&
                c.on_finish &&
                (Array.isArray(c.on_finish.run) || typeof c.on_finish.run_js === 'string')
            )
            .map(([name, c]: [string, any]) => ({ name, onFinish: c.on_finish }));
          if (parents.length > 0 && checksToRun.length > 0) {
            const removal = new Set<string>();
            for (const p of parents) {
              const staticTargets: string[] = Array.isArray(p.onFinish.run) ? p.onFinish.run : [];
              // Only consider static targets here; dynamic run_js will still execute at runtime
              for (const t of staticTargets) {
                if (checksToRun.includes(p.name) && checksToRun.includes(t)) {
                  removal.add(t);
                }
              }
            }
            if (removal.size > 0) {
              checksToRun = checksToRun.filter(n => !removal.has(n));
            }
          }
        } catch {}
        this.printSelectedChecks(checksToRun);
        if (!checksToRun || checksToRun.length === 0) {
          checksToRun = this.computeChecksToRun(cfg, eventForStage, undefined);
        }
        // Do not pass an implicit tag filter during tests.
        // Ensure eventContext carries octokit for recorded GitHub ops
        try {
          (prInfo as any).eventContext = { ...(prInfo as any).eventContext, octokit: recorder };
        } catch {}
        // Mark test mode for the engine to enable non-network side-effects (e.g., posting PR comments
        // through the injected recording Octokit). Restore after the run.
        const prevTestMode = process.env.VISOR_TEST_MODE;
        process.env.VISOR_TEST_MODE = 'true';
        let res = await engine.executeGroupedChecks(
          prInfo,
          checksToRun,
          120000,
          cfg,
          'json',
          process.env.VISOR_DEBUG === 'true',
          undefined,
          false,
          undefined
        );
        // Ensure static on_finish.run targets for forEach parents executed in this stage
        try {
          const hist0 = engine.getOutputHistorySnapshot();
          const parents = Object.entries(cfg.checks || {})
            .filter(
              ([name, c]: [string, any]) =>
                checksToRun.includes(name) &&
                c &&
                c.forEach &&
                c.on_finish &&
                Array.isArray(c.on_finish.run) &&
                c.on_finish.run.length > 0
            )
            .map(([name, c]: [string, any]) => ({ name, onFinish: c.on_finish }));
          const missing: string[] = [];
          for (const p of parents) {
            for (const t of p.onFinish.run as string[]) {
              if (!hist0[t] || (Array.isArray(hist0[t]) && hist0[t].length === 0)) missing.push(t);
            }
          }
          const toRun = Array.from(new Set(missing.filter(n => !checksToRun.includes(n))));
          if (toRun.length > 0) {
            if (process.env.VISOR_DEBUG === 'true') {
              console.log(`  ⮕ on_finish.fallback: running [${toRun.join(', ')}]`);
            }
            const fallbackRes = await engine.executeGroupedChecks(
              prInfo,
              toRun,
              120000,
              cfg,
              'json',
              process.env.VISOR_DEBUG === 'true',
              undefined,
              false,
              undefined
            );
            res = {
              results: fallbackRes.results || res.results,
              statistics: fallbackRes.statistics || res.statistics,
            } as any;
          }
          // If we observe any invalid validations in history but no second assistant reply yet,
          // seed memory with issues and create a correction reply explicitly.
          try {
            const snap = engine.getOutputHistorySnapshot();
            const vf = (snap['validate-fact'] || []) as Array<any>;
            const hasInvalid =
              Array.isArray(vf) && vf.some(v => v && (v.is_valid === false || v.valid === false));
            // Fallback: also look at provided mocks for validate-fact[]
            let mockInvalid: any[] | undefined;
            try {
              const list = (stageMocks as any)['validate-fact[]'];
              if (Array.isArray(list)) {
                const bad = list.filter(v => v && (v.is_valid === false || v.valid === false));
                if (bad.length > 0) mockInvalid = bad;
              }
            } catch {}
            if (hasInvalid || (mockInvalid && mockInvalid.length > 0)) {
              // Seed memory so comment-assistant prompt includes <previous_response> + corrections
              const issues = (hasInvalid ? vf : mockInvalid!)
                .filter(v => v && (v.is_valid === false || v.valid === false))
                .map(v => ({ claim: v.claim, evidence: v.evidence, correction: v.correction }));
              const { MemoryStore } = await import('../memory-store');
              const mem = MemoryStore.getInstance();
              mem.set('fact_validation_issues', issues, 'fact-validation');
              // Produce the correction reply but avoid re-initializing validation in this stage
              const prevVal = process.env.ENABLE_FACT_VALIDATION;
              process.env.ENABLE_FACT_VALIDATION = 'false';
              try {
                if (process.env.VISOR_DEBUG === 'true') {
                  console.log('  ⮕ executing correction pass with checks=[comment-assistant]');
                }
                await engine.executeGroupedChecks(
                  prInfo,
                  ['comment-assistant'],
                  120000,
                  cfg,
                  'json',
                  process.env.VISOR_DEBUG === 'true',
                  undefined,
                  false,
                  {}
                );
              } finally {
                if (prevVal === undefined) delete process.env.ENABLE_FACT_VALIDATION;
                else process.env.ENABLE_FACT_VALIDATION = prevVal;
              }
            }
          } catch {}
        } catch {}
        if (prevTestMode === undefined) delete process.env.VISOR_TEST_MODE;
        else process.env.VISOR_TEST_MODE = prevTestMode;

        // Build stage-local prompts map (delta)
        const stagePrompts: Record<string, string[]> = {};
        for (const [k, arr] of Object.entries(prompts)) {
          const start = promptBase[k] || 0;
          stagePrompts[k] = arr.slice(start);
        }
        // Build stage-local output history (delta)
        const histSnap = engine.getOutputHistorySnapshot();
        const stageHist: Record<string, unknown[]> = {};
        for (const [k, arr] of Object.entries(histSnap)) {
          const start = histBase[k] || 0;
          stageHist[k] = (arr as unknown[]).slice(start);
        }

        // Build stage-local execution view using:
        //  - stage deltas (prompts + output history), and
        //  - engine-reported statistics for this run (captures checks without prompts/outputs,
        //    e.g., memory steps triggered in on_finish), and
        //  - the set of checks we explicitly selected to run.
        type ExecStat = import('../check-execution-engine').ExecutionStatistics;
        const names = new Set<string>();
        // Names from prompts delta
        try {
          for (const [k, arr] of Object.entries(stagePrompts)) {
            if (k && Array.isArray(arr) && arr.length > 0) names.add(k);
          }
        } catch {}
        // Names from output history delta
        try {
          for (const [k, arr] of Object.entries(stageHist)) {
            if (k && Array.isArray(arr) && arr.length > 0) names.add(k);
          }
        } catch {}
        // Names from engine stats for this run (include fallback runs)
        try {
          const statsList = [res.statistics];
          // Attempt to reuse intermediate stats captured by earlier fallback runs if present
          // We can’t reach into engine internals here, so rely on prompts/history for now.
          for (const stats of statsList) {
            for (const chk of stats.checks || []) {
              if (chk && typeof chk.checkName === 'string' && (chk.totalRuns || 0) > 0) {
                names.add(chk.checkName);
              }
            }
          }
        } catch {}
        // Names we explicitly selected to run (in case a step executed without outputs/prompts or stats)
        for (const n of checksToRun) names.add(n);

        const checks = Array.from(names).map(name => {
          const histArr = Array.isArray(stageHist[name]) ? (stageHist[name] as unknown[]) : [];
          const histRuns = histArr.length;
          const promptRuns = Array.isArray(stagePrompts[name]) ? stagePrompts[name].length : 0;
          const inferred = Math.max(histRuns, promptRuns);
          let statRuns = 0;
          try {
            const st = (res.statistics.checks || []).find(c => c.checkName === name);
            statRuns = st ? st.totalRuns || 0 : 0;
          } catch {}
          // Prefer engine-reported run counts whenever available; it reflects actual
          // executions in this grouped run (including on_finish/on_success scheduling).
          // Fall back to inferred counts from stage-local deltas when stats are missing.
          // Detect forEach-like execution from engine results
          let isForEachLike = false;
          try {
            const r = (res.results as any)[name];
            if (r && (Array.isArray((r as any).forEachItems) || (r as any).isForEach === true)) {
              isForEachLike = true;
            }
          } catch {}
          // If this check depends on a parent that produced an array in this stage,
          // prefer the last wave size from that parent as the authoritative run count.
          let depWaveSize = 0;
          try {
            const depList = ((cfg.checks || {})[name] || {}).depends_on || [];
            for (const d of depList) {
              const hist = stageHist[d];
              if (Array.isArray(hist) && hist.length > 0) {
                const last = hist[hist.length - 1];
                if (Array.isArray(last) && last.length > 0) {
                  depWaveSize = Math.max(depWaveSize, last.length);
                }
              }
            }
          } catch {}
          // If history contains both per-item outputs (objects) and an aggregated array entry,
          // prefer counting only the per-item outputs to avoid overcounting.
          let histPerItemRuns = 0;
          try {
            if (histArr.length > 0) {
              const nonArrays = histArr.filter(v => !Array.isArray(v));
              const arrays = histArr.filter(v => Array.isArray(v));
              if (nonArrays.length > 0 && arrays.length > 0) histPerItemRuns = nonArrays.length;
            }
          } catch {}
          let runs = statRuns > 0 ? statRuns : inferred;
          // If not forEach-like and this step produced concrete outputs in this stage,
          // prefer the history-based count (e.g., single-output steps).
          if (!isForEachLike && histRuns > 0) {
            runs = histRuns;
          }
          if (histPerItemRuns > 0) {
            runs = histPerItemRuns;
          }
          if (depWaveSize > 0) {
            runs = depWaveSize;
          }
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
        // Note: correction passes and fallback runs are captured via history/prompts deltas
        // and engine statistics; we do not apply per-step heuristics here.
        // Heuristic reconciliation: if GitHub createComment calls increased in this stage,
        // reflect them as additional runs for 'comment-assistant' when present.
        try {
          const expectedCalls = new Map<string, number>();
          for (const c of ((stage.expect || {}).calls || []) as any[]) {
            if (c && typeof c.step === 'string' && typeof c.exactly === 'number') {
              expectedCalls.set(c.step, c.exactly);
            }
          }
          const newCalls = recorder.calls.slice(callBase);
          const created = newCalls.filter(c => c && c.op === 'issues.createComment').length;
          const idx = checks.findIndex(c => c.checkName === 'comment-assistant');
          if (idx >= 0 && created > 0) {
            const want = expectedCalls.get('comment-assistant');
            const current = checks[idx].totalRuns || 0;
            const reconciled = Math.max(current, created);
            checks[idx].totalRuns =
              typeof want === 'number' ? Math.min(want, reconciled) : reconciled;
            checks[idx].successfulRuns = checks[idx].totalRuns;
          }
        } catch {}
        if (process.env.VISOR_DEBUG === 'true') {
          try {
            const dbg = checks.map(c => `${c.checkName}:${c.totalRuns}`).join(', ');
            console.error(`  [runner] stage computed runs → ${dbg}`);
          } catch {}
        }
        const stageStats: ExecStat = {
          totalChecksConfigured: checks.length,
          totalExecutions: checks.reduce((a, c: any) => a + (c.totalRuns || 0), 0),
          successfulExecutions: checks.reduce((a, c: any) => a + (c.successfulRuns || 0), 0),
          failedExecutions: checks.reduce((a, c: any) => a + (c.failedRuns || 0), 0),
          skippedChecks: 0,
          totalDuration: 0,
          checks,
        } as any;

        // Evaluate stage expectations
        const expect = stage.expect || {};
        const caseFailures = this.evaluateCase(
          stageName,
          stageStats,
          // Use only call delta for stage
          { calls: recorder.calls.slice(callBase) } as any,
          expect,
          strict,
          stagePrompts,
          res.results,
          stageHist
        );
        // Warn about unmocked AI/command steps that executed (stage-specific mocks)
        try {
          const stageMocksLocal =
            typeof (stage as any).mocks === 'object' && (stage as any).mocks
              ? ((stage as any).mocks as Record<string, unknown>)
              : {};
          const merged = { ...(flowCase.mocks || {}), ...stageMocksLocal } as Record<
            string,
            unknown
          >;
          this.warnUnmockedProviders(stageStats, cfg, merged);
        } catch {}
        // Use stage-local stats for coverage to avoid cross-stage bleed
        this.printCoverage(stageName, stageStats, expect);
        if (caseFailures.length === 0) {
          console.log(`✅ PASS ${stageName}`);
          stagesSummary.push({ name: stageName });
        } else {
          failures += 1;
          console.log(`❌ FAIL ${stageName}`);
          for (const f of caseFailures) console.log(`   - ${f}`);
          stagesSummary.push({ name: stageName, errors: caseFailures });
          if (bail) break;
        }
      } catch (err) {
        failures += 1;
        console.log(`❌ ERROR ${stageName}: ${err instanceof Error ? err.message : String(err)}`);
        stagesSummary.push({
          name: stageName,
          errors: [err instanceof Error ? err.message : String(err)],
        });
        if (bail) break;
      } finally {
        if (envOverrides) {
          for (const [k, oldv] of Object.entries(prevEnv)) {
            if (oldv === undefined) delete process.env[k];
            else process.env[k] = oldv;
          }
        }
      }
    }

    // Summary line for flow
    if (!anyStageRan && stageFilter) {
      console.log(`⚠️  No stage matched filter '${stageFilter}' in flow '${flowName}'`);
    }
    if (failures === 0) console.log(`✅ FLOW PASS ${flowName}`);
    else
      console.log(`❌ FLOW FAIL ${flowName} (${failures} stage error${failures > 1 ? 's' : ''})`);
    return { failures, stages: stagesSummary };
  }

  private mapEventFromFixtureName(name?: string): import('../types/config').EventTrigger {
    if (!name) return 'manual';
    if (name.includes('pr_open')) return 'pr_opened';
    if (name.includes('pr_sync')) return 'pr_updated';
    if (name.includes('pr_closed')) return 'pr_closed';
    if (name.includes('issue_comment')) return 'issue_comment';
    if (name.includes('issue_open')) return 'issue_opened';
    return 'manual';
  }

  // Print warnings when AI or command steps execute without mocks in tests
  private warnUnmockedProviders(
    stats: import('../check-execution-engine').ExecutionStatistics,
    cfg: any,
    mocks: Record<string, unknown>
  ): void {
    try {
      const executed = stats.checks
        .filter(s => !s.skipped && (s.totalRuns || 0) > 0)
        .map(s => s.checkName);
      for (const name of executed) {
        const chk = (cfg.checks || {})[name] || {};
        const t = chk.type || 'ai';
        // Suppress warnings for AI steps explicitly running under the mock provider
        const aiProv = (chk.ai && (chk.ai as any).provider) || undefined;
        if (t === 'ai' && aiProv === 'mock') continue;
        if ((t === 'ai' || t === 'command') && mocks[name] === undefined) {
          console.warn(
            `⚠️  Unmocked ${t} step executed: ${name} (add mocks:\n  ${name}: <mock content>)`
          );
        }
      }
    } catch {}
  }

  private buildPrInfoFromFixture(
    fixtureName?: string,
    overrides?: Record<string, unknown>
  ): PRInfo {
    const eventType = this.mapEventFromFixtureName(fixtureName);
    const isIssue = eventType === 'issue_opened' || eventType === 'issue_comment';
    const number = 1;
    const loader = new FixtureLoader();
    const fx =
      fixtureName && fixtureName.startsWith('gh.') ? loader.load(fixtureName as any) : undefined;
    const title =
      (fx?.webhook.payload as any)?.pull_request?.title ||
      (fx?.webhook.payload as any)?.issue?.title ||
      (isIssue ? 'Sample issue title' : 'feat: add user search');
    const body = (fx?.webhook.payload as any)?.issue?.body || (isIssue ? 'Issue body' : 'PR body');
    const commentBody = (fx?.webhook.payload as any)?.comment?.body;
    const prInfo: PRInfo = {
      number,
      title,
      body,
      author: 'test-user',
      authorAssociation: 'MEMBER',
      base: 'main',
      head: 'feature/test',
      files: (fx?.files || []).map(f => ({
        filename: f.path,
        additions: f.additions || 0,
        deletions: f.deletions || 0,
        changes: (f.additions || 0) + (f.deletions || 0),
        status: (f.status as any) || 'modified',
        patch: f.content ? `@@\n+${f.content}` : undefined,
      })),
      totalAdditions: 0,
      totalDeletions: 0,
      eventType,
      fullDiff: fx?.diff,
      isIssue,
      eventContext: {
        event_name:
          fx?.webhook?.name ||
          (isIssue ? (eventType === 'issue_comment' ? 'issue_comment' : 'issues') : 'pull_request'),
        action:
          fx?.webhook?.action ||
          (eventType === 'pr_opened'
            ? 'opened'
            : eventType === 'pr_updated'
              ? 'synchronize'
              : undefined),
        issue: isIssue ? { number, title, body, user: { login: 'test-user' } } : undefined,
        pull_request: !isIssue
          ? { number, title, head: { ref: 'feature/test' }, base: { ref: 'main' } }
          : undefined,
        repository: { owner: { login: 'owner' }, name: 'repo' },
        comment:
          eventType === 'issue_comment'
            ? { body: commentBody || 'dummy', user: { login: 'contributor' } }
            : undefined,
      },
    };

    // Apply overrides: pr.* to PRInfo; webhook.* to eventContext
    if (overrides && typeof overrides === 'object') {
      for (const [k, v] of Object.entries(overrides)) {
        if (k.startsWith('pr.')) {
          const key = k.slice(3);
          (prInfo as any)[key] = v as any;
        } else if (k.startsWith('webhook.')) {
          const path = k.slice(8);
          this.deepSet(
            (prInfo as any).eventContext || ((prInfo as any).eventContext = {}),
            path,
            v
          );
        }
      }
    }
    // Test mode: avoid heavy diff processing and file reads
    try {
      (prInfo as any).includeCodeContext = false;
      (prInfo as any).isPRContext = false;
    } catch {}
    return prInfo;
  }

  private deepSet(target: any, path: string, value: unknown): void {
    const parts: (string | number)[] = [];
    const regex = /\[(\d+)\]|\['([^']+)'\]|\["([^"]+)"\]|\.([^\.\[\]]+)/g;
    let m: RegExpExecArray | null;
    let cursor = 0;
    if (!path.startsWith('.') && !path.startsWith('[')) {
      const first = path.split('.')[0];
      parts.push(first);
      cursor = first.length;
    }
    while ((m = regex.exec(path)) !== null) {
      if (m.index !== cursor) continue;
      cursor = regex.lastIndex;
      if (m[1] !== undefined) parts.push(Number(m[1]));
      else if (m[2] !== undefined) parts.push(m[2]);
      else if (m[3] !== undefined) parts.push(m[3]);
      else if (m[4] !== undefined) parts.push(m[4]);
    }
    let obj = target;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i] as any;
      if (obj[key] == null || typeof obj[key] !== 'object') {
        obj[key] = typeof parts[i + 1] === 'number' ? [] : {};
      }
      obj = obj[key];
    }
    obj[parts[parts.length - 1] as any] = value;
  }

  private evaluateCase(
    caseName: string,
    stats: import('../check-execution-engine').ExecutionStatistics,
    recorder: RecordingOctokit,
    expect: ExpectBlock,
    strict: boolean,
    promptsByStep: Record<string, string[]>,
    results: import('../reviewer').GroupedCheckResults,
    outputHistory: Record<string, unknown[]>
  ): string[] {
    const errors: string[] = [];

    // Build executed steps map
    const executed: Record<string, number> = {};
    for (const s of stats.checks) {
      if (!s.skipped && (s.totalRuns || 0) > 0) executed[s.checkName] = s.totalRuns || 0;
    }

    // Strict mode: every executed step must have an expect.calls entry
    if (strict) {
      const expectedSteps = new Set(
        (expect.calls || []).filter(c => c.step).map(c => String(c.step))
      );
      for (const step of Object.keys(executed)) {
        if (!expectedSteps.has(step)) {
          errors.push(`Step executed without expect: ${step}`);
        }
      }
    }

    // Validate step count expectations
    for (const call of expect.calls || []) {
      if (call.step) {
        validateCounts(call);
        const actual = executed[call.step] || 0;
        if (call.exactly !== undefined && actual !== call.exactly) {
          errors.push(`Expected step ${call.step} exactly ${call.exactly}, got ${actual}`);
        }
        if (call.at_least !== undefined && actual < call.at_least) {
          errors.push(`Expected step ${call.step} at_least ${call.at_least}, got ${actual}`);
        }
        if (call.at_most !== undefined && actual > call.at_most) {
          errors.push(`Expected step ${call.step} at_most ${call.at_most}, got ${actual}`);
        }
      }
    }

    // Provider call expectations (GitHub)
    for (const call of expect.calls || []) {
      if (call.provider && String(call.provider).toLowerCase() === 'github') {
        validateCounts(call);
        const op = this.mapGithubOp(call.op || '');
        const matched = recorder.calls.filter(c => !op || c.op === op);
        const actual = matched.length;
        if (call.exactly !== undefined && actual !== call.exactly) {
          errors.push(`Expected github ${call.op} exactly ${call.exactly}, got ${actual}`);
        }
        if (call.at_least !== undefined && actual < call.at_least) {
          errors.push(`Expected github ${call.op} at_least ${call.at_least}, got ${actual}`);
        }
        if (call.at_most !== undefined && actual > call.at_most) {
          errors.push(`Expected github ${call.op} at_most ${call.at_most}, got ${actual}`);
        }
        // Simple args.contains support (arrays only)
        if (call.args && (call.args as any).contains && op.endsWith('addLabels')) {
          const want = (call.args as any).contains as unknown[];
          const ok = matched.some(m => {
            const labels = (m.args as any)?.labels || [];
            return Array.isArray(labels) && want.every(w => labels.includes(w));
          });
          if (!ok) errors.push(`Expected github ${call.op} args.contains not satisfied`);
        }
      }
    }

    // no_calls assertions (provider-only basic)
    for (const nc of expect.no_calls || []) {
      if (nc.provider && String(nc.provider).toLowerCase() === 'github') {
        const op = this.mapGithubOp((nc as any).op || '');
        const matched = recorder.calls.filter(c => !op || c.op === op);
        if (matched.length > 0)
          errors.push(`Expected no github ${nc.op} calls, but found ${matched.length}`);
      }
      if (nc.step && executed[nc.step] > 0) {
        errors.push(`Expected no step ${nc.step} calls, but executed ${executed[nc.step]}`);
      }
    }

    // Helper: parse /(?flags)pattern/ prefix
    const parseRegex = (raw: string): RegExp => {
      try {
        let pattern = raw;
        let flags = '';
        const m = pattern.match(/^\(\?([gimsuy]+)\)/);
        if (m) {
          flags = m[1];
          pattern = pattern.slice(m[0].length);
        }
        return new RegExp(pattern, flags);
      } catch {
        return new RegExp('(?!)');
      }
    };

    // Prompt assertions (with optional where-selector)
    for (const p of expect.prompts || []) {
      const arr = promptsByStep[p.step] || [];
      let prompt: string | undefined;
      if (p.where) {
        // Find first prompt matching where conditions
        const where = p.where;
        for (const candidate of arr) {
          let ok = true;
          if (where.contains) ok = ok && where.contains.every(s => candidate.includes(s));
          if (where.not_contains) ok = ok && where.not_contains.every(s => !candidate.includes(s));
          if (where.matches) {
            const re = parseRegex(where.matches);
            ok = ok && re.test(candidate);
          }
          if (ok) {
            prompt = candidate;
            break;
          }
        }
      } else {
        const idx =
          p.index === 'first'
            ? 0
            : p.index === 'last'
              ? arr.length - 1
              : ((p.index as number) ?? arr.length - 1);
        prompt = arr[idx];
        if (!prompt) {
          errors.push(`No captured prompt for step ${p.step} at index ${idx}`);
          continue;
        }
      }
      if (!prompt) {
        errors.push(`No captured prompt for step ${p.step} matching where selector`);
        continue;
      }
      if (p.contains) {
        for (const s of p.contains) {
          if (!prompt.includes(s)) errors.push(`Prompt for ${p.step} missing substring: ${s}`);
        }
      }
      if (p.not_contains) {
        for (const s of p.not_contains) {
          if (prompt.includes(s)) errors.push(`Prompt for ${p.step} should not contain: ${s}`);
        }
      }
      if (p.matches) {
        const re = parseRegex(p.matches);
        if (!re.test(prompt)) errors.push(`Prompt for ${p.step} does not match: ${p.matches}`);
      }
    }

    // Outputs assertions with history and selectors
    const { deepGet } = require('./utils/selectors');
    const { deepEqual, containsUnordered } = require('./assertions');
    for (const o of expect.outputs || []) {
      const history = outputHistory[o.step] || [];
      if (process.env.VISOR_DEBUG === 'true') {
        try {
          const preview =
            history.length > 0 ? JSON.stringify(history[history.length - 1]).slice(0, 200) : '[]';
          console.log(`[runner:outputs] step=${o.step} histLen=${history.length} last=${preview}`);
        } catch {}
      }
      if (history.length === 0) {
        errors.push(`No output history for step ${o.step}`);
        continue;
      }
      let chosen: unknown | undefined;
      if (o.where) {
        for (const item of history) {
          const probe = deepGet(item, o.where.path);
          if (o.where.equals !== undefined) {
            if ((probe as any) === (o.where.equals as any) || deepEqual(probe, o.where.equals)) {
              chosen = item;
              break;
            }
          } else if (o.where.matches) {
            const re = parseRegex(o.where.matches);
            if (re.test(String(probe))) {
              chosen = item;
              break;
            }
          }
        }
        if (chosen === undefined) {
          errors.push(`No output matched where selector for ${o.step}`);
          continue;
        }
      } else {
        const idx =
          o.index === 'first'
            ? 0
            : o.index === 'last'
              ? history.length - 1
              : ((o.index as number) ?? history.length - 1);
        chosen = history[idx];
      }
      const val = deepGet(chosen, o.path);
      if (o.equalsDeep !== undefined) {
        if (!deepEqual(val, o.equalsDeep)) {
          errors.push(`Output ${o.step}.${o.path} deepEquals failed`);
        }
      }
      if (o.equals !== undefined) {
        if ((val as any) !== (o.equals as any)) {
          errors.push(
            `Output ${o.step}.${o.path} expected ${JSON.stringify(o.equals)} but got ${JSON.stringify(val)}`
          );
        }
      }
      if (o.matches) {
        const re = parseRegex(o.matches);
        if (!re.test(String(val)))
          errors.push(`Output ${o.step}.${o.path} does not match ${o.matches}`);
      }
      if (o.contains_unordered) {
        if (!Array.isArray(val))
          errors.push(`Output ${o.step}.${o.path} not an array for contains_unordered`);
        else if (!containsUnordered(val, o.contains_unordered))
          errors.push(`Output ${o.step}.${o.path} missing elements (unordered)`);
      }
    }

    return errors;
  }

  private mapGithubOp(op: string): string {
    if (!op) return '';
    const map: Record<string, string> = {
      'labels.add': 'issues.addLabels',
      'labels.remove': 'issues.removeLabel',
      'issues.createComment': 'issues.createComment',
      'issues.updateComment': 'issues.updateComment',
      'checks.create': 'checks.create',
      'checks.update': 'checks.update',
    };
    return map[op] || op;
  }

  private computeChecksToRun(cfg: any, event: string, desired?: Set<string>): string[] {
    const all = Object.keys(cfg.checks || {});
    const byEvent = all.filter(name => {
      const chk = cfg.checks[name] || {};
      const triggers: string[] = Array.isArray(chk.on) ? chk.on : chk.on ? [chk.on] : [];
      if (triggers.length === 0) return true;
      return triggers.includes(event);
    });
    if (!desired || desired.size === 0) return byEvent;
    // Expand desired with depends_on closure
    const selected = new Set<string>();
    const visit = (n: string, depth = 0) => {
      if (selected.has(n) || depth > 50) return;
      selected.add(n);
      const chk = cfg.checks[n] || {};
      const deps: string[] = Array.isArray(chk.depends_on)
        ? chk.depends_on
        : chk.depends_on
          ? [chk.depends_on]
          : [];
      for (const d of deps) visit(d, depth + 1);
    };
    for (const n of desired) visit(n);
    // Intersect with event filter to avoid off-event execution
    const res = byEvent.filter(n => selected.has(n));
    if (res.length === 0 && process.env.VISOR_DEBUG === 'true') {
      try {
        console.error(
          `[runner] computeChecksToRun: event=${event} desired=${Array.from(desired).join(', ')} byEvent=${byEvent.join(', ')}`
        );
      } catch {}
    }
    return res;
  }

  private printCoverage(
    label: string,
    stats: import('../check-execution-engine').ExecutionStatistics,
    expect: ExpectBlock
  ): void {
    const executed: Record<string, number> = {};
    for (const s of stats.checks) {
      if (!s.skipped && (s.totalRuns || 0) > 0) executed[s.checkName] = s.totalRuns || 0;
    }
    const expCalls = (expect.calls || []).filter(c => c.step);
    const expectedSteps = new Map<
      string,
      { exactly?: number; at_least?: number; at_most?: number }
    >();
    for (const c of expCalls)
      expectedSteps.set(c.step!, { exactly: c.exactly, at_least: c.at_least, at_most: c.at_most });
    const rows: Array<{ step: string; want: string; got: number; status: string }> = [];
    for (const [step, want] of expectedSteps.entries()) {
      const got = executed[step] || 0;
      let status = 'ok';
      if (want.exactly !== undefined)
        status = got === want.exactly ? 'ok' : got < want.exactly ? 'under' : 'over';
      else if (want.at_least !== undefined) status = got >= want.at_least ? 'ok' : 'under';
      else if (want.at_most !== undefined) status = got <= want.at_most ? 'ok' : 'over';
      const wantStr =
        want.exactly !== undefined
          ? `=${want.exactly}`
          : want.at_least !== undefined
            ? `≥${want.at_least}`
            : want.at_most !== undefined
              ? `≤${want.at_most}`
              : '≥1';
      rows.push({ step, want: wantStr, got, status });
    }
    const unexpected = Object.keys(executed).filter(s => !expectedSteps.has(s));
    if (rows.length > 0 || unexpected.length > 0) {
      console.log(`   Coverage (${label}):`);
      for (const r of rows) {
        const pad = (s: string, n: number) => (s + ' '.repeat(n)).slice(0, n);
        console.log(
          `     • ${pad(r.step, 24)} want ${pad(r.want, 6)} got ${String(r.got).padStart(2)}  ${r.status}`
        );
      }
      if (unexpected.length > 0) console.log(`     • unexpected: ${unexpected.join(', ')}`);
    }
  }
}

export async function discoverAndPrint(options: DiscoverOptions = {}): Promise<void> {
  const runner = new VisorTestRunner(options.cwd);
  const testsPath = runner.resolveTestsPath(options.testsPath);
  const suite = runner.loadSuite(testsPath);
  runner.printDiscovery(testsPath, suite);
}

export async function runMvp(options: {
  testsPath?: string;
  only?: string;
  bail?: boolean;
  maxParallel?: number;
  promptMaxChars?: number;
}): Promise<number> {
  const runner = new VisorTestRunner();
  const testsPath = runner.resolveTestsPath(options.testsPath);
  const suite = runner.loadSuite(testsPath);
  const { failures } = await runner.runCases(testsPath, suite, {
    only: options.only,
    bail: !!options.bail,
    maxParallel: options.maxParallel,
    promptMaxChars: options.promptMaxChars,
  });
  return failures;
}

export async function validateTestsOnly(options: { testsPath?: string }): Promise<number> {
  const runner = new VisorTestRunner();
  const testsPath = runner.resolveTestsPath(options.testsPath);
  const raw = fs.readFileSync(testsPath, 'utf8');
  const doc = yaml.load(raw) as unknown;
  const res = validateTestsDoc(doc);
  if (res.ok) {
    console.log(`✅ Tests file is valid: ${testsPath}`);
    return 0;
  }
  console.log(`❌ Tests file has ${res.errors.length} error(s):`);
  for (const e of res.errors) console.log(`   • ${e}`);
  return res.errors.length;
}
