export declare function flushNdjson(): Promise<void>;
export declare function emitNdjsonFallback(name: string, attrs: Record<string, unknown>): void;
export declare function emitNdjsonSpanWithEvents(name: string, attrs: Record<string, unknown>, events: Array<{
    name: string;
    attrs?: Record<string, unknown>;
}>): void;
/**
 * Emit a full span record to fallback NDJSON including traceId, spanId,
 * parentSpanId, and timing — compatible with the trace serializer's
 * parseLocalNDJSONSpans format.
 */
export declare function emitNdjsonFullSpan(record: {
    name: string;
    traceId?: string;
    spanId?: string;
    parentSpanId?: string;
    startTime?: [number, number];
    endTime?: [number, number];
    attributes?: Record<string, unknown>;
    events?: Array<{
        name: string;
        attributes?: Record<string, unknown>;
    }>;
    status?: {
        code?: number;
    };
}): void;
//# sourceMappingURL=fallback-ndjson.d.ts.map