import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/frontends/host.ts
function isActiveFrontend(f) {
  return typeof f.setEngine === "function" && typeof f.setVisorConfig === "function";
}
var FrontendsHost;
var init_host = __esm({
  "src/frontends/host.ts"() {
    FrontendsHost = class {
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
            const { NdjsonSink } = await import("./ndjson-sink-FD2PSXGD.mjs");
            this.frontends.push(new NdjsonSink(spec.config));
          } else if (spec.name === "github") {
            const { GitHubFrontend } = await import("./github-frontend-56UQTA47.mjs");
            this.frontends.push(new GitHubFrontend());
          } else if (spec.name === "slack") {
            const { SlackFrontend } = await import("./slack-frontend-6SXPTQDI.mjs");
            this.frontends.push(new SlackFrontend(spec.config));
          } else if (spec.name === "tui") {
            const { TuiFrontend } = await import("./tui-frontend-T56PZB67.mjs");
            this.frontends.push(new TuiFrontend(spec.config));
          } else if (spec.name === "telegram") {
            const { TelegramFrontend } = await import("./telegram-frontend-GA7OLADB.mjs");
            this.frontends.push(new TelegramFrontend(spec.config));
          } else if (spec.name === "email") {
            const { EmailFrontend } = await import("./email-frontend-6JU4L33L.mjs");
            this.frontends.push(new EmailFrontend(spec.config));
          } else if (spec.name === "whatsapp") {
            const { WhatsAppFrontend } = await import("./whatsapp-frontend-72XEIUIR.mjs");
            this.frontends.push(new WhatsAppFrontend(spec.config));
          } else if (spec.name === "teams") {
            const { TeamsFrontend } = await import("./teams-frontend-DNW5GZP3.mjs");
            this.frontends.push(new TeamsFrontend(spec.config));
          } else if (spec.name === "a2a") {
            const { A2AFrontend } = await import("./a2a-frontend-7CYN3X7M.mjs");
            this.frontends.push(new A2AFrontend(spec.config));
          } else {
            this.log.warn(`[FrontendsHost] Unknown frontend '${spec.name}', skipping`);
          }
        }
      }
      async startAll(ctxFactory) {
        for (const f of this.frontends) {
          try {
            const ctx = ctxFactory();
            if (isActiveFrontend(f)) {
              if (ctx.engine) f.setEngine(ctx.engine);
              if (ctx.visorConfig) f.setVisorConfig(ctx.visorConfig);
            }
            await f.start(ctx);
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
  }
});
init_host();
export {
  FrontendsHost,
  isActiveFrontend
};
//# sourceMappingURL=host-QRGXXRDA.mjs.map