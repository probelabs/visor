import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import { validateArtifactPathAliases, validateGraphCheckpointMode } from '../../src/cli-main';
import type { CliOptions } from '../../src/types/cli';

function options(overrides: Partial<CliOptions>): CliOptions {
  return { checks: ['onboard'], output: 'json', configPath: '/tmp/visor.yaml', ...overrides } as CliOptions;
}

describe('CLI checkpoint governance preflight', () => {
  it('rejects corrupt input without invoking an external authority', () => {
    const root = mkdtempSync(join(tmpdir(), 'visor-checkpoint-cli-')); chmodSync(root, 0o700);
    const input = join(root, 'input.json'); const proofCall = jest.fn();
    try {
      writeFileSync(input, JSON.stringify({ kind: 'visor.graph-journal-checkpoint' }));
      expect(() => validateGraphCheckpointMode(options({ graphCheckpointIn: input }))).toThrow();
      expect(proofCall).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects every alias pair among input, output, receipt, and output-file', () => {
    const names = ['graphCheckpointIn', 'graphCheckpointOut', 'governedReceipt', 'outputFile'] as const;
    for (let left = 0; left < names.length; left++) for (let right = left + 1; right < names.length; right++) {
      const target = `/tmp/alias-${left}-${right}.json`;
      expect(() => validateArtifactPathAliases(options({ [names[left]]: target, [names[right]]: target }))).toThrow(/cannot alias/);
    }
  });
});
