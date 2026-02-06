/**
 * Telemetry helpers for sandbox modules.
 * Wraps imports from ../telemetry/trace-helpers with graceful fallback
 * when the telemetry module is not available (e.g., before merging with main).
 */

type SpanFn<T> = (span: unknown) => Promise<T>;

let _traceHelpers: {
  withActiveSpan: <T>(
    name: string,
    attrs: Record<string, unknown> | undefined,
    fn: SpanFn<T>
  ) => Promise<T>;
  addEvent: (name: string, attrs?: Record<string, unknown>) => void;
  setSpanError: (err: unknown) => void;
} | null = null;

let _attempted = false;

function getTraceHelpers() {
  if (_attempted) return _traceHelpers;
  _attempted = true;
  try {
    _traceHelpers = require('../telemetry/trace-helpers');
  } catch {
    _traceHelpers = null;
  }
  return _traceHelpers;
}

export async function withActiveSpan<T>(
  name: string,
  attrs: Record<string, unknown> | undefined,
  fn: (span: unknown) => Promise<T>
): Promise<T> {
  const helpers = getTraceHelpers();
  if (helpers) {
    return helpers.withActiveSpan(name, attrs, fn);
  }
  // No-op: just run the function with a dummy span
  return fn({});
}

export function addEvent(name: string, attrs?: Record<string, unknown>): void {
  const helpers = getTraceHelpers();
  if (helpers) {
    helpers.addEvent(name, attrs);
  }
}

export function setSpanError(err: unknown): void {
  const helpers = getTraceHelpers();
  if (helpers) {
    helpers.setSpanError(err);
  }
}
