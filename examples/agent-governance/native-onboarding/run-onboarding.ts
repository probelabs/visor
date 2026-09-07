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
import { ExecutionJournal } from '../../../src/snapshot-store';
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
  open_native_checks: Array<{name: string; exit_code: number}>;
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

export async function loadOnboardingConfig(proof: string, subject: string, output: string, timeout: number) {
  const raw = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('onboarding YAML must be an object');
  const prepared = encodeResultSchemas(raw) as Json;
  const inspect = ((prepared.subgraphs as Json)['discover-project'] as Json).checks as Json;
  const inspectCheck = inspect.inspect as Json;
  const inventoryResult = runProof(proof, subject, output, 'preflight', ['onboarding', 'inventory'], timeout);
  const inventory = parseJson(inventoryResult, 'Proof onboarding inventory') as Json;
  writeJson(path.join(output, 'preflight', 'inventory.json'), inventory);
  const authority = inventory.authority as Json | undefined;
  const projectId = authority && typeof authority.project_id === 'string' ? authority.project_id : undefined;
  const subjectFingerprint = authority && typeof authority.subject_fingerprint === 'string' ? authority.subject_fingerprint : undefined;
  if (!projectId || !subjectFingerprint || !/^sha256:[0-9a-f]{64}$/.test(subjectFingerprint)) {
    throw new Error('Proof onboarding inventory did not provide an authenticated project id and subject fingerprint');
  }
  const invocation = {
    role_id: 'onboard',
    stance: 'owner',
    subject: {kind: 'project', id: projectId, fingerprint: subjectFingerprint},
    output_schema_id: (inspectCheck.invocation as Json).output_schema_id,
    output_schema: (inspectCheck.invocation as Json).output_schema,
  };
  const resolvedResult = runProof(proof, subject, output, 'preflight', ['resolve-role-invocation'], timeout, serializeRoleInvocation(invocation));
  const resolved = parseJson(resolvedResult, 'Proof resolve-role-invocation') as Json;
  if (resolvedResult.stderr !== '') throw new Error('Proof resolve-role-invocation emitted stderr: ' + resolvedResult.stderr.slice(0, 1000));
  if (resolved.role_id !== invocation.role_id || resolved.output_schema_id !== invocation.output_schema_id ||
      resolved.output_schema !== invocation.output_schema || typeof resolved.instructions !== 'string' ||
      resolved.instructions.length === 0 || typeof resolved.invocation_digest !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(resolved.invocation_digest)) {
    throw new Error('Proof resolve-role-invocation returned an incomplete project authority');
  }
  inspectCheck.invocation = invocation;
  inspectCheck.instructions = resolved.instructions;
  inspectCheck.invocation_digest = resolved.invocation_digest;
  inspectCheck.result_schema = Buffer.from(String(invocation.output_schema), 'base64').toString('utf8');
  const projectValue = ((prepared.checks as Json).project as Json).value as Json;
  const projects = projectValue.projects as Json[];
  if (!Array.isArray(projects) || projects.length !== 1) throw new Error('onboarding graph must contain one project root');
  projects[0].project_id = projectId;
  projects[0].root = '.';
  return loadConfig(prepared, {strict: true});
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

export function summarizeNativePostflight(postflight: Json): NativePostflightSummary {
  const checkNames = ['requirements', 'validation', 'audit', 'checklist', 'status'];
  const open_native_checks = checkNames.flatMap(name => {
    const value = postflight[name];
    const exitCode = value && typeof value === 'object' && !Array.isArray(value) &&
      typeof (value as Json).exit_code === 'number'
      ? (value as Json).exit_code as number
      : -1;
    return exitCode === 0 ? [] : [{name, exit_code: exitCode}];
  });
  return {
    hard_failures: open_native_checks
      .filter(check => check.name === 'validation' || check.name === 'status')
      .map(check => check.name),
    open_native_checks,
  };
}

async function main(): Promise<void> {
  const values = parseArgs(process.argv.slice(2));
  const roots = assertRoots(required(values, 'subject-root'), required(values, 'original-root'), required(values, 'output'));
  diagnosticOutput = roots.output;
  const proof = executable(required(values, 'proof-bin'));
  const timeout = values.timeout ? Number(values.timeout) : DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1000) throw new Error('--timeout must be a positive millisecond integer');
  const requestTimeout = Number(process.env.REQUEST_TIMEOUT || '');
  if (!Number.isSafeInteger(requestTimeout) || requestTimeout < 1000 || requestTimeout >= timeout) {
    throw new Error('REQUEST_TIMEOUT must be an explicit positive inner budget smaller than --timeout');
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
  const postflightSummary = summarizeNativePostflight(postflight);
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
