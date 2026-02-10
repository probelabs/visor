/**
 * Routing State Handler
 *
 * Responsibilities:
 * - Evaluate fail_if conditions after check execution
 * - Process on_success, on_fail, on_finish triggers
 * - Enqueue ForwardRunRequested events for goto
 * - Enqueue WaveRetry events for routing loops
 * - Transition back to WavePlanning or Completed
 *
 * M2: Core routing logic implementation
 */

import type { EngineContext, RunState, EngineState, EngineEvent } from '../../types/engine';
import type { ReviewSummary, ReviewIssue } from '../../reviewer';
import type {
  CheckConfig,
  OnFailConfig,
  TransitionRule,
  OnSuccessRunItem,
  OnInitStepInvocation,
  OnInitWorkflowInvocation,
} from '../../types/config';
import { logger } from '../../logger';
import { addEvent } from '../../telemetry/trace-helpers';
import { FailureConditionEvaluator } from '../../failure-condition-evaluator';
import { createSecureSandbox, compileAndRun } from '../../utils/sandbox';
import { MemoryStore } from '../../memory-store';
import { createExtendedLiquid } from '../../liquid-extensions';

/**
 * Render Liquid template expressions in 'with' arguments for on_success.run.
 * This is called during routing, where we have access to the step's output.
 */
async function renderRouteArgs(
  args: Record<string, unknown> | undefined,
  output: unknown,
  dependencyResults: Record<string, unknown>,
  context: EngineContext
): Promise<Record<string, unknown> | undefined> {
  if (!args || Object.keys(args).length === 0) {
    return args;
  }

  const liquid = createExtendedLiquid();
  const renderedArgs: Record<string, unknown> = {};

  // Build template context with output (current step) and outputs (all dependencies)
  const templateContext = {
    output: output, // Output of the step that triggered routing
    outputs: dependencyResults, // All dependency outputs
    env: process.env,
    inputs: (context.executionContext as any)?.workflowInputs || {},
  };

  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.includes('{{')) {
      try {
        renderedArgs[key] = await liquid.parseAndRender(value, templateContext);
      } catch (error) {
        logger.warn(`[Routing] Failed to render template for arg ${key}: ${error}`);
        renderedArgs[key] = value;
      }
    } else {
      renderedArgs[key] = value;
    }
  }

  return renderedArgs;
}

/**
 * Helper to extract target name and args from an OnSuccessRunItem.
 * OnSuccessRunItem can be:
 * - string: plain step name
 * - OnInitStepInvocation: { step: string, with?: Record<string, unknown> }
 * - OnInitWorkflowInvocation: { workflow: string, with?: Record<string, unknown> }
 */
function parseRunItem(item: OnSuccessRunItem): {
  target: string;
  args?: Record<string, unknown>;
} {
  if (typeof item === 'string') {
    return { target: item };
  }
  if ('step' in item) {
    const stepItem = item as OnInitStepInvocation;
    return { target: stepItem.step, args: stepItem.with };
  }
  if ('workflow' in item) {
    const workflowItem = item as OnInitWorkflowInvocation;
    return { target: workflowItem.workflow, args: workflowItem.with };
  }
  // Fallback - shouldn't happen with proper typing
  return { target: String(item) };
}

/**
 * Check if any configured check depends (directly or via OR dependency) on the
 * given `checkId`. Used to decide whether a forEach parent has downstream
 * dependents, in which case its on_finish should defer to the LevelDispatch
 * post-children hook.
 */
// hasDependents helper removed (unused)

/**
 * Check if any dependent of `checkId` would execute with map fanout.
 * Used to decide whether a forEach parent's on_finish should be deferred to
 * the LevelDispatch post-children hook (only necessary when map-fanout children
 * will run per item).
 */
function hasMapFanoutDependents(context: EngineContext, checkId: string): boolean {
  const checks = context.config.checks || {};
  const reduceProviders = new Set(['log', 'memory', 'script', 'workflow', 'noop']);

  for (const [cid, cfg] of Object.entries(checks)) {
    if (cid === checkId) continue;
    const rawDeps = (cfg as any).depends_on || [];
    const depList = Array.isArray(rawDeps) ? rawDeps : [rawDeps];
    // Does this check depend on our target?
    let depends = false;
    for (const dep of depList) {
      if (typeof dep !== 'string') continue;
      if (dep.includes('|')) {
        const opts = dep
          .split('|')
          .map(s => s.trim())
          .filter(Boolean);
        if (opts.includes(checkId)) {
          depends = true;
          break;
        }
      } else if (dep === checkId) {
        depends = true;
        break;
      }
    }
    if (!depends) continue;

    // Determine this dependent's fanout mode
    const explicit = (cfg as any).fanout as 'map' | 'reduce' | undefined;
    if (explicit === 'map') return true;
    if (explicit === 'reduce') continue;

    // Infer default based on provider type
    const providerType = context.checks[cid]?.providerType || (checks as any)[cid]?.type || '';
    const inferred: 'map' | 'reduce' = reduceProviders.has(providerType) ? 'reduce' : 'map';
    if (inferred === 'map') return true;
  }
  return false;
}

/** Classify failure type to inform retry policy mapping */
function classifyFailure(result: ReviewSummary): 'none' | 'logical' | 'execution' {
  const issues = result?.issues || [];
  if (!issues || issues.length === 0) return 'none';
  // Heuristics:
  // - logical: fail_if, contract/guarantee_failed, explicit ruleIds ending with _fail_if
  // - execution: provider/command errors, timeouts, forEach/execution_error, sandbox_runner_error
  let hasLogical = false;
  let hasExecution = false;
  for (const iss of issues) {
    const id = String((iss as any).ruleId || '');
    const msg = String((iss as any).message || '');
    const msgLower = msg.toLowerCase();
    if (
      id.endsWith('_fail_if') ||
      id.includes('contract/guarantee_failed') ||
      id.includes('contract/schema_validation_failed')
    )
      hasLogical = true;
    if (
      id.endsWith('/error') ||
      id.includes('/execution_error') ||
      id.includes('timeout') ||
      msgLower.includes('timed out') ||
      msg.includes('Command execution failed')
    )
      hasExecution = true;
    if (id.includes('forEach/execution_error') || msg.includes('sandbox_runner_error'))
      hasExecution = true;
  }
  if (hasLogical && !hasExecution) return 'logical';
  if (hasExecution && !hasLogical) return 'execution';
  // Mixed or unknown: treat as execution to avoid suppressing retries unexpectedly
  return hasExecution ? 'execution' : 'logical';
}

function getCriticality(context: EngineContext, checkId: string): CheckConfig['criticality'] {
  const cfg = context.config.checks?.[checkId];
  return (cfg && (cfg as any).criticality) || 'policy';
}

/**
 * Context for a check that just completed and needs routing evaluation
 */
interface RoutingContext {
  checkId: string;
  scope: Array<{ check: string; index: number }>;
  result: ReviewSummary;
  checkConfig: CheckConfig;
  success: boolean; // true if no fatal issues
}

/**
 * Create memory helpers for sandbox context
 */
function createMemoryHelpers() {
  const memoryStore = MemoryStore.getInstance();
  return {
    get: (key: string, ns?: string) => memoryStore.get(key, ns),
    has: (key: string, ns?: string) => memoryStore.has(key, ns),
    getAll: (ns?: string) => memoryStore.getAll(ns),
    set: (key: string, value: unknown, ns?: string) => {
      const nsName = ns || memoryStore.getDefaultNamespace();
      const data: Map<string, Map<string, unknown>> = (memoryStore as any)['data'];
      if (!data.has(nsName)) data.set(nsName, new Map());
      data.get(nsName)!.set(key, value);
    },
    clear: (ns?: string) => {
      const data: Map<string, Map<string, unknown>> = (memoryStore as any)['data'];
      if (ns) data.delete(ns);
      else data.clear();
    },
    increment: (key: string, amount = 1, ns?: string) => {
      const nsName = ns || memoryStore.getDefaultNamespace();
      const data: Map<string, Map<string, unknown>> = (memoryStore as any)['data'];
      if (!data.has(nsName)) data.set(nsName, new Map());
      const nsMap = data.get(nsName)!;
      const current = nsMap.get(key);
      const numCurrent = typeof current === 'number' ? current : 0;
      const newValue = numCurrent + amount;
      nsMap.set(key, newValue);
      return newValue;
    },
  };
}

function getHistoryLimit(): number | undefined {
  const raw = process.env.VISOR_TEST_HISTORY_LIMIT || process.env.VISOR_OUTPUT_HISTORY_LIMIT;
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

type RoutingTrigger = 'on_success' | 'on_fail' | 'on_finish';
type RoutingAction = 'run' | 'goto' | 'retry';
type RoutingSource = 'run' | 'run_js' | 'goto' | 'goto_js' | 'transitions' | 'retry';

function formatScopeLabel(scope: Array<{ check: string; index: number }> | undefined): string {
  if (!scope || scope.length === 0) return '';
  return scope.map(item => `${item.check}:${item.index}`).join('|');
}

function recordRoutingEvent(args: {
  checkId: string;
  trigger: RoutingTrigger;
  action: RoutingAction;
  target?: string;
  source?: RoutingSource;
  scope?: Array<{ check: string; index: number }>;
  gotoEvent?: string;
}): void {
  const attrs: Record<string, unknown> = {
    check_id: args.checkId,
    trigger: args.trigger,
    action: args.action,
  };
  if (args.target) attrs.target = args.target;
  if (args.source) attrs.source = args.source;
  const scopeLabel = formatScopeLabel(args.scope);
  if (scopeLabel) attrs.scope = scopeLabel;
  if (args.gotoEvent) attrs.goto_event = args.gotoEvent;
  addEvent('visor.routing', attrs);
}

/**
 * Handle routing state - evaluate conditions and decide next actions
 * @returns true if execution was halted (caller should stop processing)
 */
export async function handleRouting(
  context: EngineContext,
  state: RunState,
  transition: (newState: EngineState) => void,
  emitEvent: (event: EngineEvent) => void,
  routingContext: RoutingContext
): Promise<boolean> {
  const { checkId, scope, result, checkConfig, success } = routingContext;

  // Always log routing entry for debugging E2E expectations
  logger.info(`[Routing] Evaluating routing for check: ${checkId}, success: ${success}`);

  // Step 1: Evaluate fail_if and failure_conditions
  const failureResult = await evaluateFailIf(checkId, result, checkConfig, context, state);

  // Step 1.5: Check if we need to halt execution immediately
  if (failureResult.haltExecution) {
    logger.error(
      `[Routing] HALTING EXECUTION due to critical failure in ${checkId}: ${failureResult.haltMessage}`
    );

    // Add halt issue to result for reporting
    const haltIssue: ReviewIssue = {
      file: 'system',
      line: 0,
      ruleId: `${checkId}_halt_execution`,
      message: `Execution halted: ${failureResult.haltMessage || 'Critical failure condition met'}`,
      severity: 'error',
      category: 'logic',
    };
    result.issues = [...(result.issues || []), haltIssue];

    // Emit Shutdown event to stop the workflow
    emitEvent({
      type: 'Shutdown',
      error: {
        message: failureResult.haltMessage || `Execution halted by check ${checkId}`,
        name: 'HaltExecution',
      },
    });

    // Transition to Error state
    transition('Error');
    return true; // Signal that execution was halted
  }

  if (failureResult.failed) {
    if (context.debug) {
      logger.info(`[Routing] fail_if/failure_conditions triggered for ${checkId}`);
    }

    // Treat as failure for routing purposes
    await processOnFail(checkId, scope, result, checkConfig, context, state, emitEvent);
  } else if (success) {
    // Step 2: Process on_success routing
    await processOnSuccess(checkId, scope, result, checkConfig, context, state, emitEvent);
  } else {
    // Step 3: Process on_fail routing
    await processOnFail(checkId, scope, result, checkConfig, context, state, emitEvent);
  }

  // Step 4: on_finish
  // Process on_finish here for:
  //  - non-forEach checks
  //  - forEach parents that do NOT have map-fanout dependents
  //    (reduce-only dependents don't need the post-children barrier)
  const shouldProcessOnFinishHere =
    !!checkConfig.on_finish &&
    (checkConfig.forEach !== true || !hasMapFanoutDependents(context, checkId));
  if (checkConfig.on_finish) {
    logger.info(
      `[Routing] on_finish decision for ${checkId}: forEach=${!!checkConfig.forEach}, processHere=${shouldProcessOnFinishHere}`
    );
  }
  if (shouldProcessOnFinishHere) {
    await processOnFinish(checkId, scope, result, checkConfig, context, state, emitEvent);
  }

  // Transition back to WavePlanning to process queued events
  transition('WavePlanning');
  return false; // Execution continues normally
}

/**
 * Process on_finish routing
 */
async function processOnFinish(
  checkId: string,
  scope: Array<{ check: string; index: number }>,
  result: ReviewSummary,
  checkConfig: CheckConfig,
  context: EngineContext,
  state: RunState,
  emitEvent: (event: EngineEvent) => void
): Promise<void> {
  const onFinish = checkConfig.on_finish;

  if (!onFinish) {
    return; // No on_finish configuration
  }

  // Log at info level so it's visible in test output
  logger.info(`Processing on_finish for ${checkId}`);
  let queuedForward = false;
  // Process on_finish.run
  if (onFinish.run && onFinish.run.length > 0) {
    // Check if current check is a forEach parent with items
    const currentCheckIsForEach = checkConfig.forEach === true;
    const forEachItems = currentCheckIsForEach ? (result as any).forEachItems : undefined;
    const hasForEachItems = Array.isArray(forEachItems) && forEachItems.length > 0;

    for (const targetCheck of onFinish.run) {
      // Check loop budget before scheduling
      if (checkLoopBudget(context, state, 'on_finish', 'run')) {
        const errorIssue: ReviewIssue = {
          file: 'system',
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? DEFAULT_MAX_LOOPS}) during on_finish run`,
          severity: 'error',
          category: 'logic',
        };
        result.issues = [...(result.issues || []), errorIssue];
        return;
      }

      // Handle fanout: check if target has fanout configuration
      const targetConfig = context.config.checks?.[targetCheck];
      const fanoutMode = targetConfig?.fanout || 'reduce'; // default to reduce

      if (context.debug) {
        logger.info(
          `[Routing] on_finish.run: scheduling ${targetCheck} with fanout=${fanoutMode}, hasForEachItems=${hasForEachItems}`
        );
      }

      // If current check has forEach items and target is map fanout, emit one event per item
      if (fanoutMode === 'map' && hasForEachItems) {
        // Map fanout: emit one ForwardRunRequested per forEach item
        for (let itemIndex = 0; itemIndex < forEachItems!.length; itemIndex++) {
          // Increment loop count for each item
          state.routingLoopCount++;

          const itemScope: Array<{ check: string; index: number }> = [
            { check: checkId, index: itemIndex },
          ];

          recordRoutingEvent({
            checkId,
            trigger: 'on_finish',
            action: 'run',
            target: targetCheck,
            source: 'run',
            scope: itemScope,
          });
          emitEvent({
            type: 'ForwardRunRequested',
            target: targetCheck,
            scope: itemScope,
            origin: 'run',
          });
          queuedForward = true;
        }
      } else {
        // Reduce fanout (or no forEach context): emit with empty scope once
        // Increment loop count
        state.routingLoopCount++;

        recordRoutingEvent({
          checkId,
          trigger: 'on_finish',
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
  }

  // Process on_finish.run_js
  if (onFinish.run_js) {
    const dynamicTargets = await evaluateRunJs(
      onFinish.run_js,
      checkId,
      checkConfig,
      result,
      context,
      state
    );

    for (const runItem of dynamicTargets) {
      // Parse the run item to extract target and optional args
      const { target: targetCheck, args: runArgs } = parseRunItem(runItem);

      // Check loop budget before scheduling
      if (checkLoopBudget(context, state, 'on_finish', 'run')) {
        const errorIssue: ReviewIssue = {
          file: 'system',
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? DEFAULT_MAX_LOOPS}) during on_finish run`,
          severity: 'error',
          category: 'logic',
        };
        result.issues = [...(result.issues || []), errorIssue];
        return;
      }

      if (context.debug) {
        logger.info(
          `[Routing] on_finish.run_js: scheduling ${targetCheck}${runArgs ? ', args=' + JSON.stringify(runArgs) : ''}`
        );
      }

      // Increment loop count
      state.routingLoopCount++;

      recordRoutingEvent({
        checkId,
        trigger: 'on_finish',
        action: 'run',
        target: targetCheck,
        source: 'run_js',
        scope,
      });
      emitEvent({
        type: 'ForwardRunRequested',
        target: targetCheck,
        scope,
        origin: 'run_js',
        args: runArgs,
      });
      queuedForward = true;
    }
  }

  // Declarative transitions (override goto/goto_js when present)
  const finishTransTarget = await evaluateTransitions(
    onFinish.transitions,
    checkId,
    checkConfig,
    result,
    context,
    state
  );
  if (finishTransTarget !== undefined) {
    if (finishTransTarget) {
      if (checkLoopBudget(context, state, 'on_finish', 'goto')) {
        const errorIssue: ReviewIssue = {
          file: 'system',
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? DEFAULT_MAX_LOOPS}) during on_finish goto`,
          severity: 'error',
          category: 'logic',
        };
        result.issues = [...(result.issues || []), errorIssue];
        return;
      }
      state.routingLoopCount++;
      recordRoutingEvent({
        checkId,
        trigger: 'on_finish',
        action: 'goto',
        target: finishTransTarget.to,
        source: 'transitions',
        scope,
        gotoEvent: finishTransTarget.goto_event,
      });
      emitEvent({
        type: 'ForwardRunRequested',
        target: finishTransTarget.to,
        scope,
        origin: 'goto_js',
        gotoEvent: finishTransTarget.goto_event,
      });
    }
    return; // transitions override goto/goto_js
  }

  // Process on_finish.goto / goto_js
  const gotoTarget = await evaluateGoto(
    onFinish.goto_js,
    onFinish.goto,
    checkId,
    checkConfig,
    result,
    context,
    state
  );

  if (gotoTarget) {
    // Check loop budget before scheduling goto
    if (checkLoopBudget(context, state, 'on_finish', 'goto')) {
      const errorIssue: ReviewIssue = {
        file: 'system',
        line: 0,
        ruleId: `${checkId}/routing/loop_budget_exceeded`,
        message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? DEFAULT_MAX_LOOPS}) during on_finish goto`,
        severity: 'error',
        category: 'logic',
      };
      result.issues = [...(result.issues || []), errorIssue];
      return;
    }

    if (context.debug) {
      logger.info(`[Routing] on_finish.goto: ${gotoTarget}`);
    }

    // Increment loop count
    state.routingLoopCount++;

    recordRoutingEvent({
      checkId,
      trigger: 'on_finish',
      action: 'goto',
      target: gotoTarget,
      source: onFinish.goto_js ? 'goto_js' : 'goto',
      scope,
    });
    // Enqueue forward run event
    emitEvent({
      type: 'ForwardRunRequested',
      target: gotoTarget,
      scope,
      origin: 'goto_js',
    });

    // Mark that we've seen a forward run
    state.flags.forwardRunRequested = true;
  }

  // If we scheduled any forward-run targets via on_finish, request a wave retry so
  // dependent checks (with if conditions) can re-evaluate after the forward-run completes.
  // Guard: only enqueue once per originating check per wave to avoid loops.
  if (queuedForward) {
    const guardKey = `waveRetry:on_finish:${checkId}:wave:${state.wave}`;
    if (!(state as any).forwardRunGuards?.has(guardKey)) {
      (state as any).forwardRunGuards?.add(guardKey);
      emitEvent({ type: 'WaveRetry', reason: 'on_finish' });
    }
  }
}

/**
 * Result of evaluating failure conditions
 */
interface FailureEvaluationResult {
  /** Whether any failure condition was triggered */
  failed: boolean;
  /** Whether execution should halt immediately */
  haltExecution: boolean;
  /** Message describing the halt reason (if haltExecution is true) */
  haltMessage?: string;
}

/**
 * Evaluate fail_if and failure_conditions for a check
 */
// Returns { failed, haltExecution } to indicate if check failed and if execution should halt.
// Global fail_if records an issue for summary/reporting but MUST NOT gate routing.
// failure_conditions with halt_execution: true will trigger workflow halt.
async function evaluateFailIf(
  checkId: string,
  result: ReviewSummary,
  checkConfig: CheckConfig,
  context: EngineContext,
  state: RunState
): Promise<FailureEvaluationResult> {
  const config = context.config;

  // Check for fail_if at global or check level
  const globalFailIf = config.fail_if;
  const checkFailIf = checkConfig.fail_if;
  const globalFailureConditions = config.failure_conditions;
  const checkFailureConditions = checkConfig.failure_conditions;

  if (!globalFailIf && !checkFailIf && !globalFailureConditions && !checkFailureConditions) {
    return { failed: false, haltExecution: false }; // No failure conditions
  }

  const evaluator = new FailureConditionEvaluator();

  // Build outputs record from state
  const outputsRecord: Record<string, ReviewSummary> = {};
  for (const [key] of state.stats.entries()) {
    // Try to get the actual result from context.journal if available
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
        outputsRecord[key] = journalResult as ReviewSummary;
      }
    } catch {
      // Fallback to empty result
      outputsRecord[key] = { issues: [] };
    }
  }

  const checkSchema = typeof checkConfig.schema === 'object' ? 'custom' : checkConfig.schema || '';
  const checkGroup = checkConfig.group || '';

  let anyFailed = false;
  let shouldHalt = false;
  let haltMessage: string | undefined;

  // Evaluate global fail_if (non-gating)
  if (globalFailIf) {
    try {
      const failed = await evaluator.evaluateSimpleCondition(
        checkId,
        checkSchema,
        checkGroup,
        result,
        globalFailIf,
        outputsRecord
      );

      if (failed) {
        logger.warn(`[Routing] Global fail_if triggered for ${checkId}: ${globalFailIf}`);

        // Add fail_if issue to result
        const failIssue: ReviewIssue = {
          file: 'system',
          line: 0,
          ruleId: 'global_fail_if',
          message: `Global failure condition met: ${globalFailIf}`,
          severity: 'error',
          category: 'logic',
        };

        result.issues = [...(result.issues || []), failIssue];
        // IMPORTANT: do not gate routing on global fail_if
        // This condition contributes to overall run status but should not
        // block dependents from executing when the producing check succeeded.
        // Continue evaluating check-level fail_if below.
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Routing] Error evaluating global fail_if: ${msg}`);
    }
  }

  // Evaluate check-specific fail_if
  if (checkFailIf) {
    try {
      const failed = await evaluator.evaluateSimpleCondition(
        checkId,
        checkSchema,
        checkGroup,
        result,
        checkFailIf,
        outputsRecord
      );

      if (failed) {
        logger.warn(`[Routing] Check fail_if triggered for ${checkId}: ${checkFailIf}`);

        // Add fail_if issue to result
        const failIssue: ReviewIssue = {
          file: 'system',
          line: 0,
          ruleId: `${checkId}_fail_if`,
          message: `Check failure condition met: ${checkFailIf}`,
          severity: 'error',
          category: 'logic',
        };

        result.issues = [...(result.issues || []), failIssue];
        anyFailed = true;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Routing] Error evaluating check fail_if: ${msg}`);
    }
  }

  // Evaluate failure_conditions (both global and check-level)
  // These support halt_execution: true
  if (globalFailureConditions || checkFailureConditions) {
    try {
      const conditionResults = await evaluator.evaluateConditions(
        checkId,
        checkSchema,
        checkGroup,
        result,
        globalFailureConditions,
        checkFailureConditions,
        outputsRecord
      );

      // Check for triggered conditions
      for (const condResult of conditionResults) {
        if (condResult.failed) {
          logger.warn(
            `[Routing] Failure condition '${condResult.conditionName}' triggered for ${checkId}: ${condResult.expression}`
          );

          // Add issue to result
          const failIssue: ReviewIssue = {
            file: 'system',
            line: 0,
            ruleId: `${checkId}_${condResult.conditionName}`,
            message: condResult.message || `Failure condition met: ${condResult.expression}`,
            severity: condResult.severity || 'error',
            category: 'logic',
          };

          result.issues = [...(result.issues || []), failIssue];
          anyFailed = true;

          // Check if this condition requires halting execution
          if (condResult.haltExecution) {
            shouldHalt = true;
            haltMessage =
              condResult.message ||
              `Execution halted: condition '${condResult.conditionName}' triggered`;
            logger.error(
              `[Routing] HALT EXECUTION triggered by '${condResult.conditionName}' for ${checkId}`
            );
          }
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Routing] Error evaluating failure_conditions: ${msg}`);
    }
  }

  return { failed: anyFailed, haltExecution: shouldHalt, haltMessage };
}

/**
 * Check if routing loop budget is exceeded
 */
export function checkLoopBudget(
  context: EngineContext,
  state: RunState,
  origin: 'on_success' | 'on_fail' | 'on_finish',
  action: 'run' | 'goto'
): boolean {
  const maxLoops = context.config.routing?.max_loops ?? DEFAULT_MAX_LOOPS;

  if (state.routingLoopCount >= maxLoops) {
    const msg = `Routing loop budget exceeded (max_loops=${maxLoops}) during ${origin} ${action}`;
    logger.error(`[Routing] ${msg}`);
    return true; // Budget exceeded
  }

  return false; // Budget OK
}

/**
 * Process on_success routing
 */
async function processOnSuccess(
  checkId: string,
  scope: Array<{ check: string; index: number }>,
  result: ReviewSummary,
  checkConfig: CheckConfig,
  context: EngineContext,
  state: RunState,
  emitEvent: (event: EngineEvent) => void
): Promise<void> {
  const onSuccess = checkConfig.on_success;

  if (!onSuccess) {
    return; // No on_success configuration
  }

  if (context.debug) {
    logger.info(`[Routing] Processing on_success for ${checkId}`);
  }

  // Process on_success.run
  if (onSuccess.run && onSuccess.run.length > 0) {
    // Detect forEach context based on the actual result (aggregated map execution)
    const resForEachItems: any[] | undefined =
      (result && (result as any).forEachItems) || undefined;
    const hasForEachItems = Array.isArray(resForEachItems) && resForEachItems.length > 0;

    // Get the step's output for template rendering
    const stepOutput = (result as any)?.output;

    // Build dependency results from journal for template context
    const depResults: Record<string, unknown> = {};
    try {
      const snapshotId = context.journal.beginSnapshot();
      const allEntries = context.journal.readVisible(context.sessionId, snapshotId, context.event);
      for (const entry of allEntries) {
        if (entry.checkId && entry.result) {
          const r = entry.result as ReviewSummary & { output?: unknown };
          depResults[entry.checkId] = r.output !== undefined ? r.output : r;
        }
      }
    } catch (e) {
      logger.warn(`[Routing] Failed to build dependency results for template rendering: ${e}`);
    }

    for (const runItem of onSuccess.run) {
      // Parse the run item to extract target and optional args
      const { target: targetCheck, args: rawArgs } = parseRunItem(runItem);

      // Render Liquid templates in args if present
      const runArgs = rawArgs
        ? await renderRouteArgs(rawArgs, stepOutput, depResults, context)
        : undefined;

      // Check loop budget before scheduling
      if (checkLoopBudget(context, state, 'on_success', 'run')) {
        // Add error issue to result
        const errorIssue: ReviewIssue = {
          file: 'system',
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? DEFAULT_MAX_LOOPS}) during on_success run`,
          severity: 'error',
          category: 'logic',
        };
        result.issues = [...(result.issues || []), errorIssue];
        return; // Stop processing
      }

      // Handle fanout: check if target has fanout configuration
      const targetConfig = context.config.checks?.[targetCheck];
      const fanoutMode = targetConfig?.fanout || 'reduce'; // default to reduce

      if (context.debug) {
        logger.info(
          `[Routing] on_success.run: scheduling ${targetCheck} with fanout=${fanoutMode}, hasForEachItems=${hasForEachItems}${runArgs ? ', args=' + JSON.stringify(runArgs) : ''}`
        );
      }

      // If current check has forEach items and target is map fanout, emit one event per item
      if (fanoutMode === 'map' && hasForEachItems) {
        // Map fanout: emit one ForwardRunRequested per forEach item
        for (let itemIndex = 0; itemIndex < resForEachItems!.length; itemIndex++) {
          // Increment loop count for each item
          state.routingLoopCount++;

          const itemScope: Array<{ check: string; index: number }> = [
            { check: checkId, index: itemIndex },
          ];

          recordRoutingEvent({
            checkId,
            trigger: 'on_success',
            action: 'run',
            target: targetCheck,
            source: 'run',
            scope: itemScope,
          });
          emitEvent({
            type: 'ForwardRunRequested',
            target: targetCheck,
            scope: itemScope,
            origin: 'run',
            args: runArgs,
          });
        }
      } else {
        // Reduce fanout (or no forEach context): emit with empty scope once
        // Increment loop count
        state.routingLoopCount++;

        recordRoutingEvent({
          checkId,
          trigger: 'on_success',
          action: 'run',
          target: targetCheck,
          source: 'run',
          scope,
        });
        emitEvent({
          type: 'ForwardRunRequested',
          target: targetCheck,
          scope,
          origin: 'run',
          args: runArgs,
        });
      }
    }
  }

  // Process on_success.run_js
  if (onSuccess.run_js) {
    const dynamicTargets = await evaluateRunJs(
      onSuccess.run_js,
      checkId,
      checkConfig,
      result,
      context,
      state
    );

    for (const runItem of dynamicTargets) {
      // Parse the run item to extract target and optional args
      const { target: targetCheck, args: runArgs } = parseRunItem(runItem);

      // Check loop budget before scheduling
      if (checkLoopBudget(context, state, 'on_success', 'run')) {
        const errorIssue: ReviewIssue = {
          file: 'system',
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? 10}) during on_success run`,
          severity: 'error',
          category: 'logic',
        };
        result.issues = [...(result.issues || []), errorIssue];
        return;
      }

      if (context.debug) {
        logger.info(
          `[Routing] on_success.run_js: scheduling ${targetCheck}${runArgs ? ', args=' + JSON.stringify(runArgs) : ''}`
        );
      }

      // Increment loop count
      state.routingLoopCount++;

      recordRoutingEvent({
        checkId,
        trigger: 'on_success',
        action: 'run',
        target: targetCheck,
        source: 'run_js',
        scope,
      });
      emitEvent({
        type: 'ForwardRunRequested',
        target: targetCheck,
        scope,
        origin: 'run_js',
        args: runArgs,
      });
    }
  }

  // Declarative transitions for on_success (override goto/goto_js when present)
  const successTransTarget = await evaluateTransitions(
    onSuccess.transitions,
    checkId,
    checkConfig,
    result,
    context,
    state
  );
  if (successTransTarget !== undefined) {
    if (successTransTarget) {
      if (checkLoopBudget(context, state, 'on_success', 'goto')) {
        const errorIssue: ReviewIssue = {
          file: 'system',
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? DEFAULT_MAX_LOOPS}) during on_success goto`,
          severity: 'error',
          category: 'logic',
        };
        result.issues = [...(result.issues || []), errorIssue];
        return;
      }
      state.routingLoopCount++;
      recordRoutingEvent({
        checkId,
        trigger: 'on_success',
        action: 'goto',
        target: successTransTarget.to,
        source: 'transitions',
        scope,
        gotoEvent: successTransTarget.goto_event,
      });
      emitEvent({
        type: 'ForwardRunRequested',
        target: successTransTarget.to,
        scope,
        origin: 'goto_js',
        gotoEvent: successTransTarget.goto_event,
      });
      state.flags.forwardRunRequested = true;
    }
    return;
  }

  // Process on_success.goto / goto_js
  const gotoTarget = await evaluateGoto(
    onSuccess.goto_js,
    onSuccess.goto,
    checkId,
    checkConfig,
    result,
    context,
    state
  );

  if (gotoTarget) {
    // Check loop budget before scheduling goto
    if (checkLoopBudget(context, state, 'on_success', 'goto')) {
      const errorIssue: ReviewIssue = {
        file: 'system',
        line: 0,
        ruleId: `${checkId}/routing/loop_budget_exceeded`,
        message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? 10}) during on_success goto`,
        severity: 'error',
        category: 'logic',
      };
      result.issues = [...(result.issues || []), errorIssue];
      return;
    }

    if (context.debug) {
      logger.info(`[Routing] on_success.goto: ${gotoTarget}`);
    }

    // Increment loop count
    state.routingLoopCount++;

    recordRoutingEvent({
      checkId,
      trigger: 'on_success',
      action: 'goto',
      target: gotoTarget,
      source: onSuccess.goto_js ? 'goto_js' : 'goto',
      scope,
      gotoEvent: onSuccess.goto_event,
    });
    // Enqueue forward run event with optional event override
    emitEvent({
      type: 'ForwardRunRequested',
      target: gotoTarget,
      gotoEvent: onSuccess.goto_event,
      scope,
      origin: 'goto_js',
    });

    // Mark that we've seen a forward run
    state.flags.forwardRunRequested = true;
  }
}

/**
 * Process on_fail routing
 */
async function processOnFail(
  checkId: string,
  scope: Array<{ check: string; index: number }>,
  result: ReviewSummary,
  checkConfig: CheckConfig,
  context: EngineContext,
  state: RunState,
  emitEvent: (event: EngineEvent) => void
): Promise<void> {
  // Merge defaults with check-specific on_fail
  const defaults = context.config.routing?.defaults?.on_fail || {};
  const onFail: OnFailConfig | undefined = checkConfig.on_fail
    ? { ...defaults, ...checkConfig.on_fail }
    : undefined;

  if (!onFail) {
    return; // No on_fail configuration
  }

  if (context.debug) {
    logger.info(`[Routing] Processing on_fail for ${checkId}`);
  }

  // Process on_fail.run
  if (onFail.run && onFail.run.length > 0) {
    // Detect forEach context based on the actual aggregated result
    const resForEachItems: any[] | undefined =
      (result && (result as any).forEachItems) || undefined;
    const hasForEachItems = Array.isArray(resForEachItems) && resForEachItems.length > 0;

    for (const targetCheck of onFail.run) {
      // Check loop budget before scheduling
      if (checkLoopBudget(context, state, 'on_fail', 'run')) {
        const errorIssue: ReviewIssue = {
          file: 'system',
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? 10}) during on_fail run`,
          severity: 'error',
          category: 'logic',
        };
        result.issues = [...(result.issues || []), errorIssue];
        return;
      }

      // Handle fanout: check if target has fanout configuration
      const targetConfig = context.config.checks?.[targetCheck];
      const fanoutMode = targetConfig?.fanout || 'reduce'; // default to reduce

      if (context.debug) {
        logger.info(
          `[Routing] on_fail.run: scheduling ${targetCheck} with fanout=${fanoutMode}, hasForEachItems=${hasForEachItems}`
        );
      }

      // If current check ran in forEach context, schedule remediation per item
      if (hasForEachItems) {
        for (let itemIndex = 0; itemIndex < resForEachItems!.length; itemIndex++) {
          const itemOut = resForEachItems![itemIndex] as any;
          // Only remediate failed iterations if __failed is present; otherwise run for all
          if (
            itemOut &&
            typeof itemOut === 'object' &&
            itemOut.__failed !== true &&
            fanoutMode !== 'map'
          ) {
            // For reduce targets, skip successful iterations to avoid redundant runs
            continue;
          }

          state.routingLoopCount++;
          const itemScope: Array<{ check: string; index: number }> = [
            { check: checkId, index: itemIndex },
          ];
          recordRoutingEvent({
            checkId,
            trigger: 'on_fail',
            action: 'run',
            target: targetCheck,
            source: 'run',
            scope: itemScope,
          });
          emitEvent({
            type: 'ForwardRunRequested',
            target: targetCheck,
            scope: itemScope,
            origin: 'run',
            sourceCheck: checkId, // The failed check that triggered on_fail.run
          });
        }
      } else {
        // No forEach context: preserve current scope (if any)
        state.routingLoopCount++;
        recordRoutingEvent({
          checkId,
          trigger: 'on_fail',
          action: 'run',
          target: targetCheck,
          source: 'run',
          scope,
        });
        emitEvent({
          type: 'ForwardRunRequested',
          target: targetCheck,
          scope,
          origin: 'run',
          sourceCheck: checkId, // The failed check that triggered on_fail.run
        });
      }
    }
  }

  // Process on_fail.run_js
  if (onFail.run_js) {
    const dynamicTargets = await evaluateRunJs(
      onFail.run_js,
      checkId,
      checkConfig,
      result,
      context,
      state
    );

    for (const runItem of dynamicTargets) {
      // Parse the run item to extract target and optional args
      const { target: targetCheck, args: runArgs } = parseRunItem(runItem);

      // Check loop budget before scheduling
      if (checkLoopBudget(context, state, 'on_fail', 'run')) {
        const errorIssue: ReviewIssue = {
          file: 'system',
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? 10}) during on_fail run`,
          severity: 'error',
          category: 'logic',
        };
        result.issues = [...(result.issues || []), errorIssue];
        return;
      }

      if (context.debug) {
        logger.info(
          `[Routing] on_fail.run_js: scheduling ${targetCheck}${runArgs ? ', args=' + JSON.stringify(runArgs) : ''}`
        );
      }

      // Increment loop count
      state.routingLoopCount++;

      recordRoutingEvent({
        checkId,
        trigger: 'on_fail',
        action: 'run',
        target: targetCheck,
        source: 'run_js',
        scope,
      });
      emitEvent({
        type: 'ForwardRunRequested',
        target: targetCheck,
        scope,
        origin: 'run_js',
        sourceCheck: checkId, // The failed check that triggered on_fail.run_js
        args: runArgs,
      });
    }
  }

  // Process on_fail.retry (schedule retry of the current check)
  if (onFail.retry && typeof onFail.retry.max === 'number' && onFail.retry.max > 0) {
    // Criticality mapping: for 'external' and 'internal', avoid automatic
    // retries for logical failures (fail_if/guarantee violations).
    const crit = getCriticality(context, checkId);
    const failureKind = classifyFailure(result);
    if ((crit === 'external' || crit === 'internal') && failureKind === 'logical') {
      if (context.debug) {
        logger.info(
          `[Routing] on_fail.retry suppressed for ${checkId} (criticality=${crit}, failure=logical)`
        );
      }
      // Skip retry scheduling
    } else {
      const max = Math.max(0, onFail.retry.max || 0);
      // Initialize retry attempt map on state
      if (!(state as any).retryAttempts) (state as any).retryAttempts = new Map<string, number>();
      const attemptsMap: Map<string, number> = (state as any).retryAttempts;

      const makeKey = (sc: Array<{ check: string; index: number }> | undefined) => {
        const keyScope = sc && sc.length > 0 ? JSON.stringify(sc) : 'root';
        return `${checkId}::${keyScope}`;
      };

      const scheduleRetryForScope = (sc: Array<{ check: string; index: number }> | undefined) => {
        const key = makeKey(sc);
        const used = attemptsMap.get(key) || 0;
        if (used >= max) return; // budget exhausted
        attemptsMap.set(key, used + 1);

        // Increment loop count and schedule forward run for the same check
        state.routingLoopCount++;
        recordRoutingEvent({
          checkId,
          trigger: 'on_fail',
          action: 'retry',
          source: 'retry',
          scope: sc || [],
        });
        emitEvent({
          type: 'ForwardRunRequested',
          target: checkId,
          scope: sc || [],
          origin: 'run',
        });
      };

      const resForEachItems: any[] | undefined =
        (result && (result as any).forEachItems) || undefined;
      const hasForEachItems = Array.isArray(resForEachItems) && resForEachItems.length > 0;

      if (hasForEachItems) {
        for (let i = 0; i < resForEachItems!.length; i++) {
          const itemOut = resForEachItems![i] as any;
          // Only retry failed iterations (marked by __failed)
          if (itemOut && typeof itemOut === 'object' && itemOut.__failed === true) {
            const sc: Array<{ check: string; index: number }> = [{ check: checkId, index: i }];
            scheduleRetryForScope(sc);
          }
        }
      } else {
        scheduleRetryForScope(scope);
      }

      // Note: backoff.delay_ms and mode are intentionally not awaited here; the
      // state-machine processes retries as subsequent waves. If needed later, we
      // can insert a timed wait in the orchestrator layer.
    }
  }

  // Declarative transitions for on_fail (override goto/goto_js when present)
  const failTransTarget = await evaluateTransitions(
    onFail.transitions,
    checkId,
    checkConfig,
    result,
    context,
    state
  );
  if (failTransTarget !== undefined) {
    if (failTransTarget) {
      if (checkLoopBudget(context, state, 'on_fail', 'goto')) {
        const errorIssue: ReviewIssue = {
          file: 'system',
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? DEFAULT_MAX_LOOPS}) during on_fail goto`,
          severity: 'error',
          category: 'logic',
        };
        result.issues = [...(result.issues || []), errorIssue];
        return;
      }
      state.routingLoopCount++;
      recordRoutingEvent({
        checkId,
        trigger: 'on_fail',
        action: 'goto',
        target: failTransTarget.to,
        source: 'transitions',
        scope,
        gotoEvent: failTransTarget.goto_event,
      });
      emitEvent({
        type: 'ForwardRunRequested',
        target: failTransTarget.to,
        scope,
        origin: 'goto_js',
        gotoEvent: failTransTarget.goto_event,
      });
      state.flags.forwardRunRequested = true;
    }
    return;
  }

  // Process on_fail.goto / goto_js
  const gotoTarget = await evaluateGoto(
    onFail.goto_js,
    onFail.goto,
    checkId,
    checkConfig,
    result,
    context,
    state
  );

  if (gotoTarget) {
    // Check loop budget before scheduling goto
    if (checkLoopBudget(context, state, 'on_fail', 'goto')) {
      const errorIssue: ReviewIssue = {
        file: 'system',
        line: 0,
        ruleId: `${checkId}/routing/loop_budget_exceeded`,
        message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? 10}) during on_fail goto`,
        severity: 'error',
        category: 'logic',
      };
      result.issues = [...(result.issues || []), errorIssue];
      return;
    }

    if (context.debug) {
      logger.info(`[Routing] on_fail.goto: ${gotoTarget}`);
    }

    // Increment loop count
    state.routingLoopCount++;

    recordRoutingEvent({
      checkId,
      trigger: 'on_fail',
      action: 'goto',
      target: gotoTarget,
      source: onFail.goto_js ? 'goto_js' : 'goto',
      scope,
      gotoEvent: onFail.goto_event,
    });
    // Enqueue forward run event with optional event override
    emitEvent({
      type: 'ForwardRunRequested',
      target: gotoTarget,
      gotoEvent: onFail.goto_event,
      scope,
      origin: 'goto_js',
    });

    // Mark that we've seen a forward run
    state.flags.forwardRunRequested = true;
  }
}

/**
 * Evaluate run_js expression to get dynamic check targets
 */
/**
 * Validate that an item is a valid OnSuccessRunItem (string or object with step/workflow)
 */
function isValidRunItem(item: unknown): item is OnSuccessRunItem {
  if (typeof item === 'string' && item) return true;
  if (typeof item === 'object' && item !== null) {
    const obj = item as Record<string, unknown>;
    if (typeof obj.step === 'string' && obj.step) return true;
    if (typeof obj.workflow === 'string' && obj.workflow) return true;
  }
  return false;
}

async function evaluateRunJs(
  runJs: string,
  checkId: string,
  checkConfig: CheckConfig,
  result: ReviewSummary,
  context: EngineContext,
  _state: RunState
): Promise<OnSuccessRunItem[]> {
  try {
    const sandbox = createSecureSandbox();
    const historyLimit = getHistoryLimit();

    // Build outputs record and outputs_history
    const snapshotId = context.journal.beginSnapshot();
    const contextView = new (require('../../snapshot-store').ContextView)(
      context.journal,
      context.sessionId,
      snapshotId,
      [],
      context.event
    );

    const outputsRecord: Record<string, any> = {};
    const outputsHistory: Record<string, any[]> = {};

    // Get all visible journal entries to build complete history
    const allEntries = context.journal.readVisible(context.sessionId, snapshotId, context.event);
    const uniqueCheckIds = new Set(allEntries.map(e => e.checkId));

    for (const checkIdFromJournal of uniqueCheckIds) {
      try {
        // Get current output for this check
        const journalResult = contextView.get(checkIdFromJournal);
        if (journalResult) {
          // Prefer the output field if present, otherwise use the full result
          outputsRecord[checkIdFromJournal] =
            journalResult.output !== undefined ? journalResult.output : journalResult;
        }
      } catch {
        outputsRecord[checkIdFromJournal] = { issues: [] };
      }

      // Build history for this check
      try {
        const history = contextView.getHistory(checkIdFromJournal);
        if (history && history.length > 0) {
          const trimmed =
            historyLimit && history.length > historyLimit
              ? history.slice(history.length - historyLimit)
              : history;
          // Extract outputs from history (prefer output field if available)
          outputsHistory[checkIdFromJournal] = trimmed.map((r: any) =>
            r.output !== undefined ? r.output : r
          );
        }
      } catch {
        // Ignore history errors
      }
    }

    // Add history as a property on outputs object for convenient access
    outputsRecord.history = outputsHistory;

    // Compute minimal forEach metadata for run_js parity
    let forEachMeta: any = undefined;
    try {
      const hist = outputsHistory[checkId] || [];
      const lastArr = (hist as any[])
        .slice()
        .reverse()
        .find((x: any) => Array.isArray(x));
      if (checkConfig.forEach === true && Array.isArray(lastArr)) {
        forEachMeta = {
          is_parent: true,
          last_wave_size: lastArr.length,
          last_items: lastArr,
        };
      }
    } catch {}

    const scopeObj: any = {
      step: {
        id: checkId,
        tags: checkConfig.tags || [],
        group: checkConfig.group,
      },
      outputs: outputsRecord,
      outputs_history: outputsHistory,
      output: (result as any)?.output,
      memory: createMemoryHelpers(),
      event: {
        name: context.event || 'manual',
      },
      forEach: forEachMeta,
    };

    const code = `
      const step = scope.step;
      const outputs = scope.outputs;
      const outputs_history = scope.outputs_history;
      const output = scope.output;
      const memory = scope.memory;
      const event = scope.event;
      const forEach = scope.forEach;
      const log = (...args) => console.log('🔍 Debug:', ...args);
      const __fn = () => {
        ${runJs}
      };
      const __res = __fn();
      // Return as-is; validation happens after sandbox execution
      return Array.isArray(__res) ? __res : [];
    `;

    try {
      const evalResult = compileAndRun<unknown[]>(
        sandbox,
        code,
        { scope: scopeObj },
        { injectLog: false, wrapFunction: false }
      );
      // Filter to valid run items (strings or objects with step/workflow)
      return Array.isArray(evalResult) ? evalResult.filter(isValidRunItem) : [];
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Routing] Error in run_js sandbox evaluation: ${msg}`);
      return [];
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`[Routing] Error evaluating run_js: ${msg}`);
    return [];
  }
}

/**
 * Evaluate goto_js or return static goto target
 */
export async function evaluateGoto(
  gotoJs: string | undefined,
  gotoStatic: string | undefined,
  checkId: string,
  checkConfig: CheckConfig,
  result: ReviewSummary,
  context: EngineContext,
  _state: RunState
): Promise<string | null> {
  // Evaluate goto_js first
  if (gotoJs) {
    try {
      const sandbox = createSecureSandbox();
      const historyLimit = getHistoryLimit();

      // Build outputs record and outputs_history from the full session snapshot.
      // Do not filter by event here — on_finish (especially forEach post-children) may
      // need to see results committed under different event triggers within the same run.
      const snapshotId = context.journal.beginSnapshot();
      const contextView = new (require('../../snapshot-store').ContextView)(
        context.journal,
        context.sessionId,
        snapshotId,
        [],
        undefined
      );

      const outputsRecord: Record<string, any> = {};
      const outputsHistory: Record<string, any[]> = {};

      // Get all visible journal entries to build complete history
      const allEntries = context.journal.readVisible(context.sessionId, snapshotId, undefined);
      const uniqueCheckIds = new Set(allEntries.map(e => e.checkId));

      for (const checkIdFromJournal of uniqueCheckIds) {
        try {
          // Get current output for this check
          const journalResult = contextView.get(checkIdFromJournal);
          if (journalResult) {
            // Prefer the output field if present, otherwise use the full result
            outputsRecord[checkIdFromJournal] =
              journalResult.output !== undefined ? journalResult.output : journalResult;
          }
        } catch {
          outputsRecord[checkIdFromJournal] = { issues: [] };
        }

        // Build history for this check
        try {
          const history = contextView.getHistory(checkIdFromJournal);
          if (history && history.length > 0) {
            const trimmed =
              historyLimit && history.length > historyLimit
                ? history.slice(history.length - historyLimit)
                : history;
            // Extract outputs from history (prefer output field if available)
            outputsHistory[checkIdFromJournal] = trimmed.map((r: any) =>
              r.output !== undefined ? r.output : r
            );
          }
        } catch {
          // Ignore history errors
        }
      }

      // Add history as a property on outputs object for convenient access
      outputsRecord.history = outputsHistory;

      // Compute minimal forEach metadata for convenience in goto_js
      // - last_wave_size: number of items in the latest root-scope array output
      // - last_items: the latest array output itself (if available)
      let forEachMeta: any = undefined;
      try {
        const hist = outputsHistory[checkId] || [];
        const lastArr = (hist as any[])
          .slice()
          .reverse()
          .find((x: any) => Array.isArray(x));
        if (checkConfig.forEach === true && Array.isArray(lastArr)) {
          forEachMeta = {
            is_parent: true,
            last_wave_size: lastArr.length,
            last_items: lastArr,
          };
        }
      } catch {}

      const scopeObj: any = {
        step: {
          id: checkId,
          tags: checkConfig.tags || [],
          group: checkConfig.group,
        },
        outputs: outputsRecord,
        outputs_history: outputsHistory,
        output: (result as any)?.output,
        memory: createMemoryHelpers(),
        event: {
          name: context.event || 'manual',
        },
        forEach: forEachMeta,
      };

      // Debug: Log outputs_history
      if (context.debug) {
        logger.info(
          `[Routing] evaluateGoto: checkId=${checkId}, outputs_history keys=${Object.keys(outputsHistory).join(',')}`
        );
        for (const [key, values] of Object.entries(outputsHistory)) {
          logger.info(`[Routing]   ${key}: ${values.length} items`);
        }
      }

      const code = `
        const step = scope.step;
        const outputs = scope.outputs;
        const outputs_history = scope.outputs_history;
        const output = scope.output;
        const memory = scope.memory;
        const event = scope.event;
        const forEach = scope.forEach;
        const log = (...args) => console.log('🔍 Debug:', ...args);
        ${gotoJs}
      `;

      try {
        const evalResult = compileAndRun<string | null>(
          sandbox,
          code,
          { scope: scopeObj },
          { injectLog: false, wrapFunction: true }
        );

        if (context.debug) {
          logger.info(`[Routing] evaluateGoto result: ${evalResult}`);
        }

        if (typeof evalResult === 'string' && evalResult) {
          return evalResult;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[Routing] Error in goto_js sandbox evaluation: ${msg}`);
        // Fall through to static goto
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Routing] Error evaluating goto_js: ${msg}`);

      // Fall back to static goto if available
      if (gotoStatic) {
        logger.info(`[Routing] Falling back to static goto: ${gotoStatic}`);
        return gotoStatic;
      }
    }
  }

  // Return static goto
  return gotoStatic || null;
}
// Default values (used only when config is absent)
const DEFAULT_MAX_LOOPS = 10;

/**
 * Evaluate declarative transitions. Returns:
 *  - { to, goto_event } when a rule matches,
 *  - null (explicit) when a rule matches with to=null,
 *  - undefined when no rule matched or transitions is empty.
 */
export async function evaluateTransitions(
  transitions: TransitionRule[] | undefined,
  checkId: string,
  checkConfig: CheckConfig,
  result: ReviewSummary,
  context: EngineContext,
  _state: RunState
): Promise<
  { to: string; goto_event?: import('../../types/config').EventTrigger } | null | undefined
> {
  if (!transitions || transitions.length === 0) return undefined;
  try {
    const sandbox = createSecureSandbox();
    const historyLimit = getHistoryLimit();

    // Build outputs record and outputs_history from the full session snapshot
    const snapshotId = context.journal.beginSnapshot();
    const ContextView = (require('../../snapshot-store') as any).ContextView;
    const view = new ContextView(context.journal, context.sessionId, snapshotId, [], undefined);

    const outputsRecord: Record<string, any> = {};
    const outputsHistory: Record<string, any[]> = {};
    const allEntries = context.journal.readVisible(context.sessionId, snapshotId, undefined);
    const uniqueCheckIds = new Set(allEntries.map((e: any) => e.checkId));
    for (const cid of uniqueCheckIds) {
      try {
        const jr = view.get(cid);
        if (jr) outputsRecord[cid] = jr.output !== undefined ? jr.output : jr;
      } catch {}
      try {
        const hist = view.getHistory(cid);
        if (hist && hist.length > 0) {
          const trimmed =
            historyLimit && hist.length > historyLimit
              ? hist.slice(hist.length - historyLimit)
              : hist;
          outputsHistory[cid] = trimmed.map((r: any) => (r.output !== undefined ? r.output : r));
        }
      } catch {}
    }
    outputsRecord.history = outputsHistory;

    const scopeObj: any = {
      step: { id: checkId, tags: checkConfig.tags || [], group: checkConfig.group },
      outputs: outputsRecord,
      outputs_history: outputsHistory,
      output: (result as any)?.output,
      memory: createMemoryHelpers(),
      event: { name: context.event || 'manual' },
    };

    for (const rule of transitions) {
      const helpers = `
        const any = (arr, pred) => Array.isArray(arr) && arr.some(x => pred(x));
        const all = (arr, pred) => Array.isArray(arr) && arr.every(x => pred(x));
        const none = (arr, pred) => Array.isArray(arr) && !arr.some(x => pred(x));
        const count = (arr, pred) => Array.isArray(arr) ? arr.filter(x => pred(x)).length : 0;
      `;
      // Mirror the variable exposure pattern used in goto_js/run_js so that
      // `when:` expressions can reference `outputs`, `outputs_history`, `event`, etc.
      const code = `
        ${helpers}
        const step = scope.step;
        const outputs = scope.outputs;
        const outputs_history = scope.outputs_history;
        const output = scope.output;
        const memory = scope.memory;
        const event = scope.event;
        const __eval = () => { return (${rule.when}); };
        return __eval();
      `;
      let matched: boolean | undefined;
      try {
        matched = compileAndRun<boolean>(
          sandbox,
          code,
          { scope: scopeObj },
          { injectLog: false, wrapFunction: false }
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn(`[Routing] Error evaluating transition 'when' clause: ${msg}`);
        matched = false;
      }
      if (matched) {
        if (rule.to === null) return null;
        if (typeof rule.to === 'string' && rule.to.length > 0) {
          return { to: rule.to, goto_event: (rule as any).goto_event };
        }
        return null;
      }
    }
    return undefined;
  } catch (err) {
    logger.error(
      `[Routing] Error evaluating transitions: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}
