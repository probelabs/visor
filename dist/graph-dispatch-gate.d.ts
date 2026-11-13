import type { GeneratedDispatchGate } from './types/engine';
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
export declare function createGraphDispatchGate(owner: string, limit: number): GraphDispatchGateHandle;
/**
 * Retry only the selected generated subgraph instance. Every other generated
 * instance, including parent/barrier work and empty-scope generated work,
 * stays ready until an ordinary resume explicitly drains it.
 */
export declare function createGraphRetryDispatchGate(targetSubgraphInstanceId: string): GraphDispatchGateHandle;
/** Apply the existing pause/stop check before making the keyed admission decision. */
export declare function composeGraphDispatchGate(pauseGate: () => Promise<void>, dispatchGate?: GeneratedDispatchGate): GeneratedDispatchGate;
