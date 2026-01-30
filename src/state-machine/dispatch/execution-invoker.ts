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
import { updateStats } from './stats-manager';
import type { OnInitConfig, OnInitRunItem } from '../../types/config';
import {
  executeToolInvocation,
  executeStepInvocation,
  executeWorkflowInvocation,
  type Scope,
} from './on-init-handlers';
import { createSecureSandbox, compileAndRun } from '../../utils/sandbox';

/**
 * Normalize on_init.run items to array format
 * Supports backward compatibility with string arrays
 */
function normalizeRunItems(run: OnInitRunItem[]): OnInitRunItem[] {
  if (!Array.isArray(run)) return [];
  return run.filter(Boolean);
}

/**
 * Detect the type of on_init invocation
 * @returns 'tool' | 'step' | 'workflow'
 */
function detectInvocationType(item: OnInitRunItem): 'tool' | 'step' | 'workflow' {
  if (typeof item === 'string') return 'step'; // Backward compat: plain step name
  if ('tool' in item) return 'tool';
  if ('workflow' in item) return 'workflow';
  if ('step' in item) return 'step';
  // Throw error for unknown types instead of silently falling back
  throw new Error(
    `Invalid on_init item type: ${JSON.stringify(item)}. Must specify tool, step, or workflow.`
  );
}

/**
 * Execute a single on_init item (tool, step, or workflow)
 */
async function executeOnInitItem(
  item: OnInitRunItem,
  context: EngineContext,
  scope: Scope,
  prInfo: any,
  dependencyResults: Record<string, unknown>,
  executionContext: any
): Promise<{ output: unknown; outputName: string }> {
  const itemType = detectInvocationType(item);

  let output: unknown;
  let outputName: string;

  switch (itemType) {
    case 'tool': {
      const toolItem = item as { tool: string; with?: Record<string, unknown>; as?: string };
      output = await executeToolInvocation(
        toolItem,
        context,
        scope,
        prInfo,
        dependencyResults,
        executionContext
      );
      outputName = toolItem.as || toolItem.tool;
      break;
    }

    case 'step': {
      if (typeof item === 'string') {
        // Backward compat: plain step name
        const stepItem = { step: item, with: undefined, as: item };
        output = await executeStepInvocation(
          stepItem,
          context,
          scope,
          prInfo,
          dependencyResults,
          executionContext
        );
        outputName = item;
      } else {
        const stepItem = item as { step: string; with?: Record<string, unknown>; as?: string };
        output = await executeStepInvocation(
          stepItem,
          context,
          scope,
          prInfo,
          dependencyResults,
          executionContext
        );
        outputName = stepItem.as || stepItem.step;
      }
      break;
    }

    case 'workflow': {
      const workflowItem = item as {
        workflow: string;
        with?: Record<string, unknown>;
        as?: string;
      };
      output = await executeWorkflowInvocation(
        workflowItem,
        context,
        scope,
        prInfo,
        dependencyResults,
        executionContext
      );
      outputName = workflowItem.as || workflowItem.workflow;
      break;
    }

    default:
      throw new Error(`Unknown on_init item type: ${itemType}`);
  }

  return { output, outputName };
}

/**
 * Handle on_init lifecycle hook
 *
 * Executes preprocessing/setup tasks BEFORE the main check execution.
 * Supports:
 * - Static run items (on_init.run)
 * - Dynamic run items (on_init.run_js)
 * - Tool, step, and workflow invocations
 * - Custom argument passing via 'with'
 * - Custom output naming via 'as'
 *
 * Outputs are stored in dependencyResults and available as {{ outputs["name"] }}
 */
// Maximum number of on_init items to prevent abuse
const MAX_ON_INIT_ITEMS = 50;

async function handleOnInit(
  checkId: string,
  onInit: OnInitConfig,
  context: EngineContext,
  scope: Scope,
  prInfo: any,
  dependencyResults: Record<string, unknown>,
  executionContext: any
): Promise<void> {
  logger.info(`[OnInit] Processing on_init for check: ${checkId}`);

  // Prevent nested on_init execution to avoid recursion
  if (executionContext.__onInitDepth && executionContext.__onInitDepth > 0) {
    logger.warn(
      `[OnInit] Skipping nested on_init for ${checkId} (depth: ${executionContext.__onInitDepth})`
    );
    return;
  }

  let runItems: OnInitRunItem[] = [];

  // Evaluate run_js if provided (takes precedence over run)
  if (onInit.run_js) {
    logger.info(`[OnInit] Evaluating run_js for ${checkId}`);

    try {
      const sandbox = createSecureSandbox();

      const result = await compileAndRun<OnInitRunItem[]>(
        sandbox,
        onInit.run_js,
        {
          pr: prInfo,
          outputs: dependencyResults,
          env: process.env,
          args: executionContext.args || {},
        },
        { injectLog: true, wrapFunction: false }
      );
      if (Array.isArray(result)) {
        runItems = result;
      } else {
        logger.warn(`[OnInit] run_js for ${checkId} did not return an array, got ${typeof result}`);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`[OnInit] Error evaluating run_js for ${checkId}: ${err.message}`);
      // Preserve original error with context
      const wrappedError = new Error(`on_init.run_js evaluation failed: ${err.message}`);
      wrappedError.stack = err.stack;
      throw wrappedError;
    }
  } else if (onInit.run) {
    // Use static run items
    runItems = normalizeRunItems(onInit.run);
  }

  if (runItems.length === 0) {
    logger.info(`[OnInit] No items to run for ${checkId}`);
    return;
  }

  // Check for excessive number of items
  if (runItems.length > MAX_ON_INIT_ITEMS) {
    const msg = `on_init for ${checkId} has ${runItems.length} items, exceeding maximum of ${MAX_ON_INIT_ITEMS}`;
    logger.error(`[OnInit] ${msg}`);
    throw new Error(msg);
  }

  logger.info(`[OnInit] Running ${runItems.length} items for ${checkId}`);

  // Track depth to prevent nested on_init execution
  const originalDepth = executionContext.__onInitDepth || 0;
  executionContext.__onInitDepth = originalDepth + 1;

  try {
    // Execute items sequentially (preserves ordering)
    for (let i = 0; i < runItems.length; i++) {
      const item = runItems[i];
      const itemType = detectInvocationType(item);
      const itemName =
        typeof item === 'string'
          ? item
          : 'tool' in item
            ? item.tool
            : 'step' in item
              ? item.step
              : 'workflow' in item
                ? item.workflow
                : 'unknown';

      logger.info(`[OnInit] [${i + 1}/${runItems.length}] Executing ${itemType}: ${itemName}`);

      try {
        const { output, outputName } = await executeOnInitItem(
          item,
          context,
          scope,
          prInfo,
          dependencyResults,
          executionContext
        );

        // Store output in dependencyResults for subsequent items and main check
        dependencyResults[outputName] = output;
        logger.info(`[OnInit] Stored output as: ${outputName}`);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error(
          `[OnInit] Error executing ${itemType} ${itemName} for ${checkId}: ${err.message}`
        );
        // Preserve original error with context
        const wrappedError = new Error(`on_init ${itemType} '${itemName}' failed: ${err.message}`);
        wrappedError.stack = err.stack;
        throw wrappedError;
      }
    }

    logger.info(`[OnInit] Completed all on_init items for ${checkId}`);
  } finally {
    // Restore original depth
    executionContext.__onInitDepth = originalDepth;
  }
}

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
      logger.info(
        `⏭  Skipped (if: ${checkConfig.if.substring(0, 40)}${checkConfig.if.length > 40 ? '...' : ''})`
      );
      const emptyResult: ReviewSummary = { issues: [] };
      try {
        Object.defineProperty(emptyResult as any, '__skipped', {
          value: 'if_condition',
          enumerable: false,
        });
      } catch {}
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
      emitEvent({ type: 'CheckCompleted', checkId, scope: [], result: emptyResult });
      return emptyResult;
    }
  }

  const dependencies = checkConfig?.depends_on || [];
  const depList = Array.isArray(dependencies) ? dependencies : [dependencies];

  // Dependency gating with continue_on_failure and OR groups
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
      (state as any).failedChecks = (state as any).failedChecks || new Set<string>();
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

  // Banner-style log when a check actually starts executing. This is emitted
  // after all gating (if/depends_on) has passed so it only appears for real
  // runs, and gives a clear visual separator in the logs between checks.
  try {
    const wave = state.wave;
    const level = (state as any).currentLevel ?? '?';
    const banner = `━━━ CHECK ${checkId} (wave ${wave}, level ${level}) ━━━`;

    // When running in a TTY, colour the entire banner line for extra
    // visibility; keep plain text for JSON/SARIF or non-TTY environments.
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

  let forEachParent: string | undefined;
  let forEachItems: unknown[] | undefined;
  for (const depId of depList) {
    if (!depId) continue;
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
        try {
          Object.defineProperty(emptyResult as any, '__skipped', {
            value: 'forEach_empty',
            enumerable: false,
          });
        } catch {}
        state.completedChecks.add(checkId);
        // Mark as failed for dependents if parent failed
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
      return await executeCheckWithForEachItems(
        checkId,
        forEachParent,
        forEachItems as unknown[],
        context,
        state,
        emitEvent,
        transition
      );
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
    const providerRegistry =
      require('../../providers/check-provider-registry').CheckProviderRegistry.getInstance();
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
      ai: {
        ...(checkConfig.ai || {}),
        timeout: checkConfig.ai?.timeout || 1200000,
        debug: !!context.debug,
      },
    };

    const dependencyResults = buildDependencyResultsWithScope(checkId, checkConfig, context, scope);
    const prInfo: any = context.prInfo || {
      number: 1,
      title: 'State Machine Execution',
      author: 'system',
      eventType: context.event || 'manual',
      eventContext: {},
      files: [],
      commits: [],
    };
    // Derive AI session reuse context for this check (self-mode only for now).
    // When reuse_ai_session: 'self' is configured, look up the last root-scope
    // journal entry for this check in the current engine session and expose its
    // sessionId via ExecutionContext so ai-check-provider can call
    // executeReviewWithSessionReuse() against the same ProbeAgent session.
    let parentSessionId: string | undefined;
    let reuseSession = false;
    try {
      const reuseCfg: unknown = (checkConfig as any).reuse_ai_session;
      if (reuseCfg === 'self') {
        const snapshotId = context.journal.beginSnapshot();
        const visible = context.journal.readVisible(
          context.sessionId,
          snapshotId,
          context.event as any
        );
        // Prefer the most recent root-scope result for this check
        const prior = visible.filter(
          e => e.checkId === checkId && (!e.scope || e.scope.length === 0)
        );
        if (prior.length > 0) {
          const last = prior[prior.length - 1];
          const sess = (last.result as any)?.sessionId;
          if (typeof sess === 'string' && sess.length > 0) {
            parentSessionId = sess;
            reuseSession = true;
          }
        }
      }
    } catch {
      // Best-effort only – fall back to normal (non-reuse) execution on error.
      parentSessionId = undefined;
      reuseSession = false;
    }

    const executionContext = {
      ...context.executionContext,
      _engineMode: context.mode,
      _parentContext: context,
      _parentState: state,
      // Explicitly propagate workspace reference for nested workflows
      workspace: context.workspace,
    };

    // Attach session reuse hints for providers that support them (AI, Claude Code, etc).
    if (reuseSession && parentSessionId) {
      (executionContext as any).parentSessionId = parentSessionId;
      (executionContext as any).reuseSession = true;
    }

    // Handle on_init lifecycle hook BEFORE main execution
    if (checkConfig.on_init) {
      try {
        // Convert Map to Record for on_init handlers
        const dependencyResultsMap: Record<string, unknown> = {};
        for (const [key, value] of dependencyResults.entries()) {
          dependencyResultsMap[key] = value;
        }

        await handleOnInit(
          checkId,
          checkConfig.on_init,
          context,
          scope,
          prInfo,
          dependencyResultsMap,
          executionContext
        );

        // Merge on_init outputs back into dependencyResults Map
        for (const [key, value] of Object.entries(dependencyResultsMap)) {
          if (!dependencyResults.has(key)) {
            // Only add new outputs from on_init
            dependencyResults.set(key, value as any);
          }
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error(`[LevelDispatch] on_init failed for ${checkId}: ${err.message}`);
        // Rethrow to fail the check execution
        throw err;
      }
    }

    try {
      emitNdjsonFallback('visor.provider', {
        'visor.check.id': checkId,
        'visor.provider.type': providerType,
      });
    } catch {}

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

    // Handle forEach:true output from provider (convert to items)
    let isForEach = false;
    let forEachItemsLocal: unknown[] | undefined;
    if (checkConfig.forEach) {
      const output = (result as any).output;
      if (Array.isArray(output)) {
        isForEach = true;
        forEachItemsLocal = output;
        enrichedResult.isForEach = true;
        enrichedResult.forEachItems = output;
      } else {
        if (context.debug)
          logger.warn(
            `[LevelDispatch] Check ${checkId} has forEach:true but output is not an array: ${typeof output}, converting to single-item array`
          );
        isForEach = true;
        forEachItemsLocal = [output];
        enrichedResult.isForEach = true;
        enrichedResult.forEachItems = [output];
      }
    }
    if ((result as any).isForEach) enrichedResult.isForEach = true;
    if ((result as any).forEachItems) enrichedResult.forEachItems = (result as any).forEachItems;
    if ((result as any).forEachItemResults)
      enrichedResult.forEachItemResults = (result as any).forEachItemResults;
    if ((result as any).forEachFatalMask)
      enrichedResult.forEachFatalMask = (result as any).forEachFatalMask;

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
      if (output !== null && typeof output === 'object' && !Array.isArray(output))
        outputWithTimestamp = { ...output, ts: Date.now() };
      else outputWithTimestamp = output;
    }

    const enrichedResultWithContent = renderedContent
      ? { ...enrichedResult, content: renderedContent }
      : enrichedResult;
    const enrichedResultWithTimestamp =
      outputWithTimestamp !== undefined
        ? { ...enrichedResultWithContent, output: outputWithTimestamp }
        : enrichedResultWithContent;

    state.completedChecks.add(checkId);
    const currentWaveCompletions = (state as any).currentWaveCompletions as Set<string> | undefined;
    if (currentWaveCompletions) currentWaveCompletions.add(checkId);

    // Process routing (fail_if, on_success, on_fail) BEFORE storing in journal
    // Same behavior as inlined version in LevelDispatch so routing errors are captured.
    try {
      logger.info(`[LevelDispatch] Calling handleRouting for ${checkId}`);
    } catch {}
    const wasHalted = await handleRouting(context, state, transition, emitEvent, {
      checkId,
      scope,
      result: enrichedResult,
      checkConfig: checkConfig as CheckConfig,
      success: !hasFatalIssues(enrichedResult),
    });

    // If execution was halted, return the current result (with halt issue added)
    if (wasHalted) {
      logger.info(`[LevelDispatch] Execution halted after routing for ${checkId}`);
      return enrichedResult;
    }

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

    // Update stats for this single-run execution to ensure visibility
    try {
      const duration = Date.now() - startTime;
      updateStats([{ checkId, result: enrichedResult as any, duration }], state, false);
    } catch {}

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
        const items = (enrichedResultWithTimestamp as any).forEachItems;
        if (Array.isArray(items)) aggStats.outputsProduced = items.length;
        state.stats.set(checkId, aggStats);
      } catch {}
    }

    if (isForEach && forEachItemsLocal && Array.isArray(forEachItemsLocal)) {
      for (let itemIndex = 0; itemIndex < forEachItemsLocal.length; itemIndex++) {
        const itemScope: Array<{ check: string; index: number }> = [
          { check: checkId, index: itemIndex },
        ];
        const item = forEachItemsLocal[itemIndex];
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
    emitEvent({
      type: 'CheckErrored',
      checkId,
      scope,
      error: { message: err.message, stack: err.stack, name: err.name },
    });
    throw err;
  }
}

function mapCheckNameToFocus(checkName: string): string {
  const focusMap: Record<string, string> = {
    security: 'security',
    performance: 'performance',
    style: 'style',
    architecture: 'architecture',
  };
  return focusMap[checkName] || 'all';
}
