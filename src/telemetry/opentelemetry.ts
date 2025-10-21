/*
 * Visor OpenTelemetry bootstrap (lazy and optional).
 * - If OTel packages are present and telemetry is enabled, initialize NodeSDK.
 * - Supports OTLP HTTP exporter and serverless file exporter.
 * - Patches console to append trace context for log correlation (optional).
 */

import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { MetricReader } from '@opentelemetry/sdk-metrics';
import type { NodeSDK as NodeSDKType } from '@opentelemetry/sdk-node';
import type { Instrumentation } from '@opentelemetry/instrumentation';
import type { DebugVisualizerServer } from '../debug-visualizer/ws-server';

export interface TelemetryInitOptions {
  enabled?: boolean;
  sink?: 'otlp' | 'file' | 'console';
  otlp?: { endpoint?: string; headers?: string; protocol?: 'http' | 'grpc' };
  file?: { dir?: string; ndjson?: boolean; runId?: string };
  ciAlwaysOn?: boolean; // default true
  patchConsole?: boolean; // default true
  autoInstrument?: boolean; // enable @opentelemetry/auto-instrumentations-node
  traceReport?: boolean; // write a static HTML trace report
  debugServer?: DebugVisualizerServer; // debug visualizer server for live streaming
}

let sdk: NodeSDKType | null = null;
let patched = false;

/**
 * Reset telemetry state (for testing only).
 * This forcefully resets the SDK singleton.
 */
export function resetTelemetryForTesting(): void {
  sdk = null;
  patched = false;
}

export async function initTelemetry(opts: TelemetryInitOptions = {}): Promise<void> {
  // Enable telemetry if explicitly enabled, env var is set, OR if debugServer is provided
  const enabled =
    !!opts.enabled || !!opts.debugServer || process.env.VISOR_TELEMETRY_ENABLED === 'true';
  // Avoid writing to stdout to keep CLI JSON output clean
  if (!enabled || sdk) return;

  try {
    // IMPORTANT: Set up AsyncHooksContextManager as the global context manager FIRST
    // This must happen before any OpenTelemetry operations
    const otelApi = require('@opentelemetry/api');
    const { AsyncHooksContextManager } = require('@opentelemetry/context-async-hooks');
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
    // console.debug('[telemetry] AsyncHooksContextManager enabled and set as global');

    const { NodeSDK } = require('@opentelemetry/sdk-node');

    // Support both OpenTelemetry v1 and v2 APIs
    const resourcesModule = require('@opentelemetry/resources');
    const semanticConventions = require('@opentelemetry/semantic-conventions');

    const { BatchSpanProcessor, ConsoleSpanExporter } = require('@opentelemetry/sdk-trace-base');

    const sink = (opts.sink || (process.env.VISOR_TELEMETRY_SINK as string) || 'file') as
      | 'otlp'
      | 'file'
      | 'console';

    const processors: SpanProcessor[] = [];

    // Prepare a single fallback NDJSON file per run when using file sink
    if (!process.env.VISOR_FALLBACK_TRACE_FILE && sink === 'file') {
      try {
        const fs = require('fs');
        const path = require('path');
        const outDir =
          opts.file?.dir ||
          process.env.VISOR_TRACE_DIR ||
          path.join(process.cwd(), 'output', 'traces');
        fs.mkdirSync(outDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        process.env.VISOR_FALLBACK_TRACE_FILE = path.join(outDir, `run-${ts}.ndjson`);
      } catch {}
    }

    if (sink === 'otlp') {
      const protocol = opts.otlp?.protocol || 'http';
      if (protocol === 'http') {
        const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
        const exporter = new OTLPTraceExporter({
          url:
            opts.otlp?.endpoint ||
            process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
            process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
          headers: opts.otlp?.headers || process.env.OTEL_EXPORTER_OTLP_HEADERS,
        });
        processors.push(new BatchSpanProcessor(exporter, batchParams()));
      } else {
        try {
          const {
            OTLPTraceExporter: GrpcExporter,
          } = require('@opentelemetry/exporter-trace-otlp-grpc');
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

      const { FileSpanExporter } = require('./file-span-exporter');
      const exporter = new FileSpanExporter({
        dir: opts.file?.dir || process.env.VISOR_TRACE_DIR,
        ndjson: opts.file?.ndjson,
        runId: opts.file?.runId,
      });
      processors.push(new BatchSpanProcessor(exporter, batchParams()));
    }

    // Create resource - support both v1 (new Resource()) and v2 (resourceFromAttributes())
    let resource;
    if (resourcesModule.Resource) {
      // OpenTelemetry v1 API
      resource = new resourcesModule.Resource({
        [semanticConventions.SemanticResourceAttributes.SERVICE_NAME]: 'visor',
        [semanticConventions.SemanticResourceAttributes.SERVICE_VERSION]:
          process.env.VISOR_VERSION || 'dev',
        'deployment.environment': detectEnvironment(),
      });
    } else {
      // OpenTelemetry v2 API
      resource = resourcesModule.resourceFromAttributes({
        [semanticConventions.ATTR_SERVICE_NAME]: 'visor',
        [semanticConventions.ATTR_SERVICE_VERSION]: process.env.VISOR_VERSION || 'dev',
        'deployment.environment': detectEnvironment(),
      });
    }

    // Configure Metrics OTLP exporter when using 'otlp' sink
    let metricReader: MetricReader | undefined;
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
    let instrumentations: Instrumentation[] | undefined;
    const autoInstr =
      opts.autoInstrument === true || process.env.VISOR_TELEMETRY_AUTO_INSTRUMENTATIONS === 'true';
    if (autoInstr) {
      try {
        const {
          getNodeAutoInstrumentations,
        } = require('@opentelemetry/auto-instrumentations-node');
        instrumentations = [getNodeAutoInstrumentations() as unknown as Instrumentation];
      } catch {
        // ignore if package not installed
      }
    }

    // Optional Trace Report exporter (writes static HTML) added as an extra span processor
    if (opts.traceReport === true || process.env.VISOR_TRACE_REPORT === 'true') {
      try {
        const { TraceReportExporter } = require('./trace-report-exporter');
        const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
        processors.push(
          new BatchSpanProcessor(
            new TraceReportExporter({
              dir: opts.file?.dir || process.env.VISOR_TRACE_DIR,
              runId: opts.file?.runId,
            })
          )
        );
      } catch {
        // ignore
      }
    }

    // Add debug span exporter for live streaming to WebSocket server
    if (opts.debugServer) {
      // Debug span exporter streams live spans to the visualizer server
      try {
        const { DebugSpanExporter } = require('../debug-visualizer/debug-span-exporter');
        const { SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
        const debugExporter = new DebugSpanExporter(opts.debugServer);
        processors.push(new SimpleSpanProcessor(debugExporter));
        // console.debug('[telemetry] Debug span exporter added successfully, total processors:', processors.length);
      } catch (error) {
        console.error('[telemetry] Failed to initialize debug span exporter:', error);
      }
    }

    // Create a composite span processor if there are multiple processors
    let spanProcessor: SpanProcessor;
    if (processors.length > 1) {
      // Create a simple composite processor
      spanProcessor = {
        onStart: (span: any, context: any) => {
          processors.forEach(p => p.onStart?.(span, context));
        },
        onEnd: (span: any) => {
          processors.forEach(p => p.onEnd?.(span));
        },
        shutdown: async () => {
          await Promise.all(processors.map(p => p.shutdown()));
        },
        forceFlush: async () => {
          await Promise.all(processors.map(p => p.forceFlush()));
        },
      } as SpanProcessor;
    } else {
      spanProcessor = processors[0];
    }

    const nodeSdk: NodeSDKType = new NodeSDK({
      resource,
      spanProcessor,
      metricReader,
      instrumentations,
      // Context manager is already set globally above
      // Auto-instrumentations can be added later when desired
    });

    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);
    await nodeSdk.start();
    sdk = nodeSdk;
    // console.debug('[telemetry] NodeSDK started successfully');

    if (opts.patchConsole !== false) patchConsole();
  } catch (error) {
    // OTel not installed or failed to init; continue silently
    console.error('[telemetry] Failed to initialize OTel SDK:', error);
  }
}

export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  try {
    try {
      const { flushNdjson } = require('./fallback-ndjson');
      await flushNdjson();
    } catch {}
    await sdk.shutdown();
  } catch {
    // ignore
  } finally {
    sdk = null;
    try {
      if (process.env.VISOR_TRACE_REPORT === 'true') {
        const fs = require('fs');
        const path = require('path');
        const outDir = process.env.VISOR_TRACE_DIR || path.join(process.cwd(), 'output', 'traces');
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const htmlPath = path.join(outDir, `${ts}.report.html`);
        if (!fs.existsSync(htmlPath)) {
          fs.writeFileSync(
            htmlPath,
            '<!doctype html><html><head><meta charset="utf-8"/><title>Visor Trace Report</title></head><body><h2>Visor Trace Report</h2></body></html>',
            'utf8'
          );
        }
      }
    } catch {}
    // Do not emit synthetic NDJSON lines here; real events are produced
    // from evaluators/providers and exported by the SDK.
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
    const { context, trace } = require('@opentelemetry/api');
    const methods: Array<'log' | 'info' | 'warn' | 'error'> = ['log', 'info', 'warn', 'error'];
    const c = globalThis.console as Console;
    for (const m of methods) {
      const orig = (c[m] as (...a: unknown[]) => void).bind(c);
      (c as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => {
        const span = trace.getSpan(context.active());
        const ctx = span?.spanContext();
        if (ctx) {
          try {
            const suffix = ` [trace_id=${ctx.traceId} span_id=${ctx.spanId}]`;
            if (typeof args[0] === 'string') args[0] = (args[0] as string) + suffix;
            else args.push(suffix);
          } catch {
            /* noop */
          }
        }
        return orig(...(args as [unknown]));
      };
    }
    patched = true;
  } catch {
    // ignore
  }
}
