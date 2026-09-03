import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from '@jest/globals';
import {
  validateLiveBaselineCheckpoint,
  validateLiveResumeCheckpoint,
  writeControllerResumeFailureIfMissing,
} from '../../examples/agent-governance/exp-0209-discovery-egress/run-live-demo';
import { canonicalGraphCheckpointJson } from '../../src/snapshot-store';

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

  it('accepts the deterministic selective continuation and rejects receipt tampering', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-exp0209-live-resume-validator-'));
    try {
      produceFixture(directory);
      execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', FIXTURE, 'continue', directory], {
        cwd: REPO_ROOT,
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1' },
        encoding: 'utf8',
        timeout: 180_000,
        stdio: 'pipe',
      });
      const artifact = JSON.parse(fs.readFileSync(path.join(directory, 'baseline.json'), 'utf8')) as Record<string, any>;
      const continuation = JSON.parse(fs.readFileSync(path.join(directory, 'continuation.json'), 'utf8')) as Record<string, any>;
      const accepted = validateLiveResumeCheckpoint(
        JSON.parse(continuation.checkpoint),
        JSON.parse(artifact.checkpoint),
        artifact.config,
        { changedComponentId: 'alpha', changedPaths: ['alpha.go'] },
      );
      expect(accepted.gatePassed).toBe(true);
      expect(accepted.counts.proofCandidates).toBe(5);
      expect(accepted.suffix).toEqual(['alpha:inspect', 'alpha:proof_admit', 'alpha:verify', 'journalservice:project_reconcile']);
      expect(accepted.receiptIds.replacement).not.toBe(accepted.receiptIds.baseline);

      const tampered = JSON.parse(continuation.checkpoint) as Record<string, any>;
      const baselineEventCount = (JSON.parse(artifact.checkpoint) as Record<string, any>).events.length;
      const receipt = tampered.events.find((event: Record<string, any>) =>
        event.type === 'ClaimPublished' && event.eventId > baselineEventCount && event.claim === 'proof.admitted_receipt@1' && event.scope?.length === 2 && event.scope?.[1]?.key === 'alpha' && event.payload?.__proof_admission_wire,
      ) as Record<string, any> | undefined;
      expect(receipt).toBeDefined();
      const decision = JSON.parse(receipt!.payload.__proof_admission_wire) as Record<string, any>;
      delete decision.receipt.Termination;
      receipt!.payload.__proof_admission_wire = JSON.stringify(decision);
      // Rehash the checkpoint envelope so restore gets past the outer
      // integrity check and the admission/termination gate sees the omitted
      // receipt field as the actual failure.
      const body = { ...tampered };
      delete body.integrity;
      tampered.integrity = {
        algorithm: 'sha256',
        digest: createHash('sha256').update(canonicalGraphCheckpointJson(body), 'utf8').digest('hex'),
      };
      expect(() => validateLiveResumeCheckpoint(tampered, JSON.parse(artifact.checkpoint), artifact.config, { changedComponentId: 'alpha', changedPaths: ['alpha.go'] })).toThrow();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 300_000);

  it('does not overwrite a prior resume marker when a child is replayed directly', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-exp0209-live-resume-replay-'));
    fs.chmodSync(directory, 0o700);
    const markerPath = path.join(directory, 'resume.started.json');
    const original = '{"status":"started","controller_pid":999999}\n';
    fs.writeFileSync(markerPath, original, { mode: 0o600 });
    try {
      const child = spawnSync(process.execPath, [
        '-r', 'ts-node/register/transpile-only',
        path.join(REPO_ROOT, 'examples/agent-governance/exp-0209-discovery-egress/run-live-demo.ts'),
        '--resume-child', '--output', directory, '--controller-pid', '999999',
      ], {
        cwd: REPO_ROOT,
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1' },
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(child.status).not.toBe(0);
      expect(fs.readFileSync(markerPath, 'utf8')).toBe(original);
      expect(fs.existsSync(path.join(directory, 'resume-report.json'))).toBe(false);
      expect(fs.existsSync(path.join(directory, 'continued.checkpoint.json'))).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('publishes a missing controller failure report without replacing child evidence', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-exp0209-live-resume-controller-failure-'));
    fs.chmodSync(directory, 0o700);
    const checkpointPath = path.join(directory, 'resume-failure.checkpoint.json');
    const checkpointOriginal = '{"partial":true}\n';
    fs.writeFileSync(checkpointPath, checkpointOriginal, { mode: 0o600 });
    try {
      writeControllerResumeFailureIfMissing(directory, undefined, new Error('child exited without a report'));
      const reportPath = path.join(directory, 'resume-report.json');
      const reportOriginal = fs.readFileSync(reportPath, 'utf8');
      const report = JSON.parse(reportOriginal) as Record<string, any>;
      expect(report.mode).toBe('resume-only');
      expect(report.status).toBe('failed');
      expect(report.counts).toEqual({ status: 'unknown' });
      expect(fs.readFileSync(checkpointPath, 'utf8')).toBe(checkpointOriginal);

      writeControllerResumeFailureIfMissing(directory, undefined, new Error('different child error'));
      expect(fs.readFileSync(reportPath, 'utf8')).toBe(reportOriginal);
      expect(fs.readFileSync(checkpointPath, 'utf8')).toBe(checkpointOriginal);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
