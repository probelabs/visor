/*
 * EXP-0210 P3c is the explicitly invoked live counterpart of run-demo.ts.
 * Preflight is dependency-only; the run-once path is the only path that
 * constructs the real governed Proof/Probe provider in fresh child processes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as yaml from 'js-yaml';
import { canonicalGraphCheckpointJson, ExecutionJournal } from '../../../src/snapshot-store';
import { compileClaimPlan } from '../../../src/state-machine/graph/claim-plan';
import { canonicalJson } from '../../../src/state-machine/graph/claim-kernel';
import { validateProofCandidateEvidence } from '../../../src/providers/governed-proof-inspect-check-provider';
import { validateProofCurrentCatalogAuthorityBytes } from '../../../src/providers/proof-catalog-check-providers';
import { proofCanonicalJson } from '../../../src/providers/proof-wire';
import type { PRInfo } from '../../../src/pr-analyzer';
import type { VisorConfig } from '../../../src/types/config';

type AnyRecord = Record<string, any>;
type FrozenPins = { visor_base: string; visor_head: string; frozen_head: string; visor_clean: boolean; repo_status_digest: string; yaml_sha256: string; runner_sha256: string };
type Prepared = { stage: string; privateDir: string; configPath: string; proofBinary: string; baselineWorkspace: string; fixedWorkspace: string; config: VisorConfig; preflight: AnyRecord; pins: FrozenPins };
type ChildResult = { checkpoint: AnyRecord; component_ids?: string[]; held_component_id?: string; completed_component_ids?: string[]; refreshed?: AnyRecord };

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SUBJECT_REPO = '/Users/buger/go/src/jsonparser';
const PROOF_REPO = '/Users/buger/go/src/reqforge-exp-0207a-proof-cli-admission';
const PROFILE = path.resolve(__dirname, 'visor.yaml');
const CHILD_ENTRY = path.resolve(__dirname, 'run-live-demo.ts');
const VISOR_COMMIT = '025f53ce';
const BASELINE_COMMIT = 'cb835d480ac58e1b4be76afeac49e89ed651c3b5';
const FIX_COMMIT = '3980c9c9b9919e643bd095fa4469bfa19e29f20c';
const PROOF_COMMIT = '543994bd68f2b6d6217749c4c19be737021b993a';
const PROBE_VERSION = '0.6.0-rc334';
const CODEX_VERSION = '0.150.1';
const PROFILE_ID = 'luna-xhigh-readonly-v1';
const PROBE_TOOLS = ['search', 'extract', 'listFiles'] as const;
const MAX_COMPONENTS = 4;
const MAX_CALLS = 11;
const PAUSE_CALLS = 7;
const RESUME_CALLS = 2;
const REPLACEMENT_CALLS = 2;
const MANAGED_DEADLINE_MS = 30 * 60 * 1000;
const SUPERVISOR_CLEANUP_MS = 60 * 1000;
const DISCOVERY_TIMEOUT_MS = MANAGED_DEADLINE_MS + SUPERVISOR_CLEANUP_MS;
const COMPONENT_TIMEOUT_MS = 61 * 60 * 1000 + SUPERVISOR_CLEANUP_MS;
const STAGES = ['inspect', 'proof_admit', 'spec_review', 'spec_review_admit', 'verify'] as const;
const SUBJECT_FILES = [
  'bytes.go', 'bytes_safe.go', 'bytes_test.go', 'bytes_unsafe.go',
  'bytes_unsafe_test.go', 'escape.go', 'escape_test.go', 'fuzz.go',
  'go.mod', 'go.sum', 'parser.go', 'parser_error_test.go', 'parser_test.go',
] as const;
const OFFLINE_ENV = { GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local' };
const PR: PRInfo = { number: 210, title: 'jsonparser staged live demo', body: '', author: 'fixture', base: 'baseline', head: 'fixed', files: [], totalAdditions: 0, totalDeletions: 0, eventType: 'manual' };
const PROBE_FAILURE_STAGES = new Set(['native_event_grammar', 'provider_engine', 'schema_result_validation', 'internal_contract', 'unknown']);
const PROBE_FAILURE_BOUNDARIES = new Set(['raw_item_predicate', 'live_envelope_session']);
const PROBE_PROVIDER_ENGINE_FAILURE_BOUNDARIES = new Set(['acquire', 'query', 'close']);
const PROBE_FAILURE_SUBREASONS = new Set(['session_sequence', 'envelope_shape', 'correlation', 'attestation']);
const PROBE_FAILURE_OPERANDS = new Set(['thread_id', 'response_id']);
const PROBE_FAILURE_PREDICATES = new Set(['event_shape', 'jsonrpc', 'params_shape', 'response_id', 'meta_shape', 'session_shape', 'session_identity', 'model', 'model_provider', 'approval_policy', 'approvals_reviewer', 'reasoning_effort', 'rollout_path', 'cwd', 'permission_shape', 'session_type', 'permission_type', 'network', 'filesystem_shape', 'filesystem_type', 'entries', 'entry', 'access', 'path_shape', 'path_type', 'value_shape', 'kind', 'native_tool_evidence', 'internal_contract', 'invocation_attestation', 'native_capability_aggregate']);
const PROBE_SCHEMA_SUBREASONS = new Set(['response_json', 'schema_definition', 'schema_mismatch', 'result_identity']);
const PROBE_SCHEMA_KEYWORDS = new Set(['required', 'additionalProperties', 'type', 'pattern', 'enum', 'minItems', 'maxItems', 'multiple', 'unknown']);
const FAILURE_DIAGNOSTICS_SCHEMA = 'urn:reqproof:agent-governance:exp-0210-failure-diagnostics:v1';
const MAX_FAILURE_DIAGNOSTICS = 32;
const MAX_FAILURE_DIAGNOSTICS_BYTES = 32 * 1024;
const FOCUSED_CHECKPOINT = '/tmp/visor-exp0210-live-luna.fom5fO/output/failure.checkpoint.json';
const FOCUSED_PREFLIGHT = '/tmp/visor-exp0210-live-luna.fom5fO/output/preflight.json';
const FOCUSED_CHECKPOINT_SHA256 = '1c7a3a8ac34ad7059f2ff6343bd7f3038edf201c6936ee0177766a84c07fd249';
const FOCUSED_PREFLIGHT_SHA256 = 'd46cd19eb7b7cc64165288caee36498591860da1d636a6f9bd2393ca07bb6507';
const FOCUSED_GRAPH_DIGEST = '306b074949f3975a5396dfffe74fc335790f7c6247f9b6c0ea90a5555d8fb212';
const FOCUSED_BASELINE_ROOT = 'f92c73d79e79102093bdb93bc0b75fc037900618';
const FOCUSED_BASELINE_LINEAGE = 'sha256:af892646ce4a1ccf206224987408c102bd140348931fcb1d2d378bf4887b3955';
const FOCUSED_BASELINE_DATE = '2026-09-05 10:03:54 +0300';
const FOCUSED_SCHEMA_PATHS = 'unavailable_at_probe_boundary';
const FOCUSED_CHILD_TIMEOUT_MS = COMPONENT_TIMEOUT_MS;
const FOCUSED_BOUNDARY_MODE = 'focused-diagnostic-boundary';
const FOCUSED_ANSWER_SENTINEL = new Error('focused answer boundary sentinel');
const FOCUSED_PROCESS_SENTINEL = new Error('focused process boundary sentinel');
const FOCUSED_NETWORK_SENTINEL = new Error('focused network boundary sentinel');

const requireFromRepo = createRequire(path.join(REPO_ROOT, 'package.json'));

function sha256(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex'); }

function writePrivateJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function writePrivateText(file: string, value: string): void {
  fs.writeFileSync(file, value, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function writeExclusiveJson(file: string, value: unknown): void {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
  finally { fs.closeSync(fd); }
}

function ownData(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}

function allowedProbeValue(values: Set<string>, value: unknown): string | undefined {
  return typeof value === 'string' && values.has(value) ? value : undefined;
}

function safeDiagnosticId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(value) ? value : undefined;
}

export function sanitizeProbeFailureTaxonomy(error: unknown): AnyRecord {
  const stageValue = ownData(error, 'answerFailureStage');
  const stage = allowedProbeValue(PROBE_FAILURE_STAGES, stageValue) || 'unknown';
  const taxonomy: AnyRecord = { answerFailureStage: stage };
  if (stage === 'native_event_grammar') {
    const boundaryValue = ownData(error, 'nativeEventFailureBoundary');
    const boundary = allowedProbeValue(PROBE_FAILURE_BOUNDARIES, boundaryValue) || null;
    taxonomy.nativeEventFailureBoundary = boundary;
    if (boundary === 'live_envelope_session') {
      const subreasonValue = ownData(error, 'nativeEventFailureSubreason');
      const subreason = allowedProbeValue(PROBE_FAILURE_SUBREASONS, subreasonValue) || null;
      taxonomy.nativeEventFailureSubreason = subreason;
      if (subreason === 'correlation') {
        const operand = ownData(error, 'nativeEventFailureCorrelationOperand');
        taxonomy.nativeEventFailureCorrelationOperand = allowedProbeValue(PROBE_FAILURE_OPERANDS, operand) || null;
      }
      if (subreason === 'attestation') {
        const predicate = ownData(error, 'nativeEventFailureAttestationPredicate');
        taxonomy.nativeEventFailureAttestationPredicate = allowedProbeValue(PROBE_FAILURE_PREDICATES, predicate) || null;
      }
    }
  } else if (stage === 'provider_engine') {
    const boundaryValue = ownData(error, 'providerEngineFailureBoundary');
    taxonomy.providerEngineFailureBoundary = allowedProbeValue(PROBE_PROVIDER_ENGINE_FAILURE_BOUNDARIES, boundaryValue) || null;
  } else if (stage === 'schema_result_validation') {
    const subreasonValue = ownData(error, 'schemaResultValidationSubreason');
    const subreason = allowedProbeValue(PROBE_SCHEMA_SUBREASONS, subreasonValue) || null;
    taxonomy.schemaResultValidationSubreason = subreason;
    taxonomy.schemaResultValidationKeyword = null;
    if (subreason === 'schema_mismatch') {
      const keyword = ownData(error, 'schemaResultValidationKeyword');
      taxonomy.schemaResultValidationKeyword = allowedProbeValue(PROBE_SCHEMA_KEYWORDS, keyword) || 'unknown';
    }
  }
  return Object.freeze(taxonomy);
}

type FailureBinding = Readonly<{ phase: string; check_id: string; component_id: string | null; binding_digest: string }>;

const DIAGNOSTIC_PHASES = new Set(['discovery', 'pause', 'resume', 'replacement']);
const DIAGNOSTIC_ENTRY_KEYS = ['binding_digest', 'check_id', 'component_id', 'phase', 'taxonomy'];

function failureBinding(phase: string, request: unknown): FailureBinding {
  const binding = ownData(request, 'binding');
  const checkValue = ownData(binding, 'checkId');
  const scope = ownData(binding, 'scope');
  const lastScope = Array.isArray(scope) && scope.length > 1 ? scope[scope.length - 1] : undefined;
  const componentValue = ownData(lastScope, 'key');
  let bindingDigest = 'unknown';
  try { bindingDigest = `sha256:${sha256(canonicalJson(binding))}`; } catch { /* Keep only the safe correlation fields. */ }
  return Object.freeze({
    phase,
    check_id: safeDiagnosticId(checkValue) || 'unknown',
    component_id: safeDiagnosticId(componentValue) || null,
    binding_digest: bindingDigest,
  });
}

function diagnosticEntryKey(entry: AnyRecord): string {
  return `${entry.phase}\0${entry.check_id}\0${entry.component_id || ''}\0${entry.binding_digest}\0${canonicalJson(entry.taxonomy)}`;
}

function validDiagnosticTaxonomy(value: unknown): value is AnyRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const taxonomy = value as AnyRecord;
  const stage = taxonomy.answerFailureStage;
  if (typeof stage !== 'string' || !PROBE_FAILURE_STAGES.has(stage)) return false;
  const keys = Object.keys(taxonomy).sort();
  if (stage === 'native_event_grammar') {
    if (keys.indexOf('nativeEventFailureBoundary') < 0 || keys.some(key => !['answerFailureStage', 'nativeEventFailureAttestationPredicate', 'nativeEventFailureBoundary', 'nativeEventFailureCorrelationOperand', 'nativeEventFailureSubreason'].includes(key))) return false;
    const boundary = taxonomy.nativeEventFailureBoundary;
    if (boundary !== null && !PROBE_FAILURE_BOUNDARIES.has(boundary)) return false;
    if (boundary !== 'live_envelope_session') return keys.length === 2;
    const subreason = taxonomy.nativeEventFailureSubreason;
    if (subreason !== null && !PROBE_FAILURE_SUBREASONS.has(subreason)) return false;
    if (subreason === 'correlation') return keys.length === 4 && (taxonomy.nativeEventFailureCorrelationOperand === null || PROBE_FAILURE_OPERANDS.has(taxonomy.nativeEventFailureCorrelationOperand));
    if (subreason === 'attestation') return keys.length === 4 && (taxonomy.nativeEventFailureAttestationPredicate === null || PROBE_FAILURE_PREDICATES.has(taxonomy.nativeEventFailureAttestationPredicate));
    return keys.length === 3;
  }
  if (stage === 'provider_engine') {
    if (keys.length !== 2 || keys.some(key => !['answerFailureStage', 'providerEngineFailureBoundary'].includes(key))) return false;
    const boundary = taxonomy.providerEngineFailureBoundary;
    return boundary === null || PROBE_PROVIDER_ENGINE_FAILURE_BOUNDARIES.has(boundary);
  }
  if (stage === 'schema_result_validation') {
    if (keys.length !== 3 || keys.some(key => !['answerFailureStage', 'schemaResultValidationKeyword', 'schemaResultValidationSubreason'].includes(key))) return false;
    if (taxonomy.schemaResultValidationSubreason !== null && !PROBE_SCHEMA_SUBREASONS.has(taxonomy.schemaResultValidationSubreason)) return false;
    return taxonomy.schemaResultValidationSubreason === 'schema_mismatch'
      ? typeof taxonomy.schemaResultValidationKeyword === 'string' && PROBE_SCHEMA_KEYWORDS.has(taxonomy.schemaResultValidationKeyword)
      : taxonomy.schemaResultValidationKeyword === null;
  }
  return keys.length === 1;
}

function validDiagnosticEntry(value: unknown): value is AnyRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as AnyRecord;
  if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(DIAGNOSTIC_ENTRY_KEYS)) return false;
  if (!DIAGNOSTIC_PHASES.has(entry.phase) || (entry.check_id !== 'unknown' && !safeDiagnosticId(entry.check_id)) || (entry.component_id !== null && !safeDiagnosticId(entry.component_id))) return false;
  if (entry.binding_digest !== 'unknown' && (typeof entry.binding_digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(entry.binding_digest))) return false;
  return validDiagnosticTaxonomy(entry.taxonomy);
}

export function aggregateFailureDiagnostics(fragments: readonly unknown[]): AnyRecord[] {
  const entries: AnyRecord[] = [];
  const seen = new Set<string>();
  for (const fragment of fragments) {
    if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment)) continue;
    const body = fragment as AnyRecord;
    if (body.schema !== FAILURE_DIAGNOSTICS_SCHEMA || !Array.isArray(body.failures) || body.failures.length > MAX_FAILURE_DIAGNOSTICS) continue;
    for (const entry of body.failures) {
      if (!validDiagnosticEntry(entry)) continue;
      const key = diagnosticEntryKey(entry);
      if (seen.has(key) || entries.length >= MAX_FAILURE_DIAGNOSTICS) continue;
      seen.add(key);
      entries.push(Object.freeze({ ...entry, taxonomy: Object.freeze({ ...entry.taxonomy }) }));
    }
  }
  return entries.sort((left, right) => diagnosticEntryKey(left).localeCompare(diagnosticEntryKey(right)));
}

export function serializeFailureDiagnostics(entries: readonly AnyRecord[]): string {
  const body = { schema: FAILURE_DIAGNOSTICS_SCHEMA, failures: entries.slice(0, MAX_FAILURE_DIAGNOSTICS) };
  const serialized = `${JSON.stringify(body, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_FAILURE_DIAGNOSTICS_BYTES) throw new Error('failure diagnostics exceed bounded size');
  return serialized;
}

function writeFailureDiagnostics(file: string, entries: readonly AnyRecord[]): void {
  const serialized = serializeFailureDiagnostics(entries);
  fs.writeFileSync(file, serialized, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function aggregateFailureDiagnosticsFile(stage: string): void {
  try {
    const fragments: unknown[] = [];
    for (const mode of DIAGNOSTIC_PHASES) {
      const file = path.join(stage, '.private', `failure-diagnostics.${mode}.json`);
      if (!fs.existsSync(file)) continue;
      try { fragments.push(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* Ignore malformed private fragments. */ }
    }
    const entries = aggregateFailureDiagnostics(fragments);
    if (entries.length > 0) writeFailureDiagnostics(path.join(stage, 'failure-diagnostics.json'), entries);
  } catch { /* Diagnostics never mask the primary governed failure. */ }
}

export function installProbeFailureDiagnostics(mode: string, stage: string, runnerClass: { prototype: object }): () => void {
  const prototype = runnerClass.prototype as AnyRecord;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'answer');
  if (!descriptor || typeof descriptor.value !== 'function') throw new Error('governed Probe answer observer cannot attach');
  const entries: AnyRecord[] = [];
  const seen = new Set<string>();
  let restored = false;
  const write = (): void => {
    writeFailureDiagnostics(path.join(stage, '.private', `failure-diagnostics.${mode}.json`), entries);
  };
  const record = (binding: FailureBinding, error: unknown): void => {
    try {
      const taxonomy = sanitizeProbeFailureTaxonomy(error);
      const key = canonicalJson({ binding_digest: binding.binding_digest, taxonomy });
      if (seen.has(key) || entries.length >= MAX_FAILURE_DIAGNOSTICS) return;
      const entry = Object.freeze({ ...binding, taxonomy });
      const next = [...entries, entry].sort((left, right) => `${left.phase}\0${left.check_id}\0${left.component_id || ''}\0${left.binding_digest}`.localeCompare(`${right.phase}\0${right.check_id}\0${right.component_id || ''}\0${right.binding_digest}`));
      try { serializeFailureDiagnostics(next); } catch { return; }
      seen.add(key);
      entries.splice(0, entries.length, ...next);
      write();
    } catch { /* Diagnostics never alter the governed failure or expose raw errors. */ }
  };
  Object.defineProperty(prototype, 'answer', {
    ...descriptor,
    value: function (this: unknown, ...args: unknown[]): unknown {
      const binding = failureBinding(mode, args[0]);
      let result: unknown;
      try { result = Reflect.apply(descriptor.value as Function, this, args); }
      catch (error) { record(binding, error); throw error; }
      if (result && typeof (result as AnyRecord).then === 'function') {
        return Promise.resolve(result).then(value => value, error => { record(binding, error); throw error; });
      }
      return result;
    },
  });
  return () => {
    if (restored) return;
    restored = true;
    Object.defineProperty(prototype, 'answer', descriptor);
  };
}

function command(executable: string, args: string[], cwd = REPO_ROOT, input?: Buffer | string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(executable, args, { cwd, input, encoding: 'utf8', timeout: 30_000, maxBuffer: 128 * 1024 * 1024, env: { ...process.env, ...OFFLINE_ENV } });
  return { status: result.status === null ? -1 : result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

function run(executable: string, args: string[], cwd = REPO_ROOT, input?: Buffer | string): Buffer {
  return execFileSync(executable, args, { cwd, input, maxBuffer: 512 * 1024 * 1024, env: { ...process.env, ...OFFLINE_ENV } });
}

function archive(repo: string, revision: string, destination: string, deterministicRoot = false): void {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const tar = run('git', ['-C', repo, 'archive', revision, '--', ...SUBJECT_FILES]);
  run('tar', ['-xf', '-', '-C', destination], REPO_ROOT, tar);
  writePrivateText(path.join(destination, 'proof.yaml'), 'project:\n  name: jsonparser\n  version: "1.0"\n');
  run('git', ['init', '-q'], destination);
  run('git', ['config', 'user.email', 'visor-exp0210@example.invalid'], destination);
  run('git', ['config', 'user.name', 'Visor EXP-0210'], destination);
  run('git', ['add', '--', ...SUBJECT_FILES, 'proof.yaml'], destination);
  if (!deterministicRoot) {
    run('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', `EXP-0210 ${revision}`], destination);
    return;
  }
  const commit = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', `EXP-0210 ${revision}`], {
    cwd: destination,
    env: { ...process.env, ...OFFLINE_ENV, GIT_AUTHOR_DATE: FOCUSED_BASELINE_DATE, GIT_COMMITTER_DATE: FOCUSED_BASELINE_DATE },
    encoding: 'utf8', timeout: 30_000,
  });
  if (commit.status !== 0) throw new Error('focused baseline archive commit failed');
  const root = run('git', ['rev-list', '--max-parents=0', 'HEAD'], destination).toString('utf8').trim();
  if (root !== FOCUSED_BASELINE_ROOT) throw new Error('focused baseline root commit does not match retained lineage');
}

function buildProof(destination: string): string {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-exp0210-live-proof-'));
  try {
    fs.chmodSync(source, 0o700);
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    fs.chmodSync(destination, 0o700);
    const tar = run('git', ['-C', PROOF_REPO, 'archive', PROOF_COMMIT, '--format=tar']);
    run('tar', ['-xf', '-', '-C', source], REPO_ROOT, tar);
    const binary = path.join(destination, 'proof');
    run('go', ['build', '-o', binary, './cmd/proof'], source);
    fs.chmodSync(binary, 0o700);
    return binary;
  } finally { fs.rmSync(source, { recursive: true, force: true }); }
}

function proofInvoke(binary: string, cwd: string, args: string[], input = ''): AnyRecord {
  return JSON.parse(run(binary, args, cwd, input).toString('utf8')) as AnyRecord;
}

function sourceState(): AnyRecord {
  const status = run('git', ['-C', SUBJECT_REPO, 'status', '--porcelain=v1']).toString('utf8');
  const head = run('git', ['-C', SUBJECT_REPO, 'rev-parse', 'HEAD']).toString('utf8').trim();
  const files = Object.fromEntries(SUBJECT_FILES.map(file => [file, sha256(fs.readFileSync(path.join(SUBJECT_REPO, file)))]));
  return { git_status: status ? status.split('\n').filter(Boolean) : [], head, files, tree_sha256: sha256(SUBJECT_FILES.map(file => `${files[file]}  ${file}\n`).join('')) };
}

function sourceManifest(workspace: string, revision: string): AnyRecord {
  const files = Object.fromEntries(SUBJECT_FILES.map(file => [file, sha256(fs.readFileSync(path.join(workspace, file)))]));
  return { version: 'urn:reqproof:exp-0210-source-manifest:v1', revision, file_count: SUBJECT_FILES.length, paths: [...SUBJECT_FILES], file_sha256: files, manifest_sha256: sha256(SUBJECT_FILES.map(file => `${files[file]}  ${file}\n`).join('')) };
}

function packageVersion(specifier: string): { version: string; resolved: string } {
  const resolved = requireFromRepo.resolve(specifier);
  const packageFile = path.resolve(path.dirname(resolved), '..', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as AnyRecord;
  return { version: String(packageJson.version || ''), resolved };
}

/**
 * The source and profile digests are computed independently of the report, so
 * the report never participates in its own pin.  CI/frozen runs may provide
 * the final committed Visor head and these two digests through the environment
 * without making the uncommitted source claim a final commit hash.
 */
function frozenPins(requireFrozen = false): FrozenPins {
  const yamlSha256 = sha256(fs.readFileSync(PROFILE));
  const runnerSha256 = sha256(fs.readFileSync(__filename));
  const headResult = command('git', ['rev-parse', 'HEAD']);
  if (headResult.status !== 0 || !/^[0-9a-f]{40}$/i.test(headResult.stdout.trim())) throw new Error('Visor HEAD pin is unavailable');
  const observedHead = headResult.stdout.trim();
  const expectedHead = process.env.VISOR_EXP0210_EXPECTED_VISOR_HEAD;
  const expectedYaml = process.env.VISOR_EXP0210_EXPECTED_YAML_SHA256;
  const expectedRunner = process.env.VISOR_EXP0210_EXPECTED_RUNNER_SHA256;
  const repoStatus = command('git', ['status', '--porcelain=v1', '--untracked-files=all']);
  if (repoStatus.status !== 0) throw new Error('Visor repository status is unavailable');
  const visorClean = repoStatus.stdout.length === 0;
  if (requireFrozen && (!expectedHead || !expectedYaml || !expectedRunner)) throw new Error('frozen run pins are required');
  if (requireFrozen && !visorClean) throw new Error('Visor repository is not clean for the frozen run');
  if (expectedHead !== undefined && observedHead !== expectedHead) throw new Error('Visor HEAD pin does not match the frozen run');
  if (expectedYaml !== undefined && expectedYaml !== yamlSha256) throw new Error('Visor YAML pin does not match the frozen run');
  if (expectedRunner !== undefined && expectedRunner !== runnerSha256) throw new Error('live runner pin does not match the frozen run');
  return { visor_base: VISOR_COMMIT, visor_head: observedHead, frozen_head: expectedHead || 'unbound', visor_clean: visorClean, repo_status_digest: sha256(repoStatus.stdout), yaml_sha256: yamlSha256, runner_sha256: runnerSha256 };
}

function verifyCodex(): AnyRecord {
  const which = command('which', ['codex']);
  if (which.status !== 0) throw new Error('codex executable unavailable');
  const version = command('codex', ['--version']);
  if (version.status !== 0 || !version.stdout.trim().endsWith(CODEX_VERSION)) throw new Error('codex version is not pinned');
  const login = command('codex', ['login', 'status']);
  if (login.status !== 0) throw new Error('codex login status is unavailable');
  return { executable_present: true, version: CODEX_VERSION, observed_version: version.stdout.trim(), required_version: CODEX_VERSION, login_verified: login.status === 0 };
}

function verifyProbe(): AnyRecord {
  const packageInfo = packageVersion('@probelabs/probe');
  if (packageInfo.version !== PROBE_VERSION) throw new Error(`installed Probe version is not ${PROBE_VERSION}`);
  const probe = requireFromRepo('@probelabs/probe') as AnyRecord;
  const prototype = probe.ProbeAgent?.prototype as AnyRecord | undefined;
  if (typeof probe.ProbeAgent !== 'function' || !prototype || !['initialize', 'answerGoverned', 'previewGovernedAnswerDispatch', 'close'].every(method => typeof prototype[method] === 'function')) throw new Error('Probe governed API is incomplete');
  return { version: packageInfo.version, required_version: PROBE_VERSION, api: ['initialize', 'answerGoverned', 'previewGovernedAnswerDispatch', 'close'] };
}

function resolveProjectRole(binary: string, workspace: string, config: AnyRecord): AnyRecord {
  const inventory = proofInvoke(binary, workspace, ['onboarding', 'inventory']);
  const check = config.subgraphs['discover-project'].checks.inspect;
  const invocation = { role_id: 'onboard', stance: 'owner', subject: { kind: 'project', id: inventory.authority.project_id, fingerprint: inventory.authority.subject_fingerprint }, output_schema_id: check.invocation.output_schema_id, output_schema: check.invocation.output_schema };
  const resolved = proofInvoke(binary, workspace, ['resolve-role-invocation'], JSON.stringify(invocation));
  check.invocation = invocation;
  check.instructions = resolved.instructions;
  check.invocation_digest = resolved.invocation_digest;
  check.result_schema = Buffer.from(invocation.output_schema, 'base64').toString('utf8');
  return inventory;
}

/** Restore the project selector from authenticated retained evidence.  The
 * inventory command may discover a new subject after a provider upgrade; a
 * focused replay must use the invocation that produced the checkpoint. */
function resolveHistoricalProjectRole(binary: string, workspace: string, config: AnyRecord, checkpoint: AnyRecord): void {
  const event = checkpoint.events.find((value: any) => value.type === 'ClaimPublished' && value.claim === 'proof.candidate@1' && value.scope?.length === 1 && value.proofCandidateEvidence);
  if (!event?.proofCandidateEvidence) throw new Error('historical project Proof evidence is missing');
  const evidence = validateProofCandidateEvidence(event.proofCandidateEvidence);
  const historical = evidence.role.invocation;
  // Proof's CLI request is a closed Go struct wire (not Proof CanonicalJSON):
  // preserve the authenticated values while rebuilding its declared field
  // order, including the nested Subject order.
  const historicalSubject = historical.subject as AnyRecord;
  const request = {
    role_id: historical.role_id,
    stance: historical.stance,
    subject: { kind: historicalSubject.kind, id: historicalSubject.id, fingerprint: historicalSubject.fingerprint },
    output_schema_id: historical.output_schema_id,
    output_schema: historical.output_schema,
  };
  const resolved = proofInvoke(binary, workspace, ['resolve-role-invocation'], JSON.stringify(request));
  if (resolved.invocation_digest !== evidence.role.invocationDigest) throw new Error('historical project invocation digest does not match retained evidence');
  const check = config.subgraphs['discover-project'].checks.inspect;
  check.invocation = JSON.parse(JSON.stringify(historical));
  check.instructions = resolved.instructions;
  check.invocation_digest = resolved.invocation_digest;
  check.result_schema = Buffer.from(String(historical.output_schema), 'base64').toString('utf8');
}

function verifyFocusedBaselineLineage(binary: string, workspace: string, checkpoint: AnyRecord): void {
  const root = run('git', ['rev-list', '--max-parents=0', 'HEAD'], workspace).toString('utf8').trim();
  if (root !== FOCUSED_BASELINE_ROOT) throw new Error('focused baseline root is detached from retained evidence');
  const retained = checkpoint.events.map((event: any) => event.proofCandidateEvidence?.role?.invocation?.component_authority?.catalog_revalidation_receipt?.project_lineage).find(Boolean) as AnyRecord | undefined;
  if (!retained || retained.baseline_revision !== `sha1:${root}` || retained.fingerprint !== FOCUSED_BASELINE_LINEAGE || retained.object_format !== 'sha1') throw new Error('focused baseline lineage evidence is not exact');
  const { candidate, admission } = candidateAndAdmission(checkpoint);
  const candidatePayload = typeof candidate.payload === 'string' ? JSON.parse(candidate.payload) : candidate.payload;
  const admissionPayload = typeof admission.payload === 'string' ? JSON.parse(admission.payload) : admission.payload;
  if (typeof admissionPayload?.__proof_admission_wire !== 'string') throw new Error('focused project admission wire is missing');
  const request = proofCanonicalJson({ version: 'proof.catalog-revalidation-request/v2', candidate: candidatePayload, admission: JSON.parse(admissionPayload.__proof_admission_wire) });
  const refreshed = proofInvoke(binary, workspace, ['onboarding', 'revalidate'], request);
  const lineage = refreshed.receipt?.project_lineage;
  if (!lineage || lineage.baseline_revision !== retained.baseline_revision || lineage.fingerprint !== retained.fingerprint || lineage.object_format !== retained.object_format || lineage.version !== retained.version) throw new Error('focused baseline lineage does not revalidate exactly');
}

async function resolveFocusedSpecReviewRole(binary: string, workspace: string, derivation: FocusedDerivation): Promise<AnyRecord> {
  const invocation = derivation.execution.node.check.invocation as AnyRecord;
  const subject = derivation.authority.subject as AnyRecord;
  const request = {
    role_id: invocation.role_id,
    stance: invocation.stance,
    subject: { kind: 'component', id: subject.component_id, fingerprint: subject.fingerprint },
    component_authority: derivation.authority,
    onboarding_stage: derivation.onboardingStage,
    output_schema_id: invocation.output_schema_id,
    output_schema: invocation.output_schema,
  };
  const { createProofAdmissionCapability, resolveProofRoleInvocation } = require('../../../src/providers/proof-admission-cli-child') as typeof import('../../../src/providers/proof-admission-cli-child');
  const resolved = await resolveProofRoleInvocation(createProofAdmissionCapability(binary), request, workspace);
  if (typeof resolved.invocation_digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(resolved.invocation_digest) || resolved.role_id !== invocation.role_id || resolved.output_schema_id !== invocation.output_schema_id || resolved.output_schema !== invocation.output_schema || typeof resolved.instructions !== 'string' || resolved.instructions.length === 0) {
    throw new Error('focused spec-review invocation is not pinned to retained Proof authority');
  }
  return {
    role_id: resolved.role_id,
    stage_id: derivation.onboardingStage.stage_id,
    invocation_digest: resolved.invocation_digest,
    output_schema_id: resolved.output_schema_id,
    output_schema_digest: resolved.output_schema_digest,
  };
}

function preflightReport(config: AnyRecord, graphDigest: string, inventory: AnyRecord, codex: AnyRecord, probe: AnyRecord, baseline: AnyRecord, fixed: AnyRecord, pins: FrozenPins): AnyRecord {
  return {
    schema: 'urn:reqproof:agent-governance:exp-0210-live-preflight:v1', status: 'passed', mode: 'preflight-only',
    governed_calls: 0, model_calls: 0, network_dispatches_requested: 0, retries: 0, fallback: false,
    pins: { ...pins, proof_commit: PROOF_COMMIT, probe_version: probe.version, codex_version: codex.version, profile_id: PROFILE_ID, probe_tools: [...PROBE_TOOLS], subject_baseline: BASELINE_COMMIT, subject_fix: FIX_COMMIT },
    contract: { components_min: 2, components_max: MAX_COMPONENTS, call_budget: '1 + 2N + 2|C|', maximum_calls: MAX_CALLS, stages: [...STAGES], model: 'gpt-5.6-luna', reasoning_effort: 'xhigh', sandbox: 'read-only', approval_policy: 'never' },
    graph: { semantic_digest: graphDigest, compiled: true, dynamic_expansion: true, staged_profile: true },
    discovery: { project_id: inventory.authority?.project_id, subject_fingerprint: inventory.authority?.subject_fingerprint },
    source: { baseline_revision: BASELINE_COMMIT, fix_revision: FIX_COMMIT, file_count: SUBJECT_FILES.length, baseline_manifest_sha256: baseline.manifest_sha256, fix_manifest_sha256: fixed.manifest_sha256 },
    codex, probe,
    evidence: 'preflight performs no Probe-agent initialization or governed/model/network dispatch',
    config: { max_parallelism: config.max_parallelism },
  };
}

function prepare(stage: string, requireFrozen = false, focused = false, codexEvidence?: AnyRecord): Prepared {
  const privateDir = path.join(stage, '.private');
  const work = path.join(privateDir, 'work');
  fs.mkdirSync(work, { recursive: true, mode: 0o700 });
  fs.chmodSync(privateDir, 0o700); fs.chmodSync(work, 0o700);
  const baselineWorkspace = path.join(work, 'baseline');
  const fixedWorkspace = path.join(work, 'fixed');
  archive(SUBJECT_REPO, BASELINE_COMMIT, baselineWorkspace, focused);
  archive(SUBJECT_REPO, FIX_COMMIT, fixedWorkspace);
  const proofBinary = buildProof(path.join(work, 'proof'));
  const config = yaml.load(fs.readFileSync(PROFILE, 'utf8')) as VisorConfig;
  const inventory = resolveProjectRole(proofBinary, baselineWorkspace, config);
  const graphDigest = compileClaimPlan(config).expansionPlan.graphSemanticDigest;
  const codex = codexEvidence || verifyCodex();
  const probe = verifyProbe();
  const pins = frozenPins(requireFrozen);
  const baseline = sourceManifest(baselineWorkspace, BASELINE_COMMIT);
  const fixed = sourceManifest(fixedWorkspace, FIX_COMMIT);
  exactSourceDelta(baseline, fixed);
  const configPath = path.join(privateDir, 'effective-config.json');
  writePrivateJson(configPath, config);
  const input = { configPath, proofBinary, baselineWorkspace, fixedWorkspace, discoveryCheckpoint: path.join(privateDir, 'discovery.checkpoint.json'), baselineCheckpoint: path.join(privateDir, 'baseline.checkpoint.json'), pauseCheckpoint: path.join(privateDir, 'pause.checkpoint.json'), replacementCheckpoint: path.join(privateDir, 'replacement.checkpoint.json') };
  writePrivateJson(path.join(privateDir, 'run-input.json'), input);
  const preflight = preflightReport(config, graphDigest, inventory, codex, probe, baseline, fixed, pins);
  writePrivateJson(path.join(stage, 'preflight.json'), preflight);
  return { stage, privateDir, configPath, proofBinary, baselineWorkspace, fixedWorkspace, config, preflight, pins };
}

function cleanupPrivate(prepared: Prepared): void { fs.rmSync(prepared.privateDir, { recursive: true, force: true }); }

function freshOutput(output: string): void {
  if (!fs.existsSync(output)) return;
  const stat = fs.lstatSync(output);
  if (!stat.isDirectory() || fs.readdirSync(output).length !== 0) throw new Error('output directory already contains terminal evidence');
  fs.rmdirSync(output);
}

/** Claim a run-once destination before any archive, Proof, or provider work. */
function claimRunOutput(output: string): string {
  const target = path.resolve(output);
  try {
    fs.mkdirSync(target, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('run-once output is already claimed');
    throw new Error('run-once output cannot be claimed');
  }
  fs.chmodSync(target, 0o700);
  return target;
}

function publish(stage: string, output: string): void {
  freshOutput(output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.renameSync(stage, output);
  fs.chmodSync(output, 0o700);
}

function privateInput(stage: string): AnyRecord { return JSON.parse(fs.readFileSync(path.join(stage, '.private', 'run-input.json'), 'utf8')) as AnyRecord; }

function componentProjection(checkpoint: AnyRecord, config: AnyRecord): AnyRecord { return ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), checkpoint).getInstanceProjection() as AnyRecord; }

function componentIds(view: AnyRecord): string[] {
  return [...new Set(Object.values(view.instancesById).filter((value: any) => value.itemKey !== 'jsonparser').map((value: any) => String(value.itemKey)))].sort();
}

function authenticatedWorkItems(checkpoint: AnyRecord, config: AnyRecord, requireReady = true): { items: AnyRecord[]; componentIds: string[]; changedComponentId: string; heldComponentId: string } {
  const view = componentProjection(checkpoint, config);
  const claims = Object.values(view.claimsById).filter((value: any) => value.claim === 'component.work_item@1' && value.active && value.scope?.length === 2) as AnyRecord[];
  if (claims.length < 2 || claims.length > MAX_COMPONENTS) throw new Error('authenticated WorkItem count is outside the live bound');
  const items = claims.sort((left, right) => String(left.payload?.component_id || '').localeCompare(String(right.payload?.component_id || '')));
  const ids = items.map(item => String(item.payload?.component_id || ''));
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error('authenticated WorkItems are not unique');
  for (const item of items) {
    const id = String(item.payload.component_id);
    const scopeId = String(item.scope.at(-1)?.key || '');
    const instance = Object.values(view.instancesById).find((value: any) => value.itemKey === id) as AnyRecord | undefined;
    if (!instance || scopeId !== id || !Array.isArray(item.payload.sorted_owned_paths) || item.payload.sorted_owned_paths.length === 0) throw new Error('authenticated WorkItem scope or ownership is invalid');
    const inspect = Object.values(view.generationsById).filter((value: any) => value.subgraphInstanceId === instance.subgraphInstanceId && value.checkId === 'inspect');
    if (inspect.length !== 1 || (requireReady && (inspect[0] as AnyRecord).status !== 'ready')) throw new Error('discovery did not leave exactly one inspect generation per WorkItem');
  }
  const ownsParser = items.filter(item => item.payload.sorted_owned_paths.includes('parser.go') && item.payload.sorted_owned_paths.includes('parser_test.go'));
  if (ownsParser.length !== 1) throw new Error('Proof WorkItems do not identify one parser owner');
  const changedComponentId = String(ownsParser[0].payload.component_id);
  const heldComponentId = ids.find(id => id !== changedComponentId);
  if (!heldComponentId) throw new Error('no unaffected WorkItem is available for the held frontier');
  return { items, componentIds: ids, changedComponentId, heldComponentId };
}

function exactSourceDelta(baseline: AnyRecord, fixed: AnyRecord): void {
  const changed = SUBJECT_FILES.filter(file => baseline.file_sha256[file] !== fixed.file_sha256[file]).sort();
  if (canonicalJson(changed) !== canonicalJson(['parser.go', 'parser_test.go'])) throw new Error('pinned subject delta is not exactly parser.go/parser_test.go');
}

function generationsFor(view: AnyRecord, id: string): AnyRecord[] {
  const instance = Object.values(view.instancesById).find((value: any) => value.itemKey === id) as AnyRecord | undefined;
  if (!instance) throw new Error('component instance missing');
  return Object.values(view.generationsById).filter((value: any) => value.subgraphInstanceId === instance.subgraphInstanceId) as AnyRecord[];
}

function attemptCount(checkpoint: AnyRecord): number { return checkpoint.events.filter((event: any) => event.type === 'AttemptStarted' && (event.checkId === 'inspect' || event.checkId === 'spec_review')).length; }

function suffixAttemptCount(checkpoint: AnyRecord, prefix: number): number { return attemptCount({ events: checkpoint.events.slice(prefix) }); }

function candidateAndAdmission(checkpoint: AnyRecord): { candidate: AnyRecord; admission: AnyRecord } {
  const candidate = checkpoint.events.find((event: any) => event.type === 'ClaimPublished' && event.claim === 'proof.candidate@1' && event.scope.length === 1) as AnyRecord | undefined;
  const admission = checkpoint.events.find((event: any) => event.type === 'ClaimPublished' && event.claim === 'proof.admitted_receipt@1' && event.scope.length === 1) as AnyRecord | undefined;
  if (!candidate || !admission) throw new Error('discovery candidate/admission missing');
  return { candidate, admission };
}

function proofRefresh(binary: string, workspace: string, checkpoint: AnyRecord, config: AnyRecord): AnyRecord {
  const { candidate, admission } = candidateAndAdmission(checkpoint);
  const candidatePayload = typeof candidate.payload === 'string' ? JSON.parse(candidate.payload) : candidate.payload;
  const admissionPayload = typeof admission.payload === 'string' ? JSON.parse(admission.payload) : admission.payload;
  const revalidation = proofInvoke(binary, workspace, ['onboarding', 'revalidate'], proofCanonicalJson({ version: 'proof.catalog-revalidation-request/v2', candidate: candidatePayload, admission: JSON.parse(admissionPayload.__proof_admission_wire) }));
  const revalidationBytes = proofCanonicalJson(revalidation);
  const workItemsRequest = `{"version":${proofCanonicalJson('proof.onboarding-work-items-request/v1')},"candidate":${proofCanonicalJson(candidatePayload)},"admission":${admissionPayload.__proof_admission_wire},"revalidation_receipt":${proofCanonicalJson(revalidation.receipt)}}`;
  const workItems = proofInvoke(binary, workspace, ['onboarding', 'work-items'], workItemsRequest);
  const workItemsBytes = proofCanonicalJson(workItems);
  const before = componentProjection(checkpoint, config);
  const priorItems = Object.values(before.claimsById).filter((value: any) => value.claim === 'component.work_item@1' && value.active && value.scope.length === 2).map((value: any) => value.payload);
  const candidateView = { ...candidate, provenance: 'attempt', proofAdmission: candidate.proofCandidateEvidence, wireMode: candidate.wireMode };
  const validated = validateProofCurrentCatalogAuthorityBytes({ revalidationBytesBase64: Buffer.from(revalidationBytes).toString('base64'), workItemsBytesBase64: Buffer.from(workItemsBytes).toString('base64'), candidate: candidateView, admission: { ...admission, provenance: 'attempt' } } as any);
  const priorById = new Map(priorItems.map(item => [item.component_id, item]));
  const changed = validated.items.filter((item: AnyRecord) => canonicalJson(priorById.get(item.component_id)) !== canonicalJson(item));
  if (changed.length !== 1) throw new Error('Proof affected set is not exactly one component');
  return { revalidationBytes, workItemsBytes, changedComponentId: String(changed[0].component_id), changedPaths: changed[0].sorted_owned_paths };
}

function childEnvironment(): NodeJS.ProcessEnv { return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(API_KEY|ACCESS_TOKEN|SECRET|PASSWORD|EVALUATOR|SUBJECT)/i.test(key))); }

function childProcess(mode: 'discovery' | 'pause' | 'resume' | 'replacement', stage: string): ChildResult {
  const timeout = mode === 'discovery' ? DISCOVERY_TIMEOUT_MS : COMPONENT_TIMEOUT_MS;
  const result = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', CHILD_ENTRY, '--child', mode, '--output', stage, '--controller-pid', String(process.pid)], { cwd: REPO_ROOT, env: childEnvironment(), encoding: 'utf8', timeout, maxBuffer: 128 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`live child ${mode} failed`);
  return JSON.parse(fs.readFileSync(path.join(stage, '.private', `${mode}.result.json`), 'utf8')) as ChildResult;
}

type FocusedDerivation = Readonly<{
  checkpoint: AnyRecord;
  checkpointBytes: Buffer;
  execution: AnyRecord;
  authority: AnyRecord;
  onboardingStage: AnyRecord;
  binding: AnyRecord;
  historicalTermination: AnyRecord;
}>;

function focusedCheckpointBytes(): Buffer {
  const bytes = fs.readFileSync(FOCUSED_CHECKPOINT);
  if (sha256(bytes) !== FOCUSED_CHECKPOINT_SHA256) throw new Error('focused checkpoint pin does not match');
  return bytes;
}

function focusedUpstreamPreflightReceipt(): AnyRecord {
  const bytes = fs.readFileSync(FOCUSED_PREFLIGHT);
  if (sha256(bytes) !== FOCUSED_PREFLIGHT_SHA256) throw new Error('focused preflight receipt pin does not match');
  const receipt = JSON.parse(bytes.toString('utf8')) as AnyRecord;
  if (receipt.schema !== 'urn:reqproof:agent-governance:exp-0210-live-preflight:v1' || receipt.status !== 'passed' || receipt.mode !== 'preflight-only' || receipt.governed_calls !== 0 || receipt.model_calls !== 0 || receipt.retries !== 0 || receipt.fallback !== false || receipt.graph?.semantic_digest !== FOCUSED_GRAPH_DIGEST || receipt.pins?.proof_commit !== PROOF_COMMIT || receipt.pins?.probe_version !== PROBE_VERSION || receipt.pins?.codex_version !== CODEX_VERSION || receipt.pins?.profile_id !== PROFILE_ID || canonicalJson(receipt.pins?.probe_tools) !== canonicalJson([...PROBE_TOOLS])) throw new Error('focused preflight receipt is not an exact zero-call pin');
  return { sha256: `sha256:${FOCUSED_PREFLIGHT_SHA256}`, graph_semantic_digest: receipt.graph.semantic_digest };
}

function focusedAuthorizationReceipt(): AnyRecord {
  const file = process.env.VISOR_EXP0210_FOCUSED_PREFLIGHT_PATH;
  const expected = process.env.VISOR_EXP0210_FOCUSED_PREFLIGHT_SHA256?.replace(/^sha256:/, '');
  if (!file || !path.isAbsolute(file) || !expected || !/^[0-9a-f]{64}$/.test(expected)) throw new Error('focused diagnostic preflight path and exact SHA-256 pin are required');
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== expected) throw new Error('focused diagnostic preflight authorization pin does not match');
  const receipt = JSON.parse(bytes.toString('utf8')) as AnyRecord;
  const expectedHead = process.env.VISOR_EXP0210_EXPECTED_VISOR_HEAD;
  const expectedYaml = process.env.VISOR_EXP0210_EXPECTED_YAML_SHA256;
  const expectedRunner = process.env.VISOR_EXP0210_EXPECTED_RUNNER_SHA256;
  const pins = receipt.pins;
  const frozenPinsValid = !!pins && pins.visor_base === VISOR_COMMIT && typeof expectedHead === 'string' && pins.visor_head === expectedHead && pins.frozen_head === expectedHead && pins.visor_clean === true && typeof pins.repo_status_digest === 'string' && /^[0-9a-f]{64}$/.test(pins.repo_status_digest) && typeof expectedYaml === 'string' && pins.yaml_sha256 === expectedYaml && typeof expectedRunner === 'string' && pins.runner_sha256 === expectedRunner;
  const codex = receipt.codex;
  const codexEvidence = !!codex && codex.version === CODEX_VERSION && codex.required_version === CODEX_VERSION && codex.login_verified === true;
  if (receipt.schema !== 'urn:reqproof:agent-governance:exp-0210-focused-diagnostic-preflight:v1' || receipt.status !== 'passed' || receipt.mode !== 'focused-diagnostic-preflight' || receipt.governed_calls !== 0 || receipt.model_calls !== 0 || receipt.network_dispatches_requested !== 0 || receipt.retries !== 0 || receipt.fallback !== false || receipt.schema_paths !== FOCUSED_SCHEMA_PATHS || !frozenPinsValid || !codexEvidence || receipt.pins?.proof_commit !== PROOF_COMMIT || receipt.pins?.probe_version !== PROBE_VERSION || receipt.pins?.codex_version !== CODEX_VERSION || receipt.pins?.profile_id !== PROFILE_ID || canonicalJson(receipt.pins?.probe_tools) !== canonicalJson([...PROBE_TOOLS]) || receipt.derivation?.checkpoint_sha256 !== `sha256:${FOCUSED_CHECKPOINT_SHA256}` || receipt.derivation?.graph_semantic_digest !== FOCUSED_GRAPH_DIGEST || canonicalJson(receipt.derivation?.aliases) !== canonicalJson(['admission', 'candidate', 'component']) || receipt.preflight_receipt?.sha256 !== `sha256:${FOCUSED_PREFLIGHT_SHA256}`) throw new Error('focused diagnostic preflight authorization is not an exact zero-call pin');
  const resolution = receipt.spec_review_resolution;
  if (!resolution || resolution.role_id !== 'spec-review' || resolution.stage_id !== 'spec_review' || typeof resolution.invocation_digest !== 'string' || typeof resolution.output_schema_id !== 'string' || typeof resolution.output_schema_digest !== 'string') throw new Error('focused diagnostic preflight lacks pinned spec-review resolution');
  return { sha256: `sha256:${expected}`, graph_semantic_digest: receipt.derivation.graph_semantic_digest, derivation: receipt.derivation, spec_review_resolution: resolution, codex: { version: CODEX_VERSION, required_version: CODEX_VERSION, login_verified: true } };
}

function consumeFocusedCapability(file: string, expectedDigest: string, derivation: FocusedDerivation): void {
  const consumed = `${file}.consumed.${process.pid}`;
  try {
    fs.renameSync(file, consumed);
    const value = JSON.parse(fs.readFileSync(consumed, 'utf8')) as AnyRecord;
    if (sha256(canonicalJson(value)) !== expectedDigest || value.version !== 'urn:reqproof:agent-governance:exp-0210-focused-capability:v1' || value.checkpoint_sha256 !== `sha256:${FOCUSED_CHECKPOINT_SHA256}` || value.node_generation_id !== derivation.execution.generation.nodeGenerationId || typeof value.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(value.nonce)) throw new Error('focused parent capability is invalid');
  } catch (error) {
    if (error instanceof Error && error.message === 'focused parent capability is invalid') throw error;
    throw new Error('focused parent capability was already consumed');
  } finally {
    try { fs.unlinkSync(consumed); } catch { /* A failed rename leaves no capability to clean. */ }
  }
}

function focusedBindingSummary(binding: AnyRecord): AnyRecord {
  return {
    session_id: safeDiagnosticId(binding.sessionId) || 'unknown',
    check_id: safeDiagnosticId(binding.checkId) || 'unknown',
    attempt_id: safeDiagnosticId(binding.attemptId) || 'unknown',
    fence: Number.isSafeInteger(binding.fence) ? binding.fence : null,
    node_instance_id: safeDiagnosticId(binding.nodeInstanceId) || 'unknown',
    node_generation_id: safeDiagnosticId(binding.nodeGenerationId) || 'unknown',
    scope_digest: `sha256:${sha256(canonicalJson(binding.scope))}`,
  };
}

function focusedManagedRequest(derivation: FocusedDerivation, workingDirectory: string): AnyRecord {
  const generation = derivation.execution.generation as AnyRecord;
  return {
    prInfo: PR,
    checkConfig: derivation.execution.node.check,
    dependencyResults: new Map(Object.entries(derivation.execution.claims).map(([alias, claim]: [string, AnyRecord]) => [alias, { issues: [], output: claim.payload }])),
    executionContext: {
      claims: derivation.execution.claims,
      nodeInstanceId: generation.nodeInstanceId,
      nodeGenerationId: generation.nodeGenerationId,
      scope: generation.scope,
      proofComponentAuthority: derivation.authority,
      proofOnboardingStageContext: derivation.onboardingStage,
    },
    binding: derivation.binding,
    executionConfigDigest: generation.executionConfigDigest,
    workingDirectory,
  };
}

type FocusedBoundaryCounters = { process: number; network: number; answer: number };
type FocusedBoundarySequence = { value: number };

function markFocusedBoundary(timeline: AnyRecord[], sequence: FocusedBoundarySequence, event: string, status: string, extra?: AnyRecord): void {
  timeline.push({ event, status, sequence: sequence.value++, ...(extra || {}) });
}

function installFocusedBoundaryInstrumentation(binary: string, timeline: AnyRecord[], counters: FocusedBoundaryCounters, sequence: FocusedBoundarySequence): () => void {
  const restores: Array<() => void> = [];
  let restored = false;
  let runnerBoundaryObserved = false;
  const mark = (event: string, status: string): void => { markFocusedBoundary(timeline, sequence, event, status); };
  const restoreAll = (): void => {
    const pending = restores.splice(0).reverse();
    let firstError: unknown;
    for (const restore of pending) {
      try { restore(); } catch (error) { firstError ||= error; }
    }
    if (firstError) throw firstError;
  };
  const patch = (target: AnyRecord, name: string, replacement: Function, mandatory = true): void => {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (!descriptor || typeof descriptor.value !== 'function') {
      if (mandatory) throw new Error('focused boundary method is unavailable');
      return;
    }
    Object.defineProperty(target, name, { ...descriptor, value: replacement });
    if (Object.getOwnPropertyDescriptor(target, name)?.value !== replacement) throw new Error('focused boundary patch was not installed');
    restores.push(() => Object.defineProperty(target, name, descriptor));
  };
  const wrap = (target: AnyRecord, name: string, event: string): void => {
    const original = Object.getOwnPropertyDescriptor(target, name)?.value;
    if (typeof original !== 'function') throw new Error('focused boundary method is unavailable');
    patch(target, name, function (this: unknown, ...args: unknown[]): unknown {
      if ((event === 'runner_preview' || event === 'runner_answer') && !runnerBoundaryObserved) {
        runnerBoundaryObserved = true;
        mark('runner_construction', 'observed');
        mark('proof_resolution', 'completed');
        mark('provider_acquisition', 'completed');
      }
      mark(event, 'entered');
      try {
        const result = Reflect.apply(original, this, args);
        if (result && typeof (result as AnyRecord).then === 'function') {
          return Promise.resolve(result).then(value => { mark(event, 'completed'); return value; }, error => { mark(event, 'failed'); throw error; });
        }
        mark(event, 'completed');
        return result;
      } catch (error) {
        mark(event, 'failed');
        throw error;
      }
    }, true);
  };
  const answerBlock = function (): never { counters.answer += 1; mark('probe_answer_governed', 'blocked'); throw FOCUSED_ANSWER_SENTINEL; };
  const forbiddenBlock = (event: string, kind: keyof FocusedBoundaryCounters, sentinel: Error): Function => function (): never {
    counters[kind] += 1;
    mark(event, 'blocked');
    throw sentinel;
  };
  try {
    const probe = requireFromRepo('@probelabs/probe') as AnyRecord;
    const probePrototype = probe.ProbeAgent?.prototype as AnyRecord | undefined;
    if (!probePrototype) throw new Error('ProbeAgent prototype is unavailable');
    wrap(probePrototype, 'initialize', 'probe_initialize');
    wrap(probePrototype, 'previewGovernedAnswerDispatch', 'probe_preview');
    patch(probePrototype, 'answerGoverned', answerBlock, true);
    if (Object.getOwnPropertyDescriptor(probePrototype, 'answerGoverned')?.value !== answerBlock) throw new Error('focused answer guard was not installed');
    const { GovernedProbeAgentRunner } = require('../../../src/providers/governed-probe-runner') as typeof import('../../../src/providers/governed-probe-runner');
    const runnerPrototype = GovernedProbeAgentRunner.prototype as AnyRecord;
    wrap(runnerPrototype, 'preview', 'runner_preview');
    wrap(runnerPrototype, 'answer', 'runner_answer');
    wrap(runnerPrototype, 'close', 'runner_close');

    const childProcess = require('node:child_process') as AnyRecord;
    const proofPath = fs.realpathSync(binary);
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
      const original = Object.getOwnPropertyDescriptor(childProcess, name)?.value;
      if (typeof original !== 'function') continue;
      patch(childProcess, name, function (this: unknown, ...args: unknown[]): unknown {
        let command = '';
        try { command = typeof args[0] === 'string' ? fs.realpathSync(args[0]) : ''; } catch { /* Treat an unresolvable executable as forbidden. */ }
        const childArgs = Array.isArray(args[1]) ? args[1].map(value => String(value)) : [];
        if (command === proofPath && canonicalJson(childArgs) === canonicalJson(['resolve-role-invocation'])) return Reflect.apply(original, this, args);
        return forbiddenBlock('process_guard', 'process', FOCUSED_PROCESS_SENTINEL)();
      }, true);
    }
    const networkModules: Array<[AnyRecord, string[]]> = [
      [require('node:http'), ['request', 'get']], [require('node:https'), ['request', 'get']],
      [require('node:net'), ['connect', 'createConnection']], [require('node:tls'), ['connect']],
    ];
    for (const [network, names] of networkModules) for (const name of names) patch(network, name, forbiddenBlock('network_guard', 'network', FOCUSED_NETWORK_SENTINEL), true);
    patch(globalThis as AnyRecord, 'fetch', forbiddenBlock('fetch_guard', 'network', FOCUSED_NETWORK_SENTINEL), true);
    return () => {
      if (restored) return;
      restored = true;
      restoreAll();
    };
  } catch (error) {
    try { restoreAll(); } catch { /* Attempt every partial restoration before surfacing installation failure. */ }
    throw error;
  }
}

function deriveFocusedSpecReview(config: VisorConfig, checkpointBytes = focusedCheckpointBytes()): FocusedDerivation {
  const checkpoint = JSON.parse(checkpointBytes.toString('utf8')) as AnyRecord;
  if (checkpoint.graphSemanticDigest !== FOCUSED_GRAPH_DIGEST) throw new Error('focused checkpoint graph digest is not pinned');
  const claimPlan = compileClaimPlan(config);
  if (claimPlan.expansionPlan.graphSemanticDigest !== FOCUSED_GRAPH_DIGEST) throw new Error('focused effective config graph digest is not pinned');
  const journal = ExecutionJournal.restoreGraphCheckpoint(claimPlan, checkpoint);
  const projection = journal.getInstanceProjection() as AnyRecord;
  const failed = Object.values(projection.generationsById).filter((value: any) =>
    value.checkId === 'spec_review' && value.templateNodeKey === 'spec_review' && value.status === 'failed' &&
    value.scope?.length === 2 && value.scope?.at(-1)?.key === 'parser-core') as AnyRecord[];
  if (failed.length !== 1) throw new Error('focused parser-core spec_review generation is not unique');
  const execution = journal.getGeneratedExecution(failed[0].nodeGenerationId) as AnyRecord;
  if (JSON.stringify(Object.keys(execution.claims).sort()) !== JSON.stringify(['admission', 'candidate', 'component'])) throw new Error('focused generated aliases are not exact');
  const authority = journal.getProofComponentInvocationAuthority(failed[0].nodeGenerationId) as AnyRecord;
  const onboardingStage = journal.getProofComponentOnboardingStageContext(failed[0].nodeGenerationId) as AnyRecord;
  const terminations = checkpoint.events.filter((event: any) =>
    event.type === 'ManagedRunTerminated' && event.binding?.nodeGenerationId === failed[0].nodeGenerationId &&
    event.binding?.checkId === 'spec_review') as AnyRecord[];
  const acquired = checkpoint.events.filter((event: any) =>
    event.type === 'ManagedRunAcquired' && event.binding?.nodeGenerationId === failed[0].nodeGenerationId &&
    event.binding?.checkId === 'spec_review') as AnyRecord[];
  if (acquired.length !== 1 || terminations.length !== 1 || canonicalJson(acquired[0].binding) !== canonicalJson(terminations[0].binding)) throw new Error('focused historical managed binding is not unique');
  if (terminations[0].cleanupStatus !== 'clean' || terminations[0].controllerDecision !== 'failed') throw new Error('focused historical termination is not a clean failure');
  return Object.freeze({ checkpoint, checkpointBytes, execution, authority, onboardingStage, binding: acquired[0].binding, historicalTermination: terminations[0] });
}

function safeFocusedError(error: unknown): AnyRecord {
  const name = ownData(error, 'name');
  const allowed = new Set(['Error', 'TypeError', 'RangeError', 'AbortError', 'TimeoutError']);
  return { error_class: typeof name === 'string' && allowed.has(name) ? name : 'unknown' };
}

function safeFocusedAttestation(value: unknown): AnyRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const att = value as AnyRecord;
  const requested = att.requested;
  const observed = att.observed;
  const dispatch = att.dispatch;
  const pick = (record: AnyRecord | undefined, keys: readonly string[]): AnyRecord | undefined => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined;
    const result: AnyRecord = {};
    for (const key of keys) if (typeof record[key] === 'string' || typeof record[key] === 'number' || typeof record[key] === 'boolean') result[key] = record[key];
    return Object.keys(result).length > 0 ? result : undefined;
  };
  return {
    version: typeof att.version === 'string' ? att.version : 'unknown',
    profile_id: safeDiagnosticId(att.profileId) || 'unknown',
    requested: pick(requested, ['profileDigest', 'cwdDigest', 'probeToolsDigest', 'model', 'reasoningEffort', 'sandbox', 'approvalPolicy']),
    observed: pick(observed, ['source', 'model', 'modelProviderId', 'reasoningEffort', 'approvalPolicy', 'cwdDigest', 'permissionProfileDigest', 'filesystem', 'network']),
    dispatch: pick(dispatch, ['source', 'tool', 'promptDigest', 'promptBytes']),
    usage: pick(att.usage, ['status']),
  };
}

function focusedOutcomeSummary(outcome: unknown, error?: unknown): AnyRecord {
  if (error) return { status: 'provider_failed', ...safeFocusedError(error), failure_taxonomy: sanitizeProbeFailureTaxonomy(error) };
  if (!outcome || typeof outcome !== 'object') return { status: 'provider_failed', error_class: 'unknown' };
  const value = outcome as AnyRecord;
  if (value.kind !== 'succeeded-proof-candidate') return { status: typeof value.kind === 'string' ? value.kind : 'provider_failed' };
  const evidence = value.proofCandidateEvidence as AnyRecord;
  validateProofCandidateEvidence(evidence);
  const identity = evidence.probe?.resultIdentity as AnyRecord;
  return {
    status: 'succeeded-proof-candidate', wire_mode: value.wireMode,
    invocation_digest: safeDiagnosticId(evidence.role?.invocationDigest) || 'unknown',
    result_identity: { version: identity.version, source: identity.source, result_digest: identity.resultDigest, canonical_bytes: identity.canonicalBytes },
    attestation: safeFocusedAttestation(evidence.probe?.attestation),
  };
}

function focusedChildStream(value: unknown): AnyRecord {
  const bytes = Buffer.from(String(value || ''), 'utf8');
  const control = bytes.toString('utf8').trim();
  return { byte_count: bytes.length, sha256: `sha256:${sha256(bytes)}`, truncated: bytes.length > 4096, control_line: control === 'EXP-0210 focused child completed' || control === 'EXP-0210 focused child failed' ? control : null };
}

function focusedChildProcess(stage: string): AnyRecord {
  const result = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', CHILD_ENTRY, '--child', 'focused-spec-review', '--output', stage, '--controller-pid', String(process.pid)], { cwd: REPO_ROOT, env: childEnvironment(), encoding: 'utf8', timeout: FOCUSED_CHILD_TIMEOUT_MS, maxBuffer: 128 * 1024 * 1024 });
  const streams = { stdout: focusedChildStream(result.stdout), stderr: focusedChildStream(result.stderr) };
  if (result.error || result.status !== 0) {
    writePrivateJson(path.join(stage, '.private', 'focused-child-streams.json'), streams);
    throw new Error('focused diagnostic child failed');
  }
  const file = path.join(stage, '.private', 'focused-spec-review.result.json');
  return { ...JSON.parse(fs.readFileSync(file, 'utf8')) as AnyRecord, child_streams: streams };
}

function focusedDerivationSummary(derivation: FocusedDerivation): AnyRecord {
  const generation = derivation.execution.generation as AnyRecord;
  const claims = derivation.execution.claims as AnyRecord;
  return {
    checkpoint_sha256: `sha256:${sha256(derivation.checkpointBytes)}`,
    graph_semantic_digest: derivation.checkpoint.graphSemanticDigest,
    session_id: safeDiagnosticId(derivation.checkpoint.sessionId) || 'unknown',
    node_generation_id: safeDiagnosticId(generation.nodeGenerationId) || 'unknown',
    node_instance_id: safeDiagnosticId(generation.nodeInstanceId) || 'unknown',
    component_id: safeDiagnosticId(derivation.authority.subject?.component_id) || 'unknown',
    aliases: Object.keys(claims).sort(),
    claim_ids: Object.fromEntries(Object.entries(claims).map(([alias, value]: [string, any]) => [alias, safeDiagnosticId(value.claimId) || 'unknown'])),
    authority_digest: `sha256:${sha256(proofCanonicalJson(derivation.authority))}`,
    onboarding_stage_digest: `sha256:${sha256(proofCanonicalJson(derivation.onboardingStage))}`,
    historical_binding: focusedBindingSummary(derivation.binding),
    historical_termination: {
      controller_decision: derivation.historicalTermination.controllerDecision === 'failed' ? 'failed' : 'unknown',
      cleanup_status: derivation.historicalTermination.cleanupStatus === 'clean' ? 'clean' : 'unknown',
      failure_code: derivation.historicalTermination.failureCode === 'MANAGED_OUTCOME_FAILED' ? 'MANAGED_OUTCOME_FAILED' : 'unknown',
    },
  };
}

function focusedDiagnosticPreflightReport(prepared: Prepared, derivation: FocusedDerivation, receipt: AnyRecord, specReviewResolution: AnyRecord): AnyRecord {
  return {
    schema: 'urn:reqproof:agent-governance:exp-0210-focused-diagnostic-preflight:v1',
    status: 'passed', mode: 'focused-diagnostic-preflight', governed_calls: 0, model_calls: 0,
    network_dispatches_requested: 0, retries: 0, fallback: false, schema_paths: FOCUSED_SCHEMA_PATHS,
    pins: { ...prepared.pins, proof_commit: PROOF_COMMIT, probe_version: PROBE_VERSION, codex_version: CODEX_VERSION, profile_id: PROFILE_ID, probe_tools: [...PROBE_TOOLS] }, preflight_receipt: receipt,
    codex: { version: prepared.preflight.codex?.version, required_version: CODEX_VERSION, login_verified: prepared.preflight.codex?.login_verified === true },
    derivation: focusedDerivationSummary(derivation),
    spec_review_resolution: specReviewResolution,
    evidence: 'preflight restored the retained checkpoint and constructed no provider, Probe agent, or model dispatch',
  };
}

async function runFocusedDiagnosticPreflight(outputDirectory: string): Promise<AnyRecord> {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-exp0210-focused-preflight-')); fs.chmodSync(stage, 0o700);
  try {
    const receipt = focusedUpstreamPreflightReceipt();
    const prepared = prepare(stage, true, true);
    const checkpointBytes = focusedCheckpointBytes();
    verifyFocusedBaselineLineage(prepared.proofBinary, prepared.baselineWorkspace, JSON.parse(checkpointBytes.toString('utf8')) as AnyRecord);
    resolveHistoricalProjectRole(prepared.proofBinary, prepared.baselineWorkspace, prepared.config, JSON.parse(checkpointBytes.toString('utf8')) as AnyRecord);
    if (compileClaimPlan(prepared.config).expansionPlan.graphSemanticDigest !== FOCUSED_GRAPH_DIGEST) throw new Error('focused effective config graph digest is not pinned');
    writePrivateJson(prepared.configPath, prepared.config);
    const derivation = deriveFocusedSpecReview(prepared.config, checkpointBytes);
    const specReviewResolution = await resolveFocusedSpecReviewRole(prepared.proofBinary, prepared.baselineWorkspace, derivation);
    const report = focusedDiagnosticPreflightReport(prepared, derivation, receipt, specReviewResolution);
    writePrivateJson(path.join(stage, 'focused-diagnostic-preflight.json'), report);
    cleanupPrivate(prepared);
    publish(stage, outputDirectory);
    return report;
  } catch (error) {
    failureReceipt(stage, 'FOCUSED_PREFLIGHT_FAILED', { governed_calls: 0, model_calls: 0, network_dispatches_requested: 0, completed_phases: [], checkpoint_evidence: [] }, 'preflight-only');
    fs.rmSync(path.join(stage, '.private'), { recursive: true, force: true });
    try { publish(stage, outputDirectory); } catch { fs.rmSync(stage, { recursive: true, force: true }); }
    throw error;
  }
}

function runFocusedDiagnosticOnce(outputDirectory: string): AnyRecord {
  const stage = claimRunOutput(outputDirectory);
  try {
    writeExclusiveJson(path.join(stage, 'focused-diagnostic.started.json'), { schema: 'urn:reqproof:agent-governance:exp-0210-focused-diagnostic-started:v1', status: 'started', mode: 'focused-diagnostic-run-once', retries: 0, fallback: false });
    const preflightReceipt = focusedAuthorizationReceipt();
    const prepared = prepare(stage, true, true);
    const checkpointBytes = focusedCheckpointBytes();
    verifyFocusedBaselineLineage(prepared.proofBinary, prepared.baselineWorkspace, JSON.parse(checkpointBytes.toString('utf8')) as AnyRecord);
    resolveHistoricalProjectRole(prepared.proofBinary, prepared.baselineWorkspace, prepared.config, JSON.parse(checkpointBytes.toString('utf8')) as AnyRecord);
    if (compileClaimPlan(prepared.config).expansionPlan.graphSemanticDigest !== FOCUSED_GRAPH_DIGEST) throw new Error('focused effective config graph digest is not pinned');
    writePrivateJson(prepared.configPath, prepared.config);
    const derivation = deriveFocusedSpecReview(prepared.config, checkpointBytes);
    if (canonicalJson(focusedDerivationSummary(derivation)) !== canonicalJson(preflightReceipt.derivation)) throw new Error('focused diagnostic preflight derivation is detached');
    const checkpointFile = path.join(prepared.privateDir, 'focused.checkpoint.json');
    fs.writeFileSync(checkpointFile, checkpointBytes, { mode: 0o600 }); fs.chmodSync(checkpointFile, 0o600);
    const capabilityFile = path.join(prepared.privateDir, 'focused-capability.json');
    const capability = { version: 'urn:reqproof:agent-governance:exp-0210-focused-capability:v1', nonce: randomBytes(32).toString('hex'), checkpoint_sha256: `sha256:${FOCUSED_CHECKPOINT_SHA256}`, node_generation_id: derivation.execution.generation.nodeGenerationId };
    writeExclusiveJson(capabilityFile, capability);
    writePrivateJson(path.join(prepared.privateDir, 'focused-input.json'), { configPath: prepared.configPath, proofBinary: prepared.proofBinary, workingDirectory: prepared.baselineWorkspace, checkpointFile, capabilityFile, capabilityDigest: sha256(canonicalJson(capability)), preflightReceiptSha256: preflightReceipt.sha256 });
    const child = focusedChildProcess(stage);
    if (child.preflight_receipt_sha256 !== preflightReceipt.sha256 || child.checkpoint_sha256_before !== `sha256:${FOCUSED_CHECKPOINT_SHA256}` || child.checkpoint_sha256_after !== child.checkpoint_sha256_before) throw new Error('focused child is detached from retained preflight/checkpoint');
    if (child.graph_semantic_digest !== FOCUSED_GRAPH_DIGEST || child.node_generation_id !== derivation.execution.generation.nodeGenerationId) throw new Error('focused child derivation is detached');
    const report = {
      schema: 'urn:reqproof:agent-governance:exp-0210-focused-diagnostic:v1', status: child.status, mode: 'focused-diagnostic-run-once',
      retries: 0, fallback: false, schema_paths: FOCUSED_SCHEMA_PATHS, pins: { ...prepared.pins, proof_commit: PROOF_COMMIT, probe_version: PROBE_VERSION, codex_version: CODEX_VERSION, profile_id: PROFILE_ID, probe_tools: [...PROBE_TOOLS] },
      derivation: focusedDerivationSummary(derivation), preflight_receipt: preflightReceipt, timeline: child.timeline, call_ledger: child.call_ledger,
      outcome: child.outcome, child_streams: child.child_streams,
    };
    writePrivateJson(path.join(stage, 'focused-diagnostic-report.json'), report);
    writePrivateText(path.join(stage, 'focused-diagnostic-report.md'), `# EXP-0210 focused spec-review diagnostic\n\nStatus: ${String(child.status)}\nSchema paths: ${FOCUSED_SCHEMA_PATHS}\nRetries: 0\nFallback: false\n`);
    writeExclusiveJson(path.join(stage, 'focused-diagnostic.completed.json'), { schema: 'urn:reqproof:agent-governance:exp-0210-focused-diagnostic-completed:v1', status: 'completed', mode: 'focused-diagnostic-run-once', retries: 0, fallback: false });
    cleanupPrivate(prepared);
    return report;
  } catch (error) {
    failureReceipt(stage, 'FOCUSED_RUN_FAILED');
    fs.rmSync(path.join(stage, '.private'), { recursive: true, force: true });
    throw error;
  }
}

function validateRun(prepared: Prepared, pause: ChildResult, resumed: ChildResult, replacement: ChildResult): AnyRecord {
  const pauseView = componentProjection(pause.checkpoint, prepared.config);
  const resumedView = componentProjection(resumed.checkpoint, prepared.config);
  const finalView = componentProjection(replacement.checkpoint, prepared.config);
  const ids = componentIds(pauseView);
  if (ids.length < 2 || ids.length > MAX_COMPONENTS) throw new Error('discovery component count is outside the live bound');
  const selection = authenticatedWorkItems(pause.checkpoint, prepared.config, false);
  if (canonicalJson(selection.componentIds) !== canonicalJson(ids) || pause.held_component_id !== selection.heldComponentId) throw new Error('pause WorkItem selection is detached from the checkpoint');
  const complete = ids.filter(id => STAGES.every(stage => generationsFor(pauseView, id).some(value => value.checkId === stage && value.status === 'completed')));
  const ready = ids.filter(id => generationsFor(pauseView, id).some(value => value.checkId === 'inspect' && value.status === 'ready'));
  if (complete.length !== ids.length - 1 || ready.length !== 1 || ready[0] !== pause.held_component_id) throw new Error('pause did not retain one ready component frontier');
  if (resumed.checkpoint.sessionId !== pause.checkpoint.sessionId || resumed.checkpoint.graphSemanticDigest !== pause.checkpoint.graphSemanticDigest) throw new Error('resume changed session or graph digest');
  if (canonicalGraphCheckpointJson(resumed.checkpoint.events.slice(0, pause.checkpoint.events.length)) !== canonicalGraphCheckpointJson(pause.checkpoint.events)) throw new Error('resume changed the checkpoint prefix');
  if (ids.some(id => !STAGES.every(stage => generationsFor(resumedView, id).some(value => value.checkId === stage && value.status === 'completed')))) throw new Error('resume did not complete the held component');
  const changed = String(replacement.refreshed?.changedComponentId || '');
  const changedOwnerPaths = (replacement.refreshed?.changedPaths || []).map(String);
  if (!changed || changed !== selection.changedComponentId || !complete.includes(changed) || !changedOwnerPaths.includes('parser.go') || !changedOwnerPaths.includes('parser_test.go')) throw new Error('Proof affected WorkItem owner is invalid');
  const replacementSuffix = replacement.checkpoint.events.slice(resumed.checkpoint.events.length).filter((event: any) => event.type === 'AttemptStarted');
  const changedInstance = Object.values(finalView.instancesById).find((value: any) => value.itemKey === changed) as AnyRecord | undefined;
  const changedAttempts = replacementSuffix.filter((event: any) => event.scope?.length === 2 && event.scope?.at(-1)?.key === changed && event.scope?.some((scope: any) => scope.subgraphInstanceId === changedInstance?.subgraphInstanceId));
  const reconcileAttempts = replacementSuffix.filter((event: any) => event.checkId === 'project_reconcile' && event.scope?.length === 1);
  if (changedAttempts.length !== STAGES.length || changedAttempts.map((event: any) => event.checkId).sort().join(',') !== [...STAGES].sort().join(',')) throw new Error('replacement did not run exactly the staged cascade');
  if (reconcileAttempts.length !== 1 || replacementSuffix.length !== STAGES.length + 1 || replacementSuffix.some(event => !changedAttempts.includes(event) && !reconcileAttempts.includes(event))) throw new Error('replacement attempt remainder is not exactly A plus reconciliation');
  for (const sibling of ids.filter(id => id !== changed)) {
    const beforeClaims = Object.values(resumedView.claimsById).filter((value: any) => value.scope?.at(-1)?.key === sibling).sort((a: any, b: any) => a.claimId.localeCompare(b.claimId));
    const afterClaims = Object.values(finalView.claimsById).filter((value: any) => value.scope?.at(-1)?.key === sibling).sort((a: any, b: any) => a.claimId.localeCompare(b.claimId));
    if (canonicalJson(beforeClaims) !== canonicalJson(afterClaims)) throw new Error('replacement changed an unrelated claim projection');
  }
  const stagedCandidate = Object.values(finalView.claimsById).filter((value: any) => value.claim === 'proof.component_spec_review_candidate@1' && value.active && value.scope?.at(-1)?.key === changed) as AnyRecord[];
  const stagedReceipt = Object.values(finalView.claimsById).filter((value: any) => value.claim === 'proof.component_spec_review_admitted_receipt@1' && value.active && value.scope?.at(-1)?.key === changed) as AnyRecord[];
  const verify = generationsFor(finalView, changed).find(value => value.checkId === 'verify' && value.status === 'completed') as AnyRecord | undefined;
  if (stagedCandidate.length !== 1 || stagedReceipt.length !== 1 || stagedCandidate[0].parentClaimIds.length !== 3 || stagedReceipt[0].parentClaimIds.length !== 1 || !verify || verify.activeInputClaimIds.length !== 4) throw new Error('staged receipt or four-input verify evidence is invalid');
  const attestedEvents = replacement.checkpoint.events.filter((event: any) => event.type === 'ClaimPublished' && event.proofCandidateEvidence);
  const expectedAttestations = 1 + 2 * ids.length + 2;
  if (attestedEvents.length !== expectedAttestations) throw new Error('governed Probe candidate evidence count is invalid');
  const expectedToolDigest = sha256(canonicalJson([...PROBE_TOOLS]));
  const stageCounts = new Map<string, number>();
  for (const event of attestedEvents) {
    validateProofCandidateEvidence(event.proofCandidateEvidence);
    const attestation = event.proofCandidateEvidence.probe.attestation;
    if (attestation.requested?.probeToolsDigest !== expectedToolDigest) throw new Error('governed Probe tool digest is not exact');
    const scope = event.scope || [];
    const key = scope.length === 1 ? 'project:inspect' : `${String(scope.at(-1)?.key || '')}:${String(event.checkId)}`;
    stageCounts.set(key, (stageCounts.get(key) || 0) + 1);
  }
  if (stageCounts.get('project:inspect') !== 1 || ids.some(id => {
    const expected = id === selection.changedComponentId ? 2 : 1;
    return stageCounts.get(`${id}:inspect`) !== expected || stageCounts.get(`${id}:spec_review`) !== expected;
  }) || stageCounts.size !== 1 + ids.length * 2) throw new Error('governed Probe stage/scope evidence is invalid');
  const managedTerminations = replacement.checkpoint.events.filter((event: any) => event.type === 'ManagedRunTerminated') as AnyRecord[];
  const sameBinding = (candidate: AnyRecord, lifecycle: AnyRecord): boolean => {
    const binding = lifecycle.binding;
    return !!binding && binding.sessionId === candidate.sessionId && binding.checkId === candidate.checkId && binding.attemptId === candidate.attemptId && binding.fence === candidate.fence && binding.nodeInstanceId === candidate.nodeInstanceId && binding.nodeGenerationId === candidate.nodeGenerationId && canonicalJson(binding.scope) === canonicalJson(candidate.scope);
  };
  for (const candidate of attestedEvents) {
    const candidateIndex = replacement.checkpoint.events.indexOf(candidate);
    const terminations = managedTerminations.filter(event => sameBinding(candidate, event));
    if (terminations.length !== 1) throw new Error('candidate evidence lacks exactly one bound managed termination');
    const termination = terminations[0];
    const terminationIndex = replacement.checkpoint.events.indexOf(termination);
    if (terminationIndex < 0 || terminationIndex >= candidateIndex || termination.cleanupStatus !== 'clean' || termination.controllerDecision !== 'completed' || termination.failureCode !== null) throw new Error('managed termination is not an earlier clean completion');
    const lifecycle = replacement.checkpoint.events.filter((event: any) => (event.type === 'ManagedRunStarted' || event.type === 'ManagedRunAcquired' || event.type === 'ManagedRunCancelRequested' || event.type === 'ManagedRunAcquisitionFailed') && sameBinding(candidate, event));
    if (lifecycle.filter(event => event.type === 'ManagedRunStarted').length !== 1 || lifecycle.filter(event => event.type === 'ManagedRunAcquired').length !== 1 || lifecycle.some(event => event.type === 'ManagedRunCancelRequested' || event.type === 'ManagedRunAcquisitionFailed')) throw new Error('managed lifecycle contains an unexpected binding event');
  }
  const pauseCalls = attemptCount(pause.checkpoint);
  const resumeCalls = suffixAttemptCount(resumed.checkpoint, pause.checkpoint.events.length);
  const replacementCalls = suffixAttemptCount(replacement.checkpoint, resumed.checkpoint.events.length);
  const expectedCalls = 1 + 2 * ids.length + 2;
  if (expectedCalls > MAX_CALLS || pauseCalls !== 1 + 2 * (ids.length - 1) || resumeCalls !== RESUME_CALLS || replacementCalls !== REPLACEMENT_CALLS || pauseCalls + resumeCalls + replacementCalls !== expectedCalls) throw new Error('live governed call budget mismatch');
  const restored = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(prepared.config), replacement.checkpoint);
  if (canonicalGraphCheckpointJson(restored.getInstanceProjection()) !== canonicalGraphCheckpointJson(restored.replayInstanceProjection()) || canonicalGraphCheckpointJson(restored.exportGraphCheckpoint(replacement.checkpoint.sessionId)) !== canonicalGraphCheckpointJson(replacement.checkpoint)) throw new Error('replacement restore/replay/re-export mismatch');
  return { component_count: ids.length, component_ids: ids, changed_component_id: changed, held_component_id: pause.held_component_id, governed_calls: expectedCalls, staged_candidate_parents: 3, staged_receipt_parents: 1, verify_inputs: 4 };
}

function catalogArtifacts(checkpoint: AnyRecord, config: AnyRecord): AnyRecord {
  const projection = componentProjection(checkpoint, config);
  const find = (claim: string, scope: number): AnyRecord => {
    const event = checkpoint.events.find((value: any) => value.type === 'ClaimPublished' && value.claim === claim && value.scope.length === scope) as AnyRecord | undefined;
    if (!event) throw new Error(`missing ${claim}`);
    return event;
  };
  const candidate = find('proof.candidate@1', 1);
  const admission = find('proof.admitted_receipt@1', 1);
  const revalidation = find('proof.catalog_revalidation@1', 1);
  const items = Object.values(projection.claimsById).filter((value: any) => value.claim === 'component.work_item@1' && value.active && value.scope.length === 2).map((value: any) => value.payload);
  return { candidate: candidate.payload, admission: admission.payload, revalidation: revalidation.payload, work_items: { version: 'proof.onboarding-work-item-projection/v1', work_items: items } };
}

function graphDot(config: AnyRecord): string {
  const edges = new Set<string>();
  const nodeId = (scope: string, check: string): string => `${scope.replace(/[^A-Za-z0-9_]/g, '_')}__${check.replace(/[^A-Za-z0-9_]/g, '_')}`;
  const add = (from: string, to: string): void => { edges.add(`${from} -> ${to};`); };
  for (const [scope, value] of Object.entries(config.subgraphs || {}).sort(([a], [b]) => a.localeCompare(b))) {
    const checks = (value as AnyRecord).checks || {};
    for (const [check, current] of Object.entries(checks)) {
      for (const dependency of (((current as AnyRecord).depends_on || []) as unknown[])) add(nodeId(scope, String(dependency)), nodeId(scope, check));
      for (const [producer, producerValue] of Object.entries(checks)) {
        const emissions = Array.isArray((producerValue as AnyRecord).emits) ? (producerValue as AnyRecord).emits : [];
        const consumes = Array.isArray((current as AnyRecord).consumes) ? (current as AnyRecord).consumes : [];
        if (emissions.some((item: AnyRecord) => consumes.some((input: AnyRecord) => input.claim === item.claim))) add(nodeId(scope, producer), nodeId(scope, check));
      }
      const expansion = (current as AnyRecord).expand;
      if (expansion?.template) add(nodeId(scope, check), `subgraph__${String(expansion.template).replace(/[^A-Za-z0-9_]/g, '_')}`);
    }
    for (const [check, current] of Object.entries(checks)) {
      const wait = (current as AnyRecord).wait_for_expansion;
      const owner = wait?.owner && checks[wait.owner]?.expand?.template;
      if (owner && wait.terminal_node) add(nodeId(String(owner), String(wait.terminal_node)), nodeId(scope, check));
    }
  }
  const projectChecks = (config.checks || {}) as AnyRecord;
  for (const [check, current] of Object.entries(projectChecks)) {
    const expansion = (current as AnyRecord).expand;
    if (expansion?.template) add(nodeId('project', check), `subgraph__${String(expansion.template).replace(/[^A-Za-z0-9_]/g, '_')}`);
  }
  return ['// Generated from effective Visor YAML.', 'digraph visor_exp0210 {', '  rankdir=LR;', '  graph [label="EXP-0210 live discovery, barrier, and staged reinspection"];', ...[...edges].sort().map(edge => `  ${edge}`), '}'].join('\n') + '\n';
}

function publicArtifacts(prepared: Prepared, stats: AnyRecord, pause: ChildResult, resumed: ChildResult, replacement: ChildResult, before: AnyRecord, after: AnyRecord): AnyRecord {
  const stage = prepared.stage;
  writePrivateJson(path.join(stage, 'baseline-source-manifest.json'), sourceManifest(prepared.baselineWorkspace, BASELINE_COMMIT));
  writePrivateJson(path.join(stage, 'fix-source-manifest.json'), sourceManifest(prepared.fixedWorkspace, FIX_COMMIT));
  const base = catalogArtifacts(pause.checkpoint, prepared.config);
  writePrivateJson(path.join(stage, 'inventory.json'), proofInvoke(prepared.proofBinary, prepared.baselineWorkspace, ['onboarding', 'inventory']));
  writePrivateJson(path.join(stage, 'candidate.json'), base.candidate);
  writePrivateJson(path.join(stage, 'admission.json'), base.admission);
  writePrivateJson(path.join(stage, 'revalidation.json'), base.revalidation);
  writePrivateJson(path.join(stage, 'work-items.json'), base.work_items);
  writePrivateText(path.join(stage, 'replacement-revalidation.json'), String(replacement.refreshed?.revalidationBytes || ''));
  writePrivateText(path.join(stage, 'replacement-work-items.json'), String(replacement.refreshed?.workItemsBytes || ''));
  writePrivateJson(path.join(stage, 'pause.checkpoint.json'), pause.checkpoint);
  writePrivateJson(path.join(stage, 'baseline.checkpoint.json'), resumed.checkpoint);
  writePrivateJson(path.join(stage, 'replacement.checkpoint.json'), replacement.checkpoint);
  fs.copyFileSync(PROFILE, path.join(stage, 'visor.yaml')); fs.chmodSync(path.join(stage, 'visor.yaml'), 0o600);
  writePrivateJson(path.join(stage, 'effective-config.json'), prepared.config);
  writePrivateText(path.join(stage, 'effective-config.yaml'), yaml.dump(prepared.config, { noRefs: true, sortKeys: true, lineWidth: -1 }));
  writePrivateText(path.join(stage, 'graph.dot'), graphDot(prepared.config));
  for (const format of ['svg', 'png']) {
    const rendered = spawnSync('dot', ['-T', format, path.join(stage, 'graph.dot'), '-o', path.join(stage, `graph.${format}`)], { encoding: 'utf8', timeout: 30_000 });
    if (rendered.status !== 0) throw new Error(`graph ${format} rendering failed`);
    fs.chmodSync(path.join(stage, `graph.${format}`), 0o600);
  }
  const report = {
    schema: 'urn:reqproof:agent-governance:exp-0210-jsonparser-staged-live:v1', status: 'passed', mode: 'run-once',
    execution_mode: 'real-governed-probe', attestation_evidence: 'probe-codex-attestation',
    proof_commit: PROOF_COMMIT, visor_base: VISOR_COMMIT, probe_version: PROBE_VERSION, codex_version: CODEX_VERSION, profile_id: PROFILE_ID, probe_tools: [...PROBE_TOOLS],
    pins: prepared.pins,
    model_calls: stats.governed_calls, network_calls: stats.governed_calls, network_dispatches_requested: stats.governed_calls, retries: 0, fallback: false,
    ...stats, source: { git_status: before.git_status, git_status_after: after.git_status, head_before: before.head, head_after: after.head, tree_sha256_before: before.tree_sha256, tree_sha256_after: after.tree_sha256 },
    artifacts: { effective_config: 'effective-config.yaml', graph: ['graph.dot', 'graph.svg', 'graph.png'], baseline_checkpoint: 'baseline.checkpoint.json', pause_checkpoint: 'pause.checkpoint.json', replacement_checkpoint: 'replacement.checkpoint.json', source_manifests: ['baseline-source-manifest.json', 'fix-source-manifest.json'] },
  };
  writePrivateJson(path.join(stage, 'demo-report.json'), report);
  writePrivateText(path.join(stage, 'demo-report.md'), `# EXP-0210 jsonparser live staged onboarding\n\nStatus: passed\nExecution mode: real-governed-probe\nAttestation evidence: probe-codex-attestation\nGoverned model calls: ${stats.governed_calls}\nRetries: 0\nFallback: false\nProof commit: ${PROOF_COMMIT}\nComponents: ${stats.component_count}\nChanged component: ${stats.changed_component_id}\n`);
  return report;
}

function failureEvidence(stage: string): AnyRecord {
  const phases = ['discovery', 'pause', 'resume', 'replacement'] as const;
  const resultFiles = phases.map(mode => `${mode}.result.json`).filter(file => fs.existsSync(path.join(stage, '.private', file)));
  const checkpoints = new Map<string, AnyRecord>();
  for (const phase of phases) {
    try {
      const result = JSON.parse(fs.readFileSync(path.join(stage, '.private', `${phase}.result.json`), 'utf8')) as AnyRecord;
      if (result.checkpoint) checkpoints.set(phase, result.checkpoint);
    } catch { /* Unknown counts are safer than partial or guessed counts. */ }
  }
  let value: number | 'unknown' = 'unknown';
  let phaseCalls: AnyRecord = {};
  if (phases.every(phase => checkpoints.has(phase))) {
    const cumulative = phases.map(phase => attemptCount(checkpoints.get(phase)!));
    const suffix = cumulative.map((count, index) => count - (index === 0 ? 0 : cumulative[index - 1]));
    if (suffix.every(count => count >= 0)) {
      phaseCalls = Object.fromEntries(phases.map((phase, index) => [phase, suffix[index]]));
      value = suffix.reduce((sum, count) => sum + count, 0);
    }
  }
  return { governed_calls: value, model_calls: value, network_dispatches_requested: value, ...(Object.keys(phaseCalls).length > 0 ? { phase_calls: phaseCalls } : {}), completed_phases: resultFiles.map(file => file.replace('.result.json', '')), checkpoint_evidence: [...checkpoints.keys()] };
}

function retainFailureCheckpoint(stage: string): string | undefined {
  for (const phase of ['replacement', 'resume', 'pause', 'discovery']) {
    try {
      const result = JSON.parse(fs.readFileSync(path.join(stage, '.private', `${phase}.result.json`), 'utf8')) as AnyRecord;
      if (!result.checkpoint || typeof result.checkpoint !== 'object') continue;
      const file = path.join(stage, 'failure.checkpoint.json');
      writePrivateJson(file, result.checkpoint);
      return 'failure.checkpoint.json';
    } catch { /* Keep trying earlier real checkpoints without exposing errors. */ }
  }
  return undefined;
}

function failureReceipt(stage: string, code: string, counts?: AnyRecord, mode: 'preflight-only' | 'run-once' = 'run-once'): void {
  try {
    aggregateFailureDiagnosticsFile(stage);
    const latestCheckpoint = retainFailureCheckpoint(stage);
    writeExclusiveJson(path.join(stage, 'run-once.failure.json'), {
      schema: 'urn:reqproof:agent-governance:exp-0210-live-failure:v1', status: 'failed', terminal: true, mode, failure_code: code,
      ...(counts || failureEvidence(stage)), retries: 0, fallback: false,
      ...(latestCheckpoint ? { latest_checkpoint: latestCheckpoint } : {}),
    });
  } catch { /* Preserve the first terminal receipt. */ }
}

export function runPreflight(outputDirectory: string): AnyRecord {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-exp0210-live-preflight-')); fs.chmodSync(stage, 0o700);
  try {
    const prepared = prepare(stage);
    cleanupPrivate(prepared);
    publish(stage, outputDirectory);
    return prepared.preflight;
  } catch (error) {
    failureReceipt(stage, 'PREFLIGHT_FAILED', { governed_calls: 0, model_calls: 0, network_dispatches_requested: 0, completed_phases: [], checkpoint_evidence: [] }, 'preflight-only');
    fs.rmSync(path.join(stage, '.private'), { recursive: true, force: true });
    try { publish(stage, outputDirectory); } catch { fs.rmSync(stage, { recursive: true, force: true }); }
    throw error;
  }
}

export function runJsonparserStagedLive(outputDirectory: string): AnyRecord {
  const stage = claimRunOutput(outputDirectory);
  try {
    writeExclusiveJson(path.join(stage, 'run-once.started.json'), { schema: 'urn:reqproof:agent-governance:exp-0210-live-started:v1', status: 'started', mode: 'run-once', controller_pid: process.pid, proof_commit: PROOF_COMMIT, retries: 0, fallback: false });
    const prepared = prepare(stage, true);
    const before = sourceState();
    if (before.git_status.length !== 0) throw new Error('subject checkout is not clean for the frozen run');
    const discovery = childProcess('discovery', stage);
    if (attemptCount(discovery.checkpoint) !== 1) throw new Error('discovery did not use exactly one governed model call');
    writePrivateJson(path.join(prepared.privateDir, 'discovery.checkpoint.json'), discovery.checkpoint);
    const pause = childProcess('pause', stage);
    writePrivateJson(path.join(prepared.privateDir, 'pause.checkpoint.json'), pause.checkpoint);
    const resumed = childProcess('resume', stage);
    writePrivateJson(path.join(prepared.privateDir, 'baseline.checkpoint.json'), resumed.checkpoint);
    const replacement = childProcess('replacement', stage);
    writePrivateJson(path.join(prepared.privateDir, 'replacement.checkpoint.json'), replacement.checkpoint);
    const stats = validateRun(prepared, pause, resumed, replacement);
    const after = sourceState();
    if (canonicalJson(before) !== canonicalJson(after)) throw new Error('subject checkout changed');
    const report = publicArtifacts(prepared, stats, pause, resumed, replacement, before, after);
    writeExclusiveJson(path.join(stage, 'run-once.completed.json'), { schema: 'urn:reqproof:agent-governance:exp-0210-live-completed:v1', status: 'completed', mode: 'run-once', governed_calls: stats.governed_calls, retries: 0, fallback: false });
    cleanupPrivate(prepared);
    return report;
  } catch (error) {
    failureReceipt(stage, 'RUN_ONCE_FAILED');
    fs.rmSync(path.join(stage, '.private'), { recursive: true, force: true });
    throw error;
  }
}

async function runFocusedSpecReviewChild(stage: string, controllerPid: number): Promise<void> {
  if (process.ppid !== controllerPid) throw new Error('child controller ownership failed');
  const input = JSON.parse(fs.readFileSync(path.join(stage, '.private', 'focused-input.json'), 'utf8')) as AnyRecord;
  const config = JSON.parse(fs.readFileSync(input.configPath, 'utf8')) as VisorConfig;
  const checkpointBytes = fs.readFileSync(input.checkpointFile);
  const derivation = deriveFocusedSpecReview(config, checkpointBytes);
  if (typeof input.preflightReceiptSha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(input.preflightReceiptSha256)) throw new Error('focused preflight receipt is not bound');
  consumeFocusedCapability(input.capabilityFile, input.capabilityDigest, derivation);
  const { createProofAdmissionCapability } = require('../../../src/providers/proof-admission-cli-child') as typeof import('../../../src/providers/proof-admission-cli-child');
  const { createGovernedProofInspectProviderFromCapability } = require('../../../src/providers/governed-proof-inspect-check-provider') as typeof import('../../../src/providers/governed-proof-inspect-check-provider');
  const { GovernedProbeAgentRunner, withGovernedProbeRunnerBudget } = require('../../../src/providers/governed-probe-runner') as typeof import('../../../src/providers/governed-probe-runner');
  const restoreProbeDiagnostics = installProbeFailureDiagnostics('focused-spec-review', stage, GovernedProbeAgentRunner);
  const timeline: AnyRecord[] = [{ event: 'derived', status: 'validated', binding_digest: focusedBindingSummary(derivation.binding).scope_digest }];
  let run: import('../../../src/providers/check-provider.interface').ManagedAgentRun | undefined;
  let outcome: unknown;
  let outcomeError: unknown;
  let close: AnyRecord = { status: 'not_started' };
  try {
    const request = focusedManagedRequest(derivation, input.workingDirectory);
    const provider = createGovernedProofInspectProviderFromCapability(createProofAdmissionCapability(input.proofBinary));
    run = withGovernedProbeRunnerBudget(1, () => provider.startManaged(request as any));
    await run.started;
    timeline.push({ event: 'managed_run_started', status: 'started', binding: focusedBindingSummary(run.binding) });
    try { outcome = await run.outcome; }
    catch (error) { outcomeError = error; }
    timeline.push({ event: 'managed_run_outcome', status: outcomeError ? 'failed' : focusedOutcomeSummary(outcome).status });
  } finally {
    if (run) {
      try { close = await run.close(); }
      catch (error) { close = { status: 'failed', ...safeFocusedError(error) }; }
      timeline.push({ event: 'managed_run_closed', status: close.status === 'clean' ? 'clean' : 'failed' });
    }
    restoreProbeDiagnostics();
  }
  const beforeHash = sha256(checkpointBytes);
  const afterBytes = fs.readFileSync(input.checkpointFile);
  const afterHash = sha256(afterBytes);
  const outcomeSummary = focusedOutcomeSummary(outcome, outcomeError);
  const successful = outcomeSummary.status === 'succeeded-proof-candidate';
  const result = {
    schema: 'urn:reqproof:agent-governance:exp-0210-focused-diagnostic-child:v1',
    status: successful ? 'passed' : 'provider_failed', schema_paths: FOCUSED_SCHEMA_PATHS, preflight_receipt_sha256: input.preflightReceiptSha256,
    checkpoint_sha256_before: `sha256:${beforeHash}`, checkpoint_sha256_after: `sha256:${afterHash}`,
    graph_semantic_digest: derivation.checkpoint.graphSemanticDigest,
    node_generation_id: derivation.execution.generation.nodeGenerationId,
    timeline, outcome: outcomeSummary,
    call_ledger: { budget: 1, runner_constructions: successful ? 1 : 'unknown', governed_calls: 1, model_calls: successful ? 1 : 'unknown', network_dispatches_requested: successful ? 1 : 'unknown', retries: 0, fallback: false },
  };
  writePrivateJson(path.join(stage, '.private', 'focused-spec-review.result.json'), result);
  process.stdout.write('EXP-0210 focused child completed\n');
}

export async function runFocusedBoundaryLocalization(outputDirectory: string): Promise<AnyRecord> {
  const stage = claimRunOutput(outputDirectory);
  let prepared: Prepared | undefined;
  try {
    writeExclusiveJson(path.join(stage, 'focused-boundary.started.json'), { schema: 'urn:reqproof:agent-governance:exp-0210-focused-boundary-started:v1', status: 'started', mode: FOCUSED_BOUNDARY_MODE, retries: 0, fallback: false });
    const preflightReceipt = focusedAuthorizationReceipt();
    prepared = prepare(stage, true, true, preflightReceipt.codex);
    const checkpointBytes = focusedCheckpointBytes();
    const checkpoint = JSON.parse(checkpointBytes.toString('utf8')) as AnyRecord;
    verifyFocusedBaselineLineage(prepared.proofBinary, prepared.baselineWorkspace, checkpoint);
    resolveHistoricalProjectRole(prepared.proofBinary, prepared.baselineWorkspace, prepared.config, checkpoint);
    if (compileClaimPlan(prepared.config).expansionPlan.graphSemanticDigest !== FOCUSED_GRAPH_DIGEST) throw new Error('focused effective config graph digest is not pinned');
    writePrivateJson(prepared.configPath, prepared.config);
    const derivation = deriveFocusedSpecReview(prepared.config, checkpointBytes);
    if (canonicalJson(focusedDerivationSummary(derivation)) !== canonicalJson(preflightReceipt.derivation)) throw new Error('focused diagnostic preflight derivation is detached');
    const checkpointFile = path.join(prepared.privateDir, 'focused-boundary.checkpoint.json');
    fs.writeFileSync(checkpointFile, checkpointBytes, { mode: 0o600 }); fs.chmodSync(checkpointFile, 0o600);
    const capabilityFile = path.join(prepared.privateDir, 'focused-boundary-capability.json');
    const capability = { version: 'urn:reqproof:agent-governance:exp-0210-focused-capability:v1', nonce: randomBytes(32).toString('hex'), checkpoint_sha256: `sha256:${FOCUSED_CHECKPOINT_SHA256}`, node_generation_id: derivation.execution.generation.nodeGenerationId };
    writeExclusiveJson(capabilityFile, capability);
    const sequence: FocusedBoundarySequence = { value: 1 };
    const timeline: AnyRecord[] = [];
    markFocusedBoundary(timeline, sequence, 'derivation', 'validated', { digest: focusedDerivationSummary(derivation).onboarding_stage_digest });
    consumeFocusedCapability(capabilityFile, sha256(canonicalJson(capability)), derivation);
    const guardCounters: FocusedBoundaryCounters = { process: 0, network: 0, answer: 0 };
    const restoreInstrumentation = installFocusedBoundaryInstrumentation(prepared.proofBinary, timeline, guardCounters, sequence);
    let run: import('../../../src/providers/check-provider.interface').ManagedAgentRun | undefined;
    let outcome: unknown;
    let outcomeError: unknown;
    let close: AnyRecord = { status: 'not_started' };
    try {
      const { createProofAdmissionCapability } = require('../../../src/providers/proof-admission-cli-child') as typeof import('../../../src/providers/proof-admission-cli-child');
      const { createGovernedProofInspectProviderFromCapability } = require('../../../src/providers/governed-proof-inspect-check-provider') as typeof import('../../../src/providers/governed-proof-inspect-check-provider');
      const { withGovernedProbeRunnerBudget } = require('../../../src/providers/governed-probe-runner') as typeof import('../../../src/providers/governed-probe-runner');
      markFocusedBoundary(timeline, sequence, 'proof_resolution', 'started');
      const provider = createGovernedProofInspectProviderFromCapability(createProofAdmissionCapability(prepared.proofBinary));
      const request = focusedManagedRequest(derivation, prepared.baselineWorkspace);
      markFocusedBoundary(timeline, sequence, 'provider_acquisition', 'started');
      run = withGovernedProbeRunnerBudget(1, () => provider.startManaged(request as any));
      markFocusedBoundary(timeline, sequence, 'provider_acquisition', 'handle_created');
      await run.started;
      markFocusedBoundary(timeline, sequence, 'managed_run', 'started');
      try { outcome = await run.outcome; }
      catch (error) { outcomeError = error; }
      markFocusedBoundary(timeline, sequence, 'provider_outcome', outcomeError ? 'failed' : 'completed');
    } finally {
      if (run) {
        try { close = await run.close(); }
        catch (error) { close = { status: 'failed', ...safeFocusedError(error) }; }
        markFocusedBoundary(timeline, sequence, 'provider_close', close.status === 'clean' ? 'clean' : 'failed');
      }
      restoreInstrumentation();
    }
    const guarded = outcomeError === FOCUSED_ANSWER_SENTINEL && guardCounters.answer === 1 && guardCounters.process === 0 && guardCounters.network === 0 && close.status === 'clean';
    const outcomeSummary = outcomeError === FOCUSED_ANSWER_SENTINEL
      ? { status: 'blocked_before_model', ...safeFocusedError(outcomeError), taxonomy: sanitizeProbeFailureTaxonomy(outcomeError) }
      : focusedOutcomeSummary(outcome, outcomeError);
    const report = {
      schema: 'urn:reqproof:agent-governance:exp-0210-focused-boundary:v1', status: guarded ? 'passed' : 'failed', mode: FOCUSED_BOUNDARY_MODE,
      retries: 0, fallback: false, schema_paths: FOCUSED_SCHEMA_PATHS, governed_calls: 0, model_calls: 0, network_dispatches_requested: 0,
      pins: { ...prepared.pins, proof_commit: PROOF_COMMIT, probe_version: PROBE_VERSION, codex_version: CODEX_VERSION, profile_id: PROFILE_ID, probe_tools: [...PROBE_TOOLS] },
      derivation: focusedDerivationSummary(derivation), preflight_receipt: preflightReceipt, timeline,
      outcome: outcomeSummary, lifecycle: { close_status: close.status === 'clean' ? 'clean' : 'failed', checkpoint_sha256: `sha256:${sha256(checkpointBytes)}`, answer_guard_hits: guardCounters.answer, forbidden_process_hits: guardCounters.process, forbidden_network_hits: guardCounters.network },
    };
    fs.rmSync(path.join(stage, 'preflight.json'), { force: true });
    writePrivateJson(path.join(stage, 'focused-boundary-report.json'), report);
    writeExclusiveJson(path.join(stage, 'focused-boundary.completed.json'), { schema: 'urn:reqproof:agent-governance:exp-0210-focused-boundary-completed:v1', status: 'completed', mode: FOCUSED_BOUNDARY_MODE, retries: 0, fallback: false });
    cleanupPrivate(prepared);
    return report;
  } catch (error) {
    if (prepared) cleanupPrivate(prepared);
    failureReceipt(stage, 'FOCUSED_BOUNDARY_FAILED');
    throw error;
  }
}

async function runChildMode(mode: 'discovery' | 'pause' | 'resume' | 'replacement' | 'focused-spec-review', stage: string, controllerPid: number): Promise<void> {
  if (mode === 'focused-spec-review') {
    await runFocusedSpecReviewChild(stage, controllerPid);
    return;
  }
  if (process.ppid !== controllerPid) throw new Error('child controller ownership failed');
  const input = privateInput(stage);
  const config = JSON.parse(fs.readFileSync(input.configPath, 'utf8')) as VisorConfig;
  const { StateMachineExecutionEngine } = require('../../../src/state-machine-execution-engine') as typeof import('../../../src/state-machine-execution-engine');
  const { CheckProviderRegistry } = require('../../../src/providers/check-provider-registry') as typeof import('../../../src/providers/check-provider-registry');
  const { createProofAdmissionCapability } = require('../../../src/providers/proof-admission-cli-child') as typeof import('../../../src/providers/proof-admission-cli-child');
  const { GovernedProbeAgentRunner, withGovernedProbeRunnerBudget } = require('../../../src/providers/governed-probe-runner') as typeof import('../../../src/providers/governed-probe-runner');
  const registry = CheckProviderRegistry.getInstance(); registry.bootstrapProofAdmission(createProofAdmissionCapability(input.proofBinary));
  const engine = new StateMachineExecutionEngine(mode === 'replacement' ? input.fixedWorkspace : input.baselineWorkspace);
  let result: AnyRecord;
  const restoreProbeDiagnostics = installProbeFailureDiagnostics(mode, stage, GovernedProbeAgentRunner);
  try {
    if (mode === 'discovery') {
      const gate = (generation: AnyRecord): 'dispatch' | 'defer' => generation.scope?.length === 2 ? 'defer' : 'dispatch';
      const runResult = await withGovernedProbeRunnerBudget(1, () => engine.executeGroupedChecks(PR, ['project'], undefined, config, 'json', false, 3, true, undefined, gate));
      const checkpoint = engine.exportGraphCheckpoint();
      const selection = authenticatedWorkItems(checkpoint, config);
      result = { checkpoint, component_ids: selection.componentIds, changed_component_id: selection.changedComponentId, held_component_id: selection.heldComponentId, completed_component_ids: [], statistics: runResult.statistics };
    } else if (mode === 'pause') {
      const discovery = JSON.parse(fs.readFileSync(input.discoveryCheckpoint, 'utf8')) as AnyRecord;
      const selection = authenticatedWorkItems(discovery, config);
      const gate = (generation: AnyRecord): 'dispatch' | 'defer' => generation.scope?.length === 2 && String(generation.scope.at(-1)?.key || '') === selection.heldComponentId ? 'defer' : 'dispatch';
      const pauseBudget = 2 * (selection.componentIds.length - 1);
      if (1 + pauseBudget > PAUSE_CALLS) throw new Error('pause governed call budget exceeded');
      const runResult = await withGovernedProbeRunnerBudget(pauseBudget, () => engine.resumeGraphCheckpoint({ checkpoint: discovery, config, prInfo: PR, maxParallelism: 3, failFast: true, generatedDispatchGate: gate }));
      const checkpoint = runResult.checkpoint;
      const view = componentProjection(checkpoint, config);
      const completed = selection.componentIds.filter(id => STAGES.every(stageName => generationsFor(view, id).some(value => value.checkId === stageName && value.status === 'completed')));
      result = { checkpoint, component_ids: selection.componentIds, changed_component_id: selection.changedComponentId, held_component_id: selection.heldComponentId, completed_component_ids: completed, statistics: runResult.result.statistics };
    } else if (mode === 'resume') {
      const checkpoint = JSON.parse(fs.readFileSync(input.pauseCheckpoint, 'utf8')) as AnyRecord;
      const selection = authenticatedWorkItems(checkpoint, config, false);
      const gate = (generation: AnyRecord): 'dispatch' | 'defer' => generation.scope?.length === 2 && String(generation.scope.at(-1)?.key || '') === selection.heldComponentId ? 'dispatch' : 'defer';
      const runResult = await withGovernedProbeRunnerBudget(RESUME_CALLS, () => engine.resumeGraphCheckpoint({ checkpoint, config, prInfo: PR, maxParallelism: 3, failFast: true, generatedDispatchGate: gate }));
      result = { checkpoint: runResult.checkpoint, statistics: runResult.result.statistics };
    } else {
      const checkpoint = JSON.parse(fs.readFileSync(input.baselineCheckpoint, 'utf8')) as AnyRecord;
      const selection = authenticatedWorkItems(checkpoint, config, false);
      const refreshed = proofRefresh(input.proofBinary, input.fixedWorkspace, checkpoint, config);
      const changedOwnerPaths = (refreshed.changedPaths || []).map(String);
      if (refreshed.changedComponentId !== selection.changedComponentId || !changedOwnerPaths.includes('parser.go') || !changedOwnerPaths.includes('parser_test.go')) throw new Error('Proof replacement owner is not the authenticated parser WorkItem');
      const project = Object.values(componentProjection(checkpoint, config).instancesById).find((value: any) => value.itemKey === 'jsonparser' && !value.parentSubgraphInstanceId) as AnyRecord | undefined;
      if (!project) throw new Error('project instance missing');
      const continued = await withGovernedProbeRunnerBudget(REPLACEMENT_CALLS, () => engine.continueProofCurrentCatalogCheckpoint({ checkpoint, projectSubgraphInstanceId: project.subgraphInstanceId, revalidationBytes: refreshed.revalidationBytes, workItemsBytes: refreshed.workItemsBytes, config, prInfo: PR, maxParallelism: 3, failFast: true }));
      result = { checkpoint: continued.checkpoint, refreshed };
    }
    writePrivateJson(path.join(stage, '.private', `${mode}.result.json`), result);
  } finally {
    restoreProbeDiagnostics();
  }
}

function parseArgs(argv: readonly string[]): { mode: 'preflight-only' | 'run-once' | 'focused-diagnostic-preflight' | 'focused-diagnostic-run-once' | typeof FOCUSED_BOUNDARY_MODE | 'child'; output: string; childMode?: 'discovery' | 'pause' | 'resume' | 'replacement' | 'focused-spec-review'; controllerPid?: number } {
  const modeFlags = [
    ['--preflight-only', 'preflight-only'],
    ['--run-once', 'run-once'],
    ['--focused-diagnostic-preflight', 'focused-diagnostic-preflight'],
    ['--focused-diagnostic-run-once', 'focused-diagnostic-run-once'],
    ['--focused-diagnostic-boundary', FOCUSED_BOUNDARY_MODE],
    ['--child', 'child'],
  ] as const;
  const selected = modeFlags.filter(([flag]) => argv.includes(flag));
  if (selected.length !== 1) throw new Error('choose exactly one live mode');
  const mode = selected[0][1];
  const outputIndex = argv.indexOf('--output');
  const output = outputIndex >= 0 ? argv[outputIndex + 1] : undefined;
  if (!output || output.startsWith('--')) throw new Error('--output is required');
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--child') { if (mode !== 'child') throw new Error('child arguments are invalid'); index += 1; continue; }
    if (flag === '--controller-pid') { if (mode !== 'child') throw new Error('child arguments are invalid'); index += 1; continue; }
    if (flag === '--output' || modeFlags.some(([known]) => known === flag)) { if (flag === '--output') index += 1; continue; }
    throw new Error('unsupported live-run option');
  }
  if (mode !== 'child') return { mode, output: path.resolve(output) };
  const childIndex = argv.indexOf('--child');
  const childMode = argv[childIndex + 1] as 'discovery' | 'pause' | 'resume' | 'replacement' | 'focused-spec-review';
  const pidIndex = argv.indexOf('--controller-pid');
  const controllerPid = Number(argv[pidIndex + 1]);
  if (!['discovery', 'pause', 'resume', 'replacement', 'focused-spec-review'].includes(childMode) || !Number.isSafeInteger(controllerPid) || controllerPid <= 0) throw new Error('child arguments are invalid');
  return { mode, output: path.resolve(output), childMode, controllerPid };
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.mode === 'preflight-only') runPreflight(args.output);
    else if (args.mode === 'run-once') runJsonparserStagedLive(args.output);
    else if (args.mode === 'focused-diagnostic-preflight') await runFocusedDiagnosticPreflight(args.output);
    else if (args.mode === 'focused-diagnostic-run-once') runFocusedDiagnosticOnce(args.output);
    else if (args.mode === FOCUSED_BOUNDARY_MODE) await runFocusedBoundaryLocalization(args.output);
    else await runChildMode(args.childMode!, args.output, args.controllerPid!);
}

if (require.main === module) {
  void main().catch(() => {
    process.stderr.write(process.argv.includes('focused-spec-review') ? 'EXP-0210 focused child failed\n' : 'EXP-0210 live runner failed\n');
    process.exitCode = 1;
  });
}
