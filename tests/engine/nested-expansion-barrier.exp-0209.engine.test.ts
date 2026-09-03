import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import * as yaml from 'js-yaml';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import { CheckProvider, type CheckProviderConfig, type ExecutionContext } from '../../src/providers/check-provider.interface';
import type { PRInfo } from '../../src/pr-analyzer';
import type { ReviewSummary } from '../../src/reviewer';
import type { VisorConfig } from '../../src/types/config';
import { canonicalGraphCheckpointJson, ExecutionJournal } from '../../src/snapshot-store';
import {
  deriveExpansionBarrierDigest,
  deriveNodeGenerationId,
  type ExpansionBarrierChildState,
} from '../../src/state-machine/graph/instance-kernel';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setImmediate(resolve));
  }
}

const prInfo = {
  number: 209,
  title: 'Nested expansion completion barrier',
  author: 'test',
  base: 'main',
  head: 'candidate',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  eventType: 'manual',
} as PRInfo;

function fixtureConfig(): VisorConfig {
  return yaml.load(fs.readFileSync(path.join(__dirname, '../fixtures/graph-v2/nested-expansion-barrier.yaml'), 'utf8')) as VisorConfig;
}

describe('EXP-0209 nested expansion completion barrier', () => {
  const registry = CheckProviderRegistry.getInstance();
  const originalNoop = registry.getProviderOrThrow('noop');
  let engine: StateMachineExecutionEngine;
  let childCVerifyStarted: ReturnType<typeof deferred>;
  let releaseChildCVerify: ReturnType<typeof deferred>;
  let calls: string[];

  class ControlledNoopProvider extends CheckProvider {
    getName() { return 'noop'; }
    getDescription() { return 'EXP-0209 deterministic fake'; }
    async validateConfig() { return true; }
    async isAvailable() { return true; }
    getRequirements() { return []; }
    getSupportedConfigKeys() { return ['type']; }

    async execute(
      _pr: PRInfo,
      config: CheckProviderConfig,
      _dependencies?: Map<string, ReviewSummary>,
      context?: ExecutionContext,
    ): Promise<ReviewSummary> {
      const checkId = String(config.checkName);
      const scope = (context?.scope || []) as readonly { key?: string }[];
      const childKey = scope.length === 2 ? scope[1].key : undefined;
      calls.push(`${checkId}:${scope.map(value => value.key || '').join('/')}`);
      if (checkId === 'discover') {
        return { issues: [], output: { projects: [{ id: 'P' }] } };
      }
      if (checkId === 'materialize') {
        return { issues: [], output: { children: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] } };
      }
      if (checkId === 'inspect') {
        return { issues: [], output: { id: childKey, stage: checkId } };
      }
      if (checkId === 'verify' && childKey === 'C') {
        childCVerifyStarted.resolve();
        await releaseChildCVerify.promise;
      }
      return { issues: [], output: { id: childKey || 'P', stage: checkId } };
    }
  }

  beforeEach(() => {
    engine = new StateMachineExecutionEngine();
    childCVerifyStarted = deferred();
    releaseChildCVerify = deferred();
    calls = [];
    registry.unregister('noop');
    registry.register(new ControlledNoopProvider());
  });

  afterEach(() => {
    registry.unregister('noop');
    registry.register(originalNoop);
  });

  it('keeps the parent join open, then resumes it exactly once after the final child', async () => {
    const run = engine.executeGroupedChecks(prInfo, ['discover'], undefined, fixtureConfig(), 'table', false, 3);
    await childCVerifyStarted.promise;

    const context = (engine as any)._lastContext;
    const journal = context.journal as ExecutionJournal;
    await waitFor(() => Object.values(journal.getInstanceProjection().generationsById)
      .filter((generation: any) => generation.templateNodeKey === 'verify' && generation.status === 'completed').length === 2,
    'two child verifies to complete');
    const before = journal.getInstanceProjection();
    const project = Object.values(before.instancesById).find((instance: any) => instance.itemKey === 'P' && instance.scope.length === 1) as any;
    expect(project).toBeDefined();
    const joinNodeId = project.nodeInstanceIdsByTemplateNode.join;
    expect(before.activeGenerationIdByNode[joinNodeId]).toBeUndefined();
    const childGenerations = Object.values(before.generationsById).filter((generation: any) => generation.templateNodeKey === 'verify');
    expect(childGenerations.filter((generation: any) => generation.status === 'completed')).toHaveLength(2);
    expect(childGenerations.filter((generation: any) => generation.status === 'running')).toHaveLength(1);
    expect(calls.filter(call => call.startsWith('join:'))).toHaveLength(0);

    releaseChildCVerify.resolve();
    await run;
    const after = journal.getInstanceProjection();
    const joinGenerationId = after.activeGenerationIdByNode[joinNodeId];
    expect(joinGenerationId).toBeDefined();
    expect(after.generationsById[joinGenerationId!].status).toBe('completed');
    expect(after.generationsById[joinGenerationId!].expansionBarrierDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(calls.filter(call => call.startsWith('join:'))).toEqual(['join:P']);

    const childStates: ExpansionBarrierChildState[] = ['A', 'B', 'C'].map(itemKey => ({
      itemKey,
      workItemFingerprint: `fingerprint-${itemKey}`,
      terminalGenerationId: `generation-${itemKey}`,
      terminalGenerationStatus: 'completed',
      nestedCatalogClaimId: 'catalog-1',
      nestedCatalogProducerGenerationId: 'materialize-generation-1',
    }));
    const barrierIdentity = {
      expansionOwnerCheck: 'project.materialize',
      terminalNode: 'verify',
      nestedExpansionSpecDigest: 'expansion-spec-1',
      nestedTemplateDigest: 'child-template-1',
      nestedCatalogClaimId: 'catalog-1',
    };
    expect(deriveExpansionBarrierDigest({ ...barrierIdentity, children: childStates }))
      .toBe(deriveExpansionBarrierDigest({ ...barrierIdentity, children: [...childStates].reverse() }));

    const checkpoint = journal.exportGraphCheckpoint(context.sessionId);
    const restored = ExecutionJournal.restoreGraphCheckpoint(context.claimPlan, checkpoint);
    expect(restored.getInstanceProjection()).toEqual(after);
    expect(journal.replayInstanceProjection()).toEqual(after);

    const forged = JSON.parse(JSON.stringify(checkpoint));
    const joinActivation = forged.events.find((event: any) =>
      event.type === 'NodeGenerationActivated' && event.expansionBarrierDigest);
    expect(joinActivation).toBeDefined();
    joinActivation.expansionBarrierDigest = 'f'.repeat(64);
    joinActivation.nodeGenerationId = deriveNodeGenerationId({
      nodeInstanceId: joinActivation.nodeInstanceId,
      incarnation: joinActivation.incarnation,
      itemFingerprint: joinActivation.itemFingerprint,
      executionConfigDigest: joinActivation.executionConfigDigest,
      activeInputClaimIds: joinActivation.activeInputClaimIds,
      expansionBarrierDigest: joinActivation.expansionBarrierDigest,
    });
    const forgedBody = {
      kind: forged.kind,
      version: forged.version,
      sessionId: forged.sessionId,
      graphSemanticDigest: forged.graphSemanticDigest,
      frontier: forged.frontier,
      events: forged.events,
    };
    forged.integrity.digest = createHash('sha256')
      .update(canonicalGraphCheckpointJson(forgedBody), 'utf8')
      .digest('hex');
    expect(() => ExecutionJournal.restoreGraphCheckpoint(context.claimPlan, forged)).toThrow(
      /nested-expansion barrier|barrier/i,
    );

    const omitted = JSON.parse(JSON.stringify(checkpoint));
    const omittedActivation = omitted.events.find((event: any) =>
      event.type === 'NodeGenerationActivated' && event.expansionBarrierDigest);
    expect(omittedActivation).toBeDefined();
    const omittedGenerationId = omittedActivation.nodeGenerationId;
    omitted.events = omitted.events.filter((event: any) => event.nodeGenerationId !== omittedGenerationId);
    omitted.events.forEach((event: any, index: number) => { event.eventId = index + 1; });
    omitted.frontier = {
      eventCount: omitted.events.length,
      lastEventId: omitted.events.length,
    };
    const omittedBody = {
      kind: omitted.kind,
      version: omitted.version,
      sessionId: omitted.sessionId,
      graphSemanticDigest: omitted.graphSemanticDigest,
      frontier: omitted.frontier,
      events: omitted.events,
    };
    omitted.integrity.digest = createHash('sha256')
      .update(canonicalGraphCheckpointJson(omittedBody), 'utf8')
      .digest('hex');
    expect(() => ExecutionJournal.restoreGraphCheckpoint(context.claimPlan, omitted)).toThrow(
      /Ready wait barrier .* has no exact active generation/,
    );

    const omittedChildAndJoin = JSON.parse(JSON.stringify(checkpoint));
    const omittedChild = Object.values(after.instancesById).find((value: any) =>
      value.itemKey === 'C' && value.scope.length === 2) as any;
    expect(omittedChild).toBeDefined();
    const omittedChildJoin = omittedChildAndJoin.events.find((event: any) =>
      event.type === 'NodeGenerationActivated' && event.expansionBarrierDigest);
    expect(omittedChildJoin).toBeDefined();
    const omittedChildGenerationIds = new Set(Object.values(after.generationsById)
      .filter((generation: any) => generation.subgraphInstanceId === omittedChild.subgraphInstanceId)
      .map((generation: any) => generation.nodeGenerationId));
    omittedChildAndJoin.events = omittedChildAndJoin.events.filter((event: any) =>
      event.subgraphInstanceId !== omittedChild.subgraphInstanceId &&
      event.nodeGenerationId !== omittedChildJoin.nodeGenerationId &&
      !omittedChildGenerationIds.has(event.nodeGenerationId));
    omittedChildAndJoin.events.forEach((event: any, index: number) => { event.eventId = index + 1; });
    omittedChildAndJoin.frontier = {
      eventCount: omittedChildAndJoin.events.length,
      lastEventId: omittedChildAndJoin.events.length,
    };
    const omittedChildAndJoinBody = {
      kind: omittedChildAndJoin.kind,
      version: omittedChildAndJoin.version,
      sessionId: omittedChildAndJoin.sessionId,
      graphSemanticDigest: omittedChildAndJoin.graphSemanticDigest,
      frontier: omittedChildAndJoin.frontier,
      events: omittedChildAndJoin.events,
    };
    omittedChildAndJoin.integrity.digest = createHash('sha256')
      .update(canonicalGraphCheckpointJson(omittedChildAndJoinBody), 'utf8')
      .digest('hex');
    expect(() => ExecutionJournal.restoreGraphCheckpoint(context.claimPlan, omittedChildAndJoin)).toThrow(
      /Wait barrier .* has an incomplete catalog child selection/,
    );
  });
});
