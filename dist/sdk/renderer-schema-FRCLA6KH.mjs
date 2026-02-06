import {
  init_logger,
  logger
} from "./chunk-P6YFV6N2.mjs";
import "./chunk-4HVFUUNB.mjs";
import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/state-machine/dispatch/renderer-schema.ts
async function loadRendererSchema(name) {
  try {
    const fs = await import("fs/promises");
    const path = await import("path");
    const sanitized = String(name).replace(/[^a-zA-Z0-9-]/g, "");
    if (!sanitized) return void 0;
    const candidates = [
      // When bundled with ncc, __dirname is dist/ and output/ is at dist/output/
      path.join(__dirname, "output", sanitized, "schema.json"),
      // When running from source, __dirname is src/state-machine/dispatch/ and output/ is at output/
      path.join(__dirname, "..", "..", "output", sanitized, "schema.json"),
      // When running from a checkout with output/ folder copied to CWD
      path.join(process.cwd(), "output", sanitized, "schema.json"),
      // Fallback: cwd/dist/output/
      path.join(process.cwd(), "dist", "output", sanitized, "schema.json")
    ];
    for (const p of candidates) {
      try {
        const raw = await fs.readFile(p, "utf-8");
        return JSON.parse(raw);
      } catch {
      }
    }
  } catch (e) {
    try {
      logger.warn(`[schema-loader] Failed to load renderer schema '${name}': ${String(e)}`);
    } catch {
    }
  }
  return void 0;
}
var init_renderer_schema = __esm({
  "src/state-machine/dispatch/renderer-schema.ts"() {
    init_logger();
  }
});
init_renderer_schema();
export {
  loadRendererSchema
};
//# sourceMappingURL=renderer-schema-FRCLA6KH.mjs.map