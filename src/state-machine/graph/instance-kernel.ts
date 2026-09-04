import {
  canonicalJson,
  immutableCanonicalValue,
  sha256Canonical,
} from './claim-kernel';

export interface IndexedScopeSegment {
  readonly kind: 'indexed';
  readonly check: string;
  readonly index: number;
}

export interface KeyedScopeSegment {
  readonly kind: 'keyed';
  readonly expansionOwnerCheck: string;
  readonly key: string;
  readonly subgraphInstanceId: string;
}

export type TaggedScopeSegment = IndexedScopeSegment | KeyedScopeSegment;
export type TaggedScopePath = readonly TaggedScopeSegment[];
export type RootScopePath = readonly [];
export type KeyedScopePath = readonly [KeyedScopeSegment];

export type NodeGenerationStatus = 'ready' | 'running' | 'completed' | 'failed' | 'inactive';
export type CatalogRequestStatus = 'pending' | 'running' | 'completed' | 'failed';

export class InstanceKernelError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'InstanceKernelError';
    this.code = code;
  }
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function requireNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InstanceKernelError('INVALID_SCOPE', `${label} must be a non-empty string`);
  }
}

/** Canonical catalog keys deliberately collapse a number and its string form. */
export function canonicalCatalogKey(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return canonicalJson(value);
  throw new InstanceKernelError(
    'INVALID_ITEM_KEY',
    'Catalog item key must be a non-empty string or finite number'
  );
}

/**
 * Validate and clone a tagged scope. Root and legacy indexed paths are valid;
 * a C2 keyed path is exactly one root-child segment. Mixed paths fail closed.
 */
export function validateTaggedScopePath(value: unknown): TaggedScopePath {
  if (!Array.isArray(value)) {
    throw new InstanceKernelError('INVALID_SCOPE', 'Scope path must be an array');
  }
  if (value.length === 0) return Object.freeze([]);

  const segments: TaggedScopeSegment[] = value.map((candidate, position) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new InstanceKernelError('INVALID_SCOPE', `Scope segment ${position} must be an object`);
    }
    const segment = candidate as Record<string, unknown>;
    if (segment.kind === 'indexed') {
      if (!hasExactKeys(segment, ['kind', 'check', 'index'])) {
        throw new InstanceKernelError('INVALID_SCOPE', 'Indexed scope segment has unknown fields');
      }
      requireNonEmpty(segment.check, 'Indexed scope check');
      if (
        typeof segment.index !== 'number' ||
        !Number.isSafeInteger(segment.index) ||
        segment.index < 0
      ) {
        throw new InstanceKernelError(
          'INVALID_SCOPE',
          'Indexed scope index must be a safe non-negative integer'
        );
      }
      return Object.freeze({ kind: 'indexed', check: segment.check, index: segment.index });
    }
    if (segment.kind === 'keyed') {
      if (
        !hasExactKeys(segment, [
          'kind',
          'expansionOwnerCheck',
          'key',
          'subgraphInstanceId',
        ])
      ) {
        throw new InstanceKernelError('INVALID_SCOPE', 'Keyed scope segment has unknown fields');
      }
      requireNonEmpty(segment.expansionOwnerCheck, 'Keyed scope expansion owner');
      requireNonEmpty(segment.key, 'Keyed scope key');
      if (typeof segment.subgraphInstanceId !== 'string' || !SHA256_PATTERN.test(segment.subgraphInstanceId)) {
        throw new InstanceKernelError(
          'INVALID_SCOPE',
          'Keyed scope subgraph instance ID must be lowercase SHA-256'
        );
      }
      return Object.freeze({
        kind: 'keyed',
        expansionOwnerCheck: segment.expansionOwnerCheck,
        key: segment.key,
        subgraphInstanceId: segment.subgraphInstanceId,
      });
    }
    throw new InstanceKernelError('INVALID_SCOPE', `Scope segment ${position} is not tagged`);
  });

  const kinds = new Set(segments.map(segment => segment.kind));
  if (kinds.size !== 1) {
    throw new InstanceKernelError('INVALID_SCOPE', 'Indexed and keyed scope segments cannot mix');
  }
  if (segments[0].kind === 'keyed' && segments.length !== 1) {
    throw new InstanceKernelError('INVALID_SCOPE', 'C2 supports exactly one keyed scope segment');
  }
  return Object.freeze(segments);
}

export function requireRootScopePath(value: unknown): RootScopePath {
  const scope = validateTaggedScopePath(value);
  if (scope.length !== 0) {
    throw new InstanceKernelError('INVALID_SCOPE', 'Expected exact root scope');
  }
  return scope as RootScopePath;
}

export function requireKeyedScopePath(
  value: unknown,
  expected?: {
    readonly expansionOwnerCheck: string;
    readonly key: string;
    readonly subgraphInstanceId: string;
  }
): KeyedScopePath {
  const scope = validateTaggedScopePath(value);
  if (scope.length !== 1 || scope[0].kind !== 'keyed') {
    throw new InstanceKernelError('INVALID_SCOPE', 'Expected exact C2 keyed scope');
  }
  const segment = scope[0];
  if (
    expected &&
    (segment.expansionOwnerCheck !== expected.expansionOwnerCheck ||
      segment.key !== expected.key ||
      segment.subgraphInstanceId !== expected.subgraphInstanceId)
  ) {
    throw new InstanceKernelError(
      'INVALID_SCOPE',
      'Keyed scope does not match its projected owner, key, and instance ID'
    );
  }
  return scope as KeyedScopePath;
}

export function scopePathEquals(left: unknown, right: unknown): boolean {
  return canonicalJson(validateTaggedScopePath(left)) === canonicalJson(validateTaggedScopePath(right));
}

export function deriveSubgraphInstanceId(input: {
  readonly graphSemanticDigest: string;
  readonly expansionOwnerCheck: string;
  readonly parentSubgraphInstanceId: null;
  readonly templateDigest: string;
  readonly itemKey: string;
}): string {
  return sha256Canonical({ v: 1, ...input });
}

export function deriveNodeInstanceId(input: {
  readonly subgraphInstanceId: string;
  readonly templateNodeKey: string;
}): string {
  return sha256Canonical({ v: 1, ...input });
}

export function deriveItemFingerprint(payload: unknown): string {
  return sha256Canonical(payload);
}

export function deriveNodeGenerationId(input: {
  readonly nodeInstanceId: string;
  readonly incarnation: number;
  readonly itemFingerprint: string;
  readonly executionConfigDigest: string;
  readonly activeInputClaimIds: readonly string[];
}): string {
  return sha256Canonical({
    v: 1,
    nodeInstanceId: input.nodeInstanceId,
    incarnation: input.incarnation,
    itemFingerprint: input.itemFingerprint,
    executionConfigDigest: input.executionConfigDigest,
    activeInputClaimIds: [...input.activeInputClaimIds].sort(),
  });
}

export function deriveControllerItemClaimId(input: {
  readonly claim: string;
  readonly payloadFingerprint: string;
  readonly expansionSpecDigest: string;
  readonly catalogClaimId: string;
  readonly subgraphInstanceId: string;
  readonly incarnation: number;
  readonly scope: KeyedScopePath;
}): string {
  return sha256Canonical({ v: 1, type: 'controller-item', ...input });
}

export function deriveCatalogRequestId(input: {
  readonly sessionId: string;
  readonly expansionOwnerCheck: string;
  readonly ordinal: number;
}): string {
  return sha256Canonical({ v: 1, type: 'catalog-reconciliation', ...input });
}

interface InstanceEventBase {
  readonly version: 1;
  readonly eventId: number;
  readonly sessionId: string;
  readonly scope: TaggedScopePath;
}

export interface CatalogReconciliationRequestedEvent extends InstanceEventBase {
  readonly type: 'CatalogReconciliationRequested';
  readonly scope: RootScopePath;
  readonly requestId: string;
  readonly requestOrdinal: number;
  readonly expansionOwnerCheck: string;
  readonly status: 'pending';
}

export interface SubgraphExpandedEvent extends InstanceEventBase {
  readonly type: 'SubgraphExpanded';
  readonly scope: KeyedScopePath;
  readonly expansionOwnerCheck: string;
  readonly graphSemanticDigest: string;
  readonly expansionSpecDigest: string;
  readonly templateDigest: string;
  readonly parentSubgraphInstanceId: null;
  readonly catalogClaimId: string;
  readonly itemKey: string;
  readonly subgraphInstanceId: string;
  readonly nodeInstanceIdsByTemplateNode: Readonly<Record<string, string>>;
}

export interface ControllerItemClaimPublishedEvent extends InstanceEventBase {
  readonly type: 'ControllerItemClaimPublished';
  readonly scope: KeyedScopePath;
  readonly expansionOwnerCheck: string;
  readonly expansionSpecDigest: string;
  readonly catalogClaimId: string;
  readonly itemKey: string;
  readonly subgraphInstanceId: string;
  readonly incarnation: number;
  readonly claimId: string;
  readonly claim: string;
  readonly payload: unknown;
  readonly payloadFingerprint: string;
  readonly parentClaimIds: readonly [string];
}

export interface NodeGenerationInactivatedEvent extends InstanceEventBase {
  readonly type: 'NodeGenerationInactivated';
  readonly scope: KeyedScopePath;
  readonly subgraphInstanceId: string;
  readonly nodeInstanceId: string;
  readonly nodeGenerationId: string;
  readonly incarnation: number;
  readonly outputClaimIds: readonly string[];
  readonly reason: 'superseded';
}

export interface NodeGenerationActivatedEvent extends InstanceEventBase {
  readonly type: 'NodeGenerationActivated';
  readonly scope: KeyedScopePath;
  readonly subgraphInstanceId: string;
  readonly nodeInstanceId: string;
  readonly nodeGenerationId: string;
  readonly templateNodeKey: string;
  readonly checkId: string;
  readonly incarnation: number;
  readonly itemFingerprint: string;
  readonly executionConfigDigest: string;
  readonly activeInputClaimIds: readonly string[];
}

export interface SubgraphTombstonedEvent extends InstanceEventBase {
  readonly type: 'SubgraphTombstoned';
  readonly scope: KeyedScopePath;
  readonly expansionOwnerCheck: string;
  readonly sourceCatalogClaimId: string;
  readonly itemKey: string;
  readonly subgraphInstanceId: string;
  readonly lastIncarnation: number;
  readonly nodeGenerationIds: readonly string[];
  readonly outputClaimIds: readonly string[];
}

interface BoundAttemptEventBase extends InstanceEventBase {
  readonly checkId: string;
  readonly attemptId: string;
  readonly fence: number;
}

export interface GeneratedAttemptStartedEvent extends BoundAttemptEventBase {
  readonly type: 'AttemptStarted';
  readonly scope: KeyedScopePath;
  readonly nodeInstanceId: string;
  readonly nodeGenerationId: string;
}

export interface GeneratedCheckScheduledEvent extends BoundAttemptEventBase {
  readonly type: 'CheckScheduled';
  readonly scope: KeyedScopePath;
  readonly nodeInstanceId: string;
  readonly nodeGenerationId: string;
  readonly claimIds: readonly string[];
}

export interface GeneratedClaimPublishedEvent extends BoundAttemptEventBase {
  readonly type: 'ClaimPublished';
  readonly scope: KeyedScopePath;
  readonly nodeInstanceId: string;
  readonly nodeGenerationId: string;
  readonly claimId: string;
  readonly claim: string;
  readonly payload: unknown;
  readonly payloadFingerprint: string;
  readonly producerCheckId: string;
  readonly parentClaimIds: readonly string[];
}

export interface GeneratedAttemptCompletedEvent extends BoundAttemptEventBase {
  readonly type: 'AttemptCompleted';
  readonly scope: KeyedScopePath;
  readonly nodeInstanceId: string;
  readonly nodeGenerationId: string;
}

export interface GeneratedAttemptFailedEvent extends BoundAttemptEventBase {
  readonly type: 'AttemptFailed';
  readonly scope: KeyedScopePath;
  readonly nodeInstanceId: string;
  readonly nodeGenerationId: string;
  readonly reason: string;
}

export interface CatalogRequestAttemptStartedEvent extends BoundAttemptEventBase {
  readonly type: 'AttemptStarted';
  readonly scope: RootScopePath;
  readonly requestId: string;
}

export interface CatalogRequestCheckScheduledEvent extends BoundAttemptEventBase {
  readonly type: 'CheckScheduled';
  readonly scope: RootScopePath;
  readonly requestId: string;
  readonly claimIds: readonly string[];
}

export interface CatalogRequestAttemptCompletedEvent extends BoundAttemptEventBase {
  readonly type: 'AttemptCompleted';
  readonly scope: RootScopePath;
  readonly requestId: string;
}

export interface CatalogRequestAttemptFailedEvent extends BoundAttemptEventBase {
  readonly type: 'AttemptFailed';
  readonly scope: RootScopePath;
  readonly requestId: string;
  readonly reason: string;
}

export type InstanceRuntimeEvent =
  | CatalogReconciliationRequestedEvent
  | SubgraphExpandedEvent
  | ControllerItemClaimPublishedEvent
  | NodeGenerationInactivatedEvent
  | NodeGenerationActivatedEvent
  | SubgraphTombstonedEvent
  | GeneratedAttemptStartedEvent
  | GeneratedCheckScheduledEvent
  | GeneratedClaimPublishedEvent
  | GeneratedAttemptCompletedEvent
  | GeneratedAttemptFailedEvent
  | CatalogRequestAttemptStartedEvent
  | CatalogRequestCheckScheduledEvent
  | CatalogRequestAttemptCompletedEvent
  | CatalogRequestAttemptFailedEvent;

export interface CatalogRequestProjection {
  readonly requestId: string;
  readonly requestOrdinal: number;
  readonly sessionId: string;
  readonly expansionOwnerCheck: string;
  readonly status: CatalogRequestStatus;
  readonly attemptId?: string;
  readonly fence?: number;
  readonly reason?: string;
}

export interface SubgraphInstanceProjection {
  readonly sessionId: string;
  readonly expansionOwnerCheck: string;
  readonly graphSemanticDigest: string;
  readonly expansionSpecDigest: string;
  readonly templateDigest: string;
  readonly itemKey: string;
  readonly subgraphInstanceId: string;
  readonly scope: KeyedScopePath;
  readonly catalogClaimId: string;
  readonly nodeInstanceIdsByTemplateNode: Readonly<Record<string, string>>;
  readonly status: 'active' | 'tombstoned';
  readonly incarnation: number;
  readonly activeItemClaimId?: string;
  readonly tombstoneCatalogClaimId?: string;
}

export interface NodeInstanceProjection {
  readonly nodeInstanceId: string;
  readonly subgraphInstanceId: string;
  readonly templateNodeKey: string;
  readonly scope: KeyedScopePath;
}

export interface NodeGenerationProjection {
  readonly nodeGenerationId: string;
  readonly nodeInstanceId: string;
  readonly subgraphInstanceId: string;
  readonly templateNodeKey: string;
  readonly checkId: string;
  readonly scope: KeyedScopePath;
  readonly incarnation: number;
  readonly itemFingerprint: string;
  readonly executionConfigDigest: string;
  readonly activeInputClaimIds: readonly string[];
  readonly status: NodeGenerationStatus;
  readonly attemptId?: string;
  readonly fence?: number;
  readonly scheduled: boolean;
  readonly completedOutputClaimIds: readonly string[];
  readonly reason?: string;
}

export interface InstanceClaimProjection {
  readonly claimId: string;
  readonly claim: string;
  readonly payload: unknown;
  readonly payloadFingerprint: string;
  readonly producerCheckId: string;
  readonly producerAttemptId?: string;
  readonly producerFence?: number;
  readonly controllerCatalogClaimId?: string;
  readonly parentClaimIds: readonly string[];
  readonly scope: KeyedScopePath;
  readonly active: boolean;
  readonly kind: 'controller-item' | 'generated-output';
  readonly subgraphInstanceId: string;
  readonly incarnation: number;
  readonly nodeGenerationId?: string;
}

export interface InstanceProjection {
  readonly lastEventId: number;
  readonly requestsById: Readonly<Record<string, CatalogRequestProjection>>;
  readonly requestOrder: readonly string[];
  readonly instancesById: Readonly<Record<string, SubgraphInstanceProjection>>;
  readonly instanceIdByOwnerAndKey: Readonly<Record<string, string>>;
  readonly nodesById: Readonly<Record<string, NodeInstanceProjection>>;
  readonly generationsById: Readonly<Record<string, NodeGenerationProjection>>;
  readonly activeGenerationIdByNode: Readonly<Record<string, string>>;
  readonly claimsById: Readonly<Record<string, InstanceClaimProjection>>;
  readonly attemptBindingsById: Readonly<Record<string, string>>;
}

export function createInitialInstanceProjection(): InstanceProjection {
  return immutableCanonicalValue<InstanceProjection>({
    lastEventId: 0,
    requestsById: {},
    requestOrder: [],
    instancesById: {},
    instanceIdByOwnerAndKey: {},
    nodesById: {},
    generationsById: {},
    activeGenerationIdByNode: {},
    claimsById: {},
    attemptBindingsById: {},
  });
}

export function immutableInstanceEvent<T extends InstanceRuntimeEvent>(event: T): T {
  return immutableCanonicalValue(event);
}

function ownerKey(expansionOwnerCheck: string, itemKey: string): string {
  return canonicalJson([expansionOwnerCheck, itemKey]);
}

function sortedUnique(values: readonly string[], label: string): readonly string[] {
  if (values.some(value => typeof value !== 'string' || value.length === 0)) {
    throw new InstanceKernelError('INVALID_EVENT', `${label} must contain non-empty strings`);
  }
  const sorted = [...values].sort();
  if (new Set(sorted).size !== sorted.length) {
    throw new InstanceKernelError('INVALID_EVENT', `${label} must not contain duplicates`);
  }
  if (values.some((value, index) => value !== sorted[index])) {
    throw new InstanceKernelError('INVALID_EVENT', `${label} must be canonically sorted`);
  }
  return sorted;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function mutableProjection(projection: InstanceProjection): {
  lastEventId: number;
  requestsById: Record<string, CatalogRequestProjection>;
  requestOrder: string[];
  instancesById: Record<string, SubgraphInstanceProjection>;
  instanceIdByOwnerAndKey: Record<string, string>;
  nodesById: Record<string, NodeInstanceProjection>;
  generationsById: Record<string, NodeGenerationProjection>;
  activeGenerationIdByNode: Record<string, string>;
  claimsById: Record<string, InstanceClaimProjection>;
  attemptBindingsById: Record<string, string>;
} {
  return {
    lastEventId: projection.lastEventId,
    requestsById: { ...projection.requestsById },
    requestOrder: [...projection.requestOrder],
    instancesById: { ...projection.instancesById },
    instanceIdByOwnerAndKey: { ...projection.instanceIdByOwnerAndKey },
    nodesById: { ...projection.nodesById },
    generationsById: { ...projection.generationsById },
    activeGenerationIdByNode: { ...projection.activeGenerationIdByNode },
    claimsById: { ...projection.claimsById },
    attemptBindingsById: { ...projection.attemptBindingsById },
  };
}

function requireInstance(
  projection: InstanceProjection,
  subgraphInstanceId: string,
  scope: unknown
): SubgraphInstanceProjection {
  const instance = projection.instancesById[subgraphInstanceId];
  if (!instance || instance.status !== 'active') {
    throw new InstanceKernelError('INACTIVE_INSTANCE', `Instance ${subgraphInstanceId} is not active`);
  }
  requireKeyedScopePath(scope, instance.scope[0]);
  return instance;
}

function requireGeneration(
  projection: InstanceProjection,
  event: { readonly nodeInstanceId: string; readonly nodeGenerationId: string; readonly scope: unknown }
): NodeGenerationProjection {
  const generation = projection.generationsById[event.nodeGenerationId];
  if (
    !generation ||
    generation.nodeInstanceId !== event.nodeInstanceId ||
    !scopePathEquals(generation.scope, event.scope)
  ) {
    throw new InstanceKernelError(
      'INVALID_GENERATION_BINDING',
      `Generation ${event.nodeGenerationId} is not bound to the supplied node and scope`
    );
  }
  if (projection.activeGenerationIdByNode[event.nodeInstanceId] !== event.nodeGenerationId) {
    throw new InstanceKernelError('STALE_GENERATION', `Generation ${event.nodeGenerationId} is inactive`);
  }
  return generation;
}

function requireAttemptBinding(
  projection: InstanceProjection,
  event: BoundAttemptEventBase & { readonly nodeGenerationId?: string; readonly requestId?: string }
): string {
  const binding = projection.attemptBindingsById[event.attemptId];
  const expected = event.nodeGenerationId || event.requestId;
  if (!binding || binding !== expected) {
    throw new InstanceKernelError('INVALID_ATTEMPT_BINDING', `Attempt ${event.attemptId} is misbound`);
  }
  return binding;
}

function hasReadyOrRunningGeneration(projection: InstanceProjection): boolean {
  return Object.values(projection.generationsById).some(
    generation => generation.status === 'ready' || generation.status === 'running'
  );
}

function reduceRequestLifecycle(
  projection: InstanceProjection,
  next: ReturnType<typeof mutableProjection>,
  event:
    | CatalogRequestAttemptStartedEvent
    | CatalogRequestCheckScheduledEvent
    | CatalogRequestAttemptCompletedEvent
    | CatalogRequestAttemptFailedEvent
): void {
  requireRootScopePath(event.scope);
  const request = projection.requestsById[event.requestId];
  if (!request || request.expansionOwnerCheck !== event.checkId || request.sessionId !== event.sessionId) {
    throw new InstanceKernelError('INVALID_REQUEST_BINDING', `Request ${event.requestId} is misbound`);
  }
  if (event.type === 'AttemptStarted') {
    if (request.status !== 'pending') {
      throw new InstanceKernelError('INVALID_REQUEST_STATE', `Request ${event.requestId} is not pending`);
    }
    const oldestNonterminal = projection.requestOrder.find(
      requestId => {
        const status = projection.requestsById[requestId].status;
        return status === 'pending' || status === 'running';
      }
    );
    const hasRunningRequest = Object.values(projection.requestsById).some(
      candidate => candidate.status === 'running'
    );
    if (
      oldestNonterminal !== event.requestId ||
      hasRunningRequest ||
      hasReadyOrRunningGeneration(projection)
    ) {
      throw new InstanceKernelError(
        'GENERATED_WORK_PRECEDES_REQUEST',
        'Catalog request cannot start before older requests or generated work'
      );
    }
    if (projection.attemptBindingsById[event.attemptId]) {
      throw new InstanceKernelError('DUPLICATE_ATTEMPT', `Attempt ${event.attemptId} already exists`);
    }
    next.requestsById[event.requestId] = {
      ...request,
      status: 'running',
      attemptId: event.attemptId,
      fence: event.fence,
    };
    next.attemptBindingsById[event.attemptId] = event.requestId;
    return;
  }
  requireAttemptBinding(projection, event);
  if (
    request.status !== 'running' ||
    request.attemptId !== event.attemptId ||
    request.fence !== event.fence
  ) {
    throw new InstanceKernelError('INVALID_REQUEST_STATE', `Request ${event.requestId} is not running`);
  }
  if (event.type === 'CheckScheduled') return;
  next.requestsById[event.requestId] = {
    ...request,
    status: event.type === 'AttemptCompleted' ? 'completed' : 'failed',
    ...(event.type === 'AttemptFailed' ? { reason: event.reason } : {}),
  };
}

function reduceGeneratedLifecycle(
  projection: InstanceProjection,
  next: ReturnType<typeof mutableProjection>,
  event:
    | GeneratedAttemptStartedEvent
    | GeneratedCheckScheduledEvent
    | GeneratedClaimPublishedEvent
    | GeneratedAttemptCompletedEvent
    | GeneratedAttemptFailedEvent
): void {
  const generation = requireGeneration(projection, event);
  const instance = requireInstance(projection, generation.subgraphInstanceId, event.scope);
  if (event.checkId !== generation.checkId || instance.incarnation !== generation.incarnation) {
    throw new InstanceKernelError('INVALID_GENERATION_BINDING', 'Generated event has stale check or incarnation');
  }
  if (event.type === 'AttemptStarted') {
    if (generation.status !== 'ready') {
      throw new InstanceKernelError('GENERATION_NOT_READY', `Generation ${event.nodeGenerationId} is not ready`);
    }
    if (projection.attemptBindingsById[event.attemptId]) {
      throw new InstanceKernelError('DUPLICATE_ATTEMPT', `Attempt ${event.attemptId} already exists`);
    }
    next.generationsById[event.nodeGenerationId] = {
      ...generation,
      status: 'running',
      attemptId: event.attemptId,
      fence: event.fence,
    };
    next.attemptBindingsById[event.attemptId] = event.nodeGenerationId;
    return;
  }

  requireAttemptBinding(projection, event);
  if (
    generation.status !== 'running' ||
    generation.attemptId !== event.attemptId ||
    generation.fence !== event.fence
  ) {
    throw new InstanceKernelError('STALE_FENCE', `Attempt ${event.attemptId} is not current`);
  }
  if (event.type === 'CheckScheduled') {
    const claimIds = sortedUnique(event.claimIds, 'Scheduled claim IDs');
    if (!sameStrings(claimIds, generation.activeInputClaimIds)) {
      throw new InstanceKernelError(
        'INVALID_SCHEDULED_CLAIMS',
        'Generated check was not scheduled with its exact activated inputs'
      );
    }
    next.generationsById[event.nodeGenerationId] = { ...generation, scheduled: true };
    return;
  }
  if (!generation.scheduled) {
    throw new InstanceKernelError('ATTEMPT_NOT_SCHEDULED', `Attempt ${event.attemptId} is not scheduled`);
  }
  if (event.type === 'ClaimPublished') {
    if (event.producerCheckId !== generation.checkId) {
      throw new InstanceKernelError('INVALID_GENERATION_BINDING', 'Generated claim has wrong producer');
    }
    if (!sameStrings(event.parentClaimIds, generation.activeInputClaimIds)) {
      throw new InstanceKernelError('INVALID_PARENT_CLAIMS', 'Generated claim has wrong exact parents');
    }
    const payloadFingerprint = sha256Canonical(event.payload);
    if (payloadFingerprint !== event.payloadFingerprint) {
      throw new InstanceKernelError('INVALID_PAYLOAD_FINGERPRINT', 'Generated claim fingerprint is invalid');
    }
    const claimId = sha256Canonical({
      claim: event.claim,
      payloadFingerprint,
      producerCheckId: event.checkId,
      scope: event.scope,
      attemptId: event.attemptId,
      fence: event.fence,
      parentClaimIds: [...event.parentClaimIds].sort(),
    });
    if (claimId !== event.claimId || projection.claimsById[event.claimId]) {
      throw new InstanceKernelError('INVALID_CLAIM_ID', 'Generated claim ID is invalid or duplicate');
    }
    next.claimsById[event.claimId] = {
      claimId: event.claimId,
      claim: event.claim,
      payload: immutableCanonicalValue(event.payload),
      payloadFingerprint,
      producerCheckId: event.producerCheckId,
      producerAttemptId: event.attemptId,
      producerFence: event.fence,
      parentClaimIds: [...event.parentClaimIds],
      scope: requireKeyedScopePath(event.scope, instance.scope[0]),
      active: true,
      kind: 'generated-output',
      subgraphInstanceId: instance.subgraphInstanceId,
      incarnation: generation.incarnation,
      nodeGenerationId: generation.nodeGenerationId,
    };
    next.generationsById[event.nodeGenerationId] = {
      ...generation,
      completedOutputClaimIds: [...generation.completedOutputClaimIds, event.claimId],
    };
    return;
  }
  if (event.type === 'AttemptFailed' && generation.completedOutputClaimIds.length > 0) {
    throw new InstanceKernelError('PARTIAL_CLAIM_PUBLICATION', 'Failed generation has published claims');
  }
  next.generationsById[event.nodeGenerationId] = {
    ...generation,
    status: event.type === 'AttemptCompleted' ? 'completed' : 'failed',
    ...(event.type === 'AttemptFailed' ? { reason: event.reason } : {}),
  };
}

/** Pure C2 transition reducer. The returned projection is a deep immutable value. */
export function reduceInstanceEvent(
  projection: InstanceProjection,
  event: InstanceRuntimeEvent
): InstanceProjection {
  if (event.version !== 1) {
    throw new InstanceKernelError('UNSUPPORTED_EVENT_VERSION', 'Unsupported event version');
  }
  if (!Number.isSafeInteger(event.eventId) || event.eventId <= projection.lastEventId) {
    throw new InstanceKernelError('NON_MONOTONIC_EVENT', 'C2 event IDs must advance monotonically');
  }
  validateTaggedScopePath(event.scope);
  const next = mutableProjection(projection);
  next.lastEventId = event.eventId;

  switch (event.type) {
    case 'CatalogReconciliationRequested': {
      requireRootScopePath(event.scope);
      if (
        event.status !== 'pending' ||
        !Number.isSafeInteger(event.requestOrdinal) ||
        event.requestOrdinal < 1 ||
        event.requestId !==
          deriveCatalogRequestId({
            sessionId: event.sessionId,
            expansionOwnerCheck: event.expansionOwnerCheck,
            ordinal: event.requestOrdinal,
          })
      ) {
        throw new InstanceKernelError('INVALID_REQUEST_ID', 'Catalog request identity is invalid');
      }
      if (projection.requestsById[event.requestId]) {
        throw new InstanceKernelError('DUPLICATE_REQUEST', `Request ${event.requestId} already exists`);
      }
      next.requestsById[event.requestId] = {
        requestId: event.requestId,
        requestOrdinal: event.requestOrdinal,
        sessionId: event.sessionId,
        expansionOwnerCheck: event.expansionOwnerCheck,
        status: 'pending',
      };
      next.requestOrder.push(event.requestId);
      break;
    }
    case 'SubgraphExpanded': {
      const itemKey = canonicalCatalogKey(event.itemKey);
      const expectedId = deriveSubgraphInstanceId({
        graphSemanticDigest: event.graphSemanticDigest,
        expansionOwnerCheck: event.expansionOwnerCheck,
        parentSubgraphInstanceId: null,
        templateDigest: event.templateDigest,
        itemKey,
      });
      const scope = requireKeyedScopePath(event.scope, {
        expansionOwnerCheck: event.expansionOwnerCheck,
        key: itemKey,
        subgraphInstanceId: expectedId,
      });
      if (event.parentSubgraphInstanceId !== null || event.subgraphInstanceId !== expectedId) {
        throw new InstanceKernelError('INVALID_INSTANCE_ID', 'Subgraph instance identity is invalid');
      }
      if (projection.instanceIdByOwnerAndKey[ownerKey(event.expansionOwnerCheck, itemKey)]) {
        throw new InstanceKernelError(
          'TOMBSTONED_KEY_READD_UNSUPPORTED',
          `Expansion key ${itemKey} was already observed`
        );
      }
      const entries = Object.entries(event.nodeInstanceIdsByTemplateNode).sort(([a], [b]) =>
        a.localeCompare(b)
      );
      if (entries.length === 0) {
        throw new InstanceKernelError('INVALID_EXPANSION', 'Expanded subgraph must contain nodes');
      }
      for (const [templateNodeKey, nodeInstanceId] of entries) {
        requireNonEmpty(templateNodeKey, 'Template node key');
        if (
          nodeInstanceId !== deriveNodeInstanceId({ subgraphInstanceId: expectedId, templateNodeKey }) ||
          projection.nodesById[nodeInstanceId]
        ) {
          throw new InstanceKernelError('INVALID_NODE_INSTANCE_ID', 'Node instance identity is invalid');
        }
        next.nodesById[nodeInstanceId] = {
          nodeInstanceId,
          subgraphInstanceId: expectedId,
          templateNodeKey,
          scope,
        };
      }
      next.instancesById[expectedId] = {
        sessionId: event.sessionId,
        expansionOwnerCheck: event.expansionOwnerCheck,
        graphSemanticDigest: event.graphSemanticDigest,
        expansionSpecDigest: event.expansionSpecDigest,
        templateDigest: event.templateDigest,
        itemKey,
        subgraphInstanceId: expectedId,
        scope,
        catalogClaimId: event.catalogClaimId,
        nodeInstanceIdsByTemplateNode: { ...event.nodeInstanceIdsByTemplateNode },
        status: 'active',
        incarnation: 0,
      };
      next.instanceIdByOwnerAndKey[ownerKey(event.expansionOwnerCheck, itemKey)] = expectedId;
      break;
    }
    case 'ControllerItemClaimPublished': {
      const instance = requireInstance(projection, event.subgraphInstanceId, event.scope);
      if (
        event.expansionOwnerCheck !== instance.expansionOwnerCheck ||
        event.expansionSpecDigest !== instance.expansionSpecDigest ||
        event.itemKey !== instance.itemKey ||
        event.incarnation !== instance.incarnation + 1 ||
        event.parentClaimIds.length !== 1 ||
        event.parentClaimIds[0] !== event.catalogClaimId
      ) {
        throw new InstanceKernelError('INVALID_ITEM_CLAIM', 'Controller item claim authority is invalid');
      }
      if (
        Object.values(projection.generationsById).some(
          generation =>
            generation.subgraphInstanceId === instance.subgraphInstanceId &&
            generation.status !== 'inactive'
        )
      ) {
        throw new InstanceKernelError('EXPANSION_BUSY', 'Old instance generations are still active');
      }
      const payloadFingerprint = deriveItemFingerprint(event.payload);
      const scope = requireKeyedScopePath(event.scope, instance.scope[0]);
      const claimId = deriveControllerItemClaimId({
        claim: event.claim,
        payloadFingerprint,
        expansionSpecDigest: event.expansionSpecDigest,
        catalogClaimId: event.catalogClaimId,
        subgraphInstanceId: event.subgraphInstanceId,
        incarnation: event.incarnation,
        scope,
      });
      if (
        event.payloadFingerprint !== payloadFingerprint ||
        event.claimId !== claimId ||
        projection.claimsById[event.claimId]
      ) {
        throw new InstanceKernelError('INVALID_ITEM_CLAIM', 'Controller item claim identity is invalid');
      }
      if (instance.activeItemClaimId) {
        next.claimsById[instance.activeItemClaimId] = {
          ...projection.claimsById[instance.activeItemClaimId],
          active: false,
        };
      }
      next.claimsById[event.claimId] = {
        claimId,
        claim: event.claim,
        payload: immutableCanonicalValue(event.payload),
        payloadFingerprint,
        producerCheckId: event.expansionOwnerCheck,
        controllerCatalogClaimId: event.catalogClaimId,
        parentClaimIds: [event.catalogClaimId],
        scope,
        active: true,
        kind: 'controller-item',
        subgraphInstanceId: instance.subgraphInstanceId,
        incarnation: event.incarnation,
      };
      next.instancesById[instance.subgraphInstanceId] = {
        ...instance,
        incarnation: event.incarnation,
        activeItemClaimId: claimId,
      };
      break;
    }
    case 'NodeGenerationActivated': {
      const instance = requireInstance(projection, event.subgraphInstanceId, event.scope);
      const node = projection.nodesById[event.nodeInstanceId];
      if (
        !node ||
        node.subgraphInstanceId !== instance.subgraphInstanceId ||
        node.templateNodeKey !== event.templateNodeKey ||
        event.checkId !== event.templateNodeKey ||
        event.incarnation !== instance.incarnation
      ) {
        throw new InstanceKernelError('INVALID_GENERATION_BINDING', 'Activation is bound to wrong node');
      }
      if (projection.activeGenerationIdByNode[event.nodeInstanceId]) {
        throw new InstanceKernelError('GENERATION_ALREADY_ACTIVE', 'Node already has an active generation');
      }
      const inputIds = sortedUnique(event.activeInputClaimIds, 'Active input claim IDs');
      for (const claimId of inputIds) {
        const claim = projection.claimsById[claimId];
        if (!claim?.active || claim.subgraphInstanceId !== instance.subgraphInstanceId) {
          throw new InstanceKernelError('INACTIVE_INPUT_CLAIM', `Input claim ${claimId} is not active`);
        }
      }
      const itemClaim = instance.activeItemClaimId
        ? projection.claimsById[instance.activeItemClaimId]
        : undefined;
      if (!itemClaim || itemClaim.payloadFingerprint !== event.itemFingerprint) {
        throw new InstanceKernelError('INVALID_ITEM_FINGERPRINT', 'Activation item fingerprint is stale');
      }
      const generationId = deriveNodeGenerationId({
        nodeInstanceId: event.nodeInstanceId,
        incarnation: event.incarnation,
        itemFingerprint: event.itemFingerprint,
        executionConfigDigest: event.executionConfigDigest,
        activeInputClaimIds: inputIds,
      });
      if (event.nodeGenerationId !== generationId || projection.generationsById[generationId]) {
        throw new InstanceKernelError('INVALID_GENERATION_ID', 'Node generation identity is invalid');
      }
      next.generationsById[generationId] = {
        nodeGenerationId: generationId,
        nodeInstanceId: node.nodeInstanceId,
        subgraphInstanceId: instance.subgraphInstanceId,
        templateNodeKey: node.templateNodeKey,
        checkId: event.checkId,
        scope: requireKeyedScopePath(event.scope, instance.scope[0]),
        incarnation: event.incarnation,
        itemFingerprint: event.itemFingerprint,
        executionConfigDigest: event.executionConfigDigest,
        activeInputClaimIds: inputIds,
        status: 'ready',
        scheduled: false,
        completedOutputClaimIds: [],
      };
      next.activeGenerationIdByNode[node.nodeInstanceId] = generationId;
      break;
    }
    case 'NodeGenerationInactivated': {
      const generation = requireGeneration(projection, event);
      requireInstance(projection, event.subgraphInstanceId, event.scope);
      if (
        event.reason !== 'superseded' ||
        generation.subgraphInstanceId !== event.subgraphInstanceId ||
        generation.incarnation !== event.incarnation ||
        generation.status === 'ready' ||
        generation.status === 'running'
      ) {
        throw new InstanceKernelError('EXPANSION_BUSY', 'Generation cannot be inactivated now');
      }
      const outputIds = sortedUnique(event.outputClaimIds, 'Inactivated output claim IDs');
      const expectedOutputs = [...generation.completedOutputClaimIds].sort();
      if (!sameStrings(outputIds, expectedOutputs)) {
        throw new InstanceKernelError('INVALID_GENERATION_BINDING', 'Inactivation output set is not exact');
      }
      next.generationsById[event.nodeGenerationId] = { ...generation, status: 'inactive' };
      delete next.activeGenerationIdByNode[event.nodeInstanceId];
      for (const claimId of outputIds) {
        next.claimsById[claimId] = { ...projection.claimsById[claimId], active: false };
      }
      break;
    }
    case 'SubgraphTombstoned': {
      const instance = requireInstance(projection, event.subgraphInstanceId, event.scope);
      if (
        event.expansionOwnerCheck !== instance.expansionOwnerCheck ||
        event.itemKey !== instance.itemKey ||
        event.lastIncarnation !== instance.incarnation
      ) {
        throw new InstanceKernelError('INVALID_TOMBSTONE', 'Tombstone identity is invalid');
      }
      const activeGenerations = Object.values(projection.generationsById)
        .filter(
          generation =>
            generation.subgraphInstanceId === instance.subgraphInstanceId &&
            generation.status !== 'inactive'
        )
        .sort((left, right) => left.nodeGenerationId.localeCompare(right.nodeGenerationId));
      if (activeGenerations.some(generation => generation.status === 'ready' || generation.status === 'running')) {
        throw new InstanceKernelError('EXPANSION_BUSY', 'Ready or running generation blocks tombstone');
      }
      const generationIds = sortedUnique(event.nodeGenerationIds, 'Tombstone generation IDs');
      if (!sameStrings(generationIds, activeGenerations.map(generation => generation.nodeGenerationId))) {
        throw new InstanceKernelError('INVALID_TOMBSTONE', 'Tombstone generation set is not exact');
      }
      const expectedOutputs = activeGenerations
        .flatMap(generation => generation.completedOutputClaimIds)
        .sort();
      const outputIds = sortedUnique(event.outputClaimIds, 'Tombstone output claim IDs');
      if (!sameStrings(outputIds, expectedOutputs)) {
        throw new InstanceKernelError('INVALID_TOMBSTONE', 'Tombstone output set is not exact');
      }
      for (const generation of activeGenerations) {
        next.generationsById[generation.nodeGenerationId] = { ...generation, status: 'inactive' };
        delete next.activeGenerationIdByNode[generation.nodeInstanceId];
      }
      for (const claimId of outputIds) {
        next.claimsById[claimId] = { ...projection.claimsById[claimId], active: false };
      }
      if (instance.activeItemClaimId) {
        next.claimsById[instance.activeItemClaimId] = {
          ...projection.claimsById[instance.activeItemClaimId],
          active: false,
        };
      }
      next.instancesById[instance.subgraphInstanceId] = {
        ...instance,
        status: 'tombstoned',
        tombstoneCatalogClaimId: event.sourceCatalogClaimId,
      };
      break;
    }
    case 'AttemptStarted':
    case 'CheckScheduled':
    case 'AttemptCompleted':
    case 'AttemptFailed': {
      if ('requestId' in event) reduceRequestLifecycle(projection, next, event);
      else reduceGeneratedLifecycle(projection, next, event);
      break;
    }
    case 'ClaimPublished':
      reduceGeneratedLifecycle(projection, next, event);
      break;
  }

  return immutableCanonicalValue<InstanceProjection>(next);
}

export function replayInstanceEvents(events: readonly InstanceRuntimeEvent[]): InstanceProjection {
  return events.reduce(reduceInstanceEvent, createInitialInstanceProjection());
}

export function queryReadyGenerations(projection: InstanceProjection): readonly NodeGenerationProjection[] {
  return Object.values(projection.generationsById)
    .filter(generation => generation.status === 'ready')
    .sort((left, right) => left.nodeGenerationId.localeCompare(right.nodeGenerationId));
}
