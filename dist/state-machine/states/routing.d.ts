/**
 * Routing State Handler
 *
 * Responsibilities:
 * - Evaluate fail_if conditions after check execution
 * - Process on_success, on_fail, on_finish triggers
 * - Enqueue ForwardRunRequested events for goto
 * - Enqueue WaveRetry events for routing loops
 * - Transition back to WavePlanning or Completed
 *
 * M2: Core routing logic implementation
 */
import type { EngineContext, RunState, EngineState, EngineEvent } from '../../types/engine';
import type { ReviewSummary } from '../../reviewer';
import type { CheckConfig, TransitionRule } from '../../types/config';
/**
 * Context for a check that just completed and needs routing evaluation
 */
interface RoutingContext {
    checkId: string;
    scope: Array<{
        check: string;
        index: number;
    }>;
    result: ReviewSummary;
    checkConfig: CheckConfig;
    success: boolean;
}
/**
 * Handle routing state - evaluate conditions and decide next actions
 */
export declare function handleRouting(context: EngineContext, state: RunState, transition: (newState: EngineState) => void, emitEvent: (event: EngineEvent) => void, routingContext: RoutingContext): Promise<void>;
/**
 * Check if routing loop budget is exceeded
 */
export declare function checkLoopBudget(context: EngineContext, state: RunState, origin: 'on_success' | 'on_fail' | 'on_finish', action: 'run' | 'goto'): boolean;
/**
 * Evaluate goto_js or return static goto target
 */
export declare function evaluateGoto(gotoJs: string | undefined, gotoStatic: string | undefined, checkId: string, checkConfig: CheckConfig, result: ReviewSummary, context: EngineContext, _state: RunState): Promise<string | null>;
/**
 * Evaluate declarative transitions. Returns:
 *  - { to, goto_event } when a rule matches,
 *  - null (explicit) when a rule matches with to=null,
 *  - undefined when no rule matched or transitions is empty.
 */
export declare function evaluateTransitions(transitions: TransitionRule[] | undefined, checkId: string, checkConfig: CheckConfig, result: ReviewSummary, context: EngineContext, _state: RunState): Promise<{
    to: string;
    goto_event?: import('../../types/config').EventTrigger;
} | null | undefined>;
export {};
//# sourceMappingURL=routing.d.ts.map