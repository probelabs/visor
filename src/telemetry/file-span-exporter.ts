// Minimal NDJSON SpanExporter for serverless mode.
import * as fs from 'fs';
import * as path from 'path';
import { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { ExportResult } from '@opentelemetry/core';

export interface FileSpanExporterOptions {
  dir?: string; // output directory
  runId?: string; // optional run id for file naming
  ndjson?: boolean; // when true, one span per line; default true
}

export class FileSpanExporter implements SpanExporter {
  private filePath: string;
  private buffer: any[] = [];
  private ndjson: boolean;

  constructor(opts: FileSpanExporterOptions = {}) {
    const outDir = opts.dir || path.join(process.cwd(), 'output', 'traces');
    this.ndjson = opts.ndjson !== false; // default true
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const run = opts.runId ? `${opts.runId}-` : '';
    const ext = this.ndjson ? 'ndjson' : 'json';
    this.filePath = path.join(outDir, `run-${run}${ts}.${ext}`);
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      if (this.ndjson) {
        // Buffer spans; write on shutdown for fewer fs ops
        for (const s of spans) this.buffer.push(serializeSpan(s));
      } else {
        for (const s of spans) this.buffer.push(serializeSpan(s));
      }
      resultCallback(ExportResult.SUCCESS);
    } catch (e) {
      resultCallback(ExportResult.FAILED);
    }
  }

  shutdown(): Promise<void> {
    return new Promise(resolve => {
      try {
        if (this.ndjson) {
          const fd = fs.openSync(this.filePath, 'w');
          for (const span of this.buffer) {
            fs.writeSync(fd, JSON.stringify(span));
            fs.writeSync(fd, '\n');
          }
          fs.closeSync(fd);
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
    events: s.events?.map(e => ({ name: e.name, time: e.time, attributes: e.attributes })),
    resource: s.resource?.attributes,
    kind: s.kind,
  };
}
