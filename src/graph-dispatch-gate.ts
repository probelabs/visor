import type { NodeGenerationProjection } from './state-machine/graph/instance-kernel';
import type { GeneratedDispatchGate, GeneratedDispatchGateDecision } from './types/engine';

export interface GraphDispatchGateState {
  readonly admittedInstanceIds: ReadonlySet<string>;
  readonly deferredInstanceIds: ReadonlySet<string>;
  deferred: boolean;
}

export interface GraphDispatchGateHandle {
  readonly gate: GeneratedDispatchGate;
  readonly state: GraphDispatchGateState;
}

/**
 * Admit complete keyed generated instances, rather than individual nodes.
 * Nodes outside the selected owner remain dispatchable so parent/barrier work
 * can drain once its graph-owned readiness conditions are satisfied.
 */
export function createGraphDispatchGate(
  owner: string,
  limit: number,
): GraphDispatchGateHandle {
  const admittedInstanceIds = new Set<string>();
  const deferredInstanceIds = new Set<string>();
  const state: GraphDispatchGateState = {
    admittedInstanceIds,
    deferredInstanceIds,
    deferred: false,
  };

  const gate: GeneratedDispatchGate = (
    generation: NodeGenerationProjection,
  ): GeneratedDispatchGateDecision => {
    const matching = generation.scope.filter(
      segment => segment.kind === 'keyed' && segment.expansionOwnerCheck === owner,
    );
    if (matching.length === 0) return 'dispatch';

    const instanceIds = new Set(matching.map(segment => segment.subgraphInstanceId));
    if (instanceIds.size !== 1) {
      throw new Error(`Graph dispatch owner ${owner} matched an ambiguous generated scope`);
    }
    const instanceId = matching[0].subgraphInstanceId;
    if (admittedInstanceIds.has(instanceId)) return 'dispatch';
    if (admittedInstanceIds.size < limit) {
      admittedInstanceIds.add(instanceId);
      return 'dispatch';
    }
    state.deferred = true;
    deferredInstanceIds.add(instanceId);
    return 'defer';
  };

  return { gate, state };
}

/**
 * Retry only the selected generated subgraph instance. Every other generated
 * instance, including parent/barrier work and empty-scope generated work,
 * stays ready until an ordinary resume explicitly drains it.
 */
export function createGraphRetryDispatchGate(
  targetSubgraphInstanceId: string,
): GraphDispatchGateHandle {
  const admittedInstanceIds = new Set<string>([targetSubgraphInstanceId]);
  const deferredInstanceIds = new Set<string>();
  const state: GraphDispatchGateState = {
    admittedInstanceIds,
    deferredInstanceIds,
    deferred: false,
  };

  const gate: GeneratedDispatchGate = (generation: NodeGenerationProjection): GeneratedDispatchGateDecision => {
    if (generation.subgraphInstanceId === targetSubgraphInstanceId) {
      return 'dispatch';
    }
    state.deferred = true;
    deferredInstanceIds.add(generation.subgraphInstanceId);
    return 'defer';
  };

  return { gate, state };
}

/** Apply the existing pause/stop check before making the keyed admission decision. */
export function composeGraphDispatchGate(
  pauseGate: () => Promise<void>,
  dispatchGate?: GeneratedDispatchGate,
): GeneratedDispatchGate {
  return async generation => {
    await pauseGate();
    return dispatchGate ? dispatchGate(generation) : 'dispatch';
  };
}
