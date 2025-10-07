import { context as otContext, Span, SpanStatusCode, trace } from '@opentelemetry/api';

export function getTracer() {
  return trace.getTracer('visor');
}

export async function withActiveSpan<T>(
  name: string,
  attrs: Record<string, unknown> | undefined,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = getTracer();
  return await tracer.startActiveSpan(name, attrs ? { attributes: attrs } : undefined, async span => {
    try {
      const res = await fn(span);
      return res;
    } catch (err) {
      if (err instanceof Error) span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

export function addEvent(name: string, attrs?: Record<string, unknown>): void {
  const span = trace.getSpan(otContext.active());
  if (!span) return;
  try {
    span.addEvent(name, attrs);
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
