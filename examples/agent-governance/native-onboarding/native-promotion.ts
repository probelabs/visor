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
import {execFileSync, spawnSync} from 'node:child_process';

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

const DEFAULT_TIMEOUT_MS = 120_000;
const SHA256_FILE_HASH = /^sha256:[0-9a-f]{64}$/;

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

function copySelectedFiles(sourceRoot: string, stagingRoot: string, acceptedPaths: string[]): void {
  for (const relativePath of acceptedPaths) {
    const source = path.join(sourceRoot, relativePath);
    const destination = path.join(stagingRoot, relativePath);
    const sourceStat = fs.lstatSync(source);
    if (!sourceStat.isFile()) throw new Error(`selected writer path is not a regular file: ${relativePath}`);
    if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) {
      throw new Error(`staging destination is a symlink: ${relativePath}`);
    }
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.copyFileSync(source, destination);
  }
}

function validateStaging(
  proofBin: string,
  stagingRoot: string,
  componentId: string,
  acceptedPaths: string[],
  timeoutMs: number
): {validation: CommandResult; surface: NativeSurface} {
  const verifiedStagingRoot = verifyGitRoot(stagingRoot, 'native promotion staging root');
  const collected = collectNativeSurface(proofBin, verifiedStagingRoot, componentId, timeoutMs);
  for (const relativePath of acceptedPaths) {
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
    if (relativePath.endsWith('.vars.yaml') || relativePath.endsWith('.vars.yml')) {
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
  canonicalCommit: string,
  canonicalTree: string,
  markApplicationStarted: () => void
): string {
  assertCanonicalStillBaseline(canonicalRoot, canonicalCommit, canonicalTree);
  for (const relativePath of acceptedPaths) {
    const stagedFile = path.join(stagingRoot, relativePath);
    if (!fs.existsSync(stagedFile) || !fs.lstatSync(stagedFile).isFile()) {
      throw new Error(`staged selected path disappeared before promotion: ${relativePath}`);
    }
  }
  markApplicationStarted();
  for (const relativePath of acceptedPaths) {
    const destination = path.join(canonicalRoot, relativePath);
    if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) {
      throw new Error(`canonical destination is a symlink: ${relativePath}`);
    }
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.copyFileSync(path.join(stagingRoot, relativePath), destination);
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
    for (const entry of changed) {
      if (entry.status.startsWith('D') || entry.status.startsWith('R') || entry.status.startsWith('C')) {
        rejectedPaths.push(entry.path);
        continue;
      }
      if (isPrivateProofPath(entry.path)) {
        ignoredPaths.push(entry.path);
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
      if (entry.path.endsWith('.vars.yaml') || entry.path.endsWith('.vars.yml')) {
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
      return rejected(input, 'writer delta contains deleted, renamed, protected, sibling, or out-of-scope paths', [], ignoredPaths, rejectedPaths);
    }

    const componentId = input.workItem.component_id;
    const writerSurface = collectNativeSurface(input.proofBin, writerRoot, componentId, timeoutMs).surface;
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
    const variableCandidates = changed.filter(entry => entry.path.endsWith('.vars.yaml') || entry.path.endsWith('.vars.yml')).map(entry => entry.path);
    const variableFiles = writerSurface.variableFiles;
    for (const relativePath of variableCandidates) {
      if (!variableFiles.has(relativePath)) {
        return rejected(input, `Proof variable list/diagnose does not prove ownership of ${relativePath}`, [], ignoredPaths, [relativePath]);
      }
      acceptedPaths.push(relativePath);
    }
    const dedupedAccepted = [...new Set(acceptedPaths)];
    if (!dedupedAccepted.length) {
      return rejected(input, 'writer delta contains no promotable native authored files', [], ignoredPaths, []);
    }

    const canonicalSurface = collectNativeSurface(input.proofBin, canonicalRoot, componentId, timeoutMs).surface;
    const preOwnerRejectedPaths: string[] = [];
    for (const relativePath of [...reqCandidates, ...variableCandidates]) {
      if (gitFileAtCommit(canonicalRoot, input.baselineCommit, relativePath) === undefined) continue;
      const ownedBeforeWriterEdit = relativePath.endsWith('.req.yaml') || relativePath.endsWith('.req.yml')
        ? canonicalRequirementOwned(input.proofBin, canonicalRoot, canonicalSurface, relativePath, componentId, timeoutMs)
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
      const baselineBytes = gitFileAtCommit(canonicalRoot, input.baselineCommit, relativePath);
      const canonicalFile = path.join(canonicalRoot, relativePath);
      const canonicalBytes = fs.existsSync(canonicalFile) ? fs.readFileSync(canonicalFile) : undefined;
      if (!buffersEqual(baselineBytes, canonicalBytes)) {
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
      copySelectedFiles(writerRoot, stagingRoot, dedupedAccepted);
      const staged = validateStaging(input.proofBin, stagingRoot, componentId, dedupedAccepted, timeoutMs);
      const validation = {
        status: staged.validation.status,
        stdout: staged.validation.stdout,
        stderr: staged.validation.stderr,
      };
      if (staged.validation.status !== 0) {
        return rejected(input, `Proof staging validation failed with exit ${staged.validation.status}: ${commandDetail(staged.validation)}`, [], ignoredPaths, [], validation);
      }
      const promotedCommit = applyAcceptedFiles(
        input,
        canonicalRoot,
        stagingRoot,
        dedupedAccepted,
        canonicalCommit,
        canonicalTree,
        () => {
          applicationStarted = true;
        }
      );
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
