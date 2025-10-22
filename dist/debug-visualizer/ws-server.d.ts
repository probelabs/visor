/**
 * HTTP Server for Live Debug Visualization
 *
 * Provides HTTP endpoints for polling OpenTelemetry spans,
 * enabling live visualization of visor execution via simple HTTP requests.
 *
 * Milestone 4: Live Streaming Server (Updated to HTTP polling)
 */
export interface ProcessedSpan {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    startTime: [number, number];
    endTime: [number, number];
    duration: number;
    attributes: Record<string, any>;
    events: Array<{
        name: string;
        time: [number, number];
        timestamp?: string;
        attributes?: Record<string, any>;
    }>;
    status: 'ok' | 'error';
}
/**
 * HTTP server for polling OTEL spans to debug visualizer UI
 */
export declare class DebugVisualizerServer {
    private httpServer;
    private port;
    private isRunning;
    private config;
    private spans;
    private results;
    private startExecutionPromise;
    private startExecutionResolver;
    private startExecutionTimeout;
    private executionState;
    private pausePromise;
    private pauseResolver;
    /**
     * Start the HTTP server
     */
    start(port?: number): Promise<void>;
    /**
     * Stop the HTTP server
     */
    stop(): Promise<void>;
    /**
     * Wait for the user to click "Start Execution" in the UI
     */
    waitForStartSignal(): Promise<void>;
    /**
     * Clear spans for a new run (but keep server alive)
     */
    clearSpans(): void;
    /**
     * Store a span for HTTP polling clients
     */
    emitSpan(span: ProcessedSpan): void;
    /**
     * Set the configuration to be sent to clients
     */
    setConfig(config: any): void;
    /**
     * Set the execution results to be sent to clients
     */
    setResults(results: any): void;
    /**
     * Handle HTTP requests (serve UI and API endpoints)
     */
    private handleHttpRequest;
    /**
     * Serve the UI HTML file
     */
    private serveUI;
    /**
     * Check if server is running
     */
    isServerRunning(): boolean;
    /**
     * Get server port
     */
    getPort(): number;
    /**
     * Get span count
     */
    getSpanCount(): number;
    /** Return current execution state */
    getExecutionState(): 'idle' | 'running' | 'paused' | 'stopped';
    /** Await while paused; returns immediately if not paused */
    waitWhilePaused(): Promise<void>;
}
/**
 * Create and start a debug visualizer server
 */
export declare function startDebugServer(port?: number): Promise<DebugVisualizerServer>;
//# sourceMappingURL=ws-server.d.ts.map