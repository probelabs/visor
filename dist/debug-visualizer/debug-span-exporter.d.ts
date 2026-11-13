/**
 * Custom OpenTelemetry Span Exporter for Debug Visualizer
 *
 * Exports spans to the WebSocket server for live visualization
 * while also allowing them to be exported to other exporters (file, console, etc.)
 *
 * Milestone 4: Live Streaming Server
 * Note: This file is only loaded when telemetry is enabled via opentelemetry.ts
 */
import { DebugVisualizerServer } from './ws-server';
type ReadableSpan = any;
type ExportResult = any;
/**
 * OTEL Span Exporter that streams spans to debug visualizer WebSocket server
 */
export declare class DebugSpanExporter {
    private server;
    constructor(server: DebugVisualizerServer);
    /**
     * Export spans to WebSocket server
     */
    export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void;
    /**
     * Shutdown the exporter
     */
    shutdown(): Promise<void>;
    /**
     * Force flush any buffered spans (no-op for this exporter)
     */
    forceFlush(): Promise<void>;
    /**
     * Convert OTEL ReadableSpan to ProcessedSpan format
     */
    private convertSpan;
    /**
     * Convert OTEL HrTime to [seconds, nanoseconds] tuple
     */
    private hrTimeToTuple;
    /**
     * Convert OTEL HrTime to milliseconds
     */
    private hrTimeToMillis;
}
/**
 * Create a debug span exporter for a given server
 */
export declare function createDebugSpanExporter(server: DebugVisualizerServer): DebugSpanExporter;
export {};
//# sourceMappingURL=debug-span-exporter.d.ts.map