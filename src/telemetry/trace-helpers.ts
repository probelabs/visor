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
  // Check for active parent span BEFORE creating new span
  const activeCtx = otContext.active();
  const parentSpan = trace.getSpan(activeCtx);
  const parentId = parentSpan ? parentSpan.spanContext().spanId : 'NONE';
  // Avoid noisy stdout logs that break JSON consumers
  return await new Promise<T>((resolve, reject) => {
    const callback = async (span: Span) => {
      const ctx = span.spanContext();
      // console.debug(`[trace] Span callback invoked for: [trace_id=${ctx.traceId} span_id=${ctx.spanId}] ${name} span: true`);
      try {
        const res = await fn(span);
        // console.debug('[trace] Span execution completed for:', name);
        resolve(res);
      } catch (err) {
        // console.debug('[trace] Span execution errored for:', name, err);
        try {
          if (err instanceof Error) span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR });
        } catch {}
        reject(err);
      } finally {
        try {
          // console.debug('[trace] Ending span:', name);
          span.end();
        } catch {}
      }
    };
    // startActiveSpan should use the current active context to set parent automatically
    const options = attrs ? { attributes: attrs as Attributes } : {};
    tracer.startActiveSpan(name, options, callback as any);
  });
}

export function addEvent(name: string, attrs?: Record<string, unknown>): void {
  const span = trace.getSpan(otContext.active());
  if (span) {
    try {
      span.addEvent(name, attrs as Attributes);
    } catch {
      // ignore
    }
  }
  // Fallback NDJSON emission for serverless/file sink when SDK may be inactive
  try {
    const { emitNdjsonSpanWithEvents } = require('./fallback-ndjson');
    emitNdjsonSpanWithEvents('visor.event', {}, [{ name, attrs }]);
    if (name === 'fail_if.triggered') {
      emitNdjsonSpanWithEvents('visor.event', {}, [
        { name: 'fail_if.evaluated', attrs },
        { name: 'fail_if.triggered', attrs },
      ]);
    }
  } catch {}
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
    // Prefer explicit fallback file path if set by the CLI
    if (process.env.VISOR_FALLBACK_TRACE_FILE) {
      __ndjsonPath = process.env.VISOR_FALLBACK_TRACE_FILE;
      const dir = path.dirname(__ndjsonPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      return __ndjsonPath;
    }
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
