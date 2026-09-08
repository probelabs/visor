import { describe, expect, it, jest } from '@jest/globals';

// The integration boundary must exercise the real child-process transport.
jest.unmock('child_process');
jest.unmock('node:child_process');

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson, sha256Canonical } from '../../src/state-machine/graph/claim-kernel';
import { canonicalGraphCheckpointJson, ExecutionJournal } from '../../src/snapshot-store';
import { compileClaimPlan } from '../../src/state-machine/graph/claim-plan';
import {
  buildNativeChecklistProgressFromProjections,
  renderNativeChecklistProgress,
} from '../../examples/agent-governance/native-onboarding/native-checklist-progress';

type Json = Record<string, any>;
type CommandResult = { status: number; stdout: string; stderr: string };
type ProofRunner = (proof: string, subject: string, output: string, phase: string, args: string[], timeout: number, input?: string) => CommandResult;

const PROFILE = 'luna-xhigh-readonly-v1';
const ROOT = path.resolve(__dirname, '../..');
const RUNNER = path.join(ROOT, 'examples/agent-governance/native-onboarding/run-onboarding.ts');
const SNAPSHOT = 'proof.checklist.snapshot@1';
const RESEARCH_SNAPSHOT = 'proof.checklist.research-snapshot@1';
const SKELETON_SNAPSHOT = 'proof.checklist.skeleton-snapshot@1';
const BASELINE = 'native.initialized.baseline@1';
const AUTHOR = 'author-native-component';
const COMPONENT = 'component-1';

const configuredProof = process.env.PROOF_BIN || '';
const proofReady = (() => {
  try {
    const stat = fs.statSync(configuredProof);
    return path.isAbsolute(configuredProof) && stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
})();
if (configuredProof && !proofReady) {
  throw new Error(`PROOF_BIN is configured but is not an executable file: ${configuredProof}`);
}

const evidenceRequired = process.env.VISOR_EXP0208_EVIDENCE === 'required';
const describeNative = configuredProof || evidenceRequired ? describe : describe.skip;

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertDisposableCwd(cwd: string, sourceRoot: string, originalRoot?: string): void {
  const resolved = fs.realpathSync(cwd);
  const resolvedSourceRoot = fs.realpathSync(sourceRoot);
  const resolvedOriginalRoot = originalRoot ? fs.realpathSync(originalRoot) : undefined;
  if (!path.isAbsolute(cwd) || resolved !== path.resolve(cwd)) throw new Error(`Proof cwd is not a canonical absolute directory: ${cwd}`);
  if (inside(resolved, resolvedSourceRoot)) throw new Error(`refusing Proof command inside source worktree: ${resolved}`);
  if (resolvedOriginalRoot && inside(resolved, resolvedOriginalRoot)) throw new Error(`refusing Proof command inside protected original: ${resolved}`);
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr || '')}`);
  return String(result.stdout || '').trim();
}

function gitStatus(cwd: string): string {
  return git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
}

function sourceGuard(sourceRoot: string): Json {
  const fingerprintTree = (relativeRoot: string): string | null => {
    const root = path.join(sourceRoot, relativeRoot);
    if (!fs.existsSync(root)) return null;
    const rows: string[] = [];
    const visit = (absolute: string, relative: string): void => {
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(absolute).sort()) visit(path.join(absolute, name), path.join(relative, name));
      } else if (stat.isSymbolicLink()) {
        rows.push(`${relative}\0symlink\0${fs.readlinkSync(absolute)}`);
      } else if (stat.isFile()) {
        rows.push(`${relative}\0file\0${createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}`);
      }
    };
    visit(root, relativeRoot);
    return createHash('sha256').update(rows.join('\n'), 'utf8').digest('hex');
  };
  return {
    status: git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all', '--', '.gitignore', 'proof.yaml', 'proof', 'specs']),
    gitignore: fs.existsSync(path.join(sourceRoot, '.gitignore')) ? fs.readFileSync(path.join(sourceRoot, '.gitignore'), 'utf8') : null,
    proofYaml: fs.existsSync(path.join(sourceRoot, 'proof.yaml')) ? fs.readFileSync(path.join(sourceRoot, 'proof.yaml'), 'utf8') : null,
    proofRuntimeFingerprint: fingerprintTree('.proof'),
  };
}

function proofIdentity(proof: string): Json {
  const real = fs.realpathSync(proof);
  const stat = fs.statSync(real);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error(`PROOF_BIN is not executable: ${proof}`);
  return { path: real, sha256: createHash('sha256').update(fs.readFileSync(real)).digest('hex') };
}

function proofJson(runCommand: ProofRunner, proof: string, cwd: string, args: string[], label: string, output: string): Json {
  assertDisposableCwd(cwd, ROOT);
  const result = runCommand(proof, cwd, output, label, args, 180_000);
  if (result.status !== 0) throw new Error(`Proof ${label} failed with exit ${result.status}: ${result.stderr || result.stdout}`);
  try {
    const value = JSON.parse(result.stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value as Json;
  } catch (error) {
    throw new Error(`Proof ${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function createFixture(fixtureRoot: string): { subject: string; original: string; head: string } {
  const subject = path.join(fixtureRoot, 'subject');
  const original = path.join(fixtureRoot, 'original');
  fs.mkdirSync(subject, { recursive: true });
  git(subject, ['init', '--quiet']);
  git(subject, ['config', 'user.name', 'visor first slice fixture']);
  git(subject, ['config', 'user.email', 'visor-first-slice@example.invalid']);
  fs.writeFileSync(path.join(subject, 'component.go'), 'package fixture\n\nfunc Value() int { return 1 }\n', 'utf8');
  git(subject, ['add', 'component.go']);
  git(subject, ['commit', '--quiet', '-m', 'first-slice fixture']);
  const head = git(subject, ['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error('fixture HEAD is not an immutable commit');
  const clone = spawnSync('git', ['clone', '--quiet', subject, original], { cwd: fixtureRoot, encoding: 'utf8' });
  if (clone.status !== 0) throw new Error(`git clone fixture failed: ${String(clone.stderr || '')}`);
  if (git(original, ['rev-parse', 'HEAD']) !== head) throw new Error('fixture original is not an exact clone of the subject baseline');
  return { subject, original, head };
}

function serializedError(error: unknown): Json {
  if (!(error instanceof Error)) return { value: String(error) };
  const value = error as Error & { cause?: unknown };
  return { name: error.name, message: error.message, stack: error.stack, ...(value.cause ? { cause: serializedError(value.cause) } : {}) };
}

function writeDiagnostics(fixtureRoot: string, error: unknown, evidence: Json): string {
  const file = path.join(fixtureRoot, 'first-runtime-error.json');
  fs.writeFileSync(file, JSON.stringify({ fixture: 'SYNTHETIC native onboarding checklist first slice', error: serializedError(error), evidence }, null, 2) + '\n', 'utf8');
  return file;
}

function writeDiagnosticJson(file: string, value: unknown): void {
  try {
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
  } catch (error) {
    fs.writeFileSync(file, JSON.stringify({ serialization_error: serializedError(error) }, null, 2) + '\n', 'utf8');
  }
}

function retainPartialEngineDiagnostics(
  fixtureRoot: string,
  engine: any,
  evidence: Json,
  checkCompletions: readonly Json[],
  runtimeLogs: readonly Json[],
): void {
  evidence.check_completions = checkCompletions;
  evidence.runtime_console = runtimeLogs;
  const directory = path.join(fixtureRoot, 'partial-engine');
  fs.mkdirSync(directory, { recursive: true });
  const checkpointPath = path.join(directory, 'checkpoint.json');
  const eventsPath = path.join(directory, 'runtime-events.json');
  const checksPath = path.join(directory, 'check-completions.json');
  const logsPath = path.join(directory, 'runtime-console.json');
  writeDiagnosticJson(checksPath, checkCompletions);
  writeDiagnosticJson(logsPath, runtimeLogs);
  evidence.partial_check_completions_path = checksPath;
  evidence.partial_runtime_console_path = logsPath;
  if (!engine) {
    evidence.partial_engine = { status: 'unavailable' };
    return;
  }
  try {
    const checkpoint = engine.exportGraphCheckpoint();
    writeDiagnosticJson(checkpointPath, checkpoint);
    evidence.partial_checkpoint_path = checkpointPath;
    evidence.partial_checkpoint_session_id = checkpoint.sessionId;
    evidence.partial_checkpoint_event_count = Array.isArray(checkpoint.events) ? checkpoint.events.length : undefined;
  } catch (error) {
    evidence.partial_checkpoint_error = serializedError(error);
  }
  try {
    const journal = engine._lastContext?.journal as ExecutionJournal | undefined;
    if (!journal) {
      evidence.partial_runtime_events = { status: 'unavailable' };
      return;
    }
    const events = journal.readRuntimeEvents();
    writeDiagnosticJson(eventsPath, events);
    evidence.partial_runtime_events_path = eventsPath;
    evidence.partial_runtime_event_count = events.length;
    evidence.partial_last_runtime_event = events.length > 0 ? events[events.length - 1] : undefined;
  } catch (error) {
    evidence.partial_runtime_events_error = serializedError(error);
  }
}

function issues(result: Json): Json[] {
  return Object.values(result.results || {}).flatMap((entries: any) => Array.isArray(entries) ? entries : []).flatMap((entry: any) => Array.isArray(entry.issues) ? entry.issues : []);
}

function activeClaims(claimProjection: Json): Json[] {
  const ids = new Set(Object.values(claimProjection.activeClaimIdsByRef || {}).filter((id): id is string => typeof id === 'string'));
  return Object.values(claimProjection.claims || {}).filter((claim: any) => ids.has(claim.claimId));
}

function activeInstanceClaims(instanceProjection: Json): Json[] {
  return Object.values(instanceProjection.claimsById || {}).filter((claim: any) => claim.active === true);
}

function candidateForRequest(request: any): Json {
  const context = request.context;
  const project = context?.project?.payload;
  const inventory = context?.current_inventory?.payload;
  const projectId = project?.project_id;
  const sortedPaths = inventory?.sorted_paths;
  if (typeof projectId !== 'string' || !Array.isArray(sortedPaths) || sortedPaths.length === 0 || sortedPaths.some((value: unknown) => typeof value !== 'string')) {
    throw new Error('focused project selector did not expose the authenticated post-init inventory');
  }
  const paths = [...sortedPaths] as string[];
  return {
    version: 'proof.component-catalog-candidate/v1',
    project_id: projectId,
    components: [{ id: COMPONENT, responsibility: 'synthetic first-slice component', owned_paths: paths, dependency_closure: paths }],
  };
}

function focusedRunnerFactory(governedResultDigest: (value: unknown) => string, canonical: (value: unknown) => string): (request: any) => any {
  return (request: any) => ({
    preview: () => ({ source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${'c'.repeat(64)}`, promptBytes: 0 }),
    answer: () => {
      const data = candidateForRequest(request);
      const bytes = canonical(data);
      const digest = 'a'.repeat(64);
      return {
        data,
        runtimeAttestation: {
          version: 'probe.governed-codex-attestation/v2', profileId: PROFILE,
          requested: { profileDigest: digest, cwdDigest: digest, probeToolsDigest: digest, model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never' },
          observed: { source: 'session_configured', model: 'gpt-5.6-luna', modelProviderId: 'openai', reasoningEffort: 'xhigh', approvalPolicy: 'never', cwdDigest: digest, permissionProfileDigest: digest, filesystem: 'restricted-read-root', network: 'restricted' },
          executionContext: { source: 'caller', invocationDigest: request.invocationDigest },
          dispatch: { source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${'c'.repeat(64)}`, promptBytes: 0 },
          evidence: { eventCount: 1 }, usage: { status: 'unavailable' },
        },
        resultIdentity: { version: 'probe.governed-result-identity/v1', source: 'probe-host-schema-valid-json', resultDigest: governedResultDigest(data), canonicalBytes: Buffer.byteLength(bytes, 'utf8') },
      };
    },
    cancel: () => undefined,
    close: () => undefined,
  });
}

function parseRequirementId(value: Json, label: string): string {
  if (typeof value.id !== 'string' || value.id.length === 0) throw new Error(`${label} did not return a requirement id`);
  return value.id;
}

function materializeSkeleton(proof: string, checkout: string, output: string, runCommand: ProofRunner): void {
  assertDisposableCwd(checkout, ROOT);
  const created: string[] = [];
  const runRequired = (args: string[], label: string): CommandResult => {
    const result = runCommand(proof, checkout, output, label, args, 180_000);
    if (result.status !== 0) throw new Error(`Proof ${label} failed with exit ${result.status}: ${result.stderr || result.stdout}`);
    return result;
  };
  const add = (spec: string, description: string): string => {
    const args = ['req', 'new', spec, '--component', COMPONENT, '--description', description, '--priority-level', 'major', '--format', 'json'];
    const value = proofJson(runCommand, proof, checkout, args, `author-${created.length + 1}-${path.basename(spec)}`, output);
    const id = parseRequirementId(value, spec);
    created.push(id);
    return id;
  };
  const stakeholder = add('specs/stakeholder', 'The first-slice component has an explicit stakeholder obligation.');
  runRequired([
    'req', 'edit', stakeholder,
    '--persona', 'A maintainer integrating the first-slice component.',
    '--story', 'As a maintainer, I need the component contract recorded so its implementation can be reviewed.',
    '--add-acceptance-criterion', 'When Value is called, the component returns the integer 1.',
  ], 'author-edit-stakeholder');
  const derived = proofJson(runCommand, proof, checkout, ['req', 'derive', stakeholder, '--auto', '--component', COMPONENT, '--format', 'json'], 'author-derive-system', output);
  if (!Array.isArray(derived.created_reqs) || derived.created_reqs.length !== 1) throw new Error('synthetic author derive did not create exactly one system requirement');
  const system = parseRequirementId(derived.created_reqs[0] as Json, 'author-derive-system');
  created.push(system);
  const software = add('specs/software', 'The first-slice component preserves its software behavior.');
  const integration = add('specs/integration', 'The first-slice component preserves its integration boundary.');
  for (const [id, target] of [[software, system], [integration, system]]) {
    const linked = proofJson(runCommand, proof, checkout, ['req', 'link', 'add', id, 'satisfies', target, '--format', 'json'], `author-link-${path.basename(id)}`, output);
    if (linked.relation !== 'satisfies' || linked.target !== target) throw new Error(`synthetic author link did not satisfy ${target}`);
  }
  fs.appendFileSync(path.join(checkout, 'component.go'), '\n// synthetic native author evidence; behavior unchanged\n', 'utf8');
  if (created.length !== 4) throw new Error('synthetic author did not create exactly four linked requirements');
}

function waitForChild(child: ChildProcess, parentPid: number, timeoutMs: number): Promise<{ pid: number; status: number; stdout: string; stderr: string }> {
  const pid = child.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid === parentPid) {
    try { child.kill('SIGTERM'); } catch { /* preserve the fail-closed PID error */ }
    throw new Error(`resume child did not create an independent process (pid=${String(pid)}, parent=${parentPid})`);
  }
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: { pid: number; status: number; stdout: string; stderr: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* retain the timeout diagnostics */ }
      finish({ pid, status: 1, stdout, stderr: `${stderr}\n[timeout after ${timeoutMs}ms]` });
    }, timeoutMs);
    child.stdout?.on('data', value => { stdout += value.toString(); });
    child.stderr?.on('data', value => { stderr += value.toString(); });
    child.once('error', error => {
      finish({ pid, status: 1, stdout, stderr: `${stderr}\n[child error ${serializedError(error).message}]` });
    });
    child.once('close', (code, signal) => {
      finish({ pid, status: typeof code === 'number' ? code : 1, stdout, stderr: `${stderr}${signal ? `\n[signal ${signal}]` : ''}` });
    });
  });
}

describeNative('native onboarding checklist first slice (real engine + Proof)', () => {
  jest.setTimeout(240_000);

  const test = configuredProof || evidenceRequired ? it : it.skip;
  test('observes running authoring, promotes one linked skeleton, and resumes in a new Node process', async () => {
    const proof = process.env.PROOF_BIN;
    if (!proof) throw new Error('PROOF_BIN is required when first-slice evidence is required');
    const identity = proofIdentity(proof);
    const expected = process.env.VISOR_EXP0208_EXPECTED_PROOF_SHA256;
    if (evidenceRequired && !expected) throw new Error('VISOR_EXP0208_EXPECTED_PROOF_SHA256 is required when evidence is required');
    if (evidenceRequired && identity.sha256 !== expected) throw new Error(`PROOF_BIN digest ${identity.sha256} does not match VISOR_EXP0208_EXPECTED_PROOF_SHA256`);

    const fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'visor-native-checklist-first-slice-')));
    const outputA = path.join(fixtureRoot, 'output-a');
    const outputB = path.join(fixtureRoot, 'output-b');
    const codexHome = path.join(fixtureRoot, 'codex-home');
    fs.mkdirSync(outputA, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "synthetic-no-model"\n', { encoding: 'utf8', mode: 0o600 });

    const sourceBefore = sourceGuard(ROOT);
    const originalCwd = process.cwd();
    const envKeys = ['PROOF_BIN', 'NATIVE_ONBOARDING_OUTPUT_DIR', 'NATIVE_ONBOARDING_REPO_ROOT', 'NATIVE_ONBOARDING_TS_NODE', 'TS_NODE_PROJECT', 'NATIVE_ONBOARDING_WORKTREE_ROOT', 'VISOR_WORKSPACE_MAIN_PROJECT', 'VISOR_ORIGINAL_WORKDIR', 'SUBJECT_BASELINE_REVISION', 'NATIVE_ONBOARDING_BASELINE_COMMIT', 'CODEX_HOME', 'REQUEST_TIMEOUT', 'USE_CODEX', 'DISABLE_FALLBACK', 'AUTO_FALLBACK', 'VISOR_DEBUG_AI_SESSIONS'];
    const previousEnv: Record<string, string | undefined> = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    const evidence: Json = {
      fixture: 'SYNTHETIC native onboarding checklist first slice; no live model or network',
      proof_identity: { ...identity, ...(expected ? { expected_sha256: expected } : {}) },
      output_a: outputA,
      output_b: outputB,
      parent_pid: process.pid,
    };
    let failed = false;
    let restoreProviders: (() => void) | undefined;
    let diagnosticEngine: any;
    const runtimeLogs: Json[] = [];
    const captureConsole = (method: 'error' | 'warn' | 'log' | 'info'): (() => void) => {
      const target = console as any;
      const original = target[method] as (...args: any[]) => void;
      target[method] = (...args: any[]) => {
        let line: string;
        try {
          line = args.map((value: unknown) => typeof value === 'string' ? value : JSON.stringify(value)).join(' ');
        } catch (error) {
          line = `[unserializable console argument: ${serializedError(error).message}]`;
        }
        runtimeLogs.push({ stream: method === 'error' || method === 'warn' ? 'stderr' : 'stdout', method, line });
        original.apply(console, args);
      };
      return () => { target[method] = original; };
    };
    const restoreConsole = [captureConsole('error'), captureConsole('warn'), captureConsole('log'), captureConsole('info')];
    const checkCompletions: Json[] = [];
    try {
      const fixture = createFixture(fixtureRoot);
      evidence.subject = { ...fixture, original_status_before: gitStatus(fixture.original), subject_status_before: gitStatus(fixture.subject) };
      const privateTsNode = fs.realpathSync(require.resolve('ts-node/register/transpile-only'));
      process.env.PROOF_BIN = proof;
      process.env.NATIVE_ONBOARDING_OUTPUT_DIR = outputA;
      process.env.NATIVE_ONBOARDING_REPO_ROOT = ROOT;
      process.env.NATIVE_ONBOARDING_TS_NODE = privateTsNode;
      process.env.TS_NODE_PROJECT = fs.realpathSync(path.join(ROOT, 'tsconfig.json'));
      process.env.NATIVE_ONBOARDING_WORKTREE_ROOT = path.join(outputA, 'worktrees');
      process.env.VISOR_WORKSPACE_MAIN_PROJECT = fixture.subject;
      process.env.VISOR_ORIGINAL_WORKDIR = fixture.original;
      process.env.SUBJECT_BASELINE_REVISION = fixture.head;
      process.env.CODEX_HOME = codexHome;
      process.env.REQUEST_TIMEOUT = '60000';
      process.env.USE_CODEX = 'true';
      process.env.DISABLE_FALLBACK = '1';
      process.env.AUTO_FALLBACK = '0';
      process.env.VISOR_DEBUG_AI_SESSIONS = 'false';
      fs.mkdirSync(process.env.NATIVE_ONBOARDING_WORKTREE_ROOT, { recursive: true });

      jest.resetModules();
      jest.doMock('child_process', () => jest.requireActual('child_process'));
      jest.doMock('node:child_process', () => jest.requireActual('node:child_process'));
      const [runner, sdk, child, governed, registryModule] = await Promise.all([
        import('../../examples/agent-governance/native-onboarding/run-onboarding'),
        import('../../src/sdk'),
        import('../../src/providers/proof-admission-cli-child'),
        import('../../src/providers/governed-proof-inspect-check-provider'),
        import('../../src/providers/check-provider-registry'),
      ]);
      const config = await sdk.loadConfig(runner.buildChecklistOnboardingConfig({} as any), { strict: true });
      const plan = compileClaimPlan(config);
      const registry = registryModule.CheckProviderRegistry.getInstance();
      const capability = child.createProofAdmissionCapability(proof);
      registry.bootstrapProofAdmission(capability);
      const providerMap = Object.getOwnPropertyDescriptor(registry as any, 'providers')?.value as Map<string, any> | undefined;
      if (!providerMap) throw new Error('focused provider map is unavailable');
      const originalProviders = [...providerMap.entries()];
      providerMap.set('governed-proof-inspect', governed.createGovernedProofInspectProviderForFocusedTest(
        focusedRunnerFactory(governed.governedResultDigest, canonicalJson), capability,
      ));
      restoreProviders = () => {
        providerMap.clear();
        for (const [key, value] of originalProviders) providerMap.set(key, value);
        registryModule.CheckProviderRegistry.clearInstance();
        restoreProviders = undefined;
      };

      const aiCalls: string[] = [];
      const hookErrors: string[] = [];
      const authorRunningDir = path.join(outputA, 'author-running');
      evidence.author_running = {
        json: path.join(authorRunningDir, 'progress.json'),
        text: path.join(authorRunningDir, 'progress.txt'),
        html: path.join(authorRunningDir, 'progress.html'),
      };
      const authorEvidence: Json = { synthetic: true, component_id: COMPONENT, unmapped_authored_requirements: [], repositoryMutated: true, commandsExecuted: true };
      const engine = new sdk.StateMachineExecutionEngine(fixture.subject);
      diagnosticEngine = engine;
      engine.setExecutionContext({
        hooks: {
          onCheckComplete: info => {
            checkCompletions.push({ checkId: info.checkId, result: info.result, checkConfig: info.checkConfig });
          },
          onPromptCaptured: info => {
            if (info.step !== AUTHOR) return;
            try {
              const journal = (engine as any)._lastContext?.journal as ExecutionJournal | undefined;
              if (!journal) throw new Error('running author hook has no live journal');
              runner.writeNativeChecklistProgress(authorRunningDir, journal.getClaimProjection(), engine.getInstanceProjection(), undefined);
            } catch (error) {
              hookErrors.push(error instanceof Error ? error.message : String(error));
            }
          },
          mockForStep: step => {
            if (step !== AUTHOR) return undefined;
            aiCalls.push(step);
            try {
              const running = JSON.parse(fs.readFileSync(path.join(authorRunningDir, 'progress.json'), 'utf8')) as Json;
              if (running.operational?.components?.running_count !== 1 || running.operational.components.items?.length !== 1 || running.operational.components.items[0].state !== 'running') {
                hookErrors.push(`running progress did not show one running component: ${JSON.stringify(running.operational)}`);
              }
              const projection = engine.getInstanceProjection() as any;
              const generation = Object.values(projection.generationsById).find((value: any) => value.checkId === AUTHOR && value.status === 'running') as any;
              if (!generation) throw new Error('author mock did not find the active running generation');
              const journal = (engine as any)._lastContext?.journal as ExecutionJournal;
              const execution = journal.getGeneratedExecution(generation.nodeGenerationId) as any;
              const checkout = execution.claims.checkout?.payload;
              const checkoutPath = checkout?.path;
              if (typeof checkoutPath !== 'string') throw new Error('author mock did not receive the exact checkout claim');
              assertDisposableCwd(checkoutPath, ROOT, fixture.original);
              materializeSkeleton(proof, checkoutPath, outputA, runner.runProof);
            } catch (error) {
              hookErrors.push(error instanceof Error ? error.message : String(error));
            }
            return { output: authorEvidence, content: 'synthetic test-only author evidence' };
          },
        },
      });

      let runA: any;
      const projectPrefixSnapshots: { result?: Json; checkpoint?: Json } = {};
      const previousCwd = process.cwd();
      try {
        process.chdir(fixture.subject);
        runA = await runner.executeChecklistOnboardingEngine(engine, config, 180_000, frontier => {
          fs.writeFileSync(path.join(outputA, 'project-frontier-checkpoint.json'), JSON.stringify(frontier.checkpoint, null, 2) + '\n', 'utf8');
        }, {
          pauseBeforeSkeleton: true,
          onProjectPrefix: ({ initialResult, checkpoint }) => {
            const projectPrefixResultSnapshot = JSON.parse(JSON.stringify(initialResult)) as Json;
            const projectPrefixCheckpointSnapshot = JSON.parse(canonicalGraphCheckpointJson(checkpoint)) as Json;
            projectPrefixSnapshots.result = projectPrefixResultSnapshot;
            projectPrefixSnapshots.checkpoint = projectPrefixCheckpointSnapshot;
            const prefixEvidence = {
              result_path: path.join(outputA, 'project-prefix-result.json'),
              checkpoint_path: path.join(outputA, 'project-prefix-checkpoint.json'),
              manifest_path: path.join(outputA, 'project-prefix-manifest.json'),
            };
            evidence.project_prefix = prefixEvidence;
            writeDiagnosticJson(prefixEvidence.result_path, projectPrefixResultSnapshot);
            fs.writeFileSync(prefixEvidence.checkpoint_path, canonicalGraphCheckpointJson(projectPrefixCheckpointSnapshot) + '\n', 'utf8');
            writeDiagnosticJson(prefixEvidence.manifest_path, {
              version: 'synthetic.native-onboarding.project-prefix/v1',
              result_path: prefixEvidence.result_path,
              checkpoint_path: prefixEvidence.checkpoint_path,
              checkpoint_session_id: projectPrefixCheckpointSnapshot.sessionId,
              checkpoint_event_count: Array.isArray(projectPrefixCheckpointSnapshot.events) ? projectPrefixCheckpointSnapshot.events.length : 0,
            });
          },
          onSkeletonFrontier: frontier => {
            fs.writeFileSync(path.join(outputA, 'checkpoint.json'), JSON.stringify(frontier.checkpoint, null, 2) + '\n', 'utf8');
            fs.writeFileSync(path.join(outputA, 'checklist-materialized-config.json'), canonicalJson(config) + '\n', 'utf8');
          },
        });
      } finally {
        process.chdir(previousCwd);
      }
      restoreProviders?.();

      const checkpointA = runA.checkpoint as Json;
      const projectionA = engine.getInstanceProjection() as any;
      const replayedA = engine.replayInstanceProjection() as any;
      const journalA = (engine as any)._lastContext?.journal as ExecutionJournal;
      if (!journalA) throw new Error('first slice engine did not retain a journal');
      const claimsA = journalA.getClaimProjection() as any;
      const progressA = runner.writeNativeChecklistProgress(outputA, claimsA, projectionA, checkpointA, { paused: true, resumed: false });
      const restoredA = ExecutionJournal.restoreGraphCheckpoint(plan, checkpointA as any);
      const restoredProgressA = buildNativeChecklistProgressFromProjections({ claimProjection: restoredA.getClaimProjection(), instanceProjection: restoredA.getInstanceProjection(), checkpoint: restoredA.exportGraphCheckpoint((checkpointA as any).sessionId), paused: true, resumed: false });
      expect(restoredProgressA).toEqual(progressA);
      expect(renderNativeChecklistProgress(restoredProgressA).json).toBe(renderNativeChecklistProgress(progressA).json);
      evidence.checkpoint_a = checkpointA;
      evidence.progress_a = progressA;
      evidence.ai_calls = aiCalls;
      evidence.hook_errors = hookErrors;
      evidence.first_result = runA.result;
      expect(hookErrors).toEqual([]);
      expect(aiCalls).toEqual([AUTHOR]);
      expect(projectionA).toEqual(replayedA);
      expect(runA.result.statistics.failedExecutions).toBe(0);
      expect(issues(runA.result)).toEqual([]);
      const authorRunning = evidence.author_running as Json;
      expect(fs.existsSync(authorRunning.json)).toBe(true);
      expect(fs.existsSync(authorRunning.text)).toBe(true);
      expect(fs.existsSync(authorRunning.html)).toBe(true);
      const authorRunningJson = JSON.parse(fs.readFileSync(authorRunning.json, 'utf8')) as Json;
      const authorRunningHtml = fs.readFileSync(authorRunning.html, 'utf8');
      const authorRunningEmbedded = authorRunningHtml.match(/<script type="application\/json" id="native-checklist-progress">([\s\S]*?)<\/script>/)?.[1];
      if (!authorRunningEmbedded) throw new Error('author running progress HTML did not contain the canonical JSON carrier');
      expect(JSON.parse(authorRunningEmbedded)).toEqual(authorRunningJson);
      const prefixEvidence = evidence.project_prefix as Json;
      expect(prefixEvidence).toBeDefined();
      expect(fs.existsSync(prefixEvidence.result_path)).toBe(true);
      expect(fs.existsSync(prefixEvidence.checkpoint_path)).toBe(true);
      expect(fs.existsSync(prefixEvidence.manifest_path)).toBe(true);
      const prefixResult = JSON.parse(fs.readFileSync(prefixEvidence.result_path, 'utf8')) as Json;
      const prefixCheckpointText = fs.readFileSync(prefixEvidence.checkpoint_path, 'utf8').trim();
      const prefixCheckpoint = JSON.parse(prefixCheckpointText) as Json;
      const prefixManifest = JSON.parse(fs.readFileSync(prefixEvidence.manifest_path, 'utf8')) as Json;
      expect(projectPrefixSnapshots.result).toBeDefined();
      expect(projectPrefixSnapshots.checkpoint).toBeDefined();
      expect(prefixResult).toEqual(projectPrefixSnapshots.result);
      expect(canonicalGraphCheckpointJson(prefixCheckpoint)).toBe(prefixCheckpointText);
      expect(prefixCheckpoint).toEqual(projectPrefixSnapshots.checkpoint);
      expect(prefixResult.statistics.failedExecutions).toBe(0);
      expect(issues(prefixResult)).toEqual([]);
      expect((prefixCheckpoint.events as Json[]).filter(event => event.type === 'AttemptStarted' && Array.isArray(event.scope) && event.scope.length > 1)).toHaveLength(0);
      expect((prefixCheckpoint.events as Json[]).some(event => event.checkId === AUTHOR)).toBe(false);
      expect(prefixManifest).toMatchObject({
        result_path: prefixEvidence.result_path,
        checkpoint_path: prefixEvidence.checkpoint_path,
        checkpoint_session_id: prefixCheckpoint.sessionId,
        checkpoint_event_count: prefixCheckpoint.events.length,
      });

      const activeA = activeClaims(claimsA);
      const activeInstanceA = activeInstanceClaims(projectionA);
      const baselineClaims = activeInstanceA.filter(claim => claim.claim === BASELINE && claim.producerCheckId === 'commit-initialized-baseline');
      expect(baselineClaims).toHaveLength(1);
      // Root ClaimProjection contains the bootstrap claim; expanded research
      // and skeleton outputs are owned by the InstanceProjection.
      expect(activeA.filter(claim => claim.claim === SNAPSHOT)).toHaveLength(1);
      expect(activeA.filter(claim => claim.claim === RESEARCH_SNAPSHOT || claim.claim === SKELETON_SNAPSHOT)).toHaveLength(0);
      expect(activeInstanceA.filter(claim => claim.claim === RESEARCH_SNAPSHOT)).toHaveLength(1);
      expect(activeInstanceA.filter(claim => claim.claim === SKELETON_SNAPSHOT)).toHaveLength(0);
      const baselinePayload = baselineClaims[0].payload;
      expect(baselineClaims[0].payloadFingerprint).toBe(sha256Canonical(baselinePayload));
      expect((baselinePayload as Json).baseline_commit).toMatch(/^[0-9a-f]{40,64}$/);
      const activeSkeleton = Object.values(projectionA.generationsById).filter((generation: any) => generation.status !== 'inactive' && generation.checkId === 'checklist-skeleton');
      expect(activeSkeleton).toHaveLength(1);
      expect((activeSkeleton[0] as any).status).toBe('ready');
      const completedAuthor = Object.values(projectionA.generationsById).filter((generation: any) => generation.checkId === AUTHOR && generation.status === 'completed');
      expect(completedAuthor).toHaveLength(1);
      expect(gitStatus(fixture.original)).toBe('');
      expect(git(fixture.original, ['rev-parse', 'HEAD'])).toBe(fixture.head);
      expect(fs.existsSync(path.join(outputA, 'checkpoint.json'))).toBe(true);
      expect(fs.existsSync(path.join(outputA, 'checklist-materialized-config.json'))).toBe(true);

      const checkpointPath = path.join(outputA, 'checkpoint.json');
      const configPath = path.join(outputA, 'checklist-materialized-config.json');
      const resumeArgs = ['-r', privateTsNode, RUNNER, '--subject-root', fixture.subject, '--original-root', fixture.original, '--output', outputB, '--proof-bin', proof, '--timeout', '180000', '--checklist-skeleton-resume', checkpointPath];
      const childEnv = { ...process.env, PROOF_BIN: proof, CODEX_HOME: codexHome, REQUEST_TIMEOUT: '60000', TS_NODE_PROJECT: fs.realpathSync(path.join(ROOT, 'tsconfig.json')), NATIVE_ONBOARDING_REPO_ROOT: ROOT, NATIVE_ONBOARDING_TS_NODE: privateTsNode };
      const realSpawn = jest.requireActual<typeof import('node:child_process')>('node:child_process').spawn;
      const resumeCommand: { pid: number | null; argv: string[]; cwd: string; status: string; stdout: string; stderr: string } = { pid: null, argv: [process.execPath, ...resumeArgs], cwd: fixtureRoot, status: 'starting', stdout: '', stderr: '' };
      evidence.resume = resumeCommand;
      let resumeChild: ChildProcess;
      try {
        resumeChild = realSpawn(process.execPath, resumeArgs, { cwd: fixtureRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
        resumeCommand.pid = resumeChild.pid ?? null;
      } catch (error) {
        resumeCommand.status = 'spawn_error';
        resumeCommand.stderr = serializedError(error).message;
        throw error;
      }
      const resume = await waitForChild(resumeChild, process.pid, 180_000);
      evidence.resume = { pid: resume.pid, argv: [process.execPath, ...resumeArgs], cwd: fixtureRoot, status: resume.status, stdout: resume.stdout, stderr: resume.stderr, config_path: configPath };
      expect(resume.pid).not.toBe(process.pid);
      expect(resume.status).toBe(0);

      const checkpointBPath = path.join(outputB, 'checkpoint.json');
      const resultBPath = path.join(outputB, 'visor-result.json');
      const progressBPath = path.join(outputB, 'progress.json');
      expect(fs.existsSync(checkpointBPath)).toBe(true);
      expect(fs.existsSync(resultBPath)).toBe(true);
      expect(fs.existsSync(progressBPath)).toBe(true);
      const checkpointB = JSON.parse(fs.readFileSync(checkpointBPath, 'utf8')) as Json;
      const eventsA = checkpointA.events as Json[];
      const eventsB = checkpointB.events as Json[];
      expect(eventsB.slice(0, eventsA.length)).toEqual(eventsA);
      const suffix = eventsB.slice(eventsA.length);
      expect(suffix.length).toBeGreaterThan(0);
      expect(suffix.some(event => event.checkId === AUTHOR || event.type === 'ManagedRunStarted' || event.type === 'ManagedRunCompleted')).toBe(false);
      expect(suffix.filter(event => event.type === 'AttemptStarted').map(event => event.checkId)).toEqual(['checklist-skeleton']);
      const attemptCount = (events: Json[], checkId: string): number => events.filter(event => event.type === 'AttemptStarted' && event.checkId === checkId).length;
      for (const checkId of ['checklist-bootstrap', 'checklist-research', AUTHOR, 'promote-native-component']) {
        expect(attemptCount(eventsB, checkId)).toBe(attemptCount(eventsA, checkId));
      }
      const progressB = JSON.parse(fs.readFileSync(progressBPath, 'utf8')) as Json;
      const htmlB = fs.readFileSync(path.join(outputB, 'progress.html'), 'utf8');
      const embedded = htmlB.match(/<script type="application\/json" id="native-checklist-progress">([\s\S]*?)<\/script>/)?.[1];
      if (!embedded) throw new Error('resume progress HTML did not contain the canonical JSON carrier');
      const progressFromHtml = JSON.parse(embedded) as Json;
      expect(progressFromHtml).toEqual(progressB);
      expect(progressB.paused).toBe(false);
      expect(progressB.resumed).toBe(true);
      expect(progressB.checklist.steps.find((step: Json) => step.id === 'skeleton')).toMatchObject({ state: 'confirmed', verify_required: false });
      expect(progressB.checklist.steps.some((step: Json) => step.state === 'pending' || step.state === 'blocked')).toBe(true);
      expect(progressB.checklist.unresolved_count).toBeGreaterThan(0);
      const resultB = JSON.parse(fs.readFileSync(resultBPath, 'utf8')) as Json;
      expect(issues(resultB)).toEqual([]);
      const snapshotB = proofJson(runner.runProof, proof, fixture.subject, ['checklist', 'show', '--checklist', 'onboard_v1', '--format', 'json'], 'post-resume-checklist', outputB);
      const skeletonRow = (snapshotB.steps as Json[]).find(step => step.step_id === 'skeleton');
      expect(skeletonRow).toMatchObject({ effective_status: 'confirmed', stored_status: 'confirmed' });
      const requiredChecks = ['l0_stakeholder_complete', 'l1_system_complete', 'l2_software_complete', 'levels_connected'];
      expect(skeletonRow!.required_checks).toEqual(requiredChecks);
      const checkResults = skeletonRow!.check_results as Json[];
      expect(checkResults).toHaveLength(requiredChecks.length);
      expect(checkResults.map(result => result.id)).toEqual(requiredChecks);
      expect(checkResults.every(result => result.status === 'pass' && typeof result.at === 'string' && result.at.length > 0)).toBe(true);
      expect(skeletonRow!.verify_result).toBeUndefined();
      const finalChecklistCheck = runner.runProof(proof, fixture.subject, outputB, 'post-resume-checklist-check', ['checklist', 'check', '--checklist', 'onboard_v1'], 180_000);
      expect(finalChecklistCheck.status).not.toBe(0);
      evidence.checkpoint_b = checkpointB;
      evidence.progress_b = progressB;
      evidence.post_resume_checklist = snapshotB;
      expect(canonicalGraphCheckpointJson(ExecutionJournal.restoreGraphCheckpoint(plan, checkpointB as any).exportGraphCheckpoint((checkpointB as any).sessionId))).toBe(canonicalGraphCheckpointJson(checkpointB as any));
    } catch (error) {
      failed = true;
      retainPartialEngineDiagnostics(fixtureRoot, diagnosticEngine, evidence, checkCompletions, runtimeLogs);
      const diagnostics = writeDiagnostics(fixtureRoot, error, evidence);
      throw new Error(`${error instanceof Error ? error.message : String(error)} (exact first runtime error: ${diagnostics})`, { cause: error });
    } finally {
      restoreProviders?.();
      for (const restore of restoreConsole) restore();
      for (const key of envKeys) {
        const value = previousEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      try { process.chdir(originalCwd); } catch { /* preserve original failure */ }
      const sourceAfter = sourceGuard(ROOT);
      evidence.source_worktree = { before: sourceBefore, after: sourceAfter, cwd: process.cwd() };
      if (JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore) || process.cwd() !== originalCwd) {
        const guardError = new Error('first-slice fixture mutated the Visor source worktree or failed to restore cwd');
        if (!failed) writeDiagnostics(fixtureRoot, guardError, evidence);
        throw guardError;
      }
      if (evidenceRequired || failed) fs.writeFileSync(path.join(fixtureRoot, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
      else fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 240_000);
});
