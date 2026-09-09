import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
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
  validateJournaledContinuationAuthority,
} from '../../examples/agent-governance/native-onboarding/run-onboarding';
import {
  buildNativeChecklistProgressFromProjections,
  renderNativeChecklistProgress,
} from '../../examples/agent-governance/native-onboarding/native-checklist-progress';

type WorkItem = {
  version: 'reqproof.onboarding-component-work-item/v1';
  project_id: string;
  component_id: string;
  sorted_owned_paths: string[];
  sorted_dependency_closure: string[];
  proof_path_mapping: Record<string, unknown>;
  proof_input_state: Array<Record<string, unknown>>;
  proof_component_subject: {component_id: string; fingerprint: string};
  baseline_commit: string;
};

type ContinuationTask = {
  step_id: 'traces-light';
  role: 'onboard';
  required_checks: ['annotation_validity', 'orphan_code_clean'];
  orphan_code_clean: {paths: string[]; details: string[]};
};

type SkeletonContinuationTask = {
  step_id: 'skeleton';
  role: 'onboard';
  required_checks: ['l0_stakeholder_complete', 'l1_system_complete', 'l2_software_complete', 'levels_connected'];
  l2_software_complete: {paths: string[]; details: string[]};
};

type VariablesContinuationTask = {
  step_id: 'variables';
  role: 'onboard';
  required_checks: ['variable_orphans_clean', 'variables_declared', 'variable_drift'];
};

type OperationalWorkItem = WorkItem & {continuation_task: ContinuationTask};

function operationalWorkItem(
  workItem: WorkItem,
  paths: string[],
  details: string[],
): OperationalWorkItem {
  return {
    ...workItem,
    continuation_task: {
      step_id: 'traces-light',
      role: 'onboard',
      required_checks: ['annotation_validity', 'orphan_code_clean'],
      orphan_code_clean: {paths, details},
    },
  };
}

function operationalSkeletonWorkItem(
  workItem: WorkItem,
  paths: string[],
  details: string[],
): WorkItem & {continuation_task: SkeletonContinuationTask} {
  return {
    ...workItem,
    continuation_task: {
      step_id: 'skeleton',
      role: 'onboard',
      required_checks: ['l0_stakeholder_complete', 'l1_system_complete', 'l2_software_complete', 'levels_connected'],
      l2_software_complete: {paths, details},
    },
  };
}

function continuationAuthority(
  workItems: readonly WorkItem[],
  affectedComponentIds: readonly string[] = ['component-a'],
  reusedComponentIds: readonly string[] = [],
): Record<string, unknown> {
  const subjectFingerprint = `sha256:${'b'.repeat(64)}`;
  const inventory = {
    version: 'proof.structural-inventory/v1',
    authority: {
      version: 'proof.project-authority/v1',
      project_id: workItems[0].project_id,
      subject_fingerprint: subjectFingerprint,
    },
    sorted_paths: workItems.flatMap(item => item.sorted_owned_paths).sort(),
    sorted_module_paths: [],
    boundary_fingerprint: `sha256:${'c'.repeat(64)}`,
    input_state: workItems.flatMap(item => item.proof_input_state),
  };
  const receipt = {
    inventory_claim_id: `sha256:${'1'.repeat(64)}`,
    catalog_claim_id: `sha256:${'2'.repeat(64)}`,
    receipt_id: `sha256:${'3'.repeat(64)}`,
    admission_candidate_id: `sha256:${'4'.repeat(64)}`,
    admission_receipt_id: `sha256:${'5'.repeat(64)}`,
    component_authorities: workItems.map((workItem, index) => ({
      component_id: workItem.component_id,
      work_item_digest: `sha256:${String(index + 6).repeat(64)}`,
      subject: workItem.proof_component_subject,
    })).sort((left, right) => left.component_id.localeCompare(right.component_id)),
  };
  return {
    version: 'native.checklist-continuation-authority/v1',
    project_id: workItems[0].project_id,
    subject_fingerprint: subjectFingerprint,
    current_inventory: inventory,
    current_revalidation: {
      version: 'proof.catalog-revalidation/v2',
      inventory,
      catalog: {version: 'proof.onboarding-work-item-catalog/v1', work_items: workItems},
      receipt,
    },
    current_work_items: workItems,
    current_receipt_identities: receipt,
    retained: {
      checkpoint_sha256: `sha256:${'7'.repeat(64)}`,
      prefix_checkpoint_sha256: `sha256:${'8'.repeat(64)}`,
      checkpoint_path: '/__visor_test__/retained/checkpoint.json',
      prefix_checkpoint_path: '/__visor_test__/retained/prefix-checkpoint.json',
      checkpoint_session_id: 'retained-checkpoint',
      prefix_session_id: 'retained-prefix',
      checkpoint_graph_semantic_digest: `digest-${'9'.repeat(64)}`,
      prefix_graph_semantic_digest: `digest-${'a'.repeat(64)}`,
    },
    affected_component_ids: [...affectedComponentIds],
    reused_component_ids: [...reusedComponentIds],
  };
}

function continuationSnapshot(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../fixtures/native-onboarding/checklist-show-onboard-v1.json'),
    'utf8',
  )) as Record<string, unknown>;
}

function skeletonContinuationSnapshot(): Record<string, unknown> {
  const snapshot = continuationSnapshot();
  const steps = (snapshot.steps as Array<Record<string, unknown>>).map(step => {
    if (step.step_id === 'skeleton') {
      const {confirmed_at: _confirmedAt, confirmed_by: _confirmedBy, note: _note, verify_result: _verifyResult, ...pending} = step;
      return {...pending, eligible: true, stored_status: 'pending', effective_status: 'pending', unmet_requires: [], check_results: []};
    }
    if (step.step_id === 'traces-light') return {...step, eligible: false, unmet_requires: ['skeleton']};
    return step;
  });
  const skeleton = steps.find(step => step.step_id === 'skeleton') as Record<string, unknown>;
  return {
    ...snapshot,
    steps_pending: 13,
    counts: {...(snapshot.counts as Record<string, number>), confirmed: 2, pending: 1, blocked: 12},
    eligible_step_ids: ['skeleton'],
    next: {
      step_id: 'skeleton', title: skeleton.title, role: skeleton.role, stamp: skeleton.stamp,
      scope: skeleton.scope, notes_required: skeleton.notes_required, requires: skeleton.requires,
      required_checks: skeleton.required_checks,
    },
    steps,
  };
}

function confirmedSkeletonContinuationSnapshot(): Record<string, unknown> {
  const snapshot = skeletonContinuationSnapshot();
  const steps = (snapshot.steps as Array<Record<string, unknown>>).map(step => step.step_id === 'skeleton'
    ? {
      ...step,
      eligible: false,
      stored_status: 'confirmed',
      effective_status: 'confirmed',
      check_results: ['l0_stakeholder_complete', 'l1_system_complete', 'l2_software_complete', 'levels_connected']
        .map(id => ({id, status: 'pass', at: '2026-09-09T06:02:00Z'})),
    }
    : step.step_id === 'traces-light'
      ? {...step, eligible: true, unmet_requires: []}
      : step);
  return {
    ...snapshot,
    steps_pending: 12,
    counts: {...(snapshot.counts as Record<string, number>), confirmed: 3, pending: 1, blocked: 11},
    eligible_step_ids: ['traces-light'],
    next: {
      step_id: 'traces-light',
      title: 'Trace links',
      role: 'onboard',
      stamp: 'confirm',
      scope: 'package',
      requires: ['skeleton'],
      required_checks: ['annotation_validity', 'orphan_code_clean'],
    },
    steps,
  };
}

function variablesContinuationSnapshot(): Record<string, unknown> {
  const snapshot = continuationSnapshot();
  const steps = (snapshot.steps as Array<Record<string, unknown>>).map(step => {
    if (step.step_id === 'traces-light') {
      return {
        ...step,
        eligible: false,
        stored_status: 'confirmed',
        effective_status: 'confirmed',
        scope_key: 'project-a',
        check_results: ['annotation_validity', 'orphan_code_clean']
          .map(id => ({id, status: 'pass', at: '2026-09-09T06:01:00Z'})),
      };
    }
    if (step.step_id === 'variables') return {...step, eligible: true, unmet_requires: []};
    return step;
  });
  const variables = steps.find(step => step.step_id === 'variables') as Record<string, unknown>;
  return {
    ...snapshot,
    steps_pending: 1,
    counts: {...(snapshot.counts as Record<string, number>), confirmed: 4, pending: 1, blocked: 10},
    eligible_step_ids: ['variables'],
    next: {
      step_id: 'variables', title: variables.title, role: variables.role, stamp: variables.stamp,
      scope: variables.scope, notes_required: variables.notes_required, requires: variables.requires,
      required_checks: variables.required_checks,
    },
    steps,
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {encoding: 'utf8'}).trim();
}

function makeGitFixture(): {root: string; writerParent: string; output: string; proof: string; checklistState: string; checklistCalls: string; workItem: WorkItem; secondWorkItem: WorkItem; reusedWorkItem: WorkItem; cleanup: () => void} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-continuation-canonical-'));
  const writerParent = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-continuation-writers-'));
  const helperRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-continuation-helper-'));
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-continuation-output-'));
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'Visor continuation test']);
  fs.writeFileSync(path.join(root, 'source.go'), 'package fixture\n\nfunc Source() {}\n', 'utf8');
  fs.writeFileSync(path.join(root, 'second.go'), 'package fixture\n\nfunc Second() {}\n', 'utf8');
  fs.writeFileSync(path.join(root, 'reused.go'), 'package fixture\n\nfunc Reused() {}\n', 'utf8');
  git(root, ['add', 'source.go']);
  git(root, ['add', 'second.go']);
  git(root, ['add', 'reused.go']);
  git(root, ['commit', '--quiet', '-m', 'baseline']);
  const commit = git(root, ['rev-parse', 'HEAD']);
  const proof = path.join(helperRoot, 'proof-fixture.js');
  const checklistState = path.join(helperRoot, 'checklist-state.json');
  const checklistCalls = path.join(helperRoot, 'checklist-calls.jsonl');
  fs.writeFileSync(proof, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (process.env.CONTINUATION_FIXTURE_CALL_LOG) fs.appendFileSync(process.env.CONTINUATION_FIXTURE_CALL_LOG, JSON.stringify({args, cwd: process.cwd()}) + '\\n');
const checklistSnapshot = () => {
  const snapshot = JSON.parse(process.env.NATIVE_CHECKLIST_CONTINUE_SNAPSHOT || '{}');
  const confirmed = process.env.CONTINUATION_FIXTURE_CHECKLIST_STATE && fs.existsSync(process.env.CONTINUATION_FIXTURE_CHECKLIST_STATE) && JSON.parse(fs.readFileSync(process.env.CONTINUATION_FIXTURE_CHECKLIST_STATE, 'utf8')).status === 'confirmed';
  const completionStep = process.env.CONTINUATION_FIXTURE_CHECKLIST_STEP || 'traces-light';
  const completionChecks = completionStep === 'skeleton'
    ? ['l0_stakeholder_complete', 'l1_system_complete', 'l2_software_complete', 'levels_connected']
    : completionStep === 'traces-light'
      ? ['annotation_validity', 'orphan_code_clean']
      : ['variable_orphans_clean', 'variables_declared', 'variable_drift'];
  if (!confirmed) return snapshot;
  const steps = Array.isArray(snapshot.steps) ? snapshot.steps.map(step => step && step.step_id === completionStep
    ? {...step, eligible: false, stored_status: 'confirmed', effective_status: 'confirmed', ...(completionStep === 'traces-light' ? {scope_key: 'project-a'} : {}), check_results: completionChecks.map(id => ({id, status: 'pass', at: '2026-09-09T06:02:00Z'})), ...(step.stamp === 'confirm+verify' ? {verify_result: {passed: true, exit_code: 0, at: '2026-09-09T06:02:00Z'}} : {})}
    : step) : [];
  if (completionStep === 'variables') {
    const nextStep = steps.find(step => step && step.step_id === 'spec-review-1');
    const resumedSteps = steps.map(step => step && step.step_id === 'spec-review-1'
      ? {...step, eligible: true, unmet_requires: []}
      : step);
    return {
      ...snapshot,
      steps_pending: 1,
      counts: {confirmed: 5, skipped: 0, not_applicable: 0, pending: 1, blocked: 9},
      eligible_step_ids: ['spec-review-1'],
      next: nextStep ? {
        step_id: nextStep.step_id, title: nextStep.title, role: nextStep.role, stamp: nextStep.stamp,
        scope: nextStep.scope, notes_required: nextStep.notes_required, requires: nextStep.requires,
        required_checks: nextStep.required_checks,
      } : null,
      steps: resumedSteps,
    };
  }
  return {
    ...snapshot,
    steps_pending: typeof snapshot.steps_pending === 'number' ? Math.max(0, snapshot.steps_pending - 1) : snapshot.steps_pending,
    counts: snapshot.counts && typeof snapshot.counts === 'object'
      ? {...snapshot.counts, confirmed: Number(snapshot.counts.confirmed || 0) + 1, pending: Math.max(0, Number(snapshot.counts.pending || 0) - 1)}
      : snapshot.counts,
    eligible_step_ids: Array.isArray(snapshot.eligible_step_ids) ? snapshot.eligible_step_ids.filter(id => id !== completionStep) : snapshot.eligible_step_ids,
    next: snapshot.next && snapshot.next.step_id === completionStep ? null : snapshot.next,
    steps,
  };
};
if (args[0] === 'checklist' && args[1] === 'show') process.stdout.write(JSON.stringify(checklistSnapshot()));
else if (args[0] === 'checklist' && args[1] === 'confirm') {
  const completionStep = process.env.CONTINUATION_FIXTURE_CHECKLIST_STEP || 'traces-light';
  const packageIndex = args.indexOf('--package');
  if (completionStep === 'traces-light' && (packageIndex < 0 || args[packageIndex + 1] !== 'project-a')) {
    process.stderr.write('step "' + completionStep + '" is package-scoped; pass package key\\n');
    process.exit(1);
  }
  fs.writeFileSync(process.env.CONTINUATION_FIXTURE_CHECKLIST_STATE, JSON.stringify({status: 'confirmed'}));
}
else if (args[0] === 'role' && args[1] === 'show') process.stdout.write('onboard role\\n');
else if (args[0] === 'req' && args[1] === 'list') {
  const component = args[args.indexOf('--component') + 1];
  const row = component === 'component-c'
    ? {id: 'REQ-2', file_path: 'specs/REQ-2.req.yaml', component: 'component-c'}
    : {id: 'REQ-1', file_path: 'specs/REQ-1.req.yaml', component: 'component-a'};
  process.stdout.write(JSON.stringify([row]));
}
else if (args[0] === 'var' && args[1] === 'list') process.stdout.write('[]');
else if (args[0] === 'var' && args[1] === 'diagnose') process.stdout.write(JSON.stringify({variables: []}));
else if (args[0] === 'audit') {
  const requested = args[args.indexOf('--check') + 1];
  const check = process.env.CONTINUATION_FIXTURE_AUDIT_MODE === 'mismatch' && requested === 'orphan_code_clean'
    ? 'annotation_validity'
    : requested;
  const skeletonChecks = new Set(['l0_stakeholder_complete', 'l1_system_complete', 'l2_software_complete', 'levels_connected']);
  const variableChecks = new Set(['variable_orphans_clean', 'variables_declared', 'variable_drift']);
  const stage = skeletonChecks.has(requested) || variableChecks.has(requested) ? 'spec' : 'implement';
  const failedSkeleton = process.env.CONTINUATION_FIXTURE_SKELETON_MODE === 'fail' && requested === 'l2_software_complete';
  const failedVariables = process.env.CONTINUATION_FIXTURE_VARIABLE_MODE === 'fail' && requested === 'variable_drift';
  const canonicalPromotionMissing = process.env.CONTINUATION_FIXTURE_REQUIRE_PROMOTED_CANONICAL === 'true'
    && requested === 'l2_software_complete'
    && !fs.readFileSync(path.join(process.cwd(), 'source.go'), 'utf8').includes('// Implements: REQ-1');
  const status = failedSkeleton || failedVariables || canonicalPromotionMissing ? 'error' : 'pass';
  const details = failedSkeleton
    ? ['SW-REQ-FAILED current native finding']
    : failedVariables
      ? ['variable drift remains in the current native subject']
      : canonicalPromotionMissing
      ? ['SW-REQ-REQ1 remains incomplete until the promoted canonical source is visible']
      : undefined;
  process.stdout.write(JSON.stringify({event: 'stage_start', stage}) + '\\n' + JSON.stringify({event: 'check_done', stage, check, status, ...(details ? {details} : {})}) + '\\n');
  if (failedSkeleton || failedVariables || canonicalPromotionMissing) process.exitCode = 1;
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
    proof_input_state: [{owner_kind: 'onboarding_structural_inventory', owner_id: 'project-a', input_kind: 'code', path: 'source.go', file_hash: `sha256:${'a'.repeat(64)}`}],
    proof_component_subject: {component_id: 'component-a', fingerprint: `sha256:${'a'.repeat(64)}`},
    baseline_commit: commit,
  };
  const secondWorkItem: WorkItem = {
    version: 'reqproof.onboarding-component-work-item/v1',
    project_id: 'project-a',
    component_id: 'component-c',
    sorted_owned_paths: ['second.go'],
    sorted_dependency_closure: ['second.go'],
    proof_path_mapping: {owned: ['second.go']},
    proof_input_state: [{owner_kind: 'onboarding_structural_inventory', owner_id: 'project-a', input_kind: 'code', path: 'second.go', file_hash: `sha256:${'c'.repeat(64)}`}],
    proof_component_subject: {component_id: 'component-c', fingerprint: `sha256:${'c'.repeat(64)}`},
    baseline_commit: commit,
  };
  const reusedWorkItem: WorkItem = {
    version: 'reqproof.onboarding-component-work-item/v1',
    project_id: 'project-a',
    component_id: 'component-b',
    sorted_owned_paths: ['reused.go'],
    sorted_dependency_closure: ['reused.go'],
    proof_path_mapping: {owned: ['reused.go']},
    proof_input_state: [{owner_kind: 'onboarding_structural_inventory', owner_id: 'project-a', input_kind: 'code', path: 'reused.go', file_hash: `sha256:${'b'.repeat(64)}`}],
    proof_component_subject: {component_id: 'component-b', fingerprint: `sha256:${'b'.repeat(64)}`},
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
    secondWorkItem,
    reusedWorkItem,
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
    const affectedWorkItems = [
      operationalWorkItem(fixture.workItem, ['source.go'], ['source.go:1 missing Implements link for REQ-1']),
      operationalWorkItem(fixture.secondWorkItem, ['second.go'], ['second.go:1 missing Documents link for REQ-2']),
    ];
    const nativeFindings: Record<string, string> = {
      'component-a': 'source.go:1 missing Implements link for REQ-1',
      'component-c': 'second.go:1 missing Documents link for REQ-2',
    };
    const testCheckouts = new Set<string>();
    const promptsByComponent = new Map<string, string>();
    const ai = jest.spyOn(AIReviewService.prototype, 'executeReview').mockImplementation(async function (_prInfo: any, customPrompt: string) {
      const componentId = ['component-a', 'component-c'].find(id => customPrompt.includes(id));
      if (!componentId) throw new Error('mock author prompt does not identify a component');
      const otherComponentId = componentId === 'component-a' ? 'component-c' : 'component-a';
      expect(customPrompt).toContain(nativeFindings[componentId]);
      expect(customPrompt).not.toContain(nativeFindings[otherComponentId]);
      promptsByComponent.set(componentId, customPrompt);
      const checkout = (this as any).config?.path as string;
      testCheckouts.add(checkout);
      expect((this as any).config?.model).toBe('gpt-5.6-luna');
      expect((this as any).config?.codexExecutionProfile).toBe('luna-xhigh-isolated-writer-v1');
      expect((this as any).config?.codexWorkingDirectoryFrom).toBe('checkout-worktree');
      const effectiveCwd = fs.realpathSync(checkout);
      expect(effectiveCwd).not.toBe(fs.realpathSync(fixture.root));
      expect(fs.realpathSync(git(checkout, ['rev-parse', '--show-toplevel']))).toBe(effectiveCwd);
      expect(() => git(checkout, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).toThrow();
      const ownedPath = componentId === 'component-a' ? 'source.go' : 'second.go';
      const marker = componentId === 'component-a' ? '// Implements: REQ-1\n' : '// Documents: REQ-2\n';
      fs.appendFileSync(path.join(checkout, ownedPath), marker, 'utf8');
      return {issues: [], output: {status: 'no-model-mock'}} as any;
    });
    try {
      process.env.PROOF_BIN = fixture.proof;
      process.env.VISOR_WORKSPACE_MAIN_PROJECT = fixture.root;
      process.env.NATIVE_ONBOARDING_WORKTREE_ROOT = fixture.writerParent;
      process.env.NATIVE_CHECKLIST_CONTINUE_CATALOG = JSON.stringify({
        components: affectedWorkItems,
        full_components: [fixture.workItem, fixture.secondWorkItem, fixture.reusedWorkItem],
        affected_component_ids: ['component-a', 'component-c'],
        reused_component_ids: ['component-b'],
        retained_receipt_identities: [`sha256:${'7'.repeat(64)}`, `sha256:${'8'.repeat(64)}`],
        current_receipt_identities: [
          `sha256:${'1'.repeat(64)}`,
          `sha256:${'2'.repeat(64)}`,
          `sha256:${'3'.repeat(64)}`,
          `sha256:${'4'.repeat(64)}`,
          `sha256:${'5'.repeat(64)}`,
          `sha256:${'6'.repeat(64)}`,
          `sha256:${'7'.repeat(64)}`,
        ],
        authority: continuationAuthority(
          [fixture.workItem, fixture.secondWorkItem, fixture.reusedWorkItem],
          ['component-a', 'component-c'],
          ['component-b'],
        ),
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
      const paused = await executeChecklistContinuationEngine(engine, config, 120000, ['component-a', 'component-c']);
      expect(paused).toMatchObject({paused: true});
      const pausedJournal = ExecutionJournal.restoreGraphCheckpoint(
        compileClaimPlan(config),
        paused.checkpoint,
      );
      const pausedProgress = buildNativeChecklistProgressFromProjections({
        claimProjection: pausedJournal.getClaimProjection(),
        instanceProjection: pausedJournal.getInstanceProjection(),
        checkpoint: paused.checkpoint,
        paused: true,
        resumed: false,
        retainedCatalogComponentIds: ['component-a', 'component-b', 'component-c'],
        affectedComponentIds: ['component-a', 'component-c'],
      });
      expect(pausedProgress.operational.catalog_coverage).toMatchObject({
        known: true,
        known_count: 3,
        affected_count: 2,
        reused_count: 1,
        unexpanded_count: 0,
      });
      expect(pausedProgress.operational.catalog_coverage.items).toEqual([
        {id: 'component-a', disposition: 'affected'},
        {id: 'component-b', disposition: 'reused'},
        {id: 'component-c', disposition: 'affected'},
      ]);
      expect(pausedProgress.operational.components.items).toHaveLength(2);
      expect(pausedProgress.operational.components.items.map(item => item.id).sort()).toEqual(['component-a', 'component-c']);
      const pausedRendered = renderNativeChecklistProgress(pausedProgress);
      expect(pausedRendered.text).toContain(
        'catalog coverage=known:3 affected:2 reused:1 unexpanded:0',
      );
      expect(pausedRendered.text).toContain('paused=true resumed=false');
      expect(pausedRendered.html).toContain(
        'catalog coverage: known=3, affected=2, reused=1, unexpanded=0',
      );
      const pausedStartedChecks = paused.checkpoint.events
        .filter(event => event.type === 'AttemptStarted')
        .map(event => event.checkId);
      const generatedStartedScopes = (checkId: string): string[] => paused.checkpoint.events
        .filter(event => event.type === 'AttemptStarted' && event.checkId === checkId)
        .map(event => {
        const keyed = event.scope.filter(part => part.kind === 'keyed');
        return keyed[keyed.length - 1]?.key;
      }).sort();
      for (const checkId of ['checkout-worktree', 'role-onboard-component', 'author-native-component', 'promote-native-component']) {
        expect(generatedStartedScopes(checkId)).toEqual(['component-a', 'component-c']);
      }
      const checkoutClaims = paused.checkpoint.events.filter(
        event => event.type === 'ClaimPublished' && event.claim === 'native.continuation.checkout@1',
      ) as any[];
      expect(checkoutClaims).toHaveLength(2);
      expect(checkoutClaims.every(event => !Object.prototype.hasOwnProperty.call(event.payload, 'text'))).toBe(true);
      const snapshotClaims = paused.checkpoint.events.filter(
        event => event.type === 'ClaimPublished' && event.claim === 'native.continuation.checklist_snapshot@1',
      ) as any[];
      expect(snapshotClaims).toHaveLength(1);
      expect(snapshotClaims[0].payload).toEqual(continuationSnapshot());
      const pausedMutationStarts = paused.checkpoint.events.filter(
        event => event.type === 'AttemptStarted'
          && (event.checkId === 'author-native-component' || event.checkId === 'promote-native-component'),
      );
      expect(pausedMutationStarts).toHaveLength(4);
      expect(pausedMutationStarts.map(event => {
        const keyed = event.scope.filter(part => part.kind === 'keyed');
        return keyed[keyed.length - 1]?.key;
      }).sort()).toEqual([
        'component-a', 'component-a', 'component-c', 'component-c',
      ]);
      expect(promptsByComponent).toEqual(new Map([
        ['component-a', expect.any(String)],
        ['component-c', expect.any(String)],
      ]));
      expect(new Set(testCheckouts).size).toBe(2);
      const promotions = paused.checkpoint.events.filter(event => event.type === 'ClaimPublished' && event.claim === 'native.continuation.promotion@1') as any[];
      expect(promotions).toHaveLength(2);
      const promotionByComponent = new Map(promotions.map(event => [event.payload.component_id, event.payload]));
      expect([...promotionByComponent.keys()].sort()).toEqual(['component-a', 'component-c']);
      expect(promotionByComponent.get('component-a')).toMatchObject({
        baseline_commit: fixture.workItem.baseline_commit,
        accepted_paths: ['source.go'],
        ignored_paths: [],
        rejected_paths: [],
        validation: {status: 0, stderr: ''},
        checkpoint: {
          baseline_commit: fixture.workItem.baseline_commit,
          component_id: 'component-a',
          accepted_paths: ['source.go'],
          ignored_paths: [],
          status: 'promoted',
        },
      });
      expect(promotionByComponent.get('component-c')).toMatchObject({
        baseline_commit: fixture.secondWorkItem.baseline_commit,
        accepted_paths: ['second.go'],
        ignored_paths: [],
        rejected_paths: [],
        validation: {status: 0, stderr: ''},
        checkpoint: {
          baseline_commit: fixture.secondWorkItem.baseline_commit,
          component_id: 'component-c',
          accepted_paths: ['second.go'],
          ignored_paths: [],
          status: 'promoted',
        },
      });
      expect(git(fixture.root, ['status', '--porcelain'])).toBe('');
      expect(git(fixture.root, ['rev-parse', 'HEAD'])).not.toBe(fixture.workItem.baseline_commit);
      expect(git(fixture.root, ['diff', '--name-only', `${fixture.workItem.baseline_commit}..HEAD`])).toBe('second.go\nsource.go');
      expect(git(fixture.root, ['diff', '--numstat', `${fixture.workItem.baseline_commit}..HEAD`])).toBe('1\t0\tsecond.go\n1\t0\tsource.go');
      expect(git(fixture.root, ['show', 'HEAD:source.go'])).toBe('package fixture\n\nfunc Source() {}\n// Implements: REQ-1');
      expect(git(fixture.root, ['show', 'HEAD:second.go'])).toBe('package fixture\n\nfunc Second() {}\n// Documents: REQ-2');
      expect(git(fixture.root, ['show', 'HEAD:reused.go'])).toBe('package fixture\n\nfunc Reused() {}');
      const savedConfigPath = path.join(fixture.output, 'checklist-materialized-config.json');
      const savedCheckpointPath = path.join(fixture.output, 'checklist-traces-light-frontier-checkpoint.json');
      fs.writeFileSync(savedConfigPath, canonicalJson(config) + '\n', {encoding: 'utf8', mode: 0o600});
      fs.writeFileSync(savedCheckpointPath, canonicalGraphCheckpointJson(paused.checkpoint) + '\n', {encoding: 'utf8', mode: 0o600});
      const restoredConfig = await loadConfig(JSON.parse(fs.readFileSync(savedConfigPath, 'utf8')) as any, {strict: true});
      const restoredCheckpoint = ExecutionJournal.validateGraphCheckpointIntegrity(JSON.parse(fs.readFileSync(savedCheckpointPath, 'utf8')));
      expect(restoredCheckpoint.graphSemanticDigest).toBe(compileClaimPlan(restoredConfig).expansionPlan.graphSemanticDigest);
      fs.writeFileSync(fixture.checklistCalls, '', 'utf8');
      const freshEngine = new StateMachineExecutionEngine(fixture.root);
      const resumed = await executeChecklistContinuationEngine(freshEngine, restoredConfig, 120000, ['component-a', 'component-c'], restoredCheckpoint);
      expect(resumed.paused).toBe(false);
      expect(resumed.checkpoint.sessionId).toBe(restoredCheckpoint.sessionId);
      expect(resumed.checkpoint.graphSemanticDigest).toBe(restoredCheckpoint.graphSemanticDigest);
      expect(canonicalGraphCheckpointJson(resumed.checkpoint.events.slice(0, restoredCheckpoint.events.length))).toBe(canonicalGraphCheckpointJson(restoredCheckpoint.events));
      const suffix = resumed.checkpoint.events.slice(restoredCheckpoint.events.length);
      expect(suffix.filter(event => event.type === 'AttemptStarted').map(event => event.checkId)).toEqual(['checklist-traces-light']);
      const resumedJournal = ExecutionJournal.restoreGraphCheckpoint(
        compileClaimPlan(restoredConfig),
        resumed.checkpoint,
      );
      const resumedProgress = buildNativeChecklistProgressFromProjections({
        claimProjection: resumedJournal.getClaimProjection(),
        instanceProjection: resumedJournal.getInstanceProjection(),
        checkpoint: resumed.checkpoint,
        paused: false,
        resumed: true,
        retainedCatalogComponentIds: ['component-a', 'component-b', 'component-c'],
        affectedComponentIds: ['component-a', 'component-c'],
      });
      expect(resumedProgress.operational.catalog_coverage).toMatchObject({
        known: true,
        known_count: 3,
        affected_count: 2,
        reused_count: 1,
        unexpanded_count: 0,
      });
      expect(resumedProgress.operational.catalog_coverage.items).toEqual(
        pausedProgress.operational.catalog_coverage.items,
      );
      expect(resumedProgress.operational.components.items).toHaveLength(2);
      expect(resumedProgress.operational.components.items.map(item => item.id).sort()).toEqual(['component-a', 'component-c']);
      const resumedRendered = renderNativeChecklistProgress(resumedProgress);
      expect(resumedRendered.text).toContain(
        'catalog coverage=known:3 affected:2 reused:1 unexpanded:0',
      );
      expect(resumedRendered.text).toContain('paused=false resumed=true');
      expect(resumedRendered.html).toContain(
        'catalog coverage: known=3, affected=2, reused=1, unexpanded=0',
      );
      expect(ai).toHaveBeenCalledTimes(2);
      const resumeCalls = fs.readFileSync(fixture.checklistCalls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).args as string[]);
      expect(resumeCalls.map(args => args.slice(0, 2))).toEqual([
        ['checklist', 'show'],
        ['checklist', 'confirm'],
        ['checklist', 'show'],
      ]);
      expect(resumeCalls[1]).toContain('--package');
      expect(resumeCalls[1].slice(resumeCalls[1].indexOf('--package'), resumeCalls[1].indexOf('--package') + 2))
        .toEqual(['--package', 'project-a']);
      expect(resumeCalls.some(args => args[0] === 'role' || args[0] === 'audit')).toBe(false);

      const tampered = JSON.parse(JSON.stringify(restoredCheckpoint)) as any;
      tampered.integrity.digest = '0'.repeat(64);
      fs.writeFileSync(fixture.checklistCalls, '', 'utf8');
      const tamperedEngine = new StateMachineExecutionEngine(fixture.root);
      const resumeGraphSpy = jest.spyOn(tamperedEngine, 'resumeGraphCheckpoint');
      await expect(executeChecklistContinuationEngine(tamperedEngine, restoredConfig, 120000, ['component-a', 'component-c'], tampered))
        .rejects.toThrow(/resume checkpoint is invalid/i);
      expect(resumeGraphSpy).not.toHaveBeenCalled();
      expect(ai).toHaveBeenCalledTimes(2);
      expect(fs.readFileSync(fixture.checklistCalls, 'utf8')).toBe('');
      resumeGraphSpy.mockRestore();
    } finally {
      ai.mockRestore();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      for (const testCheckout of testCheckouts) {
        const worktree = (await worktreeManager.listWorktrees()).find(entry => entry.path === testCheckout || entry.metadata.worktree_path === testCheckout);
        if (worktree) await worktreeManager.removeWorktree(worktree.id);
      }
      worktreeManager.configure(previousWorktreeConfig);
      fs.rmSync(fixtureWorktreeCache, {recursive: true, force: true});
      fixture.cleanup();
    }
  });

  it('runs the zero-owner variables branch through native audits and a confirmation-only resume', async () => {
    const fixture = makeGitFixture();
    const previous = new Map<string, string | undefined>([
      ['PROOF_BIN', process.env.PROOF_BIN],
      ['VISOR_WORKSPACE_MAIN_PROJECT', process.env.VISOR_WORKSPACE_MAIN_PROJECT],
      ['NATIVE_ONBOARDING_WORKTREE_ROOT', process.env.NATIVE_ONBOARDING_WORKTREE_ROOT],
      ['NATIVE_CHECKLIST_CONTINUE_CATALOG', process.env.NATIVE_CHECKLIST_CONTINUE_CATALOG],
      ['NATIVE_CHECKLIST_CONTINUE_STEP', process.env.NATIVE_CHECKLIST_CONTINUE_STEP],
      ['NATIVE_CHECKLIST_CONTINUE_SNAPSHOT', process.env.NATIVE_CHECKLIST_CONTINUE_SNAPSHOT],
      ['REQUEST_TIMEOUT', process.env.REQUEST_TIMEOUT],
      ['NATIVE_ONBOARDING_TS_NODE', process.env.NATIVE_ONBOARDING_TS_NODE],
      ['NATIVE_ONBOARDING_REPO_ROOT', process.env.NATIVE_ONBOARDING_REPO_ROOT],
      ['NATIVE_ONBOARDING_OUTPUT_DIR', process.env.NATIVE_ONBOARDING_OUTPUT_DIR],
      ['CONTINUATION_FIXTURE_CALL_LOG', process.env.CONTINUATION_FIXTURE_CALL_LOG],
      ['CONTINUATION_FIXTURE_CHECKLIST_STATE', process.env.CONTINUATION_FIXTURE_CHECKLIST_STATE],
      ['CONTINUATION_FIXTURE_CHECKLIST_STEP', process.env.CONTINUATION_FIXTURE_CHECKLIST_STEP],
      ['CONTINUATION_FIXTURE_VARIABLE_MODE', process.env.CONTINUATION_FIXTURE_VARIABLE_MODE],
    ]);
    const previousWorktreeConfig = worktreeManager.getConfig();
    const fixtureWorktreeCache = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-continuation-variables-cache-'));
    worktreeManager.configure({base_path: fixtureWorktreeCache, cleanup_on_exit: false});
    const ai = jest.spyOn(AIReviewService.prototype, 'executeReview').mockImplementation(async () => {
      throw new Error('variables zero-owner branch must not dispatch a model author');
    });
    try {
      const allWorkItems = [fixture.workItem, fixture.secondWorkItem, fixture.reusedWorkItem];
      process.env.PROOF_BIN = fixture.proof;
      process.env.VISOR_WORKSPACE_MAIN_PROJECT = fixture.root;
      process.env.NATIVE_ONBOARDING_WORKTREE_ROOT = fixture.writerParent;
      process.env.NATIVE_CHECKLIST_CONTINUE_STEP = 'variables';
      process.env.NATIVE_CHECKLIST_CONTINUE_CATALOG = JSON.stringify({
        components: [],
        full_components: allWorkItems,
        affected_component_ids: [],
        reused_component_ids: ['component-a', 'component-b', 'component-c'],
        retained_receipt_identities: [`sha256:${'7'.repeat(64)}`, `sha256:${'8'.repeat(64)}`],
        current_receipt_identities: [
          `sha256:${'1'.repeat(64)}`, `sha256:${'2'.repeat(64)}`, `sha256:${'3'.repeat(64)}`,
          `sha256:${'4'.repeat(64)}`, `sha256:${'5'.repeat(64)}`, `sha256:${'6'.repeat(64)}`,
        ],
        authority: continuationAuthority(allWorkItems, [], ['component-a', 'component-b', 'component-c']),
      });
      process.env.REQUEST_TIMEOUT = '120000';
      process.env.NATIVE_ONBOARDING_TS_NODE = require.resolve('ts-node/register/transpile-only');
      process.env.NATIVE_ONBOARDING_REPO_ROOT = process.cwd();
      process.env.NATIVE_ONBOARDING_OUTPUT_DIR = fixture.output;
      process.env.CONTINUATION_FIXTURE_CALL_LOG = fixture.checklistCalls;
      process.env.CONTINUATION_FIXTURE_CHECKLIST_STATE = fixture.checklistState;
      process.env.CONTINUATION_FIXTURE_CHECKLIST_STEP = 'variables';
      process.env.NATIVE_CHECKLIST_CONTINUE_SNAPSHOT = JSON.stringify(variablesContinuationSnapshot());
      const config = await loadConfig(buildChecklistContinuationConfig('variables') as any, {strict: true});
      process.env.CONTINUATION_FIXTURE_VARIABLE_MODE = 'fail';
      const failedEngine = new StateMachineExecutionEngine(fixture.root);
      await expect(executeChecklistContinuationEngine(failedEngine, config, 120000, [], undefined, 'variables'))
        .rejects.toThrow(/failed before variables frontier/);
      const failedStarted = failedEngine.exportGraphCheckpoint().events
        .filter(event => event.type === 'AttemptStarted')
        .map(event => event.checkId);
      expect(failedStarted).not.toContain('checklist-variables');
      delete process.env.CONTINUATION_FIXTURE_VARIABLE_MODE;
      const engine = new StateMachineExecutionEngine(fixture.root);
      const paused = await executeChecklistContinuationEngine(engine, config, 120000, [], undefined, 'variables');
      expect(paused.paused).toBe(true);
      const started = paused.checkpoint.events
        .filter(event => event.type === 'AttemptStarted')
        .map(event => event.checkId);
      expect(started).toEqual(expect.arrayContaining([
        'continue-retained-catalog', 'materialize-retained-catalog', 'checklist-continuation-snapshot',
        'component-promotions-complete', 'variable_orphans_clean', 'variables_declared', 'variable_drift',
      ]));
      expect(started).not.toContain('checklist-variables');
      expect(started).not.toContain('checklist-traces-light');
      expect(started).not.toContain('checklist-skeleton');
      expect(started).not.toContain('author-native-component');
      expect(started).not.toContain('promote-native-component');
      const variableAudits = paused.checkpoint.events.filter(event =>
        event.type === 'ClaimPublished' && event.claim === 'native.continuation.author@1',
      );
      expect(variableAudits).toHaveLength(0);
      const pausedJournal = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), paused.checkpoint);
      const pausedGenerations = Object.values(pausedJournal.getInstanceProjection().generationsById)
        .filter((generation: any) => generation.status !== 'inactive' && generation.checkId === 'checklist-variables');
      expect(pausedGenerations).toHaveLength(1);
      expect((pausedGenerations[0] as any).status).toBe('ready');
      const pausedSnapshot = JSON.parse(process.env.NATIVE_CHECKLIST_CONTINUE_SNAPSHOT as string) as any;
      expect(pausedSnapshot.eligible_step_ids).toEqual(['variables']);
      expect(pausedSnapshot.next).toMatchObject({step_id: 'variables', scope: 'repo', requires: ['traces-light']});

      fs.writeFileSync(fixture.checklistCalls, '', 'utf8');
      const freshEngine = new StateMachineExecutionEngine(fixture.root);
      const resumed = await executeChecklistContinuationEngine(freshEngine, config, 120000, [], paused.checkpoint, 'variables');
      expect(resumed.paused).toBe(false);
      expect(resumed.checkpoint.sessionId).toBe(paused.checkpoint.sessionId);
      expect(resumed.checkpoint.graphSemanticDigest).toBe(paused.checkpoint.graphSemanticDigest);
      expect(canonicalGraphCheckpointJson(resumed.checkpoint.events.slice(0, paused.checkpoint.events.length)))
        .toBe(canonicalGraphCheckpointJson(paused.checkpoint.events));
      const suffix = resumed.checkpoint.events.slice(paused.checkpoint.events.length);
      expect(suffix.filter(event => event.type === 'AttemptStarted').map(event => event.checkId))
        .toEqual(['checklist-variables']);
      expect(ai).not.toHaveBeenCalled();
      const calls = fs.readFileSync(fixture.checklistCalls, 'utf8').trim().split('\n').filter(Boolean)
        .map(line => JSON.parse(line).args as string[]);
      expect(calls.map(args => args.slice(0, 2))).toEqual([
        ['checklist', 'show'], ['checklist', 'confirm'], ['checklist', 'show'],
      ]);
      expect(calls[1]).not.toContain('--package');
      const after = JSON.parse(execFileSync(fixture.proof, ['checklist', 'show', '--format', 'json'], {
        encoding: 'utf8', env: process.env,
      }));
      expect(after.counts).toMatchObject({confirmed: 5, pending: 1, blocked: 9});
      expect(after.eligible_step_ids).toEqual(['spec-review-1']);
      expect(after.next).toMatchObject({step_id: 'spec-review-1'});
      expect((after.steps as any[]).find(step => step.step_id === 'variables')).toMatchObject({
        effective_status: 'confirmed', stored_status: 'confirmed', scope: 'repo', required_checks: [
          'variable_orphans_clean', 'variables_declared', 'variable_drift',
        ],
      });
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

  it('waits for a nonzero-owner promotion before running the skeleton audits', async () => {
    const fixture = makeGitFixture();
    const previous = new Map<string, string | undefined>([
      ['PROOF_BIN', process.env.PROOF_BIN],
      ['VISOR_WORKSPACE_MAIN_PROJECT', process.env.VISOR_WORKSPACE_MAIN_PROJECT],
      ['NATIVE_ONBOARDING_WORKTREE_ROOT', process.env.NATIVE_ONBOARDING_WORKTREE_ROOT],
      ['NATIVE_CHECKLIST_CONTINUE_CATALOG', process.env.NATIVE_CHECKLIST_CONTINUE_CATALOG],
      ['NATIVE_CHECKLIST_CONTINUE_STEP', process.env.NATIVE_CHECKLIST_CONTINUE_STEP],
      ['NATIVE_CHECKLIST_CONTINUE_SNAPSHOT', process.env.NATIVE_CHECKLIST_CONTINUE_SNAPSHOT],
      ['REQUEST_TIMEOUT', process.env.REQUEST_TIMEOUT],
      ['NATIVE_ONBOARDING_TS_NODE', process.env.NATIVE_ONBOARDING_TS_NODE],
      ['NATIVE_ONBOARDING_REPO_ROOT', process.env.NATIVE_ONBOARDING_REPO_ROOT],
      ['NATIVE_ONBOARDING_OUTPUT_DIR', process.env.NATIVE_ONBOARDING_OUTPUT_DIR],
      ['CONTINUATION_FIXTURE_CALL_LOG', process.env.CONTINUATION_FIXTURE_CALL_LOG],
      ['CONTINUATION_FIXTURE_CHECKLIST_STATE', process.env.CONTINUATION_FIXTURE_CHECKLIST_STATE],
      ['CONTINUATION_FIXTURE_CHECKLIST_STEP', process.env.CONTINUATION_FIXTURE_CHECKLIST_STEP],
      ['CONTINUATION_FIXTURE_REQUIRE_PROMOTED_CANONICAL', process.env.CONTINUATION_FIXTURE_REQUIRE_PROMOTED_CANONICAL],
    ]);
    const previousWorktreeConfig = worktreeManager.getConfig();
    const fixtureWorktreeCache = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-continuation-skeleton-cache-'));
    worktreeManager.configure({base_path: fixtureWorktreeCache, cleanup_on_exit: false});
    const testCheckouts = new Set<string>();
    const ai = jest.spyOn(AIReviewService.prototype, 'executeReview').mockImplementation(async function (_prInfo: any, customPrompt: string) {
      expect(customPrompt).toContain('component-a');
      expect(customPrompt).toContain('source.go');
      const checkout = (this as any).config?.path as string;
      testCheckouts.add(checkout);
      expect((this as any).config?.model).toBe('gpt-5.6-luna');
      expect((this as any).config?.codexExecutionProfile).toBe('luna-xhigh-isolated-writer-v1');
      expect((this as any).config?.codexWorkingDirectoryFrom).toBe('checkout-worktree');
      expect(fs.realpathSync(checkout)).not.toBe(fs.realpathSync(fixture.root));
      fs.appendFileSync(path.join(checkout, 'source.go'), '// Implements: REQ-1\n', 'utf8');
      return {issues: [], output: {status: 'no-model-mock'}} as any;
    });
    try {
      const affectedWorkItem = operationalSkeletonWorkItem(
        fixture.workItem,
        ['source.go'],
        ['source.go:1 missing Implements link for REQ-1'],
      );
      process.env.PROOF_BIN = fixture.proof;
      process.env.VISOR_WORKSPACE_MAIN_PROJECT = fixture.root;
      process.env.NATIVE_ONBOARDING_WORKTREE_ROOT = fixture.writerParent;
      process.env.NATIVE_CHECKLIST_CONTINUE_STEP = 'skeleton';
      process.env.CONTINUATION_FIXTURE_REQUIRE_PROMOTED_CANONICAL = 'true';
      process.env.NATIVE_CHECKLIST_CONTINUE_CATALOG = JSON.stringify({
        components: [affectedWorkItem],
        full_components: [fixture.workItem, fixture.secondWorkItem, fixture.reusedWorkItem],
        affected_component_ids: ['component-a'],
        reused_component_ids: ['component-b', 'component-c'],
        retained_receipt_identities: [`sha256:${'7'.repeat(64)}`, `sha256:${'8'.repeat(64)}`],
        current_receipt_identities: [
          `sha256:${'1'.repeat(64)}`, `sha256:${'2'.repeat(64)}`, `sha256:${'3'.repeat(64)}`,
          `sha256:${'4'.repeat(64)}`, `sha256:${'5'.repeat(64)}`, `sha256:${'6'.repeat(64)}`,
          `sha256:${'7'.repeat(64)}`,
        ],
        authority: continuationAuthority(
          [fixture.workItem, fixture.secondWorkItem, fixture.reusedWorkItem],
          ['component-a'],
          ['component-b', 'component-c'],
        ),
      });
      process.env.REQUEST_TIMEOUT = '120000';
      process.env.NATIVE_ONBOARDING_TS_NODE = require.resolve('ts-node/register/transpile-only');
      process.env.NATIVE_ONBOARDING_REPO_ROOT = process.cwd();
      process.env.NATIVE_ONBOARDING_OUTPUT_DIR = fixture.output;
      process.env.CONTINUATION_FIXTURE_CALL_LOG = fixture.checklistCalls;
      process.env.CONTINUATION_FIXTURE_CHECKLIST_STATE = fixture.checklistState;
      process.env.CONTINUATION_FIXTURE_CHECKLIST_STEP = 'skeleton';
      process.env.NATIVE_CHECKLIST_CONTINUE_SNAPSHOT = JSON.stringify(skeletonContinuationSnapshot());
      const config = await loadConfig(buildChecklistContinuationConfig('skeleton') as any, {strict: true});
      const engine = new StateMachineExecutionEngine(fixture.root);
      const paused = await executeChecklistContinuationEngine(engine, config, 120000, ['component-a'], undefined, 'skeleton');
      expect(paused.paused).toBe(true);
      expect(ai).toHaveBeenCalledTimes(1);
      expect(git(fixture.root, ['show', 'HEAD:source.go'])).toBe('package fixture\n\nfunc Source() {}\n// Implements: REQ-1');

      const events = paused.checkpoint.events;
      const promotion = events.find(event => event.type === 'AttemptCompleted' && event.checkId === 'promote-native-component');
      expect(promotion).toBeDefined();
      const promotionReceipt = events.filter(event => event.type === 'ClaimPublished' && event.claim === 'native.continuation.promotion@1') as any[];
      expect(promotionReceipt).toHaveLength(1);
      expect(promotionReceipt[0].payload).toMatchObject({
        status: 'promoted', component_id: 'component-a', accepted_paths: ['source.go'],
      });
      const auditIds = ['l0_stakeholder_complete', 'l1_system_complete', 'l2_software_complete', 'levels_connected'];
      const auditStarts = events.filter(event => event.type === 'AttemptStarted' && auditIds.includes(event.checkId));
      expect(auditStarts.map(event => event.checkId).sort()).toEqual([...auditIds].sort());
      expect(auditStarts.every(event => event.eventId > (promotion as any).eventId)).toBe(true);
      for (const checkId of auditIds) {
        const stdoutPath = path.join(
          fixture.output,
          `commands/continuation-audit-${checkId}`,
          `audit---no-cache---check-${checkId}---format-json.stdout`,
        );
        const receipts = fs.readFileSync(stdoutPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
        expect(receipts.filter(receipt => receipt.event === 'check_done')).toEqual([
          expect.objectContaining({event: 'check_done', stage: 'spec', check: checkId, status: 'pass'}),
        ]);
      }
      expect(events.some(event => event.type === 'AttemptStarted' && event.checkId === 'checklist-skeleton')).toBe(false);
      const calls = fs.readFileSync(fixture.checklistCalls, 'utf8').trim().split('\n').filter(Boolean)
        .map(line => JSON.parse(line).args as string[]);
      expect(calls.some(args => args[0] === 'checklist' && args[1] === 'confirm')).toBe(false);
      const pausedJournal = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), paused.checkpoint);
      const skeletonGenerations = Object.values(pausedJournal.getInstanceProjection().generationsById)
        .filter((generation: any) => generation.status !== 'inactive' && generation.checkId === 'checklist-skeleton');
      expect(skeletonGenerations).toHaveLength(1);
      expect((skeletonGenerations[0] as any).status).toBe('ready');
      const pausedProgress = buildNativeChecklistProgressFromProjections({
        claimProjection: pausedJournal.getClaimProjection(),
        instanceProjection: pausedJournal.getInstanceProjection(),
        checkpoint: paused.checkpoint,
        paused: true,
        resumed: false,
        retainedCatalogComponentIds: ['component-a', 'component-b', 'component-c'],
        affectedComponentIds: ['component-a'],
      });
      expect(pausedProgress.operational.project.state).not.toBe('failed');
      expect(pausedProgress.operational.catalog_coverage).toMatchObject({
        known: true, known_count: 3, affected_count: 1, reused_count: 2, unexpanded_count: 0,
      });
    } finally {
      ai.mockRestore();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      for (const testCheckout of testCheckouts) {
        const worktree = (await worktreeManager.listWorktrees()).find(entry => entry.path === testCheckout || entry.metadata.worktree_path === testCheckout);
        if (worktree) await worktreeManager.removeWorktree(worktree.id);
      }
      worktreeManager.configure(previousWorktreeConfig);
      fs.rmSync(fixtureWorktreeCache, {recursive: true, force: true});
      fixture.cleanup();
    }
  });

  it('runs a zero-component skeleton continuation through native audits and a fresh confirmation-only resume', async () => {
    const fixture = makeGitFixture();
    const previous = new Map<string, string | undefined>([
      ['PROOF_BIN', process.env.PROOF_BIN],
      ['VISOR_WORKSPACE_MAIN_PROJECT', process.env.VISOR_WORKSPACE_MAIN_PROJECT],
      ['NATIVE_ONBOARDING_WORKTREE_ROOT', process.env.NATIVE_ONBOARDING_WORKTREE_ROOT],
      ['NATIVE_CHECKLIST_CONTINUE_CATALOG', process.env.NATIVE_CHECKLIST_CONTINUE_CATALOG],
      ['NATIVE_CHECKLIST_CONTINUE_STEP', process.env.NATIVE_CHECKLIST_CONTINUE_STEP],
      ['NATIVE_CHECKLIST_CONTINUE_SNAPSHOT', process.env.NATIVE_CHECKLIST_CONTINUE_SNAPSHOT],
      ['REQUEST_TIMEOUT', process.env.REQUEST_TIMEOUT],
      ['NATIVE_ONBOARDING_TS_NODE', process.env.NATIVE_ONBOARDING_TS_NODE],
      ['NATIVE_ONBOARDING_REPO_ROOT', process.env.NATIVE_ONBOARDING_REPO_ROOT],
      ['NATIVE_ONBOARDING_OUTPUT_DIR', process.env.NATIVE_ONBOARDING_OUTPUT_DIR],
      ['CONTINUATION_FIXTURE_CALL_LOG', process.env.CONTINUATION_FIXTURE_CALL_LOG],
      ['CONTINUATION_FIXTURE_CHECKLIST_STATE', process.env.CONTINUATION_FIXTURE_CHECKLIST_STATE],
      ['CONTINUATION_FIXTURE_CHECKLIST_STEP', process.env.CONTINUATION_FIXTURE_CHECKLIST_STEP],
      ['CONTINUATION_FIXTURE_SKELETON_MODE', process.env.CONTINUATION_FIXTURE_SKELETON_MODE],
    ]);
    const previousWorktreeConfig = worktreeManager.getConfig();
    const fixtureWorktreeCache = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-continuation-skeleton-cache-'));
    worktreeManager.configure({base_path: fixtureWorktreeCache, cleanup_on_exit: false});
    const ai = jest.spyOn(AIReviewService.prototype, 'executeReview').mockImplementation(async () => {
      throw new Error('zero-component skeleton continuation must not dispatch an author');
    });
    try {
      process.env.PROOF_BIN = fixture.proof;
      process.env.VISOR_WORKSPACE_MAIN_PROJECT = fixture.root;
      process.env.NATIVE_ONBOARDING_WORKTREE_ROOT = fixture.writerParent;
      process.env.NATIVE_CHECKLIST_CONTINUE_STEP = 'skeleton';
      process.env.NATIVE_CHECKLIST_CONTINUE_CATALOG = JSON.stringify({
        components: [],
        full_components: [fixture.workItem, fixture.secondWorkItem, fixture.reusedWorkItem],
        affected_component_ids: [],
        reused_component_ids: ['component-a', 'component-b', 'component-c'],
        retained_receipt_identities: [`sha256:${'7'.repeat(64)}`, `sha256:${'8'.repeat(64)}`],
        current_receipt_identities: [
          `sha256:${'1'.repeat(64)}`, `sha256:${'2'.repeat(64)}`, `sha256:${'3'.repeat(64)}`,
          `sha256:${'4'.repeat(64)}`, `sha256:${'5'.repeat(64)}`, `sha256:${'6'.repeat(64)}`,
          `sha256:${'7'.repeat(64)}`,
        ],
        authority: continuationAuthority(
          [fixture.workItem, fixture.secondWorkItem, fixture.reusedWorkItem],
          [],
          ['component-a', 'component-b', 'component-c'],
        ),
      });
      process.env.REQUEST_TIMEOUT = '120000';
      process.env.NATIVE_ONBOARDING_TS_NODE = require.resolve('ts-node/register/transpile-only');
      process.env.NATIVE_ONBOARDING_REPO_ROOT = process.cwd();
      process.env.NATIVE_ONBOARDING_OUTPUT_DIR = fixture.output;
      process.env.CONTINUATION_FIXTURE_CALL_LOG = fixture.checklistCalls;
      process.env.CONTINUATION_FIXTURE_CHECKLIST_STATE = fixture.checklistState;
      process.env.CONTINUATION_FIXTURE_CHECKLIST_STEP = 'skeleton';
      process.env.NATIVE_CHECKLIST_CONTINUE_SNAPSHOT = JSON.stringify(skeletonContinuationSnapshot());
      const config = await loadConfig(buildChecklistContinuationConfig('skeleton') as any, {strict: true});
      const engine = new StateMachineExecutionEngine(fixture.root);
      const paused = await executeChecklistContinuationEngine(engine, config, 120000, [], undefined, 'skeleton');
      expect(paused.paused).toBe(true);
      expect(ai).not.toHaveBeenCalled();
      const started = paused.checkpoint.events
        .filter(event => event.type === 'AttemptStarted')
        .map(event => event.checkId);
      expect(started.filter(checkId => ['author-native-component', 'promote-native-component', 'checkout-worktree', 'role-onboard-component', 'annotation_validity', 'orphan_code_clean', 'checklist-traces-light'].includes(checkId))).toEqual([]);
      expect(started.filter(checkId => ['l0_stakeholder_complete', 'l1_system_complete', 'l2_software_complete', 'levels_connected'].includes(checkId))).toHaveLength(4);
      expect(started).not.toContain('checklist-skeleton');
      const pausedJournal = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), paused.checkpoint);
      const skeletonGenerations = Object.values(pausedJournal.getInstanceProjection().generationsById)
        .filter((generation: any) => generation.status !== 'inactive' && generation.checkId === 'checklist-skeleton');
      expect(skeletonGenerations).toHaveLength(1);
      expect((skeletonGenerations[0] as any).status).toBe('ready');
      const pausedProgress = buildNativeChecklistProgressFromProjections({
        claimProjection: pausedJournal.getClaimProjection(),
        instanceProjection: pausedJournal.getInstanceProjection(),
        checkpoint: paused.checkpoint,
        paused: true,
        resumed: false,
        retainedCatalogComponentIds: ['component-a', 'component-b', 'component-c'],
        affectedComponentIds: [],
      });
      expect(pausedProgress.operational.catalog_coverage).toMatchObject({
        known: true, known_count: 3, affected_count: 0, reused_count: 3, unexpanded_count: 0,
      });
      expect(pausedProgress.operational.project.state).not.toBe('failed');
      expect(pausedProgress.checklist.steps.find(step => step.id === 'skeleton')).toMatchObject({
        state: 'pending', eligible: true,
      });
      expect(pausedProgress.checklist.steps.find(step => step.id === 'traces-light')).toMatchObject({
        state: 'blocked', eligible: false,
      });
      expect(renderNativeChecklistProgress(pausedProgress).text).toContain('catalog coverage=known:3 affected:0 reused:3 unexpanded:0');

      fs.writeFileSync(fixture.checklistCalls, '', 'utf8');
      const freshEngine = new StateMachineExecutionEngine(fixture.root);
      const resumed = await executeChecklistContinuationEngine(freshEngine, config, 120000, [], paused.checkpoint, 'skeleton');
      expect(resumed.paused).toBe(false);
      expect(ai).not.toHaveBeenCalled();
      const suffix = resumed.checkpoint.events.slice(paused.checkpoint.events.length);
      expect(suffix.filter(event => event.type === 'AttemptStarted').map(event => event.checkId)).toEqual(['checklist-skeleton']);
      const resumeCalls = fs.readFileSync(fixture.checklistCalls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).args as string[]);
      expect(resumeCalls.map(args => args.slice(0, 2))).toEqual([
        ['checklist', 'show'], ['checklist', 'confirm'], ['checklist', 'show'],
      ]);
      expect(resumeCalls.every(args => !args.includes('--package'))).toBe(true);
      const resumedJournal = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), resumed.checkpoint);
      const resumedProgress = buildNativeChecklistProgressFromProjections({
        claimProjection: resumedJournal.getClaimProjection(),
        instanceProjection: resumedJournal.getInstanceProjection(),
        checkpoint: resumed.checkpoint,
        currentProofSnapshot: confirmedSkeletonContinuationSnapshot(),
        paused: false,
        resumed: true,
        retainedCatalogComponentIds: ['component-a', 'component-b', 'component-c'],
        affectedComponentIds: [],
      });
      expect(resumedProgress.operational.catalog_coverage).toMatchObject({
        known: true, known_count: 3, affected_count: 0, reused_count: 3, unexpanded_count: 0,
      });
      expect(resumedProgress.operational.project.state).toBe('completed');
      expect(resumedProgress.checklist.steps.find(step => step.id === 'skeleton')).toMatchObject({
        state: 'confirmed', eligible: false,
      });
      expect(resumedProgress.evidence.proof_snapshot).toMatchObject({
        source: 'current-proof-readback',
        generation_id: expect.any(String),
      });
      expect(resumedProgress.checklist.steps.find(step => step.id === 'traces-light')).toMatchObject({
        state: 'pending', eligible: true,
      });

      // A native audit failure must stop before the selected confirmation
      // frontier, even when the retained catalog has no affected writers.
      process.env.CONTINUATION_FIXTURE_SKELETON_MODE = 'fail';
      fs.writeFileSync(fixture.checklistCalls, '', 'utf8');
      const failedEngine = new StateMachineExecutionEngine(fixture.root);
      await expect(
        executeChecklistContinuationEngine(failedEngine, config, 120000, [], undefined, 'skeleton'),
      ).rejects.toThrow(/failed before skeleton frontier/);
      const failedCheckpoint = failedEngine.exportGraphCheckpoint();
      expect(failedCheckpoint.events.some(event =>
        event.type === 'AttemptFailed' && event.checkId === 'l2_software_complete')).toBe(true);
      expect(failedCheckpoint.events.some(event =>
        event.type === 'AttemptStarted' && event.checkId === 'checklist-skeleton')).toBe(false);
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
        components: [operationalWorkItem(fixture.workItem, ['source.go'], ['source.go:1 missing Implements link for REQ-1'])],
        full_components: [fixture.workItem],
        affected_component_ids: ['component-a'],
        reused_component_ids: [],
        retained_receipt_identities: ['retained-fixture-receipt'],
        current_receipt_identities: ['current-fixture-receipt'],
        authority: continuationAuthority([fixture.workItem]),
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
        components: [operationalWorkItem(fixture.workItem, ['source.go'], ['source.go:1 missing Implements link for REQ-1'])],
        full_components: [fixture.workItem],
        affected_component_ids: ['component-a'],
        reused_component_ids: [],
        retained_receipt_identities: ['retained-fixture-receipt'],
        current_receipt_identities: ['current-fixture-receipt'],
        authority: continuationAuthority([fixture.workItem]),
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

  it('revalidates the pinned mixed current authority and rejects detached WorkItems before dispatch', async () => {
    const evidenceRoot = '/private/tmp/native-checklist-live.7EFE7S';
    const outputRoot = path.join(evidenceRoot, 'output-checklist-traces-light-preflight-2026-09-09-3');
    const prefixCheckpointPath = path.join(evidenceRoot, 'output-author-retry-escaping', 'checklist-skeleton-frontier-checkpoint.json');
    const checkpointPath = path.join(evidenceRoot, 'output-checklist-skeleton-resume-escaping-verified-2', 'checkpoint.json');
    const configPath = path.join(evidenceRoot, 'output-author-retry-escaping', 'checklist-materialized-config.json');
    const inventoryPath = path.join(outputRoot, 'commands/preflight/onboarding-inventory.stdout');
    const revalidationPath = path.join(outputRoot, 'commands/preflight/onboarding-revalidate.stdout');
    const workItemsPath = path.join(outputRoot, 'commands/preflight/onboarding-work-items.stdout');
    if (![prefixCheckpointPath, checkpointPath, configPath, inventoryPath, revalidationPath, workItemsPath].every(file => fs.existsSync(file))) return;
    const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8')) as Record<string, any>;
    const revalidation = JSON.parse(fs.readFileSync(revalidationPath, 'utf8')) as Record<string, any>;
    const workItemsProjection = JSON.parse(fs.readFileSync(workItemsPath, 'utf8')) as Record<string, any>;
    const retainedCheckpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as Record<string, any>;
    const retainedPrefix = JSON.parse(fs.readFileSync(prefixCheckpointPath, 'utf8')) as Record<string, any>;
    const preflight = JSON.parse(fs.readFileSync(path.join(outputRoot, 'preflight.json'), 'utf8')) as Record<string, any>;
    const digestFile = (file: string): string => `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
    const authority: Record<string, any> = {
      version: 'native.checklist-continuation-authority/v1',
      project_id: inventory.authority.project_id,
      subject_fingerprint: inventory.authority.subject_fingerprint,
      current_inventory: inventory,
      current_revalidation: revalidation,
      current_work_items: workItemsProjection.work_items.map((item: Record<string, any>) => ({
        ...item,
        baseline_commit: preflight.subject_revision,
      })),
      current_receipt_identities: {
        inventory_claim_id: revalidation.receipt.inventory_claim_id,
        catalog_claim_id: revalidation.receipt.catalog_claim_id,
        receipt_id: revalidation.receipt.receipt_id,
        admission_candidate_id: revalidation.receipt.admission_candidate_id,
        admission_receipt_id: revalidation.receipt.admission_receipt_id,
        component_authorities: revalidation.receipt.component_authorities,
      },
      retained: {
        checkpoint_sha256: digestFile(checkpointPath),
        prefix_checkpoint_sha256: digestFile(prefixCheckpointPath),
        checkpoint_session_id: retainedCheckpoint.sessionId,
        prefix_session_id: retainedPrefix.sessionId,
        checkpoint_graph_semantic_digest: retainedCheckpoint.graphSemanticDigest,
        prefix_graph_semantic_digest: retainedPrefix.graphSemanticDigest,
        checkpoint_path: checkpointPath,
        prefix_checkpoint_path: prefixCheckpointPath,
      },
      affected_component_ids: ['json-parser-core', 'json-string-escaping'],
      reused_component_ids: ['benchmark-suite', 'byte-conversion-primitives'],
    };
    const probeModule = require('@probelabs/probe') as {validateGovernedCodexExecAttestation?: unknown};
    const probeActual = require(path.resolve(process.cwd(), 'node_modules/@probelabs/probe/cjs/index.cjs')) as {validateGovernedCodexExecAttestation?: unknown};
    Object.defineProperty(probeModule, 'validateGovernedCodexExecAttestation', {
      value: probeActual.validateGovernedCodexExecAttestation,
      configurable: true,
      enumerable: true,
      writable: true,
    });
    expect(typeof probeModule.validateGovernedCodexExecAttestation).toBe('function');
    await expect(validateJournaledContinuationAuthority(authority)).resolves.toBe(authority);
    expect(authority.current_work_items).toHaveLength(4);
    expect(authority.affected_component_ids).toHaveLength(2);
    expect(authority.reused_component_ids).toHaveLength(2);

    for (const mutate of [
      (item: Record<string, any>) => { item.proof_component_subject = {...item.proof_component_subject, fingerprint: `sha256:${'0'.repeat(64)}`}; },
      (item: Record<string, any>) => { item.project_id = 'detached-project'; },
    ]) {
      const detached = JSON.parse(JSON.stringify(authority)) as Record<string, any>;
      mutate(detached.current_work_items[0]);
      await expect(validateJournaledContinuationAuthority(detached)).rejects.toThrow(/current Proof authority bytes are invalid|detached/i);
    }
  });
});
