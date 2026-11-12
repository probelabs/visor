/**
 * LevelDispatch State Handler
 *
 * Responsibilities:
 * - Pop next topological level from queue
 * - Spawn tasks up to maxParallelism
 * - Handle session reuse barriers
 * - Support fail-fast
 * - Support debug pause
 * - Execute actual provider logic
 * - Transition back to WavePlanning or handle errors
 *
 * M2: Integrates actual provider execution and routing
 */
import type { EngineContext, RunState, EngineState, EngineEvent } from '../../types/engine';
export declare function handleLevelDispatch(context: EngineContext, state: RunState, transition: (newState: EngineState) => void, emitEvent: (event: EngineEvent) => void): Promise<void>;
//# sourceMappingURL=level-dispatch.d.ts.map