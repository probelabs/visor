import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonicalJson } from './state-machine/graph/claim-kernel';
import { ExecutionJournal, type GraphJournalCheckpointV1 } from './snapshot-store';

const MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024;
export const GRAPH_CHECKPOINT_READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);

/**
 * File boundary for the portable Graph-v2 checkpoint.
 *
 * Checkpoints contain execution history and claim payloads.  Keep the CLI
 * boundary deliberately small: read one existing regular file and publish one
 * new regular file into an already-private directory.  The engine performs
 * graph/integrity/quiescence validation after parsing an input checkpoint.
 */

function absolute(target: string, label: string): string {
  if (process.platform === 'win32' || !path.isAbsolute(target)) {
    throw new Error(`${label} requires an absolute POSIX path`);
  }
  return path.resolve(target);
}

function privateParent(target: string, label: string): { parent: string; name: string } {
  const resolved = absolute(target, label);
  const requestedParent = path.dirname(resolved);
  const requestedStat = fs.lstatSync(requestedParent);
  if (requestedStat.isSymbolicLink() || !requestedStat.isDirectory()) {
    throw new Error(`${label} parent must be an existing real directory`);
  }
  const parent = fs.realpathSync(requestedParent);
  const parentStat = fs.lstatSync(parent);
  const stat = fs.statSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory() || !stat.isDirectory() || (stat.mode & 0o777) !== 0o700) {
    throw new Error(`${label} parent must be an existing private 0700 directory`);
  }
  const name = path.basename(resolved);
  if (!name || name === '.' || name === '..') throw new Error(`${label} target must be a regular file name`);
  return { parent, name };
}

function assertAbsent(parent: string, name: string, label: string): void {
  try {
    fs.lstatSync(path.join(parent, name));
    throw new Error(`${label} target must be absent`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function sameDirectory(parent: string, identity: fs.Stats): boolean {
  const current = fs.statSync(parent);
  return current.isDirectory() && current.dev === identity.dev && current.ino === identity.ino && (current.mode & 0o777) === 0o700;
}

/** Read a checkpoint file without granting it any authority. */
export function readGraphCheckpointFile(target: string): GraphJournalCheckpointV1 {
  const { parent, name } = privateParent(target, 'graph checkpoint input');
  const finalTarget = path.join(parent, name);
  let fd: number | undefined;
  let text: string;
  try {
    fd = fs.openSync(finalTarget, GRAPH_CHECKPOINT_READ_FLAGS);
    const descriptor = fs.fstatSync(fd);
    const pathname = fs.lstatSync(finalTarget);
    if (!descriptor.isFile() || pathname.isSymbolicLink() || !pathname.isFile() || descriptor.dev !== pathname.dev || descriptor.ino !== pathname.ino || (descriptor.mode & 0o777) !== 0o600 || descriptor.size < 1 || descriptor.size > MAX_CHECKPOINT_BYTES) {
      throw new Error('graph checkpoint input identity, mode, or size is invalid');
    }
    const bytes = Buffer.alloc(descriptor.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!Number.isInteger(count) || count <= 0) throw new Error('graph checkpoint input read made no progress');
      offset += count;
    }
    const after = fs.lstatSync(finalTarget);
    if (after.isSymbolicLink() || !after.isFile() || after.dev !== descriptor.dev || after.ino !== descriptor.ino || after.size !== descriptor.size || (after.mode & 0o777) !== 0o600) throw new Error('graph checkpoint input identity changed during read');
    text = bytes.toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('graph checkpoint input must be a regular file, not a symlink');
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`graph checkpoint input is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return ExecutionJournal.validateGraphCheckpointIntegrity(parsed);
}

/** Validate an input path before the engine is constructed or providers run. */
export function validateGraphCheckpointInputFile(target: string): GraphJournalCheckpointV1 {
  return readGraphCheckpointFile(target);
}

/** Validate an output path before the engine is constructed or providers run. */
export function validateGraphCheckpointOutputTarget(target: string): void {
  const { parent, name } = privateParent(target, 'graph checkpoint output');
  assertAbsent(parent, name, 'graph checkpoint output');
}

/**
 * Publish a canonical checkpoint atomically to an absent 0600 file.
 * Hard-linking the private temporary file makes the final path an atomic
 * create operation and prevents an existing target or symlink from being
 * replaced.
 */
export function publishGraphCheckpointFile(checkpoint: GraphJournalCheckpointV1, target: string): void {
  const bytes = Buffer.from(canonicalJson(checkpoint) + '\n', 'utf8');
  const { parent, name } = privateParent(target, 'graph checkpoint output');
  assertAbsent(parent, name, 'graph checkpoint output');
  const finalTarget = path.join(parent, name);
  const parentStat = fs.statSync(parent);
  const parentIdentity = parentStat;
  const temp = path.join(parent, `.visor-graph-checkpoint-${randomBytes(16).toString('hex')}.tmp`);
  let fd: number | undefined;
  let tempStat: fs.Stats | undefined;
  let targetStat: fs.Stats | undefined;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    tempStat = fs.fstatSync(fd);
    if (!tempStat.isFile() || (tempStat.mode & 0o777) !== 0o600) throw new Error('graph checkpoint temporary identity invalid');
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (!Number.isInteger(written) || written <= 0) throw new Error('graph checkpoint write made no progress');
      offset += written;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    tempStat = fs.lstatSync(temp);
    if (!tempStat.isFile() || (tempStat.mode & 0o777) !== 0o600 || tempStat.size !== bytes.length) throw new Error('graph checkpoint temporary identity invalid');
    if (!sameDirectory(parent, parentIdentity)) throw new Error('graph checkpoint parent identity changed');
    fs.linkSync(temp, finalTarget);
    targetStat = fs.lstatSync(finalTarget);
    if (targetStat.isSymbolicLink() || !targetStat.isFile() || targetStat.dev !== tempStat.dev || targetStat.ino !== tempStat.ino || (targetStat.mode & 0o777) !== 0o600 || targetStat.size !== bytes.length) throw new Error('graph checkpoint target identity invalid');
    fs.unlinkSync(temp);
    tempStat = undefined;
    const parentFd = fs.openSync(parent, fs.constants.O_RDONLY);
    try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
  } catch (error) {
    try { if (fd !== undefined) fs.closeSync(fd); } catch {}
    try {
      if (tempStat) {
        const current = fs.lstatSync(temp);
        if (current.dev === tempStat.dev && current.ino === tempStat.ino) fs.unlinkSync(temp);
      }
    } catch {}
    try {
      if (targetStat) {
        const current = fs.lstatSync(finalTarget);
        if (current.dev === targetStat.dev && current.ino === targetStat.ino) fs.unlinkSync(finalTarget);
      }
    } catch {}
    throw error;
  }
}
