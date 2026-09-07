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
): Promise<readonly RecoveryProofRequirementHash[]> {
  if (ids.length === 0) return [];
  const listed = parseJson(runProof(proof, subject, output, 'preflight', ['req', 'list', '--format', 'json'], timeout), 'Proof req list');
  const rows = Array.isArray(listed)
    ? listed
    : listed && typeof listed === 'object' && Array.isArray((listed as Json).requirements)
      ? (listed as Json).requirements as Json[]
      : undefined;
  if (!rows) throw new Error('Proof req list did not return a requirement array');
  return ids.map(id => {
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
    if (shown.file_path !== row.file_path || typeof fileHash !== 'string' ||
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

function summarizeCheckpoint(checkpoint: unknown): Json {
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
    no_native_admission_claimed: true,
  };
}

/**
 * Recover the expected natural component count from the journal's current
 * Proof catalog and its controller-owned WorkItems. No completed-attempt count
 * or runner-side manifest is authoritative for this boundary.
 */
export function countAuthoritativeMaterializedComponents(config: VisorConfig, checkpoint: unknown): number {
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
  return componentIds.length;
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

async function main(): Promise<void> {
  const values = parseArgs(process.argv.slice(2));
  const recovery = parseRecoveryArguments(values);
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
  const revision = assertFreshSubject(roots.subject, process.env.SUBJECT_BASELINE_REVISION);
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
