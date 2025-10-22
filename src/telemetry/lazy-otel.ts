/**
 * Lazy-loading wrapper for OpenTelemetry API.
 * Returns no-op implementations if OpenTelemetry is not installed.
 * Uses hardcoded module name for security - no dynamic module loading.
 */

let otelApi: any = null;
let otelApiAttempted = false;

// Hardcoded allowed module name to prevent module loading attacks
const OTEL_API_MODULE = '@opentelemetry/api';

function getOtelApi() {
  if (otelApiAttempted) return otelApi;
  otelApiAttempted = true;

  try {
    // Security: Only load the specific @opentelemetry/api module
    otelApi = require(OTEL_API_MODULE);
  } catch {
    // OpenTelemetry not installed - provide no-op implementations
    otelApi = null;
  }

  return otelApi;
}

// Export lazy-loaded trace API
export const trace = {
  getTracer(name: string, version?: string) {
    const api = getOtelApi();
    if (!api) return createNoOpTracer();
    return api.trace.getTracer(name, version);
  },
  getSpan(context: any) {
    const api = getOtelApi();
    if (!api) return undefined;
    return api.trace.getSpan(context);
  },
  getActiveSpan() {
    const api = getOtelApi();
    if (!api) return undefined;
    return api.trace.getActiveSpan();
  },
};

// Export lazy-loaded context API
export const context = {
  active() {
    const api = getOtelApi();
    if (!api) return {};
    return api.context.active();
  },
  with(context: any, fn: Function, thisArg?: any, ...args: any[]) {
    const api = getOtelApi();
    if (!api) return fn.call(thisArg, ...args);
    return api.context.with(context, fn, thisArg, ...args);
  },
};

// Export lazy-loaded metrics API
export const metrics = {
  getMeter(name: string, version?: string) {
    const api = getOtelApi();
    if (!api?.metrics) return createNoOpMeter();
    return api.metrics.getMeter(name, version);
  },
};

// Export types and enums
export const SpanStatusCode = {
  get UNSET() {
    const api = getOtelApi();
    return api?.SpanStatusCode?.UNSET ?? 0;
  },
  get OK() {
    const api = getOtelApi();
    return api?.SpanStatusCode?.OK ?? 1;
  },
  get ERROR() {
    const api = getOtelApi();
    return api?.SpanStatusCode?.ERROR ?? 2;
  },
};

export const SpanKind = {
  get INTERNAL() {
    const api = getOtelApi();
    return api?.SpanKind?.INTERNAL ?? 0;
  },
  get SERVER() {
    const api = getOtelApi();
    return api?.SpanKind?.SERVER ?? 1;
  },
  get CLIENT() {
    const api = getOtelApi();
    return api?.SpanKind?.CLIENT ?? 2;
  },
  get PRODUCER() {
    const api = getOtelApi();
    return api?.SpanKind?.PRODUCER ?? 3;
  },
  get CONSUMER() {
    const api = getOtelApi();
    return api?.SpanKind?.CONSUMER ?? 4;
  },
};

// Export diag API
export const diag = {
  setLogger(logger: any, level?: any) {
    const api = getOtelApi();
    if (!api) return;
    return api.diag.setLogger(logger, level);
  },
};

// Lazy-loaded DiagConsoleLogger and DiagLogLevel for consistency
export const DiagConsoleLogger = {
  get() {
    const api = getOtelApi();
    return api?.DiagConsoleLogger;
  },
};

export const DiagLogLevel = {
  get NONE() {
    const api = getOtelApi();
    return api?.DiagLogLevel?.NONE ?? 0;
  },
  get ERROR() {
    const api = getOtelApi();
    return api?.DiagLogLevel?.ERROR ?? 30;
  },
  get WARN() {
    const api = getOtelApi();
    return api?.DiagLogLevel?.WARN ?? 50;
  },
  get INFO() {
    const api = getOtelApi();
    return api?.DiagLogLevel?.INFO ?? 60;
  },
  get DEBUG() {
    const api = getOtelApi();
    return api?.DiagLogLevel?.DEBUG ?? 70;
  },
  get VERBOSE() {
    const api = getOtelApi();
    return api?.DiagLogLevel?.VERBOSE ?? 80;
  },
  get ALL() {
    const api = getOtelApi();
    return api?.DiagLogLevel?.ALL ?? 9999;
  },
};

// Type exports for TypeScript
export type Span = any;
export type Attributes = Record<string, any>;
export type HrTime = [number, number];

// No-op implementations
function createNoOpTracer() {
  return {
    startSpan: () => createNoOpSpan(),
    startActiveSpan: (name: string, fn: any) => {
      if (typeof fn === 'function') return fn(createNoOpSpan());
      return createNoOpSpan();
    },
  };
}

function createNoOpSpan() {
  return {
    spanContext: () => ({ traceId: '', spanId: '', traceFlags: 0 }),
    setAttribute: () => {},
    setAttributes: () => {},
    addEvent: () => {},
    setStatus: () => {},
    updateName: () => {},
    end: () => {},
    isRecording: () => false,
    recordException: () => {},
  };
}

function createNoOpMeter() {
  return {
    createCounter: () => ({ add: () => {} }),
    createHistogram: () => ({ record: () => {} }),
    createUpDownCounter: () => ({ add: () => {} }),
    createObservableGauge: () => {},
    createObservableCounter: () => {},
    createObservableUpDownCounter: () => {},
  };
}
