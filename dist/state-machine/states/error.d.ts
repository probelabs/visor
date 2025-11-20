/**
 * Error State Handler
 *
 * Responsibilities:
 * - Capture fatal errors
 * - Unwind gracefully
 * - Terminal state
 */
import type { EngineContext, RunState } from '../../types/engine';
export declare function handleError(context: EngineContext, state: RunState): Promise<void>;
//# sourceMappingURL=error.d.ts.map