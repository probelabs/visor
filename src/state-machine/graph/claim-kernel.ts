import { createHash } from 'crypto';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { CandidateClaimInput } from '../../providers/check-provider.interface';
import type { ScopePath } from '../../snapshot-store';
import type { ClaimPlan } from './claim-plan';

export type ClaimRuntimeEvent =
  | AttemptStartedEvent
  | ClaimPublishedEvent
  | CheckScheduledEvent
  | AttemptCompletedEvent
  | AttemptFailedEvent;

interface RuntimeEventBase {
  readonly version: 1;
  readonly eventId: number;
  readonly sessionId: string;
  readonly checkId: string;
  readonly scope: ScopePath;
  readonly attemptId: string;
  readonly fence: number;
}

export interface AttemptStartedEvent extends RuntimeEventBase {
  readonly type: 'AttemptStarted';
}

export interface ClaimPublishedEvent extends RuntimeEventBase {
  readonly type: 'ClaimPublished';
  readonly claimId: string;
  readonly claim: string;
  readonly payload: unknown;
  readonly payloadFingerprint: string;
  readonly producerCheckId: string;
  readonly parentClaimIds: readonly string[];
}

export interface CheckScheduledEvent extends RuntimeEventBase {
  readonly type: 'CheckScheduled';
  readonly claimIds: readonly string[];
}

export interface AttemptCompletedEvent extends RuntimeEventBase {
  readonly type: 'AttemptCompleted';
}

export interface AttemptFailedEvent extends RuntimeEventBase {
  readonly type: 'AttemptFailed';
  readonly reason: string;
}

export interface AttemptProjection {
  readonly sessionId: string;
  readonly checkId: string;
  readonly scope: ScopePath;
  readonly attemptId: string;
  readonly fence: number;
  readonly status: 'started' | 'completed' | 'failed';
  readonly reason?: string;
}

export interface ClaimProjection {
  readonly lastEventId: number;
  readonly attempts: Readonly<Record<string, AttemptProjection>>;
  readonly claims: Readonly<Record<string, CandidateClaimInput>>;
  readonly activeClaimIdsByRef: Readonly<Record<string, string>>;
  readonly scheduled: readonly CheckScheduledEvent[];
}

export type ClaimSchemaValidator = (payload: unknown) => void;

export class ClaimKernelError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ClaimKernelError';
    this.code = code;
  }
}

function assertJsonValue(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ClaimKernelError('NON_CANONICAL_JSON', 'Non-finite numbers are not canonical JSON');
    }
    return JSON.stringify(value);
  }
  if (
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    typeof value === 'bigint'
  ) {
    throw new ClaimKernelError(
      'NON_CANONICAL_JSON',
      `Unsupported canonical JSON value: ${typeof value}`
    );
  }
  if (typeof value !== 'object') {
    throw new ClaimKernelError('NON_CANONICAL_JSON', 'Unsupported canonical JSON value');
  }
  if (seen.has(value)) {
    throw new ClaimKernelError('NON_CANONICAL_JSON', 'Cyclic values are not canonical JSON');
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map(item => assertJsonValue(item, seen)).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ClaimKernelError(
        'NON_CANONICAL_JSON',
        'Only plain objects are canonical JSON objects'
      );
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${assertJsonValue(record[key], seen)}`)
      .join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

/** Deterministic UTF-8 JSON with recursively sorted object keys. */
export function canonicalJson(value: unknown): string {
  return assertJsonValue(value, new Set<object>());
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function freezeJson(value: unknown): unknown {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

export function immutableCanonicalValue<T>(value: T): T {
  return freezeJson(JSON.parse(canonicalJson(value))) as T;
}

export function immutableRuntimeEvent<T extends ClaimRuntimeEvent>(event: T): T {
  return immutableCanonicalValue(event);
}

export function attemptProjectionKey(
  sessionId: string,
  checkId: string,
  scope: ScopePath
): string {
  return sha256Canonical({ sessionId, checkId, scope });
}

export function createInitialClaimProjection(): ClaimProjection {
  return immutableCanonicalValue<ClaimProjection>({
    lastEventId: 0,
    attempts: {},
    claims: {},
    activeClaimIdsByRef: {},
    scheduled: [],
  });
}

function cloneScope(scope: ScopePath): ScopePath {
  return scope.map(part => ({ ...part }));
}

function requireActivePlan(plan: ClaimPlan): void {
  if (!plan.active) {
    throw new ClaimKernelError('CLAIM_MODE_INACTIVE', 'Runtime claim events require claim mode');
  }
}

function requireRootScope(scope: ScopePath): void {
  if (scope.length !== 0) {
    throw new ClaimKernelError('UNSUPPORTED_CLAIM_SCOPE', 'Graph v2 C1 supports root scope only');
  }
}

function requireCurrentAttempt(
  projection: ClaimProjection,
  event: RuntimeEventBase
): AttemptProjection {
  const key = attemptProjectionKey(event.sessionId, event.checkId, event.scope);
  const current = projection.attempts[key];
  if (
    !current ||
    current.status !== 'started' ||
    current.attemptId !== event.attemptId ||
    current.fence !== event.fence
  ) {
    throw new ClaimKernelError(
      'STALE_FENCE',
      `Attempt ${event.attemptId} fence ${event.fence} is not current for ${event.checkId}`
    );
  }
  return current;
}

function sameIds(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export function exactActiveClaimIds(
  plan: ClaimPlan,
  projection: ClaimProjection,
  checkId: string
): readonly string[] {
  requireActivePlan(plan);
  if (!Object.prototype.hasOwnProperty.call(plan.effectiveDependenciesByCheck, checkId)) {
    throw new ClaimKernelError('UNKNOWN_CHECK', `Unknown claim-mode check ${checkId}`);
  }
  const ids = (plan.consumptionsByCheck[checkId] || []).map(consumption => {
    const claimId = projection.activeClaimIdsByRef[consumption.claim];
    const claim = claimId ? projection.claims[claimId] : undefined;
    if (!claim || claim.claim !== consumption.claim) {
      throw new ClaimKernelError(
        'CLAIM_NOT_READY',
        `Check ${checkId} requires active claim ${consumption.claim}`
      );
    }
    return claimId;
  });
  return Object.freeze(ids);
}

function exactScheduledParentIds(
  plan: ClaimPlan,
  projection: ClaimProjection,
  event: RuntimeEventBase
): readonly string[] {
  const scheduled = projection.scheduled.find(
    candidate =>
      candidate.sessionId === event.sessionId &&
      candidate.checkId === event.checkId &&
      candidate.attemptId === event.attemptId &&
      candidate.fence === event.fence &&
      canonicalJson(candidate.scope) === canonicalJson(event.scope)
  );
  if (!scheduled) {
    throw new ClaimKernelError(
      'ATTEMPT_NOT_SCHEDULED',
      `Attempt ${event.attemptId} was not scheduled before terminal processing`
    );
  }
  const active = exactActiveClaimIds(plan, projection, event.checkId);
  if (!sameIds(scheduled.claimIds, active)) {
    throw new ClaimKernelError(
      'INACTIVE_PARENT_CLAIM',
      `Attempt ${event.attemptId} no longer has its exact active parent claims`
    );
  }
  return scheduled.claimIds;
}

function requireDeclaredPublication(
  plan: ClaimPlan,
  projection: ClaimProjection,
  event: ClaimPublishedEvent
): void {
  const emissions = plan.emissionsByCheck[event.checkId] || [];
  if (
    plan.emitterByClaim[event.claim] !== event.checkId ||
    event.producerCheckId !== event.checkId ||
    !emissions.some(emission => emission.claim === event.claim)
  ) {
    throw new ClaimKernelError(
      'UNDECLARED_CLAIM_PUBLICATION',
      `Check ${event.checkId} is not the declared emitter of ${event.claim}`
    );
  }

  const parentClaimIds = exactScheduledParentIds(plan, projection, event);
  if (!sameIds(event.parentClaimIds, parentClaimIds)) {
    throw new ClaimKernelError(
      'INVALID_PARENT_CLAIMS',
      `Published claim ${event.claim} does not carry the attempt's exact parent claims`
    );
  }

  plan.validatorsByClaim[event.claim](event.payload);
  const payloadFingerprint = sha256Canonical(event.payload);
  if (event.payloadFingerprint !== payloadFingerprint) {
    throw new ClaimKernelError(
      'INVALID_PAYLOAD_FINGERPRINT',
      `Published claim ${event.claim} has an invalid payload fingerprint`
    );
  }
  const expectedClaimId = sha256Canonical({
    claim: event.claim,
    payloadFingerprint,
    producerCheckId: event.checkId,
    scope: event.scope,
    attemptId: event.attemptId,
    fence: event.fence,
    parentClaimIds: [...parentClaimIds].sort(),
  });
  if (event.claimId !== expectedClaimId) {
    throw new ClaimKernelError(
      'INVALID_CLAIM_ID',
      `Published claim ${event.claim} has an invalid claim ID`
    );
  }
}

function requireAllDeclaredEmissions(
  plan: ClaimPlan,
  projection: ClaimProjection,
  event: AttemptCompletedEvent
): void {
  for (const emission of plan.emissionsByCheck[event.checkId] || []) {
    const claimId = projection.activeClaimIdsByRef[emission.claim];
    const claim = claimId ? projection.claims[claimId] : undefined;
    if (
      !claim ||
      claim.producerCheckId !== event.checkId ||
      claim.attemptId !== event.attemptId ||
      claim.fence !== event.fence
    ) {
      throw new ClaimKernelError(
        'INCOMPLETE_CLAIM_PUBLICATION',
        `Attempt ${event.attemptId} did not publish every declared claim`
      );
    }
  }
}

function hasPublishedClaimForAttempt(
  projection: ClaimProjection,
  event: AttemptFailedEvent
): boolean {
  return Object.values(projection.claims).some(
    claim =>
      claim.producerCheckId === event.checkId &&
      claim.attemptId === event.attemptId &&
      claim.fence === event.fence
  );
}

/** Pure plan-aware transition reducer. It returns a deeply immutable projection. */
export function reduceClaimEvent(
  projection: ClaimProjection,
  event: ClaimRuntimeEvent,
  plan: ClaimPlan
): ClaimProjection {
  requireActivePlan(plan);
  requireRootScope(event.scope);
  if (event.version !== 1) {
    throw new ClaimKernelError('UNSUPPORTED_EVENT_VERSION', 'Unsupported event version');
  }
  if (!Number.isSafeInteger(event.eventId) || event.eventId <= projection.lastEventId) {
    throw new ClaimKernelError(
      'NON_MONOTONIC_EVENT',
      `Claim event ${event.eventId} must advance beyond ${projection.lastEventId}`
    );
  }
  if (!Object.prototype.hasOwnProperty.call(plan.effectiveDependenciesByCheck, event.checkId)) {
    throw new ClaimKernelError('UNKNOWN_CHECK', `Unknown claim-mode check ${event.checkId}`);
  }

  const next = {
    lastEventId: event.eventId,
    attempts: { ...projection.attempts },
    claims: { ...projection.claims },
    activeClaimIdsByRef: { ...projection.activeClaimIdsByRef },
    scheduled: [...projection.scheduled],
  };
  const attemptKey = attemptProjectionKey(event.sessionId, event.checkId, event.scope);

  switch (event.type) {
    case 'AttemptStarted': {
      const current = projection.attempts[attemptKey];
      if (current && event.fence <= current.fence) {
        throw new ClaimKernelError('STALE_FENCE', 'Attempt fence must advance monotonically');
      }
      if (Object.values(projection.attempts).some(attempt => attempt.attemptId === event.attemptId)) {
        throw new ClaimKernelError('DUPLICATE_ATTEMPT', `Attempt ${event.attemptId} already exists`);
      }
      next.attempts[attemptKey] = {
        sessionId: event.sessionId,
        checkId: event.checkId,
        scope: cloneScope(event.scope),
        attemptId: event.attemptId,
        fence: event.fence,
        status: 'started',
      };
      break;
    }
    case 'ClaimPublished': {
      requireCurrentAttempt(projection, event);
      requireDeclaredPublication(plan, projection, event);
      if (projection.claims[event.claimId]) {
        throw new ClaimKernelError('DUPLICATE_CLAIM', `Claim ${event.claimId} already exists`);
      }
      const claim: CandidateClaimInput = {
        claimId: event.claimId,
        claim: event.claim,
        payload: immutableCanonicalValue(event.payload),
        payloadFingerprint: event.payloadFingerprint,
        producerCheckId: event.producerCheckId,
        scope: cloneScope(event.scope),
        attemptId: event.attemptId,
        fence: event.fence,
        parentClaimIds: [...event.parentClaimIds],
      };
      next.claims[event.claimId] = claim;
      next.activeClaimIdsByRef[event.claim] = event.claimId;
      break;
    }
    case 'CheckScheduled': {
      requireCurrentAttempt(projection, event);
      const expected = exactActiveClaimIds(plan, projection, event.checkId);
      if (new Set(event.claimIds).size !== event.claimIds.length || !sameIds(event.claimIds, expected)) {
        throw new ClaimKernelError(
          'INVALID_SCHEDULED_CLAIMS',
          `Check ${event.checkId} was not scheduled with its exact declared active claims`
        );
      }
      next.scheduled.push(event);
      break;
    }
    case 'AttemptCompleted': {
      const current = requireCurrentAttempt(projection, event);
      exactScheduledParentIds(plan, projection, event);
      requireAllDeclaredEmissions(plan, projection, event);
      next.attempts[attemptKey] = { ...current, status: 'completed' };
      break;
    }
    case 'AttemptFailed': {
      const current = requireCurrentAttempt(projection, event);
      if (hasPublishedClaimForAttempt(projection, event)) {
        throw new ClaimKernelError(
          'PARTIAL_CLAIM_PUBLICATION',
          `Failed attempt ${event.attemptId} cannot retain published claims`
        );
      }
      next.attempts[attemptKey] = { ...current, status: 'failed', reason: event.reason };
      break;
    }
  }
  return immutableCanonicalValue<ClaimProjection>(next);
}

export function replayClaimEvents(
  events: readonly ClaimRuntimeEvent[],
  plan: ClaimPlan
): ClaimProjection {
  return events.reduce(
    (projection, event) => reduceClaimEvent(projection, event, plan),
    createInitialClaimProjection()
  );
}

function formatValidationErrors(validate: ValidateFunction): string {
  return (validate.errors || [])
    .map(error => `${error.instancePath || '/'} ${error.message || 'is invalid'}`)
    .join('; ');
}

/** Compile a claim schema once, strictly, before any provider may launch. */
export function compileClaimSchema(schema: Record<string, unknown>): ClaimSchemaValidator {
  const ajv = new Ajv({
    allErrors: true,
    allowUnionTypes: true,
    strict: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  addFormats(ajv);
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    throw new ClaimKernelError(
      'INVALID_CLAIM_SCHEMA',
      `Invalid claim schema: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return Object.freeze((payload: unknown): void => {
    canonicalJson(payload);
    if (!validate(payload)) {
      const detail = formatValidationErrors(validate);
      throw new ClaimKernelError(
        'CLAIM_SCHEMA_INVALID',
        `Candidate claim payload failed schema validation${detail ? `: ${detail}` : ''}`
      );
    }
  });
}

export function buildClaimPublishedEvent(input: {
  eventId: number;
  sessionId: string;
  checkId: string;
  scope: ScopePath;
  attemptId: string;
  fence: number;
  claim: string;
  payload: unknown;
  parentClaimIds: readonly string[];
  projection: ClaimProjection;
  plan: ClaimPlan;
}): ClaimPublishedEvent {
  requireCurrentAttempt(input.projection, {
    version: 1,
    eventId: input.eventId,
    sessionId: input.sessionId,
    checkId: input.checkId,
    scope: input.scope,
    attemptId: input.attemptId,
    fence: input.fence,
  });
  const validator = input.plan.validatorsByClaim[input.claim];
  if (!validator) {
    throw new ClaimKernelError('UNDECLARED_CLAIM_PUBLICATION', `Unknown claim ${input.claim}`);
  }
  validator(input.payload);
  const payload = immutableCanonicalValue(input.payload);
  const payloadFingerprint = sha256Canonical(payload);
  const parentClaimIds = [...input.parentClaimIds];
  const claimId = sha256Canonical({
    claim: input.claim,
    payloadFingerprint,
    producerCheckId: input.checkId,
    scope: input.scope,
    attemptId: input.attemptId,
    fence: input.fence,
    parentClaimIds: [...parentClaimIds].sort(),
  });
  return {
    version: 1,
    type: 'ClaimPublished',
    eventId: input.eventId,
    sessionId: input.sessionId,
    checkId: input.checkId,
    producerCheckId: input.checkId,
    scope: cloneScope(input.scope),
    attemptId: input.attemptId,
    fence: input.fence,
    claimId,
    claim: input.claim,
    payload,
    payloadFingerprint,
    parentClaimIds,
  };
}
