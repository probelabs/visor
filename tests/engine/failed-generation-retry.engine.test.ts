import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import { ExecutionJournal } from '../../src/snapshot-store';
import { compileClaimPlan } from '../../src/state-machine/graph/claim-plan';
import { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import { CheckProvider, type CheckProviderConfig, type ExecutionContext } from '../../src/providers/check-provider.interface';
import type { PRInfo } from '../../src/pr-analyzer';
import type { ReviewSummary } from '../../src/reviewer';
import type { VisorConfig } from '../../src/types/config';
import { config as durableConfig, OWNER, prInfo as durablePrInfo } from '../fixtures/durable-graph-engine-continuation-child';

const prInfo = durablePrInfo as PRInfo;

function retryConfig(): VisorConfig {
  const value = durableConfig();
  // The checkpoint and the resumed engine use the same exact compiled graph;
  // workspace setup is unrelated to this journal-only regression.
  value.workspace = { enabled: false };
  return value;
}

class RetryFixtureProvider extends CheckProvider {
  constructor(private readonly calls: string[]) { super(); }

  getName(): string { return 'durable-fixture'; }
  getDescription(): string { return 'Failed-generation retry fixture'; }
  async validateConfig(): Promise<boolean> { return true; }
  async isAvailable(): Promise<boolean> { return true; }
  getRequirements(): string[] { return []; }
  getSupportedConfigKeys(): string[] { return ['type']; }

  async execute(
    _pr: PRInfo,
    providerConfig: CheckProviderConfig,
    dependencies?: Map<string, ReviewSummary>,
    context?: ExecutionContext,
  ): Promise<ReviewSummary> {
    const checkId = String(providerConfig.checkName);
    const scope = (context?.scope || []) as readonly { key?: string }[];
    const key = scope[scope.length - 1]?.key || 'A';
    this.calls.push(`${checkId}:${key}`);
    const item = dependencies?.get('items.item@1')?.output as { id?: string; revision?: number } | undefined;
    if (checkId === 'inspect') {
      return { issues: [], output: { id: item?.id || key, revision: item?.revision || 1 } };
    }
    return { issues: [], output: { id: item?.id || key, revision: item?.revision || 1, summarized: true } };
  }
}

describe('failed generated checkpoint retry', () => {
  const registry = CheckProviderRegistry.getInstance();
  let previous: CheckProvider | undefined;

  beforeEach(() => {
    previous = registry.getProvider('durable-fixture');
  });

  afterEach(() => {
    if (registry.getProvider('durable-fixture')) registry.unregister('durable-fixture');
    if (previous) registry.register(previous);
  });

  it('preserves the failed prefix, persists retry before dispatch, and resumes only that leaf', async () => {
    const config = retryConfig();
    const plan = compileClaimPlan(config);
    const journal = new ExecutionJournal(plan);
    const request = journal.requestCatalogReconciliation({ sessionId: 'retry-session', ownerCheck: OWNER });
    const catalogAttempt = journal.startCatalogRequestAttempt(request.requestId);
    journal.scheduleCatalogRequestAttempt(catalogAttempt);
    journal.completeAttempt({
      ...catalogAttempt,
      payload: { items: [{ id: 'A', revision: 1 }, { id: 'B', revision: 1 }] },
    });
    const sibling = journal.queryReadyWork().find(generation => generation.checkId === 'inspect' && generation.scope.at(-1)?.key === 'B')!;
    const siblingAttempt = journal.startGeneratedAttempt(sibling.nodeGenerationId);
    journal.scheduleGeneratedAttempt(siblingAttempt);
    journal.completeGeneratedAttempt({ attempt: siblingAttempt, payload: { id: 'B', revision: 1 } });
    const siblingSummary = journal.queryReadyWork().find(generation => generation.checkId === 'summarize' && generation.scope.at(-1)?.key === 'B')!;
    const siblingSummaryAttempt = journal.startGeneratedAttempt(siblingSummary.nodeGenerationId);
    journal.scheduleGeneratedAttempt(siblingSummaryAttempt);
    journal.completeGeneratedAttempt({ attempt: siblingSummaryAttempt, payload: { id: 'B', revision: 1, summarized: true } });
    const inspect = journal.queryReadyWork().find(generation => generation.checkId === 'inspect' && generation.scope.at(-1)?.key === 'A')!;
    const first = journal.startGeneratedAttempt(inspect.nodeGenerationId);
    journal.scheduleGeneratedAttempt(first);
    journal.failGeneratedAttempt(first, 'MANAGED_START_FAILED');
    const oldEvents = journal.readRuntimeEvents();
    const oldCheckpoint = journal.exportGraphCheckpoint('retry-session');

    const calls: string[] = [];
    if (previous) registry.unregister('durable-fixture');
    registry.register(new RetryFixtureProvider(calls));
    let persistedRetry: any;
    const callbackOrder: string[] = [];
    const engine = new StateMachineExecutionEngine(process.cwd());
    const resumed = await engine.retryGraphCheckpoint({
      checkpoint: JSON.parse(JSON.stringify(oldCheckpoint)),
      config,
      prInfo,
      retryGenerationIds: [inspect.nodeGenerationId],
      externalSideEffects: 'absent',
      onRetryCheckpoint: async checkpoint => {
        expect(calls).toEqual([]);
        callbackOrder.push('retry-prefix-persisted');
        await Promise.resolve();
        persistedRetry = checkpoint;
      },
      maxParallelism: 2,
    });

    expect(persistedRetry).toBeDefined();
    expect(callbackOrder).toEqual(['retry-prefix-persisted']);
    expect(persistedRetry.events.slice(0, oldEvents.length)).toEqual(oldEvents);
    expect(persistedRetry.events[oldEvents.length]).toEqual(expect.objectContaining({
      type: 'AttemptRetryRequested',
      nodeGenerationId: inspect.nodeGenerationId,
      priorAttemptId: first.attemptId,
      priorFence: first.fence,
    }));
    const suffix = resumed.checkpoint.events.slice(persistedRetry.events.length);
    expect(suffix.some((event: any) => event.type === 'AttemptStarted' && event.nodeGenerationId === inspect.nodeGenerationId)).toBe(true);
    expect(calls.filter(call => call.startsWith('inspect:A'))).toHaveLength(1);
    expect(calls.some(call => call.startsWith('inspect:B'))).toBe(false);
    expect(calls.some(call => call.startsWith('summarize:A'))).toBe(true);
    expect(calls.some(call => call.startsWith('summarize:B'))).toBe(false);
    const retryStart = suffix.find((event: any) => event.type === 'AttemptStarted' && event.nodeGenerationId === inspect.nodeGenerationId) as any;
    expect(retryStart.attemptId).not.toBe(first.attemptId);
    expect(retryStart.fence).toBeGreaterThan(first.fence);
  });

  it('requires explicit side-effect confirmation and durable-prefix callback', async () => {
    const config = retryConfig();
    const plan = compileClaimPlan(config);
    const journal = new ExecutionJournal(plan);
    const request = journal.requestCatalogReconciliation({ sessionId: 'retry-session', ownerCheck: OWNER });
    const attempt = journal.startCatalogRequestAttempt(request.requestId);
    journal.scheduleCatalogRequestAttempt(attempt);
    journal.completeAttempt({ ...attempt, payload: { items: [{ id: 'A', revision: 1 }] } });
    const inspect = journal.queryReadyWork().find(generation => generation.checkId === 'inspect')!;
    const first = journal.startGeneratedAttempt(inspect.nodeGenerationId);
    journal.scheduleGeneratedAttempt(first);
    journal.failGeneratedAttempt(first, 'pre-side-effect failure');
    const checkpoint = journal.exportGraphCheckpoint('retry-session');
    const engine = new StateMachineExecutionEngine(process.cwd());
    await expect(engine.retryGraphCheckpoint({
      checkpoint,
      config,
      prInfo,
      retryGenerationIds: [inspect.nodeGenerationId],
      externalSideEffects: undefined as any,
      onRetryCheckpoint: () => undefined,
    })).rejects.toThrow('side-effect confirmation');

    await expect(engine.retryGraphCheckpoint({
      checkpoint,
      config,
      prInfo,
      retryGenerationIds: [inspect.nodeGenerationId],
      externalSideEffects: 'absent',
      onRetryCheckpoint: () => { throw new Error('durable write failed'); },
    })).rejects.toThrow('durable write failed');
  });

  it('threads a retry dispatch gate so downstream work remains ready until the durable frontier is handled', async () => {
    const config = retryConfig();
    const plan = compileClaimPlan(config);
    const journal = new ExecutionJournal(plan);
    const request = journal.requestCatalogReconciliation({sessionId: 'retry-gated-session', ownerCheck: OWNER});
    const catalogAttempt = journal.startCatalogRequestAttempt(request.requestId);
    journal.scheduleCatalogRequestAttempt(catalogAttempt);
    journal.completeAttempt({...catalogAttempt, payload: {items: [{id: 'A', revision: 1}]}});
    const inspect = journal.queryReadyWork().find(generation => generation.checkId === 'inspect')!;
    const first = journal.startGeneratedAttempt(inspect.nodeGenerationId);
    journal.scheduleGeneratedAttempt(first);
    journal.failGeneratedAttempt(first, 'MANAGED_START_FAILED');
    const oldCheckpoint = journal.exportGraphCheckpoint('retry-gated-session');

    const calls: string[] = [];
    if (previous) registry.unregister('durable-fixture');
    registry.register(new RetryFixtureProvider(calls));
    let persistedRetry: any;
    const engine = new StateMachineExecutionEngine(process.cwd());
    const resumed = await engine.retryGraphCheckpoint({
      checkpoint: JSON.parse(JSON.stringify(oldCheckpoint)),
      config,
      prInfo,
      retryGenerationIds: [inspect.nodeGenerationId],
      externalSideEffects: 'absent',
      generatedDispatchGate: generation => generation.checkId === 'summarize' ? 'defer' : 'dispatch',
      onRetryCheckpoint: checkpoint => { persistedRetry = checkpoint; },
      maxParallelism: 1,
    });

    expect(persistedRetry.events.slice(0, oldCheckpoint.events.length)).toEqual(oldCheckpoint.events);
    expect(calls.filter(call => call === 'inspect:A')).toHaveLength(1);
    expect(calls.some(call => call === 'summarize:A')).toBe(false);
    const projection = ExecutionJournal.restoreGraphCheckpoint(plan, resumed.checkpoint).getInstanceProjection();
    const summarize = Object.values(projection.generationsById).find(generation => generation.checkId === 'summarize');
    expect(summarize?.status).toBe('ready');
  });

  it('permits a second retry after a fresh failure while rejecting a pending retry prefix', () => {
    const config = retryConfig();
    const plan = compileClaimPlan(config);
    const journal = new ExecutionJournal(plan);
    const request = journal.requestCatalogReconciliation({sessionId: 'retry-second-failure-session', ownerCheck: OWNER});
    const catalogAttempt = journal.startCatalogRequestAttempt(request.requestId);
    journal.scheduleCatalogRequestAttempt(catalogAttempt);
    journal.completeAttempt({...catalogAttempt, payload: {items: [{id: 'A', revision: 1}]}});
    const inspect = journal.queryReadyWork().find(generation => generation.checkId === 'inspect')!;
    const first = journal.startGeneratedAttempt(inspect.nodeGenerationId);
    journal.scheduleGeneratedAttempt(first);
    journal.failGeneratedAttempt(first, 'first failure');
    const firstRetry = journal.retryFailedGeneratedAttempts({
      sessionId: 'retry-second-failure-session',
      nodeGenerationIds: [inspect.nodeGenerationId],
      externalSideEffects: 'absent',
    });
    expect(firstRetry).toHaveLength(1);

    const pendingRetry = ExecutionJournal.restoreGraphCheckpoint(plan, journal.exportGraphCheckpoint('retry-second-failure-session'));
    expect(() => pendingRetry.retryFailedGeneratedAttempts({
      sessionId: 'retry-second-failure-session',
      nodeGenerationIds: [inspect.nodeGenerationId],
      externalSideEffects: 'absent',
    })).toThrow(/eligible failed leaf/);

    const second = journal.startGeneratedAttempt(inspect.nodeGenerationId);
    journal.scheduleGeneratedAttempt(second);
    journal.failGeneratedAttempt(second, 'second failure');
    const secondRetry = journal.retryFailedGeneratedAttempts({
      sessionId: 'retry-second-failure-session',
      nodeGenerationIds: [inspect.nodeGenerationId],
      externalSideEffects: 'absent',
    });
    expect(secondRetry).toHaveLength(1);
    expect(secondRetry[0].priorAttemptId).toBe(second.attemptId);
    expect(secondRetry[0].priorAttemptId).not.toBe(first.attemptId);
  });
});
