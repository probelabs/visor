import type { EngineContext, RunState } from '../../types/engine';
import type { ReviewSummary } from '../../reviewer';
/**
 * Build dependency results for a check with a specific scope.
 * Extracted from LevelDispatch to centralize dependency resolution logic.
 */
export declare function buildDependencyResultsWithScope(checkId: string, checkConfig: any, context: EngineContext, scope: Array<{
    check: string;
    index: number;
}>): Map<string, ReviewSummary>;
export declare function buildDependencyResults(checkId: string, checkConfig: any, context: EngineContext, _state: RunState): Map<string, ReviewSummary>;
//# sourceMappingURL=dependency-gating.d.ts.map