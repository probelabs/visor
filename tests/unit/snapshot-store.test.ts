import { describe, it, expect } from '@jest/globals';
import { ExecutionJournal, ContextView, ScopePath } from '../../src/snapshot-store';
import { compileClaimPlan } from '../../src/state-machine/graph/claim-plan';

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
});
