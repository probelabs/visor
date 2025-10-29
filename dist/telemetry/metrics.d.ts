export declare function recordCheckDuration(check: string, durationMs: number, group?: string): void;
export declare function recordProviderDuration(check: string, providerType: string, durationMs: number): void;
export declare function recordForEachDuration(check: string, index: number, total: number, durationMs: number): void;
export declare function addIssues(check: string, severity: string, count?: number): void;
export declare function incActiveCheck(check: string): void;
export declare function decActiveCheck(check: string): void;
export declare function addFailIfTriggered(check: string, scope: 'global' | 'check'): void;
export declare function addDiagramBlock(origin: 'content' | 'issue'): void;
export declare function getTestMetricsSnapshot(): {
    [k: string]: number;
};
export declare function resetTestMetricsSnapshot(): void;
//# sourceMappingURL=metrics.d.ts.map