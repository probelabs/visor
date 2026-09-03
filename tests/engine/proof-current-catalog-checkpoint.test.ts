import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const fixturePath = path.join(__dirname, '../fixtures/proof-current-catalog-checkpoint-child.ts');

function runChild(mode: 'produce' | 'continue' | 'negative', directory: string): void {
  execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', fixturePath, mode, directory], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1' },
    encoding: 'utf8',
    timeout: 180_000,
    stdio: 'pipe',
  });
}

function instanceSlice(projection: any, itemKey: string): any {
  const instance = Object.values(projection.instancesById).find((value: any) => value.itemKey === itemKey);
  if (!instance) return undefined;
  const nodeIds = Object.values((instance as any).nodeInstanceIdsByTemplateNode) as string[];
  return {
    instance,
    nodes: nodeIds.map((id: string) => projection.nodesById[id]).sort((left: any, right: any) => left.nodeInstanceId.localeCompare(right.nodeInstanceId)),
    generations: Object.values(projection.generationsById).filter((value: any) => value.subgraphInstanceId === (instance as any).subgraphInstanceId).sort((left: any, right: any) => left.nodeGenerationId.localeCompare(right.nodeGenerationId)),
    claims: Object.values(projection.claimsById).filter((value: any) => value.subgraphInstanceId === (instance as any).subgraphInstanceId).sort((left: any, right: any) => left.claimId.localeCompare(right.claimId)),
  };
}

describe('public Proof current-catalog checkpoint continuation', () => {
  it('process A emits a quiescent EXP0209 checkpoint and process B continues it', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-c2c-'));
    try {
      runChild('produce', directory);
      const artifact = JSON.parse(fs.readFileSync(path.join(directory, 'baseline.json'), 'utf8'));
      expect(artifact.pid).not.toBe(process.pid);
      expect(JSON.parse(artifact.checkpoint).frontier.eventCount).toBeGreaterThan(0);
      expect(artifact.calls).toEqual(expect.arrayContaining(['alpha', 'beta', 'gamma']));
      runChild('continue', directory);
      const continuation = JSON.parse(fs.readFileSync(path.join(directory, 'continuation.json'), 'utf8'));
      expect(continuation.pid).not.toBe(artifact.pid);
      expect(continuation.mutationEventCount).toBeGreaterThan(0);
      expect(continuation.authorityId).toEqual(expect.any(String));
      expect(continuation.calls).toEqual(['alpha']);
      const sourceCheckpoint = JSON.parse(artifact.checkpoint);
      const returnedCheckpoint = JSON.parse(continuation.checkpoint);
      expect(returnedCheckpoint.events.slice(0, sourceCheckpoint.events.length)).toEqual(sourceCheckpoint.events);
      expect(returnedCheckpoint.events.slice(0, sourceCheckpoint.events.length).map((event: any) => JSON.stringify(event)))
        .toEqual(sourceCheckpoint.events.map((event: any) => JSON.stringify(event)));
      expect(instanceSlice(continuation.projection, 'beta')).toEqual(instanceSlice(artifact.projection, 'beta'));
      expect(instanceSlice(continuation.projection, 'gamma')).toEqual(instanceSlice(artifact.projection, 'gamma'));
      expect(continuation.restored).toEqual(continuation.projection);
      expect(continuation.replay).toEqual(continuation.projection);
      const sourceAlpha = instanceSlice(artifact.projection, 'alpha');
      const continuedAlpha = instanceSlice(continuation.projection, 'alpha');
      expect(continuedAlpha.instance.subgraphInstanceId).toBe(sourceAlpha.instance.subgraphInstanceId);
      expect(continuedAlpha.instance.nodeInstanceIdsByTemplateNode).toEqual(sourceAlpha.instance.nodeInstanceIdsByTemplateNode);
      expect(continuedAlpha.instance.incarnation).toBe(sourceAlpha.instance.incarnation + 1);
      const inspectNodeId = sourceAlpha.instance.nodeInstanceIdsByTemplateNode.inspect;
      const sourceGeneration = artifact.projection.generationsById[artifact.projection.activeGenerationIdByNode[inspectNodeId]];
      const continuedGeneration = continuation.projection.generationsById[continuation.projection.activeGenerationIdByNode[inspectNodeId]];
      expect(continuedGeneration.nodeGenerationId).not.toBe(sourceGeneration.nodeGenerationId);
      expect(continuedGeneration.incarnation).toBe(sourceGeneration.incarnation + 1);
      expect(continuedGeneration.fence).toBeGreaterThan(sourceGeneration.fence);
      expect(continuedGeneration.status).toBe('completed');
      expect(continuation.result.statistics.failedExecutions).toBe(0);
      expect(continuation.result.statistics.totalExecutions).toBeGreaterThan(0);
      const recordedAuthority = returnedCheckpoint.events.find((event: any) => event.type === 'ProofCurrentCatalogAuthorityRecorded');
      expect(Buffer.from(recordedAuthority.revalidationBytesBase64, 'base64').toString('utf8')).toBe(continuation.revalidationBytes);
      expect(Buffer.from(recordedAuthority.workItemsBytesBase64, 'base64').toString('utf8')).toBe(continuation.workItemsBytes);
      const sourceCandidate = sourceCheckpoint.events.find((event: any) => event.type === 'ClaimPublished' && event.claim === 'proof.candidate@1' && event.scope.length === 1);
      expect(Object.is(sourceCandidate.payload.components.find((component: any) => component.id === 'alpha').interfaces[1].n, -0)).toBe(true);
      const alphaID = sourceAlpha.instance.subgraphInstanceId;
      const suffix = returnedCheckpoint.events.slice(sourceCheckpoint.events.length);
      expect(suffix.filter((event: any) => event.type === 'AttemptStarted' && event.scope.some((segment: any) => segment.subgraphInstanceId === alphaID))).not.toHaveLength(0);
      for (const component of ['beta', 'gamma']) {
        const componentID = (instanceSlice(artifact.projection, component) as any).instance.subgraphInstanceId;
        expect(suffix.filter((event: any) => event.type === 'AttemptStarted' && event.scope.some((segment: any) => segment.subgraphInstanceId === componentID))).toEqual([]);
      }
      const repeat = JSON.parse(fs.readFileSync(path.join(directory, 'repeat.json'), 'utf8'));
      expect(repeat.mutationEventCount).toBe(0);
      expect(repeat.calls).toEqual([]);
      runChild('negative', directory);
      const negative = JSON.parse(fs.readFileSync(path.join(directory, 'negative.json'), 'utf8'));
      expect(negative).toEqual({ calls: [], malformed: true, foreign: true, nonquiescent: true });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
