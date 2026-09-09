/**
 * Bounded native-artifact promotion.
 *
 * Proof remains authoritative for requirement and variable ownership. Visor
 * supplies only the Git diff isolation, staging clone, and serialized apply
 * boundary. Callers must hold their existing proof-workspace-mutation resource
 * while invoking this helper; the helper does not claim crash-atomicity.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {execFileSync, spawnSync} from 'node:child_process';
import yaml from 'js-yaml';

type Json = Record<string, unknown>;

export interface NativePromotionWorkItem {
  component_id: string;
  sorted_owned_paths: string[];
  proof_component_subject?: {
    fingerprint?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface VerifiedWriterCheckoutOutput {
  path: string;
  is_worktree: true;
  commit: string;
  worktree_id: string;
}

export interface NativePromotionInput {
  canonicalRoot: string;
  baselineCommit: string;
  writerCheckout: VerifiedWriterCheckoutOutput;
  workItem: NativePromotionWorkItem;
  proofBin: string;
  /** Optional bounded source policy for the traces-light continuation. */
  sourceWritePolicy?: 'go-trace-annotations-only';
  /** Defaults to true. Set false only when the caller owns the commit boundary. */
  commitAcceptedArtifacts?: boolean;
  timeoutMs?: number;
}

export interface NativePromotionResult {
  status: 'promoted' | 'rejected';
  accepted_paths: string[];
  ignored_paths: string[];
  rejected_paths: string[];
  reason?: string;
  validation?: {
    status: number;
    stdout: string;
    stderr: string;
  };
  promoted_commit?: string;
  checkpoint: {
    baseline_commit: string;
    component_id: string;
    accepted_paths: string[];
    ignored_paths: string[];
    status: 'promoted' | 'rejected';
  };
}

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface ChangedPath {
  path: string;
  status: string;
  oldPath?: string;
}

interface NativeSurface {
  requirementRows: Json[];
  requirementFiles: Set<string>;
  requirementByPath: Map<string, Json>;
  variableFiles: Set<string>;
}

interface VariableAlias {
  targetPath: string;
  linkText: string;
}

interface FileSnapshot {
  kind: 'file' | 'symlink';
  bytes?: Buffer;
  linkText?: string;
}

/** A bounded view of one candidate checklist-state file. */
export type NativeChecklistRefreshFile =
  | {kind: 'file'; bytes: Buffer}
  | {kind: 'symlink'; linkText: string}
  | {kind: 'missing'};

export type NativeChecklistRefreshClassification =
  | {kind: 'not-applicable'}
  | {kind: 'rejected'; reason: string}
  | {
      kind: 'ignored';
      path: string;
      checklist: string;
      disposition: 'non-authoritative-proof-checklist-refresh';
      baseline_sha256: string;
      current_sha256: string;
    };

export interface NativeChecklistRefreshInput {
  /** The active name obtained from the canonical Proof checklist readback. */
  expectedChecklist: string;
  /** Project-relative Git path from the writer delta. */
  path: string;
  /** The exact Git status for this path (`M` or porcelain ` M`). */
  gitStatus: string;
  baseline: NativeChecklistRefreshFile;
  current: NativeChecklistRefreshFile;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const TRACE_ANNOTATION_SCANNER_TIMEOUT_MS = 30_000;
const TRACE_ANNOTATION_SCANNER_FILENAME = 'trace-annotation-scanner.go';
const SHA256_FILE_HASH = /^sha256:[0-9a-f]{64}$/;
const SAFE_CHECKLIST_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function plainObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : undefined;
}

/** Resolve the active checklist only from Proof's versioned JSON projection. */
export function activeChecklistNameFromProofShow(value: unknown): string {
  const shown = plainObject(value);
  if (!shown || shown.schema_version !== 'proof.checklist.show.v1' || shown.active !== true ||
      typeof shown.checklist !== 'string' || !SAFE_CHECKLIST_NAME.test(shown.checklist)) {
    throw new Error('Proof checklist show is not an active proof.checklist.show.v1 projection');
  }
  return shown.checklist;
}

function rfc3339Millis(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = RFC3339.exec(value);
  if (!match) return undefined;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return undefined;
  const daysInMonth = new Date(Date.UTC(Number(match[1]), month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return undefined;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : undefined;
}

type TimestampEntry = {segments: string[]; value: string};

function checklistTimestampEntries(value: unknown): TimestampEntry[] {
  const state = plainObject(value);
  if (!state || !Object.prototype.hasOwnProperty.call(state, 'updated_at') ||
      rfc3339Millis(state.updated_at) === undefined) {
    throw new Error('checklist state must contain a strict RFC3339 updated_at');
  }
  const entries: TimestampEntry[] = [{segments: ['updated_at'], value: state.updated_at as string}];
  const steps = state.steps;
  const stepEntries: Array<[string, unknown]> = Array.isArray(steps)
    ? steps.map((step, index) => [String(index), step])
    : (() => {
        const stepMap = plainObject(steps);
        if (!stepMap) throw new Error('checklist state steps must be an array or map');
        return Object.entries(stepMap);
      })();
  for (const [stepKey, rawStep] of stepEntries) {
    const step = plainObject(rawStep);
    if (!step) throw new Error(`checklist state step ${stepKey} must be an object`);
    if (!Object.prototype.hasOwnProperty.call(step, 'check_results')) continue;
    if (!Array.isArray(step.check_results)) throw new Error(`checklist state step ${stepKey} check_results must be an array`);
    for (let resultIndex = 0; resultIndex < step.check_results.length; resultIndex += 1) {
      const result = plainObject(step.check_results[resultIndex]);
      if (!result || !Object.prototype.hasOwnProperty.call(result, 'at') || rfc3339Millis(result.at) === undefined) {
        throw new Error(`checklist state check result ${stepKey}/${resultIndex} must contain a strict RFC3339 at`);
      }
      entries.push({
        segments: ['steps', stepKey, 'check_results', String(resultIndex), 'at'],
        value: result.at as string,
      });
    }
  }
  return entries;
}

function cloneParsedState(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneParsedState);
  const object = plainObject(value);
  if (object) return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, cloneParsedState(item)]));
  return value;
}

function setParsedPath(root: unknown, segments: string[], value: string): void {
  let current: any = root;
  for (let index = 0; index < segments.length - 1; index += 1) current = current[segments[index]];
  current[segments[segments.length - 1]] = value;
}

function checklistRefreshHash(bytes: Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function refreshRejected(reason: string): NativeChecklistRefreshClassification {
  return {kind: 'rejected', reason};
}

/**
 * Classify the one Proof state file a writer may have refreshed incidentally.
 * The file is ignored only when the parsed state differs by forward timestamps
 * at already-existing timestamp leaves; it is never copied or staged.
 */
export function classifyNonAuthoritativeChecklistRefresh(
  input: NativeChecklistRefreshInput,
): NativeChecklistRefreshClassification {
  const expected = input?.expectedChecklist;
  const relativePath = input?.path;
  if (typeof expected !== 'string' || !SAFE_CHECKLIST_NAME.test(expected)) {
    return refreshRejected('expected checklist name is not safe');
  }
  const expectedPath = `proof/checklists/${expected}.state.yaml`;
  if (relativePath !== expectedPath) return {kind: 'not-applicable'};

  try {
    if (input.gitStatus !== 'M' && input.gitStatus !== ' M') {
      return refreshRejected('checklist refresh must be an exact Git modification (M)');
    }
    if (!input.baseline || input.baseline.kind !== 'file') return refreshRejected('checklist baseline must be a regular file');
    if (!input.current || input.current.kind !== 'file') return refreshRejected('checklist refresh must remain a regular file');
    if (!Buffer.isBuffer(input.baseline.bytes) || !Buffer.isBuffer(input.current.bytes)) {
      return refreshRejected('checklist snapshots must contain file bytes');
    }
    const baselineDocument = yaml.load(input.baseline.bytes.toString('utf8'), {schema: yaml.JSON_SCHEMA});
    const currentDocument = yaml.load(input.current.bytes.toString('utf8'), {schema: yaml.JSON_SCHEMA});
    const baselineState = plainObject(baselineDocument);
    const currentState = plainObject(currentDocument);
    if (baselineState?.checklist !== expected || currentState?.checklist !== expected) {
      return refreshRejected('checklist state does not match the active checklist');
    }
    const baselineEntries = checklistTimestampEntries(baselineDocument);
    const currentEntries = checklistTimestampEntries(currentDocument);
    if (baselineEntries.length !== currentEntries.length) return refreshRejected('checklist timestamp leaves were added or removed');
    const currentByPath = new Map(currentEntries.map(entry => [entry.segments.join('\0'), entry]));
    let changed = 0;
    for (const baselineEntry of baselineEntries) {
      const key = baselineEntry.segments.join('\0');
      const currentEntry = currentByPath.get(key);
      if (!currentEntry) return refreshRejected('checklist timestamp leaves were reordered or removed');
      if (currentEntry.value !== baselineEntry.value) {
        const before = rfc3339Millis(baselineEntry.value);
        const after = rfc3339Millis(currentEntry.value);
        if (before === undefined || after === undefined || after < before) {
          return refreshRejected('checklist timestamp refresh moves a timestamp backwards or is not strict RFC3339');
        }
        changed += 1;
      }
    }
    if (changed === 0) return refreshRejected('checklist refresh did not change an allowed timestamp');
    const restored = cloneParsedState(currentDocument);
    for (const baselineEntry of baselineEntries) setParsedPath(restored, baselineEntry.segments, baselineEntry.value);
    if (!isDeepStrictEqual(restored, baselineDocument)) return refreshRejected('checklist refresh changes semantic Proof state');
    return {
      kind: 'ignored',
      path: relativePath,
      checklist: expected,
      disposition: 'non-authoritative-proof-checklist-refresh',
      baseline_sha256: checklistRefreshHash(input.baseline.bytes),
      current_sha256: checklistRefreshHash(input.current.bytes),
    };
  } catch (error) {
    return refreshRejected(error instanceof Error ? error.message : 'invalid checklist refresh');
  }
}

function rejected(
  input: NativePromotionInput,
  reason: string,
  accepted_paths: string[] = [],
  ignored_paths: string[] = [],
  rejected_paths: string[] = [],
  validation?: NativePromotionResult['validation']
): NativePromotionResult {
  return {
    status: 'rejected',
    accepted_paths,
    ignored_paths,
    rejected_paths,
    reason,
    ...(validation ? {validation} : {}),
    checkpoint: {
      baseline_commit: input.baselineCommit,
      component_id: input.workItem?.component_id || 'unknown',
      accepted_paths,
      ignored_paths,
      status: 'rejected',
    },
  };
}

function git(root: string, args: string[], raw = false): string {
  const output = String(
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );
  return raw ? output : output.trim();
}

function proof(proofBin: string, cwd: string, args: string[], timeoutMs: number): CommandResult {
  const verifiedCwd = verifyGitRoot(cwd, 'Proof command cwd');
  const result = spawnSync(proofBin, args, {
    cwd: verifiedCwd,
    env: {...process.env, PROOF_BIN: proofBin},
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: typeof result.status === 'number' ? result.status : 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || result.error?.message || ''),
  };
}

function parseProofJson(result: CommandResult, label: string): unknown {
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit ${result.status}: ${commandDetail(result)}`);
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new Error(
      `${label} returned non-JSON output: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Proof's scoped audit JSON output is a private JSONL receipt: progress is
 * emitted as stage/check events and the check_done event is the authoritative
 * result. Keep this parser strict so a status-only or malformed audit cannot
 * open the canonical promotion boundary.
 */
function parseTraceAnnotationAuditReceipt(result: CommandResult): void {
  if (result.status !== 0) {
    throw new Error(`Proof staging annotation audit failed with exit ${result.status}: ${commandDetail(result)}`);
  }
  const lines = result.stdout.split(/\r?\n/).filter(line => line.length > 0);
  if (!lines.length) throw new Error('Proof staging annotation audit returned an empty JSONL receipt');
  const events: Json[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[index]) as unknown;
    } catch (error) {
      throw new Error(`Proof staging annotation audit returned invalid JSONL at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!plainObject(parsed)) {
      throw new Error(`Proof staging annotation audit JSONL line ${index + 1} is not an object`);
    }
    const event = parsed as Json;
    if (event.event !== 'stage_start' && event.event !== 'check_start' && event.event !== 'check_done') {
      throw new Error(`Proof staging annotation audit returned an unexpected event ${String(event.event)}`);
    }
    events.push(event);
  }
  const checkDone = events.filter(event => event.event === 'check_done');
  if (checkDone.length === 0) throw new Error('Proof staging annotation audit returned no check_done event');
  if (checkDone.length !== 1) throw new Error(`Proof staging annotation audit returned ${checkDone.length} check_done events; expected exactly one`);
  const done = checkDone[0];
  if (done.stage !== 'implement' || done.check !== 'annotation_validity') {
    throw new Error('Proof staging annotation audit returned an unexpected check_done target');
  }
  if (done.status !== 'pass') {
    throw new Error(`Proof staging annotation audit check_done is not pass: ${String(done.status)}`);
  }
}

function commandDetail(result: CommandResult): string {
  return [result.stderr, result.stdout].filter(Boolean).join('\n').slice(0, 3000);
}

function realDirectory(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  const resolved = fs.realpathSync(value);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`${label} is not a directory`);
  return resolved;
}

function ensureRelativePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const normalized = path.posix.normalize(value.replaceAll(path.sep, '/'));
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`${label} escapes the project root: ${value}`);
  }
  return normalized;
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function lstatOrUndefined(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

function verifyExistingParent(root: string, relativePath: string, label: string): string {
  const verifiedRoot = fs.realpathSync(root);
  const absolute = path.join(verifiedRoot, relativePath);
  let parent = path.dirname(absolute);
  while (parent !== verifiedRoot && !lstatOrUndefined(parent)) {
    const next = path.dirname(parent);
    if (next === parent) throw new Error(`${label} has no existing parent: ${relativePath}`);
    parent = next;
  }
  if (!inside(parent, verifiedRoot)) throw new Error(`${label} escapes its checkout: ${relativePath}`);
  const realParent = fs.realpathSync(parent);
  if (!inside(realParent, verifiedRoot)) throw new Error(`${label} has a symlink-parent escape: ${relativePath}`);
  return realParent;
}

function pathIsAbsoluteLink(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function fileSnapshot(root: string, relativePath: string): FileSnapshot | undefined {
  const absolute = path.join(root, relativePath);
  const details = lstatOrUndefined(absolute);
  if (!details) return undefined;
  if (details.isSymbolicLink()) return {kind: 'symlink', linkText: fs.readlinkSync(absolute)};
  if (details.isFile()) return {kind: 'file', bytes: fs.readFileSync(absolute)};
  throw new Error(`native path is not a regular file or symlink: ${relativePath}`);
}

function gitSnapshotAtCommit(root: string, commit: string, relativePath: string): FileSnapshot | undefined {
  const treeResult = spawnSync('git', ['-C', root, 'ls-tree', '-z', commit, '--', relativePath], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'buffer',
  });
  if (treeResult.status !== 0) return undefined;
  const record = Buffer.from(treeResult.stdout || '').toString('utf8').split('\0')[0];
  const tab = record.indexOf('\t');
  if (tab < 0) return undefined;
  const mode = record.slice(0, tab).split(' ')[0];
  const bytes = gitFileAtCommit(root, commit, relativePath);
  if (bytes === undefined) return undefined;
  if (mode === '120000') return {kind: 'symlink', linkText: bytes.toString('utf8')};
  return {kind: 'file', bytes};
}

function snapshotsEqual(left: FileSnapshot | undefined, right: FileSnapshot | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === 'symlink') return left.linkText === right.linkText;
  return buffersEqual(left.bytes, right.bytes);
}

function fileHash(file: string): string {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function gitFileAtCommit(root: string, commit: string, relativePath: string): Buffer | undefined {
  const result = spawnSync('git', ['-C', root, 'show', `${commit}:${relativePath}`], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'buffer',
  });
  if (result.status !== 0) return undefined;
  return Buffer.from(result.stdout || '');
}

function buffersEqual(left: Buffer | undefined, right: Buffer | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.equals(right);
}

function isPrivateProofPath(relativePath: string): boolean {
  return new Set([
    '.proof/index.db',
    '.proof/index.db-wal',
    '.proof/index.db-shm',
  ]).has(relativePath);
}

function isProtectedPath(relativePath: string): boolean {
  if (relativePath === '.gitignore' || relativePath === 'proof.yaml') return true;
  if (relativePath === 'package.json' || relativePath === 'package-lock.json') return true;
  if (relativePath === 'go.mod' || relativePath === 'go.sum') return true;
  if (relativePath === 'Cargo.toml' || relativePath === 'Cargo.lock') return true;
  if (relativePath === 'pyproject.toml' || relativePath === 'requirements.txt') return true;
  if (relativePath.startsWith('.github/') || relativePath.startsWith('.visor/')) return true;
  // Shared checklists, audits, and global Proof artifacts remain central.
  return relativePath === 'proof' || relativePath.startsWith('proof/');
}

function parseNulStatus(output: string): ChangedPath[] {
  const tokens = output.split('\0');
  const changed: ChangedPath[] = [];
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index];
    index += 1;
    if (token === '') continue;
    if (/^[A-Z][0-9]*$/.test(token)) {
      const status = token;
      const firstPath = tokens[index++];
      if (!firstPath) throw new Error(`Git ${status} entry is missing its path`);
      if (status.startsWith('R') || status.startsWith('C')) {
        const secondPath = tokens[index++];
        if (!secondPath) throw new Error(`Git ${status} entry is missing its destination path`);
        changed.push({path: ensureRelativePath(secondPath, 'renamed destination'), status, oldPath: ensureRelativePath(firstPath, 'renamed source')});
      } else {
        changed.push({path: ensureRelativePath(firstPath, 'changed path'), status});
      }
      continue;
    }
    if (/^[ MADRCU?!]{2} /.test(token)) {
      const xy = token.slice(0, 2);
      const status = xy.trim() || xy;
      const firstPath = ensureRelativePath(token.slice(3), 'changed path');
      if (xy.includes('R') || xy.includes('C')) {
        const secondPath = tokens[index++];
        if (!secondPath) throw new Error(`Git ${status} entry is missing its source path`);
        changed.push({path: firstPath, status, oldPath: ensureRelativePath(secondPath, 'renamed source')});
      } else {
        changed.push({path: firstPath, status});
      }
      continue;
    }
  }
  return changed;
}

function changedPaths(root: string, baselineCommit: string): ChangedPath[] {
  const tracked = git(root, ['diff', '--name-status', '-z', '--find-renames=100%', baselineCommit], true);
  const untracked = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], true);
  const result = [...parseNulStatus(tracked), ...parseNulStatus(untracked)];
  const unique = new Map<string, ChangedPath>();
  for (const entry of result) unique.set(`${entry.status}:${entry.path}:${entry.oldPath || ''}`, entry);
  return [...unique.values()];
}

interface TraceAnnotationScannerFile {
  path: string;
  baseline: string;
  current: string;
}

interface TraceAnnotationScannerResult {
  allowed?: boolean;
  reason?: string;
}

function traceAnnotationScannerPath(): string {
  const helperDirectory = fs.realpathSync(__dirname);
  const expected = path.join(helperDirectory, TRACE_ANNOTATION_SCANNER_FILENAME);
  const helperStat = lstatOrUndefined(expected);
  if (!helperStat || !helperStat.isFile() || helperStat.isSymbolicLink()) {
    throw new Error(`bounded trace annotation scanner is unavailable: ${expected}`);
  }
  const helper = fs.realpathSync(expected);
  if (helper !== expected) {
    throw new Error(`bounded trace annotation scanner is not the fixed helper: ${expected}`);
  }
  return helper;
}

function runTraceAnnotationScanner(
  canonicalRoot: string,
  baselineCommit: string,
  writerRoot: string,
  sourcePaths: readonly string[],
  requirementRows: readonly Json[],
  timeoutMs: number
): void {
  const helper = traceAnnotationScannerPath();
  const requirementIds = [...new Set(requirementRows
    .map(row => row.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const files: TraceAnnotationScannerFile[] = sourcePaths.map(relativePath => {
    const baseline = gitSnapshotAtCommit(canonicalRoot, baselineCommit, relativePath);
    const current = fileSnapshot(writerRoot, relativePath);
    if (!baseline || baseline.kind !== 'file' || !current || current.kind !== 'file' || !baseline.bytes || !current.bytes) {
      throw new Error(`trace source ${relativePath} must remain an existing regular Go file at both baselines`);
    }
    return {
      path: relativePath,
      baseline: baseline.bytes.toString('base64'),
      current: current.bytes.toString('base64'),
    };
  });
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-trace-annotation-go-'));
  try {
    const result = spawnSync('go', ['run', helper], {
      cwd: canonicalRoot,
      env: {
        PATH: process.env.PATH || '',
        HOME: cacheRoot,
        TMPDIR: cacheRoot,
        GOPATH: cacheRoot,
        GOCACHE: path.join(cacheRoot, 'cache'),
        GOMODCACHE: path.join(cacheRoot, 'mod'),
        GO111MODULE: 'off',
        GOTOOLCHAIN: 'local',
        GOPROXY: 'off',
        GOSUMDB: 'off',
        CGO_ENABLED: '0',
      },
      input: JSON.stringify({requirement_ids: requirementIds, files}),
      encoding: 'utf8',
      timeout: Math.min(timeoutMs, TRACE_ANNOTATION_SCANNER_TIMEOUT_MS),
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `bounded trace annotation scanner failed with exit ${typeof result.status === 'number' ? result.status : 'unknown'}: ${
          String(result.stderr || result.error?.message || result.stdout || '')
        }`.trim()
      );
    }
    let report: TraceAnnotationScannerResult;
    try {
      report = JSON.parse(String(result.stdout || '')) as TraceAnnotationScannerResult;
    } catch (error) {
      throw new Error(`bounded trace annotation scanner returned non-JSON output: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!report || report.allowed !== true) {
      throw new Error(`trace source policy rejected the writer delta: ${report?.reason || 'scanner did not approve the source bytes'}`);
    }
  } finally {
    fs.rmSync(cacheRoot, {recursive: true, force: true});
  }
}

function traceSourceStatusViolation(
  canonicalRoot: string,
  baselineCommit: string,
  writerRoot: string,
  entry: ChangedPath
): string | undefined {
  if (entry.status !== 'M') return 'source changes must be an exact Git modification (M)';
  const baseline = gitSnapshotAtCommit(canonicalRoot, baselineCommit, entry.path);
  if (!baseline || baseline.kind !== 'file' || !baseline.bytes) {
    return 'source baseline must be an existing regular Go file';
  }
  const currentPath = path.join(writerRoot, entry.path);
  const currentStat = lstatOrUndefined(currentPath);
  if (!currentStat?.isFile() || currentStat.isSymbolicLink()) {
    return 'source current path must be an existing regular Go file';
  }
  return undefined;
}

function rows(value: unknown, label: string): Json[] {
  if (!Array.isArray(value)) throw new Error(`${label} did not return a JSON array`);
  return value.filter(item => Boolean(item && typeof item === 'object')) as Json[];
}

function requirementRowForPath(surface: NativeSurface, relativePath: string, componentId: string): Json {
  const row = surface.requirementByPath.get(relativePath);
  if (!row || row.component !== componentId || typeof row.id !== 'string') {
    throw new Error(`requirement file ${relativePath} is not owned by component ${componentId} in Proof req list`);
  }
  return row;
}

function canonicalRequirementOwned(
  proofBin: string,
  canonicalRoot: string,
  surface: NativeSurface,
  relativePath: string,
  componentId: string,
  timeoutMs: number
): boolean {
  const row = surface.requirementByPath.get(relativePath);
  if (!row || row.component !== componentId || typeof row.id !== 'string') return false;
  try {
    const show = proof(proofBin, canonicalRoot, ['req', 'show', row.id, '--with', 'file', '--format', 'json'], timeoutMs);
    const value = parseProofJson(show, `Proof canonical req show ${row.id}`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const requirement = (value as Json).requirement;
    if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement)) return false;
    return (value as Json).file_path === relativePath && (requirement as Json).component === componentId;
  } catch {
    return false;
  }
}

function collectNativeSurface(
  proofBin: string,
  cwd: string,
  componentId: string,
  timeoutMs: number
): {surface: NativeSurface; diagnostics: {reqList: CommandResult; varList: CommandResult; varDiagnose: CommandResult}} {
  const reqList = proof(proofBin, cwd, ['req', 'list', '--component', componentId, '--format', 'json'], timeoutMs);
  const requirementRows = rows(parseProofJson(reqList, `Proof req list for ${componentId}`), 'Proof req list');
  const requirementFiles = new Set<string>();
  const requirementByPath = new Map<string, Json>();
  for (const row of requirementRows) {
    if (typeof row.id !== 'string' || typeof row.file_path !== 'string') continue;
    const filePath = ensureRelativePath(row.file_path, 'Proof requirement file path');
    requirementFiles.add(filePath);
    requirementByPath.set(filePath, row);
  }

  const varList = proof(proofBin, cwd, ['var', 'list', componentId, '--format', 'json'], timeoutMs);
  const varDiagnose = proof(
    proofBin,
    cwd,
    ['var', 'diagnose', componentId, '--no-download', '--format', 'json'],
    timeoutMs
  );
  const variableFiles = new Set<string>();
  if (varList.status === 0) {
    for (const row of rows(parseProofJson(varList, `Proof var list for ${componentId}`), 'Proof var list')) {
      if (typeof row.file === 'string') variableFiles.add(ensureRelativePath(row.file, 'Proof variable file path'));
    }
  }
  if (varDiagnose.status === 0) {
    const value = parseProofJson(varDiagnose, `Proof var diagnose for ${componentId}`);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const variableRows = (value as Json).variables;
      if (Array.isArray(variableRows)) {
        for (const row of variableRows) {
          if (row && typeof row === 'object' && typeof (row as Json).file === 'string') {
            variableFiles.add(ensureRelativePath((row as Json).file, 'Proof diagnosed variable file path'));
          }
        }
      }
    }
  }
  return {
    surface: {requirementRows, requirementFiles, requirementByPath, variableFiles},
    diagnostics: {reqList, varList, varDiagnose},
  };
}

function isVariablePath(relativePath: string): boolean {
  return relativePath.endsWith('.vars.yaml') || relativePath.endsWith('.vars.yml');
}

function inspectVariableAlias(
  root: string,
  relativePath: string,
  componentId: string,
  surface: NativeSurface
): VariableAlias | undefined {
  const source = path.join(root, relativePath);
  const sourceStat = lstatOrUndefined(source);
  if (!sourceStat?.isSymbolicLink()) return undefined;
  verifyExistingParent(root, relativePath, 'variable alias source');
  const linkText = fs.readlinkSync(source);
  if (!linkText || linkText.includes('\0') || pathIsAbsoluteLink(linkText)) {
    throw new Error(`Proof variable alias ${relativePath} must use a relative target`);
  }
  const targetAbsolute = path.resolve(path.dirname(source), linkText);
  if (!inside(targetAbsolute, root)) {
    throw new Error(`Proof variable alias ${relativePath} escapes the writer checkout`);
  }
  const targetPath = ensureRelativePath(path.relative(root, targetAbsolute), 'Proof variable alias target');
  if (!isVariablePath(targetPath)) {
    throw new Error(`Proof variable alias ${relativePath} target is not a .vars.yaml/.vars.yml file`);
  }
  if (!surface.variableFiles.has(relativePath)) {
    throw new Error(`Proof variable alias ${relativePath} is not an owned variable projection for component ${componentId}`);
  }
  if (!surface.variableFiles.has(targetPath)) {
    throw new Error(`Proof variable alias ${relativePath} target is not owned by component ${componentId}`);
  }
  verifyExistingParent(root, targetPath, 'variable alias target');
  const target = path.join(root, targetPath);
  const targetStat = lstatOrUndefined(target);
  if (!targetStat?.isFile()) {
    throw new Error(`Proof variable alias ${relativePath} target is not an existing regular file`);
  }
  const targetReal = fs.realpathSync(target);
  if (!inside(targetReal, root)) {
    throw new Error(`Proof variable alias ${relativePath} target escapes the writer checkout`);
  }
  return {targetPath, linkText};
}

function canonicalVariableTargetUnchanged(
  canonicalRoot: string,
  baselineCommit: string,
  canonicalSurface: NativeSurface,
  targetPath: string
): boolean {
  if (!canonicalSurface.variableFiles.has(targetPath)) return false;
  verifyExistingParent(canonicalRoot, targetPath, 'canonical variable target');
  const baseline = gitSnapshotAtCommit(canonicalRoot, baselineCommit, targetPath);
  const current = fileSnapshot(canonicalRoot, targetPath);
  if (!baseline || baseline.kind !== 'file' || !current || current.kind !== 'file') return false;
  return snapshotsEqual(baseline, current);
}

function validateVariableAliasTarget(
  alias: VariableAlias,
  changedVariablePaths: Set<string>,
  canonicalRoot: string,
  baselineCommit: string,
  canonicalSurface: NativeSurface
): void {
  if (changedVariablePaths.has(alias.targetPath)) return;
  if (!canonicalVariableTargetUnchanged(canonicalRoot, baselineCommit, canonicalSurface, alias.targetPath)) {
    throw new Error(`Proof variable alias target ${alias.targetPath} is not selected in this delta or unchanged native-owned canonical data`);
  }
}

function verifyGitRoot(root: string, label: string): string {
  const resolved = realDirectory(root, label);
  const gitRoot = realDirectory(git(resolved, ['rev-parse', '--show-toplevel']), `${label} Git root`);
  if (gitRoot !== resolved) throw new Error(`${label} must be the checkout Git root`);
  if (git(resolved, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    throw new Error(`${label} is not an inside-work-tree checkout`);
  }
  return resolved;
}

function verifyWriterCheckout(input: NativePromotionInput, canonicalRoot: string): string {
  const output = input.writerCheckout;
  if (!output || output.is_worktree !== true || typeof output.worktree_id !== 'string' || !output.worktree_id) {
    throw new Error('writer checkout output is not a verified worktree result');
  }
  const writerRoot = verifyGitRoot(output.path, 'writer checkout');
  if (writerRoot === canonicalRoot || inside(writerRoot, canonicalRoot) || inside(canonicalRoot, writerRoot)) {
    throw new Error('writer checkout must be disjoint from the canonical integration root');
  }
  const writerCommit = git(writerRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (writerCommit !== input.baselineCommit || output.commit !== input.baselineCommit) {
    throw new Error('writer checkout commit is stale or does not match the native baseline commit');
  }
  return writerRoot;
}

function copySelectedFiles(
  sourceRoot: string,
  stagingRoot: string,
  acceptedPaths: string[],
  variableAliases: Map<string, VariableAlias>
): void {
  for (const relativePath of acceptedPaths) {
    const source = path.join(sourceRoot, relativePath);
    const destination = path.join(stagingRoot, relativePath);
    verifyExistingParent(sourceRoot, relativePath, 'selected writer path');
    verifyExistingParent(stagingRoot, relativePath, 'staging destination');
    const sourceStat = lstatOrUndefined(source);
    if (!sourceStat) throw new Error(`selected writer path disappeared: ${relativePath}`);
    const destinationStat = lstatOrUndefined(destination);
    const alias = variableAliases.get(relativePath);
    if (sourceStat.isSymbolicLink()) {
      if (!alias) throw new Error(`selected writer symlink is not an approved variable alias: ${relativePath}`);
      const linkText = fs.readlinkSync(source);
      if (linkText !== alias.linkText) throw new Error(`selected variable alias changed before staging: ${relativePath}`);
      if (destinationStat?.isDirectory()) throw new Error(`staging destination is a directory: ${relativePath}`);
      if (destinationStat) fs.unlinkSync(destination);
      fs.mkdirSync(path.dirname(destination), {recursive: true});
      fs.symlinkSync(linkText, destination);
      continue;
    }
    if (!sourceStat.isFile()) throw new Error(`selected writer path is not a regular file: ${relativePath}`);
    if (alias) throw new Error(`selected variable alias is no longer a symlink: ${relativePath}`);
    if (destinationStat?.isSymbolicLink()) throw new Error(`staging destination is a symlink: ${relativePath}`);
    if (destinationStat?.isDirectory()) throw new Error(`staging destination is a directory: ${relativePath}`);
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.copyFileSync(source, destination);
  }
}

function validateStaging(
  proofBin: string,
  stagingRoot: string,
  componentId: string,
  acceptedPaths: string[],
  variableAliases: Map<string, VariableAlias>,
  timeoutMs: number
): {validation: CommandResult; surface: NativeSurface} {
  const verifiedStagingRoot = verifyGitRoot(stagingRoot, 'native promotion staging root');
  const collected = collectNativeSurface(proofBin, verifiedStagingRoot, componentId, timeoutMs);
  for (const relativePath of acceptedPaths) {
    const alias = variableAliases.get(relativePath);
    if (alias) {
      const stagedAlias = inspectVariableAlias(verifiedStagingRoot, relativePath, componentId, collected.surface);
      if (!stagedAlias || stagedAlias.targetPath !== alias.targetPath || stagedAlias.linkText !== alias.linkText) {
        throw new Error(`staged Proof variable alias changed for ${relativePath}`);
      }
      continue;
    }
    if (relativePath.endsWith('.req.yaml') || relativePath.endsWith('.req.yml')) {
      const row = requirementRowForPath(collected.surface, relativePath, componentId);
      const show = proof(proofBin, verifiedStagingRoot, ['req', 'show', String(row.id), '--with', 'file', '--format', 'json'], timeoutMs);
      const value = parseProofJson(show, `Proof req show ${String(row.id)} in staging`);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Proof req show ${String(row.id)} in staging is not an object`);
      const requirement = (value as Json).requirement;
      if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement)) throw new Error(`Proof req show ${String(row.id)} has no requirement object`);
      const req = requirement as Json;
      const shownPath = (value as Json).file_path;
      const shownComponent = req.component;
      const hash = (req._computed as Json | undefined)?.file_hash;
      if (shownPath !== relativePath || shownComponent !== componentId || typeof hash !== 'string' || !SHA256_FILE_HASH.test(hash)) {
        throw new Error(`Proof req show ${String(row.id)} does not prove the staged component/file ownership`);
      }
      if (hash !== fileHash(path.join(verifiedStagingRoot, relativePath))) {
        throw new Error(`staged Proof requirement hash changed for ${relativePath}`);
      }
    }
    if (isVariablePath(relativePath)) {
      if (!collected.surface.variableFiles.has(relativePath)) {
        throw new Error(`staged Proof variable file ${relativePath} is not owned by component ${componentId}`);
      }
    }
  }
  const validation = proof(proofBin, verifiedStagingRoot, ['validate', '--format', 'json', '--variable-drift'], timeoutMs);
  if (validation.status !== 0) return {validation, surface: collected.surface};
  parseProofJson(validation, 'Proof validation in staging');
  const status = proof(proofBin, verifiedStagingRoot, ['status', '--format', 'json'], timeoutMs);
  if (status.status !== 0) {
    return {
      validation: {
        status: status.status,
        stdout: status.stdout,
        stderr: `Proof status failed after validation: ${status.stderr}`,
      },
      surface: collected.surface,
    };
  }
  parseProofJson(status, 'Proof status in staging');
  return {validation, surface: collected.surface};
}

function assertCanonicalStillBaseline(
  canonicalRoot: string,
  canonicalCommit: string,
  canonicalTree: string
): void {
  if (git(canonicalRoot, ['rev-parse', '--verify', 'HEAD^{commit}']) !== canonicalCommit) {
    throw new Error('canonical integration root advanced during promotion; refusing to write');
  }
  if (git(canonicalRoot, ['rev-parse', 'HEAD^{tree}']) !== canonicalTree) {
    throw new Error('canonical integration tree changed during promotion; refusing to write');
  }
  if (git(canonicalRoot, ['status', '--porcelain', '--untracked-files=all'])) {
    throw new Error('canonical integration root became dirty during promotion; refusing to write');
  }
}

function applyAcceptedFiles(
  input: NativePromotionInput,
  canonicalRoot: string,
  stagingRoot: string,
  acceptedPaths: string[],
  variableAliases: Map<string, VariableAlias>,
  canonicalCommit: string,
  canonicalTree: string,
  markApplicationStarted: () => void
): string {
  assertCanonicalStillBaseline(canonicalRoot, canonicalCommit, canonicalTree);
  for (const relativePath of acceptedPaths) {
    const stagedFile = path.join(stagingRoot, relativePath);
    verifyExistingParent(stagingRoot, relativePath, 'staged selected path');
    const stagedStat = lstatOrUndefined(stagedFile);
    if (!stagedStat || (!stagedStat.isFile() && !stagedStat.isSymbolicLink())) {
      throw new Error(`staged selected path disappeared before promotion: ${relativePath}`);
    }
    if (stagedStat.isSymbolicLink() && !variableAliases.has(relativePath)) {
      throw new Error(`staged selected path is an unapproved symlink: ${relativePath}`);
    }
    verifyExistingParent(canonicalRoot, relativePath, 'canonical promotion destination');
  }
  markApplicationStarted();
  for (const relativePath of acceptedPaths) {
    const destination = path.join(canonicalRoot, relativePath);
    const stagedFile = path.join(stagingRoot, relativePath);
    const stagedStat = fs.lstatSync(stagedFile);
    const destinationStat = lstatOrUndefined(destination);
    if (stagedStat.isSymbolicLink()) {
      if (!variableAliases.has(relativePath)) throw new Error(`canonical source is an unapproved symlink: ${relativePath}`);
      if (destinationStat?.isDirectory()) throw new Error(`canonical destination is a directory: ${relativePath}`);
      if (destinationStat) fs.unlinkSync(destination);
      fs.mkdirSync(path.dirname(destination), {recursive: true});
      fs.symlinkSync(fs.readlinkSync(stagedFile), destination);
      continue;
    }
    if (destinationStat?.isSymbolicLink()) {
      throw new Error(`canonical destination is a symlink: ${relativePath}`);
    }
    if (destinationStat?.isDirectory()) {
      throw new Error(`canonical destination is a directory: ${relativePath}`);
    }
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.copyFileSync(stagedFile, destination);
  }
  execFileSync('git', ['-C', canonicalRoot, 'add', '--', ...acceptedPaths], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (input.commitAcceptedArtifacts !== false) {
    execFileSync(
      'git',
      ['-C', canonicalRoot, 'commit', '--no-verify', '-m', `promote native ${input.workItem.component_id} artifacts`],
      {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}
    );
  }
  return git(canonicalRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
}

/**
 * Validate and promote one component's native delta.
 *
 * This function returns a rejection result for expected stale/ownership/
 * validation failures and leaves the canonical root untouched on those paths.
 */
export function promoteNativeDelta(input: NativePromotionInput): NativePromotionResult {
  const ignoredPaths: string[] = [];
  let applicationStarted = false;
  try {
    if (!input || !input.workItem || typeof input.workItem.component_id !== 'string' || !input.workItem.component_id) {
      throw new Error('native promotion requires a component work item');
    }
    if (!Array.isArray(input.workItem.sorted_owned_paths) || input.workItem.sorted_owned_paths.length === 0) {
      throw new Error('native promotion requires non-empty sorted_owned_paths');
    }
    if (!input.workItem.proof_component_subject || typeof input.workItem.proof_component_subject.fingerprint !== 'string' || !SHA256_FILE_HASH.test(input.workItem.proof_component_subject.fingerprint)) {
      throw new Error('native promotion requires the Proof component subject fingerprint');
    }
    if (input.sourceWritePolicy !== undefined && input.sourceWritePolicy !== 'go-trace-annotations-only') {
      throw new Error(`unsupported native source write policy: ${String(input.sourceWritePolicy)}`);
    }
    if (!path.isAbsolute(input.proofBin) || !fs.existsSync(input.proofBin) || (fs.statSync(input.proofBin).mode & 0o111) === 0) {
      throw new Error('proofBin must be an absolute executable');
    }
    const timeoutMs = input.timeoutMs || DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) throw new Error('timeoutMs must be a positive millisecond integer');

    const canonicalRoot = verifyGitRoot(input.canonicalRoot, 'canonical integration root');
    const baselineCommit = git(canonicalRoot, ['rev-parse', '--verify', `${input.baselineCommit}^{commit}`]);
    if (baselineCommit !== input.baselineCommit) throw new Error('baselineCommit is not a full commit SHA');
    if (git(canonicalRoot, ['status', '--porcelain', '--untracked-files=all'])) {
      throw new Error('canonical integration root must be clean before promotion');
    }
    const canonicalCommit = git(canonicalRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const canonicalTree = git(canonicalRoot, ['rev-parse', `${canonicalCommit}^{tree}`]);
    const writerRoot = verifyWriterCheckout(input, canonicalRoot);
    const workItemPaths = new Set(input.workItem.sorted_owned_paths.map((value, index) => ensureRelativePath(value, `work item owned path ${index}`)));
    const changed = changedPaths(writerRoot, input.baselineCommit);
    const rejectedPaths: string[] = [];
    const acceptedPaths: string[] = [];
    const reqCandidates: string[] = [];
    const checklistRefreshRejections: string[] = [];
    const canonicalChecklistPaths = new Set<string>();
    const sourcePolicyRejections: string[] = [];
    let activeChecklist: string | undefined;
    let checklistStatus: unknown;
    const classifyWriterChecklistPath = (relativePath: string, gitStatus: string): NativeChecklistRefreshClassification => {
      if (!/^proof\/checklists\/[^/]+\.state\.ya?ml$/.test(relativePath)) return {kind: 'not-applicable'};
      if (checklistStatus === undefined) {
        const show = proof(input.proofBin, canonicalRoot, ['checklist', 'show', '--format', 'json'], timeoutMs);
        checklistStatus = parseProofJson(show, 'Proof active checklist show');
        activeChecklist = activeChecklistNameFromProofShow(checklistStatus);
      }
      const expected = activeChecklist;
      if (!expected) return {kind: 'rejected', reason: 'Proof active checklist is unavailable'};
      const baselineSnapshot = gitSnapshotAtCommit(canonicalRoot, input.baselineCommit, relativePath);
      const currentSnapshot = fileSnapshot(writerRoot, relativePath);
      return classifyNonAuthoritativeChecklistRefresh({
        expectedChecklist: expected,
        path: relativePath,
        gitStatus,
        baseline: baselineSnapshot
          ? baselineSnapshot.kind === 'symlink'
            ? {kind: 'symlink', linkText: baselineSnapshot.linkText || ''}
            : {kind: 'file', bytes: baselineSnapshot.bytes || Buffer.alloc(0)}
          : {kind: 'missing'},
        current: currentSnapshot
          ? currentSnapshot.kind === 'symlink'
            ? {kind: 'symlink', linkText: currentSnapshot.linkText || ''}
            : {kind: 'file', bytes: currentSnapshot.bytes || Buffer.alloc(0)}
          : {kind: 'missing'},
      });
    };
    for (const entry of changed) {
      verifyExistingParent(writerRoot, entry.path, 'writer delta path');
      const isProofNativeArtifact = entry.path.endsWith('.req.yaml') || entry.path.endsWith('.req.yml') || isVariablePath(entry.path);
      if (input.sourceWritePolicy === 'go-trace-annotations-only' && workItemPaths.has(entry.path) && !isProofNativeArtifact && !entry.path.endsWith('.go')) {
        rejectedPaths.push(entry.path);
        sourcePolicyRejections.push(`${entry.path}: owned source changes must target a .go file`);
        continue;
      }
      if (input.sourceWritePolicy === 'go-trace-annotations-only' && entry.path.endsWith('.go') && workItemPaths.has(entry.path)) {
        const violation = traceSourceStatusViolation(canonicalRoot, input.baselineCommit, writerRoot, entry);
        if (violation) {
          rejectedPaths.push(entry.path);
          sourcePolicyRejections.push(`${entry.path}: ${violation}`);
          continue;
        }
      }
      if (entry.status.startsWith('D') || entry.status.startsWith('R') || entry.status.startsWith('C')) {
        rejectedPaths.push(entry.path);
        continue;
      }
      if (isPrivateProofPath(entry.path)) {
        ignoredPaths.push(entry.path);
        continue;
      }
      if (entry.path.startsWith('proof/')) {
        const refresh = classifyWriterChecklistPath(entry.path, entry.status);
        if (refresh.kind === 'ignored') {
          ignoredPaths.push(refresh.path);
          canonicalChecklistPaths.add(refresh.path);
        } else if (refresh.kind === 'rejected') {
          rejectedPaths.push(entry.path);
          checklistRefreshRejections.push(`${entry.path}: ${refresh.reason}`);
        } else {
          rejectedPaths.push(entry.path);
        }
        continue;
      }
      if (isProtectedPath(entry.path)) {
        rejectedPaths.push(entry.path);
        continue;
      }
      if (entry.path.endsWith('.req.yaml') || entry.path.endsWith('.req.yml')) {
        reqCandidates.push(entry.path);
        continue;
      }
      if (isVariablePath(entry.path)) {
        // Proof var list/diagnose establish ownership below.
        continue;
      }
      if (workItemPaths.has(entry.path)) {
        acceptedPaths.push(entry.path);
        continue;
      }
      rejectedPaths.push(entry.path);
    }
    if (rejectedPaths.length) {
      const reason = sourcePolicyRejections.length
        ? `writer delta violates the bounded Go trace source policy: ${sourcePolicyRejections.join('; ')}`
        : checklistRefreshRejections.length
        ? `writer delta contains a rejected checklist refresh: ${checklistRefreshRejections.join('; ')}`
        : 'writer delta contains deleted, renamed, protected, sibling, or out-of-scope paths';
      return rejected(input, reason, [], ignoredPaths, rejectedPaths);
    }

    const componentId = input.workItem.component_id;
    const writerSurface = collectNativeSurface(input.proofBin, writerRoot, componentId, timeoutMs).surface;
    const canonicalSurface = collectNativeSurface(input.proofBin, canonicalRoot, componentId, timeoutMs).surface;
    const sourcePaths = changed
      .filter(entry => entry.path.endsWith('.go') && workItemPaths.has(entry.path))
      .map(entry => entry.path);
    if (input.sourceWritePolicy === 'go-trace-annotations-only') {
      try {
        runTraceAnnotationScanner(
          canonicalRoot,
          input.baselineCommit,
          writerRoot,
          sourcePaths,
          writerSurface.requirementRows,
          timeoutMs
        );
      } catch (error) {
        return rejected(
          input,
          error instanceof Error ? error.message : String(error),
          [],
          ignoredPaths,
          sourcePaths
        );
      }
    }
    for (const relativePath of reqCandidates) {
      const row = requirementRowForPath(writerSurface, relativePath, componentId);
      const show = proof(input.proofBin, writerRoot, ['req', 'show', String(row.id), '--with', 'file', '--format', 'json'], timeoutMs);
      const value = parseProofJson(show, `Proof req show ${String(row.id)}`);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Proof req show ${String(row.id)} is not an object`);
      const requirement = (value as Json).requirement;
      if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement)) throw new Error(`Proof req show ${String(row.id)} has no requirement object`);
      const req = requirement as Json;
      const hash = (req._computed as Json | undefined)?.file_hash;
      if ((value as Json).file_path !== relativePath || req.component !== componentId || typeof hash !== 'string' || !SHA256_FILE_HASH.test(hash)) {
        throw new Error(`Proof req show ${String(row.id)} does not match component/file ownership`);
      }
      if (hash !== fileHash(path.join(writerRoot, relativePath))) {
        throw new Error(`Proof req show ${String(row.id)} file hash does not match writer bytes`);
      }
      acceptedPaths.push(relativePath);
    }
    const variableCandidates = changed.filter(entry => isVariablePath(entry.path)).map(entry => entry.path);
    const variableFiles = writerSurface.variableFiles;
    const changedVariablePaths = new Set(variableCandidates);
    const variableAliases = new Map<string, VariableAlias>();
    for (const relativePath of variableCandidates) {
      const source = path.join(writerRoot, relativePath);
      const sourceStat = lstatOrUndefined(source);
      if (!sourceStat) {
        return rejected(input, `selected writer variable path disappeared: ${relativePath}`, [], ignoredPaths, [relativePath]);
      }
      if (sourceStat.isSymbolicLink()) {
        try {
          const alias = inspectVariableAlias(writerRoot, relativePath, componentId, writerSurface);
          if (!alias) throw new Error(`Proof variable alias ${relativePath} is not a symlink`);
          validateVariableAliasTarget(
            alias,
            changedVariablePaths,
            canonicalRoot,
            input.baselineCommit,
            canonicalSurface
          );
          variableAliases.set(relativePath, alias);
        } catch (error) {
          return rejected(input, error instanceof Error ? error.message : String(error), [], ignoredPaths, [relativePath]);
        }
      } else if (!sourceStat.isFile() || !variableFiles.has(relativePath)) {
        return rejected(input, `Proof variable list/diagnose does not prove ownership of ${relativePath}`, [], ignoredPaths, [relativePath]);
      }
      acceptedPaths.push(relativePath);
    }
    const dedupedAccepted = [...new Set(acceptedPaths)];
    if (!dedupedAccepted.length) {
      return rejected(input, 'writer delta contains no promotable native authored files', [], ignoredPaths, []);
    }
    const preOwnerRejectedPaths: string[] = [];
    for (const relativePath of [...reqCandidates, ...variableCandidates]) {
      if (gitFileAtCommit(canonicalRoot, input.baselineCommit, relativePath) === undefined) continue;
      const writerSource = path.join(writerRoot, relativePath);
      const ownedBeforeWriterEdit = relativePath.endsWith('.req.yaml') || relativePath.endsWith('.req.yml')
        ? canonicalRequirementOwned(input.proofBin, canonicalRoot, canonicalSurface, relativePath, componentId, timeoutMs)
        : lstatOrUndefined(writerSource)?.isSymbolicLink()
          ? Boolean(inspectVariableAlias(canonicalRoot, relativePath, componentId, canonicalSurface))
          : canonicalSurface.variableFiles.has(relativePath);
      if (!ownedBeforeWriterEdit) {
        preOwnerRejectedPaths.push(relativePath);
      }
    }
    if (preOwnerRejectedPaths.length) {
      return rejected(
        input,
        `existing native paths were not already owned by component ${componentId} at the writer baseline`,
        [],
        ignoredPaths,
        preOwnerRejectedPaths
      );
    }

    for (const relativePath of dedupedAccepted) {
      const baselineSnapshot = gitSnapshotAtCommit(canonicalRoot, input.baselineCommit, relativePath);
      const canonicalSnapshot = fileSnapshot(canonicalRoot, relativePath);
      if (!snapshotsEqual(baselineSnapshot, canonicalSnapshot)) {
        return rejected(
          input,
          `canonical path ${relativePath} changed after writer baseline; refusing conflicting promotion`,
          [],
          ignoredPaths,
          [relativePath]
        );
      }
    }

    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-native-promotion-'));
    try {
      execFileSync('git', ['clone', '--no-hardlinks', '--quiet', canonicalRoot, stagingRoot], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      copySelectedFiles(writerRoot, stagingRoot, dedupedAccepted, variableAliases);
      const staged = validateStaging(input.proofBin, stagingRoot, componentId, dedupedAccepted, variableAliases, timeoutMs);
      const validation = {
        status: staged.validation.status,
        stdout: staged.validation.stdout,
        stderr: staged.validation.stderr,
      };
      if (staged.validation.status !== 0) {
        return rejected(input, `Proof staging validation failed with exit ${staged.validation.status}: ${commandDetail(staged.validation)}`, [], ignoredPaths, [], validation);
      }
      if (input.sourceWritePolicy === 'go-trace-annotations-only') {
        const audit = proof(
          input.proofBin,
          stagingRoot,
          ['audit', '--no-cache', '--check', 'annotation_validity', '--format', 'json'],
          timeoutMs
        );
        if (audit.status !== 0) {
          return rejected(
            input,
            `Proof staging annotation audit failed with exit ${audit.status}: ${commandDetail(audit)}`,
            [],
            ignoredPaths,
            [],
            {status: audit.status, stdout: audit.stdout, stderr: audit.stderr}
          );
        }
        parseTraceAnnotationAuditReceipt(audit);
      }
      // Capture central Proof state immediately before the only canonical write
      // boundary. The ignored state file is never part of the staged paths.
      const canonicalChecklistSnapshots = new Map<string, FileSnapshot | undefined>(
        [...canonicalChecklistPaths].map(relativePath => [relativePath, fileSnapshot(canonicalRoot, relativePath)])
      );
      const promotedCommit = applyAcceptedFiles(
        input,
        canonicalRoot,
        stagingRoot,
        dedupedAccepted,
        variableAliases,
        canonicalCommit,
        canonicalTree,
        () => {
          applicationStarted = true;
        }
      );
      for (const [relativePath, before] of canonicalChecklistSnapshots) {
        if (!snapshotsEqual(before, fileSnapshot(canonicalRoot, relativePath))) {
          throw new Error(`canonical checklist state changed during promotion: ${relativePath}`);
        }
      }
      return {
        status: 'promoted',
        accepted_paths: dedupedAccepted,
        ignored_paths: ignoredPaths,
        rejected_paths: [],
        promoted_commit: promotedCommit,
        validation,
        checkpoint: {
          baseline_commit: input.baselineCommit,
          component_id: componentId,
          accepted_paths: dedupedAccepted,
          ignored_paths: ignoredPaths,
          status: 'promoted',
        },
      };
    } finally {
      fs.rmSync(stagingRoot, {recursive: true, force: true});
    }
  } catch (error) {
    if (applicationStarted) {
      throw new Error(
        `native promotion apply interrupted after canonical writes began: ${error instanceof Error ? error.message : String(error)}`,
        {cause: error}
      );
    }
    return rejected(
      input,
      error instanceof Error ? error.message : String(error),
      [],
      ignoredPaths
    );
  }
}
