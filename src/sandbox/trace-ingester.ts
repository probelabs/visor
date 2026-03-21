/**
 * Read child visor NDJSON trace files and re-emit spans into the parent's
 * telemetry context as proper child spans.
 *
 * Supports:
 * - one-shot ingestion after child exit
 * - incremental tailing while child is still running
 */

import { existsSync, readFileSync } from 'fs';
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
    attrs?: Record<string, unknown>;
  }>;
  kind?: number;
}

type OTelContextApi = {
  context: { active(): any; with(ctx: any, fn: () => void): void };
  trace?: {
    setSpan?(ctx: any, span: any): any;
    setSpanContext?(ctx: any, spanContext: any): any;
  };
  SpanStatusCode?: { ERROR?: number };
};

function getTracer(): any {
  try {
    const helpers = require('../telemetry/trace-helpers');
    return helpers.getTracer();
  } catch {
    return null;
  }
}

function getOtelContext(): OTelContextApi | null {
  try {
    return require('../telemetry/lazy-otel');
  } catch {
    return null;
  }
}

function buildFallbackSpanContext(child: ChildSpanRecord): {
  traceId: string;
  spanId: string;
  traceFlags: number;
  isRemote: boolean;
} | null {
  if (!child.traceId || !child.spanId) return null;
  return {
    traceId: child.traceId,
    spanId: child.spanId,
    traceFlags: 1,
    isRemote: true,
  };
}

function computeSpanKey(child: ChildSpanRecord): string {
  if (child.traceId && child.spanId) return `${child.traceId}:${child.spanId}`;
  const timing = JSON.stringify({
    name: child.name,
    startTime: child.startTime,
    endTime: child.endTime,
  });
  return `fallback:${timing}`;
}

function parseLines(text: string): ChildSpanRecord[] {
  const spans: ChildSpanRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      spans.push(JSON.parse(trimmed));
    } catch {
      // ignore malformed line
    }
  }
  return spans;
}

function emitChildSpan(
  tracer: any,
  otel: OTelContextApi | null,
  parentContext: any,
  child: ChildSpanRecord
): any {
  if (!child.name) return;
  if (child.name === 'visor.run' || child.name === 'visor.event') return;
  if (!child.traceId && !child.startTime) return;
  try {
    const spanOptions: Record<string, any> = {
      attributes: {
        'visor.sandbox.child_span': true,
        'visor.sandbox.original_trace_id': child.traceId || '',
        'visor.sandbox.original_span_id': child.spanId || '',
        'visor.sandbox.original_parent_span_id': child.parentSpanId || '',
        ...(child.attributes || {}),
      },
    };

    if (child.startTime) {
      spanOptions.startTime = child.startTime;
    }

    const span = tracer.startSpan(child.name, spanOptions, parentContext);

    if (Array.isArray(child.events)) {
      for (const evt of child.events) {
        const evtAttrs = evt.attributes || evt.attrs || {};
        if (evt.time) span.addEvent(evt.name, evtAttrs, evt.time);
        else span.addEvent(evt.name, evtAttrs);
      }
    }

    if (child.status?.code === 2) {
      try {
        span.setStatus({
          code: otel?.SpanStatusCode?.ERROR || 2,
          message: child.status.message,
        });
      } catch {}
    }

    if (child.endTime) span.end(child.endTime);
    else span.end();

    if (otel?.trace?.setSpan) {
      return otel.trace.setSpan(parentContext, span);
    }
    const fallbackSpanContext = buildFallbackSpanContext(child);
    if (fallbackSpanContext && otel?.trace?.setSpanContext) {
      return otel.trace.setSpanContext(parentContext, fallbackSpanContext);
    }
    return parentContext;
  } catch {
    // Non-fatal
    const fallbackSpanContext = buildFallbackSpanContext(child);
    if (fallbackSpanContext && otel?.trace?.setSpanContext) {
      try {
        return otel.trace.setSpanContext(parentContext, fallbackSpanContext);
      } catch {}
    }
    return parentContext;
  }
}

function ingestRecords(
  records: ChildSpanRecord[],
  seenKeys: Set<string>,
  parentContext?: any,
  replayContexts?: Map<string, any>
): number {
  if (records.length === 0) return 0;

  const tracer = getTracer();
  if (!tracer) {
    logger.info(`[trace-ingester] ${records.length} child spans (OTel unavailable)`);
    return 0;
  }

  const otel = getOtelContext();
  const effectiveParentContext = parentContext || otel?.context?.active?.();
  const replayParentContexts = replayContexts ?? new Map<string, any>();
  let ingested = 0;

  const pending = records.filter(child => {
    const key = computeSpanKey(child);
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });

  while (pending.length > 0) {
    let emittedInPass = 0;

    for (let i = 0; i < pending.length; ) {
      const child = pending[i];
      const hasKnownParent = !child.parentSpanId || replayParentContexts.has(child.parentSpanId);
      const parentCtx = child.parentSpanId
        ? replayParentContexts.get(child.parentSpanId) || effectiveParentContext
        : effectiveParentContext;

      if (!hasKnownParent && pending.some(candidate => candidate.spanId === child.parentSpanId)) {
        i += 1;
        continue;
      }

      const replayContext = emitChildSpan(tracer, otel, parentCtx, child);
      if (child.spanId && replayContext) {
        replayParentContexts.set(child.spanId, replayContext);
      }
      pending.splice(i, 1);
      ingested += 1;
      emittedInPass += 1;
    }

    if (emittedInPass === 0) {
      for (const child of pending.splice(0)) {
        const replayContext = emitChildSpan(tracer, otel, effectiveParentContext, child);
        if (child.spanId && replayContext) {
          replayParentContexts.set(child.spanId, replayContext);
        }
        ingested += 1;
      }
      break;
    }
  }

  return ingested;
}

export class ChildTraceTailer {
  private readonly filePath: string;
  private readonly pollIntervalMs: number;
  private readonly seenKeys: Set<string>;
  private readonly parentContext: any;
  private readonly replayContexts: Map<string, any>;
  private offset = 0;
  private partialLine = '';
  private timer: NodeJS.Timeout | null = null;
  private activePoll: Promise<void> | null = null;

  constructor(
    filePath: string,
    options?: { pollIntervalMs?: number; seenKeys?: Set<string>; parentContext?: any }
  ) {
    this.filePath = filePath;
    this.pollIntervalMs = options?.pollIntervalMs ?? 500;
    this.seenKeys = options?.seenKeys ?? new Set<string>();
    this.parentContext = options?.parentContext;
    this.replayContexts = new Map<string, any>();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.activePoll) {
        this.activePoll = this.pollOnce().finally(() => {
          this.activePoll = null;
        });
      }
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.activePoll) {
      await this.activePoll;
    }
    await this.pollOnce(true);
  }

  private async pollOnce(finalSweep = false): Promise<void> {
    if (!existsSync(this.filePath)) return;

    let buf: Buffer;
    try {
      buf = readFileSync(this.filePath);
    } catch {
      return;
    }

    if (buf.length < this.offset) {
      this.offset = 0;
      this.partialLine = '';
    }
    if (buf.length === this.offset && !finalSweep) {
      return;
    }

    const chunk = buf.subarray(this.offset).toString('utf8');
    this.offset = buf.length;

    if (!chunk && !finalSweep) return;

    const combined = this.partialLine + chunk;
    const endsWithNewline = combined.endsWith('\n');
    const lines = combined.split('\n');
    this.partialLine = endsWithNewline ? '' : lines.pop() || '';
    const completedText = lines.join('\n');
    const records = parseLines(completedText);
    ingestRecords(records, this.seenKeys, this.parentContext, this.replayContexts);

    if (finalSweep && this.partialLine.trim()) {
      const trailing = parseLines(this.partialLine);
      this.partialLine = '';
      ingestRecords(trailing, this.seenKeys, this.parentContext, this.replayContexts);
    }
  }
}

export function ingestChildTrace(
  filePath: string,
  options?: { seenKeys?: Set<string>; parentContext?: any }
): void {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  ingestRecords(
    parseLines(content),
    options?.seenKeys ?? new Set<string>(),
    options?.parentContext,
    new Map<string, any>()
  );
}
