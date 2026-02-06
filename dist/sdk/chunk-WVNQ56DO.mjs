import {
  SpanStatusCode,
  context,
  init_lazy_otel,
  trace
} from "./chunk-4HVFUUNB.mjs";
import {
  __esm,
  __export,
  __require,
  __toCommonJS
} from "./chunk-J7LXIPZS.mjs";

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
function setSpanAttributes(attrs) {
  const span = trace.getSpan(context.active());
  if (!span) return;
  try {
    for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
  } catch {
  }
}
function setSpanError(err) {
  const span = trace.getSpan(context.active());
  if (!span) return;
  try {
    if (err instanceof Error) span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR });
  } catch {
  }
}
function __getOrCreateNdjsonPath() {
  try {
    if (process.env.VISOR_TELEMETRY_SINK && process.env.VISOR_TELEMETRY_SINK !== "file")
      return null;
    const path2 = __require("path");
    const fs2 = __require("fs");
    if (process.env.VISOR_FALLBACK_TRACE_FILE) {
      __ndjsonPath = process.env.VISOR_FALLBACK_TRACE_FILE;
      const dir = path2.dirname(__ndjsonPath);
      if (!fs2.existsSync(dir)) fs2.mkdirSync(dir, { recursive: true });
      return __ndjsonPath;
    }
    const outDir = process.env.VISOR_TRACE_DIR || path2.join(process.cwd(), "output", "traces");
    if (!fs2.existsSync(outDir)) fs2.mkdirSync(outDir, { recursive: true });
    if (!__ndjsonPath) {
      const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
      __ndjsonPath = path2.join(outDir, `${ts}.ndjson`);
    }
    return __ndjsonPath;
  } catch {
    return null;
  }
}
function _appendRunMarker() {
  try {
    const fs2 = __require("fs");
    const p = __getOrCreateNdjsonPath();
    if (!p) return;
    const line = { name: "visor.run", attributes: { started: true } };
    fs2.appendFileSync(p, JSON.stringify(line) + "\n", "utf8");
  } catch {
  }
}
var __ndjsonPath;
var init_trace_helpers = __esm({
  "src/telemetry/trace-helpers.ts"() {
    init_lazy_otel();
    __ndjsonPath = null;
  }
});

export {
  emitNdjsonFallback,
  emitNdjsonSpanWithEvents,
  fallback_ndjson_exports,
  init_fallback_ndjson,
  getTracer,
  withActiveSpan,
  addEvent,
  setSpanAttributes,
  setSpanError,
  __getOrCreateNdjsonPath,
  _appendRunMarker,
  init_trace_helpers
};
//# sourceMappingURL=chunk-WVNQ56DO.mjs.map