import {
  createExtendedLiquid,
  init_liquid_extensions
} from "./chunk-PDKERNL5.mjs";
import {
  DependencyResolver,
  WorkflowRegistry,
  init_dependency_resolver,
  init_workflow_registry
} from "./chunk-OWUVOILT.mjs";
import {
  AIReviewService,
  init_ai_review_service
} from "./chunk-YC4G7Y6O.mjs";
import {
  ExecutionJournal,
  checkLoopBudget,
  handleRouting,
  init_routing,
  init_snapshot_store,
  snapshot_store_exports
} from "./chunk-CSP5LNVW.mjs";
import {
  FailureConditionEvaluator,
  compileAndRun,
  createSecureSandbox,
  init_failure_condition_evaluator,
  init_sandbox
} from "./chunk-DR5KTFIE.mjs";
import {
  createPermissionHelpers,
  detectLocalMode,
  init_author_permissions,
  resolveAssociationFromEvent
} from "./chunk-CNX7V5JK.mjs";
import {
  addEvent,
  emitNdjsonFallback,
  emitNdjsonSpanWithEvents,
  fallback_ndjson_exports,
  init_fallback_ndjson,
  init_trace_helpers,
  withActiveSpan
} from "./chunk-ZYAUYXSW.mjs";
import {
  addDiagramBlock,
  init_metrics
} from "./chunk-S2RUE2RG.mjs";
import {
  context,
  init_lazy_otel,
  trace
} from "./chunk-YSN4G6CI.mjs";
import {
  MemoryStore,
  init_memory_store,
  memory_store_exports
} from "./chunk-A7MRMUDG.mjs";
import {
  init_logger,
  logger
} from "./chunk-VMPLF6FT.mjs";
import {
  init_session_registry,
  session_registry_exports
} from "./chunk-6Y4YTKCF.mjs";
import {
  __esm,
  __export,
  __require,
  __toCommonJS
} from "./chunk-WMJKH4XE.mjs";

// src/state-machine/states/init.ts
async function handleInit(context2, state, transition) {
  if (context2.debug) {
    logger.info("[Init] Initializing state machine...");
  }
  if (!context2.config) {
    throw new Error("Configuration is required");
  }
  if (context2.memory) {
    await context2.memory.initialize();
  }
  if (context2.gitHubChecks) {
    if (context2.debug) {
      logger.info("[Init] GitHub checks service available");
    }
  }
  if (context2.debug) {
    logger.info(`[Init] Session ID: ${context2.sessionId}`);
  }
  transition("PlanReady");
}
var init_init = __esm({
  "src/state-machine/states/init.ts"() {
    "use strict";
    init_logger();
  }
});

// src/state-machine/states/plan-ready.ts
async function handlePlanReady(context2, state, transition) {
  if (context2.debug) {
    logger.info("[PlanReady] Building dependency graph...");
    if (context2.requestedChecks) {
      logger.info(`[PlanReady] Requested checks: ${context2.requestedChecks.join(", ")}`);
    }
    if (context2.config.tag_filter) {
      logger.info(
        `[PlanReady] Tag filter: include=${JSON.stringify(context2.config.tag_filter.include)}, exclude=${JSON.stringify(context2.config.tag_filter.exclude)}`
      );
    } else {
      logger.info("[PlanReady] No tag filter specified - will include only untagged checks");
    }
  }
  const eventTrigger = context2.event;
  const tagFilter = context2.config.tag_filter;
  const expandWithTransitives = (rootChecks) => {
    const expanded = new Set(rootChecks);
    const allowByTags = (checkId) => {
      if (!tagFilter) return true;
      const cfg = context2.config.checks?.[checkId];
      const tags = cfg?.tags || [];
      if (tagFilter.exclude && tagFilter.exclude.some((t) => tags.includes(t))) return false;
      if (tagFilter.include && tagFilter.include.length > 0) {
        return tagFilter.include.some((t) => tags.includes(t));
      }
      return true;
    };
    const allowByEvent = (checkId) => {
      const cfg = context2.config.checks?.[checkId];
      const triggers = cfg?.on || [];
      if (!triggers || triggers.length === 0) return true;
      const current = eventTrigger || "manual";
      return triggers.includes(current);
    };
    const visit = (checkId) => {
      const cfg = context2.config.checks?.[checkId];
      if (!cfg || !cfg.depends_on) return null;
      const depTokens = Array.isArray(cfg.depends_on) ? cfg.depends_on : [cfg.depends_on];
      const expandDep = (tok) => {
        if (tok.includes("|")) {
          return tok.split("|").map((s) => s.trim()).filter(Boolean);
        }
        return [tok];
      };
      const deps = depTokens.flatMap(expandDep);
      for (const depId of deps) {
        if (!context2.config.checks?.[depId]) {
          return `Check "${checkId}" depends on "${depId}" but "${depId}" is not defined`;
        }
        if (!allowByTags(depId)) continue;
        if (!allowByEvent(depId)) continue;
        if (!expanded.has(depId)) {
          expanded.add(depId);
          const err = visit(depId);
          if (err) return err;
        }
      }
      return null;
    };
    for (const checkId of rootChecks) {
      const err = visit(checkId);
      if (err) {
        const validationIssue = {
          file: "system",
          line: 0,
          message: err,
          category: "logic",
          severity: "error",
          ruleId: "system/error"
        };
        context2.journal.commitEntry({
          sessionId: context2.sessionId,
          scope: [],
          checkId: "system",
          result: {
            issues: [validationIssue],
            output: void 0
          }
        });
        return null;
      }
    }
    return expanded;
  };
  const requestedChecksSet = context2.requestedChecks ? expandWithTransitives(context2.requestedChecks) : void 0;
  if (context2.requestedChecks && requestedChecksSet === null) {
    logger.error(`[PlanReady] Dependency validation failed during expansion`);
    state.currentState = "Completed";
    return;
  }
  if (context2.debug && requestedChecksSet && context2.requestedChecks) {
    const added = Array.from(requestedChecksSet).filter((c) => !context2.requestedChecks.includes(c));
    if (added.length > 0) {
      logger.info(
        `[PlanReady] Expanded requested checks with transitive dependencies: ${added.join(", ")}`
      );
    }
  }
  const filteredChecks = {};
  const routingRunTargets = /* @__PURE__ */ new Set();
  for (const [, cfg] of Object.entries(context2.config.checks || {})) {
    const onFinish = cfg.on_finish || {};
    const onSuccess = cfg.on_success || {};
    const onFail = cfg.on_fail || {};
    const collect = (arr) => {
      if (Array.isArray(arr)) {
        for (const t of arr) if (typeof t === "string" && t) routingRunTargets.add(t);
      }
    };
    collect(onFinish.run);
    collect(onSuccess.run);
    collect(onFail.run);
  }
  for (const [checkId, checkConfig] of Object.entries(context2.config.checks || {})) {
    if (requestedChecksSet && !requestedChecksSet.has(checkId)) {
      if (context2.debug) {
        logger.info(
          `[PlanReady] Skipping check '${checkId}': not in expanded requested checks list`
        );
      }
      continue;
    }
    if (!requestedChecksSet && routingRunTargets.has(checkId)) {
      if (context2.debug) {
        logger.info(
          `[PlanReady] Skipping check '${checkId}': routing-run target (will be scheduled by on_*.run)`
        );
      }
      continue;
    }
    if (checkConfig.on && eventTrigger && !checkConfig.on.includes(eventTrigger)) {
      if (context2.debug) {
        logger.info(
          `[PlanReady] Skipping check '${checkId}': on=${JSON.stringify(checkConfig.on)}, event=${eventTrigger}`
        );
      }
      continue;
    }
    const checkTags = checkConfig.tags || [];
    const isTagged = checkTags.length > 0;
    if (tagFilter) {
      if (tagFilter.exclude && tagFilter.exclude.length > 0) {
        const hasExcludedTag = tagFilter.exclude.some((tag) => checkTags.includes(tag));
        if (hasExcludedTag) {
          if (context2.debug) {
            logger.info(`[PlanReady] Skipping check '${checkId}': excluded by tag filter`);
          }
          continue;
        }
      }
      if (tagFilter.include && tagFilter.include.length > 0) {
        const hasIncludedTag = tagFilter.include.some((tag) => checkTags.includes(tag));
        if (!hasIncludedTag && isTagged) {
          if (context2.debug) {
            logger.info(`[PlanReady] Skipping check '${checkId}': not included by tag filter`);
          }
          continue;
        }
      }
    } else {
      if (isTagged) {
        if (context2.debug) {
          logger.info(
            `[PlanReady] Skipping check '${checkId}': tagged but no tag filter specified`
          );
        }
        continue;
      }
    }
    filteredChecks[checkId] = checkConfig;
  }
  if (context2.debug) {
    const totalChecks = Object.keys(context2.config.checks || {}).length;
    const filteredCount = Object.keys(filteredChecks).length;
    logger.info(
      `[PlanReady] Filtered ${totalChecks} checks to ${filteredCount} based on event=${eventTrigger}`
    );
  }
  if (!context2.requestedChecks || context2.requestedChecks.length === 0) {
    const dependentsMap = /* @__PURE__ */ new Map();
    for (const [cid, cfg] of Object.entries(context2.config.checks || {})) {
      const deps = cfg.depends_on || [];
      const depList = Array.isArray(deps) ? deps : [deps];
      for (const raw of depList) {
        if (typeof raw !== "string") continue;
        const tokens = raw.includes("|") ? raw.split("|").map((s) => s.trim()).filter(Boolean) : [raw];
        for (const dep of tokens) {
          if (!dependentsMap.has(dep)) dependentsMap.set(dep, []);
          dependentsMap.get(dep).push(cid);
        }
      }
    }
    const queue = Object.keys(filteredChecks);
    const seenForward = new Set(queue);
    while (queue.length > 0) {
      const cur = queue.shift();
      const kids = dependentsMap.get(cur) || [];
      for (const child of kids) {
        if (seenForward.has(child)) continue;
        const cfg = context2.config.checks?.[child];
        if (!cfg) continue;
        if (cfg.on && eventTrigger && !cfg.on.includes(eventTrigger)) continue;
        const tags = cfg.tags || [];
        const isTagged = tags.length > 0;
        if (!tagFilter && isTagged) continue;
        if (tagFilter) {
          if (tagFilter.exclude && tagFilter.exclude.length > 0) {
            const hasExcluded = tagFilter.exclude.some((t) => tags.includes(t));
            if (hasExcluded) continue;
          }
          if (tagFilter.include && tagFilter.include.length > 0) {
            const hasIncluded = tagFilter.include.some((t) => tags.includes(t));
            if (!hasIncluded && isTagged) continue;
          }
        }
        filteredChecks[child] = cfg;
        seenForward.add(child);
        queue.push(child);
        if (context2.debug)
          logger.info(`[PlanReady] Added dependent '${child}' via forward-closure from '${cur}'`);
      }
    }
  }
  const areDependenciesSatisfied = (dependencies) => {
    for (const dep of dependencies) {
      if (dep.includes("|")) {
        const orOptions = dep.split("|").map((s) => s.trim()).filter(Boolean);
        const hasAtLeastOne = orOptions.some((opt) => filteredChecks[opt] !== void 0);
        if (!hasAtLeastOne) {
          return false;
        }
      } else {
        if (filteredChecks[dep] === void 0) {
          return false;
        }
      }
    }
    return true;
  };
  const finalChecks = {};
  for (const [checkId, checkConfig] of Object.entries(filteredChecks)) {
    const dependencies = checkConfig.depends_on || [];
    if (dependencies.length > 0 && !tagFilter && !areDependenciesSatisfied(dependencies)) {
      if (context2.debug) {
        logger.info(
          `[PlanReady] Skipping check '${checkId}': unsatisfied dependencies ${JSON.stringify(dependencies)}`
        );
      }
      continue;
    }
    finalChecks[checkId] = checkConfig;
  }
  if (context2.debug && Object.keys(finalChecks).length !== Object.keys(filteredChecks).length) {
    logger.info(
      `[PlanReady] Removed ${Object.keys(filteredChecks).length - Object.keys(finalChecks).length} checks due to unsatisfied dependencies`
    );
  }
  const checkDependencies = {};
  for (const [checkId, checkConfig] of Object.entries(finalChecks)) {
    const dependencies = (checkConfig.depends_on || []).flatMap((d) => {
      if (typeof d === "string" && d.includes("|")) {
        const orOptions = d.split("|").map((s) => s.trim()).filter(Boolean).filter((opt) => finalChecks[opt] !== void 0);
        return orOptions;
      } else {
        if (tagFilter && finalChecks[d] === void 0) {
          if (context2.debug) {
            logger.info(
              `[PlanReady] Soft dependency '${d}' of check '${checkId}' filtered out by tags - check will run without it`
            );
          }
          return [];
        }
        return [d];
      }
    });
    checkDependencies[checkId] = dependencies;
  }
  let graph;
  try {
    graph = DependencyResolver.buildDependencyGraph(checkDependencies);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error(`[PlanReady] Dependency validation failed: ${errorMsg}`);
    const validationIssue = {
      file: "system",
      line: 0,
      message: errorMsg,
      category: "logic",
      severity: "error",
      ruleId: "system/error"
    };
    context2.journal.commitEntry({
      sessionId: context2.sessionId,
      scope: [],
      checkId: "system",
      result: {
        issues: [validationIssue],
        output: void 0
      }
    });
    state.currentState = "Completed";
    return;
  }
  if (graph.hasCycles) {
    const cycleNodes = graph.cycleNodes?.join(" -> ") || "unknown";
    const errorMsg = `Dependency cycle detected: ${cycleNodes}`;
    logger.error(`[PlanReady] ${errorMsg}`);
    const cycleIssue = {
      file: "system",
      line: 0,
      message: errorMsg,
      category: "logic",
      severity: "error",
      ruleId: "system/error"
    };
    context2.journal.commitEntry({
      sessionId: context2.sessionId,
      scope: [],
      checkId: "system",
      result: {
        issues: [cycleIssue],
        output: void 0
      }
    });
    state.currentState = "Completed";
    return;
  }
  if (context2.debug) {
    logger.info(
      `[PlanReady] Graph built with ${graph.nodes.size} checks, ${graph.executionOrder.length} levels`
    );
  }
  context2.dependencyGraph = graph;
  state.wave = 0;
  transition("WavePlanning");
}
var init_plan_ready = __esm({
  "src/state-machine/states/plan-ready.ts"() {
    "use strict";
    init_dependency_resolver();
    init_logger();
  }
});

// src/state-machine/states/wave-planning.ts
async function handleWavePlanning(context2, state, transition) {
  if (context2.debug) {
    logger.info(`[WavePlanning] Planning wave ${state.wave}...`);
  }
  if (!context2.dependencyGraph) {
    throw new Error("Dependency graph not available");
  }
  const bubbledEvents = context2._bubbledEvents || [];
  if (bubbledEvents.length > 0) {
    if (context2.debug) {
      logger.info(
        `[WavePlanning] Processing ${bubbledEvents.length} bubbled events from child workflows`
      );
    }
    for (const event of bubbledEvents) {
      state.eventQueue.push(event);
    }
    context2._bubbledEvents = [];
  }
  const forwardRunRequests = state.eventQueue.filter(
    (e) => e.type === "ForwardRunRequested"
  );
  if (forwardRunRequests.length > 0 && (state.levelQueue.length === 0 || forwardRunRequests.some((r) => r.origin === "goto" || r.origin === "goto_js"))) {
    if (state.levelQueue.length > 0) {
      if (context2.debug) {
        logger.info(
          `[WavePlanning] Preempting ${state.levelQueue.length} remaining levels due to goto forward-run request`
        );
      }
      state.levelQueue = [];
    }
    if (context2.debug) {
      logger.info(`[WavePlanning] Processing ${forwardRunRequests.length} forward run requests`);
    }
    state.eventQueue = state.eventQueue.filter((e) => e.type !== "ForwardRunRequested");
    const checksToRun = /* @__PURE__ */ new Set();
    if (!state.pendingRunScopes) state.pendingRunScopes = /* @__PURE__ */ new Map();
    const eventOverrides = /* @__PURE__ */ new Map();
    for (const request of forwardRunRequests) {
      const { target, gotoEvent } = request;
      const scopeKey = request.scope && Array.isArray(request.scope) ? JSON.stringify(request.scope) : "root";
      const dedupeKey = `${target}:${gotoEvent || "default"}:${state.wave}:${scopeKey}`;
      if (state.forwardRunGuards.has(dedupeKey)) {
        if (context2.debug) {
          logger.info(`[WavePlanning] Skipping duplicate forward run: ${target}`);
        }
        continue;
      }
      state.forwardRunGuards.add(dedupeKey);
      checksToRun.add(target);
      try {
        const scope = request.scope;
        if (scope && scope.length > 0) {
          const arr = state.pendingRunScopes.get(target) || [];
          const key = (s) => JSON.stringify(s);
          if (!arr.some((s) => key(s) === key(scope))) arr.push(scope);
          state.pendingRunScopes.set(target, arr);
        }
      } catch {
      }
      if (gotoEvent) {
        eventOverrides.set(target, gotoEvent);
      }
      const dependencies = findTransitiveDependencies(target, context2);
      for (const dep of dependencies) {
        checksToRun.add(dep);
      }
      const dependents = findTransitiveDependents(target, context2, gotoEvent);
      for (const dep of dependents) {
        checksToRun.add(dep);
      }
    }
    if (checksToRun.size > 0) {
      const subgraphChecks = Array.from(checksToRun);
      const subDeps = {};
      for (const checkId of subgraphChecks) {
        const checkConfig = context2.config.checks?.[checkId];
        if (!checkConfig) continue;
        const deps = checkConfig.depends_on || [];
        const depList = Array.isArray(deps) ? deps : [deps];
        const expanded = depList.flatMap(
          (d) => typeof d === "string" && d.includes("|") ? d.split("|").map((s) => s.trim()).filter(Boolean) : [d]
        );
        subDeps[checkId] = expanded.filter((d) => checksToRun.has(d));
      }
      const subGraph = DependencyResolver.buildDependencyGraph(subDeps);
      if (subGraph.hasCycles) {
        const cycleNodes = subGraph.cycleNodes?.join(" -> ") || "unknown";
        const errorMsg = `Cycle detected in forward-run dependency subset: ${cycleNodes}`;
        logger.error(`[WavePlanning] ${errorMsg}`);
        const firstCycleCheck = subGraph.cycleNodes?.[0];
        if (firstCycleCheck) {
          const checkStats = {
            checkName: firstCycleCheck,
            totalRuns: 1,
            // Count as 1 execution attempt
            successfulRuns: 0,
            failedRuns: 1,
            skippedRuns: 0,
            skipped: false,
            totalDuration: 0,
            issuesFound: 0,
            issuesBySeverity: {
              critical: 0,
              error: 1,
              warning: 0,
              info: 0
            },
            errorMessage: errorMsg
          };
          state.stats.set(firstCycleCheck, checkStats);
        }
        transition("Completed");
        return;
      }
      state.levelQueue = [...subGraph.executionOrder];
      if (context2.debug) {
        const planned = subgraphChecks.join(", ");
        logger.info(
          `[WavePlanning] Forward-run planning: checks=[${planned}] levels=${state.levelQueue.length}`
        );
      }
      if (context2.debug) {
        logger.info(
          `[WavePlanning] Queued ${state.levelQueue.length} levels for ${checksToRun.size} checks (forward run)`
        );
      }
      state.wave++;
      state.currentWaveCompletions = /* @__PURE__ */ new Set();
      state.failedChecks = /* @__PURE__ */ new Set();
      state.flags.forwardRunRequested = false;
      transition("LevelDispatch");
      return;
    }
  }
  const waveRetryEvents = state.eventQueue.filter((e) => e.type === "WaveRetry");
  if (waveRetryEvents.length > 0 && state.levelQueue.length === 0 && !state.eventQueue.some((e) => e.type === "ForwardRunRequested")) {
    logger.info(`[WavePlanning] Processing wave retry requests (${waveRetryEvents.length} events)`);
    state.eventQueue = state.eventQueue.filter((e) => e.type !== "WaveRetry");
    const skippedIfChecks = /* @__PURE__ */ new Set();
    logger.info(`[WavePlanning] Scanning ${state.stats.size} stat entries for skipped-if checks`);
    for (const [name, stats] of state.stats.entries()) {
      logger.info(
        `[WavePlanning] Check ${name}: skipped=${stats.skipped}, skipReason=${stats.skipReason}`
      );
      if (stats.skipped === true && stats.skipReason === "if_condition") {
        skippedIfChecks.add(name);
        logger.info(`[WavePlanning] Found skipped-if check for retry: ${name}`);
      }
    }
    logger.info(`[WavePlanning] Total skipped-if checks: ${skippedIfChecks.size}`);
    if (skippedIfChecks.size === 0) {
      transition("Completed");
      return;
    }
    const checksToRun = Array.from(skippedIfChecks).filter(
      (id) => !context2.config.checks?.[id]?.forEach
    );
    const subDeps = {};
    for (const id of checksToRun) {
      const cfg = context2.config.checks?.[id];
      const deps = (cfg?.depends_on || []).filter((d) => checksToRun.includes(d));
      subDeps[id] = deps;
    }
    const subGraph = DependencyResolver.buildDependencyGraph(subDeps);
    state.levelQueue = [...subGraph.executionOrder];
    if (context2.debug) {
      logger.info(
        `[WavePlanning] Wave retry queued ${checksToRun.length} skipped-if check(s) in ${state.levelQueue.length} level(s)`
      );
    }
    state.wave++;
    state.currentWaveCompletions = /* @__PURE__ */ new Set();
    state.failedChecks = /* @__PURE__ */ new Set();
    transition("LevelDispatch");
    return;
  }
  if (state.wave === 0 && state.levelQueue.length === 0) {
    state.levelQueue = [...context2.dependencyGraph.executionOrder];
    if (context2.debug) {
      logger.info(
        `[WavePlanning] Queued ${state.levelQueue.length} levels for execution (initial wave)`
      );
    }
    state.wave++;
    state.currentWaveCompletions = /* @__PURE__ */ new Set();
    state.failedChecks = /* @__PURE__ */ new Set();
  }
  if (state.levelQueue.length > 0) {
    transition("LevelDispatch");
  } else {
    if (state.eventQueue.length > 0) {
      if (context2.debug) {
        logger.warn(
          `[WavePlanning] Event queue not empty (${state.eventQueue.length} events) but no work scheduled`
        );
      }
    }
    if (context2.debug) {
      logger.info("[WavePlanning] All waves complete");
    }
    transition("Completed");
  }
}
function findTransitiveDependencies(target, context2) {
  const dependencies = /* @__PURE__ */ new Set();
  const checks = context2.config.checks || {};
  const visited = /* @__PURE__ */ new Set();
  const dfs = (checkId) => {
    if (visited.has(checkId)) return;
    visited.add(checkId);
    const checkConfig = checks[checkId];
    if (!checkConfig) return;
    const deps = checkConfig.depends_on || [];
    const depList = Array.isArray(deps) ? deps : [deps];
    for (const depId of depList) {
      if (typeof depId !== "string") continue;
      if (depId.includes("|")) {
        const orOptions = depId.split("|").map((s) => s.trim()).filter(Boolean);
        for (const opt of orOptions) {
          if (checks[opt]) {
            const optCfg = checks[opt];
            if (String(optCfg?.type || "").toLowerCase() === "memory" && String(optCfg?.operation || "").toLowerCase() === "set") {
              continue;
            }
            dependencies.add(opt);
            dfs(opt);
          }
        }
      } else {
        if (checks[depId]) {
          const dCfg = checks[depId];
          if (String(dCfg?.type || "").toLowerCase() === "memory" && String(dCfg?.operation || "").toLowerCase() === "set") {
            continue;
          }
          dependencies.add(depId);
          dfs(depId);
        }
      }
    }
  };
  dfs(target);
  return dependencies;
}
function findTransitiveDependents(target, context2, gotoEvent) {
  const dependents = /* @__PURE__ */ new Set();
  const checks = context2.config.checks || {};
  if (context2.debug) {
    logger.info(
      `[WavePlanning] findTransitiveDependents called for target=${target}, gotoEvent=${gotoEvent}`
    );
  }
  const dependsOn = (checkId, depId) => {
    const visited = /* @__PURE__ */ new Set();
    const dfs = (current) => {
      if (visited.has(current)) return false;
      visited.add(current);
      const checkConfig = checks[current];
      if (!checkConfig) return false;
      const deps = checkConfig.depends_on || [];
      const depList = Array.isArray(deps) ? deps : [deps];
      for (const dep of depList) {
        if (typeof dep !== "string") continue;
        if (dep.includes("|")) {
          const orOptions = dep.split("|").map((s) => s.trim());
          if (orOptions.includes(depId)) return true;
        } else {
          if (dep === depId) return true;
        }
      }
      for (const d of depList) {
        if (dfs(d)) return true;
      }
      return false;
    };
    return dfs(checkId);
  };
  for (const checkId of Object.keys(checks)) {
    if (checkId === target) continue;
    const checkConfig = checks[checkId];
    if (!checkConfig) continue;
    const isDep = dependsOn(checkId, target);
    if (context2.debug && isDep) {
      logger.info(`[WavePlanning] findTransitiveDependents: ${checkId} depends on ${target}`);
    }
    if (!isDep) continue;
    if (gotoEvent) {
      const triggers = checkConfig.on;
      if (Array.isArray(triggers) && triggers.length > 0) {
        if (!triggers.includes(gotoEvent)) {
          if (context2.debug) {
            logger.info(`[WavePlanning] Skipping ${checkId}: doesn't run for event ${gotoEvent}`);
          }
          continue;
        }
      }
    }
    dependents.add(checkId);
    if (context2.debug) {
      logger.info(`[WavePlanning] Added dependent: ${checkId}`);
    }
  }
  return dependents;
}
var init_wave_planning = __esm({
  "src/state-machine/states/wave-planning.ts"() {
    "use strict";
    init_logger();
    init_dependency_resolver();
  }
});

// src/utils/mermaid-telemetry.ts
import * as fs from "fs";
import * as path from "path";
function emitMermaidFromMarkdown(checkName, markdown, origin) {
  if (!markdown || typeof markdown !== "string") return 0;
  let m;
  let count = 0;
  MERMAID_RE.lastIndex = 0;
  while ((m = MERMAID_RE.exec(markdown)) != null) {
    const code = (m[1] || "").trim();
    if (code) {
      try {
        addEvent("diagram.block", { check: checkName, origin, code });
        addDiagramBlock(origin);
        if (process.env.VISOR_TRACE_REPORT === "true") {
          const outDir = process.env.VISOR_TRACE_DIR || path.join(process.cwd(), "output", "traces");
          try {
            if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
            const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
            const jsonPath = path.join(outDir, `${ts}.trace.json`);
            const htmlPath = path.join(outDir, `${ts}.report.html`);
            let data = { spans: [] };
            if (fs.existsSync(jsonPath)) {
              try {
                data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
              } catch {
                data = { spans: [] };
              }
            }
            data.spans.push({
              events: [{ name: "diagram.block", attrs: { check: checkName, origin, code } }]
            });
            fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), "utf8");
            if (!fs.existsSync(htmlPath)) {
              fs.writeFileSync(
                htmlPath,
                '<!doctype html><html><head><meta charset="utf-8"/><title>Visor Trace Report</title></head><body><h2>Visor Trace Report</h2></body></html>',
                "utf8"
              );
            }
          } catch {
          }
        }
        count++;
      } catch {
      }
    }
  }
  return count;
}
var MERMAID_RE;
var init_mermaid_telemetry = __esm({
  "src/utils/mermaid-telemetry.ts"() {
    "use strict";
    init_trace_helpers();
    init_metrics();
    MERMAID_RE = /```mermaid\s*\n([\s\S]*?)\n```/gi;
  }
});

// src/providers/check-provider.interface.ts
var CheckProvider;
var init_check_provider_interface = __esm({
  "src/providers/check-provider.interface.ts"() {
    "use strict";
    CheckProvider = class {
    };
  }
});

// src/utils/env-resolver.ts
var EnvironmentResolver;
var init_env_resolver = __esm({
  "src/utils/env-resolver.ts"() {
    "use strict";
    EnvironmentResolver = class {
      /**
       * Resolves a single configuration value that may contain environment variable references
       */
      static resolveValue(value) {
        if (typeof value !== "string") {
          return value;
        }
        let resolved = value.replace(/\$\{\{\s*env\.([A-Z_][A-Z0-9_]*)\s*\}\}/g, (match, envVar) => {
          return process.env[envVar] || match;
        });
        resolved = resolved.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (match, envVar) => {
          return process.env[envVar] || match;
        });
        resolved = resolved.replace(/\$([A-Z_][A-Z0-9_]*)/g, (match, envVar) => {
          return process.env[envVar] || match;
        });
        return resolved;
      }
      /**
       * Resolves all environment variables in an EnvConfig object
       */
      static resolveEnvConfig(envConfig) {
        const resolved = {};
        for (const [key, value] of Object.entries(envConfig)) {
          resolved[key] = this.resolveValue(value);
        }
        return resolved;
      }
      /**
       * Applies environment configuration to the process environment
       * This allows checks to access their specific environment variables
       */
      static applyEnvConfig(envConfig) {
        const resolved = this.resolveEnvConfig(envConfig);
        for (const [key, value] of Object.entries(resolved)) {
          if (value !== void 0) {
            process.env[key] = String(value);
          }
        }
      }
      /**
       * Creates a temporary environment for a specific check execution
       * Returns a cleanup function to restore the original environment
       */
      static withTemporaryEnv(envConfig, callback) {
        const resolved = this.resolveEnvConfig(envConfig);
        const originalValues = {};
        for (const [key, value] of Object.entries(resolved)) {
          originalValues[key] = process.env[key];
          if (value !== void 0) {
            process.env[key] = String(value);
          }
        }
        try {
          const result = callback();
          if (result instanceof Promise) {
            return result.finally(() => {
              for (const [key, originalValue] of Object.entries(originalValues)) {
                if (originalValue === void 0) {
                  delete process.env[key];
                } else {
                  process.env[key] = originalValue;
                }
              }
            });
          }
          for (const [key, originalValue] of Object.entries(originalValues)) {
            if (originalValue === void 0) {
              delete process.env[key];
            } else {
              process.env[key] = originalValue;
            }
          }
          return result;
        } catch (error) {
          for (const [key, originalValue] of Object.entries(originalValues)) {
            if (originalValue === void 0) {
              delete process.env[key];
            } else {
              process.env[key] = originalValue;
            }
          }
          throw error;
        }
      }
      /**
       * Validates that all required environment variables are available
       */
      static validateRequiredEnvVars(envConfig, requiredVars) {
        const resolved = this.resolveEnvConfig(envConfig);
        const missing = [];
        for (const varName of requiredVars) {
          const value = resolved[varName] || process.env[varName];
          if (!value) {
            missing.push(varName);
          }
        }
        return missing;
      }
      /**
       * Resolves environment variables in HTTP headers
       * Each header value is processed through resolveValue to replace env var references
       */
      static resolveHeaders(headers) {
        const resolved = {};
        for (const [key, value] of Object.entries(headers)) {
          resolved[key] = String(this.resolveValue(value));
        }
        return resolved;
      }
      /**
       * Sanitizes headers for logging/telemetry by redacting sensitive values
       * Headers like Authorization, API keys, and cookies are replaced with [REDACTED]
       */
      static sanitizeHeaders(headers) {
        const sensitiveHeaders = ["authorization", "x-api-key", "cookie", "set-cookie"];
        const sanitized = {};
        for (const [key, value] of Object.entries(headers)) {
          if (sensitiveHeaders.includes(key.toLowerCase())) {
            sanitized[key] = "[REDACTED]";
          } else {
            sanitized[key] = value;
          }
        }
        return sanitized;
      }
    };
  }
});

// src/issue-filter.ts
var issue_filter_exports = {};
__export(issue_filter_exports, {
  IssueFilter: () => IssueFilter
});
import * as fs2 from "fs";
import * as path2 from "path";
var IssueFilter;
var init_issue_filter = __esm({
  "src/issue-filter.ts"() {
    "use strict";
    IssueFilter = class {
      fileCache = /* @__PURE__ */ new Map();
      suppressionEnabled;
      constructor(suppressionEnabled = true) {
        this.suppressionEnabled = suppressionEnabled;
      }
      /**
       * Filter out issues that have suppression comments
       * @param issues Array of issues to filter
       * @param workingDir Working directory for resolving file paths
       * @returns Filtered array of issues with suppressed ones removed
       */
      filterIssues(issues, workingDir = process.cwd()) {
        if (!this.suppressionEnabled || !issues || issues.length === 0) {
          return issues;
        }
        const filteredIssues = [];
        const suppressedCount = {};
        for (const issue of issues) {
          if (this.shouldSuppressIssue(issue, workingDir)) {
            suppressedCount[issue.file] = (suppressedCount[issue.file] || 0) + 1;
          } else {
            filteredIssues.push(issue);
          }
        }
        const totalSuppressed = Object.values(suppressedCount).reduce((sum, count) => sum + count, 0);
        if (totalSuppressed > 0) {
          console.log(`\u{1F507} Suppressed ${totalSuppressed} issue(s) via visor-disable comments:`);
          for (const [file, count] of Object.entries(suppressedCount)) {
            console.log(`   - ${file}: ${count} issue(s)`);
          }
        }
        return filteredIssues;
      }
      /**
       * Check if an issue should be suppressed based on comments in the file
       */
      shouldSuppressIssue(issue, workingDir) {
        if (!issue.file || issue.file === "system" || issue.file === "webhook" || issue.line === 0) {
          return false;
        }
        const lines = this.getFileLines(issue.file, workingDir);
        if (!lines || lines.length === 0) {
          return false;
        }
        const firstFiveLines = lines.slice(0, 5).join("\n").toLowerCase();
        if (firstFiveLines.includes("visor-disable-file")) {
          return true;
        }
        const lineIndex = issue.line - 1;
        const startLine = Math.max(0, lineIndex - 2);
        const endLine = Math.min(lines.length - 1, lineIndex + 2);
        for (let i = startLine; i <= endLine; i++) {
          if (lines[i].toLowerCase().includes("visor-disable")) {
            return true;
          }
        }
        return false;
      }
      /**
       * Get file lines from cache or read from disk
       */
      getFileLines(filePath, workingDir) {
        if (this.fileCache.has(filePath)) {
          return this.fileCache.get(filePath);
        }
        try {
          const resolvedPath = path2.isAbsolute(filePath) ? filePath : path2.join(workingDir, filePath);
          if (!fs2.existsSync(resolvedPath)) {
            if (fs2.existsSync(filePath)) {
              const content2 = fs2.readFileSync(filePath, "utf8");
              const lines2 = content2.split("\n");
              this.fileCache.set(filePath, lines2);
              return lines2;
            }
            return null;
          }
          const content = fs2.readFileSync(resolvedPath, "utf8");
          const lines = content.split("\n");
          this.fileCache.set(filePath, lines);
          return lines;
        } catch {
          return null;
        }
      }
      /**
       * Clear the file cache (useful for testing or long-running processes)
       */
      clearCache() {
        this.fileCache.clear();
      }
    };
  }
});

// src/telemetry/state-capture.ts
var state_capture_exports = {};
__export(state_capture_exports, {
  captureCheckInputContext: () => captureCheckInputContext,
  captureCheckOutput: () => captureCheckOutput,
  captureConditionalEvaluation: () => captureConditionalEvaluation,
  captureForEachState: () => captureForEachState,
  captureLiquidEvaluation: () => captureLiquidEvaluation,
  captureProviderCall: () => captureProviderCall,
  captureRoutingDecision: () => captureRoutingDecision,
  captureStateSnapshot: () => captureStateSnapshot,
  captureTransformJS: () => captureTransformJS
});
function safeSerialize(value, maxLength = MAX_ATTRIBUTE_LENGTH) {
  try {
    if (value === void 0 || value === null) return String(value);
    const seen = /* @__PURE__ */ new WeakSet();
    const json = JSON.stringify(value, (key, val) => {
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      if (typeof val === "string" && val.length > maxLength) {
        return val.substring(0, maxLength) + "...[truncated]";
      }
      return val;
    });
    if (json.length > maxLength) {
      return json.substring(0, maxLength) + "...[truncated]";
    }
    return json;
  } catch (err) {
    return `[Error serializing: ${err instanceof Error ? err.message : String(err)}]`;
  }
}
function captureCheckInputContext(span, context2) {
  try {
    const keys = Object.keys(context2);
    span.setAttribute("visor.check.input.keys", keys.join(","));
    span.setAttribute("visor.check.input.count", keys.length);
    span.setAttribute("visor.check.input.context", safeSerialize(context2));
    if (context2.pr) {
      span.setAttribute("visor.check.input.pr", safeSerialize(context2.pr, 1e3));
    }
    if (context2.outputs) {
      span.setAttribute("visor.check.input.outputs", safeSerialize(context2.outputs, 5e3));
    }
    if (context2.env) {
      span.setAttribute("visor.check.input.env_keys", Object.keys(context2.env).join(","));
    }
  } catch (err) {
    try {
      span.setAttribute("visor.check.input.error", String(err));
    } catch {
    }
  }
}
function captureCheckOutput(span, output) {
  try {
    span.setAttribute("visor.check.output.type", typeof output);
    if (Array.isArray(output)) {
      span.setAttribute("visor.check.output.length", output.length);
      const preview = output.slice(0, 10);
      span.setAttribute("visor.check.output.preview", safeSerialize(preview, 2e3));
    }
    span.setAttribute("visor.check.output", safeSerialize(output));
  } catch (err) {
    try {
      span.setAttribute("visor.check.output.error", String(err));
    } catch {
    }
  }
}
function captureForEachState(span, items, index, currentItem) {
  try {
    span.setAttribute("visor.foreach.total", items.length);
    span.setAttribute("visor.foreach.index", index);
    span.setAttribute("visor.foreach.current_item", safeSerialize(currentItem, 500));
    if (items.length <= MAX_ARRAY_ITEMS) {
      span.setAttribute("visor.foreach.items", safeSerialize(items));
    } else {
      span.setAttribute(
        "visor.foreach.items.preview",
        safeSerialize(items.slice(0, MAX_ARRAY_ITEMS))
      );
      span.setAttribute("visor.foreach.items.truncated", true);
    }
  } catch (err) {
    span.setAttribute("visor.foreach.error", String(err));
  }
}
function captureLiquidEvaluation(span, template, context2, result) {
  try {
    span.setAttribute("visor.liquid.template", template.substring(0, 1e3));
    span.setAttribute("visor.liquid.template.length", template.length);
    span.setAttribute("visor.liquid.result", result.substring(0, 2e3));
    span.setAttribute("visor.liquid.result.length", result.length);
    span.setAttribute("visor.liquid.context", safeSerialize(context2, 3e3));
  } catch (err) {
    span.setAttribute("visor.liquid.error", String(err));
  }
}
function captureTransformJS(span, code, input, output) {
  try {
    const codePreview = code.length > 2e3 ? code.substring(0, 2e3) + "...[truncated]" : code;
    span.setAttribute("visor.transform.code", codePreview);
    span.setAttribute("visor.transform.code.length", code.length);
    span.setAttribute("visor.transform.input", safeSerialize(input, 2e3));
    span.setAttribute("visor.transform.output", safeSerialize(output, 2e3));
  } catch (err) {
    span.setAttribute("visor.transform.error", String(err));
  }
}
function captureProviderCall(span, providerType, request, response) {
  try {
    span.setAttribute("visor.provider.type", providerType);
    if (request.model) span.setAttribute("visor.provider.request.model", String(request.model));
    if (request.prompt) {
      span.setAttribute("visor.provider.request.prompt.length", request.prompt.length);
      span.setAttribute("visor.provider.request.prompt.preview", request.prompt.substring(0, 500));
    }
    if (response.content) {
      span.setAttribute("visor.provider.response.length", response.content.length);
      span.setAttribute("visor.provider.response.preview", response.content.substring(0, 500));
    }
    if (response.tokens) {
      span.setAttribute("visor.provider.response.tokens", response.tokens);
    }
  } catch (err) {
    span.setAttribute("visor.provider.error", String(err));
  }
}
function captureConditionalEvaluation(span, condition, result, context2) {
  try {
    span.setAttribute("visor.condition.expression", condition.substring(0, 500));
    span.setAttribute("visor.condition.result", result);
    span.setAttribute("visor.condition.context", safeSerialize(context2, 2e3));
  } catch (err) {
    span.setAttribute("visor.condition.error", String(err));
  }
}
function captureRoutingDecision(span, action, target, condition) {
  try {
    span.setAttribute("visor.routing.action", action);
    span.setAttribute("visor.routing.target", Array.isArray(target) ? target.join(",") : target);
    if (condition) {
      span.setAttribute("visor.routing.condition", condition.substring(0, 500));
    }
  } catch (err) {
    span.setAttribute("visor.routing.error", String(err));
  }
}
function captureStateSnapshot(span, checkId, outputs, memory) {
  try {
    span.addEvent("state.snapshot", {
      "visor.snapshot.check_id": checkId,
      "visor.snapshot.outputs": safeSerialize(outputs, 5e3),
      "visor.snapshot.memory": safeSerialize(memory, 5e3),
      "visor.snapshot.timestamp": (/* @__PURE__ */ new Date()).toISOString()
    });
  } catch (err) {
    span.setAttribute("visor.snapshot.error", String(err));
  }
}
var MAX_ATTRIBUTE_LENGTH, MAX_ARRAY_ITEMS;
var init_state_capture = __esm({
  "src/telemetry/state-capture.ts"() {
    "use strict";
    MAX_ATTRIBUTE_LENGTH = 1e4;
    MAX_ARRAY_ITEMS = 100;
  }
});

// src/providers/ai-check-provider.ts
import fs3 from "fs/promises";
import path3 from "path";
var AICheckProvider;
var init_ai_check_provider = __esm({
  "src/providers/ai-check-provider.ts"() {
    "use strict";
    init_check_provider_interface();
    init_ai_review_service();
    init_env_resolver();
    init_issue_filter();
    init_liquid_extensions();
    init_lazy_otel();
    init_state_capture();
    AICheckProvider = class extends CheckProvider {
      aiReviewService;
      liquidEngine;
      constructor() {
        super();
        this.aiReviewService = new AIReviewService();
        this.liquidEngine = createExtendedLiquid();
      }
      getName() {
        return "ai";
      }
      getDescription() {
        return "AI-powered code review using Google Gemini, Anthropic Claude, OpenAI GPT, or AWS Bedrock models";
      }
      async validateConfig(config) {
        if (!config || typeof config !== "object") {
          return false;
        }
        const cfg = config;
        if (cfg.type !== "ai") {
          return false;
        }
        const prompt = cfg.prompt || cfg.focus;
        if (typeof prompt !== "string") {
          return false;
        }
        if (cfg.ai) {
          if (cfg.ai.provider && !["google", "anthropic", "openai", "bedrock", "mock"].includes(cfg.ai.provider)) {
            return false;
          }
          if (cfg.ai.mcpServers) {
            if (!this.validateMcpServers(cfg.ai.mcpServers)) {
              return false;
            }
          }
        }
        const checkLevelMcpServers = cfg.ai_mcp_servers;
        if (checkLevelMcpServers) {
          if (!this.validateMcpServers(checkLevelMcpServers)) {
            return false;
          }
        }
        return true;
      }
      /**
       * Validate MCP servers configuration
       */
      validateMcpServers(mcpServers) {
        if (typeof mcpServers !== "object" || mcpServers === null) {
          return false;
        }
        for (const serverConfig of Object.values(mcpServers)) {
          if (!serverConfig || typeof serverConfig !== "object") {
            return false;
          }
          const config = serverConfig;
          if (typeof config.command !== "string") {
            return false;
          }
          if (config.args !== void 0 && !Array.isArray(config.args)) {
            return false;
          }
        }
        return true;
      }
      /**
       * Group files by their file extension for template context
       */
      groupFilesByExtension(files) {
        const grouped = {};
        files.forEach((file) => {
          const parts = file.filename.split(".");
          const ext = parts.length > 1 ? parts.pop()?.toLowerCase() || "noext" : "noext";
          if (!grouped[ext]) {
            grouped[ext] = [];
          }
          grouped[ext].push(file);
        });
        return grouped;
      }
      /**
       * Process prompt configuration to resolve final prompt string
       */
      async processPrompt(promptConfig, prInfo, eventContext, dependencyResults, outputHistory) {
        let promptContent;
        if (await this.isFilePath(promptConfig)) {
          promptContent = await this.loadPromptFromFile(promptConfig);
        } else {
          promptContent = promptConfig;
        }
        return await this.renderPromptTemplate(
          promptContent,
          prInfo,
          eventContext,
          dependencyResults,
          outputHistory
        );
      }
      /**
       * Detect if a string is likely a file path and if the file exists
       */
      async isFilePath(str) {
        if (!str || str.trim() !== str || str.length > 512) {
          return false;
        }
        if (/\s{2,}/.test(str) || // Multiple consecutive spaces
        /\n/.test(str) || // Contains newlines
        /^(please|analyze|review|check|find|identify|look|search)/i.test(str.trim()) || // Starts with command words
        str.split(" ").length > 8) {
          return false;
        }
        if (!/[\/\\]/.test(str)) {
          if (/\b(the|and|or|but|for|with|by|from|in|on|at|as)\b/i.test(str)) {
            return false;
          }
        }
        const hasFileExtension = /\.[a-zA-Z0-9]{1,10}$/i.test(str);
        const hasPathSeparators = /[\/\\]/.test(str);
        const isRelativePath = /^\.{1,2}\//.test(str);
        const isAbsolutePath = path3.isAbsolute(str);
        const hasTypicalFileChars = /^[a-zA-Z0-9._\-\/\\:~]+$/.test(str);
        if (!(hasFileExtension || isRelativePath || isAbsolutePath || hasPathSeparators)) {
          return false;
        }
        if (!hasTypicalFileChars) {
          return false;
        }
        try {
          let resolvedPath;
          if (path3.isAbsolute(str)) {
            resolvedPath = path3.normalize(str);
          } else {
            resolvedPath = path3.resolve(process.cwd(), str);
          }
          const fs6 = __require("fs").promises;
          try {
            const stat = await fs6.stat(resolvedPath);
            return stat.isFile();
          } catch {
            return hasFileExtension && (isRelativePath || isAbsolutePath || hasPathSeparators);
          }
        } catch {
          return false;
        }
      }
      /**
       * Load prompt content from file with security validation
       */
      async loadPromptFromFile(promptPath) {
        if (!promptPath.endsWith(".liquid")) {
          throw new Error("Prompt file must have .liquid extension");
        }
        let resolvedPath;
        if (path3.isAbsolute(promptPath)) {
          resolvedPath = promptPath;
        } else {
          resolvedPath = path3.resolve(process.cwd(), promptPath);
        }
        if (!path3.isAbsolute(promptPath)) {
          const normalizedPath = path3.normalize(resolvedPath);
          const currentDir = path3.resolve(process.cwd());
          if (!normalizedPath.startsWith(currentDir)) {
            throw new Error("Invalid prompt file path: path traversal detected");
          }
        }
        if (promptPath.includes("../..")) {
          throw new Error("Invalid prompt file path: path traversal detected");
        }
        try {
          const promptContent = await fs3.readFile(resolvedPath, "utf-8");
          return promptContent;
        } catch (error) {
          throw new Error(
            `Failed to load prompt from ${resolvedPath}: ${error instanceof Error ? error.message : "Unknown error"}`
          );
        }
      }
      /**
       * Render Liquid template in prompt with comprehensive event context
       */
      async renderPromptTemplate(promptContent, prInfo, eventContext, dependencyResults, outputHistory) {
        const outputsRaw = {};
        if (dependencyResults) {
          for (const [k, v] of dependencyResults.entries()) {
            if (typeof k !== "string") continue;
            if (k.endsWith("-raw")) {
              const name = k.slice(0, -4);
              const summary = v;
              outputsRaw[name] = summary.output !== void 0 ? summary.output : summary;
            }
          }
        }
        const templateContext = {
          // PR Information
          pr: {
            number: prInfo.number,
            title: prInfo.title,
            body: prInfo.body,
            author: prInfo.author,
            baseBranch: prInfo.base,
            headBranch: prInfo.head,
            isIncremental: prInfo.isIncremental,
            filesChanged: prInfo.files?.map((f) => f.filename) || [],
            totalAdditions: prInfo.files?.reduce((sum, f) => sum + f.additions, 0) || 0,
            totalDeletions: prInfo.files?.reduce((sum, f) => sum + f.deletions, 0) || 0,
            totalChanges: prInfo.files?.reduce((sum, f) => sum + f.changes, 0) || 0,
            base: prInfo.base,
            head: prInfo.head
          },
          // File Details
          files: prInfo.files || [],
          description: prInfo.body || "",
          // GitHub Event Context
          event: eventContext ? {
            name: eventContext.event_name || "unknown",
            action: eventContext.action,
            isPullRequest: !prInfo.isIssue,
            // Set based on whether this is a PR or an issue
            // Repository Info
            repository: eventContext.repository ? {
              owner: eventContext.repository?.owner?.login,
              name: eventContext.repository?.name,
              fullName: eventContext.repository ? `${eventContext.repository?.owner?.login}/${eventContext.repository?.name}` : void 0
            } : void 0,
            // Comment Data (for comment events)
            comment: eventContext.comment ? {
              body: eventContext.comment?.body,
              author: eventContext.comment?.user?.login
            } : void 0,
            // Issue Data (for issue events)
            issue: eventContext.issue ? {
              number: eventContext.issue?.number,
              title: eventContext.issue?.title,
              body: eventContext.issue?.body,
              state: eventContext.issue?.state,
              author: eventContext.issue?.user?.login,
              labels: eventContext.issue?.labels || [],
              assignees: eventContext?.issue?.assignees?.map((a) => a.login) || [],
              createdAt: eventContext.issue?.created_at,
              updatedAt: eventContext.issue?.updated_at,
              isPullRequest: !!eventContext.issue?.pull_request
            } : void 0,
            // Pull Request Event Data
            pullRequest: eventContext.pull_request ? {
              number: eventContext.pull_request?.number,
              state: eventContext.pull_request?.state,
              draft: eventContext.pull_request?.draft,
              headSha: eventContext.pull_request?.head?.sha,
              headRef: eventContext.pull_request?.head?.ref,
              baseSha: eventContext.pull_request?.base?.sha,
              baseRef: eventContext.pull_request?.base?.ref
            } : void 0,
            // Raw event payload for advanced use cases
            payload: eventContext
          } : void 0,
          // Utility data for templates
          utils: {
            // Date/time helpers
            now: (/* @__PURE__ */ new Date()).toISOString(),
            today: (/* @__PURE__ */ new Date()).toISOString().split("T")[0],
            // Dynamic file grouping by extension
            filesByExtension: this.groupFilesByExtension(prInfo.files || []),
            // File status categorizations
            addedFiles: (prInfo.files || []).filter((f) => f.status === "added"),
            modifiedFiles: (prInfo.files || []).filter((f) => f.status === "modified"),
            removedFiles: (prInfo.files || []).filter((f) => f.status === "removed"),
            renamedFiles: (prInfo.files || []).filter((f) => f.status === "renamed"),
            // Change analysis
            hasLargeChanges: (prInfo.files || []).some((f) => f.changes > 50),
            totalFiles: (prInfo.files || []).length
          },
          // Previous check outputs (dependency results)
          // Expose raw output directly if available, otherwise expose the result as-is
          outputs: dependencyResults ? Object.fromEntries(
            Array.from(dependencyResults.entries()).map(([checkName, result]) => [
              checkName,
              (() => {
                const summary = result;
                return summary.output !== void 0 ? summary.output : summary;
              })()
            ])
          ) : {},
          // Alias for consistency with other providers
          outputs_history: (() => {
            const hist = {};
            if (outputHistory) {
              for (const [k, v] of outputHistory.entries()) hist[k] = v;
            }
            return hist;
          })(),
          // Stage-scoped history slice calculated from baseline captured by the flow runner.
          outputs_history_stage: (() => {
            const stage = {};
            try {
              const base = eventContext?.__stageHistoryBase;
              if (!outputHistory || !base) return stage;
              for (const [k, v] of outputHistory.entries()) {
                const start = base[k] || 0;
                const arr = Array.isArray(v) ? v : [];
                stage[k] = arr.slice(start);
              }
            } catch {
            }
            return stage;
          })(),
          // New: outputs_raw exposes aggregate values (e.g., full arrays for forEach parents)
          outputs_raw: outputsRaw
        };
        try {
          if (process.env.VISOR_DEBUG === "true") {
            console.error(
              `[prompt-ctx] outputs.keys=${Object.keys(templateContext.outputs || {}).join(", ")} hist.validate-fact.len=${(() => {
                try {
                  const h = templateContext.outputs_history || {};
                  const v = h["validate-fact"];
                  return Array.isArray(v) ? v.length : 0;
                } catch {
                  return 0;
                }
              })()}`
            );
          }
        } catch {
        }
        try {
          return await this.liquidEngine.parseAndRender(promptContent, templateContext);
        } catch (error) {
          const err = error || {};
          const lines = String(promptContent || "").split(/\r?\n/);
          const lineNum = Number(err.line || err?.token?.line || err?.location?.line || 0);
          const colNum = Number(err.col || err?.token?.col || err?.location?.col || 0);
          let snippet = "";
          if (lineNum > 0) {
            const start = Math.max(1, lineNum - 3);
            const end = Math.max(lineNum + 2, lineNum);
            const width = String(end).length;
            for (let i = start; i <= Math.min(end, lines.length); i++) {
              const ln = `${String(i).padStart(width, " ")} | ${lines[i - 1] ?? ""}`;
              snippet += ln + "\n";
              if (i === lineNum) {
                const caretPad = " ".repeat(Math.max(0, colNum > 1 ? colNum - 1 : 0) + width + 3);
                snippet += caretPad + "^\n";
              }
            }
          } else {
            const preview = lines.slice(0, 20).map((l, i) => `${(i + 1).toString().padStart(3, " ")} | ${l}`).join("\n");
            snippet = preview + "\n";
          }
          const msg = `Failed to render prompt template: ${error instanceof Error ? error.message : "Unknown error"}`;
          try {
            console.error("\n[prompt-error] " + msg + "\n" + snippet);
          } catch {
          }
          throw new Error(msg);
        }
      }
      async execute(prInfo, config, _dependencyResults, sessionInfo) {
        if (config.env) {
          const result = EnvironmentResolver.withTemporaryEnv(config.env, () => {
            return this.executeWithConfig(prInfo, config, _dependencyResults, sessionInfo);
          });
          if (result instanceof Promise) {
            return result;
          }
          return result;
        }
        return this.executeWithConfig(prInfo, config, _dependencyResults, sessionInfo);
      }
      async executeWithConfig(prInfo, config, _dependencyResults, sessionInfo) {
        try {
          if (process.env.VISOR_DEBUG === "true") {
            console.error(`[ai-exec] step=${String(config.checkName || "unknown")}`);
          }
        } catch {
        }
        const aiConfig = {};
        if (config.ai) {
          if (config.ai.apiKey !== void 0) {
            aiConfig.apiKey = config.ai.apiKey;
          }
          if (config.ai.model !== void 0) {
            aiConfig.model = config.ai.model;
          }
          if (config.ai.timeout !== void 0) {
            aiConfig.timeout = config.ai.timeout;
          }
          if (config.ai.provider !== void 0) {
            aiConfig.provider = config.ai.provider;
          }
          if (config.ai.debug !== void 0) {
            aiConfig.debug = config.ai.debug;
          }
          if (config.ai.enableDelegate !== void 0) {
            aiConfig.enableDelegate = config.ai.enableDelegate;
          }
          if (config.ai.allowEdit !== void 0) {
            aiConfig.allowEdit = config.ai.allowEdit;
          }
          if (config.ai.allowedTools !== void 0) {
            aiConfig.allowedTools = config.ai.allowedTools;
          }
          if (config.ai.disableTools !== void 0) {
            aiConfig.disableTools = config.ai.disableTools;
          }
          if (config.ai.allowBash !== void 0) {
            aiConfig.allowBash = config.ai.allowBash;
          }
          if (config.ai.bashConfig !== void 0) {
            aiConfig.bashConfig = config.ai.bashConfig;
          }
          if (config.ai.skip_code_context !== void 0) {
            aiConfig.skip_code_context = config.ai.skip_code_context;
          }
          if (config.ai.retry !== void 0) {
            aiConfig.retry = config.ai.retry;
          }
          if (config.ai.fallback !== void 0) {
            aiConfig.fallback = config.ai.fallback;
          }
        }
        if (config.ai_model !== void 0) {
          aiConfig.model = config.ai_model;
        }
        if (config.ai_provider !== void 0) {
          aiConfig.provider = config.ai_provider;
        }
        const customPrompt = config.prompt;
        if (!customPrompt) {
          throw new Error(
            `No prompt defined for check. All checks must have prompts defined in .visor.yaml configuration.`
          );
        }
        const mcpServers = {};
        const globalConfig = config;
        if (globalConfig.ai_mcp_servers) {
          Object.assign(mcpServers, globalConfig.ai_mcp_servers);
        }
        if (config.ai_mcp_servers) {
          Object.assign(mcpServers, config.ai_mcp_servers);
        }
        if (config.ai?.mcpServers) {
          Object.assign(mcpServers, config.ai.mcpServers);
        }
        if (Object.keys(mcpServers).length > 0 && !config.ai?.disableTools) {
          aiConfig.mcpServers = mcpServers;
        } else if (config.ai?.disableTools) {
        }
        const templateContext = {
          pr: {
            number: prInfo.number,
            title: prInfo.title,
            author: prInfo.author,
            branch: prInfo.head,
            base: prInfo.base
          },
          files: prInfo.files,
          outputs: _dependencyResults ? Object.fromEntries(
            Array.from(_dependencyResults.entries()).map(([checkName, result]) => [
              checkName,
              result.output !== void 0 ? result.output : result
            ])
          ) : {}
        };
        try {
          const span = trace.getSpan(context.active());
          if (span) {
            captureCheckInputContext(span, templateContext);
          }
        } catch {
        }
        try {
          const checkId = config.checkName || config.id || "unknown";
          const ctxJson = JSON.stringify(templateContext);
          const { emitNdjsonSpanWithEvents: emitNdjsonSpanWithEvents2 } = (init_fallback_ndjson(), __toCommonJS(fallback_ndjson_exports));
          emitNdjsonSpanWithEvents2(
            "visor.check",
            { "visor.check.id": checkId, "visor.check.input.context": ctxJson },
            []
          );
        } catch {
        }
        const eventContext = config.eventContext || {};
        const ctxWithStage = {
          ...eventContext || {},
          __stageHistoryBase: sessionInfo?.stageHistoryBase
        };
        const processedPrompt = await this.processPrompt(
          customPrompt,
          prInfo,
          ctxWithStage,
          _dependencyResults,
          config.__outputHistory
        );
        const aiAny = config.ai || {};
        const persona = (aiAny?.ai_persona || config.ai_persona || "").toString().trim();
        const finalPrompt = persona ? `Persona: ${persona}

${processedPrompt}` : processedPrompt;
        try {
          const pt = (config.ai?.promptType || config.ai_prompt_type || "").toString().trim();
          if (pt) process.env.VISOR_PROMPT_TYPE = pt;
        } catch {
        }
        try {
          const stepName = config.checkName || "unknown";
          const serviceForCapture = new AIReviewService(aiConfig);
          const finalPromptCapture = await serviceForCapture.buildCustomPrompt(
            prInfo,
            finalPrompt,
            config.schema,
            {
              checkName: config.checkName,
              skipPRContext: config.ai?.skip_code_context === true
            }
          );
          sessionInfo?.hooks?.onPromptCaptured?.({
            step: String(stepName),
            provider: "ai",
            prompt: finalPromptCapture
          });
        } catch {
        }
        try {
          const stepName = config.checkName || "unknown";
          const mock = sessionInfo?.hooks?.mockForStep?.(String(stepName));
          if (mock !== void 0) {
            return { issues: [], output: mock };
          }
        } catch {
        }
        try {
          const pt = (aiAny?.prompt_type || config.ai_prompt_type || "").toString().trim();
          if (pt) aiConfig.promptType = pt;
          const sys = (aiAny?.system_prompt || config.ai_system_prompt || "").toString().trim();
          const legacy = (aiAny?.custom_prompt || config.ai_custom_prompt || "").toString().trim();
          if (sys) aiConfig.systemPrompt = sys;
          else if (legacy) aiConfig.systemPrompt = legacy;
        } catch {
        }
        const service = new AIReviewService(aiConfig);
        const schema = config.schema;
        try {
          let result;
          const reuseEnabled = config.reuse_ai_session === true || typeof config.reuse_ai_session === "string";
          if (sessionInfo?.reuseSession && sessionInfo.parentSessionId && reuseEnabled) {
            try {
              const { SessionRegistry } = (init_session_registry(), __toCommonJS(session_registry_exports));
              const reg = SessionRegistry.getInstance();
              if (!reg.hasSession(sessionInfo.parentSessionId)) {
                if (aiConfig.debug || process.env.VISOR_DEBUG === "true") {
                  console.warn(
                    `\u26A0\uFE0F  Parent session ${sessionInfo.parentSessionId} not found; creating a new session for ${config.checkName}`
                  );
                }
                const fresh = await service.executeReview(
                  prInfo,
                  processedPrompt,
                  schema,
                  config.checkName,
                  config.sessionId
                );
                return {
                  ...fresh,
                  issues: new IssueFilter(config.suppressionEnabled !== false).filterIssues(
                    fresh.issues || [],
                    process.cwd()
                  )
                };
              }
            } catch {
            }
            const sessionMode = config.session_mode || "clone";
            if (aiConfig.debug) {
              console.error(
                `\u{1F504} Debug: Using session reuse with parent session: ${sessionInfo.parentSessionId} (mode: ${sessionMode})`
              );
            }
            result = await service.executeReviewWithSessionReuse(
              prInfo,
              processedPrompt,
              sessionInfo.parentSessionId,
              schema,
              config.checkName,
              sessionMode
            );
          } else {
            if (aiConfig.debug) {
              console.error(`\u{1F195} Debug: Creating new AI session for check: ${config.checkName}`);
            }
            result = await service.executeReview(
              prInfo,
              finalPrompt,
              schema,
              config.checkName,
              config.sessionId
            );
          }
          const suppressionEnabled = config.suppressionEnabled !== false;
          const issueFilter = new IssueFilter(suppressionEnabled);
          const filteredIssues = issueFilter.filterIssues(result.issues || [], process.cwd());
          const finalResult = {
            ...result,
            issues: filteredIssues
          };
          try {
            const span = trace.getSpan(context.active());
            if (span) {
              captureProviderCall(
                span,
                "ai",
                {
                  prompt: processedPrompt.substring(0, 500),
                  // Preview only
                  model: aiConfig.model
                },
                {
                  content: JSON.stringify(finalResult).substring(0, 500),
                  tokens: result.usage?.totalTokens
                }
              );
              const outputForSpan = finalResult.output ?? finalResult;
              captureCheckOutput(span, outputForSpan);
            }
          } catch {
          }
          try {
            const checkId = config.checkName || config.id || "unknown";
            const outJson = JSON.stringify(finalResult.output ?? finalResult);
            const { emitNdjsonSpanWithEvents: emitNdjsonSpanWithEvents2 } = (init_fallback_ndjson(), __toCommonJS(fallback_ndjson_exports));
            emitNdjsonSpanWithEvents2(
              "visor.check",
              { "visor.check.id": checkId, "visor.check.output": outJson },
              []
            );
          } catch {
          }
          return finalResult;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`\u274C AI Check Provider Error for check: ${errorMessage}`);
          const isCriticalError = errorMessage.includes("API rate limit") || errorMessage.includes("403") || errorMessage.includes("401") || errorMessage.includes("authentication") || errorMessage.includes("API key");
          if (isCriticalError) {
            console.error(`\u{1F6A8} CRITICAL ERROR: AI provider authentication or rate limit issue detected`);
            console.error(`\u{1F6A8} This check cannot proceed without valid API credentials`);
          }
          throw new Error(`AI analysis failed: ${errorMessage}`);
        }
      }
      getSupportedConfigKeys() {
        return [
          "type",
          "prompt",
          "focus",
          "schema",
          "group",
          "ai.provider",
          "ai.model",
          "ai.apiKey",
          "ai.timeout",
          "ai.mcpServers",
          "ai.enableDelegate",
          // legacy persona/prompt keys supported in config
          "ai_persona",
          "ai_prompt_type",
          "ai_custom_prompt",
          "ai_system_prompt",
          // new provider resilience and tools toggles
          "ai.retry",
          "ai.fallback",
          "ai.allowEdit",
          "ai.allowedTools",
          "ai.disableTools",
          "ai.allowBash",
          "ai.bashConfig",
          "ai_model",
          "ai_provider",
          "ai_mcp_servers",
          "env"
        ];
      }
      async isAvailable() {
        return !!(process.env.GOOGLE_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || // AWS Bedrock credentials check
        process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_BEDROCK_API_KEY);
      }
      getRequirements() {
        return [
          "At least one of: GOOGLE_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or AWS credentials (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY)",
          "Optional: MODEL_NAME environment variable",
          "Optional: AWS_REGION for Bedrock provider",
          "Network access to AI provider APIs"
        ];
      }
    };
  }
});

// src/providers/http-check-provider.ts
var HttpCheckProvider;
var init_http_check_provider = __esm({
  "src/providers/http-check-provider.ts"() {
    "use strict";
    init_check_provider_interface();
    init_issue_filter();
    init_liquid_extensions();
    init_lazy_otel();
    init_state_capture();
    init_env_resolver();
    HttpCheckProvider = class extends CheckProvider {
      liquid;
      constructor() {
        super();
        this.liquid = createExtendedLiquid();
      }
      getName() {
        return "http";
      }
      getDescription() {
        return "Send data to external HTTP endpoint for notifications or integration";
      }
      async validateConfig(config) {
        if (!config || typeof config !== "object") {
          return false;
        }
        const cfg = config;
        if (cfg.type !== "http") {
          return false;
        }
        if (typeof cfg.url !== "string" || !cfg.url) {
          return false;
        }
        if (typeof cfg.body !== "string" || !cfg.body) {
          return false;
        }
        try {
          new URL(cfg.url);
          return true;
        } catch {
          return false;
        }
      }
      async execute(prInfo, config, dependencyResults, _sessionInfo) {
        const url = config.url;
        const bodyTemplate = config.body;
        const method = config.method || "POST";
        const headers = config.headers || {};
        const timeout = config.timeout || 3e4;
        const templateContext = {
          pr: {
            number: prInfo.number,
            title: prInfo.title,
            body: prInfo.body,
            author: prInfo.author,
            base: prInfo.base,
            head: prInfo.head,
            totalAdditions: prInfo.totalAdditions,
            totalDeletions: prInfo.totalDeletions
          },
          files: prInfo.files.map((f) => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
            patch: f.patch
          })),
          outputs: dependencyResults ? Object.fromEntries(dependencyResults) : {},
          metadata: config.metadata || {}
        };
        try {
          const span = trace.getSpan(context.active());
          if (span) {
            captureCheckInputContext(span, templateContext);
          }
        } catch {
        }
        let payload;
        try {
          const renderedBody = await this.liquid.parseAndRender(bodyTemplate, templateContext);
          try {
            payload = JSON.parse(renderedBody);
          } catch {
            payload = { message: renderedBody };
          }
        } catch (error) {
          return this.createErrorResult(
            url,
            new Error(
              `Template rendering failed: ${error instanceof Error ? error.message : "Unknown error"}`
            )
          );
        }
        try {
          const resolvedHeaders = EnvironmentResolver.resolveHeaders(headers);
          const response = await this.sendWebhookRequest(
            url,
            method,
            resolvedHeaders,
            payload,
            timeout
          );
          const result = this.parseWebhookResponse(response, url);
          const suppressionEnabled = config.suppressionEnabled !== false;
          const issueFilter = new IssueFilter(suppressionEnabled);
          const filteredIssues = issueFilter.filterIssues(result.issues || [], process.cwd());
          const finalResult = {
            ...result,
            issues: filteredIssues
          };
          try {
            const span = trace.getSpan(context.active());
            if (span) {
              const sanitizedHeaders = EnvironmentResolver.sanitizeHeaders(resolvedHeaders);
              captureProviderCall(
                span,
                "http",
                {
                  url,
                  method,
                  headers: sanitizedHeaders,
                  body: JSON.stringify(payload).substring(0, 500)
                },
                {
                  content: JSON.stringify(response).substring(0, 500)
                }
              );
              const outputForSpan = finalResult.output ?? finalResult;
              captureCheckOutput(span, outputForSpan);
            }
          } catch {
          }
          return finalResult;
        } catch (error) {
          return this.createErrorResult(url, error);
        }
      }
      async sendWebhookRequest(url, method, headers, payload, timeout) {
        if (typeof fetch === "undefined") {
          throw new Error("Webhook provider requires Node.js 18+ or node-fetch package");
        }
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        try {
          const response = await fetch(url, {
            method,
            headers: {
              "Content-Type": "application/json",
              ...headers
            },
            body: JSON.stringify(payload),
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          if (!response.ok) {
            throw new Error(`Webhook returned ${response.status}: ${response.statusText}`);
          }
          return await response.json();
        } catch (error) {
          clearTimeout(timeoutId);
          if (error instanceof Error && error.name === "AbortError") {
            throw new Error(`Webhook request timed out after ${timeout}ms`);
          }
          throw error;
        }
      }
      parseWebhookResponse(response, url) {
        if (!response || typeof response !== "object") {
          return this.createErrorResult(url, new Error("Invalid webhook response format"));
        }
        const issues = Array.isArray(response.comments) ? response.comments.map((c) => ({
          file: c.file || "unknown",
          line: c.line || 0,
          endLine: c.endLine,
          ruleId: c.ruleId || `webhook/${this.validateCategory(c.category)}`,
          message: c.message || "",
          severity: this.validateSeverity(c.severity),
          category: this.validateCategory(c.category),
          suggestion: c.suggestion,
          replacement: c.replacement
        })) : [];
        return {
          issues
        };
      }
      createErrorResult(url, error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        return {
          issues: [
            {
              file: "webhook",
              line: 0,
              endLine: void 0,
              ruleId: "webhook/error",
              message: `Webhook execution error: ${errorMessage}`,
              severity: "error",
              category: "logic",
              suggestion: void 0,
              replacement: void 0
            }
          ]
        };
      }
      validateSeverity(severity) {
        const valid = ["info", "warning", "error", "critical"];
        return valid.includes(severity) ? severity : "info";
      }
      validateCategory(category) {
        const valid = ["security", "performance", "style", "logic", "documentation"];
        return valid.includes(category) ? category : "logic";
      }
      getSupportedConfigKeys() {
        return [
          "type",
          "url",
          "body",
          "method",
          "headers",
          "timeout",
          "metadata",
          "depends_on",
          "on",
          "if",
          "group",
          "schedule"
        ];
      }
      async isAvailable() {
        return typeof fetch !== "undefined";
      }
      getRequirements() {
        return [
          "Valid HTTP URL",
          "Body template (Liquid) for payload construction",
          "Network access to HTTP endpoint",
          "Optional: Dependencies for accessing their outputs in templates"
        ];
      }
    };
  }
});

// src/providers/http-input-provider.ts
var HttpInputProvider;
var init_http_input_provider = __esm({
  "src/providers/http-input-provider.ts"() {
    "use strict";
    init_check_provider_interface();
    init_liquid_extensions();
    init_logger();
    HttpInputProvider = class extends CheckProvider {
      liquid;
      webhookContext;
      constructor() {
        super();
        this.liquid = createExtendedLiquid();
      }
      /**
       * Set webhook context for accessing webhook data
       */
      setWebhookContext(webhookContext) {
        this.webhookContext = webhookContext;
      }
      getName() {
        return "http_input";
      }
      getDescription() {
        return "Receive and process HTTP webhook input data for use by dependent checks";
      }
      async validateConfig(config) {
        if (!config || typeof config !== "object") {
          return false;
        }
        const cfg = config;
        if (cfg.type !== "http_input") {
          return false;
        }
        if (typeof cfg.endpoint !== "string" || !cfg.endpoint) {
          return false;
        }
        if (cfg.transform !== void 0 && typeof cfg.transform !== "string") {
          return false;
        }
        return true;
      }
      async execute(prInfo, config, _dependencyResults, _sessionInfo) {
        const endpoint = config.endpoint;
        const transform = config.transform;
        const webhookData = this.getWebhookData(endpoint);
        if (!webhookData) {
          return {
            issues: []
          };
        }
        let processedData = webhookData;
        if (transform) {
          try {
            const templateContext = {
              webhook: webhookData,
              pr: {
                number: prInfo.number,
                title: prInfo.title,
                author: prInfo.author,
                base: prInfo.base,
                head: prInfo.head
              }
            };
            const rendered = await this.liquid.parseAndRender(transform, templateContext);
            processedData = JSON.parse(rendered);
            logger.verbose(`\u2713 Applied webhook transform successfully`);
          } catch (error) {
            logger.error(
              `\u2717 Failed to transform webhook data: ${error instanceof Error ? error.message : "Unknown error"}`
            );
            return {
              issues: [
                {
                  file: "webhook_input",
                  line: 0,
                  ruleId: "webhook_input/transform_error",
                  message: `Failed to transform webhook data: ${error instanceof Error ? error.message : "Unknown error"}`,
                  severity: "error",
                  category: "logic"
                }
              ]
            };
          }
        }
        return {
          issues: [],
          // Add custom data field that will be passed through
          data: processedData
        };
      }
      getWebhookData(endpoint) {
        if (this.webhookContext) {
          return this.webhookContext.get(endpoint) || null;
        }
        const globalWebhookStore = global.__visor_webhook_data;
        if (globalWebhookStore && globalWebhookStore.get) {
          console.warn(
            "HttpInputProvider: Using deprecated global webhook store. Please use webhook context instead."
          );
          return globalWebhookStore.get(endpoint) || null;
        }
        return null;
      }
      getSupportedConfigKeys() {
        return ["type", "endpoint", "transform", "on", "depends_on", "if", "group"];
      }
      async isAvailable() {
        return true;
      }
      getRequirements() {
        return [
          "HTTP server must be configured and running",
          "Valid endpoint path specified",
          "Optional: Transform template for data processing"
        ];
      }
    };
  }
});

// src/providers/http-client-provider.ts
var HttpClientProvider;
var init_http_client_provider = __esm({
  "src/providers/http-client-provider.ts"() {
    "use strict";
    init_check_provider_interface();
    init_liquid_extensions();
    init_env_resolver();
    HttpClientProvider = class extends CheckProvider {
      liquid;
      constructor() {
        super();
        this.liquid = createExtendedLiquid();
      }
      getName() {
        return "http_client";
      }
      getDescription() {
        return "Fetch data from HTTP endpoints for use by dependent checks";
      }
      async validateConfig(config) {
        if (!config || typeof config !== "object") {
          return false;
        }
        const cfg = config;
        if (cfg.type !== "http_client") {
          return false;
        }
        if (typeof cfg.url !== "string" || !cfg.url) {
          return false;
        }
        try {
          new URL(cfg.url);
          return true;
        } catch {
          return false;
        }
      }
      async execute(prInfo, config, dependencyResults, context2) {
        const url = config.url;
        const method = config.method || "GET";
        const headers = config.headers || {};
        const timeout = config.timeout || 3e4;
        const transform = config.transform;
        const bodyTemplate = config.body;
        try {
          const templateContext = {
            pr: {
              number: prInfo.number,
              title: prInfo.title,
              body: prInfo.body,
              author: prInfo.author,
              base: prInfo.base,
              head: prInfo.head,
              totalAdditions: prInfo.totalAdditions,
              totalDeletions: prInfo.totalDeletions
            },
            outputs: dependencyResults ? Object.fromEntries(dependencyResults) : {},
            env: process.env
          };
          let renderedUrl = url;
          if (url.includes("{{") || url.includes("{%")) {
            renderedUrl = await this.liquid.parseAndRender(url, templateContext);
          }
          let requestBody;
          if (bodyTemplate) {
            const renderedBody = await this.liquid.parseAndRender(bodyTemplate, templateContext);
            requestBody = renderedBody;
          }
          const resolvedHeaders = EnvironmentResolver.resolveHeaders(headers);
          const stepName = config.checkName || "unknown";
          const mock = context2?.hooks?.mockForStep?.(String(stepName));
          const data = mock !== void 0 ? mock : await this.fetchData(renderedUrl, method, resolvedHeaders, requestBody, timeout);
          let processedData = data;
          if (transform) {
            try {
              const transformContext = {
                response: data,
                pr: templateContext.pr,
                outputs: templateContext.outputs
              };
              const rendered = await this.liquid.parseAndRender(transform, transformContext);
              if (rendered.trim().startsWith("{") || rendered.trim().startsWith("[")) {
                processedData = JSON.parse(rendered);
              } else {
                processedData = rendered;
              }
            } catch (error) {
              return {
                issues: [
                  {
                    file: "http_client",
                    line: 0,
                    ruleId: "http_client/transform_error",
                    message: `Failed to transform response data: ${error instanceof Error ? error.message : "Unknown error"}`,
                    severity: "error",
                    category: "logic"
                  }
                ]
              };
            }
          }
          return {
            issues: [],
            // Add custom data field that will be passed through to dependent checks
            data: processedData
          };
        } catch (error) {
          return {
            issues: [
              {
                file: "http_client",
                line: 0,
                ruleId: "http_client/fetch_error",
                message: `Failed to fetch from ${url}: ${error instanceof Error ? error.message : "Unknown error"}`,
                severity: "error",
                category: "logic"
              }
            ]
          };
        }
      }
      async fetchData(url, method, headers, body, timeout = 3e4) {
        if (typeof fetch === "undefined") {
          throw new Error("HTTP client provider requires Node.js 18+ or node-fetch package");
        }
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        try {
          const requestOptions = {
            method,
            headers: {
              ...headers
            },
            signal: controller.signal
          };
          if (method !== "GET" && body) {
            requestOptions.body = body;
            if (!headers["Content-Type"] && !headers["content-type"]) {
              requestOptions.headers = {
                ...requestOptions.headers,
                "Content-Type": "application/json"
              };
            }
          }
          const response = await fetch(url, requestOptions);
          clearTimeout(timeoutId);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }
          const contentType = response.headers.get("content-type");
          if (contentType && contentType.includes("application/json")) {
            return await response.json();
          }
          const text = await response.text();
          if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
            try {
              return JSON.parse(text);
            } catch {
              return text;
            }
          }
          return text;
        } catch (error) {
          clearTimeout(timeoutId);
          if (error instanceof Error && error.name === "AbortError") {
            throw new Error(`Request timed out after ${timeout}ms`);
          }
          throw error;
        }
      }
      getSupportedConfigKeys() {
        return [
          "type",
          "url",
          "method",
          "headers",
          "body",
          "transform",
          "timeout",
          "depends_on",
          "on",
          "if",
          "group",
          "schedule"
        ];
      }
      async isAvailable() {
        return typeof fetch !== "undefined";
      }
      getRequirements() {
        return [
          "Valid HTTP/HTTPS URL to fetch from",
          "Network access to the endpoint",
          "Optional: Transform template for processing response data",
          "Optional: Body template for POST/PUT requests"
        ];
      }
    };
  }
});

// src/providers/noop-check-provider.ts
var NoopCheckProvider;
var init_noop_check_provider = __esm({
  "src/providers/noop-check-provider.ts"() {
    "use strict";
    init_check_provider_interface();
    NoopCheckProvider = class extends CheckProvider {
      getName() {
        return "noop";
      }
      getDescription() {
        return "No-operation provider for command orchestration and dependency triggering";
      }
      async validateConfig(config) {
        if (!config || typeof config !== "object") {
          return false;
        }
        const cfg = config;
        if (cfg.type !== "noop") {
          return false;
        }
        return true;
      }
      async execute(_prInfo, _config, _dependencyResults, _sessionInfo) {
        return {
          issues: []
        };
      }
      getSupportedConfigKeys() {
        return ["type", "command", "depends_on", "on", "if", "group"];
      }
      async isAvailable() {
        return true;
      }
      getRequirements() {
        return [
          "No external dependencies required",
          "Used for command orchestration and dependency triggering"
        ];
      }
    };
  }
});

// src/providers/log-check-provider.ts
var LogCheckProvider;
var init_log_check_provider = __esm({
  "src/providers/log-check-provider.ts"() {
    "use strict";
    init_check_provider_interface();
    init_liquid_extensions();
    init_logger();
    LogCheckProvider = class extends CheckProvider {
      liquid;
      constructor() {
        super();
        this.liquid = createExtendedLiquid({
          strictVariables: false,
          strictFilters: false
        });
      }
      getName() {
        return "log";
      }
      getDescription() {
        return "Output debugging and logging information for troubleshooting check workflows";
      }
      async validateConfig(config) {
        if (!config || typeof config !== "object") {
          return false;
        }
        const cfg = config;
        if (cfg.type !== "log") {
          return false;
        }
        if (!cfg.message || typeof cfg.message !== "string") {
          return false;
        }
        if (cfg.level && !["debug", "info", "warn", "error"].includes(cfg.level)) {
          return false;
        }
        return true;
      }
      async execute(prInfo, config, dependencyResults, context2) {
        const message = config.message;
        const level = config.level || "info";
        const includePrContext = config.include_pr_context !== false;
        const includeDependencies = config.include_dependencies !== false;
        const includeMetadata = config.include_metadata !== false;
        const templateContext = this.buildTemplateContext(
          prInfo,
          dependencyResults,
          includePrContext,
          includeDependencies,
          includeMetadata,
          config.__outputHistory,
          context2
        );
        const renderedMessage = await this.liquid.parseAndRender(message, templateContext);
        const logOutput = this.formatLogOutput(
          level,
          renderedMessage,
          templateContext,
          includePrContext,
          includeDependencies,
          includeMetadata
        );
        if (level === "error") logger.error(logOutput);
        else if (level === "warn") logger.warn(logOutput);
        else if (level === "debug") logger.debug(logOutput);
        else logger.info(logOutput);
        return {
          issues: [],
          // Add log output as custom field
          logOutput
        };
      }
      buildTemplateContext(prInfo, dependencyResults, _includePrContext = true, _includeDependencies = true, includeMetadata = true, outputHistory, executionContext) {
        const context2 = {};
        context2.pr = {
          number: prInfo.number,
          title: prInfo.title,
          body: prInfo.body,
          author: prInfo.author,
          base: prInfo.base,
          head: prInfo.head,
          totalAdditions: prInfo.totalAdditions,
          totalDeletions: prInfo.totalDeletions,
          files: prInfo.files.map((f) => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes
          }))
        };
        context2.filenames = prInfo.files.map((f) => f.filename);
        context2.fileCount = prInfo.files.length;
        if (dependencyResults) {
          const dependencies = {};
          const outputs = {};
          const outputsRaw = {};
          const history = {};
          context2.dependencyCount = dependencyResults.size;
          for (const [checkName, result] of dependencyResults.entries()) {
            if (typeof checkName !== "string") continue;
            dependencies[checkName] = {
              issueCount: result.issues?.length || 0,
              suggestionCount: 0,
              issues: result.issues || []
            };
            const summary = result;
            if (typeof checkName === "string" && checkName.endsWith("-raw")) {
              const name = checkName.slice(0, -4);
              outputsRaw[name] = summary.output !== void 0 ? summary.output : summary;
            } else {
              outputs[checkName] = summary.output !== void 0 ? summary.output : summary;
            }
          }
          if (outputHistory) {
            for (const [checkName, historyArray] of outputHistory) {
              history[checkName] = historyArray;
            }
          }
          outputs.history = history;
          context2.dependencies = dependencies;
          context2.outputs = outputs;
          context2.outputs_history = history;
          context2.outputs_raw = outputsRaw;
        }
        if (includeMetadata) {
          context2.metadata = {
            timestamp: (/* @__PURE__ */ new Date()).toISOString(),
            executionTime: Date.now(),
            nodeVersion: process.version,
            platform: process.platform,
            workingDirectory: process.cwd()
          };
        }
        const workflowInputs = executionContext?.workflowInputs || {};
        logger.debug(
          `[LogProvider] Adding ${Object.keys(workflowInputs).length} workflow inputs to context`
        );
        context2.inputs = workflowInputs;
        return context2;
      }
      formatLogOutput(level, message, templateContext, includePrContext, includeDependencies, includeMetadata) {
        const sections = [];
        const levelEmoji = this.getLevelEmoji(level);
        sections.push(`${levelEmoji} **${level.toUpperCase()}**: ${message}`);
        if (includePrContext && templateContext.pr) {
          const pr = templateContext.pr;
          sections.push("");
          sections.push("### PR Context");
          sections.push(`- **PR #${pr.number}**: ${pr.title}`);
          sections.push(`- **Author**: ${pr.author}`);
          sections.push(`- **Base**: ${pr.base} \u2192 **Head**: ${pr.head}`);
          sections.push(`- **Changes**: +${pr.totalAdditions} -${pr.totalDeletions}`);
          sections.push(`- **Files Modified**: ${templateContext.fileCount}`);
        }
        if (includeDependencies && templateContext.dependencies) {
          const deps = templateContext.dependencies;
          sections.push("");
          sections.push("### Dependency Results");
          if (Object.keys(deps).length === 0) {
            sections.push("- No dependency results available");
          } else {
            for (const [checkName, result] of Object.entries(deps)) {
              sections.push(
                `- **${checkName}**: ${result.issueCount} issues, ${result.suggestionCount} suggestions`
              );
            }
          }
        }
        if (includeMetadata && templateContext.metadata) {
          const meta = templateContext.metadata;
          sections.push("");
          sections.push("### Execution Metadata");
          sections.push(`- **Timestamp**: ${meta.timestamp}`);
          sections.push(`- **Node Version**: ${meta.nodeVersion}`);
          sections.push(`- **Platform**: ${meta.platform}`);
          sections.push(`- **Working Directory**: ${meta.workingDirectory}`);
        }
        return sections.join("\n");
      }
      getLevelEmoji(level) {
        switch (level) {
          case "debug":
            return "\u{1F41B}";
          case "info":
            return "\u2139\uFE0F";
          case "warn":
            return "\u26A0\uFE0F";
          case "error":
            return "\u274C";
          default:
            return "\u2139\uFE0F";
        }
      }
      getSupportedConfigKeys() {
        return [
          "type",
          "message",
          "level",
          "include_pr_context",
          "include_dependencies",
          "include_metadata",
          "group",
          "command",
          "depends_on",
          "on",
          "if"
        ];
      }
      async isAvailable() {
        return true;
      }
      getRequirements() {
        return [
          "No external dependencies required",
          "Used for debugging and logging check execution flow"
        ];
      }
    };
  }
});

// src/test-runner/recorders/global-recorder.ts
var global_recorder_exports = {};
__export(global_recorder_exports, {
  getGlobalRecorder: () => getGlobalRecorder,
  setGlobalRecorder: () => setGlobalRecorder
});
function setGlobalRecorder(r) {
  __rec = r;
}
function getGlobalRecorder() {
  return __rec;
}
var __rec;
var init_global_recorder = __esm({
  "src/test-runner/recorders/global-recorder.ts"() {
    "use strict";
    __rec = null;
  }
});

// src/providers/github-ops-provider.ts
var GitHubOpsProvider;
var init_github_ops_provider = __esm({
  "src/providers/github-ops-provider.ts"() {
    "use strict";
    init_check_provider_interface();
    init_sandbox();
    init_liquid_extensions();
    init_logger();
    GitHubOpsProvider = class extends CheckProvider {
      sandbox;
      getName() {
        return "github";
      }
      getDescription() {
        return "Native GitHub operations (labels, comments, reviewers) executed via Octokit";
      }
      async validateConfig(config) {
        if (!config || typeof config !== "object") return false;
        const cfg = config;
        return typeof cfg.op === "string" && cfg.op.length > 0;
      }
      getSupportedConfigKeys() {
        return ["op", "values", "value"];
      }
      async isAvailable() {
        return Boolean(
          process.env.GITHUB_TOKEN || process.env["INPUT_GITHUB-TOKEN"] || process.env.GITHUB_REPOSITORY
        );
      }
      getRequirements() {
        return ["GITHUB_TOKEN or INPUT_GITHUB-TOKEN", "GITHUB_REPOSITORY"];
      }
      async execute(prInfo, config, dependencyResults) {
        const cfg = config;
        let octokit = config.eventContext?.octokit;
        if (process.env.VISOR_DEBUG === "true") {
          try {
            logger.debug(`[github-ops] pre-fallback octokit? ${!!octokit}`);
          } catch {
          }
        }
        if (!octokit) {
          try {
            const { getGlobalRecorder: getGlobalRecorder2 } = (init_global_recorder(), __toCommonJS(global_recorder_exports));
            const rec = getGlobalRecorder2 && getGlobalRecorder2();
            if (rec) octokit = rec;
          } catch {
          }
        }
        if (!octokit) {
          if (process.env.VISOR_DEBUG === "true") {
            try {
              console.error("[github-ops] missing octokit after fallback \u2014 returning issue");
            } catch {
            }
          }
          return {
            issues: [
              {
                file: "system",
                line: 0,
                ruleId: "github/missing_octokit",
                message: "No authenticated Octokit instance available in event context. GitHub operations require proper authentication context.",
                severity: "error",
                category: "logic"
              }
            ]
          };
        }
        const repoEnv = process.env.GITHUB_REPOSITORY || "";
        let owner = "";
        let repo = "";
        if (repoEnv.includes("/")) {
          [owner, repo] = repoEnv.split("/");
        } else {
          try {
            const ec = config.eventContext || {};
            owner = ec?.repository?.owner?.login || owner;
            repo = ec?.repository?.name || repo;
          } catch {
          }
        }
        try {
          if (process.env.VISOR_DEBUG === "true") {
            logger.info(
              `[github-ops] context octokit? ${!!octokit} repo=${owner}/${repo} pr#=${prInfo?.number}`
            );
          }
        } catch {
        }
        if (!owner || !repo || !prInfo?.number) {
          return {
            issues: [
              {
                file: "system",
                line: 0,
                ruleId: "github/missing_context",
                message: "Missing owner/repo or PR number; GitHub operations require Action context",
                severity: "error",
                category: "logic"
              }
            ]
          };
        }
        let valuesRaw = [];
        if (Array.isArray(cfg.values)) valuesRaw = cfg.values.map((v) => String(v));
        else if (typeof cfg.values === "string") valuesRaw = [cfg.values];
        else if (typeof cfg.value === "string") valuesRaw = [cfg.value];
        try {
          if (process.env.VISOR_DEBUG === "true") {
            logger.info(`[github-ops] op=${cfg.op} valuesRaw(before)=${JSON.stringify(valuesRaw)}`);
          }
        } catch {
        }
        const renderValues = async (arr) => {
          if (!arr || arr.length === 0) return [];
          const liq = createExtendedLiquid({
            cache: false,
            strictFilters: false,
            strictVariables: false
          });
          const outputs = {};
          if (dependencyResults) {
            for (const [name, result] of dependencyResults.entries()) {
              const summary = result;
              outputs[name] = summary.output !== void 0 ? summary.output : summary;
            }
          }
          try {
            const hist = config.__outputHistory;
            if (hist) {
              for (const [name, arr2] of hist.entries()) {
                if (!outputs[name] && Array.isArray(arr2) && arr2.length > 0) {
                  outputs[name] = arr2[arr2.length - 1];
                }
              }
            }
          } catch {
          }
          const ctx = {
            pr: {
              number: prInfo.number,
              title: prInfo.title,
              author: prInfo.author,
              branch: prInfo.head,
              base: prInfo.base,
              authorAssociation: prInfo.authorAssociation
            },
            outputs
          };
          try {
            if (process.env.VISOR_DEBUG === "true") {
              logger.info(`[github-ops] deps keys=${Object.keys(outputs).join(", ")}`);
              const ov = outputs["overview"];
              if (ov) {
                logger.info(`[github-ops] outputs.overview.keys=${Object.keys(ov).join(",")}`);
                if (ov.tags) {
                  logger.info(
                    `[github-ops] outputs.overview.tags keys=${Object.keys(ov.tags).join(",")}`
                  );
                  try {
                    logger.info(
                      `[github-ops] outputs.overview.tags['review-effort']=${String(ov.tags["review-effort"])}`
                    );
                  } catch {
                  }
                }
              }
            }
          } catch {
          }
          const out = [];
          for (const item of arr) {
            if (typeof item === "string" && (item.includes("{{") || item.includes("{%"))) {
              try {
                const rendered = await liq.parseAndRender(item, ctx);
                out.push(rendered);
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                if (process.env.VISOR_DEBUG === "true") {
                  logger.warn(`[github-ops] liquid_render_error: ${msg}`);
                }
                return Promise.reject({
                  issues: [
                    {
                      file: "system",
                      line: 0,
                      ruleId: "github/liquid_render_error",
                      message: `Failed to render template: ${msg}`,
                      severity: "error",
                      category: "logic"
                    }
                  ]
                });
              }
            } else {
              out.push(String(item));
            }
          }
          return out;
        };
        let values = await renderValues(valuesRaw);
        try {
          const flattened = [];
          for (const v of values) {
            const t = String(v ?? "").trim();
            if (!t) continue;
            let expanded = false;
            if (t.startsWith("[") && t.endsWith("]")) {
              try {
                const arr = JSON.parse(t);
                if (Array.isArray(arr)) {
                  for (const x of arr) flattened.push(String(x ?? ""));
                  expanded = true;
                }
              } catch {
              }
            }
            if (expanded) continue;
            if (t.includes("\n")) {
              for (const line of t.split("\n")) {
                const s = line.trim();
                if (s) flattened.push(s);
              }
              expanded = true;
            }
            if (!expanded) flattened.push(t);
          }
          values = flattened;
        } catch {
        }
        const depOutputs = {};
        if (dependencyResults) {
          for (const [name, result] of dependencyResults.entries()) {
            const summary = result;
            depOutputs[name] = summary.output !== void 0 ? summary.output : summary;
          }
        }
        const sanitizeLabel = (s) => s.replace(/[^A-Za-z0-9:\/\- ]/g, "").replace(/\/{2,}/g, "/").trim();
        values = (Array.isArray(values) ? values : []).map((v) => String(v ?? "")).map(sanitizeLabel).filter(Boolean);
        if (values.length === 0 && Object.keys(depOutputs).length > 0) {
          try {
            const lbls = [];
            for (const obj of Object.values(depOutputs)) {
              const labelsAny = obj?.labels;
              if (Array.isArray(labelsAny)) {
                for (const v of labelsAny) lbls.push(String(v ?? ""));
              }
            }
            const norm = lbls.map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/[^A-Za-z0-9:\/\- ]/g, "").replace(/\/{2,}/g, "/"));
            values = Array.from(new Set(norm));
            if (process.env.VISOR_DEBUG === "true") {
              logger.info(`[github-ops] derived values from deps.labels: ${JSON.stringify(values)}`);
            }
          } catch {
          }
        }
        if (values.length === 0 && dependencyResults && dependencyResults.size > 0) {
          try {
            const derived = [];
            for (const result of dependencyResults.values()) {
              const out = result?.output ?? result;
              const tags = out?.["tags"];
              if (tags && typeof tags === "object") {
                const label = tags["label"];
                const effort = tags["review-effort"];
                if (label != null) derived.push(String(label));
                if (effort !== void 0 && effort !== null)
                  derived.push(`review/effort:${String(effort)}`);
              }
            }
            values = derived;
            if (process.env.VISOR_DEBUG === "true") {
              logger.info(`[github-ops] derived values from deps: ${JSON.stringify(values)}`);
            }
          } catch {
          }
        }
        values = Array.from(new Set(values));
        try {
          if (process.env.NODE_ENV === "test" || process.env.VISOR_DEBUG === "true") {
            logger.info(`[github-ops] ${cfg.op} resolved values: ${JSON.stringify(values)}`);
          }
        } catch {
        }
        try {
          switch (cfg.op) {
            case "labels.add": {
              if (values.length === 0) break;
              try {
                if (process.env.VISOR_OUTPUT_FORMAT !== "json")
                  logger.step(`[github-ops] labels.add -> ${JSON.stringify(values)}`);
              } catch {
              }
              await octokit.rest.issues.addLabels({
                owner,
                repo,
                issue_number: prInfo.number,
                labels: values
              });
              break;
            }
            case "labels.remove": {
              for (const l of values) {
                await octokit.rest.issues.removeLabel({
                  owner,
                  repo,
                  issue_number: prInfo.number,
                  name: l
                });
              }
              break;
            }
            case "comment.create": {
              const body = values.join("\n").trim();
              if (body)
                await octokit.rest.issues.createComment({
                  owner,
                  repo,
                  issue_number: prInfo.number,
                  body
                });
              break;
            }
            default:
              return {
                issues: [
                  {
                    file: "system",
                    line: 0,
                    ruleId: "github/unsupported_op",
                    message: `Unsupported GitHub op: ${cfg.op}`,
                    severity: "error",
                    category: "logic"
                  }
                ]
              };
          }
          return { issues: [] };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          try {
            logger.error(`[github-ops] op_failed ${cfg.op}: ${msg}`);
          } catch {
          }
          return {
            issues: [
              {
                file: "system",
                line: 0,
                ruleId: "github/op_failed",
                message: `GitHub operation failed (${cfg.op}): ${msg}`,
                severity: "error",
                category: "logic"
              }
            ]
          };
        }
      }
      /**
       * Create a secure sandbox for evaluating small expressions without access to process/env
       */
      getSecureSandbox() {
        if (this.sandbox) return this.sandbox;
        this.sandbox = createSecureSandbox();
        return this.sandbox;
      }
    };
  }
});

// src/providers/claude-code-types.ts
async function safeImport(moduleName) {
  try {
    return await import(moduleName);
  } catch {
    return null;
  }
}
var init_claude_code_types = __esm({
  "src/providers/claude-code-types.ts"() {
    "use strict";
  }
});

// src/providers/claude-code-check-provider.ts
import fs4 from "fs/promises";
import path4 from "path";
function isClaudeCodeConstructor(value) {
  return typeof value === "function";
}
var ClaudeCodeSDKNotInstalledError, ClaudeCodeAPIKeyMissingError, ClaudeCodeCheckProvider;
var init_claude_code_check_provider = __esm({
  "src/providers/claude-code-check-provider.ts"() {
    "use strict";
    init_check_provider_interface();
    init_env_resolver();
    init_issue_filter();
    init_liquid_extensions();
    init_claude_code_types();
    ClaudeCodeSDKNotInstalledError = class extends Error {
      constructor() {
        super(
          "Claude Code SDK is not installed. Install with: npm install @anthropic/claude-code-sdk @modelcontextprotocol/sdk"
        );
        this.name = "ClaudeCodeSDKNotInstalledError";
      }
    };
    ClaudeCodeAPIKeyMissingError = class extends Error {
      constructor() {
        super(
          "No API key found for Claude Code provider. Set CLAUDE_CODE_API_KEY or ANTHROPIC_API_KEY environment variable."
        );
        this.name = "ClaudeCodeAPIKeyMissingError";
      }
    };
    ClaudeCodeCheckProvider = class extends CheckProvider {
      liquidEngine;
      claudeCodeClient = null;
      constructor() {
        super();
        this.liquidEngine = createExtendedLiquid();
      }
      getName() {
        return "claude-code";
      }
      getDescription() {
        return "AI-powered code review using Claude Code with MCP tools support";
      }
      async validateConfig(config) {
        if (!config || typeof config !== "object") {
          return false;
        }
        const cfg = config;
        if (cfg.type !== "claude-code") {
          return false;
        }
        if (!cfg.prompt || typeof cfg.prompt !== "string") {
          return false;
        }
        if (cfg.claude_code) {
          const claudeCodeConfig = cfg.claude_code;
          if (claudeCodeConfig.allowedTools && !Array.isArray(claudeCodeConfig.allowedTools)) {
            return false;
          }
          if (claudeCodeConfig.maxTurns && typeof claudeCodeConfig.maxTurns !== "number") {
            return false;
          }
          if (claudeCodeConfig.systemPrompt && typeof claudeCodeConfig.systemPrompt !== "string") {
            return false;
          }
          if (claudeCodeConfig.mcpServers) {
            if (typeof claudeCodeConfig.mcpServers !== "object") {
              return false;
            }
            for (const serverConfig of Object.values(claudeCodeConfig.mcpServers)) {
              if (!serverConfig.command || typeof serverConfig.command !== "string") {
                return false;
              }
              if (serverConfig.args && !Array.isArray(serverConfig.args)) {
                return false;
              }
            }
          }
        }
        return true;
      }
      /**
       * Initialize Claude Code SDK client
       */
      async initializeClaudeCodeClient() {
        if (this.claudeCodeClient) {
          return this.claudeCodeClient;
        }
        const claudeCodeModule = await safeImport("@anthropic/claude-code-sdk");
        if (!claudeCodeModule) {
          throw new ClaudeCodeSDKNotInstalledError();
        }
        const ClaudeCodeCtor = claudeCodeModule.ClaudeCode || claudeCodeModule.default?.ClaudeCode;
        if (!isClaudeCodeConstructor(ClaudeCodeCtor)) {
          throw new Error("ClaudeCode class not found in @anthropic/claude-code-sdk");
        }
        const apiKey = process.env.CLAUDE_CODE_API_KEY || process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          throw new ClaudeCodeAPIKeyMissingError();
        }
        try {
          const client = new ClaudeCodeCtor({
            apiKey
          });
          this.claudeCodeClient = client;
          return client;
        } catch (error) {
          throw new Error(
            `Failed to initialize Claude Code SDK: ${error instanceof Error ? error.message : "Unknown error"}`
          );
        }
      }
      /**
       * Group files by their file extension for template context
       */
      groupFilesByExtension(files) {
        const grouped = {};
        files.forEach((file) => {
          const parts = file.filename.split(".");
          const ext = parts.length > 1 ? parts.pop()?.toLowerCase() || "noext" : "noext";
          if (!grouped[ext]) {
            grouped[ext] = [];
          }
          grouped[ext].push(file);
        });
        return grouped;
      }
      /**
       * Process prompt configuration to resolve final prompt string
       */
      async processPrompt(promptConfig, prInfo, eventContext, dependencyResults) {
        let promptContent;
        if (await this.isFilePath(promptConfig)) {
          promptContent = await this.loadPromptFromFile(promptConfig);
        } else {
          promptContent = promptConfig;
        }
        return await this.renderPromptTemplate(promptContent, prInfo, eventContext, dependencyResults);
      }
      /**
       * Detect if a string is likely a file path and if the file exists
       */
      async isFilePath(str) {
        if (!str || str.trim() !== str || str.length > 512) {
          return false;
        }
        if (/\s{2,}/.test(str) || // Multiple consecutive spaces
        /\n/.test(str) || // Contains newlines
        /^(please|analyze|review|check|find|identify|look|search)/i.test(str.trim()) || // Starts with command words
        str.split(" ").length > 8) {
          return false;
        }
        if (!/[\/\\]/.test(str)) {
          if (/\b(the|and|or|but|for|with|by|from|in|on|at|as)\b/i.test(str)) {
            return false;
          }
        }
        const hasFileExtension = /\.[a-zA-Z0-9]{1,10}$/i.test(str);
        const hasPathSeparators = /[\/\\]/.test(str);
        const isRelativePath = /^\.{1,2}\//.test(str);
        const isAbsolutePath = path4.isAbsolute(str);
        const hasTypicalFileChars = /^[a-zA-Z0-9._\-\/\\:~]+$/.test(str);
        if (!(hasFileExtension || isRelativePath || isAbsolutePath || hasPathSeparators)) {
          return false;
        }
        if (!hasTypicalFileChars) {
          return false;
        }
        try {
          let resolvedPath;
          if (path4.isAbsolute(str)) {
            resolvedPath = path4.normalize(str);
          } else {
            resolvedPath = path4.resolve(process.cwd(), str);
          }
          try {
            const stat = await fs4.stat(resolvedPath);
            return stat.isFile();
          } catch {
            return hasFileExtension && (isRelativePath || isAbsolutePath || hasPathSeparators);
          }
        } catch {
          return false;
        }
      }
      /**
       * Load prompt content from file with security validation
       */
      async loadPromptFromFile(promptPath) {
        if (!promptPath.endsWith(".liquid")) {
          throw new Error("Prompt file must have .liquid extension");
        }
        let resolvedPath;
        if (path4.isAbsolute(promptPath)) {
          resolvedPath = promptPath;
        } else {
          resolvedPath = path4.resolve(process.cwd(), promptPath);
        }
        if (!path4.isAbsolute(promptPath)) {
          const normalizedPath = path4.normalize(resolvedPath);
          const currentDir = path4.resolve(process.cwd());
          if (!normalizedPath.startsWith(currentDir)) {
            throw new Error("Invalid prompt file path: path traversal detected");
          }
        }
        if (promptPath.includes("../..")) {
          throw new Error("Invalid prompt file path: path traversal detected");
        }
        try {
          const promptContent = await fs4.readFile(resolvedPath, "utf-8");
          return promptContent;
        } catch (error) {
          throw new Error(
            `Failed to load prompt from ${resolvedPath}: ${error instanceof Error ? error.message : "Unknown error"}`
          );
        }
      }
      /**
       * Render Liquid template in prompt with comprehensive context
       */
      async renderPromptTemplate(promptContent, prInfo, eventContext, dependencyResults) {
        const templateContext = {
          // PR Information
          pr: {
            number: prInfo.number,
            title: prInfo.title,
            body: prInfo.body,
            author: prInfo.author,
            baseBranch: prInfo.base,
            headBranch: prInfo.head,
            isIncremental: prInfo.isIncremental,
            filesChanged: prInfo.files?.map((f) => f.filename) || [],
            totalAdditions: prInfo.files?.reduce((sum, f) => sum + f.additions, 0) || 0,
            totalDeletions: prInfo.files?.reduce((sum, f) => sum + f.deletions, 0) || 0,
            totalChanges: prInfo.files?.reduce((sum, f) => sum + f.changes, 0) || 0,
            base: prInfo.base,
            head: prInfo.head
          },
          // File Details
          files: prInfo.files || [],
          description: prInfo.body || "",
          // GitHub Event Context
          event: eventContext ? {
            name: eventContext.event_name || "unknown",
            action: eventContext.action,
            isPullRequest: !prInfo.isIssue,
            // Repository Info
            repository: eventContext.repository ? {
              owner: eventContext.repository?.owner?.login,
              name: eventContext.repository?.name,
              fullName: eventContext.repository ? `${eventContext.repository?.owner?.login}/${eventContext.repository?.name}` : void 0
            } : void 0,
            // Comment Data (for comment events)
            comment: eventContext.comment ? {
              body: eventContext.comment?.body,
              author: eventContext.comment?.user?.login
            } : void 0,
            // Raw event payload for advanced use cases
            payload: eventContext
          } : void 0,
          // Utility data for templates
          utils: {
            // Date/time helpers
            now: (/* @__PURE__ */ new Date()).toISOString(),
            today: (/* @__PURE__ */ new Date()).toISOString().split("T")[0],
            // Dynamic file grouping by extension
            filesByExtension: this.groupFilesByExtension(prInfo.files || []),
            // File status categorizations
            addedFiles: (prInfo.files || []).filter((f) => f.status === "added"),
            modifiedFiles: (prInfo.files || []).filter((f) => f.status === "modified"),
            removedFiles: (prInfo.files || []).filter((f) => f.status === "removed"),
            renamedFiles: (prInfo.files || []).filter((f) => f.status === "renamed"),
            // Change analysis
            hasLargeChanges: (prInfo.files || []).some((f) => f.changes > 50),
            totalFiles: (prInfo.files || []).length
          },
          // Previous check outputs (dependency results)
          // Expose raw output directly if available, otherwise expose the result as-is
          outputs: dependencyResults ? Object.fromEntries(
            Array.from(dependencyResults.entries()).map(([checkName, result]) => [
              checkName,
              // If the result has a direct output field, use it directly
              // Otherwise, expose the entire result
              (() => {
                const summary = result;
                return summary.output !== void 0 ? summary.output : summary;
              })()
            ])
          ) : {}
        };
        try {
          return await this.liquidEngine.parseAndRender(promptContent, templateContext);
        } catch (error) {
          throw new Error(
            `Failed to render prompt template: ${error instanceof Error ? error.message : "Unknown error"}`
          );
        }
      }
      /**
       * Parse structured response from Claude Code
       */
      parseStructuredResponse(content) {
        try {
          const parsed = JSON.parse(content);
          return {
            issues: parsed.issues || []
          };
        } catch {
          return {
            issues: []
          };
        }
      }
      async execute(prInfo, config, dependencyResults, sessionInfo) {
        if (config.env) {
          const result = EnvironmentResolver.withTemporaryEnv(config.env, () => {
            return this.executeWithConfig(prInfo, config, dependencyResults, sessionInfo);
          });
          if (result instanceof Promise) {
            return result;
          }
          return result;
        }
        return this.executeWithConfig(prInfo, config, dependencyResults, sessionInfo);
      }
      async executeWithConfig(prInfo, config, dependencyResults, sessionInfo) {
        const claudeCodeConfig = config.claude_code || {};
        const customPrompt = config.prompt;
        if (!customPrompt) {
          throw new Error(
            `No prompt defined for check. All checks must have prompts defined in .visor.yaml configuration.`
          );
        }
        const processedPrompt = await this.processPrompt(
          customPrompt,
          prInfo,
          config.eventContext,
          dependencyResults
        );
        const startTime = Date.now();
        try {
          const client = await this.initializeClaudeCodeClient();
          const query = {
            query: processedPrompt,
            maxTurns: claudeCodeConfig.maxTurns || 5,
            systemPrompt: claudeCodeConfig.systemPrompt,
            subagent: claudeCodeConfig.subagent
          };
          if (claudeCodeConfig.allowedTools && claudeCodeConfig.allowedTools.length > 0) {
            query.tools = claudeCodeConfig.allowedTools.map((name) => ({ name }));
          }
          if (claudeCodeConfig.mcpServers && Object.keys(claudeCodeConfig.mcpServers).length > 0) {
            query.mcpServers = claudeCodeConfig.mcpServers;
          }
          let response;
          if (sessionInfo?.reuseSession && sessionInfo.parentSessionId) {
            response = await client.query({
              ...query,
              sessionId: sessionInfo.parentSessionId
            });
          } else {
            response = await client.query(query);
          }
          const result = this.parseStructuredResponse(response.content);
          result.debug = {
            prompt: processedPrompt,
            rawResponse: response.content,
            provider: "claude-code",
            model: "claude-code",
            apiKeySource: "CLAUDE_CODE_API_KEY",
            processingTime: Date.now() - startTime,
            promptLength: processedPrompt.length,
            responseLength: response.content.length,
            jsonParseSuccess: true,
            errors: [],
            checksExecuted: [config.checkName || "claude-code-check"],
            parallelExecution: false,
            timestamp: (/* @__PURE__ */ new Date()).toISOString(),
            // Claude Code specific debug info
            sessionId: response.session_id,
            turnCount: response.turn_count,
            usage: response.usage
          };
          const suppressionEnabled = config.suppressionEnabled !== false;
          const issueFilter = new IssueFilter(suppressionEnabled);
          const filteredIssues = issueFilter.filterIssues(result.issues || [], process.cwd());
          return {
            ...result,
            issues: filteredIssues
          };
        } catch (error) {
          if (error instanceof ClaudeCodeSDKNotInstalledError || error instanceof ClaudeCodeAPIKeyMissingError) {
            throw error;
          }
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`\u274C Claude Code Check Provider Error: ${errorMessage}`);
          const isCriticalError = errorMessage.includes("API rate limit") || errorMessage.includes("403") || errorMessage.includes("401") || errorMessage.includes("authentication");
          if (isCriticalError) {
            console.error(
              `\u{1F6A8} CRITICAL ERROR: Claude Code provider authentication or setup issue detected`
            );
            console.error(
              `\u{1F6A8} This check cannot proceed without valid API credentials and SDK installation`
            );
          }
          throw new Error(`Claude Code analysis failed: ${errorMessage}`);
        }
      }
      getSupportedConfigKeys() {
        return [
          "type",
          "prompt",
          "claude_code.allowedTools",
          "claude_code.maxTurns",
          "claude_code.systemPrompt",
          "claude_code.mcpServers",
          "claude_code.subagent",
          "claude_code.hooks",
          "env",
          "checkName",
          "sessionId",
          "suppressionEnabled"
        ];
      }
      async isAvailable() {
        try {
          const hasApiKey = !!(process.env.CLAUDE_CODE_API_KEY || process.env.ANTHROPIC_API_KEY);
          if (!hasApiKey) {
            return false;
          }
          const claudeCodeModule = await safeImport("@anthropic/claude-code-sdk");
          if (!claudeCodeModule) {
            return false;
          }
          const ClaudeCode = claudeCodeModule.ClaudeCode || claudeCodeModule.default?.ClaudeCode;
          return !!ClaudeCode;
        } catch {
          return false;
        }
      }
      getRequirements() {
        return [
          "CLAUDE_CODE_API_KEY or ANTHROPIC_API_KEY environment variable",
          "@anthropic/claude-code-sdk npm package",
          "@modelcontextprotocol/sdk npm package (for MCP support)",
          "Network access to Claude Code API"
        ];
      }
    };
  }
});

// src/utils/command-executor.ts
import { exec } from "child_process";
import { promisify } from "util";
var CommandExecutor, commandExecutor;
var init_command_executor = __esm({
  "src/utils/command-executor.ts"() {
    "use strict";
    init_logger();
    CommandExecutor = class _CommandExecutor {
      static instance;
      constructor() {
      }
      static getInstance() {
        if (!_CommandExecutor.instance) {
          _CommandExecutor.instance = new _CommandExecutor();
        }
        return _CommandExecutor.instance;
      }
      /**
       * Execute a shell command with optional stdin, environment, and timeout
       */
      async execute(command, options = {}) {
        const execAsync = promisify(exec);
        const timeout = options.timeout || 3e4;
        if (options.stdin) {
          return this.executeWithStdin(command, options);
        }
        try {
          const result = await execAsync(command, {
            cwd: options.cwd,
            env: options.env,
            timeout
          });
          return {
            stdout: result.stdout || "",
            stderr: result.stderr || "",
            exitCode: 0
          };
        } catch (error) {
          return this.handleExecutionError(error, timeout);
        }
      }
      /**
       * Execute command with stdin input
       */
      executeWithStdin(command, options) {
        return new Promise((resolve2, reject) => {
          const childProcess = exec(
            command,
            {
              cwd: options.cwd,
              env: options.env,
              timeout: options.timeout || 3e4
            },
            (error, stdout, stderr) => {
              if (error && error.killed && (error.code === "ETIMEDOUT" || error.signal === "SIGTERM")) {
                reject(new Error(`Command timed out after ${options.timeout || 3e4}ms`));
              } else {
                resolve2({
                  stdout: stdout || "",
                  stderr: stderr || "",
                  exitCode: error ? error.code || 1 : 0
                });
              }
            }
          );
          if (options.stdin && childProcess.stdin) {
            childProcess.stdin.write(options.stdin);
            childProcess.stdin.end();
          }
        });
      }
      /**
       * Handle execution errors consistently
       */
      handleExecutionError(error, timeout) {
        const execError = error;
        if (execError.killed && (execError.code === "ETIMEDOUT" || execError.signal === "SIGTERM")) {
          throw new Error(`Command timed out after ${timeout}ms`);
        }
        let exitCode = 1;
        if (execError.code) {
          exitCode = typeof execError.code === "string" ? parseInt(execError.code, 10) : execError.code;
        }
        return {
          stdout: execError.stdout || "",
          stderr: execError.stderr || "",
          exitCode
        };
      }
      /**
       * Build safe environment variables by merging process.env with custom env
       * Ensures all values are strings (no undefined)
       */
      buildEnvironment(baseEnv = process.env, ...customEnvs) {
        const result = {};
        for (const [key, value] of Object.entries(baseEnv)) {
          if (value !== void 0) {
            result[key] = value;
          }
        }
        for (const customEnv of customEnvs) {
          if (customEnv) {
            Object.assign(result, customEnv);
          }
        }
        return result;
      }
      /**
       * Log command execution for debugging
       */
      logExecution(command, options) {
        const debugInfo = [
          `Executing command: ${command}`,
          options.cwd ? `cwd: ${options.cwd}` : null,
          options.stdin ? "with stdin" : null,
          options.timeout ? `timeout: ${options.timeout}ms` : null,
          options.env ? `env vars: ${Object.keys(options.env).length}` : null
        ].filter(Boolean).join(", ");
        logger.debug(debugInfo);
      }
    };
    commandExecutor = CommandExecutor.getInstance();
  }
});

// src/utils/env-exposure.ts
var env_exposure_exports = {};
__export(env_exposure_exports, {
  buildSandboxEnv: () => buildSandboxEnv
});
function buildSandboxEnv(input) {
  const denyDefaults = [
    "GITHUB_TOKEN",
    "INPUT_GITHUB-TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AZURE_CLIENT_SECRET",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "HUGGINGFACE_API_KEY",
    "CLAUDE_CODE_API_KEY",
    "PROBE_API_KEY"
  ];
  const denyExtra = (input.VISOR_DENY_ENV || "").split(",").map((s) => s.trim()).filter(Boolean);
  const deny = Array.from(/* @__PURE__ */ new Set([...denyDefaults, ...denyExtra]));
  const allowSpec = (input.VISOR_ALLOW_ENV || "*").trim();
  const denyMatch = (key) => {
    for (const pat of deny) {
      if (!pat) continue;
      if (pat.endsWith("*")) {
        const prefix = pat.slice(0, -1);
        if (key.startsWith(prefix)) return true;
      } else if (key === pat) {
        return true;
      }
    }
    if (/(_TOKEN|_SECRET|_PASSWORD|_PRIVATE_KEY)$/i.test(key)) return true;
    return false;
  };
  const out = {};
  if (allowSpec !== "*") {
    const allow = allowSpec.split(",").map((s) => s.trim()).filter(Boolean);
    for (const key of allow) {
      const val = input[key];
      if (key && val !== void 0 && !denyMatch(key)) out[key] = String(val);
    }
    return out;
  }
  for (const [k, v] of Object.entries(input)) {
    if (v === void 0 || v === null) continue;
    if (denyMatch(k)) continue;
    out[k] = String(v);
  }
  return out;
}
var init_env_exposure = __esm({
  "src/utils/env-exposure.ts"() {
    "use strict";
  }
});

// src/providers/command-check-provider.ts
var CommandCheckProvider;
var init_command_check_provider = __esm({
  "src/providers/command-check-provider.ts"() {
    "use strict";
    init_check_provider_interface();
    init_sandbox();
    init_liquid_extensions();
    init_logger();
    init_command_executor();
    init_author_permissions();
    init_lazy_otel();
    init_state_capture();
    CommandCheckProvider = class extends CheckProvider {
      liquid;
      sandbox;
      constructor() {
        super();
        this.liquid = createExtendedLiquid({
          cache: false,
          strictFilters: false,
          strictVariables: false
        });
      }
      createSecureSandbox() {
        return createSecureSandbox();
      }
      getName() {
        return "command";
      }
      getDescription() {
        return "Execute shell commands and capture output for processing";
      }
      async validateConfig(config) {
        if (!config || typeof config !== "object") {
          return false;
        }
        const cfg = config;
        if (!cfg.exec || typeof cfg.exec !== "string") {
          return false;
        }
        return true;
      }
      async execute(prInfo, config, dependencyResults, context2) {
        try {
          logger.info(
            `  command provider: executing check=${String(config.checkName || config.type)} hasTransformJs=${Boolean(
              config.transform_js
            )}`
          );
        } catch {
        }
        const command = config.exec;
        const transform = config.transform;
        const transformJs = config.transform_js;
        const outputsObj = this.buildOutputContext(
          dependencyResults,
          config.__outputHistory
        );
        const outputsRaw = {};
        if (dependencyResults) {
          for (const [key, value] of dependencyResults.entries()) {
            if (typeof key !== "string") continue;
            if (key.endsWith("-raw")) {
              const name = key.slice(0, -4);
              const summary = value;
              outputsRaw[name] = summary.output !== void 0 ? summary.output : summary;
            }
          }
        }
        const templateContext = {
          pr: {
            number: prInfo.number,
            title: prInfo.title,
            author: prInfo.author,
            branch: prInfo.head,
            base: prInfo.base
          },
          files: prInfo.files,
          fileCount: prInfo.files.length,
          outputs: outputsObj,
          // Alias: outputs_history mirrors outputs.history for consistency
          outputs_history: outputsObj.history || {},
          // Stage-scoped history slice based on baseline provided by runner
          outputs_history_stage: (() => {
            const stage = {};
            try {
              const base = context2?.stageHistoryBase;
              const histMap = config.__outputHistory;
              if (!base || !histMap) return stage;
              for (const [k, v] of histMap.entries()) {
                const start = base[k] || 0;
                const arr = Array.isArray(v) ? v : [];
                stage[k] = arr.slice(start);
              }
            } catch {
            }
            return stage;
          })(),
          // New: outputs_raw exposes aggregate values (e.g., full arrays for forEach parents)
          outputs_raw: outputsRaw,
          // Workflow inputs (when executing within a workflow)
          inputs: context2?.workflowInputs || {},
          env: this.getSafeEnvironmentVariables()
        };
        logger.debug(
          `\u{1F527} Debug: Template outputs keys: ${Object.keys(templateContext.outputs || {}).join(", ")}`
        );
        try {
          const span = trace.getSpan(context.active());
          if (span) {
            captureCheckInputContext(span, templateContext);
          }
        } catch {
        }
        try {
          const checkId = config.checkName || config.id || "unknown";
          const ctxJson = JSON.stringify(templateContext);
          const { emitNdjsonSpanWithEvents: emitNdjsonSpanWithEvents2 } = (init_fallback_ndjson(), __toCommonJS(fallback_ndjson_exports));
          emitNdjsonSpanWithEvents2(
            "visor.check",
            { "visor.check.id": checkId, "visor.check.input.context": ctxJson },
            [{ name: "check.started" }, { name: "check.completed" }]
          );
        } catch {
        }
        try {
          const stepName = config.checkName || "unknown";
          const rawMock = context2?.hooks?.mockForStep?.(String(stepName));
          if (rawMock !== void 0) {
            let mock;
            if (typeof rawMock === "number") {
              mock = { exit_code: Number(rawMock) };
            } else if (typeof rawMock === "string") {
              mock = { stdout: String(rawMock) };
            } else {
              mock = rawMock;
            }
            const m = mock;
            let out = m.stdout ?? "";
            try {
              if (typeof out === "string" && (out.trim().startsWith("{") || out.trim().startsWith("["))) {
                out = JSON.parse(out);
              }
            } catch {
            }
            const code = typeof m.exit_code === "number" ? m.exit_code : typeof m.exit === "number" ? m.exit : 0;
            if (code !== 0) {
              return {
                issues: [
                  {
                    file: "command",
                    line: 0,
                    ruleId: "command/execution_error",
                    message: `Mocked command exited with code ${code}`,
                    severity: "error",
                    category: "logic"
                  }
                ],
                output: out
              };
            }
            return { issues: [], output: out };
          }
        } catch {
        }
        try {
          let renderedCommand = command;
          if (command.includes("{{") || command.includes("{%")) {
            renderedCommand = await this.renderCommandTemplate(command, templateContext);
          }
          logger.debug(`\u{1F527} Debug: Rendered command: ${renderedCommand}`);
          const scriptEnv = {};
          for (const [key, value] of Object.entries(process.env)) {
            if (value !== void 0) {
              scriptEnv[key] = value;
            }
          }
          if (config.env) {
            for (const [key, value] of Object.entries(config.env)) {
              if (value !== void 0 && value !== null) {
                scriptEnv[key] = String(value);
              }
            }
          }
          const timeoutSeconds = config.timeout || 60;
          const timeoutMs = timeoutSeconds * 1e3;
          const normalizeNodeEval = (cmd) => {
            const re = /^(?<prefix>\s*(?:\/usr\/bin\/env\s+)?node(?:\.exe)?\s+(?:-e|--eval)\s+)(['"])([\s\S]*?)\2(?<suffix>\s|$)/;
            const m = cmd.match(re);
            if (!m || !m.groups) return cmd;
            const prefix = m.groups.prefix;
            const quote = m[2];
            const code = m[3];
            const suffix = m.groups.suffix || "";
            if (!code.includes("\n")) return cmd;
            const escaped = code.replace(/\n/g, "\\n");
            return cmd.replace(re, `${prefix}${quote}${escaped}${quote}${suffix}`);
          };
          const safeCommand = normalizeNodeEval(renderedCommand);
          const execResult = await commandExecutor.execute(safeCommand, {
            env: scriptEnv,
            timeout: timeoutMs
          });
          const { stdout, stderr, exitCode } = execResult;
          if (stderr) {
            logger.debug(`Command stderr: ${stderr}`);
          }
          if (exitCode !== 0) {
            const errorMessage = stderr || `Command exited with code ${exitCode}`;
            logger.error(`Command failed with exit code ${exitCode}: ${errorMessage}`);
            return {
              issues: [
                {
                  file: "command",
                  line: 0,
                  ruleId: "command/execution_error",
                  message: `Command execution failed: ${errorMessage}`,
                  severity: "error",
                  category: "logic"
                }
              ]
            };
          }
          const rawOutput = stdout.trim();
          let output = rawOutput;
          try {
            const parsed = JSON.parse(rawOutput);
            output = parsed;
            logger.debug(`\u{1F527} Debug: Parsed entire output as JSON successfully`);
          } catch {
            const extractedTail = this.extractJsonFromEnd(rawOutput);
            if (extractedTail) {
              try {
                output = JSON.parse(extractedTail);
              } catch {
                output = rawOutput;
              }
            } else {
              const extractedAny = this.extractJsonAnywhere(rawOutput);
              if (extractedAny) {
                try {
                  output = JSON.parse(extractedAny);
                } catch {
                  output = rawOutput;
                }
              } else {
                const m = /\berror\b\s*[:=]\s*(true|false)/i.exec(rawOutput);
                if (m) {
                  output = { error: m[1].toLowerCase() === "true" };
                } else {
                  output = rawOutput;
                }
              }
            }
          }
          let finalOutput = output;
          if (transform) {
            try {
              const transformContext = {
                ...templateContext,
                output
                // Use parsed output for Liquid (object if JSON, string otherwise)
              };
              const rendered = await this.liquid.parseAndRender(transform, transformContext);
              try {
                finalOutput = JSON.parse(rendered.trim());
                logger.verbose(`\u2713 Applied Liquid transform successfully (parsed as JSON)`);
              } catch {
                finalOutput = rendered.trim();
                logger.verbose(`\u2713 Applied Liquid transform successfully (string output)`);
              }
              try {
                const span = trace.getSpan(context.active());
                if (span) {
                  const { captureLiquidEvaluation: captureLiquidEvaluation2 } = (init_state_capture(), __toCommonJS(state_capture_exports));
                  captureLiquidEvaluation2(span, transform, transformContext, rendered);
                }
              } catch {
              }
            } catch (error) {
              logger.error(
                `\u2717 Failed to apply Liquid transform: ${error instanceof Error ? error.message : "Unknown error"}`
              );
              return {
                issues: [
                  {
                    file: "command",
                    line: 0,
                    ruleId: "command/transform_error",
                    message: `Failed to apply Liquid transform: ${error instanceof Error ? error.message : "Unknown error"}`,
                    severity: "error",
                    category: "logic"
                  }
                ]
              };
            }
          }
          if (transformJs) {
            try {
              const jsContext = {
                output: this.makeJsonSmart(rawOutput),
                pr: templateContext.pr,
                files: templateContext.files,
                outputs: this.makeOutputsJsonSmart(templateContext.outputs),
                inputs: templateContext.inputs || {},
                env: templateContext.env,
                permissions: createPermissionHelpers(
                  resolveAssociationFromEvent(prInfo.eventContext, prInfo.authorAssociation),
                  detectLocalMode()
                )
              };
              const trimmedTransform = transformJs.trim();
              const buildBodyWithReturn = (raw) => {
                const t = raw.trim();
                const lines = t.split(/\n/);
                let i = lines.length - 1;
                while (i >= 0 && lines[i].trim().length === 0) i--;
                if (i < 0) return "return undefined;";
                const lastLine = lines[i].trim();
                if (/^return\b/i.test(lastLine)) {
                  return t;
                }
                const idx = t.lastIndexOf(lastLine);
                const head = idx >= 0 ? t.slice(0, idx) : "";
                const lastExpr = lastLine.replace(/;\s*$/, "");
                return `${head}
return (${lastExpr});`;
              };
              const bodyWithReturn = buildBodyWithReturn(trimmedTransform);
              const code = `
            const output = scope.output;
            const pr = scope.pr;
            const files = scope.files;
            const outputs = scope.outputs;
            const inputs = scope.inputs;
            const env = scope.env;
            const log = (...args) => { console.log('\u{1F50D} Debug:', ...args); };
            const hasMinPermission = scope.permissions.hasMinPermission;
            const isOwner = scope.permissions.isOwner;
            const isMember = scope.permissions.isMember;
            const isCollaborator = scope.permissions.isCollaborator;
            const isContributor = scope.permissions.isContributor;
            const isFirstTimer = scope.permissions.isFirstTimer;
            const __result = (function(){
${bodyWithReturn}
            })();
            return __result;
          `;
              if (!this.sandbox) {
                this.sandbox = this.createSecureSandbox();
              }
              let parsedFromSandboxJson = void 0;
              try {
                const stringifyCode = `
              const output = scope.output;
              const pr = scope.pr;
              const files = scope.files;
              const outputs = scope.outputs;
              const env = scope.env;
              const log = (...args) => { console.log('\u{1F50D} Debug:', ...args); };
              const hasMinPermission = scope.permissions.hasMinPermission;
              const isOwner = scope.permissions.isOwner;
              const isMember = scope.permissions.isMember;
              const isCollaborator = scope.permissions.isCollaborator;
              const isContributor = scope.permissions.isContributor;
              const isFirstTimer = scope.permissions.isFirstTimer;
              const __ret = (function(){
${bodyWithReturn}
              })();
              return typeof __ret === 'object' && __ret !== null ? JSON.stringify(__ret) : null;
            `;
                const stringifyExec = this.sandbox.compile(stringifyCode);
                const jsonStr = stringifyExec({ scope: jsContext }).run();
                if (typeof jsonStr === "string" && jsonStr.trim().startsWith("{")) {
                  parsedFromSandboxJson = JSON.parse(jsonStr);
                }
              } catch {
              }
              if (parsedFromSandboxJson !== void 0) {
                finalOutput = parsedFromSandboxJson;
              } else {
                finalOutput = compileAndRun(
                  this.sandbox,
                  code,
                  { scope: jsContext },
                  { injectLog: false, wrapFunction: false }
                );
              }
              try {
                if (finalOutput && typeof finalOutput === "object" && !Array.isArray(finalOutput) && (finalOutput.error === void 0 || finalOutput.issues === void 0)) {
                  const vm = await import("vm");
                  const vmContext = vm.createContext({ scope: jsContext });
                  const vmCode = `
                (function(){
                  const output = scope.output; const pr = scope.pr; const files = scope.files; const outputs = scope.outputs; const env = scope.env; const log = ()=>{};
${bodyWithReturn}
                })()
              `;
                  const vmResult = vm.runInContext(vmCode, vmContext, { timeout: 1e3 });
                  if (vmResult && typeof vmResult === "object") {
                    finalOutput = vmResult;
                  }
                }
              } catch {
              }
              let finalSnapshot = null;
              try {
                if (finalOutput && typeof finalOutput === "object" && !Array.isArray(finalOutput)) {
                  try {
                    const stringifyExec = this.sandbox.compile("return JSON.stringify(scope.obj);");
                    const jsonStr = stringifyExec({ obj: finalOutput }).run();
                    if (typeof jsonStr === "string" && jsonStr.trim().startsWith("{")) {
                      finalSnapshot = JSON.parse(jsonStr);
                    }
                  } catch {
                  }
                  if (!finalSnapshot) {
                    try {
                      finalSnapshot = JSON.parse(JSON.stringify(finalOutput));
                    } catch {
                    }
                  }
                  if (!finalSnapshot) {
                    const tmp = {};
                    for (const k of Object.keys(finalOutput)) {
                      tmp[k] = finalOutput[k];
                    }
                    finalSnapshot = tmp;
                  }
                }
              } catch {
              }
              this.__lastTransformSnapshot = finalSnapshot;
              try {
                const isObj = finalOutput && typeof finalOutput === "object" && !Array.isArray(finalOutput);
                const keys = isObj ? Object.keys(finalOutput).join(",") : typeof finalOutput;
                logger.debug(
                  `  transform_js: output typeof=${Array.isArray(finalOutput) ? "array" : typeof finalOutput} keys=${keys}`
                );
                if (isObj && finalOutput.issues) {
                  const mi = finalOutput.issues;
                  logger.debug(
                    `  transform_js: issues typeof=${Array.isArray(mi) ? "array" : typeof mi} len=${mi && mi.length || 0}`
                  );
                }
                try {
                  if (isObj)
                    logger.debug(`  transform_js: error value=${String(finalOutput.error)}`);
                } catch {
                }
              } catch {
              }
              logger.verbose(`\u2713 Applied JavaScript transform successfully`);
            } catch (error) {
              logger.error(
                `\u2717 Failed to apply JavaScript transform: ${error instanceof Error ? error.message : "Unknown error"}`
              );
              return {
                issues: [
                  {
                    file: "command",
                    line: 0,
                    ruleId: "command/transform_js_error",
                    message: `Failed to apply JavaScript transform: ${error instanceof Error ? error.message : "Unknown error"}`,
                    severity: "error",
                    category: "logic"
                  }
                ]
              };
            }
          }
          let issues = [];
          let outputForDependents = finalOutput;
          const snapshotForExtraction = this.__lastTransformSnapshot || null;
          try {
            if (snapshotForExtraction) {
              logger.debug(`  provider: snapshot keys=${Object.keys(snapshotForExtraction).join(",")}`);
            } else {
              logger.debug(`  provider: snapshot is null`);
            }
          } catch {
          }
          try {
            if (Array.isArray(outputForDependents) && outputForDependents.length === 1) {
              const first = outputForDependents[0];
              if (typeof first === "string") {
                try {
                  outputForDependents = JSON.parse(first);
                } catch {
                }
              } else if (first && typeof first === "object") {
                outputForDependents = first;
              }
            }
          } catch {
          }
          let content;
          let extracted = null;
          const trimmedRawOutput = typeof rawOutput === "string" ? rawOutput.trim() : void 0;
          const commandConfig = config;
          const isForEachParent = commandConfig.forEach === true;
          if (!isForEachParent) {
            try {
              const baseObj = snapshotForExtraction || finalOutput;
              if (baseObj && typeof baseObj === "object" && Object.prototype.hasOwnProperty.call(baseObj, "issues")) {
                const remaining = { ...baseObj };
                delete remaining.issues;
                outputForDependents = Object.keys(remaining).length > 0 ? remaining : void 0;
                try {
                  const k = outputForDependents && typeof outputForDependents === "object" ? Object.keys(outputForDependents).join(",") : String(outputForDependents);
                  logger.debug(`  provider: generic-remaining keys=${k}`);
                } catch {
                }
              }
            } catch {
            }
            const objForExtraction = snapshotForExtraction || finalOutput;
            if (objForExtraction && typeof objForExtraction === "object") {
              try {
                const rec = objForExtraction;
                const maybeIssues = rec.issues;
                const toPlainArray = (v) => {
                  if (Array.isArray(v)) return v;
                  try {
                    if (v && typeof v === "object" && typeof v[Symbol.iterator] === "function") {
                      return Array.from(v);
                    }
                  } catch {
                  }
                  const len = Number((v || {}).length);
                  if (Number.isFinite(len) && len >= 0) {
                    const arr2 = [];
                    for (let i = 0; i < len; i++) arr2.push(v[i]);
                    return arr2;
                  }
                  try {
                    const cloned = JSON.parse(JSON.stringify(v));
                    return Array.isArray(cloned) ? cloned : null;
                  } catch {
                    return null;
                  }
                };
                try {
                  const ctor = maybeIssues && maybeIssues.constructor ? maybeIssues.constructor.name : "unknown";
                  logger.debug(
                    `  provider: issues inspect typeof=${typeof maybeIssues} Array.isArray=${Array.isArray(
                      maybeIssues
                    )} ctor=${ctor} keys=${Object.keys(maybeIssues || {}).join(",")}`
                  );
                } catch {
                }
                const arr = toPlainArray(maybeIssues);
                if (arr) {
                  const norm = this.normalizeIssueArray(arr);
                  if (norm) {
                    issues = norm;
                    const remaining = { ...rec };
                    delete remaining.issues;
                    outputForDependents = Object.keys(remaining).length > 0 ? remaining : void 0;
                    try {
                      const keys = outputForDependents && typeof outputForDependents === "object" ? Object.keys(outputForDependents).join(",") : String(outputForDependents);
                      logger.info(
                        `  provider: fast-path issues=${issues.length} remaining keys=${keys}`
                      );
                    } catch {
                    }
                  } else {
                    try {
                      logger.info("  provider: fast-path norm failed");
                    } catch {
                    }
                  }
                } else {
                  try {
                    logger.info("  provider: fast-path arr unavailable");
                  } catch {
                  }
                }
              } catch {
              }
            }
            let extractionTarget = snapshotForExtraction || finalOutput;
            try {
              if (Array.isArray(extractionTarget) && extractionTarget.length === 1) {
                const first = extractionTarget[0];
                if (typeof first === "string") {
                  try {
                    extractionTarget = JSON.parse(first);
                  } catch {
                    extractionTarget = first;
                  }
                } else if (first && typeof first === "object") {
                  extractionTarget = first;
                }
              }
            } catch {
            }
            extracted = this.extractIssuesFromOutput(extractionTarget);
            try {
              if (extractionTarget !== (snapshotForExtraction || finalOutput)) {
                finalOutput = extractionTarget;
              }
            } catch {
            }
            if (!extracted && finalOutput && typeof finalOutput === "object") {
              try {
                const rec = finalOutput;
                const maybeIssues = rec.issues;
                if (maybeIssues && typeof maybeIssues === "object") {
                  let arr = null;
                  try {
                    if (typeof maybeIssues[Symbol.iterator] === "function") {
                      arr = Array.from(maybeIssues);
                    }
                  } catch {
                  }
                  if (!arr) {
                    const len = Number(maybeIssues.length);
                    if (Number.isFinite(len) && len >= 0) {
                      arr = [];
                      for (let i = 0; i < len; i++) arr.push(maybeIssues[i]);
                    }
                  }
                  if (!arr) {
                    try {
                      arr = JSON.parse(JSON.stringify(maybeIssues));
                    } catch {
                    }
                  }
                  if (arr && Array.isArray(arr)) {
                    const norm = this.normalizeIssueArray(arr);
                    if (norm) {
                      issues = norm;
                      const remaining = { ...rec };
                      delete remaining.issues;
                      outputForDependents = Object.keys(remaining).length > 0 ? remaining : void 0;
                    }
                  }
                }
              } catch {
              }
            }
            if (!extracted && typeof finalOutput === "string") {
              try {
                const parsed = JSON.parse(finalOutput);
                extracted = this.extractIssuesFromOutput(parsed);
                if (extracted) {
                  issues = extracted.issues;
                  outputForDependents = extracted.remainingOutput;
                  if (typeof extracted.remainingOutput === "object" && extracted.remainingOutput !== null && typeof extracted.remainingOutput.content === "string") {
                    const c = String(extracted.remainingOutput.content).trim();
                    if (c) content = c;
                  }
                }
              } catch {
                try {
                  const any = this.extractJsonAnywhere(finalOutput);
                  if (any) {
                    const parsed = JSON.parse(any);
                    extracted = this.extractIssuesFromOutput(parsed);
                    if (extracted) {
                      issues = extracted.issues;
                      outputForDependents = extracted.remainingOutput;
                      if (typeof extracted.remainingOutput === "object" && extracted.remainingOutput !== null && typeof extracted.remainingOutput.content === "string") {
                        const c = String(extracted.remainingOutput.content).trim();
                        if (c) content = c;
                      }
                    }
                  }
                } catch {
                }
              }
            } else if (extracted) {
              issues = extracted.issues;
              outputForDependents = extracted.remainingOutput;
              if (typeof extracted.remainingOutput === "object" && extracted.remainingOutput !== null && typeof extracted.remainingOutput.content === "string") {
                const c = String(extracted.remainingOutput.content).trim();
                if (c) content = c;
              }
            }
            if (!issues.length && this.shouldTreatAsTextOutput(trimmedRawOutput)) {
              content = trimmedRawOutput;
            } else if (issues.length && typeof extracted?.remainingOutput === "string") {
              const trimmed = extracted.remainingOutput.trim();
              if (trimmed) {
                content = trimmed;
              }
            }
            if (!issues.length && typeof trimmedRawOutput === "string") {
              try {
                const tryParsed = JSON.parse(trimmedRawOutput);
                const reextract = this.extractIssuesFromOutput(tryParsed);
                if (reextract && reextract.issues && reextract.issues.length) {
                  issues = reextract.issues;
                  if (!outputForDependents && reextract.remainingOutput) {
                    outputForDependents = reextract.remainingOutput;
                  }
                } else if (Array.isArray(tryParsed)) {
                  const first = tryParsed[0];
                  if (first && typeof first === "object" && Array.isArray(first.issues)) {
                    const merged = [];
                    for (const el of tryParsed) {
                      if (el && typeof el === "object" && Array.isArray(el.issues)) {
                        merged.push(...el.issues);
                      }
                    }
                    const flat = this.normalizeIssueArray(merged);
                    if (flat) issues = flat;
                  } else {
                    const converted = [];
                    for (const el of tryParsed) {
                      if (typeof el === "string") {
                        try {
                          const obj = JSON.parse(el);
                          converted.push(obj);
                        } catch {
                        }
                      } else {
                        converted.push(el);
                      }
                    }
                    const flat = this.normalizeIssueArray(converted);
                    if (flat) issues = flat;
                  }
                }
              } catch {
              }
              if (!issues.length) {
                try {
                  const any = this.extractJsonAnywhere(trimmedRawOutput);
                  if (any) {
                    const tryParsed = JSON.parse(any);
                    const reextract = this.extractIssuesFromOutput(tryParsed);
                    if (reextract && reextract.issues && reextract.issues.length) {
                      issues = reextract.issues;
                      if (!outputForDependents && reextract.remainingOutput) {
                        outputForDependents = reextract.remainingOutput;
                      }
                    }
                  }
                } catch {
                }
              }
            }
            try {
              const srcObj = snapshotForExtraction || finalOutput;
              if (outputForDependents && typeof outputForDependents === "object" && srcObj && typeof srcObj === "object") {
                for (const k of Object.keys(srcObj)) {
                  const v = srcObj[k];
                  if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") {
                    outputForDependents[k] = v;
                  }
                }
              }
            } catch {
            }
            try {
              if (outputForDependents && typeof outputForDependents === "object" && !Array.isArray(outputForDependents)) {
                const plain = {};
                for (const k of Object.keys(outputForDependents)) {
                  plain[k] = outputForDependents[k];
                }
                outputForDependents = plain;
              }
            } catch {
            }
          }
          if (!content && this.shouldTreatAsTextOutput(trimmedRawOutput) && !isForEachParent) {
            content = trimmedRawOutput;
          }
          try {
            if (outputForDependents && typeof outputForDependents === "object") {
              outputForDependents = JSON.parse(JSON.stringify(outputForDependents));
            }
          } catch {
          }
          const promoted = {};
          try {
            const srcObj = snapshotForExtraction || finalOutput;
            if (srcObj && typeof srcObj === "object") {
              for (const k of Object.keys(srcObj)) {
                const v = srcObj[k];
                if (typeof v === "boolean") {
                  if (v === true && promoted[k] === void 0) promoted[k] = true;
                } else if ((typeof v === "number" || typeof v === "string") && promoted[k] === void 0) {
                  promoted[k] = v;
                }
              }
            }
          } catch {
          }
          const result = {
            issues,
            output: outputForDependents,
            ...content ? { content } : {},
            ...promoted
          };
          try {
            const span = trace.getSpan(context.active());
            if (span) {
              captureCheckOutput(span, outputForDependents);
              if (transformJs && output !== finalOutput) {
                captureTransformJS(span, transformJs, output, finalOutput);
              }
            }
          } catch {
          }
          try {
            const checkId = config.checkName || config.id || "unknown";
            const outJson = JSON.stringify(result.output ?? result);
            const { emitNdjsonSpanWithEvents: emitNdjsonSpanWithEvents2 } = (init_fallback_ndjson(), __toCommonJS(fallback_ndjson_exports));
            emitNdjsonSpanWithEvents2(
              "visor.check",
              { "visor.check.id": checkId, "visor.check.output": outJson },
              [{ name: "check.started" }, { name: "check.completed" }]
            );
          } catch {
          }
          try {
            if (transformJs) {
              const rawObj = snapshotForExtraction || finalOutput;
              if (rawObj && typeof rawObj === "object") {
                result.__raw = rawObj;
              }
            }
          } catch {
          }
          try {
            const srcObj = snapshotForExtraction || finalOutput;
            const srcErr = (() => {
              try {
                if (snapshotForExtraction && typeof snapshotForExtraction === "object" && snapshotForExtraction.error !== void 0) {
                  return Boolean(snapshotForExtraction.error);
                }
                if (finalOutput && typeof finalOutput === "object" && finalOutput.error !== void 0) {
                  return Boolean(finalOutput.error);
                }
              } catch {
              }
              return void 0;
            })();
            const dst = result.output;
            if (srcObj && typeof srcObj === "object" && dst && typeof dst === "object") {
              try {
                logger.debug(
                  `  provider: safeguard src.error typeof=${typeof srcObj.error} val=${String(srcObj.error)} dst.hasErrorBefore=${String(dst.error !== void 0)}`
                );
              } catch {
              }
              for (const k of Object.keys(srcObj)) {
                const v = srcObj[k];
                if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") {
                  dst[k] = v;
                }
              }
              if (srcErr !== void 0 && dst.error === void 0) {
                dst.error = srcErr;
                try {
                  const k = Object.keys(dst).join(",");
                  logger.debug(
                    `  provider: safeguard merged error -> output keys=${k} val=${String(dst.error)}`
                  );
                } catch {
                }
              }
            }
          } catch {
          }
          try {
            const out = result.output;
            if (out && typeof out === "object") {
              const k = Object.keys(out).join(",");
              logger.debug(`  provider: return output keys=${k}`);
            } else {
              logger.debug(`  provider: return output type=${typeof out}`);
            }
          } catch {
          }
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          let isTimeout = false;
          if (error && typeof error === "object") {
            const execError = error;
            if (execError.killed && execError.signal === "SIGTERM") {
              isTimeout = true;
            }
            if (execError.code === "ETIMEDOUT") {
              isTimeout = true;
            }
          }
          let stderrOutput = "";
          if (error && typeof error === "object") {
            const execError = error;
            if (execError.stderr) {
              stderrOutput = execError.stderr.trim();
            }
          }
          let detailedMessage;
          let ruleId;
          if (isTimeout) {
            const timeoutSeconds = config.timeout || 60;
            detailedMessage = `Command execution timed out after ${timeoutSeconds} seconds`;
            if (stderrOutput) {
              detailedMessage += `

Stderr output:
${stderrOutput}`;
            }
            ruleId = "command/timeout";
          } else {
            detailedMessage = stderrOutput ? `Command execution failed: ${errorMessage}

Stderr output:
${stderrOutput}` : `Command execution failed: ${errorMessage}`;
            ruleId = "command/execution_error";
          }
          logger.error(`\u2717 ${detailedMessage}`);
          return {
            issues: [
              {
                file: "command",
                line: 0,
                ruleId,
                message: detailedMessage,
                severity: "error",
                category: "logic"
              }
            ]
          };
        }
      }
      buildOutputContext(dependencyResults, outputHistory) {
        if (!dependencyResults) {
          return {};
        }
        const outputs = {};
        const history = {};
        for (const [checkName, result] of dependencyResults) {
          const summary = result;
          const value = summary.output !== void 0 ? summary.output : summary;
          outputs[checkName] = this.makeJsonSmart(value);
        }
        if (outputHistory) {
          for (const [checkName, historyArray] of outputHistory) {
            history[checkName] = historyArray.map((val) => this.makeJsonSmart(val));
          }
        }
        outputs.history = history;
        return outputs;
      }
      /**
       * Wrap a value with JSON-smart behavior:
       *  - If it's a JSON string, expose parsed properties via Proxy (e.g., value.key)
       *  - When coerced to string (toString/valueOf/Symbol.toPrimitive), return the original raw string
       *  - If parsing fails or value is not a string, return the value unchanged
       *  - Attempts to extract JSON from the end of the output if full parse fails
       */
      makeJsonSmart(value) {
        if (typeof value !== "string") {
          return value;
        }
        const raw = value;
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          const jsonMatch = this.extractJsonFromEnd(raw);
          if (jsonMatch) {
            try {
              parsed = JSON.parse(jsonMatch);
              logger.debug(
                `\u{1F527} Debug: Extracted JSON from end of output (${jsonMatch.length} chars from ${raw.length} total)`
              );
            } catch {
              return raw;
            }
          } else {
            return raw;
          }
        }
        const boxed = new String(raw);
        const handler = {
          get(target, prop, receiver) {
            if (prop === "toString" || prop === "valueOf") {
              return () => raw;
            }
            if (prop === Symbol.toPrimitive) {
              return () => raw;
            }
            if (parsed != null && (typeof parsed === "object" || Array.isArray(parsed))) {
              if (prop in parsed) {
                return parsed[prop];
              }
            }
            return Reflect.get(target, prop, receiver);
          },
          has(_target, prop) {
            if (parsed != null && (typeof parsed === "object" || Array.isArray(parsed))) {
              if (prop in parsed) return true;
            }
            return false;
          },
          ownKeys(_target) {
            if (parsed != null && (typeof parsed === "object" || Array.isArray(parsed))) {
              try {
                return Reflect.ownKeys(parsed);
              } catch {
                return [];
              }
            }
            return [];
          },
          getOwnPropertyDescriptor(_target, prop) {
            if (parsed != null && (typeof parsed === "object" || Array.isArray(parsed))) {
              const descriptor = Object.getOwnPropertyDescriptor(parsed, prop);
              if (descriptor) return descriptor;
            }
            return {
              configurable: true,
              enumerable: true,
              writable: false,
              value: void 0
            };
          }
        };
        return new Proxy(boxed, handler);
      }
      /**
       * Extract JSON from the end of a string that may contain logs/debug output
       * Looks for the last occurrence of { or [ and tries to parse from there
       */
      extractJsonFromEnd(text) {
        const lastBrace = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
        if (lastBrace === -1) return null;
        let open = 0;
        for (let i = lastBrace; i >= 0; i--) {
          const ch = text[i];
          if (ch === "}" || ch === "]") open++;
          else if (ch === "{" || ch === "[") open--;
          if (open === 0 && (ch === "{" || ch === "[")) {
            const candidate = text.slice(i, lastBrace + 1).trim();
            try {
              JSON.parse(candidate);
              return candidate;
            } catch {
              return null;
            }
          }
        }
        return null;
      }
      // Extract any balanced JSON object/array substring from anywhere in the text
      extractJsonAnywhere(text) {
        const n = text.length;
        let best = null;
        for (let i = 0; i < n; i++) {
          const start = text[i];
          if (start !== "{" && start !== "[") continue;
          let open = 0;
          let inString = false;
          let escape = false;
          for (let j = i; j < n; j++) {
            const ch = text[j];
            if (escape) {
              escape = false;
              continue;
            }
            if (ch === "\\") {
              escape = true;
              continue;
            }
            if (ch === '"') {
              inString = !inString;
              continue;
            }
            if (inString) continue;
            if (ch === "{" || ch === "[") open++;
            else if (ch === "}" || ch === "]") open--;
            if (open === 0 && (ch === "}" || ch === "]")) {
              const candidate = text.slice(i, j + 1).trim();
              try {
                JSON.parse(candidate);
                best = candidate;
              } catch {
                const strict = this.looseJsonToStrict(candidate);
                if (strict) {
                  try {
                    JSON.parse(strict);
                    best = strict;
                  } catch {
                  }
                }
              }
              break;
            }
          }
        }
        return best;
      }
      // Best-effort conversion of object-literal-like strings to strict JSON
      looseJsonToStrict(candidate) {
        try {
          let s = candidate.trim();
          s = s.replace(/'/g, '"');
          s = s.replace(/([\{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:/g, '$1"$2":');
          s = s.replace(/:\s*([A-Za-z_][A-Za-z0-9_-]*)\s*(?=[,}])/g, (m, word) => {
            const lw = String(word).toLowerCase();
            if (lw === "true" || lw === "false" || lw === "null") return `:${lw}`;
            return `:"${word}"`;
          });
          return s;
        } catch {
          return null;
        }
      }
      /**
       * Recursively apply JSON-smart wrapper to outputs object values
       */
      makeOutputsJsonSmart(outputs) {
        const wrapped = {};
        for (const [k, v] of Object.entries(outputs || {})) {
          wrapped[k] = this.makeJsonSmart(v);
        }
        return wrapped;
      }
      getSafeEnvironmentVariables() {
        const safeVars = {};
        const allowedPrefixes = [];
        const { buildSandboxEnv: buildSandboxEnv2 } = (init_env_exposure(), __toCommonJS(env_exposure_exports));
        const merged = buildSandboxEnv2(process.env);
        for (const [key, value] of Object.entries(merged)) {
          safeVars[key] = String(value);
        }
        safeVars["PWD"] = process.cwd();
        return safeVars;
      }
      getSupportedConfigKeys() {
        return [
          "type",
          "exec",
          "transform",
          "transform_js",
          "env",
          "timeout",
          "depends_on",
          "on",
          "if",
          "group",
          "forEach"
        ];
      }
      async isAvailable() {
        return true;
      }
      getRequirements() {
        return [
          "Valid shell command to execute",
          "Shell environment available",
          "Optional: Transform template for processing output"
        ];
      }
      extractIssuesFromOutput(output) {
        try {
          logger.info(
            `  extractIssuesFromOutput: typeof=${Array.isArray(output) ? "array" : typeof output}`
          );
          if (typeof output === "object" && output) {
            const rec = output;
            logger.info(
              `  extractIssuesFromOutput: keys=${Object.keys(rec).join(",")} issuesIsArray=${Array.isArray(
                rec.issues
              )}`
            );
          }
        } catch {
        }
        if (output === null || output === void 0) {
          return null;
        }
        if (typeof output === "string") {
          return null;
        }
        if (Array.isArray(output)) {
          const first = output[0];
          if (first && typeof first === "object" && !Array.isArray(first.message) && Array.isArray(first.issues)) {
            const merged = [];
            for (const el of output) {
              if (el && typeof el === "object" && Array.isArray(el.issues)) {
                merged.push(...el.issues);
              }
            }
            const flat = this.normalizeIssueArray(merged);
            if (flat) return { issues: flat, remainingOutput: void 0 };
          } else {
            const issues = this.normalizeIssueArray(output);
            if (issues) {
              return { issues, remainingOutput: void 0 };
            }
          }
          return null;
        }
        if (typeof output === "object") {
          const record = output;
          if (Array.isArray(record.issues)) {
            const issues = this.normalizeIssueArray(record.issues);
            if (!issues) {
              return null;
            }
            const remaining = { ...record };
            delete remaining.issues;
            const remainingKeys = Object.keys(remaining);
            const remainingOutput = remainingKeys.length > 0 ? remaining : void 0;
            return {
              issues,
              remainingOutput
            };
          }
          const singleIssue = this.normalizeIssue(record);
          if (singleIssue) {
            return { issues: [singleIssue], remainingOutput: void 0 };
          }
        }
        return null;
      }
      shouldTreatAsTextOutput(value) {
        if (!value) {
          return false;
        }
        const trimmed = value.trim();
        if (!trimmed) {
          return false;
        }
        const startsJson = trimmed.startsWith("{") && trimmed.endsWith("}") || trimmed.startsWith("[") && trimmed.endsWith("]");
        return !startsJson;
      }
      normalizeIssueArray(values) {
        const normalized = [];
        for (const value of values) {
          const issue = this.normalizeIssue(value);
          if (!issue) {
            return null;
          }
          normalized.push(issue);
        }
        return normalized;
      }
      normalizeIssue(raw) {
        if (!raw || typeof raw !== "object") {
          return null;
        }
        const data = raw;
        const message = this.toTrimmedString(
          data.message || data.text || data.description || data.summary
        );
        if (!message) {
          return null;
        }
        const allowedSeverities = /* @__PURE__ */ new Set(["info", "warning", "error", "critical"]);
        const severityRaw = this.toTrimmedString(data.severity || data.level || data.priority);
        let severity = "warning";
        if (severityRaw) {
          const lower = severityRaw.toLowerCase();
          if (allowedSeverities.has(lower)) {
            severity = lower;
          } else if (["fatal", "high"].includes(lower)) {
            severity = "error";
          } else if (["medium", "moderate"].includes(lower)) {
            severity = "warning";
          } else if (["low", "minor"].includes(lower)) {
            severity = "info";
          }
        }
        const allowedCategories = /* @__PURE__ */ new Set([
          "security",
          "performance",
          "style",
          "logic",
          "documentation"
        ]);
        const categoryRaw = this.toTrimmedString(data.category || data.type || data.group);
        let category = "logic";
        if (categoryRaw && allowedCategories.has(categoryRaw.toLowerCase())) {
          category = categoryRaw.toLowerCase();
        }
        const file = this.toTrimmedString(data.file || data.path || data.filename) || "system";
        const line = this.toNumber(data.line || data.startLine || data.lineNumber) ?? 0;
        const endLine = this.toNumber(data.endLine || data.end_line || data.stopLine);
        const suggestion = this.toTrimmedString(data.suggestion);
        const replacement = this.toTrimmedString(data.replacement);
        const ruleId = this.toTrimmedString(data.ruleId || data.rule || data.id || data.check) || "command";
        return {
          file,
          line,
          endLine: endLine ?? void 0,
          ruleId,
          message,
          severity,
          category,
          suggestion: suggestion || void 0,
          replacement: replacement || void 0
        };
      }
      toTrimmedString(value) {
        if (typeof value === "string") {
          const trimmed = value.trim();
          return trimmed.length > 0 ? trimmed : null;
        }
        if (value !== null && value !== void 0 && typeof value.toString === "function") {
          const converted = String(value).trim();
          return converted.length > 0 ? converted : null;
        }
        return null;
      }
      toNumber(value) {
        if (value === null || value === void 0) {
          return null;
        }
        const num = Number(value);
        if (Number.isFinite(num)) {
          return Math.trunc(num);
        }
        return null;
      }
      async renderCommandTemplate(template, context2) {
        try {
          let tpl = template;
          if (tpl.includes("{{")) {
            tpl = tpl.replace(/\{\{([\s\S]*?)\}\}/g, (_m, inner) => {
              const fixed = String(inner).replace(/\[\"/g, "['").replace(/\"\]/g, "']");
              return `{{ ${fixed} }}`;
            });
          }
          let rendered = await this.liquid.parseAndRender(tpl, context2);
          if (/\{\{[\s\S]*?\}\}/.test(rendered)) {
            try {
              rendered = this.renderWithJsExpressions(rendered, context2);
            } catch {
            }
          }
          return rendered;
        } catch (error) {
          logger.debug(`\u{1F527} Debug: Liquid templating failed, trying JS-expression fallback: ${error}`);
          try {
            return this.renderWithJsExpressions(template, context2);
          } catch {
            return template;
          }
        }
      }
      renderWithJsExpressions(template, context2) {
        const scope = {
          pr: context2.pr,
          files: context2.files,
          outputs: context2.outputs,
          env: context2.env
        };
        const expressionRegex = /\{\{\s*([^{}]+?)\s*\}\}/g;
        return template.replace(expressionRegex, (_match, expr) => {
          const expression = String(expr).trim();
          if (!expression) return "";
          try {
            const evalCode = `
          const pr = scope.pr;
          const files = scope.files;
          const outputs = scope.outputs;
          const env = scope.env;
          return (${expression});
        `;
            if (!this.sandbox) this.sandbox = this.createSecureSandbox();
            const evaluator = this.sandbox.compile(evalCode);
            const result = evaluator({ scope }).run();
            return result === void 0 || result === null ? "" : String(result);
          } catch {
            return "";
          }
        });
      }
    };
  }
});

// src/utils/template-context.ts
function prCacheKey(pr) {
  let sum = 0;
  for (const f of pr.files) sum += (f.additions || 0) + (f.deletions || 0) + (f.changes || 0);
  return [pr.number, pr.title, pr.author, pr.base, pr.head, pr.files.length, sum].join("|");
}
function buildProviderTemplateContext(prInfo, dependencyResults, memoryStore, outputHistory, stageHistoryBase, opts = { attachMemoryReadHelpers: true }) {
  const context2 = {};
  const key = prCacheKey(prInfo);
  let prObj = prCache.get(key);
  if (!prObj) {
    prObj = {
      number: prInfo.number,
      title: prInfo.title,
      body: prInfo.body,
      author: prInfo.author,
      base: prInfo.base,
      head: prInfo.head,
      totalAdditions: prInfo.totalAdditions,
      totalDeletions: prInfo.totalDeletions,
      files: prInfo.files.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes
      }))
    };
    prCache.set(key, prObj);
    if (prCache.size > PR_CACHE_LIMIT) {
      const first = prCache.keys().next();
      if (!first.done) prCache.delete(first.value);
    }
  }
  context2.pr = prObj;
  const outputs = {};
  const outputsRaw = {};
  const history = {};
  if (dependencyResults) {
    for (const [checkName, result] of dependencyResults.entries()) {
      if (typeof checkName !== "string") continue;
      const summary = result;
      if (checkName.endsWith("-raw")) {
        const name = checkName.slice(0, -4);
        outputsRaw[name] = summary.output !== void 0 ? summary.output : summary;
      } else {
        const extracted = summary.output !== void 0 ? summary.output : summary;
        outputs[checkName] = extracted;
      }
    }
  }
  if (outputHistory) {
    for (const [checkName, historyArray] of outputHistory) {
      history[checkName] = historyArray;
    }
  }
  const historyStage = {};
  try {
    if (outputHistory && stageHistoryBase) {
      for (const [checkName, historyArray] of outputHistory) {
        const start = stageHistoryBase[checkName] || 0;
        const arr = Array.isArray(historyArray) ? historyArray : [];
        historyStage[checkName] = arr.slice(start);
      }
    }
  } catch {
  }
  outputs.history = history;
  context2.outputs = outputs;
  context2.outputs_history = history;
  context2.outputs_history_stage = historyStage;
  context2.outputs_raw = outputsRaw;
  if (opts.attachMemoryReadHelpers && memoryStore) {
    context2.memory = {
      get: (key2, ns) => memoryStore.get(key2, ns),
      has: (key2, ns) => memoryStore.has(key2, ns),
      list: (ns) => memoryStore.list(ns),
      getAll: (ns) => memoryStore.getAll(ns)
    };
  }
  return context2;
}
var PR_CACHE_LIMIT, prCache;
var init_template_context = __esm({
  "src/utils/template-context.ts"() {
    "use strict";
    PR_CACHE_LIMIT = 16;
    prCache = /* @__PURE__ */ new Map();
  }
});

// src/utils/script-memory-ops.ts
function createSyncMemoryOps(store) {
  let saveNeeded = false;
  const ensureNs = (ns) => {
    const nsName = ns || store.getDefaultNamespace();
    const anyStore = store;
    if (!anyStore["data"].has(nsName)) {
      anyStore["data"].set(nsName, /* @__PURE__ */ new Map());
    }
    return nsName;
  };
  const ops = {
    get: (key, ns) => store.get(key, ns),
    has: (key, ns) => store.has(key, ns),
    list: (ns) => store.list(ns),
    getAll: (ns) => store.getAll(ns),
    set: (key, value, ns) => {
      const nsName = ensureNs(ns);
      store["data"].get(nsName).set(key, value);
      saveNeeded = true;
      return value;
    },
    append: (key, value, ns) => {
      const existing = store.get(key, ns);
      let newValue;
      if (existing === void 0) newValue = [value];
      else if (Array.isArray(existing)) newValue = [...existing, value];
      else newValue = [existing, value];
      const nsName = ensureNs(ns);
      store["data"].get(nsName).set(key, newValue);
      saveNeeded = true;
      return newValue;
    },
    increment: (key, amount = 1, ns) => {
      const nsName = ensureNs(ns);
      const current = store.get(key, nsName);
      const numCurrent = typeof current === "number" ? current : 0;
      const newValue = numCurrent + amount;
      store["data"].get(nsName).set(key, newValue);
      saveNeeded = true;
      return newValue;
    },
    delete: (key, ns) => {
      const nsName = ensureNs(ns);
      const d = store["data"].get(nsName)?.delete(key) || false;
      if (d) saveNeeded = true;
      return d;
    },
    clear: (ns) => {
      if (ns) store["data"].delete(ns);
      else store["data"].clear();
      saveNeeded = true;
    }
  };
  return { ops, needsSave: () => saveNeeded };
}
var init_script_memory_ops = __esm({
  "src/utils/script-memory-ops.ts"() {
    "use strict";
  }
});

// src/providers/memory-check-provider.ts
var MemoryCheckProvider;
var init_memory_check_provider = __esm({
  "src/providers/memory-check-provider.ts"() {
    "use strict";
    init_check_provider_interface();
    init_memory_store();
    init_liquid_extensions();
    init_logger();
    init_sandbox();
    init_template_context();
    init_script_memory_ops();
    MemoryCheckProvider = class extends CheckProvider {
      liquid;
      sandbox;
      constructor() {
        super();
        this.liquid = createExtendedLiquid({
          strictVariables: false,
          strictFilters: false
        });
      }
      /**
       * Create a secure sandbox for JavaScript execution
       */
      createSecureSandbox() {
        return createSecureSandbox();
      }
      getName() {
        return "memory";
      }
      getDescription() {
        return "Memory/state management provider for persistent key-value storage across checks";
      }
      async validateConfig(config) {
        if (!config || typeof config !== "object") {
          return false;
        }
        const cfg = config;
        if (cfg.type !== "memory") {
          return false;
        }
        if (!cfg.operation || typeof cfg.operation !== "string") {
          return false;
        }
        const operation = cfg.operation;
        const validOps = ["get", "set", "append", "increment", "delete", "clear", "list"];
        if (!validOps.includes(operation)) {
          return false;
        }
        if (["get", "set", "append", "increment", "delete"].includes(operation)) {
          if (!cfg.key || typeof cfg.key !== "string") {
            return false;
          }
        }
        if (["set", "append"].includes(operation)) {
          if (cfg.value === void 0 && !cfg.value_js) {
            return false;
          }
        }
        return true;
      }
      async execute(prInfo, config, dependencyResults, _sessionInfo) {
        const operation = config.operation;
        const key = config.key;
        const namespace = config.namespace;
        const memoryStore = MemoryStore.getInstance();
        const templateContext = this.buildTemplateContext(
          prInfo,
          dependencyResults,
          memoryStore,
          config.__outputHistory,
          _sessionInfo?.stageHistoryBase
        );
        let result;
        try {
          switch (operation) {
            case "get":
              result = await this.handleGet(memoryStore, key, namespace);
              break;
            case "set":
              result = await this.handleSet(memoryStore, key, config, namespace, templateContext);
              break;
            case "append":
              result = await this.handleAppend(memoryStore, key, config, namespace, templateContext);
              break;
            case "increment":
              result = await this.handleIncrement(
                memoryStore,
                key,
                config,
                namespace,
                templateContext
              );
              break;
            case "delete":
              result = await this.handleDelete(memoryStore, key, namespace);
              break;
            case "clear":
              result = await this.handleClear(memoryStore, namespace);
              break;
            case "list":
              result = await this.handleList(memoryStore, namespace);
              break;
            default:
              throw new Error(`Unknown memory operation: ${operation}`);
          }
          return {
            issues: [],
            output: result
          };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : "Unknown error in memory operation";
          logger.error(`Memory operation failed: ${errorMsg}`);
          return {
            issues: [],
            output: null,
            error: errorMsg
          };
        }
      }
      async handleGet(store, key, namespace) {
        const value = store.get(key, namespace);
        logger.debug(
          `Memory GET: ${namespace || store.getDefaultNamespace()}.${key} = ${JSON.stringify(value)}`
        );
        return value;
      }
      async handleSet(store, key, config, namespace, context2) {
        const value = await this.computeValue(config, context2);
        await store.set(key, value, namespace);
        logger.debug(
          `Memory SET: ${namespace || store.getDefaultNamespace()}.${key} = ${JSON.stringify(value)}`
        );
        return value;
      }
      async handleAppend(store, key, config, namespace, context2) {
        const value = await this.computeValue(config, context2);
        await store.append(key, value, namespace);
        const result = store.get(key, namespace);
        logger.debug(
          `Memory APPEND: ${namespace || store.getDefaultNamespace()}.${key} += ${JSON.stringify(value)} (now: ${JSON.stringify(result)})`
        );
        return result;
      }
      async handleIncrement(store, key, config, namespace, context2) {
        let amount = 1;
        if (config.value !== void 0 || config.value_js) {
          const computedValue = await this.computeValue(config, context2);
          if (typeof computedValue === "number") {
            amount = computedValue;
          } else {
            throw new Error(`Increment amount must be a number, got ${typeof computedValue}`);
          }
        }
        const result = await store.increment(key, amount, namespace);
        logger.debug(
          `Memory INCREMENT: ${namespace || store.getDefaultNamespace()}.${key} += ${amount} (now: ${result})`
        );
        return result;
      }
      async handleDelete(store, key, namespace) {
        const deleted = await store.delete(key, namespace);
        logger.debug(
          `Memory DELETE: ${namespace || store.getDefaultNamespace()}.${key} (deleted: ${deleted})`
        );
        return deleted;
      }
      async handleClear(store, namespace) {
        await store.clear(namespace);
        logger.debug(`Memory CLEAR: ${namespace ? `namespace ${namespace}` : "all namespaces"}`);
      }
      async handleList(store, namespace) {
        const keys = store.list(namespace);
        logger.debug(`Memory LIST: ${namespace || store.getDefaultNamespace()} (${keys.length} keys)`);
        return keys;
      }
      // For custom JavaScript execution use ScriptCheckProvider.
      /**
       * Compute value from config using value, value_js, transform, or transform_js
       */
      async computeValue(config, context2) {
        let value;
        if (config.value_js && typeof config.value_js === "string") {
          value = this.evaluateJavaScript(config.value_js, context2);
        } else {
          value = config.value;
        }
        if (config.transform && typeof config.transform === "string") {
          const rendered = await this.liquid.parseAndRender(config.transform, {
            ...context2,
            value
          });
          value = rendered;
        }
        if (config.transform_js && typeof config.transform_js === "string") {
          value = this.evaluateJavaScript(config.transform_js, { ...context2, value });
        }
        return value;
      }
      /**
       * Evaluate JavaScript expression in context using SandboxJS for secure execution
       */
      evaluateJavaScript(expression, context2) {
        if (!this.sandbox) {
          this.sandbox = this.createSecureSandbox();
        }
        try {
          const scope = { ...context2 };
          return compileAndRun(this.sandbox, `return (${expression});`, scope, {
            injectLog: true,
            wrapFunction: false,
            logPrefix: "[memory:value_js]"
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : "Unknown error";
          throw new Error(`Failed to evaluate value_js: ${errorMsg}`);
        }
      }
      // No full-script execution in memory provider. Use ScriptCheckProvider.
      /**
       * Build template context for Liquid and JS evaluation
       */
      buildTemplateContext(prInfo, dependencyResults, memoryStore, outputHistory, stageHistoryBase) {
        const base = buildProviderTemplateContext(
          prInfo,
          dependencyResults,
          memoryStore,
          outputHistory,
          stageHistoryBase
        );
        if (memoryStore) {
          const { ops } = createSyncMemoryOps(memoryStore);
          base.memory = ops;
        }
        return base;
      }
      getSupportedConfigKeys() {
        return [
          "type",
          "operation",
          "key",
          "value",
          "value_js",
          "transform",
          "transform_js",
          "namespace",
          "depends_on",
          "group",
          "command",
          "on",
          "if",
          "fail_if",
          "on_fail",
          "on_success"
        ];
      }
      async isAvailable() {
        return true;
      }
      getRequirements() {
        return [
          "No external dependencies required",
          "Used for state management and persistent storage across checks"
        ];
      }
    };
  }
});

// src/providers/custom-tool-executor.ts
import Ajv from "ajv";
var CustomToolExecutor;
var init_custom_tool_executor = __esm({
  "src/providers/custom-tool-executor.ts"() {
    "use strict";
    init_liquid_extensions();
    init_sandbox();
    init_logger();
    init_command_executor();
    CustomToolExecutor = class {
      liquid;
      sandbox;
      tools;
      ajv;
      constructor(tools) {
        this.liquid = createExtendedLiquid({
          cache: false,
          strictFilters: false,
          strictVariables: false
        });
        this.tools = new Map(Object.entries(tools || {}));
        this.ajv = new Ajv({ allErrors: true, verbose: true });
      }
      /**
       * Register a custom tool
       */
      registerTool(tool) {
        if (!tool.name) {
          throw new Error("Tool must have a name");
        }
        this.tools.set(tool.name, tool);
      }
      /**
       * Register multiple tools
       */
      registerTools(tools) {
        for (const [name, tool] of Object.entries(tools)) {
          tool.name = tool.name || name;
          this.registerTool(tool);
        }
      }
      /**
       * Get all registered tools
       */
      getTools() {
        return Array.from(this.tools.values());
      }
      /**
       * Get a specific tool by name
       */
      getTool(name) {
        return this.tools.get(name);
      }
      /**
       * Validate tool input against schema using ajv
       */
      validateInput(tool, input) {
        if (!tool.inputSchema) {
          return;
        }
        const validate = this.ajv.compile(tool.inputSchema);
        const valid = validate(input);
        if (!valid) {
          const errors = validate.errors?.map((err) => {
            if (err.instancePath) {
              return `${err.instancePath}: ${err.message}`;
            }
            return err.message;
          }).join(", ");
          throw new Error(`Input validation failed for tool '${tool.name}': ${errors}`);
        }
      }
      /**
       * Execute a custom tool
       */
      async execute(toolName, args, context2) {
        const tool = this.tools.get(toolName);
        if (!tool) {
          throw new Error(`Tool not found: ${toolName}`);
        }
        this.validateInput(tool, args);
        const templateContext = {
          ...context2,
          args,
          input: args
        };
        const command = await this.liquid.parseAndRender(tool.exec, templateContext);
        let stdin;
        if (tool.stdin) {
          stdin = await this.liquid.parseAndRender(tool.stdin, templateContext);
        }
        const env = commandExecutor.buildEnvironment(process.env, tool.env, context2?.env);
        const result = await commandExecutor.execute(command, {
          stdin,
          cwd: tool.cwd,
          env,
          timeout: tool.timeout || 3e4
        });
        let output = result.stdout;
        if (tool.parseJson) {
          try {
            output = JSON.parse(result.stdout);
          } catch (e) {
            logger.warn(`Failed to parse tool output as JSON: ${e}`);
          }
        }
        if (tool.transform) {
          const transformContext = {
            ...templateContext,
            output,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode
          };
          const transformed = await this.liquid.parseAndRender(tool.transform, transformContext);
          if (typeof transformed === "string" && transformed.trim().startsWith("{")) {
            try {
              output = JSON.parse(transformed);
            } catch {
              output = transformed;
            }
          } else {
            output = transformed;
          }
        }
        if (tool.transform_js) {
          output = await this.applyJavaScriptTransform(tool.transform_js, output, {
            ...templateContext,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode
          });
        }
        return output;
      }
      /**
       * Apply JavaScript transform to output
       */
      async applyJavaScriptTransform(transformJs, output, context2) {
        if (!this.sandbox) {
          this.sandbox = createSecureSandbox();
        }
        const code = `
      const output = ${JSON.stringify(output)};
      const context = ${JSON.stringify(context2)};
      const args = context.args || {};
      const pr = context.pr || {};
      const files = context.files || [];
      const outputs = context.outputs || {};
      const env = context.env || {};

      ${transformJs}
    `;
        try {
          return await compileAndRun(this.sandbox, code, { timeout: 5e3 });
        } catch (error) {
          logger.error(`JavaScript transform error: ${error}`);
          throw error;
        }
      }
      /**
       * Convert custom tools to MCP tool format
       */
      toMcpTools() {
        return Array.from(this.tools.values()).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          handler: async (args) => {
            return this.execute(tool.name, args);
          }
        }));
      }
    };
  }
});

// src/providers/mcp-check-provider.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
var McpCheckProvider;
var init_mcp_check_provider = __esm({
  "src/providers/mcp-check-provider.ts"() {
    "use strict";
    init_check_provider_interface();
    init_logger();
    init_liquid_extensions();
    init_sandbox();
    init_env_resolver();
    init_custom_tool_executor();
    McpCheckProvider = class extends CheckProvider {
      liquid;
      sandbox;
      customToolExecutor;
      constructor() {
        super();
        this.liquid = createExtendedLiquid({
          cache: false,
          strictFilters: false,
          strictVariables: false
        });
      }
      /**
       * Set custom tools for this provider
       */
      setCustomTools(tools) {
        if (!this.customToolExecutor) {
          this.customToolExecutor = new CustomToolExecutor(tools);
        } else {
          this.customToolExecutor.registerTools(tools);
        }
      }
      /**
       * Create a secure sandbox for JavaScript execution
       * - Uses Sandbox.SAFE_GLOBALS which excludes: Function, eval, require, process, etc.
       * - Only allows explicitly whitelisted prototype methods
       * - No access to filesystem, network, or system resources
       */
      createSecureSandbox() {
        return createSecureSandbox();
      }
      getName() {
        return "mcp";
      }
      getDescription() {
        return "Call MCP tools directly using stdio, SSE, HTTP, or custom YAML-defined tools";
      }
      async validateConfig(config) {
        if (!config || typeof config !== "object") {
          return false;
        }
        const cfg = config;
        if (!cfg.method || typeof cfg.method !== "string") {
          logger.error("MCP check requires a method name");
          return false;
        }
        const transport = cfg.transport || "stdio";
        if (transport === "stdio") {
          if (!cfg.command || typeof cfg.command !== "string") {
            logger.error("MCP stdio transport requires a command");
            return false;
          }
          if (/[;&|`$(){}[\]]/.test(cfg.command)) {
            logger.error("MCP stdio command contains potentially unsafe characters");
            return false;
          }
        } else if (transport === "sse" || transport === "http") {
          if (!cfg.url || typeof cfg.url !== "string") {
            logger.error(`MCP ${transport} transport requires a URL`);
            return false;
          }
          try {
            const parsedUrl = new URL(cfg.url);
            if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
              logger.error(
                `Invalid URL protocol for MCP ${transport} transport: ${parsedUrl.protocol}. Only http: and https: are allowed.`
              );
              return false;
            }
          } catch {
            logger.error(`Invalid URL format for MCP ${transport} transport: ${cfg.url}`);
            return false;
          }
        } else if (transport === "custom") {
          logger.debug(`MCP custom transport will validate tool '${cfg.method}' at execution time`);
        } else {
          logger.error(
            `Invalid MCP transport: ${transport}. Must be 'stdio', 'sse', 'http', or 'custom'`
          );
          return false;
        }
        return true;
      }
      async execute(prInfo, config, dependencyResults) {
        const cfg = config;
        try {
          const templateContext = {
            pr: {
              number: prInfo.number,
              title: prInfo.title,
              author: prInfo.author,
              branch: prInfo.head,
              base: prInfo.base
            },
            files: prInfo.files,
            fileCount: prInfo.files.length,
            outputs: this.buildOutputContext(dependencyResults),
            env: this.getSafeEnvironmentVariables()
          };
          let methodArgs = cfg.methodArgs || {};
          if (cfg.argsTransform) {
            const rendered = await this.liquid.parseAndRender(cfg.argsTransform, templateContext);
            try {
              methodArgs = JSON.parse(rendered);
            } catch (error) {
              logger.error(`Failed to parse argsTransform as JSON: ${error}`);
              return {
                issues: [
                  {
                    file: "mcp",
                    line: 0,
                    ruleId: "mcp/args_transform_error",
                    message: `Failed to parse argsTransform: ${error instanceof Error ? error.message : "Unknown error"}`,
                    severity: "error",
                    category: "logic"
                  }
                ]
              };
            }
          }
          const result = await this.executeMcpMethod(cfg, methodArgs, prInfo, dependencyResults);
          let finalOutput = result;
          if (cfg.transform) {
            try {
              const transformContext = {
                ...templateContext,
                output: result
              };
              const rendered = await this.liquid.parseAndRender(cfg.transform, transformContext);
              try {
                finalOutput = JSON.parse(rendered.trim());
              } catch {
                finalOutput = rendered.trim();
              }
            } catch (error) {
              logger.error(`Failed to apply Liquid transform: ${error}`);
              return {
                issues: [
                  {
                    file: "mcp",
                    line: 0,
                    ruleId: "mcp/transform_error",
                    message: `Failed to apply transform: ${error instanceof Error ? error.message : "Unknown error"}`,
                    severity: "error",
                    category: "logic"
                  }
                ]
              };
            }
          }
          if (cfg.transform_js) {
            try {
              if (!this.sandbox) {
                this.sandbox = this.createSecureSandbox();
              }
              const scope = {
                output: finalOutput,
                pr: templateContext.pr,
                files: templateContext.files,
                outputs: templateContext.outputs,
                env: templateContext.env
              };
              finalOutput = compileAndRun(
                this.sandbox,
                `return (${cfg.transform_js});`,
                scope,
                { injectLog: true, wrapFunction: false, logPrefix: "[mcp:transform_js]" }
              );
            } catch (error) {
              logger.error(`Failed to apply JavaScript transform: ${error}`);
              return {
                issues: [
                  {
                    file: "mcp",
                    line: 0,
                    ruleId: "mcp/transform_js_error",
                    message: `Failed to apply JavaScript transform: ${error instanceof Error ? error.message : "Unknown error"}`,
                    severity: "error",
                    category: "logic"
                  }
                ]
              };
            }
          }
          const extracted = this.extractIssuesFromOutput(finalOutput);
          if (extracted) {
            return {
              issues: extracted.issues,
              ...extracted.remainingOutput ? { output: extracted.remainingOutput } : {}
            };
          }
          return {
            issues: [],
            ...finalOutput ? { output: finalOutput } : {}
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          logger.error(`MCP check failed: ${errorMessage}`);
          return {
            issues: [
              {
                file: "mcp",
                line: 0,
                ruleId: "mcp/execution_error",
                message: `MCP check failed: ${errorMessage}`,
                severity: "error",
                category: "logic"
              }
            ]
          };
        }
      }
      /**
       * Execute an MCP method using the configured transport
       */
      async executeMcpMethod(config, methodArgs, prInfo, dependencyResults) {
        const transport = config.transport || "stdio";
        const timeout = (config.timeout || 60) * 1e3;
        if (transport === "custom") {
          if (!this.customToolExecutor) {
            throw new Error(
              'No custom tools available. Define tools in the "tools" section of your configuration.'
            );
          }
          const tool = this.customToolExecutor.getTool(config.method);
          if (!tool) {
            throw new Error(
              `Custom tool not found: ${config.method}. Available tools: ${this.customToolExecutor.getTools().map((t) => t.name).join(", ")}`
            );
          }
          const context2 = {
            pr: prInfo ? {
              number: prInfo.number,
              title: prInfo.title,
              author: prInfo.author,
              branch: prInfo.head,
              base: prInfo.base
            } : void 0,
            files: prInfo?.files,
            outputs: this.buildOutputContext(dependencyResults),
            env: this.getSafeEnvironmentVariables()
          };
          return await this.customToolExecutor.execute(config.method, methodArgs, context2);
        } else if (transport === "stdio") {
          return await this.executeStdioMethod(config, methodArgs, timeout);
        } else if (transport === "sse") {
          return await this.executeSseMethod(config, methodArgs, timeout);
        } else if (transport === "http") {
          return await this.executeHttpMethod(config, methodArgs, timeout);
        } else {
          throw new Error(`Unsupported transport: ${transport}`);
        }
      }
      /**
       * Generic method to execute MCP method with any transport
       */
      async executeWithTransport(transport, config, methodArgs, timeout, transportName) {
        const client = new Client(
          {
            name: "visor-mcp-client",
            version: "1.0.0"
          },
          {
            capabilities: {}
          }
        );
        try {
          let timeoutId;
          try {
            await Promise.race([
              client.connect(transport),
              new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error("Connection timeout")), timeout);
              })
            ]);
          } finally {
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
          }
          logger.debug(`Connected to MCP server via ${transportName}`);
          if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) {
            logger.debug(`MCP Session ID: ${transport.sessionId}`);
          }
          try {
            const toolsResult = await client.listTools();
            logger.debug(`Available MCP tools: ${JSON.stringify(toolsResult?.tools || [])}`);
          } catch (error) {
            logger.debug(`Could not list MCP tools: ${error}`);
          }
          let callTimeoutId;
          try {
            const result = await Promise.race([
              client.callTool({
                name: config.method,
                arguments: methodArgs
              }),
              new Promise((_, reject) => {
                callTimeoutId = setTimeout(() => reject(new Error("Request timeout")), timeout);
              })
            ]);
            logger.debug(`MCP method result: ${JSON.stringify(result)}`);
            return result;
          } finally {
            if (callTimeoutId) {
              clearTimeout(callTimeoutId);
            }
          }
        } finally {
          try {
            await client.close();
          } catch (error) {
            logger.debug(`Error closing MCP client: ${error}`);
          }
        }
      }
      /**
       * Execute MCP method using stdio transport
       */
      async executeStdioMethod(config, methodArgs, timeout) {
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.command_args,
          env: config.env,
          cwd: config.workingDirectory
        });
        return this.executeWithTransport(
          transport,
          config,
          methodArgs,
          timeout,
          `stdio: ${config.command}`
        );
      }
      /**
       * Execute MCP method using SSE transport
       */
      async executeSseMethod(config, methodArgs, timeout) {
        const requestInit = {};
        if (config.headers) {
          requestInit.headers = EnvironmentResolver.resolveHeaders(config.headers);
        }
        const transport = new SSEClientTransport(new URL(config.url), {
          requestInit
        });
        return this.executeWithTransport(transport, config, methodArgs, timeout, `SSE: ${config.url}`);
      }
      /**
       * Execute MCP method using Streamable HTTP transport
       */
      async executeHttpMethod(config, methodArgs, timeout) {
        const requestInit = {};
        if (config.headers) {
          requestInit.headers = EnvironmentResolver.resolveHeaders(config.headers);
        }
        const transport = new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit,
          sessionId: config.sessionId
        });
        return this.executeWithTransport(
          transport,
          config,
          methodArgs,
          timeout,
          `Streamable HTTP: ${config.url}`
        );
      }
      /**
       * Build output context from dependency results
       */
      buildOutputContext(dependencyResults) {
        if (!dependencyResults) {
          return {};
        }
        const outputs = {};
        for (const [checkName, result] of dependencyResults) {
          const summary = result;
          outputs[checkName] = summary.output !== void 0 ? summary.output : summary;
        }
        return outputs;
      }
      /**
       * Get safe environment variables
       */
      getSafeEnvironmentVariables() {
        const safeVars = {};
        const allowedPrefixes = [];
        const { buildSandboxEnv: buildSandboxEnv2 } = (init_env_exposure(), __toCommonJS(env_exposure_exports));
        const merged = buildSandboxEnv2(process.env);
        for (const [key, value] of Object.entries(merged)) {
          safeVars[key] = String(value);
        }
        safeVars["PWD"] = process.cwd();
        return safeVars;
      }
      /**
       * Extract issues from MCP output
       */
      extractIssuesFromOutput(output) {
        if (output === null || output === void 0) {
          return null;
        }
        if (typeof output === "string") {
          try {
            const parsed = JSON.parse(output);
            return this.extractIssuesFromOutput(parsed);
          } catch {
            return null;
          }
        }
        if (Array.isArray(output)) {
          const issues = this.normalizeIssueArray(output);
          if (issues) {
            return { issues, remainingOutput: void 0 };
          }
          return null;
        }
        if (typeof output === "object") {
          const record = output;
          if (Array.isArray(record.issues)) {
            const issues = this.normalizeIssueArray(record.issues);
            if (!issues) {
              return null;
            }
            const remaining = { ...record };
            delete remaining.issues;
            return {
              issues,
              remainingOutput: Object.keys(remaining).length > 0 ? remaining : void 0
            };
          }
          const singleIssue = this.normalizeIssue(record);
          if (singleIssue) {
            return { issues: [singleIssue], remainingOutput: void 0 };
          }
        }
        return null;
      }
      /**
       * Normalize an array of issues
       */
      normalizeIssueArray(values) {
        const normalized = [];
        for (const value of values) {
          const issue = this.normalizeIssue(value);
          if (!issue) {
            return null;
          }
          normalized.push(issue);
        }
        return normalized;
      }
      /**
       * Normalize a single issue
       */
      normalizeIssue(raw) {
        if (!raw || typeof raw !== "object") {
          return null;
        }
        const data = raw;
        const message = this.toTrimmedString(
          data.message || data.text || data.description || data.summary
        );
        if (!message) {
          return null;
        }
        const allowedSeverities = /* @__PURE__ */ new Set(["info", "warning", "error", "critical"]);
        const severityRaw = this.toTrimmedString(data.severity || data.level || data.priority);
        let severity = "warning";
        if (severityRaw) {
          const lower = severityRaw.toLowerCase();
          if (allowedSeverities.has(lower)) {
            severity = lower;
          }
        }
        const allowedCategories = /* @__PURE__ */ new Set([
          "security",
          "performance",
          "style",
          "logic",
          "documentation"
        ]);
        const categoryRaw = this.toTrimmedString(data.category || data.type || data.group);
        let category = "logic";
        if (categoryRaw && allowedCategories.has(categoryRaw.toLowerCase())) {
          category = categoryRaw.toLowerCase();
        }
        const file = this.toTrimmedString(data.file || data.path || data.filename) || "system";
        const line = this.toNumber(data.line || data.startLine || data.lineNumber) ?? 0;
        const endLine = this.toNumber(data.endLine || data.end_line || data.stopLine);
        const suggestion = this.toTrimmedString(data.suggestion);
        const replacement = this.toTrimmedString(data.replacement);
        const ruleId = this.toTrimmedString(data.ruleId || data.rule || data.id || data.check) || "mcp";
        return {
          file,
          line,
          endLine: endLine ?? void 0,
          ruleId,
          message,
          severity,
          category,
          suggestion: suggestion || void 0,
          replacement: replacement || void 0
        };
      }
      toTrimmedString(value) {
        if (typeof value === "string") {
          const trimmed = value.trim();
          return trimmed.length > 0 ? trimmed : null;
        }
        if (value !== null && value !== void 0 && typeof value.toString === "function") {
          const converted = String(value).trim();
          return converted.length > 0 ? converted : null;
        }
        return null;
      }
      toNumber(value) {
        if (value === null || value === void 0) {
          return null;
        }
        const num = Number(value);
        if (Number.isFinite(num)) {
          return Math.trunc(num);
        }
        return null;
      }
      getSupportedConfigKeys() {
        return [
          "type",
          "transport",
          "command",
          "command_args",
          "env",
          "workingDirectory",
          "url",
          "headers",
          "sessionId",
          "method",
          "methodArgs",
          "argsTransform",
          "transform",
          "transform_js",
          "timeout",
          "depends_on",
          "on",
          "if",
          "group"
        ];
      }
      async isAvailable() {
        return true;
      }
      getRequirements() {
        return ["MCP method name specified", "Transport configuration (stdio: command, sse/http: url)"];
      }
    };
  }
});

// src/utils/interactive-prompt.ts
import * as readline from "readline";
async function acquirePromptLock() {
  if (!activePrompt) {
    activePrompt = true;
    return;
  }
  await new Promise((resolve2) => waiters.push(resolve2));
  activePrompt = true;
}
function releasePromptLock() {
  activePrompt = false;
  const next = waiters.shift();
  if (next) next();
}
async function interactivePrompt(options) {
  await acquirePromptLock();
  return new Promise((resolve2, reject) => {
    const dbg = process.env.VISOR_DEBUG === "true";
    try {
      if (dbg) {
        const counts = {
          data: process.stdin.listenerCount("data"),
          end: process.stdin.listenerCount("end"),
          error: process.stdin.listenerCount("error"),
          readable: process.stdin.listenerCount("readable"),
          close: process.stdin.listenerCount("close")
        };
        console.error(
          `[human-input] starting prompt: isTTY=${!!process.stdin.isTTY} active=${activePrompt} waiters=${waiters.length} listeners=${JSON.stringify(counts)}`
        );
      }
    } catch {
    }
    try {
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(false);
      }
      process.stdin.resume();
    } catch {
    }
    try {
      process.stdin.setEncoding("utf8");
    } catch {
    }
    let rl;
    const allowEmpty = options.allowEmpty ?? false;
    const multiline = options.multiline ?? false;
    const defaultValue = options.defaultValue;
    let timeoutId;
    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      try {
        rl?.removeAllListeners();
      } catch {
      }
      try {
        rl?.close();
      } catch {
      }
      try {
        if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
          process.stdin.setRawMode(false);
        }
      } catch {
      }
      try {
        process.stdin.pause();
      } catch {
      }
      try {
        releasePromptLock();
      } catch {
      }
      try {
        if (process.stdout.__restoreWrites) {
          process.stdout.__restoreWrites();
        }
      } catch {
      }
      try {
        if (process.stderr.__restoreWrites) {
          process.stderr.__restoreWrites();
        }
      } catch {
      }
      try {
        if (dbg) {
          const counts = {
            data: process.stdin.listenerCount("data"),
            end: process.stdin.listenerCount("end"),
            error: process.stdin.listenerCount("error"),
            readable: process.stdin.listenerCount("readable"),
            close: process.stdin.listenerCount("close")
          };
          console.error(
            `[human-input] cleanup: isTTY=${!!process.stdin.isTTY} active=false waiters=${waiters.length} listeners=${JSON.stringify(counts)}`
          );
        }
      } catch {
      }
    };
    const finish = (value) => {
      cleanup();
      resolve2(value);
    };
    if (options.timeout && options.timeout > 0) {
      timeoutId = setTimeout(() => {
        cleanup();
        if (defaultValue !== void 0) return resolve2(defaultValue);
        return reject(new Error("Input timeout"));
      }, options.timeout);
    }
    const header = [];
    if (options.prompt && options.prompt.trim()) header.push(options.prompt.trim());
    if (multiline) header.push("(Ctrl+D to submit)");
    if (options.placeholder && !multiline) header.push(options.placeholder);
    const width = Math.max(
      20,
      Math.min(process.stdout && process.stdout.columns || 80, 100)
    );
    const dash = "-".repeat(width);
    try {
      console.log("\n" + dash);
      if (header.length) console.log(header.join("\n"));
      console.log(dash);
    } catch {
    }
    if (multiline) {
      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true
      });
      let buf = "";
      process.stdout.write("> ");
      rl.on("line", (line) => {
        buf += (buf ? "\n" : "") + line;
        process.stdout.write("> ");
      });
      rl.on("close", () => {
        const trimmed = buf.trim();
        if (!trimmed && !allowEmpty && defaultValue === void 0) {
          return reject(new Error("Empty input not allowed"));
        }
        return finish(trimmed || defaultValue || "");
      });
      rl.on("SIGINT", () => {
        try {
          process.stdout.write("\n");
        } catch {
        }
        cleanup();
        process.exit(130);
      });
    } else {
      const readLineRaw = async () => {
        return new Promise((resolveRaw) => {
          let buf = "";
          const onData = (chunk) => {
            const s = chunk.toString("utf8");
            for (let i = 0; i < s.length; i++) {
              const ch = s[i];
              const code = s.charCodeAt(i);
              if (ch === "\n" || ch === "\r") {
                try {
                  process.stdout.write("\n");
                } catch {
                }
                teardown();
                resolveRaw(buf);
                return;
              }
              if (ch === "\b" || code === 127) {
                if (buf.length > 0) {
                  buf = buf.slice(0, -1);
                  try {
                    process.stdout.write("\b \b");
                  } catch {
                  }
                }
                continue;
              }
              if (code === 3) {
                try {
                  process.stdout.write("\n");
                } catch {
                }
                teardown();
                process.exit(130);
              }
              if (code >= 32) {
                buf += ch;
                try {
                  process.stdout.write(ch);
                } catch {
                }
              }
            }
          };
          const teardown = () => {
            try {
              process.stdin.off("data", onData);
            } catch {
            }
            try {
              if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
                process.stdin.setRawMode(false);
              }
            } catch {
            }
          };
          try {
            if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
              process.stdin.setRawMode(true);
            }
          } catch {
          }
          process.stdin.on("data", onData);
          try {
            process.stdout.write("> ");
          } catch {
          }
        });
      };
      (async () => {
        const answer = await readLineRaw();
        const trimmed = (answer || "").trim();
        if (!trimmed && !allowEmpty && defaultValue === void 0) {
          cleanup();
          return reject(new Error("Empty input not allowed"));
        }
        return finish(trimmed || defaultValue || "");
      })().catch((err) => {
        cleanup();
        reject(err);
      });
    }
  });
}
async function simplePrompt(prompt) {
  return new Promise((resolve2) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.on("SIGINT", () => {
      try {
        process.stdout.write("\n");
      } catch {
      }
      rl.close();
      process.exit(130);
    });
    rl.question(`${prompt}
> `, (answer) => {
      rl.close();
      resolve2(answer.trim());
    });
  });
}
var activePrompt, waiters;
var init_interactive_prompt = __esm({
  "src/utils/interactive-prompt.ts"() {
    "use strict";
    activePrompt = false;
    waiters = [];
  }
});

// src/utils/stdin-reader.ts
function isStdinAvailable() {
  return !process.stdin.isTTY;
}
async function readStdin(timeout, maxSize = 1024 * 1024) {
  return new Promise((resolve2, reject) => {
    let data = "";
    let timeoutId;
    if (timeout) {
      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Stdin read timeout after ${timeout}ms`));
      }, timeout);
    }
    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onError);
      process.stdin.pause();
    };
    const onData = (chunk) => {
      data += chunk.toString();
      if (data.length > maxSize) {
        cleanup();
        reject(new Error(`Input exceeds maximum size of ${maxSize} bytes`));
      }
    };
    const onEnd = () => {
      cleanup();
      resolve2(data.trim());
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onError);
    process.stdin.resume();
  });
}
async function tryReadStdin(timeout, maxSize = 1024 * 1024) {
  if (!isStdinAvailable()) {
    return null;
  }
  try {
    return await readStdin(timeout, maxSize);
  } catch {
    return null;
  }
}
var init_stdin_reader = __esm({
  "src/utils/stdin-reader.ts"() {
    "use strict";
  }
});

// src/providers/human-input-check-provider.ts
import * as fs5 from "fs";
import * as path5 from "path";
var HumanInputCheckProvider;
var init_human_input_check_provider = __esm({
  "src/providers/human-input-check-provider.ts"() {
    "use strict";
    init_check_provider_interface();
    init_interactive_prompt();
    init_liquid_extensions();
    init_stdin_reader();
    HumanInputCheckProvider = class _HumanInputCheckProvider extends CheckProvider {
      liquid;
      /**
       * @deprecated Use ExecutionContext.cliMessage instead
       * Kept for backward compatibility
       */
      static cliMessage;
      /**
       * @deprecated Use ExecutionContext.hooks instead
       * Kept for backward compatibility
       */
      static hooks = {};
      /**
       * Set the CLI message value (from --message argument)
       * @deprecated Use ExecutionContext.cliMessage instead
       */
      static setCLIMessage(message) {
        _HumanInputCheckProvider.cliMessage = message;
      }
      /**
       * Get the current CLI message value
       * @deprecated Use ExecutionContext.cliMessage instead
       */
      static getCLIMessage() {
        return _HumanInputCheckProvider.cliMessage;
      }
      /**
       * Set hooks for SDK mode
       * @deprecated Use ExecutionContext.hooks instead
       */
      static setHooks(hooks) {
        _HumanInputCheckProvider.hooks = hooks;
      }
      getName() {
        return "human-input";
      }
      getDescription() {
        return "Prompts for human input during workflow execution (CLI interactive or SDK hook)";
      }
      async validateConfig(config) {
        if (!config || typeof config !== "object") {
          return false;
        }
        const cfg = config;
        if (cfg.type !== "human-input") {
          return false;
        }
        if (!cfg.prompt || typeof cfg.prompt !== "string") {
          console.error('human-input check requires a "prompt" field');
          return false;
        }
        return true;
      }
      /** Build a template context for Liquid rendering */
      buildTemplateContext(prInfo, dependencyResults, outputHistory, _context) {
        const ctx = {};
        try {
          ctx.pr = {
            number: prInfo.number,
            title: prInfo.title,
            body: prInfo.body,
            author: prInfo.author,
            base: prInfo.base,
            head: prInfo.head,
            files: (prInfo.files || []).map((f) => ({
              filename: f.filename,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
              changes: f.changes
            }))
          };
        } catch {
        }
        try {
          const safeEnv = (() => {
            try {
              const { buildSandboxEnv: buildSandboxEnv2 } = (init_env_exposure(), __toCommonJS(env_exposure_exports));
              return buildSandboxEnv2(process.env);
            } catch {
              return {};
            }
          })();
          ctx.event = { event_name: prInfo?.eventType || "manual" };
          ctx.env = safeEnv;
        } catch {
        }
        ctx.utils = {
          now: (/* @__PURE__ */ new Date()).toISOString(),
          today: (/* @__PURE__ */ new Date()).toISOString().split("T")[0]
        };
        const outputs = {};
        const outputsRaw = {};
        if (dependencyResults) {
          for (const [name, res] of dependencyResults.entries()) {
            const summary = res;
            if (typeof name === "string" && name.endsWith("-raw")) {
              outputsRaw[name.slice(0, -4)] = summary.output !== void 0 ? summary.output : summary;
            } else {
              outputs[name] = summary.output !== void 0 ? summary.output : summary;
            }
          }
        }
        ctx.outputs = outputs;
        ctx.outputs_raw = outputsRaw;
        const hist = {};
        if (outputHistory) {
          for (const [k, v] of outputHistory.entries()) hist[k] = Array.isArray(v) ? v : [];
        }
        ctx.outputs_history = hist;
        return ctx;
      }
      /**
       * Check if a string looks like a file path
       */
      looksLikePath(str) {
        return str.includes("/") || str.includes("\\");
      }
      /**
       * Sanitize user input to prevent injection attacks in dependent checks
       * Removes potentially dangerous characters while preserving useful input
       */
      sanitizeInput(input) {
        const collapseStutter = (s) => {
          if (!s || s.length < 4) return s;
          let dupPairs = 0;
          let pairs = 0;
          for (let i = 0; i + 1 < s.length; i++) {
            const a = s[i];
            const b = s[i + 1];
            if (/^[\x20-\x7E]$/.test(a) && /^[\x20-\x7E]$/.test(b)) {
              pairs++;
              if (a === b) dupPairs++;
            }
          }
          const ratio = pairs > 0 ? dupPairs / pairs : 0;
          if (ratio < 0.5) return s;
          let out = "";
          for (let i = 0; i < s.length; i++) {
            const a = s[i];
            const b = i + 1 < s.length ? s[i + 1] : "";
            if (b && a === b) {
              out += a;
              i++;
            } else {
              out += a;
            }
          }
          return out;
        };
        input = collapseStutter(input);
        let sanitized = input.replace(/\0/g, "");
        sanitized = sanitized.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "");
        const maxLength = 100 * 1024;
        if (sanitized.length > maxLength) {
          sanitized = sanitized.substring(0, maxLength);
        }
        return sanitized;
      }
      /**
       * Try to read message from file if it exists
       * Validates path to prevent directory traversal attacks
       */
      async tryReadFile(filePath) {
        try {
          const absolutePath = path5.isAbsolute(filePath) ? filePath : path5.resolve(process.cwd(), filePath);
          const normalizedPath = path5.normalize(absolutePath);
          const cwd = process.cwd();
          if (!normalizedPath.startsWith(cwd + path5.sep) && normalizedPath !== cwd) {
            return null;
          }
          try {
            await fs5.promises.access(normalizedPath, fs5.constants.R_OK);
            const stats = await fs5.promises.stat(normalizedPath);
            if (!stats.isFile()) {
              return null;
            }
            const content = await fs5.promises.readFile(normalizedPath, "utf-8");
            return content.trim();
          } catch {
            return null;
          }
        } catch {
        }
        return null;
      }
      /**
       * Get user input through various methods
       */
      async getUserInput(checkName, config, context2) {
        try {
          const mockVal = context2?.hooks?.mockForStep?.(checkName);
          if (mockVal !== void 0 && mockVal !== null) {
            const s = String(mockVal);
            return s;
          }
        } catch {
        }
        const prompt = config.prompt || "Please provide input:";
        const placeholder = config.placeholder || "Enter your response...";
        const allowEmpty = config.allow_empty ?? false;
        const multiline = config.multiline ?? false;
        const timeout = config.timeout ? config.timeout * 1e3 : void 0;
        const defaultValue = config.default;
        const testMode = String(process.env.VISOR_TEST_MODE || "").toLowerCase() === "true";
        const ciMode = String(process.env.CI || "").toLowerCase() === "true" || String(process.env.GITHUB_ACTIONS || "").toLowerCase() === "true";
        if (testMode || ciMode) {
          const val = config.default || "";
          return val;
        }
        const cliMessage = context2?.cliMessage ?? _HumanInputCheckProvider.cliMessage;
        if (cliMessage !== void 0) {
          const message = cliMessage;
          if (this.looksLikePath(message)) {
            const fileContent = await this.tryReadFile(message);
            if (fileContent !== null) {
              return fileContent;
            }
          }
          return message;
        }
        const stdinInput = await tryReadStdin(timeout);
        if (stdinInput !== null && stdinInput.length > 0) {
          return stdinInput;
        }
        const hooks = context2?.hooks ?? _HumanInputCheckProvider.hooks;
        if (hooks?.onHumanInput) {
          const request = {
            checkId: checkName,
            prompt,
            placeholder,
            allowEmpty,
            multiline,
            timeout,
            default: defaultValue
          };
          try {
            const result = await hooks.onHumanInput(request);
            return result;
          } catch (error) {
            throw new Error(
              `Hook onHumanInput failed: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        if (process.stdin.isTTY) {
          try {
            const result = await interactivePrompt({
              prompt,
              placeholder,
              multiline,
              timeout,
              defaultValue,
              allowEmpty
            });
            return result;
          } catch (error) {
            throw new Error(
              `Interactive prompt failed: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        try {
          const result = await simplePrompt(prompt);
          if (!result && !allowEmpty && !defaultValue) {
            throw new Error("Empty input not allowed");
          }
          return result || defaultValue || "";
        } catch (error) {
          throw new Error(
            `Simple prompt failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      async execute(_prInfo, config, _dependencyResults, context2) {
        const checkName = config.checkName || "human-input";
        try {
          try {
            this.liquid = this.liquid || createExtendedLiquid({ strictVariables: false, strictFilters: false });
            const tctx = this.buildTemplateContext(
              _prInfo,
              _dependencyResults,
              config.__outputHistory,
              context2
            );
            if (typeof config.prompt === "string") {
              let rendered = await this.liquid.parseAndRender(config.prompt, tctx);
              if (/\{\{|\{%/.test(rendered)) {
                try {
                  rendered = await this.liquid.parseAndRender(rendered, tctx);
                } catch {
                }
              }
              try {
                const stepName = config.checkName || "unknown";
                context2?.hooks?.onPromptCaptured?.({
                  step: String(stepName),
                  provider: "human-input",
                  prompt: rendered
                });
              } catch {
              }
              config = { ...config, prompt: rendered };
            }
            if (typeof config.placeholder === "string") {
              let ph = await this.liquid.parseAndRender(config.placeholder, tctx);
              if (/\{\{|\{%/.test(ph)) {
                try {
                  ph = await this.liquid.parseAndRender(ph, tctx);
                } catch {
                }
              }
              config.placeholder = ph;
            }
          } catch (e) {
            const err = e || {};
            const raw = String(config?.prompt || "");
            const lines = raw.split(/\r?\n/);
            const lineNum = Number(err.line || err?.token?.line || err?.location?.line || 0);
            const colNum = Number(err.col || err?.token?.col || err?.location?.col || 0);
            let snippet = "";
            if (lineNum > 0) {
              const start = Math.max(1, lineNum - 3);
              const end = Math.max(lineNum + 2, lineNum);
              const width = String(end).length;
              for (let i = start; i <= Math.min(end, lines.length); i++) {
                const ln = `${String(i).padStart(width, " ")} | ${lines[i - 1] ?? ""}`;
                snippet += ln + "\n";
                if (i === lineNum) {
                  const caretPad = " ".repeat(Math.max(0, colNum > 1 ? colNum - 1 : 0) + width + 3);
                  snippet += caretPad + "^\n";
                }
              }
            }
            try {
              console.error(
                `\u26A0\uFE0F  human-input: Liquid render failed: ${e instanceof Error ? e.message : String(e)}
${snippet}`
              );
            } catch {
            }
          }
          const userInput = await this.getUserInput(checkName, config, context2);
          const sanitizedInput = this.sanitizeInput(userInput);
          return {
            issues: [],
            output: { text: sanitizedInput, ts: Date.now() }
          };
        } catch (error) {
          return {
            issues: [
              {
                file: "",
                line: 0,
                ruleId: "human-input-error",
                message: `Failed to get user input: ${error instanceof Error ? error.message : String(error)}`,
                severity: "error",
                category: "logic"
              }
            ]
          };
        }
      }
      getSupportedConfigKeys() {
        return [
          "type",
          "prompt",
          "placeholder",
          "allow_empty",
          "multiline",
          "timeout",
          "default",
          "depends_on",
          "on",
          "if",
          "group"
        ];
      }
      async isAvailable() {
        return true;
      }
      getRequirements() {
        return [
          "No external dependencies required",
          "Works in CLI mode with --message argument, piped stdin, or interactive prompts",
          "SDK mode requires onHumanInput hook to be configured"
        ];
      }
    };
  }
});

// src/providers/script-check-provider.ts
var ScriptCheckProvider;
var init_script_check_provider = __esm({
  "src/providers/script-check-provider.ts"() {
    "use strict";
    init_check_provider_interface();
    init_liquid_extensions();
    init_logger();
    init_memory_store();
    init_sandbox();
    init_template_context();
    init_script_memory_ops();
    ScriptCheckProvider = class extends CheckProvider {
      liquid;
      constructor() {
        super();
        this.liquid = createExtendedLiquid({
          strictVariables: false,
          strictFilters: false
        });
      }
      createSecureSandbox() {
        return createSecureSandbox();
      }
      getName() {
        return "script";
      }
      getDescription() {
        return "Execute JavaScript with access to PR context, dependency outputs, and memory.";
      }
      async validateConfig(config) {
        if (!config || typeof config !== "object") return false;
        const cfg = config;
        if (typeof cfg.content !== "string") return false;
        const trimmed = cfg.content.trim();
        if (trimmed.length === 0) return false;
        try {
          const bytes = Buffer.byteLength(cfg.content, "utf8");
          if (bytes > 1024 * 1024) return false;
        } catch {
        }
        if (cfg.content.indexOf("\0") >= 0) return false;
        return true;
      }
      async execute(prInfo, config, dependencyResults, _sessionInfo) {
        const script = String(config.content || "");
        const memoryStore = MemoryStore.getInstance();
        const ctx = buildProviderTemplateContext(
          prInfo,
          dependencyResults,
          memoryStore,
          config.__outputHistory,
          _sessionInfo?.stageHistoryBase,
          { attachMemoryReadHelpers: false }
        );
        try {
          if (process.env.VISOR_DEBUG === "true") {
            const hist = ctx.outputs_history || {};
            const len = Array.isArray(hist["refine"]) ? hist["refine"].length : 0;
            console.error(`[script] history.refine.len=${len}`);
          }
        } catch {
        }
        const { ops, needsSave } = createSyncMemoryOps(memoryStore);
        ctx.memory = ops;
        const sandbox = this.createSecureSandbox();
        let result;
        try {
          result = compileAndRun(
            sandbox,
            script,
            { ...ctx },
            {
              injectLog: true,
              wrapFunction: true,
              logPrefix: "[script]"
            }
          );
        } catch (error) {
          const msg = error instanceof Error ? error.message : "Unknown error";
          logger.error(`[script] execution error: ${msg}`);
          return {
            issues: [
              {
                file: "script",
                line: 0,
                ruleId: "script/execution_error",
                message: msg,
                severity: "error",
                category: "logic"
              }
            ],
            output: null
          };
        }
        try {
          if (needsSave() && memoryStore.getConfig().storage === "file" && memoryStore.getConfig().auto_save) {
            await memoryStore.save();
          }
        } catch (e) {
          logger.warn(`[script] memory save failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        try {
          if (process.env.VISOR_DEBUG === "true") {
            const name = String(config.checkName || "");
            const t = typeof result;
            console.error(
              `[script-return] ${name} outputType=${t} hasArray=${Array.isArray(result)} hasObj=${result && typeof result === "object"}`
            );
          }
        } catch {
        }
        const out = { issues: [], output: result };
        try {
          out.__histTracked = true;
        } catch {
        }
        return out;
      }
      getSupportedConfigKeys() {
        return [
          "type",
          "content",
          "depends_on",
          "group",
          "on",
          "if",
          "fail_if",
          "on_fail",
          "on_success"
        ];
      }
      async isAvailable() {
        return true;
      }
      getRequirements() {
        return ["No external dependencies required"];
      }
      // No local buildTemplateContext; uses shared builder above
    };
  }
});

// src/workflow-executor.ts
import { Liquid } from "liquidjs";
var WorkflowExecutor;
var init_workflow_executor = __esm({
  "src/workflow-executor.ts"() {
    "use strict";
    init_check_provider_registry();
    init_dependency_resolver();
    init_logger();
    init_sandbox();
    WorkflowExecutor = class {
      providerRegistry = null;
      liquid;
      constructor() {
        this.liquid = new Liquid();
      }
      /**
       * Lazy-load the provider registry to avoid circular dependency during initialization
       */
      getProviderRegistry() {
        if (!this.providerRegistry) {
          this.providerRegistry = CheckProviderRegistry.getInstance();
        }
        return this.providerRegistry;
      }
      /**
       * Execute a workflow
       */
      async execute(workflow, executionContext, runOptions) {
        const startTime = Date.now();
        executionContext.metadata = {
          startTime,
          status: "running"
        };
        try {
          const executionOrder = this.resolveExecutionOrder(workflow);
          logger.debug(`Workflow ${workflow.id} execution order: ${executionOrder.join(" -> ")}`);
          const stepResults = /* @__PURE__ */ new Map();
          const stepSummaries = [];
          for (const stepId of executionOrder) {
            const step = workflow.steps[stepId];
            if (step.if) {
              const shouldRun = this.evaluateCondition(step.if, {
                inputs: executionContext.inputs,
                outputs: Object.fromEntries(stepResults),
                pr: runOptions.prInfo
              });
              if (!shouldRun) {
                logger.info(`Skipping step '${stepId}' due to condition: ${step.if}`);
                stepSummaries.push({
                  stepId,
                  status: "skipped"
                });
                continue;
              }
            }
            const stepConfig = await this.prepareStepConfig(
              step,
              stepId,
              executionContext,
              stepResults,
              workflow
            );
            try {
              logger.info(`Executing workflow step '${stepId}'`);
              const stepContext = {
                ...runOptions.context,
                workflowInputs: executionContext.inputs
              };
              const result = await this.executeStep(
                stepConfig,
                runOptions.prInfo,
                stepResults,
                stepContext
              );
              stepResults.set(stepId, result);
              stepSummaries.push({
                stepId,
                status: "success",
                issues: result.issues,
                output: result.output
              });
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              logger.error(`Step '${stepId}' failed: ${errorMessage}`);
              stepSummaries.push({
                stepId,
                status: "failed",
                output: { error: errorMessage }
              });
              if (!runOptions.options?.continueOnError) {
                throw new Error(`Workflow step '${stepId}' failed: ${errorMessage}`);
              }
            }
          }
          const outputs = await this.computeOutputs(
            workflow,
            executionContext,
            stepResults,
            runOptions.prInfo
          );
          executionContext.outputs = outputs;
          const aggregated = this.aggregateResults(stepResults);
          const endTime = Date.now();
          executionContext.metadata.endTime = endTime;
          executionContext.metadata.duration = endTime - startTime;
          executionContext.metadata.status = "completed";
          return {
            success: true,
            score: aggregated.score,
            confidence: aggregated.confidence,
            issues: aggregated.issues,
            comments: aggregated.comments,
            output: outputs,
            status: "completed",
            duration: endTime - startTime,
            stepSummaries
          };
        } catch (error) {
          const endTime = Date.now();
          executionContext.metadata.endTime = endTime;
          executionContext.metadata.duration = endTime - startTime;
          executionContext.metadata.status = "failed";
          executionContext.metadata.error = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            status: "failed",
            duration: endTime - startTime,
            error: error instanceof Error ? error.message : String(error)
          };
        }
      }
      /**
       * Resolve step execution order based on dependencies
       */
      resolveExecutionOrder(workflow) {
        const dependencies = {};
        for (const [stepId, step] of Object.entries(workflow.steps)) {
          dependencies[stepId] = step.depends_on || [];
        }
        const graph = DependencyResolver.buildDependencyGraph(dependencies);
        if (graph.hasCycles) {
          throw new Error(
            `Circular dependency detected in workflow steps: ${graph.cycleNodes?.join(" -> ")}`
          );
        }
        const order = [];
        for (const group of graph.executionOrder) {
          order.push(...group.parallel);
        }
        return order;
      }
      /**
       * Prepare step configuration with input mappings
       */
      async prepareStepConfig(step, stepId, executionContext, stepResults, workflow) {
        const config = {
          ...step,
          type: step.type || "ai",
          checkName: `${executionContext.instanceId}:${stepId}`
        };
        if (step.inputs) {
          for (const [inputName, mapping] of Object.entries(step.inputs)) {
            const value = await this.resolveInputMapping(
              mapping,
              executionContext,
              stepResults,
              workflow
            );
            config[inputName] = value;
          }
        }
        return config;
      }
      /**
       * Resolve input mapping to actual value
       */
      async resolveInputMapping(mapping, executionContext, stepResults, _workflow) {
        if (typeof mapping === "string") {
          return executionContext.inputs[mapping];
        }
        if (typeof mapping === "object" && mapping !== null && "source" in mapping) {
          const typedMapping = mapping;
          switch (typedMapping.source) {
            case "param":
              return executionContext.inputs[String(typedMapping.value)];
            case "step":
              if (!typedMapping.stepId) {
                throw new Error("Step input mapping requires stepId");
              }
              const stepResult = stepResults.get(typedMapping.stepId);
              if (!stepResult) {
                throw new Error(`Step '${typedMapping.stepId}' has not been executed yet`);
              }
              const output = stepResult.output;
              if (typedMapping.outputParam && output) {
                return output[typedMapping.outputParam];
              }
              return output;
            case "constant":
              return typedMapping.value;
            case "expression":
              if (!typedMapping.expression) {
                throw new Error("Expression mapping requires expression field");
              }
              const sandbox = createSecureSandbox();
              return compileAndRun(
                sandbox,
                typedMapping.expression,
                {
                  inputs: executionContext.inputs,
                  outputs: Object.fromEntries(stepResults),
                  steps: Object.fromEntries(
                    Array.from(stepResults.entries()).map(([id, result]) => [
                      id,
                      result.output
                    ])
                  )
                },
                { injectLog: true, logPrefix: "workflow.input.expression" }
              );
            default:
              throw new Error(`Unknown input mapping source: ${typedMapping.source}`);
          }
        }
        if (typeof mapping === "object" && mapping !== null && "template" in mapping) {
          const typedMapping = mapping;
          if (typedMapping.template) {
            return await this.liquid.parseAndRender(typedMapping.template, {
              inputs: executionContext.inputs,
              outputs: Object.fromEntries(stepResults)
            });
          }
        }
        return mapping;
      }
      /**
       * Execute a single step
       */
      async executeStep(config, prInfo, dependencyResults, context2) {
        const provider = await this.getProviderRegistry().getProvider(config.type);
        if (!provider) {
          throw new Error(`Provider '${config.type}' not found`);
        }
        return await provider.execute(prInfo, config, dependencyResults, context2);
      }
      /**
       * Compute workflow outputs
       */
      async computeOutputs(workflow, executionContext, stepResults, prInfo) {
        const outputs = {};
        if (!workflow.outputs) {
          return outputs;
        }
        for (const output of workflow.outputs) {
          if (output.value_js) {
            const sandbox = createSecureSandbox();
            outputs[output.name] = compileAndRun(
              sandbox,
              output.value_js,
              {
                inputs: executionContext.inputs,
                steps: Object.fromEntries(
                  Array.from(stepResults.entries()).map(([id, result]) => [id, result.output])
                ),
                outputs: Object.fromEntries(stepResults),
                pr: prInfo
              },
              { injectLog: true, logPrefix: `workflow.output.${output.name}` }
            );
          } else if (output.value) {
            outputs[output.name] = await this.liquid.parseAndRender(output.value, {
              inputs: executionContext.inputs,
              steps: Object.fromEntries(
                Array.from(stepResults.entries()).map(([id, result]) => [id, result.output])
              ),
              outputs: Object.fromEntries(stepResults),
              pr: prInfo
            });
          }
        }
        return outputs;
      }
      /**
       * Aggregate results from all steps
       */
      aggregateResults(stepResults) {
        let totalScore = 0;
        let scoreCount = 0;
        const allIssues = [];
        const allComments = [];
        let minConfidence = "high";
        for (const result of stepResults.values()) {
          const extResult = result;
          if (typeof extResult.score === "number") {
            totalScore += extResult.score;
            scoreCount++;
          }
          if (result.issues) {
            allIssues.push(...result.issues);
          }
          if (extResult.comments) {
            allComments.push(...extResult.comments);
          }
          if (extResult.confidence) {
            if (extResult.confidence === "low" || extResult.confidence === "medium" && minConfidence === "high") {
              minConfidence = extResult.confidence;
            }
          }
        }
        return {
          score: scoreCount > 0 ? Math.round(totalScore / scoreCount) : 0,
          confidence: minConfidence,
          issues: allIssues,
          comments: allComments
        };
      }
      /**
       * Evaluate a condition expression
       */
      evaluateCondition(condition, context2) {
        try {
          const sandbox = createSecureSandbox();
          const result = compileAndRun(sandbox, condition, context2, {
            injectLog: true,
            logPrefix: "workflow.condition"
          });
          return Boolean(result);
        } catch (error) {
          logger.warn(`Failed to evaluate condition '${condition}': ${error}`);
          return false;
        }
      }
    };
  }
});

// src/state-machine/workflow-projection.ts
var workflow_projection_exports = {};
__export(workflow_projection_exports, {
  buildWorkflowScope: () => buildWorkflowScope,
  extractParentScope: () => extractParentScope,
  getWorkflowIdFromScope: () => getWorkflowIdFromScope,
  isWorkflowStep: () => isWorkflowStep,
  projectWorkflowToGraph: () => projectWorkflowToGraph,
  validateWorkflowDepth: () => validateWorkflowDepth
});
function projectWorkflowToGraph(workflow, workflowInputs, parentCheckId) {
  if (!workflow.steps || Object.keys(workflow.steps).length === 0) {
    throw new Error(`Workflow '${workflow.id}' has no steps`);
  }
  const checks = {};
  const checksMetadata = {};
  for (const [stepId, step] of Object.entries(workflow.steps)) {
    const scopedCheckId = `${parentCheckId}:${stepId}`;
    checks[scopedCheckId] = {
      type: step.type || "ai",
      ...step,
      // Store workflow inputs in the check config so they're accessible
      workflowInputs,
      // Mark this as a workflow step
      _workflowStep: true,
      _workflowId: workflow.id,
      _stepId: stepId
    };
    checksMetadata[scopedCheckId] = {
      tags: step.tags || workflow.tags || [],
      triggers: step.on || workflow.on || [],
      group: step.group,
      providerType: step.type || "ai",
      dependencies: (step.depends_on || []).map((dep) => `${parentCheckId}:${dep}`)
    };
  }
  const config = {
    checks,
    version: "1.0",
    output: {
      pr_comment: {
        format: "table",
        group_by: "check",
        collapse: false
      }
    }
  };
  if (logger.isDebugEnabled?.()) {
    logger.debug(
      `[WorkflowProjection] Projected workflow '${workflow.id}' with ${Object.keys(checks).length} steps`
    );
  }
  return { config, checks: checksMetadata };
}
function validateWorkflowDepth(currentDepth, maxDepth, workflowId) {
  if (currentDepth >= maxDepth) {
    throw new Error(
      `Workflow nesting depth limit exceeded (${maxDepth}) for workflow '${workflowId}'. This may indicate a circular workflow reference or excessive nesting.`
    );
  }
}
function buildWorkflowScope(parentScope, workflowCheckId, stepId, foreachIndex) {
  const scope = parentScope ? [...parentScope] : [];
  scope.push({
    check: `${workflowCheckId}:${stepId}`,
    index: foreachIndex ?? 0
  });
  return scope;
}
function extractParentScope(scopedCheckId) {
  const lastColonIndex = scopedCheckId.lastIndexOf(":");
  if (lastColonIndex === -1) {
    return null;
  }
  return {
    parentCheckId: scopedCheckId.substring(0, lastColonIndex),
    stepId: scopedCheckId.substring(lastColonIndex + 1)
  };
}
function isWorkflowStep(checkId) {
  return checkId.includes(":");
}
function getWorkflowIdFromScope(scopedCheckId) {
  const parts = scopedCheckId.split(":");
  if (parts.length >= 2) {
    return parts[0];
  }
  return null;
}
var init_workflow_projection = __esm({
  "src/state-machine/workflow-projection.ts"() {
    "use strict";
    init_logger();
  }
});

// src/providers/workflow-check-provider.ts
import { Liquid as Liquid2 } from "liquidjs";
var WorkflowCheckProvider;
var init_workflow_check_provider = __esm({
  "src/providers/workflow-check-provider.ts"() {
    "use strict";
    init_check_provider_interface();
    init_workflow_registry();
    init_workflow_executor();
    init_logger();
    init_sandbox();
    WorkflowCheckProvider = class extends CheckProvider {
      registry;
      executor;
      liquid;
      constructor() {
        super();
        this.registry = WorkflowRegistry.getInstance();
        this.executor = new WorkflowExecutor();
        this.liquid = new Liquid2();
      }
      getName() {
        return "workflow";
      }
      getDescription() {
        return "Executes reusable workflow definitions as checks";
      }
      async validateConfig(config) {
        const cfg = config;
        if (!cfg.workflow) {
          logger.error('Workflow provider requires "workflow" field');
          return false;
        }
        if (!this.registry.has(cfg.workflow)) {
          logger.error(`Workflow '${cfg.workflow}' not found in registry`);
          return false;
        }
        return true;
      }
      async execute(prInfo, config, dependencyResults, context2) {
        const workflowId = config.workflow;
        const workflow = this.registry.get(workflowId);
        if (!workflow) {
          throw new Error(`Workflow '${workflowId}' not found in registry`);
        }
        logger.info(`Executing workflow '${workflowId}'`);
        const inputs = await this.prepareInputs(workflow, config, prInfo, dependencyResults);
        const validation = this.registry.validateInputs(workflow, inputs);
        if (!validation.valid) {
          const errors = validation.errors?.map((e) => `${e.path}: ${e.message}`).join(", ");
          throw new Error(`Invalid workflow inputs: ${errors}`);
        }
        const modifiedWorkflow = this.applyOverrides(workflow, config);
        const engineMode = context2?._engineMode;
        if (engineMode === "state-machine") {
          logger.info(`[WorkflowProvider] Delegating workflow '${workflowId}' to state machine engine`);
          return await this.executeViaStateMachine(
            modifiedWorkflow,
            inputs,
            config,
            prInfo,
            dependencyResults,
            context2
          );
        }
        const executionContext = {
          instanceId: `${workflowId}-${Date.now()}`,
          parentCheckId: config.checkName,
          inputs,
          stepResults: /* @__PURE__ */ new Map()
        };
        const result = await this.executor.execute(modifiedWorkflow, executionContext, {
          prInfo,
          dependencyResults,
          context: context2
        });
        const outputs = this.mapOutputs(result, config.output_mapping);
        const summary = {
          issues: result.issues || []
        };
        summary.score = result.score || 0;
        summary.confidence = result.confidence || "medium";
        summary.comments = result.comments || [];
        summary.output = outputs;
        summary.content = this.formatWorkflowResult(workflow, result, outputs);
        return summary;
      }
      getSupportedConfigKeys() {
        return ["workflow", "args", "overrides", "output_mapping", "timeout", "env", "checkName"];
      }
      async isAvailable() {
        return true;
      }
      getRequirements() {
        return [];
      }
      /**
       * Prepare inputs for workflow execution
       */
      async prepareInputs(workflow, config, prInfo, dependencyResults) {
        const inputs = {};
        if (workflow.inputs) {
          for (const param of workflow.inputs) {
            if (param.default !== void 0) {
              inputs[param.name] = param.default;
            }
          }
        }
        const userInputs = config.args || config.workflow_inputs;
        if (userInputs) {
          for (const [key, value] of Object.entries(userInputs)) {
            if (typeof value === "string") {
              if (value.includes("{{") || value.includes("{%")) {
                inputs[key] = await this.liquid.parseAndRender(value, {
                  pr: prInfo,
                  outputs: dependencyResults ? Object.fromEntries(dependencyResults) : {},
                  env: process.env
                });
              } else {
                inputs[key] = value;
              }
            } else if (typeof value === "object" && value !== null && "expression" in value) {
              const exprValue = value;
              const sandbox = createSecureSandbox();
              inputs[key] = compileAndRun(
                sandbox,
                exprValue.expression,
                {
                  pr: prInfo,
                  outputs: dependencyResults ? Object.fromEntries(dependencyResults) : {},
                  env: process.env
                },
                { injectLog: true, logPrefix: `workflow.input.${key}` }
              );
            } else {
              inputs[key] = value;
            }
          }
        }
        return inputs;
      }
      /**
       * Apply overrides to workflow steps
       */
      applyOverrides(workflow, config) {
        const overrideConfig = config.overrides || config.workflow_overrides;
        if (!overrideConfig) {
          return workflow;
        }
        const modified = JSON.parse(JSON.stringify(workflow));
        for (const [stepId, overrides] of Object.entries(overrideConfig)) {
          if (modified.steps[stepId]) {
            modified.steps[stepId] = {
              ...modified.steps[stepId],
              ...overrides
            };
          } else {
            logger.warn(`Cannot override non-existent step '${stepId}' in workflow '${workflow.id}'`);
          }
        }
        return modified;
      }
      /**
       * Map workflow outputs to check outputs
       */
      mapOutputs(result, outputMapping) {
        if (!outputMapping) {
          return result.output || {};
        }
        const mapped = {};
        const workflowOutputs = result.output || {};
        for (const [checkOutput, workflowOutput] of Object.entries(outputMapping)) {
          if (workflowOutput in workflowOutputs) {
            mapped[checkOutput] = workflowOutputs[workflowOutput];
          } else if (workflowOutput.includes(".")) {
            const parts = workflowOutput.split(".");
            let value = workflowOutputs;
            for (const part of parts) {
              value = value?.[part];
              if (value === void 0) break;
            }
            mapped[checkOutput] = value;
          }
        }
        return mapped;
      }
      /**
       * Format workflow execution result for display
       */
      /**
       * Execute workflow via state machine engine (M3: nested workflows)
       */
      async executeViaStateMachine(workflow, inputs, config, prInfo, dependencyResults, context2) {
        const {
          projectWorkflowToGraph: projectWorkflowToGraph2,
          validateWorkflowDepth: validateWorkflowDepth2
        } = (init_workflow_projection(), __toCommonJS(workflow_projection_exports));
        const { StateMachineRunner: StateMachineRunner2 } = (init_runner(), __toCommonJS(runner_exports));
        const { ExecutionJournal: ExecutionJournal2 } = (init_snapshot_store(), __toCommonJS(snapshot_store_exports));
        const { MemoryStore: MemoryStore2 } = (init_memory_store(), __toCommonJS(memory_store_exports));
        const { v4: uuidv42 } = __require("uuid");
        const parentContext = context2?._parentContext;
        const parentState = context2?._parentState;
        const currentDepth = parentState?.flags?.currentWorkflowDepth || 0;
        const maxDepth = parentState?.flags?.maxWorkflowDepth ?? parentContext?.config?.limits?.max_workflow_depth ?? 3;
        validateWorkflowDepth2(currentDepth, maxDepth, workflow.id);
        const { config: workflowConfig, checks: checksMetadata } = projectWorkflowToGraph2(
          workflow,
          inputs,
          config.checkName || workflow.id
        );
        const childContext = {
          mode: "state-machine",
          config: workflowConfig,
          checks: checksMetadata,
          journal: parentContext?.journal || new ExecutionJournal2(),
          memory: parentContext?.memory || MemoryStore2.getInstance(),
          workingDirectory: parentContext?.workingDirectory || process.cwd(),
          sessionId: parentContext?.sessionId || uuidv42(),
          event: parentContext?.event || prInfo.eventType,
          debug: parentContext?.debug || false,
          maxParallelism: parentContext?.maxParallelism,
          failFast: parentContext?.failFast
        };
        const runner = new StateMachineRunner2(childContext);
        const childState = runner.getState();
        childState.flags.currentWorkflowDepth = currentDepth + 1;
        childState.flags.maxWorkflowDepth = maxDepth;
        childState.parentContext = parentContext;
        childState.parentScope = parentState?.parentScope;
        logger.info(
          `[WorkflowProvider] Executing nested workflow '${workflow.id}' at depth ${currentDepth + 1}`
        );
        const result = await runner.run();
        const bubbledEvents = childContext._bubbledEvents || [];
        if (bubbledEvents.length > 0 && parentContext) {
          if (parentContext.debug) {
            logger.info(`[WorkflowProvider] Bubbling ${bubbledEvents.length} events to parent context`);
          }
          if (!parentContext._bubbledEvents) {
            parentContext._bubbledEvents = [];
          }
          parentContext._bubbledEvents.push(...bubbledEvents);
        }
        const allIssues = [];
        let totalScore = 0;
        let scoreCount = 0;
        for (const stepResult of Object.values(result.results)) {
          const typedResult = stepResult;
          if (typedResult.issues) {
            allIssues.push(...typedResult.issues);
          }
          if (typedResult.score) {
            totalScore += typedResult.score;
            scoreCount++;
          }
        }
        const outputs = await this.computeWorkflowOutputsFromState(
          workflow,
          inputs,
          result.results,
          prInfo
        );
        const mappedOutputs = this.mapOutputs(
          { output: outputs },
          config.output_mapping
        );
        const summary = {
          issues: allIssues
        };
        summary.score = scoreCount > 0 ? Math.round(totalScore / scoreCount) : 0;
        summary.confidence = "medium";
        summary.output = mappedOutputs;
        summary.content = this.formatWorkflowResultFromStateMachine(
          workflow,
          result,
          mappedOutputs
        );
        return summary;
      }
      /**
       * Compute workflow outputs from state machine execution results
       */
      async computeWorkflowOutputsFromState(workflow, inputs, stepResults, prInfo) {
        const outputs = {};
        if (!workflow.outputs) {
          return outputs;
        }
        const sandbox = createSecureSandbox();
        for (const output of workflow.outputs) {
          if (output.value_js) {
            outputs[output.name] = compileAndRun(
              sandbox,
              output.value_js,
              {
                inputs,
                steps: Object.fromEntries(
                  Object.entries(stepResults).map(([id, result]) => [
                    id.split(":").pop() || id,
                    result.output
                  ])
                ),
                outputs: stepResults,
                pr: prInfo
              },
              { injectLog: true, logPrefix: `workflow.output.${output.name}` }
            );
          } else if (output.value) {
            outputs[output.name] = await this.liquid.parseAndRender(output.value, {
              inputs,
              steps: Object.fromEntries(
                Object.entries(stepResults).map(([id, result]) => [
                  id.split(":").pop() || id,
                  result.output
                ])
              ),
              outputs: stepResults,
              pr: prInfo
            });
          }
        }
        return outputs;
      }
      /**
       * Format workflow result from state machine execution
       */
      formatWorkflowResultFromStateMachine(workflow, result, outputs) {
        const lines = [];
        lines.push(`Workflow: ${workflow.name}`);
        if (workflow.description) {
          lines.push(`Description: ${workflow.description}`);
        }
        lines.push("");
        lines.push("Execution Summary (State Machine):");
        lines.push(`- Total Steps: ${Object.keys(result.results || {}).length}`);
        lines.push(`- Duration: ${result.statistics?.totalDuration || 0}ms`);
        if (Object.keys(outputs).length > 0) {
          lines.push("");
          lines.push("Outputs:");
          for (const [key, value] of Object.entries(outputs)) {
            const formatted = typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
            lines.push(`- ${key}: ${formatted}`);
          }
        }
        return lines.join("\n");
      }
      formatWorkflowResult(workflow, result, outputs) {
        const lines = [];
        lines.push(`Workflow: ${workflow.name}`);
        if (workflow.description) {
          lines.push(`Description: ${workflow.description}`);
        }
        lines.push("");
        lines.push("Execution Summary:");
        lines.push(`- Status: ${result.status || "completed"}`);
        lines.push(`- Score: ${result.score || 0}`);
        lines.push(`- Issues Found: ${result.issues?.length || 0}`);
        if (result.duration) {
          lines.push(`- Duration: ${result.duration}ms`);
        }
        if (Object.keys(outputs).length > 0) {
          lines.push("");
          lines.push("Outputs:");
          for (const [key, value] of Object.entries(outputs)) {
            const formatted = typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
            lines.push(`- ${key}: ${formatted}`);
          }
        }
        if (result.stepSummaries && result.stepSummaries.length > 0) {
          lines.push("");
          lines.push("Step Results:");
          for (const summary of result.stepSummaries) {
            lines.push(
              `- ${summary.stepId}: ${summary.status} (${summary.issues?.length || 0} issues)`
            );
          }
        }
        return lines.join("\n");
      }
    };
  }
});

// src/providers/check-provider-registry.ts
var check_provider_registry_exports = {};
__export(check_provider_registry_exports, {
  CheckProviderRegistry: () => CheckProviderRegistry
});
var CheckProviderRegistry;
var init_check_provider_registry = __esm({
  "src/providers/check-provider-registry.ts"() {
    "use strict";
    init_ai_check_provider();
    init_http_check_provider();
    init_http_input_provider();
    init_http_client_provider();
    init_noop_check_provider();
    init_log_check_provider();
    init_github_ops_provider();
    init_claude_code_check_provider();
    init_command_check_provider();
    init_memory_check_provider();
    init_mcp_check_provider();
    init_human_input_check_provider();
    init_script_check_provider();
    init_workflow_check_provider();
    CheckProviderRegistry = class _CheckProviderRegistry {
      providers = /* @__PURE__ */ new Map();
      static instance;
      customTools;
      constructor() {
        this.registerDefaultProviders();
      }
      /**
       * Get singleton instance
       */
      static getInstance() {
        if (!_CheckProviderRegistry.instance) {
          _CheckProviderRegistry.instance = new _CheckProviderRegistry();
        }
        return _CheckProviderRegistry.instance;
      }
      /**
       * Register default built-in providers
       */
      registerDefaultProviders() {
        this.register(new AICheckProvider());
        this.register(new CommandCheckProvider());
        this.register(new ScriptCheckProvider());
        this.register(new HttpCheckProvider());
        this.register(new HttpInputProvider());
        this.register(new HttpClientProvider());
        this.register(new NoopCheckProvider());
        this.register(new LogCheckProvider());
        this.register(new MemoryCheckProvider());
        this.register(new GitHubOpsProvider());
        this.register(new HumanInputCheckProvider());
        this.register(new WorkflowCheckProvider());
        try {
          this.register(new ClaudeCodeCheckProvider());
        } catch (error) {
          console.error(
            `Warning: Failed to register ClaudeCodeCheckProvider: ${error instanceof Error ? error.message : "Unknown error"}`
          );
        }
        try {
          const mcpProvider = new McpCheckProvider();
          if (this.customTools) {
            mcpProvider.setCustomTools(this.customTools);
          }
          this.register(mcpProvider);
        } catch (error) {
          console.error(
            `Warning: Failed to register McpCheckProvider: ${error instanceof Error ? error.message : "Unknown error"}`
          );
        }
      }
      /**
       * Register a check provider
       */
      register(provider) {
        const name = provider.getName();
        if (this.providers.has(name)) {
          throw new Error(`Provider '${name}' is already registered`);
        }
        this.providers.set(name, provider);
        if (process.env.VISOR_DEBUG === "true") {
          console.error(`Registered check provider: ${name}`);
        }
      }
      /**
       * Unregister a check provider
       */
      unregister(name) {
        if (!this.providers.has(name)) {
          throw new Error(`Provider '${name}' not found`);
        }
        this.providers.delete(name);
        console.error(`Unregistered check provider: ${name}`);
      }
      /**
       * Get a provider by name
       */
      getProvider(name) {
        return this.providers.get(name);
      }
      /**
       * Get provider or throw if not found
       */
      getProviderOrThrow(name) {
        const provider = this.providers.get(name);
        if (!provider) {
          throw new Error(
            `Check provider '${name}' not found. Available providers: ${this.getAvailableProviders().join(", ")}`
          );
        }
        return provider;
      }
      /**
       * Check if a provider exists
       */
      hasProvider(name) {
        return this.providers.has(name);
      }
      /**
       * Get all registered provider names
       */
      getAvailableProviders() {
        return Array.from(this.providers.keys());
      }
      /**
       * Get all providers
       */
      getAllProviders() {
        return Array.from(this.providers.values());
      }
      /**
       * Set custom tools that can be used by the MCP provider
       */
      setCustomTools(tools) {
        this.customTools = tools;
        const mcpProvider = this.providers.get("mcp");
        if (mcpProvider) {
          mcpProvider.setCustomTools(tools);
        }
      }
      /**
       * Get providers that are currently available (have required dependencies)
       */
      async getActiveProviders() {
        const providers = this.getAllProviders();
        const activeProviders = [];
        for (const provider of providers) {
          if (await provider.isAvailable()) {
            activeProviders.push(provider);
          }
        }
        return activeProviders;
      }
      /**
       * List provider information
       */
      async listProviders() {
        const providers = this.getAllProviders();
        const info = [];
        for (const provider of providers) {
          info.push({
            name: provider.getName(),
            description: provider.getDescription(),
            available: await provider.isAvailable(),
            requirements: provider.getRequirements()
          });
        }
        return info;
      }
      /**
       * Reset registry (mainly for testing)
       */
      reset() {
        this.providers.clear();
        this.registerDefaultProviders();
      }
      /**
       * Clear singleton instance (for testing)
       */
      static clearInstance() {
        _CheckProviderRegistry.instance = void 0;
      }
    };
  }
});

// src/state-machine/states/level-dispatch.ts
function mapCheckNameToFocus(checkName) {
  const focusMap = {
    security: "security",
    performance: "performance",
    style: "style",
    architecture: "architecture"
  };
  return focusMap[checkName] || "all";
}
function buildOutputHistoryFromJournal(context2) {
  const outputHistory = /* @__PURE__ */ new Map();
  try {
    const snapshot = context2.journal.beginSnapshot();
    const allEntries = context2.journal.readVisible(context2.sessionId, snapshot, void 0);
    for (const entry of allEntries) {
      const checkId = entry.checkId;
      if (!outputHistory.has(checkId)) {
        outputHistory.set(checkId, []);
      }
      if (entry.result.output !== void 0) {
        outputHistory.get(checkId).push(entry.result.output);
      }
    }
  } catch (error) {
    logger.debug(`[LevelDispatch] Error building output history: ${error}`);
  }
  return outputHistory;
}
async function evaluateIfCondition(checkId, checkConfig, context2, state) {
  const ifExpression = checkConfig.if;
  if (!ifExpression) {
    return true;
  }
  try {
    const evaluator = new FailureConditionEvaluator();
    const previousResults = /* @__PURE__ */ new Map();
    const currentWaveCompletions = state.currentWaveCompletions;
    if (currentWaveCompletions) {
      for (const key of currentWaveCompletions) {
        try {
          const snapshotId = context2.journal.beginSnapshot();
          const contextView = new (init_snapshot_store(), __toCommonJS(snapshot_store_exports)).ContextView(
            context2.journal,
            context2.sessionId,
            snapshotId,
            [],
            context2.event
          );
          const journalResult = contextView.get(key);
          if (journalResult) {
            previousResults.set(key, journalResult);
          }
        } catch {
        }
      }
    }
    const envSnapshot = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== void 0) {
        envSnapshot[key] = value;
      }
    }
    if (context2.config.env) {
      for (const [key, value] of Object.entries(context2.config.env)) {
        if (value !== void 0 && value !== null) {
          envSnapshot[key] = String(value);
        }
      }
    }
    const contextData = {
      previousResults,
      event: context2.event || "manual",
      branch: context2.prInfo?.branch,
      baseBranch: context2.prInfo?.baseBranch,
      filesChanged: context2.prInfo?.files?.map((f) => f.filename),
      environment: envSnapshot
    };
    const shouldRun = await evaluator.evaluateIfCondition(checkId, ifExpression, contextData);
    return shouldRun;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to evaluate if expression for check '${checkId}': ${msg}`);
    return false;
  }
}
async function handleLevelDispatch(context2, state, transition, emitEvent) {
  const level = state.levelQueue.shift();
  if (!level) {
    if (context2.debug) {
      logger.info("[LevelDispatch] No more levels in queue");
    }
    transition("WavePlanning");
    return;
  }
  if (context2.debug) {
    logger.info(
      `[LevelDispatch] Executing level ${level.level} with ${level.parallel.length} checks`
    );
  }
  state.currentLevel = level.level;
  state.currentLevelChecks = new Set(level.parallel);
  emitEvent({ type: "LevelReady", level, wave: state.wave });
  const maxParallelism = context2.maxParallelism || 10;
  const results = [];
  const sessionGroups = groupBySession(level.parallel, context2);
  for (const group of sessionGroups) {
    const groupResults = await executeCheckGroup(
      group,
      context2,
      state,
      maxParallelism,
      emitEvent,
      transition
    );
    results.push(...groupResults);
    if (context2.failFast && shouldFailFast(results)) {
      logger.warn("[LevelDispatch] Fail-fast triggered");
      state.flags.failFastTriggered = true;
      break;
    }
  }
  emitEvent({ type: "LevelDepleted", level: level.level, wave: state.wave });
  const nonForEachResults = results.filter((r) => {
    if (r.result.isForEach) return false;
    if (r.result.__skipped) return false;
    return true;
  });
  updateStats(nonForEachResults, state);
  if (state.flags.failFastTriggered) {
    state.levelQueue = [];
    if (context2.debug) {
      logger.info("[LevelDispatch] Fail-fast triggered, clearing level queue");
    }
  }
  state.currentLevelChecks.clear();
  transition("WavePlanning");
}
function groupBySession(checks, context2) {
  const sessionProviderMap = /* @__PURE__ */ new Map();
  const noSessionChecks = [];
  for (const checkId of checks) {
    const metadata = context2.checks[checkId];
    const sessionProvider = metadata?.sessionProvider;
    if (sessionProvider) {
      const group = sessionProviderMap.get(sessionProvider) || [];
      group.push(checkId);
      sessionProviderMap.set(sessionProvider, group);
    } else {
      noSessionChecks.push(checkId);
    }
  }
  const groups = [];
  for (const group of sessionProviderMap.values()) {
    groups.push(group);
  }
  if (noSessionChecks.length > 0) {
    groups.push(noSessionChecks);
  }
  return groups;
}
async function executeCheckGroup(checks, context2, state, maxParallelism, emitEvent, transition) {
  const results = [];
  const seen = /* @__PURE__ */ new Set();
  const uniqueChecks = [];
  for (const id of checks) {
    if (!seen.has(id)) {
      seen.add(id);
      uniqueChecks.push(id);
    }
  }
  const pool = [];
  for (const checkId of uniqueChecks) {
    const scopedRuns = state.pendingRunScopes && state.pendingRunScopes.get(checkId) || [];
    try {
      const currentWaveCompletions = state.currentWaveCompletions;
      if (currentWaveCompletions && currentWaveCompletions.has(checkId)) {
        if (context2.debug) {
          logger.info(`[LevelDispatch] Skipping ${checkId}: already completed in current wave`);
        }
        continue;
      }
    } catch {
    }
    if (pool.length >= maxParallelism) {
      await Promise.race(pool);
      pool.splice(
        0,
        pool.length,
        ...pool.filter((p) => {
          const settled = p._settled;
          return !settled;
        })
      );
    }
    const runOnce = async (scopeOverride) => {
      const startTime = Date.now();
      try {
        const result = await executeSingleCheck(
          checkId,
          context2,
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
    const promise = (async () => {
      if (scopedRuns.length > 0) {
        for (const sc of scopedRuns) {
          await runOnce(sc);
        }
        try {
          state.pendingRunScopes?.delete(checkId);
        } catch {
        }
      } else {
        await runOnce();
      }
    })();
    promise.then(() => {
      promise._settled = true;
    }).catch(() => {
      promise._settled = true;
    });
    pool.push(promise);
  }
  await Promise.all(pool);
  return results;
}
async function executeCheckWithForEachItems(checkId, forEachParent, forEachItems, context2, state, emitEvent, transition) {
  try {
    const snapId = context2.journal.beginSnapshot();
    const visible = context2.journal.readVisible(context2.sessionId, snapId, context2.event);
    let latestItems;
    for (let i = visible.length - 1; i >= 0; i--) {
      const e = visible[i];
      if (e.checkId === forEachParent && Array.isArray(e.scope) && e.scope.length === 0) {
        const r = e.result;
        if (r && Array.isArray(r.forEachItems)) {
          latestItems = r.forEachItems;
          break;
        }
      }
    }
    if (Array.isArray(latestItems)) {
      if (context2.debug) {
        try {
          const prevLen = Array.isArray(forEachItems) ? forEachItems.length : 0;
          const newLen = latestItems.length;
          if (prevLen !== newLen) {
            logger.info(
              `[LevelDispatch] Refreshing forEachItems for ${checkId}: from parent '${forEachParent}' latestItems=${newLen} (was ${prevLen})`
            );
          }
        } catch {
        }
      }
      forEachItems = latestItems;
    }
  } catch (e) {
    if (context2.debug) {
      logger.warn(
        `[LevelDispatch] Failed to refresh forEachItems from journal for ${forEachParent}: ${e}`
      );
    }
  }
  const checkConfig = context2.config.checks?.[checkId];
  if (!checkConfig) {
    throw new Error(`Check configuration not found: ${checkId}`);
  }
  logger.info(
    `[LevelDispatch][DEBUG] executeCheckWithForEachItems: checkId=${checkId}, forEachParent=${forEachParent}, items=${forEachItems.length}`
  );
  logger.info(
    `[LevelDispatch][DEBUG] forEachItems: ${JSON.stringify(forEachItems).substring(0, 200)}`
  );
  const allIssues = [];
  const perItemResults = [];
  const allOutputs = [];
  const allContents = [];
  const perIterationDurations = [];
  for (let itemIndex = 0; itemIndex < forEachItems.length; itemIndex++) {
    const iterationStartMs = Date.now();
    const scope = [
      { check: forEachParent, index: itemIndex }
    ];
    const forEachItem = forEachItems[itemIndex];
    logger.info(
      `[LevelDispatch][DEBUG] Starting iteration ${itemIndex} of ${checkId}, parent=${forEachParent}, item=${JSON.stringify(forEachItem)?.substring(0, 100)}`
    );
    const shouldSkipDueToParentFailure = forEachItem?.__failed === true || forEachItem?.__skip === true;
    if (shouldSkipDueToParentFailure) {
      logger.info(
        `\u23ED  Skipped ${checkId} iteration ${itemIndex} (forEach parent "${forEachParent}" iteration ${itemIndex} marked as failed)`
      );
      const iterationDurationMs = Date.now() - iterationStartMs;
      perIterationDurations.push(iterationDurationMs);
      perItemResults.push({ issues: [] });
      allOutputs.push({ __skip: true });
      continue;
    }
    try {
      emitNdjsonSpanWithEvents(
        "visor.foreach.item",
        {
          "visor.check.id": checkId,
          "visor.foreach.index": itemIndex,
          "visor.foreach.total": forEachItems.length
        },
        []
      );
    } catch (error) {
      logger.warn(`[LevelDispatch] Failed to emit foreach.item span: ${error}`);
    }
    emitEvent({ type: "CheckScheduled", checkId, scope });
    const dispatch = {
      id: `${checkId}-${itemIndex}-${Date.now()}`,
      checkId,
      scope,
      provider: context2.checks[checkId]?.providerType || "unknown",
      startMs: Date.now(),
      attempts: 1,
      foreachIndex: itemIndex
    };
    state.activeDispatches.set(`${checkId}-${itemIndex}`, dispatch);
    try {
      const providerType = checkConfig.type || "ai";
      const providerRegistry = (init_check_provider_registry(), __toCommonJS(check_provider_registry_exports)).CheckProviderRegistry.getInstance();
      const provider = providerRegistry.getProviderOrThrow(providerType);
      const outputHistory = buildOutputHistoryFromJournal(context2);
      const providerConfig = {
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
        eventContext: context2.prInfo?.eventContext || {},
        __outputHistory: outputHistory,
        ai: {
          ...checkConfig.ai || {},
          timeout: checkConfig.ai?.timeout || 6e5,
          debug: !!context2.debug
        }
      };
      const dependencyResults = buildDependencyResultsWithScope(
        checkId,
        checkConfig,
        context2,
        scope
      );
      try {
        const rawDeps = checkConfig?.depends_on || [];
        const depList = Array.isArray(rawDeps) ? rawDeps : [rawDeps];
        if (depList.length > 0) {
          const groupSatisfied = (token) => {
            if (typeof token !== "string") return true;
            const orOptions = token.includes("|") ? token.split("|").map((s) => s.trim()).filter(Boolean) : [token];
            for (const opt of orOptions) {
              const dr = dependencyResults.get(opt);
              const depCfg = context2.config.checks?.[opt];
              const cont = !!(depCfg && depCfg.continue_on_failure === true);
              let failed = false;
              let skipped = false;
              if (!dr) {
                failed = true;
              } else {
                const out = dr.output;
                const fatal = hasFatalIssues(dr);
                failed = fatal || !!out && typeof out === "object" && out.__failed === true;
                skipped = !!(out && typeof out === "object" && out.__skip === true);
              }
              const satisfied = !skipped && (!failed || cont);
              if (satisfied) return true;
            }
            return false;
          };
          let allSatisfied = true;
          for (const token of depList) {
            if (!groupSatisfied(token)) {
              allSatisfied = false;
              break;
            }
          }
          if (!allSatisfied) {
            if (context2.debug) {
              logger.info(
                `[LevelDispatch] Skipping ${checkId} iteration ${itemIndex} due to unsatisfied dependency group(s)`
              );
            }
            const iterationDurationMs2 = Date.now() - iterationStartMs;
            perIterationDurations.push(iterationDurationMs2);
            perItemResults.push({ issues: [] });
            allOutputs.push({ __skip: true });
            continue;
          }
        }
      } catch {
      }
      const prInfo = context2.prInfo || {
        number: 1,
        title: "State Machine Execution",
        author: "system",
        eventType: context2.event || "manual",
        eventContext: {},
        files: [],
        commits: []
      };
      const executionContext = {
        ...context2.executionContext,
        _engineMode: context2.mode,
        _parentContext: context2,
        _parentState: state
      };
      try {
        const assumeExpr = checkConfig?.assume;
        if (assumeExpr) {
          const evaluator = new FailureConditionEvaluator();
          const exprs = Array.isArray(assumeExpr) ? assumeExpr : [assumeExpr];
          let ok = true;
          for (const ex of exprs) {
            const res = await evaluator.evaluateIfCondition(checkId, ex, {
              event: context2.event || "manual",
              previousResults: dependencyResults
            });
            if (!res) {
              ok = false;
              break;
            }
          }
          if (!ok) {
            logger.info(
              `\u23ED  Skipped (assume: ${String(Array.isArray(assumeExpr) ? assumeExpr[0] : assumeExpr).substring(0, 40)}${String(Array.isArray(assumeExpr) ? assumeExpr[0] : assumeExpr).length > 40 ? "..." : ""})`
            );
            const iterationDurationMs2 = Date.now() - iterationStartMs;
            perIterationDurations.push(iterationDurationMs2);
            perItemResults.push({ issues: [] });
            allOutputs.push({ __skip: true });
            continue;
          }
        }
      } catch {
      }
      try {
        emitNdjsonFallback("visor.provider", {
          "visor.check.id": checkId,
          "visor.provider.type": providerType
        });
      } catch {
      }
      const itemResult = await withActiveSpan(
        `visor.check.${checkId}`,
        {
          "visor.check.id": checkId,
          "visor.check.type": providerType,
          "visor.foreach.index": itemIndex
        },
        async () => provider.execute(prInfo, providerConfig, dependencyResults, executionContext)
      );
      const enrichedIssues = (itemResult.issues || []).map((issue) => ({
        ...issue,
        checkName: checkId,
        ruleId: `${checkId}/${issue.ruleId || "unknown"}`,
        group: checkConfig.group,
        schema: typeof checkConfig.schema === "object" ? "custom" : checkConfig.schema,
        template: checkConfig.template,
        timestamp: Date.now()
      }));
      let output = itemResult.output;
      let content = itemResult.content;
      if (!content && enrichedIssues.length > 0) {
        content = enrichedIssues.map(
          (i) => `- **${i.severity.toUpperCase()}**: ${i.message} (${i.file}:${i.line})`
        ).join("\n");
      }
      const iterationHasFatalIssues = enrichedIssues.some((issue) => {
        const ruleId = issue.ruleId || "";
        return ruleId.endsWith("/error") || // System errors
        ruleId.includes("/execution_error") || // Command failures
        ruleId.endsWith("_fail_if");
      });
      if (iterationHasFatalIssues && output !== void 0 && output !== null && typeof output === "object") {
        output = { ...output, __failed: true };
      } else if (iterationHasFatalIssues) {
        output = { __value: output, __failed: true };
      }
      logger.info(
        `[LevelDispatch][DEBUG] Iteration ${itemIndex}: output=${JSON.stringify(output)?.substring(0, 100)}, hasFatalIssues=${iterationHasFatalIssues}`
      );
      const enrichedResult = {
        ...itemResult,
        issues: enrichedIssues,
        ...content ? { content } : {}
      };
      try {
        const schemaObj = (typeof checkConfig.schema === "object" ? checkConfig.schema : void 0) || checkConfig.output_schema;
        const itemOutput = output;
        if (schemaObj && itemOutput !== void 0) {
          const Ajv2 = __require("ajv");
          const ajv = new Ajv2({ allErrors: true, allowUnionTypes: true, strict: false });
          const validate = ajv.compile(schemaObj);
          const valid = validate(itemOutput);
          if (!valid) {
            const errs = (validate.errors || []).slice(0, 3).map((e) => e.message).join("; ");
            const issue = {
              file: "contract",
              line: 0,
              ruleId: `contract/schema_validation_failed`,
              message: `Output schema validation failed${errs ? `: ${errs}` : ""}`,
              severity: "error",
              category: "logic",
              checkName: checkId,
              group: checkConfig.group,
              schema: "json-schema",
              timestamp: Date.now()
            };
            enrichedResult.issues = [...enrichedResult.issues || [], issue];
            if (Array.isArray(enrichedIssues)) {
              enrichedIssues.push(issue);
            }
          }
        }
      } catch {
      }
      try {
        const guaranteeExpr = checkConfig?.guarantee;
        if (guaranteeExpr) {
          const evaluator = new FailureConditionEvaluator();
          const exprs = Array.isArray(guaranteeExpr) ? guaranteeExpr : [guaranteeExpr];
          for (const ex of exprs) {
            const holds = await evaluator.evaluateIfCondition(checkId, ex, {
              previousResults: dependencyResults,
              event: context2.event || "manual"
            });
            if (!holds) {
              const issue = {
                file: "contract",
                line: 0,
                ruleId: `contract/guarantee_failed`,
                message: `Guarantee failed: ${ex}`,
                severity: "error",
                category: "logic",
                checkName: checkId,
                group: checkConfig.group,
                schema: typeof checkConfig.schema === "object" ? "custom" : checkConfig.schema,
                timestamp: Date.now()
              };
              enrichedResult.issues = [...enrichedResult.issues || [], issue];
            }
          }
        }
      } catch {
      }
      if (checkConfig.fail_if) {
        try {
          const evaluator = new FailureConditionEvaluator();
          const failed = await evaluator.evaluateSimpleCondition(
            checkId,
            typeof checkConfig.schema === "object" ? "custom" : checkConfig.schema || "",
            checkConfig.group || "",
            enrichedResult,
            checkConfig.fail_if,
            Object.fromEntries(dependencyResults.entries())
          );
          if (failed) {
            logger.warn(
              `[LevelDispatch] fail_if triggered for ${checkId} iteration ${itemIndex}: ${checkConfig.fail_if}`
            );
            const failIssue = {
              file: "system",
              line: 0,
              ruleId: `${checkId}/${checkId}_fail_if`,
              message: `Check failure condition met: ${checkConfig.fail_if}`,
              severity: "error",
              category: "logic",
              checkName: checkId,
              group: checkConfig.group,
              schema: typeof checkConfig.schema === "object" ? "custom" : checkConfig.schema,
              timestamp: Date.now()
            };
            enrichedResult.issues = [...enrichedResult.issues || [], failIssue];
            enrichedIssues.push(failIssue);
            allIssues.push(failIssue);
            const nowHasFatalIssues = enrichedResult.issues.some((issue) => {
              const ruleId = issue.ruleId || "";
              return ruleId.endsWith("/error") || ruleId.includes("/execution_error") || ruleId.endsWith("_fail_if");
            });
            if (nowHasFatalIssues && output !== void 0 && output !== null && typeof output === "object" && !output.__failed) {
              output = { ...output, __failed: true };
            } else if (nowHasFatalIssues && !output?.__failed) {
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
      perItemResults.push(enrichedResult);
      allIssues.push(...enrichedIssues);
      allOutputs.push(output);
      if (typeof content === "string" && content.trim()) {
        allContents.push(content.trim());
      }
      try {
        const journalEntry = {
          sessionId: context2.sessionId,
          checkId,
          result: { ...enrichedResult, output },
          event: context2.event || "manual",
          scope
        };
        logger.info(
          `[LevelDispatch][DEBUG] Committing to journal: checkId=${checkId}, scope=${JSON.stringify(scope)}, hasOutput=${output !== void 0}`
        );
        context2.journal.commitEntry(journalEntry);
      } catch (error) {
        logger.warn(`[LevelDispatch] Failed to commit to journal: ${error}`);
      }
      state.activeDispatches.delete(`${checkId}-${itemIndex}`);
      emitEvent({
        type: "CheckCompleted",
        checkId,
        scope,
        result: {
          ...enrichedResult,
          output
        }
      });
      const iterationDurationMs = Date.now() - iterationStartMs;
      perIterationDurations.push(iterationDurationMs);
      updateStats(
        [{ checkId, result: enrichedResult, duration: iterationDurationMs }],
        state,
        true
      );
    } catch (error) {
      const iterationDurationMs = Date.now() - iterationStartMs;
      perIterationDurations.push(iterationDurationMs);
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(
        `[LevelDispatch] Error executing check ${checkId} item ${itemIndex}: ${err.message}`
      );
      state.activeDispatches.delete(`${checkId}-${itemIndex}`);
      emitEvent({
        type: "CheckErrored",
        checkId,
        scope,
        error: {
          message: err.message,
          stack: err.stack,
          name: err.name
        }
      });
      const errorIssue = {
        file: "",
        line: 0,
        ruleId: `${checkId}/error`,
        message: err.message,
        severity: "error",
        category: "logic"
      };
      allIssues.push(errorIssue);
      perItemResults.push({ issues: [errorIssue] });
      updateStats(
        [{ checkId, result: { issues: [errorIssue] }, error: err, duration: iterationDurationMs }],
        state,
        true
      );
    }
  }
  state.completedChecks.add(checkId);
  const checkStats = state.stats.get(checkId);
  if (checkStats) {
    checkStats.outputsProduced = allOutputs.length;
    checkStats.perIterationDuration = perIterationDurations;
    const previewItems = allOutputs.slice(0, 3).map((item) => {
      const str = typeof item === "string" ? item : JSON.stringify(item) ?? "undefined";
      return str.length > 50 ? str.substring(0, 50) + "..." : str;
    });
    if (allOutputs.length > 3) {
      checkStats.forEachPreview = [...previewItems, `...${allOutputs.length - 3} more`];
    } else {
      checkStats.forEachPreview = previewItems;
    }
    state.stats.set(checkId, checkStats);
    if (checkStats.totalRuns > 0 && checkStats.failedRuns === checkStats.totalRuns) {
      logger.info(
        `[LevelDispatch] forEach check ${checkId} failed completely (${checkStats.failedRuns}/${checkStats.totalRuns} iterations failed)`
      );
      if (!state.failedChecks) {
        state.failedChecks = /* @__PURE__ */ new Set();
      }
      state.failedChecks.add(checkId);
    }
  }
  const aggregatedResult = {
    issues: allIssues,
    isForEach: true,
    forEachItems: allOutputs,
    forEachItemResults: perItemResults,
    // Include aggregated content from all iterations
    ...allContents.length > 0 ? { content: allContents.join("\n") } : {}
  };
  logger.info(
    `[LevelDispatch][DEBUG] Aggregated result for ${checkId}: forEachItems.length=${allOutputs.length}, results=${perItemResults.length}`
  );
  logger.info(`[LevelDispatch][DEBUG] allOutputs: ${JSON.stringify(allOutputs).substring(0, 200)}`);
  try {
    logger.info(`[LevelDispatch] Calling handleRouting for ${checkId}`);
  } catch {
  }
  try {
    state.completedChecks.add(checkId);
    const currentWaveCompletions = state.currentWaveCompletions;
    if (currentWaveCompletions) currentWaveCompletions.add(checkId);
    await handleRouting(context2, state, transition, emitEvent, {
      checkId,
      scope: [],
      result: aggregatedResult,
      checkConfig,
      success: !hasFatalIssues(aggregatedResult)
    });
  } catch (error) {
    logger.warn(`[LevelDispatch] Routing error for aggregated forEach ${checkId}: ${error}`);
  }
  try {
    context2.journal.commitEntry({
      sessionId: context2.sessionId,
      checkId,
      result: aggregatedResult,
      event: context2.event || "manual",
      scope: []
    });
    logger.info(`[LevelDispatch][DEBUG] Committed aggregated result to journal with scope=[]`);
  } catch (error) {
    logger.warn(`[LevelDispatch] Failed to commit aggregated forEach result to journal: ${error}`);
  }
  emitEvent({
    type: "CheckCompleted",
    checkId,
    scope: [],
    result: aggregatedResult
  });
  const parentCheckConfig = context2.config.checks?.[forEachParent];
  logger.info(
    `[LevelDispatch][DEBUG] Checking on_finish for forEach parent ${forEachParent}: has_on_finish=${!!parentCheckConfig?.on_finish}, is_forEach=${!!parentCheckConfig?.forEach}`
  );
  if (parentCheckConfig?.on_finish && parentCheckConfig.forEach) {
    logger.info(
      `[LevelDispatch] Processing on_finish for forEach parent ${forEachParent} after children complete`
    );
    try {
      const snapshotId = context2.journal.beginSnapshot();
      const contextView = new (init_snapshot_store(), __toCommonJS(snapshot_store_exports)).ContextView(
        context2.journal,
        context2.sessionId,
        snapshotId,
        [],
        context2.event
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
              `[LevelDispatch] Loop budget check: routingLoopCount=${state.routingLoopCount}, max_loops=${context2.config.routing?.max_loops ?? 10}`
            );
            if (checkLoopBudget(context2, state, "on_finish", "run")) {
              const errorIssue = {
                file: "system",
                line: 0,
                ruleId: `${forEachParent}/routing/loop_budget_exceeded`,
                message: `Routing loop budget exceeded (max_loops=${context2.config.routing?.max_loops ?? 10}) during on_finish run`,
                severity: "error",
                category: "logic"
              };
              parentResult.issues = [...parentResult.issues || [], errorIssue];
              try {
                context2.journal.commitEntry({
                  sessionId: context2.sessionId,
                  checkId: forEachParent,
                  result: parentResult,
                  event: context2.event || "manual",
                  scope: []
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
              type: "ForwardRunRequested",
              target: targetCheck,
              scope: [],
              origin: "run"
            });
            queuedForward = true;
          }
        }
        const { evaluateGoto } = await import("./routing-BCOFXZIM.mjs");
        if (context2.debug || true) {
          logger.info(
            `[LevelDispatch] Evaluating on_finish.goto_js for forEach parent: ${forEachParent}`
          );
          if (onFinish.goto_js) {
            logger.info(`[LevelDispatch] goto_js code: ${onFinish.goto_js.substring(0, 200)}`);
          }
          try {
            const snapshotId2 = context2.journal.beginSnapshot();
            const view = new (init_snapshot_store(), __toCommonJS(snapshot_store_exports)).ContextView(
              context2.journal,
              context2.sessionId,
              snapshotId2,
              [],
              void 0
            );
            const vfHist = view.getHistory("validate-fact") || [];
            logger.info(`[LevelDispatch] history['validate-fact'] length: ${vfHist.length}`);
            const all = context2.journal.readVisible(context2.sessionId, snapshotId2, void 0);
            const keys = Array.from(new Set(all.map((e) => e.checkId)));
            logger.info(`[LevelDispatch] history keys: ${keys.join(", ")}`);
          } catch {
          }
        }
        const gotoTarget = await evaluateGoto(
          onFinish.goto_js,
          onFinish.goto,
          forEachParent,
          parentCheckConfig,
          parentResult,
          context2,
          state
        );
        if (context2.debug || true) {
          logger.info(`[LevelDispatch] goto_js evaluation result: ${gotoTarget || "null"}`);
        }
        if (gotoTarget) {
          if (queuedForward && gotoTarget === forEachParent) {
            logger.info(
              `[LevelDispatch] on_finish.goto to self (${gotoTarget}) deferred, will process after WaveRetry`
            );
          }
          if (checkLoopBudget(context2, state, "on_finish", "goto")) {
            const errorIssue = {
              file: "system",
              line: 0,
              ruleId: `${forEachParent}/routing/loop_budget_exceeded`,
              message: `Routing loop budget exceeded (max_loops=${context2.config.routing?.max_loops ?? 10}) during on_finish goto`,
              severity: "error",
              category: "logic"
            };
            parentResult.issues = [...parentResult.issues || [], errorIssue];
            try {
              context2.journal.commitEntry({
                sessionId: context2.sessionId,
                checkId: forEachParent,
                result: parentResult,
                event: context2.event || "manual",
                scope: []
              });
            } catch (err) {
              logger.warn(
                `[LevelDispatch] Failed to commit parent result with loop budget error: ${err}`
              );
            }
            return aggregatedResult;
          }
          logger.info(`[LevelDispatch] on_finish for ${forEachParent} routing to: ${gotoTarget}`);
          state.routingLoopCount++;
          emitEvent({
            type: "ForwardRunRequested",
            target: gotoTarget,
            scope: [],
            origin: "goto_js",
            gotoEvent: context2.event
          });
          state.flags.forwardRunRequested = true;
          try {
            const guardKeyGoto = `waveRetry:on_finish:${forEachParent}:wave:${state.wave}`;
            if (!state.forwardRunGuards?.has(guardKeyGoto)) {
              state.forwardRunGuards?.add(guardKeyGoto);
              emitEvent({ type: "WaveRetry", reason: "on_finish" });
            }
          } catch {
          }
        } else {
          logger.info(`[LevelDispatch] on_finish for ${forEachParent} returned null, no routing`);
        }
        if (queuedForward) {
          const guardKey = `waveRetry:on_finish:${forEachParent}:wave:${state.wave}`;
          logger.info(
            `[LevelDispatch] Checking WaveRetry guard: ${guardKey}, has=${!!state.forwardRunGuards?.has(guardKey)}`
          );
          if (!state.forwardRunGuards?.has(guardKey)) {
            state.forwardRunGuards?.add(guardKey);
            logger.info(`[LevelDispatch] Emitting WaveRetry event for on_finish.run targets`);
            emitEvent({ type: "WaveRetry", reason: "on_finish" });
          }
        } else {
        }
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
async function executeSingleCheck(checkId, context2, state, emitEvent, transition, scopeOverride) {
  const checkConfig = context2.config.checks?.[checkId];
  if (checkConfig?.if) {
    const shouldRun = await evaluateIfCondition(checkId, checkConfig, context2, state);
    if (!shouldRun) {
      logger.info(
        `\u23ED  Skipped (if: ${checkConfig.if.substring(0, 40)}${checkConfig.if.length > 40 ? "..." : ""})`
      );
      const emptyResult = { issues: [] };
      try {
        Object.defineProperty(emptyResult, "__skipped", {
          value: "if_condition",
          enumerable: false
        });
      } catch {
      }
      state.completedChecks.add(checkId);
      const stats = {
        checkName: checkId,
        totalRuns: 0,
        successfulRuns: 0,
        failedRuns: 0,
        skippedRuns: 0,
        skipped: true,
        skipReason: "if_condition",
        skipCondition: checkConfig.if,
        totalDuration: 0,
        issuesFound: 0,
        issuesBySeverity: {
          critical: 0,
          error: 0,
          warning: 0,
          info: 0
        }
      };
      state.stats.set(checkId, stats);
      logger.info(`[LevelDispatch] Recorded skip stats for ${checkId}: skipReason=if_condition`);
      try {
        context2.journal.commitEntry({
          sessionId: context2.sessionId,
          checkId,
          result: emptyResult,
          event: context2.event || "manual",
          scope: []
        });
      } catch (error) {
        logger.warn(`[LevelDispatch] Failed to commit skipped result to journal: ${error}`);
      }
      emitEvent({
        type: "CheckCompleted",
        checkId,
        scope: [],
        result: emptyResult
      });
      return emptyResult;
    }
  }
  const dependencies = checkConfig?.depends_on || [];
  const depList = Array.isArray(dependencies) ? dependencies : [dependencies];
  const failedChecks = state.failedChecks;
  const tokens = depList.filter(Boolean);
  const groupSatisfied = (token) => {
    const options = token.includes("|") ? token.split("|").map((s) => s.trim()).filter(Boolean) : [token];
    for (const opt of options) {
      const depCfg = context2.config.checks?.[opt];
      const cont = !!(depCfg && depCfg.continue_on_failure === true);
      const st = state.stats.get(opt);
      const wasMarkedFailed = !!(failedChecks && failedChecks.has(opt));
      const skipped = !!(st && st.skipped === true);
      const failedOnly = !!(st && (st.failedRuns || 0) > 0 && (st.successfulRuns || 0) === 0);
      const satisfied = !skipped && (!failedOnly && !wasMarkedFailed || cont);
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
      const emptyResult = { issues: [] };
      try {
        Object.defineProperty(emptyResult, "__skipped", {
          value: "dependency_failed",
          enumerable: false
        });
      } catch {
      }
      state.completedChecks.add(checkId);
      if (!state.failedChecks) state.failedChecks = /* @__PURE__ */ new Set();
      state.failedChecks.add(checkId);
      const stats = {
        checkName: checkId,
        totalRuns: 0,
        successfulRuns: 0,
        failedRuns: 0,
        skippedRuns: 0,
        skipped: true,
        skipReason: "dependency_failed",
        totalDuration: 0,
        issuesFound: 0,
        issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 }
      };
      state.stats.set(checkId, stats);
      try {
        context2.journal.commitEntry({
          sessionId: context2.sessionId,
          checkId,
          result: emptyResult,
          event: context2.event || "manual",
          scope: []
        });
      } catch (error) {
        logger.warn(`[LevelDispatch] Failed to commit empty result to journal: ${error}`);
      }
      emitEvent({ type: "CheckCompleted", checkId, scope: [], result: emptyResult });
      return emptyResult;
    }
  }
  let forEachParent;
  let forEachItems;
  for (const depId of depList) {
    if (!depId) continue;
    try {
      const snapshotId = context2.journal.beginSnapshot();
      const contextView = new (init_snapshot_store(), __toCommonJS(snapshot_store_exports)).ContextView(
        context2.journal,
        context2.sessionId,
        snapshotId,
        [],
        context2.event
      );
      const depResult = contextView.get(depId);
      if (context2.debug) {
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
        if (context2.debug && forEachItems) {
          logger.info(
            `[LevelDispatch] Detected forEach parent ${depId} with ${forEachItems.length} items for check ${checkId}`
          );
        }
        break;
      }
    } catch (error) {
      if (context2.debug) {
        logger.warn(`[LevelDispatch] Error checking forEach parent ${depId}: ${error}`);
      }
    }
  }
  if (forEachParent && forEachItems !== void 0) {
    let fanoutMode = "reduce";
    const explicit = checkConfig?.fanout;
    if (explicit === "map" || explicit === "reduce") {
      fanoutMode = explicit;
    } else {
      const providerType = context2.checks[checkId]?.providerType || "";
      const reduceProviders = /* @__PURE__ */ new Set(["log", "memory", "script", "workflow", "noop"]);
      fanoutMode = reduceProviders.has(providerType) ? "reduce" : "map";
    }
    if (fanoutMode === "map") {
      if (forEachItems.length === 0) {
        logger.info(`\u23ED  Skipped (forEach parent "${forEachParent}" has 0 items)`);
        if (context2.debug) {
          logger.info(
            `[LevelDispatch] Skipping check ${checkId}: forEach parent ${forEachParent} has zero items`
          );
        }
        const emptyResult = { issues: [] };
        try {
          Object.defineProperty(emptyResult, "__skipped", {
            value: "forEach_empty",
            enumerable: false
          });
        } catch {
        }
        state.completedChecks.add(checkId);
        if (!state.failedChecks) {
          state.failedChecks = /* @__PURE__ */ new Set();
        }
        state.failedChecks.add(checkId);
        let derivedSkipReason = "forEach_empty";
        try {
          const parentFailed = !!(state.failedChecks && state.failedChecks.has(forEachParent)) || (() => {
            const s = state.stats.get(forEachParent);
            return !!(s && (s.failedRuns || 0) > 0);
          })();
          if (parentFailed) derivedSkipReason = "dependency_failed";
        } catch {
        }
        const stats = {
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
            info: 0
          }
        };
        state.stats.set(checkId, stats);
        try {
          context2.journal.commitEntry({
            sessionId: context2.sessionId,
            checkId,
            result: emptyResult,
            event: context2.event || "manual",
            scope: []
          });
        } catch (error) {
          logger.warn(`[LevelDispatch] Failed to commit empty result to journal: ${error}`);
        }
        emitEvent({
          type: "CheckCompleted",
          checkId,
          scope: [],
          result: emptyResult
        });
        return emptyResult;
      }
      return await executeCheckWithForEachItems(
        checkId,
        forEachParent,
        forEachItems,
        context2,
        state,
        emitEvent,
        transition
      );
    }
  }
  const scope = scopeOverride || [];
  emitEvent({ type: "CheckScheduled", checkId, scope });
  const startTime = Date.now();
  const dispatch = {
    id: `${checkId}-${Date.now()}`,
    checkId,
    scope,
    provider: context2.checks[checkId]?.providerType || "unknown",
    startMs: startTime,
    attempts: 1
  };
  state.activeDispatches.set(checkId, dispatch);
  try {
    const checkConfig2 = context2.config.checks?.[checkId];
    if (!checkConfig2) {
      throw new Error(`Check configuration not found: ${checkId}`);
    }
    const providerType = checkConfig2.type || "ai";
    const providerRegistry = (init_check_provider_registry(), __toCommonJS(check_provider_registry_exports)).CheckProviderRegistry.getInstance();
    const provider = providerRegistry.getProviderOrThrow(providerType);
    const outputHistory = buildOutputHistoryFromJournal(context2);
    const providerConfig = {
      type: providerType,
      checkName: checkId,
      prompt: checkConfig2.prompt,
      exec: checkConfig2.exec,
      schema: checkConfig2.schema,
      group: checkConfig2.group,
      focus: checkConfig2.focus || mapCheckNameToFocus(checkId),
      transform: checkConfig2.transform,
      transform_js: checkConfig2.transform_js,
      env: checkConfig2.env,
      forEach: checkConfig2.forEach,
      ...checkConfig2,
      eventContext: context2.prInfo?.eventContext || {},
      __outputHistory: outputHistory,
      ai: {
        ...checkConfig2.ai || {},
        timeout: checkConfig2.ai?.timeout || 6e5,
        debug: !!context2.debug
      }
    };
    const dependencyResults = buildDependencyResults(checkId, checkConfig2, context2, state);
    const prInfo = context2.prInfo || {
      number: 1,
      title: "State Machine Execution",
      author: "system",
      eventType: context2.event || "manual",
      eventContext: {},
      files: [],
      commits: []
    };
    const executionContext = {
      ...context2.executionContext,
      _engineMode: context2.mode,
      _parentContext: context2,
      _parentState: state
    };
    try {
      const assumeExpr = checkConfig2?.assume;
      if (assumeExpr) {
        const evaluator = new FailureConditionEvaluator();
        const exprs = Array.isArray(assumeExpr) ? assumeExpr : [assumeExpr];
        let ok = true;
        for (const ex of exprs) {
          const res = await evaluator.evaluateIfCondition(checkId, ex, {
            event: context2.event || "manual",
            previousResults: dependencyResults
          });
          if (!res) {
            ok = false;
            break;
          }
        }
        if (!ok) {
          logger.info(
            `\u23ED  Skipped (assume: ${String(Array.isArray(assumeExpr) ? assumeExpr[0] : assumeExpr).substring(0, 40)}${String(Array.isArray(assumeExpr) ? assumeExpr[0] : assumeExpr).length > 40 ? "..." : ""})`
          );
          state.completedChecks.add(checkId);
          const stats = {
            checkName: checkId,
            totalRuns: 0,
            successfulRuns: 0,
            failedRuns: 0,
            skippedRuns: 0,
            skipped: true,
            skipReason: "assume",
            totalDuration: 0,
            issuesFound: 0,
            issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 }
          };
          state.stats.set(checkId, stats);
          const emptyResult = { issues: [] };
          try {
            Object.defineProperty(emptyResult, "__skipped", {
              value: "assume",
              enumerable: false
            });
          } catch {
          }
          try {
            context2.journal.commitEntry({
              sessionId: context2.sessionId,
              checkId,
              result: emptyResult,
              event: context2.event || "manual",
              scope
            });
          } catch {
          }
          emitEvent({ type: "CheckCompleted", checkId, scope, result: emptyResult });
          return emptyResult;
        }
      }
    } catch {
    }
    try {
      emitNdjsonFallback("visor.provider", {
        "visor.check.id": checkId,
        "visor.provider.type": providerType
      });
    } catch {
    }
    const result = await withActiveSpan(
      `visor.check.${checkId}`,
      { "visor.check.id": checkId, "visor.check.type": providerType },
      async () => provider.execute(prInfo, providerConfig, dependencyResults, executionContext)
    );
    const enrichedIssues = (result.issues || []).map((issue) => ({
      ...issue,
      checkName: checkId,
      ruleId: `${checkId}/${issue.ruleId || "unknown"}`,
      group: checkConfig2.group,
      schema: typeof checkConfig2.schema === "object" ? "custom" : checkConfig2.schema,
      template: checkConfig2.template,
      timestamp: Date.now()
    }));
    const enrichedResult = {
      ...result,
      issues: enrichedIssues
    };
    try {
      const schemaObj = (typeof checkConfig2.schema === "object" ? checkConfig2.schema : void 0) || checkConfig2.output_schema;
      if (schemaObj && enrichedResult?.output !== void 0) {
        const Ajv2 = __require("ajv");
        const ajv = new Ajv2({ allErrors: true, allowUnionTypes: true, strict: false });
        const validate = ajv.compile(schemaObj);
        const valid = validate(enrichedResult.output);
        if (!valid) {
          const errs = (validate.errors || []).slice(0, 3).map((e) => e.message).join("; ");
          const issue = {
            file: "contract",
            line: 0,
            ruleId: `contract/schema_validation_failed`,
            message: `Output schema validation failed${errs ? `: ${errs}` : ""}`,
            severity: "error",
            category: "logic",
            checkName: checkId,
            group: checkConfig2.group,
            schema: "json-schema",
            timestamp: Date.now()
          };
          enrichedResult.issues = [...enrichedResult.issues || [], issue];
        }
      }
    } catch {
    }
    try {
      const guaranteeExpr = checkConfig2?.guarantee;
      if (guaranteeExpr) {
        const evaluator = new FailureConditionEvaluator();
        const exprs = Array.isArray(guaranteeExpr) ? guaranteeExpr : [guaranteeExpr];
        for (const ex of exprs) {
          const holds = await evaluator.evaluateIfCondition(checkId, ex, {
            previousResults: dependencyResults,
            event: context2.event || "manual"
          });
          if (!holds) {
            const issue = {
              file: "contract",
              line: 0,
              ruleId: `contract/guarantee_failed`,
              message: `Guarantee failed: ${ex}`,
              severity: "error",
              category: "logic",
              checkName: checkId,
              group: checkConfig2.group,
              schema: typeof checkConfig2.schema === "object" ? "custom" : checkConfig2.schema,
              timestamp: Date.now()
            };
            enrichedResult.issues = [...enrichedResult.issues || [], issue];
          }
        }
      }
    } catch {
    }
    let isForEach = result.isForEach;
    let forEachItems2 = result.forEachItems;
    logger.info(
      `[LevelDispatch][DEBUG] After execution ${checkId}: checkConfig.forEach=${checkConfig2.forEach}, output type=${typeof result.output}, isArray=${Array.isArray(result.output)}`
    );
    if (checkConfig2.forEach === true) {
      const output = result.output;
      logger.info(
        `[LevelDispatch][DEBUG] Processing forEach=true for ${checkId}, output=${JSON.stringify(output)?.substring(0, 200)}`
      );
      if (output === void 0) {
        logger.error(`[LevelDispatch] forEach check "${checkId}" produced undefined output`);
        const undefinedError = {
          file: "system",
          line: 0,
          // Mark as execution failure so dependents treat this as failed dependency
          ruleId: "forEach/execution_error",
          message: `forEach check "${checkId}" produced undefined output. Verify your command outputs valid data and your transform_js returns a value.`,
          severity: "error",
          category: "logic"
        };
        enrichedResult.issues = [...enrichedResult.issues || [], undefinedError];
        isForEach = true;
        forEachItems2 = [];
        enrichedResult.isForEach = true;
        enrichedResult.forEachItems = [];
        try {
          if (!state.failedChecks) {
            state.failedChecks = /* @__PURE__ */ new Set();
          }
          state.failedChecks.add(checkId);
        } catch {
        }
        try {
          state.completedChecks.add(checkId);
          const currentWaveCompletions2 = state.currentWaveCompletions;
          if (currentWaveCompletions2) currentWaveCompletions2.add(checkId);
          const existing = state.stats.get(checkId);
          const aggStats = existing || {
            checkName: checkId,
            totalRuns: 0,
            successfulRuns: 0,
            failedRuns: 0,
            skippedRuns: 0,
            skipped: false,
            totalDuration: 0,
            issuesFound: 0,
            issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 }
          };
          aggStats.totalRuns++;
          aggStats.failedRuns++;
          aggStats.outputsProduced = 0;
          state.stats.set(checkId, aggStats);
          context2.journal.commitEntry({
            sessionId: context2.sessionId,
            checkId,
            result: enrichedResult,
            event: context2.event || "manual",
            scope: []
          });
        } catch (err) {
          logger.warn(`[LevelDispatch] Failed to persist undefined forEach result: ${err}`);
        }
        try {
          state.activeDispatches.delete(checkId);
        } catch {
        }
        emitEvent({
          type: "CheckCompleted",
          checkId,
          scope: [],
          result: enrichedResult
        });
        return enrichedResult;
      } else if (Array.isArray(output)) {
        isForEach = true;
        forEachItems2 = output;
        enrichedResult.isForEach = true;
        enrichedResult.forEachItems = output;
        logger.info(`  Found ${output.length} items for forEach iteration`);
        if (context2.debug) {
          logger.info(
            `[LevelDispatch] Check ${checkId} is forEach parent with ${output.length} items`
          );
        }
      } else {
        if (context2.debug) {
          logger.warn(
            `[LevelDispatch] Check ${checkId} has forEach:true but output is not an array: ${typeof output}, converting to single-item array`
          );
        }
        isForEach = true;
        forEachItems2 = [output];
        enrichedResult.isForEach = true;
        enrichedResult.forEachItems = [output];
      }
    }
    if (result.isForEach) {
      enrichedResult.isForEach = true;
    }
    if (result.forEachItems) {
      enrichedResult.forEachItems = result.forEachItems;
    }
    if (result.forEachItemResults) {
      enrichedResult.forEachItemResults = result.forEachItemResults;
    }
    if (result.forEachFatalMask) {
      enrichedResult.forEachFatalMask = result.forEachFatalMask;
    }
    let renderedContent;
    try {
      renderedContent = await renderTemplateContent(checkId, checkConfig2, enrichedResult);
      if (renderedContent) {
        emitMermaidFromMarkdown(checkId, renderedContent, "content");
      }
    } catch (error) {
      logger.warn(`[LevelDispatch] Failed to render template for ${checkId}: ${error}`);
    }
    if (!renderedContent && enrichedIssues.length > 0) {
      renderedContent = enrichedIssues.map(
        (i) => `- **${i.severity.toUpperCase()}**: ${i.message} (${i.file}:${i.line})`
      ).join("\n");
    }
    let outputWithTimestamp = void 0;
    if (result.output !== void 0) {
      const output = result.output;
      if (output !== null && typeof output === "object" && !Array.isArray(output)) {
        outputWithTimestamp = { ...output, ts: Date.now() };
      } else {
        outputWithTimestamp = output;
      }
    }
    const enrichedResultWithContent = renderedContent ? { ...enrichedResult, content: renderedContent } : enrichedResult;
    const enrichedResultWithTimestamp = outputWithTimestamp !== void 0 ? { ...enrichedResultWithContent, output: outputWithTimestamp } : enrichedResultWithContent;
    state.completedChecks.add(checkId);
    const currentWaveCompletions = state.currentWaveCompletions;
    if (currentWaveCompletions) {
      currentWaveCompletions.add(checkId);
    }
    try {
      logger.info(`[LevelDispatch] Calling handleRouting for ${checkId}`);
    } catch {
    }
    await handleRouting(context2, state, transition, emitEvent, {
      checkId,
      scope,
      result: enrichedResult,
      checkConfig: checkConfig2,
      success: !hasFatalIssues(enrichedResult)
    });
    try {
      const commitResult = {
        ...enrichedResult,
        ...renderedContent ? { content: renderedContent } : {},
        ...result.output !== void 0 ? outputWithTimestamp !== void 0 ? { output: outputWithTimestamp } : { output: result.output } : {}
      };
      context2.journal.commitEntry({
        sessionId: context2.sessionId,
        checkId,
        result: commitResult,
        event: context2.event || "manual",
        scope
      });
    } catch (error) {
      logger.warn(`[LevelDispatch] Failed to commit to journal: ${error}`);
    }
    if (isForEach) {
      try {
        const existing = state.stats.get(checkId);
        const aggStats = existing || {
          checkName: checkId,
          totalRuns: 0,
          successfulRuns: 0,
          failedRuns: 0,
          skippedRuns: 0,
          skipped: false,
          totalDuration: 0,
          issuesFound: 0,
          issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 }
        };
        aggStats.totalRuns++;
        const hasFatal = hasFatalIssues(enrichedResultWithTimestamp);
        if (hasFatal) aggStats.failedRuns++;
        else aggStats.successfulRuns++;
        const items = enrichedResultWithTimestamp.forEachItems;
        if (Array.isArray(items)) aggStats.outputsProduced = items.length;
        state.stats.set(checkId, aggStats);
      } catch {
      }
    }
    if (isForEach && forEachItems2 && Array.isArray(forEachItems2)) {
      for (let itemIndex = 0; itemIndex < forEachItems2.length; itemIndex++) {
        const itemScope = [
          { check: checkId, index: itemIndex }
        ];
        const item = forEachItems2[itemIndex];
        try {
          context2.journal.commitEntry({
            sessionId: context2.sessionId,
            checkId,
            result: { issues: [], output: item },
            event: context2.event || "manual",
            scope: itemScope
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
      type: "CheckCompleted",
      checkId,
      scope,
      result: {
        ...enrichedResult,
        output: result.output,
        content: renderedContent || result.content
      }
    });
    return enrichedResult;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(`[LevelDispatch] Error executing check ${checkId}: ${err.message}`);
    state.activeDispatches.delete(checkId);
    emitEvent({
      type: "CheckErrored",
      checkId,
      scope,
      error: {
        message: err.message,
        stack: err.stack,
        name: err.name
      }
    });
    throw err;
  }
}
function buildDependencyResultsWithScope(checkId, checkConfig, context2, scope) {
  const dependencyResults = /* @__PURE__ */ new Map();
  const dependencies = checkConfig.depends_on || [];
  const depList = Array.isArray(dependencies) ? dependencies : [dependencies];
  const currentIndex = scope.length > 0 ? scope[scope.length - 1].index : void 0;
  for (const depId of depList) {
    if (!depId) continue;
    try {
      const snapshotId = context2.journal.beginSnapshot();
      const visible = context2.journal.readVisible(
        context2.sessionId,
        snapshotId,
        context2.event
      );
      const sameScope = (a, b) => {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++)
          if (a[i].check !== b[i].check || a[i].index !== b[i].index) return false;
        return true;
      };
      const matches = visible.filter((e) => e.checkId === depId && sameScope(e.scope, scope));
      let journalResult = matches.length > 0 ? matches[matches.length - 1].result : void 0;
      if (journalResult && Array.isArray(journalResult.forEachItems) && currentIndex !== void 0) {
        const perItemSummary = journalResult.forEachItemResults && journalResult.forEachItemResults[currentIndex] || { issues: [] };
        const perItemOutput = journalResult.forEachItems[currentIndex];
        const combined = { ...perItemSummary, output: perItemOutput };
        dependencyResults.set(depId, combined);
        continue;
      }
      if (!journalResult) {
        try {
          const rawView = new (init_snapshot_store(), __toCommonJS(snapshot_store_exports)).ContextView(
            context2.journal,
            context2.sessionId,
            snapshotId,
            [],
            context2.event
          );
          const rawResult = rawView.get(depId);
          if (rawResult && Array.isArray(rawResult.forEachItems) && currentIndex !== void 0) {
            const perItemSummary = rawResult.forEachItemResults && rawResult.forEachItemResults[currentIndex] || { issues: [] };
            const perItemOutput = rawResult.forEachItems[currentIndex];
            const combined = { ...perItemSummary, output: perItemOutput };
            dependencyResults.set(depId, combined);
            continue;
          }
          journalResult = rawResult;
        } catch {
        }
      }
      if (journalResult) {
        dependencyResults.set(depId, journalResult);
        continue;
      }
    } catch {
    }
    dependencyResults.set(depId, { issues: [] });
  }
  try {
    const snapshotId = context2.journal.beginSnapshot();
    const contextView = new (init_snapshot_store(), __toCommonJS(snapshot_store_exports)).ContextView(
      context2.journal,
      context2.sessionId,
      snapshotId,
      scope,
      context2.event
    );
    const allCheckNames = Object.keys(context2.config.checks || {});
    for (const checkName of allCheckNames) {
      if (dependencyResults.has(checkName)) continue;
      let jr = contextView.get(checkName);
      if (jr && Array.isArray(jr.forEachItems) && currentIndex !== void 0) {
        const perItemSummary = jr.forEachItemResults && jr.forEachItemResults[currentIndex] || { issues: [] };
        const perItemOutput = jr.forEachItems[currentIndex];
        const combined = { ...perItemSummary, output: perItemOutput };
        dependencyResults.set(checkName, combined);
        continue;
      }
      if (!jr) {
        try {
          const rawView = new (init_snapshot_store(), __toCommonJS(snapshot_store_exports)).ContextView(
            context2.journal,
            context2.sessionId,
            snapshotId,
            [],
            context2.event
          );
          const raw = rawView.get(checkName);
          if (raw && Array.isArray(raw.forEachItems) && currentIndex !== void 0) {
            const perItemSummary = raw.forEachItemResults && raw.forEachItemResults[currentIndex] || { issues: [] };
            const perItemOutput = raw.forEachItems[currentIndex];
            const combined = { ...perItemSummary, output: perItemOutput };
            dependencyResults.set(checkName, combined);
            continue;
          }
          jr = raw;
        } catch {
        }
      }
      if (jr) {
        dependencyResults.set(checkName, jr);
      }
    }
    for (const checkName of allCheckNames) {
      const checkCfg = context2.config.checks?.[checkName];
      if (checkCfg?.forEach) {
        try {
          const rawContextView = new (init_snapshot_store(), __toCommonJS(snapshot_store_exports)).ContextView(
            context2.journal,
            context2.sessionId,
            snapshotId,
            [],
            // No scope - get parent-level result with forEachItems
            context2.event
          );
          const rawResult = rawContextView.get(checkName);
          if (rawResult && rawResult.forEachItems) {
            const rawKey = `${checkName}-raw`;
            dependencyResults.set(rawKey, {
              issues: [],
              output: rawResult.forEachItems
            });
          }
        } catch {
        }
      }
    }
  } catch {
  }
  return dependencyResults;
}
function buildDependencyResults(checkId, checkConfig, context2, _state) {
  return buildDependencyResultsWithScope(checkId, checkConfig, context2, []);
}
function shouldFailFast(results) {
  for (const { result } of results) {
    if (!result || !result.issues) continue;
    if (hasFatalIssues(result)) {
      return true;
    }
  }
  return false;
}
function hasFatalIssues(result) {
  if (!result.issues) {
    return false;
  }
  return result.issues.some((issue) => {
    const ruleId = issue.ruleId || "";
    return ruleId.endsWith("/error") || // System errors
    ruleId.includes("/execution_error") || // Command failures
    ruleId.endsWith("_fail_if");
  });
}
function updateStats(results, state, isForEachIteration = false) {
  for (const { checkId, result, error, duration } of results) {
    const existing = state.stats.get(checkId);
    const stats = existing || {
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
        info: 0
      }
    };
    if (checkId === "post-response") {
      logger.info(
        `[updateStats] Called for post-response: existing.skipped=${existing?.skipped}, stats.skipped=${stats.skipped}, skipReason=${stats.skipReason}`
      );
    }
    if (stats.skipped) {
      stats.skipped = false;
      if (checkId === "post-response") {
        logger.info(
          `[updateStats] Clearing skipped flag for post-response (was skipped, now executing)`
        );
      }
    }
    stats.totalRuns++;
    if (duration !== void 0) {
      stats.totalDuration += duration;
    }
    const hasExecutionFailure = result.issues?.some((issue) => {
      const ruleId = issue.ruleId || "";
      return ruleId.endsWith("/error") || // System errors, exceptions
      ruleId.includes("/execution_error") || // Command failures
      ruleId.endsWith("_fail_if");
    });
    if (error) {
      stats.failedRuns++;
      stats.errorMessage = error.message;
      if (!isForEachIteration) {
        if (!state.failedChecks) {
          state.failedChecks = /* @__PURE__ */ new Set();
        }
        state.failedChecks.add(checkId);
      }
    } else if (hasExecutionFailure) {
      stats.failedRuns++;
      if (!isForEachIteration) {
        if (!state.failedChecks) {
          state.failedChecks = /* @__PURE__ */ new Set();
        }
        state.failedChecks.add(checkId);
      }
    } else {
      stats.successfulRuns++;
    }
    if (result.issues) {
      stats.issuesFound += result.issues.length;
      for (const issue of result.issues) {
        if (issue.severity === "critical") stats.issuesBySeverity.critical++;
        else if (issue.severity === "error") stats.issuesBySeverity.error++;
        else if (issue.severity === "warning") stats.issuesBySeverity.warning++;
        else if (issue.severity === "info") stats.issuesBySeverity.info++;
      }
    }
    if (stats.outputsProduced === void 0) {
      const forEachItems = result.forEachItems;
      if (Array.isArray(forEachItems)) {
        stats.outputsProduced = forEachItems.length;
      } else if (result.output !== void 0) {
        stats.outputsProduced = 1;
      }
    }
    state.stats.set(checkId, stats);
  }
}
async function renderTemplateContent(checkId, checkConfig, reviewSummary) {
  try {
    const { createExtendedLiquid: createExtendedLiquid2 } = await import("./liquid-extensions-X6CDR654.mjs");
    const fs6 = await import("fs/promises");
    const path6 = await import("path");
    const schemaRaw = checkConfig.schema || "plain";
    const schema = typeof schemaRaw === "string" ? schemaRaw : "code-review";
    let templateContent;
    if (checkConfig.template && checkConfig.template.content) {
      templateContent = String(checkConfig.template.content);
    } else if (checkConfig.template && checkConfig.template.file) {
      const file = String(checkConfig.template.file);
      const resolved = path6.resolve(process.cwd(), file);
      templateContent = await fs6.readFile(resolved, "utf-8");
    } else if (schema && schema !== "plain") {
      const sanitized = String(schema).replace(/[^a-zA-Z0-9-]/g, "");
      if (sanitized) {
        const candidatePaths = [
          // When bundled (dist), __dirname points to dist/state-machine/states
          path6.join(__dirname, "..", "..", "output", sanitized, "template.liquid"),
          // Dev fallback
          path6.join(process.cwd(), "output", sanitized, "template.liquid")
        ];
        for (const p of candidatePaths) {
          try {
            templateContent = await fs6.readFile(p, "utf-8");
            if (templateContent) break;
          } catch {
          }
        }
      }
    }
    if (!templateContent) {
      return void 0;
    }
    const liquid = createExtendedLiquid2({
      trimTagLeft: false,
      trimTagRight: false,
      trimOutputLeft: false,
      trimOutputRight: false,
      greedy: false
    });
    const templateData = {
      issues: reviewSummary.issues || [],
      checkName: checkId,
      output: reviewSummary.output
    };
    const rendered = await liquid.parseAndRender(templateContent, templateData);
    return rendered.trim();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`[LevelDispatch] Failed to render template for ${checkId}: ${msg}`);
    return void 0;
  }
}
var init_level_dispatch = __esm({
  "src/state-machine/states/level-dispatch.ts"() {
    "use strict";
    init_logger();
    init_routing();
    init_trace_helpers();
    init_mermaid_telemetry();
    init_fallback_ndjson();
    init_failure_condition_evaluator();
  }
});

// src/state-machine/states/check-running.ts
async function handleCheckRunning(_context, _state, transition, _emitEvent) {
  transition("WavePlanning");
}
var init_check_running = __esm({
  "src/state-machine/states/check-running.ts"() {
    "use strict";
  }
});

// src/state-machine/states/completed.ts
async function handleCompleted(context2, state) {
  if (context2.debug) {
    logger.info("[Completed] Execution complete");
    logger.info(`[Completed] Total waves: ${state.wave + 1}`);
    logger.info(`[Completed] Checks completed: ${state.completedChecks.size}`);
    logger.info(`[Completed] Stats collected: ${state.stats.size}`);
  }
  if (context2.gitHubChecks) {
    if (context2.debug) {
      logger.info("[Completed] GitHub checks will be finalized by main engine");
    }
  }
}
var init_completed = __esm({
  "src/state-machine/states/completed.ts"() {
    "use strict";
    init_logger();
  }
});

// src/state-machine/states/error.ts
async function handleError(context2, state) {
  logger.error("[Error] State machine entered error state");
  const errorEvent = state.eventQueue.find((e) => e.type === "Shutdown" && e.error);
  if (errorEvent && errorEvent.type === "Shutdown" && errorEvent.error) {
    logger.error(`[Error] Fatal error: ${errorEvent.error.message}`);
    if (errorEvent.error.stack) {
      logger.error(`[Error] Stack: ${errorEvent.error.stack}`);
    }
  }
  if (context2.debug) {
    logger.info(`[Error] Completed ${state.completedChecks.size} checks before error`);
    logger.info(`[Error] Active dispatches: ${state.activeDispatches.size}`);
  }
}
var init_error = __esm({
  "src/state-machine/states/error.ts"() {
    "use strict";
    init_logger();
  }
});

// src/state-machine/runner.ts
var runner_exports = {};
__export(runner_exports, {
  StateMachineRunner: () => StateMachineRunner
});
var StateMachineRunner;
var init_runner = __esm({
  "src/state-machine/runner.ts"() {
    "use strict";
    init_logger();
    init_trace_helpers();
    init_init();
    init_plan_ready();
    init_wave_planning();
    init_level_dispatch();
    init_check_running();
    init_completed();
    init_error();
    StateMachineRunner = class {
      context;
      state;
      debugServer;
      constructor(context2, debugServer) {
        this.context = context2;
        this.state = this.initializeState();
        this.debugServer = debugServer;
      }
      /**
       * Initialize the run state
       */
      initializeState() {
        const DEFAULT_MAX_WORKFLOW_DEPTH = 3;
        const configuredMaxDepth = (this.context && this.context.config && this.context.config.limits ? this.context.config.limits.max_workflow_depth : void 0) ?? DEFAULT_MAX_WORKFLOW_DEPTH;
        return {
          currentState: "Init",
          wave: 0,
          levelQueue: [],
          eventQueue: [],
          activeDispatches: /* @__PURE__ */ new Map(),
          completedChecks: /* @__PURE__ */ new Set(),
          flags: {
            failFastTriggered: false,
            forwardRunRequested: false,
            // Maximum nesting depth for nested workflows (configurable)
            maxWorkflowDepth: configuredMaxDepth,
            currentWorkflowDepth: 0
            // Start at root level
          },
          stats: /* @__PURE__ */ new Map(),
          historyLog: [],
          forwardRunGuards: /* @__PURE__ */ new Set(),
          currentLevelChecks: /* @__PURE__ */ new Set(),
          routingLoopCount: 0,
          pendingRunScopes: /* @__PURE__ */ new Map()
        };
      }
      /**
       * Execute the state machine
       */
      async run() {
        try {
          this.emitEvent({ type: "StateTransition", from: "Init", to: "Init" });
          while (!this.isTerminalState(this.state.currentState)) {
            const currentState = this.state.currentState;
            if (this.context.debug) {
              logger.info(`[StateMachine] State: ${currentState}, Wave: ${this.state.wave}`);
            }
            await this.executeState(currentState);
            if (this.state.currentState === "Error") {
              break;
            }
          }
          return this.buildExecutionResult();
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          logger.error(`[StateMachine] Fatal error: ${errorMsg}`);
          const serializedError = {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : void 0,
            name: error instanceof Error ? error.name : void 0
          };
          this.emitEvent({ type: "Shutdown", error: serializedError });
          throw error;
        }
      }
      /**
       * Execute a specific state handler
       * M4: Wraps each state execution in an OTEL span for observability
       */
      async executeState(state) {
        return withActiveSpan(
          `engine.state.${state.toLowerCase()}`,
          {
            state,
            engine_mode: this.context.mode,
            wave: this.state.wave,
            session_id: this.context.sessionId
          },
          async () => {
            try {
              switch (state) {
                case "Init":
                  await handleInit(this.context, this.state, this.transition.bind(this));
                  break;
                case "PlanReady":
                  await handlePlanReady(this.context, this.state, this.transition.bind(this));
                  break;
                case "WavePlanning":
                  await handleWavePlanning(this.context, this.state, this.transition.bind(this));
                  break;
                case "LevelDispatch":
                  await handleLevelDispatch(
                    this.context,
                    this.state,
                    this.transition.bind(this),
                    this.emitEvent.bind(this)
                  );
                  break;
                case "CheckRunning":
                  await handleCheckRunning(
                    this.context,
                    this.state,
                    this.transition.bind(this),
                    this.emitEvent.bind(this)
                  );
                  break;
                case "Routing":
                  throw new Error("Routing state should be handled by CheckRunning");
                case "Completed":
                  await handleCompleted(this.context, this.state);
                  break;
                case "Error":
                  await handleError(this.context, this.state);
                  break;
                default:
                  throw new Error(`Unknown state: ${state}`);
              }
            } catch (error) {
              const errorMsg = error instanceof Error ? error.message : String(error);
              logger.error(`[StateMachine] Error in state ${state}: ${errorMsg}`);
              const serializedError = {
                message: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : void 0,
                name: error instanceof Error ? error.name : void 0
              };
              this.emitEvent({ type: "Shutdown", error: serializedError });
              this.state.currentState = "Error";
              throw error;
            }
          }
        );
      }
      /**
       * Transition to a new state
       * M4: Emits OTEL span for the transition with state metadata
       */
      transition(newState) {
        const oldState = this.state.currentState;
        this.state.currentState = newState;
        const transitionEvent = { type: "StateTransition", from: oldState, to: newState };
        this.emitEvent(transitionEvent);
        try {
          addEvent("engine.state_transition", {
            state_from: oldState,
            state_to: newState,
            engine_mode: this.context.mode,
            wave: this.state.wave,
            session_id: this.context.sessionId
          });
        } catch (_err) {
        }
        if (this.context.debug) {
          logger.info(`[StateMachine] Transition: ${oldState} -> ${newState}`);
        }
      }
      /**
       * Emit an engine event
       * M4: Streams events to debug visualizer for time-travel debugging
       */
      emitEvent(event) {
        this.state.historyLog.push(event);
        if (event.type === "ForwardRunRequested" || event.type === "WaveRetry") {
          this.state.eventQueue.push(event);
        }
        if (this.debugServer) {
          try {
            this.streamEventToDebugServer(event);
          } catch (_err) {
          }
        }
        if (this.context.debug && event.type !== "StateTransition") {
          logger.debug(`[StateMachine] Event: ${event.type}`);
        }
      }
      /**
       * Stream an engine event to debug visualizer (M4)
       * Converts EngineEvent to ProcessedSpan format for visualization
       */
      streamEventToDebugServer(event) {
        if (!this.debugServer) return;
        const timestamp = process.hrtime();
        const span = {
          traceId: this.context.sessionId,
          spanId: `${event.type}-${Date.now()}`,
          name: `engine.event.${event.type.toLowerCase()}`,
          startTime: timestamp,
          endTime: timestamp,
          duration: 0,
          attributes: {
            event_type: event.type,
            engine_mode: this.context.mode,
            wave: this.state.wave,
            session_id: this.context.sessionId,
            ...this.extractEventAttributes(event)
          },
          events: [],
          status: "ok"
        };
        this.debugServer.emitSpan(span);
      }
      /**
       * Extract type-specific attributes from engine events
       */
      extractEventAttributes(event) {
        switch (event.type) {
          case "StateTransition":
            return { state_from: event.from, state_to: event.to };
          case "CheckScheduled":
          case "CheckCompleted":
          case "CheckErrored":
            return {
              check_id: event.checkId,
              scope: event.scope?.join(".") || ""
            };
          case "ForwardRunRequested":
            return {
              target: event.target,
              goto_event: event.gotoEvent,
              scope: event.scope?.join(".") || ""
            };
          case "WaveRetry":
            return { reason: event.reason };
          case "Shutdown":
            return {
              error: event.error?.message
            };
          default:
            return {};
        }
      }
      /**
       * Check if a state is terminal
       */
      isTerminalState(state) {
        return state === "Completed" || state === "Error";
      }
      /**
       * Build the final execution result
       */
      buildExecutionResult() {
        const stats = Array.from(this.state.stats.values());
        stats.sort((a, b) => (b.errorMessage ? 1 : 0) - (a.errorMessage ? 1 : 0));
        const results = this.aggregateResultsFromJournal();
        let totalDuration = 0;
        for (const stat of stats) {
          totalDuration = Math.max(totalDuration, stat.totalDuration);
        }
        try {
          for (const s of stats) {
            const sumSF = (s.successfulRuns || 0) + (s.failedRuns || 0);
            if (s.totalRuns !== void 0 && sumSF !== s.totalRuns) {
              if (sumSF > s.totalRuns) {
                const failures = Math.min(s.failedRuns || 0, s.totalRuns);
                s.failedRuns = failures;
                s.successfulRuns = Math.max(0, s.totalRuns - failures);
              } else {
                s.successfulRuns = (s.successfulRuns || 0) + (s.totalRuns - sumSF);
              }
            }
          }
        } catch {
        }
        if (this.context.debug) {
          logger.info("[StateMachine][Stats] Final statistics breakdown:");
          for (const s of stats) {
            logger.info(
              `  ${s.checkName}: totalRuns=${s.totalRuns}, successful=${s.successfulRuns}, failed=${s.failedRuns}`
            );
          }
          logger.info(
            `[StateMachine][Stats] Total: ${this.state.stats.size} configured, ${stats.reduce((sum, s) => sum + s.totalRuns, 0)} executions`
          );
        }
        return {
          results,
          statistics: {
            totalChecksConfigured: this.state.stats.size,
            totalExecutions: stats.reduce((sum, s) => sum + s.totalRuns, 0),
            successfulExecutions: stats.reduce((sum, s) => sum + s.successfulRuns, 0),
            failedExecutions: stats.reduce((sum, s) => sum + s.failedRuns, 0),
            skippedChecks: stats.filter((s) => s.skipped).length,
            totalDuration,
            checks: stats
          }
        };
      }
      /**
       * Aggregate results from journal into GroupedCheckResults format
       * This matches the format returned by the legacy engine
       */
      aggregateResultsFromJournal() {
        const groupedResults = {};
        const allEntries = this.context.journal.readVisible(
          this.context.sessionId,
          this.context.journal.beginSnapshot(),
          void 0
        );
        const checkEntries = /* @__PURE__ */ new Map();
        for (const entry of allEntries) {
          const existing = checkEntries.get(entry.checkId) || [];
          existing.push(entry);
          checkEntries.set(entry.checkId, existing);
        }
        for (const [checkId, entries] of checkEntries) {
          const checkConfig = this.context.config.checks?.[checkId];
          if (!checkConfig && checkId === "system") {
            const latestEntry = entries[entries.length - 1];
            if (latestEntry && latestEntry.result.issues) {
              if (!groupedResults["system"]) {
                groupedResults["system"] = [];
              }
              groupedResults["system"].push({
                checkName: "system",
                content: "",
                group: "system",
                output: void 0,
                debug: void 0,
                issues: latestEntry.result.issues
              });
            }
            continue;
          }
          if (!checkConfig) continue;
          const group = checkConfig.group || checkId;
          let content = "";
          let output = void 0;
          const allIssues = [];
          let debug = void 0;
          if (checkConfig.forEach && entries.length > 1) {
            const contents = [];
            for (const entry of entries) {
              if (entry.result.content) {
                contents.push(entry.result.content);
              }
              if (entry.result.issues) {
                allIssues.push(...entry.result.issues);
              }
              if (entry.result.debug) {
                debug = entry.result.debug;
              }
              if (entry.result.output !== void 0) {
                output = entry.result.output;
              }
            }
            content = contents.join("\n");
          } else {
            const latestEntry = entries[entries.length - 1];
            if (latestEntry) {
              content = latestEntry.result.content || "";
              output = latestEntry.result.output;
              if (latestEntry.result.issues) {
                allIssues.push(...latestEntry.result.issues);
              }
              debug = latestEntry.result.debug;
            }
          }
          const checkResult = {
            checkName: checkId,
            content,
            group,
            output,
            debug,
            issues: allIssues
          };
          if (!groupedResults[group]) {
            groupedResults[group] = [];
          }
          groupedResults[group].push(checkResult);
        }
        const suppressionEnabled = this.context.config.output?.suppressionEnabled ?? true;
        if (suppressionEnabled) {
          const { IssueFilter: IssueFilter2 } = (init_issue_filter(), __toCommonJS(issue_filter_exports));
          const filter = new IssueFilter2(true);
          for (const group of Object.keys(groupedResults)) {
            for (const checkResult of groupedResults[group]) {
              if (checkResult.issues && checkResult.issues.length > 0) {
                checkResult.issues = filter.filterIssues(
                  checkResult.issues,
                  this.context.workingDirectory
                );
              }
            }
          }
        }
        return groupedResults;
      }
      /**
       * Get current run state (for debugging/testing)
       */
      getState() {
        return this.state;
      }
      /**
       * Bubble an event to parent context (nested workflows support)
       * This allows nested workflows to trigger re-runs in parent workflows
       */
      bubbleEventToParent(event) {
        if (this.state.parentContext && this.state.parentContext.mode === "state-machine") {
          if (this.context.debug) {
            logger.info(`[StateMachine] Bubbling event to parent: ${event.type}`);
          }
          if (!this.state.parentContext._bubbledEvents) {
            this.state.parentContext._bubbledEvents = [];
          }
          this.state.parentContext._bubbledEvents.push(event);
        }
      }
    };
  }
});

// src/state-machine/context/build-engine-context.ts
var build_engine_context_exports = {};
__export(build_engine_context_exports, {
  buildEngineContextForRun: () => buildEngineContextForRun
});
import { v4 as uuidv4 } from "uuid";
function applyCriticalityDefaults(cfg) {
  const checks = cfg.checks || {};
  for (const id of Object.keys(checks)) {
    const c = checks[id];
    if (!c.criticality) {
      c.criticality = "policy";
    }
    if (c.criticality === "non-critical" && typeof c.continue_on_failure === "undefined") {
      c.continue_on_failure = true;
    }
  }
}
function buildEngineContextForRun(workingDirectory, config, prInfo, debug, maxParallelism, failFast, requestedChecks) {
  const clonedConfig = JSON.parse(JSON.stringify(config));
  const checks = {};
  applyCriticalityDefaults(clonedConfig);
  for (const [checkId, checkConfig] of Object.entries(clonedConfig.checks || {})) {
    checks[checkId] = {
      tags: checkConfig.tags || [],
      triggers: (Array.isArray(checkConfig.on) ? checkConfig.on : [checkConfig.on]).filter(
        Boolean
      ),
      group: checkConfig.group,
      providerType: checkConfig.type || "ai",
      dependencies: checkConfig.depends_on || []
    };
  }
  if (requestedChecks && requestedChecks.length > 0) {
    for (const checkName of requestedChecks) {
      if (!checks[checkName] && !clonedConfig.checks?.[checkName]) {
        logger.debug(`[StateMachine] Synthesizing minimal config for legacy check: ${checkName}`);
        if (!clonedConfig.checks) {
          clonedConfig.checks = {};
        }
        clonedConfig.checks[checkName] = {
          type: "ai",
          prompt: `Perform ${checkName} analysis`
        };
        checks[checkName] = {
          tags: [],
          triggers: [],
          group: "default",
          providerType: "ai",
          dependencies: []
        };
      }
    }
  }
  const journal = new ExecutionJournal();
  const memory = MemoryStore.getInstance(clonedConfig.memory);
  return {
    mode: "state-machine",
    config: clonedConfig,
    checks,
    journal,
    memory,
    workingDirectory,
    sessionId: uuidv4(),
    event: prInfo.eventType,
    debug,
    maxParallelism,
    failFast,
    requestedChecks: requestedChecks && requestedChecks.length > 0 ? requestedChecks : void 0,
    // Store prInfo for later access (e.g., in getOutputHistorySnapshot)
    prInfo
  };
}
var init_build_engine_context = __esm({
  "src/state-machine/context/build-engine-context.ts"() {
    "use strict";
    init_snapshot_store();
    init_memory_store();
    init_logger();
  }
});

// src/state-machine/execution/summary.ts
var summary_exports = {};
__export(summary_exports, {
  convertToReviewSummary: () => convertToReviewSummary
});
function convertToReviewSummary(groupedResults, statistics) {
  const allIssues = [];
  for (const checkResults of Object.values(groupedResults)) {
    for (const checkResult of checkResults) {
      if (checkResult.issues && checkResult.issues.length > 0) {
        allIssues.push(...checkResult.issues);
      }
    }
  }
  if (statistics) {
    for (const checkStats of statistics.checks) {
      if (checkStats.errorMessage) {
        allIssues.push({
          file: "system",
          line: 0,
          endLine: void 0,
          ruleId: "system/error",
          message: checkStats.errorMessage,
          severity: "error",
          category: "logic",
          suggestion: void 0,
          replacement: void 0
        });
      }
    }
  }
  return {
    issues: allIssues
  };
}
var init_summary = __esm({
  "src/state-machine/execution/summary.ts"() {
    "use strict";
  }
});

// src/state-machine-execution-engine.ts
init_runner();
init_logger();
var StateMachineExecutionEngine = class _StateMachineExecutionEngine {
  workingDirectory;
  executionContext;
  debugServer;
  _lastContext;
  _lastRunner;
  constructor(workingDirectory, octokit, debugServer) {
    this.workingDirectory = workingDirectory || process.cwd();
    this.debugServer = debugServer;
  }
  /**
   * Execute checks using the state machine engine
   *
   * Converts CheckExecutionOptions -> executeGroupedChecks() -> AnalysisResult
   */
  async executeChecks(options) {
    const startTime = Date.now();
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    try {
      if (options.config?.memory) {
        const { MemoryStore: MemoryStore2 } = await import("./memory-store-7BG57SLO.mjs");
        const memoryStore = MemoryStore2.getInstance(options.config.memory);
        await memoryStore.initialize();
        logger.debug("Memory store initialized");
      }
      const { GitRepositoryAnalyzer } = await import("./git-repository-analyzer-HJC4MYW4.mjs");
      const gitAnalyzer = new GitRepositoryAnalyzer(options.workingDirectory);
      logger.info("Analyzing local git repository...");
      const repositoryInfo = await gitAnalyzer.analyzeRepository();
      if (!repositoryInfo.isGitRepository) {
        return this.createErrorResult(
          repositoryInfo,
          "Not a git repository or no changes found",
          startTime,
          timestamp,
          options.checks
        );
      }
      const prInfo = gitAnalyzer.toPRInfo(repositoryInfo);
      try {
        const evt = options.webhookContext?.eventType;
        if (evt) prInfo.eventType = evt;
      } catch {
      }
      const filteredChecks = this.filterChecksByTags(
        options.checks,
        options.config,
        options.tagFilter || options.config?.tag_filter
      );
      if (filteredChecks.length === 0) {
        logger.warn("No checks match the tag filter criteria");
        return this.createErrorResult(
          repositoryInfo,
          "No checks match the tag filter criteria",
          startTime,
          timestamp,
          options.checks
        );
      }
      logger.info(`Executing checks: ${filteredChecks.join(", ")}`);
      const executionResult = await this.executeGroupedChecks(
        prInfo,
        filteredChecks,
        options.timeout,
        options.config,
        options.outputFormat,
        options.debug,
        options.maxParallelism,
        options.failFast,
        options.tagFilter
      );
      const executionTime = Date.now() - startTime;
      const reviewSummary = this.convertGroupedResultsToReviewSummary(
        executionResult.results,
        executionResult.statistics
      );
      let debugInfo;
      if (options.debug && reviewSummary.debug) {
        debugInfo = {
          provider: reviewSummary.debug.provider,
          model: reviewSummary.debug.model,
          processingTime: reviewSummary.debug.processingTime,
          parallelExecution: options.checks.length > 1,
          checksExecuted: options.checks,
          totalApiCalls: reviewSummary.debug.totalApiCalls || options.checks.length,
          apiCallDetails: reviewSummary.debug.apiCallDetails
        };
      }
      try {
        const histSnap = this.getOutputHistorySnapshot();
        reviewSummary.history = histSnap;
      } catch {
      }
      return {
        repositoryInfo,
        reviewSummary,
        executionTime,
        timestamp,
        checksExecuted: filteredChecks,
        executionStatistics: executionResult.statistics,
        debug: debugInfo
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error occurred";
      logger.error("Error executing checks: " + message);
      const strictEnv = process.env.VISOR_STRICT_ERRORS === "true";
      if (strictEnv) {
        throw error;
      }
      const fallbackRepositoryInfo = {
        title: "Error during analysis",
        body: `Error: ${message || "Unknown error"}`,
        author: "system",
        base: "main",
        head: "HEAD",
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
        isGitRepository: false,
        workingDirectory: options.workingDirectory || process.cwd()
      };
      return this.createErrorResult(
        fallbackRepositoryInfo,
        message || "Unknown error occurred",
        startTime,
        timestamp,
        options.checks
      );
    }
  }
  /**
   * Get execution context (used by state machine to propagate hooks)
   */
  getExecutionContext() {
    return this.executionContext;
  }
  /**
   * Set execution context for external callers
   */
  setExecutionContext(context2) {
    this.executionContext = context2;
  }
  /**
   * Reset per-run state (no-op for state machine engine)
   *
   * The state machine engine is stateless per-run by design.
   * Each execution creates a fresh journal and context.
   * This method exists only for backward compatibility with test framework.
   *
   * @deprecated This is a no-op. State machine engine doesn't maintain per-run state.
   */
  resetPerRunState() {
  }
  /**
   * Execute grouped checks using the state machine engine
   *
   * M4: Production-ready with full telemetry and debug server support
   */
  async executeGroupedChecks(prInfo, checks, timeout, config, outputFormat, debug, maxParallelism, failFast, tagFilter, _pauseGate) {
    if (debug) {
      logger.info("[StateMachine] Using state machine engine");
    }
    if (!config) {
      const { ConfigManager } = await import("./config-USQ6FOO5.mjs");
      const configManager = new ConfigManager();
      config = await configManager.getDefaultConfig();
      logger.debug("[StateMachine] Using default configuration (no config provided)");
    }
    const configWithTagFilter = tagFilter ? {
      ...config,
      tag_filter: tagFilter
    } : config;
    const context2 = this.buildEngineContext(
      configWithTagFilter,
      prInfo,
      debug,
      maxParallelism,
      failFast,
      checks
      // Pass the explicit checks list
    );
    context2.executionContext = this.getExecutionContext();
    this._lastContext = context2;
    const runner = new StateMachineRunner(context2, this.debugServer);
    this._lastRunner = runner;
    const result = await runner.run();
    if (debug) {
      logger.info("[StateMachine] Execution complete");
    }
    try {
      if (this.executionContext?.mode?.postGroupedComments && configWithTagFilter?.output?.pr_comment) {
        const { PRReviewer } = await import("./reviewer-U53XU57J.mjs");
        const reviewer = new PRReviewer(
          this._lastContext?.executionContext?.octokit
        );
        let owner;
        let repo;
        try {
          const anyInfo = prInfo;
          owner = anyInfo?.eventContext?.repository?.owner?.login || owner;
          repo = anyInfo?.eventContext?.repository?.name || repo;
        } catch {
        }
        owner = owner || (process.env.GITHUB_REPOSITORY || "owner/repo").split("/")[0];
        repo = repo || (process.env.GITHUB_REPOSITORY || "owner/repo").split("/")[1];
        if (owner && repo && prInfo.number) {
          await reviewer.postReviewComment(owner, repo, prInfo.number, result.results, {
            config: configWithTagFilter,
            triggeredBy: prInfo.eventType || "manual",
            commentId: "visor-review",
            octokitOverride: prInfo?.eventContext?.octokit,
            commitSha: prInfo?.eventContext?.pull_request?.head?.sha
          });
        }
      }
    } catch (err) {
      logger.debug(`[StateMachine] Skipped postGroupedComments due to error: ${err}`);
    }
    try {
      const { SessionRegistry } = await import("./session-registry-N5FFYFTM.mjs");
      const sessionRegistry = SessionRegistry.getInstance();
      sessionRegistry.clearAllSessions();
    } catch (error) {
      logger.debug(`[StateMachine] Failed to cleanup sessions: ${error}`);
    }
    return result;
  }
  /**
   * Build the engine context for state machine execution
   */
  buildEngineContext(config, prInfo, debug, maxParallelism, failFast, requestedChecks) {
    const { buildEngineContextForRun: buildEngineContextForRun2 } = (init_build_engine_context(), __toCommonJS(build_engine_context_exports));
    return buildEngineContextForRun2(
      this.workingDirectory,
      config,
      prInfo,
      debug,
      maxParallelism,
      failFast,
      requestedChecks
    );
  }
  /**
   * Get output history snapshot for test framework compatibility
   * Extracts output history from the journal
   */
  getOutputHistorySnapshot() {
    const journal = this._lastContext?.journal;
    if (!journal) {
      logger.debug("[StateMachine][DEBUG] getOutputHistorySnapshot: No journal found");
      return {};
    }
    const sessionId = this._lastContext?.sessionId;
    if (!sessionId) {
      logger.debug("[StateMachine][DEBUG] getOutputHistorySnapshot: No sessionId found");
      return {};
    }
    const snapshot = journal.beginSnapshot();
    const allEntries = journal.readVisible(sessionId, snapshot, void 0);
    logger.debug(
      `[StateMachine][DEBUG] getOutputHistorySnapshot: Found ${allEntries.length} journal entries`
    );
    const outputHistory = {};
    for (const entry of allEntries) {
      const checkId = entry.checkId;
      if (!outputHistory[checkId]) {
        outputHistory[checkId] = [];
      }
      if (entry.result.output !== void 0) {
        outputHistory[checkId].push(entry.result.output);
      }
    }
    logger.debug(
      `[StateMachine][DEBUG] getOutputHistorySnapshot result: ${JSON.stringify(Object.keys(outputHistory))}`
    );
    for (const [checkId, outputs] of Object.entries(outputHistory)) {
      logger.debug(`[StateMachine][DEBUG]   ${checkId}: ${outputs.length} outputs`);
    }
    return outputHistory;
  }
  /**
   * Save a JSON snapshot of the last run's state and journal to a file (experimental).
   * Does not include secrets. Intended for debugging and future resume support.
   */
  async saveSnapshotToFile(filePath) {
    const fs6 = await import("fs/promises");
    const ctx = this._lastContext;
    const runner = this._lastRunner;
    if (!ctx || !runner) {
      throw new Error("No prior execution context to snapshot");
    }
    const journal = ctx.journal;
    const snapshotId = journal.beginSnapshot();
    const entries = journal.readVisible(ctx.sessionId, snapshotId, void 0);
    const state = runner.getState();
    const serializableState = serializeRunState(state);
    const payload = {
      version: 1,
      sessionId: ctx.sessionId,
      event: ctx.event,
      wave: state.wave,
      state: serializableState,
      journal: entries,
      requestedChecks: ctx.requestedChecks || []
    };
    await fs6.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
  }
  /**
   * Load a snapshot JSON from file and return it. Resume support can build on this.
   */
  async loadSnapshotFromFile(filePath) {
    const fs6 = await import("fs/promises");
    const raw = await fs6.readFile(filePath, "utf8");
    return JSON.parse(raw);
  }
  /**
   * Filter checks by tag filter
   */
  filterChecksByTags(checks, config, tagFilter) {
    return checks.filter((checkName) => {
      const checkConfig = config?.checks?.[checkName];
      if (!checkConfig) {
        return true;
      }
      const checkTags = checkConfig.tags || [];
      if (!tagFilter || !tagFilter.include && !tagFilter.exclude) {
        return checkTags.length === 0;
      }
      if (checkTags.length === 0) {
        return true;
      }
      if (tagFilter.exclude && tagFilter.exclude.length > 0) {
        const hasExcludedTag = tagFilter.exclude.some((tag) => checkTags.includes(tag));
        if (hasExcludedTag) return false;
      }
      if (tagFilter.include && tagFilter.include.length > 0) {
        const hasIncludedTag = tagFilter.include.some((tag) => checkTags.includes(tag));
        if (!hasIncludedTag) return false;
      }
      return true;
    });
  }
  /**
   * Create an error result in AnalysisResult format
   */
  createErrorResult(repositoryInfo, errorMessage, startTime, timestamp, checksExecuted) {
    const executionTime = Date.now() - startTime;
    return {
      repositoryInfo,
      reviewSummary: {
        issues: [
          {
            file: "system",
            line: 0,
            endLine: void 0,
            ruleId: "system/error",
            message: errorMessage,
            severity: "error",
            category: "logic",
            suggestion: void 0,
            replacement: void 0
          }
        ]
      },
      executionTime,
      timestamp,
      checksExecuted
    };
  }
  /**
   * Convert GroupedCheckResults to ReviewSummary
   * Aggregates all check results into a single ReviewSummary
   */
  convertGroupedResultsToReviewSummary(groupedResults, statistics) {
    const { convertToReviewSummary: convertToReviewSummary2 } = (init_summary(), __toCommonJS(summary_exports));
    return convertToReviewSummary2(groupedResults, statistics);
  }
  /**
   * Evaluate failure conditions for a check result
   *
   * This method provides backward compatibility with the legacy engine by
   * delegating to the FailureConditionEvaluator.
   *
   * @param checkName - The name of the check being evaluated
   * @param reviewSummary - The review summary containing check results
   * @param config - The Visor configuration containing failure conditions
   * @param previousOutputs - Optional previous check outputs for cross-check conditions
   * @param authorAssociation - Optional GitHub author association for permission checks
   * @returns Array of failure condition evaluation results
   */
  async evaluateFailureConditions(checkName, reviewSummary, config, previousOutputs, authorAssociation) {
    const { FailureConditionEvaluator: FailureConditionEvaluator2 } = await import("./failure-condition-evaluator-DKTLNNUN.mjs");
    const evaluator = new FailureConditionEvaluator2();
    const { addEvent: addEvent2 } = await import("./trace-helpers-VP6QYVBX.mjs");
    const { addFailIfTriggered } = await import("./metrics-7PP3EJUH.mjs");
    const checkConfig = config.checks?.[checkName];
    if (!checkConfig) {
      return [];
    }
    const rawSchema = checkConfig.schema || "code-review";
    const checkSchema = typeof rawSchema === "string" ? rawSchema : "code-review";
    const checkGroup = checkConfig.group || "default";
    const results = [];
    if (config.fail_if) {
      const failed = await evaluator.evaluateSimpleCondition(
        checkName,
        checkSchema,
        checkGroup,
        reviewSummary,
        config.fail_if,
        previousOutputs || {}
      );
      try {
        addEvent2("fail_if.evaluated", {
          "visor.check.id": checkName,
          scope: "global",
          expression: String(config.fail_if),
          result: failed ? "triggered" : "not_triggered"
        });
        if (failed) {
          addEvent2("fail_if.triggered", {
            "visor.check.id": checkName,
            scope: "global",
            expression: String(config.fail_if)
          });
          addFailIfTriggered(checkName, "global");
        }
      } catch {
      }
      results.push({
        conditionName: "global_fail_if",
        failed,
        expression: config.fail_if,
        message: failed ? `Global failure condition met: ${config.fail_if}` : void 0,
        severity: "error",
        haltExecution: false
      });
    }
    if (checkConfig.fail_if) {
      const failed = await evaluator.evaluateSimpleCondition(
        checkName,
        checkSchema,
        checkGroup,
        reviewSummary,
        checkConfig.fail_if,
        previousOutputs || {}
      );
      try {
        addEvent2("fail_if.evaluated", {
          "visor.check.id": checkName,
          scope: "check",
          expression: String(checkConfig.fail_if),
          result: failed ? "triggered" : "not_triggered"
        });
        if (failed) {
          addEvent2("fail_if.triggered", {
            "visor.check.id": checkName,
            scope: "check",
            expression: String(checkConfig.fail_if)
          });
          addFailIfTriggered(checkName, "check");
        }
      } catch {
      }
      results.push({
        conditionName: `${checkName}_fail_if`,
        failed,
        expression: checkConfig.fail_if,
        message: failed ? `Check failure condition met: ${checkConfig.fail_if}` : void 0,
        severity: "error",
        haltExecution: false
      });
    }
    const globalConditions = config.failure_conditions;
    const checkConditions = checkConfig.failure_conditions;
    if (globalConditions || checkConditions) {
      const legacyResults = await evaluator.evaluateConditions(
        checkName,
        checkSchema,
        checkGroup,
        reviewSummary,
        globalConditions,
        checkConditions,
        previousOutputs,
        authorAssociation
      );
      results.push(...legacyResults);
    }
    return results;
  }
  /**
   * Get repository status
   * @returns Repository status information
   */
  async getRepositoryStatus() {
    try {
      const { GitRepositoryAnalyzer } = await import("./git-repository-analyzer-HJC4MYW4.mjs");
      const analyzer = new GitRepositoryAnalyzer(this.workingDirectory);
      const info = await analyzer.analyzeRepository();
      return {
        isGitRepository: info.isGitRepository,
        branch: info.head,
        // Use head as branch name
        hasChanges: info.isGitRepository && (info.files?.length > 0 || false),
        filesChanged: info.isGitRepository ? info.files?.length || 0 : 0
      };
    } catch {
      return {
        isGitRepository: false,
        hasChanges: false
      };
    }
  }
  /**
   * Check if current directory is a git repository
   * @returns True if git repository, false otherwise
   */
  async isGitRepository() {
    const status = await this.getRepositoryStatus();
    return status.isGitRepository;
  }
  /**
   * Get list of available check types
   * @returns Array of check type names
   */
  static getAvailableCheckTypes() {
    const { CheckProviderRegistry: CheckProviderRegistry2 } = (init_check_provider_registry(), __toCommonJS(check_provider_registry_exports));
    const registry = CheckProviderRegistry2.getInstance();
    return registry.getAvailableProviders();
  }
  /**
   * Validate check types and return valid/invalid lists
   * @param checks - Array of check type names to validate
   * @returns Object with valid and invalid check types
   */
  static validateCheckTypes(checks) {
    const availableTypes = _StateMachineExecutionEngine.getAvailableCheckTypes();
    const valid = [];
    const invalid = [];
    for (const check of checks) {
      if (availableTypes.includes(check)) {
        valid.push(check);
      } else {
        invalid.push(check);
      }
    }
    return { valid, invalid };
  }
  /**
   * Render check content using the appropriate template
   *
   * This method handles template rendering for check results, supporting:
   * - Plain schema: returns raw content without template processing
   * - Custom templates: from inline content or file
   * - Built-in schema templates: from output/{schema}/template.liquid
   */
  async renderCheckContent(checkName, reviewSummary, checkConfig, _prInfo) {
    const { createExtendedLiquid: createExtendedLiquid2 } = await import("./liquid-extensions-X6CDR654.mjs");
    const fs6 = await import("fs/promises");
    const path6 = await import("path");
    const schema = checkConfig.schema || "plain";
    let templateContent;
    if (checkConfig.template) {
      if (checkConfig.template.content) {
        templateContent = checkConfig.template.content;
      } else if (checkConfig.template.file) {
        const templateFile = checkConfig.template.file;
        if (path6.isAbsolute(templateFile)) {
          throw new Error("Template path must be relative to project directory");
        }
        if (templateFile.includes("..")) {
          throw new Error('Template path cannot contain ".." segments');
        }
        if (templateFile.startsWith("~")) {
          throw new Error("Template path cannot reference home directory");
        }
        if (templateFile.includes("\0")) {
          throw new Error("Template path contains invalid characters");
        }
        if (templateFile.trim() === "") {
          throw new Error("Template path must be a non-empty string");
        }
        if (!templateFile.endsWith(".liquid")) {
          throw new Error("Template file must have .liquid extension");
        }
        const { GitRepositoryAnalyzer } = await import("./git-repository-analyzer-HJC4MYW4.mjs");
        const gitAnalyzer = new GitRepositoryAnalyzer(this.workingDirectory);
        const repoInfo = await gitAnalyzer.analyzeRepository();
        const workingDir = repoInfo.workingDirectory;
        const resolvedPath = path6.resolve(workingDir, templateFile);
        templateContent = await fs6.readFile(resolvedPath, "utf-8");
      } else {
        throw new Error('Custom template must specify either "file" or "content"');
      }
    } else if (schema === "plain") {
      return reviewSummary.issues?.[0]?.message || "";
    } else {
      const sanitizedSchema = schema.replace(/[^a-zA-Z0-9-]/g, "");
      if (!sanitizedSchema) {
        throw new Error("Invalid schema name");
      }
      const templatePath = path6.join(__dirname, `output/${sanitizedSchema}/template.liquid`);
      templateContent = await fs6.readFile(templatePath, "utf-8");
    }
    const liquid = createExtendedLiquid2({
      trimTagLeft: false,
      trimTagRight: false,
      trimOutputLeft: false,
      trimOutputRight: false,
      greedy: false
    });
    const templateData = {
      issues: reviewSummary.issues || [],
      checkName
    };
    const rendered = await liquid.parseAndRender(templateContent, templateData);
    return rendered.trim();
  }
  /**
   * Format the status column for execution statistics
   * Used by execution-statistics-formatting tests
   */
  formatStatusColumn(stats) {
    if (stats.skipped) {
      if (stats.skipReason === "if_condition") {
        return "\u23ED if";
      } else if (stats.skipReason === "fail_fast") {
        return "\u23ED ff";
      } else if (stats.skipReason === "dependency_failed") {
        return "\u23ED dep";
      }
      return "\u23ED";
    }
    const totalRuns = stats.totalRuns;
    const successfulRuns = stats.successfulRuns;
    const failedRuns = stats.failedRuns;
    if (failedRuns > 0 && successfulRuns > 0) {
      return `\u2714/\u2716 ${successfulRuns}/${totalRuns}`;
    } else if (failedRuns > 0) {
      return totalRuns === 1 ? "\u2716" : `\u2716 \xD7${totalRuns}`;
    } else {
      return totalRuns === 1 ? "\u2714" : `\u2714 \xD7${totalRuns}`;
    }
  }
  /**
   * Format the details column for execution statistics
   * Used by execution-statistics-formatting tests
   */
  formatDetailsColumn(stats) {
    const parts = [];
    if (stats.outputsProduced !== void 0 && stats.outputsProduced > 0) {
      parts.push(`\u2192${stats.outputsProduced}`);
    }
    if (stats.issuesBySeverity.critical > 0) {
      parts.push(`${stats.issuesBySeverity.critical}\u{1F534}`);
    }
    if (stats.issuesBySeverity.error > 0 && stats.issuesBySeverity.critical === 0) {
      parts.push(`${stats.issuesBySeverity.error}\u274C`);
    }
    if (stats.issuesBySeverity.warning > 0) {
      parts.push(`${stats.issuesBySeverity.warning}\u26A0\uFE0F`);
    }
    if (stats.issuesBySeverity.info > 0 && stats.issuesBySeverity.critical === 0 && stats.issuesBySeverity.error === 0 && stats.issuesBySeverity.warning === 0) {
      parts.push(`${stats.issuesBySeverity.info}\u{1F4A1}`);
    }
    if (stats.errorMessage) {
      parts.push(this.truncate(stats.errorMessage, 40));
    }
    if (stats.skipCondition) {
      parts.push(this.truncate(stats.skipCondition, 40));
    }
    return parts.join(" ");
  }
  /**
   * Truncate a string to a maximum length
   * Used by formatDetailsColumn
   */
  truncate(str, maxLength) {
    if (str.length <= maxLength) {
      return str;
    }
    return str.substring(0, maxLength - 3) + "...";
  }
};
function serializeRunState(state) {
  return {
    ...state,
    levelQueue: state.levelQueue,
    eventQueue: state.eventQueue,
    activeDispatches: Array.from(state.activeDispatches.entries()),
    completedChecks: Array.from(state.completedChecks.values()),
    stats: Array.from(state.stats.entries()),
    historyLog: state.historyLog,
    forwardRunGuards: Array.from(state.forwardRunGuards.values()),
    currentLevelChecks: Array.from(state.currentLevelChecks.values()),
    pendingRunScopes: Array.from((state.pendingRunScopes || /* @__PURE__ */ new Map()).entries()).map(([k, v]) => [
      k,
      v
    ])
  };
}

export {
  StateMachineExecutionEngine
};
//# sourceMappingURL=chunk-A6YBCFLZ.mjs.map