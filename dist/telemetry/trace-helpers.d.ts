import { Span } from './lazy-otel';
export declare function getTracer(): any;
export declare function withActiveSpan<T>(name: string, attrs: Record<string, unknown> | undefined, fn: (span: Span) => Promise<T>): Promise<T>;
export declare function addEvent(name: string, attrs?: Record<string, unknown>): void;
export declare function setSpanAttributes(attrs: Record<string, unknown>): void;
export declare function setSpanError(err: unknown): void;
export declare function __getOrCreateNdjsonPath(): string | null;
export declare function _appendRunMarker(): void;
//# sourceMappingURL=trace-helpers.d.ts.map