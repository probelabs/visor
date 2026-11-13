import type { DebugVisualizerServer } from '../debug-visualizer/ws-server';
export interface TelemetryInitOptions {
    enabled?: boolean;
    sink?: 'otlp' | 'file' | 'console';
    otlp?: {
        endpoint?: string;
        headers?: string;
        protocol?: 'http' | 'grpc';
    };
    file?: {
        dir?: string;
        ndjson?: boolean;
        runId?: string;
    };
    ciAlwaysOn?: boolean;
    patchConsole?: boolean;
    autoInstrument?: boolean;
    traceReport?: boolean;
    debugServer?: DebugVisualizerServer;
}
/**
 * Reset telemetry state (for testing only).
 * This forcefully resets the SDK singleton.
 */
export declare function resetTelemetryForTesting(): void;
export declare function initTelemetry(opts?: TelemetryInitOptions): Promise<void>;
/**
 * Returns the OTel LoggerProvider if logs export is enabled, or null.
 * Used by the Visor logger to bridge log records to the OTel pipeline.
 */
export declare function getOtelLoggerProvider(): any;
/**
 * Force-flush all pending spans without shutting down the SDK.
 * Call after ending critical spans (e.g. visor.run) in long-running
 * processes to ensure they are exported before the next batch interval.
 */
export declare function forceFlushTelemetry(): Promise<void>;
/**
 * Best-effort non-blocking flush for lifecycle/helper spans.
 * Rate-limited to avoid exporter pressure in long-running processes.
 */
export declare function requestThrottledTelemetryFlush(): void;
export declare function shutdownTelemetry(): Promise<void>;
//# sourceMappingURL=opentelemetry.d.ts.map