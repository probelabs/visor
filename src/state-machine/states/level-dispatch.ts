/**
 * LevelDispatch State Handler
 *
 * Responsibilities:
 * - Pop next topological level from queue
 * - Spawn tasks up to maxParallelism
 * - Handle session reuse barriers
 * - Support fail-fast
 * - Support debug pause
 * - Execute actual provider logic
 * - Transition back to WavePlanning or handle errors
 *
 * M2: Integrates actual provider execution and routing
 */

import type {
  EngineContext,
  RunState,
  EngineState,
  EngineEvent,
  DispatchRecord,
} from '../../types/engine';
import { logger } from '../../logger';
import type { ReviewSummary, ReviewIssue } from '../../reviewer';
import type { CheckExecutionStats } from '../../types/execution';
import type { CheckProviderConfig } from '../../providers/check-provider.interface';
import type { CheckConfig } from '../../types/config';
import { handleRouting, checkLoopBudget } from './routing';
import { withActiveSpan } from '../../telemetry/trace-helpers';
import { emitMermaidFromMarkdown } from '../../utils/mermaid-telemetry';
import { emitNdjsonSpanWithEvents, emitNdjsonFallback } from '../../telemetry/fallback-ndjson';
import { buildOutputHistoryFromJournal } from '../dispatch/history-snapshot';
import { renderTemplateContent } from '../dispatch/template-renderer';
import { updateStats, shouldFailFast, hasFatalIssues } from '../dispatch/stats-manager';
import {
  buildDependencyResultsWithScope,
  buildDependencyResults,
} from '../dispatch/dependency-gating';
import { executeCheckWithForEachItems } from '../dispatch/foreach-processor';
import { FailureConditionEvaluator } from '../../failure-condition-evaluator';
import { executeSingleCheck as invokeSingleCheck } from '../dispatch/execution-invoker';

/**
 * Map check name to focus for AI provider
 * This is a fallback when focus is not explicitly configured
 */
function mapCheckNameToFocus(checkName: string): string {
  const focusMap: Record<string, string> = {
    security: 'security',
    performance: 'performance',
    style: 'style',
    architecture: 'architecture',
  };

  return focusMap[checkName] || 'all';
}

// moved: buildOutputHistoryFromJournal → ../dispatch/history-snapshot

/**
 * Evaluate 'if' condition for a check
 *
 * Note: For routing loops to work correctly, 'outputs' should only include
 * results from the CURRENT wave, not from previous waves. This allows
 * checks to re-execute after routing (goto/on_fail/on_success) triggers.
 */
async function evaluateIfCondition(
  checkId: string,
  checkConfig: CheckConfig,
  context: EngineContext,
  state: RunState
): Promise<boolean> {
  const ifExpression = checkConfig.if;
  if (!ifExpression) {
    return true; // No condition means always run
  }

  try {
    const evaluator = new FailureConditionEvaluator();

    // Build previous results from CURRENT WAVE ONLY
    // This ensures that when routing creates a new wave via goto/on_fail,
    // the 'outputs' context is reset and checks can re-execute
    const previousResults = new Map<string, ReviewSummary>();

    // Check if we're tracking wave-specific completions
    const currentWaveCompletions = (state as any).currentWaveCompletions as Set<string> | undefined;

    if (currentWaveCompletions) {
      // Only include outputs from checks completed in the current wave
      for (const key of currentWaveCompletions) {
        try {
          const snapshotId = context.journal.beginSnapshot();
          const contextView = new (require('../../snapshot-store').ContextView)(
            context.journal,
            context.sessionId,
            snapshotId,
            [],
            context.event
          );
          const journalResult = contextView.get(key);
          if (journalResult) {
            previousResults.set(key, journalResult as ReviewSummary);
          }
        } catch {
          // Silently skip - will use empty result
        }
      }
    }
    // Fallback: if no wave tracking, use empty outputs (allows all checks to run)

    // Build context data for if condition evaluation
    // Create a snapshot of process.env to ensure current values are captured
    // This is critical for test stages that set environment variables dynamically
    const envSnapshot: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        envSnapshot[key] = value;
      }
    }

    // Merge config.env into environment (config.env takes precedence)
    if (context.config.env) {
      for (const [key, value] of Object.entries(context.config.env)) {
        if (value !== undefined && value !== null) {
          envSnapshot[key] = String(value);
        }
      }
    }

    const contextData = {
      previousResults,
      event: context.event || 'manual',
      branch: (context.prInfo as any)?.branch,
      baseBranch: (context.prInfo as any)?.baseBranch,
      filesChanged: context.prInfo?.files?.map(f => f.filename),
      environment: envSnapshot,
    };

    const shouldRun = await evaluator.evaluateIfCondition(checkId, ifExpression, contextData);
    return shouldRun;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to evaluate if expression for check '${checkId}': ${msg}`);
    // Fail-secure: if condition evaluation fails, skip execution
    return false;
  }
}

export async function handleLevelDispatch(
  context: EngineContext,
  state: RunState,
  transition: (newState: EngineState) => void,
  emitEvent: (event: EngineEvent) => void
): Promise<void> {
  // Pop next level from queue
  const level = state.levelQueue.shift();

  if (!level) {
    // No more levels - go back to wave planning
    if (context.debug) {
      logger.info('[LevelDispatch] No more levels in queue');
    }
    transition('WavePlanning');
    return;
  }

  if (context.debug) {
    logger.info(
      `[LevelDispatch] Executing level ${level.level} with ${level.parallel.length} checks`
    );
  }

  // Update current level tracking
  state.currentLevel = level.level;
  state.currentLevelChecks = new Set(level.parallel);

  // Emit level ready event
  emitEvent({ type: 'LevelReady', level, wave: state.wave });

  const maxParallelism = context.maxParallelism || 10;
  const results: Array<{ checkId: string; result: ReviewSummary; error?: Error }> = [];

  // Group checks by session provider to enforce session reuse barriers
  const sessionGroups = groupBySession(level.parallel, context);

  // Execute each session group sequentially, but checks within group in parallel
  for (const group of sessionGroups) {
    const groupResults = await executeCheckGroup(
      group,
      context,
      state,
      maxParallelism,
      emitEvent,
      transition
    );
    results.push(...groupResults);

    // Check fail-fast
    if (context.failFast && shouldFailFast(results)) {
      logger.warn('[LevelDispatch] Fail-fast triggered');
      state.flags.failFastTriggered = true;
      break;
    }
  }

  // Emit level depleted event
  emitEvent({ type: 'LevelDepleted', level: level.level, wave: state.wave });

  // Update stats - exclude only aggregated forEach results and explicit skip stubs
  // Previously skipped checks that now execute must be included so updateStats can
  // clear the skipped flag and count this run.
  const nonForEachResults = results.filter(r => {
    const rr: any = r.result as any;
    if (rr.isForEach) return false;
    if (rr.__skipped) return false;
    if (rr.__stats_applied) return false; // already accounted in invoker
    return true;
  });
  updateStats(nonForEachResults, state);

  // Check if fail-fast was triggered
  if (state.flags.failFastTriggered) {
    // Skip remaining levels
    state.levelQueue = [];
    if (context.debug) {
      logger.info('[LevelDispatch] Fail-fast triggered, clearing level queue');
    }
  }

  // Clear current level tracking
  state.currentLevelChecks.clear();

  // Transition back to WavePlanning
  transition('WavePlanning');
}

/**
 * Group checks by session provider to enforce sequential execution
 */
function groupBySession(checks: string[], context: EngineContext): string[][] {
  // M2: Group checks that share a session provider
  const sessionProviderMap = new Map<string, string[]>();
  const noSessionChecks: string[] = [];

  for (const checkId of checks) {
    const metadata = context.checks[checkId];
    const sessionProvider = metadata?.sessionProvider;

    if (sessionProvider) {
      const group = sessionProviderMap.get(sessionProvider) || [];
      group.push(checkId);
      sessionProviderMap.set(sessionProvider, group);
    } else {
      noSessionChecks.push(checkId);
    }
  }

  // Return groups: first all session groups (sequential), then independent checks
  const groups: string[][] = [];

  // Add session groups (each group runs sequentially relative to other session groups)
  for (const group of sessionProviderMap.values()) {
    groups.push(group);
  }

  // Add independent checks as one group (can run in parallel)
  if (noSessionChecks.length > 0) {
    groups.push(noSessionChecks);
  }

  return groups;
}

/**
 * Execute a group of checks in parallel (up to maxParallelism)
 */
async function executeCheckGroup(
  checks: string[],
  context: EngineContext,
  state: RunState,
  maxParallelism: number,
  emitEvent: (event: EngineEvent) => void,
  transition: (newState: EngineState) => void
): Promise<Array<{ checkId: string; result: ReviewSummary; error?: Error; duration?: number }>> {
  const results: Array<{
    checkId: string;
    result: ReviewSummary;
    error?: Error;
    duration?: number;
  }> = [];

  // Deduplicate checks within the same level to avoid double execution when
  // routing or OR-dependency expansion accidentally introduces duplicates.
  const seen = new Set<string>();
  const uniqueChecks: string[] = [];
  for (const id of checks) {
    if (!seen.has(id)) {
      seen.add(id);
      uniqueChecks.push(id);
    }
  }

  // Execute with limited parallelism
  const pool: Promise<void>[] = [];

  for (const checkId of uniqueChecks) {
    // If forward-run provided explicit per-item scopes, schedule one execution per scope
    const scopedRuns: Array<Array<{ check: string; index: number }>> =
      (state.pendingRunScopes && state.pendingRunScopes.get(checkId)) || [];
    // Guard: do not execute the same check more than once within a single wave
    try {
      const currentWaveCompletions = (state as any).currentWaveCompletions as
        | Set<string>
        | undefined;
      if (currentWaveCompletions && currentWaveCompletions.has(checkId)) {
        if (context.debug) {
          logger.info(`[LevelDispatch] Skipping ${checkId}: already completed in current wave`);
        }
        continue;
      }
    } catch {}

    // Wait if pool is full
    if (pool.length >= maxParallelism) {
      await Promise.race(pool);
      // Remove completed promises
      pool.splice(
        0,
        pool.length,
        ...pool.filter(p => {
          const settled = (p as any)._settled;
          return !settled;
        })
      );
    }

    const runOnce = async (scopeOverride?: Array<{ check: string; index: number }>) => {
      const startTime = Date.now();
      try {
        const result = await invokeSingleCheck(
          checkId,
          context,
          state,
          emitEvent,
          transition,
          evaluateIfCondition,
          scopeOverride
        );
        const duration = Date.now() - startTime;
        results.push({ checkId, result, duration });
      } catch (error) {
        const duration = Date.now() - startTime;
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error(`[LevelDispatch] Error executing check ${checkId}: ${err.message}`);
        results.push({ checkId, result: { issues: [] }, error: err, duration });
      }
    };

    // If we have explicit scopes, schedule one run per scope; otherwise run once (default scope)
    const promise = (async () => {
      if (scopedRuns.length > 0) {
        for (const sc of scopedRuns) {
          await runOnce(sc);
        }
        // Clear consumed scopes
        try {
          state.pendingRunScopes?.delete(checkId);
        } catch {}
      } else {
        await runOnce();
      }
    })();

    // Mark promise as settled when done
    promise
      .then(() => {
        (promise as any)._settled = true;
      })
      .catch(() => {
        (promise as any)._settled = true;
      });

    pool.push(promise);
  }

  // Wait for all remaining checks
  await Promise.all(pool);

  return results;
}

// moved: executeCheckWithForEachItems → ../dispatch/foreach-processor
/**
 * Execute a single check with provider integration
 */
// moved: executeSingleCheck → ../dispatch/execution-invoker

/**
 * Build dependency results for a check with scope
 */
/* moved to ../dispatch/dependency-gating */
// moved: buildDependencyResultsWithScope → ../dispatch/dependency-gating

/**
 * Build dependency results for a check
 */
// moved: buildDependencyResults → ../dispatch/dependency-gating

/**
 * Check if fail-fast should be triggered based on results
 */
// moved: shouldFailFast → ../dispatch/stats-manager

/**
 * Check if result has fatal issues (execution failures, not code quality issues)
 *
 * Fatal issues are those indicating the check itself failed to execute properly:
 * - ruleId ends with '/error' (system errors, exceptions)
 * - ruleId contains '/execution_error' (command failures)
 * - ruleId ends with '_fail_if' (fail_if condition triggered)
 *
 * Regular error/critical severity issues (e.g., security vulnerabilities found in code)
 * are NOT fatal - they represent successful execution that found issues.
 */
// moved: hasFatalIssues → ../dispatch/stats-manager

/**
 * Update execution stats
 */
// moved: updateStats → ../dispatch/stats-manager

// moved: renderTemplateContent → ../dispatch/template-renderer
