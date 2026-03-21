import {
  getInstanceId,
  init_instance_id,
  require_package
} from "./chunk-PUHU6UY6.mjs";
import {
  init_metrics,
  metrics_exports
} from "./chunk-FWWLD555.mjs";
import {
  SpanStatusCode,
  context,
  init_lazy_otel,
  trace
} from "./chunk-B2OUZAWY.mjs";
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
  emitNdjsonFullSpan: () => emitNdjsonFullSpan,
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
function emitNdjsonFullSpan(record) {
  try {
    if (!isEnabled()) return;
    const outDir = process.env.VISOR_TRACE_DIR || path.join(process.cwd(), "output", "traces");
    const line = JSON.stringify(record) + "\n";
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

// src/telemetry/file-span-exporter.ts
var file_span_exporter_exports = {};
__export(file_span_exporter_exports, {
  FileSpanExporter: () => FileSpanExporter
});
import * as fs2 from "fs";
import * as path2 from "path";
function serializeSpan(s) {
  return {
    traceId: s.spanContext().traceId,
    spanId: s.spanContext().spanId,
    parentSpanId: s.parentSpanContext?.spanId || s.parentSpanId,
    name: s.name,
    startTime: s.startTime,
    endTime: s.endTime,
    status: s.status,
    attributes: s.attributes,
    events: s.events?.map((e) => ({ name: e.name, time: e.time, attributes: e.attributes })),
    resource: s.resource?.attributes,
    kind: s.kind
  };
}
var otelCore, FileSpanExporter;
var init_file_span_exporter = __esm({
  "src/telemetry/file-span-exporter.ts"() {
    "use strict";
    try {
      otelCore = (function(name) {
        return __require(name);
      })("@opentelemetry/core");
    } catch {
      otelCore = null;
    }
    FileSpanExporter = class {
      filePath;
      buffer = [];
      ndjson;
      constructor(opts = {}) {
        const outDir = opts.dir || path2.join(process.cwd(), "output", "traces");
        this.ndjson = opts.ndjson !== false;
        if (!fs2.existsSync(outDir)) fs2.mkdirSync(outDir, { recursive: true });
        const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
        const run = opts.runId ? `${opts.runId}-` : "";
        const ext = this.ndjson ? "ndjson" : "json";
        if (process.env.VISOR_FALLBACK_TRACE_FILE) {
          this.filePath = process.env.VISOR_FALLBACK_TRACE_FILE;
          const dir = path2.dirname(this.filePath);
          if (!fs2.existsSync(dir)) fs2.mkdirSync(dir, { recursive: true });
        } else {
          this.filePath = path2.join(outDir, `run-${run}${ts}.${ext}`);
        }
      }
      export(spans, resultCallback) {
        const ExportResultCode = otelCore?.ExportResultCode || { SUCCESS: 0, FAILED: 1 };
        try {
          if (this.ndjson) {
            for (const s of spans) {
              const line = JSON.stringify(serializeSpan(s)) + "\n";
              fs2.appendFileSync(this.filePath, line, "utf8");
            }
          } else {
            for (const s of spans) this.buffer.push(serializeSpan(s));
          }
          resultCallback({ code: ExportResultCode.SUCCESS });
        } catch {
          resultCallback({ code: ExportResultCode.FAILED });
        }
      }
      shutdown() {
        return new Promise((resolve) => {
          try {
            if (this.ndjson) {
            } else {
              fs2.writeFileSync(this.filePath, JSON.stringify({ spans: this.buffer }, null, 2), "utf8");
            }
          } catch {
          }
          resolve();
        });
      }
      forceFlush() {
        return Promise.resolve();
      }
    };
  }
});

// src/telemetry/trace-report-exporter.ts
var trace_report_exporter_exports = {};
__export(trace_report_exporter_exports, {
  TraceReportExporter: () => TraceReportExporter
});
import * as fs3 from "fs";
import * as path3 from "path";
function hrTimeToMillis(t) {
  return t[0] * 1e3 + Math.floor(t[1] / 1e6);
}
function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}
var otelCore2, TraceReportExporter;
var init_trace_report_exporter = __esm({
  "src/telemetry/trace-report-exporter.ts"() {
    "use strict";
    try {
      otelCore2 = (function(name) {
        return __require(name);
      })("@opentelemetry/core");
    } catch {
      otelCore2 = null;
    }
    TraceReportExporter = class {
      spans = [];
      outDir;
      runId;
      constructor(opts = {}) {
        this.outDir = opts.dir || path3.join(process.cwd(), "output", "traces");
        this.runId = opts.runId;
        if (!fs3.existsSync(this.outDir)) fs3.mkdirSync(this.outDir, { recursive: true });
      }
      export(spans, resultCallback) {
        const ExportResultCode = otelCore2?.ExportResultCode || { SUCCESS: 0, FAILED: 1 };
        try {
          this.spans.push(...spans);
          resultCallback({ code: ExportResultCode.SUCCESS });
        } catch {
          resultCallback({ code: ExportResultCode.FAILED });
        }
      }
      async shutdown() {
        try {
          if (this.spans.length === 0) return;
          const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
          const prefix = this.runId ? `run-${this.runId}-` : "";
          const jsonPath = path3.join(this.outDir, `${prefix}${ts}.trace.json`);
          const htmlPath = path3.join(this.outDir, `${prefix}${ts}.report.html`);
          const otlpPath = path3.join(this.outDir, `${prefix}${ts}.otlp.json`);
          const starts = this.spans.map((s) => hrTimeToMillis(s.startTime));
          const ends = this.spans.map((s) => hrTimeToMillis(s.endTime));
          const minStart = Math.min(...starts);
          const maxEnd = Math.max(...ends);
          const flat = this.spans.map((s) => ({
            name: s.name,
            start: hrTimeToMillis(s.startTime),
            end: hrTimeToMillis(s.endTime),
            duration: Math.max(0, hrTimeToMillis(s.endTime) - hrTimeToMillis(s.startTime)),
            offset: hrTimeToMillis(s.startTime) - minStart,
            attrs: s.attributes,
            events: s.events?.map((e) => ({
              name: e.name,
              time: hrTimeToMillis(e.time),
              attrs: e.attributes
            })),
            traceId: s.spanContext().traceId,
            spanId: s.spanContext().spanId,
            parentSpanId: s.parentSpanId
          }));
          fs3.writeFileSync(jsonPath, JSON.stringify({ spans: flat }, null, 2), "utf8");
          try {
            const req = this.toOtlpJson();
            fs3.writeFileSync(otlpPath, JSON.stringify(req, null, 2), "utf8");
          } catch {
          }
          const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Visor Trace Report</title>
  <style>
    :root{--fg:#e6edf3;--bg:#0b0f14;--muted:#8b949e;--panel:#161b22;--border:#30363d;--accent:#1f6feb}
    body{font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;background:var(--bg);color:var(--fg)}
    .container{max-width:1200px;margin:0 auto;padding:16px}
    .summary{display:flex;gap:16px;color:var(--muted);font-size:12px;margin-bottom:8px;flex-wrap:wrap}
    .panel{background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:8px}
    .tree .node{margin-left:12px;border-left:1px dashed var(--border);padding-left:8px}
    .tree .root{border:0;margin-left:0;padding-left:0}
    .node> .head{display:flex;align-items:center;gap:8px;cursor:pointer}
    .toggle{width:10px;height:10px;border:1px solid var(--border);display:inline-flex;align-items:center;justify-content:center;font-size:10px;border-radius:2px;color:var(--muted)}
    .name{font-weight:600}
    .meta{color:var(--muted);font-size:12px}
    .timeline{position:relative;height:8px;background:linear-gradient(90deg,transparent 0,var(--border) 0) left/100% 1px no-repeat;margin:6px 0 6px 18px}
    .bar{position:absolute;height:6px;background:var(--accent);border-radius:3px}
    .details{display:none;margin:4px 0 8px 18px}
    .details pre{white-space:pre-wrap;background:#0f141a;border:1px solid var(--border);padding:8px;border-radius:4px;color:var(--fg)}
    .legend{display:flex;justify-content:space-between;margin:8px 0;font-size:12px;color:var(--muted)}
    .grid{display:grid;grid-template-columns:360px 1fr;gap:12px}
    @media (max-width:900px){.grid{display:block}}
  </style>
</head>
<body>
  <div class="container">
    <h2>Visor Trace Report</h2>
    <div class="summary">
      <div>Start: ${new Date(minStart).toISOString()}</div>
      <div>Total Duration: ${maxEnd - minStart} ms</div>
      <div>Spans: ${flat.length}</div>
      <div>Saved JSON: ${escapeHtml(path3.basename(jsonPath))}</div>
    </div>
    <div class="grid">
      <div class="panel">
        <div class="legend"><div>Trace Tree</div><div>click a span for details</div></div>
        <div id="tree" class="tree"></div>
      </div>
      <div class="panel">
        <div class="legend"><div>Timeline</div><div>${maxEnd - minStart} ms</div></div>
        <div id="timeline" style="position:relative;height:${Math.max(120, flat.length * 16)}px"></div>
        <div class="legend"><div>0 ms</div><div>${maxEnd - minStart} ms</div></div>
      </div>
    </div>
  </div>
  <script id="trace-data" type="application/json">${escapeHtml(JSON.stringify({ spans: flat }))}</script>
  <script>
    const data = JSON.parse(document.getElementById('trace-data').textContent);
    const spans = data.spans || [];
    const byId = new Map(spans.map(s => [s.spanId, { span:s, children:[] }]));
    const roots = [];
    for (const n of byId.values()) { const p = n.span.parentSpanId && byId.get(n.span.parentSpanId); if (p) p.children.push(n); else roots.push(n); }
    for (const n of byId.values()) n.children.sort((a,b)=>a.span.start-b.span.start);
    roots.sort((a,b)=>a.span.start-b.span.start);
    const treeEl = document.getElementById('tree');
    const tlEl = document.getElementById('timeline');
    const total = Math.max(1, Math.max(...spans.map(s=>s.end)) - Math.min(...spans.map(s=>s.start)));
    function renderNode(n, parentEl, depth){
      const s=n.span;
      const node=document.createElement('div'); node.className='node'+(depth? '':' root');
      const head=document.createElement('div'); head.className='head';
      const t=document.createElement('span'); t.className='toggle'; t.textContent=n.children.length?'+':'';
      const name=document.createElement('span'); name.className='name'; name.textContent=s.name;
      const meta=document.createElement('span'); meta.className='meta'; meta.textContent=' '+s.duration+'ms';
      head.append(t,name,meta); node.append(head);
      const details=document.createElement('div'); details.className='details';
      details.innerHTML = '' + 
        <div class="timeline"><div class="bar" style="left:' + ((s.offset/total)*100) + '%;width:' + Math.max(0.5,(s.duration/total)*100) + '%"></div></div>
        <div class="meta">start: ' + new Date(s.start).toISOString() + ' \u2022 end: ' + new Date(s.end).toISOString() + '</div>
        <div class="meta">trace: ' + s.traceId + ' \u2022 span: ' + s.spanId + '' + (s.parentSpanId? ' \u2022 parent: '+s.parentSpanId:'' ) + '</div>
        <div class="meta">attributes</div>
        <pre>' + JSON.stringify(s.attrs||{},null,2) + '</pre>
        <div class="meta">events ' + ((s.events||[]).length) + '</div>
        <pre>' + JSON.stringify(s.events||[],null,2) + '</pre>';
      node.append(details);
      head.onclick=()=>{ const open=details.style.display!=='none'; details.style.display=open?'none':'block'; if(n.children.length) t.textContent=open?'+':'\u2013'; };
      details.style.display='none';
      parentEl.append(node);
      const tlRow=document.createElement('div'); tlRow.style.position='relative'; tlRow.style.height='16px'; tlRow.style.margin='2px 0';
      const bar=document.createElement('div'); bar.className='bar'; bar.style.left=((s.offset/total)*100)+'%'; bar.style.width=(Math.max(0.5,(s.duration/total)*100))+'%'; bar.title=s.name+' ('+s.duration+'ms)'; tlRow.append(bar);
      tlEl.append(tlRow);
      for(const c of n.children) renderNode(c, node, depth+1);
    }
    roots.forEach(r=>renderNode(r, treeEl, 0));
  </script>
</body>
</html>`;
          fs3.writeFileSync(htmlPath, html, "utf8");
        } catch {
        }
      }
      toOtlpJson() {
        const resourceGroups = /* @__PURE__ */ new Map();
        for (const s of this.spans) {
          const resAttrs = s.resource?.attributes || {};
          const resKey = JSON.stringify(resAttrs);
          let g = resourceGroups.get(resKey);
          if (!g) {
            g = { resource: resAttrs, spans: [] };
            resourceGroups.set(resKey, g);
          }
          g.spans.push(s);
        }
        const resourceSpans = Array.from(resourceGroups.values()).map((g) => ({
          resource: {
            attributes: toOtelAttributes(g.resource)
          },
          scopeSpans: [
            {
              scope: { name: "visor", version: String(process.env.VISOR_VERSION || "dev") },
              spans: g.spans.map((s) => toOtelSpan(s))
            }
          ]
        }));
        return { resourceSpans };
        function toOtelSpan(s) {
          const startMs = hrTimeToMillis(s.startTime);
          const endMs = hrTimeToMillis(s.endTime);
          const toNs = (ms) => String(Math.max(0, Math.floor(ms * 1e6)));
          return {
            traceId: s.spanContext().traceId,
            // hex; many tools accept hex in JSON
            spanId: s.spanContext().spanId,
            parentSpanId: s.parentSpanId || void 0,
            name: s.name,
            kind: s.kind ?? 0,
            startTimeUnixNano: toNs(startMs),
            endTimeUnixNano: toNs(endMs),
            attributes: toOtelAttributes(s.attributes || {}),
            events: (s.events || []).map((e) => ({
              timeUnixNano: toNs(hrTimeToMillis(e.time)),
              name: e.name,
              attributes: toOtelAttributes(e.attributes || {})
            })),
            status: s.status ? {
              code: s.status.code ?? 0,
              message: s.status.message || void 0
            } : void 0
          };
        }
        function toOtelAttributes(obj) {
          const out = [];
          for (const [key, value] of Object.entries(obj || {})) {
            out.push({ key, value: toAnyValue(value) });
          }
          return out;
        }
        function toAnyValue(v) {
          const t = typeof v;
          if (v == null) return { stringValue: "null" };
          if (t === "string") return { stringValue: v };
          if (t === "boolean") return { boolValue: v };
          if (t === "number")
            return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
          if (Array.isArray(v)) return { arrayValue: { values: v.map(toAnyValue) } };
          if (t === "object")
            return { kvlistValue: { values: toOtelAttributes(v) } };
          return { stringValue: String(v) };
        }
      }
      async forceFlush() {
      }
    };
  }
});

// src/debug-visualizer/debug-span-exporter.ts
var debug_span_exporter_exports = {};
__export(debug_span_exporter_exports, {
  DebugSpanExporter: () => DebugSpanExporter,
  createDebugSpanExporter: () => createDebugSpanExporter
});
function createDebugSpanExporter(server) {
  return new DebugSpanExporter(server);
}
var otelCore3, DebugSpanExporter;
var init_debug_span_exporter = __esm({
  "src/debug-visualizer/debug-span-exporter.ts"() {
    "use strict";
    try {
      otelCore3 = (function(name) {
        return __require(name);
      })("@opentelemetry/core");
    } catch {
      otelCore3 = null;
    }
    DebugSpanExporter = class {
      server;
      constructor(server) {
        this.server = server;
      }
      /**
       * Export spans to WebSocket server
       */
      export(spans, resultCallback) {
        const ExportResultCode = otelCore3?.ExportResultCode || { SUCCESS: 0, FAILED: 1 };
        console.log(`[debug-exporter] Export called with ${spans.length} spans`);
        try {
          for (const span of spans) {
            console.log(`[debug-exporter] Converting and emitting span: ${span.name}`);
            const processedSpan = this.convertSpan(span);
            this.server.emitSpan(processedSpan);
          }
          console.log(`[debug-exporter] Successfully exported ${spans.length} spans`);
          resultCallback({ code: ExportResultCode.SUCCESS });
        } catch (error) {
          console.error("[debug-exporter] Failed to export spans:", error);
          resultCallback({
            code: ExportResultCode.FAILED,
            error: error instanceof Error ? error : new Error(String(error))
          });
        }
      }
      /**
       * Shutdown the exporter
       */
      async shutdown() {
        console.log("[debug-exporter] Shutdown called");
      }
      /**
       * Force flush any buffered spans (no-op for this exporter)
       */
      async forceFlush() {
      }
      /**
       * Convert OTEL ReadableSpan to ProcessedSpan format
       */
      convertSpan(span) {
        const attributes = {};
        for (const [key, value] of Object.entries(span.attributes)) {
          attributes[key] = value;
        }
        const rawParent = span.parentSpanId;
        console.log(
          `[debug-exporter] Span: ${span.name}, parent: ${span.parentSpanId || "NONE"} (type: ${typeof rawParent})`
        );
        const events = span.events.map((event) => ({
          name: event.name,
          time: this.hrTimeToTuple(event.time),
          timestamp: new Date(this.hrTimeToMillis(event.time)).toISOString(),
          attributes: event.attributes ? { ...event.attributes } : {}
        }));
        const status = span.status.code === 2 ? "error" : "ok";
        const startMs = this.hrTimeToMillis(span.startTime);
        const endMs = this.hrTimeToMillis(span.endTime);
        const duration = endMs - startMs;
        return {
          traceId: span.spanContext().traceId,
          spanId: span.spanContext().spanId,
          parentSpanId: span.parentSpanId,
          name: span.name,
          startTime: this.hrTimeToTuple(span.startTime),
          endTime: this.hrTimeToTuple(span.endTime),
          duration,
          attributes,
          events,
          status
        };
      }
      /**
       * Convert OTEL HrTime to [seconds, nanoseconds] tuple
       */
      hrTimeToTuple(hrTime) {
        return hrTime;
      }
      /**
       * Convert OTEL HrTime to milliseconds
       */
      hrTimeToMillis(hrTime) {
        return hrTime[0] * 1e3 + hrTime[1] / 1e6;
      }
    };
  }
});

// src/telemetry/opentelemetry.ts
var opentelemetry_exports = {};
__export(opentelemetry_exports, {
  forceFlushTelemetry: () => forceFlushTelemetry,
  getOtelLoggerProvider: () => getOtelLoggerProvider,
  initTelemetry: () => initTelemetry,
  requestThrottledTelemetryFlush: () => requestThrottledTelemetryFlush,
  resetTelemetryForTesting: () => resetTelemetryForTesting,
  shutdownTelemetry: () => shutdownTelemetry
});
function resetTelemetryForTesting() {
  sdk = null;
  patched = false;
}
async function initTelemetry(opts = {}) {
  const enabled = !!opts.enabled || !!opts.debugServer || process.env.VISOR_TELEMETRY_ENABLED === "true";
  if (!enabled || sdk) return;
  try {
    (function(name) {
      return __require(name);
    })("@opentelemetry/api");
    const { NodeSDK } = (function(name) {
      return __require(name);
    })("@opentelemetry/sdk-node");
    const resourcesModule = (function(name) {
      return __require(name);
    })("@opentelemetry/resources");
    const semanticConventions = (function(name) {
      return __require(name);
    })("@opentelemetry/semantic-conventions");
    const { BatchSpanProcessor, ConsoleSpanExporter } = (function(name) {
      return __require(name);
    })("@opentelemetry/sdk-trace-base");
    const sink = opts.sink || process.env.VISOR_TELEMETRY_SINK || "file";
    const processors = [];
    if (!process.env.VISOR_FALLBACK_TRACE_FILE && sink === "file") {
      try {
        const fs4 = __require("fs");
        const path4 = __require("path");
        const outDir = opts.file?.dir || process.env.VISOR_TRACE_DIR || path4.join(process.cwd(), "output", "traces");
        fs4.mkdirSync(outDir, { recursive: true });
        const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
        process.env.VISOR_FALLBACK_TRACE_FILE = path4.join(outDir, `run-${ts}.ndjson`);
      } catch {
      }
    }
    if (sink === "otlp") {
      const protocol = opts.otlp?.protocol || "http";
      if (protocol === "http") {
        const { OTLPTraceExporter } = (function(name) {
          return __require(name);
        })("@opentelemetry/exporter-trace-otlp-http");
        const traceUrl = opts.otlp?.endpoint || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || void 0;
        const exporter = new OTLPTraceExporter({
          ...traceUrl ? { url: traceUrl } : {},
          headers: opts.otlp?.headers || process.env.OTEL_EXPORTER_OTLP_HEADERS
        });
        processors.push(new BatchSpanProcessor(exporter, batchParams()));
      } else {
        try {
          const { OTLPTraceExporter: GrpcExporter } = (function(name) {
            return __require(name);
          })("@opentelemetry/exporter-trace-otlp-grpc");
          processors.push(new BatchSpanProcessor(new GrpcExporter({}), batchParams()));
        } catch {
          processors.push(new BatchSpanProcessor(new ConsoleSpanExporter(), batchParams()));
        }
      }
    } else if (sink === "console") {
      processors.push(new BatchSpanProcessor(new ConsoleSpanExporter(), batchParams()));
    } else {
      const { FileSpanExporter: FileSpanExporter2 } = (init_file_span_exporter(), __toCommonJS(file_span_exporter_exports));
      const exporter = new FileSpanExporter2({
        dir: opts.file?.dir || process.env.VISOR_TRACE_DIR,
        ndjson: opts.file?.ndjson,
        runId: opts.file?.runId
      });
      processors.push(new BatchSpanProcessor(exporter, batchParams()));
    }
    let resource;
    if (resourcesModule.Resource) {
      resource = new resourcesModule.Resource({
        [semanticConventions.SemanticResourceAttributes.SERVICE_NAME]: "visor",
        [semanticConventions.SemanticResourceAttributes.SERVICE_VERSION]: process.env.VISOR_VERSION || "dev",
        "deployment.environment": detectEnvironment()
      });
    } else {
      resource = resourcesModule.resourceFromAttributes({
        [semanticConventions.ATTR_SERVICE_NAME]: "visor",
        [semanticConventions.ATTR_SERVICE_VERSION]: process.env.VISOR_VERSION || "dev",
        "deployment.environment": detectEnvironment()
      });
    }
    let metricReader;
    if (sink === "otlp") {
      try {
        const { OTLPMetricExporter } = (function(name) {
          return __require(name);
        })("@opentelemetry/exporter-metrics-otlp-http");
        const { PeriodicExportingMetricReader } = (function(name) {
          return __require(name);
        })("@opentelemetry/sdk-metrics");
        const metricsUrl = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || void 0;
        const mExporter = new OTLPMetricExporter({
          ...metricsUrl ? { url: metricsUrl } : {},
          headers: process.env.OTEL_EXPORTER_OTLP_HEADERS
        });
        metricReader = new PeriodicExportingMetricReader({
          exporter: mExporter,
          exportIntervalMillis: 1e4,
          exportTimeoutMillis: 1e4
        });
      } catch {
      }
    }
    if (sink === "otlp") {
      try {
        const { LoggerProvider, BatchLogRecordProcessor } = (function(name) {
          return __require(name);
        })("@opentelemetry/sdk-logs");
        const { OTLPLogExporter } = (function(name) {
          return __require(name);
        })("@opentelemetry/exporter-logs-otlp-http");
        const { logs: logsApi } = (function(name) {
          return __require(name);
        })("@opentelemetry/api-logs");
        const logsUrl = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT || void 0;
        const logExporter = new OTLPLogExporter({
          ...logsUrl ? { url: logsUrl } : {},
          headers: process.env.OTEL_EXPORTER_OTLP_HEADERS
        });
        const logProcessor = new BatchLogRecordProcessor(logExporter);
        const lp = new LoggerProvider({ resource });
        lp._sharedState.registeredLogRecordProcessors.push(logProcessor);
        lp._sharedState.activeProcessor = logProcessor;
        logsApi.setGlobalLoggerProvider(lp);
        loggerProvider = lp;
      } catch {
      }
    }
    let instrumentations;
    const autoInstr = opts.autoInstrument === true || process.env.VISOR_TELEMETRY_AUTO_INSTRUMENTATIONS === "true";
    if (autoInstr) {
      try {
        const { getNodeAutoInstrumentations } = (function(name) {
          return __require(name);
        })("@opentelemetry/auto-instrumentations-node");
        instrumentations = [getNodeAutoInstrumentations()];
      } catch {
      }
    }
    if (opts.traceReport === true || process.env.VISOR_TRACE_REPORT === "true") {
      try {
        const { TraceReportExporter: TraceReportExporter2 } = (init_trace_report_exporter(), __toCommonJS(trace_report_exporter_exports));
        const { BatchSpanProcessor: BatchSpanProcessor2 } = (function(name) {
          return __require(name);
        })("@opentelemetry/sdk-trace-base");
        processors.push(
          new BatchSpanProcessor2(
            new TraceReportExporter2({
              dir: opts.file?.dir || process.env.VISOR_TRACE_DIR,
              runId: opts.file?.runId
            })
          )
        );
      } catch {
      }
    }
    if (opts.debugServer) {
      try {
        const { DebugSpanExporter: DebugSpanExporter2 } = (init_debug_span_exporter(), __toCommonJS(debug_span_exporter_exports));
        const { SimpleSpanProcessor } = (function(name) {
          return __require(name);
        })("@opentelemetry/sdk-trace-base");
        const debugExporter = new DebugSpanExporter2(opts.debugServer);
        processors.push(new SimpleSpanProcessor(debugExporter));
      } catch (error) {
        console.error("[telemetry] Failed to initialize debug span exporter:", error);
      }
    }
    let spanProcessor;
    if (processors.length > 1) {
      spanProcessor = {
        onStart: (span, context2) => {
          processors.forEach((p) => p.onStart?.(span, context2));
        },
        onEnd: (span) => {
          processors.forEach((p) => p.onEnd?.(span));
        },
        shutdown: async () => {
          await Promise.all(processors.map((p) => p.shutdown()));
        },
        forceFlush: async () => {
          await Promise.all(processors.map((p) => p.forceFlush()));
        }
      };
    } else {
      spanProcessor = processors[0];
    }
    const nodeSdk = new NodeSDK({
      resource,
      spanProcessor,
      metricReader,
      instrumentations
      // Context manager is already set globally above
      // Auto-instrumentations can be added later when desired
    });
    const otelApiForDiag = (function(name) {
      return __require(name);
    })("@opentelemetry/api");
    const DiagConsoleLoggerClass = otelApiForDiag.DiagConsoleLogger;
    const diagLogLevel = otelApiForDiag.DiagLogLevel;
    otelApiForDiag.diag.setLogger(new DiagConsoleLoggerClass(), diagLogLevel.ERROR);
    await nodeSdk.start();
    sdk = nodeSdk;
    if (opts.patchConsole !== false) patchConsole();
  } catch (error) {
    if (process.env.VISOR_DEBUG === "true" || process.env.DEBUG) {
      console.error("[telemetry] Failed to initialize OTel SDK:", error);
    }
  }
}
function getOtelLoggerProvider() {
  return loggerProvider;
}
async function forceFlushTelemetry() {
  if (!sdk) return;
  try {
    if (typeof sdk.forceFlush === "function") {
      await sdk.forceFlush();
    }
  } catch {
  }
}
function requestThrottledTelemetryFlush() {
  if (!sdk || flushInFlight || flushTimer) return;
  const minIntervalMs = Math.max(
    250,
    parseInt(process.env.VISOR_TELEMETRY_FLUSH_INTERVAL_MS || "1500", 10) || 1500
  );
  const elapsed = Date.now() - lastFlushStartedAt;
  const delayMs = Math.max(0, minIntervalMs - elapsed);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!sdk || flushInFlight) return;
    flushInFlight = true;
    lastFlushStartedAt = Date.now();
    void (typeof sdk.forceFlush === "function" ? sdk.forceFlush() : Promise.resolve()).catch(() => {
    }).finally(() => {
      flushInFlight = false;
    });
  }, delayMs);
  if (typeof flushTimer.unref === "function") flushTimer.unref();
}
async function shutdownTelemetry() {
  if (!sdk) return;
  try {
    try {
      const { flushNdjson: flushNdjson2 } = (init_fallback_ndjson(), __toCommonJS(fallback_ndjson_exports));
      await flushNdjson2();
    } catch {
    }
    if (loggerProvider) {
      try {
        await loggerProvider.shutdown();
      } catch {
      }
      loggerProvider = null;
    }
    await sdk.shutdown();
  } catch {
  } finally {
    sdk = null;
    try {
      if (process.env.VISOR_TRACE_REPORT === "true") {
        const fs4 = __require("fs");
        const path4 = __require("path");
        const outDir = process.env.VISOR_TRACE_DIR || path4.join(process.cwd(), "output", "traces");
        if (!fs4.existsSync(outDir)) fs4.mkdirSync(outDir, { recursive: true });
        const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
        const htmlPath = path4.join(outDir, `${ts}.report.html`);
        if (!fs4.existsSync(htmlPath)) {
          fs4.writeFileSync(
            htmlPath,
            '<!doctype html><html><head><meta charset="utf-8"/><title>Visor Trace Report</title></head><body><h2>Visor Trace Report</h2></body></html>',
            "utf8"
          );
        }
      }
    } catch {
    }
  }
}
function detectEnvironment() {
  if (process.env.GITHUB_ACTIONS) return "github-actions";
  if (process.env.CI) return "ci";
  return "local";
}
function batchParams() {
  return {
    maxQueueSize: 65536,
    maxExportBatchSize: 8192,
    scheduledDelayMillis: 1e3,
    exportTimeoutMillis: 1e4
  };
}
function patchConsole() {
  if (patched) return;
  try {
    const { context: context2, trace: trace2 } = (function(name) {
      return __require(name);
    })("@opentelemetry/api");
    const methods = ["log", "info", "warn", "error"];
    const c = globalThis.console;
    for (const m of methods) {
      const orig = c[m].bind(c);
      c[m] = (...args) => {
        const span = trace2.getSpan(context2.active());
        const ctx = span?.spanContext();
        if (ctx) {
          try {
            const suffix = ` [trace_id=${ctx.traceId} span_id=${ctx.spanId}]`;
            if (typeof args[0] === "string") args[0] = args[0] + suffix;
            else args.push(suffix);
          } catch {
          }
        }
        return orig(...args);
      };
    }
    patched = true;
  } catch {
  }
}
var sdk, patched, loggerProvider, flushTimer, flushInFlight, lastFlushStartedAt;
var init_opentelemetry = __esm({
  "src/telemetry/opentelemetry.ts"() {
    "use strict";
    sdk = null;
    patched = false;
    loggerProvider = null;
    flushTimer = null;
    flushInFlight = false;
    lastFlushStartedAt = 0;
  }
});

// src/telemetry/trace-helpers.ts
var trace_helpers_exports = {};
__export(trace_helpers_exports, {
  __getOrCreateNdjsonPath: () => __getOrCreateNdjsonPath,
  _appendRunMarker: () => _appendRunMarker,
  addEvent: () => addEvent,
  emitImmediateSpan: () => emitImmediateSpan,
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
function emitImmediateSpan(name, attrs, options) {
  try {
    const startHr = process.hrtime();
    const tracer = getTracer();
    const span = tracer.startSpan(name, attrs ? { attributes: attrs } : void 0);
    try {
      for (const evt of options?.events || []) {
        span.addEvent(evt.name, evt.attrs || {});
      }
      if (options?.status) {
        span.setStatus(options.status);
      }
    } finally {
      span.end();
    }
    try {
      const { emitNdjsonFullSpan: emitNdjsonFullSpan2 } = (init_fallback_ndjson(), __toCommonJS(fallback_ndjson_exports));
      const activeParent = trace.getSpan(context.active());
      const parentCtx = activeParent?.spanContext?.();
      const ctx = span.spanContext?.();
      const endHr = process.hrtime();
      emitNdjsonFullSpan2({
        name,
        traceId: ctx?.traceId || parentCtx?.traceId || randomTraceId(),
        spanId: ctx?.spanId || randomSpanId(),
        parentSpanId: parentCtx?.spanId,
        startTime: [startHr[0], startHr[1]],
        endTime: [endHr[0], endHr[1]],
        attributes: attrs || {},
        events: (options?.events || []).map((evt) => ({
          name: evt.name,
          attributes: evt.attrs || {}
        })),
        status: options?.status
      });
    } catch {
    }
    try {
      const { requestThrottledTelemetryFlush: requestThrottledTelemetryFlush2 } = (init_opentelemetry(), __toCommonJS(opentelemetry_exports));
      requestThrottledTelemetryFlush2();
    } catch {
    }
  } catch {
  }
}
function randomSpanId() {
  return __require("crypto").randomBytes(8).toString("hex");
}
function randomTraceId() {
  return __require("crypto").randomBytes(16).toString("hex");
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
    const path4 = __require("path");
    const fs4 = __require("fs");
    if (process.env.VISOR_FALLBACK_TRACE_FILE) {
      __ndjsonPath = process.env.VISOR_FALLBACK_TRACE_FILE;
      const dir = path4.dirname(__ndjsonPath);
      if (!fs4.existsSync(dir)) fs4.mkdirSync(dir, { recursive: true });
      return __ndjsonPath;
    }
    const outDir = process.env.VISOR_TRACE_DIR || path4.join(process.cwd(), "output", "traces");
    if (!fs4.existsSync(outDir)) fs4.mkdirSync(outDir, { recursive: true });
    if (!__ndjsonPath) {
      const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
      __ndjsonPath = path4.join(outDir, `${ts}.ndjson`);
    }
    return __ndjsonPath;
  } catch {
    return null;
  }
}
function _appendRunMarker() {
  try {
    const fs4 = __require("fs");
    const p = __getOrCreateNdjsonPath();
    if (!p) return;
    const line = { name: "visor.run", attributes: { started: true } };
    fs4.appendFileSync(p, JSON.stringify(line) + "\n", "utf8");
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
  emitNdjsonFullSpan,
  fallback_ndjson_exports,
  init_fallback_ndjson,
  getTracer,
  withActiveSpan,
  emitImmediateSpan,
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
//# sourceMappingURL=chunk-QLT42TX7.mjs.map