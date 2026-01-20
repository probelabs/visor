import {
  FailureConditionEvaluator,
  init_failure_condition_evaluator
} from "./chunk-TMZFYWTK.mjs";
import {
  compileAndRun,
  createSecureSandbox,
  init_sandbox
} from "./chunk-BOVFH3LI.mjs";
import {
  addEvent,
  init_trace_helpers
} from "./chunk-ZYAUYXSW.mjs";
import {
  MemoryStore,
  init_memory_store
} from "./chunk-7UK3NIIT.mjs";
import {
  init_logger,
  logger
} from "./chunk-AGIZJ4UZ.mjs";
import {
  __esm,
  __export,
  __require,
  __toCommonJS
} from "./chunk-WMJKH4XE.mjs";

// src/snapshot-store.ts
var snapshot_store_exports = {};
__export(snapshot_store_exports, {
  ContextView: () => ContextView,
  ExecutionJournal: () => ExecutionJournal
});
var ExecutionJournal, ContextView;
var init_snapshot_store = __esm({
  "src/snapshot-store.ts"() {
    "use strict";
    ExecutionJournal = class {
      commit = 0;
      entries = [];
      beginSnapshot() {
        return this.commit;
      }
      commitEntry(entry) {
        const committed = {
          sessionId: entry.sessionId,
          scope: entry.scope,
          checkId: entry.checkId,
          result: entry.result,
          event: entry.event,
          commitId: ++this.commit
        };
        this.entries.push(committed);
        return committed;
      }
      readVisible(sessionId, commitMax, event) {
        return this.entries.filter(
          (e) => e.sessionId === sessionId && e.commitId <= commitMax && (event ? e.event === event : true)
        );
      }
      // Lightweight helpers for debugging/metrics
      size() {
        return this.entries.length;
      }
    };
    ContextView = class {
      constructor(journal, sessionId, snapshotId, scope, event) {
        this.journal = journal;
        this.sessionId = sessionId;
        this.snapshotId = snapshotId;
        this.scope = scope;
        this.event = event;
      }
      /** Return the nearest result for a check in this scope (exact item → ancestor → latest). */
      get(checkId) {
        const visible = this.journal.readVisible(this.sessionId, this.snapshotId, this.event).filter((e) => e.checkId === checkId);
        if (visible.length === 0) return void 0;
        const exactMatches = visible.filter((e) => this.sameScope(e.scope, this.scope));
        if (exactMatches.length > 0) {
          return exactMatches[exactMatches.length - 1].result;
        }
        let best;
        for (const e of visible) {
          const dist = this.ancestorDistance(e.scope, this.scope);
          if (dist >= 0 && (best === void 0 || dist < best.dist)) {
            best = { entry: e, dist };
          }
        }
        if (best) return best.entry.result;
        return visible[visible.length - 1]?.result;
      }
      /** Return an aggregate (raw) result – the shallowest scope for this check. */
      getRaw(checkId) {
        const visible = this.journal.readVisible(this.sessionId, this.snapshotId, this.event).filter((e) => e.checkId === checkId);
        if (visible.length === 0) return void 0;
        let shallow = visible[0];
        for (const e of visible) {
          if (e.scope.length < shallow.scope.length) shallow = e;
        }
        return shallow.result;
      }
      /** All results for a check up to this snapshot. */
      getHistory(checkId) {
        return this.journal.readVisible(this.sessionId, this.snapshotId, this.event).filter((e) => e.checkId === checkId).map((e) => e.result);
      }
      sameScope(a, b) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
          if (a[i].check !== b[i].check || a[i].index !== b[i].index) return false;
        }
        return true;
      }
      // distance from ancestor to current; -1 if not ancestor
      ancestorDistance(ancestor, current) {
        if (ancestor.length > current.length) return -1;
        if (ancestor.length === 0 && current.length > 0) return -1;
        for (let i = 0; i < ancestor.length; i++) {
          if (ancestor[i].check !== current[i].check || ancestor[i].index !== current[i].index)
            return -1;
        }
        return current.length - ancestor.length;
      }
    };
  }
});

// src/state-machine/states/routing.ts
function hasMapFanoutDependents(context, checkId) {
  const checks = context.config.checks || {};
  const reduceProviders = /* @__PURE__ */ new Set(["log", "memory", "script", "workflow", "noop"]);
  for (const [cid, cfg] of Object.entries(checks)) {
    if (cid === checkId) continue;
    const rawDeps = cfg.depends_on || [];
    const depList = Array.isArray(rawDeps) ? rawDeps : [rawDeps];
    let depends = false;
    for (const dep of depList) {
      if (typeof dep !== "string") continue;
      if (dep.includes("|")) {
        const opts = dep.split("|").map((s) => s.trim()).filter(Boolean);
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
    const explicit = cfg.fanout;
    if (explicit === "map") return true;
    if (explicit === "reduce") continue;
    const providerType = context.checks[cid]?.providerType || checks[cid]?.type || "";
    const inferred = reduceProviders.has(providerType) ? "reduce" : "map";
    if (inferred === "map") return true;
  }
  return false;
}
function classifyFailure(result) {
  const issues = result?.issues || [];
  if (!issues || issues.length === 0) return "none";
  let hasLogical = false;
  let hasExecution = false;
  for (const iss of issues) {
    const id = String(iss.ruleId || "");
    const msg = String(iss.message || "");
    if (id.endsWith("_fail_if") || id.includes("contract/guarantee_failed") || id.includes("contract/schema_validation_failed"))
      hasLogical = true;
    if (id.includes("/execution_error") || msg.includes("Command execution failed"))
      hasExecution = true;
    if (id.includes("forEach/execution_error") || msg.includes("sandbox_runner_error"))
      hasExecution = true;
  }
  if (hasLogical && !hasExecution) return "logical";
  if (hasExecution && !hasLogical) return "execution";
  return hasExecution ? "execution" : "logical";
}
function getCriticality(context, checkId) {
  const cfg = context.config.checks?.[checkId];
  return cfg && cfg.criticality || "policy";
}
function createMemoryHelpers() {
  const memoryStore = MemoryStore.getInstance();
  return {
    get: (key, ns) => memoryStore.get(key, ns),
    has: (key, ns) => memoryStore.has(key, ns),
    getAll: (ns) => memoryStore.getAll(ns),
    set: (key, value, ns) => {
      const nsName = ns || memoryStore.getDefaultNamespace();
      const data = memoryStore["data"];
      if (!data.has(nsName)) data.set(nsName, /* @__PURE__ */ new Map());
      data.get(nsName).set(key, value);
    },
    clear: (ns) => {
      const data = memoryStore["data"];
      if (ns) data.delete(ns);
      else data.clear();
    },
    increment: (key, amount = 1, ns) => {
      const nsName = ns || memoryStore.getDefaultNamespace();
      const data = memoryStore["data"];
      if (!data.has(nsName)) data.set(nsName, /* @__PURE__ */ new Map());
      const nsMap = data.get(nsName);
      const current = nsMap.get(key);
      const numCurrent = typeof current === "number" ? current : 0;
      const newValue = numCurrent + amount;
      nsMap.set(key, newValue);
      return newValue;
    }
  };
}
function formatScopeLabel(scope) {
  if (!scope || scope.length === 0) return "";
  return scope.map((item) => `${item.check}:${item.index}`).join("|");
}
function recordRoutingEvent(args) {
  const attrs = {
    check_id: args.checkId,
    trigger: args.trigger,
    action: args.action
  };
  if (args.target) attrs.target = args.target;
  if (args.source) attrs.source = args.source;
  const scopeLabel = formatScopeLabel(args.scope);
  if (scopeLabel) attrs.scope = scopeLabel;
  if (args.gotoEvent) attrs.goto_event = args.gotoEvent;
  addEvent("visor.routing", attrs);
}
async function handleRouting(context, state, transition, emitEvent, routingContext) {
  const { checkId, scope, result, checkConfig, success } = routingContext;
  logger.info(`[Routing] Evaluating routing for check: ${checkId}, success: ${success}`);
  const failIfTriggered = await evaluateFailIf(checkId, result, checkConfig, context, state);
  if (failIfTriggered) {
    if (context.debug) {
      logger.info(`[Routing] fail_if triggered for ${checkId}`);
    }
    await processOnFail(checkId, scope, result, checkConfig, context, state, emitEvent);
  } else if (success) {
    await processOnSuccess(checkId, scope, result, checkConfig, context, state, emitEvent);
  } else {
    await processOnFail(checkId, scope, result, checkConfig, context, state, emitEvent);
  }
  const shouldProcessOnFinishHere = !!checkConfig.on_finish && (checkConfig.forEach !== true || !hasMapFanoutDependents(context, checkId));
  if (checkConfig.on_finish) {
    logger.info(
      `[Routing] on_finish decision for ${checkId}: forEach=${!!checkConfig.forEach}, processHere=${shouldProcessOnFinishHere}`
    );
  }
  if (shouldProcessOnFinishHere) {
    await processOnFinish(checkId, scope, result, checkConfig, context, state, emitEvent);
  }
  transition("WavePlanning");
}
async function processOnFinish(checkId, scope, result, checkConfig, context, state, emitEvent) {
  const onFinish = checkConfig.on_finish;
  if (!onFinish) {
    return;
  }
  logger.info(`Processing on_finish for ${checkId}`);
  let queuedForward = false;
  if (onFinish.run && onFinish.run.length > 0) {
    const currentCheckIsForEach = checkConfig.forEach === true;
    const forEachItems = currentCheckIsForEach ? result.forEachItems : void 0;
    const hasForEachItems = Array.isArray(forEachItems) && forEachItems.length > 0;
    for (const targetCheck of onFinish.run) {
      if (checkLoopBudget(context, state, "on_finish", "run")) {
        const errorIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? DEFAULT_MAX_LOOPS}) during on_finish run`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], errorIssue];
        return;
      }
      const targetConfig = context.config.checks?.[targetCheck];
      const fanoutMode = targetConfig?.fanout || "reduce";
      if (context.debug) {
        logger.info(
          `[Routing] on_finish.run: scheduling ${targetCheck} with fanout=${fanoutMode}, hasForEachItems=${hasForEachItems}`
        );
      }
      if (fanoutMode === "map" && hasForEachItems) {
        for (let itemIndex = 0; itemIndex < forEachItems.length; itemIndex++) {
          state.routingLoopCount++;
          const itemScope = [
            { check: checkId, index: itemIndex }
          ];
          recordRoutingEvent({
            checkId,
            trigger: "on_finish",
            action: "run",
            target: targetCheck,
            source: "run",
            scope: itemScope
          });
          emitEvent({
            type: "ForwardRunRequested",
            target: targetCheck,
            scope: itemScope,
            origin: "run"
          });
          queuedForward = true;
        }
      } else {
        state.routingLoopCount++;
        recordRoutingEvent({
          checkId,
          trigger: "on_finish",
          action: "run",
          target: targetCheck,
          source: "run",
          scope: []
        });
        emitEvent({
          type: "ForwardRunRequested",
          target: targetCheck,
          scope: [],
          origin: "run"
        });
        queuedForward = true;
      }
    }
  }
  if (onFinish.run_js) {
    const dynamicTargets = await evaluateRunJs(
      onFinish.run_js,
      checkId,
      checkConfig,
      result,
      context,
      state
    );
    for (const targetCheck of dynamicTargets) {
      if (checkLoopBudget(context, state, "on_finish", "run")) {
        const errorIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? DEFAULT_MAX_LOOPS}) during on_finish run`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], errorIssue];
        return;
      }
      if (context.debug) {
        logger.info(`[Routing] on_finish.run_js: scheduling ${targetCheck}`);
      }
      state.routingLoopCount++;
      recordRoutingEvent({
        checkId,
        trigger: "on_finish",
        action: "run",
        target: targetCheck,
        source: "run_js",
        scope
      });
      emitEvent({
        type: "ForwardRunRequested",
        target: targetCheck,
        scope,
        origin: "run_js"
      });
      queuedForward = true;
    }
  }
  const finishTransTarget = await evaluateTransitions(
    onFinish.transitions,
    checkId,
    checkConfig,
    result,
    context,
    state
  );
  if (finishTransTarget !== void 0) {
    if (finishTransTarget) {
      if (checkLoopBudget(context, state, "on_finish", "goto")) {
        const errorIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? DEFAULT_MAX_LOOPS}) during on_finish goto`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], errorIssue];
        return;
      }
      state.routingLoopCount++;
      recordRoutingEvent({
        checkId,
        trigger: "on_finish",
        action: "goto",
        target: finishTransTarget.to,
        source: "transitions",
        scope,
        gotoEvent: finishTransTarget.goto_event
      });
      emitEvent({
        type: "ForwardRunRequested",
        target: finishTransTarget.to,
        scope,
        origin: "goto_js",
        gotoEvent: finishTransTarget.goto_event
      });
    }
    return;
  }
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
    if (checkLoopBudget(context, state, "on_finish", "goto")) {
      const errorIssue = {
        file: "system",
        line: 0,
        ruleId: `${checkId}/routing/loop_budget_exceeded`,
        message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? DEFAULT_MAX_LOOPS}) during on_finish goto`,
        severity: "error",
        category: "logic"
      };
      result.issues = [...result.issues || [], errorIssue];
      return;
    }
    if (context.debug) {
      logger.info(`[Routing] on_finish.goto: ${gotoTarget}`);
    }
    state.routingLoopCount++;
    recordRoutingEvent({
      checkId,
      trigger: "on_finish",
      action: "goto",
      target: gotoTarget,
      source: onFinish.goto_js ? "goto_js" : "goto",
      scope
    });
    emitEvent({
      type: "ForwardRunRequested",
      target: gotoTarget,
      scope,
      origin: "goto_js"
    });
    state.flags.forwardRunRequested = true;
  }
  if (queuedForward) {
    const guardKey = `waveRetry:on_finish:${checkId}:wave:${state.wave}`;
    if (!state.forwardRunGuards?.has(guardKey)) {
      state.forwardRunGuards?.add(guardKey);
      emitEvent({ type: "WaveRetry", reason: "on_finish" });
    }
  }
}
async function evaluateFailIf(checkId, result, checkConfig, context, state) {
  const config = context.config;
  const globalFailIf = config.fail_if;
  const checkFailIf = checkConfig.fail_if;
  if (!globalFailIf && !checkFailIf) {
    return false;
  }
  const evaluator = new FailureConditionEvaluator();
  const outputsRecord = {};
  for (const [key] of state.stats.entries()) {
    try {
      const snapshotId = context.journal.beginSnapshot();
      const contextView = new (init_snapshot_store(), __toCommonJS(snapshot_store_exports)).ContextView(
        context.journal,
        context.sessionId,
        snapshotId,
        [],
        context.event
      );
      const journalResult = contextView.get(key);
      if (journalResult) {
        outputsRecord[key] = journalResult;
      }
    } catch {
      outputsRecord[key] = { issues: [] };
    }
  }
  const checkSchema = typeof checkConfig.schema === "object" ? "custom" : checkConfig.schema || "";
  const checkGroup = checkConfig.group || "";
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
        const failIssue = {
          file: "system",
          line: 0,
          ruleId: "global_fail_if",
          message: `Global failure condition met: ${globalFailIf}`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], failIssue];
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Routing] Error evaluating global fail_if: ${msg}`);
    }
  }
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
        const failIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}_fail_if`,
          message: `Check failure condition met: ${checkFailIf}`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], failIssue];
        return true;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Routing] Error evaluating check fail_if: ${msg}`);
    }
  }
  return false;
}
function checkLoopBudget(context, state, origin, action) {
  const maxLoops = context.config.routing?.max_loops ?? DEFAULT_MAX_LOOPS;
  if (state.routingLoopCount >= maxLoops) {
    const msg = `Routing loop budget exceeded (max_loops=${maxLoops}) during ${origin} ${action}`;
    logger.error(`[Routing] ${msg}`);
    return true;
  }
  return false;
}
async function processOnSuccess(checkId, scope, result, checkConfig, context, state, emitEvent) {
  const onSuccess = checkConfig.on_success;
  if (!onSuccess) {
    return;
  }
  if (context.debug) {
    logger.info(`[Routing] Processing on_success for ${checkId}`);
  }
  if (onSuccess.run && onSuccess.run.length > 0) {
    const resForEachItems = result && result.forEachItems || void 0;
    const hasForEachItems = Array.isArray(resForEachItems) && resForEachItems.length > 0;
    for (const targetCheck of onSuccess.run) {
      if (checkLoopBudget(context, state, "on_success", "run")) {
        const errorIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? DEFAULT_MAX_LOOPS}) during on_success run`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], errorIssue];
        return;
      }
      const targetConfig = context.config.checks?.[targetCheck];
      const fanoutMode = targetConfig?.fanout || "reduce";
      if (context.debug) {
        logger.info(
          `[Routing] on_success.run: scheduling ${targetCheck} with fanout=${fanoutMode}, hasForEachItems=${hasForEachItems}`
        );
      }
      if (fanoutMode === "map" && hasForEachItems) {
        for (let itemIndex = 0; itemIndex < resForEachItems.length; itemIndex++) {
          state.routingLoopCount++;
          const itemScope = [
            { check: checkId, index: itemIndex }
          ];
          recordRoutingEvent({
            checkId,
            trigger: "on_success",
            action: "run",
            target: targetCheck,
            source: "run",
            scope: itemScope
          });
          emitEvent({
            type: "ForwardRunRequested",
            target: targetCheck,
            scope: itemScope,
            origin: "run"
          });
        }
      } else {
        state.routingLoopCount++;
        recordRoutingEvent({
          checkId,
          trigger: "on_success",
          action: "run",
          target: targetCheck,
          source: "run",
          scope
        });
        emitEvent({
          type: "ForwardRunRequested",
          target: targetCheck,
          scope,
          origin: "run"
        });
      }
    }
  }
  if (onSuccess.run_js) {
    const dynamicTargets = await evaluateRunJs(
      onSuccess.run_js,
      checkId,
      checkConfig,
      result,
      context,
      state
    );
    for (const targetCheck of dynamicTargets) {
      if (checkLoopBudget(context, state, "on_success", "run")) {
        const errorIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? 10}) during on_success run`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], errorIssue];
        return;
      }
      if (context.debug) {
        logger.info(`[Routing] on_success.run_js: scheduling ${targetCheck}`);
      }
      state.routingLoopCount++;
      recordRoutingEvent({
        checkId,
        trigger: "on_success",
        action: "run",
        target: targetCheck,
        source: "run_js",
        scope
      });
      emitEvent({
        type: "ForwardRunRequested",
        target: targetCheck,
        scope,
        origin: "run_js"
      });
    }
  }
  const successTransTarget = await evaluateTransitions(
    onSuccess.transitions,
    checkId,
    checkConfig,
    result,
    context,
    state
  );
  if (successTransTarget !== void 0) {
    if (successTransTarget) {
      if (checkLoopBudget(context, state, "on_success", "goto")) {
        const errorIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? DEFAULT_MAX_LOOPS}) during on_success goto`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], errorIssue];
        return;
      }
      state.routingLoopCount++;
      recordRoutingEvent({
        checkId,
        trigger: "on_success",
        action: "goto",
        target: successTransTarget.to,
        source: "transitions",
        scope,
        gotoEvent: successTransTarget.goto_event
      });
      emitEvent({
        type: "ForwardRunRequested",
        target: successTransTarget.to,
        scope,
        origin: "goto_js",
        gotoEvent: successTransTarget.goto_event
      });
      state.flags.forwardRunRequested = true;
    }
    return;
  }
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
    if (checkLoopBudget(context, state, "on_success", "goto")) {
      const errorIssue = {
        file: "system",
        line: 0,
        ruleId: `${checkId}/routing/loop_budget_exceeded`,
        message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? 10}) during on_success goto`,
        severity: "error",
        category: "logic"
      };
      result.issues = [...result.issues || [], errorIssue];
      return;
    }
    if (context.debug) {
      logger.info(`[Routing] on_success.goto: ${gotoTarget}`);
    }
    state.routingLoopCount++;
    recordRoutingEvent({
      checkId,
      trigger: "on_success",
      action: "goto",
      target: gotoTarget,
      source: onSuccess.goto_js ? "goto_js" : "goto",
      scope,
      gotoEvent: onSuccess.goto_event
    });
    emitEvent({
      type: "ForwardRunRequested",
      target: gotoTarget,
      gotoEvent: onSuccess.goto_event,
      scope,
      origin: "goto_js"
    });
    state.flags.forwardRunRequested = true;
  }
}
async function processOnFail(checkId, scope, result, checkConfig, context, state, emitEvent) {
  const defaults = context.config.routing?.defaults?.on_fail || {};
  const onFail = checkConfig.on_fail ? { ...defaults, ...checkConfig.on_fail } : void 0;
  if (!onFail) {
    return;
  }
  if (context.debug) {
    logger.info(`[Routing] Processing on_fail for ${checkId}`);
  }
  if (onFail.run && onFail.run.length > 0) {
    const resForEachItems = result && result.forEachItems || void 0;
    const hasForEachItems = Array.isArray(resForEachItems) && resForEachItems.length > 0;
    for (const targetCheck of onFail.run) {
      if (checkLoopBudget(context, state, "on_fail", "run")) {
        const errorIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? 10}) during on_fail run`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], errorIssue];
        return;
      }
      const targetConfig = context.config.checks?.[targetCheck];
      const fanoutMode = targetConfig?.fanout || "reduce";
      if (context.debug) {
        logger.info(
          `[Routing] on_fail.run: scheduling ${targetCheck} with fanout=${fanoutMode}, hasForEachItems=${hasForEachItems}`
        );
      }
      if (hasForEachItems) {
        for (let itemIndex = 0; itemIndex < resForEachItems.length; itemIndex++) {
          const itemOut = resForEachItems[itemIndex];
          if (itemOut && typeof itemOut === "object" && itemOut.__failed !== true && fanoutMode !== "map") {
            continue;
          }
          state.routingLoopCount++;
          const itemScope = [
            { check: checkId, index: itemIndex }
          ];
          recordRoutingEvent({
            checkId,
            trigger: "on_fail",
            action: "run",
            target: targetCheck,
            source: "run",
            scope: itemScope
          });
          emitEvent({
            type: "ForwardRunRequested",
            target: targetCheck,
            scope: itemScope,
            origin: "run"
          });
        }
      } else {
        state.routingLoopCount++;
        recordRoutingEvent({
          checkId,
          trigger: "on_fail",
          action: "run",
          target: targetCheck,
          source: "run",
          scope
        });
        emitEvent({
          type: "ForwardRunRequested",
          target: targetCheck,
          scope,
          origin: "run"
        });
      }
    }
  }
  if (onFail.run_js) {
    const dynamicTargets = await evaluateRunJs(
      onFail.run_js,
      checkId,
      checkConfig,
      result,
      context,
      state
    );
    for (const targetCheck of dynamicTargets) {
      if (checkLoopBudget(context, state, "on_fail", "run")) {
        const errorIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? 10}) during on_fail run`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], errorIssue];
        return;
      }
      if (context.debug) {
        logger.info(`[Routing] on_fail.run_js: scheduling ${targetCheck}`);
      }
      state.routingLoopCount++;
      recordRoutingEvent({
        checkId,
        trigger: "on_fail",
        action: "run",
        target: targetCheck,
        source: "run_js",
        scope
      });
      emitEvent({
        type: "ForwardRunRequested",
        target: targetCheck,
        scope,
        origin: "run_js"
      });
    }
  }
  if (onFail.retry && typeof onFail.retry.max === "number" && onFail.retry.max > 0) {
    const crit = getCriticality(context, checkId);
    const failureKind = classifyFailure(result);
    if ((crit === "external" || crit === "internal") && failureKind === "logical") {
      if (context.debug) {
        logger.info(
          `[Routing] on_fail.retry suppressed for ${checkId} (criticality=${crit}, failure=logical)`
        );
      }
    } else {
      const max = Math.max(0, onFail.retry.max || 0);
      if (!state.retryAttempts) state.retryAttempts = /* @__PURE__ */ new Map();
      const attemptsMap = state.retryAttempts;
      const makeKey = (sc) => {
        const keyScope = sc && sc.length > 0 ? JSON.stringify(sc) : "root";
        return `${checkId}::${keyScope}`;
      };
      const scheduleRetryForScope = (sc) => {
        const key = makeKey(sc);
        const used = attemptsMap.get(key) || 0;
        if (used >= max) return;
        attemptsMap.set(key, used + 1);
        state.routingLoopCount++;
        recordRoutingEvent({
          checkId,
          trigger: "on_fail",
          action: "retry",
          source: "retry",
          scope: sc || []
        });
        emitEvent({
          type: "ForwardRunRequested",
          target: checkId,
          scope: sc || [],
          origin: "run"
        });
      };
      const resForEachItems = result && result.forEachItems || void 0;
      const hasForEachItems = Array.isArray(resForEachItems) && resForEachItems.length > 0;
      if (hasForEachItems) {
        for (let i = 0; i < resForEachItems.length; i++) {
          const itemOut = resForEachItems[i];
          if (itemOut && typeof itemOut === "object" && itemOut.__failed === true) {
            const sc = [{ check: checkId, index: i }];
            scheduleRetryForScope(sc);
          }
        }
      } else {
        scheduleRetryForScope(scope);
      }
    }
  }
  const failTransTarget = await evaluateTransitions(
    onFail.transitions,
    checkId,
    checkConfig,
    result,
    context,
    state
  );
  if (failTransTarget !== void 0) {
    if (failTransTarget) {
      if (checkLoopBudget(context, state, "on_fail", "goto")) {
        const errorIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? DEFAULT_MAX_LOOPS}) during on_fail goto`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], errorIssue];
        return;
      }
      state.routingLoopCount++;
      recordRoutingEvent({
        checkId,
        trigger: "on_fail",
        action: "goto",
        target: failTransTarget.to,
        source: "transitions",
        scope,
        gotoEvent: failTransTarget.goto_event
      });
      emitEvent({
        type: "ForwardRunRequested",
        target: failTransTarget.to,
        scope,
        origin: "goto_js",
        gotoEvent: failTransTarget.goto_event
      });
      state.flags.forwardRunRequested = true;
    }
    return;
  }
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
    if (checkLoopBudget(context, state, "on_fail", "goto")) {
      const errorIssue = {
        file: "system",
        line: 0,
        ruleId: `${checkId}/routing/loop_budget_exceeded`,
        message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? 10}) during on_fail goto`,
        severity: "error",
        category: "logic"
      };
      result.issues = [...result.issues || [], errorIssue];
      return;
    }
    if (context.debug) {
      logger.info(`[Routing] on_fail.goto: ${gotoTarget}`);
    }
    state.routingLoopCount++;
    recordRoutingEvent({
      checkId,
      trigger: "on_fail",
      action: "goto",
      target: gotoTarget,
      source: onFail.goto_js ? "goto_js" : "goto",
      scope,
      gotoEvent: onFail.goto_event
    });
    emitEvent({
      type: "ForwardRunRequested",
      target: gotoTarget,
      gotoEvent: onFail.goto_event,
      scope,
      origin: "goto_js"
    });
    state.flags.forwardRunRequested = true;
  }
}
async function evaluateRunJs(runJs, checkId, checkConfig, result, context, _state) {
  try {
    const sandbox = createSecureSandbox();
    const snapshotId = context.journal.beginSnapshot();
    const contextView = new (init_snapshot_store(), __toCommonJS(snapshot_store_exports)).ContextView(
      context.journal,
      context.sessionId,
      snapshotId,
      [],
      context.event
    );
    const outputsRecord = {};
    const outputsHistory = {};
    const allEntries = context.journal.readVisible(context.sessionId, snapshotId, context.event);
    const uniqueCheckIds = new Set(allEntries.map((e) => e.checkId));
    for (const checkIdFromJournal of uniqueCheckIds) {
      try {
        const journalResult = contextView.get(checkIdFromJournal);
        if (journalResult) {
          outputsRecord[checkIdFromJournal] = journalResult.output !== void 0 ? journalResult.output : journalResult;
        }
      } catch {
        outputsRecord[checkIdFromJournal] = { issues: [] };
      }
      try {
        const history = contextView.getHistory(checkIdFromJournal);
        if (history && history.length > 0) {
          outputsHistory[checkIdFromJournal] = history.map(
            (r) => r.output !== void 0 ? r.output : r
          );
        }
      } catch {
      }
    }
    outputsRecord.history = outputsHistory;
    let forEachMeta = void 0;
    try {
      const hist = outputsHistory[checkId] || [];
      const lastArr = hist.slice().reverse().find((x) => Array.isArray(x));
      if (checkConfig.forEach === true && Array.isArray(lastArr)) {
        forEachMeta = {
          is_parent: true,
          last_wave_size: lastArr.length,
          last_items: lastArr
        };
      }
    } catch {
    }
    const scopeObj = {
      step: {
        id: checkId,
        tags: checkConfig.tags || [],
        group: checkConfig.group
      },
      outputs: outputsRecord,
      outputs_history: outputsHistory,
      output: result?.output,
      memory: createMemoryHelpers(),
      event: {
        name: context.event || "manual"
      },
      forEach: forEachMeta
    };
    const code = `
      const step = scope.step;
      const outputs = scope.outputs;
      const outputs_history = scope.outputs_history;
      const output = scope.output;
      const memory = scope.memory;
      const event = scope.event;
      const forEach = scope.forEach;
      const log = (...args) => console.log('\u{1F50D} Debug:', ...args);
      const __fn = () => {
        ${runJs}
      };
      const __res = __fn();
      return Array.isArray(__res) ? __res.filter(x => typeof x === 'string' && x) : [];
    `;
    try {
      const evalResult = compileAndRun(
        sandbox,
        code,
        { scope: scopeObj },
        { injectLog: false, wrapFunction: false }
      );
      return Array.isArray(evalResult) ? evalResult.filter(Boolean) : [];
    } catch (_e) {
      try {
        const vm = __require("vm");
        const context2 = vm.createContext({ scope: scopeObj, console: { log: () => {
        } } });
        const src = `(() => { ${runJs}
 })()`;
        const val = new vm.Script(src).runInContext(context2, { timeout: 100 });
        return Array.isArray(val) ? val.filter((x) => typeof x === "string" && x) : [];
      } catch (_vmErr) {
        return [];
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`[Routing] Error evaluating run_js: ${msg}`);
    return [];
  }
}
async function evaluateGoto(gotoJs, gotoStatic, checkId, checkConfig, result, context, _state) {
  if (gotoJs) {
    try {
      const sandbox = createSecureSandbox();
      const snapshotId = context.journal.beginSnapshot();
      const contextView = new (init_snapshot_store(), __toCommonJS(snapshot_store_exports)).ContextView(
        context.journal,
        context.sessionId,
        snapshotId,
        [],
        void 0
      );
      const outputsRecord = {};
      const outputsHistory = {};
      const allEntries = context.journal.readVisible(context.sessionId, snapshotId, void 0);
      const uniqueCheckIds = new Set(allEntries.map((e) => e.checkId));
      for (const checkIdFromJournal of uniqueCheckIds) {
        try {
          const journalResult = contextView.get(checkIdFromJournal);
          if (journalResult) {
            outputsRecord[checkIdFromJournal] = journalResult.output !== void 0 ? journalResult.output : journalResult;
          }
        } catch {
          outputsRecord[checkIdFromJournal] = { issues: [] };
        }
        try {
          const history = contextView.getHistory(checkIdFromJournal);
          if (history && history.length > 0) {
            outputsHistory[checkIdFromJournal] = history.map(
              (r) => r.output !== void 0 ? r.output : r
            );
          }
        } catch {
        }
      }
      outputsRecord.history = outputsHistory;
      let forEachMeta = void 0;
      try {
        const hist = outputsHistory[checkId] || [];
        const lastArr = hist.slice().reverse().find((x) => Array.isArray(x));
        if (checkConfig.forEach === true && Array.isArray(lastArr)) {
          forEachMeta = {
            is_parent: true,
            last_wave_size: lastArr.length,
            last_items: lastArr
          };
        }
      } catch {
      }
      const scopeObj = {
        step: {
          id: checkId,
          tags: checkConfig.tags || [],
          group: checkConfig.group
        },
        outputs: outputsRecord,
        outputs_history: outputsHistory,
        output: result?.output,
        memory: createMemoryHelpers(),
        event: {
          name: context.event || "manual"
        },
        forEach: forEachMeta
      };
      if (context.debug) {
        logger.info(
          `[Routing] evaluateGoto: checkId=${checkId}, outputs_history keys=${Object.keys(outputsHistory).join(",")}`
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
        const log = (...args) => console.log('\u{1F50D} Debug:', ...args);
        ${gotoJs}
      `;
      try {
        const evalResult = compileAndRun(
          sandbox,
          code,
          { scope: scopeObj },
          { injectLog: false, wrapFunction: true }
        );
        if (context.debug) {
          logger.info(`[Routing] evaluateGoto result: ${evalResult}`);
        }
        if (typeof evalResult === "string" && evalResult) {
          return evalResult;
        }
      } catch (_e) {
        try {
          const vm = __require("vm");
          const contextObj = {
            step: scopeObj.step,
            outputs: scopeObj.outputs,
            outputs_history: scopeObj.outputs_history,
            output: scopeObj.output,
            memory: scopeObj.memory,
            event: scopeObj.event,
            forEach: scopeObj.forEach
          };
          const vmctx = vm.createContext(contextObj);
          const src = `(() => { ${gotoJs}
 })()`;
          const res = new vm.Script(src).runInContext(vmctx, { timeout: 100 });
          if (typeof res === "string" && res) return res;
        } catch (_vmErr) {
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Routing] Error evaluating goto_js: ${msg}`);
      if (gotoStatic) {
        logger.info(`[Routing] Falling back to static goto: ${gotoStatic}`);
        return gotoStatic;
      }
    }
  }
  return gotoStatic || null;
}
async function evaluateTransitions(transitions, checkId, checkConfig, result, context, _state) {
  if (!transitions || transitions.length === 0) return void 0;
  try {
    const sandbox = createSecureSandbox();
    const snapshotId = context.journal.beginSnapshot();
    const ContextView2 = (init_snapshot_store(), __toCommonJS(snapshot_store_exports)).ContextView;
    const view = new ContextView2(context.journal, context.sessionId, snapshotId, [], void 0);
    const outputsRecord = {};
    const outputsHistory = {};
    const allEntries = context.journal.readVisible(context.sessionId, snapshotId, void 0);
    const uniqueCheckIds = new Set(allEntries.map((e) => e.checkId));
    for (const cid of uniqueCheckIds) {
      try {
        const jr = view.get(cid);
        if (jr) outputsRecord[cid] = jr.output !== void 0 ? jr.output : jr;
      } catch {
      }
      try {
        const hist = view.getHistory(cid);
        if (hist && hist.length > 0) {
          outputsHistory[cid] = hist.map((r) => r.output !== void 0 ? r.output : r);
        }
      } catch {
      }
    }
    outputsRecord.history = outputsHistory;
    const scopeObj = {
      step: { id: checkId, tags: checkConfig.tags || [], group: checkConfig.group },
      outputs: outputsRecord,
      outputs_history: outputsHistory,
      output: result?.output,
      memory: createMemoryHelpers(),
      event: { name: context.event || "manual" }
    };
    for (const rule of transitions) {
      const helpers = `
        const any = (arr, pred) => Array.isArray(arr) && arr.some(x => pred(x));
        const all = (arr, pred) => Array.isArray(arr) && arr.every(x => pred(x));
        const none = (arr, pred) => Array.isArray(arr) && !arr.some(x => pred(x));
        const count = (arr, pred) => Array.isArray(arr) ? arr.filter(x => pred(x)).length : 0;
      `;
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
      let matched;
      try {
        matched = compileAndRun(
          sandbox,
          code,
          { scope: scopeObj },
          { injectLog: false, wrapFunction: false }
        );
      } catch (_e) {
        try {
          const vm = __require("vm");
          const helpersFns = {
            any: (arr, pred) => Array.isArray(arr) && arr.some(pred),
            all: (arr, pred) => Array.isArray(arr) && arr.every(pred),
            none: (arr, pred) => Array.isArray(arr) && !arr.some(pred),
            count: (arr, pred) => Array.isArray(arr) ? arr.filter(pred).length : 0
          };
          const context2 = vm.createContext({
            step: scopeObj.step,
            outputs: scopeObj.outputs,
            outputs_history: scopeObj.outputs_history,
            output: scopeObj.output,
            memory: scopeObj.memory,
            event: scopeObj.event,
            ...helpersFns
          });
          const res = new vm.Script(`(${rule.when})`).runInContext(context2, { timeout: 50 });
          matched = !!res;
        } catch (_vmErr) {
          matched = false;
        }
      }
      if (matched) {
        if (rule.to === null) return null;
        if (typeof rule.to === "string" && rule.to.length > 0) {
          return { to: rule.to, goto_event: rule.goto_event };
        }
        return null;
      }
    }
    return void 0;
  } catch (err) {
    logger.error(
      `[Routing] Error evaluating transitions: ${err instanceof Error ? err.message : String(err)}`
    );
    return void 0;
  }
}
var DEFAULT_MAX_LOOPS;
var init_routing = __esm({
  "src/state-machine/states/routing.ts"() {
    init_logger();
    init_trace_helpers();
    init_failure_condition_evaluator();
    init_sandbox();
    init_memory_store();
    DEFAULT_MAX_LOOPS = 10;
  }
});

export {
  ExecutionJournal,
  snapshot_store_exports,
  init_snapshot_store,
  handleRouting,
  checkLoopBudget,
  evaluateGoto,
  evaluateTransitions,
  init_routing
};
//# sourceMappingURL=chunk-CIYYLQCY.mjs.map