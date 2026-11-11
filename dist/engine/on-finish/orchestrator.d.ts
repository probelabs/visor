import type { PRInfo } from '../../pr-analyzer';
import type { ReviewSummary } from '../../reviewer';
import type { VisorConfig, CheckConfig } from '../../types/config';
type RunCheckFn = (id: string) => Promise<ReviewSummary>;
export declare function runOnFinishChildren(runIds: string[], runCheck: RunCheckFn, config: VisorConfig, onFinishContext: any, debug: boolean, log: (msg: string) => void): Promise<{
    lastRunOutput?: unknown;
}>;
export declare function decideRouting(checkName: string, checkConfig: CheckConfig, outputsForContext: Record<string, unknown>, outputsHistoryForContext: Record<string, unknown[]>, forEachStats: {
    items: unknown[];
}, prInfo: PRInfo, config: VisorConfig, debug: boolean, log: (msg: string) => void): {
    gotoTarget: string | null;
};
export declare function projectOutputs(results: Map<string, ReviewSummary>, historySnapshot: Record<string, unknown[]>): {
    outputsForContext: Record<string, unknown>;
    outputsHistoryForContext: Record<string, unknown[]>;
};
export declare function computeAllValid(history: Record<string, unknown[]>, itemsCount: number): boolean | undefined;
export {};
//# sourceMappingURL=orchestrator.d.ts.map