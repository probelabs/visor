/*
 * Visor OpenTelemetry bootstrap (lazy and optional).
 * - If OTel packages are present and telemetry is enabled, initialize NodeSDK.
 * - Supports OTLP HTTP exporter and serverless file exporter.
 * - Patches console to append trace context for log correlation (optional).
 */

import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

export interface TelemetryInitOptions {
  enabled?: boolean;
  sink?: 'otlp' | 'file' | 'console';
  otlp?: { endpoint?: string; headers?: string; protocol?: 'http' | 'grpc' };
  file?: { dir?: string; ndjson?: boolean; runId?: string };
  ciAlwaysOn?: boolean; // default true
  patchConsole?: boolean; // default true
  autoInstrument?: boolean; // enable @opentelemetry/auto-instrumentations-node
  traceReport?: boolean; // write a static HTML trace report
}

let sdk: any | null = null;
let patched = false;

export async function initTelemetry(opts: TelemetryInitOptions = {}): Promise<void> {
  const enabled = !!opts.enabled || process.env.VISOR_TELEMETRY_ENABLED === 'true';
  if (!enabled || sdk) return;

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Resource } = require('@opentelemetry/resources');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { BatchSpanProcessor, ConsoleSpanExporter } = require('@opentelemetry/sdk-trace-base');

    const sink = opts.sink || (process.env.VISOR_TELEMETRY_SINK as any) || 'file';

    const processors: any[] = [];

    if (sink === 'otlp') {
      const protocol = opts.otlp?.protocol || 'http';
      if (protocol === 'http') {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
        const exporter = new OTLPTraceExporter({
          url: opts.otlp?.endpoint || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
          headers: opts.otlp?.headers || process.env.OTEL_EXPORTER_OTLP_HEADERS,
        });
        processors.push(new BatchSpanProcessor(exporter, batchParams()));
      } else {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { OTLPTraceExporter: GrpcExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
          processors.push(new BatchSpanProcessor(new GrpcExporter({}), batchParams()));
        } catch {
          // fallback to console if grpc exporter not present
          processors.push(new BatchSpanProcessor(new ConsoleSpanExporter(), batchParams()));
        }
      }
    } else if (sink === 'console') {
      processors.push(new BatchSpanProcessor(new ConsoleSpanExporter(), batchParams()));
    } else {
      // file (serverless) exporter
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { FileSpanExporter } = require('./file-span-exporter');
      const exporter = new FileSpanExporter({ dir: opts.file?.dir, ndjson: opts.file?.ndjson, runId: opts.file?.runId });
      processors.push(new BatchSpanProcessor(exporter, batchParams()));
    }

    const resource = new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: 'visor',
      [SemanticResourceAttributes.SERVICE_VERSION]: process.env.VISOR_VERSION || 'dev',
      'deployment.environment': detectEnvironment(),
    });

    // Configure Metrics OTLP exporter when using 'otlp' sink
    let metricReader: any | undefined;
    if (sink === 'otlp') {
      try {
        const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
        const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
        const mExporter = new OTLPMetricExporter({
          url:
            process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ||
            process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
          headers: process.env.OTEL_EXPORTER_OTLP_HEADERS,
        });
        metricReader = new PeriodicExportingMetricReader({
          exporter: mExporter,
          exportIntervalMillis: 10000,
          exportTimeoutMillis: 10000,
        });
      } catch {
        // Metrics exporter not available; continue without metrics
      }
    }

    // Auto-instrumentations (optional)
    let instrumentations: any[] | undefined;
    const autoInstr =
      opts.autoInstrument === true || process.env.VISOR_TELEMETRY_AUTO_INSTRUMENTATIONS === 'true';
    if (autoInstr) {
      try {
        const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
        instrumentations = [getNodeAutoInstrumentations()];
      } catch {
        // ignore if package not installed
      }
    }

    // Optional Trace Report exporter (writes static HTML) added as an extra span processor
    if (opts.traceReport === true || process.env.VISOR_TRACE_REPORT === 'true') {
      try {
        const { TraceReportExporter } = require('./trace-report-exporter');
        const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
        processors.push(new BatchSpanProcessor(new TraceReportExporter({ dir: opts.file?.dir, runId: opts.file?.runId })));
      } catch {
        // ignore
      }
    }

    sdk = new NodeSDK({
      resource,
      spanProcessor: processors.length === 1 ? processors[0] : undefined,
      spanProcessors: processors.length > 1 ? processors : undefined,
      metricReader,
      instrumentations,
      // Auto-instrumentations can be added later when desired
    });

    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);
    await sdk.start();

    if (opts.patchConsole !== false) patchConsole();
  } catch (e) {
    // OTel not installed or failed to init; continue silently
  }
}

export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    // ignore
  } finally {
    sdk = null;
  }
}

function detectEnvironment(): string {
  if (process.env.GITHUB_ACTIONS) return 'github-actions';
  if (process.env.CI) return 'ci';
  return 'local';
}

function batchParams() {
  return {
    maxQueueSize: 65536,
    maxExportBatchSize: 8192,
    scheduledDelayMillis: 1000,
    exportTimeoutMillis: 10000,
  };
}

function patchConsole() {
  if (patched) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { context, trace } = require('@opentelemetry/api');
    const methods: Array<'log' | 'info' | 'warn' | 'error'> = ['log', 'info', 'warn', 'error'];
    for (const m of methods) {
      // @ts-ignore
      const orig = console[m].bind(console);
      // @ts-ignore
      console[m] = (...args: unknown[]) => {
        const span = trace.getSpan(context.active());
        const ctx = span?.spanContext();
        if (ctx) {
          try {
            const suffix = ` [trace_id=${ctx.traceId} span_id=${ctx.spanId}]`;
            if (typeof args[0] === 'string') args[0] = (args[0] as string) + suffix;
            else args.push(suffix);
          } catch {/* noop */}
        }
        return orig(...args as [unknown]);
      };
    }
    patched = true;
  } catch {
    // ignore
  }
}
