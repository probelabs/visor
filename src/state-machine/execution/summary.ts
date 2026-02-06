import type { ReviewIssue, GroupedCheckResults, ReviewSummary } from '../../reviewer';
import type { ExecutionStatistics } from '../../types/execution';

/**
 * Pure helper to convert grouped results + statistics into a flat ReviewSummary.
 * Extracted to reduce StateMachineExecutionEngine size; behavior unchanged.
 */
export function convertToReviewSummary(
  groupedResults: GroupedCheckResults,
  statistics?: ExecutionStatistics
): ReviewSummary {
  const allIssues: ReviewIssue[] = [];

  // Aggregate issues from all check results
  for (const checkResults of Object.values(groupedResults)) {
    for (const checkResult of checkResults) {
      if (checkResult.issues && checkResult.issues.length > 0) {
        allIssues.push(...checkResult.issues);
      }
    }
  }

  // Convert errors from execution statistics into issues
  if (statistics) {
    for (const checkStats of statistics.checks) {
      if (checkStats.errorMessage) {
        allIssues.push({
          file: 'system',
          line: 0,
          endLine: undefined,
          ruleId: 'system/error',
          message: checkStats.errorMessage,
          severity: 'error',
          category: 'logic',
          suggestion: undefined,
          replacement: undefined,
        });
      }
    }
  }

  return {
    issues: allIssues,
  };
}
