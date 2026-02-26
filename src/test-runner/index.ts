import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import * as yaml from 'js-yaml';
import { ConfigManager } from '../config';
import { StateMachineExecutionEngine } from '../state-machine-execution-engine';
import type { PRInfo } from '../pr-analyzer';
import { RecordingOctokit } from './recorders/github-recorder';
import { MemoryStore } from '../memory-store';
import { SessionRegistry } from '../session-registry';
import { setGlobalRecorder } from './recorders/global-recorder';
// import { FixtureLoader } from './fixture-loader';
import { type ExpectBlock } from './assertions';
import { FlowStage } from './core/flow-stage';
import { TestExecutionWrapper } from './core/test-execution-wrapper';
// evaluators are required at call sites to avoid circular import during build
import { EnvironmentManager } from './core/environment';
import { MockManager } from './core/mocks';
import { buildPrInfoFromFixture } from './core/fixture';
import { validateTestsDoc } from './validator';
import { createSecureSandbox, compileAndRun } from '../utils/sandbox';
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
  testsPath?: string; // File, directory, or glob pattern
  cwd?: string;
}
function ensureTestEnvDefaults(): void {
  if (!process.env.VISOR_TEST_MODE) process.env.VISOR_TEST_MODE = 'true';
  if (!process.env.VISOR_TEST_PROMPT_MAX_CHARS) {
    process.env.VISOR_TEST_PROMPT_MAX_CHARS = process.env.CI === 'true' ? '4000' : '8000';
  }
  if (!process.env.VISOR_TEST_HISTORY_LIMIT) {
    process.env.VISOR_TEST_HISTORY_LIMIT = process.env.CI === 'true' ? '200' : '500';
  }
}
/**
 * Very small glob-to-RegExp converter supporting **, *, and ?
 * - ** matches across path separators
 * - *  matches any chars except '/'
 * - ?  matches a single char except '/'
 */
function globToRegExp(glob: string): RegExp {
  // Escape regex special chars, then replace globs
  const re = glob
    .replace(/[.+^${}()|\[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::GLOBSTAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/::GLOBSTAR::/g, '.*');
  return new RegExp('^' + re + '$');
}
function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
function listFilesRecursive(root: string, predicate: (p: string) => boolean): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  const ignoreDirs = new Set([
    '.git',
    'node_modules',
    'dist',
    'output',
    'tmp',
    '.schema-tmp',
    '.visor',
  ]);
  while (stack.length) {
    const cur = stack.pop() as string;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(cur).map(n => path.join(cur, n));
    } catch {
      continue;
    }
    for (const e of entries) {
      try {
        const st = fs.statSync(e);
        if (st.isDirectory()) {
          const base = path.basename(e);
          if (!ignoreDirs.has(base)) stack.push(e);
        } else if (st.isFile()) {
          if (predicate(e)) out.push(e);
        }
      } catch {
        // ignore
      }
    }
  }
  return out;
}
/**
 * Discover all YAML test suites under a directory or by glob pattern.
 * Rules:
 *  - Include files ending with .tests.yaml/.tests.yml
 *  - Include YAML files containing a top-level `tests:` key (embedded suites)
 */
export function discoverSuites(rootOrPattern?: string, cwd: string = process.cwd()): string[] {
  const root = rootOrPattern
    ? path.isAbsolute(rootOrPattern)
      ? rootOrPattern
      : path.resolve(cwd, rootOrPattern)
    : cwd;
  const candidates: string[] = [];
  const matcher = (() => {
    // If input looks like a glob (contains * or ?), compile into regex and scan from cwd
    if (rootOrPattern && /[?*]/.test(rootOrPattern)) {
      const rx = globToRegExp(
        path.isAbsolute(rootOrPattern) ? rootOrPattern : path.resolve(cwd, rootOrPattern)
      );
      return (p: string) => rx.test(p);
    }
    return null;
  })();
  if (matcher) {
    // Walk from repo root/cwd and test regex against absolute paths
    const files = listFilesRecursive(cwd, p => /\.ya?ml$/i.test(p) && matcher(p));
    candidates.push(...files);
  } else if (isDir(root)) {
    // Directory discovery
    const files = listFilesRecursive(root, p => /\.ya?ml$/i.test(p));
    candidates.push(...files);
  } else if (isFile(root)) {
    candidates.push(root);
  }
  // Filter to suites: *.tests.yaml|yml or YAML with top-level `tests.cases` array
  const suites: string[] = [];
  for (const f of candidates) {
    if (/\.tests\.ya?ml$/i.test(f)) {
      suites.push(f);
      continue;
    }
    // Probe for embedded tests key (cheap read + yaml parse)
    try {
      const raw = fs.readFileSync(f, 'utf8');
      // quick reject for large files
      if (!/\btests\s*:/i.test(raw)) continue;
      const doc = yaml.load(raw) as any;
      const isSuite =
        doc &&
        typeof doc === 'object' &&
        doc.tests &&
        typeof doc.tests === 'object' &&
        Array.isArray((doc.tests as any).cases);
      if (isSuite) suites.push(f);
    } catch {
      // ignore unreadable
    }
  }
  // Stable order for reproducibility
  return Array.from(new Set(suites)).sort((a, b) => a.localeCompare(b));
}
export async function runSuites(
  files: string[],
  options: {
    only?: string;
    bail?: boolean;
    noMocks?: boolean;
    noMocksFor?: string[];
    maxParallelSuites?: number;
    maxParallel?: number;
    promptMaxChars?: number;
  }
): Promise<{
  totalSuites: number;
  failedSuites: number;
  totalCases: number;
  failedCases: number;
  perSuite: Array<{
    file: string;
    failures: number;
    results: Array<{
      name: string;
      passed: boolean;
      errors?: string[];
      stages?: Array<{ name: string; errors?: string[] }>;
    }>;
  }>;
}> {
  ensureTestEnvDefaults();
  const perSuite: Array<{
    file: string;
    failures: number;
    results: Array<{
      name: string;
      passed: boolean;
      errors?: string[];
      stages?: Array<{ name: string; errors?: string[] }>;
    }>;
  }> = [];
  let failedSuites = 0;
  let totalCases = 0;
  let failedCases = 0;
  let idx = 0;
  const filesSorted = [...files];
  const workers = Math.max(1, options.maxParallelSuites || 1);
  let stop = false;
  const runWorker = async () => {
    while (!stop) {
      const i = idx++;
      if (i >= filesSorted.length) return;
      const fp = filesSorted[i];
      let suite: TestSuite | null = null;
      try {
        const runner = new VisorTestRunner();
        suite = runner.loadSuite(fp);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Record a synthetic failure for this suite and continue to others
        perSuite.push({
          file: fp,
          failures: 1,
          results: [{ name: '(load)', passed: false, errors: [msg] }],
        });
        failedSuites += 1;
        failedCases += 1;
        totalCases += 1;
        if (options.bail) stop = true;
        continue;
      }
      // expose relative path for suite header printing
      const runner = new VisorTestRunner();
      (runner as any).__suiteRel = path.relative(process.cwd(), fp) || fp;
      const r = await runner.runCases(fp, suite as TestSuite, {
        only: options.only,
        bail: options.bail,
        noMocks: options.noMocks,
        noMocksFor: options.noMocksFor,
        maxParallel: options.maxParallel,
        promptMaxChars: options.promptMaxChars,
      });
      perSuite.push({ file: fp, failures: r.failures, results: r.results });
      failedSuites += r.failures > 0 ? 1 : 0;
      totalCases += r.results.length;
      failedCases += r.results.filter(x => !x.passed).length;
      if (options.bail && r.failures > 0) {
        stop = true; // stop scheduling new suites
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, runWorker));
  return {
    totalSuites: filesSorted.length,
    failedSuites,
    totalCases,
    failedCases,
    perSuite,
  };
}
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function checkRequirements(requires?: string | string[]): { met: boolean; reason?: string } {
  if (!requires) return { met: true };
  const reqs = Array.isArray(requires) ? requires : [requires];
  for (const req of reqs) {
    switch (req.toLowerCase()) {
      case 'linux':
        if (process.platform !== 'linux')
          return { met: false, reason: `requires linux (got ${process.platform})` };
        break;
      case 'darwin':
        if (process.platform !== 'darwin')
          return { met: false, reason: `requires darwin (got ${process.platform})` };
        break;
      case 'windows':
        if (process.platform !== 'win32')
          return { met: false, reason: `requires windows (got ${process.platform})` };
        break;
      default:
        // Treat as tool name — check availability via `which`
        try {
          execFileSync('which', [req], { timeout: 5000, stdio: 'ignore' });
        } catch {
          return { met: false, reason: `'${req}' not found in PATH` };
        }
    }
  }
  return { met: true };
}
export class VisorTestRunner {
  constructor(private readonly cwd: string = process.cwd()) {}
  // Minimal TTY color helpers (no external deps)
  private readonly isTTY = typeof process !== 'undefined' && !!process.stderr.isTTY;
  private color(txt: string, code: string): string {
    if (!this.isTTY || process.env.NO_COLOR) return txt;
    return `\u001b[${code}m${txt}\u001b[0m`;
  }
  private bold(txt: string): string {
    return this.color(txt, '1');
  }
  private gray(txt: string): string {
    return this.color(txt, '90');
  }
  private tagPass(): string {
    return this.color(this.color(' PASS ', '30'), '42'); // black on green
  }
  private tagFail(): string {
    return this.color(this.color(' FAIL ', '97'), '41'); // white on red
  }
  private tagSkip(): string {
    return this.color(this.color(' SKIP ', '30'), '43'); // black on yellow
  }
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
    ghRec?: { error_code?: number; timeout_ms?: number },
    defaultIncludeTags?: string[] | undefined,
    defaultExcludeTags?: string[] | undefined,
    noMocks?: boolean,
    noMocksFor?: string[]
  ): {
    name: string;
    strict: boolean;
    expect: ExpectBlock;
    prInfo: PRInfo;
    engine: StateMachineExecutionEngine;
    recorder: RecordingOctokit;
    slackRecorder?: { calls: Array<{ provider: string; op: string; args: any; ts: number }> };
    prompts: Record<string, string[]>;
    mocks: Record<string, unknown>;
    restoreEnv: () => void;
    checksToRun: string[];
    tagFilter?: { include?: string[]; exclude?: string[] };
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
    // Optional Slack recorder when tests enable 'slack' frontend
    let slackRecorder: any | undefined;
    setGlobalRecorder(recorder);
    // Always clear in-memory store between cases to prevent cross-case leakage
    try {
      MemoryStore.resetInstance();
    } catch {}
    // Always clear AI sessions between cases to prevent cross-case leakage
    try {
      SessionRegistry.getInstance().clearAllSessions();
    } catch {}
    // Always use StateMachineExecutionEngine
    const engine = new StateMachineExecutionEngine(undefined as any, recorder as unknown as any);
    try {
      // Seed execution context with octokit so frontends can act in flows
      const prev: any = (engine as any).executionContext || {};
      // Attach GitHub and (optionally) Slack test doubles into executionContext
      const ctxPatch: any = { ...prev, octokit: recorder as unknown as any };
      try {
        const suiteDefaults: any = (this as any).suiteDefaults || {};
        const fns = (suiteDefaults.frontends || undefined) as unknown;
        const names = Array.isArray(fns)
          ? (fns as any[])
              .map(x => (typeof x === 'string' ? x : (x && x.name) || ''))
              .filter(Boolean)
          : [];
        if (names.includes('slack')) {
          const { RecordingSlack } = require('./recorders/slack-recorder');
          slackRecorder = new RecordingSlack();
          ctxPatch.slack = slackRecorder;
        }
      } catch {}
      (engine as any).setExecutionContext(ctxPatch);
    } catch {}
    // Prompts and mocks setup
    const prompts: Record<string, string[]> = {};
    const mocks =
      typeof (_case as any).mocks === 'object' && (_case as any).mocks
        ? ((_case as any).mocks as Record<string, unknown>)
        : {};
    const mockMgr = new MockManager(mocks);
    // Pre-compute which steps should be unmocked based on provider type
    const noMockSteps = new Set<string>();
    if (noMocksFor && noMocksFor.length > 0) {
      const noMockTypes = new Set(noMocksFor);
      for (const [checkName, chk] of Object.entries((cfg.checks || {}) as Record<string, any>)) {
        const t = chk.type || 'ai';
        if (noMockTypes.has(t)) noMockSteps.add(checkName);
      }
    }
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
    const caseInclude = parseTags((_case as any).tags);
    const caseExclude = parseTags((_case as any).exclude_tags);
    const include = Array.from(new Set([...(defaultIncludeTags || []), ...(caseInclude || [])]));
    const exclude = Array.from(new Set([...(defaultExcludeTags || []), ...(caseExclude || [])]));
    const tagFilter = {
      include: include.length ? include : undefined,
      exclude: exclude.length ? exclude : undefined,
    };
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
        // In noMocks mode, always return undefined to let real providers execute
        // In noMocksFor mode, skip mocks for steps matching excluded provider types
        mockForStep: (step: string) => {
          if (noMocks) return undefined;
          if (noMockSteps.size > 0 && noMockSteps.has(step)) return undefined;
          return mockMgr.get(step);
        },
        // Ensure human-input never blocks tests: prefer case mock, then default value
        onHumanInput: async (req: { checkId: string; default?: string }) => {
          if (noMocks) return (req.default ?? '').toString();
          const m = mockMgr.get(req.checkId);
          if (m !== undefined && m !== null) return String(m);
          return (req.default ?? '').toString();
        },
      },
      // Expose Octokit to frontends via executionContext so event-driven
      // GitHub frontend can perform calls during tests
      octokit: recorder as unknown as any,
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
      slackRecorder,
      prompts,
      mocks,
      restoreEnv,
      checksToRun,
      tagFilter,
    };
  }
  // Extracted helper: execute a prepared single case, including on_finish static fallback
  private async executeTestCase(
    setup: ReturnType<VisorTestRunner['setupTestCase']>,
    cfg: any
  ): Promise<{ res: any; outHistory: Record<string, unknown[]> }> {
    const { prInfo, engine, /* recorder, */ checksToRun, tagFilter } = setup;
    const prevStrict = process.env.VISOR_STRICT_ERRORS;
    process.env.VISOR_STRICT_ERRORS = 'true';
    const wrapper = new TestExecutionWrapper(engine);
    const { res, outHistory } = await wrapper.execute(
      prInfo,
      checksToRun,
      cfg,
      process.env.VISOR_DEBUG === 'true',
      tagFilter
    );
    if (prevStrict === undefined) delete process.env.VISOR_STRICT_ERRORS;
    else process.env.VISOR_STRICT_ERRORS = prevStrict;
    return { res, outHistory };
  }
  private printCaseHeader(name: string, kind: 'flow' | 'single', event?: string): void {
    console.log('\n' + this.line(`${this.bold('Case')}: ${name}`));
    const meta: string[] = [`type=${kind}`];
    if (event) meta.push(`event=${event}`);
    console.log(`  ${this.gray(meta.join('  ·  '))}`);
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
    if (meta.length) console.log(`  ${this.gray(meta.join('  ·  '))}`);
  }
  private printSelectedChecks(checks: string[]): void {
    if (!checks || checks.length === 0) return;
    console.log(`  checks: ${checks.join(', ')}`);
  }
  /**
   * Compute workflow outputs from output definitions and step results.
   * Evaluates value_js and value (Liquid) expressions to produce output values.
   */
  private computeWorkflowOutputs(
    outputDefs: Array<{ name: string; value?: string; value_js?: string }>,
    outputHistory: Record<string, unknown[]>,
    results: any[]
  ): Record<string, unknown> {
    const computed: Record<string, unknown> = {};
    // Build a steps map from outputHistory (last output for each step)
    const steps: Record<string, unknown> = {};
    for (const [stepId, hist] of Object.entries(outputHistory)) {
      if (Array.isArray(hist) && hist.length > 0) {
        steps[stepId] = hist[hist.length - 1];
      }
    }
    // Build outputs map from history (for {{ outputs["step"] }} syntax)
    const outputs: Record<string, unknown> = { ...steps };

    for (const outputDef of outputDefs) {
      if (!outputDef.name) continue;
      try {
        if (outputDef.value_js) {
          // Evaluate JavaScript expression using sandbox
          const sandbox = createSecureSandbox();
          const scope = { steps, outputs, results };
          computed[outputDef.name] = compileAndRun(sandbox, outputDef.value_js, scope, {
            injectLog: false,
            wrapFunction: true,
          });
        } else if (outputDef.value) {
          // Evaluate Liquid template with extended filters and tags
          const { createExtendedLiquid } = require('../liquid-extensions');
          const engine = createExtendedLiquid();
          const rendered = engine.parseAndRenderSync(outputDef.value, { steps, outputs, results });
          // Try to parse as JSON, otherwise keep as string
          try {
            computed[outputDef.name] = JSON.parse(rendered);
          } catch {
            computed[outputDef.name] = rendered.trim();
          }
        }
      } catch (e) {
        // Skip outputs that fail to compute
        if (process.env.VISOR_DEBUG === 'true') {
          console.log(`  ⚠️ Failed to compute output '${outputDef.name}': ${e}`);
        }
      }
    }
    return computed;
  }

  /**
   * Auto-propagate step outputs as workflow outputs when no explicit outputs defined.
   * Mirrors the logic in workflow-check-provider.ts for consistency.
   */
  private autoPropagateeWorkflowOutputs(
    outputHistory: Record<string, unknown[]>
  ): Record<string, unknown> | undefined {
    // Build outputs map from history (last output for each step)
    const outputsMap: Record<string, unknown> = {};
    for (const [stepId, hist] of Object.entries(outputHistory)) {
      if (Array.isArray(hist) && hist.length > 0) {
        outputsMap[stepId] = hist[hist.length - 1];
      }
    }

    const stepNames = Object.keys(outputsMap);
    if (stepNames.length === 0) {
      return undefined;
    }

    // For single-step workflows, unwrap the step output to top level
    if (stepNames.length === 1) {
      const singleStepOutput = outputsMap[stepNames[0]];
      // Return the step's output directly if it's an object, otherwise wrap it
      if (
        singleStepOutput &&
        typeof singleStepOutput === 'object' &&
        !Array.isArray(singleStepOutput)
      ) {
        return singleStepOutput as Record<string, unknown>;
      }
      return { result: singleStepOutput };
    }

    // For multi-step workflows, keep outputs nested by step name
    return outputsMap;
  }

  /**
   * Locate a tests file: explicit path > ./.visor.tests.yaml > defaults/visor.tests.yaml
   */
  public resolveTestsPath(explicit?: string): string {
    if (explicit) {
      const resolved = path.isAbsolute(explicit) ? explicit : path.resolve(this.cwd, explicit);
      // Security: prevent path traversal outside the working directory
      const normalizedPath = path.normalize(resolved);
      const normalizedCwd = path.normalize(this.cwd);
      if (!normalizedPath.startsWith(normalizedCwd)) {
        throw new Error(
          `Security error: Path traversal detected. Cannot access files outside working directory: ${this.cwd}`
        );
      }
      try {
        // Atomic-ish validation: stat then open a descriptor
        const stats = fs.statSync(resolved);
        if (!stats.isFile()) {
          throw new Error(`Explicit tests file is not a regular file: ${resolved}`);
        }
        const fd = fs.openSync(resolved, 'r');
        fs.closeSync(fd);
      } catch {
        throw new Error(`Explicit tests file not accessible: ${resolved}`);
      }
      return resolved;
    }
    const candidates = [
      // New non-dot defaults filename only
      path.resolve(this.cwd, 'defaults/visor.tests.yaml'),
      path.resolve(this.cwd, 'defaults/visor.tests.yml'),
      // Allow project-local dotfile tests names (not legacy defaults)
      path.resolve(this.cwd, '.visor.tests.yaml'),
      path.resolve(this.cwd, '.visor.tests.yml'),
    ];
    const normalizedCwd = path.normalize(this.cwd);
    for (const p of candidates) {
      // Security: validate candidate paths don't escape working directory
      const normalizedPath = path.normalize(p);
      if (!normalizedPath.startsWith(normalizedCwd)) continue;
      try {
        const stats = fs.statSync(p);
        if (stats.isFile()) return p;
      } catch {
        // not accessible; skip
        continue;
      }
    }
    const attemptedPaths = candidates.join(', ');
    throw new Error(
      `No tests file found. Attempted: ${attemptedPaths}. Provide --config <path> or add defaults/visor.tests.yaml.`
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
      let lineHint = '';
      try {
        const first = String(validation.errors[0] || '');
        const m = first.match(/unknown field\s+"([^"]+)"/i);
        const badKey = m ? m[1] : undefined;
        if (badKey) {
          const ln = findKeyLineInParent(raw, 'tests', badKey);
          if (ln) lineHint = ` (at ${path.relative(process.cwd(), testsPath)}:${ln})`;
        }
      } catch {}
      const errs = validation.errors.map(e => ` - ${e}`).join('\n');
      throw new Error(`Tests file validation failed${lineHint}:\n${errs}`);
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
    options: {
      only?: string;
      bail?: boolean;
      noMocks?: boolean;
      noMocksFor?: string[];
      maxParallel?: number;
      promptMaxChars?: number;
    }
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
    const __suiteStart = Date.now();
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
    let config: any;
    // Prefer co-located config when present, even if tests use extends.
    // This preserves local checks/steps and still honors extends through ConfigManager.
    const rawCfg = fs.readFileSync(testsPath, 'utf8');
    const docAny = yaml.load(rawCfg) as any;
    const hasCoLocatedConfig =
      !!docAny && typeof docAny === 'object' && (docAny.steps || docAny.checks);
    if (hasCoLocatedConfig) {
      const cfgObj: Record<string, unknown> = { ...(docAny as Record<string, unknown>) };
      delete (cfgObj as Record<string, unknown>)['tests'];
      config = await cm.loadConfigFromObject(cfgObj as any, {
        validate: true,
        mergeDefaults: true,
        baseDir: path.dirname(testsPath),
      });
    } else {
      // For tests-only files, prefer loading the base config referenced by extends.
      let configFileToLoad = testsPath;
      const parentExt = suite.extends;
      if (parentExt) {
        const first = Array.isArray(parentExt) ? parentExt[0] : parentExt;
        if (typeof first === 'string') {
          configFileToLoad = path.isAbsolute(first)
            ? first
            : path.resolve(path.dirname(testsPath), first);
        }
      }
      config = await cm.loadConfig(configFileToLoad, { validate: true, mergeDefaults: true });
    }
    if (!config.checks) {
      throw new Error('Loaded config has no checks; cannot run tests');
    }
    const defaultsAny: any = suite.tests.defaults || {};
    (this as any).suiteDefaults = defaultsAny;
    const defaultStrict = defaultsAny?.strict !== false;
    const aiProviderDefault = defaultsAny?.ai_provider || 'mock';
    const ghRec = defaultsAny?.github_recorder as
      | { error_code?: number; timeout_ms?: number }
      | undefined;
    const envPromptCapRaw = process.env.VISOR_TEST_PROMPT_MAX_CHARS;
    const envPromptCap = envPromptCapRaw ? parseInt(envPromptCapRaw, 10) : undefined;
    const defaultPromptCap: number | undefined =
      options.promptMaxChars ??
      (Number.isFinite(envPromptCap as number) ? (envPromptCap as number) : undefined) ??
      (typeof defaultsAny?.prompt_max_chars === 'number'
        ? defaultsAny.prompt_max_chars
        : undefined);
    const caseMaxParallel =
      options.maxParallel ||
      (typeof defaultsAny?.max_parallel === 'number' ? defaultsAny.max_parallel : undefined) ||
      1;
    // Parse default tags/include and exclude from suite defaults (string or array)
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
    const defaultIncludeTags = parseTags(defaultsAny?.tags);
    const defaultExcludeTags = parseTags(defaultsAny?.exclude_tags);
    // Test overrides: force AI provider to 'mock' when requested (default: mock per RFC)
    // In --no-mocks mode, skip the mock provider override so real AI providers execute.
    const cfg = JSON.parse(JSON.stringify(config));
    const noMocksAll = options.noMocks || false;
    const noMocksForAi =
      !noMocksAll && options.noMocksFor ? options.noMocksFor.includes('ai') : false;
    const skipAiMockOverride = noMocksAll || noMocksForAi;
    const allowCtxEnv =
      String(process.env.VISOR_TEST_ALLOW_CODE_CONTEXT || '').toLowerCase() === 'true';
    const forceNoCtxEnv =
      String(process.env.VISOR_TEST_FORCE_NO_CODE_CONTEXT || '').toLowerCase() === 'true';
    for (const name of Object.keys(cfg.checks || {})) {
      const chk = cfg.checks[name] || {};
      if ((chk.type || 'ai') === 'ai') {
        const prev = (chk.ai || {}) as Record<string, unknown>;
        // Respect existing per-check setting by default.
        // Only tweak when explicitly requested by env flags.
        const skipCtx = forceNoCtxEnv
          ? true
          : allowCtxEnv
            ? false
            : (prev.skip_code_context as boolean | undefined);
        if (skipAiMockOverride) {
          // --no-mocks or --no-mocks-for ai: keep the original provider/timeout/tools,
          // only apply code-context overrides if requested.
          chk.ai = {
            ...prev,
            ...(skipCtx === undefined ? {} : { skip_code_context: skipCtx }),
          } as any;
        } else {
          chk.ai = {
            ...prev,
            provider: aiProviderDefault,
            ...(skipCtx === undefined ? {} : { skip_code_context: skipCtx }),
            disable_tools: true,
            timeout: Math.min(15000, (prev.timeout as number) || 15000),
          } as any;
        }
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
    let __suiteRel = testsPath;
    const noMocksMode = options.noMocks || false;
    const noMocksForTypes = options.noMocksFor;
    try {
      __suiteRel = path.relative(this.cwd, testsPath) || testsPath;
      console.log(`Suite: ${__suiteRel}`);
      if (noMocksMode) {
        console.log(
          this.color('🔴 NO-MOCKS MODE: Running with real providers (no mock injection)', '33')
        );
        console.log(this.gray('   Step outputs will be captured and printed as suggested mocks'));
        if (process.env.VISOR_TELEMETRY_ENABLED === 'true') {
          const traceDir = process.env.VISOR_TRACE_DIR || 'output/traces';
          console.log(this.gray(`   Tracing enabled → ${traceDir}`));
        }
        console.log();
      } else if (noMocksForTypes && noMocksForTypes.length > 0) {
        console.log(
          this.color(
            `🟡 PARTIAL-MOCK MODE: Real providers for: ${noMocksForTypes.join(', ')}`,
            '33'
          )
        );
        console.log(this.gray('   Other provider types will still use mocks\n'));
      }
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
        caseResults.push({ name: _case.name, passed: true, /* annotate skip */ errors: [] as any });
        return { name: _case.name, failed: 0 };
      }
      const reqResult = checkRequirements((_case as any).requires);
      if (!reqResult.met) {
        console.log(`⏭ SKIP ${(_case as any).name} (${reqResult.reason})`);
        caseResults.push({ name: _case.name, passed: true, errors: [] as any });
        return { name: _case.name, failed: 0 };
      }
      if (Array.isArray((_case as any).flow) && (_case as any).flow.length > 0) {
        const flowRes = await this.runFlowCase(
          _case,
          cfg,
          defaultStrict,
          options.bail || false,
          defaultPromptCap,
          stageFilter,
          noMocksMode
        );
        const failed = flowRes.failures;
        caseResults.push({ name: _case.name, passed: failed === 0, stages: flowRes.stages });
        return { name: _case.name, failed };
      }
      // Per-case AI override: include code context when requested
      const suiteDefaults: any = (this as any).suiteDefaults || {};
      const includeCodeContext =
        (typeof (_case as any).ai_include_code_context === 'boolean'
          ? (_case as any).ai_include_code_context
          : false) || suiteDefaults.ai_include_code_context === true;
      const cfgLocal = JSON.parse(JSON.stringify(cfg));
      // Respect suite-level frontends (e.g., ['github'])
      try {
        const fns = (suiteDefaults.frontends || undefined) as unknown;
        if (Array.isArray(fns) && fns.length > 0) {
          const norm = (fns as any[]).map(x => (typeof x === 'string' ? { name: x } : x));
          (cfgLocal as any).frontends = norm;
        }
      } catch {}
      for (const name of Object.keys(cfgLocal.checks || {})) {
        const chk = cfgLocal.checks[name] || {};
        if ((chk.type || 'ai') === 'ai') {
          const prev = (chk.ai || {}) as Record<string, unknown>;
          chk.ai = {
            ...prev,
            skip_code_context: includeCodeContext ? false : true,
          } as any;
          cfgLocal.checks[name] = chk;
        }
      }
      // Workflow testing: inject workflow_input into config for template access
      const workflowInput = (_case as any).workflow_input;
      if (workflowInput && typeof workflowInput === 'object') {
        (cfgLocal as any).workflow_inputs = workflowInput;
      }
      const setup = this.setupTestCase(
        _case,
        cfgLocal,
        defaultStrict,
        defaultPromptCap,
        ghRec,
        defaultIncludeTags,
        defaultExcludeTags,
        noMocksMode,
        noMocksForTypes
      );
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
        const exec = await this.executeTestCase(setup, cfgLocal);
        const res = exec.res;

        // In no-mocks or partial-mock mode, print executed steps and captured outputs
        const showRealOutputs = noMocksMode || (noMocksForTypes && noMocksForTypes.length > 0);
        if (showRealOutputs && Object.keys(exec.outHistory).length > 0) {
          // Filter to only unmocked steps in partial mode
          const unmockedStepFilter = noMocksMode
            ? undefined
            : (step: string) => {
                // Check if this step's provider type is in the noMocksFor list
                const chk = (cfgLocal.checks || {})[step];
                if (!chk) return false;
                const t = chk.type || 'ai';
                return noMocksForTypes!.includes(t);
              };
          // Print executed steps (including nested dotted-path steps from sub-workflows)
          const allStepNames = Object.keys(exec.outHistory).sort();
          console.log(this.color('\n📌 Executed steps:', '36'));
          for (const stepName of allStepNames) {
            const count = (exec.outHistory[stepName] || []).length;
            const depth = stepName.split('.').length - 1;
            const indent = '  '.repeat(depth + 1);
            const label = depth > 0 ? this.gray(`${indent}↳ ${stepName}`) : `  ${stepName}`;
            console.log(`${label}  ${this.gray(`(${count}x)`)}`);
          }
          const unmockedLabel = unmockedStepFilter
            ? `Suggested mocks for unmocked ${noMocksForTypes!.join('/')} steps:`
            : 'Suggested mocks (copy to your test case):';
          console.log(this.color(`\n📋 ${unmockedLabel}`, '36'));
          console.log(this.gray('mocks:'));
          for (const [stepName, outputs] of Object.entries(exec.outHistory)) {
            if (!Array.isArray(outputs) || outputs.length === 0) continue;
            // In partial mode, only show outputs for unmocked provider types
            if (unmockedStepFilter && !unmockedStepFilter(stepName)) continue;
            // Use the last output for the step
            const lastOutput = outputs[outputs.length - 1];
            // Format as YAML with proper indentation
            const yamlOutput = yaml.dump(
              { [stepName]: lastOutput },
              { indent: 2, lineWidth: 120, noRefs: true }
            );
            // Indent the YAML output for proper nesting under 'mocks:'
            const indented = yamlOutput
              .split('\n')
              .map(line => '  ' + line)
              .join('\n');
            console.log(indented);
          }
          console.log('');

          // Show diff between existing mocks and real outputs to highlight API drift
          const existingMocks =
            typeof (_case as any).mocks === 'object' && (_case as any).mocks
              ? ((_case as any).mocks as Record<string, unknown>)
              : {};
          if (Object.keys(existingMocks).length > 0) {
            const driftEntries: Array<{
              step: string;
              kind: 'changed' | 'added' | 'removed';
              detail: string;
            }> = [];
            for (const [stepName, outputs] of Object.entries(exec.outHistory)) {
              if (!Array.isArray(outputs) || outputs.length === 0) continue;
              const realOutput = outputs[outputs.length - 1];
              const mockValue = existingMocks[stepName];
              if (mockValue === undefined) {
                // New step not in existing mocks
                driftEntries.push({ step: stepName, kind: 'added', detail: 'new step (no mock)' });
              } else {
                // Compare mock vs real output
                const diffs = this.diffObjects(mockValue, realOutput, '');
                if (diffs.length > 0) {
                  for (const d of diffs) {
                    driftEntries.push({ step: stepName, kind: 'changed', detail: d });
                  }
                }
              }
            }
            // Check for mocked steps that didn't execute
            for (const mockStep of Object.keys(existingMocks)) {
              if (!exec.outHistory[mockStep] || (exec.outHistory[mockStep] as any[]).length === 0) {
                driftEntries.push({
                  step: mockStep,
                  kind: 'removed',
                  detail: 'mock exists but step did not execute',
                });
              }
            }
            if (driftEntries.length > 0) {
              console.log(this.color('🔄 API drift (mock vs real output):', '33'));
              for (const d of driftEntries) {
                const icon = d.kind === 'added' ? '+' : d.kind === 'removed' ? '-' : '~';
                const colorCode = d.kind === 'added' ? '32' : d.kind === 'removed' ? '31' : '33';
                console.log(this.color(`  ${icon} ${d.step}: ${d.detail}`, colorCode));
              }
              console.log('');
            } else {
              console.log(this.color('✅ No API drift detected (mocks match real outputs)', '32'));
              console.log('');
            }
          }
        }

        if (process.env.VISOR_DEBUG === 'true') {
          try {
            const names = (res.statistics.checks || []).map(
              (c: any) => `${c.checkName}:${c.totalRuns || 0}`
            );
            console.log(`  ⮕ main stats: [${names.join(', ')}]`);
          } catch {}
        }
        // avoid printing raw history keys each case
        // (fallback for on_finish static targets handled inside executeTestCase)
        // Workflow testing: compute workflow outputs if workflow has outputs defined
        let workflowOutputs: Record<string, unknown> | undefined;
        if (Array.isArray((cfgLocal as any).outputs) && (cfgLocal as any).outputs.length > 0) {
          try {
            workflowOutputs = this.computeWorkflowOutputs(
              (cfgLocal as any).outputs,
              exec.outHistory,
              res.results
            );
          } catch (e) {
            if (process.env.VISOR_DEBUG === 'true') {
              console.log(`  ⚠️ Error computing workflow outputs: ${e}`);
            }
          }
        } else {
          // Auto-propagate step outputs when no explicit outputs defined
          // This mirrors the workflow-check-provider auto-propagation logic
          try {
            workflowOutputs = this.autoPropagateeWorkflowOutputs(exec.outHistory);
          } catch (e) {
            if (process.env.VISOR_DEBUG === 'true') {
              console.log(`  ⚠️ Error auto-propagating workflow outputs: ${e}`);
            }
          }
        }
        const caseFailures = require('./evaluators').evaluateCase(
          _case.name,
          res.statistics,
          setup.recorder,
          setup.slackRecorder ? { calls: setup.slackRecorder.calls } : undefined,
          setup.expect,
          setup.strict,
          setup.prompts,
          res.results,
          exec.outHistory,
          workflowOutputs
        );
        // Warn about unmocked AI/command steps that executed
        try {
          const mocksUsed =
            typeof (_case as any).mocks === 'object' && (_case as any).mocks
              ? ((_case as any).mocks as Record<string, unknown>)
              : {};
          this.warnUnmockedProviders(res.statistics, cfgLocal, mocksUsed);
        } catch {}
        this.printCoverage(_case.name, res.statistics, setup.expect, exec.outHistory);
        if (caseFailures.length === 0) {
          console.log(
            `${(this as any).tagPass ? (this as any).tagPass() : '✅ PASS'} ${__suiteRel} › ${_case.name}`
          );
          caseResults.push({ name: _case.name, passed: true });
        } else {
          console.log(
            `${(this as any).tagFail ? (this as any).tagFail() : '❌ FAIL'} ${__suiteRel} › ${_case.name}`
          );
          for (const f of caseFailures) console.log(`   - ${f}`);
          caseResults.push({ name: _case.name, passed: false, errors: caseFailures });
          return { name: _case.name, failed: 1 };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`❌ ERROR ${_case.name}: ${msg}`);
        try {
          if (process.env.VISOR_DEBUG === 'true' && err && (err as any).stack) {
            console.error(`[stack] case ${_case.name}: ${(err as any).stack}`);
          }
        } catch {}
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
    // Summary (suppressible for embedded runs)
    const failedCases = caseResults.filter(r => !r.passed);
    const passedCases = caseResults.filter(r => r.passed);
    // Compute Jest-like test counts (cases and stages)
    let totalTests = 0;
    let failedTests = 0;
    let skippedTests = 0;
    for (const cr of caseResults) {
      const isFlow = Array.isArray(cr.stages);
      if (isFlow) {
        const stageCount = (cr.stages as any[]).length;
        totalTests += stageCount;
        failedTests += (cr.stages as any[]).filter(
          s => Array.isArray((s as any).errors) && (s as any).errors.length > 0
        ).length;
      } else {
        totalTests += 1;
        if (!cr.passed) failedTests += 1;
      }
      // Treat YAML-level skip as a skipped test
      // (we tagged skipped cases above by pushing an empty errors array)
      if (
        !isFlow &&
        Array.isArray((cr as any).errors) &&
        (cr as any).errors.length === 0 &&
        cr.passed
      ) {
        skippedTests += 1;
      }
    }
    {
      const silentSummary =
        String(process.env.VISOR_TEST_SUMMARY_SILENT || '')
          .toLowerCase()
          .trim() === 'true';
      if (!silentSummary) {
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
        const elapsed = ((Date.now() - __suiteStart) / 1000).toFixed(2);
        write('\n' + this.line('Summary'));
        // Jest-like header lines
        // Suites: we have a single suite here (the YAML file)
        const suitesPassed = failedCases.length === 0 ? 1 : 0;
        const suitesFailed = failedCases.length === 0 ? 0 : 1;
        write(`  Test Suites: ${suitesFailed} failed, ${suitesPassed} passed, ${1} total`);
        write(
          `  Tests:       ${skippedTests} skipped, ${totalTests - failedTests - skippedTests} passed, ${failedTests} failed, ${totalTests} total`
        );
        write(`  Time:        ${elapsed}s`);
        // Keep a short preview of passes for convenience
        if (passedCases.length > 0) {
          const MAX_SHOW = Math.max(
            1,
            parseInt(String(process.env.VISOR_SUMMARY_SHOW_PASSED || '6'), 10) || 6
          );
          const names = passedCases.slice(0, MAX_SHOW).map(r => r.name);
          const more = passedCases.length - names.length;
          write(`   • Passed: ${names.join(', ')}${more > 0 ? ` … and ${more} more` : ''}`);
        }
        // Detailed failures with re-run hints (section header)
        write(`\n${this.line('Failures')}`);
        write(`  Failed: ${failedCases.length}/${selected.length}`);
        if (failedCases.length > 0) {
          const cross = this.color('✖', '31');
          const relFile = (p: string) => {
            try {
              return require('path').relative(process.cwd(), p) || p;
            } catch {
              return p;
            }
          };
          let raw: string | undefined;
          try {
            raw = fs.readFileSync(testsPath, 'utf8');
          } catch {}
          const findLine = (caseName: string, stageName?: string): number | undefined => {
            if (!raw) return undefined;
            const lines = raw.split(/\r?\n/);
            let caseLine: number | undefined;
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes('- name:') && lines[i].includes(caseName)) {
                caseLine = i + 1;
                break;
              }
            }
            if (!stageName) return caseLine;
            if (caseLine !== undefined) {
              for (let j = caseLine; j < lines.length; j++) {
                if (lines[j].includes('- name:') && lines[j].includes(stageName)) return j + 1;
              }
            }
            return caseLine;
          };
          for (const fc of failedCases) {
            if (Array.isArray(fc.stages) && fc.stages.length > 0) {
              const bad = fc.stages.filter(s => s.errors && s.errors.length > 0);
              for (const st of bad) {
                const stageNameOnly = String(st.name || '').includes('#')
                  ? String(st.name).split('#').pop()
                  : String(st.name);
                const label = `${fc.name}#${stageNameOnly}`;
                const ln = findLine(fc.name, stageNameOnly);
                write(`  ${cross} ${label}${ln ? ` (${relFile(testsPath)}:${ln})` : ''}`);
                for (const e of st.errors || []) write(`      • ${e}`);
              }
            }
            if (
              (!fc.stages || fc.stages.length === 0) &&
              Array.isArray(fc.errors) &&
              fc.errors.length > 0
            ) {
              const ln = findLine(fc.name);
              write(`  ${cross} ${fc.name}${ln ? ` (${relFile(testsPath)}:${ln})` : ''}`);
              for (const e of fc.errors) write(`      • ${e}`);
            }
          }
          try {
            const rel = relFile(testsPath);
            write(`
  Tip: Re-run a specific test: visor test --config ${rel} --only "CASE[#STAGE]"`);
          } catch {}
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
    stageFilter?: string,
    noMocks?: boolean
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
    const engine = new StateMachineExecutionEngine(undefined as any, recorder as unknown as any);
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
        // Clear in-memory store before each stage to avoid leakage across stages
        try {
          MemoryStore.resetInstance();
        } catch {}
        // Clear AI sessions before each stage to avoid leakage across stages
        try {
          SessionRegistry.getInstance().clearAllSessions();
        } catch {}
        // Prepare default tag filters for this flow (inherit suite defaults)
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
        const suiteDefaults: any = (this as any).suiteDefaults || {};
        const defaultIncludeTags = parseTags(suiteDefaults?.tags);
        const defaultExcludeTags = parseTags(suiteDefaults?.exclude_tags);
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
          this.warnUnmockedProviders.bind(this),
          defaultIncludeTags,
          defaultExcludeTags,
          (suiteDefaults.frontends || undefined) as any[],
          noMocks
        );
        const outcome = await stageRunner.run(stage, flowCase, strict);
        const expect = (stage as any).expect || {};
        if (outcome.stats) this.printCoverage(outcome.name, outcome.stats, expect);
        if (!outcome.errors) {
          const __suiteRel = (this as any).__suiteRel || 'tests';
          console.log(
            `${(this as any).tagPass ? (this as any).tagPass() : '✅ PASS'} ${__suiteRel} › ${outcome.name}`
          );
          stagesSummary.push({ name: outcome.name });
        } else {
          failures += 1;
          const __suiteRel = (this as any).__suiteRel || 'tests';
          console.log(
            `${(this as any).tagFail ? (this as any).tagFail() : '❌ FAIL'} ${__suiteRel} › ${outcome.name}`
          );
          for (const f of outcome.errors) console.log(`   - ${f}`);
          stagesSummary.push({ name: outcome.name, errors: outcome.errors });
          if (bail) break;
        }
      } catch (err) {
        failures += 1;
        const name = `${flowName}#${stage.name || `stage-${i + 1}`}`;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`❌ ERROR ${name}: ${msg}`);
        try {
          if (process.env.VISOR_DEBUG === 'true' && err && (err as any).stack) {
            console.error(`[stack] ${name}: ${(err as any).stack}`);
          }
        } catch {}
        stagesSummary.push({ name, errors: [err instanceof Error ? err.message : String(err)] });
        if (bail) break;
      }
    }
    if (!anyStageRan && stageFilter) {
      console.log(`⚠️  No stage matched filter '${stageFilter}' in flow '${flowName}'`);
    }
    if (failures === 0)
      console.log(`${(this as any).tagPass ? (this as any).tagPass() : '✅ PASS'} ${flowName}`);
    else
      console.log(
        `${(this as any).tagFail ? (this as any).tagFail() : '❌ FAIL'} ${flowName} (${failures} stage error${failures > 1 ? 's' : ''})`
      );
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
    stats: import('../types/execution').ExecutionStatistics,
    cfg: any,
    mocks: Record<string, unknown>
  ): void {
    try {
      const executed = stats.checks
        .filter(s => !s.skipped && (s.totalRuns || 0) > 0)
        .map(s => (s as any)?.checkName)
        .filter(name => typeof name === 'string' && name.trim().length > 0 && name !== 'undefined');
      for (const name of executed) {
        // Only consider configured checks for warnings
        if (!((cfg.checks || {}) as Record<string, unknown>)[name]) continue;
        const chk = (cfg.checks || {})[name] || {};
        const t = chk.type || 'ai';
        // Suppress warnings for AI steps explicitly running under the mock provider
        const aiProv = (chk.ai && (chk.ai as any).provider) || undefined;
        if (t === 'ai' && aiProv === 'mock') continue;
        const listKey = `${name}[]`;
        const hasList = Array.isArray((mocks as any)[listKey]);
        if ((t === 'ai' || t === 'command') && mocks[name] === undefined && !hasList) {
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
      const depTokens: any[] = Array.isArray(chk.depends_on)
        ? chk.depends_on
        : chk.depends_on
          ? [chk.depends_on]
          : [];
      const deps: string[] = depTokens.flatMap(d =>
        typeof d === 'string' && d.includes('|')
          ? d
              .split('|')
              .map(s => s.trim())
              .filter(Boolean)
          : [d]
      );
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
  /**
   * Compute a flat list of human-readable diffs between a mock value and a real output.
   * Walks objects recursively; reports added/removed/changed keys.
   */
  private diffObjects(mock: unknown, real: unknown, prefix: string, depth = 0): string[] {
    const safeStr = (v: unknown): string => {
      try {
        return JSON.stringify(v) ?? 'undefined';
      } catch {
        return '[unserializable]';
      }
    };
    const diffs: string[] = [];
    if (depth > 20) {
      diffs.push(`${prefix || '(root)'}: (max depth exceeded)`);
      return diffs;
    }
    if (mock === real) return diffs;
    if (mock === null || mock === undefined || real === null || real === undefined) {
      diffs.push(`${prefix || '(root)'}: ${safeStr(mock)} → ${safeStr(real)}`);
      return diffs;
    }
    if (typeof mock !== typeof real) {
      diffs.push(`${prefix || '(root)'}: type ${typeof mock} → ${typeof real}`);
      return diffs;
    }
    if (Array.isArray(mock) && Array.isArray(real)) {
      if (mock.length !== real.length) {
        diffs.push(`${prefix || '(root)'}: array length ${mock.length} → ${real.length}`);
      }
      const maxLen = Math.max(mock.length, real.length);
      for (let i = 0; i < maxLen; i++) {
        const p = prefix ? `${prefix}[${i}]` : `[${i}]`;
        if (i >= mock.length) {
          diffs.push(`${p}: (added) ${safeStr(real[i])}`);
        } else if (i >= real.length) {
          diffs.push(`${p}: (removed) ${safeStr(mock[i])}`);
        } else {
          diffs.push(...this.diffObjects(mock[i], real[i], p, depth + 1));
        }
      }
      return diffs;
    }
    if (typeof mock === 'object' && typeof real === 'object') {
      const mockObj = mock as Record<string, unknown>;
      const realObj = real as Record<string, unknown>;
      const allKeys = new Set([...Object.keys(mockObj), ...Object.keys(realObj)]);
      for (const key of allKeys) {
        const p = prefix ? `${prefix}.${key}` : key;
        if (!(key in mockObj)) {
          const val = safeStr(realObj[key]);
          diffs.push(`${p}: (added) ${val.length > 80 ? val.slice(0, 80) + '…' : val}`);
        } else if (!(key in realObj)) {
          diffs.push(`${p}: (removed from output)`);
        } else {
          diffs.push(...this.diffObjects(mockObj[key], realObj[key], p, depth + 1));
        }
      }
      return diffs;
    }
    // Primitive comparison
    if (mock !== real) {
      const m = safeStr(mock);
      const r = safeStr(real);
      diffs.push(`${prefix || '(root)'}: ${m} → ${r.length > 80 ? r.slice(0, 80) + '…' : r}`);
    }
    return diffs;
  }

  private printCoverage(
    label: string,
    stats: import('../types/execution').ExecutionStatistics,
    expect: ExpectBlock,
    outputHistory?: Record<string, unknown[]>
  ): void {
    const executed: Record<string, number> = {};
    for (const s of stats.checks) {
      const skipped = (s as any).skipped === true || !!(s as any).skipReason;
      if (!skipped && (s.totalRuns || 0) > 0) executed[s.checkName] = s.totalRuns || 0;
    }
    // Include nested step counts from outputHistory (dotted-path steps from sub-workflows)
    if (outputHistory) {
      for (const key of Object.keys(outputHistory)) {
        if (key.includes('.') && !(key in executed)) {
          const hist = outputHistory[key];
          if (Array.isArray(hist) && hist.length > 0) {
            executed[key] = hist.length;
          }
        }
      }
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

// Helper: locate a child key line number inside a parent mapping in YAML (1-based)
function findKeyLineInParent(yamlSrc: string, parentKey: string, childKey: string): number | null {
  try {
    const lines = yamlSrc.split(/\r?\n/);
    let parentLine = -1;
    let parentIndent = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*)\b([A-Za-z0-9_-]+)\s*:\s*$/);
      if (m && m[2] === parentKey) {
        parentLine = i;
        parentIndent = m[1].length;
        break;
      }
    }
    if (parentLine < 0) return null;
    // Scan forward until indentation drops back to parentIndent or end
    for (let i = parentLine + 1; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/^(\s*)/);
      const indent = m ? m[1].length : 0;
      if (indent <= parentIndent && line.trim().length > 0) break;
      const km = line.match(new RegExp(`^\\s{${parentIndent + 2},}(${childKey})\\s*:`));
      if (km) return i + 1; // 1-based
    }
    return null;
  } catch {
    return null;
  }
}
export async function discoverAndPrint(options: DiscoverOptions = {}): Promise<void> {
  const cwd = options.cwd || process.cwd();
  if (
    options.testsPath &&
    (isDir(path.resolve(cwd, options.testsPath)) || /[?*]/.test(options.testsPath))
  ) {
    const files = discoverSuites(options.testsPath, cwd);
    console.log(`Discovered ${files.length} suite(s):`);
    for (const f of files) console.log(' - ' + path.relative(cwd, f));
    console.log(
      '\nTip: run `visor test <folder>` to execute all, or `visor test --config <file>` for one.'
    );
    return;
  }
  const runner = new VisorTestRunner(cwd);
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
