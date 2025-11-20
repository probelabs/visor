import {
  FailureConditionEvaluator,
  compileAndRun,
  createSecureSandbox,
  init_failure_condition_evaluator,
  init_sandbox
} from "./chunk-HHR4HCOX.mjs";
import {
  MemoryStore,
  init_memory_store
} from "./chunk-6F5DTN74.mjs";
import {
  init_logger,
  logger
} from "./chunk-RH4HH6SI.mjs";
import {
  __esm,
  __export,
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
        const exact = visible.find((e) => this.sameScope(e.scope, this.scope));
        if (exact) return exact.result;
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
function hasDependents(context, checkId) {
  const checks = context.config.checks || {};
  for (const [cid, cfg] of Object.entries(checks)) {
    if (cid === checkId) continue;
    const rawDeps = cfg.depends_on || [];
    const depList = Array.isArray(rawDeps) ? rawDeps : [rawDeps];
    for (const dep of depList) {
      if (typeof dep !== "string") continue;
      if (dep.includes("|")) {
        const opts = dep.split("|").map((s) => s.trim()).filter(Boolean);
        if (opts.includes(checkId)) return true;
      } else if (dep === checkId) {
        return true;
      }
    }
  }
  return false;
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
async function handleRouting(context, state, transition, emitEvent, routingContext) {
  const { checkId, scope, result, checkConfig, success } = routingContext;
  if (context.debug) {
    logger.info(`[Routing] Evaluating routing for check: ${checkId}, success: ${success}`);
  }
  const failIfTriggered = await evaluateFailIf(
    checkId,
    result,
    checkConfig,
    context,
    state
  );
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
  if (checkConfig.on_finish && (checkConfig.forEach !== true || !hasDependents(context, checkId))) {
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
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? 10}) during on_finish run`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], errorIssue];
        return;
      }
      const targetConfig = context.config.checks?.[targetCheck];
      const fanoutMode = targetConfig?.fanout || "reduce";
      if (context.debug) {
        logger.info(`[Routing] on_finish.run: scheduling ${targetCheck} with fanout=${fanoutMode}, hasForEachItems=${hasForEachItems}`);
      }
      if (fanoutMode === "map" && hasForEachItems) {
        for (let itemIndex = 0; itemIndex < forEachItems.length; itemIndex++) {
          state.routingLoopCount++;
          const itemScope = [
            { check: checkId, index: itemIndex }
          ];
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
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? 10}) during on_finish run`,
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
      emitEvent({
        type: "ForwardRunRequested",
        target: targetCheck,
        scope,
        origin: "run_js"
      });
      queuedForward = true;
    }
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
        message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? 10}) during on_finish goto`,
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
        return true;
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
  const maxLoops = context.config.routing?.max_loops ?? 10;
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
    const currentCheckIsForEach = checkConfig.forEach === true;
    const forEachItems = currentCheckIsForEach ? result.forEachItems : void 0;
    const hasForEachItems = Array.isArray(forEachItems) && forEachItems.length > 0;
    for (const targetCheck of onSuccess.run) {
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
      const targetConfig = context.config.checks?.[targetCheck];
      const fanoutMode = targetConfig?.fanout || "reduce";
      if (context.debug) {
        logger.info(`[Routing] on_success.run: scheduling ${targetCheck} with fanout=${fanoutMode}, hasForEachItems=${hasForEachItems}`);
      }
      if (fanoutMode === "map" && hasForEachItems) {
        for (let itemIndex = 0; itemIndex < forEachItems.length; itemIndex++) {
          state.routingLoopCount++;
          const itemScope = [
            { check: checkId, index: itemIndex }
          ];
          emitEvent({
            type: "ForwardRunRequested",
            target: targetCheck,
            scope: itemScope,
            origin: "run"
          });
        }
      } else {
        state.routingLoopCount++;
        emitEvent({
          type: "ForwardRunRequested",
          target: targetCheck,
          scope: [],
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
      emitEvent({
        type: "ForwardRunRequested",
        target: targetCheck,
        scope,
        origin: "run_js"
      });
    }
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
    const currentCheckIsForEach = checkConfig.forEach === true;
    const forEachItems = currentCheckIsForEach ? result.forEachItems : void 0;
    const hasForEachItems = Array.isArray(forEachItems) && forEachItems.length > 0;
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
        logger.info(`[Routing] on_fail.run: scheduling ${targetCheck} with fanout=${fanoutMode}, hasForEachItems=${hasForEachItems}`);
      }
      if (fanoutMode === "map" && hasForEachItems) {
        for (let itemIndex = 0; itemIndex < forEachItems.length; itemIndex++) {
          state.routingLoopCount++;
          const itemScope = [
            { check: checkId, index: itemIndex }
          ];
          emitEvent({
            type: "ForwardRunRequested",
            target: targetCheck,
            scope: itemScope
          });
        }
      } else {
        state.routingLoopCount++;
        emitEvent({
          type: "ForwardRunRequested",
          target: targetCheck,
          scope: []
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
      emitEvent({
        type: "ForwardRunRequested",
        target: targetCheck,
        scope,
        origin: "run_js"
      });
    }
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
async function evaluateRunJs(runJs, checkId, checkConfig, result, context, state) {
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
          outputsHistory[checkIdFromJournal] = history.map((r) => r.output !== void 0 ? r.output : r);
        }
      } catch {
      }
    }
    outputsRecord.history = outputsHistory;
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
      }
    };
    const code = `
      const step = scope.step;
      const outputs = scope.outputs;
      const outputs_history = scope.outputs_history;
      const output = scope.output;
      const memory = scope.memory;
      const event = scope.event;
      const log = (...args) => console.log('\u{1F50D} Debug:', ...args);
      const __fn = () => {
        ${runJs}
      };
      const __res = __fn();
      return Array.isArray(__res) ? __res.filter(x => typeof x === 'string' && x) : [];
    `;
    const evalResult = compileAndRun(
      sandbox,
      code,
      { scope: scopeObj },
      { injectLog: false, wrapFunction: false }
    );
    return Array.isArray(evalResult) ? evalResult.filter(Boolean) : [];
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`[Routing] Error evaluating run_js: ${msg}`);
    return [];
  }
}
async function evaluateGoto(gotoJs, gotoStatic, checkId, checkConfig, result, context, state) {
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
            outputsHistory[checkIdFromJournal] = history.map((r) => r.output !== void 0 ? r.output : r);
          }
        } catch {
        }
      }
      outputsRecord.history = outputsHistory;
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
        }
      };
      if (context.debug) {
        logger.info(`[Routing] evaluateGoto: checkId=${checkId}, outputs_history keys=${Object.keys(outputsHistory).join(",")}`);
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
        const log = (...args) => console.log('\u{1F50D} Debug:', ...args);
        ${gotoJs}
      `;
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
var init_routing = __esm({
  "src/state-machine/states/routing.ts"() {
    init_logger();
    init_failure_condition_evaluator();
    init_sandbox();
    init_memory_store();
  }
});

export {
  ExecutionJournal,
  snapshot_store_exports,
  init_snapshot_store,
  handleRouting,
  checkLoopBudget,
  evaluateGoto,
  init_routing
};
//# sourceMappingURL=chunk-FUP6L2YM.mjs.map