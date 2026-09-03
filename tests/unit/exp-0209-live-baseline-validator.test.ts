import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from '@jest/globals';
import { validateLiveBaselineCheckpoint } from '../../examples/agent-governance/exp-0209-discovery-egress/run-live-demo';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE = path.join(REPO_ROOT, 'tests/fixtures/proof-current-catalog-checkpoint-child.ts');

function produceFixture(directory: string): void {
  execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', FIXTURE, 'produce', directory], {
    cwd: REPO_ROOT,
    env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1' },
    encoding: 'utf8',
    timeout: 180_000,
    stdio: 'pipe',
  });
}

describe('EXP-0209 live baseline checkpoint validator', () => {
  it('accepts the deterministic baseline and rejects catalog tampering', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-exp0209-live-validator-'));
    try {
      produceFixture(directory);
      const artifact = JSON.parse(fs.readFileSync(path.join(directory, 'baseline.json'), 'utf8')) as Record<string, any>;
      const checkpoint = JSON.parse(artifact.checkpoint) as Record<string, any>;
      const accepted = validateLiveBaselineCheckpoint(checkpoint, artifact.config);
      expect(accepted.gatePassed).toBe(true);
      expect(accepted.componentIds).toEqual(['alpha', 'beta', 'gamma']);

      const catalog = checkpoint.events.find((event: Record<string, any>) =>
        event.type === 'ClaimPublished' && event.claim === 'component.catalog@1',
      ) as Record<string, any> | undefined;
      expect(catalog).toBeDefined();
      expect(catalog?.payload.components).toHaveLength(3);
      expect(catalog?.payload.components.map((component: Record<string, any>) => component.component_id).sort()).toEqual(['alpha', 'beta', 'gamma']);
      expect(catalog?.payload.components.every((component: Record<string, any>) => !Object.prototype.hasOwnProperty.call(component, 'id'))).toBe(true);

      const tampered = JSON.parse(artifact.checkpoint) as Record<string, any>;
      const tamperedCatalog = tampered.events.find((event: Record<string, any>) =>
        event.type === 'ClaimPublished' && event.claim === 'component.catalog@1',
      ) as Record<string, any>;
      tamperedCatalog.payload.components[0].component_id = 'forged';
      expect(() => validateLiveBaselineCheckpoint(tampered, artifact.config)).toThrow();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);

  it('does not overwrite prior baseline evidence when the child is replayed directly', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-exp0209-live-replay-'));
    fs.chmodSync(directory, 0o700);
    const reportPath = path.join(directory, 'baseline-report.json');
    const original = '{"status":"passed","receipt_id":"retained"}\n';
    fs.writeFileSync(reportPath, original, { mode: 0o600 });
    try {
      const child = spawnSync(process.execPath, [
        '-r', 'ts-node/register/transpile-only',
        path.join(REPO_ROOT, 'examples/agent-governance/exp-0209-discovery-egress/run-live-demo.ts'),
        '--baseline-child', '--output', directory, '--controller-pid', '999999',
      ], {
        cwd: REPO_ROOT,
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1' },
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(child.status).not.toBe(0);
      expect(fs.readFileSync(reportPath, 'utf8')).toBe(original);
      expect(fs.existsSync(path.join(directory, 'baseline-failure.checkpoint.json'))).toBe(false);
      expect(fs.existsSync(path.join(directory, 'baseline-report.md'))).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
