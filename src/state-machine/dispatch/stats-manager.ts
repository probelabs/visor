import type { ReviewSummary } from '../../reviewer';
import type { RunState } from '../../types/engine';
import type { CheckExecutionStats } from '../../types/execution';

export function hasFatalIssues(result: ReviewSummary): boolean {
  if (!result.issues) return false;
  return result.issues.some(issue => {
    const ruleId = issue.ruleId || '';
    return (
      ruleId.endsWith('/error') ||
      ruleId.includes('/execution_error') ||
      ruleId.endsWith('_fail_if')
    );
  });
}

export function shouldFailFast(
  results: Array<{ checkId: string; result: ReviewSummary; error?: Error }>
): boolean {
  for (const { result } of results) {
    if (!result || !result.issues) continue;
    if (hasFatalIssues(result)) return true;
  }
  return false;
}

export function updateStats(
  results: Array<{ checkId: string; result: ReviewSummary; error?: Error; duration?: number }>,
  state: RunState,
  isForEachIteration: boolean = false
): void {
  for (const { checkId, result, error, duration } of results) {
    const existing = state.stats.get(checkId);

    const stats: CheckExecutionStats = existing || {
      checkName: checkId,
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
      skippedRuns: 0,
      skipped: false,
      totalDuration: 0,
      issuesFound: 0,
      issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
    };

    // Respect explicit skip markers on the result (set by LevelDispatch).
    const skippedMarker = (result as any).__skipped;
    if (skippedMarker) {
      stats.skipped = true;
      stats.skipReason =
        typeof skippedMarker === 'string'
          ? (skippedMarker as any)
          : (stats.skipReason as any) || 'if_condition';
      // A skipped result should not contribute to run counters; reset
      // them explicitly to guard against any prior values lingering
      // from earlier runs of the same check.
      stats.totalRuns = 0;
      stats.successfulRuns = 0;
      stats.failedRuns = 0;
      stats.skippedRuns++;
      // Do not count this as a run; keep totalRuns/failed/success unchanged.
      state.stats.set(checkId, stats);
      continue;
    }

    // If this check was previously marked as skipped and now executed,
    // clear the skipped flag and any skip counters to ensure the run is visible.
    if (stats.skipped) {
      stats.skipped = false;
      stats.skippedRuns = 0;
      (stats as any).skipReason = undefined;
      (stats as any).skipCondition = undefined;
    }

    stats.totalRuns++;
    if (typeof duration === 'number' && Number.isFinite(duration)) {
      stats.totalDuration += duration;
    }

    const hasExecutionFailure = !!error || hasFatalIssues(result);
    if (error) {
      stats.failedRuns++;
      // Note: do not set errorMessage; caller aggregates a single top-level issue.
    } else if (hasExecutionFailure) {
      stats.failedRuns++;
      // Marking complete failure for non-forEach
      // Per-iteration failures are handled in foreach path.
      if (!isForEachIteration) {
        (state as any).failedChecks = (state as any).failedChecks || new Set<string>();
        (state as any).failedChecks.add(checkId);
      }
    } else {
      stats.successfulRuns++;
    }

    if (result.issues) {
      stats.issuesFound += result.issues.length;
      for (const issue of result.issues) {
        if (issue.severity === 'critical') stats.issuesBySeverity.critical++;
        else if (issue.severity === 'error') stats.issuesBySeverity.error++;
        else if (issue.severity === 'warning') stats.issuesBySeverity.warning++;
        else if (issue.severity === 'info') stats.issuesBySeverity.info++;
      }
    }

    if (stats.outputsProduced === undefined) {
      const forEachItems = (result as any).forEachItems;
      if (Array.isArray(forEachItems)) stats.outputsProduced = forEachItems.length;
      else if ((result as any).output !== undefined) stats.outputsProduced = 1;
    }

    state.stats.set(checkId, stats);
  }
}
