export declare function recordCheckDuration(check: string, durationMs: number, group?: string): void;
export declare function recordProviderDuration(check: string, providerType: string, durationMs: number): void;
export declare function recordForEachDuration(check: string, index: number, total: number, durationMs: number): void;
export declare function addIssues(check: string, severity: string, count?: number): void;
export declare function incActiveCheck(check: string): void;
export declare function decActiveCheck(check: string): void;
export declare function addFailIfTriggered(check: string, scope: 'global' | 'check'): void;
export declare function addDiagramBlock(origin: 'content' | 'issue'): void;
/**
 * Record a visor run start. Call this when a visor.run span begins.
 * Attributes allow Grafana dashboards to break down by source, user, and workflow.
 */
export declare function recordRunStart(attrs: {
    source?: string;
    userId?: string;
    userName?: string;
    workflowId?: string;
    instanceId?: string;
}): void;
/**
 * Record visor run duration on completion.
 */
export declare function recordRunDuration(durationMs: number, attrs: {
    source?: string;
    userId?: string;
    workflowId?: string;
    success?: boolean;
}): void;
/**
 * Record an AI provider call. Call this every time an AI model is invoked.
 */
export declare function recordAiCall(attrs: {
    checkId?: string;
    model?: string;
    source?: string;
}): void;
/**
 * Reset the per-run AI call counter. Call at the start of a visor run.
 */
export declare function resetRunAiCalls(): void;
/**
 * Record the per-run AI call count as a histogram observation. Call at run end.
 */
export declare function recordRunAiCalls(attrs: {
    source?: string;
    workflowId?: string;
}): void;
/**
 * Get the current per-run AI call count.
 */
export declare function getRunAiCalls(): number;
export declare function getTestMetricsSnapshot(): {
    [k: string]: number;
};
export declare function resetTestMetricsSnapshot(): void;
//# sourceMappingURL=metrics.d.ts.map