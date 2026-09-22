import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import yaml from 'js-yaml';
import { CLI } from '../../src/cli';
import { resolveGraphRetryPrefixPath, validateArtifactPathAliases, validateGraphCheckpointMode, validateGraphDispatchOwner } from '../../src/cli-main';
import { canonicalGraphCheckpointJson, ExecutionJournal } from '../../src/snapshot-store';
import { compileClaimPlan } from '../../src/state-machine/graph/claim-plan';
import type { CliOptions } from '../../src/types/cli';

function options(overrides: Partial<CliOptions>): CliOptions {
  return { checks: ['onboard'], output: 'json', configPath: '/tmp/visor.yaml', ...overrides } as CliOptions;
}

describe('CLI checkpoint governance preflight', () => {
  const retryGeneration = 'a'.repeat(64);
  it.each(['0', '-1', '1.5', '9007199254740992'])('rejects unsafe graph dispatch limit %s during parsing', value => {
    expect(() => new CLI().parseArgs(['node', 'visor', '--graph-dispatch-limit', value])).toThrow(/positive safe integer/);
  });

  it.each([
    [{ graphDispatchLimit: 1 }, /--graph-dispatch-limit requires --graph-dispatch-owner/],
    [{ graphDispatchOwner: 'discover' }, /--graph-dispatch-owner requires --graph-dispatch-limit/],
    [{ graphDispatchOwner: 'discover', graphDispatchLimit: 1 }, /requires --graph-checkpoint-out/],
    [{ graphResumeReady: true }, /--graph-resume-ready requires --graph-checkpoint-in/],
    [{ graphResumeReady: true, graphCheckpointIn: '/tmp/checkpoint.json' }, /requires --graph-checkpoint-out/],
    [{ graphDispatchOwner: 'discover', graphDispatchLimit: 1, graphCheckpointIn: '/tmp/checkpoint.json', graphCheckpointOut: '/tmp/next.json' }, /requires --graph-resume-ready/],
    [{ graphCheckpointOwner: 'discover', graphCheckpointIn: '/tmp/checkpoint.json', graphCheckpointOut: '/tmp/next.json', graphDispatchOwner: 'discover', graphDispatchLimit: 1, graphResumeReady: true }, /cannot be used/],
    [{ graphRetryGeneration: retryGeneration, graphRetrySideEffects: 'absent' }, /requires --graph-checkpoint-in/],
    [{ graphRetryGeneration: retryGeneration, graphCheckpointIn: '/tmp/checkpoint.json', graphCheckpointOut: '/tmp/next.json', graphResumeReady: true }, /requires --graph-retry-side-effects/],
    [{ graphRetrySideEffects: 'absent', graphCheckpointIn: '/tmp/checkpoint.json', graphCheckpointOut: '/tmp/next.json', graphResumeReady: true }, /requires --graph-retry-generation/],
    [{ graphRetryGeneration: retryGeneration, graphRetrySideEffects: 'absent', graphCheckpointIn: '/tmp/checkpoint.json', graphCheckpointOut: '/tmp/next.json' }, /requires --graph-resume-ready/],
    [{ graphRetryGeneration: retryGeneration, graphRetrySideEffects: 'absent', graphCheckpointIn: '/tmp/checkpoint.json', graphCheckpointOut: '/tmp/next.json', graphResumeReady: true, graphCheckpointOwner: 'discover' }, /cannot/],
    [{ graphRetryGeneration: retryGeneration, graphRetrySideEffects: 'absent', graphCheckpointIn: '/tmp/checkpoint.json', graphCheckpointOut: '/tmp/next.json', graphResumeReady: true, graphDispatchOwner: 'discover', graphDispatchLimit: 1 }, /cannot be combined/],
  ])('rejects invalid bounded checkpoint combination %#', (override, error) => {
    expect(() => validateGraphCheckpointMode(options(override))).toThrow(error);
  });

  it('parses the exact retry generation and side-effect disposition', () => {
    expect(new CLI().parseArgs([
      'node', 'visor', '--graph-retry-generation', retryGeneration,
      '--graph-retry-side-effects', 'isolated_draft_replay',
    ])).toMatchObject({ graphRetryGeneration: retryGeneration, graphRetrySideEffects: 'isolated_draft_replay' });
    expect(() => new CLI().parseArgs(['node', 'visor', '--graph-retry-generation', 'A'.repeat(64), '--graph-retry-side-effects', 'absent']))
      .toThrow(/64 lowercase hexadecimal/);
    expect(() => new CLI().parseArgs(['node', 'visor', '--graph-retry-generation', retryGeneration, '--graph-retry-side-effects', 'unknown']))
      .toThrow(/side-effects must be/);
  });

  it('derives the mandatory retry prefix beside the checkpoint output', () => {
    expect(resolveGraphRetryPrefixPath(options({
      graphRetryGeneration: retryGeneration,
      graphRetrySideEffects: 'absent',
      graphCheckpointOut: '/tmp/retry-checkpoint.json',
    }))).toBe('/tmp/retry-checkpoint.json.retry.json');
  });

  it('requires an exact compiled nested expansion owner before dispatch', () => {
    const config = yaml.load(readFileSync(resolve(__dirname, '../fixtures/graph-v2/cli-ready-resume.yaml'), 'utf8')) as import('../../src/types/config').VisorConfig;
    expect(validateGraphDispatchOwner(config, '["project","materialize"]')).toBe('["project","materialize"]');
    expect(() => validateGraphDispatchOwner(config, '["project","materialize","wrong"]')).toThrow(/exactly match/);
  });

  it('accepts an unbounded ready-only resume with checkpoint input and output', () => {
    const root = mkdtempSync(join(tmpdir(), 'visor-ready-only-cli-')); chmodSync(root, 0o700);
    try {
      const config = yaml.load(readFileSync(resolve(__dirname, '../fixtures/graph-v2/cli-ready-resume.yaml'), 'utf8')) as import('../../src/types/config').VisorConfig;
      const checkpoint = new ExecutionJournal(compileClaimPlan(config)).exportGraphCheckpoint('ready-only');
      const input = join(root, 'input.json'); const output = join(root, 'output.json');
      writeFileSync(input, `${canonicalGraphCheckpointJson(checkpoint)}\n`, { mode: 0o600 });
      expect(validateGraphCheckpointMode(options({ graphCheckpointIn: input, graphCheckpointOut: output, graphResumeReady: true }))).toMatchObject({ kind: 'visor.graph-journal-checkpoint' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

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

  it('rejects hard-link aliases across the full artifact matrix', () => {
    const root = mkdtempSync(join(tmpdir(), 'visor-alias-cli-')); chmodSync(root, 0o700);
    const names = ['graphCheckpointIn', 'graphCheckpointOut', 'governedReceipt', 'outputFile'] as const;
    try {
      for (let left = 0; left < names.length; left++) for (let right = left + 1; right < names.length; right++) {
        const source = join(root, `source-${left}-${right}`); const alias = join(root, `alias-${left}-${right}`);
        writeFileSync(source, 'x', { mode: 0o600 }); linkSync(source, alias);
        expect(() => validateArtifactPathAliases(options({ [names[left]]: source, [names[right]]: alias }))).toThrow(/cannot alias/);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
