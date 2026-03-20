/**
 * Trace serializer for LLM evaluation prompts and CLI display.
 *
 * Supports multiple trace backends:
 * 1. Grafana Tempo (via Grafana datasource proxy or direct Tempo API)
 * 2. Jaeger (via Jaeger HTTP API)
 * 3. Local NDJSON files (Visor's file-span-exporter OTEL format)
 *
 * Auto-detects the backend from environment variables:
 * - OTEL_EXPORTER_OTLP_ENDPOINT + VISOR_TELEMETRY_SINK=otlp → probe Grafana/Jaeger
 * - VISOR_TRACE_BACKEND=grafana|jaeger|file (explicit override)
 * - GRAFANA_URL, GRAFANA_TEMPO_DATASOURCE_ID → Grafana Tempo
 * - JAEGER_URL → Jaeger
 * - Falls back to local file scan
 */

import * as fs from 'fs';
import * as readline from 'readline';
import * as path from 'path';
import { logger } from '../logger';

// ---------------------------------------------------------------------------
// Trace backend configuration
// ---------------------------------------------------------------------------

export interface TraceBackendConfig {
  type: 'grafana' | 'jaeger' | 'file' | 'auto';
  /** Grafana base URL, e.g. http://localhost:3000 */
  grafanaUrl?: string;
  /** Grafana Tempo datasource ID (default: auto-detect) */
  grafanaDatasourceId?: string | number;
  /** Jaeger base URL, e.g. http://localhost:16686 */
  jaegerUrl?: string;
  /** Local trace directory (default: output/traces) */
  traceDir?: string;
  /** Auth token for remote APIs */
  authToken?: string;
}

function resolveBackendConfig(overrides?: Partial<TraceBackendConfig>): TraceBackendConfig {
  const explicit = process.env.VISOR_TRACE_BACKEND as TraceBackendConfig['type'] | undefined;

  return {
    type: overrides?.type || explicit || 'auto',
    grafanaUrl: overrides?.grafanaUrl || process.env.GRAFANA_URL,
    grafanaDatasourceId: overrides?.grafanaDatasourceId || process.env.GRAFANA_TEMPO_DATASOURCE_ID,
    jaegerUrl: overrides?.jaegerUrl || process.env.JAEGER_URL,
    traceDir: overrides?.traceDir || process.env.VISOR_TRACE_DIR || 'output/traces',
    authToken: overrides?.authToken || process.env.GRAFANA_TOKEN,
  };
}

// ---------------------------------------------------------------------------
// Unified span type (normalized from all backends)
// ---------------------------------------------------------------------------

interface NormalizedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  attributes: Record<string, string | number | boolean>;
  events: Array<{ name: string; attributes: Record<string, string | number | boolean> }>;
  status: 'ok' | 'error';
}

interface SpanTree {
  span: NormalizedSpan;
  children: SpanTree[];
}

// ---------------------------------------------------------------------------
// OTLP response parsing (shared by Grafana Tempo and Jaeger)
// ---------------------------------------------------------------------------

/**
 * Parse OTLP JSON trace response (Tempo/Jaeger format) into normalized spans.
 * Format: { batches: [{ scopeSpans: [{ spans: [...] }] }] }
 * Jaeger variant: { data: [{ spans: [...] }] }
 */
function parseOTLPResponse(data: any): NormalizedSpan[] {
  const spans: NormalizedSpan[] = [];

  // Grafana Tempo OTLP format
  if (data.batches) {
    for (const batch of data.batches) {
      for (const ss of batch.scopeSpans || []) {
        for (const s of ss.spans || []) {
          spans.push(normalizeOTLPSpan(s));
        }
      }
    }
    return spans;
  }

  // Jaeger native format
  if (data.data && Array.isArray(data.data)) {
    for (const trace of data.data) {
      for (const s of trace.spans || []) {
        spans.push(normalizeJaegerSpan(s, trace.traceID));
      }
    }
    return spans;
  }

  return spans;
}

function normalizeOTLPSpan(s: any): NormalizedSpan {
  const startNs = parseInt(s.startTimeUnixNano || '0', 10);
  const endNs = parseInt(s.endTimeUnixNano || '0', 10);

  // Decode base64 span/trace IDs if needed, or use hex strings
  const traceId = decodeOTLPId(s.traceId);
  const spanId = decodeOTLPId(s.spanId);
  const parentSpanId = s.parentSpanId ? decodeOTLPId(s.parentSpanId) : undefined;

  const attributes: Record<string, string | number | boolean> = {};
  for (const attr of s.attributes || []) {
    const val = attr.value;
    if (val.stringValue !== undefined) attributes[attr.key] = val.stringValue;
    else if (val.intValue !== undefined) attributes[attr.key] = parseInt(val.intValue, 10);
    else if (val.boolValue !== undefined) attributes[attr.key] = val.boolValue;
    else if (val.doubleValue !== undefined) attributes[attr.key] = val.doubleValue;
  }

  const events: NormalizedSpan['events'] = [];
  for (const evt of s.events || []) {
    const evtAttrs: Record<string, string | number | boolean> = {};
    for (const a of evt.attributes || []) {
      const v = a.value;
      if (v.stringValue !== undefined) evtAttrs[a.key] = v.stringValue;
      else if (v.intValue !== undefined) evtAttrs[a.key] = parseInt(v.intValue, 10);
    }
    events.push({ name: evt.name, attributes: evtAttrs });
  }

  return {
    traceId,
    spanId,
    parentSpanId,
    name: s.name || 'unknown',
    startTimeMs: startNs / 1e6,
    endTimeMs: endNs / 1e6,
    durationMs: (endNs - startNs) / 1e6,
    attributes,
    events,
    status: s.status?.code === 2 ? 'error' : 'ok',
  };
}

function normalizeJaegerSpan(s: any, traceId: string): NormalizedSpan {
  const attributes: Record<string, string | number | boolean> = {};
  for (const tag of s.tags || []) {
    attributes[tag.key] = tag.value;
  }

  const events: NormalizedSpan['events'] = [];
  for (const log of s.logs || []) {
    const evtAttrs: Record<string, string | number | boolean> = {};
    for (const f of log.fields || []) evtAttrs[f.key] = f.value;
    events.push({ name: (evtAttrs['event'] as string) || 'log', attributes: evtAttrs });
  }

  // Jaeger uses microseconds
  const startUs = s.startTime || 0;
  const durationUs = s.duration || 0;

  return {
    traceId,
    spanId: s.spanID,
    parentSpanId: s.references?.find((r: any) => r.refType === 'CHILD_OF')?.spanID,
    name: s.operationName || 'unknown',
    startTimeMs: startUs / 1000,
    endTimeMs: (startUs + durationUs) / 1000,
    durationMs: durationUs / 1000,
    attributes,
    events,
    status:
      attributes['otel.status_code'] === 'ERROR' || attributes['error'] === true ? 'error' : 'ok',
  };
}

/**
 * OTLP trace/span IDs may be base64-encoded. Decode to hex string.
 */
function decodeOTLPId(id: string): string {
  if (!id) return '';
  // Already hex? (only hex chars)
  if (/^[0-9a-f]+$/i.test(id)) return id.toLowerCase();
  // Base64 → hex
  try {
    return Buffer.from(id, 'base64').toString('hex');
  } catch {
    return id;
  }
}

// ---------------------------------------------------------------------------
// Local NDJSON file parsing
// ---------------------------------------------------------------------------

function parseLocalNDJSONSpans(spans: any[]): NormalizedSpan[] {
  return spans.map(s => {
    const startMs = timeValueToMs(s.startTime || [0, 0]);
    const endMs = timeValueToMs(s.endTime || s.startTime || [0, 0]);
    const events: NormalizedSpan['events'] = (s.events || []).map((e: any) => ({
      name: e.name,
      attributes: e.attributes || {},
    }));

    return {
      traceId: s.traceId || '',
      spanId: s.spanId || '',
      parentSpanId: s.parentSpanId || undefined,
      name: s.name || 'unknown',
      startTimeMs: startMs,
      endTimeMs: endMs,
      durationMs: endMs - startMs,
      attributes: s.attributes || {},
      events,
      status: s.status?.code === 2 ? 'error' : 'ok',
    };
  });
}

function timeValueToMs(tv: [number, number]): number {
  return tv[0] * 1000 + tv[1] / 1e6;
}

// ---------------------------------------------------------------------------
// Trace fetching — multi-backend
// ---------------------------------------------------------------------------

/**
 * Fetch trace spans by trace ID. Tries backends in order:
 * 1. Explicit backend (config.type)
 * 2. Grafana Tempo (auto-detect)
 * 3. Jaeger (auto-detect)
 * 4. Local NDJSON files
 */
export async function fetchTraceSpans(
  traceId: string,
  config?: Partial<TraceBackendConfig>
): Promise<NormalizedSpan[]> {
  const cfg = resolveBackendConfig(config);

  const tryGrafana = cfg.type === 'grafana' || cfg.type === 'auto';
  const tryJaeger = cfg.type === 'jaeger' || cfg.type === 'auto';
  const tryFile = cfg.type === 'file' || cfg.type === 'auto';

  // 1. Grafana Tempo
  if (tryGrafana) {
    const spans = await fetchFromGrafanaTempo(traceId, cfg);
    if (spans && spans.length > 0) return spans;
  }

  // 2. Jaeger
  if (tryJaeger) {
    const spans = await fetchFromJaeger(traceId, cfg);
    if (spans && spans.length > 0) return spans;
  }

  // 3. Local files
  if (tryFile) {
    const spans = await fetchFromLocalFiles(traceId, cfg);
    if (spans && spans.length > 0) return spans;
  }

  return [];
}

async function fetchFromGrafanaTempo(
  traceId: string,
  cfg: TraceBackendConfig
): Promise<NormalizedSpan[] | null> {
  // Auto-detect Grafana URL from OTLP endpoint
  let grafanaUrl = cfg.grafanaUrl;
  if (!grafanaUrl) {
    const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (otlpEndpoint) {
      // Common pattern: OTLP on 4318, Grafana on 3000 or mapped port
      // Try common Grafana ports on same host
      const url = new URL(otlpEndpoint);
      const host = url.hostname;
      for (const port of ['3000', '8001', '80']) {
        try {
          const testUrl = `http://${host}:${port}/api/health`;
          const resp = await httpGet(testUrl, cfg.authToken, 2000);
          if (resp && resp.includes('"database"')) {
            grafanaUrl = `http://${host}:${port}`;
            break;
          }
        } catch {}
      }
    }
  }

  if (!grafanaUrl) return null;

  try {
    // Auto-detect Tempo datasource ID
    let dsId = cfg.grafanaDatasourceId;
    if (!dsId) {
      const dsResp = await httpGet(`${grafanaUrl}/api/datasources`, cfg.authToken);
      if (dsResp) {
        const datasources = JSON.parse(dsResp);
        const tempo = datasources.find((d: any) => d.type === 'tempo');
        if (tempo) dsId = tempo.id;
      }
    }
    if (!dsId) return null;

    const traceUrl = `${grafanaUrl}/api/datasources/proxy/${dsId}/api/traces/${traceId}`;
    const resp = await httpGet(traceUrl, cfg.authToken);
    if (!resp) return null;

    const data = JSON.parse(resp);
    return parseOTLPResponse(data);
  } catch (err) {
    logger.debug(`[TraceSerializer] Grafana Tempo fetch failed: ${err}`);
    return null;
  }
}

async function fetchFromJaeger(
  traceId: string,
  cfg: TraceBackendConfig
): Promise<NormalizedSpan[] | null> {
  let jaegerUrl = cfg.jaegerUrl;
  if (!jaegerUrl) {
    // Auto-detect: try common Jaeger ports on localhost
    const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const host = otlpEndpoint ? new URL(otlpEndpoint).hostname : 'localhost';
    for (const port of ['16686']) {
      try {
        const testUrl = `http://${host}:${port}/api/services`;
        const resp = await httpGet(testUrl, undefined, 2000);
        if (resp && resp.includes('"data"')) {
          jaegerUrl = `http://${host}:${port}`;
          break;
        }
      } catch {}
    }
  }
  if (!jaegerUrl) return null;

  try {
    const traceUrl = `${jaegerUrl}/api/traces/${traceId}`;
    const resp = await httpGet(traceUrl, cfg.authToken);
    if (!resp) return null;

    const data = JSON.parse(resp);
    return parseOTLPResponse(data);
  } catch (err) {
    logger.debug(`[TraceSerializer] Jaeger fetch failed: ${err}`);
    return null;
  }
}

async function fetchFromLocalFiles(
  traceId: string,
  cfg: TraceBackendConfig
): Promise<NormalizedSpan[] | null> {
  const traceFile = await findTraceFile(traceId, cfg.traceDir);
  if (!traceFile) return null;

  try {
    const { parseNDJSONTrace } = await import('../debug-visualizer/trace-reader');
    const trace = await parseNDJSONTrace(traceFile);
    return parseLocalNDJSONSpans(trace.spans as any[]);
  } catch (err) {
    logger.debug(`[TraceSerializer] Local file parse failed: ${err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function httpGet(
  url: string,
  authToken?: string,
  timeoutMs?: number
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs || 10000);

    const headers: Record<string, string> = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

    const resp = await fetch(url, {
      signal: controller.signal,
      headers,
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Trace file discovery (local NDJSON files)
// ---------------------------------------------------------------------------

/**
 * Find the NDJSON trace file matching a given trace ID.
 * Scans the first line of each `.ndjson` file in the trace directory.
 */
export async function findTraceFile(traceId: string, traceDir?: string): Promise<string | null> {
  const dir = traceDir || process.env.VISOR_TRACE_DIR || 'output/traces';
  if (!fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.ndjson'));

  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const firstLine = await readFirstLine(filePath);
      if (!firstLine) continue;
      const parsed = JSON.parse(firstLine);
      if (parsed.traceId === traceId) return filePath;
    } catch {
      // skip malformed files
    }
  }

  return null;
}

async function readFirstLine(filePath: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let resolved = false;
    rl.on('line', (line: string) => {
      if (!resolved) {
        resolved = true;
        rl.close();
        stream.destroy();
        resolve(line.trim() || null);
      }
    });
    rl.on('close', () => {
      if (!resolved) resolve(null);
    });
    rl.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Noise filtering
// ---------------------------------------------------------------------------

/** Span names that are pure infrastructure noise and should be filtered out */
const NOISE_SPAN_NAMES = new Set([
  'engine.state.init',
  'engine.state.waveplanning',
  'engine.state.planready',
  'visor.sandbox.stopAll',
]);

/** Span names that are redundant wrappers — lift their children up */
const WRAPPER_SPAN_NAMES = new Set([
  'engine.state.leveldispatch',
  'visor.ai_check',
  'probe.delegation',
]);

function isNoiseSpan(span: NormalizedSpan): boolean {
  return NOISE_SPAN_NAMES.has(span.name);
}

function isWrapperSpan(span: NormalizedSpan): boolean {
  return WRAPPER_SPAN_NAMES.has(span.name);
}

// ---------------------------------------------------------------------------
// Build span tree from flat list (with noise filtering)
// ---------------------------------------------------------------------------

function buildSpanTree(spans: NormalizedSpan[]): SpanTree {
  // First filter out pure noise spans
  const filtered = spans.filter(s => !isNoiseSpan(s));

  const nodeMap = new Map<string, SpanTree>();

  // Create all nodes
  for (const span of filtered) {
    nodeMap.set(span.spanId, { span, children: [] });
  }

  // Build parent-child relationships
  let root: SpanTree | undefined;
  for (const span of filtered) {
    const node = nodeMap.get(span.spanId)!;
    if (!span.parentSpanId) {
      root = node;
    } else {
      // Walk up to find nearest non-filtered ancestor
      let parentId: string | undefined = span.parentSpanId;
      while (parentId && !nodeMap.has(parentId)) {
        // Parent was filtered — find grandparent from original spans
        const parentSpan = spans.find(s => s.spanId === parentId);
        parentId = parentSpan?.parentSpanId;
      }
      if (parentId) {
        const parent = nodeMap.get(parentId);
        if (parent) parent.children.push(node);
      } else if (!root) {
        root = node;
      }
    }
  }

  // If no root found, pick the span with the longest duration
  if (!root) {
    const sorted = [...nodeMap.values()].sort((a, b) => b.span.durationMs - a.span.durationMs);
    root = sorted[0] || { span: filtered[0], children: [] };
  }

  // Sort children by start time
  const sortChildren = (node: SpanTree) => {
    node.children.sort((a, b) => a.span.startTimeMs - b.span.startTimeMs);
    node.children.forEach(sortChildren);
  };
  sortChildren(root);

  // Unwrap wrapper spans — lift children up and discard the wrapper
  const unwrap = (node: SpanTree): SpanTree => {
    // Recursively process children first
    node.children = node.children.map(unwrap);

    // Flatten: replace wrapper children with their children
    const newChildren: SpanTree[] = [];
    for (const child of node.children) {
      if (isWrapperSpan(child.span)) {
        // Lift grandchildren up
        newChildren.push(...child.children);
      } else {
        newChildren.push(child);
      }
    }
    node.children = newChildren;
    return node;
  };
  unwrap(root);

  // Remove redundant probe.event.tool.result spans that are siblings of
  // search.delegate spans — these are aggregate results echoed back to the
  // parent AI and duplicate info already shown inside the delegate subtree
  const removeDelegateEchos = (node: SpanTree): void => {
    const hasDelegateChild = node.children.some(c => c.span.name === 'search.delegate');
    if (hasDelegateChild) {
      node.children = node.children.filter(c => {
        if (c.span.name !== 'probe.event.tool.result') return true;
        const toolName = c.span.attributes['tool.name'];
        // Remove search echoes — their details are inside search.delegate
        return toolName !== 'search';
      });
    }
    node.children.forEach(removeDelegateEchos);
  };
  removeDelegateEchos(root);

  return root;
}

// ---------------------------------------------------------------------------
// Compact tree rendering
// ---------------------------------------------------------------------------

export interface RenderTreeOptions {
  maxDepth?: number;
  maxChars?: number;
  /** Fallback intent text for AI spans whose input is too truncated */
  fallbackIntent?: string;
  /** When true, don't truncate output/intent previews */
  fullOutput?: boolean;
  /** Final task response from the task store (full, not OTEL-truncated) */
  taskResponse?: string;
}

/**
 * Tracks displayed outputs and intents to avoid repeating the same text.
 * When a duplicate is detected, shows "= <first-span-name>" instead.
 */
interface DeduplicationContext {
  /** Map from normalized output prefix → span name that first displayed it */
  outputs: Map<string, string>;
  /** Map from normalized intent prefix → span name that first displayed it */
  intents: Map<string, string>;
}

/** Normalize text for dedup comparison: lowercase, collapse whitespace, take prefix */
function dedupeKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 100).toLowerCase();
}

/** Check if text was already displayed; if so return the reference name. Otherwise register it. */
function dedupeOrRegister(
  ctx: DeduplicationContext,
  kind: 'outputs' | 'intents',
  text: string,
  spanName: string
): string | null {
  if (!text || text.length < 20) return null;
  const key = dedupeKey(text);
  if (!key) return null;
  const map = ctx[kind];
  const existing = map.get(key);
  if (existing && existing !== spanName) {
    return existing;
  }
  // Cross-check: intents against outputs and vice versa
  const otherMap = kind === 'outputs' ? ctx.intents : ctx.outputs;
  const crossRef = otherMap.get(key);
  if (crossRef && crossRef !== spanName) {
    map.set(key, spanName);
    return crossRef;
  }
  map.set(key, spanName);
  return null;
}

/**
 * Serialize a trace (by ID) into a compact text tree for LLM prompts.
 * Auto-detects the backend (Grafana Tempo, Jaeger, local files).
 */
export async function serializeTraceForPrompt(
  traceIdOrPath: string,
  maxChars?: number,
  backendConfig?: Partial<TraceBackendConfig>,
  /** Final task response from the task store (not truncated by OTEL) */
  taskResponse?: string,
  /** Trace ID to try remote backends first (preferred over local file) */
  fallbackTraceId?: string
): Promise<string> {
  let spans: NormalizedSpan[] = [];
  const isFilePath = traceIdOrPath.includes('/') || traceIdOrPath.endsWith('.ndjson');

  // Always try remote backends first (Grafana Tempo, Jaeger) — they have
  // full span structure with IDs, timestamps, and parent-child relationships.
  // The local NDJSON fallback file only has minimal event markers.
  const remoteTraceId = fallbackTraceId || (!isFilePath ? traceIdOrPath : undefined);
  if (remoteTraceId) {
    spans = await fetchTraceSpans(remoteTraceId, backendConfig);
  }

  // Fall back to local file only when remote returned nothing
  if (spans.length === 0 && isFilePath) {
    try {
      const { parseNDJSONTrace } = await import('../debug-visualizer/trace-reader');
      const trace = await parseNDJSONTrace(traceIdOrPath);
      spans = parseLocalNDJSONSpans(trace.spans as any[]);
    } catch {
      // file may not exist or be malformed
    }
  }

  // Last resort: if traceIdOrPath wasn't tried as a trace ID yet, try it
  if (spans.length === 0 && !remoteTraceId && !isFilePath) {
    spans = await fetchTraceSpans(traceIdOrPath, backendConfig);
  }

  if (spans.length === 0) {
    return '(no trace data available)';
  }

  const tree = buildSpanTree(spans);

  // Extract the route-intent topic as a global fallback for AI intent
  const routeIntentTopic = extractRouteIntentTopic(spans);

  // maxChars > 100k signals "full" mode (no truncation of previews)
  const fullOutput = (maxChars ?? 4000) > 100000;

  return renderSpanYaml(tree, spans, {
    maxChars: maxChars ?? 4000,
    fallbackIntent: routeIntentTopic,
    fullOutput,
    taskResponse,
  });
}

/**
 * Render a span tree as a compact ASCII tree with durations and details.
 */
export function renderSpanTree(tree: SpanTree, opts?: RenderTreeOptions): string {
  const maxChars = opts?.maxChars ?? 4000;
  const maxDepth = opts?.maxDepth ?? 20;
  const lines: string[] = [];

  const dedup: DeduplicationContext = { outputs: new Map(), intents: new Map() };
  renderNode(
    tree,
    '',
    true,
    0,
    maxDepth,
    lines,
    undefined,
    opts?.fallbackIntent,
    opts?.fullOutput,
    dedup
  );

  let result = lines.join('\n');
  if (result.length > maxChars) {
    result = result.slice(0, maxChars - 20) + '\n... (truncated)';
  }
  return result;
}

// Keep backward compat — renderTraceTree delegates to renderSpanTree with adapter
export function renderTraceTree(
  tree: any, // ExecutionNode from trace-reader
  opts?: RenderTreeOptions
): string {
  // Convert ExecutionNode tree to SpanTree
  const convert = (node: any): SpanTree => ({
    span: {
      traceId: node.span?.traceId || '',
      spanId: node.span?.spanId || '',
      parentSpanId: node.span?.parentSpanId,
      name: node.span?.name || node.checkId || 'unknown',
      startTimeMs: timeValueToMs(node.span?.startTime || [0, 0]),
      endTimeMs: timeValueToMs(node.span?.endTime || [0, 0]),
      durationMs: node.span?.duration || 0,
      attributes: node.span?.attributes || {},
      events: (node.span?.events || []).map((e: any) => ({
        name: e.name,
        attributes: e.attributes || {},
      })),
      status: node.status === 'error' ? 'error' : 'ok',
    },
    children: (node.children || []).map(convert),
  });
  return renderSpanTree(convert(tree), opts);
}

// ---------------------------------------------------------------------------
// YAML-based renderer
// ---------------------------------------------------------------------------

/**
 * Render a span tree as YAML-like structured output.
 * More readable than ASCII tree for JSON inputs/outputs.
 */
export function renderSpanYaml(
  tree: SpanTree,
  allSpans: NormalizedSpan[],
  opts?: RenderTreeOptions
): string {
  const fullOutput = opts?.fullOutput ?? false;
  const maxLen = fullOutput ? 100000 : 120;
  const dedup: DeduplicationContext = { outputs: new Map(), intents: new Map() };
  const lines: string[] = [];

  renderYamlNode(tree, 0, lines, dedup, opts?.fallbackIntent, fullOutput, maxLen);

  // Append the final task response from the task store (not OTEL-truncated)
  if (opts?.taskResponse) {
    // Remove any trailing dedup line like "output: = generate-response"
    while (lines.length > 0 && /^\s*output:\s*=\s*\S+/.test(lines[lines.length - 1])) {
      lines.pop();
    }
    const ml = fullOutput ? 100000 : 500;
    const text = opts.taskResponse.replace(/\*\*/g, '').replace(/`/g, '').trim();
    if (fullOutput) {
      lines.push('  response: |');
      for (const line of text.split('\n')) {
        lines.push(`    ${line}`);
      }
    } else {
      const truncated = truncate(text.replace(/\n/g, ' '), ml);
      lines.push(`  response: ${truncated}`);
      if (text.length > ml) {
        lines.push('  # use --full for complete response');
      }
    }
  }

  return lines.join('\n');
}

function renderYamlNode(
  node: SpanTree,
  indent: number,
  lines: string[],
  dedup: DeduplicationContext,
  fallbackIntent?: string,
  fullOutput?: boolean,
  maxLen?: number,
  parentSpan?: NormalizedSpan
): void {
  const pad = '  '.repeat(indent);
  const attrs = node.span.attributes;
  const duration = formatDurationMs(node.span.durationMs);
  const name = node.span.name;
  const ml = maxLen ?? 120;

  // Helper: get display name — for AI spans, use parent check name
  const parentCheckId = parentSpan?.attributes['visor.check.id'];
  const parentCheckName = parentCheckId
    ? String(parentCheckId).replace(/^visor\.check\./, '')
    : undefined;
  const displayName =
    name === 'ai.request' && parentCheckName
      ? parentCheckName
      : String(attrs['visor.check.id'] || name).replace(/^visor\.check\./, '');

  // --- Tool calls ---
  const toolName = attrs['tool.name'] || attrs['visor.tool.name'];
  if (toolName) {
    const toolInput = extractToolInput(String(toolName), attrs);
    const toolResultLen = attrs['tool.result.length'] || attrs['tool.result.count'];
    const tn = String(toolName);
    // Detect "no results" for search tools: probe header is ~350-450 chars,
    // so result.length < 500 for search means no actual matches
    const isSearchTool = tn === 'search' || tn === 'searchCode' || tn === 'search_code';
    const numLen = toolResultLen ? Number(toolResultLen) : -1;
    const noResults = isSearchTool && numLen >= 0 && numLen < 500;
    const resultSize = noResults
      ? ' → no results'
      : toolResultLen
        ? ` → ${formatSize(numLen)}`
        : '';
    const successMark = attrs['tool.success'] === false ? ' ✗' : '';
    lines.push(`${pad}- ${tn}(${toolInput})${resultSize}${successMark}`);
    return;
  }

  // --- Search delegate ---
  if (name === 'search.delegate') {
    const query = attrs['search.query'] || '';
    lines.push(`${pad}search.delegate("${truncate(String(query), 80)}") — ${duration}:`);
    for (const child of node.children) {
      renderYamlNode(
        child,
        indent + 1,
        lines,
        dedup,
        fallbackIntent,
        fullOutput,
        maxLen,
        node.span
      );
    }
    return;
  }

  // --- AI request ---
  if (name === 'ai.request') {
    const model = attrs['ai.model'] || attrs['gen_ai.request.model'] || '?';
    const tokensIn = attrs['ai.input_length'] || attrs['gen_ai.usage.input_tokens'] || '';
    const tokensOut = attrs['gen_ai.usage.output_tokens'] || '';
    const tokenParts: string[] = [];
    if (tokensIn) tokenParts.push(`${tokensIn} in`);
    if (tokensOut) tokenParts.push(`${tokensOut} out`);
    const tokenStr = tokenParts.length > 0 ? ` — ${tokenParts.join(', ')}` : '';

    const hasChildren = node.children.length > 0;
    lines.push(`${pad}ai: ${model} — ${duration}${tokenStr}${hasChildren ? ':' : ''}`);

    // Intent
    const aiInput = String(attrs['ai.input'] || '');
    let intent = extractAIIntent(aiInput, ml);
    if (!intent && parentSpan) {
      const promptPreview = String(
        parentSpan.attributes['visor.provider.request.prompt.preview'] || ''
      );
      if (promptPreview) intent = extractAIIntent(promptPreview, ml);
      if (!intent) {
        const inputOutputs = String(parentSpan.attributes['visor.check.input.outputs'] || '');
        if (inputOutputs) {
          try {
            const o = JSON.parse(inputOutputs);
            const t = o['route-intent']?.topic;
            if (t) intent = truncate(String(t), ml);
          } catch {}
        }
      }
    }
    if (!intent && fallbackIntent && parentSpan?.name !== 'search.delegate') {
      intent = fallbackIntent;
    }
    if (intent) {
      const intentRef = dedupeOrRegister(dedup, 'intents', intent, displayName);
      if (intentRef) {
        lines.push(`${pad}  intent: = ${intentRef}`);
      } else {
        lines.push(`${pad}  intent: ${intent}`);
      }
    }

    // Children (tool calls etc.)
    for (const child of node.children) {
      renderYamlNode(
        child,
        indent + 1,
        lines,
        dedup,
        fallbackIntent,
        fullOutput,
        maxLen,
        node.span
      );
    }

    // Output from parent check span (AI provider stores output on the check span, not ai.request)
    if (parentSpan) {
      const checkOutput = String(parentSpan.attributes['visor.check.output'] || '');
      if (checkOutput) {
        renderYamlOutput(
          checkOutput,
          `${pad}  `,
          'output',
          displayName,
          dedup,
          lines,
          fullOutput,
          ml
        );
      }
    }
    return;
  }

  // --- visor.run ---
  if (name === 'visor.run') {
    const source = attrs['visor.run.source'] || '';
    const visorVersion = attrs['visor.version'] || '';
    const probeVersion = attrs['probe.version'] || '';
    const slackUser = attrs['slack.user_id'] || '';
    lines.push(`${pad}visor.run:`);
    lines.push(`${pad}  trace_id: ${node.span.traceId}`);
    if (visorVersion) lines.push(`${pad}  visor: ${visorVersion}`);
    if (probeVersion) lines.push(`${pad}  probe: ${probeVersion}`);
    if (source) lines.push(`${pad}  source: ${source}`);
    if (slackUser) lines.push(`${pad}  slack_user: ${slackUser}`);
    lines.push(`${pad}  duration: ${duration}`);
    for (const child of node.children) {
      renderYamlNode(
        child,
        indent + 1,
        lines,
        dedup,
        fallbackIntent,
        fullOutput,
        maxLen,
        node.span
      );
    }
    return;
  }

  // --- Visor check ---
  const checkId = attrs['visor.check.id'];
  const checkType = attrs['visor.check.type'];
  if (checkId || name.startsWith('visor.check.')) {
    const cleanName = String(checkId || name).replace(/^visor\.check\./, '');
    const errMark = node.span.status === 'error' ? ' ✗' : '';
    lines.push(`${pad}${cleanName}:${errMark}`);
    if (checkType) lines.push(`${pad}  type: ${checkType}`);
    lines.push(`${pad}  duration: ${duration}`);

    // Input — show the actual question/topic first, then dependency outputs
    const inputContext = String(attrs['visor.check.input.context'] || '');
    const inputOutputs = String(attrs['visor.check.input.outputs'] || '');
    const question = extractQuestionFromContext(inputContext, inputOutputs);
    if (question || (inputOutputs && inputOutputs !== '{}')) {
      renderYamlInput(inputOutputs, `${pad}  `, lines, fullOutput, ml, question);
    }

    // Children
    for (const child of node.children) {
      renderYamlNode(
        child,
        indent + 1,
        lines,
        dedup,
        fallbackIntent,
        fullOutput,
        maxLen,
        node.span
      );
    }

    // Output (after children)
    // Skip if check has a direct AI child — it already rendered this check's output
    const hasDirectAiChild = node.children.some(c => c.span.name === 'ai.request');
    if (!hasDirectAiChild) {
      const output = String(attrs['visor.check.output'] || '');
      if (output) {
        renderYamlOutput(output, `${pad}  `, 'output', cleanName, dedup, lines, fullOutput, ml);
      }
    }
    return;
  }

  // --- Generic span ---
  const errMark = node.span.status === 'error' ? ' ✗' : '';
  const hasChildren = node.children.length > 0;
  lines.push(`${pad}${name} — ${duration}${errMark}${hasChildren ? ':' : ''}`);
  for (const child of node.children) {
    renderYamlNode(child, indent + 1, lines, dedup, fallbackIntent, fullOutput, maxLen, node.span);
  }
}

/**
 * Render a JSON output as YAML key-value pairs under a given prefix.
 * Handles deduplication — if the output was already shown, prints "output: = <name>".
 */
function renderYamlOutput(
  rawOutput: string,
  pad: string,
  label: string,
  spanName: string,
  dedup: DeduplicationContext,
  lines: string[],
  fullOutput?: boolean,
  maxLen?: number
): void {
  const ml = maxLen ?? 120;

  // Try to parse as JSON for structured display
  let obj: any;
  try {
    obj = JSON.parse(rawOutput);
  } catch {
    // Truncated JSON — use tolerant parser to extract what we can
    obj = parseTruncatedJson(rawOutput);
  }
  if (obj === null || obj === undefined || typeof obj !== 'object') return;

  // Unwrap single-key wrapper objects: {answer: {text: "..."}} → {text: "..."}
  // and {text: "..."} → render text inline
  if (typeof obj === 'object' && !Array.isArray(obj)) {
    const keys = Object.keys(obj);
    if (keys.length === 1 && typeof obj[keys[0]] === 'object' && obj[keys[0]] !== null) {
      obj = obj[keys[0]]; // unwrap {answer: {...}} → {...}
    }
    // If single text key, render inline
    const objKeys = Object.keys(obj);
    if (objKeys.length === 1 && objKeys[0] === 'text' && typeof obj.text === 'string') {
      const text = obj.text.replace(/\*\*/g, '').replace(/`/g, '').trim();
      const flat = text.replace(/\n/g, ' ');
      const preview2 = fullOutput ? flat : truncate(flat, ml);
      const ref2 = dedupeOrRegister(dedup, 'outputs', truncate(flat, 100), spanName);
      if (ref2) {
        lines.push(`${pad}${label}: = ${ref2}`);
      } else {
        lines.push(`${pad}${label}: ${preview2}`);
      }
      return;
    }
  }

  // Get a dedup key from the formatted preview
  const preview = formatJsonPreview(obj, 200);
  if (!preview) return;
  const ref = dedupeOrRegister(dedup, 'outputs', preview, spanName);
  if (ref) {
    lines.push(`${pad}${label}: = ${ref}`);
    return;
  }

  // Render as YAML structure
  renderYamlValue(obj, pad, label, lines, fullOutput, ml);
}

/**
 * Render a JSON value as YAML structure.
 */
function renderYamlValue(
  val: any,
  pad: string,
  key: string,
  lines: string[],
  fullOutput?: boolean,
  maxLen?: number,
  depth?: number
): void {
  const ml = maxLen ?? 120;
  const d = depth ?? 0;

  if (val === null || val === undefined) return;

  if (typeof val === 'boolean' || typeof val === 'number') {
    lines.push(`${pad}${key}: ${val}`);
    return;
  }

  if (typeof val === 'string') {
    // Skip stringified JSON
    if (val.startsWith('{') || val.startsWith('[')) return;
    const clean = val.replace(/\*\*/g, '').replace(/`/g, '').trim();
    if (fullOutput && clean.length > 100 && clean.includes('\n')) {
      // Multiline YAML
      lines.push(`${pad}${key}: |`);
      for (const line of clean.split('\n').slice(0, fullOutput ? 500 : 5)) {
        lines.push(`${pad}  ${line}`);
      }
    } else {
      const flat = clean.replace(/\n/g, ' ');
      const truncVal = fullOutput ? flat : truncate(flat, ml);
      lines.push(`${pad}${key}: ${truncVal}`);
    }
    return;
  }

  if (Array.isArray(val)) {
    if (val.length === 0) {
      lines.push(`${pad}${key}: []`);
      return;
    }
    // Short string arrays: render inline like [a, b, c]
    if (val.every((v: any) => typeof v === 'string') && val.join(', ').length < ml) {
      lines.push(`${pad}${key}: [${val.join(', ')}]`);
      return;
    }
    // Limit array depth
    const maxItems = fullOutput ? 20 : 3;
    lines.push(`${pad}${key}:`);
    for (let i = 0; i < Math.min(val.length, maxItems); i++) {
      const item = val[i];
      if (typeof item === 'object' && item !== null) {
        const entries = Object.entries(item).filter(([k]) => k !== 'raw' && k !== 'tags');
        if (entries.length > 0) {
          // Put first key on same line as dash
          const [firstKey, firstVal] = entries[0];
          if (firstVal === null || firstVal === undefined || typeof firstVal !== 'object') {
            const sv =
              typeof firstVal === 'string'
                ? fullOutput
                  ? firstVal.split('\n')[0]
                  : truncate(firstVal.split('\n')[0], ml)
                : String(firstVal ?? '');
            lines.push(`${pad}  - ${firstKey}: ${sv}`);
          } else {
            // Complex first value — render key on dash line, value below
            lines.push(`${pad}  - ${firstKey}:`);
            for (const [ck, cv] of Object.entries(firstVal)) {
              if (ck === 'raw' || ck === 'skills' || ck === 'tags') continue;
              renderYamlValue(cv, `${pad}      `, ck, lines, fullOutput, ml, d + 2);
            }
          }
          for (let j = 1; j < entries.length; j++) {
            const [k, v] = entries[j];
            renderYamlValue(v, `${pad}    `, k, lines, fullOutput, ml, d + 1);
          }
        }
      } else {
        lines.push(`${pad}  - ${truncate(String(item), ml)}`);
      }
    }
    if (val.length > maxItems) {
      lines.push(`${pad}  # ... ${val.length - maxItems} more`);
    }
    return;
  }

  if (typeof val === 'object') {
    // Limit nesting depth
    if (d > 3) {
      const keys = Object.keys(val);
      lines.push(`${pad}${key}: {${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', ...' : ''}}`);
      return;
    }
    lines.push(`${pad}${key}:`);
    for (const [k, v] of Object.entries(val)) {
      if (k === 'raw' || k === 'tags') continue;
      renderYamlValue(v, `${pad}  `, k, lines, fullOutput, ml, d + 1);
    }
  }
}

/**
 * Extract the actual user question/topic from the check's input context.
 * The context contains the full execution context including outputs from
 * dependency checks. We look for the route-intent topic, args.topic, or
 * other indicators of the user's question.
 */
function extractQuestionFromContext(
  contextStr: string,
  inputOutputsStr: string
): string | undefined {
  if (!contextStr) return undefined;

  try {
    const ctx = JSON.parse(contextStr);

    // 1. Check outputs.route-intent.topic (most common)
    const outputs = ctx.outputs || {};
    const routeIntent = outputs['route-intent'];
    if (routeIntent) {
      const topic = routeIntent.topic || routeIntent.intent || routeIntent.question;
      if (topic && typeof topic === 'string') return topic;
      // route-intent might be a string itself
      if (typeof routeIntent === 'string') return routeIntent;
    }

    // 2. Check args.topic or args.question
    const args = ctx.args || {};
    if (args.topic && typeof args.topic === 'string') return args.topic;
    if (args.question && typeof args.question === 'string') return args.question;
    if (args.intent && typeof args.intent === 'string') return args.intent;

    // 3. Check any output with a topic field not already in inputOutputs
    for (const key of Object.keys(outputs)) {
      const val = outputs[key];
      if (typeof val === 'object' && val !== null) {
        if (val.topic && typeof val.topic === 'string') {
          // Skip if this output is already shown in inputOutputs
          try {
            const depOutputs = JSON.parse(inputOutputsStr);
            if (depOutputs[key]) continue;
          } catch {}
          return val.topic;
        }
      }
    }
  } catch {
    // Truncated JSON — try regex extraction
    const topicMatch = contextStr.match(/"topic"\s*:\s*"([^"]+)"/);
    if (topicMatch) return topicMatch[1];
  }

  return undefined;
}

/**
 * Render input dependencies as YAML.
 */
function renderYamlInput(
  inputOutputsStr: string,
  pad: string,
  lines: string[],
  fullOutput?: boolean,
  maxLen?: number,
  question?: string
): void {
  const ml = maxLen ?? 120;

  // Show the question/topic prominently first
  if (question) {
    lines.push(`${pad}input: ${truncate(question, fullOutput ? 100000 : ml)}`);
  }

  try {
    const inputs = JSON.parse(inputOutputsStr);
    if (typeof inputs !== 'object' || inputs === null) return;
    const keys = Object.keys(inputs);
    if (keys.length === 0) return;

    if (!question) lines.push(`${pad}input:`);
    for (const key of keys) {
      const val = inputs[key];
      if (typeof val === 'object' && val !== null) {
        renderYamlValue(val, `${pad}  `, key, lines, fullOutput, ml, 0);
      } else {
        lines.push(`${pad}  ${key}: ${truncate(String(val), ml)}`);
      }
    }
  } catch {
    // Can't parse — skip
  }
}

// ---------------------------------------------------------------------------
// ASCII tree renderer (kept for backward compat / tests)
// ---------------------------------------------------------------------------

function renderNode(
  node: SpanTree,
  prefix: string,
  isLast: boolean,
  depth: number,
  maxDepth: number,
  lines: string[],
  parentSpan?: NormalizedSpan,
  fallbackIntent?: string,
  fullOutput?: boolean,
  dedup?: DeduplicationContext
): void {
  if (depth > maxDepth) return;

  const hasChildren = node.children.length > 0;
  const connector = depth === 0 ? '' : isLast ? '└── ' : '├── ';
  const { line: formatted, output: deferredOutput } = formatSpanLine(
    node.span,
    parentSpan,
    fallbackIntent,
    fullOutput,
    dedup,
    hasChildren
  );

  // Skip if formatSpanLine returns empty (filtered)
  if (formatted) {
    lines.push(`${prefix}${connector}${formatted}`);
  }

  const childPrefix = depth === 0 ? '' : formatted ? prefix + (isLast ? '    ' : '│   ') : prefix; // no indent increase if this node was skipped

  for (let i = 0; i < node.children.length; i++) {
    const isChildLast = i === node.children.length - 1 && !deferredOutput;
    renderNode(
      node.children[i],
      childPrefix,
      isChildLast,
      depth + (formatted ? 1 : 0),
      maxDepth,
      lines,
      node.span,
      fallbackIntent,
      fullOutput,
      dedup
    );
  }

  // Show deferred output at the bottom, after all children
  if (deferredOutput) {
    lines.push(`${childPrefix}└─→ ${deferredOutput}`);
  }
}

interface FormatResult {
  line: string;
  /** Output to show after children (deferred to bottom) */
  output?: string;
}

function formatSpanLine(
  span: NormalizedSpan,
  parentSpan?: NormalizedSpan,
  fallbackIntent?: string,
  fullOutput?: boolean,
  dedup?: DeduplicationContext,
  hasChildren?: boolean
): FormatResult {
  const duration = formatDurationMs(span.durationMs);
  const attrs = span.attributes;
  const name = span.name;
  const previewLimit = fullOutput ? 10000 : 120;

  // Helper: get a display name for this span (used in dedup references)
  const displayName = String(attrs['visor.check.id'] || name).replace(/^visor\.check\./, '');

  // Helper: deduplicate an output string — returns the display string (without → prefix)
  const dedupeOutputStr = (rawOutput: string, label: string): string => {
    if (!rawOutput) return '';
    if (!dedup) return rawOutput;
    const ref = dedupeOrRegister(dedup, 'outputs', rawOutput, label);
    if (ref) return `(= ${ref})`;
    return rawOutput;
  };

  // Helper: deduplicate an intent string — returns the display string
  const dedupeIntentStr = (rawIntent: string, label: string): string => {
    if (!rawIntent || !dedup) return rawIntent ? ` 💬 ${rawIntent}` : '';
    const ref = dedupeOrRegister(dedup, 'intents', rawIntent, label);
    if (ref) return ` 💬 (= ${ref})`;
    return ` 💬 ${rawIntent}`;
  };

  // Helper: format output as inline or deferred depending on whether node has children
  const makeResult = (line: string, outputPreview: string): FormatResult => {
    if (!outputPreview) return { line };
    if (hasChildren) {
      // Defer output to bottom — show after children
      return { line, output: outputPreview };
    }
    // Inline for leaf nodes
    return { line: `${line} → ${outputPreview}` };
  };

  // --- Tool calls: extract real inputs ---
  const toolName = attrs['tool.name'] || attrs['visor.tool.name'];
  if (toolName) {
    const toolInput = extractToolInput(String(toolName), attrs);
    const toolResultLen = attrs['tool.result.length'] || attrs['tool.result.count'];
    const toolSuccess = attrs['tool.success'];
    const tn = String(toolName);
    const isSearchTool = tn === 'search' || tn === 'searchCode' || tn === 'search_code';
    const numLen = toolResultLen ? Number(toolResultLen) : -1;
    const noResults = isSearchTool && numLen >= 0 && numLen < 500;
    const resultSize = noResults ? 'no results' : toolResultLen ? formatSize(numLen) : '';
    const durStr =
      Number(attrs['tool.duration_ms']) > 0
        ? ` (${formatDurationMs(Number(attrs['tool.duration_ms']))})`
        : '';

    // Bash: show exit code / signal instead of generic success mark
    let successMark = toolSuccess === false ? ' ✗' : '';
    if (tn === 'bash') {
      const toolResult = String(attrs['tool.result'] || '');
      const exitMatch = toolResult.match(/Exit Code: (\S+)/);
      const sigMatch = toolResult.match(/Signal: (\S+)/);
      if (sigMatch && sigMatch[1] !== 'null') {
        successMark = ` [${sigMatch[1]}]`;
      } else if (exitMatch && exitMatch[1] !== '0' && exitMatch[1] !== 'null') {
        successMark = ` [exit ${exitMatch[1]}]`;
      }
    }

    return {
      line: `${toolName}(${toolInput})${durStr}${resultSize ? ` → ${resultSize}` : ''}${successMark}`,
    };
  }

  // --- Search delegate: show the search query ---
  if (name === 'search.delegate') {
    const query = attrs['search.query'] || '';
    return { line: `search.delegate(${truncate(String(query), 80)}) (${duration})` };
  }

  // --- AI request: show model + input summary ---
  if (name === 'ai.request') {
    const model = attrs['ai.model'] || attrs['gen_ai.request.model'] || '?';
    const tokensIn = attrs['ai.input_length'] || attrs['gen_ai.usage.input_tokens'] || '';
    const tokensOut = attrs['gen_ai.usage.output_tokens'] || '';
    const tokenParts: string[] = [];
    if (tokensIn) tokenParts.push(`${tokensIn} in`);
    if (tokensOut) tokenParts.push(`${tokensOut} out`);
    const tokenStr = tokenParts.length > 0 ? ` [${tokenParts.join(', ')}]` : '';

    // Extract a short intent/question from ai.input — inline on same line
    const aiInput = String(attrs['ai.input'] || '');
    let intent = extractAIIntent(aiInput, previewLimit);

    // Fallback: if ai.input was truncated, try parent check's attributes
    if (!intent && parentSpan) {
      // Try prompt preview first
      const promptPreview = String(
        parentSpan.attributes['visor.provider.request.prompt.preview'] || ''
      );
      if (promptPreview) {
        intent = extractAIIntent(promptPreview, previewLimit);
      }
      // Try extracting topic from parent check's input context (route-intent output)
      if (!intent) {
        const inputOutputs = String(parentSpan.attributes['visor.check.input.outputs'] || '');
        if (inputOutputs) {
          try {
            const outputs = JSON.parse(inputOutputs);
            const topic = outputs['route-intent']?.topic;
            if (topic) intent = truncate(String(topic), 150);
          } catch {}
        }
      }
    }
    // Global fallback: use the route-intent topic — but only for top-level AI,
    // not for sub-delegates whose intent is the search.delegate query
    if (!intent && fallbackIntent && parentSpan?.name !== 'search.delegate') {
      intent = fallbackIntent;
    }
    const intentStr = intent ? dedupeIntentStr(intent, displayName) : '';

    // Get output preview from parent check's output
    let outputPreview = '';
    if (parentSpan) {
      const checkOutput = String(parentSpan.attributes['visor.check.output'] || '');
      if (checkOutput) {
        const preview = extractOutputPreview(checkOutput, previewLimit);
        if (preview) outputPreview = dedupeOutputStr(preview, displayName);
      }
    }

    const mainLine = `ai ${model} (${duration})${tokenStr}${intentStr}`;
    return makeResult(mainLine, outputPreview);
  }

  // --- Visor check: clean name, show type, show input/output preview ---
  const checkId = attrs['visor.check.id'];
  const checkType = attrs['visor.check.type'];
  if (checkId || name.startsWith('visor.check.')) {
    const cleanName = String(checkId || name).replace(/^visor\.check\./, '');
    const typeStr = checkType ? ` [${checkType}]` : '';

    // Show input dependencies
    const inputOutputs = String(attrs['visor.check.input.outputs'] || '');
    let inputStr = '';
    if (inputOutputs && inputOutputs !== '{}') {
      inputStr = ' ' + formatInputPreview(inputOutputs, previewLimit);
    }

    // Get output preview for checks that produce meaningful output
    const output = String(attrs['visor.check.output'] || '');
    let outputPreview = '';
    if (output) {
      const preview = extractOutputPreview(output, previewLimit);
      if (preview) outputPreview = dedupeOutputStr(preview, cleanName);
    }

    const mainLine = `${cleanName}${typeStr} (${duration})${inputStr}`;
    return makeResult(mainLine, outputPreview);
  }

  // --- visor.run: show source info ---
  if (name === 'visor.run') {
    const source = attrs['visor.run.source'] || '';
    const sourceStr = source ? ` (${source})` : '';
    return { line: `visor.run${sourceStr} (${duration})` };
  }

  // --- Negotiated timeout observer: show decision details ---
  if (
    name === 'probe.event.negotiated_timeout.observer' ||
    name === 'negotiated_timeout.observer'
  ) {
    // Decision data lives in span events emitted by Probe inside the observer span.
    // Look through span.events for observer_extended, observer_declined, observer_exhausted.
    let detail = '';

    // First try span attributes (future Probe versions may set these directly)
    const attrDecision = attrs['observer.decision'] || attrs['decision_reason'];
    if (attrDecision) {
      const reason = attrs['observer.reason'] || attrs['decision_reason'] || '';
      if (String(attrDecision) === 'extended' || attrs['granted_ms']) {
        const grantedMin =
          attrs['observer.granted_min'] ||
          attrs['granted_min'] ||
          (attrs['granted_ms'] ? Math.round(Number(attrs['granted_ms']) / 60000) : '?');
        detail = `extended +${grantedMin}min`;
        if (reason) detail += ` (${truncate(String(reason), 60)})`;
        const used = attrs['observer.extensions_used'] || attrs['extensions_used'];
        const max = attrs['observer.max_requests'] || attrs['max_requests'];
        if (used) detail += ` [${used}/${max || '?'} used]`;
      } else if (String(attrDecision) === 'exhausted') {
        detail = 'budget exhausted';
      } else {
        detail = `declined`;
        if (reason) detail += `: ${truncate(String(reason), 60)}`;
      }
    }

    // Then try span events (current Probe versions emit these)
    if (!detail && span.events.length > 0) {
      for (const evt of span.events) {
        const evtName = evt.name || '';
        const ea = evt.attributes;
        if (evtName.includes('observer_extended')) {
          const grantedMin =
            ea['granted_min'] ||
            (ea['granted_ms'] ? Math.round(Number(ea['granted_ms']) / 60000) : '?');
          detail = `extended +${grantedMin}min`;
          if (ea['decision_reason']) detail += ` (${truncate(String(ea['decision_reason']), 60)})`;
          if (ea['extensions_used'])
            detail += ` [${ea['extensions_used']}/${ea['max_requests'] || '?'} used]`;
          break;
        }
        if (evtName.includes('observer_declined')) {
          detail = 'declined';
          if (ea['decision_reason']) detail += `: ${truncate(String(ea['decision_reason']), 60)}`;
          break;
        }
        if (evtName.includes('observer_exhausted')) {
          const used = ea['extensions_used'] || '?';
          const max = ea['max_requests'] || '?';
          detail = `budget exhausted [${used}/${max} extensions]`;
          break;
        }
        if (evtName.includes('observer_invoked') && !detail) {
          // Show invocation context as fallback if no decision event follows
          const elapsed = ea['elapsed_min'] || '?';
          const tools = ea['active_tools_count'] || 0;
          detail = `${elapsed}min elapsed, ${tools} active tools`;
          // Don't break — keep looking for a decision event
        }
      }
    }

    // Final fallback: span attributes for elapsed/active tools
    if (!detail) {
      const elapsed = attrs['elapsed_min'];
      const activeTools = attrs['active_tools_count'] || attrs['active_tools'];
      if (elapsed) detail += `${elapsed}min elapsed`;
      if (activeTools)
        detail += detail ? `, ${activeTools} active tools` : `${activeTools} active tools`;
    }

    const label = detail ? `timeout.observer: ${detail}` : 'timeout.observer';
    return { line: `${label} (${duration})` };
  }

  // --- Negotiated timeout sub-events (promoted to individual spans) ---
  if (name.includes('negotiated_timeout.observer_')) {
    const suffix = name.replace(/.*negotiated_timeout\.observer_/, '');
    const reason = attrs['decision_reason'] || '';
    if (suffix === 'extended') {
      const grantedMin =
        attrs['granted_min'] ||
        (attrs['granted_ms'] ? Math.round(Number(attrs['granted_ms']) / 60000) : '?');
      const used = attrs['extensions_used'] || '?';
      const max = attrs['max_requests'] || '?';
      const reasonStr = reason ? ` (${truncate(String(reason), 60)})` : '';
      return { line: `timeout.extended: +${grantedMin}min${reasonStr} [${used}/${max} used]` };
    }
    if (suffix === 'declined') {
      const reasonStr = reason ? `: ${truncate(String(reason), 60)}` : '';
      return { line: `timeout.declined${reasonStr}` };
    }
    if (suffix === 'exhausted') {
      const used = attrs['extensions_used'] || '?';
      const max = attrs['max_requests'] || '?';
      return { line: `timeout.exhausted [${used}/${max} extensions, budget depleted]` };
    }
    // observer_invoked, observer_response — less important, show compact
    if (suffix === 'invoked') {
      const elapsed = attrs['elapsed_min'] || '?';
      const tools = attrs['active_tools_count'] || 0;
      return { line: `timeout.observer invoked (${elapsed}min elapsed, ${tools} active tools)` };
    }
    return { line: `timeout.${suffix} (${duration})` };
  }

  // --- Negotiated timeout abort summary: show that final response was generated under timeout ---
  if (name.includes('negotiated_timeout.abort_summary')) {
    const summaryLen = attrs['summary_length'] || attrs['summary.length'];
    const lenStr = summaryLen ? ` → ${formatSize(Number(summaryLen))}` : '';
    return { line: `timeout.abort_summary (${duration})${lenStr}` };
  }

  // --- Graceful stop events ---
  if (name.includes('graceful_stop.initiated') || name.includes('graceful_stop.invoked')) {
    const reason = attrs['graceful_stop.reason'] || attrs['reason'] || '';
    const reasonStr = reason ? `: ${truncate(String(reason), 80)}` : '';
    return { line: `graceful_stop${reasonStr} (${duration})` };
  }

  // --- Generic span ---
  return { line: `${name} (${duration})${span.status === 'error' ? ' ✗' : ''}` };
}

/**
 * Extract a meaningful input description for a tool call.
 * Parse a workspace path like /tmp/visor-workspaces/<session>/<repo>/path/to/file
 * into { repo, filePath } components.
 */
function parseWorkspacePath(fullPath: string): { repo: string; filePath?: string } | null {
  // Match /tmp/visor-workspaces/<session-id>/<repo>/...
  const wsMatch = fullPath.match(/\/visor-workspaces\/[^/]+\/([^/]+)(?:\/(.+))?/);
  if (wsMatch) {
    return { repo: wsMatch[1], filePath: wsMatch[2] };
  }
  // Match .visor/worktrees/worktrees/<worktree-id>/<path>
  const wtMatch = fullPath.match(/\.visor\/worktrees\/worktrees\/[^/]+\/(.+)/);
  if (wtMatch) {
    const segs = wtMatch[1].split('/');
    return { repo: segs[0], filePath: segs.length > 1 ? segs.slice(1).join('/') : undefined };
  }
  return null;
}

/**
 * Parses the Pattern/Path from tool.result for search tools,
 * and file paths for extract tools.
 */
function extractToolInput(
  toolName: string,
  attrs: Record<string, string | number | boolean>
): string {
  const result = String(attrs['tool.result'] || '');
  const explicitInput = String(attrs['tool.input'] || '');

  if (explicitInput) return truncate(explicitInput, 80);

  switch (toolName) {
    case 'search': {
      // Parse "Pattern: ..." and "Path: ..." from Probe search output
      const patMatch = result.match(/Pattern: (.+)/);
      const pathMatch = result.match(/Path: (\S+)/);
      const pattern = patMatch ? patMatch[1].trim() : '';
      const workspace = pathMatch ? parseWorkspacePath(pathMatch[1]) : null;
      const parts: string[] = [];
      if (pattern) parts.push(`"${truncate(pattern, 50)}"`);
      if (workspace?.repo) parts.push(workspace.repo);
      return parts.join(', ');
    }
    case 'extract': {
      // Parse file paths from "Files to extract:" block
      // Full path looks like: /tmp/visor-workspaces/<session>/<repo>/path/to/file (lines N-M)
      const fileMatch = result.match(/Files to extract:\n\s*(\S+)/);
      if (fileMatch) {
        const fullPath = fileMatch[1];
        const workspace = parseWorkspacePath(fullPath);
        if (workspace) {
          const parts: string[] = [];
          parts.push(workspace.filePath || workspace.repo || fullPath.split('/').pop() || '');
          if (workspace.repo) parts.push(workspace.repo);
          return parts.join(', ');
        }
        // Fallback: show last 2 segments
        const segs = fullPath.split('/');
        return segs.length > 2 ? segs.slice(-2).join('/') : segs[segs.length - 1];
      }
      return '';
    }
    case 'bash': {
      // tool.result starts with "Command: <cmd>\nWorking directory: ..."
      const cmdMatch = result.match(/^Command: (.+)/);
      if (cmdMatch) {
        let cmd = cmdMatch[1].trim();
        // Strip long pipes — show first command + pipe count
        const pipes = cmd.split(/\s*\|\s*/);
        if (pipes.length > 2) {
          cmd = `${pipes[0]} | ... (${pipes.length} stages)`;
        }
        return truncate(cmd, 80);
      }
      // Blocked commands: "Permission denied: Component "<cmd>" not allowed: ..."
      const deniedMatch = result.match(/^Permission denied: Component "([^"]+)"/);
      if (deniedMatch) {
        return truncate(deniedMatch[1], 60) + ' [denied]';
      }
      return '';
    }
    case 'listFiles': {
      const pathMatch = result.match(/^(\S+):/);
      if (pathMatch) {
        const parts = pathMatch[1].split('/');
        return parts[parts.length - 1] || '';
      }
      return '';
    }
    default:
      return truncate(explicitInput, 60);
  }
}

/**
 * Extract a short intent/question from an AI prompt.
 * Looks for ## Current Request, <question>, or the user message.
 */
function extractAIIntent(input: string, maxLen: number = 150): string {
  if (!input || input.length < 20) return '';

  // Try <question>...</question>
  const qMatch = input.match(/<question>([\s\S]*?)<\/question>/);
  if (qMatch) return truncate(qMatch[1].trim(), maxLen);

  // Try "## Current Request" section
  const crMatch = input.match(/## Current Request\s*\n(?:User: )?(.+)/);
  if (crMatch) return truncate(crMatch[1].trim(), maxLen);

  // Try "User:" pattern
  const userMatch = input.match(/(?:^|\n)User: (.+)/);
  if (userMatch) return truncate(userMatch[1].trim(), maxLen);

  // Try "Primary message" pattern
  const pmMatch = input.match(/Primary message[^:]*:\s*\n(.+)/);
  if (pmMatch) return truncate(pmMatch[1].trim(), maxLen);

  return '';
}

/**
 * Format a JSON output as a compact structural preview.
 * Shows key names + brief values, preserving the JSON nature of the data.
 */
function formatJsonPreview(obj: any, maxLen: number): string {
  if (obj === null || obj === undefined) return '';
  if (typeof obj !== 'object') return truncate(String(obj), maxLen);

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    // Show array length + first item preview
    const first =
      typeof obj[0] === 'object' && obj[0] !== null
        ? obj[0].project_id || obj[0].id || obj[0].name || Object.keys(obj[0])[0] || '...'
        : String(obj[0]);
    return `[${obj.length}] ${truncate(String(first), 30)}${obj.length > 1 ? ', ...' : ''}`;
  }

  // Object — show key:value pairs compactly
  const parts: string[] = [];
  let len = 2; // for { }
  for (const [key, val] of Object.entries(obj)) {
    // Skip internal/verbose keys
    if (key === 'raw' || key === 'skills' || key === 'tags') continue;
    let valStr: string;
    if (val === null || val === undefined) continue;
    if (typeof val === 'boolean') valStr = String(val);
    else if (typeof val === 'number') valStr = String(val);
    else if (typeof val === 'string') {
      // Skip text fields that are stringified JSON (duplicate data)
      if (val.startsWith('{') || val.startsWith('[')) continue;
      // Clean markdown from text values
      const clean = val
        .replace(/\*\*/g, '')
        .replace(/^#+\s*/gm, '')
        .replace(/`/g, '')
        .trim();
      valStr = `"${truncate(clean.split('\n')[0], Math.min(80, maxLen / 3))}"`;
    } else if (Array.isArray(val)) valStr = `[${val.length}]`;
    else if (typeof val === 'object') valStr = `{${Object.keys(val).length} keys}`;
    else valStr = '...';

    const part = `${key}: ${valStr}`;
    if (len + part.length + 2 > maxLen) {
      parts.push('...');
      break;
    }
    parts.push(part);
    len += part.length + 2;
  }

  return `{${parts.join(', ')}}`;
}

/**
 * Extract a short preview from a check's output JSON.
 * Shows structural JSON preview preserving the data format.
 */
function extractOutputPreview(output: string, maxLen: number = 120): string {
  try {
    const obj = JSON.parse(output);
    return formatJsonPreview(obj, maxLen);
  } catch {
    // JSON truncated by telemetry — extract top-level keys with regex
    return extractTruncatedJsonPreview(output, maxLen);
  }
}

/**
 * Extract a structured preview from truncated JSON (telemetry cuts at ~2048 chars).
 * Extracts top-level key:value pairs using regex.
 */
/**
 * Tolerant JSON parser that extracts as much structure as possible from
 * truncated JSON (e.g., OTEL attribute values cut off at ~2048 chars).
 * Returns a partial JS object/array/string — whatever was parseable.
 */
function parseTruncatedJson(input: string): any {
  let pos = 0;
  const len = input.length;

  function skipWhitespace(): void {
    while (pos < len && ' \t\n\r'.includes(input[pos])) pos++;
  }

  function parseString(): string {
    if (input[pos] !== '"') return '';
    pos++; // skip opening quote
    let result = '';
    while (pos < len) {
      const ch = input[pos];
      if (ch === '\\' && pos + 1 < len) {
        const next = input[pos + 1];
        if (next === 'n') {
          result += '\n';
          pos += 2;
          continue;
        }
        if (next === 't') {
          result += '\t';
          pos += 2;
          continue;
        }
        if (next === '"') {
          result += '"';
          pos += 2;
          continue;
        }
        if (next === '\\') {
          result += '\\';
          pos += 2;
          continue;
        }
        result += next;
        pos += 2;
        continue;
      }
      if (ch === '"') {
        pos++;
        return result;
      }
      result += ch;
      pos++;
    }
    // Truncated — no closing quote
    return result;
  }

  function parseNumber(): number {
    const start = pos;
    if (input[pos] === '-') pos++;
    while (pos < len && input[pos] >= '0' && input[pos] <= '9') pos++;
    if (pos < len && input[pos] === '.') {
      pos++;
      while (pos < len && input[pos] >= '0' && input[pos] <= '9') pos++;
    }
    return Number(input.slice(start, pos));
  }

  function parseValue(): any {
    skipWhitespace();
    if (pos >= len) return undefined;
    const ch = input[pos];
    if (ch === '"') return parseString();
    if (ch === '{') return parseObject();
    if (ch === '[') return parseArray();
    if (ch === 't' && input.slice(pos, pos + 4) === 'true') {
      pos += 4;
      return true;
    }
    if (ch === 'f' && input.slice(pos, pos + 5) === 'false') {
      pos += 5;
      return false;
    }
    if (ch === 'n' && input.slice(pos, pos + 4) === 'null') {
      pos += 4;
      return null;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) return parseNumber();
    return undefined; // truncated
  }

  function parseObject(): Record<string, any> {
    const obj: Record<string, any> = {};
    pos++; // skip {
    skipWhitespace();
    while (pos < len && input[pos] !== '}') {
      skipWhitespace();
      if (pos >= len || input[pos] !== '"') break; // truncated
      const key = parseString();
      skipWhitespace();
      if (pos >= len || input[pos] !== ':') {
        obj[key] = undefined;
        break;
      }
      pos++; // skip :
      const val = parseValue();
      if (val !== undefined) obj[key] = val;
      skipWhitespace();
      if (pos < len && input[pos] === ',') pos++;
    }
    if (pos < len && input[pos] === '}') pos++;
    return obj;
  }

  function parseArray(): any[] {
    const arr: any[] = [];
    pos++; // skip [
    skipWhitespace();
    while (pos < len && input[pos] !== ']') {
      const val = parseValue();
      if (val !== undefined) arr.push(val);
      else break; // truncated
      skipWhitespace();
      if (pos < len && input[pos] === ',') pos++;
      skipWhitespace();
    }
    if (pos < len && input[pos] === ']') pos++;
    return arr;
  }

  return parseValue();
}

function extractTruncatedJsonPreview(output: string, maxLen: number): string {
  if (!output.startsWith('{') && !output.startsWith('[')) return '';

  const parsed = parseTruncatedJson(output);
  if (!parsed || typeof parsed !== 'object') return '';

  return formatJsonPreview(parsed, maxLen);
}

/**
 * Format check inputs from visor.check.input.outputs into a compact summary.
 * Shows which checks provided data: ← {route-intent: {intent, topic}, build-config: {5 keys}}
 */
function formatInputPreview(inputOutputsStr: string, maxLen: number): string {
  if (!inputOutputsStr) return '';
  try {
    const inputs = JSON.parse(inputOutputsStr);
    if (typeof inputs !== 'object' || inputs === null) return '';
    const keys = Object.keys(inputs);
    if (keys.length === 0) return '';

    const parts: string[] = [];
    let len = 2;
    for (const key of keys) {
      const val = inputs[key];
      let valStr: string;
      if (typeof val === 'object' && val !== null) {
        const vkeys = Object.keys(val);
        if (vkeys.length <= 3) {
          valStr = `{${vkeys.join(', ')}}`;
        } else {
          valStr = `{${vkeys.slice(0, 2).join(', ')}, ...${vkeys.length} keys}`;
        }
      } else {
        valStr = truncate(String(val), 30);
      }
      const part = `${key}: ${valStr}`;
      if (len + part.length + 2 > maxLen) {
        parts.push('...');
        break;
      }
      parts.push(part);
      len += part.length + 2;
    }
    return `← {${parts.join(', ')}}`;
  } catch {
    return '';
  }
}

/**
 * Extract the route-intent topic from the span list.
 * Looks for the route-intent check output or classify check output.
 */
function extractRouteIntentTopic(spans: NormalizedSpan[]): string | undefined {
  // Try route-intent check output first
  const riSpan = spans.find(s => s.attributes['visor.check.id'] === 'route-intent');
  if (riSpan) {
    const output = String(riSpan.attributes['visor.check.output'] || '');
    if (output) {
      try {
        const obj = JSON.parse(output);
        if (obj.topic) return truncate(String(obj.topic), 150);
      } catch {}
    }
  }
  // Try classify check output
  const classifySpan = spans.find(s => s.attributes['visor.check.id'] === 'classify');
  if (classifySpan) {
    const output = String(classifySpan.attributes['visor.check.output'] || '');
    if (output) {
      try {
        const obj = JSON.parse(output);
        if (obj.topic) return truncate(String(obj.topic), 150);
      } catch {}
    }
  }
  return undefined;
}

function formatSize(chars: number): string {
  if (chars < 1000) return `${chars} chars`;
  return `${(chars / 1000).toFixed(1)}k chars`;
}

function formatDurationMs(ms: number): string {
  if (ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function truncate(str: string, max: number): string {
  if (typeof str !== 'string') return '';
  if (str.length <= max) return str;
  // Show first and last portions with truncation marker in the middle
  const tail = Math.min(100, Math.floor(max / 3));
  const head = max - tail - 19; // 19 for " ...[truncated]... "
  if (head < 10) return str.slice(0, max - 3) + '...';
  return str.slice(0, head) + ' ...[truncated]... ' + str.slice(-tail);
}
