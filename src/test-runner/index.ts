import fs from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';

import { ConfigManager } from '../config';
import { CheckExecutionEngine } from '../check-execution-engine';
import type { PRInfo } from '../pr-analyzer';
import { RecordingOctokit } from './recorders/github-recorder';
import { setGlobalRecorder } from './recorders/global-recorder';
// import { FixtureLoader } from './fixture-loader';
import { type ExpectBlock } from './assertions';
import { FlowStage } from './core/flow-stage';
// evaluators are required at call sites to avoid circular import during build
import { EnvironmentManager } from './core/environment';
import { MockManager } from './core/mocks';
import { buildPrInfoFromFixture } from './core/fixture';
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

  // Extracted helper: prepare engine/recorder, prompts/mocks, env, and checksToRun for a single-event case
  private setupTestCase(
    _case: any,
    cfg: any,
    defaultStrict: boolean,
    defaultPromptCap?: number,
    ghRec?: { error_code?: number; timeout_ms?: number }
  ): {
    name: string;
    strict: boolean;
    expect: ExpectBlock;
    prInfo: PRInfo;
    engine: CheckExecutionEngine;
    recorder: RecordingOctokit;
    prompts: Record<string, string[]>;
    mocks: Record<string, unknown>;
    restoreEnv: () => void;
    checksToRun: string[];
  } {
    const name = (_case as any).name || '(unnamed)';
    const strict = (
      typeof (_case as any).strict === 'boolean' ? (_case as any).strict : defaultStrict
    ) as boolean;
    const expect = ((_case as any).expect || {}) as ExpectBlock;
    const fixtureInput =
      typeof (_case as any).fixture === 'object' && (_case as any).fixture
        ? (_case as any).fixture
        : { builtin: (_case as any).fixture };
    const prInfo = buildPrInfoFromFixture(
      this.mapEventFromFixtureName.bind(this),
      fixtureInput?.builtin,
      fixtureInput?.overrides
    );

    // Inject recording Octokit and apply env overrides via EnvironmentManager
    const envMgr = new EnvironmentManager();
    const envOverrides =
      typeof (_case as any).env === 'object' && (_case as any).env
        ? ((_case as any).env as Record<string, string>)
        : undefined;
    envMgr.apply(envOverrides);

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

    // Prompts and mocks setup
    const prompts: Record<string, string[]> = {};
    const mocks =
      typeof (_case as any).mocks === 'object' && (_case as any).mocks
        ? ((_case as any).mocks as Record<string, unknown>)
        : {};
    const mockMgr = new MockManager(mocks);
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
        mockForStep: (step: string) => mockMgr.get(step),
      },
    } as any);

    // Determine checks to run for this event
    const eventForCase = this.mapEventFromFixtureName(fixtureInput?.builtin);
    const desiredSteps = new Set<string>(
      (expect.calls || []).map(c => c.step).filter(Boolean) as string[]
    );
    let checksToRun = this.computeChecksToRun(
      cfg,
      eventForCase,
      desiredSteps.size > 0 ? desiredSteps : undefined
    );
    if (checksToRun.length === 0)
      checksToRun = this.computeChecksToRun(cfg, eventForCase, undefined);

    const restoreEnv = () => envMgr.restore();

    return {
      name,
      strict,
      expect,
      prInfo,
      engine,
      recorder,
      prompts,
      mocks,
      restoreEnv,
      checksToRun,
    };
  }

  // Extracted helper: execute a prepared single case, including on_finish static fallback
  private async executeTestCase(
    setup: ReturnType<VisorTestRunner['setupTestCase']>,
    cfg: any
  ): Promise<{ res: any; outHistory: Record<string, unknown[]> }> {
    const { prInfo, engine, /* recorder, */ checksToRun } = setup;
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
    } catch {}
    if (prevTestMode === undefined) delete process.env.VISOR_TEST_MODE;
    else process.env.VISOR_TEST_MODE = prevTestMode;
    const outHistory = engine.getOutputHistorySnapshot();
    return { res, outHistory };
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
    // Keep the event loop alive until we finish printing the summary.
    // This prevents a natural early exit in environments where no handles remain
    // right after engine cleanup logs.
    // Keep-alive interval kept small to avoid noticeable pauses at end-of-run
    const __keepAlive = setInterval(() => {}, 1000);
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
      const setup = this.setupTestCase(_case, cfg, defaultStrict, defaultPromptCap, ghRec);

      try {
        this.printSelectedChecks(setup.checksToRun);
        // Do not pass an implicit tag filter during tests; let the engine honor config.
        // Inject octokit into eventContext so providers can perform real GitHub ops (recorded)
        try {
          (setup.prInfo as any).eventContext = {
            ...(setup.prInfo as any).eventContext,
            octokit: setup.recorder,
          };
        } catch {}
        const exec = await this.executeTestCase(setup, cfg);
        const res = exec.res;
        if (process.env.VISOR_DEBUG === 'true') {
          try {
            const names = (res.statistics.checks || []).map(
              (c: any) => `${c.checkName}:${c.totalRuns || 0}`
            );
            console.log(`  ⮕ main stats: [${names.join(', ')}]`);
          } catch {}
        }
        try {
          const dbgHist = exec.outHistory;
          console.log(
            `  ⮕ stage base history keys: ${Object.keys(dbgHist).join(', ') || '(none)'}`
          );
        } catch {}
        // (fallback for on_finish static targets handled inside executeTestCase)

        const caseFailures = require('./evaluators').evaluateCase(
          _case.name,
          res.statistics,
          setup.recorder,
          setup.expect,
          setup.strict,
          setup.prompts,
          res.results,
          exec.outHistory
        );
        // Warn about unmocked AI/command steps that executed
        try {
          const mocksUsed =
            typeof (_case as any).mocks === 'object' && (_case as any).mocks
              ? ((_case as any).mocks as Record<string, unknown>)
              : {};
          this.warnUnmockedProviders(res.statistics, cfg, mocksUsed);
        } catch {}
        this.printCoverage(_case.name, res.statistics, setup.expect);
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
        try {
          // Restore env for this case using original setup
          setup.restoreEnv();
        } catch {}
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
    const passedCount = caseResults.filter(r => r.passed).length;
    const failedCases = caseResults.filter(r => !r.passed);
    const passedCases = caseResults.filter(r => r.passed);
    {
      const fsSync = require('fs');
      const write = (s: string) => {
        try {
          fsSync.writeSync(2, s + '\n');
        } catch {
          try {
            console.log(s);
          } catch {}
        }
      };
      write('\n' + this.line('Summary'));
      write(`  Passed: ${passedCount}/${selected.length}`);
      if (passedCases.length > 0) {
        const names = passedCases.map(r => r.name).join(', ');
        write(`   • ${names}`);
      }
      write(`  Failed: ${failedCases.length}/${selected.length}`);
      if (failedCases.length > 0) {
        const maxErrs = Math.max(
          1,
          parseInt(String(process.env.VISOR_SUMMARY_ERRORS_MAX || '5'), 10) || 5
        );
        for (const fc of failedCases) {
          write(`   • ${fc.name}`);
          // If flow case, print failing stages with their first errors
          if (Array.isArray(fc.stages) && fc.stages.length > 0) {
            const bad = fc.stages.filter(s => s.errors && s.errors.length > 0);
            for (const st of bad) {
              write(`     - ${st.name}`);
              const errs = (st.errors || []).slice(0, maxErrs);
              for (const e of errs) write(`       • ${e}`);
              const more = (st.errors?.length || 0) - errs.length;
              if (more > 0) write(`       • … and ${more} more`);
            }
            if (bad.length === 0) {
              // No per-stage errors captured; print names for context
              const names = fc.stages.map(s => s.name).join(', ');
              write(`     stages: ${names}`);
            }
          }
          // Non-flow case errors
          if (
            (!fc.stages || fc.stages.length === 0) &&
            Array.isArray(fc.errors) &&
            fc.errors.length > 0
          ) {
            const errs = fc.errors.slice(0, maxErrs);
            for (const e of errs) write(`     • ${e}`);
            const more = fc.errors.length - errs.length;
            if (more > 0) write(`     • … and ${more} more`);
          }
        }
      }
    }
    try {
      // Expose results and a summary-printed guard for the CLI to detect
      // when runner-level summary was emitted.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__VISOR_TEST_RESULTS__ = { failures, results: caseResults };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__VISOR_SUMMARY_PRINTED__ = true;
    } catch {}
    clearInterval(__keepAlive);
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

    // Shared prompts captured across the flow (FlowStage computes deltas per-stage)
    const prompts: Record<string, string[]> = {};

    // Stage filter (by name substring or 1-based index)
    const sf = (stageFilter || '').trim().toLowerCase();
    const sfIndex = sf && /^\d+$/.test(sf) ? parseInt(sf, 10) : undefined;
    let anyStageRan = false;

    for (let i = 0; i < flowCase.flow.length; i++) {
      const stage = flowCase.flow[i];
      const nm = String(stage.name || `stage-${i + 1}`).toLowerCase();
      if (sf) {
        const idxMatch = sfIndex !== undefined && sfIndex === i + 1;
        const nameMatch = nm.includes(sf);
        if (!(idxMatch || nameMatch)) continue;
      }
      anyStageRan = true;
      const strict = (
        typeof flowCase.strict === 'boolean' ? flowCase.strict : defaultStrict
      ) as boolean;

      try {
        const stageRunner = new FlowStage(
          flowName,
          engine,
          recorder,
          cfg,
          prompts,
          promptCap,
          this.mapEventFromFixtureName.bind(this),
          this.computeChecksToRun.bind(this),
          this.printStageHeader.bind(this),
          this.printSelectedChecks.bind(this),
          this.warnUnmockedProviders.bind(this)
        );
        const outcome = await stageRunner.run(stage, flowCase, strict);
        const expect = (stage as any).expect || {};
        if (outcome.stats) this.printCoverage(outcome.name, outcome.stats, expect);
        if (!outcome.errors) {
          console.log(`✅ PASS ${outcome.name}`);
          stagesSummary.push({ name: outcome.name });
        } else {
          failures += 1;
          console.log(`❌ FAIL ${outcome.name}`);
          for (const f of outcome.errors) console.log(`   - ${f}`);
          stagesSummary.push({ name: outcome.name, errors: outcome.errors });
          if (bail) break;
        }
      } catch (err) {
        failures += 1;
        const name = `${flowName}#${stage.name || `stage-${i + 1}`}`;
        console.log(`❌ ERROR ${name}: ${err instanceof Error ? err.message : String(err)}`);
        stagesSummary.push({ name, errors: [err instanceof Error ? err.message : String(err)] });
        if (bail) break;
      }
    }
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

  // buildPrInfoFromFixture and deepSet moved to src/test-runner/core/fixture.ts

  // (legacy in-class evaluateCase removed; test runner now uses evaluators.ts)

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
