/**
 * Enhanced state capture for OTEL spans to enable interactive debugging.
 *
 * This module provides utilities to capture complete execution state in span
 * attributes, enabling time-travel debugging and full state inspection.
 */
import { Span } from './lazy-otel';
/**
 * Capture check input context (Liquid template variables) in span.
 */
export declare function captureCheckInputContext(span: Span, context: Record<string, unknown>): void;
/**
 * Capture check output in span.
 */
export declare function captureCheckOutput(span: Span, output: unknown): void;
/**
 * Capture forEach iteration state.
 */
export declare function captureForEachState(span: Span, items: unknown[], index: number, currentItem: unknown): void;
/**
 * Capture Liquid template evaluation details.
 */
export declare function captureLiquidEvaluation(span: Span, template: string, context: Record<string, unknown>, result: string): void;
/**
 * Capture JavaScript transform execution.
 */
export declare function captureTransformJS(span: Span, code: string, input: unknown, output: unknown): void;
/**
 * Capture provider request/response summary (safe, no raw AI content).
 */
export declare function captureProviderCall(span: Span, providerType: string, request: {
    prompt?: string;
    model?: string;
    [key: string]: unknown;
}, response: {
    content?: string;
    tokens?: number;
    [key: string]: unknown;
}): void;
/**
 * Capture conditional evaluation (if/fail_if).
 */
export declare function captureConditionalEvaluation(span: Span, condition: string, result: boolean, context: Record<string, unknown>): void;
/**
 * Capture routing decision (retry/goto/run).
 */
export declare function captureRoutingDecision(span: Span, action: 'retry' | 'goto' | 'run', target: string | string[], condition?: string): void;
/**
 * Create a snapshot of the entire execution state at a point in time.
 * This is added as a span event for time-travel debugging.
 */
export declare function captureStateSnapshot(span: Span, checkId: string, outputs: Record<string, unknown>, memory: Record<string, unknown>): void;
//# sourceMappingURL=state-capture.d.ts.map