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
import type { InstanceClaimProjection, NodeGenerationProjection } from '../../../src/state-machine/graph/instance-kernel';
import { CheckProviderRegistry } from '../../../src/providers/check-provider-registry';
import { createProofAdmissionCapability, goCompatibleProofJson, proofCanonicalJson } from '../../../src/providers/proof-admission-cli-child';
import type { CandidateClaimInput } from '../../../src/providers/check-provider.interface';
import {
  validateProofCandidateAdmissionBinding,
  validateProofCurrentCatalogAuthorityBytes,
  validateProofCatalogRevalidationProjection,
  validateProofWorkItemsProjection,
  validateStructuralInventory,
} from '../../../src/providers/proof-catalog-check-providers';
import { governedCanonicalJson } from '../../../src/providers/proof-wire';
import type { PRInfo } from '../../../src/pr-analyzer';
import type { VisorConfig } from '../../../src/types/config';
import {
  emitNativeCampaignReport,
  type NativeCampaignReportInput,
} from './native-campaign-report';
import {
  buildNativeChecklistProgressFromProjections,
  renderNativeChecklistProgress,
  type NativeChecklistProgress,
} from './native-checklist-progress';
import {
  activeChecklistNameFromProofShow,
  classifyNonAuthoritativeChecklistRefresh,
  type NativeChecklistRefreshFile,
} from './native-promotion';

type Json = Record<string, unknown>;
type CommandResult = { status: number; stdout: string; stderr: string };

function isRecord(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Json, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export type PublicPromptCaptureInfo = Readonly<{
  step: string;
  provider: string;
  prompt: string;
}>;

export type ChecklistProgressRefreshOptions = Readonly<{
  paused?: boolean;
  resumed?: boolean;
  retainedCatalogComponentIds?: readonly string[];
  affectedComponentIds?: readonly string[];
}>;

export type RecoveryTerminalStage =
  | 'retry'
  | 'selected-retry'
  | 'postflight'
  | 'incomplete'
  | 'terminal';

export type RecoveryTerminalDescriptor = Readonly<{
  failure_code: 'RETRY_FAILED' | 'POSTFLIGHT_FAILED' | 'RECOVERY_INCOMPLETE' | 'RECOVERY_FAILED';
  evidence: 'failure.stderr' | 'summary.json' | 'postflight.json';
  result?: 'visor-result.json';
}>;

const RECOVERY_TERMINAL_DESCRIPTORS: Readonly<Record<RecoveryTerminalStage, RecoveryTerminalDescriptor>> = {
  retry: Object.freeze({failure_code: 'RETRY_FAILED', evidence: 'failure.stderr'}),
  'selected-retry': Object.freeze({failure_code: 'RETRY_FAILED', evidence: 'summary.json', result: 'visor-result.json'}),
  postflight: Object.freeze({failure_code: 'POSTFLIGHT_FAILED', evidence: 'postflight.json'}),
  incomplete: Object.freeze({failure_code: 'RECOVERY_INCOMPLETE', evidence: 'summary.json'}),
  terminal: Object.freeze({failure_code: 'RECOVERY_FAILED', evidence: 'failure.stderr'}),
};

/** Describe the closed recovery outcome without inspecting or retaining provider data. */
export function describeRecoveryTerminal(stage: RecoveryTerminalStage): RecoveryTerminalDescriptor {
  return RECOVERY_TERMINAL_DESCRIPTORS[stage];
}

/** Derive one immutable progress observation from the selected run boundary. */
export function checklistProgressRefreshOptions(
  checkpointPath: string | undefined,
): ChecklistProgressRefreshOptions {
  return Object.freeze(checkpointPath === undefined ? {} : {resumed: true});
}

/**
 * Persist the read-only checklist/graph projection alongside a runner run.
 * Proof's full effective snapshot is supplied by the postflight command; no
 * checklist state is re-read from files or synthesized from summary counts.
 */
export function writeNativeChecklistProgress(
  output: string,
  claimProjection: unknown,
  instanceProjection: unknown,
  checkpoint: unknown,
  options: ChecklistProgressRefreshOptions = {},
): NativeChecklistProgress {
  const progress = buildNativeChecklistProgressFromProjections({
    claimProjection,
    instanceProjection,
    checkpoint,
    paused: options.paused,
    resumed: options.resumed,
    retainedCatalogComponentIds: options.retainedCatalogComponentIds,
    affectedComponentIds: options.affectedComponentIds,
  });
  const rendered = renderNativeChecklistProgress(progress);
  writeText(path.join(output, 'progress.json'), rendered.json);
  writeText(path.join(output, 'progress.txt'), rendered.text);
  writeText(path.join(output, 'progress.html'), rendered.html + '\n');
  return progress;
}

function writeRestoredChecklistProgress(
  output: string,
  config: VisorConfig,
  checkpoint: GraphJournalCheckpointV1,
  options: ChecklistProgressRefreshOptions = {},
  liveInstanceProjection?: unknown,
): NativeChecklistProgress {
  const journal = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), checkpoint);
  return writeNativeChecklistProgress(
    output,
    journal.getClaimProjection(),
    liveInstanceProjection ?? journal.getInstanceProjection(),
    checkpoint,
    options,
  );
}

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
const CHECKLIST_CONFIG_PATH = path.resolve(__dirname, 'visor-checklist-onboarding.yaml');
const CHECKLIST_CONTINUATION_CONFIG_PATH = path.resolve(__dirname, 'visor-checklist-continuation.yaml');
const REPO_ROOT = path.resolve(__dirname, '../../../');
// A natural component catalog can contain many independent review items after
// each editable author/promotion. Keep the outer campaign budget bounded, but
// large enough for that real work; per-check and request budgets remain the
// enforcement points for individual calls.
const DEFAULT_TIMEOUT_MS = 7_200_000;
let diagnosticOutput: string | undefined;
let recoveryTerminalPersistence: ((error: unknown) => void) | undefined;

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
    if (key === '--checklist-onboarding') {
      result['checklist-onboarding'] = 'true';
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

export type ChecklistPrefixRetryArguments = Readonly<{
  checkpoint: string;
  priorOutput: string;
  retryGenerationId: string;
}>;

export type ChecklistContinueArguments = Readonly<{
  checkpoint: string;
  step: 'traces-light';
}>;

/** Parse the one shared continuation entry.  Unsupported checklist steps fail closed. */
export function parseChecklistContinueArguments(
  values: Record<string, string>,
): ChecklistContinueArguments | undefined {
  const checkpoint = values['checklist-continue'];
  const step = values['checklist-step'];
  if (checkpoint === undefined && step === undefined) return undefined;
  if (!checkpoint) throw new Error('--checklist-continue is required for checklist continuation');
  if (step !== undefined && step !== 'traces-light') {
    throw new Error(`unsupported checklist continuation step: ${step}; only traces-light is supported`);
  }
  return Object.freeze({checkpoint, step: 'traces-light'});
}

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

/** Parse the deliberately narrow retry mode for a failed project inspect. */
export function parseChecklistPrefixRetryArguments(values: Record<string, string>): ChecklistPrefixRetryArguments | undefined {
  const checkpoint = values['checklist-prefix-retry-checkpoint'];
  const priorOutput = values['checklist-prefix-retry-prior-output'];
  const retryGenerationId = values['checklist-prefix-retry-generation'];
  const sideEffects = values['external-side-effects'];
  const prefixPresent = [checkpoint, priorOutput, retryGenerationId].filter(value => value !== undefined).length;
  if (prefixPresent === 0) return undefined;
  if (prefixPresent !== 3 || !checkpoint || !priorOutput || !retryGenerationId || sideEffects !== 'absent') {
    throw new Error('--checklist-prefix-retry-checkpoint, --checklist-prefix-retry-prior-output, --checklist-prefix-retry-generation, and --external-side-effects absent are required together');
  }
  if (!/^[0-9a-f]{64}$/.test(retryGenerationId)) {
    throw new Error('--checklist-prefix-retry-generation must be a lowercase 64-character generation ID');
  }
  return Object.freeze({checkpoint, priorOutput, retryGenerationId});
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

function executable(value: string, option = '--proof-bin'): string {
  if (!path.isAbsolute(value)) throw new Error(option + ' must be an absolute path');
  const resolved = fs.realpathSync(value);
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error(option + ' is not executable');
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

export function runProof(proof: string, subject: string, output: string, phase: string, args: string[], timeout: number, input?: string): CommandResult {
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

/**
 * The default-auth exec transport deliberately does not consult CODEX_HOME.
 * Keep the subject-local override checks from the normal profile, but require
 * the ambient home selector to be absent before any Proof/graph work starts.
 */
export function assertCodexHomeAbsent(subject: string, original: string, output: string): {home: string; configPresent: boolean} {
  if (process.env.CODEX_HOME !== undefined) {
    throw new Error('CODEX_HOME must be absent for exec-jsonl-default-auth-v1');
  }
  for (const name of ['.codex', '.codexrc', 'codex.toml']) {
    if (fs.existsSync(path.join(subject, name))) throw new Error('subject contains unsupported Codex override ' + name);
  }
  // Keep the arguments explicit so a future caller cannot accidentally widen
  // the protected-root policy while this selector has no home directory.
  if (!path.isAbsolute(subject) || !path.isAbsolute(original) || !path.isAbsolute(output)) {
    throw new Error('exec-jsonl-default-auth-v1 roots must be absolute');
  }
  return {home: '', configPresent: false};
}

/**
 * Verify the caller-selected Codex executable before any checklist graph
 * work. Probe repeats this check immediately before launch; keeping the
 * runner-side check here prevents a stale or mistyped identity from reaching
 * Proof initialization or journal mutation.
 */
export function verifyCodexBinarySha256(executablePath: string, suppliedSha256: string): string {
  const normalized = suppliedSha256.startsWith('sha256:') ? suppliedSha256.slice('sha256:'.length) : suppliedSha256;
  if (!path.isAbsolute(executablePath) || !/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error('--codex-sha256 must be a lowercase 64-character SHA-256 digest (optionally sha256:-prefixed)');
  }
  const actual = createHash('sha256').update(fs.readFileSync(executablePath)).digest('hex');
  if (actual !== normalized) throw new Error('--codex-sha256 does not match --codex-bin bytes');
  return `sha256:${actual}`;
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
    const subject = invocation.subject;
    if (subject && typeof subject === 'object' && !Array.isArray(subject) &&
        (subject as Json).kind === 'project' &&
        !Object.prototype.hasOwnProperty.call(subject, 'id') &&
        !Object.prototype.hasOwnProperty.call(subject, 'fingerprint')) {
      delete output.result_schema;
    }
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

const checklistSkeletonPauseGate: GeneratedDispatchGate = (
  generation: NodeGenerationProjection,
): GeneratedDispatchGateDecision => generation.checkId === 'checklist-skeleton' ? 'defer' : 'dispatch';

const checklistContinuationPauseGate: GeneratedDispatchGate = (
  generation: NodeGenerationProjection,
): GeneratedDispatchGateDecision => generation.checkId === 'checklist-traces-light' ? 'defer' : 'dispatch';

type ChecklistSkeletonFrontierAssessment = Readonly<{
  ready: boolean;
  expectedComponentIds: readonly string[];
  promotedComponentIds: readonly string[];
  componentAttemptsStarted: number;
  skeletonGenerationIds: readonly string[];
  reason?: string;
}>;

/**
 * Inspect the exported component frontier without trusting the gate's return
 * value.  A skeleton pause is meaningful only when every current component
 * promotion completed, no active generation is failed/running, and exactly
 * one skeleton generation is ready to run.
 */
export function assessChecklistSkeletonFrontier(
  config: VisorConfig,
  checkpoint: GraphJournalCheckpointV1,
  expectedComponentIds?: readonly string[],
): ChecklistSkeletonFrontierAssessment {
  try {
    const projection = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), checkpoint).getInstanceProjection();
    const expected = utf8Sorted(expectedComponentIds ?? materializedComponentIds(config, checkpoint));
    const activeGenerationIds = new Set(Object.values(projection.activeGenerationIdByNode));
    const active = Object.values(projection.generationsById).filter(generation =>
      generation.status !== 'inactive' && activeGenerationIds.has(generation.nodeGenerationId),
    );
    const componentAttemptsStarted = checkpoint.events.filter(event =>
      event.type === 'AttemptStarted' && event.scope.length > 1,
    ).length;
    const promotions = active.filter(generation =>
      generation.checkId === 'promote-native-component' && generation.scope.length > 1,
    );
    const promotedComponentIds = utf8Sorted(promotions.flatMap(generation => {
      const segment = generation.scope[generation.scope.length - 1];
      return segment && segment.kind === 'keyed' ? [segment.key] : [];
    }));
    const skeleton = active.filter(generation => generation.checkId === 'checklist-skeleton');
    const failedOrRunning = active.filter(generation => generation.status === 'failed' || generation.status === 'running');
    const duplicatePromotions = new Set(promotedComponentIds).size !== promotedComponentIds.length;
    const promotionsComplete = !duplicatePromotions &&
      promotedComponentIds.length === expected.length &&
      promotedComponentIds.every((id, index) => id === expected[index]) &&
      promotions.every(generation => generation.status === 'completed');
    const readySkeleton = skeleton.length === 1 && skeleton[0].status === 'ready' &&
      activeGenerationIds.has(skeleton[0].nodeGenerationId);
    let reason: string | undefined;
    if (failedOrRunning.length > 0) reason = 'active checklist frontier contains failed or running generations';
    else if (!promotionsComplete) reason = 'not every materialized component has exactly one completed promotion';
    else if (!readySkeleton) reason = 'checklist-skeleton is not the single ready generation';
    return Object.freeze({
      ready: reason === undefined,
      expectedComponentIds: Object.freeze(expected),
      promotedComponentIds: Object.freeze(promotedComponentIds),
      componentAttemptsStarted,
      skeletonGenerationIds: Object.freeze(skeleton.map(generation => generation.nodeGenerationId)),
      ...(reason ? {reason} : {}),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unable to inspect checklist skeleton frontier';
    return Object.freeze({
      ready: false,
      expectedComponentIds: Object.freeze([]),
      promotedComponentIds: Object.freeze([]),
      componentAttemptsStarted: 0,
      skeletonGenerationIds: Object.freeze([]),
      reason,
    });
  }
}

export function checklistSkeletonFrontierIsReady(
  config: VisorConfig,
  checkpoint: GraphJournalCheckpointV1,
  expectedComponentIds?: readonly string[],
): boolean {
  return assessChecklistSkeletonFrontier(config, checkpoint, expectedComponentIds).ready;
}

export function checklistSkeletonResumeDeltaIsValid(
  config: VisorConfig,
  before: GraphJournalCheckpointV1,
  after: GraphJournalCheckpointV1,
  expectedComponentIds: readonly string[],
): boolean {
  if (!checklistSkeletonFrontierIsReady(config, before, expectedComponentIds)) return false;
  if (after.events.length <= before.events.length) return false;
  const suffix = after.events.slice(before.events.length);
  const attemptStartedChecks = suffix.filter(event => event.type === 'AttemptStarted').map(event => event.checkId);
  if (attemptStartedChecks.length !== 1 || attemptStartedChecks[0] !== 'checklist-skeleton') return false;
  const projection = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), after).getInstanceProjection();
  const activeGenerationIds = new Set(Object.values(projection.activeGenerationIdByNode));
  const skeleton = Object.values(projection.generationsById).filter(generation =>
    generation.checkId === 'checklist-skeleton' && generation.status !== 'inactive' && activeGenerationIds.has(generation.nodeGenerationId),
  );
  const activeGenerations = Object.values(projection.generationsById).filter(generation =>
    generation.status !== 'inactive' && activeGenerationIds.has(generation.nodeGenerationId),
  );
  return skeleton.length === 1 && skeleton[0].status === 'completed' &&
    !activeGenerations.some(generation => generation.status === 'failed' || generation.status === 'running');
}

export async function loadChecklistMaterializedConfig(
  checkpointPath: string,
): Promise<{config: VisorConfig; checkpoint: GraphJournalCheckpointV1; materializedConfigPath: string}> {
  const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as GraphJournalCheckpointV1;
  const checkpointRoot = fs.realpathSync(path.dirname(checkpointPath));
  const candidate = path.join(checkpointRoot, 'checklist-materialized-config.json');
  const materializedConfigPath = fs.realpathSync(candidate);
  if (!inside(materializedConfigPath, checkpointRoot) || !fs.statSync(materializedConfigPath).isFile()) {
    throw new Error('checklist skeleton resume materialized config must be a sibling regular file');
  }
  const bytes = fs.readFileSync(materializedConfigPath, 'utf8');
  const parsed = JSON.parse(bytes) as Json;
  if (canonicalJson(parsed) + '\n' !== bytes) {
    throw new Error('checklist skeleton resume materialized config is not canonical');
  }
  const config = await loadConfig(parsed as VisorConfig, {strict: true});
  const graphDigest = compileClaimPlan(config).expansionPlan.graphSemanticDigest;
  if (checkpoint.graphSemanticDigest !== graphDigest) {
    throw new Error('checklist skeleton resume config graph digest does not match checkpoint');
  }
  return {config, checkpoint, materializedConfigPath};
}

type ChecklistContinuationEvidence = Readonly<{
  mode: 'retained-skeleton' | 'continuation-frontier';
  checkpoint: GraphJournalCheckpointV1;
  checkpointPath: string;
  config: VisorConfig;
  materializedConfigPath: string;
  prefixCheckpoint?: GraphJournalCheckpointV1;
  prefixCheckpointPath?: string;
  expectedComponentIds: readonly string[];
  workItems: readonly Json[];
  authority?: Json;
  affectedComponentIds?: readonly string[];
  reusedComponentIds?: readonly string[];
  affectedBatches?: readonly Readonly<{component_id: string; paths: readonly string[]}>[];
  affectedDetailsByComponent?: Readonly<Record<string, readonly string[]>>;
}>;

const CONTINUATION_AUTHORITY_VERSION = 'native.checklist-continuation-authority/v1';
const CONTINUATION_WORK_ITEM_KEYS = [
  'version', 'project_id', 'component_id', 'sorted_owned_paths',
  'sorted_dependency_closure', 'proof_path_mapping', 'proof_input_state',
  'proof_component_subject', 'baseline_commit',
] as const;

function sha256File(file: string): string {
  return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function uniqueSortedStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  const sorted = utf8Sorted(value as string[]);
  if (new Set(sorted).size !== sorted.length) throw new Error(`${label} must be unique`);
  return sorted;
}

type ContinuationTaskObservation = Readonly<{
  batches: readonly Readonly<{component_id: string; paths: readonly string[]}>[];
  detailsByComponent: Readonly<Record<string, readonly string[]>>;
}>;

function continuationTaskObservation(
  catalog: Json,
  affectedComponentIds: readonly string[],
  authorityWorkItems: readonly unknown[],
): ContinuationTaskObservation {
  const components = Array.isArray(catalog.components) ? catalog.components.filter(isRecord) : [];
  const expectedIds = uniqueSortedStrings(affectedComponentIds, 'continuation task affected component IDs');
  if (components.length !== expectedIds.length) {
    throw new Error('continuation task components must exactly match affected component IDs');
  }
  const authorityById = new Map<string, Json>();
  for (const [index, authorityItem] of authorityWorkItems.entries()) {
    const validated = validateContinuationWorkItem(authorityItem, `authority WorkItem ${index}`);
    const componentId = String(validated.component_id);
    if (authorityById.has(componentId)) throw new Error(`authority WorkItems contain duplicate component ${componentId}`);
    authorityById.set(componentId, validated);
  }
  const batches: Array<Readonly<{component_id: string; paths: readonly string[]}>> = [];
  const detailsByComponent: Record<string, readonly string[]> = {};
  const operationalById = new Map<string, Json>();
  for (const component of components) {
    if (typeof component.component_id !== 'string' || !expectedIds.includes(component.component_id) || operationalById.has(component.component_id)) {
      throw new Error('continuation task components contain an unexpected or duplicate component ID');
    }
    operationalById.set(component.component_id, component);
  }
  for (const componentId of expectedIds) {
    const item = components.find(candidate => candidate.component_id === componentId);
    const authorityItem = authorityById.get(componentId);
    const task = item && isRecord(item.continuation_task) ? item.continuation_task : undefined;
    const orphan = task && isRecord(task.orphan_code_clean) ? task.orphan_code_clean : undefined;
    if (!item || !authorityItem || !task || !orphan || !hasExactKeys(task, ['step_id', 'role', 'required_checks', 'orphan_code_clean']) ||
        task.step_id !== 'traces-light' || task.role !== 'onboard' ||
        canonicalJson(task.required_checks) !== canonicalJson(['annotation_validity', 'orphan_code_clean']) ||
        !hasExactKeys(orphan, ['paths', 'details'])) {
      throw new Error(`affected WorkItem ${componentId} has an invalid closed continuation task`);
    }
    const {continuation_task: _continuationTask, ...baseWorkItem} = item;
    if (canonicalJson(baseWorkItem) !== canonicalJson(authorityItem)) {
      throw new Error(`continuation task WorkItem ${componentId} is detached from native authority`);
    }
    const paths = uniqueSortedStrings(orphan.paths, `continuation task ${componentId} paths`);
    const ownedPaths = Array.isArray(authorityItem.sorted_owned_paths) ? authorityItem.sorted_owned_paths : [];
    if (paths.some(candidate => !ownedPaths.includes(candidate))) {
      throw new Error(`continuation task ${componentId} paths exceed native owned paths`);
    }
    if (paths.length === 0 || !Array.isArray(orphan.details) || orphan.details.length === 0 ||
        orphan.details.some(detail => typeof detail !== 'string' || detail.length === 0)) {
      throw new Error(`continuation task ${componentId} details are incomplete`);
    }
    const details = Object.freeze((orphan.details as string[]).slice());
    if (details.some(detail => {
      const match = /^([^:]+):[0-9]+(?:\s|$)/.exec(detail);
      return !match || !paths.includes(match[1]);
    })) {
      throw new Error(`continuation task ${componentId} details are not mapped to owned paths`);
    }
    batches.push(Object.freeze({component_id: componentId, paths: Object.freeze(paths)}));
    detailsByComponent[componentId] = details;
  }
  return Object.freeze({
    batches: Object.freeze(batches),
    detailsByComponent: Object.freeze(detailsByComponent),
  });
}

function validateContinuationWorkItem(value: unknown, label: string): Json {
  if (!isRecord(value) || !hasExactKeys(value, CONTINUATION_WORK_ITEM_KEYS)) {
    throw new Error(`${label} is not a closed Proof WorkItem`);
  }
  if (value.version !== 'reqproof.onboarding-component-work-item/v1' ||
      typeof value.project_id !== 'string' || value.project_id.length === 0 ||
      typeof value.component_id !== 'string' || value.component_id.length === 0 ||
      typeof value.baseline_commit !== 'string' || !/^[0-9a-f]{40,64}$/.test(value.baseline_commit) ||
      !Array.isArray(value.sorted_owned_paths) || value.sorted_owned_paths.length === 0 ||
      value.sorted_owned_paths.some(item => typeof item !== 'string' || item.length === 0 || path.isAbsolute(item) || item.split('/').includes('..')) ||
      !Array.isArray(value.sorted_dependency_closure) || value.sorted_dependency_closure.length === 0 ||
      value.sorted_dependency_closure.some(item => typeof item !== 'string' || item.length === 0 || path.isAbsolute(item) || item.split('/').includes('..')) ||
      !isRecord(value.proof_path_mapping) || !Array.isArray(value.proof_input_state) ||
      value.proof_input_state.some(item => !isRecord(item)) || !isRecord(value.proof_component_subject)) {
    throw new Error(`${label} is incomplete or unsafe`);
  }
  return value;
}

function continuationReceiptIdentities(revalidation: Json, workItems: readonly Json[]): Json {
  const receipt = isRecord(revalidation.receipt) ? revalidation.receipt : undefined;
  if (!receipt) throw new Error('current Proof revalidation receipt is missing');
  const required = ['inventory_claim_id', 'catalog_claim_id', 'receipt_id', 'admission_candidate_id', 'admission_receipt_id'];
  if (required.some(key => typeof receipt[key] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(receipt[key] as string))) {
    throw new Error('current Proof revalidation receipt identities are incomplete');
  }
  if (!Array.isArray(receipt.component_authorities)) throw new Error('current Proof revalidation receipt has no component authorities');
  const authorities = receipt.component_authorities.map((value, index) => {
    if (!isRecord(value) || typeof value.component_id !== 'string' ||
        typeof value.work_item_digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value.work_item_digest) ||
        !isRecord(value.subject)) throw new Error(`current Proof component receipt ${index} is incomplete`);
    return {component_id: value.component_id, work_item_digest: value.work_item_digest, subject: value.subject};
  });
  const ids = workItems.map(item => item.component_id as string);
  if (authorities.length !== ids.length || utf8Sorted(authorities.map(value => value.component_id)).join('\u0000') !== utf8Sorted(ids).join('\u0000')) {
    throw new Error('current Proof component receipt identities do not match WorkItems');
  }
  return {
    inventory_claim_id: receipt.inventory_claim_id,
    catalog_claim_id: receipt.catalog_claim_id,
    receipt_id: receipt.receipt_id,
    admission_candidate_id: receipt.admission_candidate_id,
    admission_receipt_id: receipt.admission_receipt_id,
    component_authorities: authorities.sort((left, right) => Buffer.from(left.component_id).compare(Buffer.from(right.component_id))),
  };
}

function continuationAuthorityReceiptStrings(authority: Json): string[] {
  const current = authority.current_receipt_identities as Json;
  const retained = authority.retained as Json;
  const component = Array.isArray(current.component_authorities) ? current.component_authorities : [];
  return [
    current.inventory_claim_id, current.catalog_claim_id, current.receipt_id,
    current.admission_candidate_id, current.admission_receipt_id,
    ...component.flatMap(value => isRecord(value) && typeof value.work_item_digest === 'string' ? [value.work_item_digest] : []),
    retained.checkpoint_sha256, retained.prefix_checkpoint_sha256,
  ].filter((value): value is string => typeof value === 'string');
}

function validateContinuationAuthority(value: unknown, label = 'continuation authority'): Json {
  if (!isRecord(value) || !hasExactKeys(value, [
    'version', 'project_id', 'subject_fingerprint', 'current_inventory',
    'current_revalidation', 'current_work_items', 'current_receipt_identities',
    'retained', 'affected_component_ids', 'reused_component_ids',
  ])) throw new Error(`${label} is not a closed authority envelope`);
  const retained = isRecord(value.retained) ? value.retained : undefined;
  if (value.version !== CONTINUATION_AUTHORITY_VERSION || typeof value.project_id !== 'string' ||
      value.project_id.length === 0 || typeof value.subject_fingerprint !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(value.subject_fingerprint) ||
      !isRecord(value.current_inventory) || !isRecord(value.current_revalidation) ||
      !isRecord(value.current_receipt_identities) || !retained) {
    throw new Error(`${label} has invalid project authority`);
  }
  const inventoryAuthority = isRecord(value.current_inventory.authority) ? value.current_inventory.authority : undefined;
  if (!inventoryAuthority || inventoryAuthority.project_id !== value.project_id ||
      inventoryAuthority.subject_fingerprint !== value.subject_fingerprint) {
    throw new Error(`${label} inventory authority is detached`);
  }
  if (!Array.isArray(value.current_work_items) || value.current_work_items.length === 0) {
    throw new Error(`${label} has no full WorkItems`);
  }
  const workItems = value.current_work_items.map((item, index) => validateContinuationWorkItem(item, `${label} WorkItem ${index}`));
  const workItemIds = uniqueSortedStrings(workItems.map(item => item.component_id), `${label} WorkItem IDs`);
  const affected = uniqueSortedStrings(value.affected_component_ids, `${label} affected component IDs`);
  const reused = uniqueSortedStrings(value.reused_component_ids, `${label} reused component IDs`);
  if (affected.some(id => !workItemIds.includes(id)) || reused.some(id => !workItemIds.includes(id)) ||
      affected.some(id => reused.includes(id)) || utf8Sorted([...affected, ...reused]).join('\u0000') !== workItemIds.join('\u0000')) {
    throw new Error(`${label} affected/reused partition is not exact and disjoint`);
  }
  const receipt = value.current_receipt_identities;
  if (!hasExactKeys(receipt, ['inventory_claim_id', 'catalog_claim_id', 'receipt_id', 'admission_candidate_id', 'admission_receipt_id', 'component_authorities']) ||
      ['inventory_claim_id', 'catalog_claim_id', 'receipt_id', 'admission_candidate_id', 'admission_receipt_id'].some(key => typeof receipt[key] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(receipt[key] as string)) ||
      !Array.isArray(receipt.component_authorities) || receipt.component_authorities.length !== workItems.length) {
    throw new Error(`${label} current receipt identities are incomplete`);
  }
  const authorityIds = receipt.component_authorities.map((row, index) => {
    if (!isRecord(row) || !hasExactKeys(row, ['component_id', 'work_item_digest', 'subject']) ||
        typeof row.component_id !== 'string' || typeof row.work_item_digest !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(row.work_item_digest) || !isRecord(row.subject)) {
      throw new Error(`${label} component receipt ${index} is incomplete`);
    }
    return row.component_id;
  });
  if (utf8Sorted(authorityIds).join('\u0000') !== workItemIds.join('\u0000')) throw new Error(`${label} receipt identities do not match WorkItems`);
  const revalidationReceipt = isRecord(value.current_revalidation.receipt) ? value.current_revalidation.receipt : undefined;
  if (!revalidationReceipt || ['inventory_claim_id', 'catalog_claim_id', 'receipt_id', 'admission_candidate_id', 'admission_receipt_id'].some(key => revalidationReceipt[key] !== receipt[key])) {
    throw new Error(`${label} revalidation receipt is detached`);
  }
  const expectedReceipt = continuationReceiptIdentities(value.current_revalidation, workItems);
  if (canonicalJson(expectedReceipt) !== canonicalJson(receipt)) {
    throw new Error(`${label} current receipt identities are detached from native revalidation`);
  }
  const retainedKeys = ['checkpoint_sha256', 'prefix_checkpoint_sha256', 'checkpoint_session_id', 'prefix_session_id', 'checkpoint_graph_semantic_digest', 'prefix_graph_semantic_digest'];
  const hasCheckpointPointers = Object.prototype.hasOwnProperty.call(retained, 'checkpoint_path') ||
    Object.prototype.hasOwnProperty.call(retained, 'prefix_checkpoint_path');
  if (hasCheckpointPointers && (!Object.prototype.hasOwnProperty.call(retained, 'checkpoint_path') ||
      !Object.prototype.hasOwnProperty.call(retained, 'prefix_checkpoint_path'))) {
    throw new Error(`${label} retained checkpoint source pointers are incomplete`);
  }
  const checkpointPath = retained.checkpoint_path;
  const prefixCheckpointPath = retained.prefix_checkpoint_path;
  if (!hasExactKeys(retained, hasCheckpointPointers ? [...retainedKeys, 'checkpoint_path', 'prefix_checkpoint_path'] : retainedKeys) ||
      ['checkpoint_sha256', 'prefix_checkpoint_sha256'].some(key => typeof retained[key] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(retained[key] as string)) ||
      ['checkpoint_session_id', 'prefix_session_id', 'checkpoint_graph_semantic_digest', 'prefix_graph_semantic_digest'].some(key => typeof retained[key] !== 'string' || (retained[key] as string).length === 0) ||
      (hasCheckpointPointers && (typeof checkpointPath !== 'string' || !path.isAbsolute(checkpointPath) || typeof prefixCheckpointPath !== 'string' || !path.isAbsolute(prefixCheckpointPath)))) {
    throw new Error(`${label} retained checkpoint identities are incomplete`);
  }
  return value;
}

function retainedProofClaimView(
  claim: InstanceClaimProjection,
  label: string,
  includeCandidateEvidence = false,
): CandidateClaimInput {
  if (claim.kind !== 'generated-output' || claim.producerAttemptId === undefined || claim.producerFence === undefined) {
    throw new Error(`${label} is not an attempt-produced claim`);
  }
  return {
    claimId: claim.claimId,
    claim: claim.claim,
    payload: claim.payload,
    payloadFingerprint: claim.payloadFingerprint,
    producerCheckId: claim.producerCheckId,
    scope: claim.scope,
    parentClaimIds: claim.parentClaimIds,
    wireMode: claim.wireMode,
    provenance: 'attempt',
    attemptId: claim.producerAttemptId,
    fence: claim.producerFence,
    ...(includeCandidateEvidence && claim.proofCandidateEvidence
      ? {proofAdmission: claim.proofCandidateEvidence}
      : {}),
  };
}

function retainedProofCandidateAdmission(
  config: VisorConfig,
  checkpoint: GraphJournalCheckpointV1,
): {candidate: CandidateClaimInput; admission: CandidateClaimInput} {
  const projection = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), checkpoint).getInstanceProjection();
  const active = Object.values(projection.claimsById).filter(claim => claim.active && claim.scope.length === 1);
  const candidates = active.filter(claim => claim.claim === 'proof.candidate@1' && claim.producerCheckId === 'inspect');
  const admissions = active.filter(claim => claim.claim === 'proof.admitted_receipt@1' && claim.producerCheckId === 'proof_admit');
  if (candidates.length !== 1 || admissions.length !== 1) {
    throw new Error('retained Proof prefix must contain exactly one project catalog candidate and admission');
  }
  return {
    candidate: retainedProofClaimView(candidates[0], 'retained Proof candidate', true),
    admission: retainedProofClaimView(admissions[0], 'retained Proof admission'),
  };
}

/**
 * Revalidate the durable current-authority envelope before a generated
 * continuation frontier is resumed. This is intentionally a pure journal
 * operation: it reads only the recorded CP255/CP251 bytes and invokes the
 * existing Proof-byte validator, never a provider or subprocess.
 */
export async function validateJournaledContinuationAuthority(
  authority: Json,
): Promise<Json> {
  const retained = isRecord(authority.retained) ? authority.retained : undefined;
  if (!retained || typeof retained.checkpoint_path !== 'string' ||
      typeof retained.prefix_checkpoint_path !== 'string' ||
      !path.isAbsolute(retained.checkpoint_path) || !path.isAbsolute(retained.prefix_checkpoint_path)) {
    throw new Error('journaled continuation authority has no retained checkpoint source pointers');
  }
  const checkpointPath = fs.realpathSync(retained.checkpoint_path);
  const prefixCheckpointPath = fs.realpathSync(retained.prefix_checkpoint_path);
  if (checkpointPath === prefixCheckpointPath) throw new Error('journaled continuation retained checkpoints must be distinct');
  const checkpoint = readValidatedCheckpoint(checkpointPath, 'journaled retained CP255');
  const prefix = readValidatedCheckpoint(prefixCheckpointPath, 'journaled retained CP251');
  if (sha256File(checkpointPath) !== retained.checkpoint_sha256 ||
      sha256File(prefixCheckpointPath) !== retained.prefix_checkpoint_sha256 ||
      checkpoint.sessionId !== retained.checkpoint_session_id ||
      prefix.sessionId !== retained.prefix_session_id ||
      checkpoint.graphSemanticDigest !== retained.checkpoint_graph_semantic_digest ||
      prefix.graphSemanticDigest !== retained.prefix_graph_semantic_digest) {
    throw new Error('journaled continuation retained checkpoint bytes are detached from authority');
  }
  const prefixMaterialized = await loadChecklistMaterializedConfig(prefixCheckpointPath);
  const expectedComponentIds = materializedComponentIds(prefixMaterialized.config, prefixMaterialized.checkpoint);
  if (!checklistSkeletonResumeDeltaIsValid(prefixMaterialized.config, prefixMaterialized.checkpoint, checkpoint, expectedComponentIds)) {
    throw new Error('journaled continuation retained CP255 does not contain the exact CP251 skeleton suffix');
  }
  const {candidate, admission} = retainedProofCandidateAdmission(prefixMaterialized.config, prefix);
  const currentInventory = isRecord(authority.current_inventory) ? authority.current_inventory : undefined;
  const currentRevalidation = isRecord(authority.current_revalidation) ? authority.current_revalidation : undefined;
  if (!currentInventory || !currentRevalidation || !isRecord(currentRevalidation.inventory) ||
      proofCanonicalJson(currentRevalidation.inventory) !== proofCanonicalJson(currentInventory)) {
    throw new Error('journaled continuation current Proof inventory is detached from revalidation');
  }
  const rawWorkItems = Array.isArray(authority.current_work_items) ? authority.current_work_items : undefined;
  if (!rawWorkItems || rawWorkItems.length === 0) throw new Error('journaled continuation has no current Proof WorkItems');
  const workItems = rawWorkItems.map((item, index) => {
    const checked = validateContinuationWorkItem(item, `journaled current Proof WorkItem ${index}`);
    const {baseline_commit: _baselineCommit, ...proofWorkItem} = checked;
    return proofWorkItem;
  });
  const catalog = currentRevalidation.catalog;
  if (!isRecord(catalog) || !isRecord(currentInventory.authority)) {
    throw new Error('journaled continuation current Proof authority projection is incomplete');
  }
  const workItemsProjection = {
    version: 'proof.onboarding-work-item-projection/v1',
    authority: currentInventory.authority,
    catalog,
    work_items: workItems,
  };
  let validated: ReturnType<typeof validateProofCurrentCatalogAuthorityBytes>;
  try {
    validated = validateProofCurrentCatalogAuthorityBytes({
      revalidationBytesBase64: Buffer.from(proofCanonicalJson(currentRevalidation), 'utf8').toString('base64'),
      workItemsBytesBase64: Buffer.from(proofCanonicalJson(workItemsProjection), 'utf8').toString('base64'),
      candidate,
      admission,
    });
  } catch (error) {
    throw new Error(`journaled continuation current Proof authority bytes are invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (proofCanonicalJson(validated.revalidation) !== proofCanonicalJson(currentRevalidation) ||
      proofCanonicalJson(validated.workItems) !== proofCanonicalJson(workItemsProjection)) {
    throw new Error('journaled continuation current Proof authority bytes changed during validation');
  }
  return authority;
}

export function buildChecklistContinuationAuthority(
  current: CurrentRetainedCatalogValidation,
  checkpointPath: string,
  prefixCheckpointPath: string | undefined,
  affectedComponentIds: readonly string[],
  reusedComponentIds: readonly string[],
): Json {
  const inventoryAuthority = isRecord(current.inventory.authority) ? current.inventory.authority : undefined;
  if (!inventoryAuthority || typeof inventoryAuthority.project_id !== 'string' || typeof inventoryAuthority.subject_fingerprint !== 'string') {
    throw new Error('current Proof inventory authority is incomplete');
  }
  const workItems = current.workItems.map((item, index) => validateContinuationWorkItem(item, `current Proof WorkItem ${index}`));
  const retainedPath = fs.realpathSync(path.resolve(checkpointPath));
  const retainedBytes = fs.readFileSync(retainedPath);
  const prefixPath = fs.realpathSync(path.resolve(prefixCheckpointPath ?? checkpointPath));
  const prefix = JSON.parse(fs.readFileSync(prefixPath, 'utf8')) as Json;
  const retained = JSON.parse(retainedBytes.toString('utf8')) as Json;
  const authority = {
    version: CONTINUATION_AUTHORITY_VERSION,
    project_id: inventoryAuthority.project_id,
    subject_fingerprint: inventoryAuthority.subject_fingerprint,
    current_inventory: current.inventory,
    current_revalidation: current.revalidation,
    current_work_items: workItems,
    current_receipt_identities: continuationReceiptIdentities(current.revalidation, workItems),
    retained: {
      checkpoint_sha256: `sha256:${createHash('sha256').update(retainedBytes).digest('hex')}`,
      prefix_checkpoint_sha256: sha256File(prefixPath),
      checkpoint_session_id: typeof retained.sessionId === 'string' ? retained.sessionId : '',
      prefix_session_id: typeof prefix.sessionId === 'string' ? prefix.sessionId : '',
      checkpoint_graph_semantic_digest: typeof retained.graphSemanticDigest === 'string' ? retained.graphSemanticDigest : '',
      prefix_graph_semantic_digest: typeof prefix.graphSemanticDigest === 'string' ? prefix.graphSemanticDigest : '',
      checkpoint_path: retainedPath,
      prefix_checkpoint_path: prefixPath,
    },
    affected_component_ids: utf8Sorted(affectedComponentIds),
    reused_component_ids: utf8Sorted(reusedComponentIds),
  } as Json;
  return validateContinuationAuthority(authority);
}

function readValidatedCheckpoint(file: string, label: string): GraphJournalCheckpointV1 {
  const bytes = fs.readFileSync(file, 'utf8');
  let value: unknown;
  try { value = JSON.parse(bytes); } catch (error) { throw new Error(`${label} is not valid JSON: ${String(error)}`); }
  return ExecutionJournal.validateGraphCheckpointIntegrity(value);
}

/** Find the immutable CP251/config pair recorded beside a CP255 checkpoint. */
export function resolveChecklistContinuationPrefix(checkpointPath: string): {
  checkpointPath: string;
  configPath: string;
} {
  const target = fs.realpathSync(path.resolve(checkpointPath));
  if (path.basename(target) !== 'checkpoint.json') {
    throw new Error('checklist continuation must name a retained checkpoint.json');
  }
  readValidatedCheckpoint(target, 'checklist continuation checkpoint');
  const root = fs.realpathSync(path.dirname(target));
  const directConfig = path.join(root, 'checklist-materialized-config.json');
  if (fs.existsSync(directConfig)) {
    return {checkpointPath: target, configPath: fs.realpathSync(directConfig)};
  }
  const preflight = path.join(root, 'preflight.json');
  if (fs.existsSync(preflight)) {
    try {
      const record = JSON.parse(fs.readFileSync(preflight, 'utf8')) as Json;
      const recorded = record.checklist_skeleton_checkpoint;
      if (typeof recorded === 'string' && path.basename(recorded) === 'checklist-skeleton-frontier-checkpoint.json') {
        const prefix = fs.realpathSync(path.resolve(recorded));
        const config = fs.realpathSync(path.join(path.dirname(prefix), 'checklist-materialized-config.json'));
        return {checkpointPath: prefix, configPath: config};
      }
    } catch {
      // The continuation contract is intentionally fail-closed: CP255 must
      // record the exact retained skeleton checkpoint rather than relying on
      // sibling-directory discovery or event-count inference.
    }
  }
  throw new Error('checklist continuation checkpoint does not record a retained checklist_skeleton_checkpoint');
}

export function validateChecklistContinuationEligibility(show: unknown, allowConfirmed = false): Json {
  if (!show || typeof show !== 'object' || Array.isArray(show)) throw new Error('current Proof checklist show is not an object');
  const value = show as Json;
  if (value.schema_version !== 'proof.checklist.show.v1' || value.active !== true || value.new_project !== true) {
    throw new Error('current Proof checklist is not the active new-project campaign');
  }
  const steps = Array.isArray(value.steps) ? value.steps.filter(isRecord) : [];
  const skeleton = steps.find(step => step.step_id === 'skeleton');
  if (!skeleton || !hasExactChecklistConfirmationEvidence(skeleton)) {
    throw new Error('checklist continuation requires an exactly evidenced confirmed skeleton step');
  }
  const traces = steps.find(step => step.step_id === 'traces-light');
  const pending = traces && traces.applicable === true && traces.eligible === true &&
    traces.effective_status === 'pending' && traces.role === 'onboard';
  const confirmed = allowConfirmed && traces && hasExactChecklistConfirmationEvidence(traces);
  if (!traces || (!pending && !confirmed)) {
    throw new Error('checklist continuation requires eligible traces-light with the onboard role');
  }
  return Object.freeze({
    checklist: typeof value.checklist === 'string' ? value.checklist : undefined,
    skeleton: 'confirmed',
    step: 'traces-light',
    role: 'onboard',
    eligible: true,
  });
}

/** Validate CP255's exact CP251→CP255 skeleton-only suffix before any fresh graph is built. */
export async function validateChecklistContinuationCheckpoint(
  checkpointPath: string,
): Promise<ChecklistContinuationEvidence> {
  const target = fs.realpathSync(path.resolve(checkpointPath));
  const checkpoint = readValidatedCheckpoint(target, 'checklist continuation checkpoint');
  // A continuation frontier is authenticated by the exact materialized config
  // persisted beside its checkpoint. Do not compare it to the current YAML:
  // later source edits must not rewrite the graph being resumed.
  const directMaterializedConfig = path.join(path.dirname(target), 'checklist-materialized-config.json');
  if (fs.existsSync(directMaterializedConfig)) {
    const restored = await loadChecklistMaterializedConfig(target);
    if (Object.prototype.hasOwnProperty.call(restored.config.checks || {}, 'continue-retained-catalog')) {
      const authority = await validateJournaledContinuationAuthority(
        continuationGraphAuthority(restored.config, restored.checkpoint),
      );
      const workItems = continuationGraphWorkItems(restored.config, restored.checkpoint);
      const projection = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(restored.config), restored.checkpoint).getInstanceProjection();
      const catalogs = Object.values(projection.claimsById)
        .filter(claim => claim.active && claim.claim === 'native.continuation.catalog@1');
      if (catalogs.length !== 1 || !isRecord(catalogs[0].payload)) {
        throw new Error('continuation checkpoint must contain exactly one catalog authority envelope');
      }
      const taskObservation = continuationTaskObservation(
        catalogs[0].payload,
        uniqueSortedStrings(authority.affected_component_ids, 'journaled affected component IDs'),
        Array.isArray(authority.current_work_items) ? authority.current_work_items : [],
      );
      return Object.freeze({mode: 'continuation-frontier', checkpoint, checkpointPath: target, config: restored.config,
        materializedConfigPath: restored.materializedConfigPath, expectedComponentIds: Object.freeze(workItems.map(item => item.component_id as string)), workItems,
        authority, affectedComponentIds: Object.freeze(uniqueSortedStrings(authority.affected_component_ids, 'journaled affected component IDs')),
        reusedComponentIds: Object.freeze(uniqueSortedStrings(authority.reused_component_ids, 'journaled reused component IDs')),
        affectedBatches: taskObservation.batches,
        affectedDetailsByComponent: taskObservation.detailsByComponent,
      });
    }
  }
  const prefix = resolveChecklistContinuationPrefix(target);
  const restored = await loadChecklistMaterializedConfig(prefix.checkpointPath);
  if (checkpoint.graphSemanticDigest !== restored.checkpoint.graphSemanticDigest || checkpoint.sessionId !== restored.checkpoint.sessionId) {
    throw new Error('checklist continuation CP255 does not share the retained CP251 graph/session authority');
  }
  const expected = materializedComponentIds(restored.config, restored.checkpoint);
  const assessment = assessChecklistSkeletonFrontier(restored.config, restored.checkpoint, expected);
  if (!assessment.ready) throw new Error(`retained CP251 skeleton frontier is not ready: ${assessment.reason || 'frontier predicate failed'}`);
  if (!checklistSkeletonResumeDeltaIsValid(restored.config, restored.checkpoint, checkpoint, expected)) {
    throw new Error('retained CP255 does not contain exactly the validated skeleton-only resume suffix');
  }
  const workItems = materializedComponentWorkItems(restored.config, restored.checkpoint);
  return Object.freeze({mode: 'retained-skeleton', checkpoint, checkpointPath: target, config: restored.config,
    materializedConfigPath: restored.materializedConfigPath, prefixCheckpoint: restored.checkpoint,
    prefixCheckpointPath: prefix.checkpointPath, expectedComponentIds: expected, workItems});
}

function persistChecklistMaterializedConfig(output: string, config: VisorConfig): {path: string; bytes: string; digest: string} {
  const file = path.join(output, 'checklist-materialized-config.json');
  const bytes = canonicalJson(config) + '\n';
  writeText(file, bytes);
  fs.chmodSync(file, 0o600);
  return {
    path: file,
    bytes,
    digest: `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`,
  };
}

export function checklistBaselineCommitFromCheckpoint(config: VisorConfig, checkpoint: GraphJournalCheckpointV1): string {
  const projection = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), checkpoint).getInstanceProjection();
  const baselineClaims = Object.values(projection.claimsById).filter(claim =>
    claim.active && claim.claim === 'native.initialized.baseline@1',
  );
  if (baselineClaims.length !== 1) throw new Error('checklist project prefix must publish exactly one active initialized baseline claim');
  const baseline = baselineClaims[0];
  const baselineResearchParent = projection.claimsById[baseline.parentClaimIds[0]];
  const baselinePayload = baseline.payload && typeof baseline.payload === 'object' && !Array.isArray(baseline.payload)
    ? baseline.payload as Json
    : undefined;
  if (baseline.producerCheckId !== 'commit-initialized-baseline' || baseline.scope.length !== 1 ||
      baseline.scope[0]?.kind !== 'keyed' || baseline.parentClaimIds.length !== 1 ||
      !baselineResearchParent || !baselineResearchParent.active || baselineResearchParent.claim !== CHECKLIST_RESEARCH_SNAPSHOT_CLAIM ||
      baselineResearchParent.producerCheckId !== 'checklist-research' || canonicalJson(baselineResearchParent.scope) !== canonicalJson(baseline.scope) ||
      !baselinePayload || Object.keys(baselinePayload).sort().join('\0') !== 'baseline_commit\0version' ||
      baselinePayload.version !== 'native.initialized-baseline/v1' ||
      typeof baselinePayload.baseline_commit !== 'string' || !/^[0-9a-f]{40,64}$/.test(baselinePayload.baseline_commit) ||
      baseline.payloadFingerprint !== sha256Canonical(baselinePayload)) {
    throw new Error('checklist initialized baseline claim is not the exact journaled command output');
  }
  return baselinePayload.baseline_commit as string;
}

export type ChecklistPrefixRetrySelection = Readonly<{
  journal: ExecutionJournal;
  generation: NodeGenerationProjection;
  prefixEventCount: number;
}>;

/** Validate the retained failed project-inspect prefix before reopening it. */
export function validateChecklistPrefixRetrySelection(
  config: VisorConfig,
  checkpoint: GraphJournalCheckpointV1,
  retryGenerationId: string,
  externalSideEffects: string = 'absent',
): ChecklistPrefixRetrySelection {
  if (externalSideEffects !== 'absent') {
    throw new Error('checklist prefix retry requires --external-side-effects absent');
  }
  if (!/^[0-9a-f]{64}$/.test(retryGenerationId)) {
    throw new Error('checklist prefix retry generation ID must be a lowercase 64-character digest');
  }
  const plan = compileClaimPlan(config);
  if (checkpoint.graphSemanticDigest !== plan.expansionPlan.graphSemanticDigest) {
    throw new Error('checklist prefix retry checkpoint graph semantic digest does not match the current checklist configuration');
  }
  const validated = ExecutionJournal.validateGraphCheckpointIntegrity(checkpoint);
  const journal = ExecutionJournal.restoreGraphCheckpoint(plan, validated);
  const projection = journal.getInstanceProjection();
  const generation = projection.generationsById[retryGenerationId];
  if (!generation || generation.checkId !== 'inspect' || generation.scope.length > 1 ||
      projection.activeGenerationIdByNode[generation.nodeInstanceId] !== retryGenerationId ||
      generation.status !== 'failed' || !generation.scheduled ||
      typeof generation.attemptId !== 'string' || typeof generation.fence !== 'number' ||
      typeof generation.reason !== 'string' || generation.completedOutputClaimIds.length !== 0) {
    throw new Error('checklist prefix retry requires the selected failed inspect generation before component release');
  }
  const events = validated.events as unknown as readonly Json[];
  const failedAttempts = events.filter(event =>
    event.type === 'AttemptFailed' && event.nodeGenerationId === retryGenerationId && event.checkId === 'inspect',
  );
  const lastFailed = failedAttempts[failedAttempts.length - 1];
  if (!lastFailed || lastFailed.attemptId !== generation.attemptId ||
      lastFailed.fence !== generation.fence || lastFailed.reason !== generation.reason) {
    throw new Error('checklist prefix retry generation is not bound to its retained failed inspect attempt');
  }
  if (events.some(event => event.type === 'AttemptStarted' && Array.isArray(event.scope) && event.scope.length > 1)) {
    throw new Error('checklist prefix retry requires a prefix with no component attempt release');
  }
  return Object.freeze({journal, generation, prefixEventCount: validated.events.length});
}

export type ChecklistBootstrapRetrySubjectGuard = Readonly<{
  proof: string;
  subject: string;
  protectedOriginal: string;
  priorOutput: string;
  output: string;
  config: VisorConfig;
  checkpoint: GraphJournalCheckpointV1;
  governedCodexTransport: string;
  timeout: number;
}>;

/**
 * Verify the only source-tree state that a retained checklist prefix may
 * carry.  This is deliberately checklist-retry-only: generic recovery still
 * requires a clean subject.  The retained preflight is the authority for the
 * original launch roots and revision, while Proof's read-only checklist show
 * binds the three expected init files to the journaled root claim.
 */
export function assertChecklistBootstrapRetrySubject(
  input: ChecklistBootstrapRetrySubjectGuard,
): string {
  const {
    proof, subject, protectedOriginal, priorOutput, output, config, checkpoint,
    governedCodexTransport, timeout,
  } = input;
  if (!path.isAbsolute(output) || !path.isAbsolute(priorOutput)) {
    throw new Error('checklist prefix retry subject guard requires absolute output roots');
  }
  if (!Number.isSafeInteger(timeout) || timeout < 1000) {
    throw new Error('checklist prefix retry subject guard timeout is invalid');
  }
  const currentSubject = fs.realpathSync(subject);
  const currentOriginal = fs.realpathSync(protectedOriginal);
  const currentPriorOutput = fs.realpathSync(priorOutput);
  const currentProof = fs.realpathSync(proof);
  const preflightPath = path.join(currentPriorOutput, 'preflight.json');
  if (!fs.existsSync(preflightPath) || !fs.statSync(preflightPath).isFile()) {
    throw new Error('checklist prefix retry retained preflight.json is missing');
  }
  let retained: Json;
  try {
    const parsed = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    retained = parsed as Json;
  } catch (error) {
    throw new Error('checklist prefix retry retained preflight.json is invalid: ' + String(error));
  }
  const retainedPath = (key: string): string => {
    const value = retained[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`checklist prefix retry retained preflight is missing ${key}`);
    }
    try { return fs.realpathSync(value); } catch { throw new Error(`checklist prefix retry retained preflight ${key} is not a real path`); }
  };
  if (retainedPath('subject_root') !== currentSubject || retainedPath('protected_original_root') !== currentOriginal) {
    throw new Error('checklist prefix retry subject roots do not match retained preflight');
  }
  const retainedProof = retainedPath('proof_binary');
  if (retainedProof !== currentProof) {
    throw new Error('checklist prefix retry Proof binary does not match retained preflight');
  }
  if (retained.governed_codex_transport !== governedCodexTransport) {
    throw new Error('checklist prefix retry governed transport does not match retained preflight');
  }
  const head = gitScalar(currentSubject, ['rev-parse', '--verify', 'HEAD^{commit}'], 'checklist retry subject');
  const subjectRevision = retained.subject_revision;
  const sourceRevision = retained.source_revision;
  if (typeof subjectRevision !== 'string' || !/^[0-9a-f]{40,64}$/.test(subjectRevision) ||
      typeof sourceRevision !== 'string' || sourceRevision !== subjectRevision || sourceRevision !== head) {
    throw new Error('checklist prefix retry subject HEAD does not match retained preflight source revision');
  }

  const status = String(execFileSync('git', [
    '-C', currentSubject, 'status', '--porcelain=v1', '--untracked-files=all',
  ], {encoding: 'utf8'}));
  const expectedStatus = [
    ' M .gitignore',
    '?? proof.yaml',
    '?? proof/checklists/onboard_v1.state.yaml',
  ];
  const actualStatus = status.split(/\r?\n/).filter(Boolean);
  if (actualStatus.length !== expectedStatus.length ||
      [...actualStatus].sort().join('\n') !== [...expectedStatus].sort().join('\n')) {
    throw new Error('checklist prefix retry subject has unexpected Proof bootstrap dirt');
  }
  for (const relativePath of ['.gitignore', 'proof.yaml', 'proof/checklists/onboard_v1.state.yaml']) {
    const stat = fs.lstatSync(path.join(currentSubject, relativePath));
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`checklist prefix retry expected regular Proof bootstrap file: ${relativePath}`);
    }
  }
  for (const relativePath of ['proof', 'proof/checklists']) {
    const stat = fs.lstatSync(path.join(currentSubject, relativePath));
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`checklist prefix retry expected regular Proof bootstrap directory: ${relativePath}`);
    }
  }
  const headIgnore = gitSnapshotAtCommit(currentSubject, head, '.gitignore');
  if (!headIgnore || headIgnore.kind !== 'file') {
    throw new Error('checklist prefix retry subject baseline is missing a regular .gitignore');
  }
  const currentIgnore = fs.readFileSync(path.join(currentSubject, '.gitignore'));
  const expectedIgnore = Buffer.concat([headIgnore.bytes, Buffer.from(PROOF_INIT_GITIGNORE_BLOCK, 'utf8')]);
  if (!currentIgnore.equals(expectedIgnore)) {
    throw new Error('checklist prefix retry .gitignore does not contain the exact Proof init local-state block');
  }

  const validated = ExecutionJournal.validateGraphCheckpointIntegrity(checkpoint);
  const journal = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), validated);
  const projection = journal.getClaimProjection() as any;
  const activeId = projection.activeClaimIdsByRef?.[CHECKLIST_SNAPSHOT_CLAIM];
  const activeClaims = Object.values(projection.claims || {}).filter((claim: any) =>
    claim && claim.claimId === activeId && claim.claim === CHECKLIST_SNAPSHOT_CLAIM &&
    Array.isArray(claim.scope) && claim.scope.length === 0 && claim.producerCheckId === 'checklist-bootstrap',
  ) as any[];
  if (typeof activeId !== 'string' || activeClaims.length !== 1 || activeClaims[0].claimId !== activeId ||
      !activeClaims[0].payload || activeClaims[0].payloadFingerprint !== sha256Canonical(activeClaims[0].payload)) {
    throw new Error('checklist prefix retry checkpoint lacks exactly one active root bootstrap checklist claim');
  }
  const shown = parseJson(
    runProof(proof, currentSubject, output, 'checklist-prefix-retry-subject-guard',
      ['checklist', 'show', 'onboard_v1', '--format', 'json'], timeout),
    'Proof checklist bootstrap retry readback',
  );
  if (!deepJsonEqual(shown, activeClaims[0].payload)) {
    throw new Error('Proof checklist bootstrap readback does not match the retained root claim');
  }
  return head;
}

/** Reopen one retained failed inspect through the public engine retry API. */
export async function executeChecklistPrefixRetryEngine(
  engine: StateMachineExecutionEngine,
  config: VisorConfig,
  checkpoint: GraphJournalCheckpointV1,
  retryGenerationId: string,
  timeout: number,
  onRetryCheckpoint: (checkpoint: GraphJournalCheckpointV1) => void | Promise<void>,
  options: {
    onFrontier?: (frontier: RetainedContinuationFrontier) => void | Promise<void>;
    onSkeletonFrontier?: (frontier: RetainedContinuationFrontier) => void | Promise<void>;
  } = {},
): Promise<Awaited<ReturnType<StateMachineExecutionEngine['retryGraphCheckpoint']>> & {
  frontier: RetainedContinuationFrontier;
  skeletonFrontier: RetainedContinuationFrontier;
}> {
  if (!Number.isSafeInteger(timeout) || timeout < 1000) throw new Error('checklist prefix retry timeout is invalid');
  validateChecklistPrefixRetrySelection(config, checkpoint, retryGenerationId);
  const retried = await engine.retryGraphCheckpoint({
    checkpoint,
    config,
    prInfo: PR,
    retryGenerationIds: [retryGenerationId],
    externalSideEffects: 'absent',
    onRetryCheckpoint,
    // Keep component generations deferred until the same baseline/frontier
    // continuation used by the initial checklist run.
    generatedDispatchGate: retainedProjectPrefixDispatchGate,
    maxParallelism: config.max_parallelism,
    failFast: false,
  });
  if (retried.retryCheckpoint.events.length <= checkpoint.events.length ||
      retried.retryCheckpoint.events.slice(0, checkpoint.events.length).some((event, index) =>
        canonicalJson(event) !== canonicalJson(checkpoint.events[index]))) {
    throw new Error('checklist prefix retry changed the retained event prefix');
  }
  const retryEvents = retried.checkpoint.events.slice(checkpoint.events.length);
  if (retryEvents.some(event =>
    event.type === 'AttemptStarted' &&
    (event.checkId === 'checklist-bootstrap' || event.checkId === 'project' || event.checkId === 'structural_inventory'))) {
    throw new Error('checklist prefix retry repeated bootstrap, project, or structural_inventory');
  }
  const materialized = materializedComponentIds(config, retried.checkpoint);
  const componentAttemptsStarted = retried.checkpoint.events.filter(event =>
    event.type === 'AttemptStarted' && Array.isArray(event.scope) && event.scope.length > 1,
  ).length;
  if (componentAttemptsStarted !== 0) {
    throw new Error('checklist prefix retry released a component before the durable frontier boundary');
  }
  const frontier = Object.freeze({
    checkpoint: retried.checkpoint,
    materializedComponentIds: materialized,
    expectedComponentIds: Object.freeze([...materialized]),
    componentAttemptsStarted,
    zeroComponentAttempts: true,
    setsEqual: true,
  });
  if (options.onFrontier) await options.onFrontier(frontier);
  const baselineCommit = checklistBaselineCommitFromCheckpoint(config, retried.checkpoint);
  const previousBaselineCommit = process.env.NATIVE_ONBOARDING_BASELINE_COMMIT;
  let resumed: Awaited<ReturnType<StateMachineExecutionEngine['resumeGraphCheckpoint']>>;
  try {
    process.env.NATIVE_ONBOARDING_BASELINE_COMMIT = baselineCommit;
    resumed = await engine.resumeGraphCheckpoint({
      checkpoint: retried.checkpoint,
      config,
      prInfo: PR,
      maxParallelism: config.max_parallelism,
      failFast: false,
      generatedDispatchGate: checklistSkeletonPauseGate,
    });
  } finally {
    if (previousBaselineCommit === undefined) delete process.env.NATIVE_ONBOARDING_BASELINE_COMMIT;
    else process.env.NATIVE_ONBOARDING_BASELINE_COMMIT = previousBaselineCommit;
  }
  const assessment = assessChecklistSkeletonFrontier(config, resumed.checkpoint, materialized);
  if (!assessment.ready) {
    throw new Error(`checklist prefix retry did not reach a validated skeleton frontier: ${assessment.reason || 'frontier predicate failed'}`);
  }
  const skeletonFrontier = Object.freeze({
    ...frontier,
    checkpoint: resumed.checkpoint,
    materializedComponentIds: assessment.expectedComponentIds,
    expectedComponentIds: assessment.expectedComponentIds,
    componentAttemptsStarted: assessment.componentAttemptsStarted,
    zeroComponentAttempts: assessment.componentAttemptsStarted === 0,
    setsEqual: assessment.promotedComponentIds.join('\u0000') === assessment.expectedComponentIds.join('\u0000'),
  });
  if (options.onSkeletonFrontier) await options.onSkeletonFrontier(skeletonFrontier);
  return Object.freeze({...resumed, retryCheckpoint: retried.retryCheckpoint, frontier, skeletonFrontier});
}

async function runChecklistPrefixRetry(
  roots: ReturnType<typeof assertRecoveryRoots>,
  proof: string,
  timeout: number,
  requestTimeout: number,
  retry: ChecklistPrefixRetryArguments,
  governedCodexTransport: string,
  governedCodexBin: string,
  governedCodexSha256: string,
  onPromptCaptured: (info: PublicPromptCaptureInfo) => void,
): Promise<void> {
  const checkpointBytes = fs.readFileSync(roots.checkpoint, 'utf8');
  const parsedCheckpoint = JSON.parse(checkpointBytes) as GraphJournalCheckpointV1;
  const retryDirectory = path.join(roots.output, 'checklist-prefix-retry');
  fs.mkdirSync(retryDirectory, {recursive: true, mode: 0o700});
  fs.chmodSync(retryDirectory, 0o700);
  // Retain the operator-supplied bytes before any strict config or selection
  // validation can fail, so a failed retry never hides its input authority.
  writeText(path.join(retryDirectory, 'prior-checkpoint.json'), checkpointBytes);
  const registry = CheckProviderRegistry.getInstance();
  registry.bootstrapProofAdmission(createProofAdmissionCapability(proof));
  const {prepared} = onboardingConfigTemplate(CHECKLIST_CONFIG_PATH);
  const config = await loadConfig(prepared as unknown as VisorConfig, {strict: true});
  const selection = validateChecklistPrefixRetrySelection(config, parsedCheckpoint, retry.retryGenerationId);
  const subjectRevision = assertChecklistBootstrapRetrySubject({
    proof,
    subject: roots.subject,
    protectedOriginal: roots.original,
    priorOutput: roots.priorOutput,
    output: roots.output,
    config,
    checkpoint: selection.journal.exportGraphCheckpoint(parsedCheckpoint.sessionId),
    governedCodexTransport,
    timeout,
  });
  let latestRetryCheckpoint = selection.journal.exportGraphCheckpoint(parsedCheckpoint.sessionId);
  const configPlan = compileClaimPlan(config);
  const materialized = persistChecklistMaterializedConfig(roots.output, config);
  writeCheckpoint(path.join(retryDirectory, 'validated-prefix-checkpoint.json'), latestRetryCheckpoint);
  const persistRetryProgress = (
    options: ChecklistProgressRefreshOptions = {},
    liveInstanceProjection?: unknown,
  ): void => {
    for (const progressOutput of [roots.output, retryDirectory]) {
      try {
        writeRestoredChecklistProgress(
          progressOutput,
          config,
          latestRetryCheckpoint,
          options,
          liveInstanceProjection,
        );
      } catch {
        // Progress is observational; retained checkpoints and public command
        // evidence remain authoritative when a partial projection is not yet
        // renderable.
      }
    }
  };
  persistRetryProgress();
  writeJson(path.join(roots.output, 'preflight.json'), {
    status: 'launch-ready-checklist-prefix-retry',
    mode: 'checklist-prefix-retry',
    subject_root: roots.subject,
    protected_original_root: roots.original,
    prior_output: roots.priorOutput,
    subject_revision: subjectRevision,
    source_revision: subjectRevision,
    checkpoint: roots.checkpoint,
    checkpoint_event_count: selection.prefixEventCount,
    retry_generation_id: retry.retryGenerationId,
    retry_check_id: selection.generation.checkId,
    external_side_effects: 'absent',
    graph_semantic_digest: configPlan.expansionPlan.graphSemanticDigest,
    materialized_config: path.relative(roots.output, materialized.path),
    materialized_config_sha256: materialized.digest,
    proof_binary: proof,
    request_timeout_ms: requestTimeout,
    outer_timeout_ms: timeout,
    governed_codex_transport: governedCodexTransport,
    codex_bin: governedCodexBin,
    codex_sha256: governedCodexSha256,
    codex_home_absent: true,
    codex_home_config_present: false,
    codex_user_config_ignored: true,
    codex_rules_ignored: true,
    no_bootstrap_project_or_structural_inventory_repeat: true,
    note: 'Restores the retained checklist project prefix and retries only its failed inspect generation; bootstrap, project, and structural_inventory are not rerun.',
  });

  const engine = new StateMachineExecutionEngine(roots.subject);
  const refreshRetryProgress = (options: ChecklistProgressRefreshOptions = {}): void => {
    let liveInstanceProjection: unknown;
    try {
      liveInstanceProjection = engine.getInstanceProjection();
      latestRetryCheckpoint = engine.exportGraphCheckpoint();
    } catch {
      // A provider prompt may be observed while the current generated
      // attempt is in flight and therefore not exportable. Keep the last
      // durable checkpoint and pair it with the live operational projection.
      try { liveInstanceProjection = engine.getInstanceProjection(); } catch { /* observational */ }
    }
    persistRetryProgress(options, liveInstanceProjection);
  };
  const retryPromptHook = (info: PublicPromptCaptureInfo): void => {
    onPromptCaptured(info);
    refreshRetryProgress();
  };
  engine.setExecutionContext({
    governedCodexTransport: governedCodexTransport as 'exec-jsonl-default-auth-v1',
    codexBin: governedCodexBin,
    codexSha256: governedCodexSha256,
    hooks: {
      onPromptCaptured: retryPromptHook,
      onCheckComplete: () => refreshRetryProgress(),
    },
  });
  let retried: Awaited<ReturnType<typeof executeChecklistPrefixRetryEngine>>;
  try {
    retried = await executeChecklistPrefixRetryEngine(
      engine,
      config,
      selection.journal.exportGraphCheckpoint(parsedCheckpoint.sessionId),
      retry.retryGenerationId,
      timeout,
      retryCheckpoint => {
        latestRetryCheckpoint = retryCheckpoint;
        writeCheckpoint(path.join(retryDirectory, 'on-retry-checkpoint.json'), retryCheckpoint);
        writeJson(path.join(retryDirectory, 'on-retry-checkpoint-manifest.json'), {
          version: 1,
          mode: 'checklist-prefix-retry',
          prior_event_count: selection.prefixEventCount,
          retry_event_count: retryCheckpoint.events.length,
          retry_generation_id: retry.retryGenerationId,
          graph_semantic_digest: retryCheckpoint.graphSemanticDigest,
          materialized_config: path.relative(roots.output, materialized.path),
          materialized_config_sha256: materialized.digest,
          persisted_before_dispatch: true,
        });
        persistRetryProgress();
      },
      {
        onFrontier: frontier => {
          latestRetryCheckpoint = frontier.checkpoint;
          writeCheckpoint(path.join(roots.output, 'checklist-prefix-frontier-checkpoint.json'), frontier.checkpoint);
          writeJson(path.join(roots.output, 'preflight', 'checklist-prefix-frontier.json'), {
            status: 'checklist-project-prefix-complete-after-retry',
            checkpoint: 'checklist-prefix-frontier-checkpoint.json',
            materialized_component_ids: frontier.materializedComponentIds,
            component_attempts_started: frontier.componentAttemptsStarted,
            zero_component_attempts: frontier.zeroComponentAttempts,
            materialized_config: 'checklist-materialized-config.json',
            materialized_config_sha256: materialized.digest,
            graph_semantic_digest: configPlan.expansionPlan.graphSemanticDigest,
            retry_generation_id: retry.retryGenerationId,
          });
          persistRetryProgress();
        },
        onSkeletonFrontier: frontier => {
          latestRetryCheckpoint = frontier.checkpoint;
          writeCheckpoint(path.join(roots.output, 'checklist-skeleton-frontier-checkpoint.json'), frontier.checkpoint);
          writeJson(path.join(roots.output, 'preflight', 'checklist-skeleton-frontier.json'), {
            status: 'checklist-skeleton-ready-paused',
            checkpoint: 'checklist-skeleton-frontier-checkpoint.json',
            materialized_component_ids: frontier.materializedComponentIds,
            component_attempts_started: frontier.componentAttemptsStarted,
            zero_component_attempts: frontier.zeroComponentAttempts,
            sets_equal: frontier.setsEqual,
            materialized_config: 'checklist-materialized-config.json',
            materialized_config_sha256: materialized.digest,
            resume_command: '--checklist-skeleton-resume checklist-skeleton-frontier-checkpoint.json',
          });
          persistRetryProgress({paused: true});
        },
      },
    );
  } catch (error) {
    try {
      latestRetryCheckpoint = engine.exportGraphCheckpoint();
      writeCheckpoint(path.join(roots.output, 'checkpoint.partial.json'), latestRetryCheckpoint);
    } catch {
      // Preserve the original retry error even if the provider failed before a
      // quiescent checkpoint could be exported.
    }
    persistRetryProgress();
    throw error;
  }
  writeCheckpoint(path.join(roots.output, 'checkpoint.json'), retried.checkpoint);
  writeJson(path.join(roots.output, 'visor-result.json'), retried.result);
  latestRetryCheckpoint = retried.checkpoint;
  persistRetryProgress({paused: true});
  writeJson(path.join(roots.output, 'summary.json'), {
    status: 'checklist-skeleton-ready-paused',
    mode: 'checklist-prefix-retry',
    prior_checkpoint: {
      path: roots.checkpoint,
      event_count: selection.prefixEventCount,
      immutable_prefix_preserved: retried.retryCheckpoint.events.slice(0, selection.prefixEventCount)
        .every((event, index) => canonicalJson(event) === canonicalJson(parsedCheckpoint.events[index])),
    },
    retry_generation_id: retry.retryGenerationId,
    materialized_component_ids: retried.skeletonFrontier.materializedComponentIds,
    component_attempts_started: retried.skeletonFrontier.componentAttemptsStarted,
    skeleton_frontier_ready: retried.skeletonFrontier.setsEqual,
    retry_prefix_checkpoint: path.relative(roots.output, path.join(retryDirectory, 'on-retry-checkpoint.json')),
    resumed_checkpoint: 'checkpoint.json',
    external_side_effects: 'absent',
    no_bootstrap_project_or_structural_inventory_repeat: true,
    output: roots.output,
  });
  console.log(JSON.stringify({status: 'checklist-skeleton-ready-paused', output: roots.output}, null, 2));
}

/**
 * Run the checklist profile through the same engine checkpoint boundary used
 * by retained continuation.  The first pass is allowed to finish only the
 * project lane; generated component generations are left ready, never
 * attempted, until the checkpoint has been inspected and the journaled
 * baseline claim has supplied the existing writer environment variable.
 */
export async function executeChecklistOnboardingEngine(
  engine: StateMachineExecutionEngine,
  config: VisorConfig,
  timeout: number,
  onFrontier?: (frontier: RetainedContinuationFrontier) => void | Promise<void>,
  options: {
    pauseBeforeSkeleton?: boolean;
    /** Persist the project-prefix result before any baseline/frontier assertion can throw. */
    onProjectPrefix?: (evidence: {
      initialResult: Awaited<ReturnType<StateMachineExecutionEngine['executeGroupedChecks']>>;
      checkpoint: GraphJournalCheckpointV1;
    }) => void | Promise<void>;
    onSkeletonFrontier?: (frontier: RetainedContinuationFrontier) => void | Promise<void>;
  } = {},
): Promise<RetainedContinuationEngineRun> {
  const initialResult = await engine.executeGroupedChecks(
    PR, ['project'], timeout, config, 'json', false, config.max_parallelism, false,
    undefined, retainedProjectPrefixDispatchGate,
  );
  const checkpoint = engine.exportGraphCheckpoint();
  if (options.onProjectPrefix) {
    await options.onProjectPrefix({initialResult, checkpoint});
  }
  if (initialResult.statistics.failedExecutions > 0) {
    throw new Error(`checklist project prefix failed before component release (${initialResult.statistics.failedExecutions} failed executions)`);
  }
  const baselineCommit = checklistBaselineCommitFromCheckpoint(config, checkpoint);
  const materialized = materializedComponentIds(config, checkpoint);
  const componentAttemptsStarted = (checkpoint.events as readonly Json[]).filter(event =>
    event.type === 'AttemptStarted' && Array.isArray(event.scope) && event.scope.length > 1,
  ).length;
  if (componentAttemptsStarted !== 0) throw new Error('checklist project prefix started a component before the release boundary');
  const frontier = Object.freeze({
    checkpoint,
    materializedComponentIds: materialized,
    expectedComponentIds: Object.freeze(materialized),
    componentAttemptsStarted,
    zeroComponentAttempts: true,
    setsEqual: true,
  });
  if (onFrontier) await onFrontier(frontier);
  const previousBaselineCommit = process.env.NATIVE_ONBOARDING_BASELINE_COMMIT;
  let resumed: Awaited<ReturnType<StateMachineExecutionEngine['resumeGraphCheckpoint']>>;
  try {
    process.env.NATIVE_ONBOARDING_BASELINE_COMMIT = baselineCommit;
    const componentPhase = await engine.resumeGraphCheckpoint({
      checkpoint,
      config,
      prInfo: PR,
      maxParallelism: config.max_parallelism,
      failFast: false,
      ...(options.pauseBeforeSkeleton ? {generatedDispatchGate: checklistSkeletonPauseGate} : {}),
    });
    if (options.pauseBeforeSkeleton) {
      const assessment = assessChecklistSkeletonFrontier(config, componentPhase.checkpoint);
      if (!assessment.ready) {
        throw new Error(`checklist skeleton frontier is not ready: ${assessment.reason || 'frontier predicate failed'}`);
      }
      const skeletonFrontier = Object.freeze({
        ...frontier,
        checkpoint: componentPhase.checkpoint,
        materializedComponentIds: assessment.expectedComponentIds,
        expectedComponentIds: assessment.expectedComponentIds,
        componentAttemptsStarted: assessment.componentAttemptsStarted,
        zeroComponentAttempts: assessment.componentAttemptsStarted === 0,
        setsEqual: assessment.promotedComponentIds.join('\u0000') === assessment.expectedComponentIds.join('\u0000'),
      });
      if (options.onSkeletonFrontier) await options.onSkeletonFrontier(skeletonFrontier);
      resumed = componentPhase;
    } else {
      resumed = componentPhase;
    }
  } finally {
    if (previousBaselineCommit === undefined) delete process.env.NATIVE_ONBOARDING_BASELINE_COMMIT;
    else process.env.NATIVE_ONBOARDING_BASELINE_COMMIT = previousBaselineCommit;
  }
  return Object.freeze({
    initialResult,
    frontier,
    result: resumed.result,
    checkpoint: resumed.checkpoint,
  });
}

/** Resume a persisted checklist frontier after the user-visible skeleton pause. */
export async function resumeChecklistSkeleton(
  engine: StateMachineExecutionEngine,
  config: VisorConfig,
  checkpoint: GraphJournalCheckpointV1,
  timeout: number,
): Promise<Awaited<ReturnType<StateMachineExecutionEngine['resumeGraphCheckpoint']>>> {
  if (!Number.isSafeInteger(timeout) || timeout < 1000) throw new Error('checklist skeleton resume timeout is invalid');
  const baselineCommit = checklistBaselineCommitFromCheckpoint(config, checkpoint);
  const expectedComponentIds = materializedComponentIds(config, checkpoint);
  const assessment = assessChecklistSkeletonFrontier(config, checkpoint, expectedComponentIds);
  if (!assessment.ready) {
    throw new Error(`checklist skeleton resume requires a validated promoted frontier: ${assessment.reason || 'frontier predicate failed'}`);
  }
  const previousBaselineCommit = process.env.NATIVE_ONBOARDING_BASELINE_COMMIT;
  try {
    process.env.NATIVE_ONBOARDING_BASELINE_COMMIT = baselineCommit;
    const resumed = await engine.resumeGraphCheckpoint({
      checkpoint,
      config,
      prInfo: PR,
      maxParallelism: config.max_parallelism,
      failFast: false,
    });
    if (!checklistSkeletonResumeDeltaIsValid(config, checkpoint, resumed.checkpoint, expectedComponentIds)) {
      throw new Error('checklist skeleton resume did not execute exactly the validated skeleton frontier');
    }
    return resumed;
  } finally {
    if (previousBaselineCommit === undefined) delete process.env.NATIVE_ONBOARDING_BASELINE_COMMIT;
    else process.env.NATIVE_ONBOARDING_BASELINE_COMMIT = previousBaselineCommit;
  }
}

function continuationPromotionComponentIds(config: VisorConfig, checkpoint: GraphJournalCheckpointV1): readonly string[] {
  const projection = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), checkpoint).getInstanceProjection();
  const active = new Set(Object.values(projection.activeGenerationIdByNode));
  const ids = Object.values(projection.generationsById)
    .filter(generation => generation.status !== 'inactive' && active.has(generation.nodeGenerationId) &&
      generation.checkId === 'promote-native-component' && generation.status === 'completed')
    .flatMap(generation => {
      const last = generation.scope[generation.scope.length - 1];
      return last && last.kind === 'keyed' && typeof last.key === 'string' ? [last.key] : [];
    });
  return Object.freeze(utf8Sorted([...new Set(ids)]));
}

function checklistContinuationPauseIsValid(
  config: VisorConfig,
  checkpoint: GraphJournalCheckpointV1,
  expectedComponentIds: readonly string[],
): boolean {
  try {
    const projection = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), checkpoint).getInstanceProjection();
    const active = new Set(Object.values(projection.activeGenerationIdByNode));
    const generations = Object.values(projection.generationsById).filter(generation =>
      generation.status !== 'inactive' && active.has(generation.nodeGenerationId));
    const traces = generations.filter(generation => generation.checkId === 'checklist-traces-light');
    return traces.length === 1 && traces[0].status === 'ready' &&
      !generations.some(generation => generation.status === 'failed' || generation.status === 'running') &&
      continuationPromotionComponentIds(config, checkpoint).join('\u0000') === utf8Sorted(expectedComponentIds).join('\u0000');
  } catch {
    return false;
  }
}

export function checklistContinuationResumeDeltaIsValid(
  config: VisorConfig,
  before: GraphJournalCheckpointV1,
  after: GraphJournalCheckpointV1,
): boolean {
  try {
    const validatedBefore = ExecutionJournal.validateGraphCheckpointIntegrity(before);
    const validatedAfter = ExecutionJournal.validateGraphCheckpointIntegrity(after);
    if (validatedAfter.sessionId !== validatedBefore.sessionId ||
        validatedAfter.graphSemanticDigest !== validatedBefore.graphSemanticDigest ||
        validatedAfter.events.length <= validatedBefore.events.length ||
        canonicalGraphCheckpointJson(validatedAfter.events.slice(0, validatedBefore.events.length)) !==
          canonicalGraphCheckpointJson(validatedBefore.events)) return false;
    const suffix = validatedAfter.events.slice(validatedBefore.events.length);
    const started = suffix.filter(event => event.type === 'AttemptStarted');
    return started.length === 1 && started[0].checkId === 'checklist-traces-light' &&
      !suffix.some(event => event.type === 'AttemptStarted' &&
        (event.checkId === 'author-native-component' || event.checkId === 'promote-native-component')) &&
      checklistContinuationResumeCompleted(config, validatedAfter);
  } catch {
    return false;
  }
}

/** Accept an already-completed frontier as an idempotent readback. */
export function checklistContinuationReadbackIsValid(
  config: VisorConfig,
  before: GraphJournalCheckpointV1,
  after: GraphJournalCheckpointV1,
): boolean {
  try {
    const validatedBefore = ExecutionJournal.validateGraphCheckpointIntegrity(before);
    const validatedAfter = ExecutionJournal.validateGraphCheckpointIntegrity(after);
    return validatedBefore.sessionId === validatedAfter.sessionId &&
      validatedBefore.graphSemanticDigest === validatedAfter.graphSemanticDigest &&
      canonicalGraphCheckpointJson(validatedBefore) === canonicalGraphCheckpointJson(validatedAfter) &&
      checklistContinuationResumeCompleted(config, validatedAfter);
  } catch {
    return false;
  }
}

function checklistContinuationResumeCompleted(config: VisorConfig, checkpoint: GraphJournalCheckpointV1): boolean {
  try {
    const projection = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), checkpoint).getInstanceProjection();
    const active = new Set(Object.values(projection.activeGenerationIdByNode));
    const traces = Object.values(projection.generationsById).filter(generation =>
      generation.status !== 'inactive' && active.has(generation.nodeGenerationId) && generation.checkId === 'checklist-traces-light');
    return traces.length === 1 && traces[0].status === 'completed' &&
      !Object.values(projection.generationsById).some(generation =>
        generation.status !== 'inactive' && active.has(generation.nodeGenerationId) &&
        (generation.status === 'failed' || generation.status === 'running'));
  } catch {
    return false;
  }
}

/** Execute the fresh continuation graph, pausing before traces-light, or
 * resume that graph with confirmation/readback only. */
export async function executeChecklistContinuationEngine(
  engine: StateMachineExecutionEngine,
  config: VisorConfig,
  timeout: number,
  expectedComponentIds: readonly string[],
  checkpoint?: GraphJournalCheckpointV1,
): Promise<{result: unknown; checkpoint: GraphJournalCheckpointV1; paused: boolean}> {
  if (checkpoint) {
    if (checklistContinuationResumeCompleted(config, checkpoint)) {
      return {
        result: {statistics: {failedExecutions: 0, completedExecutions: 0, totalExecutions: 0}},
        checkpoint,
        paused: false,
      };
    }
    try {
      const validated = ExecutionJournal.validateGraphCheckpointIntegrity(checkpoint);
      if (!checklistContinuationPauseIsValid(config, validated, expectedComponentIds)) {
        throw new Error('checklist continuation resume requires a clean traces-light frontier');
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'checklist continuation resume requires a clean traces-light frontier') throw error;
      throw new Error(`checklist continuation resume checkpoint is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    const resumed = await engine.resumeGraphCheckpoint({
      checkpoint,
      config,
      prInfo: PR,
      maxParallelism: config.max_parallelism,
      failFast: false,
    });
    if (!checklistContinuationResumeDeltaIsValid(config, checkpoint, resumed.checkpoint)) {
      throw new Error('checklist continuation resume dispatched work other than traces-light confirmation');
    }
    return {result: resumed.result, checkpoint: resumed.checkpoint, paused: false};
  }
  const first = await engine.executeGroupedChecks(
    PR, ['continue-retained-catalog'], timeout, config, 'json', false, config.max_parallelism, false,
    undefined, checklistContinuationPauseGate,
  );
  const current = engine.exportGraphCheckpoint();
  if (first.statistics.failedExecutions > 0) throw new Error('checklist continuation failed before traces-light frontier');
  if (!checklistContinuationPauseIsValid(config, current, expectedComponentIds)) {
    throw new Error('checklist continuation did not reach a clean traces-light frontier');
  }
  return {result: first, checkpoint: current, paused: true};
}

function onboardingConfigTemplate(configPath = CONFIG_PATH): {prepared: Json; inspectCheck: Json} {
  const raw = yaml.load(fs.readFileSync(configPath, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('onboarding YAML must be an object');
  const prepared = encodeResultSchemas(raw) as Json;
  const discoverName = configPath === CHECKLIST_CONFIG_PATH ? 'discover-project-checklist' : 'discover-project';
  const inspect = ((prepared.subgraphs as Json)[discoverName] as Json).checks as Json;
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

type CurrentRetainedCatalogValidation = Readonly<{
  inventory: Json;
  revalidation: Json;
  workItems: readonly Json[];
}>;

/**
 * Re-run the retained Proof catalog through the current subject authority.
 * The candidate and admission are read only from the validated retained
 * prefix; every output used by the continuation graph comes from this fresh
 * inventory -> revalidate -> work-items command chain.
 */
export async function validateCurrentRetainedCatalog(
  proof: string,
  subject: string,
  output: string,
  timeout: number,
  retainedConfig: VisorConfig,
  retainedCheckpoint: GraphJournalCheckpointV1,
): Promise<CurrentRetainedCatalogValidation> {
  const inventoryResult = runProof(proof, subject, output, 'preflight', ['onboarding', 'inventory'], timeout);
  if (inventoryResult.status !== 0 || inventoryResult.stderr !== '') {
    throw new Error(`current Proof onboarding inventory failed with exit ${inventoryResult.status}`);
  }
  const inventory = parseJson(inventoryResult, 'current Proof onboarding inventory') as Json;
  const authority = assertAuthenticatedInventory(inventory, 'current Proof onboarding inventory');
  const projectId = typeof authority.project_id === 'string' ? authority.project_id : undefined;
  if (!projectId) throw new Error('current Proof onboarding inventory authority has no project ID');
  validateStructuralInventory(inventory, projectId);

  const {candidate, admission} = retainedProofCandidateAdmission(retainedConfig, retainedCheckpoint);
  const admitted = validateProofCandidateAdmissionBinding(candidate, admission);
  const admissionObject = JSON.parse(admitted.wire) as Json;
  const revalidationInput = governedCanonicalJson({
    version: 'proof.catalog-revalidation-request/v2',
    candidate: candidate.payload,
    admission: admissionObject,
  }, 'proof');
  const revalidationResult = runProof(
    proof,
    subject,
    output,
    'preflight',
    ['onboarding', 'revalidate'],
    timeout,
    revalidationInput,
  );
  if (revalidationResult.status !== 0 || revalidationResult.stderr !== '') {
    throw new Error(`current Proof onboarding revalidate failed with exit ${revalidationResult.status}`);
  }
  const revalidation = parseJson(revalidationResult, 'current Proof onboarding revalidate') as Json;
  validateProofCatalogRevalidationProjection(
    revalidation,
    inventory,
    candidate,
    admission,
    projectId,
  );
  const receipt = revalidation.receipt;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('current Proof revalidation did not return a receipt');
  }
  // Keep the exact Go struct field order used by the sealed provider.  The
  // nested values use the same Proof CanonicalJSON encoder as that provider.
  const workItemsInput = `{"version":${goCompatibleProofJson('proof.onboarding-work-items-request/v1')},"candidate":${governedCanonicalJson(candidate.payload, 'proof')},"admission":${admitted.wire},"revalidation_receipt":${governedCanonicalJson(receipt, 'proof')}}`;
  const workItemsResult = runProof(
    proof,
    subject,
    output,
    'preflight',
    ['onboarding', 'work-items'],
    timeout,
    workItemsInput,
  );
  if (workItemsResult.status !== 0 || workItemsResult.stderr !== '') {
    throw new Error(`current Proof onboarding work-items failed with exit ${workItemsResult.status}`);
  }
  const workItemsProjection = parseJson(workItemsResult, 'current Proof onboarding work-items') as Json;
  const validated = validateProofWorkItemsProjection(
    workItemsProjection,
    revalidation,
    inventory,
    candidate,
    admission,
    projectId,
  );
  if (!Array.isArray(validated.work_items) || validated.work_items.length === 0) {
    throw new Error('current Proof onboarding work-items returned no WorkItems');
  }
  const workItems = validated.work_items.filter((item): item is Json =>
    !!item && typeof item === 'object' && !Array.isArray(item),
  );
  if (workItems.length !== validated.work_items.length) throw new Error('current Proof WorkItems are not objects');
  // Proof's native WorkItem wire intentionally excludes the Git checkout
  // baseline.  The continuation graph needs the exact current subject point
  // for its isolated checkout; bind that one operational field to the
  // already-validated clean subject revision without changing Proof-owned
  // WorkItem content or hashes.
  const currentBaselineCommit = gitScalar(subject, ['rev-parse', 'HEAD^{commit}'], 'current Proof subject');
  const materializedWorkItems: Array<Json & {component_id: string}> = workItems.map((item, index): Json & {component_id: string} => {
    if (typeof item.component_id !== 'string' || item.component_id.length === 0) {
      throw new Error(`current Proof WorkItem ${index} has no component ID`);
    }
    return {
      ...item,
      component_id: item.component_id,
      baseline_commit: typeof item.baseline_commit === 'string' ? item.baseline_commit : currentBaselineCommit,
    };
  });
  writeJson(path.join(output, 'preflight', 'current-catalog-validation.json'), {
    status: 'current-proof-catalog-validated',
    authority,
    boundary_fingerprint: inventory.boundary_fingerprint,
    work_item_ids: materializedWorkItems.map(item => item.component_id),
    work_item_count: materializedWorkItems.length,
    commands: {
      inventory: 'commands/preflight/onboarding-inventory',
      revalidate: 'commands/preflight/onboarding-revalidate',
      work_items: 'commands/preflight/onboarding-work-items',
    },
  });
  return Object.freeze({inventory, revalidation, workItems: Object.freeze(materializedWorkItems)});
}

export async function deriveCurrentChecklistAffectedBatches(
  proof: string,
  subject: string,
  output: string,
  timeout: number,
  workItems: readonly Json[],
): Promise<ChecklistAffectedBatches> {
  const result = runProof(
    proof,
    subject,
    output,
    'preflight',
    ['audit', '--no-cache', '--check', 'orphan_code_clean', '--format', 'json'],
    timeout,
  );
  // Proof's JSON audit mode reserves stdout for JSONL receipts but emits
  // human-readable progress (including the trace-index heartbeat) on stderr.
  // Keep runProof's stdout/stderr/meta receipt files intact and accept the
  // native warning exit used when orphan paths are found.  The requested
  // check, stage, and status are still authenticated below.
  if (result.status !== 0 && result.status !== 2) {
    throw new Error(`current Proof orphan_code_clean failed with exit ${result.status}`);
  }
  const events: Json[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch {
      throw new Error('current Proof orphan_code_clean emitted malformed JSONL');
    }
    if (!isRecord(value)) throw new Error('current Proof orphan_code_clean emitted a non-object JSONL record');
    events.push(value);
  }
  const done = events.filter(event => event.event === 'check_done');
  if (done.length !== 1 || done[0].check !== 'orphan_code_clean' || done[0].stage !== 'implement' ||
      (result.status === 0 && done[0].status !== 'pass') ||
      (result.status === 2 && done[0].status !== 'warn') ||
      (result.status === 0 && done[0].details !== undefined &&
        (!Array.isArray(done[0].details) || done[0].details.some(value => typeof value !== 'string'))) ||
      (result.status === 2 && (!Array.isArray(done[0].details) || done[0].details.some(value => typeof value !== 'string')))) {
    throw new Error('current Proof orphan_code_clean did not return exactly one matching implement check_done receipt');
  }
  const details = (done[0].details === undefined ? [] : done[0].details) as string[];
  const orphanPaths = [...new Set(details.map(detail => {
    const match = /^([^:]+):[0-9]+(?:\s|$)/.exec(detail);
    if (!match) throw new Error(`orphan_code_clean detail has no exact source path: ${detail}`);
    return match[1];
  }))];
  const batches = deriveChecklistAffectedBatches(workItems, orphanPaths);
  const orphanDetailsByComponent: Record<string, string[]> = {};
  for (const detail of details) {
    const match = /^([^:]+):[0-9]+(?:\s|$)/.exec(detail);
    if (!match) throw new Error(`orphan_code_clean detail has no exact source path: ${detail}`);
    const owner = batches.batches.find(batch => batch.paths.includes(match[1]))?.component_id;
    if (!owner) throw new Error(`orphan_code_clean detail path has no unique WorkItem owner: ${match[1]}`);
    (orphanDetailsByComponent[owner] ??= []).push(detail);
  }
  const frozenDetails = Object.freeze(Object.fromEntries(
    Object.entries(orphanDetailsByComponent).map(([componentId, componentDetails]) => [componentId, Object.freeze(componentDetails.slice())]),
  ));
  const enrichedBatches = {...batches};
  Object.defineProperty(enrichedBatches, 'orphanDetailsByComponent', {
    value: frozenDetails,
    enumerable: false,
  });
  writeJson(path.join(output, 'preflight', 'current-affected-batches.json'), {
    status: 'current-proof-orphan-ownership-derived',
    orphan_paths: orphanPaths,
    affected_component_ids: batches.affectedComponentIds,
    reused_component_ids: batches.reusedComponentIds,
    batches: batches.batches,
    orphan_details_by_component: frozenDetails,
  });
  return Object.freeze(enrichedBatches);
}

function activeChecklistNameFromCheckpoint(
  config: VisorConfig,
  checkpoint: GraphJournalCheckpointV1,
): string {
  const journal = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), checkpoint);
  // This is the same root/expanded active-snapshot selector used by the
  // canonical CLI/HTML progress projection.  It validates claim identity,
  // producer, scope, payload fingerprint, and stage lineage before exposing
  // the trusted checklist name.
  const progress = buildNativeChecklistProgressFromProjections({
    claimProjection: journal.getClaimProjection(),
    instanceProjection: journal.getInstanceProjection(),
    checkpoint,
  });
  return progress.checklist.name;
}

async function loadCurrentChecklistShow(
  proof: string,
  subject: string,
  output: string,
  timeout: number,
): Promise<{name: string; show: unknown}> {
  const show = parseJson(
    runProof(proof, subject, output, 'preflight', ['checklist', 'show', '--format', 'json'], timeout),
    'Proof checklist show',
  );
  return {name: activeChecklistNameFromProofShow(show), show};
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

const CHECKLIST_SNAPSHOT_CLAIM = 'proof.checklist.snapshot@1';
const CHECKLIST_RESEARCH_SNAPSHOT_CLAIM = 'proof.checklist.research-snapshot@1';

// Proof init owns this exact three-line local-state addition.  The retry
// subject guard treats it as a narrow, expected bootstrap mutation; every
// other source-tree mutation is refused before the engine can dispatch.
const PROOF_INIT_GITIGNORE_BLOCK =
  '\n# ReqProof local-only state (versionable .proof/ audit objects stay tracked).\n.proof/\n';

function hasExactChecklistConfirmationEvidence(row: Json): boolean {
  if (row.applicable !== true || row.stored_status !== 'confirmed' || row.effective_status !== 'confirmed') {
    return false;
  }
  if (row.stamp !== 'confirm' && row.stamp !== 'confirm+verify') return false;
  const required = row.required_checks;
  const results = row.check_results;
  if (!Array.isArray(required) || !Array.isArray(results) || required.length !== results.length) return false;
  const requiredIds = new Set<string>();
  for (const value of required) {
    if (typeof value !== 'string' || value.length === 0 || requiredIds.has(value)) return false;
    requiredIds.add(value);
  }
  const resultIds = new Set<string>();
  for (const value of results) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const result = value as Json;
    const keys = Object.keys(result).sort();
    if (keys.length !== 3 || keys.join('\0') !== ['at', 'id', 'status'].join('\0') ||
        typeof result.id !== 'string' || result.id.length === 0 || resultIds.has(result.id) ||
        !requiredIds.has(result.id) || result.status !== 'pass' ||
        typeof result.at !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(result.at) ||
        Number.isNaN(Date.parse(result.at))) {
      return false;
    }
    resultIds.add(result.id);
  }
  if (resultIds.size !== requiredIds.size || [...requiredIds].some(id => !resultIds.has(id))) return false;
  if (row.stamp === 'confirm') return true;
  const verifyResult = row.verify_result;
  return !!verifyResult && typeof verifyResult === 'object' && !Array.isArray(verifyResult) &&
    (verifyResult as Json).passed === true && (verifyResult as Json).exit_code === 0 &&
    typeof (verifyResult as Json).at === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test((verifyResult as Json).at as string) &&
    !Number.isNaN(Date.parse((verifyResult as Json).at as string));
}


/**
 * Execute one journaled Proof checklist mutation and return its authoritative
 * JSON readback.  Native YAML owns the graph/check dependencies; this helper
 * only provides the shared command boundary and closed evidence checks.
 */
export function executeJournaledChecklistStep(stepId: string, note: string, verify: boolean): Json {
  if (!/^[A-Za-z0-9_.-]{1,96}$/.test(stepId) || note.length === 0 || note.length > 8192) {
    throw new Error('invalid journaled checklist step arguments');
  }
  const proof = process.env.PROOF_BIN;
  const output = process.env.NATIVE_ONBOARDING_OUTPUT_DIR;
  if (typeof proof !== 'string' || proof.length === 0 || typeof output !== 'string' || !path.isAbsolute(output)) {
    throw new Error('journaled checklist command environment is incomplete');
  }
  const run = (phase: string, args: string[]): CommandResult => runProof(
    proof, process.cwd(), output, `checklist-${stepId}-${phase}`, args, 120000,
  );
  const json = (phase: string, args: string[]): Json => {
    const result = run(phase, args);
    if (result.status !== 0) throw new Error(`Proof checklist ${phase} failed`);
    let value: unknown;
    try { value = JSON.parse(result.stdout); } catch { throw new Error(`Proof checklist ${phase} returned invalid JSON`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Proof checklist ${phase} did not return an object`);
    return value as Json;
  };
  const mutation = (args: string[]): void => {
    if (run('confirm', args).status !== 0) throw new Error(`Proof checklist confirmation failed for ${stepId}`);
  };
  if (stepId === 'init') {
    if (run('init', ['init', '--name', 'jsonparser', '--template', 'go-package', '--scope', '.', '--strict']).status !== 0) {
      throw new Error('Proof init failed');
    }
  }
  const before = json('before-show', ['checklist', 'show', '--format', 'json']);
  const checklist = before.checklist;
  if (before.schema_version !== 'proof.checklist.show.v1' || before.active !== true || before.new_project !== true || typeof checklist !== 'string' || checklist.length === 0) {
    throw new Error('Proof checklist is not the active new-project campaign');
  }
  const row = Array.isArray(before.steps) ? before.steps.find(value => value && typeof value === 'object' && !Array.isArray(value) && (value as Json).step_id === stepId) as Json | undefined : undefined;
  if (stepId === 'skeleton' && row && hasExactChecklistConfirmationEvidence(row)) return before;
  if (!row || row.applicable !== true || row.eligible !== true || row.effective_status !== 'pending') {
    throw new Error(`Proof checklist step ${stepId} is not currently eligible`);
  }
  mutation(['checklist', 'confirm', '--checklist', checklist, '--id', stepId, '--by', 'visor-checklist-driven-run', '--note', note, ...(verify ? ['--verify'] : [])]);
  const after = json('after-show', ['checklist', 'show', '--checklist', checklist, '--format', 'json']);
  const confirmed = Array.isArray(after.steps) ? after.steps.find(value => value && typeof value === 'object' && !Array.isArray(value) && (value as Json).step_id === stepId) as Json | undefined : undefined;
  const required = confirmed && Array.isArray(confirmed.required_checks) ? confirmed.required_checks : [];
  const results = confirmed && Array.isArray(confirmed.check_results) ? confirmed.check_results : [];
  const ids = new Set<string>();
  const checksPass = required.length === results.length && results.every(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const result = value as Json;
    if (typeof result.id !== 'string' || result.status !== 'pass' || typeof result.at !== 'string' || result.at.length === 0 || ids.has(result.id)) return false;
    ids.add(result.id); return true;
  }) && required.every(value => typeof value === 'string' && ids.has(value));
  const verifyPass = confirmed && confirmed.stamp !== 'confirm+verify' || !!(confirmed && confirmed.verify_result && typeof confirmed.verify_result === 'object' && (confirmed.verify_result as Json).passed === true && (confirmed.verify_result as Json).exit_code === 0 && typeof (confirmed.verify_result as Json).at === 'string' && ((confirmed.verify_result as Json).at as string).length > 0);
  if (after.new_project !== true || !confirmed || confirmed.effective_status !== 'confirmed' || confirmed.stored_status !== 'confirmed' || !checksPass || !verifyPass) {
    throw new Error(`Proof checklist confirmation readback did not confirm ${stepId} with exact evidence`);
  }
  return after;
}


export function buildChecklistOnboardingConfig(_base: VisorConfig): VisorConfig {
  // Compatibility entry point for callers that previously asked the runner
  // to build an overlay. The checklist profile is now authored as native
  // YAML; no topology is cloned, deleted, or renamed in TypeScript.
  const {prepared} = onboardingConfigTemplate(CHECKLIST_CONFIG_PATH);
  return prepared as VisorConfig;
}

/** Load the direct-load continuation policy; it intentionally contains no
 * reserved governed-proof discovery/admission node. */
export async function loadChecklistContinuationConfig(): Promise<VisorConfig> {
  const raw = yaml.load(fs.readFileSync(CHECKLIST_CONTINUATION_CONFIG_PATH, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('checklist continuation YAML must be an object');
  }
  return loadConfig(raw as VisorConfig, {strict: true});
}

export function buildChecklistContinuationConfig(): VisorConfig {
  const raw = yaml.load(fs.readFileSync(CHECKLIST_CONTINUATION_CONFIG_PATH, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('checklist continuation YAML must be an object');
  }
  return raw as VisorConfig;
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
  kind: 'file' | 'symlink' | 'missing' | 'ignored';
  sha256?: string;
  link_target?: string;
  checklist?: string;
  disposition?: 'non-authoritative-proof-checklist-refresh';
  baseline_sha256?: string;
  current_sha256?: string;
}>;

type RecoveryDraftInventory = Readonly<{
  root: string;
  baseline_commit: string;
  component_id: string;
  files: readonly RecoveryDraftInventoryEntry[];
  sha256: string;
}>;

type ChecklistRefreshContext = Readonly<{
  expectedChecklist: string;
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

function toChecklistRefreshFile(
  value: {kind: 'file'; bytes: Buffer} | {kind: 'symlink'; link_target: string} | {kind: 'missing'} | undefined,
): NativeChecklistRefreshFile {
  if (value === undefined || value.kind === 'missing') return {kind: 'missing'};
  return value.kind === 'file'
    ? {kind: 'file', bytes: value.bytes}
    : {kind: 'symlink', linkText: value.link_target};
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

/** Require the current subject revision to retain the journaled baseline in its history. */
export function assertRecoveryBaselineAncestor(root: string, baselineCommit: string, currentCommit: string): void {
  const result = spawnSync('git', [
    '-C', root, 'merge-base', '--is-ancestor', baselineCommit, currentCommit,
  ], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  if (result.status === 0) return;
  if (result.status === 1) {
    throw new Error(`Git baseline ${baselineCommit} is not an ancestor of current revision ${currentCommit}`);
  }
  const detail = result.error instanceof Error
    ? result.error.message
    : String(result.stderr || '').trim();
  throw new Error(`Git ancestry check failed${result.status === null ? '' : ` with exit ${result.status}`}: ${detail || 'unknown Git error'}`);
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
  checklistRefresh?: ChecklistRefreshContext,
): RecoveryDraftInventory {
  const owned = new Set(ownedSourcePaths);
  const files = parseGitStatusNul(root).map(({path: relativePath, status}) => {
    const allowedSource = owned.has(relativePath);
    const allowedNative = nativePathBelongsToComponent(root, baselineCommit, relativePath, componentId);
    if (checklistRefresh && relativePath.startsWith('proof/')) {
      const classification = classifyNonAuthoritativeChecklistRefresh({
        expectedChecklist: checklistRefresh.expectedChecklist,
        path: relativePath,
        gitStatus: status,
        baseline: toChecklistRefreshFile(gitSnapshotAtCommit(root, baselineCommit, relativePath) || {kind: 'missing'}),
        current: toChecklistRefreshFile(currentFileValue(root, relativePath)),
      });
      if (classification.kind === 'ignored') {
        return {
          path: classification.path,
          status,
          kind: 'ignored',
          checklist: classification.checklist,
          disposition: classification.disposition,
          baseline_sha256: classification.baseline_sha256,
          current_sha256: classification.current_sha256,
        } satisfies RecoveryDraftInventoryEntry;
      }
      if (classification.kind === 'rejected') throw new Error(classification.reason);
      throw new Error(`recovery author draft path is outside WorkItem ownership: ${relativePath}`);
    }
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

export function assertDraftInventoryUnchanged(
  expected: RecoveryDraftInventory,
  ownedSourcePaths: readonly string[],
): void {
  const expectedChecklist = expected.files.find(file => file.kind === 'ignored')?.checklist;
  const actual = inventoryAuthorDraft(
    expected.root,
    expected.baseline_commit,
    expected.component_id,
    ownedSourcePaths,
    expectedChecklist ? {expectedChecklist} : undefined,
  );
  if (actual.sha256 !== expected.sha256 || !sameJson(actual.files, expected.files)) {
    throw new Error(`recovery author draft changed before retry dispatch for ${expected.component_id}`);
  }
}

function assertIsolatedAuthorRecoveryBindings(
  bindings: readonly RecoveryBinding[],
  retryGenerationIds: readonly string[],
  expectedBaselineCommit?: string,
): void {
  if (bindings.length !== retryGenerationIds.length || retryGenerationIds.length === 0) {
    throw new Error('isolated draft replay requires one failed-author binding and inventory per selected generation');
  }
  const selectedGenerationIds = new Set(retryGenerationIds);
  const seenGenerationIds = new Set<string>();
  const componentIds = new Set<string>();
  const checkoutRoots: string[] = [];
  const promotablePathOwners = new Map<string, string>();
  let commonBaseline: string | undefined;
  for (const binding of bindings) {
    if (!selectedGenerationIds.has(binding.generationId) || seenGenerationIds.has(binding.generationId)) {
      throw new Error('isolated draft replay selected generations do not bind one-to-one to author recoveries');
    }
    seenGenerationIds.add(binding.generationId);
    if (!binding.checkoutPath || !binding.draftInventory || !binding.ownedSourcePaths) {
      throw new Error('isolated draft replay requires a retained checkout and inventory for every failed author');
    }
    const checkoutRoot = fs.realpathSync(binding.checkoutPath);
    if (checkoutRoot !== binding.checkoutPath || !fs.statSync(checkoutRoot).isDirectory()) {
      throw new Error('isolated draft replay requires distinct real retained checkout roots');
    }
    if (binding.draftInventory.root !== checkoutRoot) {
      throw new Error('isolated draft replay inventory root does not match its retained checkout');
    }
    if (componentIds.has(binding.componentId)) {
      throw new Error(`isolated draft replay selected duplicate component ${binding.componentId}`);
    }
    componentIds.add(binding.componentId);
    if (commonBaseline !== undefined && commonBaseline !== binding.baselineCommit) {
      throw new Error('isolated draft replay selected author baselines do not match');
    }
    commonBaseline = binding.baselineCommit;
    if (expectedBaselineCommit !== undefined && binding.baselineCommit !== expectedBaselineCommit) {
      throw new Error('isolated draft replay author baseline does not match the checklist initialized baseline');
    }
    const ignoredPaths = new Set(binding.draftInventory.files
      .filter(file => file.kind === 'ignored')
      .map(file => file.path));
    const promotablePaths = [
      ...binding.ownedSourcePaths.filter(relativePath => !ignoredPaths.has(relativePath)),
      ...binding.draftInventory.files
        .filter(file => file.kind !== 'ignored' && isNativeComponentPath(file.path))
        .map(file => file.path),
    ];
    const localPaths = new Set<string>();
    for (const relativePath of promotablePaths) {
      if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('..')) {
        throw new Error(`isolated draft replay has an unsafe promotable path: ${relativePath}`);
      }
      if (localPaths.has(relativePath)) {
        throw new Error(`isolated draft replay has overlapping promotable path ${relativePath}`);
      }
      localPaths.add(relativePath);
      const owner = promotablePathOwners.get(relativePath);
      if (owner !== undefined) {
        throw new Error(`isolated draft replay selected overlapping promotable path ${relativePath} for ${owner} and ${binding.componentId}`);
      }
      promotablePathOwners.set(relativePath, binding.componentId);
    }
    checkoutRoots.push(checkoutRoot);
  }
  if (seenGenerationIds.size !== retryGenerationIds.length) {
    throw new Error('isolated draft replay selected generations do not bind one-to-one to author recoveries');
  }
  for (let left = 0; left < checkoutRoots.length; left += 1) {
    for (let right = left + 1; right < checkoutRoots.length; right += 1) {
      if (inside(checkoutRoots[left], checkoutRoots[right]) || inside(checkoutRoots[right], checkoutRoots[left])) {
        throw new Error('isolated draft replay retained checkout roots must be pairwise disjoint');
      }
    }
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

/**
 * A retry must bind to the generation's current failed attempt. Historical
 * retry events do not make a newly failed attempt ineligible, while a ready or
 * running generation can never be reopened through recovery.
 */
export function isCurrentFailedRetryAttempt(checkpoint: GraphJournalCheckpointV1, generation: any): boolean {
  if (!generation || generation.status !== 'failed' || generation.scheduled !== true ||
      typeof generation.attemptId !== 'string' || typeof generation.fence !== 'number' ||
      typeof generation.reason !== 'string') return false;
  const latestFailedAttempt = [...(checkpoint.events as readonly Json[])]
    .reverse()
    .find(event => event.type === 'AttemptFailed' && event.nodeGenerationId === generation.nodeGenerationId);
  return !!latestFailedAttempt && latestFailedAttempt.attemptId === generation.attemptId &&
    latestFailedAttempt.fence === generation.fence && latestFailedAttempt.reason === generation.reason;
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
  options: Readonly<{
    allowEmptyAuthorDraft?: boolean;
    allowHistoricalAuthorRetry?: boolean;
    expectedChecklist?: string;
    expectedBaselineCommit?: string;
  }> = {},
): {journal: ExecutionJournal; bindings: readonly RecoveryBinding[]; reviewPackets: readonly RecoveryReviewPacket[]} {
  const plan = compileClaimPlan(config);
  if (checkpoint.graphSemanticDigest !== plan.expansionPlan.graphSemanticDigest) {
    throw new Error('Recovery checkpoint graph semantic digest does not match the retained configuration authority');
  }
  if (externalSideEffects !== 'absent' && externalSideEffects !== 'safely_idempotent' &&
      externalSideEffects !== 'isolated_draft_replay') {
    throw new Error('Recovery has an unsupported external side-effect disposition');
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
      (selectedChecks.length !== retryGenerationIds.length ||
        selectedChecks.some(checkId => checkId !== 'author-native-component'))) {
    throw new Error('isolated draft replay must explicitly select only failed author leaves');
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
    if (!isCurrentFailedRetryAttempt(checkpoint, {...generation, nodeGenerationId: generationId})) {
      throw new Error(`Recovery generation ${generationId} is not bound to its current failed ${authorReplay ? 'author' : 'selected'} attempt`);
    }
    if (authorReplay && hasPriorIsolatedDraftReplay(checkpoint, generationId) && !options.allowHistoricalAuthorRetry) {
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
      draftInventory = inventoryAuthorDraft(
        checkoutPath,
        baselineCommit,
        workItemPayload.component_id,
        ownedSourcePaths,
        options.expectedChecklist ? {expectedChecklist: options.expectedChecklist} : undefined,
      );
      if (!options.allowEmptyAuthorDraft && draftInventory.files.length === 0) {
        throw new Error(`Recovery author draft inventory is empty for ${workItemPayload.component_id}`);
      }
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
  if (externalSideEffects === 'isolated_draft_replay') {
    assertIsolatedAuthorRecoveryBindings(bindings, retryGenerationIds, options.expectedBaselineCommit);
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

/** Return the complete controller-owned WorkItems for a retained catalog. */
export function materializedComponentWorkItems(config: VisorConfig, checkpoint: unknown): readonly Json[] {
  const plan = compileClaimPlan(config);
  const projection = ExecutionJournal.restoreGraphCheckpoint(plan, checkpoint).getInstanceProjection();
  const activeClaims = Object.values(projection.claimsById).filter(claim => claim.active);
  const catalogs = activeClaims.filter(claim =>
    claim.kind === 'generated-output' && claim.claim === 'component.catalog@1' && claim.producerCheckId === 'materialize_catalog',
  );
  if (catalogs.length !== 1) throw new Error('checkpoint must contain exactly one active materialized component catalog');
  const catalog = catalogs[0];
  const validatedCheckpoint = (() => {
    try { return ExecutionJournal.validateGraphCheckpointIntegrity(checkpoint); } catch { return undefined; }
  })();
  const baselineCommit = (() => {
    try {
      return validatedCheckpoint ? checklistBaselineCommitFromCheckpoint(config, validatedCheckpoint) : undefined;
    } catch { return undefined; }
  })();
  const items: Array<Json & {component_id: string}> = activeClaims.filter(claim =>
    claim.kind === 'controller-item' && claim.claim === 'component.work_item@1' && claim.controllerCatalogClaimId === catalog.claimId,
  ).map((claim, index): Json & {component_id: string} => {
    if (!claim.payload || typeof claim.payload !== 'object' || Array.isArray(claim.payload)) {
      throw new Error(`materialized component WorkItem ${index} is not an object`);
    }
    const item = claim.payload as Json;
    if (typeof item.component_id !== 'string' || item.component_id.length === 0 ||
        !Array.isArray(item.sorted_owned_paths) || item.sorted_owned_paths.length === 0 ||
        item.sorted_owned_paths.some(value => typeof value !== 'string' || value.length === 0 || path.isAbsolute(value) || value.split('/').includes('..')) ||
        (item.baseline_commit !== undefined && (typeof item.baseline_commit !== 'string' || !/^[0-9a-f]{40,64}$/.test(item.baseline_commit)))) {
      throw new Error(`materialized component WorkItem ${index} is incomplete or has unsafe owned paths`);
    }
    if (typeof item.baseline_commit !== 'string' && !baselineCommit) {
      throw new Error(`materialized component WorkItem ${index} has no immutable baseline commit`);
    }
    return {
      ...item,
      component_id: item.component_id,
      baseline_commit: item.baseline_commit ?? baselineCommit,
    };
  });
  const ids = items.map(item => item.component_id);
  if (new Set(ids).size !== ids.length || utf8Sorted(ids).join('\u0000') !== materializedComponentIds(config, checkpoint).join('\u0000')) {
    throw new Error('materialized component WorkItems do not exactly match the current component IDs');
  }
  return Object.freeze(items.sort((left, right) => Buffer.from(left.component_id).compare(Buffer.from(right.component_id))));
}

function continuationGraphWorkItems(config: VisorConfig, checkpoint: GraphJournalCheckpointV1): readonly Json[] {
  const projection = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), checkpoint).getInstanceProjection();
  const catalogs = Object.values(projection.claimsById)
    .filter(claim => claim.active && claim.claim === 'native.continuation.catalog@1');
  if (catalogs.length !== 1 || !isRecord(catalogs[0].payload)) {
    throw new Error('continuation checkpoint must contain exactly one catalog authority envelope');
  }
  const catalog = catalogs[0].payload as Json;
  const authority = validateContinuationAuthority(catalog.authority, 'journaled continuation authority');
  const items = authority.current_work_items as Json[];
  const ids = items.map(item => item.component_id as string);
  if (items.length === 0 || new Set(ids).size !== ids.length) throw new Error('continuation checkpoint has no unique full WorkItems');
  return Object.freeze(items.slice().sort((left, right) => Buffer.from(left.component_id as string).compare(Buffer.from(right.component_id as string))));
}

function continuationGraphAuthority(config: VisorConfig, checkpoint: GraphJournalCheckpointV1): Json {
  const projection = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), checkpoint).getInstanceProjection();
  const catalogs = Object.values(projection.claimsById)
    .filter(claim => claim.active && claim.claim === 'native.continuation.catalog@1');
  if (catalogs.length !== 1 || !isRecord(catalogs[0].payload)) {
    throw new Error('continuation checkpoint must contain exactly one catalog authority envelope');
  }
  return validateContinuationAuthority((catalogs[0].payload as Json).authority, 'journaled continuation authority');
}

export type ChecklistAffectedBatches = Readonly<{
  affectedComponentIds: readonly string[];
  reusedComponentIds: readonly string[];
  batches: readonly Readonly<{component_id: string; paths: readonly string[]}>[];
  /** Exact native orphan detail strings keyed by their unique WorkItem owner. */
  orphanDetailsByComponent?: Readonly<Record<string, readonly string[]>>;
}>;

/** Map Proof orphan findings to exactly one retained WorkItem owner. */
export function deriveChecklistAffectedBatches(
  workItems: readonly Json[],
  orphanPaths: readonly string[],
): ChecklistAffectedBatches {
  const owners = new Map<string, string[]>();
  for (const item of workItems) {
    const id = item.component_id;
    if (typeof id !== 'string' || id.length === 0 || !Array.isArray(item.sorted_owned_paths)) {
      throw new Error('cannot derive affected batches from an incomplete WorkItem');
    }
    for (const owned of item.sorted_owned_paths) {
      if (typeof owned !== 'string' || owned.length === 0) throw new Error(`WorkItem ${id} has an invalid owned path`);
      const list = owners.get(owned) ?? [];
      list.push(id);
      owners.set(owned, list);
    }
  }
  const pathsByComponent = new Map<string, string[]>();
  for (const orphanPath of orphanPaths) {
    if (typeof orphanPath !== 'string' || orphanPath.length === 0) throw new Error('orphan finding has no exact path');
    const matches = owners.get(orphanPath) ?? [];
    if (matches.length === 0) throw new Error(`orphan path ${orphanPath} has no WorkItem owner`);
    if (matches.length !== 1) throw new Error(`orphan path ${orphanPath} has ambiguous WorkItem ownership`);
    const paths = pathsByComponent.get(matches[0]) ?? [];
    if (!paths.includes(orphanPath)) paths.push(orphanPath);
    pathsByComponent.set(matches[0], paths);
  }
  const affectedComponentIds = utf8Sorted([...pathsByComponent.keys()]);
  const all = utf8Sorted(workItems.map(item => item.component_id as string));
  const reusedComponentIds = all.filter(id => !pathsByComponent.has(id));
  const batches = affectedComponentIds.map(component_id => ({
    component_id,
    paths: Object.freeze(utf8Sorted(pathsByComponent.get(component_id) ?? [])),
  }));
  return Object.freeze({
    affectedComponentIds: Object.freeze(affectedComponentIds),
    reusedComponentIds: Object.freeze(reusedComponentIds),
    batches: Object.freeze(batches),
  });
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
  if (initialResult.statistics.failedExecutions > 0) {
    throw new Error('retained project prefix failed before catalog materialization');
  }
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

export function currentUnresolvedGenerations(config: VisorConfig, checkpoint: GraphJournalCheckpointV1): Json[] {
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
  checklistOnboarding = false,
  governedCodexTransport?: string,
  governedCodexBin?: string,
  governedCodexSha256?: string,
): Promise<void> {
  const priorOutput = realDirectory(required(values, 'prior-output'), 'prior recovery output');
  if (inside(priorOutput, roots.subject) || inside(priorOutput, roots.original) || inside(priorOutput, roots.output)) {
    throw new Error('prior recovery output must be disjoint from current subject, original, and output roots');
  }
  const checkpointPath = fs.realpathSync(path.resolve(required(values, 'recover-checkpoint')));
  if (!fs.statSync(checkpointPath).isFile()) {
    throw new Error('recover-checkpoint must be a retained checkpoint file');
  }
  const recoveryProgressOptions = checklistProgressRefreshOptions(checkpointPath);
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

  const checklistRecovery = checklistOnboarding && governedCodexTransport === 'exec-jsonl-default-auth-v1';
  if (checklistOnboarding && !checklistRecovery) {
    throw new Error('checklist recovery requires --governed-codex-transport exec-jsonl-default-auth-v1');
  }
  if (checklistRecovery && (!governedCodexBin || !governedCodexSha256)) {
    throw new Error('checklist recovery requires verified --codex-bin and --codex-sha256');
  }
  let latestRecoveryCheckpoint = validatedInput;
  let recoveryConfig: VisorConfig | undefined;
  let recoveryMaterializedConfigPath: string | undefined;
  const persistRecoveryTerminal = (stage: RecoveryTerminalStage, error: unknown): void => {
    void error;
    try { writeCheckpoint(path.join(roots.output, 'checkpoint.partial.json'), latestRecoveryCheckpoint); } catch { /* preserve primary error */ }
    if (checklistRecovery && recoveryConfig && recoveryMaterializedConfigPath) {
      try {
        const configBytes = fs.readFileSync(recoveryMaterializedConfigPath, 'utf8');
        const destination = path.join(roots.output, 'checklist-materialized-config.json');
        writeText(destination, configBytes);
        fs.chmodSync(destination, 0o600);
      } catch { /* preserve primary error */ }
      try {
        writeRestoredChecklistProgress(
          roots.output,
          recoveryConfig,
          latestRecoveryCheckpoint,
          recoveryProgressOptions,
        );
      } catch { /* observational */ }
    }
    try {
      const descriptor = describeRecoveryTerminal(stage);
      const emittedStage = stage === 'selected-retry' ? 'retry' : stage;
      writeJson(path.join(roots.output, 'recovery', 'closed-diagnostic.json'), {
        version: 1,
        kind: 'native-onboarding-recovery-failure',
        stage: emittedStage,
        failure_code: descriptor.failure_code,
        detail: descriptor.failure_code === 'POSTFLIGHT_FAILED'
          ? 'Postflight failure evidence is retained in postflight.json and commands/postflight; this record contains no provider payload or raw stderr.'
          : descriptor.failure_code === 'RECOVERY_INCOMPLETE'
            ? 'Incomplete recovery evidence is retained in summary.json, checkpoint.partial.json, and progress.json; this record contains no provider payload or raw stderr.'
            : descriptor.result
              ? 'Selected retry remained failed; summary.json and visor-result.json retain the engine outcome; this record contains no provider payload or raw stderr.'
            : 'Runner failure detail is retained in failure.stderr; this record contains no provider payload or raw stderr.',
        evidence: descriptor.evidence,
        ...(descriptor.result ? {result: descriptor.result} : {}),
        checkpoint: 'checkpoint.partial.json',
        ...(checklistRecovery && recoveryConfig ? {
          materialized_config: 'checklist-materialized-config.json',
          progress: 'progress.json',
        } : {}),
      });
    } catch { /* preserve primary error */ }
  };
  recoveryTerminalPersistence = error => persistRecoveryTerminal('terminal', error);
  const revision = assertRecoverySubject(roots.subject);
  const objectFormat = gitObjectFormat(roots.subject);
  const codex = checklistRecovery
    ? assertCodexHomeAbsent(roots.subject, roots.original, roots.output)
    : assertPrivateCodexHome(roots.subject, roots.original, roots.output);
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
    ...(checklistRecovery ? {
      codex_home_is_private: false,
      codex_home_absent: true,
      codex_home_config_present: false,
      codex_user_config_ignored: true,
      codex_rules_ignored: true,
      governed_codex_transport: governedCodexTransport,
      codex_bin: governedCodexBin,
      codex_sha256: governedCodexSha256,
    } : {
      codex_home_is_private: true,
      codex_home_config_present: codex.configPresent,
    }),
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
  let config: VisorConfig;
  let retainedAuthority: Json | undefined;
  if (checklistRecovery) {
    const restored = await loadChecklistMaterializedConfig(checkpointPath);
    config = restored.config;
    recoveryConfig = config;
    recoveryMaterializedConfigPath = restored.materializedConfigPath;
    const exactConfigBytes = fs.readFileSync(recoveryMaterializedConfigPath, 'utf8');
    writeText(path.join(roots.output, 'checklist-materialized-config.json'), exactConfigBytes);
    fs.chmodSync(path.join(roots.output, 'checklist-materialized-config.json'), 0o600);
  } else {
    const retained = await loadRetainedOnboardingConfig(priorOutput, roots.output);
    config = retained.config;
    retainedAuthority = retained.authority.inventory;
  }
  const checklistBaselineCommit = checklistRecovery
    ? checklistBaselineCommitFromCheckpoint(config, validatedInput)
    : undefined;
  const expectedChecklist = checklistRecovery
    ? activeChecklistNameFromCheckpoint(config, validatedInput)
    : undefined;
  if (expectedChecklist !== undefined) {
    const currentChecklist = await loadCurrentChecklistShow(
      proof,
      roots.subject,
      roots.output,
      timeout,
    );
    if (currentChecklist.name !== expectedChecklist) {
      throw new Error('current Proof checklist does not match the trusted active checkpoint checklist');
    }
  }
  if (checklistRecovery) {
    try {
      writeRestoredChecklistProgress(
        roots.output,
        config,
        latestRecoveryCheckpoint,
        recoveryProgressOptions,
      );
    } catch { /* observational */ }
  }
  // Refresh the current subject inventory as a separate freshness check, but
  // never bind the recovery graph to post-promotion role/schema bytes. Those
  // bytes are immutable authority retained by the earlier run.
  const currentInventory = await loadCurrentOnboardingInventory(proof, roots.subject, roots.output, timeout);
  const reviewRequirementIds = selectedReviewRequirementIds(validatedInput, generationIds);
  const currentProofRequirements = await loadCurrentProofRequirementHashes(
    proof, roots.subject, roots.output, timeout, reviewRequirementIds,
  );
  const currentAuthority = assertAuthenticatedInventory(currentInventory, 'current Proof onboarding inventory');
  if (retainedAuthority && currentAuthority.project_id !== assertAuthenticatedInventory(
    retainedAuthority,
    'retained Proof onboarding inventory',
  ).project_id) {
    throw new Error('current Proof project identity does not match retained recovery authority');
  }
  writeJson(path.join(roots.output, 'recovery', 'current-authority.json'), {
    project_id: currentAuthority.project_id,
    subject_fingerprint: currentAuthority.subject_fingerprint,
    source: 'current-read-only-proof-inventory',
  });
  const configPlan = compileClaimPlan(config);
  if (configPlan.expansionPlan.graphSemanticDigest !== validatedInput.graphSemanticDigest) {
    throw new Error('recovery configuration graph digest does not match the checkpoint authority');
  }
  if (checklistRecovery) {
    assertRecoveryBaselineAncestor(roots.subject, checklistBaselineCommit as string, revision);
  }
  const authority = validateRecoverySelection(
    config,
    validatedInput,
    generationIds,
    {subject: roots.subject, priorOutput, checkpointRoot},
    currentInventory,
    externalSideEffects,
    currentProofRequirements,
    checklistRecovery ? {
      allowEmptyAuthorDraft: true,
      allowHistoricalAuthorRetry: true,
      expectedChecklist,
      expectedBaselineCommit: checklistBaselineCommit,
    } : {},
  );
  const draftInventories = authority.bindings
    .filter(binding => binding.draftInventory)
    .map(binding => binding.draftInventory);
  if (externalSideEffects === 'isolated_draft_replay' && draftInventories.length !== generationIds.length) {
    throw new Error('isolated_draft_replay requires one retained author draft inventory per selected failed author');
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
  const refreshRecoveryProgress = (): void => {
    if (!checklistRecovery || !recoveryConfig) return;
    let liveInstanceProjection: unknown;
    try {
      liveInstanceProjection = engine.getInstanceProjection();
      latestRecoveryCheckpoint = engine.exportGraphCheckpoint();
    } catch {
      try { liveInstanceProjection = engine.getInstanceProjection(); } catch { /* observational */ }
    }
    try {
      writeRestoredChecklistProgress(
        roots.output,
        recoveryConfig,
        latestRecoveryCheckpoint,
        recoveryProgressOptions,
        liveInstanceProjection,
      );
    } catch { /* observational */ }
  };
  const recoveryPromptHook = (info: PublicPromptCaptureInfo): void => {
    onPromptCaptured(info);
    refreshRecoveryProgress();
  };
  engine.setExecutionContext({
    ...(checklistRecovery ? {
      governedCodexTransport: governedCodexTransport as 'exec-jsonl-default-auth-v1',
      codexBin: governedCodexBin,
      codexSha256: governedCodexSha256,
    } : {}),
    hooks: {
      onPromptCaptured: checklistRecovery ? recoveryPromptHook : onPromptCaptured,
      ...(checklistRecovery ? {onCheckComplete: refreshRecoveryProgress} : {}),
    },
  });
  let resumed: Awaited<ReturnType<StateMachineExecutionEngine['retryGraphCheckpoint']>>;
  const retainedBaselineCommit = checklistRecovery
    ? checklistBaselineCommit
    : undefined;
  const previousBaselineCommit = process.env.NATIVE_ONBOARDING_BASELINE_COMMIT;
  try {
    if (retainedBaselineCommit) process.env.NATIVE_ONBOARDING_BASELINE_COMMIT = retainedBaselineCommit;
    resumed = await engine.retryGraphCheckpoint({
      checkpoint: validatedInput,
      config,
      prInfo: PR,
      retryGenerationIds: generationIds,
      externalSideEffects,
      onRetryCheckpoint: retryCheckpoint => {
        latestRecoveryCheckpoint = retryCheckpoint;
        for (const binding of authority.bindings) {
          if (binding.draftInventory) {
            assertDraftInventoryUnchanged(
              binding.draftInventory,
              binding.ownedSourcePaths || [],
            );
          }
        }
        writeCheckpoint(path.join(roots.output, 'recovery', 'retry-prefix-checkpoint.json'), retryCheckpoint);
      },
      maxParallelism: config.max_parallelism,
      failFast: false,
      ...(checklistRecovery ? {generatedDispatchGate: checklistSkeletonPauseGate} : {}),
    });
  } catch (error) {
    // The engine callback persists the retry prefix before dispatch. Keep the
    // source checkpoint and selection receipt available if later resume fails.
    try { latestRecoveryCheckpoint = engine.exportGraphCheckpoint(); } catch { /* preserve last durable checkpoint */ }
    persistRecoveryTerminal('retry', error);
    recoveryTerminalPersistence = undefined;
    throw error;
  } finally {
    if (previousBaselineCommit === undefined) delete process.env.NATIVE_ONBOARDING_BASELINE_COMMIT;
    else process.env.NATIVE_ONBOARDING_BASELINE_COMMIT = previousBaselineCommit;
  }
  latestRecoveryCheckpoint = resumed.checkpoint;
  writeCheckpoint(path.join(roots.output, 'checkpoint.json'), resumed.checkpoint);
  writeJson(path.join(roots.output, 'visor-result.json'), resumed.result);
  if (checklistRecovery) {
    try {
      writeRestoredChecklistProgress(
        roots.output,
        config,
        resumed.checkpoint,
        recoveryProgressOptions,
      );
    } catch { /* observational */ }
  }
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
  const checklistFrontier = checklistRecovery
    ? assessChecklistSkeletonFrontier(config, resumed.checkpoint)
    : undefined;
  if (checklistFrontier?.ready) {
    writeCheckpoint(path.join(roots.output, 'checklist-skeleton-frontier-checkpoint.json'), resumed.checkpoint);
    try {
      writeRestoredChecklistProgress(
        roots.output,
        config,
        resumed.checkpoint,
        {...recoveryProgressOptions, paused: true},
      );
    } catch { /* observational */ }
  }

  const postflight: Json = {};
  for (const [name, args] of Object.entries({
    requirements: ['req', 'list', '--format', 'json'],
    validation: ['validate', '--variable-drift', '--format', 'json'],
    audit: ['audit', '--no-cache', '--check', 'validate_passes', '--check', 'annotation_validity', '--check', 'levels_connected', '--format', 'json'],
    checklist: checklistRecovery ? ['checklist', 'show', '--format', 'json'] : ['checklist', 'show', '--checklist', 'onboard_v1', '--format', 'json'],
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
        : checklistRecovery && checklistFrontier?.ready && unresolved.length === 0
          ? 'checklist-skeleton-ready-paused'
          : checklistRecovery
            ? 'recovery-incomplete'
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
    ...(checklistFrontier ? {
      checklist_skeleton_frontier: {
        ready: checklistFrontier.ready,
        expected_component_ids: checklistFrontier.expectedComponentIds,
        promoted_component_ids: checklistFrontier.promotedComponentIds,
        component_attempts_started: checklistFrontier.componentAttemptsStarted,
        skeleton_generation_ids: checklistFrontier.skeletonGenerationIds,
        ...(checklistFrontier.reason ? {reason: checklistFrontier.reason} : {}),
      },
    } : {}),
    recovered_retry_generations: recoveredRetryGenerations,
    open_native_checks: postflightSummary.open_native_checks,
    admitted: 'No component admission or full onboarding success is claimed by retry mode.',
    output: roots.output,
  };
  writeJson(path.join(roots.output, 'summary.json'), summary);
  const hardPostflightFailure = postflightSummary.hard_failures.length > 0;
  const incompleteRecovery = selectedStillFailed.length > 0 || unresolved.length > 0 ||
    (checklistRecovery && !checklistFrontier?.ready);
  if (hardPostflightFailure || incompleteRecovery) {
    const terminalStage: RecoveryTerminalStage = hardPostflightFailure
      ? 'postflight'
      : selectedStillFailed.length > 0
        ? 'selected-retry'
        : 'incomplete';
    persistRecoveryTerminal(terminalStage, new Error(`recovery terminal state: ${summary.status}`));
    recoveryTerminalPersistence = undefined;
    console.error(JSON.stringify({status: summary.status, output: roots.output}, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({status: summary.status, output: roots.output}, null, 2));
  recoveryTerminalPersistence = undefined;
}

type FreshRunnerRoots = Readonly<{subject: string; original: string; output: string}>;

function readCampaignReportJson(file: string, label: string): unknown {
  const resolved = fs.realpathSync(path.resolve(file));
  if (!fs.statSync(resolved).isFile()) throw new Error(`${label} must be a file`);
  return JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
}

/**
 * Static report mode intentionally has no subject/protected-original/proof
 * arguments. It replays public checkpoint data and copies only packet files
 * that the report builder has verified against the supplied export manifest.
 */
async function runCampaignReport(values: Record<string, string>): Promise<void> {
  const input: NativeCampaignReportInput = {
    epoch: values['campaign-report-epoch'] || 'author-review-recovery',
    checkpoint: readCampaignReportJson(required(values, 'campaign-report-checkpoint'), 'campaign checkpoint'),
    ...(values['campaign-report-prior-checkpoint']
      ? {priorCheckpoint: readCampaignReportJson(values['campaign-report-prior-checkpoint'], 'prior campaign checkpoint')}
      : {}),
    packetRoot: required(values, 'campaign-report-packet-root'),
    ...(values['campaign-report-postflight']
      ? {postflight: readCampaignReportJson(values['campaign-report-postflight'], 'campaign postflight')}
      : {}),
  };
  const output = path.resolve(required(values, 'campaign-report-output'));
  const artifacts = emitNativeCampaignReport(output, input);
  console.log(JSON.stringify({
    status: 'native-campaign-report-complete',
    output,
    files: artifacts.files,
    warnings: artifacts.warnings,
    counts: artifacts.report.counts,
  }, null, 2));
}

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
  if (values['campaign-report-checkpoint'] !== undefined) {
    await runCampaignReport(values);
    return;
  }
  const recovery = parseRecoveryArguments(values);
  const checklistPrefixRetry = parseChecklistPrefixRetryArguments(values);
  const checklistContinue = parseChecklistContinueArguments(values);
  const retainedExport = values['retained-review-export'];
  const checklistSkeletonResume = values['checklist-skeleton-resume'];
  if (checklistPrefixRetry && values['preflight-only'] === 'true') {
    throw new Error('checklist prefix retry cannot be combined with --preflight-only');
  }
  if (recovery && retainedExport !== undefined) {
    throw new Error('--retained-review-export cannot be combined with checkpoint recovery arguments');
  }
  if (recovery && checklistSkeletonResume !== undefined) {
    throw new Error('--checklist-skeleton-resume cannot be combined with checkpoint recovery arguments');
  }
  if (recovery && checklistPrefixRetry !== undefined) {
    throw new Error('checklist prefix retry cannot be combined with checkpoint recovery arguments');
  }
  if (recovery && checklistContinue !== undefined) {
    throw new Error('checklist continuation cannot be combined with checkpoint recovery arguments');
  }
  if (checklistPrefixRetry && checklistSkeletonResume !== undefined) {
    throw new Error('checklist prefix retry cannot be combined with --checklist-skeleton-resume');
  }
  if (checklistContinue && (checklistPrefixRetry || checklistSkeletonResume !== undefined || retainedExport !== undefined)) {
    throw new Error('checklist continuation cannot be combined with another checklist continuation mode');
  }
  if (checklistPrefixRetry && retainedExport !== undefined) {
    throw new Error('checklist prefix retry cannot be combined with --retained-review-export');
  }
  if (retainedExport !== undefined && checklistSkeletonResume !== undefined) {
    throw new Error('--checklist-skeleton-resume cannot be combined with --retained-review-export');
  }
  const roots = recovery
    ? assertRecoveryRoots(
      required(values, 'subject-root'),
      required(values, 'original-root'),
      required(values, 'output'),
      recovery.priorOutput,
      recovery.checkpoint,
    )
    : checklistPrefixRetry
      ? assertRecoveryRoots(
        required(values, 'subject-root'),
        required(values, 'original-root'),
        required(values, 'output'),
        checklistPrefixRetry.priorOutput,
        checklistPrefixRetry.checkpoint,
      )
    : assertRoots(required(values, 'subject-root'), required(values, 'original-root'), required(values, 'output'));
  diagnosticOutput = roots.output;
  const proof = executable(required(values, 'proof-bin'));
  const checklistOnboarding = values['checklist-onboarding'] === 'true' || checklistSkeletonResume !== undefined || checklistPrefixRetry !== undefined || checklistContinue !== undefined;
  const governedCodexTransport = values['governed-codex-transport'];
  const codexBinArg = values['codex-bin'];
  const codexSha256Arg = values['codex-sha256'];
  if (recovery && governedCodexTransport !== undefined && !checklistOnboarding) {
    throw new Error('--governed-codex-transport cannot be combined with checkpoint recovery');
  }
  if (recovery && checklistOnboarding && governedCodexTransport !== 'exec-jsonl-default-auth-v1') {
    throw new Error('checklist recovery requires --checklist-onboarding with --governed-codex-transport exec-jsonl-default-auth-v1');
  }
  if (governedCodexTransport !== undefined && !checklistOnboarding) {
    throw new Error('--governed-codex-transport is only valid with --checklist-onboarding');
  }
  if (checklistPrefixRetry && governedCodexTransport !== 'exec-jsonl-default-auth-v1') {
    throw new Error('checklist prefix retry requires --governed-codex-transport exec-jsonl-default-auth-v1');
  }
  if ((codexBinArg !== undefined || codexSha256Arg !== undefined) && governedCodexTransport === undefined) {
    throw new Error('--codex-bin and --codex-sha256 require --governed-codex-transport exec-jsonl-default-auth-v1');
  }
  let governedCodexBin: string | undefined;
  let governedCodexSha256: string | undefined;
  if (governedCodexTransport !== undefined) {
    if (governedCodexTransport !== 'exec-jsonl-default-auth-v1') {
      throw new Error('--governed-codex-transport must be exec-jsonl-default-auth-v1');
    }
    if (!codexBinArg || !codexSha256Arg) {
      throw new Error('--codex-bin and --codex-sha256 are required for exec-jsonl-default-auth-v1');
    }
    if (!/^(?:[0-9a-f]{64}|sha256:[0-9a-f]{64})$/.test(codexSha256Arg)) {
      throw new Error('--codex-sha256 must be a lowercase 64-character SHA-256 digest (optionally sha256:-prefixed)');
    }
    governedCodexBin = executable(codexBinArg, '--codex-bin');
    governedCodexSha256 = verifyCodexBinarySha256(governedCodexBin, codexSha256Arg);
  }
  const timeout = values.timeout ? Number(values.timeout) : DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1000) throw new Error('--timeout must be a positive millisecond integer');
  const requestTimeout = Number(process.env.REQUEST_TIMEOUT || '');
  if (!Number.isSafeInteger(requestTimeout) || requestTimeout < 1000 || requestTimeout >= timeout) {
    throw new Error('REQUEST_TIMEOUT must be an explicit positive inner budget smaller than --timeout');
  }
  if (recovery) {
    await runRecovery(
      values,
      roots,
      proof,
      timeout,
      requestTimeout,
      recovery,
      checklistOnboarding,
      governedCodexTransport,
      governedCodexBin,
      governedCodexSha256,
    );
    return;
  }
  const revision = retainedExport !== undefined || checklistSkeletonResume !== undefined || checklistContinue !== undefined
    ? assertRecoverySubject(roots.subject)
    : checklistPrefixRetry !== undefined
      ? gitScalar(roots.subject, ['rev-parse', '--verify', 'HEAD^{commit}'], 'checklist retry subject')
      : assertFreshSubject(roots.subject, process.env.SUBJECT_BASELINE_REVISION);
  let checklistResumeCheckpointPath: string | undefined;
  let checklistContinueCheckpointPath: string | undefined;
  if (checklistSkeletonResume !== undefined) {
    const candidate = path.resolve(checklistSkeletonResume);
    const checkpoint = fs.realpathSync(candidate);
    if (!fs.statSync(checkpoint).isFile() || !/checkpoint\.json$/.test(path.basename(checkpoint))) {
      throw new Error('--checklist-skeleton-resume must name a retained checkpoint JSON file');
    }
    if (inside(checkpoint, roots.subject) || inside(checkpoint, roots.original)) {
      throw new Error('checklist skeleton checkpoint must be outside subject and protected original roots');
    }
    checklistResumeCheckpointPath = checkpoint;
  }
  if (checklistContinue !== undefined) {
    const checkpoint = fs.realpathSync(path.resolve(checklistContinue.checkpoint));
    if (!fs.statSync(checkpoint).isFile() || path.basename(checkpoint) !== 'checkpoint.json') {
      throw new Error('--checklist-continue must name a retained checkpoint.json file');
    }
    if (inside(checkpoint, roots.subject) || inside(checkpoint, roots.original)) {
      throw new Error('checklist continuation checkpoint must be outside subject and protected original roots');
    }
    checklistContinueCheckpointPath = checkpoint;
  }
  const objectFormat = gitObjectFormat(roots.subject);
  const codex = governedCodexTransport === 'exec-jsonl-default-auth-v1'
    ? assertCodexHomeAbsent(roots.subject, roots.original, roots.output)
    : assertPrivateCodexHome(roots.subject, roots.original, roots.output);
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

  if (checklistPrefixRetry) {
    await runChecklistPrefixRetry(
      roots as ReturnType<typeof assertRecoveryRoots>,
      proof,
      timeout,
      requestTimeout,
      checklistPrefixRetry,
      governedCodexTransport as 'exec-jsonl-default-auth-v1',
      governedCodexBin as string,
      governedCodexSha256 as string,
      onPromptCaptured,
    );
    return;
  }

  if (retainedExport !== undefined) {
    await runRetainedContinuation(
      roots as FreshRunnerRoots, proof, timeout, requestTimeout, objectFormat, onPromptCaptured,
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
    ...(governedCodexTransport === 'exec-jsonl-default-auth-v1' ? {
      codex_home_is_private: false,
      codex_home_absent: true,
      codex_home_config_present: false,
      codex_user_config_ignored: true,
      codex_rules_ignored: true,
    } : {
      codex_home_is_private: true,
      codex_home_config_present: codex.configPresent,
      codex_mcp_plugins_hooks_rejected: true,
    }),
    ...(governedCodexTransport ? {
      governed_codex_transport: governedCodexTransport,
      codex_bin: governedCodexBin,
      codex_sha256: governedCodexSha256,
    } : {}),
    subject_codex_override_rejected: true,
    note: 'No authentication, raw Codex config, or inherited tool capability is recorded.',
  });

  if (checklistOnboarding) {
    writeJson(path.join(roots.output, 'preflight.json'), {
      status: checklistContinueCheckpointPath
        ? 'launch-ready-checklist-continuation-preflight'
        : checklistResumeCheckpointPath ? 'launch-ready-checklist-skeleton-resume' : 'launch-ready-checklist-init-journaled',
      subject_root: roots.subject,
      protected_original_root: roots.original,
      subject_revision: revision,
      source_revision: revision,
      baseline_commit: null,
      proof_binary: proof,
      request_timeout_ms: requestTimeout,
      outer_timeout_ms: timeout,
      object_format: objectFormat,
      ...(governedCodexTransport === 'exec-jsonl-default-auth-v1' ? {
        codex_home_is_private: false,
        codex_home_absent: true,
        codex_home_config_present: false,
        codex_user_config_ignored: true,
        codex_rules_ignored: true,
      } : {
        codex_home_is_private: true,
        codex_home_config_present: codex.configPresent,
        codex_mcp_plugins_hooks_rejected: true,
      }),
      ...(governedCodexTransport ? {
        governed_codex_transport: governedCodexTransport,
        codex_bin: governedCodexBin,
        codex_sha256: governedCodexSha256,
      } : {}),
      subject_codex_override_rejected: true,
      journaled_init_pending: !checklistContinueCheckpointPath,
      journaled_baseline_pending: !checklistContinueCheckpointPath,
      ...(checklistResumeCheckpointPath ? {checklist_skeleton_checkpoint: checklistResumeCheckpointPath} : {}),
      ...(checklistContinueCheckpointPath ? {checklist_continuation_checkpoint: checklistContinueCheckpointPath} : {}),
      note: checklistContinueCheckpointPath
        ? 'Checklist continuation validates the retained checkpoint and current Proof authority without re-running bootstrap commands.'
        : 'Checklist bootstrap journals Proof init, confirmation, and immutable baseline commit as graph command boundaries.',
    });
  } else {
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
  }

  const registry = CheckProviderRegistry.getInstance();
  registry.bootstrapProofAdmission(createProofAdmissionCapability(proof));
  let config: VisorConfig;
  let checklistResumeCheckpoint: GraphJournalCheckpointV1 | undefined;
  let checklistResumeMaterializedConfigPath: string | undefined;
  let checklistContinuationMaterializedConfigPath: string | undefined;
  let checklistContinuationEvidence: ChecklistContinuationEvidence | undefined;
  if (checklistOnboarding) {
    // The checklist profile is a standalone native Visor graph.  Only the
    // authored result-schema sentinel/materialization pass runs here; graph
    // topology is read directly from the profile YAML.
    if (checklistContinueCheckpointPath) {
      checklistContinuationEvidence = await validateChecklistContinuationCheckpoint(checklistContinueCheckpointPath);
      config = checklistContinuationEvidence.mode === 'continuation-frontier'
        ? checklistContinuationEvidence.config
        : await loadChecklistContinuationConfig();
      if (checklistContinuationEvidence.mode === 'retained-skeleton') {
        const current = await validateCurrentRetainedCatalog(
          proof,
          roots.subject,
          roots.output,
          timeout,
          checklistContinuationEvidence.config,
          checklistContinuationEvidence.prefixCheckpoint as GraphJournalCheckpointV1,
        );
        const expectedById = new Map(checklistContinuationEvidence.workItems.map(item => [
          String(item.component_id),
          Array.isArray(item.sorted_owned_paths) ? [...item.sorted_owned_paths].sort() : [],
        ]));
        const actualById = new Map(current.workItems.map(item => [
          String(item.component_id),
          Array.isArray(item.sorted_owned_paths) ? [...item.sorted_owned_paths].sort() : [],
        ]));
        if (expectedById.size !== actualById.size || [...expectedById].some(([id, paths]) =>
          canonicalJson(actualById.get(id)) !== canonicalJson(paths))) {
          throw new Error('current Proof WorkItems do not preserve the retained catalog IDs and owned-path partition');
        }
        const batches = await deriveCurrentChecklistAffectedBatches(
          proof,
          roots.subject,
          roots.output,
          timeout,
          current.workItems,
        );
        const authority = buildChecklistContinuationAuthority(
          current,
          checklistContinuationEvidence.checkpointPath,
          checklistContinuationEvidence.prefixCheckpointPath,
          batches.affectedComponentIds,
          batches.reusedComponentIds,
        );
        checklistContinuationEvidence = Object.freeze({
          ...checklistContinuationEvidence,
          workItems: current.workItems,
          authority,
          affectedComponentIds: batches.affectedComponentIds,
          reusedComponentIds: batches.reusedComponentIds,
          affectedBatches: batches.batches,
          affectedDetailsByComponent: batches.orphanDetailsByComponent,
        });
      }
      const authority = checklistContinuationEvidence.authority
        ? validateContinuationAuthority(checklistContinuationEvidence.authority)
        : undefined;
      if (!authority) throw new Error('checklist continuation is missing one closed current authority envelope');
      const continuationEvidence = checklistContinuationEvidence;
      const affected = new Set(continuationEvidence.affectedComponentIds ?? authority.affected_component_ids as string[]);
      const detailByComponent = continuationEvidence.affectedDetailsByComponent ?? {};
      const affectedBatches = continuationEvidence.affectedBatches;
      const graphWorkItems = continuationEvidence.workItems
        .filter(item => affected.has(String(item.component_id)))
        .map(item => {
          const componentId = String(item.component_id);
          const batch = affectedBatches?.find(candidate => candidate.component_id === componentId);
          const details = detailByComponent[componentId];
          if (!batch || !details || details.length === 0) {
            throw new Error(`checklist continuation has no exact orphan findings for affected WorkItem ${componentId}`);
          }
          return {
            ...item,
            continuation_task: {
              step_id: 'traces-light',
              role: 'onboard',
              required_checks: ['annotation_validity', 'orphan_code_clean'],
              orphan_code_clean: {paths: [...batch.paths], details: [...details]},
            },
          } as Json;
        });
      if (graphWorkItems.length !== affected.size) throw new Error('checklist continuation affected WorkItems are incomplete');
      const catalog = {
        components: graphWorkItems,
        full_components: authority.current_work_items,
        affected_component_ids: authority.affected_component_ids,
        reused_component_ids: authority.reused_component_ids,
        retained_receipt_identities: continuationAuthorityReceiptStrings(authority),
        current_receipt_identities: continuationAuthorityReceiptStrings(authority),
        authority,
      };
      process.env.NATIVE_CHECKLIST_CONTINUE_CATALOG = JSON.stringify(catalog);
      process.env.NATIVE_CHECKLIST_CONTINUE_CATALOG_FULL = JSON.stringify(catalog);
    } else if (checklistResumeCheckpointPath) {
      const restored = await loadChecklistMaterializedConfig(checklistResumeCheckpointPath);
      config = restored.config;
      checklistResumeCheckpoint = restored.checkpoint;
      checklistResumeMaterializedConfigPath = restored.materializedConfigPath;
    } else {
      const {prepared} = onboardingConfigTemplate(CHECKLIST_CONFIG_PATH);
      config = await loadConfig(prepared as VisorConfig, {strict: true});
    }
  } else {
    config = await loadOnboardingConfig(proof, roots.subject, roots.output, timeout);
  }
  if (checklistContinuationEvidence) {
    // Continuation outputs, including a completed/readback checkpoint, must
    // retain the exact graph materialization that was loaded for this run.
    const materialized = persistChecklistMaterializedConfig(roots.output, config);
    checklistContinuationMaterializedConfigPath = materialized.path;
  }
  if (checklistOnboarding) {
    writeJson(path.join(roots.output, 'preflight', 'checklist-overlay.json'), {
      mode: checklistContinueCheckpointPath ? 'checklist-continuation' : 'checklist-onboarding',
      bootstrap_check: 'checklist-bootstrap',
      research_check: 'checklist-research',
      snapshot_claim: CHECKLIST_SNAPSHOT_CLAIM,
      ordinary_graph_untouched: true,
      ...(checklistContinuationEvidence ? {
        retained_checkpoint: checklistContinuationEvidence.checkpointPath,
        retained_prefix_checkpoint: checklistContinuationEvidence.prefixCheckpointPath,
        retained_component_ids: checklistContinuationEvidence.expectedComponentIds,
      } : {}),
    });
  }
  if (checklistContinuationEvidence) {
    const currentChecklist = await loadCurrentChecklistShow(proof, roots.subject, roots.output, timeout);
    const expectedChecklist = activeChecklistNameFromCheckpoint(
      checklistContinuationEvidence.config,
      checklistContinuationEvidence.checkpoint,
    );
    if (currentChecklist.name !== expectedChecklist) {
      throw new Error('current Proof checklist does not match the trusted active checkpoint checklist');
    }
    const eligibility = validateChecklistContinuationEligibility(
      currentChecklist.show,
      checklistContinuationEvidence.mode === 'continuation-frontier',
    );
    process.env.NATIVE_CHECKLIST_CONTINUE_SNAPSHOT = JSON.stringify(currentChecklist.show);
    writeJson(path.join(roots.output, 'preflight', 'checklist-continuation.json'), {
      status: 'checklist-continuation-input-validated',
      step: checklistContinue?.step,
      current_checklist: eligibility,
      retained_checkpoint: checklistContinuationEvidence.checkpointPath,
      retained_prefix_checkpoint: checklistContinuationEvidence.prefixCheckpointPath,
      retained_component_ids: checklistContinuationEvidence.expectedComponentIds,
      affected_component_ids: checklistContinuationEvidence.affectedComponentIds,
      reused_component_ids: checklistContinuationEvidence.reusedComponentIds,
      affected_batches: checklistContinuationEvidence.affectedBatches,
      affected_details_by_component: checklistContinuationEvidence.affectedDetailsByComponent,
      work_item_count: checklistContinuationEvidence.workItems.length,
      fresh_graph_policy: path.relative(REPO_ROOT, CHECKLIST_CONTINUATION_CONFIG_PATH),
    });
  }
  if (values['preflight-only'] === 'true') {
    const continuationAuthority = checklistContinuationEvidence?.authority
      ? validateContinuationAuthority(checklistContinuationEvidence.authority, 'current continuation preflight authority')
      : undefined;
    const continuationWorkItems = continuationAuthority && Array.isArray(continuationAuthority.current_work_items)
      ? continuationAuthority.current_work_items.length
      : undefined;
    const continuationAffected = continuationAuthority && Array.isArray(continuationAuthority.affected_component_ids)
      ? continuationAuthority.affected_component_ids.length
      : undefined;
    const continuationReused = continuationAuthority && Array.isArray(continuationAuthority.reused_component_ids)
      ? continuationAuthority.reused_component_ids.length
      : undefined;
    writeJson(path.join(roots.output, 'preflight', 'summary.json'), {
      status: 'preflight-only-complete',
      subject_revision: revision,
      requirements_baseline: checklistContinuationEvidence ? 'retained-checkpoint-authority' : checklistOnboarding ? 'journaled_pending' : 'recorded',
      native_inventory: checklistContinuationEvidence ? 'current-proof-validated' : checklistOnboarding ? 'journaled_pending' : 'resolved',
      project_role_invocation: checklistContinuationEvidence ? 'retained-checkpoint-authority' : checklistOnboarding ? 'journaled_at_managed_acquisition' : 'resolved',
      checklist_overlay: checklistOnboarding,
      ...(checklistContinuationEvidence ? {
        continuation_mode: 'current-authority-preflight',
        current_catalog: {
          status: 'validated',
          full_component_count: continuationWorkItems,
          affected_component_count: continuationAffected,
          reused_component_count: continuationReused,
        },
      } : {}),
      strict_config: 'validated-with-actual-registered-providers',
      no_engine_dispatch: true,
      ...(checklistResumeMaterializedConfigPath ? {
        materialized_config: path.relative(roots.output, checklistResumeMaterializedConfigPath),
        checkpoint: path.relative(roots.output, checklistResumeCheckpointPath as string),
      } : {}),
      ...(checklistContinuationMaterializedConfigPath ? {
        materialized_config: path.relative(roots.output, checklistContinuationMaterializedConfigPath),
      } : {}),
    });
    console.log(JSON.stringify({status: 'preflight-only-complete', output: roots.output}, null, 2));
    return;
  }
  const engine = new StateMachineExecutionEngine(roots.subject);
  let latestChecklistCheckpoint: GraphJournalCheckpointV1 | undefined = checklistResumeCheckpoint;
  const refreshChecklistProgress = (options: ChecklistProgressRefreshOptions = {}): void => {
    if (!checklistOnboarding) return;
    let liveInstanceProjection: unknown;
    try {
      liveInstanceProjection = engine.getInstanceProjection();
      const exported = engine.exportGraphCheckpoint();
      latestChecklistCheckpoint = exported;
    } catch {
      // A prompt hook can run while a managed generation is in flight, when
      // the checkpoint is intentionally not exportable.  Keep the last
      // durable checkpoint and pair it with the live operational projection.
    }
    if (!latestChecklistCheckpoint) return;
    try {
      writeRestoredChecklistProgress(
        roots.output,
        config,
        latestChecklistCheckpoint,
        options,
        liveInstanceProjection,
      );
    } catch {
      // Progress is observational.  A render failure must never alter the
      // graph outcome or turn a provider hook into an authority failure.
    }
  };
  const checklistProgressObservation: ChecklistProgressRefreshOptions = checklistContinuationEvidence
    ? {
      ...(checklistContinuationEvidence.mode === 'continuation-frontier' ? {resumed: true} : {}),
      retainedCatalogComponentIds: checklistContinuationEvidence?.expectedComponentIds,
      affectedComponentIds: checklistContinuationEvidence?.affectedComponentIds,
    }
    : checklistProgressRefreshOptions(checklistResumeCheckpointPath);
  const checklistPromptHook = (info: PublicPromptCaptureInfo): void => {
    onPromptCaptured(info);
    refreshChecklistProgress(checklistProgressObservation);
  };
  const checklistCompleteHook = (): void => {
    refreshChecklistProgress(checklistProgressObservation);
  };
  engine.setExecutionContext({
    ...(governedCodexTransport === 'exec-jsonl-default-auth-v1' ? {
      governedCodexTransport,
      codexBin: governedCodexBin,
      codexSha256: governedCodexSha256,
    } : {}),
    hooks: {
      onPromptCaptured: checklistOnboarding ? checklistPromptHook : onPromptCaptured,
      ...(checklistOnboarding ? {onCheckComplete: checklistCompleteHook} : {}),
    },
  });
  let result: unknown;
  let checkpoint: unknown;
  let checklistPausedBeforeSkeleton = false;
  let checklistPausedBeforeTraces = false;
  try {
    if (checklistContinuationEvidence) {
      const continuationCheckpoint = checklistContinuationEvidence.mode === 'continuation-frontier'
        ? checklistContinuationEvidence.checkpoint
        : undefined;
      const continuationRun = await executeChecklistContinuationEngine(
        engine,
        config,
        timeout,
        checklistContinuationEvidence.affectedComponentIds ?? checklistContinuationEvidence.expectedComponentIds,
        continuationCheckpoint,
      );
      result = continuationRun.result;
      checkpoint = continuationRun.checkpoint;
      checklistPausedBeforeTraces = continuationRun.paused;
      if (checklistPausedBeforeTraces) {
        writeCheckpoint(path.join(roots.output, 'checklist-traces-light-frontier-checkpoint.json'), checkpoint);
        writeJson(path.join(roots.output, 'preflight', 'checklist-traces-light-frontier.json'), {
          status: 'checklist-traces-light-ready-paused',
          checkpoint: 'checklist-traces-light-frontier-checkpoint.json',
          materialized_config: 'checklist-materialized-config.json',
          materialized_config_sha256: checklistContinuationMaterializedConfigPath
            ? sha256File(checklistContinuationMaterializedConfigPath)
            : undefined,
          retained_component_ids: checklistContinuationEvidence.expectedComponentIds,
          resumed_from_retained_skeleton: checklistContinuationEvidence.mode === 'retained-skeleton',
          confirmation_replay: false,
        });
      }
    } else if (checklistOnboarding) {
      const checklistRun = checklistResumeCheckpointPath
        ? await resumeChecklistSkeleton(
          engine,
          config,
          checklistResumeCheckpoint as GraphJournalCheckpointV1,
          timeout,
        ).then(resumed => ({initialResult: undefined, frontier: undefined, result: resumed.result, checkpoint: resumed.checkpoint}))
      : await executeChecklistOnboardingEngine(engine, config, timeout, frontier => {
        latestChecklistCheckpoint = frontier.checkpoint;
        const materialized = persistChecklistMaterializedConfig(roots.output, config);
        writeCheckpoint(path.join(roots.output, 'checklist-frontier-checkpoint.json'), frontier.checkpoint);
        const configGraphDigest = compileClaimPlan(config).expansionPlan.graphSemanticDigest;
        refreshChecklistProgress(checklistProgressObservation);
        writeJson(path.join(roots.output, 'preflight', 'checklist-frontier.json'), {
          status: 'checklist-project-prefix-complete',
          checkpoint: 'checklist-frontier-checkpoint.json',
          materialized_component_ids: frontier.materializedComponentIds,
          component_attempts_started: frontier.componentAttemptsStarted,
          zero_component_attempts: frontier.zeroComponentAttempts,
          journaled_baseline_claim_required: true,
          materialized_config: 'checklist-materialized-config.json',
          materialized_config_sha256: materialized.digest,
          graph_semantic_digest: configGraphDigest,
          resume_same_graph: true,
        });
      }, {
        onProjectPrefix: ({initialResult: projectPrefixResult, checkpoint: projectPrefixCheckpoint}) => {
          latestChecklistCheckpoint = projectPrefixCheckpoint;
          writeJson(path.join(roots.output, 'preflight', 'checklist-project-prefix-result.json'), projectPrefixResult);
          writeCheckpoint(path.join(roots.output, 'preflight', 'checklist-project-prefix-checkpoint.json'), projectPrefixCheckpoint);
          writeJson(path.join(roots.output, 'preflight', 'checklist-project-prefix.json'), {
            status: 'checklist-project-prefix-exported',
            result: 'checklist-project-prefix-result.json',
            checkpoint: 'checklist-project-prefix-checkpoint.json',
            graph_semantic_digest: projectPrefixCheckpoint.graphSemanticDigest,
          });
        },
        pauseBeforeSkeleton: true,
        onSkeletonFrontier: frontier => {
          latestChecklistCheckpoint = frontier.checkpoint;
          checklistPausedBeforeSkeleton = true;
          const materialized = persistChecklistMaterializedConfig(roots.output, config);
          writeCheckpoint(path.join(roots.output, 'checklist-skeleton-frontier-checkpoint.json'), frontier.checkpoint);
          refreshChecklistProgress({...checklistProgressObservation, paused: true});
          writeJson(path.join(roots.output, 'preflight', 'checklist-skeleton-frontier.json'), {
            status: 'checklist-skeleton-ready-paused',
            checkpoint: 'checklist-skeleton-frontier-checkpoint.json',
            materialized_component_ids: frontier.materializedComponentIds,
            component_attempts_started: frontier.componentAttemptsStarted,
            zero_component_attempts: frontier.zeroComponentAttempts,
            sets_equal: frontier.setsEqual,
            materialized_config: 'checklist-materialized-config.json',
            materialized_config_sha256: materialized.digest,
            resume_command: '--checklist-skeleton-resume checklist-skeleton-frontier-checkpoint.json',
          });
        },
      });
      result = checklistRun.result;
      checkpoint = checklistRun.checkpoint;
    } else {
      result = await engine.executeGroupedChecks(PR, ['project'], timeout, config, 'json', false, config.max_parallelism, false);
      checkpoint = engine.exportGraphCheckpoint();
    }
    if (checklistOnboarding && checkpoint && typeof checkpoint === 'object') {
      latestChecklistCheckpoint = checkpoint as GraphJournalCheckpointV1;
      refreshChecklistProgress(checklistPausedBeforeTraces
        ? {...checklistProgressObservation, paused: true}
        : checklistProgressObservation);
    }
    writeJson(path.join(roots.output, 'checkpoint.json'), checkpoint);
    writeJson(path.join(roots.output, 'visor-result.json'), result);
    if (checklistPausedBeforeSkeleton) {
      writeJson(path.join(roots.output, 'postflight.json'), {
        status: 'checklist-skeleton-ready-paused',
        checkpoint: 'checklist-skeleton-frontier-checkpoint.json',
        note: 'Fresh process resume is required to execute checklist-skeleton confirmation/readback.',
      });
      console.log(JSON.stringify({status: 'checklist-skeleton-ready-paused', output: roots.output}, null, 2));
      return;
    }
    if (checklistPausedBeforeTraces) {
      writeJson(path.join(roots.output, 'postflight.json'), {
        status: 'checklist-traces-light-ready-paused',
        checkpoint: 'checklist-traces-light-frontier-checkpoint.json',
        note: 'Fresh process resume is required to execute traces-light confirmation/readback.',
      });
      console.log(JSON.stringify({status: 'checklist-traces-light-ready-paused', output: roots.output}, null, 2));
      return;
    }
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
  let checklistProgress: NativeChecklistProgress | undefined;
  if (checklistOnboarding && postflightValues.checklist && typeof postflightValues.checklist === 'object' &&
      !Array.isArray(postflightValues.checklist) && checkpoint !== undefined) {
    latestChecklistCheckpoint = checkpoint as GraphJournalCheckpointV1;
    try {
      checklistProgress = writeRestoredChecklistProgress(
        roots.output,
        config,
        latestChecklistCheckpoint,
        checklistProgressObservation,
        engine.getInstanceProjection(),
      );
    } catch {
      checklistProgress = undefined;
    }
  }
  if (checklistContinuationEvidence) {
    const checkpointObject = checkpoint && typeof checkpoint === 'object' ? checkpoint as GraphJournalCheckpointV1 : undefined;
    const statistics = result && typeof result === 'object' ? (result as Json).statistics as Json | undefined : undefined;
    const failedExecutions = statistics && typeof statistics.failedExecutions === 'number' ? statistics.failedExecutions : null;
    const unresolved = checkpointObject ? currentUnresolvedGenerations(config, checkpointObject) : [];
    const checklistRecord = postflightValues.checklist && typeof postflightValues.checklist === 'object' && !Array.isArray(postflightValues.checklist)
      ? postflightValues.checklist as Json : undefined;
    const traceRow = checklistRecord && Array.isArray(checklistRecord.steps)
      ? checklistRecord.steps.find(value => isRecord(value) && value.step_id === 'traces-light') as Json | undefined
      : undefined;
    const traceConfirmed = !!traceRow && hasExactChecklistConfirmationEvidence(traceRow);
    const continuationDelta = checklistContinuationEvidence.mode === 'continuation-frontier' && checkpointObject
      ? checklistContinuationResumeDeltaIsValid(config, checklistContinuationEvidence.checkpoint, checkpointObject) ||
        checklistContinuationReadbackIsValid(config, checklistContinuationEvidence.checkpoint, checkpointObject)
      : false;
    const clean = failedExecutions === 0 && unresolved.length === 0 && traceConfirmed && continuationDelta;
    const summary = {
      status: clean ? 'checklist-continuation-complete-with-later-proof-steps-pending' : 'checklist-continuation-incomplete',
      mode: 'checklist-continuation',
      step: 'traces-light',
      retained_component_ids: checklistContinuationEvidence.expectedComponentIds,
      retained_component_count: checklistContinuationEvidence.expectedComponentIds.length,
      affected_component_ids: checklistContinuationEvidence.affectedComponentIds ?? [],
      reused_component_ids: checklistContinuationEvidence.reusedComponentIds ?? [],
      affected_batches: checklistContinuationEvidence.affectedBatches ?? [],
      execution: {failed_executions: failedExecutions, current_unresolved_failures: unresolved.length, trace_confirmed: traceConfirmed, continuation_resume_delta_valid: continuationDelta},
      later_proof_steps_pending: true,
      postflight,
      checkpoint: checkpointObject ? summarizeCheckpoint(checkpointObject, false) : {available: false},
      output: roots.output,
    };
    writeJson(path.join(roots.output, 'summary.json'), summary);
    if (!clean) {
      console.error(JSON.stringify({status: summary.status, output: roots.output}, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({status: summary.status, output: roots.output}, null, 2));
    return;
  }
  if (checklistOnboarding) {
    const checkpointObject = checkpoint && typeof checkpoint === 'object'
      ? checkpoint as GraphJournalCheckpointV1
      : undefined;
    const statistics = result && typeof result === 'object' ? (result as Json).statistics as Json | undefined : undefined;
    const failedExecutions = statistics && typeof statistics.failedExecutions === 'number' ? statistics.failedExecutions : null;
    const checkpointEvents = checkpointObject?.events ?? [];
    const historicalContractFailures = checkpointEvents.filter(event =>
      event.type === 'AttemptFailed' || event.type === 'CheckErrored',
    ).length;
    const currentUnresolvedFailures = checkpointObject
      ? currentUnresolvedGenerations(config, checkpointObject)
      : [];
    const executionClean = failedExecutions === 0 && currentUnresolvedFailures.length === 0;
    const steps = checklistProgress?.checklist.steps ?? [];
    const requiredSteps = ['init', 'research', 'skeleton'];
    const confirmedSteps = requiredSteps.every(stepId => steps.some(step => step.id === stepId && step.state === 'confirmed'));
    const skeletonSnapshot = checklistProgress?.evidence.proof_snapshot.stage === 'skeleton';
    const resumeDelta = checklistResumeCheckpoint && checkpointObject
      ? checklistSkeletonResumeDeltaIsValid(
        config,
        checklistResumeCheckpoint,
        checkpointObject,
        materializedComponentIds(config, checklistResumeCheckpoint),
      )
      : false;
    const checklistRecord = postflight.checklist && typeof postflight.checklist === 'object' && !Array.isArray(postflight.checklist)
      ? postflight.checklist as Json
      : undefined;
    const checklistShowSucceeded = checklistRecord?.exit_code === 0;
    const checklistComplete = !!checklistProgress && skeletonSnapshot && confirmedSteps &&
      checklistShowSucceeded && executionClean && resumeDelta;
    const checklistSummary = {
      status: checklistComplete
        ? 'checklist-onboarding-complete-with-later-proof-steps-pending'
        : 'checklist-onboarding-incomplete',
      mode: 'checklist-onboarding',
      checklist_snapshot_stage: checklistProgress?.evidence.proof_snapshot.stage ?? 'bootstrap',
      confirmed_steps: steps.filter(step => step.state === 'confirmed').map(step => step.id),
      later_proof_steps_pending: true,
      later_proof_steps_note: 'Component admission, specification review, and reconciliation remain outside this checklist slice.',
      execution: {
        failed_executions: failedExecutions,
        contract_failures: historicalContractFailures,
        historical_contract_failures: historicalContractFailures,
        current_unresolved_failures: currentUnresolvedFailures.length,
        skeleton_resume_delta_valid: resumeDelta,
      },
      postflight,
      open_native_checks: summarizeNativePostflight(postflight, engine.getInstanceProjection()).open_native_checks,
      checklist_progress: checklistProgress ? 'progress.json' : null,
      checkpoint: checkpointObject ? summarizeCheckpoint(checkpointObject, false) : {available: false},
      output: roots.output,
    };
    writeJson(path.join(roots.output, 'summary.json'), checklistSummary);
    if (!checklistComplete) {
      console.error(JSON.stringify({status: checklistSummary.status, output: roots.output}, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({status: checklistSummary.status, output: roots.output}, null, 2));
    return;
  }
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
    checklist_progress: checklistProgress ? 'progress.json' : null,
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
    if (recoveryTerminalPersistence) {
      try { recoveryTerminalPersistence(error); } catch { /* preserve stderr */ }
      recoveryTerminalPersistence = undefined;
    }
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
