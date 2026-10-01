import { createGraphDispatchGate, createGraphRetryDispatchGate } from '../../src/graph-dispatch-gate';
import type { NodeGenerationProjection } from '../../src/state-machine/graph/instance-kernel';

function generation(owner: string, key: string, instanceId: string): NodeGenerationProjection {
  return {
    nodeGenerationId: `${instanceId}-generation`,
    nodeInstanceId: `${instanceId}-node`,
    subgraphInstanceId: instanceId,
    templateNodeKey: 'step',
    checkId: 'step',
    scope: [{ kind: 'keyed', expansionOwnerCheck: owner, key, subgraphInstanceId: instanceId }],
    incarnation: 0,
    itemFingerprint: 'a'.repeat(64),
    executionConfigDigest: 'b'.repeat(64),
    activeInputClaimIds: [],
    status: 'ready',
    scheduled: false,
    completedOutputClaimIds: [],
  };
}

describe('Graph-v2 keyed dispatch gate', () => {
  it('admits a complete instance, defers the next, and counts repeated defers once', async () => {
    const handle = createGraphDispatchGate('["project","materialize"]', 1);
    const first = generation('["project","materialize"]', 'A', 'a'.repeat(64));
    const second = generation('["project","materialize"]', 'B', 'b'.repeat(64));
    const parent = generation('discover', 'P1', 'p'.repeat(64));

    expect(await handle.gate(first)).toBe('dispatch');
    expect(await handle.gate(generation('["project","materialize"]', 'A', 'a'.repeat(64)))).toBe('dispatch');
    expect(await handle.gate(second)).toBe('defer');
    expect(await handle.gate(second)).toBe('defer');
    expect(await handle.gate(parent)).toBe('dispatch');
    expect(handle.state.admittedInstanceIds.size).toBe(1);
    expect(handle.state.deferredInstanceIds.size).toBe(1);
    expect(handle.state.deferred).toBe(true);
  });

  it('retries only the selected generated instance and defers its siblings', async () => {
    const target = 'a'.repeat(64);
    const handle = createGraphRetryDispatchGate(target);
    expect(await handle.gate(generation('owner', 'A', target))).toBe('dispatch');
    expect(await handle.gate(generation('owner', 'B', 'b'.repeat(64)))).toBe('defer');
    expect(await handle.gate({ ...generation('owner', 'root', 'c'.repeat(64)), scope: [] })).toBe('defer');
    expect(handle.state.deferred).toBe(true);
    expect(handle.state.deferredInstanceIds).toEqual(new Set(['b'.repeat(64), 'c'.repeat(64)]));
  });
});
