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
import { withActiveSpan, setSpanAttributes, addEvent } from '../../telemetry/trace-helpers';
import { emitMermaidFromMarkdown } from '../../utils/mermaid-telemetry';
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

function formatScopeLabel(scope: Array<{ check: string; index: number }> | undefined): string {
  if (!scope || scope.length === 0) return '';
  return scope.map(item => `${item.check}:${item.index}`).join('|');
}

function recordOnFinishRoutingEvent(args: {
  checkId: string;
  action: 'run' | 'goto';
  target: string;
  source: 'run' | 'goto' | 'goto_js' | 'transitions';
  scope?: Array<{ check: string; index: number }>;
  gotoEvent?: string;
}): void {
  const attrs: Record<string, unknown> = {
    check_id: args.checkId,
    trigger: 'on_finish',
    action: args.action,
    target: args.target,
    source: args.source,
  };
  const scopeLabel = formatScopeLabel(args.scope);
  if (scopeLabel) attrs.scope = scopeLabel;
  if (args.gotoEvent) attrs.goto_event = args.gotoEvent;
  addEvent('visor.routing', attrs);
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
      // Prefer explicit output; otherwise use the full result (for schemas like
      // code-review where issues are returned directly). This ensures
      // outputs_history['security'].last.issues[...] works in prompts and tests.
      const payload =
        entry.result.output !== undefined ? entry.result.output : (entry.result as unknown);
      if (payload !== undefined) outputHistory.get(checkId)!.push(payload);
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

    // Build previous results for condition evaluation
    // Default: include only results from the CURRENT wave. This prevents
    // stale data from causing routing loops in normal execution.
    const previousResults = new Map<string, ReviewSummary>();

    const currentWaveCompletions = (state as any).currentWaveCompletions as Set<string> | undefined;
    const useGlobalOutputsFlag = !!((state as any).flags && (state as any).flags.forwardRunActive);
    const waveKind = ((state as any).flags && (state as any).flags.waveKind) || undefined;
    // Heuristic: only allow global outputs for guards on checks that actually
    // have dependencies. Checks without deps (e.g., top-level prompts like
    // 'ask') should continue to see an empty outputs set so they can re-run
    // during forward-run waves triggered by goto/on_fail.
    const hasDeps = (() => {
      try {
        const deps = (checkConfig as any)?.depends_on;
        if (!deps) return false;
        if (Array.isArray(deps)) return deps.length > 0;
        return typeof deps === 'string' ? deps.trim().length > 0 : false;
      } catch {
        return false;
      }
    })();
    // Steps with dependencies should always see outputs from all completed steps.
    // In forward-run waves (from on_success/on_fail goto), guards should see the
    // latest global outputs even if the check has no explicit dependencies.
    // In wave-retry (from on_finish), restrict to checks with dependencies to
    // avoid wrongly skipping top-level prompts like 'ask'.
    const useGlobalOutputs = hasDeps || (useGlobalOutputsFlag && waveKind === 'forward');

    if (useGlobalOutputs) {
      // Forward-run wave: allow guards to consult latest outputs from the entire
      // journal so follow-up steps (e.g., post-verified after run-review) can
      // see the outputs produced in the prior wave that scheduled this forward-run.
      try {
        const snapshotId = context.journal.beginSnapshot();
        const ContextView = require('../../snapshot-store').ContextView;
        const contextView = new ContextView(
          context.journal,
          context.sessionId,
          snapshotId,
          [],
          context.event
        );
        for (const key of Object.keys(context.checks || {})) {
          const jr = contextView.get(key);
          if (jr) previousResults.set(key, jr as ReviewSummary);
        }
      } catch {
        // Fallback to current-wave only if any error occurs
      }
    } else if (currentWaveCompletions) {
      // Current-wave-only results
      for (const key of currentWaveCompletions) {
        try {
          const snapshotId = context.journal.beginSnapshot();
          const ContextView = require('../../snapshot-store').ContextView;
          const contextView = new ContextView(
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
      workflowInputs: (context.config as any).workflow_inputs || {},
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
  const levelChecksPreview = level.parallel.slice(0, 5).join(',');
  setSpanAttributes({
    level_size: level.parallel.length,
    level_checks_preview: levelChecksPreview,
  });

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

  // Handle on_init lifecycle hook ONCE before forEach loop
  // (not per-item - runs before all iterations)
  const scope: Array<{ check: string; index: number }> = [];
  const sharedDependencyResults = buildDependencyResultsWithScope(
    checkId,
    checkConfig,
    context,
    scope
  );

  if (checkConfig.on_init) {
    try {
      const { handleOnInit } = require('../dispatch/execution-invoker');

      // Convert Map to Record for on_init handlers
      const dependencyResultsMap: Record<string, unknown> = {};
      for (const [key, value] of sharedDependencyResults.entries()) {
        dependencyResultsMap[key] = value;
      }

      const prInfo = context.prInfo;
      const executionContext = {
        sessionId: context.sessionId,
        checkId,
        event: context.event,
        _parentContext: context,
      };

      await handleOnInit(
        checkId,
        checkConfig.on_init,
        context,
        scope,
        prInfo,
        dependencyResultsMap,
        executionContext
      );

      // Merge on_init outputs back into sharedDependencyResults
      for (const [key, value] of Object.entries(dependencyResultsMap)) {
        if (!sharedDependencyResults.has(key)) {
          sharedDependencyResults.set(key, value as any);
        }
      }

      logger.info(`[LevelDispatch] on_init completed for ${checkId} before forEach loop`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`[LevelDispatch] on_init failed for ${checkId}: ${err.message}`);
      throw err;
    }
  }

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

      // Propagate authenticated Octokit (v2 frontends / Action mode)
      try {
        const maybeOctokit = (context.executionContext as any)?.octokit;
        if (maybeOctokit) {
          (providerConfig as any).eventContext = {
            ...(providerConfig as any).eventContext,
            octokit: maybeOctokit,
          };
        }
      } catch {}

      // Extract Slack conversation from webhookContext (for Slack socket mode)
      // The socket-runner stores conversation data in webhookData under the endpoint key
      try {
        const webhookCtx = (context.executionContext as any)?.webhookContext;
        const webhookData = webhookCtx?.webhookData as Map<string, unknown> | undefined;
        if (context.debug) {
          logger.info(
            `[LevelDispatch] webhookContext: ${webhookCtx ? 'present' : 'absent'}, webhookData size: ${webhookData?.size || 0}`
          );
        }
        if (webhookData && webhookData.size > 0) {
          // Find the payload with slack_conversation
          for (const payload of webhookData.values()) {
            const slackConv = (payload as any)?.slack_conversation;
            if (slackConv) {
              // Build slack context with event and conversation
              const event = (payload as any)?.event;
              const messageCount = Array.isArray(slackConv?.messages)
                ? slackConv.messages.length
                : 0;
              if (context.debug) {
                logger.info(
                  `[LevelDispatch] Slack conversation extracted: ${messageCount} messages`
                );
              }
              (providerConfig as any).eventContext = {
                ...(providerConfig as any).eventContext,
                slack: {
                  event: event || {},
                  conversation: slackConv,
                },
                conversation: slackConv, // Also expose at top level for convenience
              };
              break;
            }
          }
        }
      } catch {}

      // Build dependency results with scope
      const dependencyResults = buildDependencyResultsWithScope(
        checkId,
        checkConfig,
        context,
        scope
      );

      // Merge shared on_init outputs into this iteration's dependencyResults
      for (const [key, value] of sharedDependencyResults.entries()) {
        if (!dependencyResults.has(key)) {
          dependencyResults.set(key, value);
        }
      }

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

      // Evaluate assume contract for this iteration (design-by-contract)
      {
        const assumeExpr = (checkConfig as any)?.assume as string | string[] | undefined;
        if (assumeExpr) {
          let ok = true;
          try {
            const evaluator = new FailureConditionEvaluator();
            const exprs = Array.isArray(assumeExpr) ? assumeExpr : [assumeExpr];
            for (const ex of exprs) {
              const res = await evaluator.evaluateIfCondition(checkId, ex, {
                event: context.event || 'manual',
                previousResults: dependencyResults as any,
              } as any);
              if (!res) {
                ok = false;
                break;
              }
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`Failed to evaluate assume expression for check '${checkId}': ${msg}`);
            // Fail-secure: if assume evaluation fails, skip execution
            ok = false;
          }
          if (!ok) {
            logger.info(
              `⏭  Skipped (assume: ${String(Array.isArray(assumeExpr) ? assumeExpr[0] : assumeExpr).substring(0, 40)}${String(Array.isArray(assumeExpr) ? assumeExpr[0] : assumeExpr).length > 40 ? '...' : ''})`
            );
            const iterationDurationMs = Date.now() - iterationStartMs;
            perIterationDurations.push(iterationDurationMs);
            perItemResults.push({ issues: [] });
            allOutputs.push({ __skip: true });
            continue;
          }
        }
      }

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
          session_id: context.sessionId,
          wave: state.wave,
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

      // JSON Schema validation for per-item outputs when a schema is provided
      try {
        let schemaObj =
          (typeof checkConfig.schema === 'object' ? (checkConfig.schema as any) : undefined) ||
          (checkConfig as any).output_schema;
        // If schema is a known renderer string, attempt to load its JSON Schema
        if (!schemaObj && typeof (checkConfig as any).schema === 'string') {
          try {
            const { loadRendererSchema } = await import('../dispatch/renderer-schema');
            schemaObj = await loadRendererSchema((checkConfig as any).schema as string);
          } catch {}
        }
        const itemOutput = output;
        if (schemaObj && itemOutput !== undefined) {
          const Ajv = require('ajv');
          const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false });
          const validate = ajv.compile(schemaObj);
          const valid = validate(itemOutput);
          if (!valid) {
            const errs = (validate.errors || [])
              .slice(0, 3)
              .map((e: any) => e.message)
              .join('; ');
            const issue: ReviewIssue = {
              file: 'contract',
              line: 0,
              ruleId: `contract/schema_validation_failed`,
              message: `Output schema validation failed${errs ? `: ${errs}` : ''}`,
              severity: 'error',
              category: 'logic',
              checkName: checkId,
              group: checkConfig.group,
              schema: 'json-schema',
              timestamp: Date.now(),
            } as any;
            enrichedResult.issues = [...(enrichedResult.issues || []), issue];
            if (Array.isArray(enrichedIssues)) {
              enrichedIssues.push(issue);
            }
          }
        }
      } catch {}

      // Evaluate guarantee contract (non-fatal): append error issues on violation
      try {
        const guaranteeExpr = (checkConfig as any)?.guarantee as string | string[] | undefined;
        if (guaranteeExpr) {
          const evaluator = new FailureConditionEvaluator();
          const exprs = Array.isArray(guaranteeExpr) ? guaranteeExpr : [guaranteeExpr];
          for (const ex of exprs) {
            const holds = await evaluator.evaluateIfCondition(checkId, ex, {
              previousResults: dependencyResults as any,
              event: context.event || 'manual',
              output: output, // Pass the iteration output for guarantee evaluation
            } as any);
            if (!holds) {
              const issue: ReviewIssue = {
                file: 'contract',
                line: 0,
                ruleId: `contract/guarantee_failed`,
                message: `Guarantee failed: ${ex}`,
                severity: 'error',
                category: 'logic',
                checkName: checkId,
                group: checkConfig.group,
                schema:
                  typeof checkConfig.schema === 'object' ? 'custom' : (checkConfig.schema as any),
                timestamp: Date.now(),
              } as any;
              enrichedResult.issues = [...(enrichedResult.issues || []), issue];
            }
          }
        }
      } catch {}

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

            recordOnFinishRoutingEvent({
              checkId: forEachParent,
              action: 'run',
              target: targetCheck,
              source: 'run',
              scope: [],
            });
            emitEvent({
              type: 'ForwardRunRequested',
              target: targetCheck,
              scope: [],
              origin: 'run',
            });
            queuedForward = true;
          }
        }

        // Declarative transitions override goto/goto_js when present.
        // Mirror routing.ts behavior for the forEach-parent on_finish path.
        try {
          const { evaluateTransitions } = await import('./routing');
          const transTarget = await evaluateTransitions(
            (onFinish as any).transitions,
            forEachParent,
            parentCheckConfig as any,
            parentResult as any,
            context,
            state
          );
          if (transTarget !== undefined) {
            if (transTarget) {
              // Loop budget guard
              if (checkLoopBudget(context, state, 'on_finish', 'goto')) {
                const errorIssue: ReviewIssue = {
                  file: 'system',
                  line: 0,
                  ruleId: `${forEachParent}/routing/loop_budget_exceeded`,
                  message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? 10}) during on_finish transitions`,
                  severity: 'error',
                  category: 'logic',
                };
                parentResult.issues = [...(parentResult.issues || []), errorIssue];
                try {
                  context.journal.commitEntry({
                    sessionId: context.sessionId,
                    checkId: forEachParent,
                    result: parentResult as any,
                    event: context.event || 'manual',
                    scope: [],
                  });
                } catch {}
                return aggregatedResult; // abort further routing
              }
              state.routingLoopCount++;
              recordOnFinishRoutingEvent({
                checkId: forEachParent,
                action: 'goto',
                target: transTarget.to,
                source: 'transitions',
                scope: [],
                gotoEvent: (transTarget as any).goto_event,
              });
              emitEvent({
                type: 'ForwardRunRequested',
                target: transTarget.to,
                scope: [],
                origin: 'goto_js',
                gotoEvent: (transTarget as any).goto_event,
              });
              queuedForward = true;
            }
            // Whether null (explicit no-op) or a target, transitions override goto/goto_js
            // Also request a WaveRetry if we queued something (handled below)
            if (queuedForward) {
              // no-op here; WaveRetry emitted after this block
            }
            return aggregatedResult;
          }
        } catch (e) {
          logger.error(
            `[LevelDispatch] Error evaluating on_finish transitions for ${forEachParent}: ${e instanceof Error ? e.message : String(e)}`
          );
        }

        // Evaluate goto_js and schedule routing if transitions did not match
        const { evaluateGoto } = await import('./routing');

        // Debug logging for forEach on_finish.goto_js evaluation
        if (context.debug) {
          logger.info(
            `[LevelDispatch] Evaluating on_finish.goto_js for forEach parent: ${forEachParent}`
          );
          if (onFinish.goto_js) {
            logger.info(`[LevelDispatch] goto_js code: ${onFinish.goto_js.substring(0, 200)}`);
          }
          try {
            const snapshotId = context.journal.beginSnapshot();
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

        if (context.debug) {
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

          recordOnFinishRoutingEvent({
            checkId: forEachParent,
            action: 'goto',
            target: gotoTarget,
            source: onFinish.goto_js ? 'goto_js' : 'goto',
            scope: [],
          });
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
      const skipped = !!(st && (st as any).skipped === true);
      const skipReason = (st as any)?.skipReason;
      // forEach_empty is not a failure - it means there was nothing to process, which is valid
      // The dependent step should still run (with empty data from the forEach step)
      const skippedDueToEmptyForEach = skipped && skipReason === 'forEach_empty';
      // Don't treat forEach_empty as a failure even if it's in failedChecks
      // (forEach_empty checks are added to failedChecks for cascading within forEach chains,
      // but should not be treated as failures for non-forEach dependents)
      const wasMarkedFailed =
        !!(failedChecks && failedChecks.has(opt)) && !skippedDueToEmptyForEach;
      const failedOnly = !!(st && (st.failedRuns || 0) > 0 && (st.successfulRuns || 0) === 0);
      const satisfied =
        (!skipped || skippedDueToEmptyForEach) && ((!failedOnly && !wasMarkedFailed) || cont);
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

    // Build lightweight checks metadata for template helpers (e.g., chat_history)
    const checksMeta: Record<string, { type?: string; group?: string }> = {};
    try {
      const allChecks = context.config.checks || {};
      for (const [id, cfg] of Object.entries(allChecks)) {
        const anyCfg = cfg as any;
        checksMeta[id] = { type: anyCfg.type, group: anyCfg.group };
      }
    } catch {
      // Best-effort only; helpers will fall back if this is missing
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
      // Expose history and checks metadata for template helpers
      __outputHistory: outputHistory,
      checksMeta,
      ai: {
        ...(checkConfig.ai || {}),
        timeout: checkConfig.ai?.timeout || 600000,
        debug: !!context.debug,
      },
    };

    // Propagate authenticated Octokit (v2 frontends / Action mode)
    try {
      const maybeOctokit = (context.executionContext as any)?.octokit;
      if (maybeOctokit) {
        (providerConfig as any).eventContext = {
          ...(providerConfig as any).eventContext,
          octokit: maybeOctokit,
        };
      }
    } catch {}

    // Extract Slack conversation from webhookContext (for Slack socket mode)
    // The socket-runner stores conversation data in webhookData under the endpoint key
    try {
      const webhookCtx = (context.executionContext as any)?.webhookContext;
      const webhookData = webhookCtx?.webhookData as Map<string, unknown> | undefined;
      if (context.debug) {
        logger.info(
          `[LevelDispatch] webhookContext: ${webhookCtx ? 'present' : 'absent'}, webhookData size: ${webhookData?.size || 0}`
        );
      }
      if (webhookData && webhookData.size > 0) {
        // Find the payload with slack_conversation
        for (const payload of webhookData.values()) {
          const slackConv = (payload as any)?.slack_conversation;
          if (slackConv) {
            // Build slack context with event and conversation
            const event = (payload as any)?.event;
            const messageCount = Array.isArray(slackConv?.messages) ? slackConv.messages.length : 0;
            if (context.debug) {
              logger.info(`[LevelDispatch] Slack conversation extracted: ${messageCount} messages`);
            }
            (providerConfig as any).eventContext = {
              ...(providerConfig as any).eventContext,
              slack: {
                event: event || {},
                conversation: slackConv,
              },
              conversation: slackConv, // Also expose at top level for convenience
            };
            break;
          }
        }
      }
    } catch {}

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
      // Make checks metadata available to providers that want it
      checksMeta,
    };

    // Evaluate assume contract (design-by-contract) before executing
    {
      const assumeExpr = (checkConfig as any)?.assume as string | string[] | undefined;
      if (assumeExpr) {
        let ok = true;
        try {
          const evaluator = new FailureConditionEvaluator();
          const exprs = Array.isArray(assumeExpr) ? assumeExpr : [assumeExpr];
          for (const ex of exprs) {
            const res = await evaluator.evaluateIfCondition(checkId, ex, {
              event: context.event || 'manual',
              previousResults: dependencyResults as any,
            } as any);
            if (!res) {
              ok = false;
              break;
            }
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logger.error(`Failed to evaluate assume expression for check '${checkId}': ${msg}`);
          // Fail-secure: if assume evaluation fails, skip execution
          ok = false;
        }
        if (!ok) {
          logger.info(
            `⏭  Skipped (assume: ${String(Array.isArray(assumeExpr) ? assumeExpr[0] : assumeExpr).substring(0, 40)}${String(Array.isArray(assumeExpr) ? assumeExpr[0] : assumeExpr).length > 40 ? '...' : ''})`
          );
          // Mark as completed and record skip stats
          state.completedChecks.add(checkId);
          const stats: CheckExecutionStats = {
            checkName: checkId,
            totalRuns: 0,
            successfulRuns: 0,
            failedRuns: 0,
            skippedRuns: 0,
            skipped: true,
            skipReason: 'assume',
            totalDuration: 0,
            issuesFound: 0,
            issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
          };
          state.stats.set(checkId, stats);
          const emptyResult: ReviewSummary = { issues: [] };
          try {
            Object.defineProperty(emptyResult as any, '__skipped', {
              value: 'assume',
              enumerable: false,
            });
          } catch {}
          try {
            context.journal.commitEntry({
              sessionId: context.sessionId,
              checkId,
              result: emptyResult as any,
              event: context.event || 'manual',
              scope,
            });
          } catch {}
          emitEvent({ type: 'CheckCompleted', checkId, scope, result: emptyResult });
          return emptyResult;
        }
      }
    }

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
      {
        'visor.check.id': checkId,
        'visor.check.type': providerType,
        session_id: context.sessionId,
        wave: state.wave,
      },
      async () => provider.execute(prInfo, providerConfig, dependencyResults, executionContext)
    );

    // Special case: human-input style checks that intentionally pause the run
    // (e.g., Slack SocketMode awaiting a reply) surface a marker on the result.
    // When we see this, mark the run state so WavePlanning can terminate cleanly
    // after this level instead of continuing to downstream checks.
    try {
      const awaitingHumanInput =
        (result as any)?.awaitingHumanInput === true ||
        ((result as any)?.output && (result as any).output.awaitingHumanInput === true);
      if (awaitingHumanInput) {
        (state as any).flags = (state as any).flags || {};
        (state as any).flags.awaitingHumanInput = true;
        logger.info(
          `[LevelDispatch] Set awaitingHumanInput=true for check ${checkId} (wave=${state.wave})`
        );
      }
    } catch (e) {
      logger.warn(`[LevelDispatch] Failed to check awaitingHumanInput flag: ${e}`);
    }

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

    // Validate output against JSON Schema if provided (non-fatal contract)
    try {
      let schemaObj =
        (typeof checkConfig.schema === 'object' ? (checkConfig.schema as any) : undefined) ||
        (checkConfig as any).output_schema;
      if (!schemaObj && typeof (checkConfig as any).schema === 'string') {
        try {
          const { loadRendererSchema } = await import('../dispatch/renderer-schema');
          schemaObj = await loadRendererSchema((checkConfig as any).schema as string);
        } catch {}
      }
      if (schemaObj && (enrichedResult as any)?.output !== undefined) {
        const Ajv = require('ajv');
        const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false });
        const validate = ajv.compile(schemaObj);
        const valid = validate((enrichedResult as any).output);
        if (!valid) {
          const errs = (validate.errors || [])
            .slice(0, 3)
            .map((e: any) => e.message)
            .join('; ');
          const issue: ReviewIssue = {
            file: 'contract',
            line: 0,
            ruleId: `contract/schema_validation_failed`,
            message: `Output schema validation failed${errs ? `: ${errs}` : ''}`,
            severity: 'error',
            category: 'logic',
            checkName: checkId,
            group: checkConfig.group,
            schema: 'json-schema',
            timestamp: Date.now(),
          } as any;
          enrichedResult.issues = [...(enrichedResult.issues || []), issue];
        }
      }
    } catch {}

    // Evaluate guarantee contract after execution (non-fatal)
    try {
      const guaranteeExpr = (checkConfig as any)?.guarantee as string | string[] | undefined;
      if (guaranteeExpr) {
        const evaluator = new FailureConditionEvaluator();
        const exprs = Array.isArray(guaranteeExpr) ? guaranteeExpr : [guaranteeExpr];
        for (const ex of exprs) {
          const holds = await evaluator.evaluateIfCondition(checkId, ex, {
            previousResults: dependencyResults as any,
            event: context.event || 'manual',
            output: enrichedResult.output,
          } as any);
          if (!holds) {
            const issue: ReviewIssue = {
              file: 'contract',
              line: 0,
              ruleId: `contract/guarantee_failed`,
              message: `Guarantee failed: ${ex}`,
              severity: 'error',
              category: 'logic',
              checkName: checkId,
              group: checkConfig.group,
              schema:
                typeof checkConfig.schema === 'object' ? 'custom' : (checkConfig.schema as any),
              timestamp: Date.now(),
            } as any;
            enrichedResult.issues = [...(enrichedResult.issues || []), issue];
          }
        }
      }
    } catch {}

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
        // Early exit: persist result and stop further processing to avoid
        // undefined-state follow-on work (routing/template/per-item commits).
        try {
          // Record completion BEFORE storing
          state.completedChecks.add(checkId);
          const currentWaveCompletions = (state as any).currentWaveCompletions as
            | Set<string>
            | undefined;
          if (currentWaveCompletions) currentWaveCompletions.add(checkId);

          // Update aggregated stats for forEach parent (failed run, 0 outputs)
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
          aggStats.failedRuns++;
          aggStats.outputsProduced = 0;
          state.stats.set(checkId, aggStats);

          // Store in journal
          context.journal.commitEntry({
            sessionId: context.sessionId,
            checkId,
            result: enrichedResult as any,
            event: context.event || 'manual',
            scope: [],
          });
        } catch (err) {
          logger.warn(`[LevelDispatch] Failed to persist undefined forEach result: ${err}`);
        }

        // Clear active dispatch and emit completion event
        try {
          state.activeDispatches.delete(checkId);
        } catch {}
        emitEvent({
          type: 'CheckCompleted',
          checkId,
          scope: [],
          result: enrichedResult,
        });
        return enrichedResult as ReviewSummary;
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
        logger.debug(
          `[LevelDispatch] Template rendered for ${checkId}: ${renderedContent.length} chars`
        );
        // Emit Mermaid diagram events from the rendered content
        emitMermaidFromMarkdown(checkId, renderedContent, 'content');
      } else {
        logger.debug(`[LevelDispatch] No template content rendered for ${checkId}`);
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
      (ruleId.endsWith('_fail_if') && ruleId !== 'global_fail_if') // check-level fail_if only
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
        (ruleId.endsWith('_fail_if') && ruleId !== 'global_fail_if') // check-level fail_if only
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
      logger.debug(`[LevelDispatch] Using inline template for ${checkId}`);
    } else if (checkConfig.template && checkConfig.template.file) {
      // Securely resolve relative file path
      const file = String(checkConfig.template.file);
      const resolved = path.resolve(process.cwd(), file);
      templateContent = await fs.readFile(resolved, 'utf-8');
      logger.debug(`[LevelDispatch] Using template file for ${checkId}: ${resolved}`);
    } else if (schema && schema !== 'plain') {
      // Built-in schema template fallback
      const sanitized = String(schema).replace(/[^a-zA-Z0-9-]/g, '');
      if (sanitized) {
        // When bundled with ncc, __dirname is dist/ and output/ is at dist/output/
        // When running from source, __dirname is src/state-machine/states/ and output/ is at output/
        const candidatePaths = [
          path.join(__dirname, 'output', sanitized, 'template.liquid'), // bundled: dist/output/
          path.join(__dirname, '..', '..', 'output', sanitized, 'template.liquid'), // source (from state-machine/states)
          path.join(__dirname, '..', '..', '..', 'output', sanitized, 'template.liquid'), // source (alternate)
          path.join(process.cwd(), 'output', sanitized, 'template.liquid'), // fallback: cwd/output/
          path.join(process.cwd(), 'dist', 'output', sanitized, 'template.liquid'), // fallback: cwd/dist/output/
        ];
        for (const p of candidatePaths) {
          try {
            templateContent = await fs.readFile(p, 'utf-8');
            if (templateContent) {
              logger.debug(`[LevelDispatch] Using schema template for ${checkId}: ${p}`);
              break;
            }
          } catch {
            // try next
          }
        }
        if (!templateContent) {
          logger.debug(
            `[LevelDispatch] No template found for schema '${sanitized}' (tried ${candidatePaths.length} paths)`
          );
        }
      }
    }

    if (!templateContent) {
      // No template to render
      logger.debug(`[LevelDispatch] No template content found for ${checkId}`);
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

    // Ensure output is an object, not a JSON string
    // If output is a string that looks like JSON, parse it
    let output = (reviewSummary as any).output;
    if (typeof output === 'string') {
      const trimmed = output.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          output = JSON.parse(trimmed);
        } catch {
          // Not valid JSON, keep as string
        }
      }
    }

    const templateData: Record<string, unknown> = {
      issues: reviewSummary.issues || [],
      checkName: checkId,
      output,
    };

    logger.debug(
      `[LevelDispatch] Rendering template for ${checkId} with output keys: ${output && typeof output === 'object' ? Object.keys(output).join(', ') : 'none'}`
    );

    const rendered = await liquid.parseAndRender(templateContent, templateData);
    logger.debug(
      `[LevelDispatch] Template rendered successfully for ${checkId}: ${rendered.length} chars, trimmed: ${rendered.trim().length} chars`
    );
    return rendered.trim();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`[LevelDispatch] Failed to render template for ${checkId}: ${msg}`);
    return undefined;
  }
}
