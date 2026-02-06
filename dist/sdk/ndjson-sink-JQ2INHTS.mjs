import "./chunk-J7LXIPZS.mjs";

// src/frontends/ndjson-sink.ts
import fs from "fs";
import path from "path";
var NdjsonSink = class {
  name = "ndjson-sink";
  cfg;
  unsub;
  filePath;
  constructor(config) {
    this.cfg = config || {};
  }
  start(ctx) {
    this.filePath = this.resolveFile(this.cfg.file || ".visor-events.ndjson");
    ctx.logger.info(`[ndjson-sink] Writing events to ${this.filePath}`);
    this.unsub = ctx.eventBus.onAny(async (envelope) => {
      try {
        const line = JSON.stringify({
          id: envelope && envelope.id || void 0,
          ts: (/* @__PURE__ */ new Date()).toISOString(),
          runId: ctx.run.runId,
          payload: envelope && envelope.payload || envelope,
          safe: true
        });
        await fs.promises.appendFile(this.filePath, line + "\n");
      } catch (err) {
        ctx.logger.error("[ndjson-sink] Failed to write event:", err);
      }
    });
  }
  stop() {
    this.unsub?.unsubscribe();
    this.unsub = void 0;
  }
  resolveFile(p) {
    if (path.isAbsolute(p)) return p;
    return path.join(process.cwd(), p);
  }
};
export {
  NdjsonSink
};
//# sourceMappingURL=ndjson-sink-JQ2INHTS.mjs.map