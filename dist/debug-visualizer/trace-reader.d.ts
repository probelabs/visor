/**
 * Trace File Reader & Processor
 *
 * Reads OpenTelemetry NDJSON trace files and reconstructs execution tree structure
 * for the Debug Visualizer.
 *
 * Milestone 2: Trace File Reader
 */
/**
 * OTEL span event with attributes
 */
export interface SpanEvent {
    name: string;
    time: [number, number];
    timestamp?: string;
    attributes?: Record<string, any>;
}
/**
 * Processed OTEL span with clean structure
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
    events: SpanEvent[];
    status: 'ok' | 'error';
}
/**
 * Hierarchical execution tree node
 */
export interface ExecutionNode {
    checkId: string;
    type: string;
    status: 'pending' | 'running' | 'completed' | 'error' | 'skipped';
    children: ExecutionNode[];
    span: ProcessedSpan;
    state: {
        inputContext?: any;
        output?: any;
        errors?: string[];
        metadata?: Record<string, any>;
    };
}
/**
 * State snapshot for time-travel debugging
 */
export interface StateSnapshot {
    checkId: string;
    timestamp: string;
    timestampNanos: [number, number];
    outputs: Record<string, any>;
    memory: Record<string, any>;
}
/**
 * Timeline event for visualization
 */
export interface TimelineEvent {
    type: 'check.started' | 'check.completed' | 'check.failed' | 'state.snapshot' | 'event';
    checkId?: string;
    timestamp: string;
    timestampNanos: [number, number];
    duration?: number;
    status?: string;
    metadata?: Record<string, any>;
}
/**
 * Complete parsed execution trace
 */
export interface ExecutionTrace {
    runId: string;
    traceId: string;
    spans: ProcessedSpan[];
    tree: ExecutionNode;
    timeline: TimelineEvent[];
    snapshots: StateSnapshot[];
    metadata: {
        startTime: string;
        endTime: string;
        duration: number;
        totalSpans: number;
        totalSnapshots: number;
    };
}
/**
 * Parse NDJSON trace file and return structured execution trace
 *
 * @param filePath - Path to NDJSON trace file
 * @returns Parsed execution trace with tree, timeline, and snapshots
 */
export declare function parseNDJSONTrace(filePath: string): Promise<ExecutionTrace>;
/**
 * Build hierarchical execution tree from flat list of spans
 *
 * @param spans - List of processed spans
 * @returns Root execution node with children
 */
export declare function buildExecutionTree(spans: ProcessedSpan[]): ExecutionNode;
/**
 * Extract state snapshots from spans for time-travel debugging
 *
 * @param spans - List of processed spans
 * @returns Array of state snapshots sorted by timestamp
 */
export declare function extractStateSnapshots(spans: ProcessedSpan[]): StateSnapshot[];
/**
 * Compute chronological timeline of execution events
 *
 * @param spans - List of processed spans
 * @returns Array of timeline events sorted chronologically
 */
export declare function computeTimeline(spans: ProcessedSpan[]): TimelineEvent[];
//# sourceMappingURL=trace-reader.d.ts.map