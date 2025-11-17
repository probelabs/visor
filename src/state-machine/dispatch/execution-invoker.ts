import type { EngineContext, EngineEvent, EngineState, RunState } from '../../types/engine';
import type { ReviewIssue, ReviewSummary } from '../../reviewer';
import type { CheckExecutionStats } from '../../types/execution';
import type { CheckConfig } from '../../types/config';
import { logger } from '../../logger';
import { withActiveSpan } from '../../telemetry/trace-helpers';
import { emitMermaidFromMarkdown } from '../../utils/mermaid-telemetry';
import { emitNdjsonFallback } from '../../telemetry/fallback-ndjson';
import { buildOutputHistoryFromJournal } from './history-snapshot';
import { buildDependencyResultsWithScope } from './dependency-gating';
import { renderTemplateContent } from './template-renderer';
import { hasFatalIssues } from './stats-manager';
import { handleRouting } from '../states/routing';
import { executeCheckWithForEachItems } from './foreach-processor';

/**
 * Execute a single check with provider integration (non-forEach path, but handles forEach parent outputs
 * and can redirect to forEach processor upstream).
 *
 * Note: for deciding whether to run, this function relies on the provided evaluateIf callback.
 */
export async function executeSingleCheck(
  checkId: string,
  context: EngineContext,
  state: RunState,
  emitEvent: (event: EngineEvent) => void,
  transition: (newState: EngineState) => void,
  evaluateIf: (
    checkId: string,
    checkConfig: CheckConfig,
    context: EngineContext,
    state: RunState
  ) => Promise<boolean>,
  scopeOverride?: Array<{ check: string; index: number }>
): Promise<ReviewSummary> {
  const checkConfig = context.config.checks?.[checkId];

  // Evaluate 'if' condition before execution
  if (checkConfig?.if) {
    const shouldRun = await evaluateIf(checkId, checkConfig, context, state);
    if (!shouldRun) {
      logger.info(`⏭  Skipped (if: ${checkConfig.if.substring(0, 40)}${checkConfig.if.length > 40 ? '...' : ''})`);
      const emptyResult: ReviewSummary = { issues: [] };
      try { Object.defineProperty(emptyResult as any, '__skipped', { value: 'if_condition', enumerable: false }); } catch {}
      state.completedChecks.add(checkId);
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
        issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
      };
      state.stats.set(checkId, stats);
      logger.info(`[LevelDispatch] Recorded skip stats for ${checkId}: skipReason=if_condition`);
      try { context.journal.commitEntry({ sessionId: context.sessionId, checkId, result: emptyResult as any, event: context.event || 'manual', scope: [] }); } catch (error) {
        logger.warn(`[LevelDispatch] Failed to commit skipped result to journal: ${error}`);
      }
      emitEvent({ type: 'CheckCompleted', checkId, scope: [], result: emptyResult });
      return emptyResult;
    }
  }

  const dependencies = checkConfig?.depends_on || [];
  const depList = Array.isArray(dependencies) ? dependencies : [dependencies];

  // Dependency gating with continue_on_failure and OR groups
  const failedChecks = (state as any).failedChecks as Set<string> | undefined;
  const tokens = (depList.filter(Boolean) as string[]);
  const groupSatisfied = (token: string): boolean => {
    const options = token.includes('|') ? token.split('|').map(s => s.trim()).filter(Boolean) : [token];
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
    for (const t of tokens) { if (!groupSatisfied(t)) { allOk = false; break; } }
    if (!allOk) {
      const emptyResult: ReviewSummary = { issues: [] };
      try { Object.defineProperty(emptyResult as any, '__skipped', { value: 'dependency_failed', enumerable: false }); } catch {}
      state.completedChecks.add(checkId);
      (state as any).failedChecks = (state as any).failedChecks || new Set<string>();
      (state as any).failedChecks.add(checkId);
      const stats: CheckExecutionStats = {
        checkName: checkId,
        totalRuns: 0, successfulRuns: 0, failedRuns: 0, skippedRuns: 0,
        skipped: true, skipReason: 'dependency_failed', totalDuration: 0, issuesFound: 0,
        issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
      };
      state.stats.set(checkId, stats);
      try { context.journal.commitEntry({ sessionId: context.sessionId, checkId, result: emptyResult as any, event: context.event || 'manual', scope: [] }); } catch (error) {
        logger.warn(`[LevelDispatch] Failed to commit empty result to journal: ${error}`);
      }
      emitEvent({ type: 'CheckCompleted', checkId, scope: [], result: emptyResult });
      return emptyResult;
    }
  }

  let forEachParent: string | undefined;
  let forEachItems: unknown[] | undefined;
  for (const depId of depList) {
    if (!depId) continue;
    try {
      const snapshotId = context.journal.beginSnapshot();
      const { ContextView } = require('../../snapshot-store');
      const contextView = new ContextView(context.journal, context.sessionId, snapshotId, [], context.event);
      const depResult: any = contextView.get(depId);
      if (depResult?.forEachItems && Array.isArray(depResult.forEachItems)) {
        forEachParent = depId;
        forEachItems = depResult.forEachItems;
        break;
      }
    } catch {}
  }

  // If there's a forEach parent and items, decide fanout here (map vs reduce)
  if (forEachParent && forEachItems !== undefined) {
    let fanoutMode: 'map' | 'reduce' = 'reduce';
    const explicit = (checkConfig as any)?.fanout as 'map' | 'reduce' | undefined;
    if (explicit === 'map' || explicit === 'reduce') fanoutMode = explicit;
    else {
      const providerType = context.checks[checkId]?.providerType || '';
      const reduceProviders = new Set(['log', 'memory', 'script', 'workflow', 'noop']);
      fanoutMode = reduceProviders.has(providerType) ? 'reduce' : 'map';
    }
    if (fanoutMode === 'map') {
      if ((forEachItems as unknown[]).length === 0) {
        logger.info(`⏭  Skipped (forEach parent "${forEachParent}" has 0 items)`);
        const emptyResult: ReviewSummary = { issues: [] };
        try { Object.defineProperty(emptyResult as any, '__skipped', { value: 'forEach_empty', enumerable: false }); } catch {}
        state.completedChecks.add(checkId);
        // Mark as failed for dependents if parent failed
        let derivedSkipReason: 'forEach_empty' | 'dependency_failed' = 'forEach_empty';
        try {
          const parentFailed = !!((state as any).failedChecks && (state as any).failedChecks.has(forEachParent)) || (() => { const s = state.stats.get(forEachParent); return !!(s && (s.failedRuns || 0) > 0); })();
          if (parentFailed) derivedSkipReason = 'dependency_failed';
        } catch {}
        const stats: CheckExecutionStats = { checkName: checkId, totalRuns: 0, successfulRuns: 0, failedRuns: 0, skippedRuns: 0, skipped: true, skipReason: derivedSkipReason, totalDuration: 0, issuesFound: 0, issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 } };
        state.stats.set(checkId, stats);
        try { context.journal.commitEntry({ sessionId: context.sessionId, checkId, result: emptyResult as any, event: context.event || 'manual', scope: [] }); } catch (error) { logger.warn(`[LevelDispatch] Failed to commit empty result to journal: ${error}`); }
        emitEvent({ type: 'CheckCompleted', checkId, scope: [], result: emptyResult });
        return emptyResult;
      }
      return await executeCheckWithForEachItems(checkId, forEachParent, forEachItems as unknown[], context, state, emitEvent, transition);
    }
    // fanout reduce → fall through to normal single execution
  }

  // Normal execution without forEach
  const scope: Array<{ check: string; index: number }> = scopeOverride || [];
  emitEvent({ type: 'CheckScheduled', checkId, scope });

  const startTime = Date.now();
  const dispatch: any = {
    id: `${checkId}-${Date.now()}`,
    checkId,
    scope,
    provider: context.checks[checkId]?.providerType || 'unknown',
    startMs: startTime,
    attempts: 1,
  };
  state.activeDispatches.set(checkId, dispatch);

  try {
    if (!checkConfig) throw new Error(`Check configuration not found: ${checkId}`);
    const providerType = checkConfig.type || 'ai';
    const providerRegistry = require('../../providers/check-provider-registry').CheckProviderRegistry.getInstance();
    const provider = providerRegistry.getProviderOrThrow(providerType);

    const outputHistory = buildOutputHistoryFromJournal(context);
    const providerConfig: any = {
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
      ai: { ...(checkConfig.ai || {}), timeout: checkConfig.ai?.timeout || 600000, debug: !!context.debug },
    };

    const dependencyResults = buildDependencyResultsWithScope(checkId, checkConfig, context, scope);
    const prInfo: any = context.prInfo || { number: 1, title: 'State Machine Execution', author: 'system', eventType: context.event || 'manual', eventContext: {}, files: [], commits: [] };
    const executionContext = { ...context.executionContext, _engineMode: context.mode, _parentContext: context, _parentState: state };

    try { emitNdjsonFallback('visor.provider', { 'visor.check.id': checkId, 'visor.provider.type': providerType }); } catch {}

    const result = await withActiveSpan(`visor.check.${checkId}`, { 'visor.check.id': checkId, 'visor.check.type': providerType }, async () => provider.execute(prInfo, providerConfig, dependencyResults, executionContext));

    const enrichedIssues = (result.issues || []).map((issue: ReviewIssue) => ({
      ...issue, checkName: checkId, ruleId: `${checkId}/${issue.ruleId || 'unknown'}`, group: checkConfig.group, schema: typeof checkConfig.schema === 'object' ? 'custom' : checkConfig.schema, template: checkConfig.template, timestamp: Date.now(),
    }));
    const enrichedResult: any = { ...result, issues: enrichedIssues };

    // Handle forEach:true output from provider (convert to items)
    let isForEach = false;
    let forEachItemsLocal: unknown[] | undefined;
    if (checkConfig.forEach) {
      const output = (result as any).output;
      if (Array.isArray(output)) { isForEach = true; forEachItemsLocal = output; enrichedResult.isForEach = true; enrichedResult.forEachItems = output; }
      else {
        if (context.debug) logger.warn(`[LevelDispatch] Check ${checkId} has forEach:true but output is not an array: ${typeof output}, converting to single-item array`);
        isForEach = true; forEachItemsLocal = [output]; enrichedResult.isForEach = true; enrichedResult.forEachItems = [output];
      }
    }
    if ((result as any).isForEach) enrichedResult.isForEach = true;
    if ((result as any).forEachItems) enrichedResult.forEachItems = (result as any).forEachItems;
    if ((result as any).forEachItemResults) enrichedResult.forEachItemResults = (result as any).forEachItemResults;
    if ((result as any).forEachFatalMask) enrichedResult.forEachFatalMask = (result as any).forEachFatalMask;

    let renderedContent: string | undefined;
    try {
      renderedContent = await renderTemplateContent(checkId, checkConfig, enrichedResult);
      if (renderedContent) emitMermaidFromMarkdown(checkId, renderedContent, 'content');
    } catch (error) {
      logger.warn(`[LevelDispatch] Failed to render template for ${checkId}: ${error}`);
    }

    let outputWithTimestamp: any = undefined;
    if ((result as any).output !== undefined) {
      const output = (result as any).output;
      if (output !== null && typeof output === 'object' && !Array.isArray(output)) outputWithTimestamp = { ...output, ts: Date.now() };
      else outputWithTimestamp = output;
    }

    const enrichedResultWithContent = renderedContent ? { ...enrichedResult, content: renderedContent } : enrichedResult;
    const enrichedResultWithTimestamp = outputWithTimestamp !== undefined ? { ...enrichedResultWithContent, output: outputWithTimestamp } : enrichedResultWithContent;

    state.completedChecks.add(checkId);
    const currentWaveCompletions = (state as any).currentWaveCompletions as Set<string> | undefined;
    if (currentWaveCompletions) currentWaveCompletions.add(checkId);

    // Process routing (fail_if, on_success, on_fail) BEFORE storing in journal
    // Same behavior as inlined version in LevelDispatch so routing errors are captured.
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

    try {
      const commitResult: any = {
        ...enrichedResult,
        ...(renderedContent ? { content: renderedContent } : {}),
        ...((result as any).output !== undefined ? (outputWithTimestamp !== undefined ? { output: outputWithTimestamp } : { output: (result as any).output }) : {}),
      };
      context.journal.commitEntry({ sessionId: context.sessionId, checkId, result: commitResult, event: context.event || 'manual', scope });
    } catch (error) {
      logger.warn(`[LevelDispatch] Failed to commit to journal: ${error}`);
    }

    // Apply stats here to ensure visibility even if upper-level aggregation changes
    try {
      const duration = Date.now() - startTime;
      // Mark result to avoid double counting in LevelDispatch's end-of-level updateStats
      try { Object.defineProperty(enrichedResult as any, '__stats_applied', { value: true, enumerable: false }); } catch {}
      const { updateStats } = await import('./stats-manager');
      updateStats([{ checkId, result: enrichedResult as any, duration }], state, false);
    } catch {}

    if (isForEach) {
      try {
        const existing = state.stats.get(checkId);
        const aggStats: CheckExecutionStats = existing || { checkName: checkId, totalRuns: 0, successfulRuns: 0, failedRuns: 0, skippedRuns: 0, skipped: false, totalDuration: 0, issuesFound: 0, issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 } };
        aggStats.totalRuns++;
        const hasFatal = hasFatalIssues(enrichedResultWithTimestamp as any);
        if (hasFatal) aggStats.failedRuns++; else aggStats.successfulRuns++;
        const items = (enrichedResultWithTimestamp as any).forEachItems;
        if (Array.isArray(items)) aggStats.outputsProduced = items.length;
        state.stats.set(checkId, aggStats);
      } catch {}
    }

    if (isForEach && forEachItemsLocal && Array.isArray(forEachItemsLocal)) {
      for (let itemIndex = 0; itemIndex < forEachItemsLocal.length; itemIndex++) {
        const itemScope: Array<{ check: string; index: number }> = [{ check: checkId, index: itemIndex }];
        const item = forEachItemsLocal[itemIndex];
        try { context.journal.commitEntry({ sessionId: context.sessionId, checkId, result: { issues: [], output: item } as any, event: context.event || 'manual', scope: itemScope }); } catch (error) {
          logger.warn(`[LevelDispatch] Failed to commit per-item journal for ${checkId} item ${itemIndex}: ${error}`);
        }
      }
    }

    state.activeDispatches.delete(checkId);
    emitEvent({ type: 'CheckCompleted', checkId, scope, result: { ...enrichedResult, output: (result as any).output, content: renderedContent || (result as any).content } });
    return enrichedResult;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(`[LevelDispatch] Error executing check ${checkId}: ${err.message}`);
    state.activeDispatches.delete(checkId);
    emitEvent({ type: 'CheckErrored', checkId, scope, error: { message: err.message, stack: err.stack, name: err.name } });
    throw err;
  }
}

function mapCheckNameToFocus(checkName: string): string {
  const focusMap: Record<string, string> = { security: 'security', performance: 'performance', style: 'style', architecture: 'architecture' };
  return focusMap[checkName] || 'all';
}
