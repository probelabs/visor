/**
 * Trace File Reader & Processor
 *
 * Reads OpenTelemetry NDJSON trace files and reconstructs execution tree structure
 * for the Debug Visualizer.
 *
 * Milestone 2: Trace File Reader
 */

import * as fs from 'fs';
import * as readline from 'readline';

// ============================================================================
// Core Data Structures
// ============================================================================

/**
 * OTEL span event with attributes
 */
export interface SpanEvent {
  name: string;
  time: [number, number]; // [seconds, nanoseconds]
  timestamp?: string; // ISO timestamp for convenience
  attributes?: Record<string, any>;
}

/**
 * Processed OTEL span with clean structure
 */
export interface ProcessedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: [number, number]; // [seconds, nanoseconds]
  endTime: [number, number]; // [seconds, nanoseconds]
  duration: number; // milliseconds
  attributes: Record<string, any>;
  events: SpanEvent[];
  status: 'ok' | 'error';
}

/**
 * Hierarchical execution tree node
 */
export interface ExecutionNode {
  checkId: string;
  type: string; // 'run', 'check', 'provider'
  status: 'pending' | 'running' | 'completed' | 'error' | 'skipped';
  children: ExecutionNode[];
  span: ProcessedSpan;
  state: {
    inputContext?: any;
    output?: any;
    errors?: string[];
    metadata?: Record<string, any>;
  };
}

/**
 * State snapshot for time-travel debugging
 */
export interface StateSnapshot {
  checkId: string;
  timestamp: string;
  timestampNanos: [number, number];
  outputs: Record<string, any>;
  memory: Record<string, any>;
}

/**
 * Timeline event for visualization
 */
export interface TimelineEvent {
  type: 'check.started' | 'check.completed' | 'check.failed' | 'state.snapshot' | 'event';
  checkId?: string;
  timestamp: string;
  timestampNanos: [number, number];
  duration?: number;
  status?: string;
  metadata?: Record<string, any>;
}

/**
 * Complete parsed execution trace
 */
export interface ExecutionTrace {
  runId: string;
  traceId: string;
  spans: ProcessedSpan[];
  tree: ExecutionNode;
  timeline: TimelineEvent[];
  snapshots: StateSnapshot[];
  metadata: {
    startTime: string;
    endTime: string;
    duration: number; // milliseconds
    totalSpans: number;
    totalSnapshots: number;
  };
}

// ============================================================================
// NDJSON Parser
// ============================================================================

/**
 * Parse NDJSON trace file and return structured execution trace
 *
 * @param filePath - Path to NDJSON trace file
 * @returns Parsed execution trace with tree, timeline, and snapshots
 */
export async function parseNDJSONTrace(filePath: string): Promise<ExecutionTrace> {
  const spans: ProcessedSpan[] = [];
  let lineNumber = 0;

  // Read file line by line
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lineNumber++;

    // Skip empty lines
    if (!line.trim()) {
      continue;
    }

    try {
      const rawSpan = JSON.parse(line);
      const processedSpan = processRawSpan(rawSpan);
      spans.push(processedSpan);
    } catch (error) {
      console.warn(`[trace-reader] Malformed JSON at line ${lineNumber}: ${error}`);
      // Continue parsing remaining lines
    }
  }

  if (spans.length === 0) {
    throw new Error('No valid spans found in trace file');
  }

  // Build execution tree
  const tree = buildExecutionTree(spans);

  // Extract state snapshots
  const snapshots = extractStateSnapshots(spans);

  // Compute timeline
  const timeline = computeTimeline(spans);

  // Calculate metadata
  const sortedSpans = [...spans].sort((a, b) =>
    compareTimeValues(a.startTime, b.startTime)
  );
  const firstSpan = sortedSpans[0];
  const lastSpan = sortedSpans[sortedSpans.length - 1];

  const startTimeMs = timeValueToMillis(firstSpan.startTime);
  const endTimeMs = timeValueToMillis(lastSpan.endTime);

  return {
    runId: tree.checkId,
    traceId: firstSpan.traceId,
    spans,
    tree,
    timeline,
    snapshots,
    metadata: {
      startTime: timeValueToISO(firstSpan.startTime),
      endTime: timeValueToISO(lastSpan.endTime),
      duration: endTimeMs - startTimeMs,
      totalSpans: spans.length,
      totalSnapshots: snapshots.length,
    },
  };
}

/**
 * Process raw OTEL span into clean structure
 */
function processRawSpan(rawSpan: any): ProcessedSpan {
  // Extract span IDs
  const traceId = rawSpan.traceId || '';
  const spanId = rawSpan.spanId || '';
  const parentSpanId = rawSpan.parentSpanId || undefined;

  // Extract name
  const name = rawSpan.name || 'unknown';

  // Extract times
  const startTime = rawSpan.startTime || [0, 0];
  const endTime = rawSpan.endTime || rawSpan.startTime || [0, 0];

  // Calculate duration in milliseconds
  const startMs = timeValueToMillis(startTime);
  const endMs = timeValueToMillis(endTime);
  const duration = endMs - startMs;

  // Extract attributes
  const attributes = rawSpan.attributes || {};

  // Extract events
  const events: SpanEvent[] = (rawSpan.events || []).map((evt: any) => ({
    name: evt.name || 'unknown',
    time: evt.time || [0, 0],
    timestamp: evt.timestamp || timeValueToISO(evt.time || [0, 0]),
    attributes: evt.attributes || {},
  }));

  // Determine status
  const status = rawSpan.status?.code === 2 ? 'error' : 'ok';

  return {
    traceId,
    spanId,
    parentSpanId,
    name,
    startTime,
    endTime,
    duration,
    attributes,
    events,
    status,
  };
}

// ============================================================================
// Execution Tree Builder
// ============================================================================

/**
 * Build hierarchical execution tree from flat list of spans
 *
 * @param spans - List of processed spans
 * @returns Root execution node with children
 */
export function buildExecutionTree(spans: ProcessedSpan[]): ExecutionNode {
  // Create map of spanId -> ExecutionNode
  const nodeMap = new Map<string, ExecutionNode>();

  // First pass: create all nodes
  for (const span of spans) {
    const node = createExecutionNode(span);
    nodeMap.set(span.spanId, node);
  }

  // Second pass: build parent-child relationships
  let rootNode: ExecutionNode | undefined;

  for (const span of spans) {
    const node = nodeMap.get(span.spanId)!;

    if (!span.parentSpanId) {
      // This is the root node (visor.run)
      rootNode = node;
    } else {
      // Find parent and add as child
      const parent = nodeMap.get(span.parentSpanId);
      if (parent) {
        parent.children.push(node);
      } else {
        // Orphaned span - parent not found
        console.warn(`[trace-reader] Orphaned span: ${span.spanId} (parent: ${span.parentSpanId})`);
      }
    }
  }

  if (!rootNode) {
    // No root found, create synthetic root
    console.warn('[trace-reader] No root span found, creating synthetic root');
    rootNode = {
      checkId: 'synthetic-root',
      type: 'run',
      status: 'completed',
      children: Array.from(nodeMap.values()).filter(n => !n.span.parentSpanId),
      span: spans[0], // Use first span as placeholder
      state: {},
    };
  }

  return rootNode;
}

/**
 * Create execution node from span
 */
function createExecutionNode(span: ProcessedSpan): ExecutionNode {
  const attrs = span.attributes;

  // Extract check ID
  const checkId = attrs['visor.check.id'] ||
                  attrs['visor.run.id'] ||
                  span.spanId;

  // Determine type
  let type = 'unknown';
  if (span.name === 'visor.run') {
    type = 'run';
  } else if (span.name === 'visor.check') {
    type = 'check';
  } else if (span.name.startsWith('visor.provider.')) {
    type = 'provider';
  }

  // Determine status
  let status: ExecutionNode['status'] = 'completed';
  if (span.status === 'error') {
    status = 'error';
  } else if (attrs['visor.check.skipped'] === true) {
    status = 'skipped';
  }

  // Extract state
  const state: ExecutionNode['state'] = {};

  // Input context
  if (attrs['visor.check.input.context']) {
    try {
      state.inputContext = JSON.parse(attrs['visor.check.input.context']);
    } catch {
      state.inputContext = attrs['visor.check.input.context'];
    }
  }

  // Output
  if (attrs['visor.check.output']) {
    try {
      state.output = JSON.parse(attrs['visor.check.output']);
    } catch {
      state.output = attrs['visor.check.output'];
    }
  }

  // Errors
  if (span.status === 'error' || attrs['visor.check.error']) {
    state.errors = [attrs['visor.check.error'] || 'Unknown error'];
  }

  // Additional metadata
  state.metadata = {
    type: attrs['visor.check.type'],
    duration: span.duration,
    provider: attrs['visor.provider.type'],
  };

  return {
    checkId,
    type,
    status,
    children: [],
    span,
    state,
  };
}

// ============================================================================
// State Snapshot Extractor
// ============================================================================

/**
 * Extract state snapshots from spans for time-travel debugging
 *
 * @param spans - List of processed spans
 * @returns Array of state snapshots sorted by timestamp
 */
export function extractStateSnapshots(spans: ProcessedSpan[]): StateSnapshot[] {
  const snapshots: StateSnapshot[] = [];

  for (const span of spans) {
    // Find state.snapshot events
    for (const event of span.events) {
      if (event.name === 'state.snapshot') {
        const attrs = event.attributes || {};

        const snapshot: StateSnapshot = {
          checkId: attrs['visor.snapshot.check_id'] || span.attributes['visor.check.id'] || 'unknown',
          timestamp: attrs['visor.snapshot.timestamp'] || event.timestamp || timeValueToISO(event.time),
          timestampNanos: event.time,
          outputs: parseJSON(attrs['visor.snapshot.outputs'], {}),
          memory: parseJSON(attrs['visor.snapshot.memory'], {}),
        };

        snapshots.push(snapshot);
      }
    }
  }

  // Sort by timestamp
  snapshots.sort((a, b) => compareTimeValues(a.timestampNanos, b.timestampNanos));

  return snapshots;
}

// ============================================================================
// Timeline Generator
// ============================================================================

/**
 * Compute chronological timeline of execution events
 *
 * @param spans - List of processed spans
 * @returns Array of timeline events sorted chronologically
 */
export function computeTimeline(spans: ProcessedSpan[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const span of spans) {
    const checkId = span.attributes['visor.check.id'] || span.spanId;

    // Check started event
    events.push({
      type: 'check.started',
      checkId,
      timestamp: timeValueToISO(span.startTime),
      timestampNanos: span.startTime,
      metadata: {
        name: span.name,
        type: span.attributes['visor.check.type'],
      },
    });

    // Check completed/failed event
    events.push({
      type: span.status === 'error' ? 'check.failed' : 'check.completed',
      checkId,
      timestamp: timeValueToISO(span.endTime),
      timestampNanos: span.endTime,
      duration: span.duration,
      status: span.status,
      metadata: {
        name: span.name,
      },
    });

    // Add span events (state.snapshot, etc.)
    for (const evt of span.events) {
      events.push({
        type: evt.name === 'state.snapshot' ? 'state.snapshot' : 'event',
        checkId: evt.attributes?.['visor.snapshot.check_id'] || checkId,
        timestamp: evt.timestamp || timeValueToISO(evt.time),
        timestampNanos: evt.time,
        metadata: {
          eventName: evt.name,
          attributes: evt.attributes,
        },
      });
    }
  }

  // Sort chronologically
  events.sort((a, b) => compareTimeValues(a.timestampNanos, b.timestampNanos));

  return events;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Convert OTEL time value [seconds, nanoseconds] to milliseconds
 */
function timeValueToMillis(timeValue: [number, number]): number {
  const [seconds, nanos] = timeValue;
  return seconds * 1000 + nanos / 1_000_000;
}

/**
 * Convert OTEL time value to ISO timestamp string
 */
function timeValueToISO(timeValue: [number, number]): string {
  const millis = timeValueToMillis(timeValue);
  return new Date(millis).toISOString();
}

/**
 * Compare two time values for sorting
 * Returns: -1 if a < b, 0 if a === b, 1 if a > b
 */
function compareTimeValues(a: [number, number], b: [number, number]): number {
  if (a[0] !== b[0]) {
    return a[0] - b[0];
  }
  return a[1] - b[1];
}

/**
 * Safely parse JSON string, return default on error
 */
function parseJSON<T>(value: any, defaultValue: T): T {
  if (typeof value !== 'string') {
    return defaultValue;
  }

  try {
    return JSON.parse(value);
  } catch {
    return defaultValue;
  }
}
