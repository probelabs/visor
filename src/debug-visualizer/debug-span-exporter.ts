/**
 * Custom OpenTelemetry Span Exporter for Debug Visualizer
 *
 * Exports spans to the WebSocket server for live visualization
 * while also allowing them to be exported to other exporters (file, console, etc.)
 *
 * Milestone 4: Live Streaming Server
 * Note: This file is only loaded when telemetry is enabled via opentelemetry.ts
 */

import { DebugVisualizerServer, ProcessedSpan } from './ws-server';

// Conditional imports - these packages are optional dependencies
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReadableSpan = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExportResult = any;

// Load OTel packages only if available
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let otelCore: any;

try {
  otelCore = require('@opentelemetry/core');
} catch {
  // OpenTelemetry not installed - this file won't be used
  otelCore = null;
}

/**
 * OTEL Span Exporter that streams spans to debug visualizer WebSocket server
 */
export class DebugSpanExporter {
  private server: DebugVisualizerServer;

  constructor(server: DebugVisualizerServer) {
    this.server = server;
  }

  /**
   * Export spans to WebSocket server
   */
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const ExportResultCode = otelCore?.ExportResultCode || { SUCCESS: 0, FAILED: 1 };
    console.log(`[debug-exporter] Export called with ${spans.length} spans`);
    try {
      for (const span of spans) {
        console.log(`[debug-exporter] Converting and emitting span: ${span.name}`);
        const processedSpan = this.convertSpan(span);
        this.server.emitSpan(processedSpan);
      }

      console.log(`[debug-exporter] Successfully exported ${spans.length} spans`);
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      console.error('[debug-exporter] Failed to export spans:', error);
      resultCallback({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  /**
   * Shutdown the exporter
   */
  async shutdown(): Promise<void> {
    // Server shutdown is handled separately
    console.log('[debug-exporter] Shutdown called');
  }

  /**
   * Force flush any buffered spans (no-op for this exporter)
   */
  async forceFlush(): Promise<void> {
    // No buffering in this exporter
  }

  /**
   * Convert OTEL ReadableSpan to ProcessedSpan format
   */
  private convertSpan(span: ReadableSpan): ProcessedSpan {
    const attributes: Record<string, any> = {};

    // Convert OTEL attributes to plain object
    for (const [key, value] of Object.entries(span.attributes)) {
      attributes[key] = value;
    }

    // Debug: Detailed parent span ID logging
    const rawParent = (span as any).parentSpanId;
    console.log(
      `[debug-exporter] Span: ${span.name}, parent: ${span.parentSpanId || 'NONE'} (type: ${typeof rawParent})`
    );

    // Convert events
    const events = span.events.map((event: any) => ({
      name: event.name,
      time: this.hrTimeToTuple(event.time),
      timestamp: new Date(this.hrTimeToMillis(event.time)).toISOString(),
      attributes: event.attributes ? { ...event.attributes } : {},
    }));

    // Determine status
    const status = span.status.code === 2 ? 'error' : 'ok';

    // Calculate duration
    const startMs = this.hrTimeToMillis(span.startTime);
    const endMs = this.hrTimeToMillis(span.endTime);
    const duration = endMs - startMs;

    return {
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      startTime: this.hrTimeToTuple(span.startTime),
      endTime: this.hrTimeToTuple(span.endTime),
      duration,
      attributes,
      events,
      status,
    };
  }

  /**
   * Convert OTEL HrTime to [seconds, nanoseconds] tuple
   */
  private hrTimeToTuple(hrTime: [number, number]): [number, number] {
    return hrTime;
  }

  /**
   * Convert OTEL HrTime to milliseconds
   */
  private hrTimeToMillis(hrTime: [number, number]): number {
    return hrTime[0] * 1000 + hrTime[1] / 1_000_000;
  }
}

/**
 * Create a debug span exporter for a given server
 */
export function createDebugSpanExporter(server: DebugVisualizerServer): DebugSpanExporter {
  return new DebugSpanExporter(server);
}
