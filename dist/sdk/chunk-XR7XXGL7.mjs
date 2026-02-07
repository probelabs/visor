import {
  init_lazy_otel,
  metrics
} from "./chunk-HEX3RL32.mjs";
import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/telemetry/metrics.ts
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
function getTestMetricsSnapshot() {
  return { ...TEST_SNAPSHOT };
}
function resetTestMetricsSnapshot() {
  Object.keys(TEST_SNAPSHOT).forEach((k) => TEST_SNAPSHOT[k] = 0);
}
var initialized, meter, TEST_ENABLED, TEST_SNAPSHOT, checkDurationHist, providerDurationHist, foreachDurationHist, issuesCounter, activeChecks, failIfCounter, diagramBlocks;
var init_metrics = __esm({
  "src/telemetry/metrics.ts"() {
    init_lazy_otel();
    initialized = false;
    meter = metrics.getMeter("visor");
    TEST_ENABLED = process.env.VISOR_TEST_METRICS === "true";
    TEST_SNAPSHOT = { fail_if_triggered: 0 };
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
  getTestMetricsSnapshot,
  resetTestMetricsSnapshot,
  init_metrics
};
//# sourceMappingURL=chunk-XR7XXGL7.mjs.map