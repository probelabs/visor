/**
 * Fresh native Proof onboarding runner.
 *
 * The runner owns only launch boundaries and diagnostics. Native lifecycle
 * decisions remain in Proof and the Visor graph; it never manufactures a
 * candidate, admission, or review result.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { loadConfig, StateMachineExecutionEngine } from '../../../src/sdk';
import { canonicalGraphCheckpointJson, ExecutionJournal } from '../../../src/snapshot-store';
import type { GraphJournalCheckpointV1 } from '../../../src/snapshot-store';
import { compileClaimPlan } from '../../../src/state-machine/graph/claim-plan';
import { canonicalJson, immutableCanonicalValue, sha256Canonical } from '../../../src/state-machine/graph/claim-kernel';
import type { GeneratedDispatchGate, GeneratedDispatchGateDecision } from '../../../src/types/engine';
import type { NodeGenerationProjection } from '../../../src/state-machine/graph/instance-kernel';
import { CheckProviderRegistry } from '../../../src/providers/check-provider-registry';
import { createProofAdmissionCapability, goCompatibleProofJson } from '../../../src/providers/proof-admission-cli-child';
import type { PRInfo } from '../../../src/pr-analyzer';
import type { VisorConfig } from '../../../src/types/config';

type Json = Record<string, unknown>;
type CommandResult = { status: number; stdout: string; stderr: string };
export type PublicPromptCaptureInfo = Readonly<{
  step: string;
  provider: string;
  prompt: string;
}>;

let publicPromptCaptureCounter = 0;

function safePromptStep(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 96);
  return safe || 'step';
}

/**
 * Persist the exact prompt fields exposed by the public execution hook.
 * This intentionally has no session/rollout lookup: the journal and
 * checkpoint remain the durable source for execution results.
 */
export function capturePublicPrompt(
  aiDirectory: string,
  info: PublicPromptCaptureInfo,
): string | undefined {
  if (!path.isAbsolute(aiDirectory) || !info ||
      typeof info.step !== 'string' || typeof info.provider !== 'string' ||
      typeof info.prompt !== 'string') {
    return undefined;
  }
  try {
    fs.mkdirSync(aiDirectory, {recursive: true, mode: 0o700});
    fs.chmodSync(aiDirectory, 0o700);
    const promptDigest = createHash('sha256').update(info.prompt, 'utf8').digest('hex');
    const record = {
      mode: 'public-prompt-capture/v1',
      step: info.step,
      provider: info.provider,
      prompt: info.prompt,
      promptBytes: Buffer.byteLength(info.prompt, 'utf8'),
      promptDigest: `sha256:${promptDigest}`,
    };
    const safeStep = safePromptStep(info.step);
    const serialized = JSON.stringify(record) + '\n';
    // A resumed process may reuse the initial counter while retaining the
    // same runner-owned output directory. Advance only on an exclusive-create
    // collision; other filesystem failures remain observational.
    for (let attempt = 0; attempt < 1024; attempt += 1) {
      const counter = ++publicPromptCaptureCounter;
      const filename = `${String(counter).padStart(8, '0')}-${safeStep}-${promptDigest}.json`;
      const file = path.join(aiDirectory, filename);
      try {
        fs.writeFileSync(file, serialized, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error
          ? (error as {code?: unknown}).code
          : undefined;
        if (code === 'EEXIST') continue;
        return undefined;
      }
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        return undefined;
      }
      return file;
    }
    return undefined;
  } catch {
    // Prompt diagnostics are observational and must not change execution.
    return undefined;
  }
}

/**
 * Configure the runner's public prompt diagnostic boundary. In particular,
 * an inherited debug-session setting can never turn private session history
 * back on for this runner.
 */
export function configurePublicPromptCapture(aiDirectory: string): (info: PublicPromptCaptureInfo) => void {
  if (!path.isAbsolute(aiDirectory)) throw new Error('public prompt directory must be absolute');
  fs.mkdirSync(aiDirectory, {recursive: true, mode: 0o700});
  fs.chmodSync(aiDirectory, 0o700);
  process.env.VISOR_DEBUG_AI_SESSIONS = 'false';
  process.env.VISOR_DEBUG_ARTIFACTS = aiDirectory;
  return info => {
    capturePublicPrompt(aiDirectory, info);
  };
}

export type NativePostflightSummary = {
  hard_failures: string[];
  open_native_checks: Array<{name: string; exit_code: number; component_id?: string}>;
};

type NativeComponentOpenCheck = {
  component_id: string;
  name: string;
  exit_code: number;
};

export type NativeOnboardingCompletionCounts = Readonly<{
  expected_components: number;
  native_requirements: number;
  authored_components: number;
  reviewed_items: number;
  reviewed_components: number;
  validated_components: number;
}>;

/**
 * Check natural discovered counts against the authoritative component
 * catalog. This is a completion consistency predicate, not an agent quota.
 */
export function nativeOnboardingCountsAreConsistent(counts: NativeOnboardingCompletionCounts): boolean {
  return Number.isSafeInteger(counts.expected_components) && counts.expected_components > 0 &&
    Number.isSafeInteger(counts.native_requirements) && counts.native_requirements > 0 &&
    counts.authored_components === counts.expected_components &&
    counts.reviewed_components === counts.expected_components &&
    counts.validated_components === counts.expected_components &&
    counts.reviewed_items === counts.native_requirements;
}

const CONFIG_PATH = path.resolve(__dirname, 'visor-onboarding.yaml');
const REPO_ROOT = path.resolve(__dirname, '../../../');
// A natural component catalog can contain many independent review items after
// each editable author/promotion. Keep the outer campaign budget bounded, but
// large enough for that real work; per-check and request budgets remain the
// enforcement points for individual calls.
const DEFAULT_TIMEOUT_MS = 7_200_000;
let diagnosticOutput: string | undefined;

const PR: PRInfo = {
  number: 0,
  title: 'fresh native Proof onboarding',
  body: '',
  author: 'native-onboarding-runner',
  base: 'main',
  head: 'subject',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  eventType: 'manual',
};

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error('unexpected argument: ' + key);
    if (key === '--preflight-only') {
      result['preflight-only'] = 'true';
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(key + ' requires a value');
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

function required(values: Record<string, string>, key: string): string {
  const value = values[key];
  if (!value) throw new Error('--' + key + ' is required');
  return value;
}

function realDirectory(value: string, label: string): string {
  const resolved = fs.realpathSync(path.resolve(value));
  if (!fs.statSync(resolved).isDirectory()) throw new Error(label + ' is not a directory');
  return resolved;
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function gitRoot(root: string): string {
  return String(execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {encoding: 'utf8'})).trim();
}

function assertRoots(subjectArg: string, originalArg: string, outputArg: string): {subject: string; original: string; output: string} {
  const subject = realDirectory(subjectArg, 'subject root');
  const original = realDirectory(originalArg, 'original root');
  const subjectGitRoot = realDirectory(gitRoot(subject), 'subject git root');
  const originalGitRoot = realDirectory(gitRoot(original), 'original git root');
  if (subject !== subjectGitRoot || original !== originalGitRoot) {
    throw new Error('subject-root and original-root must each be their checkout git root');
  }
  if (subject === original || subjectGitRoot === originalGitRoot) {
    throw new Error('subject root must differ from protected original root');
  }
  if (inside(subject, original) || inside(original, subject) ||
      inside(subjectGitRoot, originalGitRoot) || inside(originalGitRoot, subjectGitRoot)) {
    throw new Error('subject and protected original checkouts must be disjoint');
  }
  const output = path.resolve(outputArg);
  const parent = fs.realpathSync(path.dirname(output));
  if (inside(output, subject) || inside(output, original) || inside(parent, subject) || inside(parent, original)) {
    throw new Error('output must be outside both subject and protected original roots');
  }
  if (fs.existsSync(output)) throw new Error('output must be a fresh non-existent directory');
  fs.mkdirSync(output, {recursive: true});
  return {subject, original, output};
}

export type RecoveryArguments = Readonly<{
  checkpoint: string;
  priorOutput: string;
  retryGenerationIds: readonly string[];
}>;

/** Parse the explicit, closed recovery mode instead of inferring failed work. */
export function parseRecoveryArguments(values: Record<string, string>): RecoveryArguments | undefined {
  const checkpoint = values['recover-checkpoint'];
  const priorOutput = values['prior-output'];
  const retryValue = values['retry-generations'];
  const present = [checkpoint, priorOutput, retryValue].filter(value => value !== undefined).length;
  if (present === 0) return undefined;
  if (present !== 3 || !checkpoint || !priorOutput || !retryValue) {
    throw new Error('--recover-checkpoint, --prior-output, and --retry-generations must be supplied together');
  }
  const ids = retryValue.split(',').map(value => value.trim());
  if (ids.length === 0 || ids.some(id => !/^[0-9a-f]{64}$/.test(id))) {
    throw new Error('--retry-generations must contain comma-separated 64-character generation IDs');
  }
  const sorted = [...ids].sort();
  if (new Set(ids).size !== ids.length || ids.some((id, index) => id !== sorted[index])) {
    throw new Error('--retry-generations must be sorted and unique');
  }
  return Object.freeze({checkpoint, priorOutput, retryGenerationIds: Object.freeze(ids)});
}

function assertDisjointCheckoutRoots(subject: string, original: string): void {
  const subjectGitRoot = realDirectory(gitRoot(subject), 'subject git root');
  const originalGitRoot = realDirectory(gitRoot(original), 'original git root');
  if (subject !== subjectGitRoot || original !== originalGitRoot) {
    throw new Error('subject-root and original-root must each be their checkout git root');
  }
  if (subject === original || subjectGitRoot === originalGitRoot) {
    throw new Error('subject root must differ from protected original root');
  }
  if (inside(subject, original) || inside(original, subject) ||
      inside(subjectGitRoot, originalGitRoot) || inside(originalGitRoot, subjectGitRoot)) {
    throw new Error('subject and protected original checkouts must be disjoint');
  }
}

/** Recovery may reuse an initialized subject, but its output is always fresh. */
export function assertRecoveryRoots(
  subjectArg: string,
  originalArg: string,
  outputArg: string,
  priorOutputArg: string,
  checkpointArg: string,
): {subject: string; original: string; output: string; priorOutput: string; checkpoint: string} {
  const subject = realDirectory(subjectArg, 'subject root');
  const original = realDirectory(originalArg, 'original root');
  assertDisjointCheckoutRoots(subject, original);
  const priorOutput = realDirectory(priorOutputArg, 'prior output');
  if (inside(priorOutput, subject) || inside(priorOutput, original)) {
    throw new Error('prior output must be outside subject and protected original roots');
  }
  const checkpointCandidate = path.resolve(checkpointArg);
  const checkpoint = fs.realpathSync(checkpointCandidate);
  if (!fs.statSync(checkpoint).isFile()) {
    throw new Error('recovery checkpoint must be a retained checkpoint file');
  }
  if (!inside(checkpoint, priorOutput)) {
    // A chained recovery may pass the exact checkpoint from the newest,
    // separate recovery output. The explicit file is the authority; require
    // its conventional name and keep its containing root disjoint rather
    // than inferring ownership from marker files beside it.
    if (path.basename(checkpoint) !== 'checkpoint.json') {
      throw new Error('recovery checkpoint outside prior output must be named checkpoint.json');
    }
    const checkpointRoot = realDirectory(path.dirname(checkpoint), 'retained checkpoint root');
    if (inside(checkpointRoot, subject) || inside(subject, checkpointRoot) ||
        inside(checkpointRoot, original) || inside(original, checkpointRoot) ||
        inside(checkpointRoot, priorOutput) || inside(priorOutput, checkpointRoot)) {
      throw new Error('retained checkpoint root must be disjoint from subject, protected original, and prior output');
    }
  }
  const output = path.resolve(outputArg);
  const parent = fs.realpathSync(path.dirname(output));
  if (inside(output, subject) || inside(output, original) || inside(output, priorOutput) ||
      inside(parent, subject) || inside(parent, original) || inside(parent, priorOutput)) {
    throw new Error('recovery output must be outside subject, protected original, and prior output roots');
  }
  if (fs.existsSync(output)) throw new Error('recovery output must be a fresh non-existent directory');
  fs.mkdirSync(output, {recursive: true});
  return {subject, original, output, priorOutput, checkpoint};
}

function executable(value: string): string {
  if (!path.isAbsolute(value)) throw new Error('--proof-bin must be an absolute path');
  const resolved = fs.realpathSync(value);
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error('--proof-bin is not executable');
  return resolved;
}

function writeText(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, value, 'utf8');
}

function writeJson(file: string, value: unknown): void {
  const serialized = JSON.stringify(value, null, 2) + '\n';
  JSON.parse(serialized);
  writeText(file, serialized);
  JSON.parse(fs.readFileSync(file, 'utf8'));
}

function commandName(args: string[]): string {
  return args.join('-').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 128);
}

function runProof(proof: string, subject: string, output: string, phase: string, args: string[], timeout: number, input?: string): CommandResult {
  const started = new Date().toISOString();
  const result = spawnSync(proof, args, {
    cwd: subject,
    env: {...process.env, PROOF_BIN: proof},
    encoding: 'utf8',
    timeout,
    maxBuffer: 128 * 1024 * 1024,
    ...(input === undefined ? {} : {input}),
  });
  const status = typeof result.status === 'number' ? result.status : 1;
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || (result.error && result.error.message) || '');
  const base = path.join(output, 'commands', phase, commandName(args));
  writeText(base + '.stdout', stdout);
  writeText(base + '.stderr', stderr);
  if (input !== undefined) writeText(base + '.stdin', input);
  writeJson(base + '.meta.json', {
    cwd: subject,
    started_at: started,
    finished_at: new Date().toISOString(),
    args,
    status,
    timed_out: result.signal === 'SIGTERM',
  });
  return {status, stdout, stderr};
}

function parseJson(result: CommandResult, label: string): unknown {
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').slice(0, 2000);
    throw new Error(label + ' failed with exit ' + result.status + ': ' + detail);
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new Error(label + ' returned non-JSON output: ' + (error instanceof Error ? error.message : String(error)));
  }
}

export function serializeRoleInvocation(invocation: Json): string {
  const wire = goCompatibleProofJson(invocation);
  if (wire.includes('\n') || wire.includes('\r')) throw new Error('Proof role invocation wire contains a line terminator');
  return wire;
}

/**
 * Pin child TypeScript imports to this repository's project configuration.
 * Promotion runs from an isolated subject cwd, where an ambient project can
 * otherwise make ts-node select an incompatible module/moduleResolution pair.
 */
export function pinNativeOnboardingTsProject(): string {
  const project = fs.realpathSync(path.join(REPO_ROOT, 'tsconfig.json'));
  process.env.TS_NODE_PROJECT = project;
  return project;
}

function assertFreshSubject(subject: string, expectedRevision?: string): string {
  const status = String(execFileSync('git', ['-C', subject, 'status', '--porcelain', '--untracked-files=all'], {encoding: 'utf8'}));
  if (status.trim()) throw new Error('subject checkout must be clean and pinned before Proof init');
  const revision = String(execFileSync('git', ['-C', subject, 'rev-parse', '--verify', 'HEAD^{commit}'], {encoding: 'utf8'})).trim();
  if (expectedRevision && revision !== expectedRevision) throw new Error('subject HEAD does not match SUBJECT_BASELINE_REVISION');
  const requirementFiles = spawnSync('find', [path.join(subject, 'specs'), '-type', 'f', '-name', '*.req.yaml'], {encoding: 'utf8'});
  if (requirementFiles.status === 0 && String(requirementFiles.stdout || '').trim()) {
    throw new Error('fresh subject already contains native requirement files');
  }
  if (fs.existsSync(path.join(subject, 'proof.yaml')) || fs.existsSync(path.join(subject, '.proof'))) {
    throw new Error('fresh subject already contains Proof state');
  }
  return revision;
}

function assertRecoverySubject(subject: string): string {
  const status = String(execFileSync('git', ['-C', subject, 'status', '--porcelain', '--untracked-files=all'], {encoding: 'utf8'}));
  if (status.trim()) throw new Error('recovery subject checkout must remain clean before retry');
  return String(execFileSync('git', ['-C', subject, 'rev-parse', '--verify', 'HEAD^{commit}'], {encoding: 'utf8'})).trim();
}

function gitObjectFormat(subject: string): 'sha1' | 'sha256' {
  const format = String(execFileSync('git', ['-C', subject, 'rev-parse', '--show-object-format'], {encoding: 'utf8'})).trim();
  if (format !== 'sha1' && format !== 'sha256') throw new Error('subject Git object format is not sha1 or sha256');
  return format;
}

/**
 * Commit the files produced by Proof init as the immutable runtime baseline.
 * The caller verifies that the subject was clean before init, so staging the
 * resulting tree cannot absorb pre-existing source edits. This commit is a
 * runtime fixture boundary, not a source change to the Visor repository.
 */
export function commitInitializedProofBaseline(subject: string, sourceRevision: string): string {
  const currentRevision = String(execFileSync('git', ['-C', subject, 'rev-parse', '--verify', 'HEAD^{commit}'], {encoding: 'utf8'})).trim();
  if (currentRevision !== sourceRevision) throw new Error('Proof init baseline subject HEAD changed from the source revision');
  const changed = String(execFileSync('git', ['-C', subject, 'status', '--porcelain', '--untracked-files=all'], {encoding: 'utf8'}));
  if (!changed.trim()) throw new Error('Proof init produced no files to commit for the native baseline');
  execFileSync('git', ['-C', subject, 'add', '--all', '--', '.'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  const staged = String(execFileSync('git', ['-C', subject, 'diff', '--cached', '--name-only'], {encoding: 'utf8'}));
  const stagedPaths = staged.split('\n').map(value => value.trim()).filter(Boolean);
  const allowedInitPath = (value: string): boolean =>
    value === 'proof.yaml' || value === '.gitignore' ||
    value.startsWith('specs/') || value.startsWith('proof/') ||
    value.startsWith('baselines/') || value.startsWith('templates/') ||
    value.startsWith('docs/');
  const unexpectedPaths = stagedPaths.filter(value => !allowedInitPath(value));
  if (unexpectedPaths.length > 0) {
    execFileSync('git', ['-C', subject, 'reset', '--quiet'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    throw new Error('Proof init baseline contains unexpected source paths: ' + unexpectedPaths.join(', '));
  }
  if (!stagedPaths.includes('proof.yaml')) {
    execFileSync('git', ['-C', subject, 'reset', '--quiet'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    throw new Error('Proof init baseline is missing tracked proof.yaml');
  }
  execFileSync('git', [
    '-C', subject,
    '-c', 'user.name=visor-native-onboarding',
    '-c', 'user.email=visor-native-onboarding@localhost',
    'commit', '--no-verify', '-m', 'initialize native Proof baseline',
  ], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  const baseline = String(execFileSync('git', ['-C', subject, 'rev-parse', '--verify', 'HEAD^{commit}'], {encoding: 'utf8'})).trim();
  if (!baseline || baseline === sourceRevision) throw new Error('Proof init baseline commit did not advance from the source revision');
  const tracked = String(execFileSync('git', ['-C', subject, 'ls-tree', '-r', '--name-only', baseline], {encoding: 'utf8'}))
    .split('\n').map(value => value.trim()).filter(Boolean);
  if (!tracked.includes('proof.yaml')) throw new Error('Proof init baseline commit does not contain tracked proof.yaml');
  return baseline;
}

export function assertPrivateCodexHome(subject: string, original: string, output: string): {home: string; configPresent: boolean} {
  const value = process.env.CODEX_HOME;
  if (!value || !path.isAbsolute(value)) throw new Error('CODEX_HOME must be an absolute private caller-provided directory');
  const home = realDirectory(value, 'CODEX_HOME');
  if (inside(home, subject) || inside(home, original) || inside(home, output) || inside(output, home)) {
    throw new Error('CODEX_HOME must be outside subject, original, and output roots');
  }
  const configPath = path.join(home, 'config.toml');
  if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
    throw new Error('CODEX_HOME/config.toml is required');
  }
  const config = fs.readFileSync(configPath, 'utf8');
  if (/^\s*\[(?:mcp|mcp_servers|plugins|hooks)(?:\.|\])/im.test(config) ||
      /^\s*(?:mcp_servers|plugins|hooks|model_provider|provider)\s*=/im.test(config)) {
    throw new Error('CODEX_HOME must not configure MCP, plugins, hooks, or alternate providers');
  }
  for (const name of ['mcp.json', '.mcp.json', 'plugins', 'hooks']) {
    if (fs.existsSync(path.join(home, name))) throw new Error('CODEX_HOME contains disallowed ' + name + ' configuration');
  }
  // Subject-local Codex configuration would be an unreviewed override of the
  // caller's private profile. Reject it before registry/bootstrap/dispatch.
  for (const name of ['.codex', '.codexrc', 'codex.toml']) {
    if (fs.existsSync(path.join(subject, name))) throw new Error('subject contains unsupported Codex override ' + name);
  }
  return {home, configPresent: true};
}

function encodeResultSchemas(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => encodeResultSchemas(item));
  if (!value || typeof value !== 'object') return value;
  const output: Json = {};
  for (const [key, child] of Object.entries(value as Json)) output[key] = encodeResultSchemas(child);
  if (output.type === 'governed-proof-inspect' &&
      output.result_schema && typeof output.result_schema === 'string' &&
      output.invocation && typeof output.invocation === 'object') {
    const invocation = output.invocation as Json;
    output.invocation = {
      ...invocation,
      output_schema: Buffer.from(output.result_schema, 'utf8').toString('base64'),
    };
  }
  return output;
}

const RETAINED_AGGREGATE_MAP_SENTINEL = '__NATIVE_RETAINED_AGGREGATE_MAP_BASE64__';
const RETAINED_AGGREGATE_MAX_BYTES = 128 * 1024;

function utf8Sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')));
}

/**
 * Build the one immutable component-keyed map consumed by the retained
 * component template.  The map is deliberately made from the validated
 * packet objects, never from an archive path or a mutable process value.
 */
export function buildRetainedReviewedAggregateMap(input: RetainedReviewExport): Json {
  const componentIds = utf8Sorted([...new Set(input.packets.map(packet => packet.componentId))]);
  if (componentIds.length === 0) throw new Error('retained review export has no component aggregates');
  const entries = componentIds.map(componentId => {
    const aggregate = buildRetainedReviewedAggregate(input, componentId);
    const bytes = Buffer.byteLength(canonicalJson(aggregate), 'utf8');
    if (bytes > RETAINED_AGGREGATE_MAX_BYTES) {
      throw new Error(`retained component aggregate exceeds ${RETAINED_AGGREGATE_MAX_BYTES} bytes for ${componentId}`);
    }
    return [componentId, aggregate] as const;
  });
  return immutableCanonicalValue(Object.fromEntries(entries)) as Json;
}

/** Encode exact canonical map bytes for embedding in the retained command. */
export function encodeRetainedReviewedAggregateMap(input: RetainedReviewExport): string {
  const bytes = Buffer.from(canonicalJson(buildRetainedReviewedAggregateMap(input)), 'utf8');
  const encoded = bytes.toString('base64');
  if (!encoded || Buffer.from(encoded, 'base64').compare(bytes) !== 0) {
    throw new Error('retained aggregate map did not round-trip as canonical base64');
  }
  return encoded;
}

function componentCandidateSelectorSchema(prepared: Json): string {
  const claimTypes = prepared.claim_types;
  const candidateType = claimTypes && typeof claimTypes === 'object' && !Array.isArray(claimTypes)
    ? (claimTypes as Json)['proof.candidate@1']
    : undefined;
  const candidateSchema = candidateType && typeof candidateType === 'object' && !Array.isArray(candidateType)
    ? (candidateType as Json).schema
    : undefined;
  const oneOf = candidateSchema && typeof candidateSchema === 'object' && !Array.isArray(candidateSchema)
    ? (candidateSchema as Json).oneOf
    : undefined;
  const branch = Array.isArray(oneOf)
    ? oneOf.find(value => value && typeof value === 'object' && !Array.isArray(value) &&
      (((value as Json).properties as Json | undefined)?.schema as Json | undefined)?.const === 'reqproof.component-onboarding/v1')
    : undefined;
  if (!branch || typeof branch !== 'object' || Array.isArray(branch)) {
    throw new Error('shipped proof.candidate@1 schema has no component selector branch');
  }
  return Buffer.from(canonicalJson(branch), 'utf8').toString('base64');
}

function requiredObject(value: unknown, label: string): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as Json;
}

/**
 * Materialize the retained profile from the shipped graph.  This keeps the
 * profile and both component selector schemas under one config authority while
 * changing only the project expansion template and the validated map bytes.
 */
export function materializeRetainedContinuationConfig(preparedInput: Json, aggregateMap: Json): Json {
  const prepared = JSON.parse(canonicalJson(preparedInput)) as Json;
  const encodedMap = Buffer.from(canonicalJson(aggregateMap), 'utf8').toString('base64');
  if (!encodedMap) throw new Error('retained aggregate map is empty');
  const selectorSchema = componentCandidateSelectorSchema(prepared);
  const subgraphs = requiredObject(prepared.subgraphs, 'onboarding subgraphs');
  const discover = requiredObject(subgraphs['discover-project'], 'discover-project subgraph');
  const discoverChecks = requiredObject(discover.checks, 'discover-project checks');
  const materialize = requiredObject(discoverChecks.materialize_catalog, 'materialize_catalog check');
  const expand = requiredObject(materialize.expand, 'materialize_catalog expansion');
  if (expand.template !== 'onboard-component' && expand.template !== 'onboard-component-retained') {
    throw new Error('materialize_catalog expansion does not use the shipped component template');
  }
  expand.template = 'onboard-component-retained';
  const retainedComponentIds = utf8Sorted(Object.keys(aggregateMap));
  const discoveryInspect = requiredObject(discoverChecks.inspect, 'discover-project inspect check');
  if (retainedComponentIds.length === 0 || typeof discoveryInspect.message !== 'string') {
    throw new Error('retained discovery requires a shipped project message and component identities');
  }
  discoveryInspect.message = `${discoveryInspect.message}\n\nRetained prior component identities to revalidate and preserve when still current: ${JSON.stringify(retainedComponentIds)}. Do not invent replacement component identities; the authenticated current WorkItem set remains authoritative.`;

  const profiles = ['onboard-component', 'onboard-component-retained'];
  for (const profileName of profiles) {
    const profile = requiredObject(subgraphs[profileName], `${profileName} subgraph`);
    const checks = requiredObject(profile.checks, `${profileName} checks`);
    for (const checkName of ['inspect', 'spec_review']) {
      const check = requiredObject(checks[checkName], `${profileName}.${checkName} check`);
      const invocation = requiredObject(check.invocation, `${profileName}.${checkName} invocation`);
      invocation.output_schema = selectorSchema;
    }
  }
  const retainedProfile = requiredObject(subgraphs['onboard-component-retained'], 'onboard-component-retained subgraph');
  const retainedChecks = requiredObject(retainedProfile.checks, 'onboard-component-retained checks');
  const reviewed = requiredObject(retainedChecks['component-reviewed'], 'retained component-reviewed check');
  if (reviewed.type !== 'command' || typeof reviewed.exec !== 'string') {
    throw new Error('retained component-reviewed check is not a command');
  }
  const occurrences = reviewed.exec.split(RETAINED_AGGREGATE_MAP_SENTINEL).length - 1;
  if (occurrences !== 1) throw new Error('retained component-reviewed command must contain one aggregate map sentinel');
  reviewed.exec = reviewed.exec.replace(RETAINED_AGGREGATE_MAP_SENTINEL, encodedMap);

  // Both selector invocations must be derived from this one claim branch.
  const liveChecks = requiredObject(requiredObject(subgraphs['onboard-component'], 'onboard-component subgraph').checks, 'onboard-component checks');
  const retainedFinalChecks = requiredObject(retainedProfile.checks, 'retained final checks');
  const selectorSchemas = [
    requiredObject(liveChecks.inspect, 'live inspect').invocation,
    requiredObject(liveChecks.spec_review, 'live spec_review').invocation,
    requiredObject(retainedFinalChecks.inspect, 'retained inspect').invocation,
    requiredObject(retainedFinalChecks.spec_review, 'retained spec_review').invocation,
  ].map(value => requiredObject(value, 'component selector invocation').output_schema);
  if (selectorSchemas.some(value => value !== selectorSchema)) {
    throw new Error('component selector output schemas were not derived from one claim branch');
  }
  // The retained graph intentionally has no live authoring or per-item
  // reviewer expansion. Remove those dormant templates after deriving the
  // selector bytes; retaining them would make the switched root expansion
  // fail the compiler's unreachable-template gate.
  delete subgraphs['onboard-component'];
  delete subgraphs['native-requirement-review'];
  return prepared;
}

/** Defer every generated component-scope generation until the project prefix is materialized. */
export const retainedProjectPrefixDispatchGate: GeneratedDispatchGate = (
  generation: NodeGenerationProjection,
): GeneratedDispatchGateDecision => generation.scope.length > 1 ? 'defer' : 'dispatch';

function onboardingConfigTemplate(): {prepared: Json; inspectCheck: Json} {
  const raw = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('onboarding YAML must be an object');
  const prepared = encodeResultSchemas(raw) as Json;
  const inspect = ((prepared.subgraphs as Json)['discover-project'] as Json).checks as Json;
  const inspectCheck = inspect.inspect as Json;
  return {prepared, inspectCheck};
}

function assertAuthenticatedInventory(inventory: Json, label: string): Json {
  const authority = inventory.authority as Json | undefined;
  const projectId = authority && typeof authority.project_id === 'string' ? authority.project_id : undefined;
  const subjectFingerprint = authority && typeof authority.subject_fingerprint === 'string' ? authority.subject_fingerprint : undefined;
  if (!projectId || !subjectFingerprint || !/^sha256:[0-9a-f]{64}$/.test(subjectFingerprint)) {
    throw new Error(`${label} did not provide an authenticated project id and subject fingerprint`);
  }
  return {project_id: projectId, subject_fingerprint: subjectFingerprint};
}

function bindResolvedOnboardingAuthority(
  prepared: Json,
  inspectCheck: Json,
  inventory: Json,
  resolved: Json,
  label: string,
): void {
  const authority = assertAuthenticatedInventory(inventory, label);
  const resolvedSubject = resolved.subject && typeof resolved.subject === 'object' && !Array.isArray(resolved.subject)
    ? resolved.subject as Json
    : undefined;
  if (resolved.version !== 'proof.role-invocation/v1' || resolved.role_id !== 'onboard' ||
      resolved.role_source !== 'builtin' || resolved.stance !== 'owner' || resolved.authority !== 'read-only' ||
      !resolvedSubject || resolvedSubject.kind !== 'project' || resolvedSubject.id !== authority.project_id ||
      resolvedSubject.fingerprint !== authority.subject_fingerprint ||
      typeof resolved.output_schema_id !== 'string' || typeof resolved.output_schema !== 'string' ||
      typeof resolved.instructions !== 'string' || resolved.instructions.length === 0 ||
      typeof resolved.invocation_digest !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(resolved.invocation_digest)) {
    throw new Error(`${label} returned an incomplete retained project authority`);
  }
  const templateInvocation = inspectCheck.invocation as Json;
  if (!templateInvocation || resolved.output_schema_id !== templateInvocation.output_schema_id ||
      resolved.output_schema !== templateInvocation.output_schema) {
    throw new Error(`${label} output schema does not match the shipped onboarding graph`);
  }
  inspectCheck.invocation = {
    role_id: resolved.role_id,
    stance: resolved.stance,
    subject: {
      kind: resolvedSubject.kind,
      id: resolvedSubject.id,
      fingerprint: resolvedSubject.fingerprint,
    },
    output_schema_id: resolved.output_schema_id,
    output_schema: resolved.output_schema,
  };
  inspectCheck.instructions = resolved.instructions;
  inspectCheck.invocation_digest = resolved.invocation_digest;
  inspectCheck.result_schema = Buffer.from(resolved.output_schema, 'base64').toString('utf8');
  const projectValue = ((prepared.checks as Json).project as Json).value as Json;
  const projects = projectValue.projects as Json[];
  if (!Array.isArray(projects) || projects.length !== 1) throw new Error('onboarding graph must contain one project root');
  projects[0].project_id = authority.project_id;
  projects[0].root = '.';
}

async function loadCurrentOnboardingInventory(proof: string, subject: string, output: string, timeout: number): Promise<Json> {
  const inventoryResult = runProof(proof, subject, output, 'preflight', ['onboarding', 'inventory'], timeout);
  const inventory = parseJson(inventoryResult, 'Proof onboarding inventory') as Json;
  writeJson(path.join(output, 'preflight', 'inventory.json'), inventory);
  assertAuthenticatedInventory(inventory, 'Proof onboarding inventory');
  return inventory;
}

async function loadResolvedOnboardingAuthority(
  proof: string,
  subject: string,
  output: string,
  timeout: number,
  inventory: Json,
  prepared: Json,
  inspectCheck: Json,
): Promise<Json> {
  const authority = assertAuthenticatedInventory(inventory, 'Proof onboarding inventory');
  const invocation = {
    role_id: 'onboard',
    stance: 'owner',
    subject: {kind: 'project', id: authority.project_id, fingerprint: authority.subject_fingerprint},
    output_schema_id: (inspectCheck.invocation as Json).output_schema_id,
    output_schema: (inspectCheck.invocation as Json).output_schema,
  };
  const resolvedResult = runProof(proof, subject, output, 'preflight', ['resolve-role-invocation'], timeout, serializeRoleInvocation(invocation));
  const resolved = parseJson(resolvedResult, 'Proof resolve-role-invocation') as Json;
  if (resolvedResult.stderr !== '') throw new Error('Proof resolve-role-invocation emitted stderr: ' + resolvedResult.stderr.slice(0, 1000));
  bindResolvedOnboardingAuthority(prepared, inspectCheck, inventory, resolved, 'Proof resolve-role-invocation');
  return resolved;
}

export async function loadOnboardingConfig(proof: string, subject: string, output: string, timeout: number) {
  const {prepared, inspectCheck} = onboardingConfigTemplate();
  const inventory = await loadCurrentOnboardingInventory(proof, subject, output, timeout);
  await loadResolvedOnboardingAuthority(proof, subject, output, timeout, inventory, prepared, inspectCheck);
  return loadConfig(prepared, {strict: true});
}

type RetainedAuthorityFiles = Readonly<{
  inventory: Json;
  resolved: Json;
  manifest: Json;
}>;

function readRetainedAuthorityFile(priorOutput: string, relativePath: string): Buffer {
  if (path.isAbsolute(relativePath) || relativePath.includes('..')) {
    throw new Error('retained authority path is not a safe relative path');
  }
  const candidate = path.join(priorOutput, relativePath);
  let resolved: string;
  try {
    resolved = fs.realpathSync(candidate);
  } catch {
    throw new Error(`retained recovery authority is missing: ${relativePath}`);
  }
  const canonicalPriorOutput = fs.realpathSync(priorOutput);
  if (!inside(resolved, canonicalPriorOutput)) throw new Error(`retained recovery authority escapes prior output: ${relativePath}`);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`retained recovery authority is not a regular file: ${relativePath}`);
  return fs.readFileSync(resolved);
}

function copyRetainedAuthorityEvidence(priorOutput: string, output: string): RetainedAuthorityFiles {
  const paths = {
    inventory: 'preflight/inventory.json',
    resolved: 'commands/preflight/resolve-role-invocation.stdout',
    resolved_meta: 'commands/preflight/resolve-role-invocation.meta.json',
    resolved_stderr: 'commands/preflight/resolve-role-invocation.stderr',
  } as const;
  const captured = {} as Record<keyof typeof paths, Buffer>;
  const records = Object.entries(paths).map(([name, relativePath]) => {
    const bytes = readRetainedAuthorityFile(priorOutput, relativePath);
    captured[name as keyof typeof paths] = bytes;
    const destination = path.join(output, 'recovery', 'config-authority', path.basename(relativePath));
    fs.mkdirSync(path.dirname(destination), {recursive: true, mode: 0o700});
    fs.writeFileSync(destination, bytes, {mode: 0o600});
    fs.chmodSync(destination, 0o600);
    return {
      name,
      source: relativePath,
      retained_path: path.relative(output, destination),
      bytes: bytes.byteLength,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    };
  });
  const inventoryBytes = captured.inventory;
  const resolvedBytes = captured.resolved;
  const metaBytes = captured.resolved_meta;
  const stderrBytes = captured.resolved_stderr;
  if (stderrBytes.byteLength !== 0) throw new Error('retained Proof resolve-role-invocation stderr must be empty');
  let inventory: Json;
  let resolved: Json;
  let meta: Json;
  try {
    inventory = JSON.parse(inventoryBytes.toString('utf8')) as Json;
    resolved = JSON.parse(resolvedBytes.toString('utf8')) as Json;
    meta = JSON.parse(metaBytes.toString('utf8')) as Json;
  } catch {
    throw new Error('retained recovery authority contains invalid JSON');
  }
  if (meta.status !== 0 || meta.timed_out !== false ||
      !Array.isArray(meta.args) || meta.args.length !== 1 || meta.args[0] !== 'resolve-role-invocation') {
    throw new Error('retained Proof resolve-role-invocation metadata is not a successful exact command');
  }
  const authority = assertAuthenticatedInventory(inventory, 'retained Proof onboarding inventory');
  const resolvedSubject = resolved.subject && typeof resolved.subject === 'object' && !Array.isArray(resolved.subject)
    ? resolved.subject as Json
    : undefined;
  if (!resolvedSubject || resolvedSubject.kind !== 'project' || resolvedSubject.id !== authority.project_id ||
      resolvedSubject.fingerprint !== authority.subject_fingerprint) {
    throw new Error('retained Proof role authority does not match retained inventory authority');
  }
  const manifest = {
    source_root: priorOutput,
    files: records,
    authority: {
      project_id: authority.project_id,
      subject_fingerprint: authority.subject_fingerprint,
    },
  };
  writeJson(path.join(output, 'recovery', 'config-authority', 'manifest.json'), manifest);
  return {inventory, resolved, manifest};
}

export async function loadRetainedOnboardingConfig(priorOutput: string, output: string): Promise<{
  config: VisorConfig;
  authority: RetainedAuthorityFiles;
}> {
  const authority = copyRetainedAuthorityEvidence(priorOutput, output);
  const {prepared, inspectCheck} = onboardingConfigTemplate();
  bindResolvedOnboardingAuthority(
    prepared,
    inspectCheck,
    authority.inventory,
    authority.resolved,
    'retained Proof resolve-role-invocation',
  );
  return {config: await loadConfig(prepared, {strict: true}), authority};
}

type RecoveryRoots = Readonly<{
  subject: string;
  priorOutput: string;
  checkpointRoot?: string;
}>;

type RecoveryBinding = Readonly<{
  generationId: string;
  componentId: string;
  baselineCommit: string;
  checkoutPath?: string;
  workItemClaimId: string;
  checkoutClaimId?: string;
  authorClaimId?: string;
  ownedSourcePaths?: readonly string[];
  draftInventory?: RecoveryDraftInventory;
}>;

export type RecoveryReviewPacket = Readonly<{
  componentId: string;
  id: string;
  claimId: string;
  sourceRelativePath: string;
  bytes: Buffer;
  sha256: string;
}>;

type RecoverySideEffects = 'absent' | 'safely_idempotent' | 'isolated_draft_replay';

/**
 * A portable retained review export is input evidence for a fresh graph, not
 * a Graph-v2 checkpoint. Keep the manifest and packet bytes together so a
 * caller cannot silently substitute an older packet directory or relabel a
 * historical claim as a newly produced review.
 */
export type RetainedReviewExportPacket = Readonly<{
  componentId: string;
  id: string;
  filePath: string;
  proofFileHash: string;
  claimId: string;
  payloadFingerprint: string;
  packetSha256: string;
  bytes: Buffer;
  packet: Json;
}>;

export type RetainedReviewExport = Readonly<{
  root: string;
  manifestSha256: string;
  checkpointSha256: string;
  graphSemanticDigest: string;
  packetCount: number;
  packets: readonly RetainedReviewExportPacket[];
}>;

function retainedManifestPath(root: string): string {
  const candidate = path.join(root, 'manifest.json');
  let resolved: string;
  try { resolved = fs.realpathSync(candidate); } catch { throw new Error('retained review export is missing manifest.json'); }
  if (!inside(resolved, root) || resolved !== candidate) throw new Error('retained review export manifest escapes its root');
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('retained review export manifest must be a regular file');
  return resolved;
}

function retainedSafeRelative(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value) || value.includes('\\') ||
      value.split('/').some(part => part.length === 0 || part === '..' || part === '.')) {
    throw new Error(`retained review export ${label} is not a safe relative path`);
  }
  return value;
}

function retainedDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`retained review export ${label} is not a sha256 digest`);
  }
  return value;
}

function retainedBareDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`retained review export ${label} is not a bare digest`);
  }
  return value;
}

function retainedExactKeys(value: Json, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`retained review export ${label} has an unexpected closed shape`);
  }
}

function retainedRegularFile(root: string, relativePath: string, label: string): {path: string; bytes: Buffer} {
  const safe = retainedSafeRelative(relativePath, `${label} path`);
  const candidate = path.join(root, safe);
  let resolved: string;
  try { resolved = fs.realpathSync(candidate); } catch { throw new Error(`retained review export ${label} is missing`); }
  if (!inside(resolved, root)) throw new Error(`retained review export ${label} escapes its root`);
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`retained review export ${label} must be a regular file`);
  return {path: resolved, bytes: fs.readFileSync(resolved)};
}

/** Validate one portable, schema-shaped 92-packet input before graph launch. */
export function readRetainedReviewExport(
  inputRoot: string,
  plan: ReturnType<typeof compileClaimPlan>,
  expectedPacketCount?: number,
): RetainedReviewExport {
  const root = realDirectory(inputRoot, 'retained review export root');
  const manifestFile = retainedManifestPath(root);
  const manifestBytes = fs.readFileSync(manifestFile);
  let manifest: Json;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')) as Json; } catch { throw new Error('retained review export manifest is not valid JSON'); }
  if (manifest.version !== 1 || manifest.kind !== 'retained-native-review-packet-export' || manifest.status !== 'validated-reference-only' ||
      !manifest.source || typeof manifest.source !== 'object' || Array.isArray(manifest.source) ||
      !Array.isArray(manifest.packets) || !Number.isSafeInteger(manifest.packet_count) || manifest.packet_count !== manifest.packets.length) {
    throw new Error('retained review export manifest envelope is invalid');
  }
  retainedExactKeys(manifest, ['version', 'kind', 'status', 'source', 'packet_count', 'packets', 'interpretation'], 'manifest');
  const interpretation = manifest.interpretation;
  if (!interpretation || typeof interpretation !== 'object' || Array.isArray(interpretation)) {
    throw new Error('retained review export interpretation is invalid');
  }
  retainedExactKeys(interpretation as Json, [
    'old_graph_reference', 'imported_journal_claims', 'approval_or_admission_claimed', 'current_proof_recheck_required',
  ], 'interpretation');
  if (interpretation.old_graph_reference !== true || interpretation.imported_journal_claims !== false ||
      interpretation.approval_or_admission_claimed !== false || interpretation.current_proof_recheck_required !== true) {
    throw new Error('retained review export interpretation is invalid');
  }
  const source = manifest.source as Json;
  retainedExactKeys(source, [
    'checkpoint', 'checkpoint_sha256', 'checkpoint_bytes', 'graph_semantic_digest',
    'config_authority_files_sha256', 'config_authority_files', 'packet_sources',
  ], 'manifest source');
  if (typeof source.checkpoint !== 'string' || source.checkpoint.length === 0 ||
      !Number.isSafeInteger(source.checkpoint_bytes) || (source.checkpoint_bytes as number) < 0) {
    throw new Error('retained review export checkpoint declaration is invalid');
  }
  retainedDigest(source.checkpoint_sha256, 'checkpoint_sha256');
  const checkpointSha256 = source.checkpoint_sha256 as string;
  const graphSemanticDigest = retainedBareDigest(source.graph_semantic_digest, 'graph_semantic_digest');
  retainedDigest(source.config_authority_files_sha256, 'config_authority_files_sha256');
  if (!Array.isArray(source.config_authority_files) || source.config_authority_files.length === 0) {
    throw new Error('retained review export config authority declaration is invalid');
  }
  for (const raw of source.config_authority_files) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('retained review export config authority declaration is invalid');
    const record = raw as Json;
    retainedExactKeys(record, ['name', 'source', 'bytes', 'sha256'], 'config authority file');
    if (typeof record.name !== 'string' || record.name.length === 0 ||
        !Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0) {
      throw new Error('retained review export config authority declaration is invalid');
    }
    retainedSafeRelative(record.source, 'config authority file source');
    retainedDigest(record.sha256, 'config authority file sha256');
  }
  const expected = expectedPacketCount ?? (manifest.packet_count as number);
  if (!Number.isSafeInteger(expected) || expected < 1 || manifest.packet_count !== expected) {
    throw new Error(`retained review export must contain exactly ${expected} packets`);
  }
  if (!Array.isArray(source.packet_sources) || source.packet_sources.length === 0) {
    throw new Error('retained review export manifest has no packet source declarations');
  }
  const sourceComponents = new Set<string>();
  let declaredCount = 0;
  for (const record of source.packet_sources) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('retained review export packet source declaration is invalid');
    }
    const sourceRecord = record as Json;
    retainedExactKeys(sourceRecord, ['component_id', 'item_count', 'source_root', 'source_aggregate_present', 'helper_input'], 'packet source');
    if (typeof sourceRecord.component_id !== 'string' || (sourceRecord.component_id as string).length === 0 ||
        !Number.isSafeInteger(sourceRecord.item_count) || (sourceRecord.item_count as number) < 1 ||
        typeof sourceRecord.source_root !== 'string' || (sourceRecord.source_root as string).length === 0 ||
        typeof sourceRecord.source_aggregate_present !== 'boolean' || sourceRecord.helper_input !== 'validated-packet-files-only') {
      throw new Error('retained review export packet source declaration is invalid');
    }
    const componentId = sourceRecord.component_id as string;
    if (sourceComponents.has(componentId)) throw new Error(`retained review export duplicates component source ${componentId}`);
    sourceComponents.add(componentId);
    declaredCount += sourceRecord.item_count as number;
  }
  if (declaredCount !== expected) throw new Error('retained review export packet source counts do not match packet_count');
  const recoveryManifest = retainedRegularFile(root, 'recovery/review-packet-manifest.json', 'recovery manifest');
  let recovery: Json;
  try { recovery = JSON.parse(recoveryManifest.bytes.toString('utf8')) as Json; } catch { throw new Error('retained recovery packet manifest is not valid JSON'); }
  if (recovery.version !== 1 || recovery.kind !== 'retained-native-review-packet-manifest' || !Array.isArray(recovery.packets) || recovery.packets.length !== expected) {
    throw new Error('retained recovery packet manifest envelope is invalid');
  }
  retainedExactKeys(recovery, ['version', 'kind', 'packets'], 'recovery manifest');
  const recoveryByPath = new Map<string, Json>();
  for (const entry of recovery.packets) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('retained recovery packet manifest entry is invalid');
    const record = entry as Json;
    retainedExactKeys(record, ['component_id', 'id', 'claim_id', 'source', 'destination', 'bytes', 'source_sha256', 'destination_sha256'], 'recovery manifest entry');
    const sourceRelativePath = retainedSafeRelative(record.source, 'packet source');
    const destination = retainedSafeRelative(record.destination, 'packet destination');
    if (sourceRelativePath !== destination || recoveryByPath.has(sourceRelativePath) ||
        typeof record.component_id !== 'string' || typeof record.id !== 'string' || typeof record.claim_id !== 'string' ||
        !/^[0-9a-f]{64}$/.test(record.claim_id as string) || !Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0 ||
        retainedDigest(record.source_sha256, 'packet source_sha256') !== record.destination_sha256) {
      throw new Error('retained recovery packet manifest entry is detached');
    }
    recoveryByPath.set(sourceRelativePath, record);
  }
  const packets: RetainedReviewExportPacket[] = [];
  const seen = new Set<string>();
  let previousKey: string | undefined;
  for (const raw of manifest.packets) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('retained review export packet entry is invalid');
    const entry = raw as Json;
    retainedExactKeys(entry, [
      'claim_id', 'payload_fingerprint', 'component_id', 'id', 'file_path', 'proof_file_hash',
      'source_relative_path', 'packet_bytes', 'packet_sha256',
    ], 'packet entry');
    const componentId = entry.component_id;
    const id = entry.id;
    if (typeof componentId !== 'string' || componentId.length === 0 || typeof id !== 'string' || id.length === 0) {
      throw new Error('retained review export packet identity is invalid');
    }
    const key = `${componentId}\u0000${id}`;
    if (seen.has(key) || (previousKey !== undefined && Buffer.from(previousKey, 'utf8').compare(Buffer.from(key, 'utf8')) >= 0)) {
      throw new Error('retained review export packets must be UTF-8 ID sorted and unique');
    }
    seen.add(key); previousKey = key;
    const sourceRelativePath = retainedSafeRelative(entry.source_relative_path, `packet ${id} source`);
    const recoveryEntry = recoveryByPath.get(sourceRelativePath);
    if (!recoveryEntry || recoveryEntry.component_id !== componentId || recoveryEntry.id !== id || recoveryEntry.claim_id !== entry.claim_id) {
      throw new Error(`retained review export packet ${id} is detached from its recovery manifest`);
    }
    const packetFile = retainedRegularFile(root, sourceRelativePath, `packet ${id}`);
    const packetSha256 = retainedDigest(entry.packet_sha256, `packet ${id} packet_sha256`);
    const actualSha256 = `sha256:${createHash('sha256').update(packetFile.bytes).digest('hex')}`;
    if (!Number.isSafeInteger(entry.packet_bytes) || (entry.packet_bytes as number) < 0 ||
        actualSha256 !== packetSha256 || packetFile.bytes.byteLength !== entry.packet_bytes || recoveryEntry.bytes !== entry.packet_bytes || recoveryEntry.source_sha256 !== packetSha256) {
      throw new Error(`retained review export packet ${id} bytes are detached from the manifest`);
    }
    let packet: Json;
    try { packet = JSON.parse(packetFile.bytes.toString('utf8')) as Json; } catch { throw new Error(`retained review export packet ${id} is not valid JSON`); }
    const packetValidator = plan.validatorsByClaim['native.review.packet@1'];
    if (!packetValidator) throw new Error('retained review export has no compiled native.review.packet validator');
    try {
      packetValidator(packet);
    } catch {
      throw new Error(`retained review export packet ${id} failed its compiled validator`);
    }
    if (!packet || Array.isArray(packet) || packet.id !== id || packet.component_id !== componentId || packet.file_path !== entry.file_path || packet.proof_file_hash !== entry.proof_file_hash || !Object.prototype.hasOwnProperty.call(packet, 'candidate')) {
      throw new Error(`retained review export packet ${id} identity is invalid`);
    }
    const filePath = retainedSafeRelative(entry.file_path, `packet ${id} file_path`);
    const proofFileHash = retainedDigest(entry.proof_file_hash, `packet ${id} proof_file_hash`);
    const claimId = retainedBareDigest(entry.claim_id, `packet ${id} claim_id`);
    const payloadFingerprint = retainedBareDigest(entry.payload_fingerprint, `packet ${id} payload_fingerprint`);
    if (entry.component_id !== componentId || !sourceComponents.has(componentId) || sha256Canonical(packet) !== payloadFingerprint) {
      throw new Error(`retained review export packet ${id} payload fingerprint is detached`);
    }
    packets.push(Object.freeze({
      componentId,
      id,
      filePath,
      proofFileHash,
      claimId,
      payloadFingerprint,
      packetSha256,
      bytes: packetFile.bytes,
      packet: immutableCanonicalValue(packet),
    }));
  }
  if (recoveryByPath.size !== packets.length) throw new Error('retained recovery packet manifest contains an unreferenced packet');
  const actualCounts = new Map<string, number>();
  for (const packet of packets) actualCounts.set(packet.componentId, (actualCounts.get(packet.componentId) ?? 0) + 1);
  for (const sourceRecord of source.packet_sources as Json[]) {
    const componentId = sourceRecord.component_id as string;
    if (actualCounts.get(componentId) !== sourceRecord.item_count) {
      throw new Error(`retained review export packet source count is detached for ${componentId}`);
    }
  }
  return Object.freeze({root, manifestSha256: `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`, checkpointSha256, graphSemanticDigest, packetCount: expected, packets: Object.freeze(packets)});
}

/** Emit the frozen reviewed claim payload from validated retained packet bytes. */
export function buildRetainedReviewedAggregate(input: RetainedReviewExport, componentId: string): Json {
  if (typeof componentId !== 'string' || componentId.length === 0) throw new Error('retained aggregate component ID is required');
  const packets = input.packets.filter(packet => packet.componentId === componentId);
  if (packets.length === 0) throw new Error(`retained review export has no packets for ${componentId}`);
  const reviews = packets.map(packet => ({
    id: packet.id,
    component_id: packet.componentId,
    file_path: packet.filePath,
    proof_file_hash: packet.proofFileHash,
    candidate: packet.packet.candidate,
    candidate_fingerprint: `sha256:${sha256Canonical(packet.packet.candidate)}`,
    packet_sha256: packet.packetSha256,
    retained_claim: {claim_id: packet.claimId, payload_fingerprint: packet.payloadFingerprint},
  }));
  reviews.sort((left, right) => Buffer.from(left.id, 'utf8').compare(Buffer.from(right.id, 'utf8')));
  return immutableCanonicalValue({
    version: 'native.component.reviewed/v1',
    component_id: componentId,
    status: 'reviewed-native-requirement-items',
    item_count: reviews.length,
    source: {kind: 'retained_checkpoint', checkpoint_sha256: input.checkpointSha256, graph_semantic_digest: input.graphSemanticDigest, manifest_sha256: input.manifestSha256},
    reviews,
  }) as Json;
}

export async function validateRetainedReviewExportAgainstCurrentProof(
  input: RetainedReviewExport,
  proof: string,
  subject: string,
  output: string,
  timeout: number,
): Promise<readonly RecoveryProofRequirementHash[]> {
  const ids = input.packets.map(packet => packet.id);
  const current = await loadCurrentProofRequirementHashes(proof, subject, output, timeout, ids, true);
  const currentIds = current.map(row => row.id);
  if (current.length !== input.packets.length || new Set(ids).size !== ids.length || new Set(currentIds).size !== currentIds.length ||
      [...currentIds].sort().join('\u0000') !== [...ids].sort().join('\u0000')) {
    throw new Error('current Proof requirement set does not match retained review export');
  }
  const byId = new Map(current.map(row => [row.id, row]));
  for (const packet of input.packets) {
    const row = byId.get(packet.id);
    if (!row || row.componentId !== packet.componentId || row.filePath !== packet.filePath || row.proofFileHash !== packet.proofFileHash) {
      throw new Error(`current Proof requirement hash is stale for retained packet ${packet.id}`);
    }
  }
  return Object.freeze(current);
}

export type RetainedContinuationPreparation = Readonly<{
  config: VisorConfig;
  retained: RetainedReviewExport;
  aggregateMap: Json;
  aggregateMapBase64: string;
  currentRequirements: readonly RecoveryProofRequirementHash[];
  materializedConfigPath: string;
  materializedConfigSha256: string;
  graphSemanticDigest: string;
}>;

/**
 * Bind one validated retained export to a fresh, current Proof authority and
 * compile the resulting retained graph.  The subject is intentionally not
 * initialized here: retained continuation runs against an already initialized
 * and promoted subject whose current WorkItems are rechecked by Proof.
 */
export async function loadRetainedContinuationConfig(
  inputRoot: string,
  proof: string,
  subject: string,
  output: string,
  timeout: number,
): Promise<RetainedContinuationPreparation> {
  const {prepared, inspectCheck} = onboardingConfigTemplate();
  const inventory = await loadCurrentOnboardingInventory(proof, subject, output, timeout);
  await loadResolvedOnboardingAuthority(proof, subject, output, timeout, inventory, prepared, inspectCheck);
  const baseConfig = await loadConfig(prepared, {strict: true});
  const plan = compileClaimPlan(baseConfig);
  const retained = readRetainedReviewExport(inputRoot, plan);
  const currentRequirements = await validateRetainedReviewExportAgainstCurrentProof(
    retained, proof, subject, output, timeout,
  );
  const aggregateMap = buildRetainedReviewedAggregateMap(retained);
  const aggregateMapBase64 = encodeRetainedReviewedAggregateMap(retained);
  const finalPrepared = materializeRetainedContinuationConfig(prepared, aggregateMap);
  const config = await loadConfig(finalPrepared, {strict: true});
  const graphSemanticDigest = compileClaimPlan(config).expansionPlan.graphSemanticDigest;
  const materializedConfigPath = path.join(output, 'preflight', 'retained-config.materialized.json');
  const materializedConfigBytes = canonicalJson(config) + '\n';
  writeText(materializedConfigPath, materializedConfigBytes);
  fs.chmodSync(materializedConfigPath, 0o600);
  const materializedConfigSha256 = `sha256:${createHash('sha256').update(materializedConfigBytes, 'utf8').digest('hex')}`;
  const restoredConfig = await loadConfig(JSON.parse(materializedConfigBytes) as Json, {strict: true});
  if (compileClaimPlan(restoredConfig).expansionPlan.graphSemanticDigest !== graphSemanticDigest) {
    throw new Error('persisted retained materialized config does not reproduce its graph semantic digest');
  }
  const aggregateMapFile = path.join(output, 'preflight', 'retained-aggregate-map.json');
  writeText(aggregateMapFile, canonicalJson(aggregateMap) + '\n');
  fs.chmodSync(aggregateMapFile, 0o600);
  writeJson(path.join(output, 'preflight', 'retained-continuation.json'), {
    mode: 'retained-review-continuation',
    export_root: fs.realpathSync(inputRoot),
    packet_count: retained.packetCount,
    component_ids: utf8Sorted(Object.keys(aggregateMap)),
    aggregate_map_sha256: `sha256:${createHash('sha256').update(canonicalJson(aggregateMap), 'utf8').digest('hex')}`,
    aggregate_map_base64_bytes: Buffer.byteLength(aggregateMapBase64, 'utf8'),
    current_requirement_count: currentRequirements.length,
    materialized_config_path: path.relative(output, materializedConfigPath),
    materialized_config_sha256: materializedConfigSha256,
    graph_semantic_digest: graphSemanticDigest,
  });
  return Object.freeze({config, retained, aggregateMap, aggregateMapBase64, currentRequirements,
    materializedConfigPath, materializedConfigSha256, graphSemanticDigest});
}

export type RecoveryProofRequirementHash = Readonly<{
  id: string;
  componentId: string;
  filePath: string;
  proofFileHash: string;
}>;

type RecoveryDraftInventoryEntry = Readonly<{
  path: string;
  status: string;
  kind: 'file' | 'symlink' | 'missing';
  sha256?: string;
  link_target?: string;
}>;

type RecoveryDraftInventory = Readonly<{
  root: string;
  baseline_commit: string;
  component_id: string;
  files: readonly RecoveryDraftInventoryEntry[];
  sha256: string;
}>;

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function deepJsonEqual(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value as Json).sort().map(key => [key, canonical((value as Json)[key])]));
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function gitScalar(root: string, args: string[], label: string): string {
  try {
    return String(execFileSync('git', ['-C', root, ...args], {encoding: 'utf8'})).trim();
  } catch {
    throw new Error(label + ' is not a valid Git checkout');
  }
}

function assertCleanGit(root: string, label: string): void {
  const status = String(execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], {encoding: 'utf8'}));
  if (status.trim()) throw new Error(label + ' must have a clean Git tree');
}

function gitSnapshotAtCommit(root: string, commit: string, relativePath: string):
  {kind: 'file'; bytes: Buffer} | {kind: 'symlink'; link_target: string} | undefined {
  const tree = spawnSync('git', ['-C', root, 'ls-tree', '-z', commit, '--', relativePath], {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (tree.status !== 0) return undefined;
  const record = Buffer.from(tree.stdout || '').toString('utf8').split('\0')[0];
  const tab = record.indexOf('\t');
  if (tab < 0) return undefined;
  const mode = record.slice(0, tab).split(' ')[0];
  const content = spawnSync('git', ['-C', root, 'show', `${commit}:${relativePath}`], {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (content.status !== 0) return undefined;
  const bytes = Buffer.from(content.stdout || '');
  return mode === '120000'
    ? {kind: 'symlink', link_target: bytes.toString('utf8')}
    : {kind: 'file', bytes};
}

function parseGitStatusNul(root: string): Array<{path: string; status: string}> {
  const output = String(execFileSync('git', [
    '-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all',
  ], {encoding: 'utf8'}));
  const entries: Array<{path: string; status: string}> = [];
  const tokens = output.split('\0');
  for (const token of tokens) {
    if (!token) continue;
    if (token.length < 4 || token[2] !== ' ') throw new Error('recovery checkout Git status has an invalid NUL record');
    const status = token.slice(0, 2);
    if (status.includes('R') || status.includes('C')) {
      throw new Error('recovery author draft cannot contain renames or copies');
    }
    const relativePath = token.slice(3);
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0')) {
      throw new Error('recovery checkout Git status contains an invalid path');
    }
    const normalized = path.posix.normalize(relativePath.replaceAll(path.sep, '/'));
    if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
      throw new Error('recovery checkout Git status escapes its root');
    }
    entries.push({path: normalized, status});
  }
  const unique = new Map<string, {path: string; status: string}>();
  for (const entry of entries) unique.set(entry.path, entry);
  return [...unique.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function draftFileValue(root: string, relativePath: string, baselineCommit: string):
  {kind: 'file'; bytes: Buffer} | {kind: 'symlink'; link_target: string} | {kind: 'missing'} {
  const absolute = path.join(root, relativePath);
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!stat) {
    const baseline = gitSnapshotAtCommit(root, baselineCommit, relativePath);
    return baseline ? baseline : {kind: 'missing'};
  }
  if (stat.isSymbolicLink()) return {kind: 'symlink', link_target: fs.readlinkSync(absolute)};
  if (stat.isFile()) return {kind: 'file', bytes: fs.readFileSync(absolute)};
  throw new Error(`recovery draft path is not a regular file or symlink: ${relativePath}`);
}

function currentFileValue(root: string, relativePath: string):
  {kind: 'file'; bytes: Buffer} | {kind: 'symlink'; link_target: string} | undefined {
  const absolute = path.join(root, relativePath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (stat.isSymbolicLink()) return {kind: 'symlink', link_target: fs.readlinkSync(absolute)};
  if (stat.isFile()) return {kind: 'file', bytes: fs.readFileSync(absolute)};
  throw new Error(`recovery path is not a regular file or symlink: ${relativePath}`);
}

function fileValuesEqual(
  left: {kind: 'file'; bytes: Buffer} | {kind: 'symlink'; link_target: string} | undefined,
  right: {kind: 'file'; bytes: Buffer} | {kind: 'symlink'; link_target: string} | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.kind !== right.kind) return false;
  return left.kind === 'file'
    ? left.bytes.equals((right as {kind: 'file'; bytes: Buffer}).bytes)
    : left.link_target === (right as {kind: 'symlink'; link_target: string}).link_target;
}

/**
 * Compare only the WorkItem-owned source paths with the recorded baseline.
 * The subject may have advanced with an unrelated sibling commit, but a
 * changed owned path cannot be safely replayed from a retained author draft.
 */
export function assertCanonicalOwnedPathsUnchanged(
  root: string,
  baselineCommit: string,
  ownedSourcePaths: readonly string[],
): void {
  const changed = ownedSourcePaths.filter(relativePath =>
    !fileValuesEqual(
      gitSnapshotAtCommit(root, baselineCommit, relativePath),
      currentFileValue(root, relativePath),
    )
  );
  if (changed.length > 0) {
    throw new Error(`Recovery canonical subject changed WorkItem-owned paths: ${changed.join(', ')}`);
  }
}

function isNativeComponentPath(relativePath: string): boolean {
  return /^specs\/(?:stakeholder|system|software|integration)\/(?:requirements\/[^/]+\.req\.ya?ml|variables\/[^/]+\.vars\.ya?ml)$/.test(relativePath);
}

function yamlComponent(value: Buffer | string, relativePath: string): string | undefined {
  if (!isNativeComponentPath(relativePath)) return undefined;
  try {
    const parsed = yaml.load(Buffer.isBuffer(value) ? value.toString('utf8') : value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
      typeof (parsed as Json).component === 'string'
      ? (parsed as Json).component as string
      : undefined;
  } catch {
    return undefined;
  }
}

function nativePathBelongsToComponent(
  root: string,
  baselineCommit: string,
  relativePath: string,
  componentId: string,
): boolean {
  if (!isNativeComponentPath(relativePath)) return false;
  const current = draftFileValue(root, relativePath, baselineCommit);
  if (current.kind === 'missing') return false;
  let currentBytes: Buffer;
  if (current.kind === 'file') currentBytes = current.bytes;
  else {
    if (path.isAbsolute(current.link_target)) return false;
    const target = path.resolve(path.dirname(path.join(root, relativePath)), current.link_target);
    if (!inside(target, root) || !fs.existsSync(target) || !fs.statSync(target).isFile()) return false;
    currentBytes = fs.readFileSync(target);
  }
  if (yamlComponent(currentBytes, relativePath) !== componentId) return false;
  const baseline = gitSnapshotAtCommit(root, baselineCommit, relativePath);
  if (!baseline) return true;
  const baselineBytes = baseline.kind === 'file'
    ? baseline.bytes
    : Buffer.from(baseline.link_target, 'utf8');
  return yamlComponent(baselineBytes, relativePath) === componentId;
}

function draftInventoryDigest(files: readonly RecoveryDraftInventoryEntry[]): string {
  return createHash('sha256').update(JSON.stringify(files), 'utf8').digest('hex');
}

export function inventoryAuthorDraft(
  root: string,
  baselineCommit: string,
  componentId: string,
  ownedSourcePaths: readonly string[],
): RecoveryDraftInventory {
  const owned = new Set(ownedSourcePaths);
  const files = parseGitStatusNul(root).map(({path: relativePath, status}) => {
    const allowedSource = owned.has(relativePath);
    const allowedNative = nativePathBelongsToComponent(root, baselineCommit, relativePath, componentId);
    if (!allowedSource && !allowedNative) {
      throw new Error(`recovery author draft path is outside WorkItem ownership: ${relativePath}`);
    }
    const value = draftFileValue(root, relativePath, baselineCommit);
    const entry: RecoveryDraftInventoryEntry = value.kind === 'file'
      ? {path: relativePath, status, kind: 'file', sha256: `sha256:${createHash('sha256').update(value.bytes).digest('hex')}`}
      : value.kind === 'symlink'
        ? {path: relativePath, status, kind: 'symlink', link_target: value.link_target,
          sha256: `sha256:${createHash('sha256').update(value.link_target, 'utf8').digest('hex')}`}
        : {path: relativePath, status, kind: 'missing'};
    return entry;
  });
  return Object.freeze({
    root,
    baseline_commit: baselineCommit,
    component_id: componentId,
    files: Object.freeze(files),
    sha256: `sha256:${draftInventoryDigest(files)}`,
  });
}

function assertDraftInventoryUnchanged(
  expected: RecoveryDraftInventory,
  ownedSourcePaths: readonly string[],
): void {
  const actual = inventoryAuthorDraft(expected.root, expected.baseline_commit, expected.component_id, ownedSourcePaths);
  if (actual.sha256 !== expected.sha256 || !sameJson(actual.files, expected.files)) {
    throw new Error(`recovery author draft changed before retry dispatch for ${expected.component_id}`);
  }
}

function gitCommonDirectory(root: string, label: string): string {
  const value = gitScalar(root, ['rev-parse', '--git-common-dir'], label);
  const candidate = path.isAbsolute(value) ? value : path.resolve(root, value);
  return fs.realpathSync(candidate);
}

function assertCheckoutCommonDirectory(checkoutRoot: string, canonicalRoot: string, baselineCommit: string): void {
  const commonDirectory = gitCommonDirectory(checkoutRoot, 'retained checkout');
  if (!fs.statSync(commonDirectory).isDirectory()) throw new Error('retained checkout Git common directory is not a directory');
  try {
    execFileSync('git', ['--git-dir', commonDirectory, 'cat-file', '-e', `${baselineCommit}^{commit}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('retained checkout Git common directory does not contain the WorkItem baseline');
  }
  const canonicalCommon = gitCommonDirectory(canonicalRoot, 'recovery subject');
  if (commonDirectory === canonicalCommon) return;
  // Worktree managers may use a verified bare cache. The checkout claim's
  // repository path remains the canonical subject authority; the common dir
  // must still be a real Git object store containing the exact baseline.
  if (!path.isAbsolute(commonDirectory) || commonDirectory === checkoutRoot) {
    throw new Error('retained checkout Git common directory is not an owned Git object store');
  }
}

function hasPriorIsolatedDraftReplay(checkpoint: GraphJournalCheckpointV1, generationId: string): boolean {
  return checkpoint.events.some(event =>
    event.type === 'AttemptRetryRequested' &&
    event.nodeGenerationId === generationId &&
    event.externalSideEffects === 'isolated_draft_replay'
  );
}

function assertRecoveryInputClaim(
  projection: any,
  generation: any,
  claimName: string,
): any {
  const claims = generation.activeInputClaimIds.map((id: string) => projection.claimsById[id]).filter(Boolean);
  const matches = claims.filter((claim: any) => claim.claim === claimName && claim.active);
  if (matches.length !== 1) throw new Error(`Recovery generation ${generation.nodeGenerationId} must have one active ${claimName} input`);
  return matches[0];
}

function assertSingleScopedClaim(
  projection: any,
  claimName: string,
  scope: readonly Json[],
): any {
  const matches = Object.values(projection.claimsById).filter((claim: any) =>
    claim.active === true && claim.claim === claimName && sameJson(claim.scope, scope)
  );
  if (matches.length !== 1) {
    throw new Error(`Recovery requires exactly one active ${claimName} claim at its exact scope`);
  }
  return matches[0];
}

export function assertCurrentProofRequirementHash(
  item: Json,
  currentRequirements: readonly RecoveryProofRequirementHash[],
): void {
  const matches = currentRequirements.filter(candidate => candidate.id === item.id);
  if (matches.length !== 1 || matches[0].componentId !== item.component_id ||
      matches[0].filePath !== item.file_path || matches[0].proofFileHash !== item.proof_file_hash) {
    throw new Error(`Recovery native requirement ${String(item.id || 'unknown')} has a stale current Proof hash or binding`);
  }
}

function selectedReviewRequirementIds(
  checkpoint: GraphJournalCheckpointV1,
  generationIds: readonly string[],
): string[] {
  const selected = generationIds.map(generationId => {
    const activation = checkpoint.events.find(event =>
      event.type === 'NodeGenerationActivated' && event.nodeGenerationId === generationId
    );
    if (!activation || activation.checkId !== 'review-native-item' || !Array.isArray(activation.scope)) {
      return undefined;
    }
    const itemScope = activation.scope[activation.scope.length - 1];
    return itemScope && typeof itemScope === 'object' && !Array.isArray(itemScope) &&
      typeof (itemScope as Json).key === 'string'
      ? (itemScope as Json).key as string
      : undefined;
  }).filter((value): value is string => Boolean(value));
  return [...new Set(selected)].sort();
}

async function loadCurrentProofRequirementHashes(
  proof: string,
  subject: string,
  output: string,
  timeout: number,
  ids: readonly string[],
  requireCompleteSet = false,
): Promise<readonly RecoveryProofRequirementHash[]> {
  if (ids.length === 0 && !requireCompleteSet) return [];
  const listed = parseJson(runProof(proof, subject, output, 'preflight', ['req', 'list', '--format', 'json'], timeout), 'Proof req list');
  const rows = Array.isArray(listed)
    ? listed
    : listed && typeof listed === 'object' && Array.isArray((listed as Json).requirements)
      ? (listed as Json).requirements as Json[]
      : undefined;
  if (!rows) throw new Error('Proof req list did not return a requirement array');
  const listedIds = rows.map(candidate => candidate && typeof candidate === 'object' && !Array.isArray(candidate) && typeof candidate.id === 'string' ? candidate.id : undefined);
  if (requireCompleteSet && listedIds.some(id => id === undefined)) {
    throw new Error('Proof req list contains a requirement without an exact ID');
  }
  const selectedIds = requireCompleteSet ? listedIds as string[] : [...ids];
  if (new Set(selectedIds).size !== selectedIds.length) throw new Error('Proof req list contains duplicate requirement IDs');
  return selectedIds.map(id => {
    const matchingRows = rows.filter(candidate => candidate && typeof candidate === 'object' && !Array.isArray(candidate) && candidate.id === id) as Json[];
    const row = matchingRows.length === 1 ? matchingRows[0] : undefined;
    if (!row || typeof row.component !== 'string' || typeof row.file_path !== 'string' ||
        path.isAbsolute(row.file_path) || row.file_path.includes('..')) {
      throw new Error(`Proof req list did not return an exact current row for ${id}`);
    }
    const shown = parseJson(runProof(
      proof, subject, output, 'preflight', ['req', 'show', id, '--with', 'file', '--format', 'json'], timeout,
    ), `Proof req show ${id}`) as Json;
    const requirement = shown.requirement && typeof shown.requirement === 'object' && !Array.isArray(shown.requirement)
      ? shown.requirement as Json
      : undefined;
    const computed = requirement?.['_computed'];
    const fileHash = computed && typeof computed === 'object' && !Array.isArray(computed)
      ? (computed as Json).file_hash
      : undefined;
    const shownRequirement = requirement;
    if (shown.file_path !== row.file_path || shownRequirement?.id !== id ||
        shownRequirement?.component !== row.component || typeof fileHash !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(fileHash)) {
      throw new Error(`Proof req show ${id} did not return its exact current file hash`);
    }
    return {id, componentId: row.component, filePath: row.file_path, proofFileHash: fileHash};
  });
}

function recoveryToken(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function assertRecoveryPacketScope(scope: unknown, componentScope: readonly Json[], itemId: string): void {
  if (!Array.isArray(scope) || scope.length !== componentScope.length + 1 ||
      !sameJson(scope.slice(0, componentScope.length), componentScope)) {
    throw new Error(`Recovery review packet for ${itemId} has a mismatched component scope`);
  }
  const itemScope = scope[scope.length - 1];
  if (!itemScope || typeof itemScope !== 'object' || Array.isArray(itemScope) ||
      (itemScope as Json).kind !== 'keyed' || (itemScope as Json).key !== itemId ||
      (itemScope as Json).expansionOwnerCheck !== '["onboard-component","enumerate-native-requirements"]' ||
      typeof (itemScope as Json).subgraphInstanceId !== 'string' ||
      !/^[0-9a-f]{64}$/.test((itemScope as Json).subgraphInstanceId as string)) {
    throw new Error(`Recovery review packet for ${itemId} has an invalid requirement scope`);
  }
}

export function readRecoveryReviewPackets(
  checkpointRoot: string,
  componentScope: readonly Json[],
  componentId: string,
  workItemPayload: Json,
  catalogPayload: Json,
  projection: any,
  plan: ReturnType<typeof compileClaimPlan>,
): readonly RecoveryReviewPacket[] {
  const root = realDirectory(checkpointRoot, 'retained checkpoint root');
  const packetRootCandidate = path.join(root, 'review-packets');
  const packetRootStat = fs.lstatSync(packetRootCandidate);
  if (!packetRootStat.isDirectory() || packetRootStat.isSymbolicLink()) {
    throw new Error('retained review packet root must be a regular directory');
  }
  const packetRoot = realDirectory(packetRootCandidate, 'retained review packet root');
  if (!inside(packetRoot, root) || packetRoot === root) {
    throw new Error('retained review packet root must remain inside the checkpoint root');
  }
  const componentToken = recoveryToken(componentId);
  const componentDirCandidate = path.join(packetRoot, componentToken);
  const componentDirStat = fs.lstatSync(componentDirCandidate);
  if (!componentDirStat.isDirectory() || componentDirStat.isSymbolicLink()) {
    throw new Error(`retained review packet directory must be a regular directory for ${componentId}`);
  }
  const componentDir = realDirectory(componentDirCandidate, `retained review packets for ${componentId}`);
  if (!inside(componentDir, packetRoot) || componentDir === packetRoot) {
    throw new Error(`retained review packet directory escapes the checkpoint root for ${componentId}`);
  }
  const aggregatePath = path.join(packetRoot, componentToken + '.json');
  if (fs.existsSync(aggregatePath)) {
    throw new Error(`recovery review packet source already has a component aggregate for ${componentId}`);
  }
  const items = Array.isArray(catalogPayload.items) ? catalogPayload.items as Json[] : [];
  const itemIds = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        typeof item.id !== 'string' || !item.id || itemIds.has(item.id)) {
      throw new Error(`Recovery native requirement catalog contains duplicate or invalid item IDs for ${componentId}`);
    }
    itemIds.add(item.id);
  }
  const expectedFiles = new Set(items.map(item => recoveryToken(String(item.id)) + '.json'));
  const actualEntries = fs.readdirSync(componentDir, {withFileTypes: true});
  if (actualEntries.length !== expectedFiles.size ||
      actualEntries.some(entry => !entry.isFile() || !expectedFiles.has(entry.name))) {
    throw new Error(`retained review packet set does not exactly match the native requirement catalog for ${componentId}`);
  }
  const packetClaims = Object.values(projection.claimsById).filter((claim: any) =>
    claim.active === true && claim.claim === 'native.review.packet@1' &&
    claim.producerCheckId === 'collect-proof-evidence'
  ) as any[];
  const packetValidator = plan.validatorsByClaim['native.review.packet@1'];
  const itemValidator = plan.validatorsByClaim['native.requirement.item@1'];
  const packets: RecoveryReviewPacket[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        typeof item.id !== 'string' || !item.id || item.component_id !== componentId ||
        typeof item.file_path !== 'string' || path.isAbsolute(item.file_path) || item.file_path.includes('..') ||
        typeof item.proof_file_hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(item.proof_file_hash) ||
        !item.proof_snapshot || typeof item.proof_snapshot !== 'object' || Array.isArray(item.proof_snapshot) ||
        !deepJsonEqual(item.prepared_work_item, workItemPayload)) {
      throw new Error(`Recovery native requirement item is not bound to the selected WorkItem for ${componentId}`);
    }
    try {
      itemValidator(item);
    } catch {
      throw new Error(`Recovery native requirement item failed its compiled validator for ${item.id}`);
    }
    const matches = packetClaims.filter(claim =>
      claim.payload && typeof claim.payload === 'object' && !Array.isArray(claim.payload) &&
      claim.payload.id === item.id && claim.payload.component_id === componentId
    );
    if (matches.length !== 1) {
      throw new Error(`Recovery requires exactly one active native review packet claim for ${item.id}`);
    }
    const claim = matches[0];
    if (typeof claim.claimId !== 'string' || !/^[0-9a-f]{64}$/.test(claim.claimId)) {
      throw new Error(`Recovery native review packet claim for ${item.id} has no exact claim identity`);
    }
    const claimPayload = claim.payload as Json;
    const itemSnapshot = item.proof_snapshot as Json;
    if (claimPayload.file_path !== item.file_path || claimPayload.proof_file_hash !== item.proof_file_hash ||
        !deepJsonEqual(claimPayload.prepared_work_item, workItemPayload) ||
        !deepJsonEqual(claimPayload.catalog_entry, itemSnapshot.catalog_entry) ||
        !deepJsonEqual(claimPayload.req_show, itemSnapshot.req_show) ||
        !deepJsonEqual(claimPayload.spec_graph, itemSnapshot.spec_graph)) {
      throw new Error(`Recovery native review packet claim is not bound to the catalog item ${item.id}`);
    }
    assertRecoveryPacketScope(claim.scope, componentScope, item.id);
    const relativePath = path.join('review-packets', componentToken, recoveryToken(item.id) + '.json');
    const sourcePath = path.join(root, relativePath);
    let sourceRealPath: string;
    try {
      sourceRealPath = fs.realpathSync(sourcePath);
    } catch {
      throw new Error(`retained native review packet is missing for ${item.id}`);
    }
    if (!inside(sourceRealPath, componentDir) || sourceRealPath !== path.join(componentDir, recoveryToken(item.id) + '.json')) {
      throw new Error(`retained native review packet escapes its component directory for ${item.id}`);
    }
    const sourceStat = fs.lstatSync(sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`retained native review packet is not a regular file for ${item.id}`);
    const bytes = fs.readFileSync(sourceRealPath);
    let packet: Json;
    try {
      packet = JSON.parse(bytes.toString('utf8')) as Json;
    } catch {
      throw new Error(`retained native review packet is not valid JSON for ${item.id}`);
    }
    if (!deepJsonEqual(packet, claim.payload)) {
      throw new Error(`retained native review packet does not match its checkpoint claim for ${item.id}`);
    }
    try {
      packetValidator(packet);
    } catch {
      throw new Error(`retained native review packet failed its compiled validator for ${item.id}`);
    }
    packets.push(Object.freeze({
      componentId,
      id: item.id,
      claimId: claim.claimId,
      sourceRelativePath: relativePath,
      bytes,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    }));
  }
  return Object.freeze(packets);
}

export function stageRecoveryReviewPackets(
  output: string,
  packets: readonly RecoveryReviewPacket[],
): Json {
  if (!path.isAbsolute(output)) throw new Error('recovery review packet output must be absolute');
  const outputRoot = path.resolve(output);
  const packetRoot = path.join(outputRoot, 'review-packets');
  fs.mkdirSync(packetRoot, {recursive: true, mode: 0o700});
  fs.chmodSync(packetRoot, 0o700);
  const entries: Json[] = [];
  for (const packet of packets) {
    const componentDir = path.join(packetRoot, recoveryToken(packet.componentId));
    fs.mkdirSync(componentDir, {recursive: true, mode: 0o700});
    fs.chmodSync(componentDir, 0o700);
    const destination = path.join(componentDir, recoveryToken(packet.id) + '.json');
    if (!inside(destination, componentDir) || path.dirname(destination) !== componentDir) {
      throw new Error(`recovery review packet destination escapes its component directory for ${packet.id}`);
    }
    fs.writeFileSync(destination, packet.bytes, {flag: 'wx', mode: 0o600});
    fs.chmodSync(destination, 0o600);
    const copied = fs.readFileSync(destination);
    const copiedSha = `sha256:${createHash('sha256').update(copied).digest('hex')}`;
    if (!copied.equals(packet.bytes) || copiedSha !== packet.sha256) {
      throw new Error(`recovery review packet changed while staging for ${packet.id}`);
    }
    entries.push({
      component_id: packet.componentId,
      id: packet.id,
      claim_id: packet.claimId,
      source: packet.sourceRelativePath,
      destination: path.relative(outputRoot, destination),
      bytes: packet.bytes.byteLength,
      source_sha256: packet.sha256,
      destination_sha256: copiedSha,
    });
  }
  const manifest = {version: 1, kind: 'retained-native-review-packet-manifest', packets: entries};
  const manifestPath = path.join(outputRoot, 'recovery', 'review-packet-manifest.json');
  writeJson(manifestPath, manifest);
  fs.chmodSync(manifestPath, 0o600);
  return manifest;
}

/**
 * Validate the immutable checkpoint projection and the retained native inputs
 * before the retry API is allowed to append its retry events.
 */
export function validateRecoverySelection(
  config: VisorConfig,
  checkpoint: GraphJournalCheckpointV1,
  retryGenerationIds: readonly string[],
  roots: RecoveryRoots,
  inventory: Json,
  externalSideEffects: RecoverySideEffects,
  currentProofRequirements: readonly RecoveryProofRequirementHash[] = [],
): {journal: ExecutionJournal; bindings: readonly RecoveryBinding[]; reviewPackets: readonly RecoveryReviewPacket[]} {
  const plan = compileClaimPlan(config);
  if (checkpoint.graphSemanticDigest !== plan.expansionPlan.graphSemanticDigest) {
    throw new Error('Recovery checkpoint graph semantic digest does not match the retained configuration authority');
  }
  if (externalSideEffects !== 'absent' && externalSideEffects !== 'safely_idempotent' &&
      externalSideEffects !== 'isolated_draft_replay') {
    throw new Error('Recovery has an unsupported external side-effect disposition');
  }
  if (externalSideEffects === 'isolated_draft_replay' && retryGenerationIds.length !== 1) {
    throw new Error('isolated draft replay requires exactly one selected author generation');
  }
  const journal = ExecutionJournal.restoreGraphCheckpoint(plan, checkpoint);
  const projection: any = journal.getInstanceProjection();
  const selectedChecks = retryGenerationIds.map(generationId => projection.generationsById[generationId]?.checkId);
  const componentReviewCount = selectedChecks.filter(checkId => checkId === 'component-reviewed').length;
  if (componentReviewCount > 0 && (componentReviewCount !== selectedChecks.length || externalSideEffects !== 'absent')) {
    throw new Error('component-reviewed recovery must select only component-reviewed leaves with absent external side effects');
  }
  const nativeReviewCount = selectedChecks.filter(checkId => checkId === 'review-native-item').length;
  if (nativeReviewCount > 0 && (nativeReviewCount !== selectedChecks.length || externalSideEffects !== 'absent')) {
    throw new Error('review-native-item recovery must select only review-native-item leaves with absent external side effects');
  }
  if (externalSideEffects === 'isolated_draft_replay' &&
      selectedChecks.some(checkId => checkId !== 'author-native-component')) {
    throw new Error('isolated draft replay must select only failed author leaves');
  }
  const authority = inventory.authority && typeof inventory.authority === 'object' && !Array.isArray(inventory.authority)
    ? inventory.authority as Json
    : undefined;
  if (!authority || typeof authority.project_id !== 'string' ||
      typeof authority.subject_fingerprint !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(authority.subject_fingerprint)) {
    throw new Error('Recovery Proof inventory did not provide a current authenticated project fingerprint');
  }
  assertCleanGit(roots.subject, 'recovery subject');
  const subjectHead = gitScalar(roots.subject, ['rev-parse', '--verify', 'HEAD^{commit}'], 'recovery subject');
  const worktreeRoot = path.join(roots.priorOutput, 'worktrees');
  if (!fs.existsSync(worktreeRoot) || !fs.statSync(worktreeRoot).isDirectory()) {
    throw new Error('prior output is missing its retained worktree root');
  }
  const retainedWorktreeRoot = fs.realpathSync(worktreeRoot);
  const bindings: RecoveryBinding[] = [];
  const reviewPackets: RecoveryReviewPacket[] = [];
  const stagedReviewComponents = new Set<string>();
  const selectedReviewItemIds = new Set<string>();
  for (const generationId of retryGenerationIds) {
    const generation = projection.generationsById[generationId];
    if (generation?.checkId === 'review-native-item' && Array.isArray(generation.scope)) {
      const itemScope = generation.scope[generation.scope.length - 1];
      if (itemScope && typeof itemScope === 'object' && !Array.isArray(itemScope) &&
          typeof (itemScope as Json).key === 'string') {
        selectedReviewItemIds.add((itemScope as Json).key as string);
      }
    }
  }
  for (const generationId of retryGenerationIds) {
    const generation = projection.generationsById[generationId];
    const authorReplay = externalSideEffects === 'isolated_draft_replay';
    const componentReviewReplay = generation?.checkId === 'component-reviewed';
    const nativeReviewReplay = generation?.checkId === 'review-native-item';
    const expectedCheckId = componentReviewReplay
      ? 'component-reviewed'
      : nativeReviewReplay ? 'review-native-item'
      : authorReplay ? 'author-native-component' : 'promote-native-component';
    if (!generation || generation.checkId !== expectedCheckId || generation.status !== 'failed' ||
        !generation.scheduled || typeof generation.attemptId !== 'string' || typeof generation.fence !== 'number' ||
        typeof generation.reason !== 'string' || generation.completedOutputClaimIds.length !== 0) {
      throw new Error(`Recovery generation ${generationId} is not an eligible failed ${authorReplay ? 'author' : nativeReviewReplay ? 'native review' : 'promotion'} leaf`);
    }
    if (authorReplay && hasPriorIsolatedDraftReplay(checkpoint, generationId)) {
      throw new Error(`Recovery generation ${generationId} already has an isolated draft replay`);
    }
    if (!authorReplay && hasPriorIsolatedDraftReplay(checkpoint, generationId)) {
      throw new Error(`Recovery generation ${generationId} has already used isolated draft replay`);
    }
    if (!componentReviewReplay && !nativeReviewReplay && Object.values(projection.instancesById).some((instance: any) =>
      instance.status === 'active' && instance.parentSubgraphInstanceId === generation.subgraphInstanceId)) {
      throw new Error(`Recovery generation ${generationId} still has active descendants`);
    }
    const claims = generation.activeInputClaimIds.map((id: string) => projection.claimsById[id]).filter(Boolean);
    const expectedClaims = componentReviewReplay
      ? ['component.prepared_work_item@1', 'native.requirement.catalog@1']
      : nativeReviewReplay
        ? ['native.requirement.item@1']
      : authorReplay
        ? ['component.checkout@1', 'component.prepared_work_item@1', 'native.role.onboard@1']
        : ['component.checkout@1', 'component.prepared_work_item@1', 'native.author.evidence@1'];
    if (claims.length !== expectedClaims.length ||
        new Set(claims.map((claim: any) => claim.claim)).size !== expectedClaims.length ||
        expectedClaims.some(claimName => !claims.some((claim: any) => claim.claim === claimName))) {
      throw new Error(`Recovery generation ${generationId} has an unexpected ${authorReplay ? 'author' : 'promotion'} input set`);
    }
    const reviewItem = nativeReviewReplay ? assertRecoveryInputClaim(projection, generation, 'native.requirement.item@1') : undefined;
    const reviewComponentScope = nativeReviewReplay ? generation.scope.slice(0, -1) : undefined;
    const workItem = nativeReviewReplay
      ? assertSingleScopedClaim(projection, 'component.prepared_work_item@1', reviewComponentScope || [])
      : assertRecoveryInputClaim(projection, generation, 'component.prepared_work_item@1');
    const checkout = componentReviewReplay || nativeReviewReplay ? undefined : assertRecoveryInputClaim(projection, generation, 'component.checkout@1');
    const author = componentReviewReplay || nativeReviewReplay ? undefined : assertRecoveryInputClaim(
      projection, generation, authorReplay ? 'native.role.onboard@1' : 'native.author.evidence@1'
    );
    const catalog = componentReviewReplay
      ? assertRecoveryInputClaim(projection, generation, 'native.requirement.catalog@1')
      : nativeReviewReplay
        ? assertSingleScopedClaim(projection, 'native.requirement.catalog@1', reviewComponentScope || [])
        : undefined;
    const reviewRole = nativeReviewReplay
      ? assertSingleScopedClaim(projection, 'native.role.spec_review@1', reviewComponentScope || [])
      : undefined;
    const expectedWorkItemScope = nativeReviewReplay ? reviewComponentScope : generation.scope;
    if (workItem.producerCheckId !== 'prepare-work-item' ||
        (componentReviewReplay
          ? catalog?.producerCheckId !== 'enumerate-native-requirements'
          : nativeReviewReplay
            ? catalog?.producerCheckId !== 'enumerate-native-requirements' ||
              reviewRole?.producerCheckId !== 'role-spec-review-component'
          : checkout?.producerCheckId !== 'checkout-worktree' ||
            (authorReplay ? author?.producerCheckId !== 'role-onboard-component' : author?.producerCheckId !== 'author-native-component')) ||
        !sameJson(workItem.scope, expectedWorkItemScope) ||
        (componentReviewReplay ? !sameJson(catalog?.scope, generation.scope) : nativeReviewReplay
          ? !sameJson(catalog?.scope, reviewComponentScope) || !sameJson(reviewRole?.scope, reviewComponentScope) :
          !sameJson(checkout?.scope, generation.scope) || !sameJson(author?.scope, generation.scope))) {
      throw new Error(`Recovery generation ${generationId} has mismatched native input provenance`);
    }
    if (authorReplay && !componentReviewReplay && !nativeReviewReplay && (typeof author?.payload !== 'string' || author.payload.length === 0)) {
      throw new Error(`Recovery generation ${generationId} has no built-in onboard role authority`);
    }
    const workItemPayload = workItem.payload && typeof workItem.payload === 'object' && !Array.isArray(workItem.payload)
      ? workItem.payload as Json
      : undefined;
    if (!workItemPayload || typeof workItemPayload.component_id !== 'string' || !workItemPayload.component_id ||
        typeof workItemPayload.baseline_commit !== 'string' || !/^[0-9a-f]{40,64}$/.test(workItemPayload.baseline_commit) ||
        typeof workItemPayload.project_id !== 'string' || workItemPayload.project_id !== authority.project_id) {
      throw new Error(`Recovery generation ${generationId} has an invalid or stale Proof WorkItem`);
    }
    const componentSubject = workItemPayload.proof_component_subject;
    if (!componentSubject || typeof componentSubject !== 'object' || Array.isArray(componentSubject) ||
        (componentSubject as Json).component_id !== workItemPayload.component_id ||
        typeof (componentSubject as Json).fingerprint !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test((componentSubject as Json).fingerprint as string)) {
      throw new Error(`Recovery generation ${generationId} has incomplete Proof component subject authority`);
    }
    const baselineCommit = workItemPayload.baseline_commit;
    const ownedSourcePaths = Array.isArray(workItemPayload.sorted_owned_paths)
      ? workItemPayload.sorted_owned_paths.filter((value): value is string => typeof value === 'string')
      : [];
    if (ownedSourcePaths.length === 0 || ownedSourcePaths.some(value => path.isAbsolute(value) || value.includes('..'))) {
      throw new Error(`Recovery WorkItem for ${workItemPayload.component_id} has no safe sorted owned paths`);
    }
    if (!authorReplay && !componentReviewReplay && !nativeReviewReplay && subjectHead !== baselineCommit) {
      throw new Error(`Recovery subject HEAD does not match WorkItem baseline for ${workItemPayload.component_id}`);
    }
    const checkoutPayload = checkout?.payload && typeof checkout.payload === 'object' && !Array.isArray(checkout.payload)
      ? checkout.payload as Json
      : undefined;
    if (!componentReviewReplay && !nativeReviewReplay && (!checkoutPayload || checkoutPayload.success !== true || checkoutPayload.is_worktree !== true ||
        typeof checkoutPayload.path !== 'string' || !path.isAbsolute(checkoutPayload.path) ||
        typeof checkoutPayload.commit !== 'string' || checkoutPayload.commit !== baselineCommit ||
        typeof checkoutPayload.ref !== 'string' || checkoutPayload.ref !== baselineCommit ||
        typeof checkoutPayload.repository !== 'string' ||
        typeof checkoutPayload.worktree_id !== 'string' || checkoutPayload.worktree_id.length === 0)) {
      throw new Error(`Recovery generation ${generationId} has an invalid retained checkout binding`);
    }
    const checkoutPath = !componentReviewReplay && checkoutPayload
      ? fs.realpathSync(checkoutPayload.path)
      : undefined;
    if (!componentReviewReplay && !nativeReviewReplay && (!checkoutPath || !inside(checkoutPath, retainedWorktreeRoot) || checkoutPath === retainedWorktreeRoot)) {
      throw new Error(`Recovery checkout for ${workItemPayload.component_id} is outside the retained worktree root`);
    }
    const checkoutGitRoot = checkoutPath ? realDirectory(gitRoot(checkoutPath), 'retained checkout Git root') : undefined;
    if (!componentReviewReplay && !nativeReviewReplay && (!checkoutPath || checkoutGitRoot !== checkoutPath ||
        gitScalar(checkoutPath, ['rev-parse', '--verify', 'HEAD^{commit}'], 'retained checkout') !== baselineCommit)) {
      throw new Error(`Recovery retained checkout for ${workItemPayload.component_id} is not pinned to its WorkItem baseline`);
    }
    // Author checkouts intentionally retain their uncommitted native draft.
    // Verify only immutable Git identity here; never clean or rewrite drafts.
    if (!componentReviewReplay && !nativeReviewReplay && checkoutPath && checkoutPayload) {
      const repository = realDirectory(checkoutPayload.repository as string, 'retained checkout repository');
      if (repository !== roots.subject) throw new Error(`Recovery checkout for ${workItemPayload.component_id} has a mismatched repository`);
      assertCheckoutCommonDirectory(checkoutPath, roots.subject, baselineCommit);
    }
    let draftInventory: RecoveryDraftInventory | undefined;
    if (authorReplay) {
      if (!checkoutPath) throw new Error(`Recovery author generation ${generationId} has no retained checkout`);
      draftInventory = inventoryAuthorDraft(checkoutPath, baselineCommit, workItemPayload.component_id, ownedSourcePaths);
    }
    if (authorReplay && (!draftInventory || draftInventory.files.length === 0)) {
      throw new Error(`Recovery author draft inventory is empty for ${workItemPayload.component_id}`);
    }
    if (authorReplay) {
      const retainedNativePaths = draftInventory?.files
        .map(file => file.path)
        .filter(isNativeComponentPath) || [];
      const canonicalPaths = [...new Set([...ownedSourcePaths, ...retainedNativePaths])];
      assertCanonicalOwnedPathsUnchanged(roots.subject, baselineCommit, canonicalPaths);
    }
    if (nativeReviewReplay) {
      if (!roots.checkpointRoot || !reviewItem || !catalog || !reviewRole || !reviewComponentScope) {
        throw new Error(`Recovery generation ${generationId} has incomplete native review authority`);
      }
      const itemPayload = reviewItem.payload && typeof reviewItem.payload === 'object' && !Array.isArray(reviewItem.payload)
        ? reviewItem.payload as Json
        : undefined;
      const catalogPayload = catalog.payload && typeof catalog.payload === 'object' && !Array.isArray(catalog.payload)
        ? catalog.payload as Json
        : undefined;
      const itemScope = generation.scope[generation.scope.length - 1];
      if (!itemPayload || !catalogPayload || !Array.isArray(catalogPayload.items) || catalogPayload.items.length === 0 ||
          itemPayload.component_id !== workItemPayload.component_id ||
          itemPayload.id !== generation.scope[generation.scope.length - 1]?.key ||
          itemPayload.file_path === undefined ||
          !deepJsonEqual(itemPayload.prepared_work_item, workItemPayload) ||
          !sameJson(reviewItem.scope, generation.scope) ||
          !itemScope || typeof itemScope !== 'object' || Array.isArray(itemScope) ||
          reviewItem.producerCheckId !== (itemScope as Json).expansionOwnerCheck ||
          reviewItem.kind !== 'controller-item' || reviewItem.controllerCatalogClaimId !== catalog.claimId ||
          !Array.isArray(reviewItem.parentClaimIds) || reviewItem.parentClaimIds.length !== 1 ||
          reviewItem.parentClaimIds[0] !== catalog.claimId ||
          typeof reviewRole.payload !== 'string' || reviewRole.payload !== itemPayload.spec_review_role ||
          !Array.isArray(reviewRole.parentClaimIds) || !Array.isArray(workItem.parentClaimIds) ||
          !sameJson(reviewRole.parentClaimIds, workItem.parentClaimIds) ||
          !Array.isArray(catalog.parentClaimIds) ||
          !catalog.parentClaimIds.includes(workItem.claimId) || !catalog.parentClaimIds.includes(reviewRole.claimId)) {
        throw new Error(`Recovery generation ${generationId} has an unbound native review item or role`);
      }
      try {
        plan.validatorsByClaim['native.requirement.item@1'](itemPayload);
        plan.validatorsByClaim['native.requirement.catalog@1'](catalogPayload);
      } catch {
        throw new Error(`Recovery native review item or catalog failed its compiled validator for ${itemPayload.id}`);
      }
      const catalogItems = catalogPayload.items as Json[];
      if (catalogItems.filter(item => item && item.id === itemPayload.id).length !== 1) {
        throw new Error(`Recovery native review item ${String(itemPayload.id)} is not the exact catalog item`);
      }
      const catalogItem = catalogItems.find(item => item && item.id === itemPayload.id);
      if (!catalogItem || !deepJsonEqual(catalogItem, itemPayload)) {
        throw new Error(`Recovery native review item ${String(itemPayload.id)} does not match its catalog entry`);
      }
      assertCurrentProofRequirementHash(itemPayload, currentProofRequirements);
      const existingPacket = Object.values(projection.claimsById).some((claim: any) =>
        claim.active === true && claim.claim === 'native.review.packet@1' &&
        claim.producerCheckId === 'collect-proof-evidence' && claim.payload?.id === itemPayload.id &&
        claim.payload?.component_id === workItemPayload.component_id
      );
      if (existingPacket) {
        throw new Error(`Recovery native review item ${String(itemPayload.id)} already has a retained packet`);
      }
      if (!selectedReviewItemIds.has(String(itemPayload.id))) {
        throw new Error(`Recovery native review item ${String(itemPayload.id)} was not selected exactly`);
      }
      if (!stagedReviewComponents.has(workItemPayload.component_id)) {
        const componentPacketClaims = Object.values(projection.claimsById).filter((claim: any) =>
          claim.active === true && claim.claim === 'native.review.packet@1' &&
          claim.producerCheckId === 'collect-proof-evidence' && claim.payload?.component_id === workItemPayload.component_id
        ) as any[];
        const packetClaimsById = new Map<string, any[]>();
        for (const claim of componentPacketClaims) {
          const itemId = claim.payload && typeof claim.payload.id === 'string' ? claim.payload.id : '';
          const claimsForItem = packetClaimsById.get(itemId) || [];
          claimsForItem.push(claim);
          packetClaimsById.set(itemId, claimsForItem);
        }
        const catalogIds = new Set(catalogItems.map(item => item && typeof item.id === 'string' ? item.id : ''));
        if ([...packetClaimsById.keys()].some(itemId => !itemId || !catalogIds.has(itemId))) {
          throw new Error(`Recovery native review packet claims contain an item outside the exact catalog for ${workItemPayload.component_id}`);
        }
        for (const [itemId, claimsForItem] of packetClaimsById) {
          if (claimsForItem.length !== 1) {
            throw new Error(`Recovery requires exactly one active native review packet claim for ${itemId}`);
          }
          if (selectedReviewItemIds.has(itemId)) {
            throw new Error(`Recovery native review item ${itemId} already has a retained packet`);
          }
        }
        const retainedItems = catalogItems.filter(item =>
          item && typeof item.id === 'string' && packetClaimsById.has(item.id)
        );
        const retainedComponentDir = path.join(
          roots.checkpointRoot, 'review-packets', recoveryToken(workItemPayload.component_id),
        );
        if (retainedItems.length > 0 || fs.existsSync(retainedComponentDir)) {
          const retainedCatalog = {...catalogPayload, items: retainedItems};
          reviewPackets.push(...readRecoveryReviewPackets(
            roots.checkpointRoot, reviewComponentScope, workItemPayload.component_id, workItemPayload,
            retainedCatalog, projection, plan,
          ));
        }
        stagedReviewComponents.add(workItemPayload.component_id);
      }
    } else if (componentReviewReplay) {
      if (!roots.checkpointRoot) {
        throw new Error('component-reviewed recovery requires an explicit retained checkpoint root');
      }
      if (!catalog || !catalog.payload || typeof catalog.payload !== 'object' || Array.isArray(catalog.payload)) {
        throw new Error(`Recovery generation ${generationId} has no native requirement catalog`);
      }
      const catalogPayload = catalog.payload as Json;
      if (catalogPayload.component_id !== workItemPayload.component_id || !Array.isArray(catalogPayload.items) || catalogPayload.items.length === 0) {
        throw new Error(`Recovery generation ${generationId} has an invalid native requirement catalog`);
      }
      const catalogValidator = plan.validatorsByClaim['native.requirement.catalog@1'];
      try {
        catalogValidator(catalogPayload);
      } catch {
        throw new Error(`Recovery native requirement catalog failed its compiled validator for ${workItemPayload.component_id}`);
      }
      reviewPackets.push(...readRecoveryReviewPackets(
        roots.checkpointRoot, generation.scope, workItemPayload.component_id, workItemPayload,
        catalogPayload, projection, plan,
      ));
    }
    bindings.push(Object.freeze({
      generationId,
      componentId: workItemPayload.component_id,
      baselineCommit,
      ...(checkoutPath ? {checkoutPath} : {}),
      workItemClaimId: workItem.claimId,
      ...(checkout ? {checkoutClaimId: checkout.claimId} : {}),
      ...(author ? {authorClaimId: author.claimId} : {}),
      ...(authorReplay ? {ownedSourcePaths: Object.freeze([...ownedSourcePaths])} : {}),
      ...(draftInventory ? {draftInventory} : {}),
    }));
  }
  // Exercise the same immutable kernel eligibility check that the resumed
  // engine will use.  This is deliberately a separately restored journal so
  // preflight cannot append retry events to the source checkpoint.
  const eligibilityJournal = ExecutionJournal.restoreGraphCheckpoint(plan, checkpoint);
  eligibilityJournal.retryFailedGeneratedAttempts({
    sessionId: checkpoint.sessionId,
    nodeGenerationIds: retryGenerationIds,
    externalSideEffects,
  });
  return {journal, bindings: Object.freeze(bindings), reviewPackets: Object.freeze(reviewPackets)};
}

function summarizeCheckpoint(checkpoint: unknown, noNativeAdmissionClaimed = true): Json {
  if (!checkpoint || typeof checkpoint !== 'object') return {available: false};
  const events = Array.isArray((checkpoint as Json).events) ? (checkpoint as Json).events as Json[] : [];
  const completed = events.filter(event => event.type === 'AttemptCompleted');
  const failed = events.filter(event => event.type === 'AttemptFailed' || event.type === 'CheckErrored');
  const byCheck: Record<string, number> = {};
  for (const event of completed) {
    const check = typeof event.checkId === 'string' ? event.checkId : 'unknown';
    byCheck[check] = (byCheck[check] || 0) + 1;
  }
  return {
    available: true,
    event_count: events.length,
    completed_attempts: completed.length,
    failed_attempts: failed.length,
    completed_by_check: byCheck,
    failed_by_check: Object.fromEntries(failed.map(event => [String(event.checkId || 'unknown'), (failed.filter(item => item.checkId === event.checkId).length)])),
    has_failures: failed.length > 0,
    no_native_admission_claimed: noNativeAdmissionClaimed,
  };
}

/**
 * Recover the expected natural component count from the journal's current
 * Proof catalog and its controller-owned WorkItems. No completed-attempt count
 * or runner-side manifest is authoritative for this boundary.
 */
export function countAuthoritativeMaterializedComponents(config: VisorConfig, checkpoint: unknown): number {
  return materializedComponentIds(config, checkpoint).length;
}

/** Return the exact current WorkItem component IDs owned by the active catalog. */
export function materializedComponentIds(config: VisorConfig, checkpoint: unknown): readonly string[] {
  const plan = compileClaimPlan(config);
  const journal = ExecutionJournal.restoreGraphCheckpoint(plan, checkpoint);
  const projection = journal.getInstanceProjection();
  const activeClaims = Object.values(projection.claimsById).filter(claim => claim.active);
  const catalogs = activeClaims.filter(claim =>
    claim.kind === 'generated-output' &&
    claim.claim === 'component.catalog@1' &&
    claim.producerCheckId === 'materialize_catalog'
  );
  if (catalogs.length !== 1) throw new Error('checkpoint must contain exactly one active materialized component catalog');
  const catalog = catalogs[0];
  const payload = catalog.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('materialized component catalog payload is invalid');
  const components = (payload as Json).components;
  if (!Array.isArray(components) || components.length === 0) throw new Error('materialized component catalog has no components');
  const componentIds = components.map((component, index) => {
    if (!component || typeof component !== 'object' || Array.isArray(component) || typeof (component as Json).component_id !== 'string' || !(component as Json).component_id) {
      throw new Error(`materialized component catalog entry ${index} has no exact component_id`);
    }
    return (component as Json).component_id as string;
  });
  if (new Set(componentIds).size !== componentIds.length) throw new Error('materialized component catalog contains duplicate component_id values');
  const workItems = activeClaims.filter(claim =>
    claim.kind === 'controller-item' &&
    claim.claim === 'component.work_item@1' &&
    claim.controllerCatalogClaimId === catalog.claimId
  );
  const workItemIds = workItems.map((claim, index) => {
    const item = claim.payload;
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof (item as Json).component_id !== 'string' || !(item as Json).component_id) {
      throw new Error(`materialized component WorkItem ${index} has no exact component_id`);
    }
    return (item as Json).component_id as string;
  });
  if (new Set(workItemIds).size !== workItemIds.length ||
      workItemIds.slice().sort().join('\u0000') !== componentIds.slice().sort().join('\u0000')) {
    throw new Error('materialized component WorkItems do not exactly match the current component catalog');
  }
  return Object.freeze(utf8Sorted(workItemIds));
}

/**
 * Confirm that the final retained journal contains the current WorkItems, all
 * component suffix receipts, and the project reconciliation receipt. Historical
 * failures are not silently treated as completion.
 */
export function retainedContinuationCheckpointIsComplete(
  config: VisorConfig,
  checkpoint: unknown,
  expectedComponentIds: readonly string[],
): boolean {
  try {
    const plan = compileClaimPlan(config);
    const projection = ExecutionJournal.restoreGraphCheckpoint(plan, checkpoint).getInstanceProjection();
    if (Object.values(projection.generationsById).some(generation => generation.status === 'failed')) return false;
    const actual = materializedComponentIds(config, checkpoint);
    const expected = utf8Sorted(expectedComponentIds);
    if (actual.join('\u0000') !== expected.join('\u0000')) return false;
    const componentScope = (claim: {scope: readonly {kind: string; key?: string}[]}) => {
      const last = claim.scope[claim.scope.length - 1];
      return last && last.kind === 'keyed' && typeof last.key === 'string' ? last.key : undefined;
    };
    const exactParents = (actual: readonly string[], expected: readonly string[]): boolean =>
      actual.length === expected.length &&
      new Set(actual).size === actual.length &&
      actual.every(parent => expected.includes(parent)) &&
      expected.every(parent => actual.includes(parent));
    const sortedParents = (actual: readonly string[], expected: readonly string[]): boolean =>
      exactParents(actual, expected) && sameJson(actual, [...expected].sort());
    const activeClaims = Object.values(projection.claimsById).filter(claim => claim.active);
    const workItems = activeClaims.filter(claim =>
      claim.kind === 'controller-item' && claim.claim === 'component.work_item@1' && componentScope(claim) !== undefined,
    );
    const workItemDigests = new Map<string, string>();
    const suffix = [
      ['proof.candidate@1', 'inspect'],
      ['proof.admitted_receipt@1', 'proof_admit'],
      ['proof.component_spec_review_candidate@1', 'spec_review'],
      ['proof.component_spec_review_admitted_receipt@1', 'spec_review_admit'],
    ] as const;
    for (const componentId of expected) {
      const currentWorkItems = workItems.filter(claim => componentScope(claim) === componentId);
      if (currentWorkItems.length !== 1) return false;
      const workItem = currentWorkItems[0];
      const workItemPayload = workItem.payload;
      const authority = workItemPayload && typeof workItemPayload === 'object' && !Array.isArray(workItemPayload)
        ? (workItemPayload as Json).authority
        : undefined;
      const workItemDigest = authority && typeof authority === 'object' && !Array.isArray(authority) &&
        typeof (authority as Json).work_item_digest === 'string'
        ? (authority as Json).work_item_digest as string
        : undefined;
      if (!workItemDigest || !/^sha256:[0-9a-f]{64}$/.test(workItemDigest) || workItemDigests.has(componentId)) return false;
      workItemDigests.set(componentId, workItemDigest);
      const reviewed = activeClaims.filter(claim =>
        claim.claim === 'native.component.reviewed@1' &&
        claim.producerCheckId === 'component-reviewed' &&
        componentScope(claim) === componentId,
      );
      if (reviewed.length !== 1 || reviewed[0].kind !== 'generated-output' ||
          reviewed[0].subgraphInstanceId !== workItem.subgraphInstanceId ||
          !sortedParents(reviewed[0].parentClaimIds, [workItem.claimId])) return false;
      const candidates = activeClaims.filter(claim =>
        claim.claim === 'proof.candidate@1' && claim.producerCheckId === 'inspect' && componentScope(claim) === componentId,
      );
      if (candidates.length !== 1 || candidates[0].kind !== 'generated-output' ||
          candidates[0].subgraphInstanceId !== workItem.subgraphInstanceId ||
          !sortedParents(candidates[0].parentClaimIds, [workItem.claimId, reviewed[0].claimId])) return false;
      for (const [claimRef, producer] of suffix) {
        const matches = activeClaims.filter(claim => claim.claim === claimRef && claim.producerCheckId === producer && componentScope(claim) === componentId);
        if (matches.length !== 1) return false;
        if (claimRef === 'proof.admitted_receipt@1' || claimRef === 'proof.component_spec_review_admitted_receipt@1') {
          const receipt = matches[0].payload;
          if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
              (receipt as Json).Status !== 'ADMITTED' || typeof (receipt as Json).ClaimID !== 'string' ||
              typeof (receipt as Json).PayloadFingerprint !== 'string') return false;
          const expectedClaim = claimRef === 'proof.admitted_receipt@1' ? candidates[0] : undefined;
          if (expectedClaim && ((matches[0].payload as Json).ClaimID !== expectedClaim.claimId ||
              (matches[0].payload as Json).PayloadFingerprint !== expectedClaim.payloadFingerprint)) return false;
        }
      }
      const admission = activeClaims.filter(claim =>
        claim.claim === 'proof.admitted_receipt@1' && claim.producerCheckId === 'proof_admit' && componentScope(claim) === componentId,
      );
      const stagedCandidates = activeClaims.filter(claim =>
        claim.claim === 'proof.component_spec_review_candidate@1' && claim.producerCheckId === 'spec_review' && componentScope(claim) === componentId,
      );
      const stagedAdmissions = activeClaims.filter(claim =>
        claim.claim === 'proof.component_spec_review_admitted_receipt@1' && claim.producerCheckId === 'spec_review_admit' && componentScope(claim) === componentId,
      );
      if (admission.length !== 1 || stagedCandidates.length !== 1 || stagedAdmissions.length !== 1 ||
          !sortedParents(admission[0].parentClaimIds, [candidates[0].claimId]) ||
          !sortedParents(stagedAdmissions[0].parentClaimIds, [stagedCandidates[0].claimId]) ||
          !sortedParents(stagedCandidates[0].parentClaimIds, [workItem.claimId, candidates[0].claimId, admission[0].claimId])) return false;
      const stagedReceipt = stagedAdmissions[0].payload;
      if (!stagedReceipt || typeof stagedReceipt !== 'object' || Array.isArray(stagedReceipt) ||
          (stagedReceipt as Json).ClaimID !== stagedCandidates[0].claimId ||
          (stagedReceipt as Json).PayloadFingerprint !== stagedCandidates[0].payloadFingerprint) return false;
    }
    const reconciliations = activeClaims.filter(claim => claim.claim === 'proof.project_reconciliation_receipt@1' && claim.producerCheckId === 'project_reconcile');
    if (reconciliations.length !== 1) return false;
    const reconciliation = reconciliations[0];
    if (!reconciliation || !reconciliation.payload || typeof reconciliation.payload !== 'object' || Array.isArray(reconciliation.payload) ||
        (reconciliation.payload as Json).version !== 'proof.project-reconciliation-receipt/v1') return false;
    const admissions = (reconciliation.payload as Json).component_admissions;
    const covered = (reconciliation.payload as Json).covered_work_item_digests;
    const expectedWorkItemDigests = expected.map(componentId => workItemDigests.get(componentId));
    if (expectedWorkItemDigests.some((digest): digest is undefined => digest === undefined) ||
        new Set(expectedWorkItemDigests).size !== expectedWorkItemDigests.length) return false;
    const admissionRows = Array.isArray(admissions) ? admissions.map(value =>
      value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined,
    ) : [];
    if (!Array.isArray(admissions) || !Array.isArray(covered) || admissions.length !== expected.length || covered.length !== expected.length ||
        new Set(covered.filter(value => typeof value === 'string')).size !== expected.length ||
        utf8Sorted(covered.filter((value): value is string => typeof value === 'string')).join('\u0000') !== utf8Sorted(expectedWorkItemDigests as string[]).join('\u0000') ||
        new Set(admissions.map(value => value && typeof value === 'object' && !Array.isArray(value) ? (value as Json).component_id : undefined)).size !== expected.length ||
        admissionRows.some(value => !value || typeof value.component_id !== 'string' || !expected.includes(value.component_id) ||
          typeof value.work_item_digest !== 'string' || value.work_item_digest !== workItemDigests.get(value.component_id))) return false;
    const forbiddenChecks = new Set(['author-native-component', 'promote-native-component', 'enumerate-native-requirements', 'review-native-item', 'collect-proof-evidence']);
    if (Object.values(projection.generationsById).some(generation => forbiddenChecks.has(generation.checkId))) return false;
    const componentGenerations = Object.values(projection.generationsById).filter(generation => generation.scope.length > 1);
    for (const componentId of expected) {
      for (const checkId of ['component-reviewed', 'native-validation', 'inspect', 'proof_admit', 'spec_review', 'spec_review_admit', 'verify']) {
        if (componentGenerations.filter(generation => generation.scope[generation.scope.length - 1]?.key === componentId &&
          generation.checkId === checkId && generation.status === 'completed').length !== 1) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** The pre-resume frontier must not have started a component generation. */
export function retainedFrontierHasNoComponentAttempts(checkpoint: unknown): boolean {
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return false;
  const events = (checkpoint as Json).events;
  if (!Array.isArray(events)) return false;
  return !events.some(event => event && typeof event === 'object' && !Array.isArray(event) &&
    (event as Json).type === 'AttemptStarted' && Array.isArray((event as Json).scope) &&
    ((event as Json).scope as unknown[]).length > 1);
}

export type RetainedContinuationFrontier = Readonly<{
  checkpoint: GraphJournalCheckpointV1;
  materializedComponentIds: readonly string[];
  expectedComponentIds: readonly string[];
  componentAttemptsStarted: number;
  zeroComponentAttempts: boolean;
  setsEqual: boolean;
}>;

export type RetainedContinuationEngineRun = Readonly<{
  initialResult: Awaited<ReturnType<StateMachineExecutionEngine['executeGroupedChecks']>>;
  frontier: RetainedContinuationFrontier;
  result: Awaited<ReturnType<StateMachineExecutionEngine['resumeGraphCheckpoint']>>['result'];
  checkpoint: GraphJournalCheckpointV1;
}>;

/**
 * Execute the retained project prefix, publish its durable frontier, then
 * resume that exact checkpoint through the normal engine.  The callback is
 * invoked after export and before either frontier predicate can fail, so the
 * caller can retain diagnostic evidence even for a set mismatch.
 */
export async function executeRetainedContinuationEngine(
  engine: StateMachineExecutionEngine,
  config: VisorConfig,
  timeout: number,
  expectedComponentIds: readonly string[],
  onFrontier?: (frontier: RetainedContinuationFrontier) => void | Promise<void>,
): Promise<RetainedContinuationEngineRun> {
  const initialResult = await engine.executeGroupedChecks(
    PR, ['project'], timeout, config, 'json', false, config.max_parallelism, false,
    undefined, retainedProjectPrefixDispatchGate,
  );
  const checkpoint = engine.exportGraphCheckpoint();
  const materialized = materializedComponentIds(config, checkpoint);
  const expected = Object.freeze(utf8Sorted(expectedComponentIds));
  const zeroComponentAttempts = retainedFrontierHasNoComponentAttempts(checkpoint);
  const componentAttemptsStarted = (checkpoint.events as readonly Json[]).filter(event =>
    event.type === 'AttemptStarted' && Array.isArray(event.scope) && event.scope.length > 1,
  ).length;
  const frontier = Object.freeze({
    checkpoint,
    materializedComponentIds: materialized,
    expectedComponentIds: expected,
    componentAttemptsStarted,
    zeroComponentAttempts,
    setsEqual: materialized.join('\u0000') === expected.join('\u0000'),
  });
  if (onFrontier) await onFrontier(frontier);
  if (!frontier.zeroComponentAttempts) {
    throw new Error('retained project frontier started a component generation before aggregate set validation');
  }
  if (!frontier.setsEqual) {
    throw new Error('retained aggregate map does not exactly match current materialized component WorkItems');
  }
  const resumed = await engine.resumeGraphCheckpoint({
    checkpoint,
    config,
    prInfo: PR,
    maxParallelism: config.max_parallelism,
    failFast: false,
  });
  return Object.freeze({initialResult, frontier, result: resumed.result, checkpoint: resumed.checkpoint});
}

function writeCheckpoint(file: string, checkpoint: unknown): void {
  const canonical = canonicalGraphCheckpointJson(checkpoint);
  writeText(file, canonical + '\n');
  JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function collectNativeComponentOpenChecks(projection: unknown): NativeComponentOpenCheck[] {
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)) return [];
  const claimsById = (projection as Json).claimsById;
  if (!claimsById || typeof claimsById !== 'object' || Array.isArray(claimsById)) return [];
  const checks: NativeComponentOpenCheck[] = [];
  for (const claim of Object.values(claimsById as Record<string, unknown>)) {
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) continue;
    const claimObject = claim as Json;
    if (claimObject.active !== true || claimObject.claim !== 'native.component.summary@1') continue;
    const scope = claimObject.scope;
    const componentScope = Array.isArray(scope) ? scope[scope.length - 1] : undefined;
    const payload = claimObject.payload && typeof claimObject.payload === 'object' && !Array.isArray(claimObject.payload)
      ? claimObject.payload as Json
      : undefined;
    const componentId = payload?.component_id;
    if (typeof componentId !== 'string' || componentId.length === 0 ||
        !componentScope || typeof componentScope !== 'object' || Array.isArray(componentScope) ||
        (componentScope as Json).kind !== 'keyed' || (componentScope as Json).key !== componentId) continue;
    const openChecks = payload.open_native_checks;
    if (!Array.isArray(openChecks)) continue;
    for (const check of openChecks) {
      if (!check || typeof check !== 'object' || Array.isArray(check)) continue;
      const name = (check as Json).name;
      const exitCode = (check as Json).exit_code;
      if (typeof name === 'string' && name.length > 0 && Number.isSafeInteger(exitCode)) {
        checks.push({component_id: componentId, name, exit_code: exitCode as number});
      }
    }
  }
  return checks.sort((left, right) =>
    left.component_id.localeCompare(right.component_id) ||
    left.name.localeCompare(right.name) || left.exit_code - right.exit_code,
  );
}

export function summarizeNativePostflight(postflight: Json, projection?: unknown): NativePostflightSummary {
  const checkNames = ['requirements', 'validation', 'audit', 'checklist', 'status'];
  const open_native_checks = checkNames.flatMap(name => {
    const value = postflight[name];
    const exitCode = value && typeof value === 'object' && !Array.isArray(value) &&
      typeof (value as Json).exit_code === 'number'
      ? (value as Json).exit_code as number
      : -1;
    return exitCode === 0 ? [] : [{name, exit_code: exitCode}];
  });
  const componentOpenChecks = collectNativeComponentOpenChecks(projection);
  return {
    hard_failures: open_native_checks
      .filter(check => check.name === 'validation' || check.name === 'status')
      .map(check => check.name)
      .concat(componentOpenChecks
        .filter(check => check.name === 'validation' || check.name === 'validate' || check.name === 'status')
        .map(check => `${check.component_id}:${check.name}`)),
    open_native_checks: open_native_checks.concat(componentOpenChecks),
  };
}

function historicalFailedAttempts(checkpoint: GraphJournalCheckpointV1): Json[] {
  return (checkpoint.events as readonly Json[])
    .filter(event => event.type === 'AttemptFailed')
    .map(event => ({
      attempt_id: event.attemptId,
      generation_id: event.nodeGenerationId,
      check_id: event.checkId,
      reason: event.reason,
    }));
}

function currentUnresolvedGenerations(config: VisorConfig, checkpoint: GraphJournalCheckpointV1): Json[] {
  const journal = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), checkpoint);
  const projection: any = journal.getInstanceProjection();
  return Object.values(projection.generationsById)
    .filter((generation: any) => generation.status === 'failed')
    .map((generation: any) => ({
      generation_id: generation.nodeGenerationId,
      check_id: generation.checkId,
      reason: generation.reason || null,
      scope: generation.scope,
    }));
}

async function runRecovery(
  values: Record<string, string>,
  roots: {subject: string; original: string; output: string},
  proof: string,
  timeout: number,
  requestTimeout: number,
  recovery: RecoveryArguments,
): Promise<void> {
  const priorOutput = realDirectory(required(values, 'prior-output'), 'prior recovery output');
  if (inside(priorOutput, roots.subject) || inside(priorOutput, roots.original) || inside(priorOutput, roots.output)) {
    throw new Error('prior recovery output must be disjoint from current subject, original, and output roots');
  }
  const checkpointPath = fs.realpathSync(path.resolve(required(values, 'recover-checkpoint')));
  if (!fs.statSync(checkpointPath).isFile()) {
    throw new Error('recover-checkpoint must be a retained checkpoint file');
  }
  const checkpointRoot = realDirectory(path.dirname(checkpointPath), 'retained checkpoint root');
  if (!inside(checkpointPath, priorOutput)) {
    if (path.basename(checkpointPath) !== 'checkpoint.json') {
      throw new Error('recover-checkpoint outside prior-output must be named checkpoint.json');
    }
    if (inside(checkpointRoot, roots.subject) || inside(roots.subject, checkpointRoot) ||
        inside(checkpointRoot, roots.original) || inside(roots.original, checkpointRoot) ||
        inside(checkpointRoot, priorOutput) || inside(priorOutput, checkpointRoot) ||
        inside(checkpointRoot, roots.output) || inside(roots.output, checkpointRoot)) {
      throw new Error('retained checkpoint root must be disjoint from subject, protected original, prior output, and recovery output');
    }
  }
  const checkpointBytes = fs.readFileSync(checkpointPath, 'utf8');
  const checkpoint = JSON.parse(checkpointBytes) as unknown;
  const validatedInput = ExecutionJournal.validateGraphCheckpointIntegrity(checkpoint);
  const generationIds = [...recovery.retryGenerationIds];
  const externalSideEffects = required(values, 'external-side-effects');
  if (externalSideEffects !== 'absent' && externalSideEffects !== 'safely_idempotent' &&
      externalSideEffects !== 'isolated_draft_replay') {
    throw new Error('--external-side-effects must be absent, safely_idempotent, or isolated_draft_replay');
  }
  if (externalSideEffects === 'isolated_draft_replay' && generationIds.length !== 1) {
    throw new Error('isolated_draft_replay requires exactly one failed author generation');
  }

  const revision = assertRecoverySubject(roots.subject);
  const objectFormat = gitObjectFormat(roots.subject);
  const codex = assertPrivateCodexHome(roots.subject, roots.original, roots.output);
  process.chdir(roots.subject);
  if (fs.realpathSync(process.cwd()) !== roots.subject) throw new Error('runner cwd did not resolve to the validated recovery subject root');
  const retainedWorktreeRoot = path.join(priorOutput, 'worktrees');
  if (!fs.existsSync(retainedWorktreeRoot) || !fs.statSync(retainedWorktreeRoot).isDirectory()) {
    throw new Error('prior recovery output is missing its retained worktrees directory');
  }

  process.env.VISOR_WORKSPACE_MAIN_PROJECT = roots.subject;
  process.env.VISOR_ORIGINAL_WORKDIR = roots.original;
  process.env.PROOF_BIN = proof;
  process.env.NATIVE_ONBOARDING_OUTPUT_DIR = roots.output;
  process.env.NATIVE_ONBOARDING_REPO_ROOT = REPO_ROOT;
  process.env.NATIVE_ONBOARDING_TS_NODE = fs.realpathSync(require.resolve('ts-node/register/transpile-only'));
  pinNativeOnboardingTsProject();
  process.env.NATIVE_ONBOARDING_WORKTREE_ROOT = retainedWorktreeRoot;
  process.env.SUBJECT_BASELINE_REVISION = revision;
  process.env.USE_CODEX = 'true';
  process.env.DISABLE_FALLBACK = '1';
  process.env.AUTO_FALLBACK = '0';
  process.env.VISOR_DEBUG_AI_SESSIONS = 'false';
  process.env.VISOR_TRACE_DIR = process.env.VISOR_TRACE_DIR || path.join(roots.output, 'traces');
  const onPromptCaptured = configurePublicPromptCapture(path.join(roots.output, 'ai'));

  const checkpointDigest = createHash('sha256').update(checkpointBytes, 'utf8').digest('hex');
  writeText(path.join(roots.output, 'recovery', 'prior-checkpoint.json'), checkpointBytes);
  JSON.parse(fs.readFileSync(path.join(roots.output, 'recovery', 'prior-checkpoint.json'), 'utf8'));
  writeJson(path.join(roots.output, 'preflight.json'), {
    status: 'recovery-launch-boundary-passed',
    subject_root: roots.subject,
    protected_original_root: roots.original,
    subject_revision: revision,
    proof_binary: proof,
    request_timeout_ms: requestTimeout,
    outer_timeout_ms: timeout,
    prior_output: priorOutput,
    recover_checkpoint: checkpointPath,
    recover_checkpoint_sha256: `sha256:${checkpointDigest}`,
    retry_generation_ids: generationIds,
    external_side_effects: externalSideEffects,
    object_format: objectFormat,
    codex_home_is_private: true,
    codex_home_config_present: codex.configPresent,
    no_native_init_or_discovery: true,
    note: externalSideEffects === 'isolated_draft_replay'
      ? 'Recovery restores one retained Graph-v2 prefix and explicitly retries one selected author leaf from an isolated retained draft; other failures remain visible.'
      : generationIds.some(generationId => {
        const event = (validatedInput.events as readonly Json[]).find(candidate =>
          candidate.type === 'AttemptFailed' && candidate.nodeGenerationId === generationId);
        return event?.checkId === 'component-reviewed';
      })
        ? 'Recovery restores one retained Graph-v2 prefix and explicitly retries selected native fan-in aggregation leaves; failed authors and historical failures remain visible.'
      : generationIds.some(generationId => {
        const event = (validatedInput.events as readonly Json[]).find(candidate =>
          candidate.type === 'AttemptFailed' && candidate.nodeGenerationId === generationId);
        return event?.checkId === 'review-native-item';
      })
        ? 'Recovery restores one retained Graph-v2 prefix and explicitly retries selected native review leaves while reusing retained sibling packets; failed authors and historical failures remain visible.'
      : 'Recovery restores one retained Graph-v2 prefix and explicitly retries only selected promotion leaves; failed authors and historical failures remain visible.',
  });

  const registry = CheckProviderRegistry.getInstance();
  registry.bootstrapProofAdmission(createProofAdmissionCapability(proof));
  // Refresh the current subject inventory as a separate freshness check, but
  // never bind the recovery graph to post-promotion role/schema bytes. Those
  // bytes are immutable authority retained by the earlier run.
  const currentInventory = await loadCurrentOnboardingInventory(proof, roots.subject, roots.output, timeout);
  const reviewRequirementIds = selectedReviewRequirementIds(validatedInput, generationIds);
  const currentProofRequirements = await loadCurrentProofRequirementHashes(
    proof, roots.subject, roots.output, timeout, reviewRequirementIds,
  );
  const retained = await loadRetainedOnboardingConfig(priorOutput, roots.output);
  const currentAuthority = assertAuthenticatedInventory(currentInventory, 'current Proof onboarding inventory');
  const retainedAuthority = assertAuthenticatedInventory(
    retained.authority.inventory,
    'retained Proof onboarding inventory',
  );
  if (currentAuthority.project_id !== retainedAuthority.project_id) {
    throw new Error('current Proof project identity does not match retained recovery authority');
  }
  writeJson(path.join(roots.output, 'recovery', 'current-authority.json'), {
    project_id: currentAuthority.project_id,
    subject_fingerprint: currentAuthority.subject_fingerprint,
    source: 'current-read-only-proof-inventory',
  });
  const config = retained.config;
  const configPlan = compileClaimPlan(config);
  if (configPlan.expansionPlan.graphSemanticDigest !== validatedInput.graphSemanticDigest) {
    throw new Error('recovery configuration graph digest does not match the checkpoint authority');
  }
  const authority = validateRecoverySelection(
    config,
    validatedInput,
    generationIds,
    {subject: roots.subject, priorOutput, checkpointRoot},
    currentInventory,
    externalSideEffects,
    currentProofRequirements,
  );
  const draftInventories = authority.bindings
    .filter(binding => binding.draftInventory)
    .map(binding => binding.draftInventory);
  if (externalSideEffects === 'isolated_draft_replay' && draftInventories.length !== 1) {
    throw new Error('isolated_draft_replay requires one retained author draft inventory');
  }
  if (authority.reviewPackets.length > 0) {
    stageRecoveryReviewPackets(roots.output, authority.reviewPackets);
  }
  writeJson(path.join(roots.output, 'recovery', 'draft-inventory.json'), draftInventories);
  writeJson(path.join(roots.output, 'recovery', 'selection.json'), {
    session_id: checkpoint && typeof checkpoint === 'object' ? (checkpoint as Json).sessionId : undefined,
    source_revision: revision,
    failed_generations: authority.bindings,
    prior_checkpoint_sha256: `sha256:${checkpointDigest}`,
  });

  const engine = new StateMachineExecutionEngine(roots.subject);
  engine.setExecutionContext({hooks: {onPromptCaptured}});
  let resumed: Awaited<ReturnType<StateMachineExecutionEngine['retryGraphCheckpoint']>>;
  try {
    resumed = await engine.retryGraphCheckpoint({
      checkpoint: validatedInput,
      config,
      prInfo: PR,
      retryGenerationIds: generationIds,
      externalSideEffects,
      onRetryCheckpoint: retryCheckpoint => {
        for (const binding of authority.bindings) {
          if (binding.draftInventory) {
            assertDraftInventoryUnchanged(binding.draftInventory, binding.ownedSourcePaths || []);
          }
        }
        writeCheckpoint(path.join(roots.output, 'recovery', 'retry-prefix-checkpoint.json'), retryCheckpoint);
      },
      maxParallelism: config.max_parallelism,
      failFast: false,
    });
  } catch (error) {
    // The engine callback persists the retry prefix before dispatch. Keep the
    // source checkpoint and selection receipt available if later resume fails.
    throw error;
  }
  writeCheckpoint(path.join(roots.output, 'checkpoint.json'), resumed.checkpoint);
  writeJson(path.join(roots.output, 'visor-result.json'), resumed.result);
  const unresolved = currentUnresolvedGenerations(config, resumed.checkpoint);
  const finalProjection: any = ExecutionJournal.restoreGraphCheckpoint(
    compileClaimPlan(config), resumed.checkpoint,
  ).getInstanceProjection();
  const recoveredRetryGenerations = generationIds.map(generationId => ({
    generation_id: generationId,
    status: finalProjection.generationsById[generationId]?.status || 'missing',
  }));
  const selectedStillFailed = recoveredRetryGenerations
    .filter(generation => generation.status === 'failed')
    .map(generation => generation.generation_id);

  const postflight: Json = {};
  for (const [name, args] of Object.entries({
    requirements: ['req', 'list', '--format', 'json'],
    validation: ['validate', '--variable-drift', '--format', 'json'],
    audit: ['audit', '--no-cache', '--check', 'validate_passes', '--check', 'annotation_validity', '--check', 'levels_connected', '--format', 'json'],
    checklist: ['checklist', 'show', '--checklist', 'onboard_v1', '--format', 'json'],
    status: ['status', '--format', 'json'],
  })) {
    const run = runProof(proof, roots.subject, roots.output, 'postflight', args, timeout);
    postflight[name] = {exit_code: run.status, stdout_file: 'commands/postflight/' + commandName(args) + '.stdout', stderr_file: 'commands/postflight/' + commandName(args) + '.stderr'};
  }
  writeJson(path.join(roots.output, 'postflight.json'), postflight);
  const postflightSummary = summarizeNativePostflight(postflight, finalProjection);
  const summary = {
    status: postflightSummary.hard_failures.length > 0
      ? 'recovery-retry-failed-postflight'
      : selectedStillFailed.length > 0
        ? 'recovery-retry-failed'
        : unresolved.length > 0
          ? 'recovery-retry-complete-with-unresolved-generations'
          : 'recovery-retry-complete-open-admission-boundary',
    mode: 'explicit-failed-generation-retry',
    prior_checkpoint: {
      path: checkpointPath,
      sha256: `sha256:${checkpointDigest}`,
      event_count: ((checkpoint as Json).events as unknown[]).length,
      immutable_prefix_preserved: true,
    },
    retry: {
      generation_ids: generationIds,
      side_effect_confirmation: externalSideEffects,
      prefix_checkpoint: 'recovery/retry-prefix-checkpoint.json',
      resumed_checkpoint: 'checkpoint.json',
    },
    historical_failed_attempts: historicalFailedAttempts(validatedInput),
    final_checkpoint: summarizeCheckpoint(resumed.checkpoint),
    current_unresolved_failed_generations: unresolved,
    recovered_retry_generations: recoveredRetryGenerations,
    open_native_checks: postflightSummary.open_native_checks,
    admitted: 'No component admission or full onboarding success is claimed by retry mode.',
    output: roots.output,
  };
  writeJson(path.join(roots.output, 'summary.json'), summary);
  if (postflightSummary.hard_failures.length > 0 || selectedStillFailed.length > 0 || unresolved.length > 0) {
    console.error(JSON.stringify({status: summary.status, output: roots.output}, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({status: summary.status, output: roots.output}, null, 2));
}

type FreshRunnerRoots = Readonly<{subject: string; original: string; output: string}>;

/**
 * Run a retained review export through a fresh current Proof graph.  The
 * subject is already initialized/promoted: this mode intentionally skips
 * Proof init and all authoring/review expansion, then gates component dispatch
 * until the current catalog has materialized exact WorkItems.
 */
async function runRetainedContinuation(
  roots: FreshRunnerRoots,
  proof: string,
  timeout: number,
  requestTimeout: number,
  objectFormat: 'sha1' | 'sha256',
  onPromptCaptured: (info: PublicPromptCaptureInfo) => void,
  exportRoot: string,
  preflightOnly: boolean,
): Promise<void> {
  const revision = assertRecoverySubject(roots.subject);
  const resolvedExportRoot = realDirectory(exportRoot, 'retained review export root');
  if (inside(resolvedExportRoot, roots.subject) || inside(roots.subject, resolvedExportRoot) ||
      inside(resolvedExportRoot, roots.original) || inside(roots.original, resolvedExportRoot)) {
    throw new Error('retained review export root must be disjoint from subject and protected original roots');
  }
  writeJson(path.join(roots.output, 'preflight.json'), {
    status: 'retained-continuation-launch-boundary-passed',
    mode: 'retained-review-continuation',
    subject_root: roots.subject,
    protected_original_root: roots.original,
    subject_revision: revision,
    proof_binary: proof,
    request_timeout_ms: requestTimeout,
    outer_timeout_ms: timeout,
    object_format: objectFormat,
    retained_export_root: resolvedExportRoot,
    no_native_init: true,
    no_authoring_or_per_requirement_review_dispatch: true,
    note: 'Current Proof inventory, role authority, and requirement hashes are revalidated before graph dispatch.',
  });
  const registry = CheckProviderRegistry.getInstance();
  registry.bootstrapProofAdmission(createProofAdmissionCapability(proof));
  const preparation = await loadRetainedContinuationConfig(resolvedExportRoot, proof, roots.subject, roots.output, timeout);
  const config = preparation.config;
  const configPlan = compileClaimPlan(config);
  writeJson(path.join(roots.output, 'preflight', 'retained-config-authority.json'), {
    graph_semantic_digest: preparation.graphSemanticDigest,
    materialized_config_path: path.relative(roots.output, preparation.materializedConfigPath),
    materialized_config_sha256: preparation.materializedConfigSha256,
    current_requirement_count: preparation.currentRequirements.length,
    component_ids: utf8Sorted(Object.keys(preparation.aggregateMap)),
    aggregate_map_base64_bytes: Buffer.byteLength(preparation.aggregateMapBase64, 'utf8'),
  });
  if (preflightOnly) {
    writeJson(path.join(roots.output, 'preflight', 'summary.json'), {
      status: 'retained-continuation-preflight-only-complete',
      mode: 'retained-review-continuation',
      packet_count: preparation.retained.packetCount,
      current_requirement_count: preparation.currentRequirements.length,
      no_engine_dispatch: true,
    });
    console.log(JSON.stringify({status: 'retained-continuation-preflight-only-complete', output: roots.output}, null, 2));
    return;
  }

  const engine = new StateMachineExecutionEngine(roots.subject);
  engine.setExecutionContext({hooks: {onPromptCaptured}});
  let checkpoint: GraphJournalCheckpointV1;
  let initialResult: unknown;
  let finalResult: unknown;
  const expectedFrontierComponents = utf8Sorted(Object.keys(preparation.aggregateMap));
  try {
    // The generated gate allows the project lane to reach materialize_catalog
    // while leaving every component-scope generation at a ready frontier.
    const engineRun = await executeRetainedContinuationEngine(
      engine, config, timeout, expectedFrontierComponents, frontier => {
        checkpoint = frontier.checkpoint;
        writeCheckpoint(path.join(roots.output, 'retained-frontier-checkpoint.json'), frontier.checkpoint);
        writeJson(path.join(roots.output, 'preflight', 'component-frontier.json'), {
          status: frontier.zeroComponentAttempts && frontier.setsEqual
            ? 'exact-current-component-frontier'
            : 'component-frontier-mismatch',
          checkpoint_sha256: frontier.checkpoint.integrity && typeof frontier.checkpoint.integrity.digest === 'string'
            ? `sha256:${frontier.checkpoint.integrity.digest}`
            : null,
          graph_semantic_digest: frontier.checkpoint.graphSemanticDigest,
          materialized_config_path: path.relative(roots.output, preparation.materializedConfigPath),
          materialized_config_sha256: preparation.materializedConfigSha256,
          materialized_component_ids: frontier.materializedComponentIds,
          retained_aggregate_component_ids: frontier.expectedComponentIds,
          component_attempts_released: false,
          component_attempts_started: frontier.componentAttemptsStarted,
          zero_component_attempts: frontier.zeroComponentAttempts,
          sets_equal: frontier.setsEqual,
        });
      },
    );
    initialResult = engineRun.initialResult;
    checkpoint = engineRun.checkpoint;
    finalResult = engineRun.result;
    writeJson(path.join(roots.output, 'checkpoint.json'), checkpoint);
    writeJson(path.join(roots.output, 'visor-result.json'), finalResult);
  } catch (error) {
    try {
      checkpoint = engine.exportGraphCheckpoint();
      writeJson(path.join(roots.output, 'checkpoint.partial.json'), checkpoint);
    } catch {
      // Preserve the original engine error when no checkpoint exists.
    }
    throw error;
  }

  const postflight: Json = {};
  for (const [name, args] of Object.entries({
    requirements: ['req', 'list', '--format', 'json'],
    validation: ['validate', '--variable-drift', '--format', 'json'],
    audit: ['audit', '--no-cache', '--check', 'validate_passes', '--check', 'annotation_validity', '--check', 'levels_connected', '--format', 'json'],
    checklist: ['checklist', 'show', '--checklist', 'onboard_v1', '--format', 'json'],
    status: ['status', '--format', 'json'],
  })) {
    const run = runProof(proof, roots.subject, roots.output, 'postflight', args, timeout);
    postflight[name] = {
      exit_code: run.status,
      stdout_file: 'commands/postflight/' + commandName(args) + '.stdout',
      stderr_file: 'commands/postflight/' + commandName(args) + '.stderr',
    };
  }
  writeJson(path.join(roots.output, 'postflight.json'), postflight);
  const postflightSummary = summarizeNativePostflight(postflight, engine.getInstanceProjection());
  const finalMaterialized = materializedComponentIds(config, checkpoint);
  const expectedComponents = utf8Sorted(Object.keys(preparation.aggregateMap));
  const journalComplete = retainedContinuationCheckpointIsComplete(config, checkpoint, expectedComponents);
  const finalProjection = ExecutionJournal.restoreGraphCheckpoint(configPlan, checkpoint).getInstanceProjection();
  const finalActiveClaims = Object.values(finalProjection.claimsById).filter(claim => claim.active);
  const componentScope = (claim: {scope: readonly {kind: string; key?: string}[]}) => {
    const last = claim.scope[claim.scope.length - 1];
    return last && last.kind === 'keyed' && typeof last.key === 'string' ? last.key : undefined;
  };
  const admittedComponentIds = new Set(finalActiveClaims
    .filter(claim => claim.claim === 'proof.admitted_receipt@1' && claim.producerCheckId === 'proof_admit' &&
      claim.scope.length > 1 && componentScope(claim) !== undefined && expectedComponents.includes(componentScope(claim) as string) &&
      claim.payload && typeof claim.payload === 'object' && !Array.isArray(claim.payload) &&
      (claim.payload as Json).Status === 'ADMITTED')
    .map(claim => componentScope(claim)));
  const projectReconciliationReceipts = finalActiveClaims.filter(claim =>
    claim.claim === 'proof.project_reconciliation_receipt@1' && claim.producerCheckId === 'project_reconcile',
  ).length;
  const forbiddenDispatchChecks = new Set(['author-native-component', 'promote-native-component', 'enumerate-native-requirements', 'review-native-item', 'collect-proof-evidence']);
  const forbiddenDispatches = (checkpoint.events as readonly Json[]).filter(event =>
    event.type === 'AttemptStarted' && typeof event.checkId === 'string' && forbiddenDispatchChecks.has(event.checkId),
  ).length;
  const newlyExecutedPerItemReviews = (checkpoint.events as readonly Json[]).filter(event =>
    event.type === 'AttemptStarted' && event.checkId === 'review-native-item',
  ).length;
  const summary = {
    status: postflightSummary.hard_failures.length > 0 || !journalComplete
      ? 'retained-continuation-failed-postflight'
      : 'retained-continuation-complete',
    mode: 'retained-review-continuation',
    retained_export_root: resolvedExportRoot,
    retained_packet_count: preparation.retained.packetCount,
    current_requirement_count: preparation.currentRequirements.length,
    materialized_component_ids: finalMaterialized,
    retained_aggregate_component_ids: expectedComponents,
    checkpoint: summarizeCheckpoint(checkpoint, !journalComplete),
    postflight,
    open_native_checks: postflightSummary.open_native_checks,
    journal_complete: journalComplete,
    reused_review_packets: preparation.retained.packetCount,
    newly_executed_per_item_reviews: newlyExecutedPerItemReviews,
    components_admitted: admittedComponentIds.size,
    project_reconciliation_receipts: projectReconciliationReceipts,
    forbidden_dispatches: forbiddenDispatches,
    no_historical_author_or_per_requirement_review_dispatch: forbiddenDispatches === 0,
    result_recorded: finalResult !== undefined,
    initial_result_recorded: initialResult !== undefined,
    output: roots.output,
  };
  writeJson(path.join(roots.output, 'summary.json'), summary);
  if (postflightSummary.hard_failures.length > 0 || !journalComplete) {
    console.error(JSON.stringify({status: summary.status, output: roots.output}, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({status: summary.status, output: roots.output}, null, 2));
}

async function main(): Promise<void> {
  const values = parseArgs(process.argv.slice(2));
  const recovery = parseRecoveryArguments(values);
  const retainedExport = values['retained-review-export'];
  if (recovery && retainedExport !== undefined) {
    throw new Error('--retained-review-export cannot be combined with checkpoint recovery arguments');
  }
  const roots = recovery
    ? assertRecoveryRoots(
      required(values, 'subject-root'),
      required(values, 'original-root'),
      required(values, 'output'),
      recovery.priorOutput,
      recovery.checkpoint,
    )
    : assertRoots(required(values, 'subject-root'), required(values, 'original-root'), required(values, 'output'));
  diagnosticOutput = roots.output;
  const proof = executable(required(values, 'proof-bin'));
  const timeout = values.timeout ? Number(values.timeout) : DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1000) throw new Error('--timeout must be a positive millisecond integer');
  const requestTimeout = Number(process.env.REQUEST_TIMEOUT || '');
  if (!Number.isSafeInteger(requestTimeout) || requestTimeout < 1000 || requestTimeout >= timeout) {
    throw new Error('REQUEST_TIMEOUT must be an explicit positive inner budget smaller than --timeout');
  }
  if (recovery) {
    await runRecovery(values, roots, proof, timeout, requestTimeout, recovery);
    return;
  }
  const revision = retainedExport !== undefined
    ? assertRecoverySubject(roots.subject)
    : assertFreshSubject(roots.subject, process.env.SUBJECT_BASELINE_REVISION);
  const objectFormat = gitObjectFormat(roots.subject);
  const codex = assertPrivateCodexHome(roots.subject, roots.original, roots.output);
  process.chdir(roots.subject);
  if (fs.realpathSync(process.cwd()) !== roots.subject) throw new Error('runner cwd did not resolve to the validated subject root');

  process.env.VISOR_WORKSPACE_MAIN_PROJECT = roots.subject;
  process.env.VISOR_ORIGINAL_WORKDIR = roots.original;
  process.env.PROOF_BIN = proof;
  process.env.NATIVE_ONBOARDING_OUTPUT_DIR = roots.output;
  process.env.NATIVE_ONBOARDING_REPO_ROOT = REPO_ROOT;
  process.env.NATIVE_ONBOARDING_TS_NODE = fs.realpathSync(require.resolve('ts-node/register/transpile-only'));
  pinNativeOnboardingTsProject();
  process.env.NATIVE_ONBOARDING_WORKTREE_ROOT = path.join(roots.output, 'worktrees');
  fs.mkdirSync(process.env.NATIVE_ONBOARDING_WORKTREE_ROOT, {recursive: true});
  process.env.SUBJECT_BASELINE_REVISION = revision;
  process.env.USE_CODEX = 'true';
  process.env.DISABLE_FALLBACK = '1';
  process.env.AUTO_FALLBACK = '0';
  process.env.VISOR_DEBUG_AI_SESSIONS = 'false';
  process.env.VISOR_TRACE_DIR = process.env.VISOR_TRACE_DIR || path.join(roots.output, 'traces');
  const publicAiDirectory = path.join(roots.output, 'ai');
  const onPromptCaptured = configurePublicPromptCapture(publicAiDirectory);

  if (retainedExport !== undefined) {
    await runRetainedContinuation(
      roots, proof, timeout, requestTimeout, objectFormat, onPromptCaptured,
      retainedExport, values['preflight-only'] === 'true',
    );
    return;
  }

  writeJson(path.join(roots.output, 'preflight.json'), {
    status: 'launch-boundary-passed',
    subject_root: roots.subject,
    protected_original_root: roots.original,
    subject_revision: revision,
    source_revision: revision,
    proof_binary: proof,
    request_timeout_ms: requestTimeout,
    outer_timeout_ms: timeout,
    baseline_commit: null,
    object_format: objectFormat,
    codex_home_is_private: true,
    codex_home_config_present: codex.configPresent,
    codex_mcp_plugins_hooks_rejected: true,
    subject_codex_override_rejected: true,
    note: 'No authentication, raw Codex config, or inherited tool capability is recorded.',
  });

  const init = runProof(proof, roots.subject, roots.output, 'preflight', ['init', '--name', 'jsonparser', '--template', 'go-package', '--scope', '.', '--strict'], timeout);
  if (init.status !== 0) throw new Error('Proof init failed with exit ' + init.status);
  const baselineCommit = commitInitializedProofBaseline(roots.subject, revision);
  process.env.NATIVE_ONBOARDING_BASELINE_COMMIT = baselineCommit;
  const baseline = runProof(proof, roots.subject, roots.output, 'preflight', ['req', 'list', '--format', 'json'], timeout);
  const baselineValue = parseJson(baseline, 'Proof baseline req list');
  writeJson(path.join(roots.output, 'preflight', 'requirements-baseline.json'), baselineValue);
  const proofStatus = runProof(proof, roots.subject, roots.output, 'preflight', ['status', '--format', 'json'], timeout);
  const proofStatusValue = parseJson(proofStatus, 'Proof native status baseline');
  if (!proofStatusValue || typeof proofStatusValue !== 'object' || Array.isArray(proofStatusValue)) {
    throw new Error('Proof native status baseline is not an object');
  }
  writeJson(path.join(roots.output, 'preflight', 'native-status-baseline.json'), proofStatusValue);
  writeJson(path.join(roots.output, 'preflight', 'baseline-checkpoint.json'), {
    status: 'initialized-native-proof-baseline',
    initialized: true,
    canonical_root: roots.subject,
    source_commit: revision,
    baseline_commit: baselineCommit,
    object_format: objectFormat,
    requirements_baseline: path.join(roots.output, 'preflight', 'requirements-baseline.json'),
    native_status_baseline: path.join(roots.output, 'preflight', 'native-status-baseline.json'),
    checkouts_allowed_after: 'baseline-checkpoint.json',
  });
  writeJson(path.join(roots.output, 'preflight.json'), {
    status: 'baseline-committed',
    subject_root: roots.subject,
    protected_original_root: roots.original,
    subject_revision: revision,
    source_revision: revision,
    baseline_commit: baselineCommit,
    proof_binary: proof,
    request_timeout_ms: requestTimeout,
    outer_timeout_ms: timeout,
    object_format: objectFormat,
    codex_home_is_private: true,
    codex_home_config_present: codex.configPresent,
    codex_mcp_plugins_hooks_rejected: true,
    subject_codex_override_rejected: true,
    note: 'No authentication, raw Codex config, or inherited tool capability is recorded.',
  });
  writeText(path.join(roots.output, 'preflight-complete'), 'proof-init-and-baseline-complete\\n');

  const registry = CheckProviderRegistry.getInstance();
  registry.bootstrapProofAdmission(createProofAdmissionCapability(proof));
  const config = await loadOnboardingConfig(proof, roots.subject, roots.output, timeout);
  if (values['preflight-only'] === 'true') {
    writeJson(path.join(roots.output, 'preflight', 'summary.json'), {
      status: 'preflight-only-complete',
      subject_revision: revision,
      requirements_baseline: 'recorded',
      native_inventory: 'resolved',
      project_role_invocation: 'resolved',
      strict_config: 'validated-with-actual-registered-providers',
      no_engine_dispatch: true,
    });
    console.log(JSON.stringify({status: 'preflight-only-complete', output: roots.output}, null, 2));
    return;
  }
  const engine = new StateMachineExecutionEngine(roots.subject);
  engine.setExecutionContext({
    hooks: {onPromptCaptured},
  });
  let result: unknown;
  let checkpoint: unknown;
  try {
    result = await engine.executeGroupedChecks(PR, ['project'], timeout, config, 'json', false, config.max_parallelism, false);
    checkpoint = engine.exportGraphCheckpoint();
    writeJson(path.join(roots.output, 'checkpoint.json'), checkpoint);
    writeJson(path.join(roots.output, 'visor-result.json'), result);
  } catch (error) {
    try {
      checkpoint = engine.exportGraphCheckpoint();
      writeJson(path.join(roots.output, 'checkpoint.partial.json'), checkpoint);
    } catch {
      // Preserve the original engine error when no checkpoint exists.
    }
    throw error;
  }

  const postflight: Json = {};
  const postflightValues: Record<string, unknown> = {};
  for (const [name, args] of Object.entries({
    requirements: ['req', 'list', '--format', 'json'],
    validation: ['validate', '--variable-drift', '--format', 'json'],
    audit: ['audit', '--no-cache', '--check', 'validate_passes', '--check', 'annotation_validity', '--check', 'levels_connected', '--format', 'json'],
    checklist: ['checklist', 'show', '--checklist', 'onboard_v1', '--format', 'json'],
    status: ['status', '--format', 'json'],
  })) {
    const run = runProof(proof, roots.subject, roots.output, 'postflight', args, timeout);
    postflight[name] = {exit_code: run.status, stdout_file: 'commands/postflight/' + commandName(args) + '.stdout', stderr_file: 'commands/postflight/' + commandName(args) + '.stderr'};
    try { postflightValues[name] = JSON.parse(run.stdout); } catch { postflightValues[name] = undefined; }
  }
  writeJson(path.join(roots.output, 'postflight.json'), postflight);
  const postflightSummary = summarizeNativePostflight(postflight, engine.getInstanceProjection());
  const checkpointSummary = summarizeCheckpoint(checkpoint);
  checkpointSummary.mode = 'export-only-no-resume-wired';
  let expectedComponents = 0;
  let authoritativeComponentError: string | null = null;
  try {
    expectedComponents = countAuthoritativeMaterializedComponents(config, checkpoint);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    authoritativeComponentError = message.length > 1024 ? `${message.slice(0, 1024)}...[truncated]` : message;
  }
  const completedByCheck = checkpointSummary.completed_by_check &&
      typeof checkpointSummary.completed_by_check === 'object' &&
      !Array.isArray(checkpointSummary.completed_by_check)
    ? checkpointSummary.completed_by_check as Record<string, number>
    : {};
  const nativeRequirements = postflightValues.requirements;
  const nativeRequirementCount = Array.isArray(nativeRequirements) ? nativeRequirements.length : 0;
  const authored = completedByCheck['author-native-component'] || 0;
  const reviewedItems = completedByCheck['collect-proof-evidence'] || 0;
  const reviewedComponents = completedByCheck['component-reviewed'] || 0;
  const validated = completedByCheck['native-validation'] || 0;
  const discoveryAdmission = completedByCheck.proof_admit || 0;
  const reconciliation = completedByCheck.project_reconcile || 0;
  const failedByCheck = checkpointSummary.failed_by_check &&
      typeof checkpointSummary.failed_by_check === 'object' &&
      !Array.isArray(checkpointSummary.failed_by_check)
    ? checkpointSummary.failed_by_check as Record<string, number>
    : {};
  const unexpectedFailures = Object.keys(failedByCheck).filter(check => check !== 'project_reconcile');
  const statistics = result && typeof result === 'object' ? (result as Json).statistics as Json | undefined : undefined;
  const failedExecutions = statistics && typeof statistics.failedExecutions === 'number' ? statistics.failedExecutions : 0;
  const expectedBoundaryFailureOnly = failedExecutions > 0 &&
    Object.keys(failedByCheck).length > 0 &&
    Object.keys(failedByCheck).every(check => check === 'project_reconcile');
  const countConsistency = authoritativeComponentError === null && nativeOnboardingCountsAreConsistent({
    expected_components: expectedComponents,
    native_requirements: nativeRequirementCount,
    authored_components: authored,
    reviewed_items: reviewedItems,
    reviewed_components: reviewedComponents,
    validated_components: validated,
  });
  const failed = unexpectedFailures.length > 0 || !countConsistency ||
    postflightSummary.hard_failures.length > 0 ||
    (failedExecutions > 0 && !expectedBoundaryFailureOnly);
  const status = failed ? 'failed-native-onboarding-run' : 'partial-open-component-admission-boundary';
  const summary = {
    status,
    candidate: discoveryAdmission > 0 ? 'proof-governed-discovery-candidate-and-discovery-admission-receipt-recorded' : 'discovery-candidate-or-admission-not-recorded',
    reviewed: reviewedItems > 0 ? 'persisted-independent-native-requirement-review-packets' : 'no-persisted-independent-review-packets',
    validated: validated > 0 && nativeRequirementCount > 0 ? 'native-validation-summary-and-postflight-proof-evidence' : 'native-validation-not-complete',
    admitted: 'component authoring and independent review are not native approval; no component admission is claimed',
    project_summary: reconciliation > 0 ? 'project reconciliation receipt recorded; inspect component boundary before treating as admitted' : 'project reconciliation did not record a component admission receipt; open step is native component admission/reconciliation',
    open_step: 'component admission/reconciliation remains open; per-requirement review packets and native validation are recorded separately',
    open_native_checks: postflightSummary.open_native_checks,
    counts: {expected_components: expectedComponents, authored_components: authored, reviewed_items: reviewedItems, reviewed_components: reviewedComponents, validated_components: validated, native_requirements: nativeRequirementCount, project_reconciliation: reconciliation, failed_executions: failedExecutions},
    count_consistency: {authoritative: authoritativeComponentError === null, consistent: countConsistency, error: authoritativeComponentError},
    failure_reason: failed ? 'failed attempt outside the explicit project-reconciliation boundary, incomplete natural component/item review counts, unavailable authoritative component catalog, empty native requirement catalog, or nonzero native validation/status' : null,
    checkpoint: checkpointSummary,
    output: roots.output,
  };
  writeJson(path.join(roots.output, 'summary.json'), summary);
  if (failed) {
    console.error(JSON.stringify({status, output: roots.output}, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({status, output: roots.output}, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    const message = error instanceof Error ? (error.stack || error.message) : String(error);
    if (!diagnosticOutput) {
      try { diagnosticOutput = process.env.NATIVE_ONBOARDING_OUTPUT_DIR; } catch { diagnosticOutput = undefined; }
    }
    if (diagnosticOutput) {
      try { writeText(path.join(diagnosticOutput, 'failure.stderr'), message + '\n'); } catch { /* preserve stderr */ }
    }
    console.error(message);
    process.exitCode = 1;
  });
}
