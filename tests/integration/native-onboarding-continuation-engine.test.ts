import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {jest} from '@jest/globals';
import {AIReviewService} from '../../src/ai-review-service';
import {loadConfig, StateMachineExecutionEngine} from '../../src/sdk';
import {worktreeManager} from '../../src/utils/worktree-manager';
import {canonicalGraphCheckpointJson, ExecutionJournal} from '../../src/snapshot-store';
import {canonicalJson} from '../../src/state-machine/graph/claim-kernel';
import {compileClaimPlan} from '../../src/state-machine/graph/claim-plan';
import {
  buildChecklistContinuationConfig,
  executeChecklistContinuationEngine,
} from '../../examples/agent-governance/native-onboarding/run-onboarding';

type WorkItem = {
  version: 'reqproof.onboarding-component-work-item/v1';
  project_id: string;
  component_id: string;
  sorted_owned_paths: string[];
  sorted_dependency_closure: string[];
  proof_path_mapping: Record<string, unknown>;
  proof_input_state: Array<Record<string, unknown>>;
  proof_component_subject: {fingerprint: string};
  baseline_commit: string;
};

function continuationAuthority(workItem: WorkItem): Record<string, unknown> {
  const subjectFingerprint = `sha256:${'b'.repeat(64)}`;
  const receipt = {
    inventory_claim_id: `sha256:${'1'.repeat(64)}`,
    catalog_claim_id: `sha256:${'2'.repeat(64)}`,
    receipt_id: `sha256:${'3'.repeat(64)}`,
    admission_candidate_id: `sha256:${'4'.repeat(64)}`,
    admission_receipt_id: `sha256:${'5'.repeat(64)}`,
    component_authorities: [{
      component_id: workItem.component_id,
      work_item_digest: `sha256:${'6'.repeat(64)}`,
      subject: workItem.proof_component_subject,
    }],
  };
  return {
    version: 'native.checklist-continuation-authority/v1',
    project_id: workItem.project_id,
    subject_fingerprint: subjectFingerprint,
    current_inventory: {authority: {project_id: workItem.project_id, subject_fingerprint: subjectFingerprint}},
    current_revalidation: {receipt},
    current_work_items: [workItem],
    current_receipt_identities: receipt,
    retained: {
      checkpoint_sha256: `sha256:${'7'.repeat(64)}`,
      prefix_checkpoint_sha256: `sha256:${'8'.repeat(64)}`,
      checkpoint_session_id: 'retained-checkpoint',
      prefix_session_id: 'retained-prefix',
      checkpoint_graph_semantic_digest: `digest-${'9'.repeat(64)}`,
      prefix_graph_semantic_digest: `digest-${'a'.repeat(64)}`,
    },
    affected_component_ids: ['component-a'],
    reused_component_ids: [],
  };
}

function continuationSnapshot(): Record<string, unknown> {
  return {
    schema_version: 'proof.checklist.show.v1',
    checklist: 'onboard_v1',
    active: true,
    new_project: true,
    steps: [{step_id: 'traces-light', title: 'Trace links', applicable: true, eligible: true, stored_status: 'pending', effective_status: 'pending', required_checks: [], check_results: []}],
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {encoding: 'utf8'}).trim();
}

function makeGitFixture(): {root: string; writerParent: string; output: string; proof: string; checklistState: string; checklistCalls: string; workItem: WorkItem; cleanup: () => void} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-continuation-canonical-'));
  const writerParent = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-continuation-writers-'));
  const helperRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-continuation-helper-'));
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-continuation-output-'));
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'Visor continuation test']);
  fs.writeFileSync(path.join(root, 'source.go'), 'package fixture\n\nfunc Source() {}\n', 'utf8');
  git(root, ['add', 'source.go']);
  git(root, ['commit', '--quiet', '-m', 'baseline']);
  const commit = git(root, ['rev-parse', 'HEAD']);
  const proof = path.join(helperRoot, 'proof-fixture.js');
  const checklistState = path.join(helperRoot, 'checklist-state.json');
  const checklistCalls = path.join(helperRoot, 'checklist-calls.jsonl');
  fs.writeFileSync(proof, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.CONTINUATION_FIXTURE_CALL_LOG) fs.appendFileSync(process.env.CONTINUATION_FIXTURE_CALL_LOG, JSON.stringify({args, cwd: process.cwd()}) + '\\n');
const checklistRow = () => {
  const confirmed = process.env.CONTINUATION_FIXTURE_CHECKLIST_STATE && fs.existsSync(process.env.CONTINUATION_FIXTURE_CHECKLIST_STATE) && JSON.parse(fs.readFileSync(process.env.CONTINUATION_FIXTURE_CHECKLIST_STATE, 'utf8')).status === 'confirmed';
  return confirmed
    ? {step_id: 'traces-light', applicable: true, eligible: false, stored_status: 'confirmed', effective_status: 'confirmed', stamp: 'confirm+verify', required_checks: [], check_results: [], verify_result: {passed: true, exit_code: 0, at: '2026-09-09T00:00:02Z'}}
    : {step_id: 'traces-light', applicable: true, eligible: true, stored_status: 'pending', effective_status: 'pending', stamp: 'confirm+verify', required_checks: [], check_results: []};
};
if (args[0] === 'checklist' && args[1] === 'show') process.stdout.write(JSON.stringify({schema_version: 'proof.checklist.show.v1', checklist: 'onboard_v1', active: true, new_project: true, steps: [checklistRow()]}));
else if (args[0] === 'checklist' && args[1] === 'confirm') { fs.writeFileSync(process.env.CONTINUATION_FIXTURE_CHECKLIST_STATE, JSON.stringify({status: 'confirmed'})); }
else if (args[0] === 'role' && args[1] === 'show') process.stdout.write('onboard role\\n');
else if (args[0] === 'req' && args[1] === 'list') process.stdout.write(JSON.stringify([{id: 'REQ-1', file_path: 'specs/REQ-1.req.yaml', component: 'component-a'}]));
else if (args[0] === 'var' && args[1] === 'list') process.stdout.write('[]');
else if (args[0] === 'var' && args[1] === 'diagnose') process.stdout.write(JSON.stringify({variables: []}));
else if (args[0] === 'audit') {
  const requested = args[args.indexOf('--check') + 1];
  const check = process.env.CONTINUATION_FIXTURE_AUDIT_MODE === 'mismatch' && requested === 'orphan_code_clean'
    ? 'annotation_validity'
    : requested;
  const stage = 'implement';
  process.stdout.write(JSON.stringify({event: 'stage_start', stage}) + '\\n' + JSON.stringify({event: 'check_done', stage, check, status: 'pass'}) + '\\n');
}
else process.stdout.write(JSON.stringify({status: 'pass'}));
`, {encoding: 'utf8', mode: 0o700});
  fs.chmodSync(proof, 0o700);
  const workItem: WorkItem = {
    version: 'reqproof.onboarding-component-work-item/v1',
    project_id: 'project-a',
    component_id: 'component-a',
    sorted_owned_paths: ['source.go'],
    sorted_dependency_closure: ['source.go'],
    proof_path_mapping: {},
    proof_input_state: [{}],
    proof_component_subject: {fingerprint: `sha256:${'a'.repeat(64)}`},
    baseline_commit: commit,
  };
  return {
    root,
    writerParent,
    output,
    proof,
    checklistState,
    checklistCalls,
    workItem,
    cleanup: () => {
      try { git(root, ['worktree', 'list', '--porcelain']); } catch {}
      fs.rmSync(writerParent, {recursive: true, force: true});
      fs.rmSync(root, {recursive: true, force: true});
      fs.rmSync(helperRoot, {recursive: true, force: true});
      fs.rmSync(output, {recursive: true, force: true});
    },
  };
}

describe('production traces-light continuation graph', () => {
  jest.setTimeout(60000);
  it('reaches a paused traces-light frontier with no model dispatch', async () => {
    const fixture = makeGitFixture();
    const previous = new Map<string, string | undefined>([
      ['PROOF_BIN', process.env.PROOF_BIN],
      ['VISOR_WORKSPACE_MAIN_PROJECT', process.env.VISOR_WORKSPACE_MAIN_PROJECT],
      ['NATIVE_ONBOARDING_WORKTREE_ROOT', process.env.NATIVE_ONBOARDING_WORKTREE_ROOT],
      ['NATIVE_CHECKLIST_CONTINUE_CATALOG', process.env.NATIVE_CHECKLIST_CONTINUE_CATALOG],
      ['REQUEST_TIMEOUT', process.env.REQUEST_TIMEOUT],
      ['NATIVE_ONBOARDING_TS_NODE', process.env.NATIVE_ONBOARDING_TS_NODE],
      ['NATIVE_ONBOARDING_REPO_ROOT', process.env.NATIVE_ONBOARDING_REPO_ROOT],
      ['NATIVE_ONBOARDING_OUTPUT_DIR', process.env.NATIVE_ONBOARDING_OUTPUT_DIR],
      ['CONTINUATION_FIXTURE_CALL_LOG', process.env.CONTINUATION_FIXTURE_CALL_LOG],
      ['CONTINUATION_FIXTURE_CHECKLIST_STATE', process.env.CONTINUATION_FIXTURE_CHECKLIST_STATE],
      ['CONTINUATION_FIXTURE_AUDIT_MODE', process.env.CONTINUATION_FIXTURE_AUDIT_MODE],
      ['NATIVE_CHECKLIST_CONTINUE_SNAPSHOT', process.env.NATIVE_CHECKLIST_CONTINUE_SNAPSHOT],
    ]);
    const previousWorktreeConfig = worktreeManager.getConfig();
    const fixtureWorktreeCache = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-continuation-cache-'));
    worktreeManager.configure({base_path: fixtureWorktreeCache, cleanup_on_exit: false});
    let testCheckout: string | undefined;
    const ai = jest.spyOn(AIReviewService.prototype, 'executeReview').mockImplementation(async function () {
      const checkout = (this as any).config?.path as string;
      testCheckout = checkout;
      expect((this as any).config?.model).toBe('gpt-5.6-luna');
      expect((this as any).config?.codexExecutionProfile).toBe('luna-xhigh-isolated-writer-v1');
      expect((this as any).config?.codexWorkingDirectoryFrom).toBe('checkout-worktree');
      const effectiveCwd = fs.realpathSync(checkout);
      expect(effectiveCwd).not.toBe(fs.realpathSync(fixture.root));
      expect(fs.realpathSync(git(checkout, ['rev-parse', '--show-toplevel']))).toBe(effectiveCwd);
      expect(() => git(checkout, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).toThrow();
      fs.appendFileSync(path.join(checkout, 'source.go'), '// Implements: REQ-1\n', 'utf8');
      return {issues: [], output: {status: 'no-model-mock'}} as any;
    });
    try {
      process.env.PROOF_BIN = fixture.proof;
      process.env.VISOR_WORKSPACE_MAIN_PROJECT = fixture.root;
      process.env.NATIVE_ONBOARDING_WORKTREE_ROOT = fixture.writerParent;
      process.env.NATIVE_CHECKLIST_CONTINUE_CATALOG = JSON.stringify({
        components: [fixture.workItem],
        full_components: [fixture.workItem],
        affected_component_ids: ['component-a'],
        reused_component_ids: [],
        retained_receipt_identities: ['retained-fixture-receipt'],
        current_receipt_identities: ['current-fixture-receipt'],
        authority: continuationAuthority(fixture.workItem),
      });
      process.env.REQUEST_TIMEOUT = '120000';
      process.env.NATIVE_ONBOARDING_TS_NODE = require.resolve('ts-node/register/transpile-only');
      process.env.NATIVE_ONBOARDING_REPO_ROOT = process.cwd();
      process.env.NATIVE_ONBOARDING_OUTPUT_DIR = fixture.output;
      process.env.CONTINUATION_FIXTURE_CALL_LOG = fixture.checklistCalls;
      process.env.CONTINUATION_FIXTURE_CHECKLIST_STATE = fixture.checklistState;
      process.env.NATIVE_CHECKLIST_CONTINUE_SNAPSHOT = JSON.stringify(continuationSnapshot());
      const config = await loadConfig(buildChecklistContinuationConfig() as any, {strict: true});
      const engine = new StateMachineExecutionEngine(fixture.root);
      const paused = await executeChecklistContinuationEngine(engine, config, 120000, ['component-a']);
      expect(paused).toMatchObject({paused: true});
      const promotion = paused.checkpoint.events.find(event => event.type === 'ClaimPublished' && event.claim === 'native.continuation.promotion@1') as any;
      expect(promotion?.payload).toBeDefined();
      expect(promotion.payload.baseline_commit).toBe(fixture.workItem.baseline_commit);
      expect(promotion.payload.accepted_paths).toEqual(['source.go']);
      expect(promotion.payload.ignored_paths).toEqual([]);
      expect(promotion.payload.rejected_paths).toEqual([]);
      expect(promotion.payload.promoted_commit).toBe(git(fixture.root, ['rev-parse', 'HEAD']));
      expect(promotion.payload.validation).toMatchObject({status: 0, stderr: ''});
      expect(promotion.payload.checkpoint).toEqual({
        baseline_commit: fixture.workItem.baseline_commit,
        component_id: 'component-a',
        accepted_paths: ['source.go'],
        ignored_paths: [],
        status: 'promoted',
      });
      expect(git(fixture.root, ['status', '--porcelain'])).toBe('');
      expect(git(fixture.root, ['rev-parse', 'HEAD'])).not.toBe(fixture.workItem.baseline_commit);
      expect(git(fixture.root, ['diff', '--name-only', `${fixture.workItem.baseline_commit}..HEAD`])).toBe('source.go');
      expect(git(fixture.root, ['diff', '--numstat', `${fixture.workItem.baseline_commit}..HEAD`])).toBe('1\t0\tsource.go');
      expect(git(fixture.root, ['show', 'HEAD:source.go'])).toBe('package fixture\n\nfunc Source() {}\n// Implements: REQ-1');
      const savedConfigPath = path.join(fixture.output, 'checklist-materialized-config.json');
      const savedCheckpointPath = path.join(fixture.output, 'checklist-traces-light-frontier-checkpoint.json');
      fs.writeFileSync(savedConfigPath, canonicalJson(config) + '\n', {encoding: 'utf8', mode: 0o600});
      fs.writeFileSync(savedCheckpointPath, canonicalGraphCheckpointJson(paused.checkpoint) + '\n', {encoding: 'utf8', mode: 0o600});
      const restoredConfig = await loadConfig(JSON.parse(fs.readFileSync(savedConfigPath, 'utf8')) as any, {strict: true});
      const restoredCheckpoint = ExecutionJournal.validateGraphCheckpointIntegrity(JSON.parse(fs.readFileSync(savedCheckpointPath, 'utf8')));
      expect(restoredCheckpoint.graphSemanticDigest).toBe(compileClaimPlan(restoredConfig).expansionPlan.graphSemanticDigest);
      fs.writeFileSync(fixture.checklistCalls, '', 'utf8');
      const freshEngine = new StateMachineExecutionEngine(fixture.root);
      const resumed = await executeChecklistContinuationEngine(freshEngine, restoredConfig, 120000, ['component-a'], restoredCheckpoint);
      expect(resumed.paused).toBe(false);
      expect(resumed.checkpoint.sessionId).toBe(restoredCheckpoint.sessionId);
      expect(resumed.checkpoint.graphSemanticDigest).toBe(restoredCheckpoint.graphSemanticDigest);
      expect(canonicalGraphCheckpointJson(resumed.checkpoint.events.slice(0, restoredCheckpoint.events.length))).toBe(canonicalGraphCheckpointJson(restoredCheckpoint.events));
      const suffix = resumed.checkpoint.events.slice(restoredCheckpoint.events.length);
      expect(suffix.filter(event => event.type === 'AttemptStarted').map(event => event.checkId)).toEqual(['checklist-traces-light']);
      expect(ai).toHaveBeenCalledTimes(1);
      const resumeCalls = fs.readFileSync(fixture.checklistCalls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).args as string[]);
      expect(resumeCalls.map(args => args.slice(0, 2))).toEqual([
        ['checklist', 'show'],
        ['checklist', 'confirm'],
        ['checklist', 'show'],
      ]);
      expect(resumeCalls.some(args => args[0] === 'role' || args[0] === 'audit')).toBe(false);

      const tampered = JSON.parse(JSON.stringify(restoredCheckpoint)) as any;
      tampered.integrity.digest = '0'.repeat(64);
      fs.writeFileSync(fixture.checklistCalls, '', 'utf8');
      const tamperedEngine = new StateMachineExecutionEngine(fixture.root);
      const resumeGraphSpy = jest.spyOn(tamperedEngine, 'resumeGraphCheckpoint');
      await expect(executeChecklistContinuationEngine(tamperedEngine, restoredConfig, 120000, ['component-a'], tampered))
        .rejects.toThrow(/resume checkpoint is invalid/i);
      expect(resumeGraphSpy).not.toHaveBeenCalled();
      expect(ai).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(fixture.checklistCalls, 'utf8')).toBe('');
      resumeGraphSpy.mockRestore();
    } finally {
      ai.mockRestore();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (testCheckout) {
        const worktree = (await worktreeManager.listWorktrees()).find(entry => entry.path === testCheckout || entry.metadata.worktree_path === testCheckout);
        if (worktree) await worktreeManager.removeWorktree(worktree.id);
      }
      worktreeManager.configure(previousWorktreeConfig);
      fs.rmSync(fixtureWorktreeCache, {recursive: true, force: true});
      fixture.cleanup();
    }
  });

  it('rejects a mismatched orphan audit receipt before traces confirmation', async () => {
    const fixture = makeGitFixture();
    const previous = new Map<string, string | undefined>([
      ['PROOF_BIN', process.env.PROOF_BIN],
      ['VISOR_WORKSPACE_MAIN_PROJECT', process.env.VISOR_WORKSPACE_MAIN_PROJECT],
      ['NATIVE_ONBOARDING_WORKTREE_ROOT', process.env.NATIVE_ONBOARDING_WORKTREE_ROOT],
      ['NATIVE_CHECKLIST_CONTINUE_CATALOG', process.env.NATIVE_CHECKLIST_CONTINUE_CATALOG],
      ['REQUEST_TIMEOUT', process.env.REQUEST_TIMEOUT],
      ['NATIVE_ONBOARDING_TS_NODE', process.env.NATIVE_ONBOARDING_TS_NODE],
      ['NATIVE_ONBOARDING_REPO_ROOT', process.env.NATIVE_ONBOARDING_REPO_ROOT],
      ['NATIVE_ONBOARDING_OUTPUT_DIR', process.env.NATIVE_ONBOARDING_OUTPUT_DIR],
      ['CONTINUATION_FIXTURE_CALL_LOG', process.env.CONTINUATION_FIXTURE_CALL_LOG],
      ['CONTINUATION_FIXTURE_CHECKLIST_STATE', process.env.CONTINUATION_FIXTURE_CHECKLIST_STATE],
      ['CONTINUATION_FIXTURE_AUDIT_MODE', process.env.CONTINUATION_FIXTURE_AUDIT_MODE],
      ['NATIVE_CHECKLIST_CONTINUE_SNAPSHOT', process.env.NATIVE_CHECKLIST_CONTINUE_SNAPSHOT],
    ]);
    const previousWorktreeConfig = worktreeManager.getConfig();
    const fixtureWorktreeCache = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-continuation-cache-'));
    worktreeManager.configure({base_path: fixtureWorktreeCache, cleanup_on_exit: false});
    let testCheckout: string | undefined;
    const ai = jest.spyOn(AIReviewService.prototype, 'executeReview').mockImplementation(async function () {
      const checkout = (this as any).config?.path as string;
      testCheckout = checkout;
      fs.appendFileSync(path.join(checkout, 'source.go'), '// Implements: REQ-1\n', 'utf8');
      return {issues: [], output: {status: 'no-model-mock'}} as any;
    });
    try {
      process.env.PROOF_BIN = fixture.proof;
      process.env.VISOR_WORKSPACE_MAIN_PROJECT = fixture.root;
      process.env.NATIVE_ONBOARDING_WORKTREE_ROOT = fixture.writerParent;
      process.env.NATIVE_CHECKLIST_CONTINUE_CATALOG = JSON.stringify({
        components: [fixture.workItem],
        full_components: [fixture.workItem],
        affected_component_ids: ['component-a'],
        reused_component_ids: [],
        retained_receipt_identities: ['retained-fixture-receipt'],
        current_receipt_identities: ['current-fixture-receipt'],
        authority: continuationAuthority(fixture.workItem),
      });
      process.env.REQUEST_TIMEOUT = '120000';
      process.env.NATIVE_ONBOARDING_TS_NODE = require.resolve('ts-node/register/transpile-only');
      process.env.NATIVE_ONBOARDING_REPO_ROOT = process.cwd();
      process.env.NATIVE_ONBOARDING_OUTPUT_DIR = fixture.output;
      process.env.CONTINUATION_FIXTURE_CALL_LOG = fixture.checklistCalls;
      process.env.CONTINUATION_FIXTURE_CHECKLIST_STATE = fixture.checklistState;
      process.env.NATIVE_CHECKLIST_CONTINUE_SNAPSHOT = JSON.stringify(continuationSnapshot());
      process.env.CONTINUATION_FIXTURE_AUDIT_MODE = 'mismatch';
      const config = await loadConfig(buildChecklistContinuationConfig() as any, {strict: true});
      const engine = new StateMachineExecutionEngine(fixture.root);
      await expect(executeChecklistContinuationEngine(engine, config, 120000, ['component-a']))
        .rejects.toThrow(/failed before traces-light frontier/);
      const checkpoint = engine.exportGraphCheckpoint();
      expect(checkpoint.events.some(event => event.type === 'AttemptFailed' && event.checkId === 'orphan_code_clean')).toBe(true);
      expect(checkpoint.events.some(event => event.type === 'AttemptStarted' && event.checkId === 'checklist-traces-light')).toBe(false);
    } finally {
      ai.mockRestore();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (testCheckout) {
        const worktree = (await worktreeManager.listWorktrees()).find(entry => entry.path === testCheckout || entry.metadata.worktree_path === testCheckout);
        if (worktree) await worktreeManager.removeWorktree(worktree.id);
      }
      worktreeManager.configure(previousWorktreeConfig);
      fs.rmSync(fixtureWorktreeCache, {recursive: true, force: true});
      fixture.cleanup();
    }
  });

  it('rejects a valid partial generated frontier before any resume provider dispatch', async () => {
    const fixture = makeGitFixture();
    const previous = new Map<string, string | undefined>([
      ['PROOF_BIN', process.env.PROOF_BIN],
      ['VISOR_WORKSPACE_MAIN_PROJECT', process.env.VISOR_WORKSPACE_MAIN_PROJECT],
      ['NATIVE_ONBOARDING_WORKTREE_ROOT', process.env.NATIVE_ONBOARDING_WORKTREE_ROOT],
      ['NATIVE_CHECKLIST_CONTINUE_CATALOG', process.env.NATIVE_CHECKLIST_CONTINUE_CATALOG],
      ['REQUEST_TIMEOUT', process.env.REQUEST_TIMEOUT],
      ['NATIVE_ONBOARDING_TS_NODE', process.env.NATIVE_ONBOARDING_TS_NODE],
      ['NATIVE_ONBOARDING_REPO_ROOT', process.env.NATIVE_ONBOARDING_REPO_ROOT],
      ['NATIVE_ONBOARDING_OUTPUT_DIR', process.env.NATIVE_ONBOARDING_OUTPUT_DIR],
      ['CONTINUATION_FIXTURE_CALL_LOG', process.env.CONTINUATION_FIXTURE_CALL_LOG],
      ['CONTINUATION_FIXTURE_CHECKLIST_STATE', process.env.CONTINUATION_FIXTURE_CHECKLIST_STATE],
      ['CONTINUATION_FIXTURE_AUDIT_MODE', process.env.CONTINUATION_FIXTURE_AUDIT_MODE],
      ['NATIVE_CHECKLIST_CONTINUE_SNAPSHOT', process.env.NATIVE_CHECKLIST_CONTINUE_SNAPSHOT],
    ]);
    const previousWorktreeConfig = worktreeManager.getConfig();
    const fixtureWorktreeCache = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-continuation-cache-'));
    worktreeManager.configure({base_path: fixtureWorktreeCache, cleanup_on_exit: false});
    const ai = jest.spyOn(AIReviewService.prototype, 'executeReview');
    try {
      process.env.PROOF_BIN = fixture.proof;
      process.env.VISOR_WORKSPACE_MAIN_PROJECT = fixture.root;
      process.env.NATIVE_ONBOARDING_WORKTREE_ROOT = fixture.writerParent;
      process.env.NATIVE_CHECKLIST_CONTINUE_CATALOG = JSON.stringify({
        components: [fixture.workItem],
        full_components: [fixture.workItem],
        affected_component_ids: ['component-a'],
        reused_component_ids: [],
        retained_receipt_identities: ['retained-fixture-receipt'],
        current_receipt_identities: ['current-fixture-receipt'],
        authority: continuationAuthority(fixture.workItem),
      });
      process.env.REQUEST_TIMEOUT = '120000';
      process.env.NATIVE_ONBOARDING_TS_NODE = require.resolve('ts-node/register/transpile-only');
      process.env.NATIVE_ONBOARDING_REPO_ROOT = process.cwd();
      process.env.NATIVE_ONBOARDING_OUTPUT_DIR = fixture.output;
      process.env.CONTINUATION_FIXTURE_CALL_LOG = fixture.checklistCalls;
      process.env.CONTINUATION_FIXTURE_CHECKLIST_STATE = fixture.checklistState;
      process.env.NATIVE_CHECKLIST_CONTINUE_SNAPSHOT = JSON.stringify(continuationSnapshot());
      delete process.env.CONTINUATION_FIXTURE_AUDIT_MODE;
      const config = await loadConfig(buildChecklistContinuationConfig() as any, {strict: true});
      const engine = new StateMachineExecutionEngine(fixture.root);
      const partialResult = await engine.executeGroupedChecks(
        {
          number: 0,
          title: 'continuation fixture',
          body: '',
          author: 'continuation-fixture',
          base: 'main',
          head: 'subject',
          files: [],
          totalAdditions: 0,
          totalDeletions: 0,
          eventType: 'manual',
        } as any,
        ['continue-retained-catalog'],
        120000,
        config,
        'json',
        false,
        config.max_parallelism,
        false,
        undefined,
        (generation: any) => generation.checkId === 'materialize-retained-catalog' ? 'defer' : 'dispatch',
      );
      expect(partialResult.statistics.failedExecutions).toBe(0);
      const partial = ExecutionJournal.validateGraphCheckpointIntegrity(engine.exportGraphCheckpoint());
      expect(partial.events.some(event => event.type === 'NodeGenerationActivated' && event.checkId === 'materialize-retained-catalog')).toBe(true);
      expect(partial.events.some(event => event.type === 'AttemptStarted' && event.checkId === 'materialize-retained-catalog')).toBe(false);
      fs.writeFileSync(fixture.checklistCalls, '', 'utf8');
      const freshEngine = new StateMachineExecutionEngine(fixture.root);
      const resumeGraphSpy = jest.spyOn(freshEngine, 'resumeGraphCheckpoint');
      await expect(executeChecklistContinuationEngine(freshEngine, config, 120000, ['component-a'], partial))
        .rejects.toThrow(/clean traces-light frontier/i);
      expect(resumeGraphSpy).not.toHaveBeenCalled();
      expect(ai).not.toHaveBeenCalled();
      expect(fs.readFileSync(fixture.checklistCalls, 'utf8')).toBe('');
      resumeGraphSpy.mockRestore();
    } finally {
      ai.mockRestore();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      worktreeManager.configure(previousWorktreeConfig);
      fs.rmSync(fixtureWorktreeCache, {recursive: true, force: true});
      fixture.cleanup();
    }
  });
});
