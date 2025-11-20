/**
 * Init State Handler
 *
 * Responsibilities:
 * - Validate configuration
 * - Initialize services (journal, memory, GitHub checks)
 * - Transition to PlanReady
 */
import type { EngineContext, RunState, EngineState } from '../../types/engine';
export declare function handleInit(context: EngineContext, state: RunState, transition: (newState: EngineState) => void): Promise<void>;
//# sourceMappingURL=init.d.ts.map