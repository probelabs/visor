export interface TaskTraceMetadata {
    trace_id?: string;
    trace_file?: string;
}
export interface ResolvedTaskTrace {
    traceId?: string;
    traceFile?: string;
    primaryRef?: string;
}
export declare function resolveTaskTraceReference(metadata?: TaskTraceMetadata | null): Promise<ResolvedTaskTrace>;
//# sourceMappingURL=task-trace-resolution.d.ts.map