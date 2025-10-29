import {
  __esm,
  __export,
  __toCommonJS
} from "./chunk-WMJKH4XE.mjs";

// src/telemetry/fallback-ndjson.ts
var fallback_ndjson_exports = {};
__export(fallback_ndjson_exports, {
  emitNdjsonFallback: () => emitNdjsonFallback,
  emitNdjsonSpanWithEvents: () => emitNdjsonSpanWithEvents,
  flushNdjson: () => flushNdjson
});
import * as fs from "fs";
import * as path from "path";
function resolveTargetPath(outDir) {
  if (process.env.VISOR_FALLBACK_TRACE_FILE) {
    CURRENT_FILE = process.env.VISOR_FALLBACK_TRACE_FILE;
    return CURRENT_FILE;
  }
  if (CURRENT_FILE) return CURRENT_FILE;
  const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  CURRENT_FILE = path.join(outDir, `${ts}.ndjson`);
  return CURRENT_FILE;
}
function isEnabled() {
  if (process.env.VISOR_FALLBACK_TRACE_FILE) return true;
  return process.env.VISOR_TELEMETRY_ENABLED === "true" && (process.env.VISOR_TELEMETRY_SINK || "file") === "file";
}
function appendAsync(outDir, line) {
  writeChain = writeChain.then(async () => {
    if (!dirReady) {
      try {
        await fs.promises.mkdir(outDir, { recursive: true });
      } catch {
      }
      dirReady = true;
    }
    const target = resolveTargetPath(outDir);
    await fs.promises.appendFile(target, line, "utf8");
  }).catch(() => {
  });
}
async function flushNdjson() {
  try {
    await writeChain;
  } catch {
  }
}
function emitNdjsonFallback(name, attrs) {
  try {
    if (!isEnabled()) return;
    const outDir = process.env.VISOR_TRACE_DIR || path.join(process.cwd(), "output", "traces");
    const line = JSON.stringify({ name, attributes: attrs }) + "\n";
    appendAsync(outDir, line);
  } catch {
  }
}
function emitNdjsonSpanWithEvents(name, attrs, events) {
  try {
    if (!isEnabled()) return;
    const outDir = process.env.VISOR_TRACE_DIR || path.join(process.cwd(), "output", "traces");
    const line = JSON.stringify({ name, attributes: attrs, events }) + "\n";
    appendAsync(outDir, line);
  } catch {
  }
}
var CURRENT_FILE, dirReady, writeChain;
var init_fallback_ndjson = __esm({
  "src/telemetry/fallback-ndjson.ts"() {
    "use strict";
    CURRENT_FILE = null;
    dirReady = false;
    writeChain = Promise.resolve();
  }
});

// src/telemetry/trace-helpers.ts
import { context as otContext, SpanStatusCode, trace } from "@opentelemetry/api";
function getTracer() {
  return trace.getTracer("visor");
}
async function withActiveSpan(name, attrs, fn) {
  const tracer = getTracer();
  return await new Promise((resolve, reject) => {
    const callback = async (span) => {
      try {
        const res = await fn(span);
        resolve(res);
      } catch (err) {
        try {
          if (err instanceof Error) span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR });
        } catch {
        }
        reject(err);
      } finally {
        try {
          span.end();
        } catch {
        }
      }
    };
    const options = attrs ? { attributes: attrs } : {};
    tracer.startActiveSpan(name, options, callback);
  });
}
function addEvent(name, attrs) {
  const span = trace.getSpan(otContext.active());
  if (span) {
    try {
      span.addEvent(name, attrs);
    } catch {
    }
  }
  try {
    const { emitNdjsonSpanWithEvents: emitNdjsonSpanWithEvents2 } = (init_fallback_ndjson(), __toCommonJS(fallback_ndjson_exports));
    emitNdjsonSpanWithEvents2("visor.event", {}, [{ name, attrs }]);
    if (name === "fail_if.triggered") {
      emitNdjsonSpanWithEvents2("visor.event", {}, [
        { name: "fail_if.evaluated", attrs },
        { name: "fail_if.triggered", attrs }
      ]);
    }
  } catch {
  }
}

// src/telemetry/metrics.ts
import { metrics } from "@opentelemetry/api";
var initialized = false;
var meter = metrics.getMeter("visor");
var TEST_ENABLED = process.env.VISOR_TEST_METRICS === "true";
var TEST_SNAPSHOT = { fail_if_triggered: 0 };
var checkDurationHist;
var providerDurationHist;
var foreachDurationHist;
var issuesCounter;
var activeChecks;
var failIfCounter;
var diagramBlocks;
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

export {
  emitNdjsonFallback,
  emitNdjsonSpanWithEvents,
  fallback_ndjson_exports,
  init_fallback_ndjson,
  withActiveSpan,
  addEvent,
  addFailIfTriggered,
  addDiagramBlock
};
//# sourceMappingURL=chunk-FVS5CJ5S.mjs.map