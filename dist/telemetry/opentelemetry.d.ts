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
export declare function shutdownTelemetry(): Promise<void>;
//# sourceMappingURL=opentelemetry.d.ts.map