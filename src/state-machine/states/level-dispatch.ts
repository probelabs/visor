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
    if ((r.result as any).isForEach) return false;
    if ((r.result as any).__skipped) return false;
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
        const result = await executeSingleCheck(
          checkId,
          context,
          state,
          emitEvent,
          transition,
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
async function executeSingleCheck(
  checkId: string,
  context: EngineContext,
  state: RunState,
  emitEvent: (event: EngineEvent) => void,
  transition: (newState: EngineState) => void,
  scopeOverride?: Array<{ check: string; index: number }>
): Promise<ReviewSummary> {
  // Check if this check depends on a forEach parent
  const checkConfig = context.config.checks?.[checkId];

  // Evaluate 'if' condition before execution
  if (checkConfig?.if) {
    const shouldRun = await evaluateIfCondition(checkId, checkConfig, context, state);

    if (!shouldRun) {
      // Log skip message at info level (visible without debug mode)
      // Message format intentionally omits check name to satisfy e2e expectations.
      logger.info(
        `⏭  Skipped (if: ${checkConfig.if.substring(0, 40)}${checkConfig.if.length > 40 ? '...' : ''})`
      );

      // Return empty result and mark as completed (tag as internal-skip for stats filtering)
      const emptyResult: ReviewSummary = { issues: [] };
      try {
        Object.defineProperty(emptyResult as any, '__skipped', {
          value: 'if_condition',
          enumerable: false,
        });
      } catch {}

      state.completedChecks.add(checkId);

      // Track skip statistics
      const stats: CheckExecutionStats = {
        checkName: checkId,
        totalRuns: 0,
        successfulRuns: 0,
        failedRuns: 0,
        skippedRuns: 0,
        skipped: true,
        skipReason: 'if_condition',
        skipCondition: checkConfig.if,
        totalDuration: 0,
        issuesFound: 0,
        issuesBySeverity: {
          critical: 0,
          error: 0,
          warning: 0,
          info: 0,
        },
      };
      state.stats.set(checkId, stats);
      logger.info(`[LevelDispatch] Recorded skip stats for ${checkId}: skipReason=if_condition`);

      // Store empty result in journal
      try {
        context.journal.commitEntry({
          sessionId: context.sessionId,
          checkId,
          result: emptyResult as any,
          event: context.event || 'manual',
          scope: [],
        });
      } catch (error) {
        logger.warn(`[LevelDispatch] Failed to commit skipped result to journal: ${error}`);
      }

      // Emit completed event
      emitEvent({
        type: 'CheckCompleted',
        checkId,
        scope: [],
        result: emptyResult,
      });

      return emptyResult;
    }
  }

  const dependencies = checkConfig?.depends_on || [];
  const depList = Array.isArray(dependencies) ? dependencies : [dependencies];

  // Dependency gating with continue_on_failure and OR groups ("A|B")
  const failedChecks = (state as any).failedChecks as Set<string> | undefined;
  const tokens = depList.filter(Boolean) as string[];
  const groupSatisfied = (token: string): boolean => {
    const options = token.includes('|')
      ? token
          .split('|')
          .map(s => s.trim())
          .filter(Boolean)
      : [token];
    for (const opt of options) {
      const depCfg: any = context.config.checks?.[opt];
      const cont = !!(depCfg && depCfg.continue_on_failure === true);
      const st = state.stats.get(opt);
      const wasMarkedFailed = !!(failedChecks && failedChecks.has(opt));
      const skipped = !!(st && (st as any).skipped === true);
      const failedOnly = !!(st && (st.failedRuns || 0) > 0 && (st.successfulRuns || 0) === 0);
      const satisfied = !skipped && ((!failedOnly && !wasMarkedFailed) || cont);
      if (satisfied) return true;
    }
    return false;
  };

  if (tokens.length > 0) {
    let allOk = true;
    for (const t of tokens) {
      if (!groupSatisfied(t)) {
        allOk = false;
        break;
      }
    }
    if (!allOk) {
      const emptyResult: ReviewSummary = { issues: [] };
      try {
        Object.defineProperty(emptyResult as any, '__skipped', {
          value: 'dependency_failed',
          enumerable: false,
        });
      } catch {}
      state.completedChecks.add(checkId);
      if (!(state as any).failedChecks) (state as any).failedChecks = new Set<string>();
      (state as any).failedChecks.add(checkId);
      const stats: CheckExecutionStats = {
        checkName: checkId,
        totalRuns: 0,
        successfulRuns: 0,
        failedRuns: 0,
        skippedRuns: 0,
        skipped: true,
        skipReason: 'dependency_failed',
        totalDuration: 0,
        issuesFound: 0,
        issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
      };
      state.stats.set(checkId, stats);
      try {
        context.journal.commitEntry({
          sessionId: context.sessionId,
          checkId,
          result: emptyResult as any,
          event: context.event || 'manual',
          scope: [],
        });
      } catch (error) {
        logger.warn(`[LevelDispatch] Failed to commit empty result to journal: ${error}`);
      }
      emitEvent({ type: 'CheckCompleted', checkId, scope: [], result: emptyResult });
      return emptyResult;
    }
  }

  let forEachParent: string | undefined;
  let forEachItems: unknown[] | undefined;

  // Find if any dependency is a forEach parent with items
  for (const depId of depList) {
    if (!depId) continue;

    try {
      const snapshotId = context.journal.beginSnapshot();
      const contextView = new (require('../../snapshot-store').ContextView)(
        context.journal,
        context.sessionId,
        snapshotId,
        [],
        context.event
      );
      const depResult: any = contextView.get(depId);

      if (context.debug) {
        logger.info(
          `[LevelDispatch] Checking dependency ${depId} for ${checkId}: has forEachItems=${!!depResult?.forEachItems}, isArray=${Array.isArray(depResult?.forEachItems)}`
        );
        if (depResult?.forEachItems) {
          logger.info(
            `[LevelDispatch] forEachItems length: ${depResult.forEachItems.length}, items: ${JSON.stringify(depResult.forEachItems).substring(0, 200)}`
          );
        }
      }

      if (depResult?.forEachItems && Array.isArray(depResult.forEachItems)) {
        forEachParent = depId;
        forEachItems = depResult.forEachItems;
        if (context.debug && forEachItems) {
          logger.info(
            `[LevelDispatch] Detected forEach parent ${depId} with ${forEachItems.length} items for check ${checkId}`
          );
        }
        break;
      }
    } catch (error) {
      if (context.debug) {
        logger.warn(`[LevelDispatch] Error checking forEach parent ${depId}: ${error}`);
      }
    }
  }

  // If there's a forEach parent, decide fanout behavior:
  // - fanout: 'map'  => run once per item
  // - fanout: 'reduce' (default) => run once at parent scope
  if (forEachParent && forEachItems !== undefined) {
    // Determine fanout mode
    let fanoutMode: 'map' | 'reduce' = 'reduce';
    const explicit = (checkConfig as any)?.fanout as 'map' | 'reduce' | undefined;
    if (explicit === 'map' || explicit === 'reduce') {
      fanoutMode = explicit;
    } else {
      // Heuristic default: most providers (command, ai, http, etc.) map per item.
      // Aggregator-style providers (log, memory, script, workflow/noop) default to reduce.
      const providerType = context.checks[checkId]?.providerType || '';
      const reduceProviders = new Set(['log', 'memory', 'script', 'workflow', 'noop']);
      fanoutMode = reduceProviders.has(providerType) ? 'reduce' : 'map';
    }
    if (fanoutMode === 'map') {
      // Per-item execution
      if (forEachItems.length === 0) {
        // forEach parent has zero items - skip this check entirely
        // Log skip message at info level (visible without debug mode)
        logger.info(`⏭  Skipped (forEach parent "${forEachParent}" has 0 items)`);

        if (context.debug) {
          logger.info(
            `[LevelDispatch] Skipping check ${checkId}: forEach parent ${forEachParent} has zero items`
          );
        }

        // Return empty result
        const emptyResult: ReviewSummary = { issues: [] };
        try {
          Object.defineProperty(emptyResult as any, '__skipped', {
            value: 'forEach_empty',
            enumerable: false,
          });
        } catch {}

        // Mark as completed
        state.completedChecks.add(checkId);

        // Mark this check as failed so downstream dependencies also skip
        // This enables cascade skipping when a forEach parent has no items
        if (!(state as any).failedChecks) {
          (state as any).failedChecks = new Set<string>();
        }
        (state as any).failedChecks.add(checkId);

        // Determine skip reason: if the parent failed, prefer dependency_failed over forEach_empty
        let derivedSkipReason: 'forEach_empty' | 'dependency_failed' = 'forEach_empty';
        try {
          const parentFailed =
            !!((state as any).failedChecks && (state as any).failedChecks.has(forEachParent)) ||
            (() => {
              const s = state.stats.get(forEachParent);
              return !!(s && (s.failedRuns || 0) > 0);
            })();
          if (parentFailed) derivedSkipReason = 'dependency_failed';
        } catch {}

        // Update stats to record skip
        const stats: CheckExecutionStats = {
          checkName: checkId,
          totalRuns: 0,
          successfulRuns: 0,
          failedRuns: 0,
          skippedRuns: 0,
          skipped: true,
          skipReason: derivedSkipReason,
          totalDuration: 0,
          issuesFound: 0,
          issuesBySeverity: {
            critical: 0,
            error: 0,
            warning: 0,
            info: 0,
          },
        };
        state.stats.set(checkId, stats);

        // Store empty result in journal
        try {
          context.journal.commitEntry({
            sessionId: context.sessionId,
            checkId,
            result: emptyResult as any,
            event: context.event || 'manual',
            scope: [],
          });
        } catch (error) {
          logger.warn(`[LevelDispatch] Failed to commit empty result to journal: ${error}`);
        }

        // Emit completed event
        emitEvent({
          type: 'CheckCompleted',
          checkId,
          scope: [],
          result: emptyResult,
        });

        return emptyResult;
      }

      return await executeCheckWithForEachItems(
        checkId,
        forEachParent,
        forEachItems,
        context,
        state,
        emitEvent,
        transition
      );
    }
    // fanout reduce: fall through to normal single execution below
  }

  // Normal execution without forEach
  const scope: Array<{ check: string; index: number }> = scopeOverride || [];

  // Emit scheduled event
  emitEvent({ type: 'CheckScheduled', checkId, scope });

  // Track start time for duration calculation
  const startTime = Date.now();

  // Create dispatch record
  const dispatch: DispatchRecord = {
    id: `${checkId}-${Date.now()}`,
    checkId,
    scope,
    provider: context.checks[checkId]?.providerType || 'unknown',
    startMs: startTime,
    attempts: 1,
  };

  state.activeDispatches.set(checkId, dispatch);

  try {
    // Get check configuration
    const checkConfig = context.config.checks?.[checkId];
    if (!checkConfig) {
      throw new Error(`Check configuration not found: ${checkId}`);
    }

    // Get provider
    const providerType = checkConfig.type || 'ai';
    const providerRegistry =
      require('../../providers/check-provider-registry').CheckProviderRegistry.getInstance();
    const provider = providerRegistry.getProviderOrThrow(providerType);

    // Build output history for template rendering
    const outputHistory = buildOutputHistoryFromJournal(context);

    // Build provider configuration
    const providerConfig: CheckProviderConfig = {
      type: providerType,
      checkName: checkId,
      prompt: checkConfig.prompt,
      exec: checkConfig.exec,
      schema: checkConfig.schema,
      group: checkConfig.group,
      focus: checkConfig.focus || mapCheckNameToFocus(checkId),
      transform: checkConfig.transform,
      transform_js: checkConfig.transform_js,
      env: checkConfig.env,
      forEach: checkConfig.forEach,
      ...checkConfig,
      eventContext: (context.prInfo as any)?.eventContext || {},
      __outputHistory: outputHistory,
      ai: {
        ...(checkConfig.ai || {}),
        timeout: checkConfig.ai?.timeout || 600000,
        debug: !!context.debug,
      },
    };

    // Build dependency results
    const dependencyResults = buildDependencyResults(checkId, checkConfig, context, state);

    // Build PR info (use real prInfo from context if available, otherwise use defaults)
    const prInfo: any = context.prInfo || {
      number: 1,
      title: 'State Machine Execution',
      author: 'system',
      eventType: context.event || 'manual',
      eventContext: {},
      files: [],
      commits: [],
    };

    // Build execution context with engine mode and parent context (M3: nested workflows)
    const executionContext = {
      ...context.executionContext,
      _engineMode: context.mode,
      _parentContext: context,
      _parentState: state,
    };

    // Emit provider telemetry
    try {
      emitNdjsonFallback('visor.provider', {
        'visor.check.id': checkId,
        'visor.provider.type': providerType,
      });
    } catch {}

    // Execute provider with telemetry
    const result = await withActiveSpan(
      `visor.check.${checkId}`,
      { 'visor.check.id': checkId, 'visor.check.type': providerType },
      async () => provider.execute(prInfo, providerConfig, dependencyResults, executionContext)
    );

    // Enrich issues with metadata
    const enrichedIssues = (result.issues || []).map((issue: ReviewIssue) => ({
      ...issue,
      checkName: checkId,
      ruleId: `${checkId}/${issue.ruleId || 'unknown'}`,
      group: checkConfig.group,
      schema: typeof checkConfig.schema === 'object' ? 'custom' : checkConfig.schema,
      template: checkConfig.template,
      timestamp: Date.now(),
    }));

    const enrichedResult: any = {
      ...result,
      issues: enrichedIssues,
    };

    // Handle forEach: true checks - convert output array to forEachItems
    let isForEach = (result as any).isForEach;
    let forEachItems = (result as any).forEachItems;

    // DEBUG: Log forEach handling
    logger.info(
      `[LevelDispatch][DEBUG] After execution ${checkId}: checkConfig.forEach=${checkConfig.forEach}, output type=${typeof (result as any).output}, isArray=${Array.isArray((result as any).output)}`
    );

    if (checkConfig.forEach === true) {
      const output = (result as any).output;
      logger.info(
        `[LevelDispatch][DEBUG] Processing forEach=true for ${checkId}, output=${JSON.stringify(output)?.substring(0, 200)}`
      );

      // Validate forEach output (must not be undefined)
      if (output === undefined) {
        logger.error(`[LevelDispatch] forEach check "${checkId}" produced undefined output`);
        const undefinedError: ReviewIssue = {
          file: 'system',
          line: 0,
          // Mark as execution failure so dependents treat this as failed dependency
          ruleId: 'forEach/execution_error',
          message: `forEach check "${checkId}" produced undefined output. Verify your command outputs valid data and your transform_js returns a value.`,
          severity: 'error',
          category: 'logic',
        };
        enrichedResult.issues = [...(enrichedResult.issues || []), undefinedError];
        // Mark as forEach with empty items to skip dependent iterations
        isForEach = true;
        forEachItems = [];
        enrichedResult.isForEach = true;
        enrichedResult.forEachItems = [];
        // Also mark this check as failed so downstream dependents skip with dependency_failed
        try {
          if (!(state as any).failedChecks) {
            (state as any).failedChecks = new Set<string>();
          }
          (state as any).failedChecks.add(checkId);
        } catch {}
      } else if (Array.isArray(output)) {
        isForEach = true;
        forEachItems = output;
        enrichedResult.isForEach = true;
        enrichedResult.forEachItems = output;

        // Log forEach items count (always log, not just in debug mode)
        logger.info(`  Found ${output.length} items for forEach iteration`);

        if (context.debug) {
          logger.info(
            `[LevelDispatch] Check ${checkId} is forEach parent with ${output.length} items`
          );
        }
      } else {
        // forEach check but output is not an array - convert to single-item array
        if (context.debug) {
          logger.warn(
            `[LevelDispatch] Check ${checkId} has forEach:true but output is not an array: ${typeof output}, converting to single-item array`
          );
        }
        isForEach = true;
        forEachItems = [output];
        enrichedResult.isForEach = true;
        enrichedResult.forEachItems = [output];
      }
    }

    // Also preserve forEach metadata if already present (from provider)
    if ((result as any).isForEach) {
      enrichedResult.isForEach = true;
    }
    if ((result as any).forEachItems) {
      enrichedResult.forEachItems = (result as any).forEachItems;
    }
    if ((result as any).forEachItemResults) {
      enrichedResult.forEachItemResults = (result as any).forEachItemResults;
    }
    if ((result as any).forEachFatalMask) {
      enrichedResult.forEachFatalMask = (result as any).forEachFatalMask;
    }

    // Render template content and emit Mermaid diagrams
    let renderedContent: string | undefined;
    try {
      renderedContent = await renderTemplateContent(checkId, checkConfig, enrichedResult);
      if (renderedContent) {
        // Emit Mermaid diagram events from the rendered content
        emitMermaidFromMarkdown(checkId, renderedContent, 'content');
      }
    } catch (error) {
      logger.warn(`[LevelDispatch] Failed to render template for ${checkId}: ${error}`);
    }

    // Generate default content from issues if no template content was rendered
    if (!renderedContent && enrichedIssues.length > 0) {
      renderedContent = enrichedIssues
        .map(
          (i: ReviewIssue) =>
            `- **${i.severity.toUpperCase()}**: ${i.message} (${i.file}:${i.line})`
        )
        .join('\n');
    }

    // Add timestamp to output if it exists and is an object
    // For primitive outputs (number, string, boolean), preserve them as-is
    let outputWithTimestamp: any = undefined;
    if ((result as any).output !== undefined) {
      const output = (result as any).output;
      if (output !== null && typeof output === 'object' && !Array.isArray(output)) {
        // Only add timestamp to plain objects
        outputWithTimestamp = { ...output, ts: Date.now() };
      } else {
        // Preserve primitives, arrays, and null as-is
        outputWithTimestamp = output;
      }
    }

    // Add rendered content to the result
    const enrichedResultWithContent = renderedContent
      ? { ...enrichedResult, content: renderedContent }
      : enrichedResult;

    const enrichedResultWithTimestamp =
      outputWithTimestamp !== undefined
        ? { ...enrichedResultWithContent, output: outputWithTimestamp }
        : enrichedResultWithContent;

    // Record completion BEFORE routing (so routing can see it as completed)
    state.completedChecks.add(checkId);

    // Track wave-specific completion for 'if' condition evaluation
    const currentWaveCompletions = (state as any).currentWaveCompletions as Set<string> | undefined;
    if (currentWaveCompletions) {
      currentWaveCompletions.add(checkId);
    }

    // Process routing (fail_if, on_success, on_fail) BEFORE storing in journal
    // This allows routing errors to be included in the stored result
    try {
      logger.info(`[LevelDispatch] Calling handleRouting for ${checkId}`);
    } catch {}
    await handleRouting(context, state, transition, emitEvent, {
      checkId,
      scope,
      result: enrichedResult,
      checkConfig: checkConfig as CheckConfig,
      success: !hasFatalIssues(enrichedResult),
    });

    // NOW store in journal with routing-side mutations included (e.g., fail_if issues)
    // Rebuild the commit payload from the possibly mutated enrichedResult so new issues are captured.
    try {
      const commitResult: any = {
        ...enrichedResult,
        ...(renderedContent ? { content: renderedContent } : {}),
        ...((result as any).output !== undefined
          ? outputWithTimestamp !== undefined
            ? { output: outputWithTimestamp }
            : { output: (result as any).output }
          : {}),
      };

      context.journal.commitEntry({
        sessionId: context.sessionId,
        checkId,
        result: commitResult,
        event: context.event || 'manual',
        scope,
      });
    } catch (error) {
      logger.warn(`[LevelDispatch] Failed to commit to journal: ${error}`);
    }

    // For forEach parent checks (this check produced forEachItems), record a single aggregated run in stats
    if (isForEach) {
      try {
        const existing = state.stats.get(checkId);
        const aggStats: CheckExecutionStats = existing || {
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
        aggStats.totalRuns++;
        const hasFatal = hasFatalIssues(enrichedResultWithTimestamp as any);
        if (hasFatal) aggStats.failedRuns++;
        else aggStats.successfulRuns++;
        // outputsProduced for parent equals number of items
        const items = (enrichedResultWithTimestamp as any).forEachItems;
        if (Array.isArray(items)) aggStats.outputsProduced = items.length;
        state.stats.set(checkId, aggStats);
      } catch {}
    }

    // If this is a forEach check, also commit per-item results
    if (isForEach && forEachItems && Array.isArray(forEachItems)) {
      for (let itemIndex = 0; itemIndex < forEachItems.length; itemIndex++) {
        const itemScope: Array<{ check: string; index: number }> = [
          { check: checkId, index: itemIndex },
        ];
        const item = forEachItems[itemIndex];

        try {
          context.journal.commitEntry({
            sessionId: context.sessionId,
            checkId,
            result: { issues: [], output: item } as any,
            event: context.event || 'manual',
            scope: itemScope,
          });
        } catch (error) {
          logger.warn(
            `[LevelDispatch] Failed to commit per-item journal for ${checkId} item ${itemIndex}: ${error}`
          );
        }
      }
    }

    state.activeDispatches.delete(checkId);

    // Emit completed event with full result (including routing errors)
    emitEvent({
      type: 'CheckCompleted',
      checkId,
      scope,
      result: {
        ...enrichedResult,
        output: (result as any).output,
        content: renderedContent || (result as any).content,
      },
    });

    return enrichedResult;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(`[LevelDispatch] Error executing check ${checkId}: ${err.message}`);

    state.activeDispatches.delete(checkId);

    // Emit error event
    emitEvent({
      type: 'CheckErrored',
      checkId,
      scope,
      error: {
        message: err.message,
        stack: err.stack,
        name: err.name,
      },
    });
    // Re-throw so the caller records the failure in statistics and surfaces
    // a single top-level system/error issue via statistics aggregation.
    throw err;
  }
}

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
