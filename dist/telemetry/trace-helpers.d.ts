import { Span } from './lazy-otel';
export declare function getTracer(): any;
export declare function withActiveSpan<T>(name: string, attrs: Record<string, unknown> | undefined, fn: (span: Span) => Promise<T>): Promise<T>;
export declare function emitImmediateSpan(name: string, attrs?: Record<string, unknown>, options?: {
    events?: Array<{
        name: string;
        attrs?: Record<string, unknown>;
    }>;
    status?: {
        code?: number;
        message?: string;
    };
}): void;
export declare function addEvent(name: string, attrs?: Record<string, unknown>): void;
export declare function setSpanAttributes(attrs: Record<string, unknown>): void;
export declare function setSpanError(err: unknown): void;
/**
 * Return standard visor.* resource attributes for the root `visor.run` span.
 * Reads version from package.json / env and git commit short SHA from env.
 */
export declare function getVisorRunAttributes(): Record<string, string>;
/**
 * Wraps a visor.run span with automatic run metrics (counter + duration histogram).
 * Use this instead of raw `withActiveSpan('visor.run', ...)` to get metrics for free.
 */
export declare function withVisorRun<T>(attrs: Record<string, unknown>, runMeta: {
    source?: string;
    userId?: string;
    userName?: string;
    workflowId?: string;
}, fn: (span: Span) => Promise<T>): Promise<T>;
export declare function __getOrCreateNdjsonPath(): string | null;
export declare function _appendRunMarker(): void;
//# sourceMappingURL=trace-helpers.d.ts.map