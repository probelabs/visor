import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import {
  CheckProvider,
  type CheckProviderConfig,
  type ExecutionContext,
} from '../../src/providers/check-provider.interface';
import { canonicalGraphCheckpointJson, ExecutionJournal } from '../../src/snapshot-store';
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
            resource_group: 'proof-workspace-mutation',
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

function recoveryConfigWithSkeletonCandidate(): VisorConfig {
  const config = recoveryConfig();
  config.max_parallelism = 3;
  config.claim_types = {
    ...config.claim_types,
    'checklist.skeleton@1': {schema: {type: 'object'}},
  };
  const component = config.subgraphs!.component as any;
  config.subgraphs = {
    ...config.subgraphs,
    component: {
      ...component,
      checks: {
        ...component.checks,
        'checklist-skeleton': {
          type: 'author-recovery-fixture',
          depends_on: ['promote-native-component'],
          consumes: [{claim: 'native.component.promoted@1', as: 'promotion'}],
          emits: [{claim: 'checklist.skeleton@1', from: 'output'}],
        },
      },
    },
  };
  return config;
}

function nativeReviewConfig(): VisorConfig {
  const config = recoveryConfig();
  const objectClaim = {schema: {type: 'object'}};
  config.claim_types = {
    ...config.claim_types,
    'native.role.spec_review@1': {schema: {type: 'string', minLength: 1}},
    'native.requirement.catalog@1': objectClaim,
    'native.requirement.item@1': objectClaim,
    'native.review.candidate@1': objectClaim,
    'native.review.packet@1': objectClaim,
    'native.component.reviewed@1': objectClaim,
  };
  config.subgraphs = {
    ...config.subgraphs,
    'onboard-component': {
      ...config.subgraphs.component,
      checks: {
        ...config.subgraphs.component.checks,
        'role-spec-review-component': {
          type: 'native-review-recovery-fixture',
          consumes: [{claim: 'component.item@1', as: 'component'}],
          emits: [{claim: 'native.role.spec_review@1', from: 'output'}],
        },
        'enumerate-native-requirements': {
          type: 'native-review-recovery-fixture',
          depends_on: ['prepare-work-item', 'role-spec-review-component'],
          consumes: [
            {claim: 'component.prepared_work_item@1', as: 'workItem'},
            {claim: 'native.role.spec_review@1', as: 'role'},
          ],
          emits: [{claim: 'native.requirement.catalog@1', from: 'output'}],
          expand: {
            claim: 'native.requirement.catalog@1',
            template: 'native-requirement-review',
            items_pointer: '/items',
            key_pointer: '/id',
            item_claim: 'native.requirement.item@1',
          },
        },
        'wait-for-native-items': {
          type: 'noop',
          depends_on: ['enumerate-native-requirements'],
          wait_for_expansion: {
            owner: 'enumerate-native-requirements',
            terminal_node: 'collect-proof-evidence',
          },
        },
        'component-reviewed': {
          type: 'native-review-recovery-fixture',
          depends_on: ['wait-for-native-items'],
          consumes: [
            {claim: 'component.prepared_work_item@1', as: 'workItem'},
            {claim: 'native.requirement.catalog@1', as: 'catalog'},
          ],
          emits: [{claim: 'native.component.reviewed@1', from: 'output'}],
        },
      },
    },
    'native-requirement-review': {
      input: {name: 'item', claim: 'native.requirement.item@1'},
      checks: {
          'review-native-item': {
            type: 'native-review-recovery-fixture',
          consumes: [{claim: 'native.requirement.item@1', as: 'item'}],
          emits: [{claim: 'native.review.candidate@1', from: 'output'}],
        },
          'collect-proof-evidence': {
            type: 'native-review-recovery-fixture',
          depends_on: ['review-native-item'],
          consumes: [
            {claim: 'native.requirement.item@1', as: 'item'},
            {claim: 'native.review.candidate@1', as: 'candidate'},
          ],
          emits: [{claim: 'native.review.packet@1', from: 'output'}],
        },
      },
    },
  };
  delete config.subgraphs.component;
  (config.checks['discover-components'] as any).expand.template = 'onboard-component';
  return config;
}

function git(root: string, args: string[]): string {
  return String(execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })).trim();
}

async function waitForFixture<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`fixture timed out waiting for ${label}`)), 1000);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function rehashCheckpoint(checkpoint: any): any {
  const body = {
    events: checkpoint.events,
    frontier: checkpoint.frontier,
    graphSemanticDigest: checkpoint.graphSemanticDigest,
    kind: checkpoint.kind,
    sessionId: checkpoint.sessionId,
    version: checkpoint.version,
  };
  checkpoint.integrity = {
    algorithm: 'sha256',
    digest: createHash('sha256').update(canonicalGraphCheckpointJson(body), 'utf8').digest('hex'),
  };
  return checkpoint;
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

type FailedAuthorCheckpointOptions = Readonly<{
  workItems?: Partial<Record<ComponentId, AuthorWorkItemOverrides>>;
  checkouts?: Partial<Record<ComponentId, AuthorCheckoutOverrides>>;
}>;

function failedAuthorCheckpoint(
  fixture: GitFixture,
  config: VisorConfig,
  options: FailedAuthorCheckpointOptions = {},
): {journal: ExecutionJournal; checkpoint: any; failedGenerations: any[]} {
  const plan = compileClaimPlan(config);
  const journal = new ExecutionJournal(plan);
  publishCatalog(journal);
  for (const component of ['A', 'B'] as const) {
    completeGeneration(journal, 'prepare-work-item', component, workItem(fixture, component, options.workItems?.[component]));
    completeGeneration(journal, 'checkout-worktree', component, checkout(fixture, component, options.checkouts?.[component]));
    completeGeneration(journal, 'role-onboard-component', component, 'native onboard role v1');
  }
  const failedGenerations = (['A', 'B'] as const).map(component => {
    const failedAuthor = generationFor(journal, 'author-native-component', component);
    const attempt = journal.startGeneratedAttempt(failedAuthor.nodeGenerationId);
    journal.scheduleGeneratedAttempt(attempt);
    journal.failGeneratedAttempt(attempt, 'MANAGED_START_FAILED');
    return failedAuthor;
  });
  return {journal, checkpoint: journal.exportGraphCheckpoint(SESSION_ID), failedGenerations};
}

function generationForNativeItem(journal: ExecutionJournal, checkId: string, itemId: string): any {
  const generation = journal.queryReadyWork().find(value =>
    value.checkId === checkId && value.scope.at(-1)?.key === itemId
  );
  if (!generation) throw new Error(`missing ready ${checkId}:${itemId}`);
  return generation;
}

function completeNativeGeneration(journal: ExecutionJournal, checkId: string, itemId: string, payload: unknown): any {
  const generation = generationForNativeItem(journal, checkId, itemId);
  const attempt = journal.startGeneratedAttempt(generation.nodeGenerationId);
  journal.scheduleGeneratedAttempt(attempt);
  journal.completeGeneratedAttempt({attempt, payload});
  return {generation, attempt};
}

type AuthorWorkItemOverrides = Readonly<{
  componentId?: string;
  baselineCommit?: string;
  ownedPath?: string;
}>;

type AuthorCheckoutOverrides = Readonly<{
  path?: string;
  baselineCommit?: string;
}>;

function workItem(
  fixture: GitFixture,
  component: ComponentId,
  overrides: AuthorWorkItemOverrides = {},
): Record<string, unknown> {
  const componentId = overrides.componentId || component;
  return {
    component_id: componentId,
    baseline_commit: overrides.baselineCommit || fixture.baselineCommit,
    project_id: PROJECT_ID,
    proof_component_subject: {
      component_id: componentId,
      fingerprint: PROOF_FINGERPRINT,
    },
    sorted_owned_paths: [overrides.ownedPath || `owned-${component.toLowerCase()}.txt`],
  };
}

function checkout(
  fixture: GitFixture,
  component: ComponentId,
  overrides: AuthorCheckoutOverrides = {},
): Record<string, unknown> {
  return {
    success: true,
    path: overrides.path || fixture.checkouts[component],
    commit: overrides.baselineCommit || fixture.baselineCommit,
    ref: overrides.baselineCommit || fixture.baselineCommit,
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
  getSupportedConfigKeys(): string[] { return ['type', 'resource_group']; }

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

type MultiAuthorRecoveryFixtureOptions = Readonly<{
  holdAuthor?: ComponentId;
}>;

class MultiAuthorRecoveryFixtureProvider extends CheckProvider {
  authorEntries = 0;
  activeAuthors = 0;
  maxConcurrentAuthors = 0;
  activePromotions = 0;
  maxConcurrentPromotions = 0;
  heldAuthorReleased = false;
  readonly heldAuthorEntered: Promise<void>;
  readonly authorACompleted: Promise<void>;
  readonly authorAPromotionStarted: Promise<void>;
  private readonly heldAuthor?: ComponentId;
  private readonly heldAuthorGate: Promise<void>;
  private releaseHeldAuthorGate!: () => void;
  private resolveHeldAuthorEntered!: () => void;
  private resolveAuthorACompleted!: () => void;
  private resolveAuthorAPromotionStarted!: () => void;
  private readonly authorOverlap: Promise<void>;
  private releaseAuthorOverlap!: () => void;

  constructor(
    private readonly calls: string[],
    options: MultiAuthorRecoveryFixtureOptions = {},
  ) {
    super();
    this.heldAuthor = options.holdAuthor;
    this.heldAuthorGate = new Promise<void>(resolve => {
      this.releaseHeldAuthorGate = resolve;
    });
    this.heldAuthorEntered = new Promise<void>(resolve => {
      this.resolveHeldAuthorEntered = resolve;
    });
    this.authorACompleted = new Promise<void>(resolve => {
      this.resolveAuthorACompleted = resolve;
    });
    this.authorAPromotionStarted = new Promise<void>(resolve => {
      this.resolveAuthorAPromotionStarted = resolve;
    });
    this.authorOverlap = this.heldAuthor === undefined
      ? new Promise<void>(resolve => { this.releaseAuthorOverlap = resolve; })
      : Promise.resolve();
  }

  releaseHeldAuthor(): void {
    this.heldAuthorReleased = true;
    this.releaseHeldAuthorGate();
  }

  getName(): string { return 'author-recovery-fixture'; }
  getDescription(): string { return 'Deterministic concurrent isolated author recovery provider'; }
  async validateConfig(): Promise<boolean> { return true; }
  async isAvailable(): Promise<boolean> { return true; }
  getRequirements(): string[] { return []; }
  getSupportedConfigKeys(): string[] { return ['type', 'resource_group']; }

  async execute(
    _pr: PRInfo,
    providerConfig: CheckProviderConfig,
    _dependencies?: Map<string, ReviewSummary>,
    context?: ExecutionContext,
  ): Promise<ReviewSummary> {
    const checkId = String(providerConfig.checkName);
    const scope = context?.scope || [];
    const component = String(scope[scope.length - 1]?.key || '');
    if (component !== 'A' && component !== 'B') throw new Error(`unexpected provider dispatch for ${component || 'root'}`);
    this.calls.push(`${checkId}:${component}`);
    if (checkId === 'author-native-component') {
      this.activeAuthors += 1;
      this.authorEntries += 1;
      this.maxConcurrentAuthors = Math.max(this.maxConcurrentAuthors, this.activeAuthors);
      try {
        if (this.heldAuthor === component) {
          this.resolveHeldAuthorEntered();
          await this.heldAuthorGate;
        } else if (this.heldAuthor !== undefined) {
          await this.heldAuthorEntered;
        } else if (this.heldAuthor === undefined) {
          if (this.authorEntries === 2) this.releaseAuthorOverlap();
          await this.authorOverlap;
        }
      } finally {
        this.activeAuthors -= 1;
      }
      if (component === 'A') this.resolveAuthorACompleted();
      return {issues: [], output: {component_id: component, replayed: true}};
    }
    if (checkId === 'promote-native-component') {
      this.activePromotions += 1;
      this.maxConcurrentPromotions = Math.max(this.maxConcurrentPromotions, this.activePromotions);
      if (component === 'A') this.resolveAuthorAPromotionStarted();
      await new Promise<void>(resolve => setTimeout(resolve, 10));
      this.activePromotions -= 1;
      return {issues: [], output: {component_id: component, promoted: true}};
    }
    throw new Error(`unexpected recovery check ${checkId}`);
  }
}

class NativeReviewRecoveryFixtureProvider extends CheckProvider {
  constructor(private readonly calls: string[]) { super(); }
  getName(): string { return 'native-review-recovery-fixture'; }
  getDescription(): string { return 'Deterministic native review recovery provider'; }
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
    const itemCheck = checkId === 'review-native-item' || checkId === 'collect-proof-evidence';
    const component = itemCheck ? scope[scope.length - 2]?.key : scope[scope.length - 1]?.key;
    const item = scope[scope.length - 1]?.key;
    if (component !== 'B' && checkId !== 'component-reviewed') {
      throw new Error(`unexpected native review dispatch for ${component || 'root'}`);
    }
    this.calls.push(`${checkId}:${String(item)}`);
    if (checkId === 'review-native-item') {
      return {issues: [], output: {component_id: component, id: item, reviewed: true}};
    }
    if (checkId === 'collect-proof-evidence') {
      return {issues: [], output: {component_id: component, id: item, packet: true}};
    }
    if (checkId === 'component-reviewed') {
      return {issues: [], output: {component_id: component, reviewed: true}};
    }
    throw new Error(`unexpected native review check ${checkId}`);
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
    if (registry.getProvider('native-review-recovery-fixture')) registry.unregister('native-review-recovery-fixture');
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

  it('atomically selects two isolated authors, runs them concurrently, and serializes promotions', async () => {
    const current = fixture!;
    fs.writeFileSync(path.join(current.checkouts.A, 'owned-a.txt'), 'A retained draft\n');
    const config = recoveryConfig();
    const plan = compileClaimPlan(config);
    const prepared = failedAuthorCheckpoint(current, config);
    const checkpoint = prepared.checkpoint;
    const oldCheckpointBytes = JSON.stringify(checkpoint);
    const selectedGenerationIds = prepared.failedGenerations
      .map(generation => generation.nodeGenerationId)
      .sort();
    const inventory = {
      authority: {
        project_id: PROJECT_ID,
        subject_fingerprint: PROOF_FINGERPRINT,
      },
    };
    const roots = {
      subject: fs.realpathSync(current.subject),
      priorOutput: fs.realpathSync(current.priorOutput),
    };
    const selected = validateRecoverySelection(
      config,
      checkpoint,
      selectedGenerationIds,
      roots,
      inventory,
      'isolated_draft_replay',
      [],
      {allowEmptyAuthorDraft: true, expectedBaselineCommit: current.baselineCommit},
    );
    expect(selected.bindings).toHaveLength(2);
    expect(selected.bindings.map(binding => binding.componentId).sort()).toEqual(['A', 'B']);
    expect(selected.bindings.every(binding => binding.draftInventory?.files.length === 1)).toBe(true);

    const calls: string[] = [];
    const provider = new MultiAuthorRecoveryFixtureProvider(calls);
    registry.register(provider);
    try {
      let retryPrefix: any;
      const engine = new StateMachineExecutionEngine(current.subject);
      const resumed = await engine.retryGraphCheckpoint({
        checkpoint: JSON.parse(JSON.stringify(checkpoint)),
        config,
        prInfo,
        retryGenerationIds: selectedGenerationIds,
        externalSideEffects: 'isolated_draft_replay',
        onRetryCheckpoint: prefix => {
          expect(calls).toEqual([]);
          retryPrefix = prefix;
          const retrySuffix = prefix.events.slice(checkpoint.events.length);
          expect(retrySuffix).toHaveLength(2);
          expect(retrySuffix.map((event: any) => event.type)).toEqual(['AttemptRetryRequested', 'AttemptRetryRequested']);
          expect(retrySuffix.map((event: any) => event.nodeGenerationId)).toEqual(selectedGenerationIds);
        },
        maxParallelism: 2,
        failFast: false,
      });

      expect(JSON.stringify(checkpoint)).toBe(oldCheckpointBytes);
      expect(retryPrefix.events.slice(0, checkpoint.events.length)).toEqual(checkpoint.events);
      expect(retryPrefix.events.filter((event: any) =>
        event.type === 'AttemptRetryRequested' && selectedGenerationIds.includes(event.nodeGenerationId)
      )).toHaveLength(2);
      expect(provider.authorEntries).toBe(2);
      expect(provider.maxConcurrentAuthors).toBe(2);
      expect(provider.maxConcurrentPromotions).toBe(1);
      expect(calls.filter(call => call.startsWith('author-native-component:')).sort()).toEqual([
        'author-native-component:A', 'author-native-component:B',
      ]);
      expect(calls.filter(call => call.startsWith('promote-native-component:')).sort()).toEqual([
        'promote-native-component:A', 'promote-native-component:B',
      ]);
      const projection = ExecutionJournal.restoreGraphCheckpoint(
        plan,
        JSON.parse(JSON.stringify(resumed.checkpoint)),
      ).getInstanceProjection();
      for (const generationId of selectedGenerationIds) {
        expect(projection.generationsById[generationId].status).toBe('completed');
      }
      expect(Object.values(projection.claimsById).filter((claim: any) =>
        claim.active === true && claim.claim === 'native.component.promoted@1'
      ).map((claim: any) => claim.scope.at(-1)?.key).sort()).toEqual(['A', 'B']);
    } finally {
      registry.unregister('author-recovery-fixture');
    }
  });

  it('does not hold a ready promotion behind a paused checklist skeleton', async () => {
    const current = fixture!;
    fs.writeFileSync(path.join(current.checkouts.A, 'owned-a.txt'), 'A retained draft\n');
    const config = recoveryConfigWithSkeletonCandidate();
    const plan = compileClaimPlan(config);
    const prepared = failedAuthorCheckpoint(current, config);
    const checkpoint = prepared.checkpoint;
    const oldCheckpointBytes = JSON.stringify(checkpoint);
    const selectedGenerationIds = prepared.failedGenerations
      .map(generation => generation.nodeGenerationId)
      .sort();
    const inventory = {
      authority: {
        project_id: PROJECT_ID,
        subject_fingerprint: PROOF_FINGERPRINT,
      },
    };
    const roots = {
      subject: fs.realpathSync(current.subject),
      priorOutput: fs.realpathSync(current.priorOutput),
    };
    const selected = validateRecoverySelection(
      config,
      checkpoint,
      selectedGenerationIds,
      roots,
      inventory,
      'isolated_draft_replay',
      [],
      {allowEmptyAuthorDraft: true, expectedBaselineCommit: current.baselineCommit},
    );
    expect(selected.bindings).toHaveLength(2);

    const calls: string[] = [];
    const provider = new MultiAuthorRecoveryFixtureProvider(calls, {holdAuthor: 'B'});
    registry.register(provider);
    let retryPrefix: any;
    const gateCalls: string[] = [];
    const engine = new StateMachineExecutionEngine(current.subject);
    const resumedPromise = engine.retryGraphCheckpoint({
      checkpoint: JSON.parse(JSON.stringify(checkpoint)),
      config,
      prInfo,
      retryGenerationIds: selectedGenerationIds,
      externalSideEffects: 'isolated_draft_replay',
      generatedDispatchGate: generation => {
        const component = String(generation.scope.at(-1)?.key || '');
        gateCalls.push(`${generation.checkId}:${component}`);
        return generation.checkId === 'checklist-skeleton' ? 'defer' : 'dispatch';
      },
      onRetryCheckpoint: prefix => {
        expect(calls).toEqual([]);
        retryPrefix = prefix;
      },
      maxParallelism: 3,
      failFast: false,
    });
    try {
      await waitForFixture(provider.heldAuthorEntered, 'B author entry');
      await waitForFixture(provider.authorACompleted, 'A author completion');
      expect(provider.heldAuthorReleased).toBe(false);
      expect(provider.activeAuthors).toBe(1);
      await waitForFixture(provider.authorAPromotionStarted, 'A promotion dispatch while B is held');
      expect(provider.heldAuthorReleased).toBe(false);
      expect(provider.activePromotions).toBe(1);
      provider.releaseHeldAuthor();
      const resumed = await resumedPromise;

      expect(JSON.stringify(checkpoint)).toBe(oldCheckpointBytes);
      expect(retryPrefix.events.slice(0, checkpoint.events.length)).toEqual(checkpoint.events);
      expect(retryPrefix.events.slice(checkpoint.events.length).map((event: any) => event.type)).toEqual([
        'AttemptRetryRequested', 'AttemptRetryRequested',
      ]);
      expect(retryPrefix.events.slice(checkpoint.events.length).map((event: any) => event.nodeGenerationId)).toEqual(
        selectedGenerationIds,
      );
      expect(provider.authorEntries).toBe(2);
      expect(provider.maxConcurrentAuthors).toBe(2);
      expect(provider.maxConcurrentPromotions).toBe(1);
      expect(gateCalls.some(call => call.startsWith('checklist-skeleton:'))).toBe(true);

      const projection = ExecutionJournal.restoreGraphCheckpoint(
        plan,
        JSON.parse(JSON.stringify(resumed.checkpoint)),
      ).getInstanceProjection();
      const skeletons = Object.values(projection.generationsById).filter(
        generation => generation.checkId === 'checklist-skeleton'
      );
      expect(skeletons).toHaveLength(2);
      expect(skeletons.every(generation => generation.status === 'ready')).toBe(true);
      for (const event of resumed.checkpoint.events.filter(event =>
        typeof event.nodeGenerationId === 'string' && selectedGenerationIds.includes(event.nodeGenerationId)
      )) {
        const expectedGeneration = prepared.failedGenerations.find(
          generation => generation.nodeGenerationId === event.nodeGenerationId
        );
        expect(event.scope).toEqual(expectedGeneration?.scope);
      }
    } finally {
      provider.releaseHeldAuthor();
      await resumedPromise.catch(() => undefined);
      registry.unregister('author-recovery-fixture');
    }
  });

  it.each([
    ['shared checkout', 'shared-checkout', /checkout roots/],
    ['duplicate component', 'duplicate-component', /duplicate component/],
    ['overlapping promotable path', 'overlapping-path', /overlapping promotable path/],
    ['mismatched baseline', 'mismatched-baseline', /baselines? (?:do|does) not match/],
  ] as const)('rejects %s before retry events or provider calls', (_label, scenario, expectedError) => {
    const current = fixture!;
    const config = recoveryConfig();
    let options: FailedAuthorCheckpointOptions = {};
    if (scenario === 'shared-checkout') {
      options = {checkouts: {B: {path: current.checkouts.A}}};
    } else if (scenario === 'duplicate-component') {
      fs.writeFileSync(path.join(current.checkouts.B, 'owned-b.txt'), 'B baseline\n');
      options = {workItems: {B: {componentId: 'A'}}};
    } else if (scenario === 'overlapping-path') {
      fs.writeFileSync(path.join(current.checkouts.A, 'owned-a.txt'), 'A retained draft\n');
      fs.writeFileSync(path.join(current.checkouts.B, 'owned-b.txt'), 'B baseline\n');
      fs.writeFileSync(path.join(current.checkouts.B, 'owned-a.txt'), 'B retained draft\n');
      options = {workItems: {B: {ownedPath: 'owned-a.txt'}}};
    } else {
      const descendant = git(current.subject, ['rev-parse', 'HEAD']);
      git(current.subject, ['worktree', 'remove', '--force', current.checkouts.B]);
      git(current.subject, ['worktree', 'add', '--quiet', '--detach', current.checkouts.B, descendant]);
      fs.writeFileSync(path.join(current.checkouts.B, 'owned-b.txt'), 'B retained draft\n');
      options = {
        workItems: {B: {baselineCommit: descendant}},
        checkouts: {B: {baselineCommit: descendant}},
      };
    }
    const prepared = failedAuthorCheckpoint(current, config, options);
    const checkpoint = prepared.checkpoint;
    const oldCheckpointBytes = JSON.stringify(checkpoint);
    const inventory = {authority: {project_id: PROJECT_ID, subject_fingerprint: PROOF_FINGERPRINT}};
    const roots = {subject: fs.realpathSync(current.subject), priorOutput: fs.realpathSync(current.priorOutput)};
    const calls: string[] = [];
    const provider = new MultiAuthorRecoveryFixtureProvider(calls);
    registry.register(provider);
    try {
      expect(() => validateRecoverySelection(
        config,
        checkpoint,
        prepared.failedGenerations.map(generation => generation.nodeGenerationId).sort(),
        roots,
        inventory,
        'isolated_draft_replay',
        [],
        {allowEmptyAuthorDraft: true, expectedBaselineCommit: current.baselineCommit},
      )).toThrow(expectedError);
      expect(calls).toEqual([]);
      expect(JSON.stringify(checkpoint)).toBe(oldCheckpointBytes);
    } finally {
      registry.unregister('author-recovery-fixture');
    }
  });

  it('retries only failed native review leaves and reuses retained sibling packets', async () => {
    const current = fixture!;
    const config = nativeReviewConfig();
    const plan = compileClaimPlan(config);
    const journal = new ExecutionJournal(plan);
    publishCatalog(journal);

    const prepared = workItem(current, 'B');
    const items = Array.from({length: 17}, (_, index) => {
      const id = `SYS-REQ-${String(index + 1).padStart(3, '0')}`;
      return {
        id,
        component_id: 'B',
        file_path: `specs/system/requirements/${id}.req.yaml`,
        proof_file_hash: `sha256:${String(index + 1).padStart(2, '0').repeat(32)}`,
        spec_review_role: 'native spec-review role',
        proof_snapshot: {
          catalog_entry: {id, component: 'B', priority_level: 'major'},
          req_show: {file_path: `specs/system/requirements/${id}.req.yaml`},
          spec_graph: {id, edges: []},
        },
        prepared_work_item: prepared,
      };
    });
    for (const component of ['A', 'B'] as const) {
      completeGeneration(journal, 'prepare-work-item', component, workItem(current, component));
      completeGeneration(journal, 'checkout-worktree', component, checkout(current, component));
      completeGeneration(journal, 'role-onboard-component', component, 'native onboard role v1');
      completeGeneration(journal, 'role-spec-review-component', component, 'native spec-review role');
      completeGeneration(journal, 'enumerate-native-requirements', component, {
        component_id: component,
        items: component === 'B' ? items : [],
      });
      completeGeneration(journal, 'author-native-component', component, {component_id: component, authored: true});
      completeGeneration(journal, 'promote-native-component', component, {component_id: component, promoted: true});
    }

    const failedIds = new Set(items.slice(-3).map(item => item.id));
    const failedGenerations: any[] = [];
    const packetById = new Map<string, any>();
    for (const item of items) {
      const review = generationForNativeItem(journal, 'review-native-item', item.id);
      const attempt = journal.startGeneratedAttempt(review.nodeGenerationId);
      journal.scheduleGeneratedAttempt(attempt);
      if (failedIds.has(item.id)) {
        journal.failGeneratedAttempt(attempt, 'PROVIDER_EXECUTION_FAILED');
        failedGenerations.push(review);
        continue;
      }
      journal.completeGeneratedAttempt({
        attempt,
        payload: {component_id: 'B', id: item.id, reviewed: true},
      });
      const packet = {
        id: item.id,
        component_id: 'B',
        file_path: item.file_path,
        proof_file_hash: item.proof_file_hash,
        candidate: {decision: 'needs_changes'},
        catalog_entry: item.proof_snapshot.catalog_entry,
        req_show: item.proof_snapshot.req_show,
        spec_graph: item.proof_snapshot.spec_graph,
        prepared_work_item: prepared,
        freshness: 'pending_component_fan_in',
      };
      completeNativeGeneration(journal, 'collect-proof-evidence', item.id, packet);
      packetById.set(item.id, packet);
    }
    const checkpoint = journal.exportGraphCheckpoint(SESSION_ID);
    const checkpointRoot = path.join(current.root, 'review-checkpoint');
    const packetDir = path.join(checkpointRoot, 'review-packets', Buffer.from('B').toString('base64url'));
    fs.mkdirSync(packetDir, {recursive: true});
    for (const [id, packet] of packetById) {
      fs.writeFileSync(
        path.join(packetDir, Buffer.from(id).toString('base64url') + '.json'),
        JSON.stringify(packet, null, 2) + '\n',
        'utf8',
      );
    }
    const selectedGenerationIds = failedGenerations.map(generation => generation.nodeGenerationId).sort();
    const selectedItemId = String(failedGenerations.find(generation =>
      generation.nodeGenerationId === selectedGenerationIds[0]
    )?.scope.at(-1)?.key);
    const currentRequirements = items.slice(-3).map(item => ({
      id: item.id,
      componentId: 'B',
      filePath: item.file_path,
      proofFileHash: item.proof_file_hash,
    }));
    const roots = {
      subject: fs.realpathSync(current.subject),
      priorOutput: fs.realpathSync(current.priorOutput),
      checkpointRoot: fs.realpathSync(checkpointRoot),
    };
    const inventory = {authority: {project_id: PROJECT_ID, subject_fingerprint: PROOF_FINGERPRINT}};
    const validate = (
      input = checkpoint,
      sideEffects: any = 'absent',
      requirements = currentRequirements,
      generations = selectedGenerationIds,
    ) =>
      validateRecoverySelection(
        config, input, generations, roots, inventory, sideEffects, requirements,
      );

    const selected = validate();
    expect(selected.bindings.map(binding => binding.componentId)).toEqual(['B', 'B', 'B']);
    expect(selected.reviewPackets).toHaveLength(14);
    expect(selected.reviewPackets.map(packet => packet.id).sort()).toEqual([...packetById.keys()].sort());

    const catalogEvent = checkpoint.events.find((event: any) =>
      event.type === 'ClaimPublished' && event.claim === 'native.requirement.catalog@1' &&
      event.scope?.at(-1)?.key === 'B'
    );
    const preparedClaim = checkpoint.events.find((event: any) =>
      event.type === 'ClaimPublished' && event.claim === 'component.prepared_work_item@1' &&
      event.scope?.at(-1)?.key === 'B'
    );
    const catalogRoleClaim = checkpoint.events.find((event: any) =>
      event.type === 'ClaimPublished' && event.claim === 'native.role.spec_review@1' &&
      event.scope?.at(-1)?.key === 'B'
    );
    expect(catalogEvent).toBeDefined();
    expect(preparedClaim).toBeDefined();
    expect(catalogRoleClaim).toBeDefined();
    expect(catalogEvent.parentClaimIds).toEqual(expect.arrayContaining([
      preparedClaim.claimId,
      catalogRoleClaim.claimId,
    ]));

    const wrongControllerOwner = JSON.parse(JSON.stringify(checkpoint));
    const controllerItem = wrongControllerOwner.events.find((event: any) =>
      event.type === 'ControllerItemClaimPublished' && event.claim === 'native.requirement.item@1' &&
      event.scope?.at(-1)?.key === selectedItemId
    );
    expect(controllerItem).toBeDefined();
    controllerItem.expansionOwnerCheck = 'discover-components';
    expect(() => validate(rehashCheckpoint(wrongControllerOwner))).toThrow(
      /Checkpoint instance replay failed|expansion|owner/i,
    );

    const wrongCatalogParents = JSON.parse(JSON.stringify(checkpoint));
    const mutatedCatalog = wrongCatalogParents.events.find((event: any) =>
      event.type === 'ClaimPublished' && event.claim === 'native.requirement.catalog@1' &&
      event.scope?.at(-1)?.key === 'B'
    );
    expect(mutatedCatalog).toBeDefined();
    mutatedCatalog.parentClaimIds = [preparedClaim.claimId];
    expect(() => validate(rehashCheckpoint(wrongCatalogParents))).toThrow(
      /Checkpoint instance replay failed|parent|catalog/i,
    );

    const failedState = new Map(selectedGenerationIds.map(id => {
      const generation = journal.getInstanceProjection().generationsById[id];
      return [id, {attemptId: generation.attemptId, fence: generation.fence, status: generation.status}];
    }));

    const partial = validate(checkpoint, 'absent', currentRequirements, [selectedGenerationIds[0]]);
    expect(partial.bindings).toHaveLength(1);
    expect(partial.reviewPackets).toHaveLength(14);

    expect(() => validate(checkpoint, 'safely_idempotent')).toThrow(/review-native-item recovery/);
    expect(() => validate(checkpoint, 'isolated_draft_replay')).toThrow(/isolated draft replay|review-native-item recovery/);
    expect(() => validate(checkpoint, 'absent', currentRequirements.map(requirement => ({
      ...requirement,
      proofFileHash: `sha256:${'f'.repeat(64)}`,
    })))).toThrow(/stale current Proof hash/);

    const wrongRole = JSON.parse(JSON.stringify(checkpoint));
    const roleClaim = wrongRole.events.find((event: any) =>
      event.type === 'ClaimPublished' && event.claim === 'native.role.spec_review@1' &&
      event.scope?.at(-1)?.key === 'B'
    );
    expect(roleClaim).toBeDefined();
    roleClaim.payload = 'forged native role';
    expect(() => validate(rehashCheckpoint(wrongRole))).toThrow(/unbound native review item or role|Checkpoint instance replay failed/);

    const wrongScope = JSON.parse(JSON.stringify(checkpoint));
    const itemClaim = wrongScope.events.find((event: any) =>
      event.claim === 'native.requirement.item@1' && event.scope?.at(-1)?.key === [...failedIds][0]
    );
    expect(itemClaim).toBeDefined();
    itemClaim.scope = itemClaim.scope.slice(1);
    expect(() => validate(rehashCheckpoint(wrongScope))).toThrow(/unbound native review item or role|Checkpoint instance replay failed/);

    const calls: string[] = [];
    registry.register(new NativeReviewRecoveryFixtureProvider(calls));
    let partialRetryPrefix: any;
    const partialEngine = new StateMachineExecutionEngine(current.subject);
    const partialResumed = await partialEngine.retryGraphCheckpoint({
      checkpoint: JSON.parse(JSON.stringify(checkpoint)),
      config,
      prInfo,
      retryGenerationIds: [selectedGenerationIds[0]],
      externalSideEffects: 'absent',
      onRetryCheckpoint: prefix => { partialRetryPrefix = prefix; },
      maxParallelism: 2,
      failFast: false,
    });
    expect(partialRetryPrefix.events.slice(0, checkpoint.events.length)).toEqual(checkpoint.events);
    expect(calls).toEqual([
      `review-native-item:${selectedItemId}`,
      `collect-proof-evidence:${selectedItemId}`,
    ]);
    const partialRetryEvents = partialResumed.checkpoint.events.filter(event => event.type === 'AttemptRetryRequested');
    expect(partialRetryEvents).toHaveLength(1);
    expect(partialRetryEvents[0].nodeGenerationId).toBe(selectedGenerationIds[0]);
    const partialProjection = ExecutionJournal.restoreGraphCheckpoint(
      plan,
      JSON.parse(JSON.stringify(partialResumed.checkpoint)),
    ).getInstanceProjection();
    for (const generationId of selectedGenerationIds.slice(1)) {
      expect(partialProjection.generationsById[generationId]).toMatchObject(failedState.get(generationId));
    }
    const selectedAfterPartial = partialProjection.generationsById[selectedGenerationIds[0]];
    expect(selectedAfterPartial.status).toBe('completed');
    expect(selectedAfterPartial.attemptId).not.toBe(failedState.get(selectedGenerationIds[0])?.attemptId);
    expect(selectedAfterPartial.fence).toBeGreaterThan(failedState.get(selectedGenerationIds[0])?.fence || 0);
    // The wait/fan-in remains blocked behind the two untouched failed leaves;
    // the dependent node is therefore not created or attempted yet.
    expect((config.subgraphs!['onboard-component'] as any).checks['wait-for-native-items']).toEqual(expect.objectContaining({
      wait_for_expansion: expect.objectContaining({owner: 'enumerate-native-requirements'}),
    }));
    expect(Object.values(partialProjection.generationsById).some(generation =>
      generation.checkId === 'component-reviewed' && generation.scope.at(-1)?.key === 'B'
    )).toBe(false);
    expect(calls.some(call => call.startsWith('component-reviewed:'))).toBe(false);

    calls.length = 0;
    let retryPrefix: any;
    const engine = new StateMachineExecutionEngine(current.subject);
    const resumed = await engine.retryGraphCheckpoint({
      checkpoint: JSON.parse(JSON.stringify(checkpoint)),
      config,
      prInfo,
      retryGenerationIds: selectedGenerationIds,
      externalSideEffects: 'absent',
      onRetryCheckpoint: prefix => { retryPrefix = prefix; },
      maxParallelism: 2,
      failFast: false,
    });
    expect(retryPrefix.events.slice(0, checkpoint.events.length)).toEqual(checkpoint.events);
    expect(calls.filter(call => call.startsWith('review-native-item:')).sort()).toEqual(
      [...failedIds].map(id => `review-native-item:${id}`).sort(),
    );
    expect(calls.filter(call => call.startsWith('collect-proof-evidence:')).sort()).toEqual(
      [...failedIds].map(id => `collect-proof-evidence:${id}`).sort(),
    );
    expect(calls.some(call => [...packetById.keys()].some(id => call.endsWith(':' + id)))).toBe(false);
    expect(calls.filter(call => call === 'component-reviewed:B')).toHaveLength(1);
    expect(resumed.checkpoint.events.filter(event =>
      event.type === 'AttemptRetryRequested' && selectedGenerationIds.includes(event.nodeGenerationId)
    )).toHaveLength(3);
  });
});
