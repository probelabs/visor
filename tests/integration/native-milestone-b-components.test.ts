import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

const configuredProof = process.env.PROOF_BIN ?? '';
let configuredProofValid = !configuredProof;
if (configuredProof) {
  try {
    const stat = fs.statSync(configuredProof);
    configuredProofValid = path.isAbsolute(configuredProof) && stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    configuredProofValid = false;
  }
}
if (!configuredProofValid) {
  throw new Error(`configured PROOF_BIN is not an executable: ${configuredProof}`);
}

const describeNative = configuredProof ? describe : describe.skip;
const ROOT = path.resolve(__dirname, '../..');
const RUNNER = path.join(ROOT, 'examples/agent-governance/native-onboarding/run-milestone-b.ts');
const PROFILE = path.join(ROOT, 'examples/agent-governance/native-onboarding/visor-milestone-b.yaml');

type ProofRow = {
  id: string;
  component: string;
  file_path: string;
};

type Fixture = {
  parent: string;
  subject: string;
  original: string;
  codexHome: string;
  output: string;
};

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || ''}`);
  return String(result.stdout || '').trim();
}

function proof(cwd: string, args: string[]): string {
  const verifiedRoot = fs.realpathSync(cwd);
  if (git(verifiedRoot, ['rev-parse', '--show-toplevel']) !== verifiedRoot) {
    throw new Error(`Proof fixture is not a Git root: ${verifiedRoot}`);
  }
  const result = spawnSync(configuredProof, args, {
    cwd: verifiedRoot,
    encoding: 'utf8',
    env: { ...process.env, PROOF_BIN: configuredProof },
  });
  if (result.status !== 0) throw new Error(`proof ${args.join(' ')} failed with exit ${result.status}: ${result.stderr || ''}`);
  return String(result.stdout || '');
}

function createFixture(componentCount: 1 | 2): Fixture {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-native-milestone-b-'));
  const subject = path.join(parent, 'subject');
  const original = path.join(parent, 'original');
  const codexHome = path.join(parent, 'codex-home');
  const output = path.join(parent, 'run');
  for (const directory of [subject, original, codexHome]) fs.mkdirSync(directory);

  for (const directory of [subject, original]) {
    git(directory, ['init', '--quiet']);
    git(directory, ['config', 'user.name', 'native-milestone-b-test']);
    git(directory, ['config', 'user.email', 'native-milestone-b@example.invalid']);
  }
  fs.writeFileSync(path.join(subject, 'go.mod'), 'module example.invalid/native-milestone-b\n\ngo 1.25\n', 'utf8');
  fs.writeFileSync(path.join(subject, 'core.go'), 'package milestone\n\nfunc Core() int { return 1 }\n', 'utf8');
  if (componentCount === 2) {
    fs.writeFileSync(path.join(subject, 'benchmark.go'), 'package milestone\n\nfunc Benchmark() int { return 2 }\n', 'utf8');
  }
  fs.writeFileSync(path.join(original, 'README.md'), 'protected original fixture\n', 'utf8');
  git(subject, ['add', '--all']);
  git(subject, ['commit', '--quiet', '-m', 'source fixture']);
  git(original, ['add', '--all']);
  git(original, ['commit', '--quiet', '-m', 'original fixture']);

  proof(subject, ['init', '--name', 'native-milestone-b', '--template', 'go-package', '--scope', '.', '--strict']);
  const components = ['jsonparser-core', ...(componentCount === 2 ? ['jsonparser-benchmark-suite'] : [])];
  for (const component of components) {
    const variable = component === 'jsonparser-core' ? 'core_state' : 'benchmark_state';
    const fretishSubject = component.replace(/-/g, '_');
    proof(subject, [
      'req', 'new', 'specs/system', '--component', component,
      '--fretish', `the ${fretishSubject} shall always satisfy ${variable} > 0`,
      '--variables', variable, '--format', 'json',
    ]);
    proof(subject, [
      'var', 'add', component, variable, '--type', 'int', '--direction', 'input',
      '--description', `${component} state`,
    ]);
  }
  git(subject, ['add', '--all']);
  git(subject, ['commit', '--quiet', '-m', 'native Proof baseline']);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5.6-luna"\n', 'utf8');
  return { parent, subject, original, codexHome, output };
}

function runnerEnv(fixture: Fixture): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['USE_CLAUDE_CODE', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'MODEL_NAME', 'MODEL', 'AI_PROVIDER']) {
    delete env[key];
  }
  return {
    ...env,
    NODE_ENV: 'test',
    VISOR_NATIVE_B_ZERO_MODEL_TEST: 'true',
    CODEX_HOME: fixture.codexHome,
    PROOF_BIN: configuredProof,
    TS_NODE_TRANSPILE_ONLY: '1',
  };
}

function runRunner(fixture: Fixture, mode: 'prepare' | 'pause' | 'resume', extraArgs: string[] = []): ReturnType<typeof spawnSync> {
  const result = spawnSync(process.execPath, [
    '-r', 'ts-node/register/transpile-only', RUNNER, mode,
    '--subject-root', fixture.subject,
    '--original-root', fixture.original,
    '--proof-bin', configuredProof,
    '--output', fixture.output,
    ...extraArgs,
  ], {
    cwd: ROOT,
    env: runnerEnv(fixture),
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${mode} failed with exit ${result.status}\nstdout:\n${result.stdout || ''}\nstderr:\n${result.stderr || ''}`);
  }
  return result;
}

function json<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function sha256(file: string): string {
  return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function attemptEventsForGeneration(checkpoint: any, generationIds: Set<string>): any[] {
  const events = Array.isArray(checkpoint?.events) ? checkpoint.events : [];
  return events.filter((event: any) => generationIds.has(event?.nodeGenerationId) && /^Attempt/.test(String(event?.type)));
}

function assertNativeItemClaims(checkpoint: any, rows: ProofRow[], fixture: Fixture): void {
  const events = Array.isArray(checkpoint?.events) ? checkpoint.events : [];
  const itemClaims = events.filter((event: any) =>
    event?.type === 'ControllerItemClaimPublished' && event?.claim === 'native.spec.item@1',
  );
  expect(itemClaims).toHaveLength(rows.length);
  for (const row of rows) {
    const matches = itemClaims.filter((event: any) => event?.payload?.id === row.id);
    expect(matches).toHaveLength(1);
    const event = matches[0];
    expect(event.payload).toMatchObject({
      id: row.id,
      component: row.component,
      file_path: row.file_path,
      proof_file_hash: sha256(path.join(fixture.subject, row.file_path)),
    });
    expect(event.scope).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'keyed',
        expansionOwnerCheck: 'discover-native-components',
        key: row.component,
      }),
      expect.objectContaining({
        kind: 'keyed',
        expansionOwnerCheck: '["native-component","enumerate-native-specs"]',
        key: row.id,
      }),
    ]));
  }
}

function assertCandidatePackets(checkpoint: any, rows: ProofRow[], fixture: Fixture): void {
  const events = Array.isArray(checkpoint?.events) ? checkpoint.events : [];
  const packets = events.filter((event: any) =>
    event?.type === 'ClaimPublished' && event?.claim === 'native.review.candidate.packet@1',
  );
  expect(packets).toHaveLength(rows.length);
  for (const row of rows) {
    const matches = packets.filter((event: any) => event?.payload?.id === row.id);
    expect(matches).toHaveLength(1);
    const payload = matches[0].payload;
    expect(payload).toMatchObject({
      id: row.id,
      freshness: 'pending_component_fan_in',
      req_show: {
        file_path: row.file_path,
        requirement: {
          id: row.id,
          component: row.component,
          _computed: {
            file_hash: sha256(path.join(fixture.subject, row.file_path)),
          },
        },
      },
    });
    expect(matches[0].scope).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'keyed', key: row.component }),
      expect.objectContaining({ kind: 'keyed', key: row.id }),
    ]));
  }
}

function nativeCatalog(fixture: Fixture): { rows: ProofRow[]; summary: any } {
  const rows = json<ProofRow[]>(path.join(fixture.output, 'prepare', 'catalog.json'));
  const summary = json<any>(path.join(fixture.output, 'prepare', 'summary.json'));
  expect(rows).toHaveLength(summary.item_count);
  return { rows, summary };
}

function assertPreparedNativeSurface(fixture: Fixture, expectedComponents: string[]): ProofRow[] {
  const { rows, summary } = nativeCatalog(fixture);
  expect(summary.components.map((component: any) => component.id)).toEqual(expectedComponents);
  expect(summary.components.every((component: any) => component.items.length > 0)).toBe(true);
  expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
  const listed = JSON.parse(proof(fixture.subject, ['req', 'list', '--format', 'json'])) as ProofRow[];
  expect(listed.map(row => row.id).sort()).toEqual(rows.map(row => row.id).sort());
  for (const row of rows) {
    const shown = JSON.parse(proof(fixture.subject, ['req', 'show', row.id, '--with', 'file', '--format', 'json'])) as any;
    expect(shown.file_path).toBe(row.file_path);
    expect(shown.requirement.id).toBe(row.id);
    expect(shown.requirement.component).toBe(row.component);
    expect(shown.requirement._computed.file_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(shown.requirement._computed.file_hash).toBe(sha256(path.join(fixture.subject, row.file_path)));
    const prepared = json<any>(path.join(fixture.output, 'prepare', 'items', row.id, 'req-show.json'));
    expect(prepared.requirement._computed.file_hash).toBe(shown.requirement._computed.file_hash);
  }
  return rows;
}

function runFlow(componentCount: 1 | 2): void {
  const fixture = createFixture(componentCount);
  try {
    runRunner(fixture, 'prepare');
    const expectedComponents = componentCount === 2
      ? ['jsonparser-benchmark-suite', 'jsonparser-core']
      : ['jsonparser-core'];
    const rows = assertPreparedNativeSurface(fixture, expectedComponents);
    const held = rows.find(row => row.component === 'jsonparser-core');
    if (!held) throw new Error('fixture did not produce a core requirement to hold');

    runRunner(fixture, 'pause', ['--hold-id', held.id]);
    const pauseSummary = json<any>(path.join(fixture.output, 'paused', 'summary.json'));
    const pauseCheckpoint = json<any>(path.join(fixture.output, 'paused', 'checkpoint.json'));
    const pauseObservations = json<any[]>(path.join(fixture.output, 'paused', 'observations.json'));
    const pauseEvents = Array.isArray(pauseCheckpoint.events) ? pauseCheckpoint.events : [];
    expect(pauseSummary.held_scope).toBe(held.id);
    expect(pauseSummary.status).toBe('quiescent-ready-frontier');
    expect(pauseObservations.some(observation => observation.scope.some((part: any) => part.key === held.id))).toBe(true);
    expect(pauseObservations.some(observation => observation.check_id === 'review-native-item')).toBe(true);
    for (const row of rows) {
      const promptExists = fs.existsSync(path.join(fixture.output, 'diagnostic', 'zero-model-prompts', `${row.id}.txt`));
      expect(promptExists).toBe(row.id !== held.id);
    }
    assertNativeItemClaims(pauseCheckpoint, rows, fixture);
    const heldGenerationIds = new Set<string>(pauseSummary.held_generation_ids || []);
    expect(attemptEventsForGeneration(pauseCheckpoint, heldGenerationIds)).toHaveLength(0);
    if (componentCount === 2) {
      const sibling = rows.find(row => row.component === 'jsonparser-benchmark-suite');
      expect(sibling).toBeDefined();
      expect(pauseSummary.sibling_progressed).toBeGreaterThan(0);
      expect(pauseSummary.sibling_packet_completed).toBe(true);
      expect(pauseObservations.some(observation => observation.scope.some((part: any) => part.key === sibling!.id))).toBe(true);
      expect(pauseEvents.filter((event: any) => event.type === 'AttemptCompleted' && event.checkId === 'collect-proof-evidence' && event.scope?.some((part: any) => part.key === sibling!.id))).not.toHaveLength(0);
    }
    expect(pauseEvents.length).toBeGreaterThan(0);
    expect(pauseEvents.some((event: any) => event.type === 'AttemptCompleted')).toBe(true);
    const progressedRows = rows.filter(row => row.id !== held.id);
    assertCandidatePackets(pauseCheckpoint, progressedRows, fixture);

    runRunner(fixture, 'resume');
    const resumed = json<any>(path.join(fixture.output, 'resumed', 'checkpoint.json'));
    const resumedSummary = json<any>(path.join(fixture.output, 'resumed', 'summary.json'));
    const resumeObservations = json<any[]>(path.join(fixture.output, 'resumed', 'observations.json'));
    const resumedEvents = Array.isArray(resumed.events) ? resumed.events : [];
    assertNativeItemClaims(resumed, rows, fixture);
    assertCandidatePackets(resumed, rows, fixture);
    expect(resumedSummary.resume_pid_differs).toBe(true);
    expect(resumedEvents.slice(0, pauseEvents.length)).toEqual(pauseEvents);
    expect(resumedEvents.length).toBeGreaterThan(pauseEvents.length);
    expect(resumedEvents.slice(pauseEvents.length).some((event: any) => event.type === 'AttemptCompleted')).toBe(true);
    const resumedHeld = resumeObservations.filter(observation => observation.scope.some((part: any) => part.key === held.id));
    expect(resumedHeld.length).toBeGreaterThan(0);
    expect(resumedHeld.every(observation => observation.scope.some((part: any) => part.key === held.component))).toBe(true);
    expect(resumeObservations.some(observation => observation.check_id === 'wait-for-native-items')).toBe(true);
    const resumedEventsOnly = resumedEvents.slice(pauseEvents.length);
    const completedReviewIdsBeforeResume = new Set(
      pauseEvents
        .filter((event: any) => event.type === 'AttemptCompleted' && event.checkId === 'review-native-item' && event.nodeGenerationId)
        .map((event: any) => event.nodeGenerationId),
    );
    expect(resumedEventsOnly.filter((event: any) =>
      (event.type === 'AttemptStarted' || event.type === 'AttemptCompleted') &&
      event.checkId === 'review-native-item' && completedReviewIdsBeforeResume.has(event.nodeGenerationId),
    )).toHaveLength(0);
    const startedIds = new Set(resumedEventsOnly.filter((event: any) => event.type === 'AttemptStarted').map((event: any) => event.nodeGenerationId));
    const completedIds = new Set(resumedEventsOnly.filter((event: any) => event.type === 'AttemptCompleted').map((event: any) => event.nodeGenerationId));
    for (const id of startedIds) expect(completedIds).toContain(id);
    expect(resumedEvents.some((event: any) => event.type === 'AttemptFailed' || event.type === 'CheckErrored')).toBe(false);
  } finally {
    fs.rmSync(fixture.parent, { recursive: true, force: true });
  }
}

describe('native Milestone B profile wiring', () => {
  it('keeps the live reviewer governed and limits mock replacement to the explicit test branch', () => {
    const yaml = fs.readFileSync(PROFILE, 'utf8');
    const runner = fs.readFileSync(RUNNER, 'utf8');
    expect(yaml).toContain('codex_execution_profile: luna-xhigh-readonly-v1');
    expect(yaml).not.toMatch(/^\s+retry:/m);
    expect(yaml).not.toMatch(/^\s+fallback:/m);
    expect(runner).toContain('if (zeroModelTestEnabled())');
    expect(runner).toContain("provider: 'mock'");
    expect(runner).toContain("model: 'mock'");
    expect(runner).toContain("DISABLE_FALLBACK = '1'");
    expect(runner).toContain("AUTO_FALLBACK = '0'");
  });
});

describeNative('native Milestone B component/spec progression', () => {
  jest.setTimeout(240_000);

  it('discovers two natural native components, holds one spec, and resumes in a fresh process', () => {
    runFlow(2);
  });

  it('accepts a natural single-component catalog with the same runner path', () => {
    runFlow(1);
  });
});
