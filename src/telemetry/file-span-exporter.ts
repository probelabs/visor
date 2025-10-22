// Minimal NDJSON SpanExporter for serverless mode.
// Note: This file is only loaded when telemetry is enabled via opentelemetry.ts
import * as fs from 'fs';
import * as path from 'path';

// Conditional imports - these packages are optional dependencies
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReadableSpan = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExportResult = any;

// Load OTel packages only if available
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let otelCore: any;

try {
  otelCore = require('@opentelemetry/core');
} catch {
  // OpenTelemetry not installed - this file won't be used
  otelCore = null;
}

export interface FileSpanExporterOptions {
  dir?: string; // output directory
  runId?: string; // optional run id for file naming
  ndjson?: boolean; // when true, one span per line; default true
}

export class FileSpanExporter {
  private filePath: string;
  private buffer: ReturnType<typeof serializeSpan>[] = [];
  private ndjson: boolean;

  constructor(opts: FileSpanExporterOptions = {}) {
    const outDir = opts.dir || path.join(process.cwd(), 'output', 'traces');
    this.ndjson = opts.ndjson !== false; // default true
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const run = opts.runId ? `${opts.runId}-` : '';
    const ext = this.ndjson ? 'ndjson' : 'json';
    // If CLI provided a fallback trace file path, prefer writing to it to unify outputs
    if (process.env.VISOR_FALLBACK_TRACE_FILE) {
      this.filePath = process.env.VISOR_FALLBACK_TRACE_FILE;
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } else {
      this.filePath = path.join(outDir, `run-${run}${ts}.${ext}`);
    }
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const ExportResultCode = otelCore?.ExportResultCode || { SUCCESS: 0, FAILED: 1 };
    try {
      if (this.ndjson) {
        for (const s of spans) {
          const line = JSON.stringify(serializeSpan(s)) + '\n';
          fs.appendFileSync(this.filePath, line, 'utf8');
        }
      } else {
        for (const s of spans) this.buffer.push(serializeSpan(s));
      }
      resultCallback({ code: ExportResultCode.SUCCESS } as ExportResult);
    } catch {
      resultCallback({ code: ExportResultCode.FAILED } as ExportResult);
    }
  }

  shutdown(): Promise<void> {
    return new Promise(resolve => {
      try {
        if (this.ndjson) {
          // already written incrementally
        } else {
          fs.writeFileSync(this.filePath, JSON.stringify({ spans: this.buffer }, null, 2), 'utf8');
        }
      } catch {
        // ignore
      }
      resolve();
    });
  }

  forceFlush(): Promise<void> {
    // No-op; we only write on shutdown for simplicity
    return Promise.resolve();
  }
}

function serializeSpan(s: ReadableSpan) {
  // Minimal subset for offline analysis; backends can transform to full OTLP if needed
  return {
    traceId: s.spanContext().traceId,
    spanId: s.spanContext().spanId,
    parentSpanId: s.parentSpanId,
    name: s.name,
    startTime: s.startTime,
    endTime: s.endTime,
    status: s.status,
    attributes: s.attributes,
    events: s.events?.map((e: any) => ({ name: e.name, time: e.time, attributes: e.attributes })),
    resource: s.resource?.attributes,
    kind: s.kind,
  };
}
