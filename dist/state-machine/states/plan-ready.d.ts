/**
 * PlanReady State Handler
 *
 * Responsibilities:
 * - Build dependency graph using DependencyResolver
 * - Validate graph (check for cycles)
 * - Compute check metadata (tags, sessions, triggers)
 * - Transition to WavePlanning
 */
import type { EngineContext, RunState, EngineState } from '../../types/engine';
export declare function handlePlanReady(context: EngineContext, state: RunState, transition: (newState: EngineState) => void): Promise<void>;
//# sourceMappingURL=plan-ready.d.ts.map