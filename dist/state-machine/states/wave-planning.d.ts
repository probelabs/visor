/**
 * WavePlanning State Handler
 *
 * Responsibilities:
 * - Inspect event queue for forward runs, goto events, etc.
 * - Determine next wave's execution levels
 * - Queue topological levels for execution
 * - Transition to LevelDispatch or Completed
 *
 * M2: Adds goto/on_finish/on_fail routing with deduplication
 */
import type { EngineContext, RunState, EngineState } from '../../types/engine';
export declare function handleWavePlanning(context: EngineContext, state: RunState, transition: (newState: EngineState) => void): Promise<void>;
//# sourceMappingURL=wave-planning.d.ts.map