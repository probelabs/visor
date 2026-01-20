import type { ReviewSummary } from '../../reviewer';
import type { RunState } from '../../types/engine';
export declare function hasFatalIssues(result: ReviewSummary): boolean;
export declare function shouldFailFast(results: Array<{
    checkId: string;
    result: ReviewSummary;
    error?: Error;
}>): boolean;
export declare function updateStats(results: Array<{
    checkId: string;
    result: ReviewSummary;
    error?: Error;
    duration?: number;
}>, state: RunState, isForEachIteration?: boolean): void;
//# sourceMappingURL=stats-manager.d.ts.map