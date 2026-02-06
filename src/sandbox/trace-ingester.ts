/**
 * Read child visor NDJSON trace file and re-emit spans
 * into the parent's telemetry context as proper child spans.
 *
 * NDJSON format from FileSpanExporter:
 *   { traceId, spanId, parentSpanId?, name, startTime: [s,ns], endTime: [s,ns],
 *     status: { code, message? }, attributes, events?, kind }
 */

import { readFileSync } from 'fs';
import { logger } from '../logger';

interface ChildSpanRecord {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name: string;
  startTime?: [number, number];
  endTime?: [number, number];
  status?: { code?: number; message?: string };
  attributes?: Record<string, unknown>;
  events?: Array<{
    name: string;
    time?: [number, number];
    attributes?: Record<string, unknown>;
    attrs?: Record<string, unknown>; // fallback-ndjson uses 'attrs'
  }>;
  kind?: number;
}

/**
 * Try to obtain the OTel tracer. Returns null if OTel is not available.
 */
function getTracer(): any {
  try {
    const helpers = require('../telemetry/trace-helpers');
    return helpers.getTracer();
  } catch {
    return null;
  }
}

/**
 * Try to get the OTel context module for active span context.
 */
function getOtelContext(): any {
  try {
    return require('../telemetry/lazy-otel');
  } catch {
    return null;
  }
}

/**
 * Ingest child trace NDJSON file and re-emit each span as a proper
 * child span under the current active parent span.
 *
 * Spans are created with their original startTime/endTime so they
 * appear with correct timing in the trace viewer.
 *
 * Gracefully degrades to no-op if OTel is not available.
 */
export function ingestChildTrace(filePath: string): void {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return;
  }

  const lines = content.split('\n');
  const spans: ChildSpanRecord[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      spans.push(JSON.parse(trimmed));
    } catch {
      // Ignore malformed lines
    }
  }

  if (spans.length === 0) return;

  const tracer = getTracer();
  if (!tracer) {
    // No OTel — fall back to logging
    logger.info(`[trace-ingester] ${spans.length} child spans (OTel unavailable)`);
    return;
  }

  const otel = getOtelContext();

  // Re-emit each child span as a proper child span of the current parent
  for (const child of spans) {
    if (!child.name) continue;

    // Skip fallback markers and fallback-ndjson duplicates (no traceId = fallback emitter)
    if (child.name === 'visor.run' || child.name === 'visor.event') continue;
    if (!child.traceId && !child.startTime) continue; // fallback-ndjson record, skip

    try {
      const spanOptions: Record<string, any> = {
        attributes: {
          'visor.sandbox.child_span': true,
          ...(child.attributes || {}),
        },
      };

      // Preserve original timing if available
      if (child.startTime) {
        spanOptions.startTime = child.startTime;
      }

      const span = tracer.startSpan(`child: ${child.name}`, spanOptions);

      // Re-emit child events
      if (Array.isArray(child.events)) {
        for (const evt of child.events) {
          const evtAttrs = evt.attributes || evt.attrs || {};
          if (evt.time) {
            span.addEvent(evt.name, evtAttrs, evt.time);
          } else {
            span.addEvent(evt.name, evtAttrs);
          }
        }
      }

      // Set status if error
      if (child.status && child.status.code === 2) {
        try {
          const { SpanStatusCode } = otel || {};
          span.setStatus({
            code: SpanStatusCode?.ERROR || 2,
            message: child.status.message,
          });
        } catch {}
      }

      // End with original endTime if available
      if (child.endTime) {
        span.end(child.endTime);
      } else {
        span.end();
      }
    } catch {
      // Non-fatal: skip individual span re-emission errors
    }
  }
}
