import {
  init_lazy_otel,
  metrics
} from "./chunk-UCMJJ3IM.mjs";
import {
  __esm,
  __export
} from "./chunk-J7LXIPZS.mjs";

// src/telemetry/metrics.ts
var metrics_exports = {};
__export(metrics_exports, {
  addDiagramBlock: () => addDiagramBlock,
  addFailIfTriggered: () => addFailIfTriggered,
  addIssues: () => addIssues,
  decActiveCheck: () => decActiveCheck,
  getRunAiCalls: () => getRunAiCalls,
  getTestMetricsSnapshot: () => getTestMetricsSnapshot,
  incActiveCheck: () => incActiveCheck,
  recordAiCall: () => recordAiCall,
  recordCheckDuration: () => recordCheckDuration,
  recordForEachDuration: () => recordForEachDuration,
  recordProviderDuration: () => recordProviderDuration,
  recordRunAiCalls: () => recordRunAiCalls,
  recordRunDuration: () => recordRunDuration,
  recordRunStart: () => recordRunStart,
  resetRunAiCalls: () => resetRunAiCalls,
  resetTestMetricsSnapshot: () => resetTestMetricsSnapshot
});
function ensureInstruments() {
  if (initialized) return;
  try {
    checkDurationHist = meter.createHistogram("visor.check.duration_ms", {
      description: "Duration of a check execution in milliseconds",
      unit: "ms"
    });
    providerDurationHist = meter.createHistogram("visor.provider.duration_ms", {
      description: "Duration of provider execution in milliseconds",
      unit: "ms"
    });
    foreachDurationHist = meter.createHistogram("visor.foreach.item.duration_ms", {
      description: "Duration of a forEach item execution in milliseconds",
      unit: "ms"
    });
    issuesCounter = meter.createCounter("visor.check.issues", {
      description: "Number of issues produced by checks",
      unit: "1"
    });
    activeChecks = meter.createUpDownCounter("visor.run.active_checks", {
      description: "Number of checks actively running",
      unit: "1"
    });
    failIfCounter = meter.createCounter("visor.fail_if.triggered", {
      description: "Number of times fail_if condition triggered",
      unit: "1"
    });
    diagramBlocks = meter.createCounter("visor.diagram.blocks", {
      description: "Number of Mermaid diagram blocks emitted",
      unit: "1"
    });
    runCounter = meter.createCounter("visor.run.total", {
      description: "Total number of visor runs (workflow executions)",
      unit: "1"
    });
    runDurationHist = meter.createHistogram("visor.run.duration_ms", {
      description: "Duration of a complete visor run in milliseconds",
      unit: "ms"
    });
    aiCallCounter = meter.createCounter("visor.ai_call.total", {
      description: "Total number of AI provider calls",
      unit: "1"
    });
    runAiCallsHist = meter.createHistogram("visor.run.ai_calls", {
      description: "Number of AI calls per visor run",
      unit: "1"
    });
    initialized = true;
  } catch {
  }
}
function recordCheckDuration(check, durationMs, group) {
  ensureInstruments();
  try {
    checkDurationHist?.record(durationMs, {
      "visor.check.id": check,
      "visor.check.group": group || "default"
    });
  } catch {
  }
}
function recordProviderDuration(check, providerType, durationMs) {
  ensureInstruments();
  try {
    providerDurationHist?.record(durationMs, {
      "visor.check.id": check,
      "visor.provider.type": providerType
    });
  } catch {
  }
}
function recordForEachDuration(check, index, total, durationMs) {
  ensureInstruments();
  try {
    foreachDurationHist?.record(durationMs, {
      "visor.check.id": check,
      "visor.foreach.index": index,
      "visor.foreach.total": total
    });
  } catch {
  }
}
function addIssues(check, severity, count = 1) {
  ensureInstruments();
  try {
    issuesCounter?.add(count, {
      "visor.check.id": check,
      severity
    });
  } catch {
  }
}
function incActiveCheck(check) {
  ensureInstruments();
  try {
    activeChecks?.add(1, { "visor.check.id": check });
  } catch {
  }
}
function decActiveCheck(check) {
  ensureInstruments();
  try {
    activeChecks?.add(-1, { "visor.check.id": check });
  } catch {
  }
}
function addFailIfTriggered(check, scope) {
  ensureInstruments();
  try {
    failIfCounter?.add(1, { "visor.check.id": check, scope });
  } catch {
  }
  if (TEST_ENABLED) TEST_SNAPSHOT.fail_if_triggered++;
}
function addDiagramBlock(origin) {
  ensureInstruments();
  try {
    diagramBlocks?.add(1, { origin });
  } catch {
  }
}
function recordRunStart(attrs) {
  ensureInstruments();
  try {
    const labels = {};
    if (attrs.source) labels["visor.run.source"] = attrs.source;
    if (attrs.userId) labels["visor.run.user_id"] = attrs.userId;
    if (attrs.userName) labels["visor.run.user_name"] = attrs.userName;
    if (attrs.workflowId) labels["visor.run.workflow"] = attrs.workflowId;
    if (attrs.instanceId) labels["visor.instance_id"] = attrs.instanceId;
    runCounter?.add(1, labels);
  } catch {
  }
}
function recordRunDuration(durationMs, attrs) {
  ensureInstruments();
  try {
    const labels = {};
    if (attrs.source) labels["visor.run.source"] = attrs.source;
    if (attrs.userId) labels["visor.run.user_id"] = attrs.userId;
    if (attrs.workflowId) labels["visor.run.workflow"] = attrs.workflowId;
    if (attrs.success !== void 0) labels["visor.run.success"] = attrs.success;
    runDurationHist?.record(durationMs, labels);
  } catch {
  }
}
function recordAiCall(attrs) {
  ensureInstruments();
  _currentRunAiCalls++;
  try {
    const labels = {};
    if (attrs.checkId) labels["visor.check.id"] = attrs.checkId;
    if (attrs.model) labels["visor.ai.model"] = attrs.model;
    if (attrs.source) labels["visor.run.source"] = attrs.source;
    aiCallCounter?.add(1, labels);
  } catch {
  }
}
function resetRunAiCalls() {
  _currentRunAiCalls = 0;
}
function recordRunAiCalls(attrs) {
  ensureInstruments();
  try {
    const labels = {};
    if (attrs.source) labels["visor.run.source"] = attrs.source;
    if (attrs.workflowId) labels["visor.run.workflow"] = attrs.workflowId;
    runAiCallsHist?.record(_currentRunAiCalls, labels);
  } catch {
  }
}
function getRunAiCalls() {
  return _currentRunAiCalls;
}
function getTestMetricsSnapshot() {
  return { ...TEST_SNAPSHOT };
}
function resetTestMetricsSnapshot() {
  Object.keys(TEST_SNAPSHOT).forEach((k) => TEST_SNAPSHOT[k] = 0);
}
var initialized, meter, TEST_ENABLED, TEST_SNAPSHOT, checkDurationHist, providerDurationHist, foreachDurationHist, issuesCounter, activeChecks, failIfCounter, diagramBlocks, runCounter, runDurationHist, aiCallCounter, runAiCallsHist, _currentRunAiCalls;
var init_metrics = __esm({
  "src/telemetry/metrics.ts"() {
    init_lazy_otel();
    initialized = false;
    meter = metrics.getMeter("visor");
    TEST_ENABLED = process.env.VISOR_TEST_METRICS === "true";
    TEST_SNAPSHOT = { fail_if_triggered: 0 };
    _currentRunAiCalls = 0;
  }
});

export {
  recordCheckDuration,
  recordProviderDuration,
  recordForEachDuration,
  addIssues,
  incActiveCheck,
  decActiveCheck,
  addFailIfTriggered,
  addDiagramBlock,
  recordRunStart,
  recordRunDuration,
  recordAiCall,
  resetRunAiCalls,
  recordRunAiCalls,
  getRunAiCalls,
  getTestMetricsSnapshot,
  resetTestMetricsSnapshot,
  metrics_exports,
  init_metrics
};
//# sourceMappingURL=chunk-4TV2CVVI.mjs.map