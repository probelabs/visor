/**
 * Small Milestone B harness.  `prepare` is zero-model and reads the current
 * Proof catalog.  `pause` and `resume` use the existing Graph-v2 SDK journal;
 * they do not introduce a second checkpoint or scheduling protocol.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadConfig, StateMachineExecutionEngine } from '../../../src/sdk';
import { CheckProviderRegistry } from '../../../src/providers/check-provider-registry';
import { ExecutionJournal } from '../../../src/snapshot-store';
import { compileClaimPlan } from '../../../src/state-machine/graph/claim-plan';
import type { PRInfo } from '../../../src/pr-analyzer';
import type { GeneratedDispatchGate } from '../../../src/types/engine';

type Json = Record<string, unknown>;
type ProofRow = { id: string; component?: string; file_path?: string } & Json;
type CommandResult = { status: number; stdout: string; stderr: string };

const CONFIG_PATH = path.resolve(__dirname, 'visor-milestone-b.yaml');

const prInfo: PRInfo = {
  number: 0,
  title: 'native Proof Milestone B review slice',
  body: '',
  author: 'native-onboarding-runner',
  base: 'main',
  head: 'subject',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  eventType: 'manual',
};

function parseArgs(argv: string[]): { mode: string; values: Record<string, string> } {
  const mode = argv[0] || 'prepare';
  const values: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    values[key.slice(2)] = value;
    i += 1;
  }
  return { mode, values };
}

function required(values: Record<string, string>, key: string): string {
  const value = values[key];
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function realDirectory(value: string, label: string): string {
  const resolved = fs.realpathSync(path.resolve(value));
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`${label} is not a directory`);
  return resolved;
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertRoots(subjectArg: string, originalArg: string, outputArg: string): {
  subject: string;
  original: string;
  output: string;
} {
  const subject = realDirectory(subjectArg, 'subject root');
  const original = realDirectory(originalArg, 'original root');
  const gitRoot = (root: string): string => String(execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })).trim();
  const subjectGitRoot = realDirectory(gitRoot(subject), 'subject git root');
  const originalGitRoot = realDirectory(gitRoot(original), 'original git root');
  if (subject !== subjectGitRoot || original !== originalGitRoot) {
    throw new Error('subject-root and original-root must each be their checkout git root');
  }
  const outputPath = path.resolve(outputArg);
  const outputParent = fs.realpathSync(path.dirname(outputPath));
  const output = fs.existsSync(outputPath)
    ? fs.realpathSync(outputPath)
    : path.join(outputParent, path.basename(outputPath));
  if (subject === original || subjectGitRoot === originalGitRoot) throw new Error('subject root must differ from protected original root');
  if (inside(subject, original) || inside(original, subject) || inside(subjectGitRoot, originalGitRoot) || inside(originalGitRoot, subjectGitRoot)) {
    throw new Error('subject and protected original checkouts must be disjoint');
  }
  if (inside(output, subject) || inside(output, original)) {
    throw new Error('output must be outside both subject and protected original roots');
  }
  if (!fs.existsSync(output)) fs.mkdirSync(output, { recursive: true });
  return { subject, original, output };
}

function requireReadonlyCodexHome(subject: string, original: string, output: string): string {
  const value = process.env.CODEX_HOME;
  if (!value || !path.isAbsolute(value)) throw new Error('pause/resume requires an absolute CODEX_HOME');
  const home = realDirectory(value, 'CODEX_HOME');
  if (inside(home, subject) || inside(home, original) || inside(home, output) || inside(output, home)) {
    throw new Error('CODEX_HOME must be outside subject, original, and run output roots');
  }
  if (!fs.existsSync(path.join(home, 'config.toml'))) throw new Error('CODEX_HOME/config.toml is required');
  return home;
}

function proofExecutable(value: string): string {
  if (!path.isAbsolute(value)) throw new Error('--proof-bin must be an absolute path');
  const resolved = fs.realpathSync(value);
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error('--proof-bin is not executable');
  return resolved;
}

function writeText(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, 'utf8');
}

function writeJson(file: string, value: unknown): void {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function commandName(args: string[]): string {
  return args.join('-').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 120);
}

function runProof(
  proof: string,
  subject: string,
  output: string,
  phase: string,
  args: string[],
): CommandResult {
  const startedAt = new Date().toISOString();
  const result = spawnSync(proof, args, {
    cwd: subject,
    encoding: 'utf8',
    env: { ...process.env, PROOF_BIN: proof },
  });
  const status = typeof result.status === 'number' ? result.status : 1;
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || result.error?.message || '');
  const base = path.join(output, 'commands', phase, commandName(args));
  writeText(`${base}.stdout`, stdout);
  writeText(`${base}.stderr`, stderr);
  writeJson(`${base}.meta.json`, {
    pid: process.pid,
    cwd: subject,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    args,
    status,
  });
  return { status, stdout, stderr };
}

function parseJson(result: CommandResult, description: string): Json | ProofRow[] {
  if (result.status !== 0) throw new Error(`${description} failed with exit ${result.status}`);
  try {
    return JSON.parse(result.stdout) as Json | ProofRow[];
  } catch (error) {
    throw new Error(`${description} returned non-JSON output: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function rowsForComponent(value: Json | ProofRow[]): ProofRow[] {
  if (!Array.isArray(value)) throw new Error('Proof req list did not return an array');
  const rows = value.filter(row => row && row.component === 'get_string' && typeof row.id === 'string' && typeof row.file_path === 'string') as ProofRow[];
  if (!rows.length) throw new Error('Proof catalog has no native get_string requirements');
  return rows;
}

function proofFileHash(value: Json, id: string): string {
  const hash = (value._computed as Json | undefined)?.file_hash;
  if (typeof hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`Proof req show ${id} has no computed sha256 file hash`);
  }
  return hash;
}

function ensureFreshPrepareOutput(output: string): void {
  if (fs.readdirSync(output).length > 0) {
    throw new Error('prepare requires a new empty run output; existing diagnostics are never overwritten');
  }
}

function verifyCurrentProofInputs(
  proof: string,
  subject: string,
  output: string,
  rows: ProofRow[],
  phase: string,
): Record<string, string> {
  const currentList = runProof(proof, subject, output, `${phase}-catalog`, ['req', 'list', '--format', 'json']);
  const currentRows = rowsForComponent(parseJson(currentList, 'Proof req list') as ProofRow[]);
  const expectedIds = rows.map(row => row.id).sort();
  const currentIds = currentRows.map(row => row.id).sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(currentIds)) throw new Error(`Proof requirement ID set changed during ${phase}`);
  const hashes: Record<string, string> = {};
  for (const row of rows) {
    const currentRow = currentRows.find(item => item.id === row.id);
    if (!currentRow || currentRow.file_path !== row.file_path) throw new Error(`Proof requirement path changed during ${phase} for ${row.id}`);
    const shown = runProof(proof, subject, output, `${phase}-${row.id}`, ['req', 'show', row.id, '--with', 'file', '--format', 'json']);
    const value = parseJson(shown, `Proof req show ${row.id}`) as Json;
    const requirement = value.requirement as Json | undefined;
    if (!requirement || requirement.id !== row.id || value.file_path !== row.file_path) throw new Error(`Proof req show ${row.id} does not match the ${phase} catalog row`);
    hashes[row.id] = proofFileHash(requirement, row.id);
  }
  return hashes;
}

function baselineRows(output: string): ProofRow[] {
  const file = path.join(output, 'prepare', 'catalog.json');
  if (!fs.existsSync(file)) throw new Error(`missing prepare catalog: ${file}`);
  return rowsForComponent(JSON.parse(fs.readFileSync(file, 'utf8')) as Json | ProofRow[]);
}

function zeroModelTestEnabled(): boolean {
  const enabled = process.env.VISOR_NATIVE_B_ZERO_MODEL_TEST === 'true';
  if (enabled && process.env.NODE_ENV !== 'test') {
    throw new Error('VISOR_NATIVE_B_ZERO_MODEL_TEST requires NODE_ENV=test');
  }
  return enabled;
}

function nativeReviewItem(value: unknown): Json | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Json;
  if (
    typeof candidate.id === 'string' &&
    typeof candidate.spec_review_role === 'string' &&
    candidate.proof_snapshot &&
    typeof candidate.proof_file_hash === 'string'
  ) {
    return candidate;
  }
  for (const key of ['output', 'payload', 'value']) {
    const nested = nativeReviewItem(candidate[key]);
    if (nested) return nested;
  }
  return undefined;
}

function installZeroModelPromptWitness(output: string): void {
  const provider = CheckProviderRegistry.getInstance().getProviderOrThrow('ai') as any;
  const original = provider.renderPromptTemplate;
  if (typeof original !== 'function') throw new Error('zero-model prompt witness requires AICheckProvider.renderPromptTemplate');
  if (provider.__nativeBPromptWitnessInstalled) return;
  provider.__nativeBPromptWitnessInstalled = true;
  provider.renderPromptTemplate = async function (...args: any[]): Promise<string> {
    const rendered = String(await original.apply(this, args));
    const dependencyResults = args[3];
    let item: Json | undefined;
    if (dependencyResults instanceof Map) {
      for (const value of dependencyResults.values()) {
        item = nativeReviewItem(value);
        if (item) break;
      }
    }
    if (!item) throw new Error('zero-model prompt witness found no native item in actual dependencyResults');
    const id = String(item.id);
    const role = String(item.spec_review_role);
    const serializedRole = JSON.stringify(role);
    if (!rendered.includes(id)) throw new Error(`zero-model rendered prompt omitted native requirement ${id}`);
    if (!rendered.includes(role) && !rendered.includes(serializedRole)) {
      throw new Error(`zero-model rendered prompt omitted built-in spec-review role for ${id}`);
    }
    writeText(path.join(output, 'diagnostic', 'zero-model-prompts', `${id}.txt`), rendered);
    return rendered;
  };
}

async function configForSubject(subject: string, output: string) {
  const config = await loadConfig(CONFIG_PATH, { strict: true });
  if (zeroModelTestEnabled()) {
    const review = (config as any).subgraphs?.['native-spec-item']?.checks?.['review-native-item'];
    if (!review) throw new Error('zero-model test could not find native review check');
    review.ai = { ...(review.ai || {}), provider: 'mock', model: 'mock' };
    installZeroModelPromptWitness(output);
  }
  return { config, engine: new StateMachineExecutionEngine(subject) };
}

async function prepare(subject: string, proof: string, output: string): Promise<void> {
  const role = runProof(proof, subject, output, 'prepare', ['role', 'show', 'spec-review', '--format', 'agent']);
  if (role.status !== 0) throw new Error(`built-in spec-review role failed with exit ${role.status}`);
  writeText(path.join(output, 'prepare', 'role-spec-review.txt'), role.stdout);

  const list = runProof(proof, subject, output, 'prepare', ['req', 'list', '--format', 'json']);
  const rows = rowsForComponent(parseJson(list, 'Proof req list') as ProofRow[]);
  writeJson(path.join(output, 'prepare', 'catalog.json'), rows);
  const itemSummaries: Json[] = [];
  for (const row of rows) {
    const show = runProof(proof, subject, output, `prepare-${row.id}`, ['req', 'show', row.id, '--with', 'file', '--format', 'json']);
    const graph = runProof(proof, subject, output, `prepare-${row.id}`, ['spec', 'graph', '--focus', row.id, '--format', 'json']);
    const reqEnvelope = parseJson(show, `Proof req show ${row.id}`) as Json;
    const req = reqEnvelope.requirement as Json | undefined;
    if (!req || req.id !== row.id || reqEnvelope.file_path !== row.file_path) throw new Error(`Proof req show ${row.id} does not match the catalog row`);
    const hash = proofFileHash(req, row.id);
    if (graph.status !== 0) throw new Error(`Proof spec graph ${row.id} failed with exit ${graph.status}`);
    const graphValue = parseJson(graph, `Proof spec graph ${row.id}`);
    if (!graphValue || Array.isArray(graphValue) || typeof graphValue !== 'object') throw new Error(`Proof spec graph ${row.id} is not an object`);
    writeJson(path.join(output, 'prepare', 'items', row.id, 'req-show.json'), reqEnvelope);
    writeJson(path.join(output, 'prepare', 'items', row.id, 'spec-graph.json'), graphValue);
    itemSummaries.push({ id: row.id, file_path: row.file_path, file_hash: hash, graph_exit: graph.status });
  }
  writeJson(path.join(output, 'prepare', 'summary.json'), {
    phase: 'prepare',
    status: 'ready-for-review',
    component: 'get_string',
    item_count: rows.length,
    items: itemSummaries,
    role_exit: role.status,
    catalog_exit: list.status,
    proof_bin: proof,
    note: 'Native state is collected from Proof; this is not an admission receipt.',
  });
  console.log(JSON.stringify({ mode: 'prepare', status: 'ready-for-review', item_count: rows.length, output }, null, 2));
}

function dispatchGate(mode: 'pause' | 'resume', holdId: string, observations: Json[]): GeneratedDispatchGate {
  return generation => {
    const observation = {
      pid: process.pid,
      mode,
      recorded_at: new Date().toISOString(),
      generation_id: generation.nodeGenerationId,
      check_id: generation.checkId,
      template_node_key: generation.templateNodeKey,
      scope: generation.scope,
      status: generation.status,
      held_scope: generation.scope.some(part => part.key === holdId),
    };
    observations.push(observation);
    if (mode === 'pause' && observation.held_scope) return 'defer';
    return 'dispatch';
  };
}

function checkpointEvents(checkpoint: any): any[] {
  return Array.isArray(checkpoint?.events) ? checkpoint.events : [];
}

function assertNoAttemptFailures(events: any[], label: string): void {
  const failures = events.filter(event => event?.type === 'AttemptFailed' || event?.type === 'CheckErrored');
  if (failures.length) throw new Error(`${label} contains ${failures.length} failed generated attempt(s)`);
}

function assertUnchangedSiblingGenerations(before: any, after: any, heldId: string, completedGenerationIds: Set<string>): void {
  const beforeGenerations = before?.generationsById || {};
  const afterGenerations = after?.generationsById || {};
  for (const [id, generation] of Object.entries(beforeGenerations) as Array<[string, any]>) {
    if (!completedGenerationIds.has(id)) continue;
    if (Array.isArray(generation.scope) && generation.scope.some((part: any) => part.key === heldId)) continue;
    if (JSON.stringify(generation) !== JSON.stringify(afterGenerations[id])) {
      throw new Error(`resume changed completed sibling generation ${id}`);
    }
  }
}

async function pause(subject: string, proof: string, output: string, holdId?: string): Promise<void> {
  const rows = baselineRows(output);
  const held = holdId || rows[0].id;
  if (!rows.some(row => row.id === held)) throw new Error(`--hold-id ${held} is not a prepared native requirement`);
  if (fs.existsSync(path.join(output, 'paused', 'checkpoint.json')) || fs.existsSync(path.join(output, 'commands', 'pause-catalog'))) {
    throw new Error('pause output already exists; use a fresh run output');
  }
  const pauseHashes = verifyCurrentProofInputs(proof, subject, output, rows, 'pause');
  for (const row of rows) {
    const baseline = JSON.parse(fs.readFileSync(path.join(output, 'prepare', 'items', row.id, 'req-show.json'), 'utf8')) as Json;
    if (pauseHashes[row.id] !== proofFileHash(baseline.requirement as Json, row.id)) throw new Error(`Proof input changed before pause for ${row.id}`);
  }
  process.env.PROOF_BIN = proof;
  const { config, engine } = await configForSubject(subject, output);
  const observations: Json[] = [];
  const result = await engine.executeGroupedChecks(
    prInfo,
    ['discover-native-components'],
    undefined,
    config,
    undefined,
    false,
    config.max_parallelism,
    false,
    undefined,
    dispatchGate('pause', held, observations),
  );
  const context = (engine as any)._lastContext;
  if (!context) throw new Error('Graph-v2 engine did not expose a journal context');
  const checkpoint = JSON.parse(JSON.stringify(context.journal.exportGraphCheckpoint(context.sessionId)));
  const events = checkpointEvents(checkpoint);
  writeJson(path.join(output, 'diagnostic', 'pause-checkpoint.json'), checkpoint);
  writeJson(path.join(output, 'diagnostic', 'pause-observations.json'), observations);
  writeJson(path.join(output, 'diagnostic', 'pause-result.json'), result);
  const heldObservations = observations.filter(observation => observation.held_scope);
  const siblingObservations = observations.filter(observation => !observation.held_scope && observation.status === 'ready');
  if (!heldObservations.some(observation => observation.status === 'ready')) throw new Error('pause did not hold a ready generated scope');
  const siblingPacketCompleted = events.some(event => event?.type === 'AttemptCompleted' && event?.checkId === 'collect-proof-evidence' && !event.scope?.some((part: any) => part.key === held));
  if (!siblingObservations.length || !siblingPacketCompleted) throw new Error('pause did not observe sibling candidate-packet progression');
  const heldGenerationIds = new Set(heldObservations.map(observation => observation.generation_id));
  const heldAttemptEvents = events.filter(event => heldGenerationIds.has(event.nodeGenerationId) && /^Attempt/.test(String(event.type)));
  if (heldAttemptEvents.length) throw new Error('held ready scope already has an attempt event');
  assertNoAttemptFailures(events, 'paused checkpoint');
  const restored = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), checkpoint);
  const projection = context.journal.getInstanceProjection();
  if (JSON.stringify(projection) !== JSON.stringify(restored.getInstanceProjection())) {
    throw new Error('paused checkpoint projection does not match its restored projection');
  }
  const canonical = restored.exportGraphCheckpoint(checkpoint.sessionId);
  if (JSON.stringify(canonical) !== JSON.stringify(checkpoint)) throw new Error('paused checkpoint canonical re-export changed its bytes');
  writeJson(path.join(output, 'paused', 'checkpoint.json'), checkpoint);
  writeJson(path.join(output, 'paused', 'observations.json'), observations);
  writeJson(path.join(output, 'paused', 'summary.json'), {
    phase: 'pause',
    status: 'quiescent-ready-frontier',
    held_scope: held,
    pid: process.pid,
    result,
    checkpoint_session_id: checkpoint.sessionId,
    graph_semantic_digest: checkpoint.graphSemanticDigest,
    checkpoint_integrity_digest: checkpoint.integrity?.digest,
    checkpoint_event_count: events.length,
    held_generation_ids: [...heldGenerationIds],
    sibling_progressed: siblingObservations.length,
    sibling_packet_completed: siblingPacketCompleted,
    zero_model_test: zeroModelTestEnabled(),
    note: 'This holds a ready generated scope; it is not evidence of in-flight overlap or recovery.',
  });
  console.log(JSON.stringify({ mode: 'pause', status: 'quiescent-ready-frontier', held_scope: held, output }, null, 2));
}

async function resume(subject: string, proof: string, output: string): Promise<void> {
  const checkpointPath = path.join(output, 'paused', 'checkpoint.json');
  if (!fs.existsSync(checkpointPath)) throw new Error(`missing paused checkpoint: ${checkpointPath}`);
  if (fs.existsSync(path.join(output, 'resumed', 'checkpoint.json')) || fs.existsSync(path.join(output, 'commands', 'resume-catalog'))) {
    throw new Error('resume output already exists; refusing to overwrite evidence');
  }
  const pausedSummaryPath = path.join(output, 'paused', 'summary.json');
  if (!fs.existsSync(pausedSummaryPath)) throw new Error(`missing paused summary: ${pausedSummaryPath}`);
  const pausedSummary = JSON.parse(fs.readFileSync(pausedSummaryPath, 'utf8')) as Json;
  if (pausedSummary.pid === process.pid) throw new Error('resume must run in a fresh OS process');
  const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  const rows = baselineRows(output);
  const heldId = String(pausedSummary.held_scope || '');
  if (!rows.some(row => row.id === heldId)) throw new Error('paused held scope is not present in the prepared catalog');
  const currentHashes = verifyCurrentProofInputs(proof, subject, output, rows, 'resume');
  const stale: Json[] = [];
  for (const row of rows) {
    const baseline = JSON.parse(fs.readFileSync(path.join(output, 'prepare', 'items', row.id, 'req-show.json'), 'utf8')) as Json;
    const before = proofFileHash(baseline.requirement as Json, row.id);
    const after = currentHashes[row.id];
    if (before !== after) stale.push({ id: row.id, baseline_hash: before, current_hash: after });
  }
  if (stale.length) {
    writeJson(path.join(output, 'resume', 'stale-inputs.json'), stale);
    throw new Error(`Proof inputs changed since prepare (${stale.map(item => String(item.id)).join(', ')})`);
  }

  process.env.PROOF_BIN = proof;
  const { config, engine } = await configForSubject(subject, output);
  const observations: Json[] = [];
  const resumed = await engine.resumeGraphCheckpoint({
    checkpoint,
    config,
    prInfo,
    maxParallelism: config.max_parallelism,
    generatedDispatchGate: dispatchGate('resume', heldId, observations),
  });
  const returned = JSON.parse(JSON.stringify(resumed.checkpoint));
  const oldEvents = checkpointEvents(checkpoint);
  const newEvents = checkpointEvents(returned);
  writeJson(path.join(output, 'diagnostic', 'resume-checkpoint.json'), returned);
  writeJson(path.join(output, 'diagnostic', 'resume-observations.json'), observations);
  writeJson(path.join(output, 'diagnostic', 'resume-result.json'), resumed.result);
  if (returned.sessionId !== checkpoint.sessionId || returned.graphSemanticDigest !== checkpoint.graphSemanticDigest) {
    throw new Error('resume changed checkpoint session or graph semantic digest');
  }
  if (JSON.stringify(newEvents.slice(0, oldEvents.length)) !== JSON.stringify(oldEvents)) {
    throw new Error('resume did not preserve the exact paused event prefix');
  }
  const parentFanIn = observations.filter(observation => observation.check_id === 'wait-for-native-items');
  const unexpectedDispatch = observations.filter(observation => !observation.held_scope && observation.check_id !== 'wait-for-native-items');
  if (!observations.length || unexpectedDispatch.length || parentFanIn.length !== 1) {
    throw new Error('resume dispatched work outside the unfinished held scope and its single parent fan-in');
  }
  const newlyCompleted = newEvents.slice(oldEvents.length).filter(event => event?.type === 'AttemptCompleted');
  if (!newlyCompleted.length) throw new Error('resume did not complete any held generated attempt');
  if (!newEvents.some(event => event?.type === 'AttemptCompleted' && event?.checkId === 'wait-for-native-items')) {
    throw new Error('resume did not complete the parent fan-in');
  }
  const startedIds = new Set(newEvents.slice(oldEvents.length).filter(event => event?.type === 'AttemptStarted' && event.nodeGenerationId).map(event => event.nodeGenerationId));
  const completedIds = new Set(newEvents.slice(oldEvents.length).filter(event => event?.type === 'AttemptCompleted' && event.nodeGenerationId).map(event => event.nodeGenerationId));
  for (const id of startedIds) if (!completedIds.has(id)) throw new Error(`resume left generated attempt ${id} incomplete`);
  assertNoAttemptFailures(newEvents, 'resumed checkpoint');
  const restored = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), returned);
  const before = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), checkpoint).getInstanceProjection();
  const completedBeforeResume = new Set(
    oldEvents
      .filter(event => event?.type === 'AttemptCompleted' && typeof event.nodeGenerationId === 'string')
      .map(event => event.nodeGenerationId as string),
  );
  assertUnchangedSiblingGenerations(before, restored.getInstanceProjection(), heldId, completedBeforeResume);
  if (JSON.stringify(engine.getInstanceProjection()) !== JSON.stringify(restored.getInstanceProjection())) {
    throw new Error('resumed checkpoint projection does not match its restored projection');
  }
  const canonical = restored.exportGraphCheckpoint(returned.sessionId);
  if (JSON.stringify(canonical) !== JSON.stringify(returned)) throw new Error('resumed checkpoint canonical re-export changed its bytes');
  writeJson(path.join(output, 'resumed', 'checkpoint.json'), returned);
  writeJson(path.join(output, 'resumed', 'observations.json'), observations);
  writeJson(path.join(output, 'resumed', 'summary.json'), {
    phase: 'resume',
    status: 'completed-or-reviewed-state-recorded',
    pid: process.pid,
    result: resumed.result,
    checkpoint_session_id: returned.sessionId,
    checkpoint_event_prefix_count: oldEvents.length,
    resumed_event_count: newEvents.length,
    resume_pid_differs: pausedSummary.pid !== process.pid,
    held_scope: heldId,
    stale_inputs: false,
    zero_model_test: zeroModelTestEnabled(),
    note: 'Execution completion does not imply Proof validation, review, or admission.',
  });
  console.log(JSON.stringify({ mode: 'resume', status: 'completed-or-reviewed-state-recorded', output }, null, 2));
}

async function main(): Promise<void> {
  const { mode, values } = parseArgs(process.argv.slice(2));
  const roots = assertRoots(required(values, 'subject-root'), required(values, 'original-root'), required(values, 'output'));
  diagnosticOutput = roots.output;
  const proof = proofExecutable(required(values, 'proof-bin'));
  // workspace:false is intentional for this prototype.  Ordinary command
  // providers inherit process.cwd(), so make the validated subject the process
  // cwd before loading or executing any Graph-v2 mode.
  process.chdir(roots.subject);
  if (fs.realpathSync(process.cwd()) !== roots.subject) throw new Error('runner cwd did not resolve to the validated subject root');
  process.env.VISOR_NATIVE_B_PREPARE_SUMMARY = path.join(roots.output, 'prepare', 'summary.json');
  process.env.USE_CODEX = 'true';
  process.env.VISOR_DEBUG_AI_SESSIONS = 'true';
  process.env.VISOR_TRACE_DIR = process.env.VISOR_TRACE_DIR || path.join(roots.output, 'traces');
  process.env.VISOR_DEBUG_ARTIFACTS = process.env.VISOR_DEBUG_ARTIFACTS || path.join(roots.output, 'ai');
  if (mode === 'prepare') {
    ensureFreshPrepareOutput(roots.output);
    return prepare(roots.subject, proof, roots.output);
  }
  requireReadonlyCodexHome(roots.subject, roots.original, roots.output);
  if (mode === 'pause') return pause(roots.subject, proof, roots.output, values['hold-id']);
  if (mode === 'resume') return resume(roots.subject, proof, roots.output);
  throw new Error(`unknown mode ${mode}; expected prepare, pause, or resume`);
}

let diagnosticOutput: string | undefined;

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  try {
    if (diagnosticOutput) writeText(path.join(diagnosticOutput, 'failure.stderr'), `${message}\n`);
  } catch {
    // Preserve the original failure on stderr if the output path is unusable.
  }
  console.error(message);
  process.exitCode = 1;
});
