/**
 * Read child visor NDJSON trace files and re-emit spans into the parent's
 * telemetry context as proper child spans.
 *
 * Supports:
 * - one-shot ingestion after child exit
 * - incremental tailing while child is still running
 */
export declare class ChildTraceTailer {
    private readonly filePath;
    private readonly pollIntervalMs;
    private readonly seenKeys;
    private readonly parentContext;
    private readonly replayContexts;
    private offset;
    private partialLine;
    private timer;
    private activePoll;
    constructor(filePath: string, options?: {
        pollIntervalMs?: number;
        seenKeys?: Set<string>;
        parentContext?: any;
    });
    start(): void;
    stop(): Promise<void>;
    private pollOnce;
}
export declare function ingestChildTrace(filePath: string, options?: {
    seenKeys?: Set<string>;
    parentContext?: any;
}): void;
//# sourceMappingURL=trace-ingester.d.ts.map