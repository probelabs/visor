import {
  __esm,
  __require
} from "./chunk-WMJKH4XE.mjs";

// src/utils/tracer-init.ts
import * as path from "path";
import * as fs from "fs";
async function initializeTracer(sessionId, checkName) {
  try {
    let ProbeLib;
    try {
      ProbeLib = await import("@probelabs/probe");
    } catch {
      try {
        ProbeLib = __require("@probelabs/probe");
      } catch {
        ProbeLib = {};
      }
    }
    const SimpleTelemetry = ProbeLib?.SimpleTelemetry;
    const SimpleAppTracer = ProbeLib?.SimpleAppTracer;
    if (SimpleTelemetry && SimpleAppTracer) {
      const sanitizedCheckName = checkName ? path.basename(checkName) : "check";
      const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
      const traceDir = process.env.GITHUB_WORKSPACE ? path.join(process.env.GITHUB_WORKSPACE, "debug-artifacts") : path.join(process.cwd(), "debug-artifacts");
      if (!fs.existsSync(traceDir)) {
        fs.mkdirSync(traceDir, { recursive: true });
      }
      const traceFilePath = path.join(traceDir, `trace-${sanitizedCheckName}-${timestamp}.jsonl`);
      const resolvedTracePath = path.resolve(traceFilePath);
      const resolvedTraceDir = path.resolve(traceDir);
      if (!resolvedTracePath.startsWith(resolvedTraceDir)) {
        console.error(
          `\u26A0\uFE0F Security: Attempted path traversal detected. Check name: ${checkName}, resolved path: ${resolvedTracePath}`
        );
        return null;
      }
      const telemetry = new SimpleTelemetry({
        enableFile: true,
        filePath: traceFilePath,
        enableConsole: false
      });
      const tracer = new SimpleAppTracer(telemetry, sessionId);
      if (typeof tracer.recordEvent !== "function") {
        tracer.recordEvent = (name, attributes) => {
          try {
            if (telemetry.record) {
              telemetry.record({ event: name, ...attributes });
            }
          } catch {
          }
        };
      }
      console.error(`\u{1F4CA} Simple tracing enabled, will save to: ${traceFilePath}`);
      if (process.env.GITHUB_ACTIONS) {
        console.log(`::notice title=AI Trace::Trace will be saved to ${traceFilePath}`);
        console.log(`::set-output name=trace-path::${traceFilePath}`);
      }
      return {
        tracer,
        telemetryConfig: telemetry,
        filePath: traceFilePath
      };
    }
    console.error("\u26A0\uFE0F Telemetry classes not available in ProbeAgent, skipping tracing");
    return null;
  } catch (error) {
    console.error("\u26A0\uFE0F Warning: Failed to initialize tracing:", error);
    return null;
  }
}
var init_tracer_init = __esm({
  "src/utils/tracer-init.ts"() {
  }
});

export {
  initializeTracer,
  init_tracer_init
};
//# sourceMappingURL=chunk-3OMWVM6J.mjs.map