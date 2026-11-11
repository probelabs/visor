import type { Frontend, FrontendContext } from './host';
export declare class NdjsonSink implements Frontend {
    readonly name = "ndjson-sink";
    private cfg;
    private unsub?;
    private filePath?;
    constructor(config?: unknown);
    start(ctx: FrontendContext): void;
    stop(): void;
    private resolveFile;
}
//# sourceMappingURL=ndjson-sink.d.ts.map