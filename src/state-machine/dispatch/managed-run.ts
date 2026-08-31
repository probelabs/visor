import type {
  ManagedAgentRun,
  ManagedRunCancelReceiptV1,
  ManagedRunCleanupReceiptV1,
  ManagedRunOutcomeV1,
  ManagedRunStartRequest,
  ManagedRunStartedReceiptV1,
} from '../../providers/check-provider.interface';
import type { ReviewSummary } from '../../reviewer';
import { validateProofCandidateEvidence } from '../../providers/governed-proof-inspect-check-provider';
import { canonicalJson, immutableCanonicalValue } from '../graph/claim-kernel';
import {
  requireKeyedScopePath,
  type ManagedRunBindingV1,
  type ManagedRunFailureCode,
} from '../graph/instance-kernel';

type ManagedRunProtocolFailureCode = Extract<
  ManagedRunFailureCode,
  | 'MANAGED_HANDLE_INVALID'
  | 'MANAGED_BINDING_MISMATCH'
  | 'MANAGED_START_FAILED'
  | 'MANAGED_STARTED_RECEIPT_INVALID'
  | 'MANAGED_OUTCOME_RECEIPT_INVALID'
  | 'MANAGED_CANCEL_FAILED'
  | 'MANAGED_CANCEL_RECEIPT_INVALID'
  | 'MANAGED_CLOSE_FAILED'
  | 'MANAGED_CLEANUP_RECEIPT_INVALID'
>;

const PROTOCOL_MESSAGES: Readonly<Record<ManagedRunProtocolFailureCode, string>> = Object.freeze({
  MANAGED_HANDLE_INVALID: 'Managed provider returned an invalid handle',
  MANAGED_BINDING_MISMATCH: 'Managed provider binding does not match controller authority',
  MANAGED_START_FAILED: 'Managed provider acquisition failed',
  MANAGED_STARTED_RECEIPT_INVALID: 'Managed provider returned an invalid started receipt',
  MANAGED_OUTCOME_RECEIPT_INVALID: 'Managed provider returned an invalid outcome receipt',
  MANAGED_CANCEL_FAILED: 'Managed provider cancellation failed',
  MANAGED_CANCEL_RECEIPT_INVALID: 'Managed provider returned an invalid cancellation receipt',
  MANAGED_CLOSE_FAILED: 'Managed provider cleanup failed',
  MANAGED_CLEANUP_RECEIPT_INVALID: 'Managed provider returned an invalid cleanup receipt',
});

const BINDING_KEYS = Object.freeze([
  'managedRunId',
  'sessionId',
  'checkId',
  'scope',
  'nodeInstanceId',
  'nodeGenerationId',
  'attemptId',
  'fence',
] as const);

const HANDLE_KEYS = Object.freeze(['binding', 'started', 'outcome', 'cancel', 'close'] as const);

// Capture controller intrinsics before any provider code can run. Provider-owned
// Promise methods and later prototype changes are never consulted.
const ControllerPromise = Promise;
const controllerPromiseThen = Promise.prototype.then;

/** Stable, data-minimal failure surfaced by the managed provider boundary. */
export class ManagedRunProtocolError extends Error {
  readonly code: ManagedRunProtocolFailureCode;

  constructor(code: ManagedRunProtocolFailureCode) {
    super(PROTOCOL_MESSAGES[code]);
    this.name = 'ManagedRunProtocolError';
    this.code = code;
  }
}

export interface ManagedRunSnapshot {
  readonly binding: ManagedRunBindingV1;
  readonly started: Promise<ManagedRunStartedReceiptV1>;
  readonly outcome: Promise<ManagedRunOutcomeV1>;
  readonly cancelOnce: (
    reason: 'deadline',
    fence: number
  ) => Promise<ManagedRunCancelReceiptV1>;
  readonly closeOnce: () => Promise<ManagedRunCleanupReceiptV1>;
}

export interface ManagedRunDeadlineSettlement {
  readonly cancel: PromiseSettledResult<ManagedRunCancelReceiptV1> | null;
  readonly close: PromiseSettledResult<ManagedRunCleanupReceiptV1>;
  readonly cancelRequested: boolean;
}

export interface ManagedRunDeadline {
  /** Resolves only after the independently started cancel and close calls both settle. */
  readonly fired: Promise<ManagedRunDeadlineSettlement>;
  readonly didFire: () => boolean;
  /** The controller calls this only after close has settled on the ordinary path. */
  readonly clear: () => void;
}

function protocolError(code: ManagedRunProtocolFailureCode): ManagedRunProtocolError {
  return new ManagedRunProtocolError(code);
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}

function hasExactOwnKeys(value: object, expected: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  if (actual.length !== expected.length || actual.some(key => typeof key !== 'string')) {
    return false;
  }
  const wanted = new Set(expected);
  return actual.every(key => wanted.has(key as string));
}

function isPlainRecord(value: unknown): value is object {
  if (!isObject(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireNonEmptyString(value: unknown, code: ManagedRunProtocolFailureCode): string {
  if (typeof value !== 'string' || value.length === 0) throw protocolError(code);
  return value;
}

function normalizeBinding(
  value: unknown,
  code: ManagedRunProtocolFailureCode
): ManagedRunBindingV1 {
  try {
    if (!isPlainRecord(value) || !hasExactOwnKeys(value, BINDING_KEYS)) {
      throw protocolError(code);
    }

    const managedRunId = Reflect.get(value, 'managedRunId', value) as unknown;
    const sessionId = Reflect.get(value, 'sessionId', value) as unknown;
    const checkId = Reflect.get(value, 'checkId', value) as unknown;
    const scopeValue = Reflect.get(value, 'scope', value) as unknown;
    const nodeInstanceId = Reflect.get(value, 'nodeInstanceId', value) as unknown;
    const nodeGenerationId = Reflect.get(value, 'nodeGenerationId', value) as unknown;
    const attemptId = Reflect.get(value, 'attemptId', value) as unknown;
    const fence = Reflect.get(value, 'fence', value) as unknown;
    const scope = requireKeyedScopePath(scopeValue);

    if (typeof fence !== 'number' || !Number.isInteger(fence)) {
      throw protocolError(code);
    }

    return immutableCanonicalValue<ManagedRunBindingV1>({
      managedRunId: requireNonEmptyString(managedRunId, code),
      sessionId: requireNonEmptyString(sessionId, code),
      checkId: requireNonEmptyString(checkId, code),
      scope,
      nodeInstanceId: requireNonEmptyString(nodeInstanceId, code),
      nodeGenerationId: requireNonEmptyString(nodeGenerationId, code),
      attemptId: requireNonEmptyString(attemptId, code),
      fence,
    });
  } catch {
    throw protocolError(code);
  }
}

function bindingEquals(left: ManagedRunBindingV1, right: ManagedRunBindingV1): boolean {
  return (
    left.managedRunId === right.managedRunId &&
    left.sessionId === right.sessionId &&
    left.checkId === right.checkId &&
    canonicalJson(left.scope) === canonicalJson(right.scope) &&
    left.nodeInstanceId === right.nodeInstanceId &&
    left.nodeGenerationId === right.nodeGenerationId &&
    left.attemptId === right.attemptId &&
    left.fence === right.fence
  );
}

function controllerRejected<T>(reason: unknown): Promise<T> {
  return new ControllerPromise<T>((_resolve, reject) => reject(reason));
}

function mirrorNativePromise<T>(
  value: unknown,
  code: ManagedRunProtocolFailureCode
): Promise<T> {
  let resolveMirror!: (value: T | PromiseLike<T>) => void;
  let rejectMirror!: (reason?: unknown) => void;
  const mirror = new ControllerPromise<T>((resolve, reject) => {
    resolveMirror = resolve;
    rejectMirror = reject;
  });
  try {
    Reflect.apply(controllerPromiseThen, value, [resolveMirror, rejectMirror]);
  } catch {
    throw protocolError(code);
  }
  return mirror;
}

function observeRejection(promise: Promise<unknown>): void {
  void Reflect.apply(controllerPromiseThen, promise, [undefined, () => undefined]);
}

function copyAndFreezePlainData<T>(value: T, copies = new WeakMap<object, unknown>()): T {
  if (!isObject(value) || typeof value === 'function') return value;
  if (!Array.isArray(value) && !isPlainRecord(value)) return value;

  const existing = copies.get(value);
  if (existing !== undefined) return existing as T;

  const copy: unknown[] | Record<PropertyKey, unknown> = Array.isArray(value)
    ? []
    : Object.create(Object.getPrototypeOf(value));
  copies.set(value, copy);

  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) continue;
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: copyAndFreezePlainData(Reflect.get(value, key, value), copies),
    });
  }
  return Object.freeze(copy) as T;
}

function snapshotReadonlyMap(
  source: ReadonlyMap<string, ReviewSummary>,
  copies: WeakMap<object, unknown>
): ReadonlyMap<string, ReviewSummary> {
  const entries = Array.from(source, ([key, value]) =>
    Object.freeze([key, copyAndFreezePlainData(value, copies)] as const)
  );
  const snapshot = new Map<string, ReviewSummary>(entries);
  const shell = Object.create(null) as Record<PropertyKey, unknown>;
  Object.defineProperties(shell, {
    size: { enumerable: true, get: () => snapshot.size },
    get: { enumerable: true, value: (key: string) => snapshot.get(key) },
    has: { enumerable: true, value: (key: string) => snapshot.has(key) },
    entries: { enumerable: true, value: () => snapshot.entries() },
    keys: { enumerable: true, value: () => snapshot.keys() },
    values: { enumerable: true, value: () => snapshot.values() },
    forEach: {
      enumerable: true,
      value: (
        callback: (value: ReviewSummary, key: string, map: ReadonlyMap<string, ReviewSummary>) => void,
        thisArg?: unknown
      ) => snapshot.forEach((value, key) => callback.call(thisArg, value, key, view)),
    },
    [Symbol.iterator]: { enumerable: false, value: () => snapshot.entries() },
  });
  const view = Object.freeze(shell) as unknown as ReadonlyMap<string, ReviewSummary>;
  return view;
}

/** Build an immutable provider-only view without freezing controller-owned inputs. */
export function snapshotManagedRunStartRequest(
  request: ManagedRunStartRequest
): ManagedRunStartRequest {
  const proofAdmission = request.checkConfig.type === 'proof-admit';
  if (proofAdmission !== (request.proofAdmissionRequest !== undefined)) {
    throw new Error('PROOF_ADMISSION_REQUEST_AUTHORITY_MISMATCH');
  }
  const copies = new WeakMap<object, unknown>();
  const snapshot = {
    prInfo: copyAndFreezePlainData(request.prInfo, copies),
    checkConfig: copyAndFreezePlainData(request.checkConfig, copies),
    dependencyResults: snapshotReadonlyMap(request.dependencyResults, copies),
    executionContext: copyAndFreezePlainData(request.executionContext, copies),
    binding: copyAndFreezePlainData(request.binding, copies),
    executionConfigDigest: request.executionConfigDigest,
    workingDirectory: request.workingDirectory,
    ...(request.proofAdmissionRequest !== undefined ? { proofAdmissionRequest: request.proofAdmissionRequest } : {}),
  };
  return Object.freeze(snapshot);
}

/** Preserve the selected timeout value when valid; otherwise arm an immediate deadline. */
export function normalizeManagedRunTimeout(timeoutMs: number): number {
  return Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 0;
}

interface CapturedHandleMembers {
  readonly receiver: object;
  readonly binding: unknown;
  readonly started: unknown;
  readonly outcome: unknown;
  readonly cancel: (...args: unknown[]) => unknown;
  readonly close: (...args: unknown[]) => unknown;
}

function readHandleMembers(value: unknown): CapturedHandleMembers {
  try {
    if (!isPlainRecord(value)) throw protocolError('MANAGED_HANDLE_INVALID');
    const thenMember = Reflect.get(value, 'then', value) as unknown;
    if (thenMember !== undefined || !hasExactOwnKeys(value, HANDLE_KEYS)) {
      throw protocolError('MANAGED_HANDLE_INVALID');
    }

    // Every authoritative member is read exactly once inside this guarded block.
    const binding = Reflect.get(value, 'binding', value) as unknown;
    const started = Reflect.get(value, 'started', value) as unknown;
    const outcome = Reflect.get(value, 'outcome', value) as unknown;
    const cancel = Reflect.get(value, 'cancel', value) as unknown;
    const close = Reflect.get(value, 'close', value) as unknown;

    if (!isCallable(cancel) || !isCallable(close)) {
      throw protocolError('MANAGED_HANDLE_INVALID');
    }
    return { receiver: value, binding, started, outcome, cancel, close };
  } catch {
    throw protocolError('MANAGED_HANDLE_INVALID');
  }
}

/**
 * Invoke start exactly once, then synchronously detach all handle authority
 * from provider mutation before any provider-controlled await can occur.
 */
export function snapshotManagedRun(
  start: () => ManagedAgentRun,
  expectedBinding: ManagedRunBindingV1
): ManagedRunSnapshot {
  const binding = normalizeBinding(expectedBinding, 'MANAGED_BINDING_MISMATCH');
  let returned: unknown;
  try {
    returned = start();
  } catch {
    throw protocolError('MANAGED_START_FAILED');
  }

  const members = readHandleMembers(returned);
  const echoedBinding = normalizeBinding(members.binding, 'MANAGED_HANDLE_INVALID');
  if (!bindingEquals(binding, echoedBinding)) {
    throw protocolError('MANAGED_BINDING_MISMATCH');
  }

  const started = mirrorNativePromise<ManagedRunStartedReceiptV1>(
    members.started,
    'MANAGED_HANDLE_INVALID'
  );
  const outcome = mirrorNativePromise<ManagedRunOutcomeV1>(
    members.outcome,
    'MANAGED_HANDLE_INVALID'
  );
  observeRejection(started);
  observeRejection(outcome);

  let cancelStarted = false;
  let cancelPromise: Promise<ManagedRunCancelReceiptV1> | undefined;
  const cancelOnce = (
    reason: 'deadline',
    fence: number
  ): Promise<ManagedRunCancelReceiptV1> => {
    if (!cancelStarted) {
      cancelStarted = true;
      let firstPromise: Promise<ManagedRunCancelReceiptV1>;
      try {
        const value: unknown = Reflect.apply(members.cancel, members.receiver, [reason, fence]);
        firstPromise = mirrorNativePromise<ManagedRunCancelReceiptV1>(
          value,
          'MANAGED_CANCEL_FAILED'
        );
      } catch {
        firstPromise = controllerRejected(protocolError('MANAGED_CANCEL_FAILED'));
      }
      cancelPromise = firstPromise;
      observeRejection(firstPromise);
    }
    return cancelPromise as Promise<ManagedRunCancelReceiptV1>;
  };

  let closeStarted = false;
  let closePromise: Promise<ManagedRunCleanupReceiptV1> | undefined;
  const closeOnce = (): Promise<ManagedRunCleanupReceiptV1> => {
    if (!closeStarted) {
      closeStarted = true;
      let firstPromise: Promise<ManagedRunCleanupReceiptV1>;
      try {
        const value: unknown = Reflect.apply(members.close, members.receiver, []);
        firstPromise = mirrorNativePromise<ManagedRunCleanupReceiptV1>(
          value,
          'MANAGED_CLOSE_FAILED'
        );
      } catch {
        firstPromise = controllerRejected(protocolError('MANAGED_CLOSE_FAILED'));
      }
      closePromise = firstPromise;
      observeRejection(firstPromise);
    }
    return closePromise as Promise<ManagedRunCleanupReceiptV1>;
  };

  return Object.freeze({
    binding,
    started,
    outcome,
    cancelOnce,
    closeOnce,
  });
}

function normalizeReceiptBinding(
  value: unknown,
  expectedBinding: ManagedRunBindingV1,
  code: ManagedRunProtocolFailureCode
): ManagedRunBindingV1 {
  const expected = normalizeBinding(expectedBinding, code);
  const actual = normalizeBinding(value, code);
  if (!bindingEquals(expected, actual)) throw protocolError(code);
  return expected;
}

export function normalizeManagedRunStartedReceipt(
  value: unknown,
  expectedBinding: ManagedRunBindingV1
): ManagedRunStartedReceiptV1 {
  const code = 'MANAGED_STARTED_RECEIPT_INVALID';
  try {
    if (!isPlainRecord(value) || !hasExactOwnKeys(value, ['version', 'kind', 'binding'])) {
      throw protocolError(code);
    }
    const version = Reflect.get(value, 'version', value) as unknown;
    const kind = Reflect.get(value, 'kind', value) as unknown;
    const receiptBinding = Reflect.get(value, 'binding', value) as unknown;
    if (version !== 1 || kind !== 'started') throw protocolError(code);
    const binding = normalizeReceiptBinding(receiptBinding, expectedBinding, code);
    return Object.freeze({ version: 1, kind: 'started', binding });
  } catch {
    throw protocolError(code);
  }
}

export function normalizeManagedRunOutcome(
  value: unknown,
  expectedBinding: ManagedRunBindingV1
): ManagedRunOutcomeV1 {
  const code = 'MANAGED_OUTCOME_RECEIPT_INVALID';
  try {
    if (!isPlainRecord(value)) throw protocolError(code);
    const kind = Reflect.get(value, 'kind', value) as unknown;
    const expectedKeys = kind === 'succeeded'
      ? ['version', 'kind', 'binding', 'summary']
      : kind === 'succeeded-proof-candidate'
        ? ['version', 'kind', 'binding', 'summary', 'proofCandidateEvidence']
      : ['version', 'kind', 'binding'];
    if (!hasExactOwnKeys(value, expectedKeys)) throw protocolError(code);

    const version = Reflect.get(value, 'version', value) as unknown;
    const receiptBinding = Reflect.get(value, 'binding', value) as unknown;
    if (version !== 1 || (kind !== 'succeeded' && kind !== 'succeeded-proof-candidate' && kind !== 'failed')) {
      throw protocolError(code);
    }
    const binding = normalizeReceiptBinding(receiptBinding, expectedBinding, code);
    if (kind === 'failed') return Object.freeze({ version: 1, kind, binding });

    const summary = Reflect.get(value, 'summary', value) as unknown;
    if (!isPlainRecord(summary)) throw protocolError(code);
    if (kind === 'succeeded-proof-candidate') {
      const proofCandidateEvidence = validateProofCandidateEvidence(Reflect.get(value, 'proofCandidateEvidence', value));
      return Object.freeze({
        version: 1,
        kind,
        binding,
        summary: immutableCanonicalValue<ReviewSummary>(summary as ReviewSummary),
        proofCandidateEvidence,
      });
    }
    return Object.freeze({
      version: 1,
      kind,
      binding,
      // Detach semantic evidence from the provider before cleanup can await.
      // Later mutation of the outcome receipt cannot change Visor's decision.
      summary: immutableCanonicalValue<ReviewSummary>(summary as ReviewSummary),
    });
  } catch {
    throw protocolError(code);
  }
}

export function normalizeManagedRunCancelReceipt(
  value: unknown,
  expectedBinding: ManagedRunBindingV1
): ManagedRunCancelReceiptV1 {
  const code = 'MANAGED_CANCEL_RECEIPT_INVALID';
  try {
    if (
      !isPlainRecord(value) ||
      !hasExactOwnKeys(value, ['version', 'kind', 'binding', 'reason'])
    ) {
      throw protocolError(code);
    }
    const version = Reflect.get(value, 'version', value) as unknown;
    const kind = Reflect.get(value, 'kind', value) as unknown;
    const receiptBinding = Reflect.get(value, 'binding', value) as unknown;
    const reason = Reflect.get(value, 'reason', value) as unknown;
    if (version !== 1 || kind !== 'cancelled' || reason !== 'deadline') {
      throw protocolError(code);
    }
    const binding = normalizeReceiptBinding(receiptBinding, expectedBinding, code);
    return Object.freeze({ version: 1, kind: 'cancelled', binding, reason: 'deadline' });
  } catch {
    throw protocolError(code);
  }
}

export function normalizeManagedRunCleanupReceipt(
  value: unknown,
  expectedBinding: ManagedRunBindingV1
): ManagedRunCleanupReceiptV1 {
  const code = 'MANAGED_CLEANUP_RECEIPT_INVALID';
  try {
    if (
      !isPlainRecord(value) ||
      !hasExactOwnKeys(value, [
        'version',
        'kind',
        'binding',
        'status',
        'activeChildren',
        'activeResources',
      ])
    ) {
      throw protocolError(code);
    }
    const version = Reflect.get(value, 'version', value) as unknown;
    const kind = Reflect.get(value, 'kind', value) as unknown;
    const receiptBinding = Reflect.get(value, 'binding', value) as unknown;
    const status = Reflect.get(value, 'status', value) as unknown;
    const activeChildren = Reflect.get(value, 'activeChildren', value) as unknown;
    const activeResources = Reflect.get(value, 'activeResources', value) as unknown;
    if (
      version !== 1 ||
      kind !== 'cleanup' ||
      status !== 'clean' ||
      activeChildren !== 0 ||
      activeResources !== 0
    ) {
      throw protocolError(code);
    }
    const binding = normalizeReceiptBinding(receiptBinding, expectedBinding, code);
    return Object.freeze({
      version: 1,
      kind: 'cleanup',
      binding,
      status: 'clean',
      activeChildren: 0,
      activeResources: 0,
    });
  } catch {
    throw protocolError(code);
  }
}

function frozenSettledResult<T>(result: PromiseSettledResult<T>): PromiseSettledResult<T> {
  return result.status === 'fulfilled'
    ? Object.freeze({ status: 'fulfilled', value: result.value })
    : Object.freeze({ status: 'rejected', reason: result.reason });
}

function settleCancelAndClose(
  cancel: Promise<ManagedRunCancelReceiptV1>,
  close: Promise<ManagedRunCleanupReceiptV1>
): Promise<[
  PromiseSettledResult<ManagedRunCancelReceiptV1>,
  PromiseSettledResult<ManagedRunCleanupReceiptV1>,
]> {
  return new ControllerPromise(resolve => {
    let remaining = 2;
    let cancelResult!: PromiseSettledResult<ManagedRunCancelReceiptV1>;
    let closeResult!: PromiseSettledResult<ManagedRunCleanupReceiptV1>;
    const settled = () => {
      remaining--;
      if (remaining === 0) resolve([cancelResult, closeResult]);
    };
    Reflect.apply(controllerPromiseThen, cancel, [
      (value: ManagedRunCancelReceiptV1) => {
        cancelResult = { status: 'fulfilled', value };
        settled();
      },
      (reason: unknown) => {
        cancelResult = { status: 'rejected', reason };
        settled();
      },
    ]);
    Reflect.apply(controllerPromiseThen, close, [
      (value: ManagedRunCleanupReceiptV1) => {
        closeResult = { status: 'fulfilled', value };
        settled();
      },
      (reason: unknown) => {
        closeResult = { status: 'rejected', reason };
        settled();
      },
    ]);
  });
}

/**
 * Arm the managed run's sole deadline timer. Once the journal callback commits,
 * cancel and close are invoked back-to-back before either is awaited.
 */
export function armManagedRunDeadline(input: {
  readonly snapshot: ManagedRunSnapshot;
  readonly timeoutMs: number;
  readonly onCancelRequested: () => void;
}): ManagedRunDeadline {
  let didFire = false;
  let cleared = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fired = new ControllerPromise<ManagedRunDeadlineSettlement>(resolve => {
    timer = setTimeout(() => {
      didFire = true;
      let cancelRequested = true;
      try {
        input.onCancelRequested();
      } catch {
        cancelRequested = false;
      }

      let cancel: Promise<ManagedRunCancelReceiptV1> | undefined;
      if (cancelRequested) {
        try {
          cancel = input.snapshot.cancelOnce('deadline', input.snapshot.binding.fence);
        } catch {
          cancel = controllerRejected(protocolError('MANAGED_CANCEL_FAILED'));
        }
      }
      let close: Promise<ManagedRunCleanupReceiptV1>;
      try {
        close = input.snapshot.closeOnce();
      } catch {
        close = controllerRejected(protocolError('MANAGED_CLOSE_FAILED'));
      }
      if (cancel) observeRejection(cancel);
      observeRejection(close);

      if (!cancel) {
        void Reflect.apply(controllerPromiseThen, close, [
          (value: ManagedRunCleanupReceiptV1) => resolve(Object.freeze({
            cancel: null,
            close: frozenSettledResult({ status: 'fulfilled', value }),
            cancelRequested: false,
          })),
          (reason: unknown) => resolve(Object.freeze({
            cancel: null,
            close: frozenSettledResult<ManagedRunCleanupReceiptV1>({
              status: 'rejected',
              reason,
            }),
            cancelRequested: false,
          })),
        ]);
        return;
      }

      void Reflect.apply(controllerPromiseThen, settleCancelAndClose(cancel, close), [
        (results: [
          PromiseSettledResult<ManagedRunCancelReceiptV1>,
          PromiseSettledResult<ManagedRunCleanupReceiptV1>,
        ]) => resolve(Object.freeze({
          cancel: frozenSettledResult(results[0]),
          close: frozenSettledResult(results[1]),
          cancelRequested: true,
        })),
      ]);
    }, normalizeManagedRunTimeout(input.timeoutMs));
  });
  observeRejection(fired);

  return Object.freeze({
    fired,
    didFire: () => didFire,
    clear: () => {
      if (cleared || didFire) return;
      cleared = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  });
}
