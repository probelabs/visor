import * as fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import * as yaml from 'js-yaml';
import {ConfigManager} from '../../src/config';
import {canonicalGraphCheckpointJson, ExecutionJournal} from '../../src/snapshot-store';
import * as claimPlan from '../../src/state-machine/graph/claim-plan';
import {
  runNativeChecklistProgressDisplay,
  type NativeChecklistDisplayArgs,
} from '../../examples/agent-governance/native-onboarding/native-checklist-progress';

const SOURCE = path.resolve(__dirname, '../../examples/agent-governance/native-onboarding/native-checklist-progress.ts');
const TS_NODE = require.resolve('ts-node/register/transpile-only');

function proofSnapshot(): Record<string, unknown> {
  return {
    schema_version: 'proof.checklist.show.v1',
    checklist: 'onboard_v1',
    active: true,
    new_project: true,
    steps_pending: 1,
    eligible_step_ids: ['research'],
    next: {step_id: 'research', title: 'Research'},
    steps: [{
      step_id: 'research',
      title: 'Research',
      effective_status: 'pending',
      stored_status: 'pending',
      applicable: true,
      eligible: true,
      requires: [],
      unmet_requires: [],
      required_checks: [],
      check_results: [],
    }],
  };
}

function privateDirectory(parent: string, name: string): string {
  const target = path.join(parent, name);
  fs.mkdirSync(target, {mode: 0o700});
  fs.chmodSync(target, 0o700);
  return target;
}

describe('native checklist display adapter', () => {
  let root: string;
  let targetRoot: string;
  let outputDir: string;
  let proofBin: string;
  let callLog: string;
  let checkpointPath: string;
  let projection: Record<string, unknown>;
  let checkpoint: Record<string, unknown>;
  let restore: jest.SpiedFunction<typeof ExecutionJournal.restoreGraphCheckpoint>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-checklist-display-'));
    fs.chmodSync(root, 0o700);
    targetRoot = privateDirectory(root, 'target');
    outputDir = privateDirectory(root, 'outputs');
    callLog = path.join(root, 'proof-call.log');
    proofBin = path.join(root, 'proof');
    const script = `#!/usr/bin/env node
const fs = require('node:fs');
if (process.env.NATIVE_DISPLAY_PROOF_LOG) fs.writeFileSync(process.env.NATIVE_DISPLAY_PROOF_LOG, JSON.stringify({cwd: process.cwd(), argv: process.argv.slice(2)}));
if (process.env.NATIVE_DISPLAY_PROOF_FAIL === '1') process.exit(9);
process.stdout.write(JSON.stringify(${JSON.stringify(proofSnapshot())}));
`;
    fs.writeFileSync(proofBin, script, {mode: 0o700});
    fs.chmodSync(proofBin, 0o700);
    process.env.NATIVE_DISPLAY_PROOF_LOG = callLog;
    checkpointPath = path.join(root, 'checkpoint.json');
    const fixturePath = path.resolve(__dirname, '../fixtures/graph-v2/cli-ready-resume.yaml');
    const fixture = yaml.load(fs.readFileSync(fixturePath, 'utf8')) as any;
    const fixturePlan = claimPlan.compileClaimPlan(fixture);
    checkpoint = new ExecutionJournal(fixturePlan).exportGraphCheckpoint('display-session');
    fs.writeFileSync(checkpointPath, `${canonicalGraphCheckpointJson(checkpoint)}\n`, {mode: 0o600});
    projection = {
      claimsById: {
        project: {
          claimId: 'project',
          claim: 'native.project.item@1',
          active: true,
          payload: {id: 'project', target: {path: targetRoot}, state: {}},
        },
      },
      generationsById: {},
      activeGenerationIdByNode: {},
    };
    jest.spyOn(ConfigManager.prototype, 'loadConfig').mockResolvedValue(fixture as any);
    restore = jest.spyOn(ExecutionJournal, 'restoreGraphCheckpoint').mockReturnValue({
      getInstanceProjection: () => projection as any,
      queryReadyWork: () => [{}],
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.NATIVE_DISPLAY_PROOF_LOG;
    delete process.env.NATIVE_DISPLAY_PROOF_FAIL;
    fs.rmSync(root, {recursive: true, force: true});
  });

  function args(overrides: Partial<NativeChecklistDisplayArgs> = {}): NativeChecklistDisplayArgs {
    return {
      config: path.join(root, 'config.yaml'),
      checkpoint: checkpointPath,
      proofBin,
      targetRoot,
      outputDir,
      resumed: false,
      ...overrides,
    };
  }

  function outputPaths(): string[] {
    const realOutputDir = fs.realpathSync(outputDir);
    return [
      path.join(realOutputDir, 'native-checklist-progress.json'),
      path.join(realOutputDir, 'native-checklist-progress.txt'),
      path.join(realOutputDir, 'native-checklist-progress.html'),
    ];
  }

  it('writes truthful JSON, text, and HTML output with fresh Proof identity', async () => {
    const written = await runNativeChecklistProgressDisplay(args());
    expect(written).toEqual(outputPaths());
    expect(JSON.parse(fs.readFileSync(written[0], 'utf8'))).toMatchObject({
      kind: 'native-checklist-progress',
      checklist: {name: 'onboard_v1', steps_pending: 1},
      paused: true,
      resumed: false,
    });
    expect(fs.readFileSync(written[1], 'utf8')).toContain('onboard_v1');
    expect(fs.readFileSync(written[2], 'utf8')).toContain('data-native-checklist-progress="v1"');
    expect(JSON.parse(fs.readFileSync(callLog, 'utf8'))).toEqual({
      cwd: fs.realpathSync(targetRoot),
      argv: ['checklist', 'show', 'onboard_v1', '--format', 'json'],
    });
    for (const target of written) expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('requires an existing private output directory and refuses overwrite or symlink targets', async () => {
    fs.writeFileSync(outputPaths()[0], 'keep', {mode: 0o600});
    await expect(runNativeChecklistProgressDisplay(args())).rejects.toThrow(/absent/);
    expect(fs.readFileSync(outputPaths()[0], 'utf8')).toBe('keep');
    expect(fs.existsSync(callLog)).toBe(false);

    fs.unlinkSync(outputPaths()[0]);
    const link = path.join(root, 'output-link');
    fs.symlinkSync(outputDir, link);
    await expect(runNativeChecklistProgressDisplay(args({outputDir: link}))).rejects.toThrow(/real directory/);
    expect(fs.existsSync(callLog)).toBe(false);
    const publicDir = path.join(root, 'public');
    fs.mkdirSync(publicDir, {mode: 0o755});
    fs.chmodSync(publicDir, 0o755);
    await expect(runNativeChecklistProgressDisplay(args({outputDir: publicDir}))).rejects.toThrow(/0700/);
  });

  it('rejects checkpoint or target failures before Proof and output creation', async () => {
    fs.writeFileSync(checkpointPath, '{"tampered":true}', {mode: 0o600});
    await expect(runNativeChecklistProgressDisplay(args())).rejects.toThrow(/checkpoint|JSON|integrity/i);
    expect(fs.existsSync(callLog)).toBe(false);
    expect(outputPaths().some(target => fs.existsSync(target))).toBe(false);

    fs.writeFileSync(checkpointPath, `${canonicalGraphCheckpointJson(checkpoint)}\n`, {mode: 0o600});
    restore.mockImplementationOnce(() => {
      throw new Error('CHECKPOINT_GRAPH_MISMATCH');
    });
    await expect(runNativeChecklistProgressDisplay(args())).rejects.toThrow(/CHECKPOINT_GRAPH_MISMATCH/);
    expect(fs.existsSync(callLog)).toBe(false);
    expect(outputPaths().some(target => fs.existsSync(target))).toBe(false);

    const otherTarget = privateDirectory(root, 'other-target');
    projection.claimsById = {
      project: {
        claimId: 'project', claim: 'native.project.item@1', active: true,
        payload: {id: 'project', target: {path: otherTarget}, state: {}},
      },
    };
    await expect(runNativeChecklistProgressDisplay(args())).rejects.toThrow(/target-root/);
    expect(fs.existsSync(callLog)).toBe(false);
    expect(outputPaths().some(target => fs.existsSync(target))).toBe(false);
  });

  it('does not create outputs when the fresh Proof command fails', async () => {
    process.env.NATIVE_DISPLAY_PROOF_FAIL = '1';
    process.env.NATIVE_DISPLAY_PROOF_LOG = callLog;
    try {
      await expect(runNativeChecklistProgressDisplay(args())).rejects.toThrow(/exit 9/);
      expect(fs.existsSync(callLog)).toBe(true);
      expect(outputPaths().some(target => fs.existsSync(target))).toBe(false);
    } finally {
      delete process.env.NATIVE_DISPLAY_PROOF_FAIL;
      delete process.env.NATIVE_DISPLAY_PROOF_LOG;
    }
  });

  it('imports as a renderer without entering CLI mode', () => {
    const env = {
      ...process.env,
      TS_NODE_TRANSPILE_ONLY: '1',
      TS_NODE_PROJECT: path.resolve(__dirname, '../../tsconfig.json'),
    };
    const output = execFileSync(process.execPath, ['-r', TS_NODE, '-e', `require(${JSON.stringify(SOURCE)})`], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    expect(output).toBe('');
  });

  it('rejects direct CLI invocation with missing explicit paths', () => {
    const env = {
      ...process.env,
      TS_NODE_TRANSPILE_ONLY: '1',
      TS_NODE_PROJECT: path.resolve(__dirname, '../../tsconfig.json'),
    };
    expect(() => execFileSync(process.execPath, ['-r', TS_NODE, SOURCE, 'display'], {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
    })).toThrow();
    expect(outputPaths().some(target => fs.existsSync(target))).toBe(false);
  });
});
