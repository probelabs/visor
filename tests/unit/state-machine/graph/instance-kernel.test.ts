import { sha256Canonical } from '../../../../src/state-machine/graph/claim-kernel';
import {
  canonicalCatalogKey,
  createInitialInstanceProjection,
  deriveCatalogRequestId,
  deriveControllerItemClaimId,
  deriveItemFingerprint,
  deriveNodeGenerationId,
  deriveNodeInstanceId,
  deriveSubgraphInstanceId,
  InstanceKernelError,
  queryReadyGenerations,
  reduceInstanceEvent,
  replayInstanceEvents,
  requireKeyedScopePath,
  validateTaggedScopePath,
  type ControllerItemClaimPublishedEvent,
  type GeneratedAttemptCompletedEvent,
  type GeneratedAttemptStartedEvent,
  type GeneratedCheckScheduledEvent,
  type GeneratedClaimPublishedEvent,
  type InstanceProjection,
  type InstanceRuntimeEvent,
  type KeyedScopePath,
  type NodeGenerationActivatedEvent,
  type NodeGenerationInactivatedEvent,
  type SubgraphExpandedEvent,
  type SubgraphTombstonedEvent,
} from '../../../../src/state-machine/graph/instance-kernel';

const sessionId = 'session-1';
const expansionOwnerCheck = 'discover-components';
const graphSemanticDigest = sha256Canonical({ graph: 1 });
const expansionSpecDigest = sha256Canonical({ expansion: 1 });
const templateDigest = sha256Canonical({ template: 1 });
const catalogClaimId = sha256Canonical({ catalog: 1 });
const itemClaimRef = 'component.item@1';
const outputClaimRef = 'component.onboarded@1';

function expectKernelError(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error(`Expected InstanceKernelError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(InstanceKernelError);
    if (!(error instanceof InstanceKernelError)) throw error;
    expect(error.code).toBe(code);
  }
}

function instanceIdentity(itemKey = 'A') {
  const subgraphInstanceId = deriveSubgraphInstanceId({
    graphSemanticDigest,
    expansionOwnerCheck,
    parentSubgraphInstanceId: null,
    templateDigest,
    itemKey,
  });
  const scope: KeyedScopePath = [
    { kind: 'keyed', expansionOwnerCheck, key: itemKey, subgraphInstanceId },
  ];
  const nodeInstanceId = deriveNodeInstanceId({
    subgraphInstanceId,
    templateNodeKey: 'inspect',
  });
  return { itemKey, subgraphInstanceId, scope, nodeInstanceId };
}

function expanded(eventId = 1, itemKey = 'A'): SubgraphExpandedEvent {
  const identity = instanceIdentity(itemKey);
  return {
    version: 1,
    type: 'SubgraphExpanded',
    eventId,
    sessionId,
    scope: identity.scope,
    expansionOwnerCheck,
    graphSemanticDigest,
    expansionSpecDigest,
    templateDigest,
    parentSubgraphInstanceId: null,
    catalogClaimId,
    itemKey,
    subgraphInstanceId: identity.subgraphInstanceId,
    nodeInstanceIdsByTemplateNode: { inspect: identity.nodeInstanceId },
  };
}

function itemPublished(
  eventId: number,
  payload: { id: string; revision: number },
  incarnation: number,
  introducingCatalogClaimId = catalogClaimId
): ControllerItemClaimPublishedEvent {
  const identity = instanceIdentity(payload.id);
  const payloadFingerprint = deriveItemFingerprint(payload);
  const claimId = deriveControllerItemClaimId({
    claim: itemClaimRef,
    payloadFingerprint,
    expansionSpecDigest,
    catalogClaimId: introducingCatalogClaimId,
    subgraphInstanceId: identity.subgraphInstanceId,
    incarnation,
    scope: identity.scope,
  });
  return {
    version: 1,
    type: 'ControllerItemClaimPublished',
    eventId,
    sessionId,
    scope: identity.scope,
    expansionOwnerCheck,
    expansionSpecDigest,
    catalogClaimId: introducingCatalogClaimId,
    itemKey: payload.id,
    subgraphInstanceId: identity.subgraphInstanceId,
    incarnation,
    claimId,
    claim: itemClaimRef,
    payload,
    payloadFingerprint,
    parentClaimIds: [introducingCatalogClaimId],
  };
}

function activated(
  eventId: number,
  item: ControllerItemClaimPublishedEvent
): NodeGenerationActivatedEvent {
  const identity = instanceIdentity(item.itemKey);
  const executionConfigDigest = sha256Canonical({ check: 'inspect', revision: 1 });
  const activeInputClaimIds = [item.claimId];
  const nodeGenerationId = deriveNodeGenerationId({
    nodeInstanceId: identity.nodeInstanceId,
    incarnation: item.incarnation,
    itemFingerprint: item.payloadFingerprint,
    executionConfigDigest,
    activeInputClaimIds,
  });
  return {
    version: 1,
    type: 'NodeGenerationActivated',
    eventId,
    sessionId,
    scope: identity.scope,
    subgraphInstanceId: identity.subgraphInstanceId,
    nodeInstanceId: identity.nodeInstanceId,
    nodeGenerationId,
    templateNodeKey: 'inspect',
    checkId: 'inspect',
    incarnation: item.incarnation,
    itemFingerprint: item.payloadFingerprint,
    executionConfigDigest,
    activeInputClaimIds,
  };
}

function successfulGeneration(
  firstEventId: number,
  activation: NodeGenerationActivatedEvent
): readonly [
  GeneratedAttemptStartedEvent,
  GeneratedCheckScheduledEvent,
  GeneratedClaimPublishedEvent,
  GeneratedAttemptCompletedEvent,
] {
  const attemptId = sha256Canonical({ generation: activation.nodeGenerationId, attempt: 1 });
  const started: GeneratedAttemptStartedEvent = {
    version: 1,
    type: 'AttemptStarted',
    eventId: firstEventId,
    sessionId,
    scope: activation.scope,
    checkId: activation.checkId,
    attemptId,
    fence: 1,
    nodeInstanceId: activation.nodeInstanceId,
    nodeGenerationId: activation.nodeGenerationId,
  };
  const scheduled: GeneratedCheckScheduledEvent = {
    ...started,
    type: 'CheckScheduled',
    eventId: firstEventId + 1,
    claimIds: activation.activeInputClaimIds,
  };
  const payload = { id: activation.scope[0].key, inspected: true };
  const payloadFingerprint = sha256Canonical(payload);
  const claimId = sha256Canonical({
    claim: outputClaimRef,
    payloadFingerprint,
    producerCheckId: activation.checkId,
    scope: activation.scope,
    attemptId,
    fence: 1,
    parentClaimIds: [...activation.activeInputClaimIds].sort(),
  });
  const published: GeneratedClaimPublishedEvent = {
    ...started,
    type: 'ClaimPublished',
    eventId: firstEventId + 2,
    claimId,
    claim: outputClaimRef,
    payload,
    payloadFingerprint,
    producerCheckId: activation.checkId,
    parentClaimIds: activation.activeInputClaimIds,
  };
  const completed: GeneratedAttemptCompletedEvent = {
    ...started,
    type: 'AttemptCompleted',
    eventId: firstEventId + 3,
  };
  return [started, scheduled, published, completed];
}

describe('Graph v2 C2 instance kernel', () => {
  it('uses tagged scopes and rejects ambiguous, extra, mixed, and malformed segments', () => {
    expect(validateTaggedScopePath([])).toEqual([]);
    expect(
      validateTaggedScopePath([
        { kind: 'indexed', check: 'matrix', index: 0 },
        { kind: 'indexed', check: 'nested', index: 2 },
      ])
    ).toHaveLength(2);
    expect(requireKeyedScopePath(instanceIdentity().scope)).toEqual(instanceIdentity().scope);

    for (const invalid of [
      [{ check: 'legacy-untagged', index: 0 }],
      [{ kind: 'indexed', check: 'x', index: 0, extra: true }],
      [{ kind: 'indexed', check: 'x', index: Number.MAX_SAFE_INTEGER + 1 }],
      [
        { kind: 'indexed', check: 'x', index: 0 },
        instanceIdentity().scope[0],
      ],
      [instanceIdentity().scope[0], instanceIdentity().scope[0]],
    ]) {
      expectKernelError(() => validateTaggedScopePath(invalid), 'INVALID_SCOPE');
    }
  });

  it('derives reorder-stable instance/node identities and canonical item keys', () => {
    const aBefore = instanceIdentity('A');
    const bBefore = instanceIdentity('B');
    const reordered = [instanceIdentity('B'), instanceIdentity('A')];
    expect(reordered[1]).toEqual(aBefore);
    expect(reordered[0]).toEqual(bBefore);
    expect(canonicalCatalogKey(1)).toBe('1');
    expect(canonicalCatalogKey('1')).toBe('1');
    expect(canonicalCatalogKey(-0)).toBe('0');
    expectKernelError(() => canonicalCatalogKey(''), 'INVALID_ITEM_KEY');
  });

  it('replays expansion, controller claim, activation, and bound generated lifecycle immutably', () => {
    const item = itemPublished(2, { id: 'A', revision: 1 }, 1);
    const activation = activated(3, item);
    const lifecycle = successfulGeneration(4, activation);
    const events: InstanceRuntimeEvent[] = [expanded(), item, activation, ...lifecycle];
    const live = events.reduce(reduceInstanceEvent, createInitialInstanceProjection());

    expect(queryReadyGenerations(live)).toEqual([]);
    expect(live.instancesById[item.subgraphInstanceId]).toMatchObject({
      status: 'active',
      incarnation: 1,
      activeItemClaimId: item.claimId,
    });
    expect(live.generationsById[activation.nodeGenerationId]).toMatchObject({
      status: 'completed',
      scheduled: true,
      completedOutputClaimIds: [lifecycle[2].claimId],
    });
    expect(live.claimsById[lifecycle[2].claimId]).toMatchObject({
      active: true,
      nodeGenerationId: activation.nodeGenerationId,
      parentClaimIds: [item.claimId],
    });
    expect(replayInstanceEvents(events)).toEqual(live);
    expect(Object.isFrozen(live)).toBe(true);
    expect(Object.isFrozen(live.generationsById[activation.nodeGenerationId])).toBe(true);
    expect(Object.isFrozen(live.claimsById[item.claimId].payload)).toBe(true);
  });

  it('inactivates one incarnation exactly and activates only its replacement', () => {
    const firstItem = itemPublished(2, { id: 'A', revision: 1 }, 1);
    const firstActivation = activated(3, firstItem);
    const lifecycle = successfulGeneration(4, firstActivation);
    let projection = replayInstanceEvents([expanded(), firstItem, firstActivation, ...lifecycle]);
    const inactivated: NodeGenerationInactivatedEvent = {
      version: 1,
      type: 'NodeGenerationInactivated',
      eventId: 8,
      sessionId,
      scope: firstActivation.scope,
      subgraphInstanceId: firstActivation.subgraphInstanceId,
      nodeInstanceId: firstActivation.nodeInstanceId,
      nodeGenerationId: firstActivation.nodeGenerationId,
      incarnation: 1,
      outputClaimIds: [lifecycle[2].claimId],
      reason: 'superseded',
    };
    projection = reduceInstanceEvent(projection, inactivated);
    const nextCatalogClaimId = sha256Canonical({ catalog: 2 });
    const secondItem = itemPublished(9, { id: 'A', revision: 2 }, 2, nextCatalogClaimId);
    projection = reduceInstanceEvent(projection, secondItem);
    const secondActivation = activated(10, secondItem);
    projection = reduceInstanceEvent(projection, secondActivation);

    expect(firstActivation.nodeInstanceId).toBe(secondActivation.nodeInstanceId);
    expect(firstActivation.nodeGenerationId).not.toBe(secondActivation.nodeGenerationId);
    expect(projection.generationsById[firstActivation.nodeGenerationId].status).toBe('inactive');
    expect(projection.claimsById[firstItem.claimId].active).toBe(false);
    expect(projection.claimsById[lifecycle[2].claimId].active).toBe(false);
    expect(queryReadyGenerations(projection).map(value => value.nodeGenerationId)).toEqual([
      secondActivation.nodeGenerationId,
    ]);
  });

  it('tombstones without deleting history and fails closed on key re-add', () => {
    const item = itemPublished(2, { id: 'A', revision: 1 }, 1);
    const activation = activated(3, item);
    const lifecycle = successfulGeneration(4, activation);
    let projection = replayInstanceEvents([expanded(), item, activation, ...lifecycle]);
    const tombstone: SubgraphTombstonedEvent = {
      version: 1,
      type: 'SubgraphTombstoned',
      eventId: 8,
      sessionId,
      scope: activation.scope,
      expansionOwnerCheck,
      sourceCatalogClaimId: sha256Canonical({ catalog: 'remove' }),
      itemKey: 'A',
      subgraphInstanceId: activation.subgraphInstanceId,
      lastIncarnation: 1,
      nodeGenerationIds: [activation.nodeGenerationId],
      outputClaimIds: [lifecycle[2].claimId],
    };
    projection = reduceInstanceEvent(projection, tombstone);
    expect(projection.instancesById[activation.subgraphInstanceId].status).toBe('tombstoned');
    expect(projection.generationsById[activation.nodeGenerationId].status).toBe('inactive');
    expect(projection.claimsById[lifecycle[2].claimId].active).toBe(false);
    expectKernelError(() => reduceInstanceEvent(projection, expanded(9)), 'TOMBSTONED_KEY_READD_UNSUPPORTED');
  });

  it('keeps catalog requests FIFO and behind every ready or running generation', () => {
    const item = itemPublished(2, { id: 'A', revision: 1 }, 1);
    const activation = activated(3, item);
    let projection = replayInstanceEvents([expanded(), item, activation]);
    const requestId = deriveCatalogRequestId({
      sessionId,
      expansionOwnerCheck,
      ordinal: 1,
    });
    projection = reduceInstanceEvent(projection, {
      version: 1,
      type: 'CatalogReconciliationRequested',
      eventId: 4,
      sessionId,
      scope: [],
      requestId,
      requestOrdinal: 1,
      expansionOwnerCheck,
      status: 'pending',
    });
    const requestStart = {
      version: 1 as const,
      type: 'AttemptStarted' as const,
      eventId: 5,
      sessionId,
      scope: [] as const,
      requestId,
      checkId: expansionOwnerCheck,
      attemptId: sha256Canonical({ requestId, attempt: 1 }),
      fence: 2,
    };
    expectKernelError(
      () => reduceInstanceEvent(projection, requestStart),
      'GENERATED_WORK_PRECEDES_REQUEST'
    );
    expect(projection.requestsById[requestId].status).toBe('pending');
  });

  it('does not start a later FIFO request while its predecessor is running', () => {
    let projection = createInitialInstanceProjection();
    const ids = [1, 2].map(ordinal => deriveCatalogRequestId({
      sessionId, expansionOwnerCheck, ordinal,
    }));
    for (let index = 0; index < ids.length; index++) {
      projection = reduceInstanceEvent(projection, {
        version: 1, type: 'CatalogReconciliationRequested', eventId: index + 1,
        sessionId, scope: [], requestId: ids[index], requestOrdinal: index + 1,
        expansionOwnerCheck, status: 'pending',
      });
    }
    projection = reduceInstanceEvent(projection, {
      version: 1, type: 'AttemptStarted', eventId: 3, sessionId, scope: [],
      requestId: ids[0], checkId: expansionOwnerCheck,
      attemptId: sha256Canonical({ requestId: ids[0], attempt: 1 }), fence: 1,
    });
    expectKernelError(() => reduceInstanceEvent(projection, {
      version: 1, type: 'AttemptStarted', eventId: 4, sessionId, scope: [],
      requestId: ids[1], checkId: expansionOwnerCheck,
      attemptId: sha256Canonical({ requestId: ids[1], attempt: 1 }), fence: 2,
    }), 'GENERATED_WORK_PRECEDES_REQUEST');
  });

  it('rejects stale, cross-instance, and caller-forged lifecycle bindings without mutation', () => {
    const item = itemPublished(2, { id: 'A', revision: 1 }, 1);
    const activation = activated(3, item);
    const projection = replayInstanceEvents([expanded(), item, activation]);
    const before: InstanceProjection = projection;
    const [started, scheduled] = successfulGeneration(4, activation);
    expectKernelError(
      () => reduceInstanceEvent(projection, { ...started, nodeInstanceId: sha256Canonical('forged') }),
      'INVALID_GENERATION_BINDING'
    );
    expectKernelError(
      () => reduceInstanceEvent(reduceInstanceEvent(projection, started), { ...scheduled, claimIds: [] }),
      'INVALID_SCHEDULED_CLAIMS'
    );
    expect(projection).toBe(before);
    expect(projection.generationsById[activation.nodeGenerationId].status).toBe('ready');
  });
});
