import {
  addDiagramBlock,
  addEvent
} from "./chunk-33QVZ2D4.mjs";
import "./chunk-WMJKH4XE.mjs";

// src/utils/mermaid-telemetry.ts
import * as fs from "fs";
import * as path from "path";
var MERMAID_RE = /```mermaid\s*\n([\s\S]*?)\n```/gi;
function emitMermaidFromMarkdown(checkName, markdown, origin) {
  if (!markdown || typeof markdown !== "string") return 0;
  let m;
  let count = 0;
  MERMAID_RE.lastIndex = 0;
  while ((m = MERMAID_RE.exec(markdown)) != null) {
    const code = (m[1] || "").trim();
    if (code) {
      try {
        addEvent("diagram.block", { check: checkName, origin, code });
        addDiagramBlock(origin);
        if (process.env.VISOR_TRACE_REPORT === "true") {
          const outDir = process.env.VISOR_TRACE_DIR || path.join(process.cwd(), "output", "traces");
          try {
            if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
            const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
            const jsonPath = path.join(outDir, `${ts}.trace.json`);
            const htmlPath = path.join(outDir, `${ts}.report.html`);
            let data = { spans: [] };
            if (fs.existsSync(jsonPath)) {
              try {
                data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
              } catch {
                data = { spans: [] };
              }
            }
            data.spans.push({
              events: [{ name: "diagram.block", attrs: { check: checkName, origin, code } }]
            });
            fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), "utf8");
            if (!fs.existsSync(htmlPath)) {
              fs.writeFileSync(
                htmlPath,
                '<!doctype html><html><head><meta charset="utf-8"/><title>Visor Trace Report</title></head><body><h2>Visor Trace Report</h2></body></html>',
                "utf8"
              );
            }
          } catch {
          }
        }
        count++;
      } catch {
      }
    }
  }
  return count;
}
export {
  emitMermaidFromMarkdown
};
//# sourceMappingURL=mermaid-telemetry-YCTIG76M.mjs.map