import {
  __esm,
  __export,
  __require
} from "./chunk-J7LXIPZS.mjs";

// src/telemetry/lazy-otel.ts
var lazy_otel_exports = {};
__export(lazy_otel_exports, {
  DiagConsoleLogger: () => DiagConsoleLogger,
  DiagLogLevel: () => DiagLogLevel,
  SpanKind: () => SpanKind,
  SpanStatusCode: () => SpanStatusCode,
  context: () => context,
  diag: () => diag,
  metrics: () => metrics,
  trace: () => trace
});
function getOtelApi() {
  if (otelApiAttempted) return otelApi;
  otelApiAttempted = true;
  try {
    otelApi = (function(name) {
      return __require(name);
    })(OTEL_API_MODULE);
  } catch {
    otelApi = null;
  }
  return otelApi;
}
function createNoOpTracer() {
  return {
    startSpan: () => createNoOpSpan(),
    // Support both OTel v1 and v2 overloads:
    // - startActiveSpan(name, callback)
    // - startActiveSpan(name, options, callback)
    // - startActiveSpan(name, options, context, callback)
    startActiveSpan: (name, arg2, arg3, arg4) => {
      const span = createNoOpSpan();
      let cb = void 0;
      if (typeof arg2 === "function") cb = arg2;
      else if (typeof arg3 === "function") cb = arg3;
      else if (typeof arg4 === "function") cb = arg4;
      if (typeof cb === "function") {
        try {
          return cb(span);
        } catch {
          return void 0;
        }
      }
      return span;
    }
  };
}
function createNoOpSpan() {
  return {
    spanContext: () => ({ traceId: "", spanId: "", traceFlags: 0 }),
    setAttribute: () => {
    },
    setAttributes: () => {
    },
    addEvent: () => {
    },
    setStatus: () => {
    },
    updateName: () => {
    },
    end: () => {
    },
    isRecording: () => false,
    recordException: () => {
    }
  };
}
function createNoOpMeter() {
  return {
    createCounter: () => ({ add: () => {
    } }),
    createHistogram: () => ({ record: () => {
    } }),
    createUpDownCounter: () => ({ add: () => {
    } }),
    createObservableGauge: () => {
    },
    createObservableCounter: () => {
    },
    createObservableUpDownCounter: () => {
    }
  };
}
var otelApi, otelApiAttempted, OTEL_API_MODULE, trace, context, metrics, SpanStatusCode, SpanKind, diag, DiagConsoleLogger, DiagLogLevel;
var init_lazy_otel = __esm({
  "src/telemetry/lazy-otel.ts"() {
    "use strict";
    otelApi = null;
    otelApiAttempted = false;
    OTEL_API_MODULE = "@opentelemetry/api";
    trace = {
      getTracer(name, version) {
        const api = getOtelApi();
        if (!api) return createNoOpTracer();
        return api.trace.getTracer(name, version);
      },
      getSpan(context2) {
        const api = getOtelApi();
        if (!api) return void 0;
        return api.trace.getSpan(context2);
      },
      getActiveSpan() {
        const api = getOtelApi();
        if (!api) return void 0;
        return api.trace.getActiveSpan();
      }
    };
    context = {
      active() {
        const api = getOtelApi();
        if (!api) return {};
        return api.context.active();
      },
      with(context2, fn, thisArg, ...args) {
        const api = getOtelApi();
        if (!api) return fn.call(thisArg, ...args);
        return api.context.with(context2, fn, thisArg, ...args);
      }
    };
    metrics = {
      getMeter(name, version) {
        const api = getOtelApi();
        if (!api?.metrics) return createNoOpMeter();
        return api.metrics.getMeter(name, version);
      }
    };
    SpanStatusCode = {
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
      }
    };
    SpanKind = {
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
      }
    };
    diag = {
      setLogger(logger, level) {
        const api = getOtelApi();
        if (!api) return;
        return api.diag.setLogger(logger, level);
      }
    };
    DiagConsoleLogger = {
      get() {
        const api = getOtelApi();
        return api?.DiagConsoleLogger;
      }
    };
    DiagLogLevel = {
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
      }
    };
  }
});

export {
  trace,
  context,
  metrics,
  SpanStatusCode,
  lazy_otel_exports,
  init_lazy_otel
};
//# sourceMappingURL=chunk-HEX3RL32.mjs.map