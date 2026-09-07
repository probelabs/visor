import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import {
  CheckProvider,
  type CheckProviderConfig,
  type ExecutionContext,
} from '../../src/providers/check-provider.interface';
import { ExecutionJournal } from '../../src/snapshot-store';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import { compileClaimPlan } from '../../src/state-machine/graph/claim-plan';
import type { PRInfo } from '../../src/pr-analyzer';
import type { ReviewSummary } from '../../src/reviewer';
import type { VisorConfig } from '../../src/types/config';
import { validateRecoverySelection } from '../../examples/agent-governance/native-onboarding/run-onboarding';

const SESSION_ID = 'author-recovery-session';
const PROJECT_ID = 'isolated-author-fixture';
const PROOF_FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const prInfo: PRInfo = {
  number: 1,
  title: 'isolated author recovery fixture',
  author: 'fixture',
  base: 'main',
  head: 'recovery',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  eventType: 'manual',
};

type ComponentId = 'A' | 'B';

type GitFixture = {
  root: string;
  subject: string;
  priorOutput: string;
  baselineCommit: string;
  checkouts: Record<ComponentId, string>;
};

function recoveryConfig(): VisorConfig {
  const objectClaim = { schema: { type: 'object' } };
  return {
    version: '1.0',
    max_parallelism: 2,
    workspace: { enabled: false },
    claim_types: {
      'component.catalog@1': objectClaim,
      'component.item@1': objectClaim,
      'component.prepared_work_item@1': objectClaim,
      'component.checkout@1': objectClaim,
      'native.role.onboard@1': { schema: { type: 'string', minLength: 1 } },
      'native.author.evidence@1': objectClaim,
      'native.component.promoted@1': objectClaim,
    },
    subgraphs: {
      component: {
        input: { name: 'component', claim: 'component.item@1' },
        checks: {
          'prepare-work-item': {
            type: 'author-recovery-fixture',
            consumes: [{ claim: 'component.item@1', as: 'component' }],
            emits: [{ claim: 'component.prepared_work_item@1', from: 'output' }],
          },
          'checkout-worktree': {
            type: 'author-recovery-fixture',
            consumes: [{ claim: 'component.item@1', as: 'component' }],
            emits: [{ claim: 'component.checkout@1', from: 'output' }],
          },
          'role-onboard-component': {
            type: 'author-recovery-fixture',
            consumes: [{ claim: 'component.item@1', as: 'component' }],
            emits: [{ claim: 'native.role.onboard@1', from: 'output' }],
          },
          'author-native-component': {
            type: 'author-recovery-fixture',
            depends_on: ['prepare-work-item', 'checkout-worktree', 'role-onboard-component'],
            consumes: [
              { claim: 'component.prepared_work_item@1', as: 'workItem' },
              { claim: 'component.checkout@1', as: 'checkout' },
              { claim: 'native.role.onboard@1', as: 'role' },
            ],
            emits: [{ claim: 'native.author.evidence@1', from: 'output' }],
          },
          'promote-native-component': {
            type: 'author-recovery-fixture',
            depends_on: ['author-native-component'],
            consumes: [
              { claim: 'component.prepared_work_item@1', as: 'workItem' },
              { claim: 'component.checkout@1', as: 'checkout' },
              { claim: 'native.author.evidence@1', as: 'author' },
            ],
            emits: [{ claim: 'native.component.promoted@1', from: 'output' }],
          },
        },
      },
    },
    checks: {
      'discover-components': {
        type: 'author-recovery-fixture',
        emits: [{ claim: 'component.catalog@1', from: 'output' }],
        expand: {
          claim: 'component.catalog@1',
          template: 'component',
          items_pointer: '/items',
          key_pointer: '/id',
          item_claim: 'component.item@1',
        },
      },
    },
  } as VisorConfig;
}

function git(root: string, args: string[]): string {
  return String(execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })).trim();
}

function createGitFixture(): GitFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-author-recovery-'));
  const subject = path.join(root, 'subject');
  const priorOutput = path.join(root, 'prior-output');
  fs.mkdirSync(subject, { recursive: true });
  fs.mkdirSync(path.join(priorOutput, 'worktrees'), { recursive: true });
  git(subject, ['init', '--quiet']);
  git(subject, ['config', 'user.email', 'fixture@example.invalid']);
  git(subject, ['config', 'user.name', 'Recovery Fixture']);
  fs.writeFileSync(path.join(subject, 'owned-a.txt'), 'A baseline\n');
  fs.writeFileSync(path.join(subject, 'owned-b.txt'), 'B baseline\n');
  fs.writeFileSync(path.join(subject, 'unrelated.txt'), 'baseline\n');
  git(subject, ['add', 'owned-a.txt', 'owned-b.txt', 'unrelated.txt']);
  git(subject, ['commit', '--quiet', '-m', 'fixture baseline']);
  const baselineCommit = git(subject, ['rev-parse', 'HEAD']);

  const checkouts = {} as Record<ComponentId, string>;
  for (const component of ['A', 'B'] as const) {
    checkouts[component] = path.join(priorOutput, 'worktrees', component);
    git(subject, ['worktree', 'add', '--quiet', '--detach', checkouts[component], baselineCommit]);
  }
  // This is the retained dirty author draft. It is a WorkItem-owned path and
  // remains uncommitted so the runner must inventory it rather than clean it.
  fs.writeFileSync(path.join(checkouts.B, 'owned-b.txt'), 'B retained draft\n');

  // An unrelated canonical advance is valid for isolated author replay.
  fs.writeFileSync(path.join(subject, 'unrelated.txt'), 'A disjoint canonical advance\n');
  git(subject, ['add', 'unrelated.txt']);
  git(subject, ['commit', '--quiet', '-m', 'A disjoint canonical advance']);
  return { root, subject, priorOutput, baselineCommit, checkouts };
}

function publishCatalog(journal: ExecutionJournal): void {
  const request = journal.requestCatalogReconciliation({
    sessionId: SESSION_ID,
    ownerCheck: 'discover-components',
  });
  const attempt = journal.startCatalogRequestAttempt(request.requestId);
  journal.scheduleCatalogRequestAttempt(attempt);
  journal.completeAttempt({
    ...attempt,
    payload: { items: [{ id: 'A' }, { id: 'B' }] },
  });
}

function generationFor(
  journal: ExecutionJournal,
  checkId: string,
  component: ComponentId,
): any {
  const generation = journal.queryReadyWork().find(value =>
    value.checkId === checkId && value.scope.at(-1)?.key === component
  );
  if (!generation) throw new Error(`missing ready ${checkId}:${component}`);
  return generation;
}

function completeGeneration(
  journal: ExecutionJournal,
  checkId: string,
  component: ComponentId,
  payload: unknown,
): any {
  const generation = generationFor(journal, checkId, component);
  const attempt = journal.startGeneratedAttempt(generation.nodeGenerationId);
  journal.scheduleGeneratedAttempt(attempt);
  journal.completeGeneratedAttempt({ attempt, payload });
  return { generation, attempt };
}

function workItem(fixture: GitFixture, component: ComponentId): Record<string, unknown> {
  return {
    component_id: component,
    baseline_commit: fixture.baselineCommit,
    project_id: PROJECT_ID,
    proof_component_subject: {
      component_id: component,
      fingerprint: PROOF_FINGERPRINT,
    },
    sorted_owned_paths: [`owned-${component.toLowerCase()}.txt`],
  };
}

function checkout(fixture: GitFixture, component: ComponentId): Record<string, unknown> {
  return {
    success: true,
    path: fixture.checkouts[component],
    commit: fixture.baselineCommit,
    ref: fixture.baselineCommit,
    worktree_id: `fixture-worktree-${component}`,
    repository: fixture.subject,
    is_worktree: true,
  };
}

class AuthorRecoveryFixtureProvider extends CheckProvider {
  constructor(private readonly calls: string[]) {
    super();
  }

  getName(): string { return 'author-recovery-fixture'; }
  getDescription(): string { return 'Deterministic isolated author recovery provider'; }
  async validateConfig(): Promise<boolean> { return true; }
  async isAvailable(): Promise<boolean> { return true; }
  getRequirements(): string[] { return []; }
  getSupportedConfigKeys(): string[] { return ['type']; }

  async execute(
    _pr: PRInfo,
    providerConfig: CheckProviderConfig,
    _dependencies?: Map<string, ReviewSummary>,
    context?: ExecutionContext,
  ): Promise<ReviewSummary> {
    const checkId = String(providerConfig.checkName);
    const scope = context?.scope || [];
    const component = scope[scope.length - 1]?.key;
    if (component !== 'B') throw new Error(`unexpected provider dispatch for ${component || 'root'}`);
    this.calls.push(`${checkId}:${component}`);
    if (checkId === 'author-native-component') {
      return { issues: [], output: { component_id: component, replayed: true } };
    }
    if (checkId === 'promote-native-component') {
      return { issues: [], output: { component_id: component, promoted: true } };
    }
    throw new Error(`unexpected recovery check ${checkId}`);
  }
}

describe('native isolated author recovery', () => {
  const registry = CheckProviderRegistry.getInstance();
  let previous: CheckProvider | undefined;
  let fixture: GitFixture | undefined;

  beforeEach(() => {
    previous = registry.getProvider('author-recovery-fixture');
    if (previous) registry.unregister('author-recovery-fixture');
    fixture = createGitFixture();
  });

  afterEach(() => {
    if (registry.getProvider('author-recovery-fixture')) registry.unregister('author-recovery-fixture');
    if (previous) registry.register(previous);
    if (fixture) fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  it('selects the dirty author leaf, preserves the prefix, and releases only its promotion', async () => {
    const current = fixture!;
    const config = recoveryConfig();
    const plan = compileClaimPlan(config);
    const journal = new ExecutionJournal(plan);
    publishCatalog(journal);

    for (const component of ['A', 'B'] as const) {
      completeGeneration(journal, 'prepare-work-item', component, workItem(current, component));
      completeGeneration(journal, 'checkout-worktree', component, checkout(current, component));
      completeGeneration(journal, 'role-onboard-component', component, 'native onboard role v1');
    }
    completeGeneration(journal, 'author-native-component', 'A', { component_id: 'A', authored: true });
    completeGeneration(journal, 'promote-native-component', 'A', { component_id: 'A', promoted: true });
    const failedAuthor = generationFor(journal, 'author-native-component', 'B');
    const firstAttempt = journal.startGeneratedAttempt(failedAuthor.nodeGenerationId);
    journal.scheduleGeneratedAttempt(firstAttempt);
    journal.failGeneratedAttempt(firstAttempt, 'MANAGED_START_FAILED');
    expect(journal.getInstanceProjection().generationsById[failedAuthor.nodeGenerationId].status).toBe('failed');

    const checkpoint = journal.exportGraphCheckpoint(SESSION_ID);
    const oldCheckpointBytes = JSON.stringify(checkpoint);
    const inventory = {
      authority: {
        project_id: PROJECT_ID,
        subject_fingerprint: PROOF_FINGERPRINT,
      },
    };
    const selected = validateRecoverySelection(
      config,
      checkpoint,
      [failedAuthor.nodeGenerationId],
      { subject: fs.realpathSync(current.subject), priorOutput: fs.realpathSync(current.priorOutput) },
      inventory,
      'isolated_draft_replay',
    );
    expect(selected.bindings).toHaveLength(1);
    expect(selected.bindings[0].componentId).toBe('B');
    expect(selected.bindings[0].draftInventory?.files.map(file => file.path)).toEqual(['owned-b.txt']);

    const beforeRejectedEvents = selected.journal.readRuntimeEvents();
    fs.mkdirSync(path.join(current.checkouts.B, 'specs/system/requirements'), { recursive: true });
    fs.writeFileSync(
      path.join(current.checkouts.B, 'specs/system/requirements/A.req.yaml'),
      'component: A\n',
    );
    expect(() => validateRecoverySelection(
      config,
      checkpoint,
      [failedAuthor.nodeGenerationId],
      { subject: fs.realpathSync(current.subject), priorOutput: fs.realpathSync(current.priorOutput) },
      inventory,
      'isolated_draft_replay',
    )).toThrow(/outside WorkItem ownership/);
    expect(selected.journal.readRuntimeEvents()).toEqual(beforeRejectedEvents);
    fs.rmSync(path.join(current.checkouts.B, 'specs'), { recursive: true, force: true });

    const ownedCanonical = path.join(current.subject, 'owned-b.txt');
    fs.writeFileSync(ownedCanonical, 'canonical collision\n');
    git(current.subject, ['add', 'owned-b.txt']);
    git(current.subject, ['commit', '--quiet', '-m', 'invalid B owned collision']);
    expect(() => validateRecoverySelection(
      config,
      checkpoint,
      [failedAuthor.nodeGenerationId],
      { subject: fs.realpathSync(current.subject), priorOutput: fs.realpathSync(current.priorOutput) },
      inventory,
      'isolated_draft_replay',
    )).toThrow(/changed WorkItem-owned paths/);
    git(current.subject, ['revert', '--quiet', '--no-edit', 'HEAD']);

    const calls: string[] = [];
    registry.register(new AuthorRecoveryFixtureProvider(calls));
    let retryPrefix: any;
    const engine = new StateMachineExecutionEngine(current.subject);
    const resumed = await engine.retryGraphCheckpoint({
      checkpoint: JSON.parse(JSON.stringify(checkpoint)),
      config,
      prInfo,
      retryGenerationIds: [failedAuthor.nodeGenerationId],
      externalSideEffects: 'isolated_draft_replay',
      onRetryCheckpoint: prefix => {
        expect(calls).toEqual([]);
        retryPrefix = prefix;
      },
      maxParallelism: 2,
      failFast: false,
    });

    expect(JSON.stringify(checkpoint)).toBe(oldCheckpointBytes);
    expect(retryPrefix).toBeDefined();
    expect(retryPrefix.events.slice(0, checkpoint.events.length)).toEqual(checkpoint.events);
    expect(retryPrefix.events[checkpoint.events.length]).toEqual(expect.objectContaining({
      type: 'AttemptRetryRequested',
      nodeGenerationId: failedAuthor.nodeGenerationId,
      externalSideEffects: 'isolated_draft_replay',
    }));
    expect(calls).toEqual(['author-native-component:B', 'promote-native-component:B']);

    const resumedSuffix = resumed.checkpoint.events.slice(retryPrefix.events.length) as any[];
    const retryStart = resumedSuffix.find(event =>
      event.type === 'AttemptStarted' && event.nodeGenerationId === failedAuthor.nodeGenerationId
    );
    expect(retryStart).toBeDefined();
    expect(retryStart.attemptId).not.toBe(firstAttempt.attemptId);
    expect(retryStart.fence).toBeGreaterThan(firstAttempt.fence);
    expect(resumed.checkpoint.events.some(event =>
      event.type === 'ClaimPublished' && event.claim === 'native.component.promoted@1' &&
      event.scope.at(-1)?.key === 'B'
    )).toBe(true);
    expect(calls.some(call => call.endsWith(':A'))).toBe(false);

    const retryPrefixJournal = ExecutionJournal.restoreGraphCheckpoint(
      plan,
      JSON.parse(JSON.stringify(retryPrefix)),
    );
    expect(() => retryPrefixJournal.retryFailedGeneratedAttempts({
      sessionId: SESSION_ID,
      nodeGenerationIds: [failedAuthor.nodeGenerationId],
      externalSideEffects: 'isolated_draft_replay',
    })).toThrow();
    expect(retryPrefixJournal.readRuntimeEvents()).toEqual(retryPrefix.events);
  });
});
