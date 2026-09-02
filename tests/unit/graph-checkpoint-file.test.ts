import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { canonicalJson } from '../../src/state-machine/graph/claim-kernel';
import { publishGraphCheckpointFile, readGraphCheckpointFile, validateGraphCheckpointInputFile } from '../../src/graph-checkpoint-file';

const checkpoint: any = {
  kind: 'visor.graph-journal-checkpoint', version: 1, sessionId: 'session', graphSemanticDigest: 'a'.repeat(64),
  frontier: { eventCount: 0, lastEventId: 0 }, events: [], integrity: { algorithm: 'sha256', digest: 'b'.repeat(64) },
};

describe('public Graph-v2 checkpoint file boundary', () => {
  it('publishes canonical JSON atomically to a new 0600 file and reads it back', () => {
    const root = mkdtempSync(join(tmpdir(), 'visor-checkpoint-')); chmodSync(root, 0o700);
    const target = join(root, 'baseline.json');
    try {
      publishGraphCheckpointFile(checkpoint, target);
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(readFileSync(target, 'utf8')).toBe(canonicalJson(checkpoint) + '\n');
      expect(readGraphCheckpointFile(target)).toEqual(checkpoint);
      expect(() => publishGraphCheckpointFile(checkpoint, target)).toThrow(/absent/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('requires an existing private directory and regular non-symlink input', () => {
    const root = mkdtempSync(join(tmpdir(), 'visor-checkpoint-')); const publicRoot = join(root, 'public'); mkdirSync(publicRoot, { mode: 0o755 });
    try {
      expect(() => validateGraphCheckpointInputFile(join(publicRoot, 'missing.json'))).toThrow(/private/);
      expect(() => publishGraphCheckpointFile(checkpoint, join(publicRoot, 'out.json'))).toThrow(/private/);
      const regular = join(root, 'regular.json'); writeFileSync(regular, '{}');
      expect(() => validateGraphCheckpointInputFile(regular)).not.toThrow();
      const linked = join(root, 'linked.json'); symlinkSync(regular, linked);
      expect(() => validateGraphCheckpointInputFile(linked)).toThrow(/regular file/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
