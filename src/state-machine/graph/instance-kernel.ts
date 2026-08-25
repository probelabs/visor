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

export interface ManagedRunBindingV1 {
  readonly managedRunId: string;
  readonly sessionId: string;
  readonly checkId: string;
  readonly scope: KeyedScopePath;
  readonly nodeInstanceId: string;
  readonly nodeGenerationId: string;
  readonly attemptId: string;
  readonly fence: number;
}

export type ManagedRunCleanupStatus = 'clean' | 'unverified';
export type ManagedRunControllerDecision = 'completed' | 'failed';
export type ManagedRunFailureCode =
  | 'MANAGED_HANDLE_INVALID'
  | 'MANAGED_BINDING_MISMATCH'
  | 'MANAGED_START_FAILED'
  | 'MANAGED_STARTED_RECEIPT_INVALID'
  | 'MANAGED_OUTCOME_FAILED'
  | 'MANAGED_OUTCOME_RECEIPT_INVALID'
  | 'MANAGED_DEADLINE_EXCEEDED'
  | 'MANAGED_CANCEL_FAILED'
  | 'MANAGED_CANCEL_RECEIPT_INVALID'
  | 'MANAGED_CLOSE_FAILED'
  | 'MANAGED_CLEANUP_RECEIPT_INVALID'
  | 'MANAGED_SANDBOX_UNSUPPORTED'
  | 'MANAGED_DEBOUNCE_UNSUPPORTED'
  | 'MANAGED_FATAL_SUMMARY'
  | 'MANAGED_FAIL_IF'
  | 'MANAGED_HALT_EXECUTION'
  | 'MANAGED_CLAIM_VALIDATION_FAILED'
  | 'MANAGED_POST_PROVIDER_FAILED';

export type ManagedRunAcquisitionFailureCode =
  | 'MANAGED_HANDLE_INVALID'
  | 'MANAGED_BINDING_MISMATCH'
  | 'MANAGED_START_FAILED'
  | 'MANAGED_SANDBOX_UNSUPPORTED'
  | 'MANAGED_DEBOUNCE_UNSUPPORTED';

export function deriveManagedRunId(
  input: Omit<ManagedRunBindingV1, 'managedRunId'>
): string {
  return sha256Canonical({
    v: 1,
    type: 'managed-run',
    sessionId: input.sessionId,
    checkId: input.checkId,
    scope: validateTaggedScopePath(input.scope),
    nodeInstanceId: input.nodeInstanceId,
    nodeGenerationId: input.nodeGenerationId,
    attemptId: input.attemptId,
    fence: input.fence,
  });
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

interface ManagedRunEventBase extends InstanceEventBase {
  readonly scope: KeyedScopePath;
  readonly binding: ManagedRunBindingV1;
}

export interface ManagedRunAcquisitionFailedEvent extends ManagedRunEventBase {
  readonly type: 'ManagedRunAcquisitionFailed';
  readonly failureCode: ManagedRunAcquisitionFailureCode;
}

export interface ManagedRunAcquiredEvent extends ManagedRunEventBase {
  readonly type: 'ManagedRunAcquired';
}

export interface ManagedRunStartedEvent extends ManagedRunEventBase {
  readonly type: 'ManagedRunStarted';
}

export interface ManagedRunCancelRequestedEvent extends ManagedRunEventBase {
  readonly type: 'ManagedRunCancelRequested';
  readonly reason: 'deadline';
}

export interface ManagedRunTerminatedEvent extends ManagedRunEventBase {
  readonly type: 'ManagedRunTerminated';
  readonly cleanupStatus: ManagedRunCleanupStatus;
  readonly controllerDecision: ManagedRunControllerDecision;
  readonly failureCode: ManagedRunFailureCode | null;
}

type ManagedRunLifecycleEvent =
  | ManagedRunAcquisitionFailedEvent
  | ManagedRunAcquiredEvent
  | ManagedRunStartedEvent
  | ManagedRunCancelRequestedEvent
  | ManagedRunTerminatedEvent;

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
  | ManagedRunAcquisitionFailedEvent
  | ManagedRunAcquiredEvent
  | ManagedRunStartedEvent
  | ManagedRunCancelRequestedEvent
  | ManagedRunTerminatedEvent
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

export interface ManagedRunProjection {
  readonly binding: ManagedRunBindingV1;
  readonly status:
    | 'acquisition_failed'
    | 'acquired'
    | 'started'
    | 'cancel_requested'
    | 'terminated';
  readonly cleanupStatus?: ManagedRunCleanupStatus;
  readonly controllerDecision?: ManagedRunControllerDecision;
  readonly failureCode?: ManagedRunFailureCode;
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
  readonly managedRunsByAttemptId: Readonly<Record<string, ManagedRunProjection>>;
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
    managedRunsByAttemptId: {},
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
  managedRunsByAttemptId: Record<string, ManagedRunProjection>;
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
    managedRunsByAttemptId: { ...projection.managedRunsByAttemptId },
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

const MANAGED_RUN_FAILURE_CODES: ReadonlySet<string> = new Set<ManagedRunFailureCode>([
  'MANAGED_HANDLE_INVALID',
  'MANAGED_BINDING_MISMATCH',
  'MANAGED_START_FAILED',
  'MANAGED_STARTED_RECEIPT_INVALID',
  'MANAGED_OUTCOME_FAILED',
  'MANAGED_OUTCOME_RECEIPT_INVALID',
  'MANAGED_DEADLINE_EXCEEDED',
  'MANAGED_CANCEL_FAILED',
  'MANAGED_CANCEL_RECEIPT_INVALID',
  'MANAGED_CLOSE_FAILED',
  'MANAGED_CLEANUP_RECEIPT_INVALID',
  'MANAGED_SANDBOX_UNSUPPORTED',
  'MANAGED_DEBOUNCE_UNSUPPORTED',
  'MANAGED_FATAL_SUMMARY',
  'MANAGED_FAIL_IF',
  'MANAGED_HALT_EXECUTION',
  'MANAGED_CLAIM_VALIDATION_FAILED',
  'MANAGED_POST_PROVIDER_FAILED',
]);

const MANAGED_RUN_ACQUISITION_FAILURE_CODES: ReadonlySet<string> = new Set<
  ManagedRunAcquisitionFailureCode
>([
  'MANAGED_HANDLE_INVALID',
  'MANAGED_BINDING_MISMATCH',
  'MANAGED_START_FAILED',
  'MANAGED_SANDBOX_UNSUPPORTED',
  'MANAGED_DEBOUNCE_UNSUPPORTED',
]);

const MANAGED_RUN_UNVERIFIED_CLEANUP_FAILURE_CODES: ReadonlySet<ManagedRunFailureCode> =
  new Set<ManagedRunFailureCode>(['MANAGED_CLOSE_FAILED', 'MANAGED_CLEANUP_RECEIPT_INVALID']);

const MANAGED_RUN_CANCEL_PATH_FAILURE_CODES: ReadonlySet<ManagedRunFailureCode> = new Set<ManagedRunFailureCode>([
  'MANAGED_DEADLINE_EXCEEDED',
  'MANAGED_CANCEL_FAILED',
  'MANAGED_CANCEL_RECEIPT_INVALID',
  'MANAGED_CLOSE_FAILED',
  'MANAGED_CLEANUP_RECEIPT_INVALID',
]);

const MANAGED_RUN_CANCEL_ONLY_FAILURE_CODES: ReadonlySet<ManagedRunFailureCode> =
  new Set<ManagedRunFailureCode>([
    'MANAGED_DEADLINE_EXCEEDED',
    'MANAGED_CANCEL_FAILED',
    'MANAGED_CANCEL_RECEIPT_INVALID',
  ]);

function managedBindingEquals(left: ManagedRunBindingV1, right: ManagedRunBindingV1): boolean {
  return (
    left.managedRunId === right.managedRunId &&
    left.sessionId === right.sessionId &&
    left.checkId === right.checkId &&
    scopePathEquals(left.scope, right.scope) &&
    left.nodeInstanceId === right.nodeInstanceId &&
    left.nodeGenerationId === right.nodeGenerationId &&
    left.attemptId === right.attemptId &&
    left.fence === right.fence
  );
}

function requireManagedRunBinding(value: unknown): ManagedRunBindingV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InstanceKernelError('INVALID_MANAGED_BINDING', 'Managed run binding must be an object');
  }
  const binding = value as unknown as Record<string, unknown>;
  if (
    !hasExactKeys(binding, [
      'managedRunId',
      'sessionId',
      'checkId',
      'scope',
      'nodeInstanceId',
      'nodeGenerationId',
      'attemptId',
      'fence',
    ])
  ) {
    throw new InstanceKernelError(
      'INVALID_MANAGED_BINDING',
      'Managed run binding must contain exactly eight authority fields'
    );
  }
  for (const field of [
    'managedRunId',
    'sessionId',
    'checkId',
    'nodeInstanceId',
    'nodeGenerationId',
    'attemptId',
  ] as const) {
    if (typeof binding[field] !== 'string' || binding[field].length === 0) {
      throw new InstanceKernelError(
        'INVALID_MANAGED_BINDING',
        `Managed run binding ${field} must be a non-empty string`
      );
    }
  }
  if (!Number.isSafeInteger(binding.fence) || (binding.fence as number) < 1) {
    throw new InstanceKernelError(
      'INVALID_MANAGED_BINDING',
      'Managed run binding fence must be a positive safe integer'
    );
  }
  const scope = requireKeyedScopePath(binding.scope);
  const candidate: ManagedRunBindingV1 = {
    managedRunId: binding.managedRunId as string,
    sessionId: binding.sessionId as string,
    checkId: binding.checkId as string,
    scope,
    nodeInstanceId: binding.nodeInstanceId as string,
    nodeGenerationId: binding.nodeGenerationId as string,
    attemptId: binding.attemptId as string,
    fence: binding.fence as number,
  };
  if (deriveManagedRunId(candidate) !== candidate.managedRunId) {
    throw new InstanceKernelError(
      'INVALID_MANAGED_BINDING',
      'Managed run ID is not derived from its exact controller binding'
    );
  }
  return candidate;
}

function requireManagedEventShape(event: ManagedRunLifecycleEvent): void {
  const common = ['version', 'type', 'eventId', 'sessionId', 'scope', 'binding'];
  const expected =
    event.type === 'ManagedRunAcquisitionFailed'
      ? [...common, 'failureCode']
      : event.type === 'ManagedRunCancelRequested'
        ? [...common, 'reason']
        : event.type === 'ManagedRunTerminated'
          ? [...common, 'cleanupStatus', 'controllerDecision', 'failureCode']
          : common;
  if (!hasExactKeys(event as unknown as Record<string, unknown>, expected)) {
    throw new InstanceKernelError('INVALID_MANAGED_EVENT', `${event.type} has unknown or missing fields`);
  }
}

function requireCurrentManagedBinding(
  projection: InstanceProjection,
  event: ManagedRunLifecycleEvent
): ManagedRunBindingV1 {
  requireManagedEventShape(event);
  const binding = requireManagedRunBinding(event.binding);
  if (event.sessionId !== binding.sessionId || !scopePathEquals(event.scope, binding.scope)) {
    throw new InstanceKernelError(
      'INVALID_MANAGED_BINDING',
      'Managed lifecycle envelope does not match its complete binding'
    );
  }
  const generation = requireGeneration(projection, binding);
  const instance = requireInstance(projection, generation.subgraphInstanceId, binding.scope);
  if (
    projection.attemptBindingsById[binding.attemptId] !== binding.nodeGenerationId ||
    instance.sessionId !== binding.sessionId ||
    generation.checkId !== binding.checkId ||
    generation.nodeInstanceId !== binding.nodeInstanceId ||
    generation.nodeGenerationId !== binding.nodeGenerationId ||
    generation.status !== 'running' ||
    generation.attemptId !== binding.attemptId ||
    generation.fence !== binding.fence ||
    !generation.scheduled
  ) {
    throw new InstanceKernelError(
      'INVALID_MANAGED_BINDING',
      'Managed run binding is not the exact current scheduled running attempt'
    );
  }
  return binding;
}

function generatedAttemptMatchesManagedBinding(
  event: GeneratedAttemptCompletedEvent | GeneratedAttemptFailedEvent,
  binding: ManagedRunBindingV1
): boolean {
  return (
    event.sessionId === binding.sessionId &&
    event.checkId === binding.checkId &&
    scopePathEquals(event.scope, binding.scope) &&
    event.nodeInstanceId === binding.nodeInstanceId &&
    event.nodeGenerationId === binding.nodeGenerationId &&
    event.attemptId === binding.attemptId &&
    event.fence === binding.fence
  );
}

function reduceManagedRunLifecycle(
  projection: InstanceProjection,
  next: ReturnType<typeof mutableProjection>,
  event: ManagedRunLifecycleEvent
): void {
  const binding = requireCurrentManagedBinding(projection, event);
  const current = projection.managedRunsByAttemptId[binding.attemptId];
  if (current && !managedBindingEquals(current.binding, binding)) {
    throw new InstanceKernelError(
      'INVALID_MANAGED_BINDING',
      'Managed attempt index resolved to a different complete binding'
    );
  }

  if (event.type === 'ManagedRunAcquisitionFailed') {
    if (current || !MANAGED_RUN_ACQUISITION_FAILURE_CODES.has(event.failureCode)) {
      throw new InstanceKernelError(
        current ? 'MANAGED_RUN_ALREADY_ACQUIRED' : 'INVALID_MANAGED_FAILURE_CODE',
        'Managed acquisition failure is duplicate or has an invalid stable code'
      );
    }
    next.managedRunsByAttemptId[binding.attemptId] = {
      binding,
      status: 'acquisition_failed',
      controllerDecision: 'failed',
      failureCode: event.failureCode,
    };
    return;
  }

  if (event.type === 'ManagedRunAcquired') {
    if (current) {
      throw new InstanceKernelError('MANAGED_RUN_ALREADY_ACQUIRED', 'Managed run was already acquired');
    }
    next.managedRunsByAttemptId[binding.attemptId] = { binding, status: 'acquired' };
    return;
  }

  if (!current || current.status === 'acquisition_failed' || current.status === 'terminated') {
    throw new InstanceKernelError(
      'INVALID_MANAGED_TRANSITION',
      'Managed lifecycle event requires one matching nonterminal acquired run'
    );
  }

  if (event.type === 'ManagedRunStarted') {
    if (current.status !== 'acquired') {
      throw new InstanceKernelError('INVALID_MANAGED_TRANSITION', 'Managed run start is duplicate or late');
    }
    next.managedRunsByAttemptId[binding.attemptId] = { ...current, status: 'started' };
    return;
  }

  if (event.type === 'ManagedRunCancelRequested') {
    if (event.reason !== 'deadline' || current.status === 'cancel_requested') {
      throw new InstanceKernelError(
        'INVALID_MANAGED_TRANSITION',
        'Managed cancellation must be one current-fence deadline request'
      );
    }
    next.managedRunsByAttemptId[binding.attemptId] = {
      ...current,
      status: 'cancel_requested',
    };
    return;
  }

  const completed = event.controllerDecision === 'completed';
  const failed = event.controllerDecision === 'failed';
  const cleanupIsValid = event.cleanupStatus === 'clean' || event.cleanupStatus === 'unverified';
  const failureCodeIsValid =
    event.failureCode !== null && MANAGED_RUN_FAILURE_CODES.has(event.failureCode);
  const acquisitionCodeUsedAsTerminal =
    event.failureCode !== null && MANAGED_RUN_ACQUISITION_FAILURE_CODES.has(event.failureCode);
  const unverifiedCode =
    event.failureCode !== null &&
    MANAGED_RUN_UNVERIFIED_CLEANUP_FAILURE_CODES.has(event.failureCode);
  const cancelPathCode =
    event.failureCode !== null && MANAGED_RUN_CANCEL_PATH_FAILURE_CODES.has(event.failureCode);
  const cancelOnlyCode =
    event.failureCode !== null && MANAGED_RUN_CANCEL_ONLY_FAILURE_CODES.has(event.failureCode);
  const cancelWasRequested = current.status === 'cancel_requested';
  if (
    !cleanupIsValid ||
    (!completed && !failed) ||
    (completed &&
      (event.cleanupStatus !== 'clean' ||
        event.failureCode !== null ||
        cancelWasRequested)) ||
    (!completed &&
      (!failureCodeIsValid ||
        acquisitionCodeUsedAsTerminal ||
        (event.cleanupStatus === 'unverified') !== unverifiedCode ||
        (cancelWasRequested ? !cancelPathCode : cancelOnlyCode)))
  ) {
    throw new InstanceKernelError(
      'INVALID_MANAGED_TERMINAL',
      'Managed terminal cleanup, decision, and failure code are inconsistent'
    );
  }
  next.managedRunsByAttemptId[binding.attemptId] = {
    ...current,
    status: 'terminated',
    cleanupStatus: event.cleanupStatus,
    controllerDecision: event.controllerDecision,
    ...(event.failureCode === null ? {} : { failureCode: event.failureCode }),
  };
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
  const managed = projection.managedRunsByAttemptId[event.attemptId];
  if (managed) {
    if (
      !generatedAttemptMatchesManagedBinding(
        event as GeneratedAttemptCompletedEvent | GeneratedAttemptFailedEvent,
        managed.binding
      )
    ) {
      throw new InstanceKernelError(
        'INVALID_MANAGED_BINDING',
        'Generated event does not match the complete managed run binding'
      );
    }
    if (event.type === 'ClaimPublished') {
      if (
        managed.status !== 'terminated' ||
        managed.cleanupStatus !== 'clean' ||
        managed.controllerDecision !== 'completed' ||
        managed.failureCode !== undefined
      ) {
        throw new InstanceKernelError(
          'MANAGED_TERMINAL_REQUIRED',
          'Managed claims require a clean controller-completed terminal fact'
        );
      }
    } else if (event.type === 'AttemptCompleted') {
      if (
        managed.status !== 'terminated' ||
        managed.cleanupStatus !== 'clean' ||
        managed.controllerDecision !== 'completed' ||
        managed.failureCode !== undefined
      ) {
        throw new InstanceKernelError(
          'MANAGED_TERMINAL_REQUIRED',
          'Managed completion requires a clean controller-completed terminal fact'
        );
      }
    } else if (event.type === 'AttemptFailed') {
      if (
        (managed.status !== 'acquisition_failed' && managed.status !== 'terminated') ||
        managed.controllerDecision !== 'failed' ||
        managed.failureCode === undefined ||
        event.reason !== managed.failureCode
      ) {
        throw new InstanceKernelError(
          'MANAGED_TERMINAL_REQUIRED',
          'Managed failure requires its controller-failed lifecycle terminal and stable code'
        );
      }
    }
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
    case 'ManagedRunAcquisitionFailed':
    case 'ManagedRunAcquired':
    case 'ManagedRunStarted':
    case 'ManagedRunCancelRequested':
    case 'ManagedRunTerminated':
      reduceManagedRunLifecycle(projection, next, event);
      break;
  }

  return immutableCanonicalValue<InstanceProjection>(next);
}

function isGeneratedAttemptTerminal(
  event: InstanceRuntimeEvent
): event is GeneratedAttemptCompletedEvent | GeneratedAttemptFailedEvent {
  return (
    (event.type === 'AttemptCompleted' || event.type === 'AttemptFailed') &&
    'nodeGenerationId' in event
  );
}

function requireMatchingAttemptTerminal(
  binding: ManagedRunBindingV1,
  event: InstanceRuntimeEvent | undefined,
  expectedType: 'AttemptCompleted' | 'AttemptFailed',
  failureCode?: ManagedRunFailureCode
): void {
  if (
    !event ||
    !isGeneratedAttemptTerminal(event) ||
    event.type !== expectedType ||
    !generatedAttemptMatchesManagedBinding(event, binding) ||
    (event.type === 'AttemptFailed' && event.reason !== failureCode)
  ) {
    throw new InstanceKernelError(
      'INVALID_MANAGED_BATCH',
      `Managed lifecycle terminal requires a matching ${expectedType} in the same batch`
    );
  }
}

/**
 * Pure atomic-batch validator/reducer. Callers publish none of the input events
 * unless this function returns the fully reduced immutable projection.
 */
export function reduceInstanceEventBatch(
  projection: InstanceProjection,
  events: readonly InstanceRuntimeEvent[]
): InstanceProjection {
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.type === 'ManagedRunAcquisitionFailed') {
      if (index !== 0 || events.length !== 2) {
        throw new InstanceKernelError(
          'INVALID_MANAGED_BATCH',
          'Managed acquisition failure batch must contain exactly its two adjacent terminals'
        );
      }
      requireMatchingAttemptTerminal(
        event.binding,
        events[index + 1],
        'AttemptFailed',
        event.failureCode
      );
    } else if (event.type === 'ManagedRunTerminated') {
      if (event.controllerDecision === 'failed') {
        if (index !== 0 || events.length !== 2) {
          throw new InstanceKernelError(
            'INVALID_MANAGED_BATCH',
            'Managed failure batch must contain exactly its two adjacent terminals'
          );
        }
        requireMatchingAttemptTerminal(
          event.binding,
          events[index + 1],
          'AttemptFailed',
          event.failureCode || undefined
        );
      } else {
        if (index !== 0) {
          throw new InstanceKernelError(
            'INVALID_MANAGED_BATCH',
            'Managed completion lifecycle terminal must begin its atomic batch'
          );
        }
        const completionIndex = events.findIndex(
          (candidate, candidateIndex) =>
            candidateIndex > index &&
            isGeneratedAttemptTerminal(candidate) &&
            candidate.attemptId === event.binding.attemptId
        );
        const completion = completionIndex < 0 ? undefined : events[completionIndex];
        requireMatchingAttemptTerminal(event.binding, completion, 'AttemptCompleted');
        if (completionIndex !== events.length - 1) {
          throw new InstanceKernelError(
            'INVALID_MANAGED_BATCH',
            'Managed AttemptCompleted must end its atomic terminal batch'
          );
        }
        let activationObserved = false;
        for (const staged of events.slice(1, -1)) {
          if (staged.type === 'NodeGenerationActivated') {
            activationObserved = true;
          } else if (staged.type !== 'ClaimPublished' || activationObserved) {
            throw new InstanceKernelError(
              'INVALID_MANAGED_BATCH',
              'Managed completion batch permits claims followed by downstream activations only'
            );
          }
        }
      }
    }
  }

  for (const event of events) {
    if (!isGeneratedAttemptTerminal(event)) continue;
    const existing = projection.managedRunsByAttemptId[event.attemptId];
    const matchingLifecycle = events.find(
      candidate =>
        (candidate.type === 'ManagedRunAcquisitionFailed' ||
          candidate.type === 'ManagedRunTerminated') &&
        generatedAttemptMatchesManagedBinding(event, candidate.binding)
    );
    if (existing && !matchingLifecycle) {
      throw new InstanceKernelError(
        'INVALID_MANAGED_BATCH',
        'Managed attempt terminal cannot bypass its same-batch lifecycle terminal'
      );
    }
  }

  return events.reduce(reduceInstanceEvent, projection);
}

/**
 * Pure replay preserves the atomic terminal boundaries encoded by contiguous
 * journal order. Batch-only managed terminals are never reduced as singles.
 */
export function replayInstanceEvents(events: readonly InstanceRuntimeEvent[]): InstanceProjection {
  let projection = createInitialInstanceProjection();
  let index = 0;
  while (index < events.length) {
    const event = events[index];
    if (
      event.type === 'ManagedRunAcquisitionFailed' ||
      (event.type === 'ManagedRunTerminated' && event.controllerDecision === 'failed')
    ) {
      projection = reduceInstanceEventBatch(projection, events.slice(index, index + 2));
      index += 2;
      continue;
    }
    if (event.type === 'ManagedRunTerminated') {
      let terminalIndex = index + 1;
      while (terminalIndex < events.length) {
        const candidate = events[terminalIndex];
        if (
          isGeneratedAttemptTerminal(candidate) &&
          candidate.attemptId === event.binding.attemptId
        ) {
          break;
        }
        terminalIndex++;
      }
      projection = reduceInstanceEventBatch(
        projection,
        events.slice(index, Math.min(terminalIndex + 1, events.length))
      );
      index = terminalIndex + 1;
      continue;
    }
    projection = reduceInstanceEventBatch(projection, [event]);
    index++;
  }
  return projection;
}

export function queryReadyGenerations(projection: InstanceProjection): readonly NodeGenerationProjection[] {
  return Object.values(projection.generationsById)
    .filter(generation => generation.status === 'ready')
    .sort((left, right) => left.nodeGenerationId.localeCompare(right.nodeGenerationId));
}
