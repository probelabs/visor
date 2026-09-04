import { describe, it, expect, jest } from '@jest/globals';
import { ExecutionJournal, ContextView, ScopePath } from '../../src/snapshot-store';
import { compileClaimPlan } from '../../src/state-machine/graph/claim-plan';
import {
  armManagedRunDeadline,
  normalizeManagedRunOutcome,
  normalizeManagedRunTimeout,
  snapshotManagedRun,
  snapshotManagedRunStartRequest,
} from '../../src/state-machine/dispatch/managed-run';
import type {
  ManagedRunCancelReceiptV1,
  ManagedRunCleanupReceiptV1,
} from '../../src/providers/check-provider.interface';
import { canonicalJson, immutableCanonicalValue, sha256Canonical } from '../../src/state-machine/graph/claim-kernel';
import { governedResultDigest } from '../../src/providers/governed-proof-inspect-check-provider';
import {
  deriveControllerItemClaimId,
  deriveNodeGenerationId,
  reduceInstanceEventBatch,
  type GeneratedAttemptStartedEvent,
  type InstanceProjection,
  type InstanceRuntimeEvent,
  type ManagedRunBindingV1,
} from '../../src/state-machine/graph/instance-kernel';

function makeResult(val: any) {
  return { issues: [], output: val } as any;
}

type C2TemplateShape = 'linear' | 'two-predecessor';

function c2Config(templateShape: C2TemplateShape = 'linear'): any {
  const claimSchema = (required: string[]) => ({
    type: 'object',
    additionalProperties: false,
    required,
    properties: {
      id: { type: 'string', minLength: 1 },
      findings: { type: 'array', items: { type: 'string' } },
    },
  });
  const checks =
    templateShape === 'linear'
      ? {
          inspect: {
            type: 'noop',
            consumes: [{ claim: 'component.item@1', as: 'component' }],
            emits: [{ claim: 'component.inspected@1', from: 'output' }],
          },
          summarize: {
            type: 'noop',
            consumes: [{ claim: 'component.inspected@1', as: 'inspected' }],
          },
        }
      : {
          first: {
            type: 'noop',
            consumes: [{ claim: 'component.item@1', as: 'component' }],
            emits: [{ claim: 'component.first@1', from: 'output' }],
          },
          second: {
            type: 'noop',
            consumes: [{ claim: 'component.item@1', as: 'component' }],
            emits: [{ claim: 'component.second@1', from: 'output' }],
          },
          join: {
            type: 'noop',
            depends_on: ['first', 'second'],
            consumes: [{ claim: 'component.first@1', as: 'firstResult' }],
          },
        };

  return {
    version: '1.0',
    claim_types: {
      // Deliberately permissive: reconciliation, not the catalog schema, owns pointer checks.
      'component.catalog@1': { schema: { type: 'object' } },
      'component.item@1': {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'path'],
          properties: {
            // Number/string equivalence is a hostile canonical-key case.
            id: {
              anyOf: [
                { type: 'string', minLength: 1 },
                { type: 'number' },
              ],
            },
            path: { type: 'string', minLength: 1 },
          },
        },
      },
      'component.inspected@1': { schema: claimSchema(['id', 'findings']) },
      'component.first@1': { schema: claimSchema(['id', 'findings']) },
      'component.second@1': { schema: claimSchema(['id', 'findings']) },
    },
    subgraphs: {
      component: {
        input: { name: 'component', claim: 'component.item@1' },
        checks,
      },
    },
    checks: {
      discover: {
        type: 'noop',
        emits: [{ claim: 'component.catalog@1', from: 'output' }],
        expand: {
          claim: 'component.catalog@1',
          template: 'component',
          items_pointer: '/components',
          key_pointer: '/id',
          item_claim: 'component.item@1',
        },
      },
    },
  };
}

function c2Journal(templateShape: C2TemplateShape = 'linear'): ExecutionJournal {
  return new ExecutionJournal(compileClaimPlan(c2Config(templateShape)));
}

function governedC2Config(): any {
  const config = c2Config();
  const schema = JSON.stringify({ type: 'object' });
  const invocation = { role_id: 'owner', stance: 'owner', subject: { kind: 'project', id: 'fixture', fingerprint: `sha256:${'1'.repeat(64)}` }, output_schema_id: 'candidate', output_schema: Buffer.from(schema).toString('base64') };
  config.claim_types['proof.candidate@1'] = { schema: { type: 'object', required: ['id', 'decision'], properties: { id: { type: 'string' }, decision: { type: 'string' } } } };
  config.claim_types['proof.admitted_receipt@1'] = { schema: { type: 'object' } };
  config.subgraphs.component.checks = {
    inspect: { type: 'governed-proof-inspect', message: 'inspect', instructions: 'review', invocation, invocation_digest: `sha256:${'2'.repeat(64)}`, result_schema: schema, profile: 'luna-xhigh-readonly-v1', consumes: [{ claim: 'component.item@1', as: 'component' }], emits: [{ claim: 'proof.candidate@1', from: 'output' }] },
    proof_admit: { type: 'proof-admit', consumes: [{ claim: 'proof.candidate@1', as: 'candidate' }], emits: [{ claim: 'proof.admitted_receipt@1', from: 'output' }] },
    verify: { type: 'noop', consumes: [{ claim: 'proof.candidate@1', as: 'candidate' }, { claim: 'proof.admitted_receipt@1', as: 'receipt' }] },
  };
  return config;
}

function governedEvidence(data: Record<string, string>): any {
  const invocation = { role_id: 'owner', stance: 'owner', subject: { kind: 'project', id: 'fixture', fingerprint: `sha256:${'1'.repeat(64)}` }, output_schema_id: 'candidate', output_schema: Buffer.from(JSON.stringify({ type: 'object' })).toString('base64') };
  const digest = governedResultDigest(data);
  const attestationDigest = 'c'.repeat(64);
  const attestation = { version: 'probe.governed-codex-attestation/v2', profileId: 'luna-xhigh-readonly-v1', requested: { profileDigest: attestationDigest, cwdDigest: attestationDigest, probeToolsDigest: attestationDigest, model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never' }, observed: { source: 'session_configured', model: 'gpt-5.6-luna', modelProviderId: 'openai', reasoningEffort: 'xhigh', approvalPolicy: 'never', cwdDigest: attestationDigest, permissionProfileDigest: attestationDigest, filesystem: 'restricted-read-root', network: 'restricted' }, executionContext: { source: 'caller', invocationDigest: `sha256:${'2'.repeat(64)}` }, dispatch: { source: 'probe-host-tools-call', tool: 'codex', promptDigest: digest, promptBytes: 0 }, evidence: { eventCount: 1 }, usage: { status: 'unavailable' } };
  return immutableCanonicalValue({ version: 'visor.proof-candidate-evidence/v1', role: { invocation, invocationDigest: `sha256:${'2'.repeat(64)}` }, probe: { attestation, resultIdentity: { version: 'probe.governed-result-identity/v1', source: 'probe-host-schema-valid-json', resultDigest: digest, canonicalBytes: Buffer.byteLength(canonicalJson(data)) } } });
}

function completedGovernedCheckpoint(): { plan: any; checkpoint: any } {
  const plan = compileClaimPlan(governedC2Config()); const journal = new ExecutionJournal(plan);
  publishCatalog(journal, { components: [{ id: 'A', path: 'packages/a' }] });
  const generation = journal.queryReadyWork().find(value => value.checkId === 'inspect')!;
  const attempt = journal.startGeneratedAttempt(generation.nodeGenerationId); journal.scheduleGeneratedAttempt(attempt);
  const binding = journal.deriveManagedRunBinding(attempt); journal.recordManagedRunAcquired(binding); journal.recordManagedRunStarted(binding);
  const payload = { decision: 'accept', id: 'A' };
  journal.completeManagedGeneratedAttempt({ attempt, binding, payload, executionConfigDigest: journal.getGeneratedExecution(generation.nodeGenerationId).node.executionConfigDigest, proofCandidateEvidence: governedEvidence(payload) });
  return { plan, checkpoint: JSON.parse(JSON.stringify(journal.exportGraphCheckpoint('c2-session'))) };
}

function c4Config(): any {
  const itemSchema = (required: string[]) => ({
    type: 'object',
    additionalProperties: false,
    required,
    properties: {
      id: { type: 'string', minLength: 1 },
      revision: { type: 'integer', minimum: 1 },
      source: { type: 'string', minLength: 1 },
      stage: { type: 'string', minLength: 1 },
    },
  });
  return {
    version: '1.0',
    claim_types: {
      'component.catalog@1': { schema: { type: 'object' } },
      'component.item@1': { schema: itemSchema(['id', 'revision']) },
      'spec.catalog@1': { schema: { type: 'object' } },
      'spec.enumeration-evidence@1': { schema: { type: 'object' } },
      'spec.item@1': { schema: itemSchema(['id', 'revision', 'source']) },
      'spec.authored@1': { schema: itemSchema(['id', 'stage']) },
      'spec.reviewed@1': { schema: itemSchema(['id', 'stage']) },
    },
    subgraphs: {
      component: {
        input: { name: 'component', claim: 'component.item@1' },
        checks: {
          enumerate: {
            type: 'noop',
            consumes: [{ claim: 'component.item@1', as: 'component' }],
            emits: [
              { claim: 'spec.catalog@1', from: 'output' },
              { claim: 'spec.enumeration-evidence@1', from: 'output' },
            ],
            expand: {
              claim: 'spec.catalog@1',
              template: 'spec-review',
              items_pointer: '/specs',
              key_pointer: '/id',
              item_claim: 'spec.item@1',
            },
          },
        },
      },
      'spec-review': {
        input: { name: 'spec', claim: 'spec.item@1' },
        checks: {
          author: {
            type: 'noop',
            consumes: [{ claim: 'spec.item@1', as: 'spec' }],
            emits: [{ claim: 'spec.authored@1', from: 'output' }],
          },
          review: {
            type: 'noop',
            consumes: [{ claim: 'spec.authored@1', as: 'authored' }],
            emits: [{ claim: 'spec.reviewed@1', from: 'output' }],
          },
        },
      },
    },
    checks: {
      discover: {
        type: 'noop',
        emits: [{ claim: 'component.catalog@1', from: 'output' }],
        expand: {
          claim: 'component.catalog@1',
          template: 'component',
          items_pointer: '/components',
          key_pointer: '/id',
          item_claim: 'component.item@1',
        },
      },
    },
  };
}

function c4Journal(): ExecutionJournal {
  return new ExecutionJournal(compileClaimPlan(c4Config()));
}

function completeReadySpecWork(journal: ExecutionJournal): void {
  while (journal.queryReadyWork().some(generation => generation.scope.length === 2)) {
    for (const generation of journal.queryReadyWork().filter(value => value.scope.length === 2)) {
      const attempt = journal.startGeneratedAttempt(generation.nodeGenerationId);
      journal.scheduleGeneratedAttempt(attempt);
      journal.completeGeneratedAttempt({
        attempt,
        payload: {
          id: generation.scope[generation.scope.length - 1].key,
          stage: generation.checkId,
        },
      });
    }
  }
}

function managedNestedBatchFixture(componentKey = 'A'): {
  readonly journal: ExecutionJournal;
  readonly beforeProjection: InstanceProjection;
  readonly batch: readonly InstanceRuntimeEvent[];
  readonly binding: ManagedRunBindingV1;
} {
  const journal = c4Journal();
  publishCatalog(journal, {
    components: [
      { id: 'A', revision: 1 },
      { id: 'B', revision: 1 },
    ],
  });
  const enumerate = journal.queryReadyWork().find(candidate =>
    candidate.checkId === 'enumerate' &&
    candidate.scope[candidate.scope.length - 1].key === componentKey
  )!;
  const attempt = journal.startGeneratedAttempt(enumerate.nodeGenerationId);
  journal.scheduleGeneratedAttempt(attempt);
  const binding = journal.deriveManagedRunBinding(attempt);
  journal.recordManagedRunAcquired(binding);
  journal.recordManagedRunStarted(binding);
  const beforeProjection = journal.getInstanceProjection();
  const beforeEventCount = journal.readRuntimeEvents().length;
  journal.completeManagedGeneratedAttempt({
    attempt,
    binding,
    executionConfigDigest: journal.getGeneratedExecution(attempt.nodeGenerationId).node.executionConfigDigest,
    payload: {
      specs: [{ id: 'spec-1', revision: 1, source: `${componentKey}/one` }],
    },
  });
  return {
    journal,
    beforeProjection,
    batch: journal.readRuntimeEvents().slice(beforeEventCount) as readonly InstanceRuntimeEvent[],
    binding,
  };
}

function renumberBatch(
  projection: InstanceProjection,
  events: readonly InstanceRuntimeEvent[]
): readonly InstanceRuntimeEvent[] {
  return events.map((event, index) => ({
    ...event,
    eventId: projection.lastEventId + index + 1,
  })) as readonly InstanceRuntimeEvent[];
}

function scheduleCatalogAttempt(journal: ExecutionJournal) {
  const request = journal.requestCatalogReconciliation({
    sessionId: 'c2-session',
    ownerCheck: 'discover',
  });
  const attempt = journal.startCatalogRequestAttempt(request.requestId);
  journal.scheduleCatalogRequestAttempt(attempt);
  return attempt;
}

function publishCatalog(journal: ExecutionJournal, payload: unknown) {
  const attempt = scheduleCatalogAttempt(journal);
  return journal.completeAttempt({ ...attempt, payload });
}

function expectErrorCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
  }
}

function expectDeeplyFrozen(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value as object)) return;
  const object = value as Record<string, unknown>;
  seen.add(object);
  expect(Object.isFrozen(object)).toBe(true);
  for (const child of Object.values(object)) expectDeeplyFrozen(child, seen);
}

function helperManagedBinding(): ManagedRunBindingV1 {
  return {
    managedRunId: 'managed-helper-1',
    sessionId: 'helper-session',
    checkId: 'inspect',
    scope: [{
      kind: 'keyed',
      expansionOwnerCheck: 'discover',
      key: 'A',
      subgraphInstanceId: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    }],
    nodeInstanceId: 'helper-node',
    nodeGenerationId: 'helper-generation',
    attemptId: 'helper-attempt',
    fence: 7,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('snapshot-store (journal + context view)', () => {
  it('keeps one ordered versioned runtime lane and rebuilds it from events alone', () => {
    const plan = compileClaimPlan({
      version: '1.0',
      claim_types: {
        'fixture.ready@1': {
          schema: {
            type: 'object',
            required: ['value'],
            properties: { value: { const: 'ready' } },
          },
        },
      },
      checks: {
        producer: { type: 'noop', emits: [{ claim: 'fixture.ready@1', from: 'output' }] },
        consumer: {
          type: 'noop',
          consumes: [{ claim: 'fixture.ready@1', cardinality: 'one' }],
        },
      },
    });
    const journal = new ExecutionJournal(plan);
    const attempt = journal.startAttempt({ sessionId: 'runtime', checkId: 'producer', scope: [] });
    journal.scheduleCheck(attempt);
    const terminal = journal.completeAttempt({ ...attempt, payload: { value: 'ready' } });

    expect(journal.size()).toBe(0);
    expect(terminal.completed.eventId).toBe(4);
    expect(terminal.completed.type).toBe('AttemptCompleted');
    expect(journal.readRuntimeEvents().map(event => event.type)).toEqual([
      'AttemptStarted',
      'CheckScheduled',
      'ClaimPublished',
      'AttemptCompleted',
    ]);
    expect(journal.readCheckClaims('consumer')).toEqual({
      'fixture.ready@1': terminal.claims[0],
    });
    expect(journal.replayClaimProjection()).toEqual(journal.getClaimProjection());
  });

  it('commits are monotonic and readVisible honors snapshot', () => {
    const j = new ExecutionJournal();
    const session = 's1';
    const scope: ScopePath = [];

    const s0 = j.beginSnapshot();
    expect(s0).toBe(0);

    const e1 = j.commitEntry({ sessionId: session, scope, checkId: 'A', result: makeResult(1) });
    const e2 = j.commitEntry({ sessionId: session, scope, checkId: 'A', result: makeResult(2) });
    expect(e2.commitId).toBeGreaterThan(e1.commitId);

    const snap1 = 1; // only first commit visible
    const vis1 = j.readVisible(session, snap1);
    expect(vis1.find(e => e.commitId === e1.commitId)).toBeTruthy();
    expect(vis1.find(e => e.commitId === e2.commitId)).toBeFalsy();
  });

  it('ContextView prefers exact scope, then ancestor, else latest', () => {
    const j = new ExecutionJournal();
    const session = 's2';
    const parent: ScopePath = [];
    const itemScope: ScopePath = [{ check: 'parent', index: 0 }];

    j.commitEntry({ sessionId: session, scope: parent, checkId: 'X', result: makeResult('root') });
    j.commitEntry({
      sessionId: session,
      scope: itemScope,
      checkId: 'X',
      result: makeResult('item0'),
    });
    const snap = j.beginSnapshot();

    // exact item scope
    const cvItem = new ContextView(j, session, snap, itemScope);
    expect((cvItem.get('X') as any).output).toBe('item0');
    expect((cvItem.getRaw('X') as any).output).toBe('root');

    // unrelated scope → latest
    const otherScope: ScopePath = [{ check: 'other', index: 0 }];
    const cvOther = new ContextView(j, session, snap, otherScope);
    expect((cvOther.get('X') as any).output).toBe('item0');

    // history contains both
    const hist = cvOther.getHistory('X');
    expect(hist).toHaveLength(2);
  });

  it.each([
    {
      name: 'duplicate canonical number/string keys',
      payload: {
        components: [
          { id: 1, path: 'packages/number' },
          { id: '1', path: 'packages/string' },
        ],
      },
      code: 'DUPLICATE_CATALOG_KEY',
    },
    {
      name: 'missing items pointer',
      payload: {},
      code: 'JSON_POINTER_NOT_FOUND',
    },
    {
      name: 'non-array items pointer',
      payload: { components: { id: 'A', path: 'packages/a' } },
      code: 'INVALID_CATALOG_ITEMS',
    },
    {
      name: 'invalid item schema',
      payload: { components: [{ id: 'A' }] },
      code: 'CLAIM_SCHEMA_INVALID',
    },
  ])(
    'atomically rejects $name and records only the explicit terminal failure',
    ({ payload, code }) => {
      const journal = c2Journal();
      const attempt = scheduleCatalogAttempt(journal);
      const eventsBeforeCompletion = journal.readRuntimeEvents();
      const claimsBeforeCompletion = journal.getClaimProjection();
      const instancesBeforeCompletion = journal.getInstanceProjection();

      expectErrorCode(() => journal.completeAttempt({ ...attempt, payload }), code);
      expect(journal.readRuntimeEvents()).toEqual(eventsBeforeCompletion);
      expect(journal.getClaimProjection()).toEqual(claimsBeforeCompletion);
      expect(journal.getInstanceProjection()).toEqual(instancesBeforeCompletion);

      const failed = journal.failAttempt({
        ...attempt,
        reason: `rejected hostile catalog: ${code}`,
      });
      expect(journal.readRuntimeEvents()).toEqual([...eventsBeforeCompletion, failed]);
      expect(failed.type).toBe('AttemptFailed');
      expect(journal.replayClaimProjection()).toEqual(journal.getClaimProjection());
      expect(journal.replayInstanceProjection()).toEqual(journal.getInstanceProjection());
      expect(journal.queryReadyWork()).toEqual([]);
    }
  );

  it('emits keyed reconciliation identities in canonical key order, not catalog input order', () => {
    const journal = c2Journal();
    publishCatalog(journal, {
      components: [
        { id: 'B', path: 'packages/b' },
        { id: 'A', path: 'packages/a' },
      ],
    });

    const keyedDiff = (journal.readRuntimeEvents() as readonly any[])
      .filter(event =>
        [
          'SubgraphExpanded',
          'ControllerItemClaimPublished',
          'NodeGenerationActivated',
        ].includes(event.type)
      )
      .map(event => ({ type: event.type, itemKey: event.scope[0].key }));

    expect(keyedDiff).toEqual([
      { type: 'SubgraphExpanded', itemKey: 'A' },
      { type: 'ControllerItemClaimPublished', itemKey: 'A' },
      { type: 'NodeGenerationActivated', itemKey: 'A' },
      { type: 'SubgraphExpanded', itemKey: 'B' },
      { type: 'ControllerItemClaimPublished', itemKey: 'B' },
      { type: 'NodeGenerationActivated', itemKey: 'B' },
    ]);
    expect(
      (journal.readRuntimeEvents() as readonly any[])
        .filter(event => event.type === 'SubgraphExpanded' && event.scope.length === 1)
        .every(event => !Object.prototype.hasOwnProperty.call(event, 'catalogClaimRef'))
    ).toBe(true);
  });

  it('exposes exact deeply immutable controller and generated provenance', () => {
    const journal = c2Journal();
    publishCatalog(journal, {
      components: [{ id: 'A', path: 'packages/a' }],
    });

    const events = journal.readRuntimeEvents() as readonly any[];
    const catalogClaim = events.find(
      event => event.type === 'ClaimPublished' && event.claim === 'component.catalog@1'
    );
    const itemClaim = events.find(event => event.type === 'ControllerItemClaimPublished');
    const inspect = journal.queryReadyWork().find(generation => generation.checkId === 'inspect');
    expect(catalogClaim).toBeDefined();
    expect(itemClaim).toBeDefined();
    expect(inspect).toBeDefined();
    expect(
      Object.prototype.hasOwnProperty.call(
        journal.getInstanceProjection().generationsById[inspect!.nodeGenerationId],
        'nestedExpansionCatalogClaimRef'
      )
    ).toBe(false);

    const controllerExecution = journal.getGeneratedExecution(inspect!.nodeGenerationId);
    expect(controllerExecution.claims).toEqual({
      component: {
        claimId: itemClaim.claimId,
        claim: 'component.item@1',
        payload: { id: 'A', path: 'packages/a' },
        payloadFingerprint: itemClaim.payloadFingerprint,
        producerCheckId: 'discover',
        scope: itemClaim.scope,
        parentClaimIds: [catalogClaim.claimId],
        wireMode: 'generic',
        provenance: 'controller',
        catalogClaimId: catalogClaim.claimId,
        incarnation: 1,
      },
    });
    expectDeeplyFrozen(controllerExecution);

    const inspectAttempt = journal.startGeneratedAttempt(inspect!.nodeGenerationId);
    journal.scheduleGeneratedAttempt(inspectAttempt);
    journal.completeGeneratedAttempt({
      attempt: inspectAttempt,
      payload: { id: 'A', findings: ['bounded'] },
    });

    const generatedClaim = (journal.readRuntimeEvents() as readonly any[]).find(
      event => event.type === 'ClaimPublished' && event.claim === 'component.inspected@1'
    );
    const summarize = journal
      .queryReadyWork()
      .find(generation => generation.checkId === 'summarize');
    expect(generatedClaim).toBeDefined();
    expect(summarize).toBeDefined();

    const generatedExecution = journal.getGeneratedExecution(summarize!.nodeGenerationId);
    expect(generatedExecution.claims).toEqual({
      inspected: {
        claimId: generatedClaim.claimId,
        claim: 'component.inspected@1',
        payload: { id: 'A', findings: ['bounded'] },
        payloadFingerprint: generatedClaim.payloadFingerprint,
        producerCheckId: 'inspect',
        scope: generatedClaim.scope,
        parentClaimIds: [itemClaim.claimId],
        wireMode: 'generic',
        provenance: 'attempt',
        attemptId: inspectAttempt.attemptId,
        fence: inspectAttempt.fence,
      },
    });
    expectDeeplyFrozen(generatedExecution);
  });

  it('waits for every compiled control predecessor after the data claim exists', () => {
    const journal = c2Journal('two-predecessor');
    publishCatalog(journal, {
      components: [{ id: 'A', path: 'packages/a' }],
    });
    const initial = journal.queryReadyWork();
    const first = initial.find(generation => generation.checkId === 'first');
    const second = initial.find(generation => generation.checkId === 'second');
    expect(initial.map(generation => generation.checkId).sort()).toEqual(['first', 'second']);

    const firstAttempt = journal.startGeneratedAttempt(first!.nodeGenerationId);
    journal.scheduleGeneratedAttempt(firstAttempt);
    journal.completeGeneratedAttempt({
      attempt: firstAttempt,
      payload: { id: 'A', findings: ['first complete'] },
    });

    const afterFirst = journal.getInstanceProjection();
    expect(
      Object.values(afterFirst.claimsById).some(claim => claim.claim === 'component.first@1')
    ).toBe(true);
    expect(journal.queryReadyWork().map(generation => generation.checkId)).toEqual(['second']);

    const secondAttempt = journal.startGeneratedAttempt(second!.nodeGenerationId);
    journal.scheduleGeneratedAttempt(secondAttempt);
    journal.completeGeneratedAttempt({
      attempt: secondAttempt,
      payload: { id: 'A', findings: ['second complete'] },
    });

    expect(journal.queryReadyWork().map(generation => generation.checkId)).toEqual(['join']);
    const join = journal.queryReadyWork()[0];
    const joinExecution = journal.getGeneratedExecution(join.nodeGenerationId);
    expect(joinExecution.node.dependencyNodeKeys).toEqual(['first', 'second']);
    expect(joinExecution.claims.firstResult.claim).toBe('component.first@1');
  });

  it('atomically publishes a managed nested catalog and exposes exact child provenance', () => {
    const journal = c4Journal();
    publishCatalog(journal, { components: [{ id: 'A', revision: 1 }] });
    const enumerate = journal.queryReadyWork().find(candidate => candidate.checkId === 'enumerate')!;
    expect(
      journal.getInstanceProjection().generationsById[enumerate.nodeGenerationId]
        .nestedExpansionCatalogClaimRef
    ).toBe('spec.catalog@1');
    const attempt = journal.startGeneratedAttempt(enumerate.nodeGenerationId);
    journal.scheduleGeneratedAttempt(attempt);
    const binding = journal.deriveManagedRunBinding(attempt);
    journal.recordManagedRunAcquired(binding);
    journal.recordManagedRunStarted(binding);
    const before = journal.readRuntimeEvents();

    journal.completeManagedGeneratedAttempt({
      attempt,
      binding,
      executionConfigDigest: journal.getGeneratedExecution(attempt.nodeGenerationId).node.executionConfigDigest,
      payload: {
        specs: [
          { id: 'spec-2', revision: 1, source: 'A/two' },
          { id: 'spec-1', revision: 1, source: 'A/one' },
        ],
      },
    });

    const committed = journal.readRuntimeEvents().slice(before.length) as readonly any[];
    const projection = journal.getInstanceProjection();
    const parent = projection.instancesById[enumerate.subgraphInstanceId];
    const children = Object.values(projection.instancesById)
      .filter(instance => instance.parentSubgraphInstanceId === parent.subgraphInstanceId)
      .sort((left, right) => left.itemKey.localeCompare(right.itemKey));
    expect(committed[0].type).toBe('ManagedRunTerminated');
    expect(committed.at(-1)?.type).toBe('AttemptCompleted');
    expect(children.map(child => child.itemKey)).toEqual(['spec-1', 'spec-2']);
    expect(children.every(child => child.scope.length === 2)).toBe(true);
    expect(children.every(child => child.scope[0].subgraphInstanceId === parent.subgraphInstanceId)).toBe(true);
    expect(children.every(child => child.expansionOwnerNodeInstanceId === enumerate.nodeInstanceId)).toBe(true);
    expect(children.every(child => child.catalogClaimRef === 'spec.catalog@1')).toBe(true);
    expect(children.every(child => child.catalogProducerNodeGenerationId === enumerate.nodeGenerationId)).toBe(true);

    const catalogIndex = committed.findIndex(
      event => event.type === 'ClaimPublished' && event.claim === 'spec.catalog@1'
    );
    const evidenceIndex = committed.findIndex(
      event =>
        event.type === 'ClaimPublished' &&
        event.claim === 'spec.enumeration-evidence@1'
    );
    const firstChildIndex = committed.findIndex(event => event.type === 'SubgraphExpanded');
    expect(catalogIndex).toBeGreaterThanOrEqual(0);
    expect(evidenceIndex).toBeGreaterThanOrEqual(0);
    expect(firstChildIndex).toBeGreaterThan(catalogIndex);
    expect(firstChildIndex).toBeGreaterThan(evidenceIndex);
    for (const generation of journal.queryReadyWork().filter(value => value.scope.length === 2)) {
      const execution = journal.getGeneratedExecution(generation.nodeGenerationId);
      expect(Object.keys(execution.claims)).toEqual(['spec']);
      expect(execution.claims.spec).toMatchObject({
        claim: 'spec.item@1',
        provenance: 'controller',
        scope: generation.scope,
      });
      expect(execution.claims.spec.parentClaimIds).toEqual([
        projection.instancesById[generation.subgraphInstanceId].catalogClaimId,
      ]);
    }
    expect(projection.managedRunsByAttemptId[attempt.attemptId]).toMatchObject({
      status: 'terminated',
      cleanupStatus: 'clean',
      controllerDecision: 'completed',
    });
    expect(journal.replayInstanceProjection()).toEqual(projection);
  });

  it('rejects a duplicate nested key without partially publishing its catalog or children', () => {
    const journal = c4Journal();
    publishCatalog(journal, { components: [{ id: 'A', revision: 1 }] });
    const enumerate = journal.queryReadyWork().find(candidate => candidate.checkId === 'enumerate')!;
    const attempt = journal.startGeneratedAttempt(enumerate.nodeGenerationId);
    journal.scheduleGeneratedAttempt(attempt);
    const eventsBefore = journal.readRuntimeEvents();
    const projectionBefore = journal.getInstanceProjection();

    expectErrorCode(
      () => journal.completeGeneratedAttempt({
        attempt,
        payload: {
          specs: [
            { id: 'duplicate', revision: 1, source: 'A/one' },
            { id: 'duplicate', revision: 1, source: 'A/two' },
          ],
        },
      }),
      'DUPLICATE_CATALOG_KEY'
    );
    expect(journal.readRuntimeEvents()).toEqual(eventsBefore);
    expect(journal.getInstanceProjection()).toEqual(projectionBefore);

    journal.failGeneratedAttempt(attempt, 'invalid nested catalog');
    expect(journal.replayInstanceProjection()).toEqual(journal.getInstanceProjection());
  });

  it('rejects a malformed nested item without publishing any generated output or child event', () => {
    const journal = c4Journal();
    publishCatalog(journal, { components: [{ id: 'A', revision: 1 }] });
    const enumerate = journal.queryReadyWork().find(candidate => candidate.checkId === 'enumerate')!;
    const attempt = journal.startGeneratedAttempt(enumerate.nodeGenerationId);
    journal.scheduleGeneratedAttempt(attempt);
    const eventsBefore = journal.readRuntimeEvents();
    const projectionBefore = journal.getInstanceProjection();

    expectErrorCode(
      () => journal.completeGeneratedAttempt({
        attempt,
        payload: { specs: [{ id: 'missing-source', revision: 1 }] },
      }),
      'CLAIM_SCHEMA_INVALID'
    );
    expect(journal.readRuntimeEvents()).toEqual(eventsBefore);
    expect(journal.getInstanceProjection()).toEqual(projectionBefore);
    journal.failGeneratedAttempt(attempt, 'malformed nested item');
    expect(journal.replayInstanceProjection()).toEqual(journal.getInstanceProjection());
  });

  it('tombstones descendants first and revives stable child identities with fresh claims on replacement', () => {
    const journal = c4Journal();
    publishCatalog(journal, { components: [{ id: 'A', revision: 1 }] });
    const firstEnumerate = journal.queryReadyWork().find(candidate => candidate.checkId === 'enumerate')!;
    const firstAttempt = journal.startGeneratedAttempt(firstEnumerate.nodeGenerationId);
    journal.scheduleGeneratedAttempt(firstAttempt);
    journal.completeGeneratedAttempt({
      attempt: firstAttempt,
      payload: {
        specs: [
          { id: 'spec-1', revision: 1, source: 'A/one' },
          { id: 'spec-2', revision: 1, source: 'A/two' },
        ],
      },
    });
    completeReadySpecWork(journal);

    const firstProjection = journal.getInstanceProjection();
    const firstChildren = Object.values(firstProjection.instancesById)
      .filter(instance => instance.parentSubgraphInstanceId === firstEnumerate.subgraphInstanceId)
      .sort((left, right) => left.itemKey.localeCompare(right.itemKey));
    const firstByKey = Object.fromEntries(firstChildren.map(child => [child.itemKey, {
      subgraphInstanceId: child.subgraphInstanceId,
      activeItemClaimId: child.activeItemClaimId,
      incarnation: child.incarnation,
      nodeInstanceIdsByTemplateNode: child.nodeInstanceIdsByTemplateNode,
      sourceGenerationId:
        firstProjection.activeGenerationIdByNode[child.nodeInstanceIdsByTemplateNode.author],
    }]));
    const beforeReplacement = journal.readRuntimeEvents().length;

    publishCatalog(journal, { components: [{ id: 'A', revision: 2 }] });
    const replacementEvents = journal.readRuntimeEvents().slice(beforeReplacement) as readonly any[];
    const childTombstoneIndexes = replacementEvents
      .map((event, index) => ({ event, index }))
      .filter(({ event }) =>
        event.type === 'SubgraphTombstoned' &&
        firstChildren.some(child => child.subgraphInstanceId === event.subgraphInstanceId)
      )
      .map(({ index }) => index);
    const parentInactivationIndex = replacementEvents.findIndex(
      event =>
        event.type === 'NodeGenerationInactivated' &&
        event.nodeGenerationId === firstEnumerate.nodeGenerationId
    );
    expect(childTombstoneIndexes).toHaveLength(2);
    expect(parentInactivationIndex).toBeGreaterThan(Math.max(...childTombstoneIndexes));
    expect(firstChildren.every(child =>
      journal.getInstanceProjection().instancesById[child.subgraphInstanceId].status === 'tombstoned'
    )).toBe(true);

    const secondEnumerate = journal.queryReadyWork().find(candidate => candidate.checkId === 'enumerate')!;
    const secondAttempt = journal.startGeneratedAttempt(secondEnumerate.nodeGenerationId);
    journal.scheduleGeneratedAttempt(secondAttempt);
    journal.completeGeneratedAttempt({
      attempt: secondAttempt,
      payload: {
        specs: [
          { id: 'spec-2', revision: 1, source: 'A/two' },
          { id: 'spec-1', revision: 1, source: 'A/one' },
        ],
      },
    });

    const revivedProjection = journal.getInstanceProjection();
    const revivedChildren = Object.values(revivedProjection.instancesById)
      .filter(instance => instance.parentSubgraphInstanceId === secondEnumerate.subgraphInstanceId)
      .sort((left, right) => left.itemKey.localeCompare(right.itemKey));
    expect(revivedChildren).toHaveLength(2);
    for (const child of revivedChildren) {
      const first = firstByKey[child.itemKey];
      expect(child.status).toBe('active');
      expect(child.subgraphInstanceId).toBe(first.subgraphInstanceId);
      expect(child.nodeInstanceIdsByTemplateNode).toEqual(first.nodeInstanceIdsByTemplateNode);
      expect(child.incarnation).toBe(first.incarnation + 1);
      expect(child.activeItemClaimId).not.toBe(first.activeItemClaimId);
      expect(revivedProjection.claimsById[first.activeItemClaimId!].active).toBe(false);
      expect(
        revivedProjection.activeGenerationIdByNode[child.nodeInstanceIdsByTemplateNode.author]
      ).not.toBe(first.sourceGenerationId);
    }
    expect(secondEnumerate.nodeInstanceId).toBe(firstEnumerate.nodeInstanceId);
    expect(secondEnumerate.nodeGenerationId).not.toBe(firstEnumerate.nodeGenerationId);
    completeReadySpecWork(journal);
    expect(journal.replayInstanceProjection()).toEqual(journal.getInstanceProjection());
  });

  it('applies explicit keyed child removal and addition without reusing the removed identity', () => {
    const journal = c4Journal();
    publishCatalog(journal, { components: [{ id: 'A', revision: 1 }] });
    const firstEnumerate = journal.queryReadyWork().find(candidate => candidate.checkId === 'enumerate')!;
    const firstAttempt = journal.startGeneratedAttempt(firstEnumerate.nodeGenerationId);
    journal.scheduleGeneratedAttempt(firstAttempt);
    journal.completeGeneratedAttempt({
      attempt: firstAttempt,
      payload: {
        specs: [
          { id: 'keep', revision: 1, source: 'A/keep' },
          { id: 'remove', revision: 1, source: 'A/remove' },
        ],
      },
    });
    completeReadySpecWork(journal);
    const firstProjection = journal.getInstanceProjection();
    const retainedBefore = Object.values(firstProjection.instancesById).find(
      instance => instance.parentSubgraphInstanceId === firstEnumerate.subgraphInstanceId &&
        instance.itemKey === 'keep'
    )!;
    const removedBefore = Object.values(firstProjection.instancesById).find(
      instance => instance.parentSubgraphInstanceId === firstEnumerate.subgraphInstanceId &&
        instance.itemKey === 'remove'
    )!;

    publishCatalog(journal, { components: [{ id: 'A', revision: 2 }] });
    const secondEnumerate = journal.queryReadyWork().find(candidate => candidate.checkId === 'enumerate')!;
    const secondAttempt = journal.startGeneratedAttempt(secondEnumerate.nodeGenerationId);
    journal.scheduleGeneratedAttempt(secondAttempt);
    journal.completeGeneratedAttempt({
      attempt: secondAttempt,
      payload: {
        specs: [
          { id: 'add', revision: 1, source: 'A/add' },
          { id: 'keep', revision: 1, source: 'A/keep' },
        ],
      },
    });

    const projection = journal.getInstanceProjection();
    const retainedAfter = projection.instancesById[retainedBefore.subgraphInstanceId];
    const removedAfter = projection.instancesById[removedBefore.subgraphInstanceId];
    const added = Object.values(projection.instancesById).find(
      instance => instance.parentSubgraphInstanceId === secondEnumerate.subgraphInstanceId &&
        instance.itemKey === 'add'
    )!;
    expect(retainedAfter.status).toBe('active');
    expect(retainedAfter.subgraphInstanceId).toBe(retainedBefore.subgraphInstanceId);
    expect(retainedAfter.activeItemClaimId).not.toBe(retainedBefore.activeItemClaimId);
    expect(removedAfter.status).toBe('tombstoned');
    expect(added.status).toBe('active');
    expect(added.subgraphInstanceId).not.toBe(removedBefore.subgraphInstanceId);
    expect(journal.replayInstanceProjection()).toEqual(projection);
  });

  it.each([
    ['swapped parent scope', 'INVALID_MANAGED_BATCH'],
    ['foreign owner node', 'INVALID_MANAGED_BATCH'],
    ['foreign catalog lineage', 'INVALID_MANAGED_BATCH'],
    ['stale nested fence', 'STALE_FENCE'],
    ['cross-parent child event', 'INVALID_MANAGED_BATCH'],
    ['post-reconciliation claim', 'INVALID_MANAGED_BATCH'],
  ])('atomically rejects %s in a managed nested terminal batch', (scenario, code) => {
    const fixture = managedNestedBatchFixture('A');
    const batch = fixture.batch as readonly any[];
    const childIndex = batch.findIndex(event => event.type === 'SubgraphExpanded');
    const catalogIndex = batch.findIndex(
      event => event.type === 'ClaimPublished' && event.claim === 'spec.catalog@1'
    );
    const evidenceIndex = batch.findIndex(
      event =>
        event.type === 'ClaimPublished' &&
        event.claim === 'spec.enumeration-evidence@1'
    );
    const parentB = Object.values(fixture.beforeProjection.instancesById).find(
      instance => instance.itemKey === 'B' && !instance.parentSubgraphInstanceId
    )!;
    let forged: readonly InstanceRuntimeEvent[];

    if (scenario === 'swapped parent scope') {
      forged = batch.map((event, index) => index === childIndex
        ? { ...event, scope: [parentB.scope[0], event.scope[1]] }
        : event
      ) as readonly InstanceRuntimeEvent[];
    } else if (scenario === 'foreign owner node') {
      forged = batch.map((event, index) => index === childIndex
        ? {
            ...event,
            expansionOwnerNodeInstanceId: parentB.nodeInstanceIdsByTemplateNode.enumerate,
          }
        : event
      ) as readonly InstanceRuntimeEvent[];
    } else if (scenario === 'foreign catalog lineage') {
      const evidenceClaimId = batch[evidenceIndex].claimId;
      const controller = batch.find(
        event => event.type === 'ControllerItemClaimPublished'
      );
      const activation = batch.find(
        event => event.type === 'NodeGenerationActivated' && event.scope.length === 2
      );
      const controllerClaimId = deriveControllerItemClaimId({
        claim: controller.claim,
        payloadFingerprint: controller.payloadFingerprint,
        expansionSpecDigest: controller.expansionSpecDigest,
        catalogClaimId: evidenceClaimId,
        subgraphInstanceId: controller.subgraphInstanceId,
        incarnation: controller.incarnation,
        scope: controller.scope,
      });
      const nodeGenerationId = deriveNodeGenerationId({
        nodeInstanceId: activation.nodeInstanceId,
        incarnation: activation.incarnation,
        itemFingerprint: activation.itemFingerprint,
        executionConfigDigest: activation.executionConfigDigest,
        activeInputClaimIds: [controllerClaimId],
      });
      forged = batch.map(event => {
        if (event.type === 'SubgraphExpanded') {
          return {
            ...event,
            catalogClaimRef: 'spec.enumeration-evidence@1',
            catalogClaimId: evidenceClaimId,
          };
        }
        if (event.type === 'ControllerItemClaimPublished') {
          return {
            ...event,
            catalogClaimId: evidenceClaimId,
            parentClaimIds: [evidenceClaimId],
            claimId: controllerClaimId,
          };
        }
        if (event.type === 'NodeGenerationActivated' && event.scope.length === 2) {
          return {
            ...event,
            activeInputClaimIds: [controllerClaimId],
            nodeGenerationId,
          };
        }
        return event;
      }) as readonly InstanceRuntimeEvent[];
    } else if (scenario === 'stale nested fence') {
      forged = batch.map((event, index) => index === catalogIndex
        ? { ...event, fence: event.fence + 1 }
        : event
      ) as readonly InstanceRuntimeEvent[];
    } else if (scenario === 'cross-parent child event') {
      const foreign = managedNestedBatchFixture('B').batch.find(
        event => event.type === 'SubgraphExpanded'
      )!;
      forged = batch.map((event, index) => index === childIndex
        ? { ...foreign, eventId: event.eventId }
        : event
      ) as readonly InstanceRuntimeEvent[];
    } else {
      const reordered = batch.filter((_, index) => index !== evidenceIndex);
      const reconciliationIndex = reordered.findIndex(
        event => event.type === 'SubgraphExpanded'
      );
      reordered.splice(reconciliationIndex + 1, 0, batch[evidenceIndex]);
      forged = renumberBatch(fixture.beforeProjection, reordered);
    }

    const projectionBefore = JSON.stringify(fixture.beforeProjection);
    expectErrorCode(
      () => reduceInstanceEventBatch(fixture.beforeProjection, forged),
      code
    );
    expect(JSON.stringify(fixture.beforeProjection)).toBe(projectionBefore);
    expect(fixture.journal.replayInstanceProjection()).toEqual(
      fixture.journal.getInstanceProjection()
    );
  });

  it('isolates one failed child while its sibling completes the review subgraph', () => {
    const journal = c4Journal();
    publishCatalog(journal, { components: [{ id: 'A', revision: 1 }] });
    const enumerate = journal.queryReadyWork().find(candidate => candidate.checkId === 'enumerate')!;
    const enumerateAttempt = journal.startGeneratedAttempt(enumerate.nodeGenerationId);
    journal.scheduleGeneratedAttempt(enumerateAttempt);
    journal.completeGeneratedAttempt({
      attempt: enumerateAttempt,
      payload: {
        specs: [
          { id: 'spec-1', revision: 1, source: 'A/one' },
          { id: 'spec-2', revision: 1, source: 'A/two' },
        ],
      },
    });

    const authors = journal.queryReadyWork().filter(candidate => candidate.checkId === 'author');
    const failed = authors.find(candidate => candidate.scope[candidate.scope.length - 1].key === 'spec-1')!;
    const sibling = authors.find(candidate => candidate.scope[candidate.scope.length - 1].key === 'spec-2')!;
    const failedAttempt = journal.startGeneratedAttempt(failed.nodeGenerationId);
    journal.scheduleGeneratedAttempt(failedAttempt);
    const siblingAttempt = journal.startGeneratedAttempt(sibling.nodeGenerationId);
    journal.scheduleGeneratedAttempt(siblingAttempt);
    journal.failGeneratedAttempt(failedAttempt, 'isolated author failure');
    journal.completeGeneratedAttempt({
      attempt: siblingAttempt,
      payload: { id: 'spec-2', stage: 'author' },
    });
    const review = journal.queryReadyWork().find(candidate =>
      candidate.checkId === 'review' &&
      candidate.subgraphInstanceId === sibling.subgraphInstanceId
    )!;
    const reviewAttempt = journal.startGeneratedAttempt(review.nodeGenerationId);
    journal.scheduleGeneratedAttempt(reviewAttempt);
    journal.completeGeneratedAttempt({
      attempt: reviewAttempt,
      payload: { id: 'spec-2', stage: 'review' },
    });

    const projection = journal.getInstanceProjection();
    expect(projection.generationsById[failed.nodeGenerationId].status).toBe('failed');
    expect(projection.generationsById[review.nodeGenerationId].status).toBe('completed');
    expect(Object.values(projection.claimsById).some(claim =>
      claim.active &&
      claim.claim === 'spec.reviewed@1' &&
      claim.subgraphInstanceId === sibling.subgraphInstanceId
    )).toBe(true);
    expect(Object.values(projection.claimsById).some(claim =>
      claim.active &&
      claim.claim === 'spec.reviewed@1' &&
      claim.subgraphInstanceId === failed.subgraphInstanceId
    )).toBe(false);
    expect(journal.replayInstanceProjection()).toEqual(projection);
  });

  it('atomically records a controller-derived managed acquisition failure', () => {
    const journal = c2Journal();
    publishCatalog(journal, { components: [{ id: 'A', path: 'packages/a' }] });
    const generation = journal.queryReadyWork().find(candidate => candidate.checkId === 'inspect')!;
    const attempt = journal.startGeneratedAttempt(generation.nodeGenerationId);
    journal.scheduleGeneratedAttempt(attempt);
    const binding = journal.deriveManagedRunBinding(attempt);
    const before = journal.readRuntimeEvents();

    journal.failManagedRunAcquisition({
      attempt,
      binding,
      failureCode: 'MANAGED_HANDLE_INVALID',
    });

    expect(journal.readRuntimeEvents().slice(before.length).map(event => event.type)).toEqual([
      'ManagedRunAcquisitionFailed',
      'AttemptFailed',
    ]);
    expect(journal.getInstanceProjection().managedRunsByAttemptId[attempt.attemptId]).toEqual({
      binding,
      status: 'acquisition_failed',
      controllerDecision: 'failed',
      failureCode: 'MANAGED_HANDLE_INVALID',
    });
    expect(journal.replayInstanceProjection()).toEqual(journal.getInstanceProjection());
    expect(() => journal.exportGraphCheckpoint('c2-session')).not.toThrow();
    expectErrorCode(
      () => journal.failGeneratedAttempt(attempt, 'PROVIDER_EXECUTION_FAILED'),
      'STALE_FENCE'
    );
  });

  it('derives all managed authority from projection and rejects altered attempt fields', () => {
    const journal = c2Journal();
    publishCatalog(journal, { components: [{ id: 'A', path: 'packages/a' }] });
    const generation = journal.queryReadyWork().find(candidate => candidate.checkId === 'inspect')!;
    const attempt = journal.startGeneratedAttempt(generation.nodeGenerationId);
    journal.scheduleGeneratedAttempt(attempt);
    const binding = journal.deriveManagedRunBinding(attempt);
    const projection = journal.getInstanceProjection();
    const projectedGeneration = projection.generationsById[generation.nodeGenerationId];
    const instance = projection.instancesById[generation.subgraphInstanceId];

    expect(binding).toMatchObject({
      sessionId: instance.sessionId,
      checkId: projectedGeneration.checkId,
      scope: projectedGeneration.scope,
      nodeInstanceId: projectedGeneration.nodeInstanceId,
      nodeGenerationId: projectedGeneration.nodeGenerationId,
      attemptId: projectedGeneration.attemptId,
      fence: projectedGeneration.fence,
    });

    const mutations: Array<Partial<GeneratedAttemptStartedEvent>> = [
      { sessionId: 'wrong-session' },
      { checkId: 'wrong-check' },
      { scope: [] },
      { nodeInstanceId: 'wrong-instance' },
      { nodeGenerationId: 'wrong-generation' },
      { attemptId: 'wrong-attempt' },
      { fence: attempt.fence + 1 },
    ];
    for (const mutation of mutations) {
      expect(() => journal.deriveManagedRunBinding({ ...attempt, ...mutation })).toThrow();
    }
  });

  it('detaches and deeply freezes managed outcome evidence before cleanup awaits', () => {
    const journal = c2Journal();
    publishCatalog(journal, { components: [{ id: 'A', path: 'packages/a' }] });
    const generation = journal.queryReadyWork().find(candidate => candidate.checkId === 'inspect')!;
    const attempt = journal.startGeneratedAttempt(generation.nodeGenerationId);
    journal.scheduleGeneratedAttempt(attempt);
    const binding = journal.deriveManagedRunBinding(attempt);
    const summary = {
      issues: [] as Array<{ message: string }>,
      output: { nested: { value: 'before' } },
    };

    const normalized = normalizeManagedRunOutcome(
      { version: 1, kind: 'succeeded', binding, summary },
      binding
    );
    summary.output.nested.value = 'after';
    summary.issues.push({ message: 'late mutation' });

    expect(normalized.kind).toBe('succeeded');
    if (normalized.kind !== 'succeeded') throw new Error('expected managed success');
    expect(normalized.summary).toEqual({
      issues: [],
      output: { nested: { value: 'before' } },
    });
    expect(Object.isFrozen(normalized.summary)).toBe(true);
    expect(Object.isFrozen(normalized.summary.output as object)).toBe(true);
    expect(
      Object.isFrozen((normalized.summary.output as { nested: object }).nested)
    ).toBe(true);
  });

  it('keeps generic managed output canonical while trusted reserved Proof output keeps signed zero', () => {
    const journal = c2Journal();
    publishCatalog(journal, { components: [{ id: 'A', path: 'packages/a' }] });
    const generation = journal.queryReadyWork().find(candidate => candidate.checkId === 'inspect')!;
    const attempt = journal.startGeneratedAttempt(generation.nodeGenerationId);
    journal.scheduleGeneratedAttempt(attempt);
    const binding = journal.deriveManagedRunBinding(attempt);
    const generic = normalizeManagedRunOutcome(
      { version: 1, kind: 'succeeded', binding, summary: { issues: [], output: { value: -0 } } },
      binding
    );
    const trusted = normalizeManagedRunOutcome(
      { version: 1, kind: 'succeeded', binding, summary: { issues: [], output: { value: -0 } } },
      binding,
      'proof'
    );

    expect(Object.is((generic.summary.output as { value: number }).value, -0)).toBe(false);
    expect(Object.is((trusted.summary.output as { value: number }).value, -0)).toBe(true);
  });

  it('does not let a non-reserved provider receive Proof wire mode', () => {
    const config = c2Config();
    const plan = compileClaimPlan(config);
    const journal = new ExecutionJournal(plan);
    publishCatalog(journal, { components: [{ id: 'A', path: 'packages/a' }] });
    const generation = journal.queryReadyWork().find(value => value.checkId === 'inspect')!;
    const attempt = journal.startGeneratedAttempt(generation.nodeGenerationId);
    journal.scheduleGeneratedAttempt(attempt);
    const binding = journal.deriveManagedRunBinding(attempt);
    expectErrorCode(() => journal.completeManagedGeneratedAttempt({
      attempt,
      binding,
      payload: { id: 'A', findings: [] },
      executionConfigDigest: generation.executionConfigDigest,
      wireMode: 'proof',
    }), 'INVALID_PROOF_EVIDENCE');
  });

  it('keeps clean cleanup separate from a controller failure and replays it exactly', () => {
    const journal = c2Journal();
    publishCatalog(journal, { components: [{ id: 'A', path: 'packages/a' }] });
    const generation = journal.queryReadyWork().find(candidate => candidate.checkId === 'inspect')!;
    const attempt = journal.startGeneratedAttempt(generation.nodeGenerationId);
    journal.scheduleGeneratedAttempt(attempt);
    const binding = journal.deriveManagedRunBinding(attempt);

    journal.recordManagedRunAcquired(binding);
    journal.recordManagedRunStarted(binding);
    journal.recordManagedRunCancelRequested(binding);
    journal.failManagedGeneratedAttempt({
      attempt,
      binding,
      cleanupStatus: 'clean',
      failureCode: 'MANAGED_DEADLINE_EXCEEDED',
    });

    const managed = journal.getInstanceProjection().managedRunsByAttemptId[attempt.attemptId];
    expect(managed).toEqual({
      binding,
      status: 'terminated',
      cleanupStatus: 'clean',
      controllerDecision: 'failed',
      failureCode: 'MANAGED_DEADLINE_EXCEEDED',
      cancellationRequested: true,
    });
    expect(
      journal.readRuntimeEvents().slice(-5).map(event => event.type)
    ).toEqual([
      'ManagedRunAcquired',
      'ManagedRunStarted',
      'ManagedRunCancelRequested',
      'ManagedRunTerminated',
      'AttemptFailed',
    ]);
    expect(journal.replayInstanceProjection()).toEqual(journal.getInstanceProjection());
    expect(JSON.stringify(journal.readRuntimeEvents())).not.toContain('activeResources');
    expect(() => journal.exportGraphCheckpoint('c2-session')).not.toThrow();
  });

  it('rejects an unverified managed cleanup at the checkpoint boundary', () => {
    const journal = c2Journal();
    publishCatalog(journal, { components: [{ id: 'A', path: 'packages/a' }] });
    const generation = journal.queryReadyWork().find(candidate => candidate.checkId === 'inspect')!;
    const attempt = journal.startGeneratedAttempt(generation.nodeGenerationId);
    journal.scheduleGeneratedAttempt(attempt);
    const binding = journal.deriveManagedRunBinding(attempt);
    journal.recordManagedRunAcquired(binding);
    journal.recordManagedRunStarted(binding);
    journal.failManagedGeneratedAttempt({
      attempt,
      binding,
      cleanupStatus: 'unverified',
      failureCode: 'MANAGED_CLOSE_FAILED',
    });
    expectErrorCode(
      () => journal.exportGraphCheckpoint('c2-session'),
      'CHECKPOINT_NOT_QUIESCENT'
    );
  });

  it('publishes a managed completion only with its clean terminal in one batch', () => {
    const journal = c2Journal();
    publishCatalog(journal, { components: [{ id: 'A', path: 'packages/a' }] });
    const generation = journal.queryReadyWork().find(candidate => candidate.checkId === 'inspect')!;
    const attempt = journal.startGeneratedAttempt(generation.nodeGenerationId);
    journal.scheduleGeneratedAttempt(attempt);
    const binding = journal.deriveManagedRunBinding(attempt);
    journal.recordManagedRunAcquired(binding);
    journal.recordManagedRunStarted(binding);
    const before = journal.readRuntimeEvents();

    expectErrorCode(
      () =>
        journal.completeManagedGeneratedAttempt({
          attempt,
          binding,
          executionConfigDigest: journal.getGeneratedExecution(attempt.nodeGenerationId).node.executionConfigDigest,
          payload: { id: 'A', findings: 'not-an-array' },
        }),
      'CLAIM_SCHEMA_INVALID'
    );
    expect(journal.readRuntimeEvents()).toEqual(before);

    journal.completeManagedGeneratedAttempt({
      attempt,
      binding,
      executionConfigDigest: journal.getGeneratedExecution(attempt.nodeGenerationId).node.executionConfigDigest,
      payload: { id: 'A', findings: ['bounded'] },
    });
    const committed = journal.readRuntimeEvents().slice(before.length);
    expect(committed[0].type).toBe('ManagedRunTerminated');
    expect(committed.at(-1)?.type).toBe('AttemptCompleted');
    expect(committed.some(event => event.type === 'ClaimPublished')).toBe(true);
    expect(journal.getInstanceProjection().managedRunsByAttemptId[attempt.attemptId]).toEqual({
      binding,
      status: 'terminated',
      cleanupStatus: 'clean',
      controllerDecision: 'completed',
    });
    expect(journal.replayInstanceProjection()).toEqual(journal.getInstanceProjection());
    expect(Object.values(journal.getInstanceProjection().claimsById).every(claim => !('proofAdmission' in claim))).toBe(true);
  });

  it('round-trips a governed candidate sidecar through admission and quiescent restore', () => {
    const plan = compileClaimPlan(governedC2Config());
    const journal = new ExecutionJournal(plan);
    publishCatalog(journal, { components: [{ id: 'A', path: 'packages/a' }] });
    const inspect = journal.queryReadyWork().find(generation => generation.checkId === 'inspect')!;
    const attempt = journal.startGeneratedAttempt(inspect.nodeGenerationId);
    journal.scheduleGeneratedAttempt(attempt);
    const binding = journal.deriveManagedRunBinding(attempt);
    journal.recordManagedRunAcquired(binding);
    journal.recordManagedRunStarted(binding);
    const payload = { decision: 'accept', id: 'A' };
    journal.completeManagedGeneratedAttempt({ attempt, binding, payload, executionConfigDigest: journal.getGeneratedExecution(inspect.nodeGenerationId).node.executionConfigDigest, proofCandidateEvidence: governedEvidence(payload) });
    const candidate = Object.values(journal.getInstanceProjection().claimsById).find(claim => claim.claim === 'proof.candidate@1')!;
    const admission = journal.queryReadyWork().find(generation => generation.checkId === 'proof_admit')!;
    const admissionAttempt = journal.startGeneratedAttempt(admission.nodeGenerationId);
    journal.scheduleGeneratedAttempt(admissionAttempt);
    journal.completeGeneratedAttempt({ attempt: admissionAttempt, payload: { candidateClaimId: candidate.claimId } });
    const verify = journal.queryReadyWork().find(generation => generation.checkId === 'verify')!;
    const verifyAttempt = journal.startGeneratedAttempt(verify.nodeGenerationId);
    journal.scheduleGeneratedAttempt(verifyAttempt);
    journal.completeGeneratedAttempt({ attempt: verifyAttempt, payload: {} });
    const checkpoint = journal.exportGraphCheckpoint('c2-session');
    const restored = ExecutionJournal.restoreGraphCheckpoint(plan, checkpoint);
    expect(restored.getInstanceProjection()).toEqual(journal.getInstanceProjection());
    expect(restored.replayInstanceProjection()).toEqual(restored.getInstanceProjection());
    expect(restored.getGeneratedExecution(verify.nodeGenerationId).claims.candidate.proofAdmission).toEqual(governedEvidence(payload));
  });

  it('rejects governed completion without digest, managed terminal, or bound invocation', () => {
    const plan = compileClaimPlan(governedC2Config()); const journal = new ExecutionJournal(plan);
    publishCatalog(journal, { components: [{ id: 'A', path: 'packages/a' }] });
    const generation = journal.queryReadyWork().find(value => value.checkId === 'inspect')!;
    const attempt = journal.startGeneratedAttempt(generation.nodeGenerationId); journal.scheduleGeneratedAttempt(attempt);
    const binding = journal.deriveManagedRunBinding(attempt); const payload = { decision: 'accept', id: 'A' };
    expectErrorCode(() => journal.completeManagedGeneratedAttempt({ attempt, binding, executionConfigDigest: 'f'.repeat(64), payload, proofCandidateEvidence: governedEvidence(payload) }), 'STALE_EXECUTION_CONFIG');
    expectErrorCode(() => journal.completeGeneratedAttempt({ attempt, payload, proofCandidateEvidence: governedEvidence(payload) }), 'MANAGED_TERMINAL_REQUIRED');
    const detached = JSON.parse(JSON.stringify(governedEvidence(payload))); detached.role.invocationDigest = `sha256:${'f'.repeat(64)}`;
    journal.recordManagedRunAcquired(binding); journal.recordManagedRunStarted(binding);
    expectErrorCode(() => journal.completeManagedGeneratedAttempt({ attempt, binding, executionConfigDigest: journal.getGeneratedExecution(generation.nodeGenerationId).node.executionConfigDigest, payload, proofCandidateEvidence: detached }), 'INVALID_PROOF_EVIDENCE');
  });
});

describe('Graph-v2 journal checkpoints', () => {
  type JsonCheckpoint = any;

  function rehash(checkpoint: JsonCheckpoint): JsonCheckpoint {
    checkpoint.integrity.digest = sha256Canonical({
      kind: checkpoint.kind,
      version: checkpoint.version,
      sessionId: checkpoint.sessionId,
      graphSemanticDigest: checkpoint.graphSemanticDigest,
      frontier: checkpoint.frontier,
      events: checkpoint.events,
    });
    return checkpoint;
  }

  function checkpointWithEvents(source: ExecutionJournal, events: readonly any[], baseCheckpoint?: JsonCheckpoint): JsonCheckpoint {
    const checkpoint = JSON.parse(JSON.stringify(baseCheckpoint || source.exportGraphCheckpoint('c2-session')));
    checkpoint.events = JSON.parse(JSON.stringify(events));
    checkpoint.frontier = { eventCount: events.length, lastEventId: events.length };
    return rehash(checkpoint);
  }

  function completedC2Journal(): ExecutionJournal {
    const source = c2Journal();
    publishCatalog(source, { components: [{ id: 'A', path: 'packages/a' }] });
    completeC2Work(source);
    return source;
  }

  function completeC2Work(journal: ExecutionJournal): void {
    while (journal.queryReadyWork().length > 0) {
      const generation = journal.queryReadyWork()[0];
      const attempt = journal.startGeneratedAttempt(generation.nodeGenerationId);
      journal.scheduleGeneratedAttempt(attempt);
      journal.completeGeneratedAttempt({
        attempt,
        payload: generation.checkId === 'inspect' ? { id: 'A', findings: [] } : { done: true },
      });
    }
  }

  it('round-trips an immutable completed Graph-v2 prefix through JSON', () => {
    const source = c2Journal();
    publishCatalog(source, { components: [{ id: 'A', path: 'packages/a' }] });
    completeC2Work(source);
    const checkpoint = source.exportGraphCheckpoint('c2-session');
    const restored = ExecutionJournal.restoreGraphCheckpoint(
      compileClaimPlan(c2Config()),
      JSON.parse(JSON.stringify(checkpoint))
    );

    expect(restored.readRuntimeEvents()).toEqual(source.readRuntimeEvents());
    expect(restored.getClaimProjection()).toEqual(source.getClaimProjection());
    expect(restored.getInstanceProjection()).toEqual(source.getInstanceProjection());
    expect(restored.replayClaimProjection()).toEqual(restored.getClaimProjection());
    expect(restored.replayInstanceProjection()).toEqual(restored.getInstanceProjection());
    expect(restored.exportGraphCheckpoint('c2-session')).toEqual(checkpoint);
    expectDeeplyFrozen(restored.exportGraphCheckpoint('c2-session'));
  });

  it('migrates legacy v1 generated publications without wireMode', () => {
    const source = completedC2Journal();
    const legacy = JSON.parse(JSON.stringify(source.exportGraphCheckpoint('c2-session')));
    for (const event of legacy.events) {
      if (event.type === 'ClaimPublished' && event.nodeGenerationId) delete event.wireMode;
    }
    rehash(legacy);
    const restored = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(c2Config()), legacy);
    expect(restored.readRuntimeEvents().filter((event: any) => event.type === 'ClaimPublished' && event.nodeGenerationId).every((event: any) => event.wireMode === 'generic')).toBe(true);
  });

  it('round-trips nested reconciliation after all generated work is quiescent', () => {
    const source = c4Journal();
    publishCatalog(source, { components: [{ id: 'A', revision: 1 }] });
    const enumerate = source.queryReadyWork().find(value => value.checkId === 'enumerate')!;
    const enumerateAttempt = source.startGeneratedAttempt(enumerate.nodeGenerationId);
    source.scheduleGeneratedAttempt(enumerateAttempt);
    source.completeGeneratedAttempt({
      attempt: enumerateAttempt,
      payload: { specs: [{ id: 'spec-1', revision: 1, source: 'A/one' }] },
    });
    completeReadySpecWork(source);
    const checkpoint = source.exportGraphCheckpoint('c2-session');
    const restored = ExecutionJournal.restoreGraphCheckpoint(
      compileClaimPlan(c4Config()),
      JSON.parse(JSON.stringify(checkpoint))
    );
    expect(restored.readRuntimeEvents()).toEqual(source.readRuntimeEvents());
    expect(restored.getClaimProjection()).toEqual(source.getClaimProjection());
    expect(restored.getInstanceProjection()).toEqual(source.getInstanceProjection());
    expect(restored.replayInstanceProjection()).toEqual(restored.getInstanceProjection());
  });

  it('rejects a rehashed graph mismatch and an unhashed payload mutation', () => {
    const source = c2Journal();
    publishCatalog(source, { components: [{ id: 'A', path: 'packages/a' }] });
    completeC2Work(source);
    const checkpoint = source.exportGraphCheckpoint('c2-session');
    const tampered = JSON.parse(JSON.stringify(checkpoint));
    const catalogEvent = tampered.events.find((event: any) => event.type === 'ClaimPublished');
    catalogEvent.payload.components[0].path = 'packages/changed';
    expectErrorCode(
      () => ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(c2Config()), tampered),
      'CHECKPOINT_INTEGRITY_MISMATCH'
    );
    const graphChanged = JSON.parse(JSON.stringify(checkpoint));
    graphChanged.graphSemanticDigest = 'f'.repeat(64);
    graphChanged.frontier.eventCount += 1;
    rehash(graphChanged);
    expectErrorCode(
      () => ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(c2Config()), graphChanged),
      'CHECKPOINT_GRAPH_MISMATCH'
    );
  });

  it.each([
    ['unknown envelope key', (checkpoint: any) => { checkpoint.extra = true; }],
    ['wrong kind', (checkpoint: any) => { checkpoint.kind = 'other'; }],
    ['wrong version', (checkpoint: any) => { checkpoint.version = 2; }],
    ['alternate algorithm', (checkpoint: any) => { checkpoint.integrity.algorithm = 'sha512'; }],
  ])('rejects %s at the envelope gate', (_name, mutate) => {
    const source = completedC2Journal();
    const checkpoint = JSON.parse(JSON.stringify(source.exportGraphCheckpoint('c2-session')));
    mutate(checkpoint);
    expectErrorCode(
      () => ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(c2Config()), checkpoint),
      'INVALID_CHECKPOINT_ENVELOPE'
    );
  });

  it.each([
    ['unknown event type', (checkpoint: any) => { checkpoint.events[0].type = 'Unknown'; }],
    ['extra event key', (checkpoint: any) => { checkpoint.events[0].unknown = true; }],
    ['request and node hybrid', (checkpoint: any) => {
      const event = checkpoint.events.find((candidate: any) => candidate.nodeGenerationId);
      event.requestId = 'hybrid';
    }],
    ['non-contiguous event ID', (checkpoint: any) => { checkpoint.events[1].eventId = 99; }],
    ['event count mismatch', (checkpoint: any) => { checkpoint.frontier.eventCount += 1; }],
    ['last event mismatch', (checkpoint: any) => { checkpoint.frontier.lastEventId += 1; }],
  ])('rejects rehashed %s at the prefix gate', (_name, mutate) => {
    const source = completedC2Journal();
    const checkpoint = JSON.parse(JSON.stringify(source.exportGraphCheckpoint('c2-session')));
    mutate(checkpoint);
    rehash(checkpoint);
    expectErrorCode(
      () => ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(c2Config()), checkpoint),
      'INVALID_CHECKPOINT_PREFIX'
    );
  });

  it('checks graph binding before prefix grammar', () => {
    const source = completedC2Journal();
    const checkpoint = JSON.parse(JSON.stringify(source.exportGraphCheckpoint('c2-session')));
    checkpoint.graphSemanticDigest = 'f'.repeat(64);
    checkpoint.frontier.eventCount += 1;
    rehash(checkpoint);
    expectErrorCode(
      () => ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(c2Config()), checkpoint),
      'CHECKPOINT_GRAPH_MISMATCH'
    );
  });

  it.each([
    ['one-sided sidecar', (event: any) => { delete event.proofCandidateEvidenceFingerprint; }, 'INVALID_CHECKPOINT_PREFIX'],
    ['evidence tamper', (event: any) => { event.proofCandidateEvidence.probe.resultIdentity.resultDigest = `sha256:${'f'.repeat(64)}`; }, 'CHECKPOINT_PLAN_AUTHORITY_MISMATCH'],
    ['wrong claim sidecar', (event: any) => { event.claim = 'component.inspected@1'; }, 'INVALID_CHECKPOINT_PREFIX'],
    ['wrong node', (event: any) => { event.nodeGenerationId = 'f'.repeat(64); }, 'CHECKPOINT_PLAN_AUTHORITY_MISMATCH'],
    ['wrong producer/checkId', (event: any) => { event.checkId = 'proof_admit'; }, 'INVALID_CHECKPOINT_PREFIX'],
    ['claim ID mismatch', (event: any) => { event.claimId = 'f'.repeat(64); }, 'INVALID_CHECKPOINT_PREFIX'],
  ])('rejects governed publication authority drift: %s', (_name, mutate, code) => {
    const { plan, checkpoint } = completedGovernedCheckpoint();
    const event = checkpoint.events.find((value: any) => value.claim === 'proof.candidate@1');
    mutate(event);
    rehash(checkpoint);
    expectErrorCode(() => ExecutionJournal.restoreGraphCheckpoint(plan, checkpoint), code);
  });

  it.each([
    ['mixed event session', (checkpoint: any) => { checkpoint.events[0].sessionId = 'other'; }],
    ['root expansion digest', (checkpoint: any) => {
      const event = checkpoint.events.find((candidate: any) => candidate.type === 'SubgraphExpanded');
      event.expansionSpecDigest = 'f'.repeat(64);
    }],
    ['generated activation config', (checkpoint: any) => {
      const event = checkpoint.events.find((candidate: any) => candidate.type === 'NodeGenerationActivated');
      event.executionConfigDigest = 'f'.repeat(64);
    }],
  ])('rejects rehashed %s with its dedicated gate', (_name, mutate) => {
    const source = completedC2Journal();
    const checkpoint = JSON.parse(JSON.stringify(source.exportGraphCheckpoint('c2-session')));
    mutate(checkpoint);
    rehash(checkpoint);
    expectErrorCode(
      () => ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(c2Config()), checkpoint),
      _name === 'mixed event session' ? 'CHECKPOINT_SESSION_MISMATCH' : 'CHECKPOINT_PLAN_AUTHORITY_MISMATCH'
    );
  });

  it('rejects a semantically different compiled graph after its checkpoint integrity passes', () => {
    const source = completedC2Journal();
    const checkpoint = source.exportGraphCheckpoint('c2-session');
    expectErrorCode(
      () => ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(c2Config('two-predecessor')), checkpoint),
      'CHECKPOINT_GRAPH_MISMATCH'
    );
  });

  it('accepts empty and ready-only frontiers while rejecting every in-flight class', () => {
    const empty = new ExecutionJournal(compileClaimPlan(c2Config())).exportGraphCheckpoint('empty');
    const restored = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(c2Config()), JSON.parse(JSON.stringify(empty)));
    expect(restored.readRuntimeEvents()).toEqual([]);
    const readyJournal = c2Journal();
    publishCatalog(readyJournal, { components: [{ id: 'A', path: 'packages/a' }] });
    const readyCheckpoint = readyJournal.exportGraphCheckpoint('c2-session');
    const readyRestore = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(c2Config()), JSON.parse(JSON.stringify(readyCheckpoint)));
    expect(readyRestore.getInstanceProjection()).toEqual(readyJournal.getInstanceProjection());
    expect((readyRestore as any).nextFence).toBe((readyJournal as any).nextFence);
    expect((readyRestore as any).attemptOrdinals).toEqual((readyJournal as any).attemptOrdinals);
    expect(readyRestore.exportGraphCheckpoint('c2-session')).toEqual(readyCheckpoint);
    const cases: Array<[string, () => ExecutionJournal]> = [
      ['root attempt', () => {
        const journal = c2Journal();
        journal.startAttempt({ sessionId: 'c2-session', checkId: 'discover', scope: [] });
        return journal;
      }],
      ['pending request', () => {
        const journal = c2Journal();
        journal.requestCatalogReconciliation({ sessionId: 'c2-session', ownerCheck: 'discover' });
        return journal;
      }],
      ['running generation', () => {
        const journal = c2Journal();
        publishCatalog(journal, { components: [{ id: 'A', path: 'packages/a' }] });
        const generation = journal.queryReadyWork()[0];
        journal.startGeneratedAttempt(generation.nodeGenerationId);
        return journal;
      }],
      ['acquired managed run', () => {
        const journal = c2Journal();
        publishCatalog(journal, { components: [{ id: 'A', path: 'packages/a' }] });
        const generation = journal.queryReadyWork()[0];
        const attempt = journal.startGeneratedAttempt(generation.nodeGenerationId);
        journal.scheduleGeneratedAttempt(attempt);
        journal.recordManagedRunAcquired(journal.deriveManagedRunBinding(attempt));
        return journal;
      }],
      ['started managed run', () => {
        const journal = c2Journal();
        publishCatalog(journal, { components: [{ id: 'A', path: 'packages/a' }] });
        const generation = journal.queryReadyWork()[0];
        const attempt = journal.startGeneratedAttempt(generation.nodeGenerationId);
        journal.scheduleGeneratedAttempt(attempt);
        const binding = journal.deriveManagedRunBinding(attempt);
        journal.recordManagedRunAcquired(binding);
        journal.recordManagedRunStarted(binding);
        return journal;
      }],
      ['cancel-requested managed run', () => {
        const journal = c2Journal();
        publishCatalog(journal, { components: [{ id: 'A', path: 'packages/a' }] });
        const generation = journal.queryReadyWork()[0];
        const attempt = journal.startGeneratedAttempt(generation.nodeGenerationId);
        journal.scheduleGeneratedAttempt(attempt);
        const binding = journal.deriveManagedRunBinding(attempt);
        journal.recordManagedRunAcquired(binding);
        journal.recordManagedRunStarted(binding);
        journal.recordManagedRunCancelRequested(binding);
        return journal;
      }],
    ];
    for (const [name, build] of cases) {
      expectErrorCode(
        () => build().exportGraphCheckpoint('c2-session'),
        'CHECKPOINT_NOT_QUIESCENT'
      );
      void name;
    }
  });

  it.each([
    ['acquisition terminal cut', (journal: ExecutionJournal) => {
      const generation = journal.queryReadyWork()[0];
      const attempt = journal.startGeneratedAttempt(generation.nodeGenerationId);
      journal.scheduleGeneratedAttempt(attempt);
      journal.failManagedRunAcquisition({ attempt, binding: journal.deriveManagedRunBinding(attempt), failureCode: 'MANAGED_HANDLE_INVALID' });
      return journal.readRuntimeEvents().findIndex(event => event.type === 'ManagedRunAcquisitionFailed') + 1;
    }],
    ['completion terminal cut', (journal: ExecutionJournal) => {
      const generation = journal.queryReadyWork()[0];
      const attempt = journal.startGeneratedAttempt(generation.nodeGenerationId);
      journal.scheduleGeneratedAttempt(attempt);
      const binding = journal.deriveManagedRunBinding(attempt);
      journal.recordManagedRunAcquired(binding);
      journal.recordManagedRunStarted(binding);
      journal.completeManagedGeneratedAttempt({ attempt, binding, executionConfigDigest: journal.getGeneratedExecution(attempt.nodeGenerationId).node.executionConfigDigest, payload: { id: 'A', findings: [] } });
      return journal.readRuntimeEvents().findIndex(event => event.type === 'ManagedRunTerminated') + 1;
    }],
  ])('rejects an atomic managed-terminal cut (%s)', (_name, buildCut) => {
    const source = c2Journal();
    publishCatalog(source, { components: [{ id: 'A', path: 'packages/a' }] });
    const baseCheckpoint = source.exportGraphCheckpoint('c2-session');
    const cut = buildCut(source);
    const checkpoint = checkpointWithEvents(source, source.readRuntimeEvents().slice(0, cut), baseCheckpoint);
    expectErrorCode(
      () => ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(c2Config()), checkpoint),
      'INVALID_CHECKPOINT_PREFIX'
    );
  });

  it('keeps a pre-checkpoint fence stale without appending an event', () => {
    const source = completedC2Journal();
    const oldAttempt = source.readRuntimeEvents().find(event =>
      event.type === 'AttemptStarted' && !('nodeGenerationId' in event)
    ) as any;
    const checkpoint = source.exportGraphCheckpoint('c2-session');
    const restored = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(c2Config()), checkpoint);
    const nextRequest = restored.requestCatalogReconciliation({
      sessionId: 'c2-session',
      ownerCheck: 'discover',
    });
    const nextAttempt = restored.startCatalogRequestAttempt(nextRequest.requestId);
    expect(nextAttempt.fence).toBe(
      source.readRuntimeEvents().filter(event => event.type === 'AttemptStarted').length + 1
    );
    const staleSchedule = () => restored.scheduleCheck({
      sessionId: oldAttempt.sessionId,
      checkId: oldAttempt.checkId,
      scope: oldAttempt.scope,
      attemptId: oldAttempt.attemptId,
      fence: oldAttempt.fence,
    });
    const staleTerminal = () => restored.failAttempt({
      sessionId: oldAttempt.sessionId,
      checkId: oldAttempt.checkId,
      scope: oldAttempt.scope,
      attemptId: oldAttempt.attemptId,
      fence: oldAttempt.fence,
      reason: 'stale pre-checkpoint attempt',
    });
    for (const staleOperation of [staleSchedule, staleTerminal]) {
      const beforeStaleCall = restored.readRuntimeEvents().length;
      expectErrorCode(staleOperation, 'STALE_FENCE');
      expect(restored.readRuntimeEvents()).toHaveLength(beforeStaleCall);
    }
  });

  it('reconstructs shared root/catalog ordinals and repeats restore without process-local state', () => {
    const source = c2Journal();
    const root = source.startAttempt({ sessionId: 'c2-session', checkId: 'discover', scope: [] });
    source.scheduleCheck(root);
    source.failAttempt({ ...root, reason: 'root failed' });
    const request = source.requestCatalogReconciliation({ sessionId: 'c2-session', ownerCheck: 'discover' });
    const catalog = source.startCatalogRequestAttempt(request.requestId);
    source.scheduleCatalogRequestAttempt(catalog);
    source.failAttempt({ ...catalog, reason: 'catalog failed' });
    const checkpoint = source.exportGraphCheckpoint('c2-session');
    const first = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(c2Config()), JSON.parse(JSON.stringify(checkpoint)));
    const second = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(c2Config()), first.exportGraphCheckpoint('c2-session'));
    const nextRequest = second.requestCatalogReconciliation({ sessionId: 'c2-session', ownerCheck: 'discover' });
    const nextCatalog = second.startCatalogRequestAttempt(nextRequest.requestId);
    expect(nextRequest.requestOrdinal).toBe(2);
    expect(nextCatalog.attemptId).toBe(sha256Canonical({
      sessionId: 'c2-session', checkId: 'discover', scope: [], ordinal: 3,
    }));
    expect(nextCatalog.fence).toBe(3);
  });

  it('starts a changed generation with generated ordinal one and rejects a duplicate start', () => {
    const source = completedC2Journal();
    const restored = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(c2Config()), source.exportGraphCheckpoint('c2-session'));
    const request = restored.requestCatalogReconciliation({ sessionId: 'c2-session', ownerCheck: 'discover' });
    const catalog = restored.startCatalogRequestAttempt(request.requestId);
    restored.scheduleCatalogRequestAttempt(catalog);
    restored.completeAttempt({ ...catalog, payload: { components: [{ id: 'A', path: 'packages/new' }] } });
    const generation = restored.queryReadyWork().find(value => value.checkId === 'inspect')!;
    const attempt = restored.startGeneratedAttempt(generation.nodeGenerationId);
    expect(attempt.attemptId).toBe(sha256Canonical({ nodeGenerationId: generation.nodeGenerationId, ordinal: 1 }));
    expectErrorCode(() => restored.startGeneratedAttempt(generation.nodeGenerationId), 'GENERATION_NOT_READY');
    restored.scheduleGeneratedAttempt(attempt);
    restored.completeGeneratedAttempt({ attempt, payload: { id: 'A', findings: [] } });
    const downstream = restored.queryReadyWork().find(value => value.checkId === 'summarize')!;
    const downstreamAttempt = restored.startGeneratedAttempt(downstream.nodeGenerationId);
    restored.scheduleGeneratedAttempt(downstreamAttempt);
    restored.completeGeneratedAttempt({ attempt: downstreamAttempt, payload: { done: true } });

    const secondCheckpoint = restored.exportGraphCheckpoint('c2-session');
    const secondRestore = ExecutionJournal.restoreGraphCheckpoint(
      compileClaimPlan(c2Config()),
      JSON.parse(JSON.stringify(secondCheckpoint))
    );
    const furtherRequest = secondRestore.requestCatalogReconciliation({
      sessionId: 'c2-session',
      ownerCheck: 'discover',
    });
    const furtherCatalog = secondRestore.startCatalogRequestAttempt(furtherRequest.requestId);
    expect(furtherRequest.requestOrdinal).toBe(3);
    expect(furtherCatalog.attemptId).toBe(sha256Canonical({
      sessionId: 'c2-session', checkId: 'discover', scope: [], ordinal: 3,
    }));
    expect(furtherCatalog.fence).toBe(7);
  });

  it('reconstructs the next request, attempt, and global fence authority', () => {
    const source = c2Journal();
    publishCatalog(source, { components: [{ id: 'A', path: 'packages/a' }] });
    completeC2Work(source);
    const checkpoint = source.exportGraphCheckpoint('c2-session');
    const restored = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(c2Config()), checkpoint);
    const request = restored.requestCatalogReconciliation({ sessionId: 'c2-session', ownerCheck: 'discover' });
    expect(request.requestOrdinal).toBe(2);
    const attempt = restored.startCatalogRequestAttempt(request.requestId);
    const starts = source.readRuntimeEvents().filter(event => event.type === 'AttemptStarted').length;
    expect(attempt.fence).toBe(starts + 1);
    expect(attempt.attemptId).toBe(sha256Canonical({
      sessionId: 'c2-session', checkId: 'discover', scope: [], ordinal: 2,
    }));
  });
});

describe('managed-run authority snapshots', () => {
  it('starts deadline cancel and close independently without consulting provider promise methods', async () => {
    jest.useFakeTimers();
    const timeoutSpy = jest.spyOn(global, 'setTimeout');
    const intervalSpy = jest.spyOn(global, 'setInterval');
    try {
      const binding = helperManagedBinding();
      const cancelReturn = deferred<ManagedRunCancelReceiptV1>();
      const closeReturn = deferred<ManagedRunCleanupReceiptV1>();
      const providerPromiseTrap = jest.fn(() => {
        throw new Error('provider settlement promise methods were consulted');
      });
      for (const promise of [cancelReturn.promise, closeReturn.promise]) {
        Object.defineProperties(promise, {
          then: { configurable: true, value: providerPromiseTrap },
          catch: { configurable: true, value: providerPromiseTrap },
        });
      }

      const callOrder: string[] = [];
      const handleRef: { value?: any } = {};
      const cancel = jest.fn(function (this: unknown, _reason: 'deadline', _fence: number) {
        expect(this).toBe(handleRef.value);
        callOrder.push('cancel');
        return cancelReturn.promise;
      });
      const close = jest.fn(function (this: unknown) {
        expect(this).toBe(handleRef.value);
        callOrder.push('close');
        return closeReturn.promise;
      });
      const handle: any = {
        binding,
        started: Promise.resolve({ version: 1 as const, kind: 'started' as const, binding }),
        outcome: Promise.resolve({ version: 1 as const, kind: 'failed' as const, binding }),
        cancel,
        close,
      };
      handleRef.value = handle;
      const snapshot = snapshotManagedRun(() => handle, binding);
      const onCancelRequested = jest.fn();
      const deadline = armManagedRunDeadline({
        snapshot,
        timeoutMs: 25,
        onCancelRequested,
      });
      let deadlineSettled = false;
      void deadline.fired.then(() => {
        deadlineSettled = true;
      });

      expect(timeoutSpy).toHaveBeenCalledTimes(1);
      expect(timeoutSpy.mock.calls[0][1]).toBe(25);
      expect(intervalSpy).not.toHaveBeenCalled();
      jest.advanceTimersByTime(25);

      expect(deadline.didFire()).toBe(true);
      expect(onCancelRequested).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledWith('deadline', binding.fence);
      expect(close).toHaveBeenCalledTimes(1);
      expect(callOrder).toEqual(['cancel', 'close']);
      expect(providerPromiseTrap).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);

      const closeReceipt: ManagedRunCleanupReceiptV1 = {
        version: 1,
        kind: 'cleanup',
        binding,
        status: 'clean',
        activeChildren: 0,
        activeResources: 0,
      };
      closeReturn.resolve(closeReceipt);
      await Promise.resolve();
      await Promise.resolve();
      expect(deadlineSettled).toBe(false);

      const cancelReceipt: ManagedRunCancelReceiptV1 = {
        version: 1,
        kind: 'cancelled',
        binding,
        reason: 'deadline',
      };
      cancelReturn.resolve(cancelReceipt);
      await expect(deadline.fired).resolves.toEqual({
        cancel: { status: 'fulfilled', value: cancelReceipt },
        close: { status: 'fulfilled', value: closeReceipt },
        cancelRequested: true,
      });
      expect(deadlineSettled).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(callOrder).toEqual(['cancel', 'close']);
      expect(providerPromiseTrap).not.toHaveBeenCalled();
      expect(timeoutSpy).toHaveBeenCalledTimes(1);
      expect(intervalSpy).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      timeoutSpy.mockRestore();
      intervalSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it.each([
    ['NaN', Number.NaN],
    ['negative', -1],
    ['positive infinity', Number.POSITIVE_INFINITY],
  ])('arms one immediate, total deadline for a %s timeout', async (_name, timeoutMs) => {
    jest.useFakeTimers();
    const timeoutSpy = jest.spyOn(global, 'setTimeout');
    const intervalSpy = jest.spyOn(global, 'setInterval');
    try {
      const binding = helperManagedBinding();
      const cancel = jest.fn(() => Promise.resolve({
        version: 1 as const,
        kind: 'cancelled' as const,
        binding,
        reason: 'deadline' as const,
      }));
      const close = jest.fn(() => Promise.resolve({
        version: 1 as const,
        kind: 'cleanup' as const,
        binding,
        status: 'clean' as const,
        activeChildren: 0 as const,
        activeResources: 0 as const,
      }));
      const snapshot = snapshotManagedRun(() => ({
        binding,
        started: Promise.resolve({ version: 1, kind: 'started', binding }),
        outcome: Promise.resolve({ version: 1, kind: 'failed', binding }),
        cancel,
        close,
      } as any), binding);
      const onCancelRequested = jest.fn();

      expect(normalizeManagedRunTimeout(timeoutMs)).toBe(0);
      const deadline = armManagedRunDeadline({ snapshot, timeoutMs, onCancelRequested });
      expect(timeoutSpy).toHaveBeenCalledTimes(1);
      expect(timeoutSpy.mock.calls[0][1]).toBe(0);
      expect(intervalSpy).not.toHaveBeenCalled();

      jest.advanceTimersByTime(0);
      const settlement = await deadline.fired;

      expect(deadline.didFire()).toBe(true);
      expect(onCancelRequested).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledWith('deadline', binding.fence);
      expect(close).toHaveBeenCalledTimes(1);
      expect(settlement.cancel?.status).toBe('fulfilled');
      expect(settlement.close.status).toBe('fulfilled');
      expect(timeoutSpy).toHaveBeenCalledTimes(1);
      expect(intervalSpy).not.toHaveBeenCalled();
    } finally {
      timeoutSpy.mockRestore();
      intervalSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it.each([
    ['started thenable', 'started', { then: jest.fn() }],
    ['outcome object', 'outcome', {}],
  ])('rejects a handle with a non-native $s', (_name, slot, hostileValue) => {
    const binding = helperManagedBinding();
    const cancel = jest.fn();
    const close = jest.fn();
    const started = Promise.resolve({ version: 1 as const, kind: 'started' as const, binding });
    const outcome = Promise.resolve({ version: 1 as const, kind: 'failed' as const, binding });
    const handle: any = { binding, started, outcome, cancel, close };
    handle[slot] = hostileValue;

    expectErrorCode(
      () => snapshotManagedRun(() => handle, binding),
      'MANAGED_HANDLE_INVALID'
    );
    expect(cancel).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    if ('then' in hostileValue) expect(hostileValue.then).not.toHaveBeenCalled();
  });

  it.each(['own methods', 'per-object prototype'] as const)(
    'does not reconsult %s after started and outcome are mirrored',
    async mutation => {
      const binding = helperManagedBinding();
      const started = deferred<any>();
      const outcome = deferred<any>();
      const trap = jest.fn(() => {
        throw new Error('provider promise mutation was consulted');
      });
      const snapshot = snapshotManagedRun(() => ({
        binding,
        started: started.promise,
        outcome: outcome.promise,
        cancel: () => Promise.reject(new Error('unused cancel')),
        close: () => Promise.reject(new Error('unused close')),
      }), binding);

      for (const promise of [started.promise, outcome.promise]) {
        if (mutation === 'own methods') {
          Object.defineProperties(promise, {
            then: { configurable: true, value: trap },
            catch: { configurable: true, value: trap },
          });
        } else {
          Object.setPrototypeOf(promise, Object.freeze({ then: trap, catch: trap }));
        }
      }

      const startedValue = { version: 1 as const, kind: 'started' as const, binding };
      const outcomeValue = { version: 1 as const, kind: 'failed' as const, binding };
      started.resolve(startedValue);
      outcome.resolve(outcomeValue);

      await expect(snapshot.started).resolves.toBe(startedValue);
      await expect(snapshot.outcome).resolves.toBe(outcomeValue);
      expect(trap).not.toHaveBeenCalled();
    }
  );

  it('mirrors first cancel and close returns and ignores later provider authority mutation', async () => {
    const binding = helperManagedBinding();
    const cancelReturn = deferred<any>();
    const closeReturn = deferred<any>();
    const originalCancel = jest.fn(() => cancelReturn.promise);
    const originalClose = jest.fn(() => closeReturn.promise);
    const redirectedCancel = jest.fn();
    const redirectedClose = jest.fn();
    const redirectedStart = jest.fn();
    const handle: any = {
      binding,
      started: Promise.resolve({ version: 1 as const, kind: 'started' as const, binding }),
      outcome: Promise.resolve({ version: 1 as const, kind: 'failed' as const, binding }),
      cancel: originalCancel,
      close: originalClose,
    };
    const provider: { startManaged: () => any } = {
      startManaged: jest.fn(() => handle),
    };
    const snapshot = snapshotManagedRun(() => provider.startManaged(), binding);

    provider.startManaged = redirectedStart;
    handle.cancel = redirectedCancel;
    handle.close = redirectedClose;
    Object.setPrototypeOf(handle, Object.freeze({
      cancel: redirectedCancel,
      close: redirectedClose,
    }));

    const cancelMirror = snapshot.cancelOnce('deadline', binding.fence);
    const closeMirror = snapshot.closeOnce();
    const trap = jest.fn(() => {
      throw new Error('provider completion mutation was consulted');
    });
    Object.defineProperties(cancelReturn.promise, {
      then: { configurable: true, value: trap },
      catch: { configurable: true, value: trap },
    });
    Object.setPrototypeOf(closeReturn.promise, Object.freeze({ then: trap, catch: trap }));

    const cancelReceipt = {
      version: 1 as const,
      kind: 'cancelled' as const,
      binding,
      reason: 'deadline' as const,
    };
    const closeReceipt = {
      version: 1 as const,
      kind: 'cleanup' as const,
      binding,
      status: 'clean' as const,
      activeChildren: 0 as const,
      activeResources: 0 as const,
    };
    cancelReturn.resolve(cancelReceipt);
    closeReturn.resolve(closeReceipt);

    await expect(cancelMirror).resolves.toBe(cancelReceipt);
    await expect(closeMirror).resolves.toBe(closeReceipt);
    expect(snapshot.cancelOnce('deadline', binding.fence)).toBe(cancelMirror);
    expect(snapshot.closeOnce()).toBe(closeMirror);
    expect(originalCancel).toHaveBeenCalledTimes(1);
    expect(originalCancel).toHaveBeenCalledWith('deadline', binding.fence);
    expect(originalClose).toHaveBeenCalledTimes(1);
    expect(redirectedStart).not.toHaveBeenCalled();
    expect(redirectedCancel).not.toHaveBeenCalled();
    expect(redirectedClose).not.toHaveBeenCalled();
    expect(trap).not.toHaveBeenCalled();
  });

  it('gives the provider a cyclic, frozen copy without freezing controller inputs', () => {
    const binding = helperManagedBinding();
    const shared: any = { nested: { value: 'before' } };
    shared.self = shared;
    const dependencyResults = new Map<string, any>([['dep', { output: shared }]]);
    const request: any = {
      prInfo: {
        number: 1,
        title: 'fixture',
        body: '',
        author: 'fixture',
        base: 'main',
        head: 'feature',
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
        eventContext: shared,
      },
      checkConfig: { type: 'managed', metadata: shared },
      dependencyResults,
      executionContext: { args: shared },
      binding,
    };

    const snapshot = snapshotManagedRunStartRequest(request);
    const providerShared = snapshot.prInfo.eventContext as any;
    const dependency = snapshot.dependencyResults.get('dep') as any;

    expect(providerShared).not.toBe(shared);
    expect(providerShared.self).toBe(providerShared);
    expect((snapshot.checkConfig.metadata as any)).toBe(providerShared);
    expect((snapshot.executionContext.args as any)).toBe(providerShared);
    expect(dependency.output).toBe(providerShared);
    expectDeeplyFrozen(snapshot);
    expectDeeplyFrozen(dependency);
    expect(snapshot.dependencyResults.size).toBe(1);
    expect(snapshot.dependencyResults.get('dep')).toBe(dependency);
    expect(snapshot.dependencyResults.has('dep')).toBe(true);
    expect(Array.from(snapshot.dependencyResults.entries())).toEqual([['dep', dependency]]);
    expect(Array.from(snapshot.dependencyResults.keys())).toEqual(['dep']);
    expect(Array.from(snapshot.dependencyResults.values())).toEqual([dependency]);
    const visited: Array<[
      string,
      unknown,
      ReadonlyMap<string, unknown>,
    ]> = [];
    snapshot.dependencyResults.forEach((value, key, map) => {
      visited.push([key, value, map]);
    });
    expect(visited).toEqual([['dep', dependency, snapshot.dependencyResults]]);
    expect(Array.from(snapshot.dependencyResults)).toEqual([['dep', dependency]]);
    expect((snapshot.dependencyResults as any).set).toBeUndefined();
    expect((snapshot.dependencyResults as any).delete).toBeUndefined();
    expect((snapshot.dependencyResults as any).clear).toBeUndefined();
    expect(() => (snapshot.dependencyResults as any).set('late', {})).toThrow();

    expect(Object.isFrozen(request)).toBe(false);
    expect(Object.isFrozen(request.prInfo)).toBe(false);
    expect(Object.isFrozen(request.checkConfig)).toBe(false);
    expect(Object.isFrozen(request.executionContext)).toBe(false);
    expect(Object.isFrozen(request.binding)).toBe(false);
    expect(Object.isFrozen(dependencyResults)).toBe(false);
    expect(Object.isFrozen(shared)).toBe(false);
    expect(Object.isFrozen(shared.nested)).toBe(false);
    shared.nested.value = 'after';
    dependencyResults.set('late', { output: 'late' });
    expect(providerShared.nested.value).toBe('before');
    expect(snapshot.dependencyResults.has('late')).toBe(false);
  });

  it('requires the Proof request only for proof-admit snapshots', () => {
    const base: any = { prInfo: {}, dependencyResults: new Map(), executionContext: {}, binding: helperManagedBinding() };
    expect(() => snapshotManagedRunStartRequest({ ...base, checkConfig: { type: 'proof-admit' } })).toThrow('PROOF_ADMISSION_REQUEST_AUTHORITY_MISMATCH');
    expect(() => snapshotManagedRunStartRequest({ ...base, checkConfig: { type: 'managed' }, proofAdmissionRequest: '{}' })).toThrow('PROOF_ADMISSION_REQUEST_AUTHORITY_MISMATCH');
    expect(snapshotManagedRunStartRequest({ ...base, checkConfig: { type: 'proof-admit' }, proofAdmissionRequest: '{}' }).proofAdmissionRequest).toBe('{}');
  });

  it('snapshots and freezes the controller-derived reinspection context', () => {
    const reinspectionContext: any = {
      version: 'visor.proof-component-reinspection-context/v1', component_id: 'alpha', changed_paths: ['alpha.go'],
      historical_work_item: { claim_id: '1'.repeat(64), payload_fingerprint: '2'.repeat(64) },
      current_work_item: { claim_id: '3'.repeat(64), payload_fingerprint: '4'.repeat(64) },
      prior_candidate: { claim_id: '5'.repeat(64), payload_fingerprint: '6'.repeat(64), result_digest: `sha256:${'7'.repeat(64)}`, payload: { finding: '& < prior' } },
      prior_admission: { claim_id: '8'.repeat(64), payload_fingerprint: '9'.repeat(64) },
    };
    const request: any = { prInfo: {}, checkConfig: { type: 'managed' }, dependencyResults: new Map(), executionContext: {}, binding: helperManagedBinding(), reinspectionContext };
    const snapshot = snapshotManagedRunStartRequest(request);
    expect(snapshot.reinspectionContext).not.toBe(reinspectionContext);
    expect(snapshot.reinspectionContext).toEqual(reinspectionContext);
    expectDeeplyFrozen(snapshot.reinspectionContext);
    reinspectionContext.prior_candidate.payload.finding = 'mutated';
    expect((snapshot.reinspectionContext as any).prior_candidate.payload.finding).toBe('& < prior');
  });

  it('requires the reconciliation request only for the exact Proof project reconciler', () => {
    const base: any = { prInfo: {}, dependencyResults: new Map(), executionContext: {}, binding: helperManagedBinding() };
    expect(() => snapshotManagedRunStartRequest({ ...base, checkConfig: { type: 'proof-project-reconcile' } })).toThrow('PROOF_PROJECT_RECONCILIATION_REQUEST_AUTHORITY_MISMATCH');
    expect(() => snapshotManagedRunStartRequest({ ...base, checkConfig: { type: 'managed' }, proofProjectReconciliationRequest: '{}' })).toThrow('PROOF_PROJECT_RECONCILIATION_REQUEST_AUTHORITY_MISMATCH');
    expect(snapshotManagedRunStartRequest({ ...base, checkConfig: { type: 'proof-project-reconcile' }, proofProjectReconciliationRequest: '{}' }).proofProjectReconciliationRequest).toBe('{}');
    expect(() => snapshotManagedRunStartRequest({
      ...base,
      checkConfig: { type: 'proof-project-reconcile' },
      proofAdmissionRequest: '{}',
      proofProjectReconciliationRequest: '{}',
    })).toThrow('PROOF_REQUEST_FIELDS_MUTUALLY_EXCLUSIVE');
  });
});
