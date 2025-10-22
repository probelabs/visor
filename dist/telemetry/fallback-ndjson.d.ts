export declare function flushNdjson(): Promise<void>;
export declare function emitNdjsonFallback(name: string, attrs: Record<string, unknown>): void;
export declare function emitNdjsonSpanWithEvents(name: string, attrs: Record<string, unknown>, events: Array<{
    name: string;
    attrs?: Record<string, unknown>;
}>): void;
//# sourceMappingURL=fallback-ndjson.d.ts.map