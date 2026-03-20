import { context as otContext, Span, SpanStatusCode, trace, Attributes } from './lazy-otel';
import { getInstanceId } from '../utils/instance-id';

export function getTracer() {
  return trace.getTracer('visor');
}

export async function withActiveSpan<T>(
  name: string,
  attrs: Record<string, unknown> | undefined,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = getTracer();
  // Preserve parent context via tracer API; avoid logging parent IDs to stdout
  // Avoid noisy stdout logs that break JSON consumers
  return await new Promise<T>((resolve, reject) => {
    const callback = async (span: Span) => {
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
    tracer.startActiveSpan(name, options, callback);
  });
}

export function emitImmediateSpan(
  name: string,
  attrs?: Record<string, unknown>,
  options?: {
    events?: Array<{ name: string; attrs?: Record<string, unknown> }>;
    status?: { code?: number; message?: string };
  }
): void {
  try {
    const startHr = process.hrtime();
    const tracer = getTracer();
    const span = tracer.startSpan(name, attrs ? { attributes: attrs as Attributes } : undefined);
    try {
      for (const evt of options?.events || []) {
        span.addEvent(evt.name, (evt.attrs || {}) as Attributes);
      }
      if (options?.status) {
        span.setStatus(options.status as never);
      }
    } finally {
      span.end();
    }
    try {
      const { emitNdjsonFullSpan } = require('./fallback-ndjson');
      const activeParent = trace.getSpan(otContext.active());
      const parentCtx = activeParent?.spanContext?.();
      const ctx = span.spanContext?.();
      const endHr = process.hrtime();
      emitNdjsonFullSpan({
        name,
        traceId: ctx?.traceId || parentCtx?.traceId || randomTraceId(),
        spanId: ctx?.spanId || randomSpanId(),
        parentSpanId: parentCtx?.spanId,
        startTime: [startHr[0], startHr[1]],
        endTime: [endHr[0], endHr[1]],
        attributes: attrs || {},
        events: (options?.events || []).map(evt => ({
          name: evt.name,
          attributes: evt.attrs || {},
        })),
        status: options?.status,
      });
    } catch {
      // ignore fallback emission errors
    }
    try {
      const { requestThrottledTelemetryFlush } = require('./opentelemetry');
      requestThrottledTelemetryFlush();
    } catch {
      // ignore best-effort flush scheduling errors
    }
  } catch {
    // ignore
  }
}

function randomSpanId(): string {
  return require('crypto').randomBytes(8).toString('hex');
}

function randomTraceId(): string {
  return require('crypto').randomBytes(16).toString('hex');
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

/**
 * Return standard visor.* resource attributes for the root `visor.run` span.
 * Reads version from package.json / env and git commit short SHA from env.
 */
export function getVisorRunAttributes(): Record<string, string> {
  const attrs: Record<string, string> = {};
  try {
    attrs['visor.version'] =
      process.env.VISOR_VERSION || (require('../../package.json')?.version ?? 'dev');
  } catch {
    attrs['visor.version'] = 'dev';
  }
  const commitShort = process.env.VISOR_COMMIT_SHORT || '';
  const commitFull = process.env.VISOR_COMMIT_SHA || process.env.VISOR_COMMIT || '';
  if (commitShort) {
    attrs['visor.commit'] = commitShort;
  }
  if (commitFull) {
    attrs['visor.commit.sha'] = commitFull;
  }
  attrs['visor.instance_id'] = getInstanceId();
  return attrs;
}

/**
 * Wraps a visor.run span with automatic run metrics (counter + duration histogram).
 * Use this instead of raw `withActiveSpan('visor.run', ...)` to get metrics for free.
 */
export async function withVisorRun<T>(
  attrs: Record<string, unknown>,
  runMeta: {
    source?: string;
    userId?: string;
    userName?: string;
    workflowId?: string;
  },
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const {
    recordRunStart,
    recordRunDuration,
    resetRunAiCalls,
    recordRunAiCalls,
    getRunAiCalls,
  } = require('./metrics');
  const instanceId = getInstanceId();
  recordRunStart({
    source: runMeta.source,
    userId: runMeta.userId,
    userName: runMeta.userName,
    workflowId: runMeta.workflowId,
    instanceId,
  });
  resetRunAiCalls();
  const startMs = Date.now();
  let success = true;
  try {
    return await withActiveSpan('visor.run', attrs, async span => {
      try {
        return await fn(span);
      } finally {
        // Record AI call count as span attribute for trace visibility
        try {
          span.setAttribute('visor.run.ai_calls', getRunAiCalls());
          span.setAttribute('visor.run.duration_ms', Date.now() - startMs);
        } catch {}
      }
    });
  } catch (err) {
    success = false;
    throw err;
  } finally {
    recordRunAiCalls({
      source: runMeta.source,
      workflowId: runMeta.workflowId,
    });
    recordRunDuration(Date.now() - startMs, {
      source: runMeta.source,
      userId: runMeta.userId,
      workflowId: runMeta.workflowId,
      success,
    });
  }
}

// Internal helper for tests: write a minimal run marker to NDJSON when using file sink
let __ndjsonPath: string | null = null;
export function __getOrCreateNdjsonPath(): string | null {
  try {
    // If sink is explicitly set to non-file, skip. If unset, still allow when a trace dir/file is configured.
    if (process.env.VISOR_TELEMETRY_SINK && process.env.VISOR_TELEMETRY_SINK !== 'file')
      return null;
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
