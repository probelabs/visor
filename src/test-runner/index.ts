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
      const badge = isFlow ? 'flow' : (c.event || 'event');
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
  ): Promise<{ failures: number; results: Array<{ name: string; passed: boolean; errors?: string[]; stages?: Array<{ name: string; errors?: string[] }> }> }> {
    // Save defaults for flow runner access
    (this as any).suiteDefaults = suite.tests.defaults || {};
    const only = options.only?.toLowerCase();
    const allCases = suite.tests.cases;
    const selected = only
      ? allCases.filter(c => c.name.toLowerCase().includes(only))
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
    const ghRec = defaultsAny?.github_recorder as { error_code?: number; timeout_ms?: number } | undefined;
    const defaultPromptCap: number | undefined = options.promptMaxChars || (typeof defaultsAny?.prompt_max_chars === 'number' ? defaultsAny.prompt_max_chars : undefined);
    const caseMaxParallel = options.maxParallel || (typeof defaultsAny?.max_parallel === 'number' ? defaultsAny.max_parallel : undefined) || 1;

    // Test overrides: force AI provider to 'mock' when requested (default: mock per RFC)
    const cfg = JSON.parse(JSON.stringify(config));
    for (const name of Object.keys(cfg.checks || {})) {
      const chk = cfg.checks[name] || {};
      if ((chk.type || 'ai') === 'ai') {
        chk.ai = { ...(chk.ai || {}), provider: aiProviderDefault };
        cfg.checks[name] = chk;
      }
    }

    let failures = 0;
    const caseResults: Array<{ name: string; passed: boolean; errors?: string[]; stages?: Array<{ name: string; errors?: string[] }> }> = [];

    const runOne = async (_case: any): Promise<{ name: string; failed: number }> => {
      if (Array.isArray((_case as any).flow) && (_case as any).flow.length > 0) {
        const flowRes = await this.runFlowCase(_case, cfg, defaultStrict, options.bail || false, defaultPromptCap);
        const failed = flowRes.failures;
        caseResults.push({ name: _case.name, passed: failed === 0, stages: flowRes.stages });
        return { name: _case.name, failed };
      }
      const strict = (typeof (_case as any).strict === 'boolean' ? (_case as any).strict : defaultStrict) as boolean;
      const expect = ((_case as any).expect || {}) as ExpectBlock;
      // Fixture selection with optional overrides
      const fixtureInput = (typeof (_case as any).fixture === 'object' && (_case as any).fixture)
        ? (_case as any).fixture
        : { builtin: (_case as any).fixture };
      const prInfo = this.buildPrInfoFromFixture(fixtureInput?.builtin, fixtureInput?.overrides);

      // Inject recording Octokit into engine via actionContext using env owner/repo
      const prevRepo = process.env.GITHUB_REPOSITORY;
      process.env.GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || 'owner/repo';
      // Apply case env overrides if present
      const envOverrides = (typeof (_case as any).env === 'object' && (_case as any).env) ? (_case as any).env as Record<string,string> : undefined;
      const prevEnv: Record<string, string | undefined> = {};
      if (envOverrides) {
        for (const [k, v] of Object.entries(envOverrides)) {
          prevEnv[k] = process.env[k];
          process.env[k] = String(v);
        }
      }
      const ghRecCase = (typeof (_case as any).github_recorder === 'object' && (_case as any).github_recorder)
        ? ((_case as any).github_recorder as { error_code?: number; timeout_ms?: number })
        : undefined;
      const rcOpts = ghRecCase || ghRec;
      const recorder = new RecordingOctokit(rcOpts ? { errorCode: rcOpts.error_code, timeoutMs: rcOpts.timeout_ms } : undefined);
      setGlobalRecorder(recorder);
      const engine = new CheckExecutionEngine(undefined as any, (recorder as unknown) as any);

      // Capture prompts per step
      const prompts: Record<string, string[]> = {};
      const mocks = (typeof (_case as any).mocks === 'object' && (_case as any).mocks) ? (_case as any).mocks as Record<string, unknown> : {};
      engine.setExecutionContext({
        hooks: {
          onPromptCaptured: (info: { step: string; provider: string; prompt: string }) => {
            const k = info.step;
            if (!prompts[k]) prompts[k] = [];
            const p = defaultPromptCap && info.prompt.length > defaultPromptCap ? info.prompt.slice(0, defaultPromptCap) : info.prompt;
            prompts[k].push(p);
          },
          mockForStep: (step: string) => mocks[step],
        },
      } as any);

      try {
        const eventForCase = this.mapEventFromFixtureName(fixtureInput?.builtin);
        const desiredSteps = new Set<string>((expect.calls || []).map(c => c.step).filter(Boolean) as string[]);
        const checksToRun = this.computeChecksToRun(cfg, eventForCase, desiredSteps.size > 0 ? desiredSteps : undefined);
        // Include all tagged checks by default in test mode: build tagFilter.include = union of all tags
        const allTags: string[] = Array.from(
          new Set(
            Object.values(cfg.checks || {})
              .flatMap((c: any) => Array.isArray(c?.tags) ? c.tags : [])
              .filter((t: any) => typeof t === 'string') as string[]
          )
        );
        // Inject octokit into eventContext so providers can perform real GitHub ops (recorded)
        try { (prInfo as any).eventContext = { ...(prInfo as any).eventContext, octokit: recorder }; } catch {}

        const res = await engine.executeGroupedChecks(
          prInfo,
          checksToRun,
          120000,
          cfg,
          'json',
          false,
          undefined,
          false,
          { include: allTags }
        );
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
        caseResults.push({ name: _case.name, passed: false, errors: [err instanceof Error ? err.message : String(err)] });
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

    if ((options.bail || false) || caseMaxParallel <= 1) {
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
    promptCap?: number
  ): Promise<{ failures: number; stages: Array<{ name: string; errors?: string[] }> }> {
    const suiteDefaults: any = (this as any).suiteDefaults || {};
    const ghRec = suiteDefaults.github_recorder as { error_code?: number; timeout_ms?: number } | undefined;
    const ghRecCase = (typeof (flowCase as any).github_recorder === 'object' && (flowCase as any).github_recorder)
      ? ((flowCase as any).github_recorder as { error_code?: number; timeout_ms?: number })
      : undefined;
    const rcOpts = ghRecCase || ghRec;
    const recorder = new RecordingOctokit(rcOpts ? { errorCode: rcOpts.error_code, timeoutMs: rcOpts.timeout_ms } : undefined);
    setGlobalRecorder(recorder);
    const engine = new CheckExecutionEngine(undefined as any, (recorder as unknown) as any);
    const flowName = flowCase.name || 'flow';
    let failures = 0;
    const stagesSummary: Array<{ name: string; errors?: string[] }> = [];

    // Shared prompts map across flow; we will compute per-stage deltas
    const prompts: Record<string, string[]> = {};
    const stageMocks = (typeof (flowCase.mocks) === 'object' && flowCase.mocks) ? (flowCase.mocks as Record<string,unknown>) : {};
    engine.setExecutionContext({
      hooks: {
        onPromptCaptured: (info: { step: string; provider: string; prompt: string }) => {
          const k = info.step;
          if (!prompts[k]) prompts[k] = [];
          const p = promptCap && info.prompt.length > promptCap ? info.prompt.slice(0, promptCap) : info.prompt;
          prompts[k].push(p);
        },
        mockForStep: (step: string) => stageMocks[step],
      },
    } as any);

    // Run each stage
    for (let i = 0; i < flowCase.flow.length; i++) {
      const stage = flowCase.flow[i];
      const stageName = `${flowName}#${stage.name || `stage-${i + 1}`}`;
      const strict = (typeof flowCase.strict === 'boolean' ? flowCase.strict : defaultStrict) as boolean;

      // Fixture + env
      const fixtureInput = (typeof stage.fixture === 'object' && stage.fixture)
        ? stage.fixture
        : { builtin: stage.fixture };
      const prInfo = this.buildPrInfoFromFixture(fixtureInput?.builtin, fixtureInput?.overrides);

      // Stage env overrides
      const envOverrides = (typeof stage.env === 'object' && stage.env) ? (stage.env as Record<string,string>) : undefined;
      const prevEnv: Record<string, string | undefined> = {};
      if (envOverrides) {
        for (const [k, v] of Object.entries(envOverrides)) {
          prevEnv[k] = process.env[k];
          process.env[k] = String(v);
        }
      }

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
        const desiredSteps = new Set<string>(((stage.expect || {}).calls || []).map((c: any) => c.step).filter(Boolean) as string[]);
        const checksToRun = this.computeChecksToRun(cfg, eventForStage, desiredSteps.size > 0 ? desiredSteps : undefined);
        const allTags: string[] = Array.from(
          new Set(
            Object.values(cfg.checks || {})
              .flatMap((c: any) => Array.isArray(c?.tags) ? c.tags : [])
              .filter((t: any) => typeof t === 'string') as string[]
          )
        );
        // Ensure eventContext carries octokit for recorded GitHub ops
        try { (prInfo as any).eventContext = { ...(prInfo as any).eventContext, octokit: recorder }; } catch {}
        const res = await engine.executeGroupedChecks(prInfo, checksToRun, 120000, cfg, 'json', false, undefined, false, { include: allTags });

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

        // Evaluate stage expectations
        const expect = stage.expect || {};
        const caseFailures = this.evaluateCase(
          stageName,
          res.statistics,
          // Use only call delta for stage
          { calls: recorder.calls.slice(callBase) } as any,
          expect,
          strict,
          stagePrompts,
          res.results,
          stageHist
        );
        this.printCoverage(stageName, res.statistics, expect);
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
        stagesSummary.push({ name: stageName, errors: [err instanceof Error ? err.message : String(err)] });
        if (bail) break;
      } finally {
        if (envOverrides) {
          for (const [k, oldv] of Object.entries(prevEnv)) {
            if (oldv === undefined) delete process.env[k]; else process.env[k] = oldv;
          }
        }
      }
    }

    // Summary line for flow
    if (failures === 0) console.log(`✅ FLOW PASS ${flowName}`);
    else console.log(`❌ FLOW FAIL ${flowName} (${failures} stage error${failures>1?'s':''})`);
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

  private buildPrInfoFromFixture(fixtureName?: string, overrides?: Record<string, unknown>): PRInfo {
    const eventType = this.mapEventFromFixtureName(fixtureName);
    const isIssue = eventType === 'issue_opened' || eventType === 'issue_comment';
    const number = 1;
    const loader = new FixtureLoader();
    const fx = fixtureName && fixtureName.startsWith('gh.') ? loader.load(fixtureName as any) : undefined;
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
          fx?.webhook?.name || (isIssue ? (eventType === 'issue_comment' ? 'issue_comment' : 'issues') : 'pull_request'),
        action: fx?.webhook?.action || (eventType === 'pr_opened' ? 'opened' : eventType === 'pr_updated' ? 'synchronize' : undefined),
        issue: isIssue ? { number, title, body, user: { login: 'test-user' } } : undefined,
        pull_request: !isIssue ? { number, title, head: { ref: 'feature/test' }, base: { ref: 'main' } } : undefined,
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
          this.deepSet((prInfo as any).eventContext || ((prInfo as any).eventContext = {}), path, v);
        }
      }
    }
    return prInfo;
  }

  private deepSet(target: any, path: string, value: unknown): void {
    const parts: (string|number)[] = [];
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
        (expect.calls || [])
          .filter(c => c.step)
          .map(c => String(c.step))
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
        const matched = recorder.calls.filter(c => (!op || c.op === op));
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
        const matched = recorder.calls.filter(c => (!op || c.op === op));
        if (matched.length > 0) errors.push(`Expected no github ${nc.op} calls, but found ${matched.length}`);
      }
      if (nc.step && executed[nc.step] > 0) {
        errors.push(`Expected no step ${nc.step} calls, but executed ${executed[nc.step]}`);
      }
    }

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
            try {
              let pattern = where.matches;
              let flags = '';
              const m = pattern.match(/^\(\?([gimsuy]+)\)/);
              if (m) { flags = m[1]; pattern = pattern.slice(m[0].length); }
              const re = new RegExp(pattern, flags);
              ok = ok && re.test(candidate);
            } catch {
              ok = false;
            }
          }
          if (ok) { prompt = candidate; break; }
        }
      } else {
        const idx = p.index === 'first' ? 0 : p.index === 'last' ? arr.length - 1 : (p.index as number) ?? arr.length - 1;
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
        try {
          let pattern = p.matches;
          let flags = '';
          const m = pattern.match(/^\(\?([gimsuy]+)\)/);
          if (m) { flags = m[1]; pattern = pattern.slice(m[0].length); }
          const re = new RegExp(pattern, flags);
          if (!re.test(prompt)) errors.push(`Prompt for ${p.step} does not match: ${p.matches}`);
        } catch {
          errors.push(`Invalid regex in matches for ${p.step}`);
        }
      }
    }

    // Outputs assertions with history and selectors
    const { deepGet } = require('./utils/selectors');
    const { deepEqual, containsUnordered } = require('./assertions');
    for (const o of expect.outputs || []) {
      const history = outputHistory[o.step] || [];
      if (process.env.VISOR_DEBUG === 'true') {
        try {
          const preview = history.length > 0 ? JSON.stringify(history[history.length - 1]).slice(0, 200) : '[]';
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
            try {
              const re = new RegExp(o.where.matches);
              if (re.test(String(probe))) {
                chosen = item;
                break;
              }
            } catch {}
          }
        }
        if (chosen === undefined) {
          errors.push(`No output matched where selector for ${o.step}`);
          continue;
        }
      } else {
        const idx = o.index === 'first' ? 0 : o.index === 'last' ? history.length - 1 : (o.index as number) ?? history.length - 1;
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
          errors.push(`Output ${o.step}.${o.path} expected ${JSON.stringify(o.equals)} but got ${JSON.stringify(val)}`);
        }
      }
      if (o.matches) {
        try {
          let pattern = o.matches;
          let flags = '';
          const m = pattern.match(/^\(\?([gimsuy]+)\)/);
          if (m) { flags = m[1]; pattern = pattern.slice(m[0].length); }
          const re = new RegExp(pattern, flags);
          if (!re.test(String(val))) errors.push(`Output ${o.step}.${o.path} does not match ${o.matches}`);
        } catch {
          errors.push(`Invalid regex for outputs.matches in ${o.step}`);
        }
      }
      if (o.contains_unordered) {
        if (!Array.isArray(val)) errors.push(`Output ${o.step}.${o.path} not an array for contains_unordered`);
        else if (!containsUnordered(val, o.contains_unordered)) errors.push(`Output ${o.step}.${o.path} missing elements (unordered)`);
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
      const triggers: string[] = Array.isArray(chk.on) ? chk.on : (chk.on ? [chk.on] : []);
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
      const deps: string[] = Array.isArray(chk.depends_on) ? chk.depends_on : (chk.depends_on ? [chk.depends_on] : []);
      for (const d of deps) visit(d, depth + 1);
    };
    for (const n of desired) visit(n);
    // Intersect with event filter to avoid off-event execution
    return byEvent.filter(n => selected.has(n));
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
    const expectedSteps = new Map<string, { exactly?: number; at_least?: number; at_most?: number }>();
    for (const c of expCalls) expectedSteps.set(c.step!, { exactly: c.exactly, at_least: c.at_least, at_most: c.at_most });
    const rows: Array<{ step: string; want: string; got: number; status: string }> = [];
    for (const [step, want] of expectedSteps.entries()) {
      const got = executed[step] || 0;
      let status = 'ok';
      if (want.exactly !== undefined) status = got === want.exactly ? 'ok' : got < want.exactly ? 'under' : 'over';
      else if (want.at_least !== undefined) status = got >= want.at_least ? 'ok' : 'under';
      else if (want.at_most !== undefined) status = got <= want.at_most ? 'ok' : 'over';
      const wantStr = want.exactly !== undefined
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
        console.log(`     • ${pad(r.step, 24)} want ${pad(r.want, 6)} got ${String(r.got).padStart(2)}  ${r.status}`);
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

export async function runMvp(options: { testsPath?: string; only?: string; bail?: boolean; maxParallel?: number; promptMaxChars?: number }): Promise<number> {
  const runner = new VisorTestRunner();
  const testsPath = runner.resolveTestsPath(options.testsPath);
  const suite = runner.loadSuite(testsPath);
  const { failures } = await runner.runCases(testsPath, suite, { only: options.only, bail: !!options.bail, maxParallel: options.maxParallel, promptMaxChars: options.promptMaxChars });
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
