import * as fs from 'fs';
import * as path from 'path';
import { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { ExportResultCode } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import { HrTime } from '@opentelemetry/api';

function hrTimeToMillis(t: HrTime): number {
  return t[0] * 1000 + Math.floor(t[1] / 1e6);
}

export interface TraceReportExporterOptions {
  dir?: string;
  runId?: string;
}

export class TraceReportExporter implements SpanExporter {
  private spans: ReadableSpan[] = [];
  private outDir: string;
  private runId?: string;

  constructor(opts: TraceReportExporterOptions = {}) {
    this.outDir = opts.dir || path.join(process.cwd(), 'output', 'traces');
    this.runId = opts.runId;
    if (!fs.existsSync(this.outDir)) fs.mkdirSync(this.outDir, { recursive: true });
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
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

      // Compute time bounds
      const starts = this.spans.map(s => hrTimeToMillis(s.startTime));
      const ends = this.spans.map(s => hrTimeToMillis(s.endTime));
      const minStart = Math.min(...starts);
      const maxEnd = Math.max(...ends);
      const total = Math.max(1, maxEnd - minStart);

      // Serialize a light JSON
      const flat = this.spans.map(s => ({
        name: s.name,
        start: hrTimeToMillis(s.startTime),
        end: hrTimeToMillis(s.endTime),
        attrs: s.attributes,
        events: s.events?.map(e => ({ name: e.name, time: hrTimeToMillis(e.time), attrs: e.attributes })),
        traceId: s.spanContext().traceId,
        spanId: s.spanContext().spanId,
        parentSpanId: s.parentSpanId,
      }));
      fs.writeFileSync(jsonPath, JSON.stringify({ spans: flat }, null, 2), 'utf8');

      // Build minimal timeline HTML
      const rows = flat
        .sort((a, b) => a.start - b.start)
        .map(s => {
          const left = ((s.start - minStart) / total) * 100;
          const width = Math.max(0.5, ((s.end - s.start) / total) * 100);
          const label = `${s.name} (${s.end - s.start}ms)`;
          return `<div class="row"><div class="bar" style="left:${left}%;width:${width}%" title="${escapeHtml(
            label
          )}"></div><span class="label">${escapeHtml(label)}</span></div>`;
        })
        .join('\n');

      const html = `<!doctype html>
<html><head><meta charset="utf-8"/><title>Visor Trace Report</title>
<style>
body{font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;padding:16px;background:#0b0f14;color:#e6edf3}
.container{max-width:1200px;margin:0 auto}
.timeline{position:relative;border:1px solid #30363d;border-radius:6px;padding:8px;background:#161b22}
.row{position:relative;height:24px;margin:6px 0}
.bar{position:absolute;top:4px;height:16px;background:#1f6feb;border-radius:4px}
.label{position:absolute;left:8px;top:2px;font-size:12px;color:#c9d1d9}
.legend{display:flex;justify-content:space-between;margin:8px 0;font-size:12px;color:#8b949e}
</style></head>
<body><div class="container">
<h2>Visor Trace Report</h2>
<div class="legend"><div>Start: ${new Date(minStart).toISOString()}</div><div>Duration: ${
        maxEnd - minStart
      } ms</div></div>
<div class="timeline">${rows}</div>
<p style="margin-top:12px;font-size:12px;color:#8b949e">Saved JSON: ${path.basename(jsonPath)}</p>
</div></body></html>`;

      fs.writeFileSync(htmlPath, html, 'utf8');
    } catch {
      // ignore
    }
  }

  async forceFlush(): Promise<void> {
    // no-op
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
