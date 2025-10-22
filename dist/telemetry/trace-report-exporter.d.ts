type ReadableSpan = any;
type ExportResult = any;
export interface TraceReportExporterOptions {
    dir?: string;
    runId?: string;
}
export declare class TraceReportExporter {
    private spans;
    private outDir;
    private runId?;
    constructor(opts?: TraceReportExporterOptions);
    export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void;
    shutdown(): Promise<void>;
    private toOtlpJson;
    forceFlush(): Promise<void>;
}
export {};
//# sourceMappingURL=trace-report-exporter.d.ts.map