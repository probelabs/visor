import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/debug-visualizer/trace-reader.ts
import * as fs from "fs";
import * as readline from "readline";
async function parseNDJSONTrace(filePath) {
  const spans = [];
  let lineNumber = 0;
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });
  for await (const line of rl) {
    lineNumber++;
    if (!line.trim()) {
      continue;
    }
    try {
      const rawSpan = JSON.parse(line);
      const processedSpan = processRawSpan(rawSpan);
      spans.push(processedSpan);
    } catch (error) {
      console.warn(`[trace-reader] Malformed JSON at line ${lineNumber}: ${error}`);
    }
  }
  if (spans.length === 0) {
    throw new Error("No valid spans found in trace file");
  }
  const tree = buildExecutionTree(spans);
  const snapshots = extractStateSnapshots(spans);
  const timeline = computeTimeline(spans);
  const sortedSpans = [...spans].sort((a, b) => compareTimeValues(a.startTime, b.startTime));
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
      totalSnapshots: snapshots.length
    }
  };
}
function processRawSpan(rawSpan) {
  const traceId = rawSpan.traceId || "";
  const spanId = rawSpan.spanId || "";
  const parentSpanId = rawSpan.parentSpanId || void 0;
  const name = rawSpan.name || "unknown";
  const startTime = rawSpan.startTime || [0, 0];
  const endTime = rawSpan.endTime || rawSpan.startTime || [0, 0];
  const startMs = timeValueToMillis(startTime);
  const endMs = timeValueToMillis(endTime);
  const duration = endMs - startMs;
  const attributes = rawSpan.attributes || {};
  const events = (rawSpan.events || []).map((evt) => ({
    name: evt.name || "unknown",
    time: evt.time || [0, 0],
    timestamp: evt.timestamp || timeValueToISO(evt.time || [0, 0]),
    attributes: evt.attributes || {}
  }));
  const status = rawSpan.status?.code === 2 ? "error" : "ok";
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
    status
  };
}
function buildExecutionTree(spans) {
  const nodeMap = /* @__PURE__ */ new Map();
  for (const span of spans) {
    const node = createExecutionNode(span);
    nodeMap.set(span.spanId, node);
  }
  let rootNode;
  const orphans = [];
  for (const span of spans) {
    const node = nodeMap.get(span.spanId);
    if (!span.parentSpanId) {
      rootNode = node;
    } else {
      const parent = nodeMap.get(span.parentSpanId);
      if (parent) {
        parent.children.push(node);
      } else {
        orphans.push(node);
      }
    }
  }
  if (!rootNode) {
    console.warn("[trace-reader] No root span found, creating synthetic root");
    rootNode = {
      checkId: "synthetic-root",
      type: "run",
      status: "completed",
      children: Array.from(nodeMap.values()).filter((n) => !n.span.parentSpanId),
      span: spans[0],
      // Use first span as placeholder
      state: {}
    };
  }
  if (orphans.length > 0 && rootNode) {
    rootNode.children.push(...orphans);
  }
  return rootNode;
}
function createExecutionNode(span) {
  const attrs = span.attributes;
  const checkId = attrs["visor.check.id"] || attrs["visor.run.id"] || span.spanId;
  let type = "unknown";
  if (span.name === "visor.run") {
    type = "run";
  } else if (span.name === "visor.check") {
    type = "check";
  } else if (span.name.startsWith("visor.provider.")) {
    type = "provider";
  }
  let status = "completed";
  if (span.status === "error") {
    status = "error";
  } else if (attrs["visor.check.skipped"] === true) {
    status = "skipped";
  }
  const state = {};
  if (attrs["visor.check.input.context"]) {
    try {
      state.inputContext = JSON.parse(attrs["visor.check.input.context"]);
    } catch {
      state.inputContext = attrs["visor.check.input.context"];
    }
  }
  if (attrs["visor.check.output"]) {
    try {
      state.output = JSON.parse(attrs["visor.check.output"]);
    } catch {
      state.output = attrs["visor.check.output"];
    }
  }
  if (span.status === "error" || attrs["visor.check.error"]) {
    state.errors = [attrs["visor.check.error"] || "Unknown error"];
  }
  state.metadata = {
    type: attrs["visor.check.type"],
    duration: span.duration,
    provider: attrs["visor.provider.type"]
  };
  return {
    checkId,
    type,
    status,
    children: [],
    span,
    state
  };
}
function extractStateSnapshots(spans) {
  const snapshots = [];
  for (const span of spans) {
    for (const event of span.events) {
      if (event.name === "state.snapshot") {
        const attrs = event.attributes || {};
        const snapshot = {
          checkId: attrs["visor.snapshot.check_id"] || span.attributes["visor.check.id"] || "unknown",
          timestamp: attrs["visor.snapshot.timestamp"] || event.timestamp || timeValueToISO(event.time),
          timestampNanos: event.time,
          outputs: parseJSON(attrs["visor.snapshot.outputs"], {}),
          memory: parseJSON(attrs["visor.snapshot.memory"], {})
        };
        snapshots.push(snapshot);
      }
    }
  }
  snapshots.sort((a, b) => compareTimeValues(a.timestampNanos, b.timestampNanos));
  return snapshots;
}
function computeTimeline(spans) {
  const events = [];
  for (const span of spans) {
    const checkId = span.attributes["visor.check.id"] || span.spanId;
    events.push({
      type: "check.started",
      checkId,
      timestamp: timeValueToISO(span.startTime),
      timestampNanos: span.startTime,
      metadata: {
        name: span.name,
        type: span.attributes["visor.check.type"]
      }
    });
    events.push({
      type: span.status === "error" ? "check.failed" : "check.completed",
      checkId,
      timestamp: timeValueToISO(span.endTime),
      timestampNanos: span.endTime,
      duration: span.duration,
      status: span.status,
      metadata: {
        name: span.name
      }
    });
    for (const evt of span.events) {
      events.push({
        type: evt.name === "state.snapshot" ? "state.snapshot" : "event",
        checkId: evt.attributes?.["visor.snapshot.check_id"] || checkId,
        timestamp: evt.timestamp || timeValueToISO(evt.time),
        timestampNanos: evt.time,
        metadata: {
          eventName: evt.name,
          attributes: evt.attributes
        }
      });
    }
  }
  events.sort((a, b) => compareTimeValues(a.timestampNanos, b.timestampNanos));
  return events;
}
function timeValueToMillis(timeValue) {
  const [seconds, nanos] = timeValue;
  return seconds * 1e3 + nanos / 1e6;
}
function timeValueToISO(timeValue) {
  const millis = timeValueToMillis(timeValue);
  return new Date(millis).toISOString();
}
function compareTimeValues(a, b) {
  if (a[0] !== b[0]) {
    return a[0] - b[0];
  }
  return a[1] - b[1];
}
function parseJSON(value, defaultValue) {
  if (typeof value !== "string") {
    return defaultValue;
  }
  try {
    return JSON.parse(value);
  } catch {
    return defaultValue;
  }
}
var init_trace_reader = __esm({
  "src/debug-visualizer/trace-reader.ts"() {
  }
});
init_trace_reader();
export {
  buildExecutionTree,
  computeTimeline,
  extractStateSnapshots,
  parseNDJSONTrace
};
//# sourceMappingURL=trace-reader-OVE4DL2D.mjs.map