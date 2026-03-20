import {
  init_logger,
  logger
} from "./chunk-FT3I25QV.mjs";
import "./chunk-UCMJJ3IM.mjs";
import {
  __esm,
  __require
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
async function fetchTraceSpans(traceId, config) {
  const cfg = resolveBackendConfig(config);
  const tryGrafana = cfg.type === "grafana" || cfg.type === "auto";
  const tryJaeger = cfg.type === "jaeger" || cfg.type === "auto";
  const tryFile = cfg.type === "file" || cfg.type === "auto";
  if (tryGrafana) {
    const spans = await fetchFromGrafanaTempo(traceId, cfg);
    if (spans && spans.length > 0) return spans;
  }
  if (tryJaeger) {
    const spans = await fetchFromJaeger(traceId, cfg);
    if (spans && spans.length > 0) return spans;
  }
  if (tryFile) {
    const spans = await fetchFromLocalFiles(traceId, cfg);
    if (spans && spans.length > 0) return spans;
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
async function fetchFromLocalFiles(traceId, cfg) {
  const traceFile = await findTraceFile(traceId, cfg.traceDir);
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
async function serializeTraceForPrompt(traceIdOrPath, maxChars, backendConfig, taskResponse, fallbackTraceId) {
  let spans = [];
  const isFilePath = traceIdOrPath.includes("/") || traceIdOrPath.endsWith(".ndjson");
  const remoteTraceId = fallbackTraceId || (!isFilePath ? traceIdOrPath : void 0);
  if (remoteTraceId) {
    spans = await fetchTraceSpans(remoteTraceId, backendConfig);
  }
  if (spans.length === 0 && isFilePath) {
    try {
      const { parseNDJSONTrace } = await import("./trace-reader-OVE4DL2D.mjs");
      const trace = await parseNDJSONTrace(traceIdOrPath);
      spans = parseLocalNDJSONSpans(trace.spans);
    } catch {
    }
  }
  if (spans.length === 0 && !remoteTraceId && !isFilePath) {
    spans = await fetchTraceSpans(traceIdOrPath, backendConfig);
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
function renderSpanYaml(tree, allSpans, opts) {
  const fullOutput = opts?.fullOutput ?? false;
  const maxLen = fullOutput ? 1e5 : 120;
  const dedup = { outputs: /* @__PURE__ */ new Map(), intents: /* @__PURE__ */ new Map() };
  const lines = [];
  renderYamlNode(tree, 0, lines, dedup, opts?.fallbackIntent, fullOutput, maxLen);
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
function renderYamlNode(node, indent, lines, dedup, fallbackIntent, fullOutput, maxLen, parentSpan) {
  const pad = "  ".repeat(indent);
  const attrs = node.span.attributes;
  const duration = formatDurationMs(node.span.durationMs);
  const name = node.span.name;
  const ml = maxLen ?? 120;
  const parentCheckId = parentSpan?.attributes["visor.check.id"];
  const parentCheckName = parentCheckId ? String(parentCheckId).replace(/^visor\.check\./, "") : void 0;
  const displayName = name === "ai.request" && parentCheckName ? parentCheckName : String(attrs["visor.check.id"] || name).replace(/^visor\.check\./, "");
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
    lines.push(`${pad}- ${tn}(${toolInput})${resultSize}${successMark}`);
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
    let header = `search.delegate("${truncate(String(query), 80)}")`;
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
    lines.push(`${pad}ai: ${model} \u2014 ${duration}${tokenStr}${hasChildren2 ? ":" : ""}`);
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
  if (checkId || name.startsWith("visor.check.")) {
    const cleanName = String(checkId || name).replace(/^visor\.check\./, "");
    const errMark2 = node.span.status === "error" ? " \u2717" : "";
    lines.push(`${pad}${cleanName}:${errMark2}`);
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
  lines.push(`${pad}${name} \u2014 ${duration}${errMark}${hasChildren ? ":" : ""}`);
  for (const child of node.children) {
    renderYamlNode(child, indent + 1, lines, dedup, fallbackIntent, fullOutput, maxLen, node.span);
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
    if (keys.length === 1 && typeof obj[keys[0]] === "object" && obj[keys[0]] !== null) {
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
    if (key === "raw" || key === "skills" || key === "tags") continue;
    let valStr;
    if (val === null || val === void 0) continue;
    if (typeof val === "boolean") valStr = String(val);
    else if (typeof val === "number") valStr = String(val);
    else if (typeof val === "string") {
      if (val.startsWith("{") || val.startsWith("[")) continue;
      const clean = val.replace(/\*\*/g, "").replace(/^#+\s*/gm, "").replace(/`/g, "").trim();
      valStr = `"${truncate(clean.split("\n")[0], Math.min(80, maxLen / 3))}"`;
    } else if (Array.isArray(val)) valStr = `[${val.length}]`;
    else if (typeof val === "object") valStr = `{${Object.keys(val).length} keys}`;
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
    "use strict";
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

// src/agent-protocol/task-evaluator.ts
import crypto from "crypto";
function buildEvaluationSchema(includeExecution) {
  const schema = {
    type: "object",
    required: ["response_quality", "overall_rating", "summary"],
    properties: {
      response_quality: {
        type: "object",
        required: ["rating", "category", "relevance", "completeness", "actionable", "reasoning"],
        properties: {
          rating: { type: "integer", minimum: 1, maximum: 5 },
          category: {
            type: "string",
            enum: ["excellent", "good", "adequate", "poor", "off-topic", "error"]
          },
          relevance: { type: "boolean" },
          completeness: { type: "boolean" },
          actionable: { type: "boolean" },
          reasoning: { type: "string" }
        }
      },
      overall_rating: { type: "integer", minimum: 1, maximum: 5 },
      summary: { type: "string" }
    }
  };
  if (includeExecution) {
    schema.required.push("execution_quality");
    schema.properties.execution_quality = {
      type: "object",
      required: ["rating", "category", "reasoning"],
      properties: {
        rating: { type: "integer", minimum: 1, maximum: 5 },
        category: { type: "string", enum: ["efficient", "adequate", "wasteful", "error"] },
        unnecessary_tool_calls: { type: "integer" },
        reasoning: { type: "string" }
      }
    };
  }
  return schema;
}
async function evaluateTask(taskId, store, config) {
  const { rows } = store.listTasksRaw({ limit: 500 });
  const match = rows.find((r) => r.id === taskId || r.id.startsWith(taskId));
  if (!match) {
    throw new Error(`Task not found: ${taskId}`);
  }
  const fullTask = store.getTask(match.id);
  if (!fullTask) {
    throw new Error(`Task data not found: ${match.id}`);
  }
  const requestText = match.request_message || "No request text available";
  let responseText = "No response available";
  if (fullTask.status?.message) {
    const parts = fullTask.status.message.parts ?? [];
    const textPart = parts.find((p) => typeof p.text === "string");
    if (textPart) {
      responseText = textPart.text;
    }
  }
  if (fullTask.status.state === "failed" && responseText === "No response available") {
    return {
      response_quality: {
        rating: 1,
        category: "error",
        relevance: false,
        completeness: false,
        actionable: false,
        reasoning: "Task failed without producing a response."
      },
      overall_rating: 1,
      summary: "Task failed without producing a response."
    };
  }
  let traceTree;
  const traceId = match.metadata?.trace_id;
  const traceFile = match.metadata?.trace_file;
  if (traceFile || traceId) {
    try {
      const traceRef = traceFile || traceId;
      traceTree = await serializeTraceForPrompt(
        traceRef,
        1e6,
        { traceDir: config?.traceDir },
        responseText !== "No response available" ? responseText : void 0,
        traceId
      );
      if (traceTree === "(no trace data available)") {
        traceTree = void 0;
      }
    } catch (err) {
      logger.debug(
        `[TaskEvaluator] Failed to load trace: ${err instanceof Error ? err.message : err}`
      );
    }
  }
  const systemPrompt = config?.prompt || process.env.VISOR_EVAL_PROMPT || DEFAULT_EVALUATION_PROMPT;
  const hasTrace = !!traceTree;
  let userPrompt;
  if (traceTree) {
    userPrompt = `<user_request>
${requestText}
</user_request>

<execution_trace>
${traceTree}
</execution_trace>`;
  } else {
    userPrompt = `<user_request>
${requestText}
</user_request>

<agent_response>
${responseText}
</agent_response>`;
  }
  const { ProbeAgent } = __require("@probelabs/probe");
  const model = config?.model || process.env.VISOR_EVAL_MODEL || process.env.VISOR_JUDGE_MODEL || void 0;
  const provider = config?.provider || process.env.VISOR_EVAL_PROVIDER || void 0;
  const agentOptions = {
    sessionId: `visor-task-eval-${Date.now()}`,
    systemPrompt,
    maxIterations: 1,
    disableTools: true
  };
  if (model) agentOptions.model = model;
  if (provider) agentOptions.provider = provider;
  if (config?.apiKey) {
    const envKey = provider === "openai" ? "OPENAI_API_KEY" : provider === "anthropic" ? "ANTHROPIC_API_KEY" : "GOOGLE_API_KEY";
    process.env[envKey] = config.apiKey;
  }
  const agent = new ProbeAgent(agentOptions);
  if (typeof agent.initialize === "function") {
    await agent.initialize();
  }
  const jsonSchema = buildEvaluationSchema(hasTrace);
  const schemaStr = JSON.stringify(jsonSchema);
  const response = await agent.answer(userPrompt, void 0, { schema: schemaStr });
  let result;
  try {
    const cleaned = response.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
    result = JSON.parse(cleaned);
  } catch {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      result = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error(`Failed to parse evaluation response as JSON: ${response.slice(0, 200)}`);
    }
  }
  if (!hasTrace) {
    const MAX_RATING_WITHOUT_TRACE = 4;
    if (result.overall_rating > MAX_RATING_WITHOUT_TRACE) {
      result.overall_rating = MAX_RATING_WITHOUT_TRACE;
    }
    result.trace_available = false;
    result.summary = `[No trace available \u2014 execution quality not assessed, rating capped at ${MAX_RATING_WITHOUT_TRACE}/5] ${result.summary}`;
  } else {
    result.trace_available = true;
  }
  return result;
}
async function evaluateAndStore(taskId, store, config) {
  const result = await evaluateTask(taskId, store, config);
  const { rows } = store.listTasksRaw({ limit: 500 });
  const match = rows.find((r) => r.id === taskId || r.id.startsWith(taskId));
  if (match) {
    store.addArtifact(match.id, {
      artifact_id: crypto.randomUUID(),
      name: "evaluation",
      parts: [{ text: JSON.stringify(result), media_type: "application/json" }]
    });
  }
  return result;
}
var DEFAULT_EVALUATION_PROMPT;
var init_task_evaluator = __esm({
  "src/agent-protocol/task-evaluator.ts"() {
    init_logger();
    init_trace_serializer();
    DEFAULT_EVALUATION_PROMPT = `You are a task response quality evaluator for an AI agent system called Visor.

You will receive the user's original request and an execution trace inside <execution_trace> tags. The trace is a YAML-formatted view of the entire agent execution, including the final response. When no trace is available, the agent response is provided directly.

## How to Read the Execution Trace

The trace is a tree of spans representing the agent's execution pipeline:

**Top-level: \`visor.run\`** \u2014 The root span with metadata:
- \`trace_id\`: Unique execution identifier
- \`visor\` / \`probe\`: Software versions
- \`source\`: Where the request came from (e.g., "slack", "cli")
- \`duration\`: Total wall-clock time

**Checks** \u2014 Named processing steps (e.g., \`route-intent\`, \`explore-code\`, \`generate-response\`):
- \`type\`: "ai" (LLM-powered), "script" (deterministic), or "workflow" (sub-pipeline)
- \`duration\`: How long this step took
- \`input\`: What was passed to this check \u2014 may include an \`intent\` (the user's question as understood by the router) and dependency outputs
- \`output\`: The check's result \u2014 may be structured JSON or plain text

**AI blocks** (\`ai: model-name\`) \u2014 Individual LLM calls within checks:
- Shows model used, duration, and token counts (input/output)
- \`intent\`: The question or instruction sent to the LLM

**Tool calls** \u2014 Listed as \`- toolName(input) \u2192 size\`:
- \`search("query" in repo)\`: Code search. "\u2192 no results" means nothing was found; otherwise shows result size
- \`extract(file/path)\`: File content extraction with result size
- \`listFiles(dir)\`: Directory listing
- \`bash()\`: Shell command execution

**Delegations** (\`search.delegate("query")\`) \u2014 Sub-agent searches:
- Contains their own AI blocks and tool calls
- Used for complex multi-step code exploration

**The \`response\` field** at the end of the trace is the final answer sent back to the user. This is the primary output to evaluate.

**Symbols:**
- \`\u2717\` marks failed/error spans
- \`= check-name\` means output is identical to that check's output (deduplication)

## Evaluation Criteria

**Response Quality** (1-5):
- **Relevance**: Does the response directly address what the user asked? A response about the wrong topic or that misunderstands the question scores low.
- **Completeness**: Does it fully answer the question? Partial answers, missing key details, or surface-level responses score lower.
- **Actionable**: Can the user act on this information? Vague or generic advice scores lower than specific, concrete answers with code references.
- Rating: 5=excellent (thorough, specific, directly useful), 4=good (answers well but minor gaps), 3=adequate (addresses question but lacks depth), 2=poor (partially relevant or very incomplete), 1=off-topic or error

**Execution Quality** (1-5, only when trace is provided):
- **Efficiency**: Were tool calls necessary and well-targeted? Good search queries that find results on the first try score high.
- **Redundancy**: Were there duplicate searches, unnecessary re-searches with slightly different queries, or tools called for information already available?
- **Extract-then-search anti-pattern**: If a file was already extracted (e.g., \`extract(docs/config.mdx) \u2192 3.3k chars\`), then a subsequent \`search("term" in config.mdx)\` is redundant \u2014 the agent already has the file content and should parse it from context instead of making another tool call. Flag every instance of this pattern.
- **Search-reformulation waste**: If a search returns "no results" and the agent immediately retries with a minor query variation (e.g., \`"audit store_type"\` \u2192 \`"audit "store_type""\` \u2192 \`"store_type"\`), that's usually wasteful. A single well-crafted query should suffice; reformulating 3+ times for the same concept is a red flag.
- **Delegation quality**: Were search delegations productive? Did they explore relevant code paths?
- **Token usage**: Was input context kept reasonable, or did the agent load excessive amounts of code?
- Rating: 5=efficient (minimal, targeted tool use), 4=adequate (minor redundancy), 3=some waste (noticeable unnecessary calls), 2=wasteful (many redundant searches or delegations), 1=error/broken execution

**Overall Rating** (1-5): Weighted combination \u2014 response quality matters most, execution quality is secondary. A perfect response from a wasteful execution still scores 3-4 overall.

You MUST respond with valid JSON matching the provided schema. Be specific in your reasoning \u2014 reference actual check names, tool calls, or response content.`;
  }
});
init_task_evaluator();
export {
  DEFAULT_EVALUATION_PROMPT,
  evaluateAndStore,
  evaluateTask
};
//# sourceMappingURL=task-evaluator-GQYDOSGT.mjs.map