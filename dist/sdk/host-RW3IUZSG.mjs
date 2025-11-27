import "./chunk-WMJKH4XE.mjs";

// src/frontends/host.ts
var FrontendsHost = class {
  bus;
  log;
  frontends = [];
  constructor(bus, log) {
    this.bus = bus;
    this.log = log;
  }
  async load(specs) {
    this.frontends = [];
    for (const spec of specs) {
      if (spec.name === "ndjson-sink") {
        const { NdjsonSink } = await import("./ndjson-sink-B4V4NTAQ.mjs");
        this.frontends.push(new NdjsonSink(spec.config));
      } else if (spec.name === "github") {
        const { GitHubFrontend } = await import("./github-frontend-STKFLVEI.mjs");
        this.frontends.push(new GitHubFrontend());
      } else if (spec.name === "slack") {
        const { SlackFrontend } = await import("./slack-frontend-4AOQY4AL.mjs");
        this.frontends.push(new SlackFrontend(spec.config));
      } else {
        this.log.warn(`[FrontendsHost] Unknown frontend '${spec.name}', skipping`);
      }
    }
  }
  async startAll(ctxFactory) {
    for (const f of this.frontends) {
      try {
        await f.start(ctxFactory());
        this.log.info(`[FrontendsHost] Started frontend '${f.name}'`);
      } catch (err) {
        this.log.error(`[FrontendsHost] Failed to start '${f.name}':`, err);
      }
    }
  }
  async stopAll() {
    for (const f of this.frontends) {
      try {
        await f.stop();
      } catch (err) {
        this.log.error(`[FrontendsHost] Failed to stop '${f.name}':`, err);
      }
    }
  }
};
export {
  FrontendsHost
};
//# sourceMappingURL=host-RW3IUZSG.mjs.map