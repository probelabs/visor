import type { EngineContext, EngineEvent, EngineState, RunState } from '../../types/engine';
import type { ReviewSummary } from '../../reviewer';
import type { CheckConfig } from '../../types/config';
/**
 * Execute a single check with provider integration (non-forEach path, but handles forEach parent outputs
 * and can redirect to forEach processor upstream).
 *
 * Note: for deciding whether to run, this function relies on the provided evaluateIf callback.
 */
export declare function executeSingleCheck(checkId: string, context: EngineContext, state: RunState, emitEvent: (event: EngineEvent) => void, transition: (newState: EngineState) => void, evaluateIf: (checkId: string, checkConfig: CheckConfig, context: EngineContext, state: RunState) => Promise<boolean>, scopeOverride?: Array<{
    check: string;
    index: number;
}>): Promise<ReviewSummary>;
//# sourceMappingURL=execution-invoker.d.ts.map