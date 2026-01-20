import type { EngineContext, EngineEvent, EngineState, RunState } from '../../types/engine';
import type { ReviewIssue, ReviewSummary } from '../../reviewer';
import { logger } from '../../logger';
import { emitNdjsonSpanWithEvents } from '../../telemetry/fallback-ndjson';
import { withActiveSpan } from '../../telemetry/trace-helpers';
import type { CheckProviderConfig } from '../../providers/check-provider.interface';
import { buildOutputHistoryFromJournal } from './history-snapshot';
import { buildDependencyResultsWithScope } from './dependency-gating';
import { updateStats, hasFatalIssues } from './stats-manager';
import { handleRouting, checkLoopBudget, evaluateGoto } from '../states/routing';

/**
 * Execute a check once per forEach item (map fanout path).
 * Extracted from LevelDispatch without behavior change.
 */
export async function executeCheckWithForEachItems(
  checkId: string,
  forEachParent: string,
  forEachItems: unknown[],
  context: EngineContext,
  state: RunState,
  emitEvent: (event: EngineEvent) => void,
  transition: (newState: EngineState) => void
): Promise<ReviewSummary> {
  // Tactical correctness fix: re-read the parent's aggregated forEachItems
  try {
    const snapId = context.journal.beginSnapshot();
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
              `[LevelDispatch] Refreshing forEachItems for ${checkId}: from parent '${forEachParent}' latestItems=${newLen} (was ${prevLen})`
            );
          }
        } catch {}
      }
      forEachItems = latestItems as unknown[];
    }
  } catch (e) {
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

  // Emit a banner for the forEach parent so logs clearly show when we are
  // entering the aggregated execution for that step.
  try {
    const wave = state.wave;
    const lvl = (state as any).currentLevel ?? '?';
    const banner = `━━━ CHECK ${checkId} (wave ${wave}, level ${lvl}, forEach parent) ━━━`;
    const isTTY = typeof process !== 'undefined' ? !!process.stderr.isTTY : false;
    const outputFormat = process.env.VISOR_OUTPUT_FORMAT || '';
    const isJsonLike = outputFormat === 'json' || outputFormat === 'sarif';
    if (isTTY && !isJsonLike) {
      const cyan = '\x1b[36m';
      const reset = '\x1b[0m';
      logger.info(`${cyan}${banner}${reset}`);
    } else {
      logger.info(banner);
    }
  } catch {
    // best-effort only
  }

  for (let itemIndex = 0; itemIndex < forEachItems.length; itemIndex++) {
    const iterationStartMs = Date.now();
    const scope: Array<{ check: string; index: number }> = [
      { check: forEachParent, index: itemIndex },
    ];

    const forEachItem = forEachItems[itemIndex];
    logger.info(
      `[LevelDispatch][DEBUG] Starting iteration ${itemIndex} of ${checkId}, parent=${forEachParent}, item=${JSON.stringify(forEachItem)?.substring(0, 100)}`
    );

    const shouldSkipDueToParentFailure =
      (forEachItem as any)?.__failed === true || (forEachItem as any)?.__skip === true;
    if (shouldSkipDueToParentFailure) {
      logger.info(
        `⏭  Skipped ${checkId} iteration ${itemIndex} (forEach parent "${forEachParent}" iteration ${itemIndex} marked as failed)`
      );
      const iterationDurationMs = Date.now() - iterationStartMs;
      perIterationDurations.push(iterationDurationMs);
      perItemResults.push({ issues: [] });
      allOutputs.push({ __skip: true });
      continue;
    }

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

    emitEvent({ type: 'CheckScheduled', checkId, scope });

    const dispatch = {
      id: `${checkId}-${itemIndex}-${Date.now()}`,
      checkId,
      scope,
      provider: context.checks[checkId]?.providerType || 'unknown',
      startMs: Date.now(),
      attempts: 1,
      foreachIndex: itemIndex,
    };
    state.activeDispatches.set(`${checkId}-${itemIndex}`, dispatch as any);

    try {
      const providerType = checkConfig.type || 'ai';
      const providerRegistry =
        require('../../providers/check-provider-registry').CheckProviderRegistry.getInstance();
      const provider = providerRegistry.getProviderOrThrow(providerType);

      const outputHistory = buildOutputHistoryFromJournal(context);

      const providerConfig: CheckProviderConfig = {
        type: providerType,
        checkName: checkId,
        prompt: checkConfig.prompt,
        exec: checkConfig.exec,
        schema: checkConfig.schema,
        group: checkConfig.group,
        focus:
          checkConfig.focus ||
          ((): string => {
            const focusMap: Record<string, string> = {
              security: 'security',
              performance: 'performance',
              style: 'style',
              architecture: 'architecture',
            };
            return focusMap[checkId] || 'all';
          })(),
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

      const dependencyResults = buildDependencyResultsWithScope(
        checkId,
        checkConfig,
        context,
        scope
      );

      // Per-item dependency gating for map fanout
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
              if (!dr) failed = true;
              else {
                const out: any = (dr as any).output;
                const fatal = hasFatalIssues(dr as any);
                failed = fatal || (!!out && typeof out === 'object' && out.__failed === true);
                skipped = !!(out && typeof out === 'object' && out.__skip === true);
              }
              const satisfied = !skipped && (!failed || cont);
              if (satisfied) return true;
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
            if (context.debug) {
              logger.info(
                `[LevelDispatch] Skipping ${checkId} iteration ${itemIndex} due to unsatisfied dependency group(s)`
              );
            }
            const iterationDurationMs = Date.now() - iterationStartMs;
            perIterationDurations.push(iterationDurationMs);
            perItemResults.push({ issues: [] });
            allOutputs.push({ __skip: true });
            continue;
          }
        }
      } catch {}

      const prInfo: any = context.prInfo || {
        number: 1,
        title: 'State Machine Execution',
        author: 'system',
        eventType: context.event || 'manual',
        eventContext: {},
        files: [],
        commits: [],
      };
      const executionContext = {
        ...context.executionContext,
        _engineMode: context.mode,
        _parentContext: context,
        _parentState: state,
      };

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

      const enrichedIssues = (result.issues || []).map((issue: ReviewIssue) => ({
        ...issue,
        checkName: checkId,
        ruleId: `${checkId}/${issue.ruleId || 'unknown'}`,
        group: checkConfig.group,
        schema: typeof checkConfig.schema === 'object' ? 'custom' : checkConfig.schema,
        template: checkConfig.template,
        timestamp: Date.now(),
      }));

      const enrichedResult: any = { ...result, issues: enrichedIssues };

      // Update stats for this iteration
      const iterationDurationMs = Date.now() - iterationStartMs;
      perIterationDurations.push(iterationDurationMs);
      updateStats(
        [{ checkId, result: enrichedResult as any, duration: iterationDurationMs }],
        state,
        true
      );

      // Commit per-iteration journal result (scoped)
      try {
        context.journal.commitEntry({
          sessionId: context.sessionId,
          checkId,
          result: enrichedResult as any,
          event: context.event || 'manual',
          scope,
        });
        logger.info(
          `[LevelDispatch][DEBUG] Committing to journal: checkId=${checkId}, scope=${JSON.stringify(scope)}, hasOutput=${enrichedResult.output !== undefined}`
        );
      } catch (error) {
        logger.warn(`[LevelDispatch] Failed to commit per-iteration result to journal: ${error}`);
      }

      // Record per-item summary and aggregate outputs/contents
      perItemResults.push(enrichedResult);
      if ((enrichedResult as any).content)
        allContents.push(String((enrichedResult as any).content));
      if ((enrichedResult as any).output !== undefined)
        allOutputs.push((enrichedResult as any).output);
      allIssues.push(...(enrichedResult.issues || []));

      // Emit completion for iteration
      emitEvent({ type: 'CheckCompleted', checkId, scope, result: enrichedResult });
    } catch (error) {
      const iterationDurationMs = Date.now() - iterationStartMs;
      perIterationDurations.push(iterationDurationMs);
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(
        `[LevelDispatch] Error executing ${checkId} iteration ${itemIndex}: ${err.message}`
      );
      updateStats(
        [
          {
            checkId,
            result: {
              issues: [
                {
                  severity: 'error',
                  category: 'logic',
                  ruleId: `${checkId}/error`,
                  file: 'system',
                  line: 0,
                  message: err.message,
                  timestamp: Date.now(),
                } as any,
              ],
            } as any,
            error: err,
            duration: iterationDurationMs,
          },
        ],
        state,
        true
      );
      allOutputs.push({ __failed: true });
      perItemResults.push({
        issues: [
          {
            severity: 'error',
            category: 'logic',
            ruleId: `${checkId}/error`,
            file: 'system',
            line: 0,
            message: err.message,
            timestamp: Date.now(),
          } as any,
        ],
      });
      emitEvent({
        type: 'CheckErrored',
        checkId,
        scope,
        error: { message: err.message, stack: err.stack, name: err.name },
      });
    } finally {
      state.activeDispatches.delete(`${checkId}-${itemIndex}`);
    }
  }

  // Update forEach metadata in stats (same behavior)
  const checkStats = state.stats.get(checkId);
  if (checkStats) {
    checkStats.outputsProduced = allOutputs.length;
    checkStats.perIterationDuration = perIterationDurations;
    const previewItems = allOutputs.slice(0, 3).map(item => {
      const str = typeof item === 'string' ? item : (JSON.stringify(item) ?? 'undefined');
      return str.length > 50 ? str.substring(0, 50) + '...' : str;
    });
    checkStats.forEachPreview =
      allOutputs.length > 3 ? [...previewItems, `...${allOutputs.length - 3} more`] : previewItems;
    state.stats.set(checkId, checkStats);
    if (checkStats.totalRuns > 0 && checkStats.failedRuns === checkStats.totalRuns) {
      logger.info(
        `[LevelDispatch] forEach check ${checkId} failed completely (${checkStats.failedRuns}/${checkStats.totalRuns} iterations failed)`
      );
      (state as any).failedChecks = (state as any).failedChecks || new Set<string>();
      (state as any).failedChecks.add(checkId);
    }
  }

  // Aggregated result
  const aggregatedResult: any = {
    issues: allIssues,
    isForEach: true,
    forEachItems: allOutputs,
    forEachItemResults: perItemResults,
    ...(allContents.length > 0 ? { content: allContents.join('\n') } : {}),
  };

  logger.info(
    `[LevelDispatch][DEBUG] Aggregated result for ${checkId}: forEachItems.length=${allOutputs.length}, results=${perItemResults.length}`
  );
  logger.info(`[LevelDispatch][DEBUG] allOutputs: ${JSON.stringify(allOutputs).substring(0, 200)}`);

  // Route aggregated child before commit
  try {
    logger.info(`[LevelDispatch] Calling handleRouting for ${checkId}`);
  } catch {}
  try {
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

  emitEvent({ type: 'CheckCompleted', checkId, scope: [], result: aggregatedResult });

  // on_finish for forEach parent after children complete (as before)
  const parentCheckConfig = context.config.checks?.[forEachParent];
  logger.info(
    `[LevelDispatch][DEBUG] Checking on_finish for forEach parent ${forEachParent}: has_on_finish=${!!parentCheckConfig?.on_finish}, is_forEach=${!!parentCheckConfig?.forEach}`
  );

  if (parentCheckConfig?.on_finish && parentCheckConfig.forEach) {
    logger.info(
      `[LevelDispatch] Processing on_finish for forEach parent ${forEachParent} after children complete`
    );
    try {
      const snapshotId = context.journal.beginSnapshot();
      const { ContextView } = require('../../snapshot-store');
      const contextView = new ContextView(
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

        const onFinish = parentCheckConfig.on_finish;

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
            if (checkLoopBudget(context, state, 'on_finish', 'run')) {
              const errorIssue: ReviewIssue = {
                file: 'system',
                line: 0,
                ruleId: `${forEachParent}/routing/loop_budget_exceeded`,
                message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? 10}) during on_finish run`,
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
              } catch (err) {
                logger.warn(
                  `[LevelDispatch] Failed to commit parent result with loop budget error: ${err}`
                );
              }
              return aggregatedResult;
            }
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

        // Debug for goto_js (guarded)
        if (context.debug) {
          logger.info(
            `[LevelDispatch] Evaluating on_finish.goto_js for forEach parent: ${forEachParent}`
          );
          if (onFinish.goto_js)
            logger.info(`[LevelDispatch] goto_js code: ${onFinish.goto_js.substring(0, 200)}`);
          try {
            const snapshotId2 = context.journal.beginSnapshot();
            const all = context.journal.readVisible(context.sessionId, snapshotId2, undefined);
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
        if (context.debug)
          logger.info(`[LevelDispatch] goto_js evaluation result: ${gotoTarget || 'null'}`);

        if (gotoTarget) {
          if (queuedForward && gotoTarget === forEachParent) {
            logger.info(
              `[LevelDispatch] on_finish.goto to self (${gotoTarget}) deferred, will process after WaveRetry`
            );
            emitEvent({ type: 'WaveRetry', reason: 'on_finish' });
          } else {
            if (checkLoopBudget(context, state, 'on_finish', 'goto')) {
              const errorIssue: ReviewIssue = {
                file: 'system',
                line: 0,
                ruleId: `${forEachParent}/routing/loop_budget_exceeded`,
                message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? 10}) during on_finish goto`,
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
              return aggregatedResult;
            }
            state.routingLoopCount++;
            emitEvent({ type: 'ForwardRunRequested', target: gotoTarget, origin: 'goto' });
          }
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
        }
      }
    } catch {}
  }

  return aggregatedResult;
}
