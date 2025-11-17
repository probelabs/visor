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
import { Liquid } from 'liquidjs';
import { emitNdjsonSpanWithEvents, emitNdjsonFallback } from '../../telemetry/fallback-ndjson';
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

/**
 * Build output history Map from journal for template rendering
 * This matches the format expected by AI providers
 */
function buildOutputHistoryFromJournal(context: EngineContext): Map<string, unknown[]> {
  const outputHistory = new Map<string, unknown[]>();

  try {
    const snapshot = context.journal.beginSnapshot();
    const allEntries = context.journal.readVisible(context.sessionId, snapshot, undefined);

    // Group by checkId and extract outputs
    for (const entry of allEntries) {
      const checkId = entry.checkId;
      if (!outputHistory.has(checkId)) {
        outputHistory.set(checkId, []);
      }
      // Push the output if it exists
      if (entry.result.output !== undefined) {
        outputHistory.get(checkId)!.push(entry.result.output);
      }
    }
  } catch (error) {
    // Silently fail - return empty map
    logger.debug(`[LevelDispatch] Error building output history: ${error}`);
  }

  return outputHistory;
}

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

/**
 * Execute a check multiple times for forEach items
 */
async function executeCheckWithForEachItems(
  checkId: string,
  forEachParent: string,
  forEachItems: unknown[],
  context: EngineContext,
  state: RunState,
  emitEvent: (event: EngineEvent) => void,
  transition: (newState: EngineState) => void
): Promise<ReviewSummary> {
  // Tactical correctness fix: re-read the parent's aggregated forEachItems
  // from a fresh journal snapshot to avoid stale items during goto/on_finish
  // retries. Prefer the shallowest (root-scope) entry via getRaw().
  try {
    const snapId = context.journal.beginSnapshot();
    // Read latest aggregated (root-scope) parent entry directly from journal.
    // ContextView.getRaw() returns the shallowest entry but not necessarily the latest;
    // here we explicitly pick the last committed root-scope entry for correctness.
    const visible = context.journal.readVisible(context.sessionId, snapId, context.event as any);
    let latestItems: unknown[] | undefined;
    for (let i = visible.length - 1; i >= 0; i--) {
      const e = visible[i];
      if (e.checkId === forEachParent && Array.isArray(e.scope) && e.scope.length === 0) {
        const r: any = e.result;
        if (r && Array.isArray(r.forEachItems)) {
          latestItems = r.forEachItems as unknown[];
          break;
        }
      }
    }
    if (Array.isArray(latestItems)) {
      if (context.debug) {
        try {
          const prevLen = Array.isArray(forEachItems) ? (forEachItems as any[]).length : 0;
          const newLen = latestItems.length;
          if (prevLen !== newLen) {
            logger.info(
              `[LevelDispatch] Refreshing forEachItems for ${checkId}: ` +
                `from parent '${forEachParent}' latestItems=${newLen} (was ${prevLen})`
            );
          }
        } catch {}
      }
      forEachItems = latestItems as unknown[];
    }
  } catch (e) {
    // Non-fatal: proceed with provided forEachItems
    if (context.debug) {
      logger.warn(
        `[LevelDispatch] Failed to refresh forEachItems from journal for ${forEachParent}: ${e}`
      );
    }
  }
  const checkConfig = context.config.checks?.[checkId];
  if (!checkConfig) {
    throw new Error(`Check configuration not found: ${checkId}`);
  }

  // DEBUG: Log forEach execution
  logger.info(
    `[LevelDispatch][DEBUG] executeCheckWithForEachItems: checkId=${checkId}, forEachParent=${forEachParent}, items=${forEachItems.length}`
  );
  logger.info(
    `[LevelDispatch][DEBUG] forEachItems: ${JSON.stringify(forEachItems).substring(0, 200)}`
  );

  const allIssues: ReviewIssue[] = [];
  const perItemResults: ReviewSummary[] = [];
  const allOutputs: unknown[] = [];
  const allContents: string[] = [];
  const perIterationDurations: number[] = [];

  // Execute check once per forEach item
  for (let itemIndex = 0; itemIndex < forEachItems.length; itemIndex++) {
    const iterationStartMs = Date.now();
    const scope: Array<{ check: string; index: number }> = [
      { check: forEachParent, index: itemIndex },
    ];

    const forEachItem = forEachItems[itemIndex];
    logger.info(
      `[LevelDispatch][DEBUG] Starting iteration ${itemIndex} of ${checkId}, parent=${forEachParent}, item=${JSON.stringify(forEachItem)?.substring(0, 100)}`
    );

    // Check if the forEach item indicates a failure
    // When a check fails (via fail_if or execution error), it may set a flag in the output
    // Skip this iteration if the parent iteration failed
    const shouldSkipDueToParentFailure =
      (forEachItem as any)?.__failed === true || (forEachItem as any)?.__skip === true;

    if (shouldSkipDueToParentFailure) {
      // Parent iteration failed - skip this iteration
      logger.info(
        `⏭  Skipped ${checkId} iteration ${itemIndex} (forEach parent "${forEachParent}" iteration ${itemIndex} marked as failed)`
      );

      // Track this as a skipped iteration in stats
      const iterationDurationMs = Date.now() - iterationStartMs;
      perIterationDurations.push(iterationDurationMs);

      // Add empty result to maintain array alignment
      perItemResults.push({ issues: [] });
      // Propagate an explicit skip marker so downstream dependents can also skip this branch
      allOutputs.push({ __skip: true });

      continue; // Skip to next iteration
    }

    // Emit visor.foreach.item span for telemetry
    try {
      emitNdjsonSpanWithEvents(
        'visor.foreach.item',
        {
          'visor.check.id': checkId,
          'visor.foreach.index': itemIndex,
          'visor.foreach.total': forEachItems.length,
        },
        []
      );
    } catch (error) {
      logger.warn(`[LevelDispatch] Failed to emit foreach.item span: ${error}`);
    }

    // Emit scheduled event
    emitEvent({ type: 'CheckScheduled', checkId, scope });

    // Create dispatch record
    const dispatch: DispatchRecord = {
      id: `${checkId}-${itemIndex}-${Date.now()}`,
      checkId,
      scope,
      provider: context.checks[checkId]?.providerType || 'unknown',
      startMs: Date.now(),
      attempts: 1,
      foreachIndex: itemIndex,
    };

    state.activeDispatches.set(`${checkId}-${itemIndex}`, dispatch);

    try {
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

      // Build dependency results with scope
      const dependencyResults = buildDependencyResultsWithScope(
        checkId,
        checkConfig,
        context,
        scope
      );

      // Per-item dependency gating for map fanout: honor OR dependencies and continue_on_failure
      try {
        const rawDeps = (checkConfig as any)?.depends_on || [];
        const depList = Array.isArray(rawDeps) ? rawDeps : [rawDeps];
        if (depList.length > 0) {
          const groupSatisfied = (token: string): boolean => {
            if (typeof token !== 'string') return true;
            const orOptions = token.includes('|')
              ? token
                  .split('|')
                  .map(s => s.trim())
                  .filter(Boolean)
              : [token];
            for (const opt of orOptions) {
              const dr = dependencyResults.get(opt) as ReviewSummary | undefined;
              const depCfg = context.config.checks?.[opt];
              const cont = !!(depCfg && (depCfg as any).continue_on_failure === true);
              let failed = false;
              let skipped = false;
              if (!dr) {
                failed = true; // missing result => not satisfied
              } else {
                const out: any = (dr as any).output;
                const fatal = hasFatalIssues(dr as any);
                failed = fatal || (!!out && typeof out === 'object' && out.__failed === true);
                skipped = !!(out && typeof out === 'object' && out.__skip === true);
              }
              const satisfied = !skipped && (!failed || cont);
              if (satisfied) return true; // any option satisfies the group
            }
            return false;
          };

          let allSatisfied = true;
          for (const token of depList) {
            if (!groupSatisfied(token as any)) {
              allSatisfied = false;
              break;
            }
          }

          if (!allSatisfied) {
            // Skip this iteration without executing provider; maintain per-item alignment
            if (context.debug) {
              logger.info(
                `[LevelDispatch] Skipping ${checkId} iteration ${itemIndex} due to unsatisfied dependency group(s)`
              );
            }
            const iterationDurationMs = Date.now() - iterationStartMs;
            perIterationDurations.push(iterationDurationMs);
            perItemResults.push({ issues: [] });
            allOutputs.push({ __skip: true });
            // Do not call updateStats here: iteration did not execute
            continue;
          }
        }
      } catch {}

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

      // Build execution context
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
      const itemResult = await withActiveSpan(
        `visor.check.${checkId}`,
        {
          'visor.check.id': checkId,
          'visor.check.type': providerType,
          'visor.foreach.index': itemIndex,
        },
        async () => provider.execute(prInfo, providerConfig, dependencyResults, executionContext)
      );

      // Enrich issues
      const enrichedIssues = (itemResult.issues || []).map((issue: ReviewIssue) => ({
        ...issue,
        checkName: checkId,
        ruleId: `${checkId}/${issue.ruleId || 'unknown'}`,
        group: checkConfig.group,
        schema: typeof checkConfig.schema === 'object' ? 'custom' : checkConfig.schema,
        template: checkConfig.template,
        timestamp: Date.now(),
      }));

      // Track output BEFORE creating enrichedResult
      let output = (itemResult as any).output;
      let content = (itemResult as any).content;

      // Generate default content from issues if no content was provided
      if (!content && enrichedIssues.length > 0) {
        content = enrichedIssues
          .map(
            (i: ReviewIssue) =>
              `- **${i.severity.toUpperCase()}**: ${i.message} (${i.file}:${i.line})`
          )
          .join('\n');
      }

      // Check if this iteration has fatal issues (execution failures)
      const iterationHasFatalIssues = enrichedIssues.some((issue: ReviewIssue) => {
        const ruleId = issue.ruleId || '';
        return (
          ruleId.endsWith('/error') || // System errors
          ruleId.includes('/execution_error') || // Command failures
          ruleId.endsWith('_fail_if') // fail_if triggered
        );
      });

      // If this iteration failed, mark the output so dependent forEach iterations can skip it
      if (
        iterationHasFatalIssues &&
        output !== undefined &&
        output !== null &&
        typeof output === 'object'
      ) {
        output = { ...output, __failed: true };
      } else if (iterationHasFatalIssues) {
        // If output is primitive or undefined, wrap it in an object with __failed flag
        output = { __value: output, __failed: true };
      }

      // DEBUG: Log output for this iteration
      logger.info(
        `[LevelDispatch][DEBUG] Iteration ${itemIndex}: output=${JSON.stringify(output)?.substring(0, 100)}, hasFatalIssues=${iterationHasFatalIssues}`
      );

      const enrichedResult: ReviewSummary = {
        ...itemResult,
        issues: enrichedIssues,
        ...(content ? { content } : {}),
      };

      // Evaluate fail_if for this forEach iteration
      if (checkConfig.fail_if) {
        try {
          const evaluator = new FailureConditionEvaluator();
          // Build outputs map for fail_if evaluation (use dependency results as previous outputs)
          const failed = await evaluator.evaluateSimpleCondition(
            checkId,
            typeof checkConfig.schema === 'object' ? 'custom' : checkConfig.schema || '',
            checkConfig.group || '',
            enrichedResult,
            checkConfig.fail_if,
            Object.fromEntries(dependencyResults.entries()) as Record<string, ReviewSummary>
          );

          if (failed) {
            logger.warn(
              `[LevelDispatch] fail_if triggered for ${checkId} iteration ${itemIndex}: ${checkConfig.fail_if}`
            );

            // Add fail_if issue to the result
            const failIssue: ReviewIssue = {
              file: 'system',
              line: 0,
              ruleId: `${checkId}/${checkId}_fail_if`,
              message: `Check failure condition met: ${checkConfig.fail_if}`,
              severity: 'error',
              category: 'logic',
              checkName: checkId,
              group: checkConfig.group,
              schema: typeof checkConfig.schema === 'object' ? 'custom' : checkConfig.schema,
              timestamp: Date.now(),
            };

            enrichedResult.issues = [...(enrichedResult.issues || []), failIssue];
            enrichedIssues.push(failIssue);
            allIssues.push(failIssue);

            // Re-check if iteration has fatal issues after adding fail_if issue
            const nowHasFatalIssues = enrichedResult.issues.some((issue: ReviewIssue) => {
              const ruleId = issue.ruleId || '';
              return (
                ruleId.endsWith('/error') ||
                ruleId.includes('/execution_error') ||
                ruleId.endsWith('_fail_if')
              );
            });

            // Update output with __failed flag if needed
            if (
              nowHasFatalIssues &&
              output !== undefined &&
              output !== null &&
              typeof output === 'object' &&
              !(output as any).__failed
            ) {
              output = { ...output, __failed: true };
            } else if (nowHasFatalIssues && !(output as any)?.__failed) {
              output = { __value: output, __failed: true };
            }
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logger.error(
            `[LevelDispatch] Error evaluating fail_if for ${checkId} iteration ${itemIndex}: ${msg}`
          );
        }
      }

      // Store per-item result
      perItemResults.push(enrichedResult);
      allIssues.push(...enrichedIssues);
      allOutputs.push(output);

      // Track content
      if (typeof content === 'string' && content.trim()) {
        allContents.push(content.trim());
      }

      // Store in journal with scope - EXPLICITLY include output field
      try {
        const journalEntry = {
          sessionId: context.sessionId,
          checkId,
          result: { ...enrichedResult, output } as any,
          event: context.event || 'manual',
          scope,
        };
        // DEBUG: Log journal entry
        logger.info(
          `[LevelDispatch][DEBUG] Committing to journal: checkId=${checkId}, scope=${JSON.stringify(scope)}, hasOutput=${output !== undefined}`
        );
        context.journal.commitEntry(journalEntry);
      } catch (error) {
        logger.warn(`[LevelDispatch] Failed to commit to journal: ${error}`);
      }

      state.activeDispatches.delete(`${checkId}-${itemIndex}`);

      // Emit completed event
      emitEvent({
        type: 'CheckCompleted',
        checkId,
        scope,
        result: {
          ...enrichedResult,
          output,
        },
      });

      // Track duration for this iteration
      const iterationDurationMs = Date.now() - iterationStartMs;
      perIterationDurations.push(iterationDurationMs);

      // Track statistics for this forEach iteration
      updateStats(
        [{ checkId, result: enrichedResult, duration: iterationDurationMs }],
        state,
        true
      );
    } catch (error) {
      // Track duration for failed iteration
      const iterationDurationMs = Date.now() - iterationStartMs;
      perIterationDurations.push(iterationDurationMs);
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(
        `[LevelDispatch] Error executing check ${checkId} item ${itemIndex}: ${err.message}`
      );

      state.activeDispatches.delete(`${checkId}-${itemIndex}`);

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

      // Add error to results
      const errorIssue: ReviewIssue = {
        file: '',
        line: 0,
        ruleId: `${checkId}/error`,
        message: err.message,
        severity: 'error',
        category: 'logic',
      };

      allIssues.push(errorIssue);
      perItemResults.push({ issues: [errorIssue] });

      // Track statistics for this failed forEach iteration
      updateStats(
        [{ checkId, result: { issues: [errorIssue] }, error: err, duration: iterationDurationMs }],
        state,
        true
      );
    }
  }

  // Mark as completed
  state.completedChecks.add(checkId);

  // Update forEach metadata in stats
  const checkStats = state.stats.get(checkId);
  if (checkStats) {
    checkStats.outputsProduced = allOutputs.length;
    checkStats.perIterationDuration = perIterationDurations;

    // Create preview of forEach items (first 3 + indicator for more)
    const previewItems = allOutputs.slice(0, 3).map(item => {
      const str = typeof item === 'string' ? item : (JSON.stringify(item) ?? 'undefined');
      return str.length > 50 ? str.substring(0, 50) + '...' : str;
    });

    if (allOutputs.length > 3) {
      checkStats.forEachPreview = [...previewItems, `...${allOutputs.length - 3} more`];
    } else {
      checkStats.forEachPreview = previewItems;
    }

    state.stats.set(checkId, checkStats);

    // Check if ALL iterations failed (complete failure)
    // If so, mark check as failed so dependents can be skipped
    if (checkStats.totalRuns > 0 && checkStats.failedRuns === checkStats.totalRuns) {
      logger.info(
        `[LevelDispatch] forEach check ${checkId} failed completely (${checkStats.failedRuns}/${checkStats.totalRuns} iterations failed)`
      );
      // Mark in state so dependents know this check failed
      if (!(state as any).failedChecks) {
        (state as any).failedChecks = new Set<string>();
      }
      (state as any).failedChecks.add(checkId);
    }
  }

  // Return aggregated result
  const aggregatedResult: any = {
    issues: allIssues,
    isForEach: true,
    forEachItems: allOutputs,
    forEachItemResults: perItemResults,
    // Include aggregated content from all iterations
    ...(allContents.length > 0 ? { content: allContents.join('\n') } : {}),
  };

  // DEBUG: Log aggregated result
  logger.info(
    `[LevelDispatch][DEBUG] Aggregated result for ${checkId}: forEachItems.length=${allOutputs.length}, results=${perItemResults.length}`
  );
  logger.info(`[LevelDispatch][DEBUG] allOutputs: ${JSON.stringify(allOutputs).substring(0, 200)}`);

  // Store aggregated result in journal (without scope - this is the parent-level result)
  // Before storing, process routing for the aggregated child check so on_success/on_fail
  // can schedule follow-up actions (e.g., per-item remediation) based on forEach results.
  try {
    logger.info(`[LevelDispatch] Calling handleRouting for ${checkId}`);
  } catch {}
  try {
    // Mark completion prior to routing so guards see this as completed in the wave
    state.completedChecks.add(checkId);
    const currentWaveCompletions = (state as any).currentWaveCompletions as Set<string> | undefined;
    if (currentWaveCompletions) currentWaveCompletions.add(checkId);

    await handleRouting(context, state, transition, emitEvent, {
      checkId,
      scope: [],
      result: aggregatedResult as any,
      checkConfig: checkConfig as any,
      success: !hasFatalIssues(aggregatedResult as any),
    });
  } catch (error) {
    logger.warn(`[LevelDispatch] Routing error for aggregated forEach ${checkId}: ${error}`);
  }

  try {
    context.journal.commitEntry({
      sessionId: context.sessionId,
      checkId,
      result: aggregatedResult as any,
      event: context.event || 'manual',
      scope: [],
    });
    logger.info(`[LevelDispatch][DEBUG] Committed aggregated result to journal with scope=[]`);
  } catch (error) {
    logger.warn(`[LevelDispatch] Failed to commit aggregated forEach result to journal: ${error}`);
  }

  // Note: We intentionally do not increment totals here for the aggregated
  // child invocation; per-iteration stats were recorded above via updateStats.
  // Each iteration was counted separately, so the totalRuns already reflects
  // the correct number of executions.

  // Emit completed event for aggregated result
  emitEvent({
    type: 'CheckCompleted',
    checkId,
    scope: [],
    result: aggregatedResult,
  });

  const parentCheckConfig = context.config.checks?.[forEachParent];

  // Process on_finish for forEach PARENT after all forEach children complete
  // The forEach parent is the one that produced the forEachItems
  logger.info(
    `[LevelDispatch][DEBUG] Checking on_finish for forEach parent ${forEachParent}: has_on_finish=${!!parentCheckConfig?.on_finish}, is_forEach=${!!parentCheckConfig?.forEach}`
  );

  if (parentCheckConfig?.on_finish && parentCheckConfig.forEach) {
    logger.info(
      `[LevelDispatch] Processing on_finish for forEach parent ${forEachParent} after children complete`
    );

    // Get the parent check's result from journal
    try {
      const snapshotId = context.journal.beginSnapshot();
      const contextView = new (require('../../snapshot-store').ContextView)(
        context.journal,
        context.sessionId,
        snapshotId,
        [],
        context.event
      );
      const parentResult = contextView.get(forEachParent);

      if (parentResult) {
        logger.info(
          `[LevelDispatch] Found parent result for ${forEachParent}, evaluating on_finish`
        );

        // Evaluate on_finish routing (goto/goto_js) for the forEach parent
        const onFinish = parentCheckConfig.on_finish;

        // Process on_finish.run (if any). When we enqueue forward runs via
        // on_finish from within LevelDispatch (i.e., forEach parent path), we
        // must also request a WaveRetry so that checks whose execution depends
        // on updated memory/side-effects (but are not direct dependents of the
        // scheduled target) can re-evaluate their `if` conditions next wave.
        // This mirrors routing.ts behavior and is necessary for flows where an
        // aggregator sets flags consumed by later checks (e.g., posting steps).
        let queuedForward = false;
        logger.info(
          `[LevelDispatch] on_finish.run: ${onFinish.run?.length || 0} targets, targets=${JSON.stringify(onFinish.run || [])}`
        );
        if (onFinish.run && onFinish.run.length > 0) {
          for (const targetCheck of onFinish.run) {
            logger.info(`[LevelDispatch] Processing on_finish.run target: ${targetCheck}`);
            logger.info(
              `[LevelDispatch] Loop budget check: routingLoopCount=${state.routingLoopCount}, max_loops=${context.config.routing?.max_loops ?? 10}`
            );
            // Check loop budget before scheduling
            if (checkLoopBudget(context, state, 'on_finish', 'run')) {
              const errorIssue: ReviewIssue = {
                file: 'system',
                line: 0,
                ruleId: `${forEachParent}/routing/loop_budget_exceeded`,
                message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? 10}) during on_finish run`,
                severity: 'error',
                category: 'logic',
              };
              // Add error to parent result (not child aggregatedResult)
              parentResult.issues = [...(parentResult.issues || []), errorIssue];
              // Update parent result in journal with the error
              try {
                context.journal.commitEntry({
                  sessionId: context.sessionId,
                  checkId: forEachParent,
                  result: parentResult as any,
                  event: context.event || 'manual',
                  scope: [],
                });
              } catch (err) {
                logger.warn(
                  `[LevelDispatch] Failed to commit parent result with loop budget error: ${err}`
                );
              }
              return aggregatedResult; // ABORT
            }

            // Increment loop count
            state.routingLoopCount++;

            emitEvent({
              type: 'ForwardRunRequested',
              target: targetCheck,
              scope: [],
              origin: 'run',
            });
            queuedForward = true;
          }
        }

        // Evaluate goto_js and schedule routing
        const { evaluateGoto } = await import('./routing');

        // Debug logging for forEach on_finish.goto_js evaluation
        if (context.debug || true) {
          logger.info(
            `[LevelDispatch] Evaluating on_finish.goto_js for forEach parent: ${forEachParent}`
          );
          if (onFinish.goto_js) {
            logger.info(`[LevelDispatch] goto_js code: ${onFinish.goto_js.substring(0, 200)}`);
          }
          try {
            const snapshotId = context.journal.beginSnapshot();
            const view = new (require('../../snapshot-store').ContextView)(
              context.journal,
              context.sessionId,
              snapshotId,
              [],
              undefined
            );
            const vfHist = view.getHistory('validate-fact') || [];
            logger.info(`[LevelDispatch] history['validate-fact'] length: ${vfHist.length}`);
            const all = context.journal.readVisible(context.sessionId, snapshotId, undefined);
            const keys = Array.from(new Set(all.map((e: any) => e.checkId)));
            logger.info(`[LevelDispatch] history keys: ${keys.join(', ')}`);
          } catch {}
        }

        const gotoTarget = await (evaluateGoto as any)(
          onFinish.goto_js,
          onFinish.goto,
          forEachParent,
          parentCheckConfig,
          parentResult,
          context,
          state
        );

        if (context.debug || true) {
          logger.info(`[LevelDispatch] goto_js evaluation result: ${gotoTarget || 'null'}`);
        }

        if (gotoTarget) {
          // If we also queued on_finish.run and the goto target is the same
          // forEach parent, defer this self-goto to avoid premature preemption
          // before reducers (on_finish.run) have updated shared state (e.g.,
          // memory). The goto will be scheduled AFTER the WaveRetry completes
          // and checks can re-evaluate their conditions.
          if (queuedForward && gotoTarget === forEachParent) {
            logger.info(
              `[LevelDispatch] on_finish.goto to self (${gotoTarget}) deferred, will process after WaveRetry`
            );
            // Still schedule the goto, but it will execute after aggregate completes
            // and WaveRetry processes. This ensures the goto happens AFTER memory
            // is updated by aggregate.
            // Note: We don't schedule it immediately to avoid preemption, but we
            // DO schedule it so it processes after the wave retry.
          }
          // Always schedule the goto (even if deferred) - it will execute in order
          // Check loop budget before scheduling goto
          if (checkLoopBudget(context, state, 'on_finish', 'goto')) {
            const errorIssue: ReviewIssue = {
              file: 'system',
              line: 0,
              ruleId: `${forEachParent}/routing/loop_budget_exceeded`,
              message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? 10}) during on_finish goto`,
              severity: 'error',
              category: 'logic',
            };
            // Add error to parent result (not child aggregatedResult)
            parentResult.issues = [...(parentResult.issues || []), errorIssue];
            // Update parent result in journal with the error
            try {
              context.journal.commitEntry({
                sessionId: context.sessionId,
                checkId: forEachParent,
                result: parentResult as any,
                event: context.event || 'manual',
                scope: [],
              });
            } catch (err) {
              logger.warn(
                `[LevelDispatch] Failed to commit parent result with loop budget error: ${err}`
              );
            }
            return aggregatedResult; // ABORT
          }

          logger.info(`[LevelDispatch] on_finish for ${forEachParent} routing to: ${gotoTarget}`);

          // Increment loop count
          state.routingLoopCount++;

          emitEvent({
            type: 'ForwardRunRequested',
            target: gotoTarget,
            scope: [],
            origin: 'goto_js',
            gotoEvent: context.event as any,
          });
          state.flags.forwardRunRequested = true;
          // Also request a WaveRetry so planning occurs promptly even when preemption
          // does not immediately rebuild a wave in some schedules.
          try {
            const guardKeyGoto = `waveRetry:on_finish:${forEachParent}:wave:${state.wave}`;
            if (!(state as any).forwardRunGuards?.has(guardKeyGoto)) {
              (state as any).forwardRunGuards?.add(guardKeyGoto);
              emitEvent({ type: 'WaveRetry', reason: 'on_finish' });
            }
          } catch {}
        } else {
          logger.info(`[LevelDispatch] on_finish for ${forEachParent} returned null, no routing`);
        }

        // If we enqueued any on_finish.run targets, request a WaveRetry so the
        // next wave re-evaluates guards/ifs across the full plan. Guard to
        // avoid duplicate retries for the same parent within the same wave.
        if (queuedForward) {
          const guardKey = `waveRetry:on_finish:${forEachParent}:wave:${state.wave}`;
          logger.info(
            `[LevelDispatch] Checking WaveRetry guard: ${guardKey}, has=${!!(state as any).forwardRunGuards?.has(guardKey)}`
          );
          if (!(state as any).forwardRunGuards?.has(guardKey)) {
            (state as any).forwardRunGuards?.add(guardKey);
            logger.info(`[LevelDispatch] Emitting WaveRetry event for on_finish.run targets`);
            emitEvent({ type: 'WaveRetry', reason: 'on_finish' });
          }
        } else {
          // We may still have scheduled a goto above; in that case the guard
          // block there has already emitted WaveRetry. Nothing to do here.
        }

        // No WaveRetry needed when goto was scheduled; the planner preempts
        // remaining work and rebuilds the next wave around the goto target.
      } else {
        logger.warn(`[LevelDispatch] Could not find parent result for ${forEachParent} in journal`);
      }
    } catch (error) {
      logger.error(
        `[LevelDispatch] Error processing on_finish for forEach parent ${forEachParent}: ${error}`
      );
    }
  }

  return aggregatedResult;
}

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
function buildDependencyResultsWithScope(
  checkId: string,
  checkConfig: any,
  context: EngineContext,
  scope: Array<{ check: string; index: number }>
): Map<string, ReviewSummary> {
  const dependencyResults = new Map<string, ReviewSummary>();

  // Get dependencies from configuration
  const dependencies = checkConfig.depends_on || [];
  const depList = Array.isArray(dependencies) ? dependencies : [dependencies];

  // Determine current forEach index from scope (if any)
  const currentIndex = scope.length > 0 ? scope[scope.length - 1].index : undefined;

  // First, populate explicit dependencies
  for (const depId of depList) {
    if (!depId) continue;

    // Try to get the LATEST result from journal for this exact scope
    try {
      const snapshotId = context.journal.beginSnapshot();
      const visible = context.journal.readVisible(
        context.sessionId,
        snapshotId,
        context.event as any
      );
      const sameScope = (
        a: Array<{ check: string; index: number }>,
        b: Array<{ check: string; index: number }>
      ): boolean => {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++)
          if (a[i].check !== b[i].check || a[i].index !== b[i].index) return false;
        return true;
      };
      const matches = visible.filter(e => e.checkId === depId && sameScope(e.scope as any, scope));
      let journalResult = (
        matches.length > 0 ? matches[matches.length - 1].result : undefined
      ) as any;

      // If we couldn't resolve a scoped result OR we received an aggregated
      // forEach result, reconstruct a per-item view using forEachItemResults
      if (
        journalResult &&
        Array.isArray(journalResult.forEachItems) &&
        currentIndex !== undefined
      ) {
        const perItemSummary: any = (journalResult.forEachItemResults &&
          journalResult.forEachItemResults[currentIndex]) || { issues: [] };
        const perItemOutput = journalResult.forEachItems[currentIndex];
        const combined = { ...perItemSummary, output: perItemOutput } as ReviewSummary;
        dependencyResults.set(depId, combined);
        continue;
      }

      if (!journalResult) {
        // Fallback: try raw (aggregate) view and slice out current index if possible
        try {
          const rawView = new (require('../../snapshot-store').ContextView)(
            context.journal,
            context.sessionId,
            snapshotId,
            [],
            context.event
          );
          const rawResult = rawView.get(depId) as any | undefined;
          if (rawResult && Array.isArray(rawResult.forEachItems) && currentIndex !== undefined) {
            const perItemSummary: any = (rawResult.forEachItemResults &&
              rawResult.forEachItemResults[currentIndex]) || { issues: [] };
            const perItemOutput = rawResult.forEachItems[currentIndex];
            const combined = { ...perItemSummary, output: perItemOutput } as ReviewSummary;
            dependencyResults.set(depId, combined);
            continue;
          }
          journalResult = rawResult;
        } catch {
          // ignore
        }
      }

      if (journalResult) {
        dependencyResults.set(depId, journalResult as ReviewSummary);
        continue;
      }
    } catch {
      // Fall through to other sources
    }

    // Fall back to empty result
    dependencyResults.set(depId, { issues: [] });
  }

  // Also populate ALL other executed checks from journal (for global outputs namespace)
  // This provides access to all outputs via {{ outputs["check-name"] }} in templates
  try {
    const snapshotId = context.journal.beginSnapshot();
    const contextView = new (require('../../snapshot-store').ContextView)(
      context.journal,
      context.sessionId,
      snapshotId,
      scope,
      context.event
    );

    // Get all check names from the config
    const allCheckNames = Object.keys(context.config.checks || {});
    for (const checkName of allCheckNames) {
      // Skip if already in dependencies
      if (dependencyResults.has(checkName)) continue;

      // Try to get result from journal
      let jr: any | undefined = contextView.get(checkName);

      // If this is an aggregated forEach result and we have an index in scope,
      // expose the per-item view to make `outputs["name"]` reflect the current branch item.
      if (jr && Array.isArray(jr.forEachItems) && currentIndex !== undefined) {
        const perItemSummary: any = (jr.forEachItemResults &&
          jr.forEachItemResults[currentIndex]) || { issues: [] };
        const perItemOutput = jr.forEachItems[currentIndex];
        const combined = { ...perItemSummary, output: perItemOutput } as ReviewSummary;
        dependencyResults.set(checkName, combined);
        continue;
      }

      if (!jr) {
        // Fallback to raw aggregate and slice current index if possible
        try {
          const rawView = new (require('../../snapshot-store').ContextView)(
            context.journal,
            context.sessionId,
            snapshotId,
            [],
            context.event
          );
          const raw = rawView.get(checkName) as any | undefined;
          if (raw && Array.isArray(raw.forEachItems) && currentIndex !== undefined) {
            const perItemSummary: any = (raw.forEachItemResults &&
              raw.forEachItemResults[currentIndex]) || { issues: [] };
            const perItemOutput = raw.forEachItems[currentIndex];
            const combined = { ...perItemSummary, output: perItemOutput } as ReviewSummary;
            dependencyResults.set(checkName, combined);
            continue;
          }
          jr = raw;
        } catch {
          // ignore
        }
      }

      if (jr) {
        dependencyResults.set(checkName, jr as ReviewSummary);
      }
    }

    // Add raw array access for forEach checks
    // For each check with forEach:true, also provide <checkName>-raw key with the full array
    for (const checkName of allCheckNames) {
      const checkCfg = context.config.checks?.[checkName];
      if (checkCfg?.forEach) {
        // Get the check result (without scope) to access the full forEachItems array
        try {
          const rawContextView = new (require('../../snapshot-store').ContextView)(
            context.journal,
            context.sessionId,
            snapshotId,
            [], // No scope - get parent-level result with forEachItems
            context.event
          );
          const rawResult = rawContextView.get(checkName);
          if (rawResult && (rawResult as any).forEachItems) {
            // Add -raw key with full array
            const rawKey = `${checkName}-raw`;
            dependencyResults.set(rawKey, {
              issues: [],
              output: (rawResult as any).forEachItems,
            } as ReviewSummary);
          }
        } catch {
          // Silently skip - raw access is optional
        }
      }
    }
  } catch {
    // Silently fail - we'll just have the explicit dependencies
  }

  return dependencyResults;
}

/**
 * Build dependency results for a check
 */
function buildDependencyResults(
  checkId: string,
  checkConfig: any,
  context: EngineContext,
  _state: RunState
): Map<string, ReviewSummary> {
  return buildDependencyResultsWithScope(checkId, checkConfig, context, []);
}

/**
 * Check if fail-fast should be triggered based on results
 */
function shouldFailFast(
  results: Array<{ checkId: string; result: ReviewSummary; error?: Error }>
): boolean {
  // Fail-fast if any check has critical or error severity issues
  for (const { result } of results) {
    if (!result || !result.issues) continue;

    if (hasFatalIssues(result)) {
      return true;
    }
  }

  return false;
}

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
function hasFatalIssues(result: ReviewSummary): boolean {
  if (!result.issues) {
    return false;
  }

  // Check for execution failure indicators in ruleId
  return result.issues.some(issue => {
    const ruleId = issue.ruleId || '';
    return (
      ruleId.endsWith('/error') || // System errors
      ruleId.includes('/execution_error') || // Command failures
      ruleId.endsWith('_fail_if') // fail_if triggered
    );
  });
}

/**
 * Update execution stats
 */
function updateStats(
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
      issuesBySeverity: {
        critical: 0,
        error: 0,
        warning: 0,
        info: 0,
      },
    };

    // DEBUG: Log when updateStats is called for post-response
    if (checkId === 'post-response') {
      logger.info(
        `[updateStats] Called for post-response: existing.skipped=${existing?.skipped}, stats.skipped=${stats.skipped}, skipReason=${(stats as any).skipReason}`
      );
    }

    // If check was previously skipped but is now executing, clear the skipped flag
    if (stats.skipped) {
      stats.skipped = false;
      if (checkId === 'post-response') {
        logger.info(
          `[updateStats] Clearing skipped flag for post-response (was skipped, now executing)`
        );
      }
    }

    // Increment totalRuns for all executions including forEach iterations
    // isForEachIteration=true means this is a single iteration of a forEach child check
    // We count these as separate executions
    stats.totalRuns++;

    // Track duration if provided
    if (duration !== undefined) {
      stats.totalDuration += duration;
    }

    // Check if this is an execution failure (not a code quality finding)
    // Execution failures have specific ruleId patterns that indicate the check itself failed
    const hasExecutionFailure = result.issues?.some(issue => {
      const ruleId = issue.ruleId || '';
      return (
        ruleId.endsWith('/error') || // System errors, exceptions
        ruleId.includes('/execution_error') || // Command failures
        ruleId.endsWith('_fail_if') // fail_if condition triggered
      );
    });

    if (error) {
      // Exception during execution
      stats.failedRuns++;
      stats.errorMessage = error.message;
      // Mark check as failed so dependents can be skipped
      // Note: forEach iteration failures are tracked per-iteration, but the check
      // is only marked as completely failed if ALL iterations fail (handled in executeCheckWithForEachItems)
      if (!isForEachIteration) {
        if (!(state as any).failedChecks) {
          (state as any).failedChecks = new Set<string>();
        }
        (state as any).failedChecks.add(checkId);
      }
    } else if (hasExecutionFailure) {
      // Execution failure (command error, fail_if triggered, etc.)
      stats.failedRuns++;
      // Note: We do NOT set stats.errorMessage here because the check already produced
      // error issues as part of its normal output. Setting errorMessage would cause
      // convertGroupedResultsToReviewSummary to create a duplicate system/error issue.
      // errorMessage should only be set for exceptional errors (caught exceptions).

      // Mark check as failed so dependents can be skipped
      // Note: forEach iteration failures are tracked per-iteration, but the check
      // is only marked as completely failed if ALL iterations fail (handled in executeCheckWithForEachItems)
      if (!isForEachIteration) {
        if (!(state as any).failedChecks) {
          (state as any).failedChecks = new Set<string>();
        }
        (state as any).failedChecks.add(checkId);
      }
    } else {
      stats.successfulRuns++;
    }

    // Count issues
    if (result.issues) {
      stats.issuesFound += result.issues.length;

      for (const issue of result.issues) {
        if (issue.severity === 'critical') stats.issuesBySeverity.critical++;
        else if (issue.severity === 'error') stats.issuesBySeverity.error++;
        else if (issue.severity === 'warning') stats.issuesBySeverity.warning++;
        else if (issue.severity === 'info') stats.issuesBySeverity.info++;
      }
    }

    // Track outputsProduced if result has output
    // For forEach parent checks, use the length of forEachItems
    // For regular checks, count is 1
    if (stats.outputsProduced === undefined) {
      const forEachItems = (result as any).forEachItems;
      if (Array.isArray(forEachItems)) {
        stats.outputsProduced = forEachItems.length;
      } else if ((result as any).output !== undefined) {
        stats.outputsProduced = 1;
      }
    }

    state.stats.set(checkId, stats);
  }
}

/**
 * Render template content for a check
 * Similar to legacy engine's renderCheckContent method
 */
async function renderTemplateContent(
  checkId: string,
  checkConfig: any,
  reviewSummary: ReviewSummary
): Promise<string | undefined> {
  try {
    const { createExtendedLiquid } = await import('../../liquid-extensions');
    const fs = await import('fs/promises');
    const path = await import('path');

    // Determine template source: explicit template (content/file) or built-in by schema
    const schemaRaw = checkConfig.schema || 'plain';
    const schema = typeof schemaRaw === 'string' ? schemaRaw : 'code-review';

    let templateContent: string | undefined;

    if (checkConfig.template && checkConfig.template.content) {
      templateContent = String(checkConfig.template.content);
    } else if (checkConfig.template && checkConfig.template.file) {
      // Securely resolve relative file path
      const file = String(checkConfig.template.file);
      const resolved = path.resolve(process.cwd(), file);
      templateContent = await fs.readFile(resolved, 'utf-8');
    } else if (schema && schema !== 'plain') {
      // Built-in schema template fallback
      const sanitized = String(schema).replace(/[^a-zA-Z0-9-]/g, '');
      if (sanitized) {
        const candidatePaths = [
          // When bundled (dist), __dirname points to dist/state-machine/states
          path.join(__dirname, '..', '..', 'output', sanitized, 'template.liquid'),
          // Dev fallback
          path.join(process.cwd(), 'output', sanitized, 'template.liquid'),
        ];
        for (const p of candidatePaths) {
          try {
            templateContent = await fs.readFile(p, 'utf-8');
            if (templateContent) break;
          } catch {
            // try next
          }
        }
      }
    }

    if (!templateContent) {
      // No template to render
      return undefined;
    }

    // Use extended Liquid with our custom filters/tags
    const liquid = createExtendedLiquid({
      trimTagLeft: false,
      trimTagRight: false,
      trimOutputLeft: false,
      trimOutputRight: false,
      greedy: false,
    });

    const templateData: Record<string, unknown> = {
      issues: reviewSummary.issues || [],
      checkName: checkId,
      output: (reviewSummary as any).output,
    };

    const rendered = await liquid.parseAndRender(templateContent, templateData);
    return rendered.trim();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`[LevelDispatch] Failed to render template for ${checkId}: ${msg}`);
    return undefined;
  }
}
