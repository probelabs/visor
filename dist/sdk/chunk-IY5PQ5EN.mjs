import {
  init_logger,
  logger
} from "./chunk-6E625R3C.mjs";
import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/agent-protocol/trace-serializer.ts
import * as fs from "fs";
import * as readline from "readline";
import * as path from "path";
function resolveBackendConfig(overrides) {
  const explicit = process.env.VISOR_TRACE_BACKEND;
  return {
    type: overrides?.type || explicit || "auto",
    grafanaUrl: overrides?.grafanaUrl || process.env.GRAFANA_URL,
    grafanaDatasourceId: overrides?.grafanaDatasourceId || process.env.GRAFANA_TEMPO_DATASOURCE_ID,
    jaegerUrl: overrides?.jaegerUrl || process.env.JAEGER_URL,
    traceDir: overrides?.traceDir || process.env.VISOR_TRACE_DIR || "output/traces",
    authToken: overrides?.authToken || process.env.GRAFANA_TOKEN
  };
}
function getAutoBackendOrder() {
  const sink = (process.env.VISOR_TELEMETRY_SINK || "").trim().toLowerCase();
  const hasRemoteHints = !!process.env.GRAFANA_URL || !!process.env.JAEGER_URL || !!process.env.GRAFANA_TEMPO_DATASOURCE_ID || !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT || !!process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (sink === "file") return ["file", "grafana", "jaeger"];
  if (sink === "otlp" || hasRemoteHints) return ["grafana", "jaeger", "file"];
  return ["file", "grafana", "jaeger"];
}
function getBackendOrder(cfg) {
  if (cfg.type === "grafana") return ["grafana"];
  if (cfg.type === "jaeger") return ["jaeger"];
  if (cfg.type === "file") return ["file"];
  return getAutoBackendOrder();
}
function isTraceFilePath(ref) {
  return ref.includes("/") || ref.endsWith(".ndjson");
}
function parseOTLPResponse(data) {
  const spans = [];
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
function normalizeOTLPSpan(s) {
  const startNs = parseInt(s.startTimeUnixNano || "0", 10);
  const endNs = parseInt(s.endTimeUnixNano || "0", 10);
  const traceId = decodeOTLPId(s.traceId);
  const spanId = decodeOTLPId(s.spanId);
  const parentSpanId = s.parentSpanId ? decodeOTLPId(s.parentSpanId) : void 0;
  const attributes = {};
  for (const attr of s.attributes || []) {
    const val = attr.value;
    if (val.stringValue !== void 0) attributes[attr.key] = val.stringValue;
    else if (val.intValue !== void 0) attributes[attr.key] = parseInt(val.intValue, 10);
    else if (val.boolValue !== void 0) attributes[attr.key] = val.boolValue;
    else if (val.doubleValue !== void 0) attributes[attr.key] = val.doubleValue;
  }
  const events = [];
  for (const evt of s.events || []) {
    const evtAttrs = {};
    for (const a of evt.attributes || []) {
      const v = a.value;
      if (v.stringValue !== void 0) evtAttrs[a.key] = v.stringValue;
      else if (v.intValue !== void 0) evtAttrs[a.key] = parseInt(v.intValue, 10);
    }
    events.push({ name: evt.name, attributes: evtAttrs });
  }
  return {
    traceId,
    spanId,
    parentSpanId,
    name: s.name || "unknown",
    startTimeMs: startNs / 1e6,
    endTimeMs: endNs / 1e6,
    durationMs: (endNs - startNs) / 1e6,
    attributes,
    events,
    status: s.status?.code === 2 ? "error" : "ok"
  };
}
function normalizeJaegerSpan(s, traceId) {
  const attributes = {};
  for (const tag of s.tags || []) {
    attributes[tag.key] = tag.value;
  }
  const events = [];
  for (const log of s.logs || []) {
    const evtAttrs = {};
    for (const f of log.fields || []) evtAttrs[f.key] = f.value;
    events.push({ name: evtAttrs["event"] || "log", attributes: evtAttrs });
  }
  const startUs = s.startTime || 0;
  const durationUs = s.duration || 0;
  return {
    traceId,
    spanId: s.spanID,
    parentSpanId: s.references?.find((r) => r.refType === "CHILD_OF")?.spanID,
    name: s.operationName || "unknown",
    startTimeMs: startUs / 1e3,
    endTimeMs: (startUs + durationUs) / 1e3,
    durationMs: durationUs / 1e3,
    attributes,
    events,
    status: attributes["otel.status_code"] === "ERROR" || attributes["error"] === true ? "error" : "ok"
  };
}
function decodeOTLPId(id) {
  if (!id) return "";
  if (/^[0-9a-f]+$/i.test(id)) return id.toLowerCase();
  try {
    return Buffer.from(id, "base64").toString("hex");
  } catch {
    return id;
  }
}
function parseLocalNDJSONSpans(spans) {
  return spans.map((s) => {
    const startMs = timeValueToMs(s.startTime || [0, 0]);
    const endMs = timeValueToMs(s.endTime || s.startTime || [0, 0]);
    const events = (s.events || []).map((e) => ({
      name: e.name,
      attributes: e.attributes || {}
    }));
    return {
      traceId: s.traceId || "",
      spanId: s.spanId || "",
      parentSpanId: s.parentSpanId || void 0,
      name: s.name || "unknown",
      startTimeMs: startMs,
      endTimeMs: endMs,
      durationMs: endMs - startMs,
      attributes: s.attributes || {},
      events,
      status: s.status?.code === 2 ? "error" : "ok"
    };
  });
}
function timeValueToMs(tv) {
  return tv[0] * 1e3 + tv[1] / 1e6;
}
async function fetchTraceSpans(traceRef, config) {
  const cfg = resolveBackendConfig(config);
  const backendOrder = getBackendOrder(cfg);
  const traceId = isTraceFilePath(traceRef) ? await readTraceIdFromFile(traceRef) : traceRef;
  for (const backend of backendOrder) {
    if (backend === "grafana" && traceId) {
      const spans = await fetchFromGrafanaTempo(traceId, cfg);
      if (spans && spans.length > 0) return spans;
      continue;
    }
    if (backend === "jaeger" && traceId) {
      const spans = await fetchFromJaeger(traceId, cfg);
      if (spans && spans.length > 0) return spans;
      continue;
    }
    if (backend === "file") {
      const spans = await fetchFromLocalFiles(traceRef, cfg);
      if (spans && spans.length > 0) return spans;
      continue;
    }
  }
  return [];
}
async function fetchFromGrafanaTempo(traceId, cfg) {
  let grafanaUrl = cfg.grafanaUrl;
  if (!grafanaUrl) {
    const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (otlpEndpoint) {
      const url = new URL(otlpEndpoint);
      const host = url.hostname;
      for (const port of ["3000", "8001", "80"]) {
        try {
          const testUrl = `http://${host}:${port}/api/health`;
          const resp = await httpGet(testUrl, cfg.authToken, 2e3);
          if (resp && resp.includes('"database"')) {
            grafanaUrl = `http://${host}:${port}`;
            break;
          }
        } catch {
        }
      }
    }
  }
  if (!grafanaUrl) return null;
  try {
    let dsId = cfg.grafanaDatasourceId;
    if (!dsId) {
      const dsResp = await httpGet(`${grafanaUrl}/api/datasources`, cfg.authToken);
      if (dsResp) {
        const datasources = JSON.parse(dsResp);
        const tempo = datasources.find((d) => d.type === "tempo");
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
async function fetchFromJaeger(traceId, cfg) {
  let jaegerUrl = cfg.jaegerUrl;
  if (!jaegerUrl) {
    const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const host = otlpEndpoint ? new URL(otlpEndpoint).hostname : "localhost";
    for (const port of ["16686"]) {
      try {
        const testUrl = `http://${host}:${port}/api/services`;
        const resp = await httpGet(testUrl, void 0, 2e3);
        if (resp && resp.includes('"data"')) {
          jaegerUrl = `http://${host}:${port}`;
          break;
        }
      } catch {
      }
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
async function fetchFromLocalFiles(traceRef, cfg) {
  const traceFile = isTraceFilePath(traceRef) ? traceRef : await findTraceFile(traceRef, cfg.traceDir);
  if (!traceFile) return null;
  try {
    const { parseNDJSONTrace } = await import("./trace-reader-OVE4DL2D.mjs");
    const trace = await parseNDJSONTrace(traceFile);
    return parseLocalNDJSONSpans(trace.spans);
  } catch (err) {
    logger.debug(`[TraceSerializer] Local file parse failed: ${err}`);
    return null;
  }
}
async function httpGet(url, authToken, timeoutMs) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs || 1e4);
    const headers = {};
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
    const resp = await fetch(url, {
      signal: controller.signal,
      headers
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}
async function findTraceFile(traceId, traceDir) {
  const dir = traceDir || process.env.VISOR_TRACE_DIR || "output/traces";
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ndjson"));
  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const firstLine = await readFirstLine(filePath);
      if (!firstLine) continue;
      const parsed = JSON.parse(firstLine);
      if (parsed.traceId === traceId) return filePath;
    } catch {
    }
  }
  return null;
}
async function readTraceIdFromFile(traceFile) {
  try {
    const rl = readline.createInterface({
      input: fs.createReadStream(traceFile, { encoding: "utf8" }),
      crlfDelay: Infinity
    });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed.traceId === "string" && parsed.traceId) {
          rl.close();
          return parsed.traceId;
        }
      } catch {
      }
    }
  } catch {
    return null;
  }
  return null;
}
async function readFirstLine(filePath) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let resolved = false;
    rl.on("line", (line) => {
      if (!resolved) {
        resolved = true;
        rl.close();
        stream.destroy();
        resolve(line.trim() || null);
      }
    });
    rl.on("close", () => {
      if (!resolved) resolve(null);
    });
    rl.on("error", reject);
  });
}
function isNoiseSpan(span) {
  return NOISE_SPAN_NAMES.has(span.name);
}
function isWrapperSpan(span) {
  return WRAPPER_SPAN_NAMES.has(span.name);
}
function buildSpanTree(spans) {
  const filtered = spans.filter((s) => !isNoiseSpan(s));
  const nodeMap = /* @__PURE__ */ new Map();
  for (const span of filtered) {
    nodeMap.set(span.spanId, { span, children: [] });
  }
  let root;
  const orphans = [];
  for (const span of filtered) {
    const node = nodeMap.get(span.spanId);
    if (!span.parentSpanId) {
      root = node;
    } else {
      let parentId = span.parentSpanId;
      while (parentId && !nodeMap.has(parentId)) {
        const parentSpan = spans.find((s) => s.spanId === parentId);
        parentId = parentSpan?.parentSpanId;
      }
      if (parentId) {
        const parent = nodeMap.get(parentId);
        if (parent) parent.children.push(node);
      } else if (!root) {
        root = node;
      } else {
        orphans.push(node);
      }
    }
  }
  if (!root) {
    const sorted = [...nodeMap.values()].sort((a, b) => b.span.durationMs - a.span.durationMs);
    root = sorted[0] || { span: filtered[0], children: [] };
  }
  if (orphans.length > 0) {
    root.children.push(...orphans);
  }
  const sortChildren = (node) => {
    node.children.sort((a, b) => a.span.startTimeMs - b.span.startTimeMs);
    node.children.forEach(sortChildren);
  };
  sortChildren(root);
  const unwrap = (node) => {
    node.children = node.children.map(unwrap);
    const newChildren = [];
    for (const child of node.children) {
      if (isWrapperSpan(child.span)) {
        newChildren.push(...child.children);
      } else {
        newChildren.push(child);
      }
    }
    node.children = newChildren;
    return node;
  };
  unwrap(root);
  const removeDelegateEchos = (node) => {
    const hasDelegateChild = node.children.some((c) => c.span.name === "search.delegate");
    if (hasDelegateChild) {
      node.children = node.children.filter((c) => {
        if (c.span.name !== "probe.event.tool.result") return true;
        const toolName = c.span.attributes["tool.name"];
        return toolName !== "search";
      });
    }
    node.children.forEach(removeDelegateEchos);
  };
  removeDelegateEchos(root);
  return root;
}
function dedupeKey(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 100).toLowerCase();
}
function dedupeOrRegister(ctx, kind, text, spanName) {
  if (!text || text.length < 20) return null;
  const key = dedupeKey(text);
  if (!key) return null;
  const map = ctx[kind];
  const existing = map.get(key);
  if (existing && existing !== spanName) {
    return existing;
  }
  const otherMap = kind === "outputs" ? ctx.intents : ctx.outputs;
  const crossRef = otherMap.get(key);
  if (crossRef && crossRef !== spanName) {
    map.set(key, spanName);
    return crossRef;
  }
  map.set(key, spanName);
  return null;
}
function normalizeSpanName(name) {
  return name.replace(/^child:\s*/, "");
}
function isChildSpan(span) {
  return span.name.startsWith("child: ") || span.attributes["visor.sandbox.child_span"] === true;
}
function getConcreteCheckName(span) {
  const attrs = span.attributes || {};
  const normalizedName = normalizeSpanName(span.name || "");
  const checkId = attrs["visor.check.id"];
  if (checkId) return `visor.check.${String(checkId).replace(/^visor\.check\./, "")}`;
  const lifecycle = getLifecycleSpanInfo(normalizedName);
  if (lifecycle?.kind === "check") return lifecycle.baseName;
  const match = normalizedName.match(/^visor\.check\.([^.]+)$/);
  if (match) return `visor.check.${match[1]}`;
  return null;
}
function getLifecycleSpanInfo(name) {
  const normalizedName = normalizeSpanName(name);
  const checkMatch = normalizedName.match(
    /^visor\.check\.([^.]+)\.(started|completed|failed|progress)$/
  );
  if (checkMatch) {
    return {
      baseName: `visor.check.${checkMatch[1]}`,
      phase: checkMatch[2],
      kind: "check"
    };
  }
  const sandboxChildMatch = normalizedName.match(
    /^visor\.sandbox\.child\.(started|waiting|completed|failed)$/
  );
  if (sandboxChildMatch) {
    return {
      baseName: "visor.sandbox.child",
      phase: sandboxChildMatch[1],
      kind: "sandbox-child"
    };
  }
  const engineerMatch = normalizedName.match(
    /^visor\.engineer\.(started|sandbox_resolved|child_spawned|waiting_on_child|completed|failed|progress)$/
  );
  if (engineerMatch) {
    return {
      baseName: "visor.engineer",
      phase: engineerMatch[1],
      kind: "engineer"
    };
  }
  const genericMatch = normalizedName.match(
    /^(ai\.request|search\.delegate|visor\.ai_check|probe\.ai_request|probe\.search_delegate)\.(started|completed|failed)$/
  );
  if (genericMatch) {
    const baseName = genericMatch[1] === "probe.ai_request" ? "ai.request" : genericMatch[1] === "probe.search_delegate" ? "search.delegate" : genericMatch[1];
    return {
      baseName,
      phase: genericMatch[2],
      kind: "generic"
    };
  }
  return null;
}
function buildRenderContext(allSpans) {
  const realSpanNames = /* @__PURE__ */ new Set();
  let hasChildWorkSpans = false;
  for (const span of allSpans) {
    const normalizedName = normalizeSpanName(span.name);
    const lifecycle = getLifecycleSpanInfo(normalizedName);
    if (!lifecycle) {
      const checkName = getConcreteCheckName(span);
      if (checkName) realSpanNames.add(checkName);
      else realSpanNames.add(normalizedName);
    }
    if (isChildSpan(span) && !lifecycle) {
      hasChildWorkSpans = true;
    }
  }
  return { realSpanNames, hasChildWorkSpans };
}
function shouldSkipLifecycleSpan(span, renderContext) {
  const lifecycle = getLifecycleSpanInfo(span.name);
  if (!lifecycle) return false;
  if (lifecycle.kind === "sandbox-child") {
    return renderContext.hasChildWorkSpans;
  }
  return renderContext.realSpanNames.has(lifecycle.baseName);
}
async function serializeTraceForPrompt(traceIdOrPath, maxChars, backendConfig, taskResponse, fallbackTraceId) {
  let spans = [];
  const cfg = resolveBackendConfig(backendConfig);
  const backendOrder = getBackendOrder(cfg);
  const isFilePath = isTraceFilePath(traceIdOrPath);
  const localTracePath = isFilePath ? traceIdOrPath : void 0;
  const remoteTraceId = fallbackTraceId || (!isFilePath ? traceIdOrPath : await readTraceIdFromFile(traceIdOrPath) || void 0);
  const preferLocalFirst = backendOrder[0] === "file";
  logger.debug(
    `[TraceSerializer] serializeTraceForPrompt ref=${traceIdOrPath} remoteTraceId=${remoteTraceId || "-"} backendOrder=${backendOrder.join(">")}`
  );
  if (preferLocalFirst && localTracePath) {
    logger.debug(`[TraceSerializer] Trying local trace file first: ${localTracePath}`);
    spans = await fetchTraceSpans(localTracePath, { ...cfg, type: "file" });
  }
  if (spans.length === 0 && remoteTraceId) {
    logger.debug(`[TraceSerializer] Trying remote trace backends for trace_id=${remoteTraceId}`);
    spans = await fetchTraceSpans(remoteTraceId, cfg);
  }
  if (spans.length === 0 && localTracePath) {
    logger.debug(`[TraceSerializer] Falling back to local trace file: ${localTracePath}`);
    spans = await fetchTraceSpans(localTracePath, { ...cfg, type: "file" });
  }
  if (spans.length === 0) {
    return "(no trace data available)";
  }
  const tree = buildSpanTree(spans);
  const routeIntentTopic = extractRouteIntentTopic(spans);
  const fullOutput = (maxChars ?? 4e3) > 1e5;
  return renderSpanYaml(tree, spans, {
    maxChars: maxChars ?? 4e3,
    fallbackIntent: routeIntentTopic,
    fullOutput,
    taskResponse
  });
}
function renderSpanTree(tree, opts) {
  const maxChars = opts?.maxChars ?? 4e3;
  const maxDepth = opts?.maxDepth ?? 20;
  const lines = [];
  const dedup = { outputs: /* @__PURE__ */ new Map(), intents: /* @__PURE__ */ new Map() };
  renderNode(
    tree,
    "",
    true,
    0,
    maxDepth,
    lines,
    void 0,
    opts?.fallbackIntent,
    opts?.fullOutput,
    dedup
  );
  let result = lines.join("\n");
  if (result.length > maxChars) {
    result = result.slice(0, maxChars - 20) + "\n... (truncated)";
  }
  return result;
}
function renderTraceTree(tree, opts) {
  const convert = (node) => ({
    span: {
      traceId: node.span?.traceId || "",
      spanId: node.span?.spanId || "",
      parentSpanId: node.span?.parentSpanId,
      name: node.span?.name || node.checkId || "unknown",
      startTimeMs: timeValueToMs(node.span?.startTime || [0, 0]),
      endTimeMs: timeValueToMs(node.span?.endTime || [0, 0]),
      durationMs: node.span?.duration || 0,
      attributes: node.span?.attributes || {},
      events: (node.span?.events || []).map((e) => ({
        name: e.name,
        attributes: e.attributes || {}
      })),
      status: node.status === "error" ? "error" : "ok"
    },
    children: (node.children || []).map(convert)
  });
  return renderSpanTree(convert(tree), opts);
}
function renderSpanYaml(tree, allSpans, opts) {
  const fullOutput = opts?.fullOutput ?? false;
  const maxLen = fullOutput ? 1e5 : 120;
  const dedup = { outputs: /* @__PURE__ */ new Map(), intents: /* @__PURE__ */ new Map() };
  const renderContext = buildRenderContext(allSpans);
  const lines = [];
  renderYamlNode(tree, 0, lines, dedup, renderContext, opts?.fallbackIntent, fullOutput, maxLen);
  if (opts?.taskResponse) {
    while (lines.length > 0 && /^\s*output:\s*=\s*\S+/.test(lines[lines.length - 1])) {
      lines.pop();
    }
    const ml = fullOutput ? 1e5 : 500;
    const text = opts.taskResponse.replace(/\*\*/g, "").replace(/`/g, "").trim();
    if (fullOutput) {
      lines.push("  response: |");
      for (const line of text.split("\n")) {
        lines.push(`    ${line}`);
      }
    } else {
      const truncated = truncate(text.replace(/\n/g, " "), ml);
      lines.push(`  response: ${truncated}`);
      if (text.length > ml) {
        lines.push("  # use --full for complete response");
      }
    }
  }
  return lines.join("\n");
}
function renderYamlNode(node, indent, lines, dedup, renderContext, fallbackIntent, fullOutput, maxLen, parentSpan) {
  if (shouldSkipLifecycleSpan(node.span, renderContext)) {
    for (const child of node.children) {
      renderYamlNode(
        child,
        indent,
        lines,
        dedup,
        renderContext,
        fallbackIntent,
        fullOutput,
        maxLen,
        parentSpan
      );
    }
    return;
  }
  const pad = "  ".repeat(indent);
  const attrs = node.span.attributes;
  const duration = formatDurationMs(node.span.durationMs);
  const rawName = node.span.name;
  const name = normalizeSpanName(rawName);
  const lifecycle = getLifecycleSpanInfo(name);
  const childSuffix = isChildSpan(node.span) ? " [child]" : "";
  const ml = maxLen ?? 120;
  const parentCheckId = parentSpan?.attributes["visor.check.id"];
  const parentCheckName = parentCheckId ? String(parentCheckId).replace(/^visor\.check\./, "") : void 0;
  const displayName = name === "ai.request" && parentCheckName ? parentCheckName : String(attrs["visor.check.id"] || name).replace(/^visor\.check\./, "");
  if (lifecycle) {
    if (lifecycle.kind === "check") {
      const cleanName = lifecycle.baseName.replace(/^visor\.check\./, "");
      lines.push(`${pad}${cleanName}${childSuffix} [${lifecycle.phase}] \u2014 ${duration}`);
      return;
    }
    if (lifecycle.kind === "sandbox-child") {
      const checkName = attrs["visor.check.name"] ? ` ${String(attrs["visor.check.name"])}` : "";
      lines.push(
        `${pad}sandbox.child${checkName}${childSuffix} [${lifecycle.phase}] \u2014 ${duration}`
      );
      return;
    }
    if (lifecycle.kind === "engineer") {
      const sandbox = attrs["visor.sandbox.selected"] || attrs["visor.sandbox.name"];
      const sandboxSuffix = sandbox ? ` sandbox=${String(sandbox)}` : "";
      lines.push(`${pad}engineer${childSuffix} [${lifecycle.phase}]${sandboxSuffix} \u2014 ${duration}`);
      return;
    }
    lines.push(`${pad}${lifecycle.baseName}${childSuffix} [${lifecycle.phase}] \u2014 ${duration}`);
    return;
  }
  const toolName = attrs["tool.name"] || attrs["visor.tool.name"];
  if (toolName) {
    const toolInput = extractToolInput(String(toolName), attrs);
    const toolResultLen = attrs["tool.result.length"] || attrs["tool.result.count"];
    const tn = String(toolName);
    const isSearchTool = tn === "search" || tn === "searchCode" || tn === "search_code";
    const numLen = toolResultLen ? Number(toolResultLen) : -1;
    const noResults = isSearchTool && numLen >= 0 && numLen < 500;
    const resultSize = noResults ? " \u2192 no results" : toolResultLen ? ` \u2192 ${formatSize(numLen)}` : "";
    const successMark = attrs["tool.success"] === false ? " \u2717" : "";
    lines.push(`${pad}- ${tn}(${toolInput})${childSuffix}${resultSize}${successMark}`);
    return;
  }
  if (name === "search.delegate.dedup") {
    const query = attrs["dedup.query"] || "";
    const action = attrs["dedup.action"] || "?";
    const reason = attrs["dedup.reason"] || "";
    const rewritten = attrs["dedup.rewritten"] || "";
    const prevCount = attrs["dedup.previous_count"] || "0";
    let detail = `${action}`;
    if (rewritten) detail += ` \u2192 "${truncate(String(rewritten), 60)}"`;
    if (reason) detail += ` (${truncate(String(reason), 80)})`;
    lines.push(
      `${pad}dedup("${truncate(String(query), 60)}") [${prevCount} prior]: ${detail} \u2014 ${duration}`
    );
    return;
  }
  if (name === "search.delegate") {
    const query = attrs["search.query"] || "";
    const rewritten = attrs["search.query.rewritten"] || "";
    const output = attrs["search.delegate.output"] || "";
    const outputLen = attrs["search.delegate.output_length"] || "";
    let header = `search.delegate("${truncate(String(query), 80)}")${childSuffix}`;
    if (rewritten) header += ` \u2192 rewritten: "${truncate(String(rewritten), 60)}"`;
    header += ` \u2014 ${duration}`;
    lines.push(`${pad}${header}:`);
    if (output) {
      try {
        const parsed = JSON.parse(String(output));
        if (parsed.confidence) {
          let confLine = `confidence: ${parsed.confidence}`;
          if (parsed.reason) confLine += ` \u2014 ${truncate(String(parsed.reason), 100)}`;
          lines.push(`${pad}  ${confLine}`);
        }
        if (parsed.searches && Array.isArray(parsed.searches) && parsed.searches.length > 0) {
          lines.push(`${pad}  searches (${parsed.searches.length}):`);
          for (const s of parsed.searches) {
            const outcome = s.had_results ? "\u2713" : "\u2717";
            lines.push(
              `${pad}    ${outcome} "${truncate(String(s.query || ""), 60)}" in ${truncate(String(s.path || "."), 40)}`
            );
          }
        }
        if (parsed.groups && Array.isArray(parsed.groups) && parsed.groups.length > 0) {
          lines.push(`${pad}  groups (${parsed.groups.length}):`);
          for (const g of parsed.groups) {
            const fileCount = g.files?.length || 0;
            lines.push(`${pad}    - ${truncate(String(g.reason || ""), 80)} (${fileCount} files)`);
          }
        }
      } catch {
        if (outputLen) lines.push(`${pad}  output: ${outputLen} chars`);
      }
    }
    for (const child of node.children) {
      renderYamlNode(
        child,
        indent + 1,
        lines,
        dedup,
        renderContext,
        fallbackIntent,
        fullOutput,
        maxLen,
        node.span
      );
    }
    return;
  }
  if (name === "ai.request") {
    const model = attrs["ai.model"] || attrs["gen_ai.request.model"] || "?";
    const tokensIn = attrs["ai.input_length"] || attrs["gen_ai.usage.input_tokens"] || "";
    const tokensOut = attrs["gen_ai.usage.output_tokens"] || "";
    const tokenParts = [];
    if (tokensIn) tokenParts.push(`${tokensIn} in`);
    if (tokensOut) tokenParts.push(`${tokensOut} out`);
    const tokenStr = tokenParts.length > 0 ? ` \u2014 ${tokenParts.join(", ")}` : "";
    const hasChildren2 = node.children.length > 0;
    lines.push(
      `${pad}ai: ${model}${childSuffix} \u2014 ${duration}${tokenStr}${hasChildren2 ? ":" : ""}`
    );
    const aiInput = String(attrs["ai.input"] || "");
    let intent = extractAIIntent(aiInput, ml);
    if (!intent && parentSpan) {
      const promptPreview = String(
        parentSpan.attributes["visor.provider.request.prompt.preview"] || ""
      );
      if (promptPreview) intent = extractAIIntent(promptPreview, ml);
      if (!intent) {
        const inputOutputs = String(parentSpan.attributes["visor.check.input.outputs"] || "");
        if (inputOutputs) {
          try {
            const o = JSON.parse(inputOutputs);
            const t = o["route-intent"]?.topic;
            if (t) intent = truncate(String(t), ml);
          } catch {
          }
        }
      }
    }
    if (!intent && fallbackIntent && parentSpan?.name !== "search.delegate") {
      intent = fallbackIntent;
    }
    if (intent) {
      const intentRef = dedupeOrRegister(dedup, "intents", intent, displayName);
      if (intentRef) {
        lines.push(`${pad}  intent: = ${intentRef}`);
      } else {
        lines.push(`${pad}  intent: ${intent}`);
      }
    }
    for (const child of node.children) {
      renderYamlNode(
        child,
        indent + 1,
        lines,
        dedup,
        renderContext,
        fallbackIntent,
        fullOutput,
        maxLen,
        node.span
      );
    }
    if (parentSpan) {
      const checkOutput = String(parentSpan.attributes["visor.check.output"] || "");
      if (checkOutput) {
        renderYamlOutput(
          checkOutput,
          `${pad}  `,
          "output",
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
  if (name === "visor.run") {
    const source = attrs["visor.run.source"] || "";
    const visorVersion = attrs["visor.version"] || "";
    const probeVersion = attrs["probe.version"] || "";
    const slackUser = attrs["slack.user_id"] || "";
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
        renderContext,
        fallbackIntent,
        fullOutput,
        maxLen,
        node.span
      );
    }
    return;
  }
  const checkId = attrs["visor.check.id"];
  const checkType = attrs["visor.check.type"];
  const concreteCheckName = getConcreteCheckName({ name, attributes: attrs });
  if (checkId || concreteCheckName) {
    const cleanName = String(checkId || concreteCheckName || name).replace(/^visor\.check\./, "");
    const errMark2 = node.span.status === "error" ? " \u2717" : "";
    lines.push(`${pad}${cleanName}${childSuffix}:${errMark2}`);
    if (checkType) lines.push(`${pad}  type: ${checkType}`);
    lines.push(`${pad}  duration: ${duration}`);
    const inputContext = String(attrs["visor.check.input.context"] || "");
    const inputOutputs = String(attrs["visor.check.input.outputs"] || "");
    const question = extractQuestionFromContext(inputContext, inputOutputs);
    if (question || inputOutputs && inputOutputs !== "{}") {
      renderYamlInput(inputOutputs, `${pad}  `, lines, fullOutput, ml, question);
    }
    for (const child of node.children) {
      renderYamlNode(
        child,
        indent + 1,
        lines,
        dedup,
        renderContext,
        fallbackIntent,
        fullOutput,
        maxLen,
        node.span
      );
    }
    const hasDirectAiChild = node.children.some((c) => c.span.name === "ai.request");
    if (!hasDirectAiChild) {
      const output = String(attrs["visor.check.output"] || "");
      if (output) {
        renderYamlOutput(output, `${pad}  `, "output", cleanName, dedup, lines, fullOutput, ml);
      }
    }
    return;
  }
  const errMark = node.span.status === "error" ? " \u2717" : "";
  const hasChildren = node.children.length > 0;
  lines.push(`${pad}${name}${childSuffix} \u2014 ${duration}${errMark}${hasChildren ? ":" : ""}`);
  for (const child of node.children) {
    renderYamlNode(
      child,
      indent + 1,
      lines,
      dedup,
      renderContext,
      fallbackIntent,
      fullOutput,
      maxLen,
      node.span
    );
  }
}
function renderYamlOutput(rawOutput, pad, label, spanName, dedup, lines, fullOutput, maxLen) {
  const ml = maxLen ?? 120;
  let obj;
  try {
    obj = JSON.parse(rawOutput);
  } catch {
    obj = parseTruncatedJson(rawOutput);
  }
  if (obj === null || obj === void 0 || typeof obj !== "object") return;
  if (typeof obj === "object" && !Array.isArray(obj)) {
    const keys = Object.keys(obj);
    if (keys.length === 1 && typeof obj[keys[0]] === "object" && obj[keys[0]] !== null && !Array.isArray(obj[keys[0]])) {
      obj = obj[keys[0]];
    }
    const objKeys = Object.keys(obj);
    if (objKeys.length === 1 && objKeys[0] === "text" && typeof obj.text === "string") {
      const text = obj.text.replace(/\*\*/g, "").replace(/`/g, "").trim();
      const flat = text.replace(/\n/g, " ");
      const preview2 = fullOutput ? flat : truncate(flat, ml);
      const ref2 = dedupeOrRegister(dedup, "outputs", truncate(flat, 100), spanName);
      if (ref2) {
        lines.push(`${pad}${label}: = ${ref2}`);
      } else {
        lines.push(`${pad}${label}: ${preview2}`);
      }
      return;
    }
  }
  const preview = formatJsonPreview(obj, 200);
  if (!preview) return;
  const ref = dedupeOrRegister(dedup, "outputs", preview, spanName);
  if (ref) {
    lines.push(`${pad}${label}: = ${ref}`);
    return;
  }
  renderYamlValue(obj, pad, label, lines, fullOutput, ml);
}
function renderYamlValue(val, pad, key, lines, fullOutput, maxLen, depth) {
  const ml = maxLen ?? 120;
  const d = depth ?? 0;
  if (val === null || val === void 0) return;
  if (typeof val === "boolean" || typeof val === "number") {
    lines.push(`${pad}${key}: ${val}`);
    return;
  }
  if (typeof val === "string") {
    if (val.startsWith("{") || val.startsWith("[")) return;
    const clean = val.replace(/\*\*/g, "").replace(/`/g, "").trim();
    if (fullOutput && clean.length > 100 && clean.includes("\n")) {
      lines.push(`${pad}${key}: |`);
      for (const line of clean.split("\n").slice(0, fullOutput ? 500 : 5)) {
        lines.push(`${pad}  ${line}`);
      }
    } else {
      const flat = clean.replace(/\n/g, " ");
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
    if (val.every((v) => typeof v === "string") && val.join(", ").length < ml) {
      lines.push(`${pad}${key}: [${val.join(", ")}]`);
      return;
    }
    const maxItems = fullOutput ? 20 : 3;
    lines.push(`${pad}${key}:`);
    for (let i = 0; i < Math.min(val.length, maxItems); i++) {
      const item = val[i];
      if (typeof item === "object" && item !== null) {
        const entries = Object.entries(item).filter(([k]) => k !== "raw" && k !== "tags");
        if (entries.length > 0) {
          const [firstKey, firstVal] = entries[0];
          if (firstVal === null || firstVal === void 0 || typeof firstVal !== "object") {
            const sv = typeof firstVal === "string" ? fullOutput ? firstVal.split("\n")[0] : truncate(firstVal.split("\n")[0], ml) : String(firstVal ?? "");
            lines.push(`${pad}  - ${firstKey}: ${sv}`);
          } else {
            lines.push(`${pad}  - ${firstKey}:`);
            for (const [ck, cv] of Object.entries(firstVal)) {
              if (ck === "raw" || ck === "skills" || ck === "tags") continue;
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
  if (typeof val === "object") {
    if (d > 3) {
      const keys = Object.keys(val);
      lines.push(`${pad}${key}: {${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", ..." : ""}}`);
      return;
    }
    lines.push(`${pad}${key}:`);
    for (const [k, v] of Object.entries(val)) {
      if (k === "raw" || k === "tags") continue;
      renderYamlValue(v, `${pad}  `, k, lines, fullOutput, ml, d + 1);
    }
  }
}
function extractQuestionFromContext(contextStr, inputOutputsStr) {
  if (!contextStr) return void 0;
  try {
    const ctx = JSON.parse(contextStr);
    const outputs = ctx.outputs || {};
    const routeIntent = outputs["route-intent"];
    if (routeIntent) {
      const topic = routeIntent.topic || routeIntent.intent || routeIntent.question;
      if (topic && typeof topic === "string") return topic;
      if (typeof routeIntent === "string") return routeIntent;
    }
    const args = ctx.args || {};
    if (args.topic && typeof args.topic === "string") return args.topic;
    if (args.question && typeof args.question === "string") return args.question;
    if (args.intent && typeof args.intent === "string") return args.intent;
    for (const key of Object.keys(outputs)) {
      const val = outputs[key];
      if (typeof val === "object" && val !== null) {
        if (val.topic && typeof val.topic === "string") {
          try {
            const depOutputs = JSON.parse(inputOutputsStr);
            if (depOutputs[key]) continue;
          } catch {
          }
          return val.topic;
        }
      }
    }
  } catch {
    const topicMatch = contextStr.match(/"topic"\s*:\s*"([^"]+)"/);
    if (topicMatch) return topicMatch[1];
  }
  return void 0;
}
function renderYamlInput(inputOutputsStr, pad, lines, fullOutput, maxLen, question) {
  const ml = maxLen ?? 120;
  if (question) {
    lines.push(`${pad}input: ${truncate(question, fullOutput ? 1e5 : ml)}`);
  }
  try {
    const inputs = JSON.parse(inputOutputsStr);
    if (typeof inputs !== "object" || inputs === null) return;
    const keys = Object.keys(inputs);
    if (keys.length === 0) return;
    if (!question) lines.push(`${pad}input:`);
    for (const key of keys) {
      const val = inputs[key];
      if (typeof val === "object" && val !== null) {
        renderYamlValue(val, `${pad}  `, key, lines, fullOutput, ml, 0);
      } else {
        lines.push(`${pad}  ${key}: ${truncate(String(val), ml)}`);
      }
    }
  } catch {
  }
}
function renderNode(node, prefix, isLast, depth, maxDepth, lines, parentSpan, fallbackIntent, fullOutput, dedup) {
  if (depth > maxDepth) return;
  const hasChildren = node.children.length > 0;
  const connector = depth === 0 ? "" : isLast ? "\u2514\u2500\u2500 " : "\u251C\u2500\u2500 ";
  const { line: formatted, output: deferredOutput } = formatSpanLine(
    node.span,
    parentSpan,
    fallbackIntent,
    fullOutput,
    dedup,
    hasChildren
  );
  if (formatted) {
    lines.push(`${prefix}${connector}${formatted}`);
  }
  const childPrefix = depth === 0 ? "" : formatted ? prefix + (isLast ? "    " : "\u2502   ") : prefix;
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
  if (deferredOutput) {
    lines.push(`${childPrefix}\u2514\u2500\u2192 ${deferredOutput}`);
  }
}
function formatSpanLine(span, parentSpan, fallbackIntent, fullOutput, dedup, hasChildren) {
  const duration = formatDurationMs(span.durationMs);
  const attrs = span.attributes;
  const name = span.name;
  const previewLimit = fullOutput ? 1e4 : 120;
  const displayName = String(attrs["visor.check.id"] || name).replace(/^visor\.check\./, "");
  const dedupeOutputStr = (rawOutput, label) => {
    if (!rawOutput) return "";
    if (!dedup) return rawOutput;
    const ref = dedupeOrRegister(dedup, "outputs", rawOutput, label);
    if (ref) return `(= ${ref})`;
    return rawOutput;
  };
  const dedupeIntentStr = (rawIntent, label) => {
    if (!rawIntent || !dedup) return rawIntent ? ` \u{1F4AC} ${rawIntent}` : "";
    const ref = dedupeOrRegister(dedup, "intents", rawIntent, label);
    if (ref) return ` \u{1F4AC} (= ${ref})`;
    return ` \u{1F4AC} ${rawIntent}`;
  };
  const makeResult = (line, outputPreview) => {
    if (!outputPreview) return { line };
    if (hasChildren) {
      return { line, output: outputPreview };
    }
    return { line: `${line} \u2192 ${outputPreview}` };
  };
  const toolName = attrs["tool.name"] || attrs["visor.tool.name"];
  if (toolName) {
    const toolInput = extractToolInput(String(toolName), attrs);
    const toolResultLen = attrs["tool.result.length"] || attrs["tool.result.count"];
    const toolSuccess = attrs["tool.success"];
    const tn = String(toolName);
    const isSearchTool = tn === "search" || tn === "searchCode" || tn === "search_code";
    const numLen = toolResultLen ? Number(toolResultLen) : -1;
    const noResults = isSearchTool && numLen >= 0 && numLen < 500;
    const resultSize = noResults ? "no results" : toolResultLen ? formatSize(numLen) : "";
    const durStr = Number(attrs["tool.duration_ms"]) > 0 ? ` (${formatDurationMs(Number(attrs["tool.duration_ms"]))})` : "";
    let successMark = toolSuccess === false ? " \u2717" : "";
    if (tn === "bash") {
      const toolResult = String(attrs["tool.result"] || "");
      const exitMatch = toolResult.match(/Exit Code: (\S+)/);
      const sigMatch = toolResult.match(/Signal: (\S+)/);
      if (sigMatch && sigMatch[1] !== "null") {
        successMark = ` [${sigMatch[1]}]`;
      } else if (exitMatch && exitMatch[1] !== "0" && exitMatch[1] !== "null") {
        successMark = ` [exit ${exitMatch[1]}]`;
      }
    }
    return {
      line: `${toolName}(${toolInput})${durStr}${resultSize ? ` \u2192 ${resultSize}` : ""}${successMark}`
    };
  }
  if (name === "search.delegate.dedup") {
    const query = attrs["dedup.query"] || "";
    const action = attrs["dedup.action"] || "?";
    const reason = attrs["dedup.reason"] || "";
    const rewritten = attrs["dedup.rewritten"] || "";
    let detail = `${action}`;
    if (rewritten) detail += ` \u2192 "${truncate(String(rewritten), 50)}"`;
    if (reason) detail += ` \u2014 ${truncate(String(reason), 60)}`;
    return { line: `dedup("${truncate(String(query), 50)}") ${detail} (${duration})` };
  }
  if (name === "search.delegate") {
    const query = attrs["search.query"] || "";
    const rewritten = attrs["search.query.rewritten"] || "";
    const output = attrs["search.delegate.output"] || "";
    let suffix = "";
    try {
      const parsed = JSON.parse(String(output));
      const parts = [];
      if (parsed.confidence) parts.push(parsed.confidence);
      if (parsed.groups?.length) parts.push(`${parsed.groups.length} groups`);
      if (parsed.searches?.length) parts.push(`${parsed.searches.length} searches`);
      if (parts.length > 0) suffix = ` \u2192 ${parts.join(", ")}`;
    } catch {
    }
    const rewriteStr = rewritten ? ` \u2192 "${truncate(String(rewritten), 40)}"` : "";
    return {
      line: `search.delegate("${truncate(String(query), 60)}"${rewriteStr}) (${duration})${suffix}`
    };
  }
  if (name === "ai.request") {
    const model = attrs["ai.model"] || attrs["gen_ai.request.model"] || "?";
    const tokensIn = attrs["ai.input_length"] || attrs["gen_ai.usage.input_tokens"] || "";
    const tokensOut = attrs["gen_ai.usage.output_tokens"] || "";
    const tokenParts = [];
    if (tokensIn) tokenParts.push(`${tokensIn} in`);
    if (tokensOut) tokenParts.push(`${tokensOut} out`);
    const tokenStr = tokenParts.length > 0 ? ` [${tokenParts.join(", ")}]` : "";
    const aiInput = String(attrs["ai.input"] || "");
    let intent = extractAIIntent(aiInput, previewLimit);
    if (!intent && parentSpan) {
      const promptPreview = String(
        parentSpan.attributes["visor.provider.request.prompt.preview"] || ""
      );
      if (promptPreview) {
        intent = extractAIIntent(promptPreview, previewLimit);
      }
      if (!intent) {
        const inputOutputs = String(parentSpan.attributes["visor.check.input.outputs"] || "");
        if (inputOutputs) {
          try {
            const outputs = JSON.parse(inputOutputs);
            const topic = outputs["route-intent"]?.topic;
            if (topic) intent = truncate(String(topic), 150);
          } catch {
          }
        }
      }
    }
    if (!intent && fallbackIntent && parentSpan?.name !== "search.delegate") {
      intent = fallbackIntent;
    }
    const intentStr = intent ? dedupeIntentStr(intent, displayName) : "";
    let outputPreview = "";
    if (parentSpan) {
      const checkOutput = String(parentSpan.attributes["visor.check.output"] || "");
      if (checkOutput) {
        const preview = extractOutputPreview(checkOutput, previewLimit);
        if (preview) outputPreview = dedupeOutputStr(preview, displayName);
      }
    }
    const mainLine = `ai ${model} (${duration})${tokenStr}${intentStr}`;
    return makeResult(mainLine, outputPreview);
  }
  const checkId = attrs["visor.check.id"];
  const checkType = attrs["visor.check.type"];
  if (checkId || name.startsWith("visor.check.")) {
    const cleanName = String(checkId || name).replace(/^visor\.check\./, "");
    const typeStr = checkType ? ` [${checkType}]` : "";
    const inputOutputs = String(attrs["visor.check.input.outputs"] || "");
    let inputStr = "";
    if (inputOutputs && inputOutputs !== "{}") {
      inputStr = " " + formatInputPreview(inputOutputs, previewLimit);
    }
    const output = String(attrs["visor.check.output"] || "");
    let outputPreview = "";
    if (output) {
      const preview = extractOutputPreview(output, previewLimit);
      if (preview) outputPreview = dedupeOutputStr(preview, cleanName);
    }
    const mainLine = `${cleanName}${typeStr} (${duration})${inputStr}`;
    return makeResult(mainLine, outputPreview);
  }
  if (name === "visor.run") {
    const source = attrs["visor.run.source"] || "";
    const sourceStr = source ? ` (${source})` : "";
    return { line: `visor.run${sourceStr} (${duration})` };
  }
  if (name === "probe.event.negotiated_timeout.observer" || name === "negotiated_timeout.observer") {
    let detail = "";
    const attrDecision = attrs["observer.decision"] || attrs["decision_reason"];
    if (attrDecision) {
      const reason = attrs["observer.reason"] || attrs["decision_reason"] || "";
      if (String(attrDecision) === "extended" || attrs["granted_ms"]) {
        const grantedMin = attrs["observer.granted_min"] || attrs["granted_min"] || (attrs["granted_ms"] ? Math.round(Number(attrs["granted_ms"]) / 6e4) : "?");
        detail = `extended +${grantedMin}min`;
        if (reason) detail += ` (${truncate(String(reason), 60)})`;
        const used = attrs["observer.extensions_used"] || attrs["extensions_used"];
        const max = attrs["observer.max_requests"] || attrs["max_requests"];
        if (used) detail += ` [${used}/${max || "?"} used]`;
      } else if (String(attrDecision) === "exhausted") {
        detail = "budget exhausted";
      } else {
        detail = `declined`;
        if (reason) detail += `: ${truncate(String(reason), 60)}`;
      }
    }
    if (!detail && span.events.length > 0) {
      for (const evt of span.events) {
        const evtName = evt.name || "";
        const ea = evt.attributes;
        if (evtName.includes("observer_extended")) {
          const grantedMin = ea["granted_min"] || (ea["granted_ms"] ? Math.round(Number(ea["granted_ms"]) / 6e4) : "?");
          detail = `extended +${grantedMin}min`;
          if (ea["decision_reason"]) detail += ` (${truncate(String(ea["decision_reason"]), 60)})`;
          if (ea["extensions_used"])
            detail += ` [${ea["extensions_used"]}/${ea["max_requests"] || "?"} used]`;
          break;
        }
        if (evtName.includes("observer_declined")) {
          detail = "declined";
          if (ea["decision_reason"]) detail += `: ${truncate(String(ea["decision_reason"]), 60)}`;
          break;
        }
        if (evtName.includes("observer_exhausted")) {
          const used = ea["extensions_used"] || "?";
          const max = ea["max_requests"] || "?";
          detail = `budget exhausted [${used}/${max} extensions]`;
          break;
        }
        if (evtName.includes("observer_invoked") && !detail) {
          const elapsed = ea["elapsed_min"] || "?";
          const tools = ea["active_tools_count"] || 0;
          detail = `${elapsed}min elapsed, ${tools} active tools`;
        }
      }
    }
    if (!detail) {
      const elapsed = attrs["elapsed_min"];
      const activeTools = attrs["active_tools_count"] || attrs["active_tools"];
      if (elapsed) detail += `${elapsed}min elapsed`;
      if (activeTools)
        detail += detail ? `, ${activeTools} active tools` : `${activeTools} active tools`;
    }
    const label = detail ? `timeout.observer: ${detail}` : "timeout.observer";
    return { line: `${label} (${duration})` };
  }
  if (name.includes("negotiated_timeout.observer_")) {
    const suffix = name.replace(/.*negotiated_timeout\.observer_/, "");
    const reason = attrs["decision_reason"] || "";
    if (suffix === "extended") {
      const grantedMin = attrs["granted_min"] || (attrs["granted_ms"] ? Math.round(Number(attrs["granted_ms"]) / 6e4) : "?");
      const used = attrs["extensions_used"] || "?";
      const max = attrs["max_requests"] || "?";
      const reasonStr = reason ? ` (${truncate(String(reason), 60)})` : "";
      return { line: `timeout.extended: +${grantedMin}min${reasonStr} [${used}/${max} used]` };
    }
    if (suffix === "declined") {
      const reasonStr = reason ? `: ${truncate(String(reason), 60)}` : "";
      return { line: `timeout.declined${reasonStr}` };
    }
    if (suffix === "exhausted") {
      const used = attrs["extensions_used"] || "?";
      const max = attrs["max_requests"] || "?";
      return { line: `timeout.exhausted [${used}/${max} extensions, budget depleted]` };
    }
    if (suffix === "invoked") {
      const elapsed = attrs["elapsed_min"] || "?";
      const tools = attrs["active_tools_count"] || 0;
      return { line: `timeout.observer invoked (${elapsed}min elapsed, ${tools} active tools)` };
    }
    return { line: `timeout.${suffix} (${duration})` };
  }
  if (name.includes("negotiated_timeout.abort_summary")) {
    const summaryLen = attrs["summary_length"] || attrs["summary.length"];
    const lenStr = summaryLen ? ` \u2192 ${formatSize(Number(summaryLen))}` : "";
    return { line: `timeout.abort_summary (${duration})${lenStr}` };
  }
  if (name.includes("graceful_stop.initiated") || name.includes("graceful_stop.invoked")) {
    const reason = attrs["graceful_stop.reason"] || attrs["reason"] || "";
    const reasonStr = reason ? `: ${truncate(String(reason), 80)}` : "";
    return { line: `graceful_stop${reasonStr} (${duration})` };
  }
  return { line: `${name} (${duration})${span.status === "error" ? " \u2717" : ""}` };
}
function parseWorkspacePath(fullPath) {
  const wsMatch = fullPath.match(/\/visor-workspaces\/[^/]+\/([^/]+)(?:\/(.+))?/);
  if (wsMatch) {
    return { repo: wsMatch[1], filePath: wsMatch[2] };
  }
  const wtMatch = fullPath.match(/\.visor\/worktrees\/worktrees\/[^/]+\/(.+)/);
  if (wtMatch) {
    const segs = wtMatch[1].split("/");
    return { repo: segs[0], filePath: segs.length > 1 ? segs.slice(1).join("/") : void 0 };
  }
  return null;
}
function extractToolInput(toolName, attrs) {
  const result = String(attrs["tool.result"] || "");
  const explicitInput = String(attrs["tool.input"] || "");
  if (explicitInput) return truncate(explicitInput, 80);
  switch (toolName) {
    case "search": {
      const patMatch = result.match(/Pattern: (.+)/);
      const pathMatch = result.match(/Path: (\S+)/);
      const pattern = patMatch ? patMatch[1].trim() : "";
      const workspace = pathMatch ? parseWorkspacePath(pathMatch[1]) : null;
      const parts = [];
      if (pattern) parts.push(`"${truncate(pattern, 50)}"`);
      if (workspace?.repo) parts.push(workspace.repo);
      return parts.join(", ");
    }
    case "extract": {
      const fileMatch = result.match(/Files to extract:\n\s*(\S+)/);
      if (fileMatch) {
        const fullPath = fileMatch[1];
        const workspace = parseWorkspacePath(fullPath);
        if (workspace) {
          const parts = [];
          parts.push(workspace.filePath || workspace.repo || fullPath.split("/").pop() || "");
          if (workspace.repo) parts.push(workspace.repo);
          return parts.join(", ");
        }
        const segs = fullPath.split("/");
        return segs.length > 2 ? segs.slice(-2).join("/") : segs[segs.length - 1];
      }
      return "";
    }
    case "bash": {
      const cmdMatch = result.match(/^Command: (.+)/);
      if (cmdMatch) {
        let cmd = cmdMatch[1].trim();
        const pipes = cmd.split(/\s*\|\s*/);
        if (pipes.length > 2) {
          cmd = `${pipes[0]} | ... (${pipes.length} stages)`;
        }
        return truncate(cmd, 80);
      }
      const deniedMatch = result.match(/^Permission denied: Component "([^"]+)"/);
      if (deniedMatch) {
        return truncate(deniedMatch[1], 60) + " [denied]";
      }
      return "";
    }
    case "listFiles": {
      const pathMatch = result.match(/^(\S+):/);
      if (pathMatch) {
        const parts = pathMatch[1].split("/");
        return parts[parts.length - 1] || "";
      }
      return "";
    }
    default:
      return truncate(explicitInput, 60);
  }
}
function extractAIIntent(input, maxLen = 150) {
  if (!input || input.length < 20) return "";
  const qMatch = input.match(/<question>([\s\S]*?)<\/question>/);
  if (qMatch) return truncate(qMatch[1].trim(), maxLen);
  const crMatch = input.match(/## Current Request\s*\n(?:User: )?(.+)/);
  if (crMatch) return truncate(crMatch[1].trim(), maxLen);
  const userMatch = input.match(/(?:^|\n)User: (.+)/);
  if (userMatch) return truncate(userMatch[1].trim(), maxLen);
  const pmMatch = input.match(/Primary message[^:]*:\s*\n(.+)/);
  if (pmMatch) return truncate(pmMatch[1].trim(), maxLen);
  return "";
}
function formatJsonPreview(obj, maxLen) {
  if (obj === null || obj === void 0) return "";
  if (typeof obj !== "object") return truncate(String(obj), maxLen);
  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    const first = typeof obj[0] === "object" && obj[0] !== null ? obj[0].project_id || obj[0].id || obj[0].name || Object.keys(obj[0])[0] || "..." : String(obj[0]);
    return `[${obj.length}] ${truncate(String(first), 30)}${obj.length > 1 ? ", ..." : ""}`;
  }
  const parts = [];
  let len = 2;
  for (const [key, val] of Object.entries(obj)) {
    if (key === "raw" || key === "tags") continue;
    let valStr;
    if (val === null || val === void 0) continue;
    if (typeof val === "boolean") valStr = String(val);
    else if (typeof val === "number") valStr = String(val);
    else if (typeof val === "string") {
      if (val.startsWith("{") || val.startsWith("[")) continue;
      const clean = val.replace(/\*\*/g, "").replace(/^#+\s*/gm, "").replace(/`/g, "").trim();
      valStr = `"${truncate(clean.split("\n")[0], Math.min(80, maxLen / 3))}"`;
    } else if (Array.isArray(val)) {
      if (val.every((item) => typeof item === "string") && val.join(", ").length < Math.min(120, maxLen / 2)) {
        valStr = `[${val.join(", ")}]`;
      } else {
        valStr = `[${val.length}]`;
      }
    } else if (typeof val === "object") valStr = `{${Object.keys(val).length} keys}`;
    else valStr = "...";
    const part = `${key}: ${valStr}`;
    if (len + part.length + 2 > maxLen) {
      parts.push("...");
      break;
    }
    parts.push(part);
    len += part.length + 2;
  }
  return `{${parts.join(", ")}}`;
}
function extractOutputPreview(output, maxLen = 120) {
  try {
    const obj = JSON.parse(output);
    return formatJsonPreview(obj, maxLen);
  } catch {
    return extractTruncatedJsonPreview(output, maxLen);
  }
}
function parseTruncatedJson(input) {
  let pos = 0;
  const len = input.length;
  function skipWhitespace() {
    while (pos < len && " 	\n\r".includes(input[pos])) pos++;
  }
  function parseString() {
    if (input[pos] !== '"') return "";
    pos++;
    let result = "";
    while (pos < len) {
      const ch = input[pos];
      if (ch === "\\" && pos + 1 < len) {
        const next = input[pos + 1];
        if (next === "n") {
          result += "\n";
          pos += 2;
          continue;
        }
        if (next === "t") {
          result += "	";
          pos += 2;
          continue;
        }
        if (next === '"') {
          result += '"';
          pos += 2;
          continue;
        }
        if (next === "\\") {
          result += "\\";
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
    return result;
  }
  function parseNumber() {
    const start = pos;
    if (input[pos] === "-") pos++;
    while (pos < len && input[pos] >= "0" && input[pos] <= "9") pos++;
    if (pos < len && input[pos] === ".") {
      pos++;
      while (pos < len && input[pos] >= "0" && input[pos] <= "9") pos++;
    }
    return Number(input.slice(start, pos));
  }
  function parseValue() {
    skipWhitespace();
    if (pos >= len) return void 0;
    const ch = input[pos];
    if (ch === '"') return parseString();
    if (ch === "{") return parseObject();
    if (ch === "[") return parseArray();
    if (ch === "t" && input.slice(pos, pos + 4) === "true") {
      pos += 4;
      return true;
    }
    if (ch === "f" && input.slice(pos, pos + 5) === "false") {
      pos += 5;
      return false;
    }
    if (ch === "n" && input.slice(pos, pos + 4) === "null") {
      pos += 4;
      return null;
    }
    if (ch === "-" || ch >= "0" && ch <= "9") return parseNumber();
    return void 0;
  }
  function parseObject() {
    const obj = {};
    pos++;
    skipWhitespace();
    while (pos < len && input[pos] !== "}") {
      skipWhitespace();
      if (pos >= len || input[pos] !== '"') break;
      const key = parseString();
      skipWhitespace();
      if (pos >= len || input[pos] !== ":") {
        obj[key] = void 0;
        break;
      }
      pos++;
      const val = parseValue();
      if (val !== void 0) obj[key] = val;
      skipWhitespace();
      if (pos < len && input[pos] === ",") pos++;
    }
    if (pos < len && input[pos] === "}") pos++;
    return obj;
  }
  function parseArray() {
    const arr = [];
    pos++;
    skipWhitespace();
    while (pos < len && input[pos] !== "]") {
      const val = parseValue();
      if (val !== void 0) arr.push(val);
      else break;
      skipWhitespace();
      if (pos < len && input[pos] === ",") pos++;
      skipWhitespace();
    }
    if (pos < len && input[pos] === "]") pos++;
    return arr;
  }
  return parseValue();
}
function extractTruncatedJsonPreview(output, maxLen) {
  if (!output.startsWith("{") && !output.startsWith("[")) return "";
  const parsed = parseTruncatedJson(output);
  if (!parsed || typeof parsed !== "object") return "";
  return formatJsonPreview(parsed, maxLen);
}
function formatInputPreview(inputOutputsStr, maxLen) {
  if (!inputOutputsStr) return "";
  try {
    const inputs = JSON.parse(inputOutputsStr);
    if (typeof inputs !== "object" || inputs === null) return "";
    const keys = Object.keys(inputs);
    if (keys.length === 0) return "";
    const parts = [];
    let len = 2;
    for (const key of keys) {
      const val = inputs[key];
      let valStr;
      if (typeof val === "object" && val !== null) {
        const vkeys = Object.keys(val);
        if (vkeys.length <= 3) {
          valStr = `{${vkeys.join(", ")}}`;
        } else {
          valStr = `{${vkeys.slice(0, 2).join(", ")}, ...${vkeys.length} keys}`;
        }
      } else {
        valStr = truncate(String(val), 30);
      }
      const part = `${key}: ${valStr}`;
      if (len + part.length + 2 > maxLen) {
        parts.push("...");
        break;
      }
      parts.push(part);
      len += part.length + 2;
    }
    return `\u2190 {${parts.join(", ")}}`;
  } catch {
    return "";
  }
}
function extractRouteIntentTopic(spans) {
  const riSpan = spans.find((s) => s.attributes["visor.check.id"] === "route-intent");
  if (riSpan) {
    const output = String(riSpan.attributes["visor.check.output"] || "");
    if (output) {
      try {
        const obj = JSON.parse(output);
        if (obj.topic) return truncate(String(obj.topic), 150);
      } catch {
      }
    }
  }
  const classifySpan = spans.find((s) => s.attributes["visor.check.id"] === "classify");
  if (classifySpan) {
    const output = String(classifySpan.attributes["visor.check.output"] || "");
    if (output) {
      try {
        const obj = JSON.parse(output);
        if (obj.topic) return truncate(String(obj.topic), 150);
      } catch {
      }
    }
  }
  return void 0;
}
function formatSize(chars) {
  if (chars < 1e3) return `${chars} chars`;
  return `${(chars / 1e3).toFixed(1)}k chars`;
}
function formatDurationMs(ms) {
  if (ms < 0) return "0ms";
  if (ms < 1e3) return `${Math.round(ms)}ms`;
  if (ms < 6e4) return `${(ms / 1e3).toFixed(1)}s`;
  const mins = Math.floor(ms / 6e4);
  const secs = Math.round(ms % 6e4 / 1e3);
  return `${mins}m ${secs}s`;
}
function truncate(str, max) {
  if (typeof str !== "string") return "";
  if (str.length <= max) return str;
  const tail = Math.min(100, Math.floor(max / 3));
  const head = max - tail - 19;
  if (head < 10) return str.slice(0, max - 3) + "...";
  return str.slice(0, head) + " ...[truncated]... " + str.slice(-tail);
}
var NOISE_SPAN_NAMES, WRAPPER_SPAN_NAMES;
var init_trace_serializer = __esm({
  "src/agent-protocol/trace-serializer.ts"() {
    init_logger();
    NOISE_SPAN_NAMES = /* @__PURE__ */ new Set([
      "engine.state.init",
      "engine.state.waveplanning",
      "engine.state.planready",
      "visor.sandbox.stopAll"
    ]);
    WRAPPER_SPAN_NAMES = /* @__PURE__ */ new Set([
      "engine.state.leveldispatch",
      "visor.ai_check",
      "probe.delegation"
    ]);
  }
});

export {
  fetchTraceSpans,
  findTraceFile,
  readTraceIdFromFile,
  serializeTraceForPrompt,
  renderSpanTree,
  renderTraceTree,
  renderSpanYaml,
  init_trace_serializer
};
//# sourceMappingURL=chunk-IY5PQ5EN.mjs.map