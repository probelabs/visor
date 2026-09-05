import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalGraphCheckpointJson } from '../../src/snapshot-store';
import { deriveProofProjectReconciliationParentClaimIds } from '../../src/state-machine/graph/instance-kernel';

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

function canonicalBytes(value: unknown): string {
  return canonicalGraphCheckpointJson(value);
}

function activeClaims(projection: any, claim: string, scopeLength?: number): any[] {
  return Object.values(projection.claimsById).filter((value: any) =>
    value.claim === claim &&
    value.active === true &&
    (scopeLength === undefined || value.scope.length === scopeLength),
  ) as any[];
}

function completedGenerationFor(projection: any, subgraphInstanceId: string, checkId: string): any {
  return Object.values(projection.generationsById).find((value: any) =>
    value.subgraphInstanceId === subgraphInstanceId &&
    value.checkId === checkId &&
    value.status === 'completed',
  );
}

function attemptDispatches(checkpoint: any, projection: any, prefixLength: number): string[] {
  return checkpoint.events.slice(prefixLength)
    .filter((event: any) => event.type === 'AttemptStarted')
    .map((event: any) => {
      const generation = projection.generationsById[event.nodeGenerationId];
      const instance = generation && projection.instancesById[generation.subgraphInstanceId];
      return `${instance?.itemKey ?? '<unknown>'}:${event.checkId}`;
    })
    .sort();
}

describe('public Proof current-catalog checkpoint continuation', () => {
  it('process A emits a quiescent EXP0209 checkpoint and process B continues it', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-c2c-'));
    try {
      runChild('produce', directory);
      const artifact = JSON.parse(fs.readFileSync(path.join(directory, 'baseline.json'), 'utf8'));
      expect(artifact.pid).not.toBe(process.pid);
      const sourceCheckpoint = JSON.parse(artifact.checkpoint);
      expect(artifact.checkpoint).toBe(canonicalBytes(sourceCheckpoint));
      expect(sourceCheckpoint.frontier.eventCount).toBe(sourceCheckpoint.events.length);
      expect(sourceCheckpoint.frontier.eventCount).toBeGreaterThan(0);
      expect(sourceCheckpoint.sessionId).toEqual(expect.any(String));
      expect(artifact.calls).toEqual(expect.arrayContaining(['alpha', 'beta', 'gamma']));

      const baselineComponentAdmissions = activeClaims(artifact.projection, 'proof.admitted_receipt@1', 2);
      expect(baselineComponentAdmissions).toHaveLength(3);
      expect(new Set(baselineComponentAdmissions.map((claim: any) => claim.scope.at(-1).key))).toEqual(new Set(['alpha', 'beta', 'gamma']));
      const baselineProject = instanceSlice(artifact.projection, 'journalservice');
      const baselineReconcileGeneration = completedGenerationFor(artifact.projection, baselineProject.instance.subgraphInstanceId, 'project_reconcile');
      expect(baselineReconcileGeneration).toBeDefined();
      expect(baselineReconcileGeneration.status).toBe('completed');
      const baselineReconcileReceipts = activeClaims(artifact.projection, 'proof.project_reconciliation_receipt@1', 1);
      expect(baselineReconcileReceipts).toHaveLength(1);
      expect(baselineReconcileReceipts[0].subgraphInstanceId).toBe(baselineProject.instance.subgraphInstanceId);
      expect(baselineReconcileGeneration.completedOutputClaimIds).toEqual([baselineReconcileReceipts[0].claimId]);

      runChild('continue', directory);
      const continuation = JSON.parse(fs.readFileSync(path.join(directory, 'continuation.json'), 'utf8'));
      expect(continuation.pid).not.toBe(artifact.pid);
      const returnedCheckpoint = JSON.parse(continuation.checkpoint);
      expect(returnedCheckpoint.sessionId).toBe(sourceCheckpoint.sessionId);
      expect(continuation.checkpoint).toBe(canonicalBytes(returnedCheckpoint));
      expect(continuation.mutationEventCount).toBeGreaterThan(0);
      expect(continuation.authorityId).toEqual(expect.any(String));
      expect(continuation.calls).toEqual(['alpha']);
      const prefixLength = sourceCheckpoint.events.length;
      expect(returnedCheckpoint.events.slice(0, prefixLength)).toEqual(sourceCheckpoint.events);
      expect(canonicalBytes(returnedCheckpoint.events.slice(0, prefixLength))).toBe(canonicalBytes(sourceCheckpoint.events));
      expect(continuation.restoredReexport).toBe(continuation.checkpoint);
      expect(canonicalBytes(continuation.restored)).toBe(canonicalBytes(continuation.projection));
      expect(canonicalBytes(continuation.replay)).toBe(canonicalBytes(continuation.projection));
      expect(continuation.restored).toEqual(continuation.projection);
      expect(continuation.replay).toEqual(continuation.projection);

      for (const component of ['beta', 'gamma']) {
        expect(canonicalBytes(instanceSlice(continuation.projection, component))).toBe(canonicalBytes(instanceSlice(artifact.projection, component)));
      }
      const sourceAlpha = instanceSlice(artifact.projection, 'alpha');
      const continuedAlpha = instanceSlice(continuation.projection, 'alpha');
      expect(continuation.editedPaths).toEqual(['alpha.go']);
      expect(continuation.sourceBefore).toEqual(artifact.sourceDigests);
      expect(continuation.sourceAfter['beta.go']).toBe(artifact.sourceDigests['beta.go']);
      expect(continuation.sourceAfter['gamma.go']).toBe(artifact.sourceDigests['gamma.go']);
      expect(continuation.sourceAfter['alpha.go']).not.toBe(artifact.sourceDigests['alpha.go']);
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
      expect(recordedAuthority).toBeDefined();
      expect(Buffer.from(recordedAuthority.revalidationBytesBase64, 'base64').toString('utf8')).toBe(continuation.revalidationBytes);
      expect(Buffer.from(recordedAuthority.workItemsBytesBase64, 'base64').toString('utf8')).toBe(continuation.workItemsBytes);
      const sourceCandidate = sourceCheckpoint.events.find((event: any) => event.type === 'ClaimPublished' && event.claim === 'proof.candidate@1' && event.scope.length === 1);
      expect(sourceCandidate).toBeDefined();
      expect(Object.is(sourceCandidate.payload.components.find((component: any) => component.id === 'alpha').interfaces[1].n, -0)).toBe(true);
      const alphaID = sourceAlpha.instance.subgraphInstanceId;
      const suffix = returnedCheckpoint.events.slice(sourceCheckpoint.events.length);
      expect(attemptDispatches(returnedCheckpoint, continuation.projection, prefixLength)).toEqual([
        'alpha:inspect', 'alpha:proof_admit', 'alpha:verify', 'journalservice:project_reconcile',
      ]);
      expect(suffix.filter((event: any) => event.type === 'AttemptStarted' && event.scope.some((segment: any) => segment.subgraphInstanceId === alphaID))).not.toHaveLength(0);
      for (const component of ['beta', 'gamma']) {
        const componentID = (instanceSlice(artifact.projection, component) as any).instance.subgraphInstanceId;
        expect(suffix.filter((event: any) => event.type === 'AttemptStarted' && event.scope.some((segment: any) => segment.subgraphInstanceId === componentID))).toEqual([]);
      }

      const continuedProjectReceipts = Object.values(continuation.projection.claimsById).filter((value: any) =>
        value.claim === 'proof.project_reconciliation_receipt@1' && value.subgraphInstanceId === baselineProject.instance.subgraphInstanceId,
      ) as any[];
      expect(continuedProjectReceipts).toHaveLength(2);
      expect(continuedProjectReceipts.filter((claim: any) => claim.active)).toHaveLength(1);
      const replacementReceipt = continuedProjectReceipts.find((claim: any) => claim.active);
      expect(replacementReceipt).toBeDefined();
      const continuedReconcileGenerations = Object.values(continuation.projection.generationsById).filter((value: any) =>
        value.subgraphInstanceId === baselineProject.instance.subgraphInstanceId && value.checkId === 'project_reconcile',
      ) as any[];
      expect(continuedReconcileGenerations).toHaveLength(2);
      expect(continuedReconcileGenerations.filter((generation: any) => generation.status === 'completed')).toHaveLength(1);
      const replacementGeneration = continuedReconcileGenerations.find((generation: any) => generation.status === 'completed');
      expect(replacementGeneration.completedOutputClaimIds).toEqual([replacementReceipt.claimId]);
      expect(replacementGeneration.activeInputClaimIds).toEqual([]);
      expect(continuation.projection.generationsById[baselineReconcileGeneration.nodeGenerationId].status).toBe('inactive');
      expect(continuation.projection.claimsById[baselineReconcileReceipts[0].claimId].active).toBe(false);

      const baselineRevalidation = activeClaims(artifact.projection, 'proof.catalog_revalidation@1', 1);
      expect(baselineRevalidation).toHaveLength(1);
      expect(replacementReceipt.parentClaimIds).toEqual(
        deriveProofProjectReconciliationParentClaimIds(continuation.projection, replacementGeneration),
      );
      expect(replacementReceipt.parentClaimIds).toEqual(
        [baselineRevalidation[0].claimId, ...activeClaims(continuation.projection, 'proof.admitted_receipt@1', 2).map((claim: any) => claim.claimId)].sort(),
      );

      const baselineReconcileRequest = JSON.parse(artifact.projectReconciliationRequest);
      const replacementReconcileRequest = JSON.parse(continuation.projectReconciliationRequest);
      const baselineRevalidationReceiptId = baselineReconcileRequest.catalog_revalidation.receipt.receipt_id;
      const replacementRevalidationReceiptId = replacementReconcileRequest.catalog_revalidation.receipt.receipt_id;
      expect(replacementRevalidationReceiptId).not.toBe(baselineRevalidationReceiptId);
      expect(replacementReceipt.payload.catalog_revalidation_receipt.receipt_id).toBe(replacementRevalidationReceiptId);
      expect(baselineReconcileReceipts[0].payload.catalog_revalidation_receipt.receipt_id).toBe(baselineRevalidationReceiptId);

      const repeat = JSON.parse(fs.readFileSync(path.join(directory, 'repeat.json'), 'utf8'));
      expect(repeat.mutationEventCount).toBe(0);
      expect(repeat.calls).toEqual([]);
      expect(repeat.probeDispatches).toEqual([]);
      expect(repeat.receiptCount).toBe(2);
      const repeatCheckpoint = JSON.parse(repeat.checkpoint);
      const repeatSuffix = repeatCheckpoint.events.slice(returnedCheckpoint.events.length);
      expect(repeatSuffix.filter((event: any) => ['AttemptStarted', 'NodeGenerationActivated', 'NodeGenerationInactivated'].includes(event.type))).toEqual([]);
      runChild('negative', directory);
      const negative = JSON.parse(fs.readFileSync(path.join(directory, 'negative.json'), 'utf8'));
      expect(negative).toEqual({
        calls: [],
        malformed: true,
        foreign: true,
        nonquiescent: true,
        standaloneInactivation: true,
        retiredReceiptRebind: true,
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
