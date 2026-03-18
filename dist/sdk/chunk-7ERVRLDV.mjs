import {
  getInstanceId,
  init_instance_id,
  require_package
} from "./chunk-QXT47ZHR.mjs";
import {
  init_metrics,
  metrics_exports
} from "./chunk-34QX63WK.mjs";
import {
  SpanStatusCode,
  context,
  init_lazy_otel,
  trace
} from "./chunk-UCMJJ3IM.mjs";
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
var trace_helpers_exports = {};
__export(trace_helpers_exports, {
  __getOrCreateNdjsonPath: () => __getOrCreateNdjsonPath,
  _appendRunMarker: () => _appendRunMarker,
  addEvent: () => addEvent,
  getTracer: () => getTracer,
  getVisorRunAttributes: () => getVisorRunAttributes,
  setSpanAttributes: () => setSpanAttributes,
  setSpanError: () => setSpanError,
  withActiveSpan: () => withActiveSpan,
  withVisorRun: () => withVisorRun
});
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
function getVisorRunAttributes() {
  const attrs = {};
  try {
    attrs["visor.version"] = process.env.VISOR_VERSION || (require_package()?.version ?? "dev");
  } catch {
    attrs["visor.version"] = "dev";
  }
  const commitShort = process.env.VISOR_COMMIT_SHORT || "";
  const commitFull = process.env.VISOR_COMMIT_SHA || process.env.VISOR_COMMIT || "";
  if (commitShort) {
    attrs["visor.commit"] = commitShort;
  }
  if (commitFull) {
    attrs["visor.commit.sha"] = commitFull;
  }
  attrs["visor.instance_id"] = getInstanceId();
  return attrs;
}
async function withVisorRun(attrs, runMeta, fn) {
  const {
    recordRunStart,
    recordRunDuration,
    resetRunAiCalls,
    recordRunAiCalls,
    getRunAiCalls
  } = (init_metrics(), __toCommonJS(metrics_exports));
  const instanceId = getInstanceId();
  recordRunStart({
    source: runMeta.source,
    userId: runMeta.userId,
    userName: runMeta.userName,
    workflowId: runMeta.workflowId,
    instanceId
  });
  resetRunAiCalls();
  const startMs = Date.now();
  let success = true;
  try {
    return await withActiveSpan("visor.run", attrs, async (span) => {
      try {
        return await fn(span);
      } finally {
        try {
          span.setAttribute("visor.run.ai_calls", getRunAiCalls());
          span.setAttribute("visor.run.duration_ms", Date.now() - startMs);
        } catch {
        }
      }
    });
  } catch (err) {
    success = false;
    throw err;
  } finally {
    recordRunAiCalls({
      source: runMeta.source,
      workflowId: runMeta.workflowId
    });
    recordRunDuration(Date.now() - startMs, {
      source: runMeta.source,
      userId: runMeta.userId,
      workflowId: runMeta.workflowId,
      success
    });
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
    init_instance_id();
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
  getVisorRunAttributes,
  withVisorRun,
  __getOrCreateNdjsonPath,
  _appendRunMarker,
  trace_helpers_exports,
  init_trace_helpers
};
//# sourceMappingURL=chunk-7ERVRLDV.mjs.map