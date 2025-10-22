/**
 * Lazy-loading wrapper for OpenTelemetry API.
 * Returns no-op implementations if OpenTelemetry is not installed.
 * Uses hardcoded module name for security - no dynamic module loading.
 */
export declare const trace: {
    getTracer(name: string, version?: string): any;
    getSpan(context: any): any;
    getActiveSpan(): any;
};
export declare const context: {
    active(): any;
    with(context: any, fn: Function, thisArg?: any, ...args: any[]): any;
};
export declare const metrics: {
    getMeter(name: string, version?: string): any;
};
export declare const SpanStatusCode: {
    readonly UNSET: any;
    readonly OK: any;
    readonly ERROR: any;
};
export declare const SpanKind: {
    readonly INTERNAL: any;
    readonly SERVER: any;
    readonly CLIENT: any;
    readonly PRODUCER: any;
    readonly CONSUMER: any;
};
export declare const diag: {
    setLogger(logger: any, level?: any): any;
};
export declare const DiagConsoleLogger: {
    get(): any;
};
export declare const DiagLogLevel: {
    readonly NONE: any;
    readonly ERROR: any;
    readonly WARN: any;
    readonly INFO: any;
    readonly DEBUG: any;
    readonly VERBOSE: any;
    readonly ALL: any;
};
export type Span = any;
export type Attributes = Record<string, any>;
export type HrTime = [number, number];
//# sourceMappingURL=lazy-otel.d.ts.map