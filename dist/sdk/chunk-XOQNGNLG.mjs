import {
  __esm,
  __export,
  __require,
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

// src/telemetry/lazy-otel.ts
function getOtelApi() {
  if (otelApiAttempted) return otelApi;
  otelApiAttempted = true;
  try {
    otelApi = (function(name) {
      return __require(name);
    })(OTEL_API_MODULE);
  } catch {
    otelApi = null;
  }
  return otelApi;
}
function createNoOpTracer() {
  return {
    startSpan: () => createNoOpSpan(),
    // Support both OTel v1 and v2 overloads:
    // - startActiveSpan(name, callback)
    // - startActiveSpan(name, options, callback)
    // - startActiveSpan(name, options, context, callback)
    startActiveSpan: (name, arg2, arg3, arg4) => {
      const span = createNoOpSpan();
      let cb = void 0;
      if (typeof arg2 === "function") cb = arg2;
      else if (typeof arg3 === "function") cb = arg3;
      else if (typeof arg4 === "function") cb = arg4;
      if (typeof cb === "function") {
        try {
          return cb(span);
        } catch {
          return void 0;
        }
      }
      return span;
    }
  };
}
function createNoOpSpan() {
  return {
    spanContext: () => ({ traceId: "", spanId: "", traceFlags: 0 }),
    setAttribute: () => {
    },
    setAttributes: () => {
    },
    addEvent: () => {
    },
    setStatus: () => {
    },
    updateName: () => {
    },
    end: () => {
    },
    isRecording: () => false,
    recordException: () => {
    }
  };
}
function createNoOpMeter() {
  return {
    createCounter: () => ({ add: () => {
    } }),
    createHistogram: () => ({ record: () => {
    } }),
    createUpDownCounter: () => ({ add: () => {
    } }),
    createObservableGauge: () => {
    },
    createObservableCounter: () => {
    },
    createObservableUpDownCounter: () => {
    }
  };
}
var otelApi, otelApiAttempted, OTEL_API_MODULE, trace, context, metrics, SpanStatusCode;
var init_lazy_otel = __esm({
  "src/telemetry/lazy-otel.ts"() {
    "use strict";
    otelApi = null;
    otelApiAttempted = false;
    OTEL_API_MODULE = "@opentelemetry/api";
    trace = {
      getTracer(name, version) {
        const api = getOtelApi();
        if (!api) return createNoOpTracer();
        return api.trace.getTracer(name, version);
      },
      getSpan(context2) {
        const api = getOtelApi();
        if (!api) return void 0;
        return api.trace.getSpan(context2);
      },
      getActiveSpan() {
        const api = getOtelApi();
        if (!api) return void 0;
        return api.trace.getActiveSpan();
      }
    };
    context = {
      active() {
        const api = getOtelApi();
        if (!api) return {};
        return api.context.active();
      },
      with(context2, fn, thisArg, ...args) {
        const api = getOtelApi();
        if (!api) return fn.call(thisArg, ...args);
        return api.context.with(context2, fn, thisArg, ...args);
      }
    };
    metrics = {
      getMeter(name, version) {
        const api = getOtelApi();
        if (!api?.metrics) return createNoOpMeter();
        return api.metrics.getMeter(name, version);
      }
    };
    SpanStatusCode = {
      get UNSET() {
        const api = getOtelApi();
        return api?.SpanStatusCode?.UNSET ?? 0;
      },
      get OK() {
        const api = getOtelApi();
        return api?.SpanStatusCode?.OK ?? 1;
      },
      get ERROR() {
        const api = getOtelApi();
        return api?.SpanStatusCode?.ERROR ?? 2;
      }
    };
  }
});

// src/telemetry/trace-helpers.ts
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
  const span = trace.getSpan(context.active());
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
var init_trace_helpers = __esm({
  "src/telemetry/trace-helpers.ts"() {
    "use strict";
    init_lazy_otel();
  }
});

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
var initialized, meter, TEST_ENABLED, TEST_SNAPSHOT, checkDurationHist, providerDurationHist, foreachDurationHist, issuesCounter, activeChecks, failIfCounter, diagramBlocks;
var init_metrics = __esm({
  "src/telemetry/metrics.ts"() {
    "use strict";
    init_lazy_otel();
    initialized = false;
    meter = metrics.getMeter("visor");
    TEST_ENABLED = process.env.VISOR_TEST_METRICS === "true";
    TEST_SNAPSHOT = { fail_if_triggered: 0 };
  }
});

export {
  trace,
  context,
  init_lazy_otel,
  emitNdjsonFallback,
  emitNdjsonSpanWithEvents,
  fallback_ndjson_exports,
  init_fallback_ndjson,
  withActiveSpan,
  addEvent,
  init_trace_helpers,
  addFailIfTriggered,
  addDiagramBlock,
  init_metrics
};
//# sourceMappingURL=chunk-XOQNGNLG.mjs.map