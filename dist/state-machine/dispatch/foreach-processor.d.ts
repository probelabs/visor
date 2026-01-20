import type { EngineContext, EngineEvent, EngineState, RunState } from '../../types/engine';
import type { ReviewSummary } from '../../reviewer';
/**
 * Execute a check once per forEach item (map fanout path).
 * Extracted from LevelDispatch without behavior change.
 */
export declare function executeCheckWithForEachItems(checkId: string, forEachParent: string, forEachItems: unknown[], context: EngineContext, state: RunState, emitEvent: (event: EngineEvent) => void, transition: (newState: EngineState) => void): Promise<ReviewSummary>;
//# sourceMappingURL=foreach-processor.d.ts.map