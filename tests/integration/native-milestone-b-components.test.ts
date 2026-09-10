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
const REVIEW_PROFILE = path.join(ROOT, 'examples/agent-governance/native-onboarding/visor-milestone-b-review-record.yaml');

type ProofRow = {
  id: string;
  component: string;
  file_path: string;
  priority_level?: string;
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
      '--variables', variable, '--priority-level', 'major', '--format', 'json',
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

function runnerEnv(fixture: Fixture, defaultAuth = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.JEST_WORKER_ID;
  for (const key of ['USE_CLAUDE_CODE', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'MODEL_NAME', 'MODEL', 'AI_PROVIDER']) {
    delete env[key];
  }
  const result = {
    ...env,
    NODE_ENV: 'test',
    VISOR_NATIVE_B_ZERO_MODEL_TEST: 'true',
    CODEX_HOME: fixture.codexHome,
    PROOF_BIN: configuredProof,
    TS_NODE_TRANSPILE_ONLY: '1',
    TS_NODE_PROJECT: path.join(ROOT, 'tsconfig.json'),
  };
  if (defaultAuth) delete result.CODEX_HOME;
  return result;
}

function runRunnerResult(
  fixture: Fixture,
  mode: 'prepare' | 'pause' | 'resume' | 'record-prepare' | 'record-pause' | 'record-resume' | 'record-recover',
  extraArgs: string[] = [],
  defaultAuth = false,
  output = fixture.output,
  envOverrides: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [
    '-r', 'ts-node/register/transpile-only', RUNNER, mode,
    '--subject-root', fixture.subject,
    '--original-root', fixture.original,
    '--proof-bin', configuredProof,
    '--output', output,
    ...extraArgs,
  ], {
    cwd: ROOT,
    env: {...runnerEnv(fixture, defaultAuth), ...envOverrides},
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function runRunner(
  fixture: Fixture,
  mode: 'prepare' | 'pause' | 'resume' | 'record-prepare' | 'record-pause' | 'record-resume' | 'record-recover',
  extraArgs: string[] = [],
  defaultAuth = false,
  output = fixture.output,
  envOverrides: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  const result = runRunnerResult(fixture, mode, extraArgs, defaultAuth, output, envOverrides);
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
    expect(event.payload.proof_snapshot.catalog_entry).toEqual(row);
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
      catalog_entry: row,
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
  expect(rows.every(row => row.priority_level === 'major')).toBe(true);
  expect(summary.preflight).toMatchObject({
    status: 'validated',
    component_ids: expectedComponents,
    item_ids: rows.map(row => row.id),
  });
  expect(summary.preflight.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(summary.preflight.graph_semantic_digest).toMatch(/^[0-9a-f]{64}$/);
  expect(summary.preflight.validator_counts['native.component.catalog@1']).toBe(1);
  expect(summary.preflight.validator_counts['native.component.item@1']).toBe(expectedComponents.length);
  expect(summary.preflight.validator_counts['native.spec.catalog@1']).toBe(expectedComponents.length);
  expect(summary.preflight.validator_counts['native.spec.item@1']).toBe(rows.length);
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

describe('native Milestone B focus argument policy', () => {
  it.each([
    ['unsorted', 'B,A', /sorted and unique/],
    ['duplicate', 'A,A', /sorted and unique/],
    ['empty entry', 'A,,B', /empty requirement IDs/],
    ['whitespace-bearing ID', 'A,not valid', /empty requirement IDs/],
  ])('rejects %s focus IDs before touching a subject', (_label, value, expected) => {
    const result = spawnSync(process.execPath, [
      '-r', 'ts-node/register/transpile-only', RUNNER, 'prepare', '--focus-ids', value,
    ], { cwd: ROOT, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout || ''}${result.stderr || ''}`).toMatch(expected);
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

  it('focuses one requested requirement while retaining and validating the full catalog', () => {
    const fixture = createFixture(2);
    try {
      const catalog = JSON.parse(proof(fixture.subject, ['req', 'list', '--format', 'json'])) as ProofRow[];
      const focusId = [...catalog.map(row => row.id)].sort()[0];
      const unselected = catalog.filter(row => row.id !== focusId);
      expect(focusId).toBeTruthy();
      expect(unselected.length).toBeGreaterThan(0);

      runRunner(fixture, 'prepare', ['--focus-ids', focusId]);
      const preparedCatalog = json<ProofRow[]>(path.join(fixture.output, 'prepare', 'catalog.json'));
      const preparedSummary = json<any>(path.join(fixture.output, 'prepare', 'summary.json'));
      expect(preparedCatalog.map(row => row.id).sort()).toEqual(catalog.map(row => row.id).sort());
      expect(preparedSummary).toMatchObject({
        catalog_item_count: catalog.length,
        item_count: 1,
        focus_ids: [focusId],
      });
      expect(preparedSummary.items.map((item: any) => item.id)).toEqual([focusId]);
      expect(fs.existsSync(path.join(fixture.output, 'prepare', 'items', focusId, 'req-show.json'))).toBe(true);
      for (const row of unselected) {
        expect(fs.existsSync(path.join(fixture.output, 'prepare', 'items', row.id, 'req-show.json'))).toBe(false);
      }

      runRunner(fixture, 'pause', ['--hold-id', focusId]);
      const paused = json<any>(path.join(fixture.output, 'paused', 'checkpoint.json'));
      assertNativeItemClaims(paused, [catalog.find(row => row.id === focusId)!], fixture);
      assertCandidatePackets(paused, [], fixture);
      const pausedIds = new Set(
        (paused.events || [])
          .filter((event: any) => event?.scope?.some((part: any) => part.key === focusId))
          .map((event: any) => event.scope.find((part: any) => part.key === focusId)?.key),
      );
      expect(pausedIds).toEqual(new Set([focusId]));

      runRunner(fixture, 'resume');
      const resumed = json<any>(path.join(fixture.output, 'resumed', 'checkpoint.json'));
      assertNativeItemClaims(resumed, [catalog.find(row => row.id === focusId)!], fixture);
      assertCandidatePackets(resumed, [catalog.find(row => row.id === focusId)!], fixture);
      expect((resumed.events || []).filter((event: any) =>
        event?.claim === 'native.spec.item@1' && event.payload?.id !== focusId,
      )).toHaveLength(0);
    } finally {
      fs.rmSync(fixture.parent, { recursive: true, force: true });
    }
  });

  it('accepts the pinned default-auth path without requiring CODEX_HOME', () => {
    const fixture = createFixture(1);
    const codexBin = process.execPath;
    const codexSha256 = sha256(codexBin);
    const runner = fs.readFileSync(RUNNER, 'utf8');
    expect(runner).toContain('engine.setExecutionContext(governedCodex);');
    const governedArgs = [
      '--governed-codex-transport', 'exec-jsonl-default-auth-v1',
      '--codex-bin', codexBin,
      '--codex-sha256', codexSha256,
    ];
    try {
      runRunner(fixture, 'prepare', governedArgs, true);
      const rows = nativeCatalog(fixture).rows;
      expect(rows).toHaveLength(1);
      const focusId = rows[0].id;

      const invalid = runRunnerResult(fixture, 'pause', [
        '--hold-id', focusId,
        '--governed-codex-transport', 'unsupported-transport',
      ], true);
      expect(invalid.status).not.toBe(0);
      expect(`${invalid.stdout || ''}${invalid.stderr || ''}`).toContain(
        '--governed-codex-transport must be exec-jsonl-default-auth-v1',
      );

      runRunner(fixture, 'pause', ['--hold-id', focusId, ...governedArgs], true);
      runRunner(fixture, 'resume', governedArgs, true);
    } finally {
      fs.rmSync(fixture.parent, { recursive: true, force: true });
    }
  });

  it('rejects an absent focus ID and a focused Proof hash change', () => {
    const absentFixture = createFixture(2);
    try {
      const catalog = JSON.parse(proof(absentFixture.subject, ['req', 'list', '--format', 'json'])) as ProofRow[];
      const existingIds = catalog.map(row => row.id).sort();
      const absentId = 'ZZZ-REQ-NOT-IN-CATALOG';
      const result = runRunnerResult(absentFixture, 'prepare', ['--focus-ids', [...existingIds, absentId].sort().join(',')]);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout || ''}${result.stderr || ''}`).toContain(`requested requirement ${absentId}`);
    } finally {
      fs.rmSync(absentFixture.parent, { recursive: true, force: true });
    }

    const hashFixture = createFixture(2);
    try {
      const catalog = JSON.parse(proof(hashFixture.subject, ['req', 'list', '--format', 'json'])) as ProofRow[];
      const focus = [...catalog.map(row => row.id)].sort()[0];
      runRunner(hashFixture, 'prepare', ['--focus-ids', focus]);
      const focused = catalog.find(row => row.id === focus);
      if (!focused) throw new Error(`fixture did not produce ${focus}`);
      fs.appendFileSync(path.join(hashFixture.subject, focused.file_path), '\n', 'utf8');
      const result = runRunnerResult(hashFixture, 'pause', ['--hold-id', focus]);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout || ''}${result.stderr || ''}`).toContain(`Proof input changed before pause for ${focus}`);
    } finally {
      fs.rmSync(hashFixture.parent, { recursive: true, force: true });
    }
  });

  it('reuses completed reader packets for per-item native review records with exact fresh resume', () => {
    const fixture = createFixture(2);
    const reviewOutput = path.join(fixture.parent, 'review-run');
    const reviewer = 'agent:luna-xhigh-native-spec-review';
    try {
      runRunner(fixture, 'prepare');
      const rows = nativeCatalog(fixture).rows;
      runRunner(fixture, 'pause', ['--hold-id', rows[0].id]);
      runRunner(fixture, 'resume');

      expect(fs.existsSync(REVIEW_PROFILE)).toBe(true);
      runRunner(fixture, 'record-prepare', [
        '--reader-output', fixture.output,
        '--reviewer', reviewer,
      ], false, reviewOutput);
      const reviewItems = json<any>(path.join(reviewOutput, 'review', 'items.json')).items;
      expect(reviewItems).toHaveLength(rows.length);
      expect(reviewItems.every((item: any) => item.reviewer === reviewer)).toBe(true);
      expect(reviewItems.every((item: any) => /^sha256:[0-9a-f]{64}$/.test(item.current_context_sha256))).toBe(true);
      expect(reviewItems.every((item: any) => item.lineage.candidate_claim_id && item.lineage.candidate_payload_fingerprint)).toBe(true);
      expect(reviewItems.every((item: any) =>
        item.parent_bindings.length > 0 &&
        item.parent_bindings.every((binding: any) =>
          binding.requirement_id && binding.file_path && /^sha256:[0-9a-f]{64}$/.test(binding.file_hash),
        ) && item.parent_bindings.some((binding: any) => binding.requirement_id === item.id),
      )).toBe(true);
      expect(JSON.stringify(reviewItems.map((item: any) => item.packet?.candidate))).not.toMatch(/401 Unauthorized|api\.openai\.com\/v1\/responses/);

      const reviewItemsPath = path.join(reviewOutput, 'review', 'items.json');
      const originalReviewItems = fs.readFileSync(reviewItemsPath, 'utf8');
      const tamperedContext = JSON.parse(originalReviewItems);
      tamperedContext.items[0].current_context = {
        ...tamperedContext.items[0].current_context,
        tampered_context_marker: 'must-fail-closed',
      };
      fs.writeFileSync(reviewItemsPath, JSON.stringify(tamperedContext), 'utf8');
      const contextTamper = runRunnerResult(fixture, 'record-pause', [
        '--reader-output', fixture.output,
        '--reviewer', reviewer,
        '--hold-id', rows[0].id,
      ], false, reviewOutput);
      expect(contextTamper.status).not.toBe(0);
      expect(`${contextTamper.stdout || ''}${contextTamper.stderr || ''}`).toContain('detached normalized Proof context');
      fs.writeFileSync(reviewItemsPath, originalReviewItems, 'utf8');

      const tamperedLineage = JSON.parse(originalReviewItems);
      tamperedLineage.items[0].lineage.packet_id = 'f'.repeat(64);
      fs.writeFileSync(reviewItemsPath, JSON.stringify(tamperedLineage), 'utf8');
      const lineageTamper = runRunnerResult(fixture, 'record-pause', [
        '--reader-output', fixture.output,
        '--reviewer', reviewer,
        '--hold-id', rows[0].id,
      ], false, reviewOutput);
      expect(lineageTamper.status).not.toBe(0);
      expect(`${lineageTamper.stdout || ''}${lineageTamper.stderr || ''}`).toContain('lineage field packet_id is detached');
      fs.writeFileSync(reviewItemsPath, originalReviewItems, 'utf8');

      runRunner(fixture, 'record-pause', [
        '--reader-output', fixture.output,
        '--reviewer', reviewer,
        '--hold-id', rows[0].id,
      ], false, reviewOutput);
      const paused = json<any>(path.join(reviewOutput, 'paused', 'checkpoint.json'));
      const pausedEvents = paused.events || [];
      const pausedSummary = json<any>(path.join(reviewOutput, 'paused', 'summary.json'));
      const adjudicationClaims = pausedEvents.filter((event: any) =>
        event.type === 'ClaimPublished' && event.claim === 'native.review.adjudication@1',
      );
      expect(adjudicationClaims).toHaveLength(rows.length);
      for (const event of adjudicationClaims) {
        expect(Object.keys(event.payload || {}).sort()).toEqual(['citations', 'comment', 'decision', 'reviewer']);
        expect(event.payload.reviewer).toBe('agent:model-echo');
      }
      expect(pausedSummary.held_scope).toBe('all-record-native-review');
      expect(pausedSummary.held_item_ids).toEqual(rows.map(row => row.id));
      expect(pausedSummary.pid).toBeGreaterThan(0);
      expect(pausedEvents.filter((event: any) => event.type === 'AttemptCompleted' && event.checkId === 'record-native-review')).toHaveLength(0);
      expect(pausedEvents.filter((event: any) => event.type === 'AttemptStarted' && event.checkId === 'record-native-review')).toHaveLength(0);
      const beforeRecords = JSON.parse(proof(fixture.subject, ['review', 'list', '--kind', 'spec_conformance', '--format', 'json'])) as any[];
      expect(beforeRecords).toHaveLength(0);

      // Exercise the real Graph failure window: the recorder writes its native
      // Proof record and then dies before emitting a command receipt. The
      // failed checkpoint is retried through the journal's explicit
      // safely-idempotent path, which must reuse the exact native tuple.
      const failedResume = runRunnerResult(fixture, 'record-resume', [
        '--reader-output', fixture.output,
        '--reviewer', reviewer,
      ], false, reviewOutput, { VISOR_NATIVE_B_CRASH_AFTER_NATIVE_WRITE: 'true' });
      expect(failedResume.status).not.toBe(0);
      const failedCheckpoint = json<any>(path.join(reviewOutput, 'resumed', 'failure-checkpoint.json'));
      const failedSummary = json<any>(path.join(reviewOutput, 'resumed', 'failure-summary.json'));
      expect(failedCheckpoint.events.slice(0, pausedEvents.length)).toEqual(pausedEvents);
      expect(failedCheckpoint.events.filter((event: any) => event.type === 'AttemptFailed' && event.checkId === 'record-native-review').length).toBeGreaterThan(0);
      expect(failedSummary.pid).toBeGreaterThan(0);
      expect(failedSummary.pid).not.toBe(pausedSummary.pid);
      expect(failedSummary.checkpoint_session_id).toBe(paused.sessionId);
      expect(failedSummary.graph_semantic_digest).toBe(paused.graphSemanticDigest);
      const crashedRecords = JSON.parse(proof(fixture.subject, ['review', 'list', '--kind', 'spec_conformance', '--format', 'json'])) as any[];
      const crashedRecordIds = crashedRecords.map(record => record.id).sort();
      expect(crashedRecords.length).toBe(rows.length);
      expect(new Set(crashedRecordIds).size).toBe(crashedRecords.length);

      runRunner(fixture, 'record-recover', [
        '--reader-output', fixture.output,
        '--reviewer', reviewer,
      ], false, reviewOutput);
      const recovered = json<any>(path.join(reviewOutput, 'recovered', 'checkpoint.json'));
      const recoveredSummary = json<any>(path.join(reviewOutput, 'recovered', 'summary.json'));
      const recoveredEvents = recovered.events || [];
      const retryPrefix = json<any>(path.join(reviewOutput, 'diagnostic', 'record-recover-retry-prefix.json'));
      const recoverySuffix = recoveredEvents.slice(retryPrefix.events.length);
      expect(retryPrefix.events.slice(0, failedCheckpoint.events.length)).toEqual(failedCheckpoint.events);
      expect(recoverySuffix.filter((event: any) => event.type === 'AttemptStarted' && event.checkId !== 'record-native-review')).toHaveLength(0);
      expect(recoverySuffix.filter((event: any) => event.type === 'AttemptStarted' && event.checkId === 'adjudicate-native-review')).toHaveLength(0);
      expect(recoverySuffix.filter((event: any) => event.type === 'AttemptCompleted' && event.checkId === 'record-native-review')).toHaveLength(rows.length);
      const records = JSON.parse(proof(fixture.subject, ['review', 'list', '--kind', 'spec_conformance', '--format', 'json'])) as any[];
      expect(records).toHaveLength(rows.length);
      expect(recoveredSummary.pid).toBeGreaterThan(0);
      expect(recoveredSummary.pid).not.toBe(failedSummary.pid);
      expect(recoveredSummary.checkpoint_session_id).toBe(paused.sessionId);
      expect(recoveredSummary.graph_semantic_digest).toBe(paused.graphSemanticDigest);
      expect(records.map(record => record.id).sort()).toEqual(crashedRecordIds);
      expect(records.every(record => record.kind === 'spec_conformance' && record.reviewer === reviewer && record.decision === 'needs_changes')).toBe(true);
    } finally {
      fs.rmSync(fixture.parent, { recursive: true, force: true });
    }
  });
});
