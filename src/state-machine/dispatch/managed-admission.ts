import type { EngineContext } from '../../types/engine';
import {
  canonicalJson,
  immutableCanonicalValue,
} from '../graph/claim-kernel';
import type {
  GeneratedClaimPublishedEvent,
  ExpansionCoverageProjection,
  ManagedRunBindingV1,
} from '../graph/instance-kernel';

/** The detached request handed to the internal admission decision sink. */
export interface ManagedGeneratedAdmissionRequestV1 {
  readonly version: 1;
  readonly binding: ManagedRunBindingV1;
  readonly pendingEventId: number;
  readonly committedThroughEventId: number;
  readonly claims: readonly GeneratedClaimPublishedEvent[];
  readonly coverage: ExpansionCoverageProjection | null;
  readonly providerOutput: unknown;
}

export interface ManagedAdmissionAcceptedDecisionV1 {
  readonly version: 1;
  readonly kind: 'accepted';
  readonly binding: ManagedRunBindingV1;
  readonly admissionId: string;
}

export interface ManagedAdmissionRejectedDecisionV1 {
  readonly version: 1;
  readonly kind: 'rejected';
  readonly binding: ManagedRunBindingV1;
  readonly reason: string;
}

export type ManagedAdmissionDecisionV1 =
  | ManagedAdmissionAcceptedDecisionV1
  | ManagedAdmissionRejectedDecisionV1;

export interface ManagedAdmissionSinkV1 {
  readonly decide: (
    request: ManagedGeneratedAdmissionRequestV1
  ) => Promise<ManagedAdmissionDecisionV1>;
}

/** Receipt returned by the journal after a durable resolution. */
export interface ManagedAdmissionResolutionReceiptV1 {
  readonly version: 1;
  readonly kind: 'accepted' | 'rejected';
  readonly binding: ManagedRunBindingV1;
  readonly admissionId?: string;
  readonly reason?: string;
  readonly resolvedEventId: number;
  readonly activationEventIds: readonly number[];
}

// These collections deliberately have no public accessor for their contents.
// A caller must possess the opaque object returned by create... to install a sink.
const admissionCapabilities = new WeakSet<object>();
const admissionSinks = new WeakMap<object, ManagedAdmissionSinkV1>();

export interface ManagedAdmissionCapabilityV1 {
  readonly __managedAdmissionCapability: true;
}

export function createManagedAdmissionCapability(): ManagedAdmissionCapabilityV1 {
  const capability = Object.freeze({ __managedAdmissionCapability: true as const });
  admissionCapabilities.add(capability);
  return capability;
}

function isContext(value: unknown): value is EngineContext {
  return value !== null && typeof value === 'object';
}

function isSink(value: unknown): value is ManagedAdmissionSinkV1 {
  return value !== null && typeof value === 'object' &&
    typeof (value as { decide?: unknown }).decide === 'function';
}

/** Install exactly one sink for one engine context before dispatch begins. */
export function installManagedAdmissionSink(
  context: EngineContext,
  capability: ManagedAdmissionCapabilityV1,
  sink: ManagedAdmissionSinkV1
): void {
  if (!isContext(context) || !admissionCapabilities.has(capability as object)) {
    throw new TypeError('Invalid managed admission bootstrap capability');
  }
  if (!isSink(sink)) throw new TypeError('Managed admission sink must implement decide');
  if (admissionSinks.has(context)) {
    throw new TypeError('Managed admission sink is already installed for this engine context');
  }
  admissionSinks.set(context, sink);
}

export function resolveManagedAdmissionSink(
  context: EngineContext
): ManagedAdmissionSinkV1 | undefined {
  return admissionSinks.get(context);
}

// Descriptive aliases make the internal bootstrap seam easy to use from focused
// tests without adding any SDK/config/runner installation path.
export const bindManagedAdmissionSink = installManagedAdmissionSink;
export const getManagedAdmissionSink = resolveManagedAdmissionSink;

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === expected.length &&
    actual.every(key => typeof key === 'string' && expected.includes(key));
}

function bindingShape(value: unknown): value is ManagedRunBindingV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return exactKeys(value, [
    'managedRunId', 'sessionId', 'checkId', 'scope', 'nodeInstanceId',
    'nodeGenerationId', 'attemptId', 'fence',
  ]);
}

/** Validate and detach a decision before it reaches journal mutation code. */
export function normalizeManagedAdmissionDecision(
  value: unknown
): ManagedAdmissionDecisionV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Managed admission decision must be an object');
  }
  const decision = value as Record<string, unknown>;
  const kind = decision.kind;
  const expected = kind === 'accepted'
    ? ['version', 'kind', 'binding', 'admissionId']
    : kind === 'rejected'
      ? ['version', 'kind', 'binding', 'reason']
      : [];
  if (expected.length === 0 || !exactKeys(decision, expected) || decision.version !== 1 || !bindingShape(decision.binding)) {
    throw new TypeError('Managed admission decision shape is invalid');
  }
  if (kind === 'accepted') {
    if (typeof decision.admissionId !== 'string' || decision.admissionId.length === 0) {
      throw new TypeError('Accepted managed admission requires a non-empty admissionId');
    }
  } else if (typeof decision.reason !== 'string' || decision.reason.length === 0) {
    throw new TypeError('Rejected managed admission requires a non-empty reason');
  }
  // canonicalJson also rejects accessors, non-plain objects, cycles, and other
  // values that could make a transport-neutral decision ambiguous.
  canonicalJson(decision);
  return immutableCanonicalValue(decision) as ManagedAdmissionDecisionV1;
}

export function freezeManagedAdmissionRequest(
  request: ManagedGeneratedAdmissionRequestV1
): ManagedGeneratedAdmissionRequestV1 {
  canonicalJson(request.providerOutput);
  return immutableCanonicalValue(request);
}
