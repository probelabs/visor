type ReadableSpan = any;
type ExportResult = any;
export interface FileSpanExporterOptions {
    dir?: string;
    runId?: string;
    ndjson?: boolean;
}
export declare class FileSpanExporter {
    private filePath;
    private buffer;
    private ndjson;
    constructor(opts?: FileSpanExporterOptions);
    export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void;
    shutdown(): Promise<void>;
    forceFlush(): Promise<void>;
}
export {};
//# sourceMappingURL=file-span-exporter.d.ts.map