import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

jest.mock('../../src/state-machine/dispatch/managed-run', () => {
  const actual = jest.requireActual<typeof import('../../src/state-machine/dispatch/managed-run')>(
    '../../src/state-machine/dispatch/managed-run'
  );
  return { ...actual, snapshotManagedRun: jest.fn(actual.snapshotManagedRun) };
});
jest.mock('../../src/telemetry/trace-helpers', () => {
  const actual = jest.requireActual<typeof import('../../src/telemetry/trace-helpers')>(
    '../../src/telemetry/trace-helpers'
  );
  return { ...actual, emitImmediateSpan: jest.fn(actual.emitImmediateSpan) };
});
jest.mock('../../src/telemetry/fallback-ndjson', () => {
  const actual = jest.requireActual<typeof import('../../src/telemetry/fallback-ndjson')>(
    '../../src/telemetry/fallback-ndjson'
  );
  return { ...actual, emitNdjsonFallback: jest.fn(actual.emitNdjsonFallback) };
});

import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import {
  CheckProvider,
  type CheckProviderConfig,
  type ExecutionContext,
  type ManagedAgentRun,
  type ManagedRunCancelReceiptV1,
  type ManagedRunCleanupReceiptV1,
  type ManagedRunOutcomeV1,
  type ManagedRunStartRequest,
  type ManagedRunStartedReceiptV1,
} from '../../src/providers/check-provider.interface';
import type { ManagedRunBindingV1 } from '../../src/state-machine/graph/instance-kernel';
import type { PRInfo } from '../../src/pr-analyzer';
import type { ReviewSummary } from '../../src/reviewer';
import type { VisorConfig } from '../../src/types/config';
import { SandboxManager } from '../../src/sandbox/sandbox-manager';
import { EventBus } from '../../src/event-bus/event-bus';
import * as traceHelpers from '../../src/telemetry/trace-helpers';
import * as ndjsonTelemetry from '../../src/telemetry/fallback-ndjson';
import * as managedRunHelpers from '../../src/state-machine/dispatch/managed-run';

const realManagedRunHelpers = jest.requireActual<
  typeof import('../../src/state-machine/dispatch/managed-run')
>('../../src/state-machine/dispatch/managed-run');
const realTraceHelpers = jest.requireActual<typeof import('../../src/telemetry/trace-helpers')>(
  '../../src/telemetry/trace-helpers'
);
const realNdjsonTelemetry = jest.requireActual<
  typeof import('../../src/telemetry/fallback-ndjson')
>('../../src/telemetry/fallback-ndjson');

function resetObservableModuleMocks(): void {
  jest.mocked(managedRunHelpers.snapshotManagedRun)
    .mockReset()
    .mockImplementation(realManagedRunHelpers.snapshotManagedRun);
  jest.mocked(traceHelpers.emitImmediateSpan)
    .mockReset()
    .mockImplementation(realTraceHelpers.emitImmediateSpan);
  jest.mocked(ndjsonTelemetry.emitNdjsonFallback)
    .mockReset()
    .mockImplementation(realNdjsonTelemetry.emitNdjsonFallback);
}

const MANAGED_PROVIDER = 'exp-0123-managed';
const LEGACY_PROVIDER = 'exp-0123-legacy';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`Deterministic fixture did not reach: ${label}`);
}

const prInfo = {
  number: 1,
  title: 'Managed graph-run ownership',
  author: 'test',
  base: 'main',
  head: 'candidate',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  eventType: 'manual',
} as PRInfo;

function fixtureConfig(provider = MANAGED_PROVIDER): VisorConfig {
  return {
    version: '1.0',
    max_parallelism: 1,
    workspace: { enabled: false },
    claim_types: {
      'component.catalog@1': {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['components'],
          properties: {
            components: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'path'],
                properties: {
                  id: { type: 'string', minLength: 1 },
                  path: { type: 'string', minLength: 1 },
                },
              },
            },
          },
        },
      },
      'component.item@1': {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'path'],
          properties: {
            id: { type: 'string', minLength: 1 },
            path: { type: 'string', minLength: 1 },
          },
        },
      },
      'component.onboarded@1': {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'findings'],
          properties: {
            id: { type: 'string', minLength: 1 },
            findings: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    subgraphs: {
      'onboard-component': {
        input: { name: 'component', claim: 'component.item@1' },
        checks: {
          inspect: {
            type: provider,
            timeout: 1800000,
            consumes: [{ claim: 'component.item@1', as: 'component' }],
            emits: [{ claim: 'component.onboarded@1', from: 'output' }],
          },
        },
      },
    },
    checks: {
      'discover-components': {
        type: provider,
        emits: [{ claim: 'component.catalog@1', from: 'output' }],
        expand: {
          claim: 'component.catalog@1',
          template: 'onboard-component',
          items_pointer: '/components',
          key_pointer: '/id',
          item_claim: 'component.item@1',
        },
      },
    },
  };
}

function startedReceipt(binding: ManagedRunBindingV1): ManagedRunStartedReceiptV1 {
  return { version: 1, kind: 'started', binding };
}

function successOutcome(
  binding: ManagedRunBindingV1,
  summary: ReviewSummary
): ManagedRunOutcomeV1 {
  return { version: 1, kind: 'succeeded', binding, summary };
}

function cancelReceipt(binding: ManagedRunBindingV1): ManagedRunCancelReceiptV1 {
  return { version: 1, kind: 'cancelled', binding, reason: 'deadline' };
}

function cleanupReceipt(binding: ManagedRunBindingV1): ManagedRunCleanupReceiptV1 {
  return {
    version: 1,
    kind: 'cleanup',
    binding,
    status: 'clean',
    activeChildren: 0,
    activeResources: 0,
  };
}

function setManagedTimeout(config: VisorConfig, timeout: number): void {
  (config.subgraphs!['onboard-component'].checks.inspect as any).timeout = timeout;
}

type AcquisitionMode =
  | 'valid'
  | 'throw'
  | 'thenable'
  | 'throwing-getter'
  | 'null'
  | 'missing-member'
  | 'extra-member'
  | 'wrong-member'
  | 'wrong-binding';

const IDENTITY_FIELDS = [
  'sessionId',
  'checkId',
  'scope',
  'managedRunId',
  'nodeInstanceId',
  'nodeGenerationId',
  'attemptId',
  'fence',
] as const;
type IdentityField = (typeof IDENTITY_FIELDS)[number];
type IdentityPosition = 'handle' | 'started' | 'outcome' | 'cancel' | 'cleanup';

function mismatchedBinding(
  binding: ManagedRunBindingV1,
  field: IdentityField
): ManagedRunBindingV1 {
  if (field === 'scope') {
    return {
      ...binding,
      scope: [{ ...binding.scope[0], key: 'wrong-scope' }],
    };
  }
  if (field === 'fence') {
    return { ...binding, fence: binding.fence + 1 };
  }
  return { ...binding, [field]: `wrong-${field}` };
}

interface ManagedControl {
  readonly request: ManagedRunStartRequest;
  readonly binding: ManagedRunBindingV1;
  readonly started: ReturnType<typeof deferred<ManagedRunStartedReceiptV1>>;
  readonly outcome: ReturnType<typeof deferred<ManagedRunOutcomeV1>>;
  readonly cancel: ReturnType<typeof deferred<ManagedRunCancelReceiptV1>>;
  readonly close: ReturnType<typeof deferred<ManagedRunCleanupReceiptV1>>;
  readonly handle: ManagedAgentRun;
  readonly scheduleVisibleAtStart: boolean;
  readonly timeoutCallsAtStart: number;
  readonly intervalCallsAtStart: number;
  cancelCalls: Array<{ reason: 'deadline'; fence: number; receiver: unknown }>;
  closeCalls: number;
  closeReceivers: unknown[];
}

function keyOf(request: ManagedRunStartRequest): string {
  const scope = request.binding.scope;
  return scope.length === 0 ? 'root' : scope[scope.length - 1].key;
}

function attemptEvents(engine: StateMachineExecutionEngine, attemptId: string): readonly any[] {
  return (engine as any)._lastContext.journal.readRuntimeEvents().filter(
    (event: any) => event.attemptId === attemptId || event.binding?.attemptId === attemptId
  );
}

function expectSerializedControllerBinding(
  events: readonly unknown[],
  binding: ManagedRunBindingV1
): void {
  const serialized = JSON.parse(JSON.stringify(events)) as Array<Record<string, any>>;
  for (const event of serialized) {
    expect(event.sessionId).toBe(binding.sessionId);
    expect(event.scope).toEqual(binding.scope);
    if ('checkId' in event) expect(event.checkId).toBe(binding.checkId);
    if ('nodeInstanceId' in event) expect(event.nodeInstanceId).toBe(binding.nodeInstanceId);
    if ('nodeGenerationId' in event) {
      expect(event.nodeGenerationId).toBe(binding.nodeGenerationId);
    }
    if ('attemptId' in event) expect(event.attemptId).toBe(binding.attemptId);
    if ('fence' in event) expect(event.fence).toBe(binding.fence);
    if ('binding' in event) expect(event.binding).toEqual(binding);
  }
}

describe('EXP-0123 managed graph-run ownership', () => {
  const registry = CheckProviderRegistry.getInstance();
  let engine: StateMachineExecutionEngine;
  let catalogs: Array<Array<{ id: string; path: string }>>;
  let catalogCalls: number;
  let controls: ManagedControl[];
  let acquisitionMode: AcquisitionMode;
  let startManagedCalls: number;
  let originalCancelCalls: number;
  let originalCloseCalls: number;
  let replacementCancelCalls: number;
  let replacementCloseCalls: number;
  let activeHandles: number;
  let launchOrder: string[];
  let terminalVisibleAtCompletion: boolean[];
  let timeoutCallCount: () => number;
  let intervalCallCount: () => number;
  let identityPosition: IdentityPosition | undefined;
  let observationLane: string[] | undefined;
  let legacyInspectResult: ReviewSummary | undefined;
  let legacyIntervalCallsAtInspectStart: number;
  let mutateRequestAtStart: boolean;
  let requestMutationEvidence: Record<string, unknown> | undefined;
  let callerExecutionContext: ExecutionContext;
  let poisonProviderStartPromises:
    ((started: Promise<unknown>, outcome: Promise<unknown>) => void) | undefined;
  let poisonProviderSettlementPromise: ((promise: Promise<unknown>) => void) | undefined;

  class ManagedFixtureProvider extends CheckProvider {
    getName() {
      return MANAGED_PROVIDER;
    }
    getDescription() {
      return 'EXP-0123 deterministic managed provider';
    }
    async validateConfig() {
      return true;
    }
    async isAvailable() {
      return true;
    }
    getRequirements() {
      return [];
    }
    getSupportedConfigKeys() {
      return ['type'];
    }
    async execute(
      _pr: PRInfo,
      config: CheckProviderConfig
    ): Promise<ReviewSummary> {
      const checkId = String(config.checkName);
      if (checkId !== 'discover-components') {
        throw new Error('MANAGED_GENERATED_EXECUTE_MUST_NOT_RUN');
      }
      const index = catalogCalls++;
      launchOrder.push(`catalog:${index}`);
      return {
        issues: [],
        output: { components: catalogs[Math.min(index, catalogs.length - 1)] },
      };
    }
    startManaged(request: ManagedRunStartRequest): ManagedAgentRun {
      startManagedCalls++;
      observationLane?.push(`provider:start:${keyOf(request)}`);
      if (acquisitionMode === 'throw') throw new Error('RAW_START_SECRET');
      if (acquisitionMode === 'thenable') {
        return Promise.resolve({}) as unknown as ManagedAgentRun;
      }
      if (acquisitionMode === 'null') return null as unknown as ManagedAgentRun;
      if (acquisitionMode === 'throwing-getter') {
        const bad: Record<string, unknown> = {};
        Object.defineProperties(bad, {
          binding: { enumerable: true, get: () => { throw new Error('RAW_GETTER_SECRET'); } },
          started: { enumerable: true, value: Promise.resolve() },
          outcome: { enumerable: true, value: Promise.resolve() },
          cancel: { enumerable: true, value: () => Promise.resolve() },
          close: { enumerable: true, value: () => Promise.resolve() },
        });
        return bad as unknown as ManagedAgentRun;
      }
      if (acquisitionMode === 'missing-member') {
        return {
          binding: request.binding,
          started: Promise.resolve(startedReceipt(request.binding)),
          outcome: Promise.resolve(successOutcome(request.binding, { issues: [] })),
          cancel: () => Promise.resolve(cancelReceipt(request.binding)),
        } as unknown as ManagedAgentRun;
      }
      if (acquisitionMode === 'extra-member') {
        return {
          binding: request.binding,
          started: Promise.resolve(startedReceipt(request.binding)),
          outcome: Promise.resolve(successOutcome(request.binding, { issues: [] })),
          cancel: () => Promise.resolve(cancelReceipt(request.binding)),
          close: () => Promise.resolve(cleanupReceipt(request.binding)),
          unexpected: 'RAW_EXTRA_HANDLE_MEMBER',
        } as unknown as ManagedAgentRun;
      }
      if (acquisitionMode === 'wrong-member') {
        return {
          binding: request.binding,
          started: Promise.resolve(startedReceipt(request.binding)),
          outcome: Promise.resolve(successOutcome(request.binding, { issues: [] })),
          cancel: () => Promise.resolve(cancelReceipt(request.binding)),
          close: 42,
        } as unknown as ManagedAgentRun;
      }

      const identityField = IDENTITY_FIELDS.find(field => field === keyOf(request));
      const binding = acquisitionMode === 'wrong-binding'
        ? { ...request.binding, checkId: 'wrong-check' }
        : identityPosition === 'handle' && identityField
          ? mismatchedBinding(request.binding, identityField)
        : request.binding;
      const started = deferred<ManagedRunStartedReceiptV1>();
      const outcome = deferred<ManagedRunOutcomeV1>();
      const cancel = deferred<ManagedRunCancelReceiptV1>();
      const close = deferred<ManagedRunCleanupReceiptV1>();
      if (mutateRequestAtStart) {
        const map = request.dependencyResults;
        const dependencyKey = Array.from(map.keys())[0];
        const dependency = map.get(dependencyKey);
        const forEachRows: Array<[string, ReviewSummary, boolean]> = [];
        map.forEach((value, key, owner) => forEachRows.push([key, value, owner === map]));
        const mutationAttempts = [
          () => ((request.prInfo.files[0] as any).filename = 'provider-mutated.ts'),
          () => (((request.checkConfig as any).emits[0] as any).claim = 'provider-mutated@1'),
          () => (((request.executionContext.metadata as any).nested as any).label = 'provider-mutated'),
          () => ((request.binding.scope[0] as any).key = 'provider-mutated'),
          () => ((dependency!.output as any).id = 'provider-mutated'),
        ];
        for (const mutate of mutationAttempts) {
          try { mutate(); } catch {}
        }
        const mutatorAttempts: Record<string, string> = {};
        for (const [name, args] of [
          ['set', ['provider-entry', { issues: [], output: { id: 'provider-entry' } }]],
          ['delete', [dependencyKey]],
          ['clear', []],
        ] as const) {
          try {
            Reflect.apply((map as any)[name], map, args);
            mutatorAttempts[name] = 'returned';
          } catch {
            mutatorAttempts[name] = 'rejected';
          }
        }
        requestMutationEvidence = {
          requestFrozen: Object.isFrozen(request),
          size: map.size,
          dependencyKey,
          get: map.get(dependencyKey),
          has: map.has(dependencyKey),
          entries: Array.from(map.entries()),
          keys: Array.from(map.keys()),
          values: Array.from(map.values()),
          forEachRows,
          iteration: Array.from(map),
          set: (map as any).set,
          delete: (map as any).delete,
          clear: (map as any).clear,
          mutatorAttempts,
          prFilename: request.prInfo.files[0].filename,
          emittedClaim: ((request.checkConfig as any).emits[0] as any).claim,
          executionLabel: ((request.executionContext.metadata as any).nested as any).label,
          scopeKey: request.binding.scope[0].key,
          dependencyId: ((map.get(dependencyKey)?.output as any).id as string),
          fence: request.binding.fence,
        };
      }
      let control!: ManagedControl;
      const handle: ManagedAgentRun = {
        binding,
        started: started.promise,
        outcome: outcome.promise,
        cancel(reason, fence) {
          observationLane?.push(`provider:cancel:${keyOf(request)}`);
          originalCancelCalls++;
          control.cancelCalls.push({ reason, fence, receiver: this });
          poisonProviderSettlementPromise?.(cancel.promise);
          return cancel.promise;
        },
        close() {
          observationLane?.push(`provider:close:${keyOf(request)}`);
          originalCloseCalls++;
          control.closeCalls++;
          control.closeReceivers.push(this);
          const observedClose = close.promise.then(
            receipt => {
              if (acquisitionMode === 'valid' && identityPosition !== 'handle') activeHandles--;
              return receipt;
            },
            error => {
              if (acquisitionMode === 'valid' && identityPosition !== 'handle') activeHandles--;
              throw error;
            }
          );
          poisonProviderSettlementPromise?.(observedClose);
          return observedClose;
        },
      };
      const journal = (engine as any)._lastContext.journal;
      control = {
        request,
        binding,
        started,
        outcome,
        cancel,
        close,
        handle,
        scheduleVisibleAtStart: journal.readRuntimeEvents().some(
          (event: any) =>
            event.type === 'CheckScheduled' &&
            event.nodeGenerationId === request.binding.nodeGenerationId
        ),
        timeoutCallsAtStart: timeoutCallCount(),
        intervalCallsAtStart: intervalCallCount(),
        cancelCalls: [],
        closeCalls: 0,
        closeReceivers: [],
      };
      controls.push(control);
      launchOrder.push(`managed:${keyOf(request)}`);
      if (acquisitionMode === 'valid' && identityPosition !== 'handle') activeHandles++;
      poisonProviderStartPromises?.(started.promise, outcome.promise);
      return handle;
    }
  }

  class LegacyFixtureProvider extends CheckProvider {
    getName() {
      return LEGACY_PROVIDER;
    }
    getDescription() {
      return 'EXP-0123 deterministic legacy provider';
    }
    async validateConfig() {
      return true;
    }
    async isAvailable() {
      return true;
    }
    getRequirements() {
      return [];
    }
    getSupportedConfigKeys() {
      return ['type'];
    }
    async execute(
      _pr: PRInfo,
      config: CheckProviderConfig,
      _dependencies?: Map<string, ReviewSummary>,
      context?: ExecutionContext
    ): Promise<ReviewSummary> {
      const checkId = String(config.checkName);
      launchOrder.push(`legacy:${checkId}`);
      observationLane?.push(`provider:legacy:${checkId}`);
      if (checkId === 'discover-components') {
        catalogCalls++;
        return { issues: [], output: { components: catalogs[0] } };
      }
      const consumed = context?.claims?.component || context?.claims?.onboarded;
      const key = String((consumed?.payload as { id: string }).id);
      legacyIntervalCallsAtInspectStart = intervalCallCount();
      legacyInspectResult = { issues: [], output: { id: key, findings: ['legacy'] } };
      return legacyInspectResult;
    }
  }

  beforeEach(() => {
    resetObservableModuleMocks();
    engine = new StateMachineExecutionEngine();
    catalogs = [[{ id: 'A', path: 'packages/a' }]];
    catalogCalls = 0;
    controls = [];
    acquisitionMode = 'valid';
    startManagedCalls = 0;
    originalCancelCalls = 0;
    originalCloseCalls = 0;
    replacementCancelCalls = 0;
    replacementCloseCalls = 0;
    activeHandles = 0;
    launchOrder = [];
    terminalVisibleAtCompletion = [];
    timeoutCallCount = () => 0;
    intervalCallCount = () => 0;
    identityPosition = undefined;
    observationLane = undefined;
    legacyInspectResult = undefined;
    legacyIntervalCallsAtInspectStart = 0;
    mutateRequestAtStart = false;
    requestMutationEvidence = undefined;
    poisonProviderStartPromises = undefined;
    poisonProviderSettlementPromise = undefined;
    callerExecutionContext = {
      metadata: { nested: { label: 'caller-execution' } },
      hooks: {
        onCheckComplete: info => {
          if (info.checkId !== 'inspect') return;
          const events = (engine as any)._lastContext.journal.readRuntimeEvents();
          terminalVisibleAtCompletion.push(
            events.some((event: any) => event.type === 'ManagedRunTerminated')
          );
          observationLane?.push(`callback:${info.checkId}`);
        },
      },
    };
    engine.setExecutionContext(callerExecutionContext);
    registry.register(new ManagedFixtureProvider());
    registry.register(new LegacyFixtureProvider());
  });

  afterEach(() => {
    registry.unregister(MANAGED_PROVIDER);
    registry.unregister(LEGACY_PROVIDER);
    jest.useRealTimers();
    jest.restoreAllMocks();
    resetObservableModuleMocks();
  });

  it('holds capacity through close, snapshots handle authority, then runs generated work before catalog work', async () => {
    catalogs = [
      [
        { id: 'A', path: 'packages/a' },
        { id: 'B', path: 'packages/b' },
      ],
      [
        { id: 'A', path: 'packages/a' },
        { id: 'B', path: 'packages/b' },
      ],
    ];
    let runSettled = false;
    const run = engine
      .executeGroupedChecks(
        prInfo,
        ['discover-components'],
        undefined,
        fixtureConfig(),
        'table',
        false,
        1
      )
      .finally(() => {
        runSettled = true;
      });

    await until(() => controls.length === 1, 'first managed acquisition');
    const first = controls[0];
    const firstKey = keyOf(first.request);
    expect(['A', 'B']).toContain(firstKey);
    expect(first.scheduleVisibleAtStart).toBe(true);
    const reconciliation = engine.requestCatalogReconciliation('discover-components');

    const replacementStarted = deferred<ManagedRunStartedReceiptV1>();
    const replacementOutcome = deferred<ManagedRunOutcomeV1>();
    Object.assign(first.handle as unknown as Record<string, unknown>, {
      binding: { ...first.binding, fence: first.binding.fence + 100 },
      started: replacementStarted.promise,
      outcome: replacementOutcome.promise,
      cancel: () => {
        replacementCancelCalls++;
        return Promise.resolve(cancelReceipt(first.binding));
      },
      close: () => {
        replacementCloseCalls++;
        return Promise.resolve(cleanupReceipt(first.binding));
      },
    });

    first.started.resolve(startedReceipt(first.binding));
    first.outcome.resolve(
      successOutcome(first.binding, {
        issues: [],
        output: { id: firstKey, findings: ['bounded'] },
      })
    );
    await until(() => first.closeCalls === 1, 'first close call');

    const blockedEvents = attemptEvents(engine, first.binding.attemptId);
    expect(blockedEvents.some(event => event.type === 'ManagedRunTerminated')).toBe(false);
    expect(blockedEvents.some(event => event.type === 'ClaimPublished')).toBe(false);
    expect(controls).toHaveLength(1);
    expect(catalogCalls).toBe(1);
    expect(runSettled).toBe(false);
    expect(activeHandles).toBe(1);
    expect(terminalVisibleAtCompletion).toEqual([]);

    first.close.resolve(cleanupReceipt(first.binding));
    await until(() => controls.length === 2, 'second generated acquisition');
    const second = controls[1];
    const secondKey = keyOf(second.request);
    expect([firstKey, secondKey].sort()).toEqual(['A', 'B']);
    expect(catalogCalls).toBe(1);

    second.started.resolve(startedReceipt(second.binding));
    second.outcome.resolve(
      successOutcome(second.binding, {
        issues: [],
        output: { id: secondKey, findings: ['bounded'] },
      })
    );
    await until(() => second.closeCalls === 1, 'second close call');
    second.close.resolve(cleanupReceipt(second.binding));
    await until(() => catalogCalls === 2, 'queued catalog reconciliation');
    await run;

    expect(launchOrder).toEqual([
      'catalog:0',
      `managed:${firstKey}`,
      `managed:${secondKey}`,
      'catalog:1',
    ]);
    expect(reconciliation.requestId).toEqual(expect.any(String));
    expect(startManagedCalls).toBe(2);
    expect(originalCloseCalls).toBe(2);
    expect(originalCancelCalls).toBe(0);
    expect(replacementCloseCalls).toBe(0);
    expect(replacementCancelCalls).toBe(0);
    expect(first.closeReceivers).toEqual([first.handle]);
    expect(second.closeReceivers).toEqual([second.handle]);
    expect(activeHandles).toBe(0);
    expect(terminalVisibleAtCompletion).toEqual([true, true]);

    for (const control of controls) {
      const events = attemptEvents(engine, control.binding.attemptId);
      expect(events.map(event => event.type)).toEqual([
        'AttemptStarted',
        'CheckScheduled',
        'ManagedRunAcquired',
        'ManagedRunStarted',
        'ManagedRunTerminated',
        'ClaimPublished',
        'AttemptCompleted',
      ]);
      expect(events.filter(event => event.type === 'ManagedRunAcquired')).toHaveLength(1);
      expect(events.filter(event => event.type === 'ManagedRunTerminated')).toHaveLength(1);
      expect(events.filter(event => event.type === 'AttemptCompleted')).toHaveLength(1);
      expect(events.some(event => event.type === 'AttemptFailed')).toBe(false);
      const terminal = events.find(event => event.type === 'ManagedRunTerminated');
      expect(terminal).toMatchObject({
        cleanupStatus: 'clean',
        controllerDecision: 'completed',
        failureCode: null,
      });
    }

    const finalProjection = (engine as any)._lastContext.journal.getInstanceProjection();
    expect(finalProjection.requestsById[reconciliation.requestId].status).toBe('completed');
    expect((engine as any)._lastContext.journal.queryReadyWork()).toEqual([]);
  });

  it('gives the actual provider a complete immutable request and ReadonlyMap view', async () => {
    mutateRequestAtStart = true;
    const config = fixtureConfig();
    const callerPrInfo = {
      ...prInfo,
      body: 'caller body',
      files: [{
        filename: 'packages/a/index.ts',
        additions: 1,
        deletions: 0,
        changes: 1,
        status: 'modified' as const,
      }],
    } as PRInfo;
    const configBefore = JSON.stringify(config);
    const prInfoBefore = JSON.stringify(callerPrInfo);
    const executionContextBefore = JSON.stringify(callerExecutionContext);
    const run = engine.executeGroupedChecks(
      callerPrInfo,
      ['discover-components'],
      undefined,
      config,
      'table',
      false,
      1
    );
    await until(() => controls.length === 1, 'provider request mutation attempt');
    const control = controls[0];
    const dependencySummary = {
      issues: [],
      output: { id: 'A', path: 'packages/a' },
    };

    expect(requestMutationEvidence).toMatchObject({
      requestFrozen: true,
      size: 1,
      dependencyKey: 'discover-components',
      get: dependencySummary,
      has: true,
      entries: [['discover-components', dependencySummary]],
      keys: ['discover-components'],
      values: [dependencySummary],
      forEachRows: [['discover-components', dependencySummary, true]],
      iteration: [['discover-components', dependencySummary]],
      set: undefined,
      delete: undefined,
      clear: undefined,
      mutatorAttempts: { set: 'rejected', delete: 'rejected', clear: 'rejected' },
      prFilename: 'packages/a/index.ts',
      emittedClaim: 'component.onboarded@1',
      executionLabel: 'caller-execution',
      scopeKey: 'A',
      dependencyId: 'A',
      fence: control.request.binding.fence,
    });
    expect(JSON.stringify(config)).toBe(configBefore);
    expect(JSON.stringify(callerPrInfo)).toBe(prInfoBefore);
    expect(JSON.stringify(callerExecutionContext)).toBe(executionContextBefore);
    expect(Object.isFrozen(config)).toBe(false);
    expect(Object.isFrozen(config.subgraphs!['onboard-component'].checks.inspect)).toBe(false);
    expect(Object.isFrozen(callerPrInfo)).toBe(false);
    expect(Object.isFrozen(callerPrInfo.files[0])).toBe(false);
    expect(Object.isFrozen(callerExecutionContext)).toBe(false);
    expect(Object.isFrozen(callerExecutionContext.metadata)).toBe(false);
    expect(control.request.binding.scope[0].key).toBe('A');

    control.started.resolve(startedReceipt(control.request.binding));
    control.outcome.resolve(
      successOutcome(control.request.binding, {
        issues: [],
        output: { id: 'A', findings: ['immutable request'] },
      })
    );
    await until(() => control.closeCalls === 1, 'immutable request close');
    const cleanup = cleanupReceipt(control.request.binding);
    control.close.resolve(cleanup);
    await run;
    const events = attemptEvents(engine, control.binding.attemptId);
    expect(events.find(event => event.type === 'ManagedRunTerminated')).toMatchObject({
      binding: control.binding,
      cleanupStatus: 'clean',
      controllerDecision: 'completed',
      failureCode: null,
    });
    expect(cleanup.binding).toEqual(control.binding);
    expect(originalCloseCalls).toBe(1);
    expect(activeHandles).toBe(0);
  });

  it('replays only journal facts without crossing live collaborator boundaries', async () => {
    let eventBus!: EventBus;
    const originalBuild = (engine as any).buildEngineContext.bind(engine);
    jest.spyOn(engine as any, 'buildEngineContext').mockImplementation((...args: unknown[]) => {
      const built = originalBuild(...args);
      eventBus = new EventBus();
      built.eventBus = eventBus;
      return built;
    });
    const run = engine.executeGroupedChecks(
      prInfo,
      ['discover-components'],
      undefined,
      fixtureConfig(),
      'table',
      false,
      1
    );
    await until(() => controls.length === 1, 'replay fixture acquisition');
    const control = controls[0];
    control.started.resolve(startedReceipt(control.binding));
    control.outcome.resolve(
      successOutcome(control.binding, {
        issues: [],
        output: { id: 'A', findings: ['replay facts only'] },
      })
    );
    await until(() => control.closeCalls === 1, 'replay fixture close');
    control.close.resolve(cleanupReceipt(control.binding));
    await run;

    const provider = registry.getProviderOrThrow(MANAGED_PROVIDER) as ManagedFixtureProvider;
    const providerSpy = jest.spyOn(provider, 'startManaged').mockImplementation(() => {
      throw new Error('REPLAY_MUST_NOT_START_PROVIDER');
    });
    const helperSpy = jest.mocked(managedRunHelpers.snapshotManagedRun);
    expect(helperSpy).toHaveBeenCalledTimes(1);
    helperSpy.mockClear();
    helperSpy.mockImplementation(() => {
      throw new Error('REPLAY_MUST_NOT_SNAPSHOT_HANDLE');
    });
    const cancelSpy = jest.spyOn(control.handle, 'cancel').mockImplementation(() => {
      throw new Error('REPLAY_MUST_NOT_CANCEL_HANDLE');
    });
    const closeSpy = jest.spyOn(control.handle, 'close').mockImplementation(() => {
      throw new Error('REPLAY_MUST_NOT_CLOSE_HANDLE');
    });
    const observerSpy = jest.fn(() => {
      throw new Error('REPLAY_MUST_NOT_NOTIFY_OBSERVERS');
    });
    eventBus.onAny(observerSpy);

    const journal = (engine as any)._lastContext.journal;
    const liveProjection = journal.getInstanceProjection();
    expect(journal.replayInstanceProjection()).toEqual(liveProjection);
    expect(providerSpy).not.toHaveBeenCalled();
    expect(helperSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(closeSpy).not.toHaveBeenCalled();
    expect(observerSpy).not.toHaveBeenCalled();
    expect(activeHandles).toBe(0);
  });

  it('keeps the committed Started fact authoritative when its observation throws', async () => {
    jest.mocked(traceHelpers.emitImmediateSpan).mockImplementation((name: string) => {
      if (name === 'visor.check.inspect.started') {
        throw new Error('TEST_STARTED_OBSERVATION_FAILURE');
      }
    });
    const run = engine.executeGroupedChecks(
      prInfo,
      ['discover-components'],
      undefined,
      fixtureConfig(),
      'table',
      false,
      1
    );
    await until(() => controls.length === 1, 'Started observation acquisition');
    const control = controls[0];
    control.started.resolve(startedReceipt(control.request.binding));
    await until(
      () => attemptEvents(engine, control.request.binding.attemptId).some(
        event => event.type === 'ManagedRunStarted'
      ),
      'Started fact before failed observation'
    );
    control.outcome.resolve(
      successOutcome(control.request.binding, {
        issues: [],
        output: { id: 'A', findings: ['started fact retained'] },
      })
    );
    await until(() => control.closeCalls === 1, 'Started observation close');
    control.close.resolve(cleanupReceipt(control.request.binding));
    await run;

    const events = attemptEvents(engine, control.request.binding.attemptId);
    expect(events.map(event => event.type)).toEqual([
      'AttemptStarted',
      'CheckScheduled',
      'ManagedRunAcquired',
      'ManagedRunStarted',
      'ManagedRunTerminated',
      'ClaimPublished',
      'AttemptCompleted',
    ]);
    expect(events.find(event => event.type === 'ManagedRunTerminated')).toMatchObject({
      cleanupStatus: 'clean',
      controllerDecision: 'completed',
      failureCode: null,
    });
    expect(originalCloseCalls).toBe(1);
    expect(activeHandles).toBe(0);
  });

  it('keeps one deadline armed through close and starts cancel and cleanup independently', async () => {
    jest.useFakeTimers();
    const timeoutSpy = jest.spyOn(global, 'setTimeout');
    const intervalSpy = jest.spyOn(global, 'setInterval');
    timeoutCallCount = () => timeoutSpy.mock.calls.length;
    intervalCallCount = () => intervalSpy.mock.calls.length;

    const config = fixtureConfig();
    setManagedTimeout(config, 25);
    const run = engine.executeGroupedChecks(
      prInfo,
      ['discover-components'],
      undefined,
      config,
      'table',
      false,
      1
    );
    await until(() => controls.length === 1, 'deadline fixture acquisition');
    const control = controls[0];
    await until(
      () => timeoutSpy.mock.calls.length === control.timeoutCallsAtStart + 1,
      'one managed deadline'
    );
    expect(intervalSpy.mock.calls.length).toBe(control.intervalCallsAtStart);

    control.started.resolve(startedReceipt(control.binding));
    control.outcome.resolve(
      successOutcome(control.binding, {
        issues: [],
        output: { id: 'A', findings: ['late close'] },
      })
    );
    await until(() => control.closeCalls === 1, 'ordinary close pending');
    expect(jest.getTimerCount()).toBe(1);

    const redirectedCancel = () => {
      replacementCancelCalls++;
      return Promise.resolve(cancelReceipt(control.request.binding));
    };
    const redirectedClose = () => {
      replacementCloseCalls++;
      return Promise.resolve(cleanupReceipt(control.request.binding));
    };
    Object.assign(control.handle as unknown as Record<string, unknown>, {
      cancel: redirectedCancel,
      close: redirectedClose,
    });
    Object.setPrototypeOf(control.handle, Object.freeze({
      cancel: redirectedCancel,
      close: redirectedClose,
    }));

    jest.advanceTimersByTime(25);
    await until(() => control.cancelCalls.length === 1, 'deadline cancellation');
    expect(control.cancelCalls).toEqual([
      { reason: 'deadline', fence: control.binding.fence, receiver: control.handle },
    ]);
    expect(control.closeCalls).toBe(1);

    control.close.resolve(cleanupReceipt(control.binding));
    await Promise.resolve();
    expect(
      attemptEvents(engine, control.binding.attemptId).some(
        event => event.type === 'ManagedRunTerminated'
      )
    ).toBe(false);
    expect(activeHandles).toBe(0);

    control.cancel.resolve(cancelReceipt(control.binding));
    await run;

    const events = attemptEvents(engine, control.binding.attemptId);
    expect(events.map(event => event.type)).toEqual([
      'AttemptStarted',
      'CheckScheduled',
      'ManagedRunAcquired',
      'ManagedRunStarted',
      'ManagedRunCancelRequested',
      'ManagedRunTerminated',
      'AttemptFailed',
    ]);
    expect(events.find(event => event.type === 'ManagedRunTerminated')).toMatchObject({
      cleanupStatus: 'clean',
      controllerDecision: 'failed',
      failureCode: 'MANAGED_DEADLINE_EXCEEDED',
    });
    expect(events.some(event => event.type === 'ClaimPublished')).toBe(false);
    expect(events.filter(event => event.type === 'AttemptFailed')).toHaveLength(1);
    expect(originalCancelCalls).toBe(1);
    expect(originalCloseCalls).toBe(1);
    expect(replacementCancelCalls).toBe(0);
    expect(replacementCloseCalls).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('coordinates managed promises without native combinators or late promise lookups', async () => {
    const ControllerPromise = Promise;
    const thenDescriptor = Object.getOwnPropertyDescriptor(ControllerPromise.prototype, 'then');
    const raceDescriptor = Object.getOwnPropertyDescriptor(ControllerPromise, 'race');
    const allSettledDescriptor = Object.getOwnPropertyDescriptor(
      ControllerPromise,
      'allSettled'
    );
    if (
      !raceDescriptor ||
      typeof raceDescriptor.value !== 'function' ||
      !allSettledDescriptor ||
      typeof allSettledDescriptor.value !== 'function'
    ) {
      throw new Error('PROMISE_SENTINEL_DESCRIPTOR_UNAVAILABLE');
    }
    const capturedRace = raceDescriptor.value as typeof Promise.race;
    const capturedAllSettled = allSettledDescriptor.value as typeof Promise.allSettled;
    const realQueueMicrotask = global.queueMicrotask.bind(global);
    const counters = {
      managedRaceThen: 0,
      lateStaticRace: 0,
      lateStaticAllSettled: 0,
    };
    const poisonedProviderStartPromises: Promise<unknown>[] = [];
    const managedRaceThenTrap = jest.fn(() => {
      counters.managedRaceThen++;
      throw new Error('PROVIDER_START_PROMISE_METHOD_MUST_NOT_BE_CONSULTED');
    });
    const armStaticProbe = (
      property: 'race' | 'allSettled',
      descriptor: PropertyDescriptor,
      captured: Function,
      counter: 'lateStaticRace' | 'lateStaticAllSettled'
    ): (() => void) => {
      const sentinel = function (this: PromiseConstructor, ...args: unknown[]) {
        counters[counter]++;
        return Reflect.apply(captured, this, args);
      };
      Object.defineProperty(ControllerPromise, property, { ...descriptor, value: sentinel });
      let restored = false;
      return () => {
        if (restored) return;
        restored = true;
        const current = Object.getOwnPropertyDescriptor(ControllerPromise, property);
        if (current?.value === sentinel) {
          Object.defineProperty(ControllerPromise, property, descriptor);
        }
      };
    };
    const restoreExactDescriptors = () => {
      Object.defineProperty(ControllerPromise, 'race', raceDescriptor);
      Object.defineProperty(ControllerPromise, 'allSettled', allSettledDescriptor);
    };

    let run: Promise<unknown> | undefined;
    let firstReachedTerminal = false;
    let firstReachedObserver = false;
    jest.useFakeTimers();
    try {
      catalogs = [[
        { id: 'A', path: 'packages/a' },
        { id: 'B', path: 'packages/b' },
      ]];
      const config = fixtureConfig();
      config.max_parallelism = 2;
      setManagedTimeout(config, 25);

      poisonProviderStartPromises = (started, outcome) => {
        for (const promise of [started, outcome]) {
          Object.defineProperties(promise, {
            then: { configurable: true, value: managedRaceThenTrap },
            catch: { configurable: true, value: managedRaceThenTrap },
          });
          poisonedProviderStartPromises.push(promise);
        }
      };
      run = engine.executeGroupedChecks(
        prInfo,
        ['discover-components'],
        undefined,
        config,
        'table',
        false,
        2
      );
      await until(() => controls.length === 2, 'combinator sentinel acquisitions');
      poisonProviderStartPromises = undefined;
      expect(poisonedProviderStartPromises).toHaveLength(4);
      for (const [index, control] of controls.entries()) {
        expect(poisonedProviderStartPromises[index * 2]).toBe(control.started.promise);
        expect(poisonedProviderStartPromises[index * 2 + 1]).toBe(control.outcome.promise);
      }
      for (const promise of poisonedProviderStartPromises) {
        expect(Object.getOwnPropertyDescriptor(promise, 'then')?.value).toBe(
          managedRaceThenTrap
        );
        expect(Object.getOwnPropertyDescriptor(promise, 'catch')?.value).toBe(
          managedRaceThenTrap
        );
      }

      const providerPromiseTrap = jest.fn(() => {
        throw new Error('PROVIDER_PROMISE_METHOD_MUST_NOT_BE_CONSULTED');
      });
      poisonProviderSettlementPromise = promise => {
        Object.defineProperties(promise, {
          then: { configurable: true, value: providerPromiseTrap },
          catch: { configurable: true, value: providerPromiseTrap },
        });
      };
      const restoreStaticAllSettled = armStaticProbe(
        'allSettled',
        allSettledDescriptor,
        capturedAllSettled,
        'lateStaticAllSettled'
      );
      jest.advanceTimersByTime(25);
      restoreStaticAllSettled();
      await until(
        () => controls.every(control => control.cancelCalls.length === 1 && control.closeCalls === 1),
        'combinator sentinel deadline calls'
      );

      const first = controls[0];
      const second = controls[1];
      const restoreStaticRace = armStaticProbe(
        'race',
        raceDescriptor,
        capturedRace,
        'lateStaticRace'
      );
      first.cancel.resolve(cancelReceipt(first.binding));
      first.close.resolve(cleanupReceipt(first.binding));
      for (let index = 0; index < 10; index++) {
        await new ControllerPromise<void>(resolve => realQueueMicrotask(resolve));
      }
      firstReachedTerminal = attemptEvents(engine, first.binding.attemptId).some(
        event => event.type === 'ManagedRunTerminated'
      );
      firstReachedObserver = ((engine as any)._lastRunner.getState().historyLog as readonly any[])
        .some(event => event.type === 'CheckErrored' && event.checkId === 'inspect');
      restoreStaticRace();

      second.cancel.resolve(cancelReceipt(second.binding));
      second.close.resolve(cleanupReceipt(second.binding));
      await run;

      for (const control of controls) {
        const events = attemptEvents(engine, control.binding.attemptId);
        expect(events.map(event => event.type)).toEqual([
          'AttemptStarted',
          'CheckScheduled',
          'ManagedRunAcquired',
          'ManagedRunCancelRequested',
          'ManagedRunTerminated',
          'AttemptFailed',
        ]);
        expect(events.find(event => event.type === 'ManagedRunTerminated')).toMatchObject({
          binding: control.binding,
          cleanupStatus: 'clean',
          controllerDecision: 'failed',
          failureCode: 'MANAGED_DEADLINE_EXCEEDED',
        });
        expect(events.filter(event => event.type === 'ManagedRunTerminated')).toHaveLength(1);
        expect(events.filter(event => event.type === 'AttemptFailed')).toHaveLength(1);
        expect(events.find(event => event.type === 'AttemptFailed')).toMatchObject({
          reason: 'MANAGED_DEADLINE_EXCEEDED',
        });
        expect(control.cancelCalls).toEqual([{
          reason: 'deadline',
          fence: control.binding.fence,
          receiver: control.handle,
        }]);
        expect(control.closeCalls).toBe(1);
        expect(control.closeReceivers).toEqual([control.handle]);
      }
      expect(firstReachedTerminal).toBe(true);
      expect(firstReachedObserver).toBe(true);
      expect(counters).toEqual({
        managedRaceThen: 0,
        lateStaticRace: 0,
        lateStaticAllSettled: 0,
      });
      expect(managedRaceThenTrap).not.toHaveBeenCalled();
      expect(providerPromiseTrap).not.toHaveBeenCalled();
      expect(originalCancelCalls).toBe(2);
      expect(originalCloseCalls).toBe(2);
      expect(activeHandles).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      restoreExactDescriptors();
      poisonProviderStartPromises = undefined;
      poisonProviderSettlementPromise = undefined;
      for (const control of controls) {
        control.started.resolve(startedReceipt(control.binding));
        control.outcome.resolve(
          successOutcome(control.binding, {
            issues: [],
            output: { id: keyOf(control.request), findings: ['sentinel-finally'] },
          })
        );
        control.cancel.resolve(cancelReceipt(control.binding));
        control.close.resolve(cleanupReceipt(control.binding));
      }
      if (run) {
        try { await run; } catch {}
      }
      jest.useRealTimers();
    }

    expect(Object.getOwnPropertyDescriptor(ControllerPromise.prototype, 'then')).toEqual(
      thenDescriptor
    );
    expect(Object.getOwnPropertyDescriptor(ControllerPromise, 'race')).toEqual(raceDescriptor);
    expect(Object.getOwnPropertyDescriptor(ControllerPromise, 'allSettled')).toEqual(
      allSettledDescriptor
    );
  });

  it.each([
    { name: 'negative', timeout: -1 },
    { name: 'positive infinity', timeout: Number.POSITIVE_INFINITY },
  ])('normalizes a $name managed timeout to one immediate owned deadline', async row => {
    jest.useFakeTimers();
    const timeoutSpy = jest.spyOn(global, 'setTimeout');
    const intervalSpy = jest.spyOn(global, 'setInterval');
    timeoutCallCount = () => timeoutSpy.mock.calls.length;
    intervalCallCount = () => intervalSpy.mock.calls.length;
    const config = fixtureConfig();
    setManagedTimeout(config, row.name === 'positive infinity' ? 25 : row.timeout);
    if (row.name === 'positive infinity') {
      const originalBuild = (engine as any).buildEngineContext.bind(engine);
      jest.spyOn(engine as any, 'buildEngineContext').mockImplementation((...args: unknown[]) => {
        const built = originalBuild(...args);
        const originalGetGeneratedExecution = built.journal.getGeneratedExecution.bind(
          built.journal
        );
        built.journal.getGeneratedExecution = (nodeGenerationId: string) => {
          const execution = originalGetGeneratedExecution(nodeGenerationId);
          return execution.node.templateNodeKey === 'inspect'
            ? {
                ...execution,
                node: {
                  ...execution.node,
                  check: { ...execution.node.check, timeout: Number.POSITIVE_INFINITY },
                },
              }
            : execution;
        };
        return built;
      });
    }

    const run = engine.executeGroupedChecks(
      prInfo,
      ['discover-components'],
      undefined,
      config,
      'table',
      false,
      1
    );
    await until(() => controls.length === 1, `${row.name} timeout acquisition`);
    const control = controls[0];
    await until(
      () => timeoutSpy.mock.calls.length === control.timeoutCallsAtStart + 1,
      `${row.name} single deadline`
    );
    expect(timeoutSpy.mock.calls.at(-1)?.[1]).toBe(0);
    expect(intervalSpy.mock.calls.length).toBe(control.intervalCallsAtStart);

    jest.advanceTimersByTime(0);
    await until(
      () => control.cancelCalls.length === 1 && control.closeCalls === 1,
      `${row.name} cancel and close`
    );
    expect(control.cancelCalls[0]).toMatchObject({
      reason: 'deadline',
      fence: control.request.binding.fence,
    });
    control.cancel.resolve(cancelReceipt(control.request.binding));
    control.close.resolve(cleanupReceipt(control.request.binding));
    await run;

    const events = attemptEvents(engine, control.request.binding.attemptId);
    expect(events.find(event => event.type === 'ManagedRunTerminated')).toMatchObject({
      cleanupStatus: 'clean',
      controllerDecision: 'failed',
      failureCode: 'MANAGED_DEADLINE_EXCEEDED',
    });
    expect(events.filter(event => event.type === 'ManagedRunTerminated')).toHaveLength(1);
    expect(events.filter(event => event.type === 'AttemptFailed')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(String(row.timeout));
    expect(originalCancelCalls).toBe(1);
    expect(originalCloseCalls).toBe(1);
    expect(activeHandles).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each<{
    name: string;
    mode: AcquisitionMode;
    failureCode: string;
    configure?: (config: VisorConfig) => void;
    startCalls: number;
  }>([
    { name: 'start throw', mode: 'throw', failureCode: 'MANAGED_START_FAILED', startCalls: 1 },
    { name: 'thenable', mode: 'thenable', failureCode: 'MANAGED_HANDLE_INVALID', startCalls: 1 },
    {
      name: 'throwing getter',
      mode: 'throwing-getter',
      failureCode: 'MANAGED_HANDLE_INVALID',
      startCalls: 1,
    },
    { name: 'null handle', mode: 'null', failureCode: 'MANAGED_HANDLE_INVALID', startCalls: 1 },
    {
      name: 'missing member',
      mode: 'missing-member',
      failureCode: 'MANAGED_HANDLE_INVALID',
      startCalls: 1,
    },
    {
      name: 'extra handle member',
      mode: 'extra-member',
      failureCode: 'MANAGED_HANDLE_INVALID',
      startCalls: 1,
    },
    {
      name: 'wrong member',
      mode: 'wrong-member',
      failureCode: 'MANAGED_HANDLE_INVALID',
      startCalls: 1,
    },
    {
      name: 'wrong binding',
      mode: 'wrong-binding',
      failureCode: 'MANAGED_BINDING_MISMATCH',
      startCalls: 1,
    },
    {
      name: 'managed debounce',
      mode: 'valid',
      failureCode: 'MANAGED_DEBOUNCE_UNSUPPORTED',
      configure: config => {
        (config.subgraphs!['onboard-component'].checks.inspect as any).debounce = 5;
      },
      startCalls: 0,
    },
    {
      name: 'managed sandbox',
      mode: 'valid',
      failureCode: 'MANAGED_SANDBOX_UNSUPPORTED',
      configure: config => {
        config.sandboxes = { fixture: { image: 'unused' } };
        (config.subgraphs!['onboard-component'].checks.inspect as any).sandbox = 'fixture';
      },
      startCalls: 0,
    },
  ])('atomically fails acquisition for $name', async row => {
    acquisitionMode = row.mode;
    const config = fixtureConfig();
    row.configure?.(config);
    let buildContextSpy: { mockRestore: () => void } | undefined;
    if (row.name === 'managed sandbox') {
      delete config.sandboxes;
      const originalBuild = (engine as any).buildEngineContext.bind(engine);
      buildContextSpy = jest.spyOn(engine as any, 'buildEngineContext').mockImplementation(
        (...args: unknown[]) => {
          const built = originalBuild(...args);
          const fakeSandbox = Object.create(SandboxManager.prototype) as SandboxManager;
          Object.defineProperty(fakeSandbox, 'resolveSandbox', {
            value: jest.fn((requested?: string) => requested === 'fixture' ? 'fixture' : null),
          });
          built.sandboxManager = fakeSandbox;
          return built;
        }
      );
    }
    try {
      await engine.executeGroupedChecks(
        prInfo,
        ['discover-components'],
        undefined,
        config,
        'table',
        false,
        1
      );
    } finally {
      buildContextSpy?.mockRestore();
    }

    const events = (engine as any)._lastContext.journal.readRuntimeEvents() as readonly any[];
    const generated = events.filter(
      event => event.checkId === 'inspect' || event.binding?.checkId === 'inspect'
    );
    expect(generated.map(event => event.type)).toEqual([
      'NodeGenerationActivated',
      'AttemptStarted',
      'CheckScheduled',
      'ManagedRunAcquisitionFailed',
      'AttemptFailed',
    ]);
    expect(generated.filter(event => event.type === 'CheckScheduled')).toHaveLength(1);
    expect(generated.find(event => event.type === 'ManagedRunAcquisitionFailed')).toMatchObject({
      failureCode: row.failureCode,
    });
    expect(generated.find(event => event.type === 'AttemptFailed')).toMatchObject({
      reason: row.failureCode,
    });
    expect(generated.some(event => event.type === 'ManagedRunAcquired')).toBe(false);
    expect(generated.some(event => event.type === 'ManagedRunTerminated')).toBe(false);
    expect(generated.some(event => event.type === 'AttemptCompleted')).toBe(false);
    expect(startManagedCalls).toBe(row.startCalls);
    expect(originalCancelCalls).toBe(0);
    expect(originalCloseCalls).toBe(0);
    expect(activeHandles).toBe(0);
    expect(JSON.stringify(generated)).not.toContain('RAW_START_SECRET');
    expect(JSON.stringify(generated)).not.toContain('RAW_GETTER_SECRET');
  });

  it.each<IdentityPosition>(['handle', 'started', 'outcome', 'cancel', 'cleanup'])(
    'rejects every independently mismatched binding field in the %s position',
    async position => {
      identityPosition = position;
      catalogs = [IDENTITY_FIELDS.map(field => ({ id: field, path: `packages/${field}` }))];
      const config = fixtureConfig();
      config.max_parallelism = 8;
      if (position === 'cancel') {
        jest.useFakeTimers();
        setManagedTimeout(config, 25);
      }

      const run = engine.executeGroupedChecks(
        prInfo,
        ['discover-components'],
        undefined,
        config,
        'table',
        false,
        8
      );
      await until(() => controls.length === 8, `${position} identity acquisitions`);

      if (position !== 'handle') {
        for (const control of controls) {
          const field = keyOf(control.request) as IdentityField;
          const expected = control.request.binding;
          if (position === 'started') {
            control.started.resolve(startedReceipt(mismatchedBinding(expected, field)));
            continue;
          }

          control.started.resolve(startedReceipt(expected));
          if (position === 'outcome') {
            control.outcome.resolve(
              successOutcome(mismatchedBinding(expected, field), {
                issues: [],
                output: { id: field, findings: ['wrong outcome binding'] },
              })
            );
          } else if (position !== 'cancel') {
            control.outcome.resolve(
              successOutcome(expected, {
                issues: [],
                output: { id: field, findings: ['wrong cleanup binding'] },
              })
            );
          }
        }

        if (position === 'cancel') {
          jest.advanceTimersByTime(25);
          await until(
            () => controls.every(control => control.cancelCalls.length === 1 && control.closeCalls === 1),
            'all identity cancel/close calls'
          );
          for (const control of controls) {
            const field = keyOf(control.request) as IdentityField;
            control.cancel.resolve(cancelReceipt(mismatchedBinding(control.request.binding, field)));
            control.close.resolve(cleanupReceipt(control.request.binding));
          }
        } else {
          await until(
            () => controls.every(control => control.closeCalls === 1),
            `all ${position} close calls`
          );
          for (const control of controls) {
            const field = keyOf(control.request) as IdentityField;
            control.close.resolve(
              position === 'cleanup'
                ? cleanupReceipt(mismatchedBinding(control.request.binding, field))
                : cleanupReceipt(control.request.binding)
            );
          }
        }
      }

      await run;
      const expectedCode = position === 'handle'
        ? 'MANAGED_BINDING_MISMATCH'
        : position === 'started'
          ? 'MANAGED_STARTED_RECEIPT_INVALID'
          : position === 'outcome'
            ? 'MANAGED_OUTCOME_RECEIPT_INVALID'
            : position === 'cancel'
              ? 'MANAGED_CANCEL_RECEIPT_INVALID'
              : 'MANAGED_CLEANUP_RECEIPT_INVALID';

      expect(startManagedCalls).toBe(8);
      expect(originalCloseCalls).toBe(position === 'handle' ? 0 : 8);
      expect(originalCancelCalls).toBe(position === 'cancel' ? 8 : 0);
      expect(activeHandles).toBe(0);
      for (const control of controls) {
        const events = attemptEvents(engine, control.request.binding.attemptId);
        expectSerializedControllerBinding(events, control.request.binding);
        if (position === 'handle') {
          expect(events.map(event => event.type)).toEqual([
            'AttemptStarted',
            'CheckScheduled',
            'ManagedRunAcquisitionFailed',
            'AttemptFailed',
          ]);
          expect(events.find(event => event.type === 'ManagedRunAcquisitionFailed')).toMatchObject({
            failureCode: expectedCode,
          });
          expect(events.filter(event => event.type === 'ManagedRunTerminated')).toHaveLength(0);
        } else {
          expect(events.find(event => event.type === 'ManagedRunTerminated')).toMatchObject({
            controllerDecision: 'failed',
            failureCode: expectedCode,
          });
          expect(events.filter(event => event.type === 'ManagedRunTerminated')).toHaveLength(1);
          expect(events.filter(event => event.type === 'AttemptFailed')).toHaveLength(1);
          expect(events.some(event => event.type === 'AttemptCompleted')).toBe(false);
          expect(events.some(event => event.type === 'ClaimPublished')).toBe(false);
          expect(control.closeCalls).toBe(1);
        }
        expect(JSON.stringify(events)).not.toContain('wrong-');
      }
    }
  );

  it.each<{
    name: string;
    failureCode: string;
    configure?: (config: VisorConfig) => void;
    summary: ReviewSummary;
    observer: 'completed' | 'errored';
  }>([
    {
      name: 'fatal summary',
      failureCode: 'MANAGED_FATAL_SUMMARY',
      summary: {
        issues: [
          {
            file: 'fixture.ts',
            line: 1,
            ruleId: 'fixture/error',
            message: 'fatal fixture',
            severity: 'error',
            category: 'logic',
          },
        ],
        output: { id: 'A', findings: ['fatal'] },
      },
      observer: 'completed',
    },
    {
      name: 'fail_if',
      failureCode: 'MANAGED_FAIL_IF',
      configure: config => {
        (config.subgraphs!['onboard-component'].checks.inspect as any).fail_if = 'true';
      },
      summary: { issues: [], output: { id: 'A', findings: ['fail_if'] } },
      observer: 'completed',
    },
    {
      name: 'failure_conditions',
      failureCode: 'MANAGED_FAIL_IF',
      configure: config => {
        (config.subgraphs!['onboard-component'].checks.inspect as any).failure_conditions = {
          fixture: 'true',
        };
      },
      summary: { issues: [], output: { id: 'A', findings: ['condition'] } },
      observer: 'completed',
    },
    {
      name: 'halt_execution',
      failureCode: 'MANAGED_HALT_EXECUTION',
      configure: config => {
        (config.subgraphs!['onboard-component'].checks.inspect as any).failure_conditions = {
          fixture: {
            condition: 'true',
            message: 'halt fixture',
            severity: 'error',
            halt_execution: true,
          },
        };
      },
      summary: { issues: [], output: { id: 'A', findings: ['halt'] } },
      observer: 'completed',
    },
    {
      name: 'claim validation',
      failureCode: 'MANAGED_CLAIM_VALIDATION_FAILED',
      summary: { issues: [], output: { id: 'A' } },
      observer: 'errored',
    },
  ])('keeps clean cleanup separate from $name controller failure', async row => {
    const config = fixtureConfig();
    row.configure?.(config);
    const run = engine.executeGroupedChecks(
      prInfo,
      ['discover-components'],
      undefined,
      config,
      'table',
      false,
      1
    );
    await until(() => controls.length === 1, `${row.name} acquisition`);
    const control = controls[0];
    control.started.resolve(startedReceipt(control.binding));
    control.outcome.resolve(successOutcome(control.binding, row.summary));
    await until(() => control.closeCalls === 1, `${row.name} close`);
    control.close.resolve(cleanupReceipt(control.binding));
    await run;

    const events = attemptEvents(engine, control.binding.attemptId);
    const terminalIndex = events.findIndex(event => event.type === 'ManagedRunTerminated');
    expect(terminalIndex).toBeGreaterThan(0);
    expect(events[terminalIndex]).toMatchObject({
      cleanupStatus: 'clean',
      controllerDecision: 'failed',
      failureCode: row.failureCode,
    });
    expect(events[terminalIndex + 1]).toMatchObject({
      type: 'AttemptFailed',
      reason: row.failureCode,
    });
    expect(events.filter(event => event.type === 'ManagedRunTerminated')).toHaveLength(1);
    expect(events.filter(event => event.type === 'AttemptFailed')).toHaveLength(1);
    expect(events.some(event => event.type === 'ClaimPublished')).toBe(false);
    expect(events.some(event => event.type === 'AttemptCompleted')).toBe(false);
    expect(events.filter(event => event.type === 'ManagedRunTerminated')).toHaveLength(1);
    expect(events.filter(event => event.type === 'AttemptFailed')).toHaveLength(1);
    expect(originalCloseCalls).toBe(1);
    expect(activeHandles).toBe(0);

    const history = (engine as any)._lastRunner.getState().historyLog as readonly any[];
    expect(
      history.some(
        event =>
          event.checkId === 'inspect' &&
          event.type === (row.observer === 'completed' ? 'CheckCompleted' : 'CheckErrored')
      )
    ).toBe(true);
    if (row.name === 'halt_execution') {
      expect(history.some(event => event.type === 'Shutdown')).toBe(true);
      expect(history.some(event => event.type === 'StateTransition' && event.to === 'Error')).toBe(
        true
      );
    }
    if (row.observer === 'completed') expect(terminalVisibleAtCompletion).toEqual([true]);
  });

  it('latches halt scheduling immediately after terminal when the routing effect throws', async () => {
    catalogs = [[
      { id: 'A', path: 'packages/a' },
      { id: 'B', path: 'packages/b' },
    ]];
    const config = fixtureConfig();
    (config.subgraphs!['onboard-component'].checks.inspect as any).failure_conditions = {
      fixture: {
        condition: 'true',
        message: 'halt before fallible effect',
        severity: 'error',
        halt_execution: true,
      },
    };
    const run = engine.executeGroupedChecks(
      prInfo,
      ['discover-components'],
      undefined,
      config,
      'table',
      false,
      1
    );
    await until(() => controls.length === 1, 'halt latch acquisition');
    const control = controls[0];
    const history = (engine as any)._lastRunner.getState().historyLog as any[];
    let shutdownThrows = 0;
    Object.defineProperty(history, 'push', {
      configurable: true,
      value: function (this: any[], ...items: any[]) {
        if (shutdownThrows === 0 && items.some(item => item.type === 'Shutdown')) {
          shutdownThrows++;
          throw new Error('TEST_HALT_EFFECT_OBSERVER_FAILURE');
        }
        return Array.prototype.push.apply(this, items);
      },
    });
    control.started.resolve(startedReceipt(control.request.binding));
    control.outcome.resolve(
      successOutcome(control.request.binding, {
        issues: [],
        output: { id: keyOf(control.request), findings: ['halted'] },
      })
    );
    await until(() => control.closeCalls === 1, 'halt latch close');
    control.close.resolve(cleanupReceipt(control.request.binding));
    await run;

    const events = attemptEvents(engine, control.request.binding.attemptId);
    expect(shutdownThrows).toBe(1);
    expect(events.find(event => event.type === 'ManagedRunTerminated')).toMatchObject({
      cleanupStatus: 'clean',
      controllerDecision: 'failed',
      failureCode: 'MANAGED_HALT_EXECUTION',
    });
    expect(events.filter(event => event.type === 'ManagedRunTerminated')).toHaveLength(1);
    expect(events.filter(event => event.type === 'AttemptFailed')).toHaveLength(1);
    expect(controls).toHaveLength(1);
    expect(
      (engine as any)._lastContext.journal.queryReadyWork().filter(
        (generation: any) => generation.checkId === 'inspect'
      )
    ).toHaveLength(1);
    expect(originalCloseCalls).toBe(1);
    expect(activeHandles).toBe(0);
  });

  it('converges a reachable post-provider routing throw through the managed terminal latch', async () => {
    const config = fixtureConfig();
    const run = engine.executeGroupedChecks(
      prInfo,
      ['discover-components'],
      undefined,
      config,
      'table',
      false,
      1
    );
    await until(() => controls.length === 1, 'post-provider throw acquisition');
    const control = controls[0];
    const journal = (engine as any)._lastContext.journal;
    const plainFailSpy = jest.spyOn(journal, 'failGeneratedAttempt');
    Object.defineProperty((engine as any)._lastContext.config, 'fail_if', {
      configurable: true,
      get: () => {
        throw new Error('TEST_POST_PROVIDER_ROUTING_FAILURE');
      },
    });

    control.started.resolve(startedReceipt(control.request.binding));
    control.outcome.resolve(
      successOutcome(control.request.binding, {
        issues: [],
        output: { id: 'A', findings: ['routing throw'] },
      })
    );
    await until(() => control.closeCalls === 1, 'post-provider clean close');
    control.close.resolve(cleanupReceipt(control.request.binding));
    await run;

    const events = attemptEvents(engine, control.request.binding.attemptId);
    expect(events.find(event => event.type === 'ManagedRunTerminated')).toMatchObject({
      cleanupStatus: 'clean',
      controllerDecision: 'failed',
      failureCode: 'MANAGED_POST_PROVIDER_FAILED',
    });
    expect(events.filter(event => event.type === 'ManagedRunTerminated')).toHaveLength(1);
    expect(events.filter(event => event.type === 'AttemptFailed')).toHaveLength(1);
    expect(events.some(event => event.type === 'ClaimPublished')).toBe(false);
    expect(events.some(event => event.type === 'AttemptCompleted')).toBe(false);
    expect(plainFailSpy).not.toHaveBeenCalled();
    expect(originalCloseCalls).toBe(1);
    expect(activeHandles).toBe(0);
  });

  it('keeps an acquired failure terminal when the outer CheckErrored observer throws', async () => {
    const run = engine.executeGroupedChecks(
      prInfo,
      ['discover-components'],
      undefined,
      fixtureConfig(),
      'table',
      false,
      1
    );
    await until(() => controls.length === 1, 'outer observer acquisition');
    const control = controls[0];
    const journal = (engine as any)._lastContext.journal;
    const plainFailSpy = jest.spyOn(journal, 'failGeneratedAttempt');
    const history = (engine as any)._lastRunner.getState().historyLog as any[];
    let observerThrows = 0;
    let terminalVisibleAtThrow = false;
    Object.defineProperty(history, 'push', {
      configurable: true,
      value: function (...items: any[]) {
        if (observerThrows === 0 && items.some(item => item.type === 'CheckErrored' && item.checkId === 'inspect')) {
          observerThrows++;
          terminalVisibleAtThrow = attemptEvents(engine, control.request.binding.attemptId).some(
            event => event.type === 'ManagedRunTerminated'
          );
          throw new Error('TEST_OUTER_OBSERVER_FAILURE');
        }
        return Array.prototype.push.apply(this, items);
      },
    });

    control.started.resolve(startedReceipt(control.request.binding));
    control.outcome.reject(new Error('RAW_OUTCOME_SECRET'));
    await until(() => control.closeCalls === 1, 'outer observer clean close');
    control.close.resolve(cleanupReceipt(control.request.binding));
    await run;

    const events = attemptEvents(engine, control.request.binding.attemptId);
    expect(observerThrows).toBe(1);
    expect(terminalVisibleAtThrow).toBe(true);
    expect(events.find(event => event.type === 'ManagedRunTerminated')).toMatchObject({
      cleanupStatus: 'clean',
      controllerDecision: 'failed',
      failureCode: 'MANAGED_OUTCOME_FAILED',
    });
    expect(events.filter(event => event.type === 'ManagedRunTerminated')).toHaveLength(1);
    expect(events.filter(event => event.type === 'AttemptFailed')).toHaveLength(1);
    expect(plainFailSpy).not.toHaveBeenCalled();
    expect(originalCloseCalls).toBe(1);
    expect(activeHandles).toBe(0);
  });

  it.each([
    { name: 'started rejection', failureCode: 'MANAGED_STARTED_RECEIPT_INVALID' },
    { name: 'outcome rejection', failureCode: 'MANAGED_OUTCOME_FAILED' },
  ])('closes exactly once after $name and publishes no success', async row => {
    const run = engine.executeGroupedChecks(
      prInfo,
      ['discover-components'],
      undefined,
      fixtureConfig(),
      'table',
      false,
      1
    );
    await until(() => controls.length === 1, `${row.name} acquisition`);
    const control = controls[0];
    if (row.name === 'started rejection') {
      control.started.reject(new Error('RAW_STARTED_SECRET'));
    } else {
      control.started.resolve(startedReceipt(control.binding));
      await until(
        () =>
          attemptEvents(engine, control.binding.attemptId).some(
            event => event.type === 'ManagedRunStarted'
          ),
        'started fact before outcome rejection'
      );
      control.outcome.reject(new Error('RAW_OUTCOME_SECRET'));
    }
    await until(() => control.closeCalls === 1, `${row.name} close`);
    control.close.resolve(cleanupReceipt(control.binding));
    await run;

    const events = attemptEvents(engine, control.binding.attemptId);
    expect(events.map(event => event.type)).toEqual(
      row.name === 'started rejection'
        ? [
            'AttemptStarted',
            'CheckScheduled',
            'ManagedRunAcquired',
            'ManagedRunTerminated',
            'AttemptFailed',
          ]
        : [
            'AttemptStarted',
            'CheckScheduled',
            'ManagedRunAcquired',
            'ManagedRunStarted',
            'ManagedRunTerminated',
            'AttemptFailed',
          ]
    );
    expect(events.find(event => event.type === 'ManagedRunTerminated')).toMatchObject({
      cleanupStatus: 'clean',
      controllerDecision: 'failed',
      failureCode: row.failureCode,
    });
    expect(events.find(event => event.type === 'AttemptFailed')).toMatchObject({
      reason: row.failureCode,
    });
    expect(events.some(event => event.type === 'ClaimPublished')).toBe(false);
    expect(events.some(event => event.type === 'AttemptCompleted')).toBe(false);
    expect(events.filter(event => event.type === 'ManagedRunTerminated')).toHaveLength(1);
    expect(events.filter(event => event.type === 'AttemptFailed')).toHaveLength(1);
    expect(originalCloseCalls).toBe(1);
    expect(activeHandles).toBe(0);
    expect(JSON.stringify(events)).not.toContain('RAW_STARTED_SECRET');
    expect(JSON.stringify(events)).not.toContain('RAW_OUTCOME_SECRET');
  });

  it.each([
    { name: 'started extra field', failureCode: 'MANAGED_STARTED_RECEIPT_INVALID' },
    { name: 'started missing binding', failureCode: 'MANAGED_STARTED_RECEIPT_INVALID' },
    { name: 'outcome binding mismatch', failureCode: 'MANAGED_OUTCOME_RECEIPT_INVALID' },
    { name: 'outcome extra field', failureCode: 'MANAGED_OUTCOME_RECEIPT_INVALID' },
    { name: 'outcome missing summary', failureCode: 'MANAGED_OUTCOME_RECEIPT_INVALID' },
    { name: 'close rejection', failureCode: 'MANAGED_CLOSE_FAILED' },
    { name: 'invalid cleanup', failureCode: 'MANAGED_CLEANUP_RECEIPT_INVALID' },
    { name: 'cleanup missing activeChildren', failureCode: 'MANAGED_CLEANUP_RECEIPT_INVALID' },
  ])('fails closed on $name without serializing hostile receipt data', async row => {
    const run = engine.executeGroupedChecks(
      prInfo,
      ['discover-components'],
      undefined,
      fixtureConfig(),
      'table',
      false,
      1
    );
    await until(() => controls.length === 1, `${row.name} acquisition`);
    const control = controls[0];

    if (row.name.startsWith('started')) {
      control.started.resolve(
        row.name === 'started missing binding'
          ? ({ version: 1, kind: 'started' } as unknown as ManagedRunStartedReceiptV1)
          : ({
              ...startedReceipt(control.binding),
              rawSecret: 'RAW_RECEIPT_SECRET',
            } as unknown as ManagedRunStartedReceiptV1)
      );
    } else {
      control.started.resolve(startedReceipt(control.binding));
      if (row.name === 'outcome binding mismatch') {
        control.outcome.resolve({
          ...successOutcome(control.binding, {
            issues: [],
            output: { id: 'A', findings: ['hostile'] },
          }),
          binding: { ...control.binding, fence: control.binding.fence + 1 },
        });
      } else if (row.name === 'outcome extra field') {
        control.outcome.resolve({
          ...successOutcome(control.binding, {
            issues: [],
            output: { id: 'A', findings: ['hostile'] },
          }),
          rawSecret: 'RAW_RECEIPT_SECRET',
        } as unknown as ManagedRunOutcomeV1);
      } else if (row.name === 'outcome missing summary') {
        control.outcome.resolve({
          version: 1,
          kind: 'succeeded',
          binding: control.binding,
        } as unknown as ManagedRunOutcomeV1);
      } else {
        control.outcome.resolve(
          successOutcome(control.binding, {
            issues: [],
            output: { id: 'A', findings: ['hostile'] },
          })
        );
      }
    }

    await until(() => control.closeCalls === 1, `${row.name} close`);
    if (row.name === 'close rejection') {
      control.close.reject(new Error('RAW_CLOSE_SECRET'));
    } else if (row.name === 'invalid cleanup') {
      control.close.resolve({
        ...cleanupReceipt(control.binding),
        activeResources: 1,
        rawSecret: 'RAW_RECEIPT_SECRET',
      } as unknown as ManagedRunCleanupReceiptV1);
    } else if (row.name === 'cleanup missing activeChildren') {
      const { activeChildren: _omitted, ...missingActiveChildren } = cleanupReceipt(
        control.binding
      );
      control.close.resolve(missingActiveChildren as unknown as ManagedRunCleanupReceiptV1);
    } else {
      control.close.resolve(cleanupReceipt(control.binding));
    }
    await run;

    const events = attemptEvents(engine, control.binding.attemptId);
    expect(events.find(event => event.type === 'ManagedRunTerminated')).toMatchObject({
      cleanupStatus:
        row.failureCode === 'MANAGED_CLOSE_FAILED' ||
        row.failureCode === 'MANAGED_CLEANUP_RECEIPT_INVALID'
          ? 'unverified'
          : 'clean',
      controllerDecision: 'failed',
      failureCode: row.failureCode,
    });
    expect(events.some(event => event.type === 'ClaimPublished')).toBe(false);
    expect(events.some(event => event.type === 'AttemptCompleted')).toBe(false);
    expect(events.filter(event => event.type === 'ManagedRunTerminated')).toHaveLength(1);
    expect(events.filter(event => event.type === 'AttemptFailed')).toHaveLength(1);
    expect(originalCloseCalls).toBe(1);
    expect(activeHandles).toBe(0);
    expect(JSON.stringify(events)).not.toContain('RAW_RECEIPT_SECRET');
    expect(JSON.stringify(events)).not.toContain('RAW_CLOSE_SECRET');
  });

  it.each([
    { name: 'cancel rejection', failureCode: 'MANAGED_CANCEL_FAILED' },
    { name: 'invalid cancel receipt', failureCode: 'MANAGED_CANCEL_RECEIPT_INVALID' },
    { name: 'cancel missing reason', failureCode: 'MANAGED_CANCEL_RECEIPT_INVALID' },
  ])('lets $name settle while close runs independently', async row => {
    jest.useFakeTimers();
    const config = fixtureConfig();
    setManagedTimeout(config, 25);
    const run = engine.executeGroupedChecks(
      prInfo,
      ['discover-components'],
      undefined,
      config,
      'table',
      false,
      1
    );
    await until(() => controls.length === 1, 'cancel rejection acquisition');
    const control = controls[0];

    jest.advanceTimersByTime(25);
    await until(() => control.cancelCalls.length === 1, 'cancel rejection deadline');
    expect(control.closeCalls).toBe(1);
    if (row.name === 'cancel rejection') {
      control.cancel.reject(new Error('RAW_CANCEL_SECRET'));
    } else if (row.name === 'invalid cancel receipt') {
      control.cancel.resolve({
        ...cancelReceipt(control.binding),
        rawSecret: 'RAW_CANCEL_SECRET',
      } as unknown as ManagedRunCancelReceiptV1);
    } else {
      control.cancel.resolve({
        version: 1,
        kind: 'cancelled',
        binding: control.binding,
      } as unknown as ManagedRunCancelReceiptV1);
    }
    await Promise.resolve();
    expect(
      attemptEvents(engine, control.binding.attemptId).some(
        event => event.type === 'ManagedRunTerminated'
      )
    ).toBe(false);

    control.close.resolve(cleanupReceipt(control.binding));
    await run;
    const events = attemptEvents(engine, control.binding.attemptId);
    expect(events.find(event => event.type === 'ManagedRunTerminated')).toMatchObject({
      cleanupStatus: 'clean',
      controllerDecision: 'failed',
      failureCode: row.failureCode,
    });
    expect(events.filter(event => event.type === 'ManagedRunTerminated')).toHaveLength(1);
    expect(events.filter(event => event.type === 'AttemptFailed')).toHaveLength(1);
    expect(originalCancelCalls).toBe(1);
    expect(originalCloseCalls).toBe(1);
    expect(activeHandles).toBe(0);
    expect(JSON.stringify(events)).not.toContain('RAW_CANCEL_SECRET');
  });

  it('closes without unauthoritative cancel when the cancel fact callback throws and holds both competitors', async () => {
    jest.useFakeTimers();
    catalogs = [
      [
        { id: 'A', path: 'packages/a' },
        { id: 'B', path: 'packages/b' },
      ],
      [
        { id: 'A', path: 'packages/a' },
        { id: 'B', path: 'packages/b' },
      ],
    ];
    const config = fixtureConfig();
    setManagedTimeout(config, 25);
    const run = engine.executeGroupedChecks(
      prInfo,
      ['discover-components'],
      undefined,
      config,
      'table',
      false,
      1
    );
    await until(() => controls.length === 1, 'cancel callback acquisition');
    const first = controls[0];
    const firstKey = keyOf(first.request);
    const reconciliation = engine.requestCatalogReconciliation('discover-components');
    const journal = (engine as any)._lastContext.journal;
    jest.spyOn(journal, 'recordManagedRunCancelRequested').mockImplementationOnce(() => {
      throw new Error('TEST_CANCEL_FACT_FAILURE');
    });

    jest.advanceTimersByTime(25);
    await until(() => first.closeCalls === 1, 'same-turn close after cancel fact failure');
    expect(first.cancelCalls).toHaveLength(0);
    expect(originalCancelCalls).toBe(0);
    expect(controls).toHaveLength(1);
    expect(catalogCalls).toBe(1);
    expect(activeHandles).toBe(1);
    expect(
      attemptEvents(engine, first.request.binding.attemptId).some(
        event => event.type === 'ManagedRunTerminated'
      )
    ).toBe(false);

    first.close.resolve(cleanupReceipt(first.request.binding));
    await until(() => controls.length === 2, 'generated competitor after terminal');
    const firstEvents = attemptEvents(engine, first.request.binding.attemptId);
    expect(firstEvents.map(event => event.type)).toEqual([
      'AttemptStarted',
      'CheckScheduled',
      'ManagedRunAcquired',
      'ManagedRunTerminated',
      'AttemptFailed',
    ]);
    expect(firstEvents.find(event => event.type === 'ManagedRunTerminated')).toMatchObject({
      cleanupStatus: 'clean',
      controllerDecision: 'failed',
      failureCode: 'MANAGED_POST_PROVIDER_FAILED',
    });
    expect(firstEvents.filter(event => event.type === 'ManagedRunTerminated')).toHaveLength(1);
    expect(firstEvents.filter(event => event.type === 'AttemptFailed')).toHaveLength(1);
    expect(firstEvents.some(event => event.type === 'ManagedRunCancelRequested')).toBe(false);
    expect(catalogCalls).toBe(1);

    const second = controls[1];
    const secondKey = keyOf(second.request);
    expect([firstKey, secondKey].sort()).toEqual(['A', 'B']);
    second.started.resolve(startedReceipt(second.request.binding));
    second.outcome.resolve(
      successOutcome(second.request.binding, {
        issues: [],
        output: { id: secondKey, findings: ['competitor'] },
      })
    );
    await until(() => second.closeCalls === 1, 'generated competitor close');
    second.close.resolve(cleanupReceipt(second.request.binding));
    await until(() => catalogCalls === 2, 'catalog competitor after generated terminal');
    await run;

    expect(launchOrder).toEqual([
      'catalog:0',
      `managed:${firstKey}`,
      `managed:${secondKey}`,
      'catalog:1',
    ]);
    expect(
      journal.getInstanceProjection().requestsById[reconciliation.requestId].status
    ).toBe('completed');
    expect(originalCloseCalls).toBe(2);
    expect(activeHandles).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('holds generated and catalog competitors across an ordinary finite deadline', async () => {
    jest.useFakeTimers();
    catalogs = [
      [
        { id: 'A', path: 'packages/a' },
        { id: 'B', path: 'packages/b' },
      ],
      [
        { id: 'A', path: 'packages/a' },
        { id: 'B', path: 'packages/b' },
      ],
    ];
    const config = fixtureConfig();
    setManagedTimeout(config, 25);
    const run = engine.executeGroupedChecks(
      prInfo,
      ['discover-components'],
      undefined,
      config,
      'table',
      false,
      1
    );
    await until(() => controls.length === 1, 'ordinary finite deadline acquisition');
    const first = controls[0];
    const firstKey = keyOf(first.request);
    engine.requestCatalogReconciliation('discover-components');

    jest.advanceTimersByTime(25);
    await until(
      () => first.cancelCalls.length === 1 && first.closeCalls === 1,
      'ordinary finite cancel and close'
    );
    expect(controls).toHaveLength(1);
    expect(catalogCalls).toBe(1);
    expect(activeHandles).toBe(1);

    first.cancel.resolve(cancelReceipt(first.request.binding));
    await Promise.resolve();
    expect(controls).toHaveLength(1);
    expect(catalogCalls).toBe(1);
    expect(
      attemptEvents(engine, first.request.binding.attemptId).some(
        event => event.type === 'ManagedRunTerminated'
      )
    ).toBe(false);

    first.close.resolve(cleanupReceipt(first.request.binding));
    await until(() => controls.length === 2, 'generated competitor after finite terminal');
    const firstEvents = attemptEvents(engine, first.request.binding.attemptId);
    expect(firstEvents.find(event => event.type === 'ManagedRunTerminated')).toMatchObject({
      cleanupStatus: 'clean',
      controllerDecision: 'failed',
      failureCode: 'MANAGED_DEADLINE_EXCEEDED',
    });
    expect(firstEvents.filter(event => event.type === 'ManagedRunTerminated')).toHaveLength(1);
    expect(firstEvents.filter(event => event.type === 'AttemptFailed')).toHaveLength(1);
    expect(catalogCalls).toBe(1);

    const second = controls[1];
    const secondKey = keyOf(second.request);
    expect([firstKey, secondKey].sort()).toEqual(['A', 'B']);
    second.started.resolve(startedReceipt(second.request.binding));
    second.outcome.resolve(
      successOutcome(second.request.binding, {
        issues: [],
        output: { id: secondKey, findings: ['after finite deadline'] },
      })
    );
    await until(() => second.closeCalls === 1, 'finite competitor close');
    second.close.resolve(cleanupReceipt(second.request.binding));
    await until(() => catalogCalls === 2, 'catalog after finite competitor');
    await run;

    expect(launchOrder).toEqual([
      'catalog:0',
      `managed:${firstKey}`,
      `managed:${secondKey}`,
      'catalog:1',
    ]);
    expect(originalCancelCalls).toBe(1);
    expect(originalCloseCalls).toBe(2);
    expect(activeHandles).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('commits downstream generation activation inside the managed success batch', async () => {
    const config = fixtureConfig();
    (config.subgraphs!['onboard-component'].checks as any).verify = {
      type: LEGACY_PROVIDER,
      depends_on: ['inspect'],
      consumes: [{ claim: 'component.onboarded@1', as: 'onboarded' }],
    };
    const run = engine.executeGroupedChecks(
      prInfo,
      ['discover-components'],
      undefined,
      config,
      'table',
      false,
      1
    );
    await until(() => controls.length === 1, 'downstream activation acquisition');
    const control = controls[0];
    control.started.resolve(startedReceipt(control.request.binding));
    control.outcome.resolve(
      successOutcome(control.request.binding, {
        issues: [],
        output: { id: 'A', findings: ['activates downstream'] },
      })
    );
    await until(() => control.closeCalls === 1, 'downstream activation close');

    const beforeClose = attemptEvents(engine, control.request.binding.attemptId);
    expect(beforeClose.some(event => event.type === 'ManagedRunTerminated')).toBe(false);
    expect(beforeClose.some(event => event.type === 'ClaimPublished')).toBe(false);
    const allBeforeClose = (engine as any)._lastContext.journal.readRuntimeEvents() as readonly any[];
    expect(allBeforeClose.some(event => event.type === 'NodeGenerationActivated' && event.checkId === 'verify')).toBe(false);
    expect(beforeClose.some(event => event.type === 'AttemptCompleted')).toBe(false);

    control.close.resolve(cleanupReceipt(control.request.binding));
    await run;
    const allEvents = (engine as any)._lastContext.journal.readRuntimeEvents() as readonly any[];
    const terminalIndex = allEvents.findIndex(
      event =>
        event.type === 'ManagedRunTerminated' &&
        event.binding?.attemptId === control.request.binding.attemptId
    );
    const completedIndex = allEvents.findIndex(
      event =>
        event.type === 'AttemptCompleted' &&
        event.attemptId === control.request.binding.attemptId
    );
    expect(allEvents.slice(terminalIndex, completedIndex + 1).map(event => event.type)).toEqual([
      'ManagedRunTerminated',
      'ClaimPublished',
      'NodeGenerationActivated',
      'AttemptCompleted',
    ]);
    expect(launchOrder).toEqual(['catalog:0', 'managed:A', 'legacy:verify']);
    expect(originalCloseCalls).toBe(1);
    expect(activeHandles).toBe(0);
  });

  it('orders journal authority before provider, telemetry, events, transitions, and callbacks', async () => {
    jest.useFakeTimers();
    observationLane = [];
    const lane = observationLane;
    jest.mocked(traceHelpers.emitImmediateSpan).mockImplementation((name: string) => {
      lane.push(`telemetry:${name}`);
    });
    jest.mocked(ndjsonTelemetry.emitNdjsonFallback).mockImplementation((name: string) => {
      lane.push(`telemetry:${name}`);
    });
    const originalBuild = (engine as any).buildEngineContext.bind(engine);
    jest.spyOn(engine as any, 'buildEngineContext').mockImplementation((...args: unknown[]) => {
      const built = originalBuild(...args);
      const eventBus = new EventBus();
      eventBus.onAny(event => {
        const observed = event as any;
        lane.push(`event:${observed.payload?.type || observed.type}`);
      });
      built.eventBus = eventBus;
      const journal = built.journal as Record<string, (...callArgs: any[]) => any>;
      const wrap = (method: string, label: string) => {
        const original = journal[method].bind(journal);
        journal[method] = (...callArgs: any[]) => {
          const value = original(...callArgs);
          lane.push(`journal:${label}`);
          return value;
        };
      };
      wrap('scheduleGeneratedAttempt', 'scheduled');
      wrap('recordManagedRunAcquired', 'acquired');
      wrap('recordManagedRunStarted', 'started');
      wrap('recordManagedRunCancelRequested', 'cancel-requested');
      wrap('failManagedGeneratedAttempt', 'terminal-failed');
      wrap('completeManagedGeneratedAttempt', 'terminal-completed');
      return built;
    });
    const indexAfter = (label: string, after = -1) =>
      lane.findIndex((value, index) => index > after && value === label);

    const deadlineConfig = fixtureConfig();
    setManagedTimeout(deadlineConfig, 25);
    const deadlineRun = engine.executeGroupedChecks(
      prInfo,
      ['discover-components'],
      undefined,
      deadlineConfig,
      'table',
      false,
      1
    );
    await until(() => controls.length === 1, 'global order deadline acquisition');
    const deadlineControl = controls[0];
    deadlineControl.started.resolve(startedReceipt(deadlineControl.request.binding));
    await until(() => lane.includes('journal:started'), 'global order started fact');
    jest.advanceTimersByTime(25);
    await until(
      () => deadlineControl.cancelCalls.length === 1 && deadlineControl.closeCalls === 1,
      'global order deadline cleanup calls'
    );
    deadlineControl.cancel.resolve(cancelReceipt(deadlineControl.request.binding));
    deadlineControl.close.resolve(cleanupReceipt(deadlineControl.request.binding));
    await deadlineRun;

    const scheduled = indexAfter('journal:scheduled');
    const checkScheduled = indexAfter('event:CheckScheduled', scheduled);
    const providerStart = indexAfter('provider:start:A', checkScheduled);
    const acquired = indexAfter('journal:acquired', providerStart);
    const acquiredObservation = indexAfter('telemetry:visor.provider', acquired);
    const started = indexAfter('journal:started', acquired);
    const startedObservation = indexAfter('telemetry:visor.check.inspect.started', started);
    const cancelRequested = indexAfter('journal:cancel-requested', started);
    const providerCancel = indexAfter('provider:cancel:A', cancelRequested);
    const providerClose = indexAfter('provider:close:A', cancelRequested);
    const deadlineTerminal = indexAfter('journal:terminal-failed', providerClose);
    const failureTelemetry = indexAfter('telemetry:visor.check.inspect.failed', deadlineTerminal);
    const checkErrored = indexAfter('event:CheckErrored', deadlineTerminal);
    expect([
      scheduled,
      checkScheduled,
      providerStart,
      acquired,
      acquiredObservation,
      started,
      startedObservation,
      cancelRequested,
      providerCancel,
      providerClose,
      deadlineTerminal,
      failureTelemetry,
      checkErrored,
    ].every(index => index >= 0)).toBe(true);
    expect(scheduled).toBeLessThan(checkScheduled);
    expect(checkScheduled).toBeLessThan(providerStart);
    expect(providerStart).toBeLessThan(acquired);
    expect(acquired).toBeLessThan(acquiredObservation);
    expect(started).toBeLessThan(startedObservation);
    expect(cancelRequested).toBeLessThan(providerCancel);
    expect(cancelRequested).toBeLessThan(providerClose);
    expect(deadlineTerminal).toBeLessThan(failureTelemetry);
    expect(deadlineTerminal).toBeLessThan(checkErrored);

    const haltStart = lane.length;
    controls = [];
    activeHandles = 0;
    catalogCalls = 0;
    launchOrder = [];
    const haltConfig = fixtureConfig();
    (haltConfig.subgraphs!['onboard-component'].checks.inspect as any).failure_conditions = {
      fixture: {
        condition: 'true',
        message: 'ordered halt',
        severity: 'error',
        halt_execution: true,
      },
    };
    const haltRun = engine.executeGroupedChecks(
      prInfo,
      ['discover-components'],
      undefined,
      haltConfig,
      'table',
      false,
      1
    );
    await until(() => controls.length === 1, 'global order halt acquisition');
    const haltControl = controls[0];
    haltControl.started.resolve(startedReceipt(haltControl.request.binding));
    haltControl.outcome.resolve(
      successOutcome(haltControl.request.binding, {
        issues: [],
        output: { id: 'A', findings: ['halt'] },
      })
    );
    await until(() => haltControl.closeCalls === 1, 'global order halt close');
    haltControl.close.resolve(cleanupReceipt(haltControl.request.binding));
    await haltRun;

    const haltTerminal = indexAfter('journal:terminal-failed', haltStart - 1);
    const shutdown = indexAfter('event:Shutdown', haltTerminal);
    const transition = indexAfter('event:StateTransition', haltTerminal);
    const haltTelemetry = indexAfter('telemetry:visor.check.inspect.failed', haltTerminal);
    const completed = indexAfter('event:CheckCompleted', haltTerminal);
    const callback = indexAfter('callback:inspect', haltTerminal);
    expect([haltTerminal, shutdown, transition, haltTelemetry, completed, callback].every(
      index => index >= 0
    )).toBe(true);
    expect(haltTerminal).toBeLessThan(shutdown);
    expect(haltTerminal).toBeLessThan(transition);
    expect(haltTerminal).toBeLessThan(haltTelemetry);
    expect(haltTerminal).toBeLessThan(completed);
    expect(haltTerminal).toBeLessThan(callback);
    expect(activeHandles).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('leaves execute-only providers on the legacy interval and terminal path', async () => {
    observationLane = [];
    const lane = observationLane;
    const nativeSetInterval = global.setInterval.bind(global);
    const nativeClearInterval = global.clearInterval.bind(global);
    const intervalSpy = jest.spyOn(global, 'setInterval').mockImplementation((
      (handler: (...args: any[]) => void, timeout?: number, ...args: any[]) => {
        lane.push('interval:start');
        return nativeSetInterval(handler, timeout, ...args);
      }
    ) as typeof setInterval);
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval').mockImplementation((
      (timer: ReturnType<typeof setInterval>) => {
        lane.push('interval:stop');
        return nativeClearInterval(timer);
      }
    ) as typeof clearInterval);
    intervalCallCount = () => intervalSpy.mock.calls.length;
    jest.mocked(traceHelpers.emitImmediateSpan).mockImplementation((name: string) => {
      lane.push(`telemetry:${name}`);
    });
    jest.mocked(ndjsonTelemetry.emitNdjsonFallback).mockImplementation((name: string) => {
      lane.push(`telemetry:${name}`);
    });
    const originalBuild = (engine as any).buildEngineContext.bind(engine);
    jest.spyOn(engine as any, 'buildEngineContext').mockImplementation((...args: unknown[]) => {
      const built = originalBuild(...args);
      const eventBus = new EventBus();
      eventBus.onAny(event => {
        const observed = event as any;
        lane.push(`event:${observed.payload?.type || observed.type}`);
      });
      built.eventBus = eventBus;
      const journal = built.journal;
      const schedule = journal.scheduleGeneratedAttempt.bind(journal);
      journal.scheduleGeneratedAttempt = (...callArgs: any[]) => {
        const value = schedule(...callArgs);
        lane.push('journal:scheduled');
        return value;
      };
      const complete = journal.completeGeneratedAttempt.bind(journal);
      journal.completeGeneratedAttempt = (...callArgs: any[]) => {
        const value = complete(...callArgs);
        lane.push('journal:attempt-completed');
        return value;
      };
      return built;
    });
    const result = await engine.executeGroupedChecks(
      prInfo,
      ['discover-components'],
      undefined,
      fixtureConfig(LEGACY_PROVIDER),
      'table',
      false,
      1
    );

    const events = (engine as any)._lastContext.journal.readRuntimeEvents() as readonly any[];
    const generated = events.filter(event => event.checkId === 'inspect');
    expect(launchOrder).toEqual(['legacy:discover-components', 'legacy:inspect']);
    expect(startManagedCalls).toBe(0);
    expect(events.some(event => String(event.type).startsWith('ManagedRun'))).toBe(false);
    expect(generated.map(event => event.type)).toEqual([
      'NodeGenerationActivated',
      'AttemptStarted',
      'CheckScheduled',
      'ClaimPublished',
      'AttemptCompleted',
    ]);
    expect(generated.find(event => event.type === 'ClaimPublished').payload).toEqual({
      id: 'A',
      findings: ['legacy'],
    });
    const indexAfter = (label: string, after = -1) =>
      lane.findIndex((value, index) => index > after && value === label);
    const scheduled = indexAfter('journal:scheduled');
    const checkScheduled = indexAfter('event:CheckScheduled', scheduled);
    const providerTelemetry = indexAfter('telemetry:visor.provider', checkScheduled);
    const startedTelemetry = indexAfter('telemetry:visor.check.inspect.started', providerTelemetry);
    const intervalStarted = indexAfter('interval:start', startedTelemetry);
    const providerExecution = indexAfter('provider:legacy:inspect', intervalStarted);
    const completedTelemetry = indexAfter(
      'telemetry:visor.check.inspect.completed',
      providerExecution
    );
    const intervalStopped = indexAfter('interval:stop', completedTelemetry);
    const terminal = indexAfter('journal:attempt-completed', intervalStopped);
    const checkCompleted = indexAfter('event:CheckCompleted', terminal);
    const callback = indexAfter('callback:inspect', checkCompleted);
    expect([
      scheduled,
      checkScheduled,
      providerTelemetry,
      startedTelemetry,
      intervalStarted,
      providerExecution,
      intervalStopped,
      terminal,
      completedTelemetry,
      checkCompleted,
      callback,
    ].every(index => index >= 0)).toBe(true);
    expect(scheduled).toBeLessThan(checkScheduled);
    expect(checkScheduled).toBeLessThan(providerTelemetry);
    expect(providerTelemetry).toBeLessThan(startedTelemetry);
    expect(startedTelemetry).toBeLessThan(intervalStarted);
    expect(intervalStarted).toBeLessThan(providerExecution);
    expect(providerExecution).toBeLessThan(completedTelemetry);
    expect(completedTelemetry).toBeLessThan(intervalStopped);
    expect(intervalStopped).toBeLessThan(terminal);
    expect(terminal).toBeLessThan(checkCompleted);
    expect(completedTelemetry).toBeLessThan(checkCompleted);
    expect(checkCompleted).toBeLessThan(callback);
    expect(lane.some(name => name === 'telemetry:visor.check.inspect.progress')).toBe(false);
    expect(intervalSpy).toHaveBeenCalledTimes(2);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    expect(legacyIntervalCallsAtInspectStart).toBe(2);
    const observed = ((engine as any)._lastRunner.getState().historyLog as readonly any[]).filter(
      event => event.checkId === 'inspect' &&
        (event.type === 'CheckScheduled' || event.type === 'CheckCompleted')
    );
    expect(observed.map(event => event.type)).toEqual(['CheckScheduled', 'CheckCompleted']);
    expect(JSON.stringify(observed[1].result)).toBe(JSON.stringify(legacyInspectResult));
    expect(result.statistics.failedExecutions).toBe(0);
  });
});
