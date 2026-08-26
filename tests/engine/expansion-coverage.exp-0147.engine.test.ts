import fs from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import {
  CheckProvider,
  type CheckProviderConfig,
  type ManagedAgentRun,
  type ManagedRunStartRequest,
} from '../../src/providers/check-provider.interface';
import { ExecutionJournal } from '../../src/snapshot-store';
import { compileClaimPlan } from '../../src/state-machine/graph/claim-plan';
import { projectExpansionCoverage } from '../../src/state-machine/graph/instance-kernel';
import type { PRInfo } from '../../src/pr-analyzer';
import type { ReviewSummary } from '../../src/reviewer';
import type { VisorConfig } from '../../src/types/config';

type Mode = 'completed_clean' | 'completed_with_findings' | 'guardrail_blocked' |
  'error' | 'cancelled' | 'running' | 'deferred';
type Item = { id: string; mode: Mode; revision: number };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}
async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('fixture did not reach controlled state');
}
const prInfo = { number: 147, title: 'coverage', author: 'test', base: 'main', head: 'poc',
  files: [], totalAdditions: 0, totalDeletions: 0, eventType: 'manual' } as PRInfo;
function fixture(): VisorConfig {
  return yaml.load(fs.readFileSync(path.join(
    __dirname, '../fixtures/graph-v2/expansion-coverage.yaml'
  ), 'utf8')) as VisorConfig;
}

describe('EXP-0147 expansion coverage projection', () => {
  const registry = CheckProviderRegistry.getInstance();
  const originalNoop = registry.getProviderOrThrow('noop');
  let catalog: Item[];
  let rootStarted: ReturnType<typeof deferred<void>>;
  let rootRelease: ReturnType<typeof deferred<void>>;
  let rootCalls: number;
  let managedStarts: number;
  let cancelCalls: number;
  let gates: Map<string, ReturnType<typeof deferred<ReviewSummary>>>;

  class ControlledNoop extends CheckProvider {
    getName() { return 'noop'; }
    getDescription() { return 'deterministic in-process EXP-0147 fake'; }
    async validateConfig() { return true; }
    async isAvailable() { return true; }
    getRequirements() { return []; }
    getSupportedConfigKeys() { return ['type']; }
    async execute(_pr: PRInfo, config: CheckProviderConfig): Promise<ReviewSummary> {
      if (String(config.checkName) !== 'discover-operations') throw new Error('legacy throw');
      if (rootCalls++ === 0) { rootStarted.resolve(); await rootRelease.promise; }
      return { issues: [], output: { operations: catalog } };
    }
    startManaged(request: ManagedRunStartRequest): ManagedAgentRun {
      managedStarts++;
      const item = [...request.dependencyResults.values()][0].output as Item;
      if (item.mode === 'error') throw new Error('real operation throw');
      const binding = request.binding;
      const terminalClass = item.mode === 'deferred' || item.mode === 'running'
        ? 'completed_clean' : item.mode;
      const gate = gates.get(item.id);
      const outcome = item.mode === 'cancelled'
        ? new Promise<never>(() => undefined)
        : gate?.promise || Promise.resolve({ issues: [], output: {
            class: terminalClass, ...(item.id === 'A' ? { findings: [] } : {}) } });
      return {
        binding,
        started: Promise.resolve({ version: 1, kind: 'started', binding }),
        outcome: outcome.then(summary => ({ version: 1, kind: 'succeeded', binding, summary })),
        cancel: async () => { cancelCalls++; return { version: 1, kind: 'cancelled', binding, reason: 'deadline' }; },
        close: async () => ({ version: 1, kind: 'cleanup', binding, status: 'clean',
          activeChildren: 0, activeResources: 0 }),
      };
    }
  }

  function reset(items: Item[], controlled: string[] = []): void {
    catalog = items;
    rootStarted = deferred<void>();
    rootRelease = deferred<void>();
    rootCalls = 0;
    managedStarts = 0;
    cancelCalls = 0;
    gates = new Map(controlled.map(key => [key, deferred<ReviewSummary>()]));
  }
  async function begin(items: Item[], controlled: string[] = [], timeout = 1800000) {
    reset(items, controlled);
    const config = fixture();
    config.subgraphs!['assess-operation'].checks.assess.timeout = timeout;
    const engine = new StateMachineExecutionEngine();
    const run = engine.executeGroupedChecks(prInfo, ['discover-operations'], undefined, config, 'table');
    await rootStarted.promise;
    const request = engine.requestCatalogReconciliation('discover-operations');
    expect(engine.getExpansionCoverageRequestIds()).toEqual([request.requestId]);
    expect(engine.getExpansionCoverageRequestIds('other')).toEqual([]);
    rootRelease.resolve();
    return { engine, run, requestId: request.requestId };
  }
  function liveAndReplay(engine: StateMachineExecutionEngine, requestId: string) {
    const live = engine.getExpansionCoverageProjection(requestId);
    expect(engine.replayExpansionCoverageProjection(requestId)).toEqual(live);
    return live;
  }
  beforeEach(() => {
    registry.unregister('noop');
    registry.register(new ControlledNoop());
  });
  afterEach(() => {
    registry.unregister('noop');
    registry.register(originalNoop);
    jest.useRealTimers();
  });

  it('compiles only a declared sink outcome and strict pointer', () => {
    const valid = compileClaimPlan(fixture()).expansionPlan.byOwner['discover-operations'];
    expect(valid.coverage).toMatchObject({ outcomeClaimRef: 'operation.outcome@1',
      emitterNodeKey: 'assess', classPointer: { source: '/class', tokens: ['class'] } });
    const invalid = fixture();
    invalid.checks!['discover-operations'].expand!.coverage!.class_pointer = 'class';
    expect(() => compileClaimPlan(invalid)).toThrow(expect.objectContaining({ code: 'INVALID_JSON_POINTER' }));
    const nonSink = fixture();
    nonSink.subgraphs!['assess-operation'].checks.after = {
      type: 'noop', consumes: [{ claim: 'operation.outcome@1', as: 'outcome' }],
    };
    expect(() => compileClaimPlan(nonSink)).toThrow(
      expect.objectContaining({ code: 'INVALID_COVERAGE_OUTCOME_EMITTER' })
    );
  });

  it('closes two real clean operations and replays exact claim plus instance facts', async () => {
    const run = await begin([
      { id: 'A', mode: 'completed_clean', revision: 1 },
      { id: 'B', mode: 'completed_clean', revision: 1 },
    ]);
    await run.run;
    expect(liveAndReplay(run.engine, run.requestId)).toMatchObject({
      closure: 'closed', disposition: 'clean', terminalItems: 2,
    });
  });

  it('derives all terminal classes from provider outcomes, a throw, and a real deadline', async () => {
    const modes: Mode[] = ['completed_clean', 'completed_with_findings', 'error',
      'guardrail_blocked', 'cancelled'];
    const run = await begin(modes.map((mode, index) => ({ id: String(index), mode, revision: 1 })), [], 10);
    await run.run;
    const view = liveAndReplay(run.engine, run.requestId);
    expect(view).toMatchObject({ closure: 'closed', disposition: 'unverifiable', terminalItems: 5 });
    expect(view.items.map(item => item.terminalClass)).toEqual(modes);
    expect(cancelCalls).toBe(1);
  });

  it('stays open while a real operation is running', async () => {
    const run = await begin([{ id: 'A', mode: 'running', revision: 1 }], ['A']);
    await until(() => managedStarts === 1);
    expect(liveAndReplay(run.engine, run.requestId)).toMatchObject({
      closure: 'open', disposition: 'unverifiable',
    });
    gates.get('A')!.resolve({ issues: [], output: { class: 'completed_clean' } });
    await run.run;
  });

  it('has the same digest across distinct sessions and inverted completion order', async () => {
    const items: Item[] = [{ id: 'A', mode: 'deferred', revision: 1 },
      { id: 'B', mode: 'deferred', revision: 1 }];
    const execute = async (order: string[]) => {
      const run = await begin(items, ['A', 'B']);
      await until(() => managedStarts === 2);
      for (const key of order) gates.get(key)!.resolve({ issues: [], output: { class: 'completed_clean' } });
      await run.run;
      return { requestId: run.requestId, view: liveAndReplay(run.engine, run.requestId) };
    };
    const forward = await execute(['A', 'B']);
    const reverse = await execute(['B', 'A']);
    expect(reverse.requestId).not.toBe(forward.requestId);
    expect(reverse.view.semanticDigest).toBe(forward.view.semanticDigest);
    expect(reverse.view.items).toEqual(forward.view.items);
  });

  it('closes an empty catalog without generated operations', async () => {
    const run = await begin([]);
    await run.run;
    expect(managedStarts).toBe(0);
    expect(liveAndReplay(run.engine, run.requestId)).toMatchObject({
      closure: 'closed', disposition: 'clean', terminalItems: 0,
    });
  });

  it('fails closed for directly constructed malformed lifecycle projections', () => {
    const config = fixture();
    const plan = compileClaimPlan(config);
    const journal = new ExecutionJournal(plan);
    const request = journal.requestCatalogReconciliation({ sessionId: 'malformed', ownerCheck: 'discover-operations' });
    const root = journal.startCatalogRequestAttempt(request.requestId);
    journal.scheduleCatalogRequestAttempt(root);
    journal.completeAttempt({ ...root, payload: { operations: [{ id: 'A', mode: 'completed_clean', revision: 1 }] } });
    const generation = journal.queryReadyWork()[0];
    const attempt = journal.startGeneratedAttempt(generation.nodeGenerationId);
    journal.scheduleGeneratedAttempt(attempt);
    journal.completeGeneratedAttempt({ attempt, payload: { class: 'completed_clean' } });
    const claims: any = journal.getClaimProjection();
    const instances: any = journal.getInstanceProjection();
    const expansion = plan.expansionPlan.byOwner['discover-operations'];
    const project = (candidate: any) => projectExpansionCoverage(claims, candidate, expansion, request.requestId);
    const generationId = Object.keys(instances.generationsById)[0];
    const claimId = instances.generationsById[generationId].completedOutputClaimIds[0];
    const itemClaimId = Object.keys(instances.claimsById).find(
      key => instances.claimsById[key].kind === 'controller-item'
    )!;
    const variants = [
      { ...instances, generationsById: { ...instances.generationsById,
        [generationId]: { ...instances.generationsById[generationId], completedOutputClaimIds: [claimId, claimId] } } },
      { ...instances, instancesById: { ...instances.instancesById,
        unknown: { ...Object.values(instances.instancesById)[0] as object, itemKey: 'B' } } },
      { ...instances, claimsById: { ...instances.claimsById,
        [itemClaimId]: { ...instances.claimsById[itemClaimId],
          payloadFingerprint: '0'.repeat(64) } } },
      { ...instances, generationsById: { ...instances.generationsById,
        [generationId]: { ...instances.generationsById[generationId], status: 'running', completedOutputClaimIds: [] } } },
    ];
    for (const variant of variants) expect(project(variant)).toMatchObject({ closure: 'open', disposition: 'unverifiable' });
  });
});
