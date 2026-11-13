import type { VisorConfig } from '../../types/config';
import type { PRInfo } from '../../pr-analyzer';
import type { EngineContext, GeneratedDispatchGate } from '../../types/engine';
/** Private bootstrap used only by the engine's one-shot Graph checkpoint continuation. */
export interface GraphCheckpointBootstrap {
    readonly kind: 'graph';
    readonly checkpoint: unknown;
    readonly expansionOwnerCheck: string;
}
/** Restore a ready-only checkpoint without appending a catalog request. */
export interface GraphCheckpointResumeBootstrap {
    readonly kind: 'graph-resume';
    readonly checkpoint: unknown;
}
/**
 * Private bootstrap for a Proof catalog refresh.  The public SDK deliberately
 * does not expose graph mutations: it supplies only the checkpoint and the
 * exact Proof output bytes, which the journal authenticates and projects.
 */
export interface ProofCurrentCatalogCheckpointBootstrap {
    readonly kind: 'proof-current-catalog';
    readonly checkpoint: unknown;
    readonly projectSubgraphInstanceId: string;
    readonly revalidationBytes: string | Uint8Array;
    readonly workItemsBytes: string | Uint8Array;
}
export type CheckpointBootstrap = GraphCheckpointBootstrap | GraphCheckpointResumeBootstrap | ProofCurrentCatalogCheckpointBootstrap;
export type BuiltGraphCheckpointContext = {
    readonly kind: 'graph';
    readonly context: EngineContext;
    readonly requestId: string;
} | {
    readonly kind: 'proof-current-catalog';
    readonly context: EngineContext;
    readonly authorityId: string;
    readonly mutationEventCount: number;
} | {
    readonly kind: 'graph-resume';
    readonly context: EngineContext;
};
/**
 * Pure helper to build an EngineContext for a state-machine run.
 * Extracted to reduce StateMachineExecutionEngine size; behavior unchanged.
 */
export declare function buildEngineContextForRun(workingDirectory: string, config: VisorConfig, prInfo: PRInfo, debug?: boolean, maxParallelism?: number, failFast?: boolean, requestedChecks?: string[], graphCheckpointBootstrap?: undefined, generatedDispatchGate?: GeneratedDispatchGate, runtimeTimeoutMs?: number): EngineContext;
export declare function buildEngineContextForRun(workingDirectory: string, config: VisorConfig, prInfo: PRInfo, debug?: boolean, maxParallelism?: number, failFast?: boolean, requestedChecks?: string[], graphCheckpointBootstrap?: CheckpointBootstrap, generatedDispatchGate?: GeneratedDispatchGate, runtimeTimeoutMs?: number): BuiltGraphCheckpointContext;
/**
 * Initialize workspace isolation for an engine context.
 * Creates an isolated workspace with the main project worktree.
 *
 * @param context - Engine context to update with workspace
 * @returns Updated context (same object, mutated)
 */
export declare function initializeWorkspace(context: EngineContext): Promise<EngineContext>;
//# sourceMappingURL=build-engine-context.d.ts.map