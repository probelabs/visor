import { context as otContext, Span, SpanStatusCode, trace, Attributes } from '@opentelemetry/api';

export function getTracer() {
  return trace.getTracer('visor');
}

export async function withActiveSpan<T>(
  name: string,
  attrs: Record<string, unknown> | undefined,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = getTracer();
  return await new Promise<T>((resolve, reject) => {
    const callback = async (span: Span) => {
      try {
        const res = await fn(span);
        resolve(res);
      } catch (err) {
        try {
          if (err instanceof Error) span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR });
        } catch {}
        reject(err);
      } finally {
        try {
          span.end();
        } catch {}
      }
    };
    if (attrs) {
      tracer.startActiveSpan(name, { attributes: attrs as Attributes }, callback);
    } else {
      tracer.startActiveSpan(name, callback as (span: Span) => void);
    }
  });
}

export function addEvent(name: string, attrs?: Record<string, unknown>): void {
  const span = trace.getSpan(otContext.active());
  if (!span) return;
  try {
    span.addEvent(name, attrs as Attributes);
  } catch {
    // ignore
  }
}

export function setSpanAttributes(attrs: Record<string, unknown>): void {
  const span = trace.getSpan(otContext.active());
  if (!span) return;
  try {
    for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v as never);
  } catch {
    // ignore
  }
}

export function setSpanError(err: unknown): void {
  const span = trace.getSpan(otContext.active());
  if (!span) return;
  try {
    if (err instanceof Error) span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR });
  } catch {
    // ignore
  }
}

// Internal helper for tests: write a minimal run marker to NDJSON when using file sink
let __ndjsonPath: string | null = null;
export function __getOrCreateNdjsonPath(): string | null {
  try {
    if (process.env.VISOR_TELEMETRY_SINK !== 'file') return null;
    const path = require('path');
    const fs = require('fs');
    const outDir = process.env.VISOR_TRACE_DIR || path.join(process.cwd(), 'output', 'traces');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    if (!__ndjsonPath) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      __ndjsonPath = path.join(outDir, `${ts}.ndjson`);
    }
    return __ndjsonPath;
  } catch {
    return null;
  }
}
export function _appendRunMarker(): void {
  try {
    const fs = require('fs');
    const p = __getOrCreateNdjsonPath();
    if (!p) return;
    const line = { name: 'visor.run', attributes: { started: true } };
    fs.appendFileSync(p, JSON.stringify(line) + '\n', 'utf8');
  } catch {}
}
