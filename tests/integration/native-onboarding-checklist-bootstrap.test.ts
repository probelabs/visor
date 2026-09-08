import { describe, expect, it, jest } from '@jest/globals';

// Jest's default setup replaces child_process with a mock.  This integration
// boundary must exercise the real command provider and the real Proof binary.
jest.unmock('child_process');
jest.unmock('node:child_process');

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  buildNativeChecklistProgressFromProjections,
  renderNativeChecklistProgress,
} from '../../examples/agent-governance/native-onboarding/native-checklist-progress';
import { canonicalGraphCheckpointJson, ExecutionJournal } from '../../src/snapshot-store';
import { canonicalJson, sha256Canonical } from '../../src/state-machine/graph/claim-kernel';
import { compileClaimPlan } from '../../src/state-machine/graph/claim-plan';
import type { PRInfo } from '../../src/pr-analyzer';

const SNAPSHOT_CLAIM = 'proof.checklist.snapshot@1';
const BASELINE_CLAIM = 'native.initialized.baseline@1';

type JsonRecord = Record<string, any>;

function proofIdentity(proof: string): { path: string; sha256: string } {
  const realPath = fs.realpathSync(proof);
  const stat = fs.statSync(realPath);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error(`PROOF_BIN is not an executable file: ${proof}`);
  }
  return {
    path: realPath,
    sha256: createHash('sha256').update(fs.readFileSync(realPath)).digest('hex'),
  };
}

function runGit(subject: string, args: string[]): string {
  return execFileSync('git', ['-C', subject, ...args], { encoding: 'utf8' }).trim();
}

function gitStatus(subject: string): string {
  return execFileSync('git', ['-C', subject, 'status', '--porcelain=v1'], { encoding: 'utf8' });
}

function createSubject(fixtureRoot: string): { subject: string; head: string } {
  const subject = path.join(fixtureRoot, 'subject');
  fs.mkdirSync(subject, { recursive: true });
  runGit(subject, ['init', '--quiet']);
  runGit(subject, ['config', 'user.email', 'visor-fixture@example.test']);
  runGit(subject, ['config', 'user.name', 'Visor Fixture']);
  fs.writeFileSync(
    path.join(subject, 'README.md'),
    '# native checklist bootstrap fixture\n',
    'utf8'
  );
  runGit(subject, ['add', 'README.md']);
  runGit(subject, ['commit', '--quiet', '-m', 'fixture']);
  return { subject, head: runGit(subject, ['rev-parse', 'HEAD']) };
}

function assertFreshProofState(subject: string): void {
  expect(fs.existsSync(path.join(subject, '.gitignore'))).toBe(false);
  expect(fs.existsSync(path.join(subject, 'proof.yaml'))).toBe(false);
  expect(fs.existsSync(path.join(subject, 'proof'))).toBe(false);
  expect(fs.existsSync(path.join(subject, '.proof'))).toBe(false);
}

function sourceWorktreeGuard(sourceRoot: string): {
  status: string;
  proofYaml: string | undefined;
  proofTree: string | undefined;
  gitignore: string;
} {
  const proofYamlPath = path.join(sourceRoot, 'proof.yaml');
  const proofDir = path.join(sourceRoot, 'proof');
  const status = execFileSync(
    'git',
    ['-C', sourceRoot, 'status', '--short', '--', 'proof.yaml', 'proof'],
    { encoding: 'utf8' }
  );
  const proofTree = fs.existsSync(proofDir)
    ? execFileSync(
        'find',
        [proofDir, '-type', 'f', '-print', '-exec', 'shasum', '-a', '256', '{}', ';'],
        { encoding: 'utf8' }
      )
    : undefined;
  return {
    status,
    proofYaml: fs.existsSync(proofYamlPath) ? fs.readFileSync(proofYamlPath, 'utf8') : undefined,
    proofTree,
    gitignore: fs.readFileSync(path.join(sourceRoot, '.gitignore'), 'utf8'),
  };
}

function proofShow(proof: string, subject: string): JsonRecord {
  const stdout = execFileSync(
    proof,
    ['checklist', 'show', '--checklist', 'onboard_v1', '--format', 'json'],
    {
      cwd: subject,
      encoding: 'utf8',
      env: { ...process.env, PROOF_BIN: proof },
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  return JSON.parse(stdout) as JsonRecord;
}

function serializedError(error: unknown): JsonRecord {
  if (error instanceof Error) {
    const childError = error as Error & { stdout?: unknown; stderr?: unknown; cause?: unknown };
    const output = (value: unknown): string | undefined => {
      if (typeof value === 'string') return value;
      if (Buffer.isBuffer(value)) return value.toString('utf8');
      return undefined;
    };
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(output(childError.stdout) !== undefined ? { stdout: output(childError.stdout) } : {}),
      ...(output(childError.stderr) !== undefined ? { stderr: output(childError.stderr) } : {}),
      ...(childError.cause !== undefined ? { cause: serializedError(childError.cause) } : {}),
    };
  }
  return { value: String(error) };
}

function writeFailureDiagnostics(fixtureRoot: string, error: unknown): string {
  const diagnosticsPath = path.join(fixtureRoot, 'first-runtime-error.json');
  fs.writeFileSync(
    diagnosticsPath,
    JSON.stringify(
      {
        fixture: 'SYNTHETIC native checklist bootstrap integration',
        error: serializedError(error),
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
  return diagnosticsPath;
}

describe('native onboarding checklist bootstrap (real engine + Proof)', () => {
  const proofConfigured =
    typeof process.env.PROOF_BIN === 'string' && process.env.PROOF_BIN.length > 0;
  const evidenceRequired = process.env.VISOR_EXP0208_EVIDENCE === 'required';
  const bootstrapTest = proofConfigured || evidenceRequired ? it : it.skip;

  bootstrapTest(
    'journals only the init checklist snapshot at the first no-model boundary',
    async () => {
      const proof = process.env.PROOF_BIN;
      if (!proof) {
        throw new Error('PROOF_BIN is required for native checklist bootstrap evidence');
      }

      const identity = proofIdentity(proof);
      const expectedProofSha = process.env.VISOR_EXP0208_EXPECTED_PROOF_SHA256;
      if (evidenceRequired) {
        if (!expectedProofSha) {
          throw new Error(
            'VISOR_EXP0208_EXPECTED_PROOF_SHA256 is required when evidence is required'
          );
        }
        expect(identity.sha256).toBe(expectedProofSha);
      }
      const sourceRoot = path.resolve(__dirname, '../..');
      const sourceBefore = sourceWorktreeGuard(sourceRoot);
      const fixtureRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'visor-native-checklist-bootstrap-')
      );
      const previousOutputDir = process.env.NATIVE_ONBOARDING_OUTPUT_DIR;
      const previousRepoRoot = process.env.NATIVE_ONBOARDING_REPO_ROOT;
      const previousTsNode = process.env.NATIVE_ONBOARDING_TS_NODE;
      const previousTsProject = process.env.TS_NODE_PROJECT;
      const outputDir = path.join(fixtureRoot, 'output');
      fs.mkdirSync(outputDir, { recursive: true });
      const evidence: JsonRecord = {
        fixture: 'SYNTHETIC native checklist bootstrap integration',
        proof_identity: {
          ...identity,
          ...(evidenceRequired ? { expected_sha256: expectedProofSha } : {}),
        },
        output_directory: outputDir,
      };
      try {
        const { subject, head } = createSubject(fixtureRoot);
        evidence.subject = { path: subject, before_head: head, before_status: gitStatus(subject) };
        assertFreshProofState(subject);

        // Reset the module registry before importing the runner/engine so no
        // provider can retain Jest's child_process mock from test setup.
        jest.resetModules();
        jest.doMock('child_process', () => jest.requireActual('child_process'));
        jest.doMock('node:child_process', () => jest.requireActual('node:child_process'));
        const [{ buildChecklistOnboardingConfig }, { loadConfig, StateMachineExecutionEngine }] =
          await Promise.all([
            import('../../examples/agent-governance/native-onboarding/run-onboarding'),
            import('../../src/sdk'),
          ]);
        const config = await loadConfig(buildChecklistOnboardingConfig({} as any), {
          strict: true,
        });
        const plan = compileClaimPlan(config);
        const engine = new StateMachineExecutionEngine(subject);
        expect(runGit(subject, ['rev-parse', 'HEAD'])).toBe(head);
        expect(gitStatus(subject)).toBe('');
        assertFreshProofState(subject);
        const dispatchedGeneratedChecks: string[] = [];
        const dispatchGate = (generation: any) => {
          dispatchedGeneratedChecks.push(generation.checkId);
          return 'defer' as const;
        };
        const prInfo = {
          number: 1,
          title: 'Synthetic checklist bootstrap',
          body: '',
          author: 'fixture',
          base: 'main',
          head,
          files: [],
          totalAdditions: 0,
          totalDeletions: 0,
          eventType: 'manual',
        } as PRInfo;

        const previousCwd = process.cwd();
        let result;
        try {
          // The native checklist YAML deliberately keeps workspace isolation
          // off. The command provider therefore follows process.cwd(), so
          // point the real command boundary at this disposable subject.
          process.chdir(subject);
          process.env.NATIVE_ONBOARDING_OUTPUT_DIR = outputDir;
          process.env.NATIVE_ONBOARDING_REPO_ROOT = sourceRoot;
          process.env.NATIVE_ONBOARDING_TS_NODE = fs.realpathSync(
            require.resolve('ts-node/register/transpile-only')
          );
          process.env.TS_NODE_PROJECT = fs.realpathSync(path.join(sourceRoot, 'tsconfig.json'));
          result = await engine.executeGroupedChecks(
            prInfo,
            ['checklist-bootstrap'],
            120_000,
            config,
            'json',
            false,
            1,
            false,
            undefined,
            dispatchGate
          );
        } finally {
          process.chdir(previousCwd);
          if (previousOutputDir === undefined) delete process.env.NATIVE_ONBOARDING_OUTPUT_DIR;
          else process.env.NATIVE_ONBOARDING_OUTPUT_DIR = previousOutputDir;
          if (previousRepoRoot === undefined) delete process.env.NATIVE_ONBOARDING_REPO_ROOT;
          else process.env.NATIVE_ONBOARDING_REPO_ROOT = previousRepoRoot;
          if (previousTsNode === undefined) delete process.env.NATIVE_ONBOARDING_TS_NODE;
          else process.env.NATIVE_ONBOARDING_TS_NODE = previousTsNode;
          if (previousTsProject === undefined) delete process.env.TS_NODE_PROJECT;
          else process.env.TS_NODE_PROJECT = previousTsProject;
        }
        const checkpoint = engine.exportGraphCheckpoint();
        const projection = engine.getInstanceProjection();
        const replayed = engine.replayInstanceProjection();
        const journal = (engine as any)._lastContext?.journal as ExecutionJournal;
        expect(journal).toBeDefined();
        const claimProjection = journal.getClaimProjection();
        const restored = ExecutionJournal.restoreGraphCheckpoint(plan, checkpoint);
        const restoredProjection = restored.getInstanceProjection();
        const restoredClaimProjection = restored.getClaimProjection();
        const restoredCheckpoint = restored.exportGraphCheckpoint(checkpoint.sessionId);
        const checkpointTimestamp = '2026-09-08T14:00:00Z';
        const progress = buildNativeChecklistProgressFromProjections({
          claimProjection,
          instanceProjection: projection,
          checkpoint,
          checkpointTimestamp,
          paused: false,
          resumed: false,
        });
        const restoredProgress = buildNativeChecklistProgressFromProjections({
          claimProjection: restoredClaimProjection,
          instanceProjection: restoredProjection,
          checkpoint: restoredCheckpoint,
          checkpointTimestamp,
          paused: false,
          resumed: false,
        });
        const renderedProgress = renderNativeChecklistProgress(progress);
        const restoredRenderedProgress = renderNativeChecklistProgress(restoredProgress);
        const afterHead = runGit(subject, ['rev-parse', 'HEAD']);
        const afterStatus = gitStatus(subject);
        const snapshot = proofShow(identity.path, subject);
        evidence.subject = {
          ...evidence.subject,
          after_head: afterHead,
          after_status: afterStatus,
        };
        evidence.result = result;
        evidence.checkpoint = checkpoint;
        evidence.proof_show = snapshot;
        evidence.progress = {
          json: renderedProgress.json,
          text: renderedProgress.text,
        };
        expect(sourceWorktreeGuard(sourceRoot)).toEqual(sourceBefore);
        expect(process.cwd()).toBe(sourceRoot);

        expect(result.statistics.successfulExecutions).toBe(1);
        expect(result.statistics.failedExecutions).toBe(0);
        const resultIssues = Object.values(result.results || {})
          .flatMap((entries: any) => (Array.isArray(entries) ? entries : []))
          .flatMap((entry: any) => (Array.isArray(entry.issues) ? entry.issues : []));
        expect(
          resultIssues.filter(
            (issue: any) => issue.severity === 'error' || issue.severity === 'critical'
          )
        ).toEqual([]);
        expect(dispatchedGeneratedChecks).toEqual([]);
        expect(afterHead).toBe(head);
        expect(afterStatus.trimEnd().split('\n')).toEqual([
          '?? .gitignore',
          '?? proof.yaml',
          '?? proof/',
        ]);
        expect(snapshot.schema_version).toBe('proof.checklist.show.v1');
        expect(snapshot.active).toBe(true);
        expect(snapshot.new_project).toBe(true);
        const statePath = path.join(subject, 'proof/checklists/onboard_v1.state.yaml');
        expect(fs.existsSync(statePath)).toBe(true);
        expect(
          (yaml.load(fs.readFileSync(statePath, 'utf8')) as JsonRecord).campaign_new_project
        ).toBe(true);

        const rows = snapshot.steps as JsonRecord[];
        const init = rows.find(row => row.step_id === 'init');
        const research = rows.find(row => row.step_id === 'research');
        const skeleton = rows.find(row => row.step_id === 'skeleton');
        expect(init).toBeDefined();
        expect(init).toMatchObject({
          effective_status: 'confirmed',
          stored_status: 'confirmed',
          applicable: true,
        });
        expect(init!.required_checks).toEqual(['validate_passes', 'role_prompt_hygiene']);
        expect(init!.check_results).toEqual([
          expect.objectContaining({ id: 'validate_passes', status: 'pass' }),
          expect.objectContaining({ id: 'role_prompt_hygiene', status: 'pass' }),
        ]);
        expect(init!.check_results).toHaveLength(init!.required_checks.length);
        expect(init!.verify_result).toEqual(
          expect.objectContaining({ exit_code: 0, passed: true })
        );
        expect(research).toMatchObject({
          effective_status: 'pending',
          applicable: true,
          eligible: true,
        });
        expect(skeleton).toMatchObject({
          effective_status: 'pending',
          applicable: true,
          eligible: false,
          unmet_requires: ['research'],
        });
        expect(progress.evidence.proof_snapshot).toMatchObject({
          source: SNAPSHOT_CLAIM,
          claim_id: expect.any(String),
        });
        expect(progress.checklist.steps.find(step => step.id === 'init')).toMatchObject({
          state: 'confirmed',
        });
        expect(progress.checklist.steps.find(step => step.id === 'research')).toMatchObject({
          state: 'pending',
          eligible: true,
        });
        expect(progress.checklist.steps.find(step => step.id === 'skeleton')).toMatchObject({
          state: 'blocked',
          eligible: false,
        });
        expect(progress.paused).toBe(false);
        expect(progress.resumed).toBe(false);
        expect(progress.resumable).toBe(false);

        const activeClaimIds = new Set(Object.values(claimProjection.activeClaimIdsByRef));
        const activeClaims = Object.values(claimProjection.claims).filter(claim =>
          activeClaimIds.has(claim.claimId)
        );
        const activeSnapshots = activeClaims.filter(claim => claim.claim === SNAPSHOT_CLAIM);
        expect(activeSnapshots).toHaveLength(1);
        expect(activeClaims.filter(claim => claim.claim === BASELINE_CLAIM)).toHaveLength(0);
        expect(activeClaims.map(claim => claim.claim)).toEqual([SNAPSHOT_CLAIM]);
        const snapshotClaim = activeSnapshots[0];
        expect(snapshotClaim.producerCheckId).toBe('checklist-bootstrap');
        expect(snapshotClaim.scope).toEqual([]);
        expect(snapshotClaim.parentClaimIds).toEqual([]);
        expect(snapshotClaim.payloadFingerprint).toBe(sha256Canonical(snapshotClaim.payload));
        expect(canonicalJson(snapshotClaim.payload)).toBe(canonicalJson(snapshot));

        const events = checkpoint.events as JsonRecord[];
        expect(events).toHaveLength(4);
        expect(
          events.some(
            event => event.type === 'ManagedRunStarted' || event.type === 'ManagedRunCompleted'
          )
        ).toBe(false);
        expect(events.some(event => event.checkId !== 'checklist-bootstrap')).toBe(false);
        expect(projection).toEqual(replayed);
        expect(projection).toEqual(restoredProjection);
        expect(claimProjection).toEqual(restoredClaimProjection);
        expect(restoredProgress).toEqual(progress);
        expect(restoredRenderedProgress.json).toBe(renderedProgress.json);
        expect(canonicalGraphCheckpointJson(restoredCheckpoint)).toBe(
          canonicalGraphCheckpointJson(checkpoint)
        );
      } catch (error) {
        const diagnosticsPath = writeFailureDiagnostics(fixtureRoot, error);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} (exact first runtime error: ${diagnosticsPath})`,
          { cause: error }
        );
      } finally {
        const diagnosticsPath = path.join(fixtureRoot, 'first-runtime-error.json');
        const hadFailure = fs.existsSync(diagnosticsPath);
        const sourceAfter = sourceWorktreeGuard(sourceRoot);
        evidence.source_worktree = { before: sourceBefore, after: sourceAfter };
        evidence.process_cwd = process.cwd();
        if (
          !hadFailure &&
          (JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore) ||
            process.cwd() !== sourceRoot)
        ) {
          writeFailureDiagnostics(
            fixtureRoot,
            new Error(
              'bootstrap mutated the Visor source worktree or did not restore process.cwd()'
            )
          );
          throw new Error(
            'bootstrap mutated the Visor source worktree or did not restore process.cwd()'
          );
        }
        if (evidenceRequired) {
          fs.writeFileSync(
            path.join(fixtureRoot, 'evidence.json'),
            JSON.stringify(evidence, null, 2) + '\n',
            'utf8'
          );
        }
        if (
          !evidenceRequired &&
          !fs.existsSync(path.join(fixtureRoot, 'first-runtime-error.json'))
        ) {
          fs.rmSync(fixtureRoot, { recursive: true, force: true });
        }
      }
    },
    180_000
  );
});
