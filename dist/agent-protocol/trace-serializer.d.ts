/**
 * Trace serializer for LLM evaluation prompts and CLI display.
 *
 * Supports multiple trace backends:
 * 1. Grafana Tempo (via Grafana datasource proxy or direct Tempo API)
 * 2. Jaeger (via Jaeger HTTP API)
 * 3. Local NDJSON files (Visor's file-span-exporter OTEL format)
 *
 * Auto-detects the backend from environment variables:
 * - OTEL_EXPORTER_OTLP_ENDPOINT + VISOR_TELEMETRY_SINK=otlp → probe Grafana/Jaeger
 * - VISOR_TRACE_BACKEND=grafana|jaeger|file (explicit override)
 * - GRAFANA_URL, GRAFANA_TEMPO_DATASOURCE_ID → Grafana Tempo
 * - JAEGER_URL → Jaeger
 * - Falls back to local file scan
 */
export interface TraceBackendConfig {
    type: 'grafana' | 'jaeger' | 'file' | 'auto';
    /** Grafana base URL, e.g. http://localhost:3000 */
    grafanaUrl?: string;
    /** Grafana Tempo datasource ID (default: auto-detect) */
    grafanaDatasourceId?: string | number;
    /** Jaeger base URL, e.g. http://localhost:16686 */
    jaegerUrl?: string;
    /** Local trace directory (default: output/traces) */
    traceDir?: string;
    /** Auth token for remote APIs */
    authToken?: string;
    /** Optional trace ID to filter mixed local NDJSON files down to a single trace */
    targetTraceId?: string;
}
type TraceBackendKind = Exclude<TraceBackendConfig['type'], 'auto'>;
export interface NormalizedSpan {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    startTimeMs: number;
    endTimeMs: number;
    durationMs: number;
    attributes: Record<string, string | number | boolean>;
    events: Array<{
        name: string;
        attributes: Record<string, string | number | boolean>;
    }>;
    status: 'ok' | 'error';
}
interface SpanTree {
    span: NormalizedSpan;
    children: SpanTree[];
}
export interface ResolvedTraceData {
    spans: NormalizedSpan[];
    source: TraceBackendKind | null;
    remoteTraceId?: string;
    localTracePath?: string;
}
export interface ProbeTaskSummaryItem {
    id: string;
    title: string;
    status: string;
    synthetic?: boolean;
}
export interface ProbeTaskScopeSummary {
    label: string;
    source: 'snapshot' | 'events';
    eventCount: number;
    snapshotCount: number;
    tasks: ProbeTaskSummaryItem[];
    children: ProbeTaskScopeSummary[];
}
export interface ProbeTaskSummary {
    tasksEnabled: boolean;
    source: 'snapshot' | 'events';
    eventCount: number;
    snapshotCount: number;
    tasks: ProbeTaskSummaryItem[];
    scopes: ProbeTaskScopeSummary[];
}
export interface TraceReport {
    traceData: ResolvedTraceData;
    tree: string;
    taskSummary: ProbeTaskSummary | null;
    headerText: string;
    text: string;
}
/**
 * Fetch trace spans by trace ID. Tries backends in order:
 * 1. Explicit backend (config.type)
 * 2. Grafana Tempo (auto-detect)
 * 3. Jaeger (auto-detect)
 * 4. Local NDJSON files
 */
export declare function fetchTraceSpans(traceRef: string, config?: Partial<TraceBackendConfig>): Promise<NormalizedSpan[]>;
export declare function resolveTraceSpans(traceIdOrPath: string, backendConfig?: Partial<TraceBackendConfig>, fallbackTraceId?: string): Promise<ResolvedTraceData>;
/**
 * Find the NDJSON trace file matching a given trace ID.
 * Scans the first line of each `.ndjson` file in the trace directory.
 */
export declare function findTraceFile(traceId: string, traceDir?: string): Promise<string | null>;
export declare function readTraceIdFromFile(traceFile: string): Promise<string | null>;
export interface RenderTreeOptions {
    maxDepth?: number;
    maxChars?: number;
    /** Fallback intent text for AI spans whose input is too truncated */
    fallbackIntent?: string;
    /** When true, don't truncate output/intent previews */
    fullOutput?: boolean;
    /** Final task response from the task store (full, not OTEL-truncated) */
    taskResponse?: string;
}
/**
 * Serialize a trace (by ID) into a compact text tree for LLM prompts.
 * Auto-detects the backend (Grafana Tempo, Jaeger, local files).
 */
export declare function serializeTraceForPrompt(traceIdOrPath: string, maxChars?: number, backendConfig?: Partial<TraceBackendConfig>, 
/** Final task response from the task store (not truncated by OTEL) */
taskResponse?: string, 
/** Trace ID to try remote backends first (preferred over local file) */
fallbackTraceId?: string): Promise<string>;
export declare function buildTraceHeaderLines(traceData: ResolvedTraceData, taskSummary: ProbeTaskSummary | null): string[];
export declare function buildTraceReport(traceIdOrPath: string, maxChars?: number, backendConfig?: Partial<TraceBackendConfig>, taskResponse?: string, fallbackTraceId?: string): Promise<TraceReport | null>;
export declare function extractProbeTaskSummary(spans: NormalizedSpan[]): ProbeTaskSummary | null;
/**
 * Render a span tree as a compact ASCII tree with durations and details.
 */
export declare function renderSpanTree(tree: SpanTree, opts?: RenderTreeOptions): string;
export declare function renderTraceTree(tree: any, // ExecutionNode from trace-reader
opts?: RenderTreeOptions): string;
/**
 * Render a span tree as YAML-like structured output.
 * More readable than ASCII tree for JSON inputs/outputs.
 */
export declare function renderSpanYaml(tree: SpanTree, allSpans: NormalizedSpan[], opts?: RenderTreeOptions): string;
export {};
//# sourceMappingURL=trace-serializer.d.ts.map