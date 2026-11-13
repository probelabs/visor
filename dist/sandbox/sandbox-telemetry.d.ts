/**
 * Telemetry helpers for sandbox modules.
 * Wraps imports from ../telemetry/trace-helpers with graceful fallback
 * when the telemetry module is not available (e.g., before merging with main).
 */
export declare function withActiveSpan<T>(name: string, attrs: Record<string, unknown> | undefined, fn: (span: unknown) => Promise<T>): Promise<T>;
export declare function addEvent(name: string, attrs?: Record<string, unknown>): void;
export declare function emitImmediateSpan(name: string, attrs?: Record<string, unknown>, options?: {
    events?: Array<{
        name: string;
        attrs?: Record<string, unknown>;
    }>;
    status?: any;
}): void;
export declare function setSpanError(err: unknown): void;
//# sourceMappingURL=sandbox-telemetry.d.ts.map