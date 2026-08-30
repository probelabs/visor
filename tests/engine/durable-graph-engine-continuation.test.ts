import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { StateMachineExecutionEngine, type GraphCheckpointContinuationInput } from '../../src/sdk';
import { ExecutionJournal } from '../../src/snapshot-store';
import { compileClaimPlan } from '../../src/state-machine/graph/claim-plan';
import { MemoryStore } from '../../src/memory-store';
import { sha256Canonical } from '../../src/state-machine/graph/claim-kernel';
import { OWNER, config, prInfo } from '../fixtures/durable-graph-engine-continuation-child';

type Artifact = {
  pid: number;
  checkpoint: any;
  calls: any[];
  projection: any;
  events?: any[];
  replay?: any;
  canonicalReexport?: any;
  transitions?: any[];
};

const fixturePath = path.join(__dirname, '../fixtures/durable-graph-engine-continuation-child.ts');

function runChild(mode: 'produce' | 'continue', artifactDirectory: string): void {
  execFileSync(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', fixturePath, mode, artifactDirectory],
    {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1' },
      encoding: 'utf8',
      timeout: 120_000,
      stdio: 'pipe',
    }
  );
}

function readArtifact(directory: string, name: string): Artifact {
  return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) as Artifact;
}

function rehash(checkpoint: any): any {
  const body = {
    kind: checkpoint.kind,
    version: checkpoint.version,
    sessionId: checkpoint.sessionId,
    graphSemanticDigest: checkpoint.graphSemanticDigest,
    frontier: checkpoint.frontier,
    events: checkpoint.events,
  };
  return { ...checkpoint, integrity: { algorithm: 'sha256', digest: sha256Canonical(body) } };
}

function continuationInput(checkpoint: unknown, owner = OWNER): GraphCheckpointContinuationInput {
  return { checkpoint, expansionOwnerCheck: owner, config: config(), prInfo };
}

function instanceSlice(projection: any, itemKey: string): unknown {
  const instance = Object.values(projection.instancesById).find(
    (candidate: any) => candidate.itemKey === itemKey
  ) as any;
  if (!instance) return undefined;
  const nodeIds = Object.values(instance.nodeInstanceIdsByTemplateNode) as string[];
  return {
    instance,
    nodes: nodeIds
      .map(nodeId => projection.nodesById[nodeId])
      .sort((left: any, right: any) => left.nodeInstanceId.localeCompare(right.nodeInstanceId)),
    generations: Object.values(projection.generationsById)
      .filter((generation: any) => generation.subgraphInstanceId === instance.subgraphInstanceId)
      .sort((left: any, right: any) => left.nodeGenerationId.localeCompare(right.nodeGenerationId)),
    claims: Object.values(projection.claimsById)
      .filter((claim: any) => claim.subgraphInstanceId === instance.subgraphInstanceId)
      .sort((left: any, right: any) => left.claimId.localeCompare(right.claimId)),
  };
}

describe('durable Graph checkpoint continuation', () => {
  let artifactDirectory: string;
  let producer: Artifact;

  beforeAll(() => {
    artifactDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-graph-continuation-'));
    // This is child A. The continuation assertion below launches the only
    // other fixture child, in a fresh process with a fresh module cache.
    runChild('produce', artifactDirectory);
    producer = readArtifact(artifactDirectory, 'producer.json');
  });

  afterAll(() => {
    fs.rmSync(artifactDirectory, { recursive: true, force: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    MemoryStore.resetInstance();
  });

  it('rejects an altered payload before services, tools, or context installation', async () => {
    const altered = JSON.parse(JSON.stringify(producer.checkpoint));
    altered.events[0].sessionId = `${altered.events[0].sessionId}-altered`;
    const initialize = jest.spyOn(MemoryStore.prototype, 'initialize');
    const engine = new StateMachineExecutionEngine();

    await expect(engine.continueGraphCheckpoint(continuationInput(altered))).rejects.toMatchObject({
      code: 'CHECKPOINT_INTEGRITY_MISMATCH',
    });
    expect(initialize).not.toHaveBeenCalled();
    expect((engine as any)._lastContext).toBeUndefined();
    expect((engine as any)._lastRunner).toBeUndefined();
    expect(() => engine.getInstanceProjection()).toThrow(
      expect.objectContaining({ code: 'RUN_NOT_ACTIVE' })
    );
    expect(() => engine.requestCatalogReconciliation(OWNER)).toThrow(
      expect.objectContaining({ code: 'RUN_NOT_ACTIVE' })
    );
  });

  it('rejects a validly rehashed checkpoint for a different compiled graph', async () => {
    const mismatched = rehash({
      ...producer.checkpoint,
      graphSemanticDigest: 'different-graph-digest',
    });
    const initialize = jest.spyOn(MemoryStore.prototype, 'initialize');
    const engine = new StateMachineExecutionEngine();

    await expect(
      engine.continueGraphCheckpoint(continuationInput(mismatched))
    ).rejects.toMatchObject({
      code: 'CHECKPOINT_GRAPH_MISMATCH',
    });
    expect(initialize).not.toHaveBeenCalled();
    expect((engine as any)._lastContext).toBeUndefined();
    expect((engine as any)._lastRunner).toBeUndefined();
  });

  it('rejects a hashed nonquiescent prefix before creating fresh services', async () => {
    const plan = compileClaimPlan(config());
    const journal = ExecutionJournal.restoreGraphCheckpoint(plan, producer.checkpoint);
    journal.requestCatalogReconciliation({
      sessionId: producer.checkpoint.sessionId,
      ownerCheck: OWNER,
    });
    const pending = journal.exportGraphCheckpoint(producer.checkpoint.sessionId);
    const initialize = jest.spyOn(MemoryStore.prototype, 'initialize');
    const engine = new StateMachineExecutionEngine();

    await expect(engine.continueGraphCheckpoint(continuationInput(pending))).rejects.toMatchObject({
      code: 'CHECKPOINT_NOT_QUIESCENT',
    });
    expect(initialize).not.toHaveBeenCalled();
    expect((engine as any)._lastContext).toBeUndefined();
    expect((engine as any)._lastRunner).toBeUndefined();
  });

  it('rejects an unknown owner without appending a request suffix', async () => {
    const initialize = jest.spyOn(MemoryStore.prototype, 'initialize');
    const engine = new StateMachineExecutionEngine();

    await expect(
      engine.continueGraphCheckpoint(continuationInput(producer.checkpoint, 'unknown-owner'))
    ).rejects.toMatchObject({ code: 'UNKNOWN_EXPANSION_OWNER' });
    expect(initialize).not.toHaveBeenCalled();
    expect((engine as any)._lastContext).toBeUndefined();
    expect((engine as any)._lastRunner).toBeUndefined();
  });

  it('preserves prior private run references when continuation setup fails', async () => {
    const priorContext = { marker: 'prior-context' };
    const priorRunner = { marker: 'prior-runner' };
    const engine = new StateMachineExecutionEngine();
    (engine as any)._lastContext = priorContext;
    (engine as any)._lastRunner = priorRunner;
    const initialize = jest
      .spyOn(MemoryStore.prototype, 'initialize')
      .mockRejectedValueOnce(new Error('fixture memory setup failure'));

    await expect(
      engine.continueGraphCheckpoint(continuationInput(producer.checkpoint))
    ).rejects.toThrow('fixture memory setup failure');
    expect(initialize).toHaveBeenCalledTimes(1);
    expect((engine as any)._lastContext).toBe(priorContext);
    expect((engine as any)._lastRunner).toBe(priorRunner);
  });

  it('continues one changed keyed closure in a separate process and round-trips the result', () => {
    // This is child B, and the test intentionally stops after the returned
    // checkpoint has been restored and canonically re-exported by the child.
    runChild('continue', artifactDirectory);
    const continuation = readArtifact(artifactDirectory, 'continuation.json');
    const sourceEvents = producer.checkpoint.events;
    const returnedEvents = continuation.checkpoint.events;
    const suffix = returnedEvents.slice(sourceEvents.length);

    expect(continuation.pid).not.toBe(producer.pid);
    expect(returnedEvents.slice(0, sourceEvents.length)).toEqual(sourceEvents);
    expect(new Set(returnedEvents.map((event: any) => event.sessionId))).toEqual(
      new Set([producer.checkpoint.sessionId])
    );
    expect(continuation.checkpoint.sessionId).toBe(producer.checkpoint.sessionId);

    for (const field of [
      'requestsById',
      'instancesById',
      'nodesById',
      'generationsById',
      'claimsById',
    ]) {
      for (const id of Object.keys(producer.projection[field])) {
        expect(continuation.projection[field][id]).toBeDefined();
      }
    }

    expect(instanceSlice(continuation.projection, 'B')).toEqual(
      instanceSlice(producer.projection, 'B')
    );
    const sourceA = instanceSlice(producer.projection, 'A') as any;
    const continuedA = instanceSlice(continuation.projection, 'A') as any;
    expect(continuedA.nodes).toEqual(sourceA.nodes);
    const sourceAGenerationIds = new Set(
      sourceA.generations.map((generation: any) => generation.nodeGenerationId)
    );
    const continuedAGenerationIds = new Set(
      continuedA.generations.map((generation: any) => generation.nodeGenerationId)
    );
    for (const id of sourceAGenerationIds) expect(continuedAGenerationIds.has(id)).toBe(true);
    expect(
      continuedA.generations.some((generation: any) => generation.status === 'completed')
    ).toBe(true);
    expect(continuedA.generations.some((generation: any) => generation.status === 'inactive')).toBe(
      true
    );

    expect(
      continuation.calls.map(call => `${call.kind}:${call.checkId}:${call.key || ''}`)
    ).toEqual(['owner:discover-items:', 'generated:inspect:A', 'generated:summarize:A']);
    expect(continuation.calls.some(call => call.key === 'B')).toBe(false);
    expect(continuation.calls[0].sessionId).toBe(producer.checkpoint.sessionId);
    expect(continuation.calls[0].workingDirectory).toBe(process.cwd());
    expect(
      continuation.calls.slice(1).every(call => call.sessionId === producer.checkpoint.sessionId)
    ).toBe(true);

    const rootStarts = suffix.filter(
      (event: any) => event.type === 'AttemptStarted' && !('nodeGenerationId' in event)
    );
    expect(rootStarts).toHaveLength(1);
    expect(rootStarts[0].requestId).toBe(continuation.requestId);
    const priorRequests = producer.checkpoint.events.filter(
      (event: any) =>
        event.type === 'CatalogReconciliationRequested' && event.expansionOwnerCheck === OWNER
    );
    const suffixRequests = suffix.filter(
      (event: any) =>
        event.type === 'CatalogReconciliationRequested' && event.expansionOwnerCheck === OWNER
    );
    expect(suffixRequests).toHaveLength(1);
    expect(suffixRequests[0].requestOrdinal).toBe(
      Math.max(0, ...priorRequests.map((event: any) => event.requestOrdinal)) + 1
    );
    expect(
      suffix
        .filter((event: any) => event.type === 'AttemptStarted')
        .some((event: any) =>
          producer.events?.some((prior: any) => prior.attemptId === event.attemptId)
        )
    ).toBe(false);

    expect(suffix.map((event: any) => event.eventId)).toEqual(
      suffix.map(
        (_: unknown, index: number) => producer.checkpoint.frontier.lastEventId + index + 1
      )
    );
    const suffixAttempts = suffix.filter((event: any) => event.type === 'AttemptStarted');
    const priorFence = Math.max(
      0,
      ...producer.checkpoint.events
        .filter((event: any) => event.type === 'AttemptStarted')
        .map((event: any) => event.fence)
    );
    expect(suffixAttempts.map((event: any) => event.fence)).toEqual(
      suffixAttempts.map((_: unknown, index: number) => priorFence + index + 1)
    );

    expect(continuation.transitions?.[0]).toEqual({
      type: 'StateTransition',
      from: 'LevelDispatch',
      to: 'LevelDispatch',
    });
    expect(continuation.replay).toEqual(continuation.projection);
    expect(continuation.canonicalReexport).toEqual(continuation.checkpoint);
    expect(continuation.checkpoint.frontier.eventCount).toBe(returnedEvents.length);
    expect(continuation.result).toBeDefined();
  });
});
