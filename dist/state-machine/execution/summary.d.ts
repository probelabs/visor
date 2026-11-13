import type { GroupedCheckResults, ReviewSummary } from '../../reviewer';
import type { ExecutionStatistics } from '../../types/execution';
/**
 * Pure helper to convert grouped results + statistics into a flat ReviewSummary.
 * Extracted to reduce StateMachineExecutionEngine size; behavior unchanged.
 */
export declare function convertToReviewSummary(groupedResults: GroupedCheckResults, statistics?: ExecutionStatistics): ReviewSummary;
//# sourceMappingURL=summary.d.ts.map