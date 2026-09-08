import {
  canonicalJson,
  ClaimKernelError,
  reduceClaimEvent,
  replayClaimEvents,
  sha256Canonical,
  type AttemptStartedEvent,
  type CheckScheduledEvent,
} from '../../../../src/state-machine/graph/claim-kernel';
import { compileClaimPlan } from '../../../../src/state-machine/graph/claim-plan';
import { ExecutionJournal } from '../../../../src/snapshot-store';

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['value'],
  properties: { value: { type: 'string', const: 'ready' } },
};

function singleClaimPlan() {
  return compileClaimPlan({
    version: '1.0',
    claim_types: { 'fixture.ready@1': { schema } },
    checks: {
      producer: { type: 'noop', emits: [{ claim: 'fixture.ready@1', from: 'output' }] },
      consumer: {
        type: 'noop',
        consumes: [{ claim: 'fixture.ready@1', cardinality: 'one' }],
      },
    },
  });
}

describe('Graph v2 C1 claim kernel', () => {
  function expectClaimError(run: () => unknown, code: string, message: string): void {
    try {
      run();
      throw new Error(`Expected ClaimKernelError ${code}`);
    } catch (error) {
      expect(error).toBeInstanceOf(ClaimKernelError);
      if (!(error instanceof ClaimKernelError)) throw error;
      expect(error.code).toBe(code);
      expect(error.message).toContain(message);
    }
  }

  it('canonicalizes recursively and fingerprints independently of insertion order', () => {
    const left = { z: [{ b: 2, a: 1 }], a: true };
    const right = { a: true, z: [{ a: 1, b: 2 }] };
    expect(canonicalJson(left)).toBe('{"a":true,"z":[{"a":1,"b":2}]}');
    expect(sha256Canonical(left)).toBe(sha256Canonical(right));
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, () => true, Symbol('x')])(
    'rejects non-canonical payload %p',
    value => {
      expect(() => canonicalJson(value)).toThrow(ClaimKernelError);
    }
  );

  it('atomically commits ordered multi-emission completion and replays identically', () => {
    const plan = compileClaimPlan({
      version: '1.0',
      claim_types: {
        'fixture.first@1': { schema },
        'fixture.second@1': { schema },
      },
      checks: {
        producer: {
          type: 'noop',
          emits: [
            { claim: 'fixture.first@1', from: 'output' },
            { claim: 'fixture.second@1', from: 'output' },
          ],
        },
        consumer: {
          type: 'noop',
          consumes: [
            { claim: 'fixture.first@1', cardinality: 'one' },
            { claim: 'fixture.second@1', cardinality: 'one' },
          ],
        },
      },
    });
    const journal = new ExecutionJournal(plan);
    const producer = journal.startAttempt({ sessionId: 's1', checkId: 'producer', scope: [] });
    journal.scheduleCheck(producer);
    const terminal = journal.completeAttempt({ ...producer, payload: { value: 'ready' } });
    const consumer = journal.startAttempt({ sessionId: 's1', checkId: 'consumer', scope: [] });
    const scheduled = journal.scheduleCheck(consumer);
    journal.completeAttempt({ ...consumer, payload: { consumed: true } });

    const events = journal.readRuntimeEvents();
    expect(events.map(event => event.eventId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(events.map(event => event.type)).toEqual([
      'AttemptStarted',
      'CheckScheduled',
      'ClaimPublished',
      'ClaimPublished',
      'AttemptCompleted',
      'AttemptStarted',
      'CheckScheduled',
      'AttemptCompleted',
    ]);
    expect(terminal.claims.map(claim => claim.claim)).toEqual([
      'fixture.first@1',
      'fixture.second@1',
    ]);
    const expectedAttemptId = sha256Canonical({
      sessionId: 's1',
      checkId: 'producer',
      scope: [],
      ordinal: 1,
    });
    const expectedFingerprint = sha256Canonical({ value: 'ready' });
    expect(producer).toMatchObject({ attemptId: expectedAttemptId, fence: 1 });
    expect(terminal.claims.map(claim => claim.payloadFingerprint)).toEqual([
      expectedFingerprint,
      expectedFingerprint,
    ]);
    expect(terminal.claims.map(claim => claim.claimId)).toEqual(
      ['fixture.first@1', 'fixture.second@1'].map(claim =>
        sha256Canonical({
          claim,
          payloadFingerprint: expectedFingerprint,
          producerCheckId: 'producer',
          scope: [],
          attemptId: expectedAttemptId,
          fence: 1,
          parentClaimIds: [],
        })
      )
    );
    expect(consumer.fence).toBe(2);
    expect(scheduled.claimIds).toEqual(terminal.claims.map(claim => claim.claimId));
    expect(replayClaimEvents(events, plan)).toEqual(journal.getClaimProjection());
  });

  it('leaves no partial prefix when a later emission is invalid', () => {
    const plan = compileClaimPlan({
      version: '1.0',
      claim_types: {
        'fixture.first@1': { schema },
        'fixture.second@1': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['value', 'second'],
            properties: { value: { const: 'ready' }, second: { const: true } },
          },
        },
      },
      checks: {
        producer: {
          type: 'noop',
          emits: [
            { claim: 'fixture.first@1', from: 'output' },
            { claim: 'fixture.second@1', from: 'output' },
          ],
        },
      },
    });
    const journal = new ExecutionJournal(plan);
    const attempt = journal.startAttempt({ sessionId: 's1', checkId: 'producer', scope: [] });
    journal.scheduleCheck(attempt);
    const before = journal.getClaimProjection();
    expectClaimError(
      () => journal.completeAttempt({ ...attempt, payload: { value: 'ready' } }),
      'CLAIM_SCHEMA_INVALID',
      'failed schema validation'
    );
    expect(journal.getClaimProjection()).toEqual(before);
    expect(journal.readRuntimeEvents().map(event => event.type)).toEqual([
      'AttemptStarted',
      'CheckScheduled',
    ]);

    journal.failAttempt({ ...attempt, reason: 'CLAIM_SCHEMA_INVALID' });
    expect(journal.readRuntimeEvents().map(event => event.type)).toEqual([
      'AttemptStarted',
      'CheckScheduled',
      'AttemptFailed',
    ]);
    expect(journal.getClaimProjection().claims).toEqual({});
  });

  it('derives emitter, schema, ref, parent IDs, and scheduled IDs from its owned plan', () => {
    const plan = compileClaimPlan({
      version: '1.0',
      claim_types: {
        'fixture.parent@1': { schema },
        'fixture.child@1': { schema },
      },
      checks: {
        parent: { type: 'noop', emits: [{ claim: 'fixture.parent@1', from: 'output' }] },
        child: {
          type: 'noop',
          consumes: [{ claim: 'fixture.parent@1', cardinality: 'one' }],
          emits: [{ claim: 'fixture.child@1', from: 'output' }],
        },
      },
    });
    const journal = new ExecutionJournal(plan);
    const parent = journal.startAttempt({ sessionId: 's1', checkId: 'parent', scope: [] });
    journal.scheduleCheck(parent);
    const parentTerminal = journal.completeAttempt({ ...parent, payload: { value: 'ready' } });
    const child = journal.startAttempt({ sessionId: 's1', checkId: 'child', scope: [] });
    const scheduled = journal.scheduleCheck({
      ...child,
      claimIds: ['caller-forged'],
    } as typeof child);
    const beforeSubstitution = journal.readRuntimeEvents();
    expectClaimError(
      () =>
        journal.completeAttempt({
          ...child,
          payload: { value: 'wrong' },
          claim: 'caller.substitution@99',
          schema: {},
          producerCheckId: 'caller',
          parentClaimIds: ['caller-forged'],
        } as typeof child & { payload: unknown }),
      'CLAIM_SCHEMA_INVALID',
      'failed schema validation'
    );
    expect(journal.readRuntimeEvents()).toEqual(beforeSubstitution);
    const terminal = journal.completeAttempt({
      ...child,
      payload: { value: 'ready' },
      claim: 'caller.substitution@99',
      schema: { not: {} },
      producerCheckId: 'caller',
      parentClaimIds: ['caller-forged'],
    } as typeof child & { payload: unknown });

    expect(scheduled.claimIds).toEqual([parentTerminal.claims[0].claimId]);
    expect(terminal.claims[0]).toMatchObject({
      claim: 'fixture.child@1',
      producerCheckId: 'child',
      parentClaimIds: [parentTerminal.claims[0].claimId],
    });
  });

  it.each([
    { name: 'wrong', claimIds: ['wrong'] },
    { name: 'missing', claimIds: [] },
    { name: 'extra', claimIds: ['ACTIVE', 'extra'] },
    { name: 'duplicate', claimIds: ['ACTIVE', 'ACTIVE'] },
  ])('rejects $name scheduled claim IDs in live reduction and replay', ({ claimIds }) => {
    const plan = singleClaimPlan();
    const journal = new ExecutionJournal(plan);
    const producer = journal.startAttempt({ sessionId: 's1', checkId: 'producer', scope: [] });
    journal.scheduleCheck(producer);
    const terminal = journal.completeAttempt({ ...producer, payload: { value: 'ready' } });
    const consumer = journal.startAttempt({ sessionId: 's1', checkId: 'consumer', scope: [] });
    const active = terminal.claims[0].claimId;
    const forged: CheckScheduledEvent = {
      version: 1,
      type: 'CheckScheduled',
      eventId: journal.getClaimProjection().lastEventId + 1,
      sessionId: consumer.sessionId,
      checkId: consumer.checkId,
      scope: [],
      attemptId: consumer.attemptId,
      fence: consumer.fence,
      claimIds: claimIds.map(value => (value === 'ACTIVE' ? active : value)),
    };
    expectClaimError(
      () => reduceClaimEvent(journal.getClaimProjection(), forged, plan),
      'INVALID_SCHEDULED_CLAIMS',
      'exact declared active claims'
    );
    expectClaimError(
      () => replayClaimEvents([...journal.readRuntimeEvents(), forged], plan),
      'INVALID_SCHEDULED_CLAIMS',
      'exact declared active claims'
    );
  });

  it('rejects an inactive older-generation scheduled claim in live reduction and replay', () => {
    const plan = singleClaimPlan();
    const journal = new ExecutionJournal(plan);
    const first = journal.startAttempt({ sessionId: 's1', checkId: 'producer', scope: [] });
    journal.scheduleCheck(first);
    const oldClaim = journal.completeAttempt({ ...first, payload: { value: 'ready' } }).claims[0];
    const second = journal.startAttempt({ sessionId: 's1', checkId: 'producer', scope: [] });
    journal.scheduleCheck(second);
    const activeClaim = journal.completeAttempt({ ...second, payload: { value: 'ready' } }).claims[0];
    expect(activeClaim.claimId).not.toBe(oldClaim.claimId);
    const consumer = journal.startAttempt({ sessionId: 's1', checkId: 'consumer', scope: [] });
    const forged: CheckScheduledEvent = {
      version: 1,
      type: 'CheckScheduled',
      eventId: journal.getClaimProjection().lastEventId + 1,
      sessionId: consumer.sessionId,
      checkId: consumer.checkId,
      scope: [],
      attemptId: consumer.attemptId,
      fence: consumer.fence,
      claimIds: [oldClaim.claimId],
    };
    expectClaimError(
      () => reduceClaimEvent(journal.getClaimProjection(), forged, plan),
      'INVALID_SCHEDULED_CLAIMS',
      'exact declared active claims'
    );
    expectClaimError(
      () => replayClaimEvents([...journal.readRuntimeEvents(), forged], plan),
      'INVALID_SCHEDULED_CLAIMS',
      'exact declared active claims'
    );
  });

  it('deeply isolates authored inputs, appended events, returned events, and projections', () => {
    const authored: any = {
      version: '1.0',
      claim_types: { 'fixture.ready@1': { schema: JSON.parse(JSON.stringify(schema)) } },
      checks: {
        producer: { type: 'noop', emits: [{ claim: 'fixture.ready@1', from: 'output' }] },
        consumer: {
          type: 'noop',
          consumes: [{ claim: 'fixture.ready@1', cardinality: 'one' }],
        },
      },
    };
    const plan = compileClaimPlan(authored);
    const journal = new ExecutionJournal(plan);
    authored.claim_types['fixture.ready@1'].schema.properties.value.const = 'corrupted';

    const scope: Array<{ check: string; index: number }> = [];
    const payload = { value: 'ready' };
    const attempt = journal.startAttempt({ sessionId: 's1', checkId: 'producer', scope });
    journal.scheduleCheck(attempt);
    journal.completeAttempt({ ...attempt, payload });
    payload.value = 'corrupted';
    scope.push({ check: 'caller', index: 1 });

    const events: any = journal.readRuntimeEvents();
    const projection: any = journal.getClaimProjection();
    expect(Object.isFrozen(events)).toBe(true);
    expect(Object.isFrozen(events[2].payload)).toBe(true);
    expect(Object.isFrozen(projection)).toBe(true);
    try {
      events[2].payload.value = 'mutated';
      events.push({ type: 'forged' });
      projection.activeClaimIdsByRef['fixture.ready@1'] = 'forged';
    } catch {}

    const reread = journal.readRuntimeEvents();
    expect((reread[2] as any).payload).toEqual({ value: 'ready' });
    expect(journal.readCheckClaims('consumer')['fixture.ready@1'].payload).toEqual({
      value: 'ready',
    });
    expect(journal.replayClaimProjection()).toEqual(journal.getClaimProjection());
  });

  it('requires fences to advance after both completed and failed attempts', () => {
    const plan = singleClaimPlan();
    const journal = new ExecutionJournal(plan);
    const first = journal.startAttempt({ sessionId: 's1', checkId: 'producer', scope: [] });
    journal.scheduleCheck(first);
    journal.completeAttempt({ ...first, payload: { value: 'ready' } });

    const staleAfterCompletion: AttemptStartedEvent = {
      ...first,
      eventId: journal.getClaimProjection().lastEventId + 1,
    };
    expectClaimError(
      () => reduceClaimEvent(journal.getClaimProjection(), staleAfterCompletion, plan),
      'STALE_FENCE',
      'advance monotonically'
    );
    const second = journal.startAttempt({ sessionId: 's1', checkId: 'producer', scope: [] });
    expect(second.fence).toBeGreaterThan(first.fence);
    journal.failAttempt({ ...second, reason: 'TEST_FAILURE' });

    const staleAfterFailure: AttemptStartedEvent = {
      ...second,
      eventId: journal.getClaimProjection().lastEventId + 1,
    };
    expectClaimError(
      () => replayClaimEvents([...journal.readRuntimeEvents(), staleAfterFailure], plan),
      'STALE_FENCE',
      'advance monotonically'
    );
    const third = journal.startAttempt({ sessionId: 's1', checkId: 'producer', scope: [] });
    expect(third.fence).toBeGreaterThan(second.fence);
  });

  it('rejects stale-fence atomic publication without changing journal truth', () => {
    const plan = singleClaimPlan();
    const journal = new ExecutionJournal(plan);
    const stale = journal.startAttempt({ sessionId: 's1', checkId: 'producer', scope: [] });
    journal.scheduleCheck(stale);
    const current = journal.startAttempt({ sessionId: 's1', checkId: 'producer', scope: [] });
    journal.scheduleCheck(current);
    const beforeEvents = journal.readRuntimeEvents();
    const beforeProjection = journal.getClaimProjection();
    expectClaimError(
      () => journal.completeAttempt({ ...stale, payload: { value: 'ready' } }),
      'STALE_FENCE',
      'is not current'
    );
    expect(journal.readRuntimeEvents()).toEqual(beforeEvents);
    expect(journal.getClaimProjection()).toEqual(beforeProjection);
    journal.completeAttempt({ ...current, payload: { value: 'ready' } });
  });
});
