import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import {
  CheckProvider,
  type CheckProviderConfig,
  type ExecutionContext,
} from '../../src/providers/check-provider.interface';
import {
  queryReadyGenerations,
  replayInstanceEvents,
} from '../../src/state-machine/graph/instance-kernel';
import type { PRInfo } from '../../src/pr-analyzer';
import type { ReviewSummary } from '../../src/reviewer';
import type { VisorConfig } from '../../src/types/config';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const prInfo = {
  number: 1,
  title: 'Graph v2 dynamic component instances',
  author: 'test',
  base: 'main',
  head: 'candidate',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  eventType: 'manual',
} as PRInfo;

function dynamicConfig(): VisorConfig {
  return {
    version: '1.0',
    max_parallelism: 2,
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
            type: 'noop',
            consumes: [{ claim: 'component.item@1', as: 'component' }],
            emits: [{ claim: 'component.onboarded@1', from: 'output' }],
          },
          summarize: {
            type: 'noop',
            consumes: [{ claim: 'component.onboarded@1', as: 'inspected' }],
          },
        },
      },
    },
    checks: {
      'discover-components': {
        type: 'noop',
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

function instanceFor(projection: any, key: string): any {
  return Object.values(projection.instancesById).find((instance: any) => instance.itemKey === key);
}

function stableInstanceSlice(projection: any, key: string): unknown {
  const instance = instanceFor(projection, key);
  const nodeIds = Object.values(instance.nodeInstanceIdsByTemplateNode) as string[];
  return {
    instance,
    nodes: nodeIds.map(id => projection.nodesById[id]).sort((a, b) =>
      a.nodeInstanceId.localeCompare(b.nodeInstanceId)
    ),
    generations: Object.values(projection.generationsById)
      .filter((generation: any) => generation.subgraphInstanceId === instance.subgraphInstanceId)
      .sort((a: any, b: any) => a.nodeGenerationId.localeCompare(b.nodeGenerationId)),
    claims: Object.values(projection.claimsById)
      .filter((claim: any) => claim.subgraphInstanceId === instance.subgraphInstanceId)
      .sort((a: any, b: any) => a.claimId.localeCompare(b.claimId)),
  };
}

function isInstanceEvent(event: any): boolean {
  return (
    [
      'CatalogReconciliationRequested',
      'SubgraphExpanded',
      'ControllerItemClaimPublished',
      'NodeGenerationInactivated',
      'NodeGenerationActivated',
      'SubgraphTombstoned',
    ].includes(event.type) ||
    'nodeGenerationId' in event ||
    'requestId' in event
  );
}

describe('EXP-0122 dynamic component instances', () => {
  const registry = CheckProviderRegistry.getInstance();
  const originalNoop = registry.getProviderOrThrow('noop');

  let engine: StateMachineExecutionEngine;
  let catalogs: Array<Array<{ id: string; path: string }>>;
  let catalogIndex: number;
  let catalogStarts: Array<ReturnType<typeof deferred>>;
  let catalogGates: Array<ReturnType<typeof deferred>>;
  let bInspectGate: ReturnType<typeof deferred>;
  let firstASummaryStarted: ReturnType<typeof deferred>;
  let activeProviders: number;
  let peakProviders: number;
  let calls: Array<{ version: number; key: string; checkId: string }>;
  let contextEvidence: Array<{
    version: number;
    key: string;
    checkId: string;
    aliases: string[];
    dependencyKeys: string[];
    dependencyOutputs: unknown[];
    claimPayload: unknown;
    scope: unknown;
    historySize: number;
    hasParentContext: boolean;
    hasParentState: boolean;
    hasJournal: boolean;
    claimsFrozen: boolean;
    claimFrozen: boolean;
    scopeFrozen: boolean;
    payloadFrozen: boolean;
    provenance: unknown;
    attemptId: unknown;
    fence: unknown;
    catalogClaimId: unknown;
    incarnation: unknown;
    scheduledBeforeProvider: boolean;
    pendingRequestIds: string[];
  }>;
  let boundaryProjections: any[];

  class ControlledNoopProvider extends CheckProvider {
    getName() {
      return 'noop';
    }
    getDescription() {
      return 'EXP-0122 deterministic fake';
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
      dependencies?: Map<string, ReviewSummary>,
      context?: ExecutionContext
    ): Promise<ReviewSummary> {
      const checkId = String(config.checkName);
      activeProviders++;
      peakProviders = Math.max(peakProviders, activeProviders);
      try {
        if (checkId === 'discover-components') {
          const version = catalogIndex++;
          if (version > 0) {
            boundaryProjections[version - 1] = (engine as any)._lastContext.journal
              .getInstanceProjection();
          }
          catalogStarts[version].resolve();
          await catalogGates[version].promise;
          return { issues: [], output: { components: catalogs[version] } };
        }

        const version = catalogIndex - 1;
        const aliases = Object.keys(context?.claims || {}).sort();
        const claim = context?.claims?.component || context?.claims?.inspected;
        const payload = claim?.payload as { id: string; path?: string; findings?: string[] };
        const key = payload.id;
        const journal = (engine as any)._lastContext.journal;
        const projection = journal.getInstanceProjection();
        const pendingRequestIds = projection.requestOrder.filter(
          (requestId: string) => projection.requestsById[requestId].status === 'pending'
        );
        const history = config.__outputHistory as Map<string, unknown[]> | undefined;
        const rawContext = (context || {}) as Record<string, unknown>;

        calls.push({ version, key, checkId });
        contextEvidence.push({
          version,
          key,
          checkId,
          aliases,
          dependencyKeys: [...(dependencies?.keys() || [])].sort(),
          dependencyOutputs: [...(dependencies?.values() || [])].map(result => result.output),
          claimPayload: claim?.payload,
          scope: context?.scope,
          historySize: history?.size ?? -1,
          hasParentContext: '_parentContext' in rawContext,
          hasParentState: '_parentState' in rawContext,
          hasJournal: 'journal' in rawContext,
          claimsFrozen: Object.isFrozen(context?.claims),
          claimFrozen: Object.isFrozen(claim),
          scopeFrozen: Object.isFrozen(context?.scope) && Object.isFrozen(context?.scope?.[0]),
          payloadFrozen: Object.isFrozen(claim?.payload),
          provenance: claim?.provenance,
          attemptId: claim?.attemptId,
          fence: claim?.fence,
          catalogClaimId:
            claim?.provenance === 'controller' ? claim.catalogClaimId : undefined,
          incarnation: claim?.provenance === 'controller' ? claim.incarnation : undefined,
          scheduledBeforeProvider: journal.readRuntimeEvents().some(
            (event: any) =>
              event.type === 'CheckScheduled' &&
              event.nodeGenerationId === context?.nodeGenerationId
          ),
          pendingRequestIds,
        });

        if (key === 'B' && checkId === 'inspect' && version === 0) {
          await bInspectGate.promise;
        }
        if (key === 'A' && checkId === 'summarize' && version === 0) {
          firstASummaryStarted.resolve();
        }
        if (checkId === 'inspect') {
          return { issues: [], output: { id: key, findings: [String(payload.path)] } };
        }
        return { issues: [], output: { id: key, summarized: true } };
      } finally {
        activeProviders--;
      }
    }
  }

  beforeEach(() => {
    engine = new StateMachineExecutionEngine();
    catalogs = [
      [
        { id: 'A', path: 'a1' },
        { id: 'B', path: 'b1' },
      ],
      [
        { id: 'B', path: 'b1' },
        { id: 'A', path: 'a1' },
      ],
      [
        { id: 'B', path: 'b1' },
        { id: 'A', path: 'a1' },
        { id: 'C', path: 'c1' },
      ],
      [
        { id: 'B', path: 'b1' },
        { id: 'A', path: 'a1' },
      ],
      [
        { id: 'B', path: 'b1' },
        { id: 'A', path: 'a2' },
      ],
    ];
    catalogIndex = 0;
    catalogStarts = catalogs.map(() => deferred());
    catalogGates = catalogs.map(() => deferred());
    bInspectGate = deferred();
    firstASummaryStarted = deferred();
    activeProviders = 0;
    peakProviders = 0;
    calls = [];
    contextEvidence = [];
    boundaryProjections = [];
    registry.unregister('noop');
    registry.register(new ControlledNoopProvider());
  });

  afterEach(() => {
    registry.unregister('noop');
    registry.register(originalNoop);
  });

  it('runs one live five-version FIFO lifecycle with stable reuse and exact keyed authority', async () => {
    const run = engine.executeGroupedChecks(
      prInfo,
      ['discover-components'],
      undefined,
      dynamicConfig(),
      'table',
      false,
      2
    );
    const requestIds: string[] = [];
    const queuedRequestProjections: any[] = [];

    for (let version = 0; version < catalogs.length; version++) {
      await catalogStarts[version].promise;
      if (version < catalogs.length - 1) {
        const request = engine.requestCatalogReconciliation('discover-components');
        requestIds.push(request.requestId);
        const projection = (engine as any)._lastContext.journal.getInstanceProjection();
        queuedRequestProjections.push(projection);
      }
      catalogGates[version].resolve();
      if (version === 0) {
        await firstASummaryStarted.promise;
        bInspectGate.resolve();
      }
    }
    await run;

    const journal = (engine as any)._lastContext.journal;
    const events = journal.readRuntimeEvents() as readonly any[];
    const finalProjection = journal.getInstanceProjection();
    boundaryProjections[4] = finalProjection;

    expect(catalogIndex).toBe(5);
    expect(peakProviders).toBe(2);
    expect(activeProviders).toBe(0);
    expect([...new Set(events.map(event => event.sessionId).filter(Boolean))]).toHaveLength(1);
    expect(events.some(event => event.type === 'ForwardRunRequested')).toBe(false);

    for (const [index, requestId] of requestIds.entries()) {
      expect(queuedRequestProjections[index].requestsById[requestId].status).toBe('pending');
    }
    expect(
      contextEvidence
        .filter(evidence => evidence.pendingRequestIds.length > 0)
        .map(evidence => evidence.version)
    ).toEqual(expect.arrayContaining([0, 2]));

    expect(calls.filter(call => call.key === 'A' && call.checkId === 'inspect')).toHaveLength(2);
    expect(calls.filter(call => call.key === 'A' && call.checkId === 'summarize')).toHaveLength(2);
    expect(calls.filter(call => call.key === 'B' && call.checkId === 'inspect')).toHaveLength(1);
    expect(calls.filter(call => call.key === 'B' && call.checkId === 'summarize')).toHaveLength(1);
    expect(calls.filter(call => call.key === 'C' && call.checkId === 'inspect')).toHaveLength(1);
    expect(calls.filter(call => call.key === 'C' && call.checkId === 'summarize')).toHaveLength(1);
    expect(calls.filter(call => call.version === 1)).toEqual([]);
    expect(calls.filter(call => call.version === 2).map(call => call.key)).toEqual(['C', 'C']);
    expect(calls.filter(call => call.version === 3)).toEqual([]);
    expect(calls.filter(call => call.version === 4).map(call => call.key)).toEqual(['A', 'A']);

    for (const evidence of contextEvidence) {
      expect(evidence.aliases).toEqual([
        evidence.checkId === 'inspect' ? 'component' : 'inspected',
      ]);
      expect(evidence.dependencyKeys).toEqual([
        evidence.checkId === 'inspect' ? 'discover-components' : 'inspect',
      ]);
      expect(evidence.dependencyOutputs).toEqual([evidence.claimPayload]);
      expect(evidence.dependencyOutputs).toHaveLength(1);
      expect(evidence.dependencyOutputs[0]).not.toHaveProperty('components');
      expect(evidence.dependencyOutputs[0]).toMatchObject({ id: evidence.key });
      expect(evidence.scope).toEqual([
        {
          kind: 'keyed',
          expansionOwnerCheck: 'discover-components',
          key: evidence.key,
          subgraphInstanceId: instanceFor(finalProjection, evidence.key).subgraphInstanceId,
        },
      ]);
      expect(evidence.historySize).toBe(0);
      expect(evidence.hasParentContext).toBe(false);
      expect(evidence.hasParentState).toBe(false);
      expect(evidence.hasJournal).toBe(false);
      expect(evidence.claimsFrozen).toBe(true);
      expect(evidence.claimFrozen).toBe(true);
      expect(evidence.scopeFrozen).toBe(true);
      expect(evidence.payloadFrozen).toBe(true);
      expect(evidence.scheduledBeforeProvider).toBe(true);
      if (evidence.checkId === 'inspect') {
        expect(evidence.provenance).toBe('controller');
        expect(evidence.attemptId).toBeUndefined();
        expect(evidence.fence).toBeUndefined();
        expect(evidence.catalogClaimId).toMatch(/^[0-9a-f]{64}$/);
        expect(evidence.incarnation).toBe(evidence.version === 4 ? 2 : 1);
      } else {
        expect(evidence.provenance).toBe('attempt');
        expect(evidence.attemptId).toMatch(/^[0-9a-f]{64}$/);
        expect(evidence.fence).toEqual(expect.any(Number));
        expect(evidence.catalogClaimId).toBeUndefined();
        expect(evidence.incarnation).toBeUndefined();
      }
    }

    expect(stableInstanceSlice(boundaryProjections[0], 'A')).toEqual(
      stableInstanceSlice(boundaryProjections[1], 'A')
    );
    expect(stableInstanceSlice(boundaryProjections[0], 'A')).toEqual(
      stableInstanceSlice(boundaryProjections[2], 'A')
    );
    expect(stableInstanceSlice(boundaryProjections[0], 'A')).toEqual(
      stableInstanceSlice(boundaryProjections[3], 'A')
    );
    for (const projection of boundaryProjections.slice(1)) {
      expect(stableInstanceSlice(projection, 'B')).toEqual(
        stableInstanceSlice(boundaryProjections[0], 'B')
      );
    }

    const initialA = instanceFor(boundaryProjections[0], 'A');
    const finalA = instanceFor(finalProjection, 'A');
    expect(finalA.subgraphInstanceId).toBe(initialA.subgraphInstanceId);
    expect(finalA.nodeInstanceIdsByTemplateNode).toEqual(initialA.nodeInstanceIdsByTemplateNode);
    expect(finalA.incarnation).toBe(2);
    const initialAGenerationIds = Object.values(boundaryProjections[0].generationsById)
      .filter((generation: any) => generation.subgraphInstanceId === initialA.subgraphInstanceId)
      .map((generation: any) => generation.nodeGenerationId);
    for (const generationId of initialAGenerationIds) {
      expect(finalProjection.generationsById[generationId].status).toBe('inactive');
      for (const claimId of finalProjection.generationsById[generationId].completedOutputClaimIds) {
        expect(finalProjection.claimsById[claimId].active).toBe(false);
      }
    }
    const activeAFinal = Object.values(finalProjection.generationsById).filter(
      (generation: any) =>
        generation.subgraphInstanceId === finalA.subgraphInstanceId &&
        generation.status !== 'inactive'
    ) as any[];
    expect(activeAFinal).toHaveLength(2);
    expect(activeAFinal.every(generation => generation.incarnation === 2)).toBe(true);
    expect(activeAFinal.every(generation => generation.status === 'completed')).toBe(true);

    const addedC = instanceFor(boundaryProjections[2], 'C');
    const removedC = instanceFor(boundaryProjections[3], 'C');
    expect(addedC.status).toBe('active');
    expect(removedC.subgraphInstanceId).toBe(addedC.subgraphInstanceId);
    expect(removedC.status).toBe('tombstoned');
    for (const generation of Object.values(finalProjection.generationsById).filter(
      (value: any) => value.subgraphInstanceId === removedC.subgraphInstanceId
    ) as any[]) {
      expect(generation.status).toBe('inactive');
      for (const claimId of generation.completedOutputClaimIds) {
        expect(finalProjection.claimsById[claimId].active).toBe(false);
      }
    }

    const catalogClaims = events.filter(
      event => event.type === 'ClaimPublished' && event.claim === 'component.catalog@1'
    );
    expect(catalogClaims).toHaveLength(5);
    const catalogBatches = catalogClaims.map(claim => {
      const completed = events.find(
        event => event.type === 'AttemptCompleted' && event.attemptId === claim.attemptId
      );
      return events.filter(
        event => event.eventId > claim.eventId && event.eventId < completed.eventId
      );
    });
    const diffTypes = new Set([
      'SubgraphExpanded',
      'ControllerItemClaimPublished',
      'NodeGenerationInactivated',
      'NodeGenerationActivated',
      'SubgraphTombstoned',
    ]);
    const catalogDiffs = catalogBatches.map(batch =>
      batch.filter(event => diffTypes.has(event.type))
    );
    const eventKey = (event: any): string => event.itemKey || event.scope?.[0]?.key;
    expect(catalogDiffs[0].map(event => [event.type, eventKey(event)])).toEqual([
      ['SubgraphExpanded', 'A'],
      ['ControllerItemClaimPublished', 'A'],
      ['NodeGenerationActivated', 'A'],
      ['SubgraphExpanded', 'B'],
      ['ControllerItemClaimPublished', 'B'],
      ['NodeGenerationActivated', 'B'],
    ]);
    const initialB = instanceFor(boundaryProjections[0], 'B');
    expect(catalogDiffs[0][0].subgraphInstanceId).toBe(initialA.subgraphInstanceId);
    expect(catalogDiffs[0][1].subgraphInstanceId).toBe(initialA.subgraphInstanceId);
    expect(catalogDiffs[0][2].nodeInstanceId).toBe(
      initialA.nodeInstanceIdsByTemplateNode.inspect
    );
    expect(catalogDiffs[0][3].subgraphInstanceId).toBe(initialB.subgraphInstanceId);
    expect(catalogDiffs[0][4].subgraphInstanceId).toBe(initialB.subgraphInstanceId);
    expect(catalogDiffs[0][5].nodeInstanceId).toBe(
      initialB.nodeInstanceIdsByTemplateNode.inspect
    );
    expect(catalogDiffs[0].map(event => event.type)).toEqual([
        'SubgraphExpanded',
        'ControllerItemClaimPublished',
        'NodeGenerationActivated',
        'SubgraphExpanded',
        'ControllerItemClaimPublished',
        'NodeGenerationActivated',
    ]);
    expect(catalogDiffs[1]).toEqual([]);
    expect(catalogs[1].map(item => item.id)).toEqual(['B', 'A']);
    expect(catalogDiffs[2].map(event => [event.type, eventKey(event)])).toEqual([
      ['SubgraphExpanded', 'C'],
      ['ControllerItemClaimPublished', 'C'],
      ['NodeGenerationActivated', 'C'],
    ]);
    expect(catalogDiffs[2][0].subgraphInstanceId).toBe(addedC.subgraphInstanceId);
    expect(catalogDiffs[2][1].subgraphInstanceId).toBe(addedC.subgraphInstanceId);
    expect(catalogDiffs[2][2].nodeInstanceId).toBe(
      addedC.nodeInstanceIdsByTemplateNode.inspect
    );
    expect(catalogDiffs[3].map(event => [event.type, eventKey(event)])).toEqual([
      ['SubgraphTombstoned', 'C'],
    ]);
    expect(catalogDiffs[3][0].subgraphInstanceId).toBe(addedC.subgraphInstanceId);
    expect(catalogDiffs[4].map(event => [event.type, eventKey(event)])).toEqual([
      ['NodeGenerationInactivated', 'A'],
      ['NodeGenerationInactivated', 'A'],
      ['ControllerItemClaimPublished', 'A'],
      ['NodeGenerationActivated', 'A'],
    ]);
    expect(catalogDiffs[4].slice(0, 2).map(event => event.nodeInstanceId)).toEqual([
      initialA.nodeInstanceIdsByTemplateNode.summarize,
      initialA.nodeInstanceIdsByTemplateNode.inspect,
    ]);
    expect(catalogDiffs[4][2].subgraphInstanceId).toBe(initialA.subgraphInstanceId);
    expect(catalogDiffs[4][3].nodeInstanceId).toBe(
      initialA.nodeInstanceIdsByTemplateNode.inspect
    );

    for (const expanded of events.filter(event => event.type === 'SubgraphExpanded')) {
      expect(expanded).not.toHaveProperty('claimId');
      expect(expanded).not.toHaveProperty('incarnation');
      expect(expanded).not.toHaveProperty('nodeGenerationId');
    }
    for (const itemClaim of events.filter(
      event => event.type === 'ControllerItemClaimPublished'
    )) {
      expect(itemClaim.parentClaimIds).toEqual([itemClaim.catalogClaimId]);
      expect(itemClaim.scope).toEqual([
        {
          kind: 'keyed',
          expansionOwnerCheck: itemClaim.expansionOwnerCheck,
          key: itemClaim.itemKey,
          subgraphInstanceId: itemClaim.subgraphInstanceId,
        },
      ]);
    }

    const generatedLifecycle = events.filter(
      event => 'nodeGenerationId' in event && 'attemptId' in event
    );
    for (const event of generatedLifecycle) {
      const generation = finalProjection.generationsById[event.nodeGenerationId];
      expect(event.nodeInstanceId).toBe(generation.nodeInstanceId);
      expect(event.scope).toEqual(generation.scope);
      if (event.type === 'CheckScheduled') {
        expect(event.claimIds).toEqual(generation.activeInputClaimIds);
      }
      if (event.type === 'ClaimPublished') {
        expect(event.parentClaimIds).toEqual(generation.activeInputClaimIds);
        const terminal = events.find(
          candidate =>
            candidate.type === 'AttemptCompleted' && candidate.attemptId === event.attemptId
        );
        const downstream = events.filter(
          candidate =>
            candidate.type === 'NodeGenerationActivated' &&
            candidate.subgraphInstanceId === generation.subgraphInstanceId &&
            candidate.incarnation === generation.incarnation &&
            candidate.eventId > event.eventId &&
            candidate.eventId < terminal.eventId
        );
        expect(downstream).toHaveLength(1);
        expect(downstream[0].templateNodeKey).toBe('summarize');
      }
    }

    for (const requestId of requestIds) {
      const requested = events.find(
        event => event.type === 'CatalogReconciliationRequested' && event.requestId === requestId
      );
      const started = events.find(
        event => event.type === 'AttemptStarted' && event.requestId === requestId
      );
      const scheduled = events.find(
        event => event.type === 'CheckScheduled' && event.requestId === requestId
      );
      const completed = events.find(
        event => event.type === 'AttemptCompleted' && event.requestId === requestId
      );
      expect(requested.eventId).toBeLessThan(started.eventId);
      expect(started.eventId).toBeLessThan(scheduled.eventId);
      expect(scheduled.eventId).toBeLessThan(completed.eventId);

      const beforeStart = replayInstanceEvents(
        events.filter(event => isInstanceEvent(event) && event.eventId < started.eventId)
      );
      expect(beforeStart.requestsById[requestId].status).toBe('pending');
      expect(queryReadyGenerations(beforeStart)).toEqual([]);
      expect(
        Object.values(beforeStart.generationsById).some(
          generation => generation.status === 'running'
        )
      ).toBe(false);
      expect(finalProjection.requestsById[requestId].status).toBe('completed');
    }

    expect(journal.queryReadyWork()).toEqual([]);
    expect(journal.replayInstanceProjection()).toEqual(finalProjection);
    expect(
      Object.values(finalProjection.generationsById).some(
        (generation: any) => generation.status === 'ready' || generation.status === 'running'
      )
    ).toBe(false);
    try {
      engine.requestCatalogReconciliation('discover-components');
      throw new Error('expected post-terminal request rejection');
    } catch (error) {
      expect((error as Error & { code?: string }).code).toBe('RUN_NOT_ACTIVE');
    }
  });

  it('schedules and terminalizes a generated if:false attempt without provider launch', async () => {
    catalogs = [[{ id: 'A', path: 'a1' }]];
    catalogStarts = [deferred()];
    catalogGates = [deferred()];
    const config = dynamicConfig();
    config.subgraphs!['onboard-component'].checks.inspect.if = 'false';

    const run = engine.executeGroupedChecks(
      prInfo,
      ['discover-components'],
      undefined,
      config,
      'table',
      false,
      2
    );
    await catalogStarts[0].promise;
    catalogGates[0].resolve();
    await run;

    expect(calls).toEqual([]);
    const journal = (engine as any)._lastContext.journal;
    const events = journal.readRuntimeEvents() as readonly any[];
    const projection = journal.getInstanceProjection();
    const generation = Object.values(projection.generationsById)[0] as any;
    expect(generation.status).toBe('failed');
    expect(generation.scheduled).toBe(true);
    expect(generation.reason).toBe('IF_CONDITION_NOT_MET');
    expect(
      events
        .filter(event => event.nodeGenerationId === generation.nodeGenerationId)
        .map(event => event.type)
    ).toEqual(['NodeGenerationActivated', 'AttemptStarted', 'CheckScheduled', 'AttemptFailed']);
    expect(journal.queryReadyWork()).toEqual([]);
    expect(journal.replayInstanceProjection()).toEqual(projection);
  });
});
