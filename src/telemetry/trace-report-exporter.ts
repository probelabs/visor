// Trace Report Exporter - generates static HTML trace visualization
// Note: This file is only loaded when telemetry is enabled via opentelemetry.ts
import * as fs from 'fs';
import * as path from 'path';

// Conditional imports - these packages are optional dependencies
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReadableSpan = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExportResult = any;
type HrTime = [number, number];

// Load OTel packages only if available
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let otelCore: any;

try {
  otelCore = require('@opentelemetry/core');
} catch {
  // OpenTelemetry not installed - this file won't be used
  otelCore = null;
}

function hrTimeToMillis(t: HrTime): number {
  return t[0] * 1000 + Math.floor(t[1] / 1e6);
}

export interface TraceReportExporterOptions {
  dir?: string;
  runId?: string;
}

export class TraceReportExporter {
  private spans: ReadableSpan[] = [];
  private outDir: string;
  private runId?: string;

  constructor(opts: TraceReportExporterOptions = {}) {
    this.outDir = opts.dir || path.join(process.cwd(), 'output', 'traces');
    this.runId = opts.runId;
    if (!fs.existsSync(this.outDir)) fs.mkdirSync(this.outDir, { recursive: true });
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const ExportResultCode = otelCore?.ExportResultCode || { SUCCESS: 0, FAILED: 1 };
    try {
      this.spans.push(...spans);
      resultCallback({ code: ExportResultCode.SUCCESS } as ExportResult);
    } catch {
      resultCallback({ code: ExportResultCode.FAILED } as ExportResult);
    }
  }

  async shutdown(): Promise<void> {
    try {
      if (this.spans.length === 0) return;
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const prefix = this.runId ? `run-${this.runId}-` : '';
      const jsonPath = path.join(this.outDir, `${prefix}${ts}.trace.json`);
      const htmlPath = path.join(this.outDir, `${prefix}${ts}.report.html`);
      const otlpPath = path.join(this.outDir, `${prefix}${ts}.otlp.json`);

      // Compute time bounds
      const starts = this.spans.map(s => hrTimeToMillis(s.startTime));
      const ends = this.spans.map(s => hrTimeToMillis(s.endTime));
      const minStart = Math.min(...starts);
      const maxEnd = Math.max(...ends);

      // Serialize rich JSON
      const flat = this.spans.map(s => ({
        name: s.name,
        start: hrTimeToMillis(s.startTime),
        end: hrTimeToMillis(s.endTime),
        duration: Math.max(0, hrTimeToMillis(s.endTime) - hrTimeToMillis(s.startTime)),
        offset: hrTimeToMillis(s.startTime) - minStart,
        attrs: s.attributes,
        events: s.events?.map((e: any) => ({
          name: e.name,
          time: hrTimeToMillis(e.time),
          attrs: e.attributes,
        })),
        traceId: s.spanContext().traceId,
        spanId: s.spanContext().spanId,
        parentSpanId: s.parentSpanId,
      }));
      fs.writeFileSync(jsonPath, JSON.stringify({ spans: flat }, null, 2), 'utf8');

      // Also emit OTLP JSON (ExportTraceServiceRequest) for ingestion in standard tools
      try {
        const req = this.toOtlpJson();
        fs.writeFileSync(otlpPath, JSON.stringify(req, null, 2), 'utf8');
      } catch {
        // ignore OTLP serialization errors
      }

      // Build richer single-file HTML with a collapsible tree and a simple timeline

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
      <div>Saved JSON: ${escapeHtml(path.basename(jsonPath))}</div>
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
        <div class="meta">start: ' + new Date(s.start).toISOString() + ' • end: ' + new Date(s.end).toISOString() + '</div>
        <div class="meta">trace: ' + s.traceId + ' • span: ' + s.spanId + '' + (s.parentSpanId? ' • parent: '+s.parentSpanId:'' ) + '</div>
        <div class="meta">attributes</div>
        <pre>' + JSON.stringify(s.attrs||{},null,2) + '</pre>
        <div class="meta">events ' + ((s.events||[]).length) + '</div>
        <pre>' + JSON.stringify(s.events||[],null,2) + '</pre>';
      node.append(details);
      head.onclick=()=>{ const open=details.style.display!=='none'; details.style.display=open?'none':'block'; if(n.children.length) t.textContent=open?'+':'–'; };
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

      fs.writeFileSync(htmlPath, html, 'utf8');
    } catch {
      // ignore
    }
  }

  private toOtlpJson(): unknown {
    // Build a minimal ExportTraceServiceRequest with ResourceSpans and ScopeSpans
    const resourceGroups = new Map<string, { resource: any; spans: ReadableSpan[] }>();
    for (const s of this.spans) {
      const resAttrs = (s.resource as any)?.attributes || {};
      const resKey = JSON.stringify(resAttrs);
      let g = resourceGroups.get(resKey);
      if (!g) {
        g = { resource: resAttrs, spans: [] };
        resourceGroups.set(resKey, g);
      }
      g.spans.push(s);
    }

    const resourceSpans = Array.from(resourceGroups.values()).map(g => ({
      resource: {
        attributes: toOtelAttributes(g.resource),
      },
      scopeSpans: [
        {
          scope: { name: 'visor', version: String(process.env.VISOR_VERSION || 'dev') },
          spans: g.spans.map(s => toOtelSpan(s)),
        },
      ],
    }));

    return { resourceSpans };

    function toOtelSpan(s: ReadableSpan): any {
      const startMs = hrTimeToMillis(s.startTime);
      const endMs = hrTimeToMillis(s.endTime);
      const toNs = (ms: number) => String(Math.max(0, Math.floor(ms * 1_000_000)));
      return {
        traceId: s.spanContext().traceId, // hex; many tools accept hex in JSON
        spanId: s.spanContext().spanId,
        parentSpanId: s.parentSpanId || undefined,
        name: s.name,
        kind: s.kind ?? 0,
        startTimeUnixNano: toNs(startMs),
        endTimeUnixNano: toNs(endMs),
        attributes: toOtelAttributes((s as any).attributes || {}),
        events: (s.events || []).map((e: any) => ({
          timeUnixNano: toNs(hrTimeToMillis(e.time)),
          name: e.name,
          attributes: toOtelAttributes(e.attributes || {}),
        })),
        status: (s as any).status
          ? {
              code: (s as any).status.code ?? 0,
              message: (s as any).status.message || undefined,
            }
          : undefined,
      };
    }

    function toOtelAttributes(obj: Record<string, unknown>): any[] {
      const out: any[] = [];
      for (const [key, value] of Object.entries(obj || {})) {
        out.push({ key, value: toAnyValue(value) });
      }
      return out;
    }

    function toAnyValue(v: unknown): any {
      const t = typeof v;
      if (v == null) return { stringValue: 'null' };
      if (t === 'string') return { stringValue: v };
      if (t === 'boolean') return { boolValue: v };
      if (t === 'number')
        return Number.isInteger(v as number) ? { intValue: String(v) } : { doubleValue: v };
      if (Array.isArray(v)) return { arrayValue: { values: v.map(toAnyValue) } };
      if (t === 'object')
        return { kvlistValue: { values: toOtelAttributes(v as Record<string, unknown>) } };
      return { stringValue: String(v) };
    }
  }

  async forceFlush(): Promise<void> {
    // no-op
  }
}

function escapeHtml(s: string) {
  return s.replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );
}
