import {
  __esm,
  __export
} from "./chunk-WMJKH4XE.mjs";

// src/logger.ts
var logger_exports = {};
__export(logger_exports, {
  configureLoggerFromCli: () => configureLoggerFromCli,
  logger: () => logger
});
function levelToNumber(level) {
  switch (level) {
    case "silent":
      return 0;
    case "error":
      return 10;
    case "warn":
      return 20;
    case "info":
      return 30;
    case "verbose":
      return 40;
    case "debug":
      return 50;
  }
}
function configureLoggerFromCli(options) {
  logger.configure({
    outputFormat: options.output,
    debug: options.debug,
    verbose: options.verbose,
    quiet: options.quiet
  });
  try {
    if (options.output) process.env.VISOR_OUTPUT_FORMAT = String(options.output);
    if (typeof options.debug === "boolean") {
      process.env.VISOR_DEBUG = options.debug ? "true" : "false";
    }
  } catch {
  }
}
var Logger, logger;
var init_logger = __esm({
  "src/logger.ts"() {
    "use strict";
    Logger = class {
      level = "info";
      isJsonLike = false;
      isTTY = typeof process !== "undefined" ? !!process.stderr.isTTY : false;
      showTimestamps = true;
      // default: always show timestamps
      configure(opts = {}) {
        let lvl = "info";
        if (opts.debug || process.env.VISOR_DEBUG === "true") {
          lvl = "debug";
        } else if (opts.verbose || process.env.VISOR_LOG_LEVEL === "verbose") {
          lvl = "verbose";
        } else if (opts.quiet || process.env.VISOR_LOG_LEVEL === "quiet") {
          lvl = "warn";
        } else if (opts.level) {
          lvl = opts.level;
        } else if (process.env.VISOR_LOG_LEVEL) {
          const envLvl = process.env.VISOR_LOG_LEVEL;
          if (["silent", "error", "warn", "info", "verbose", "debug"].includes(envLvl)) {
            lvl = envLvl;
          }
        }
        this.level = lvl;
        const output = opts.outputFormat || process.env.VISOR_OUTPUT_FORMAT || "table";
        this.isJsonLike = output === "json" || output === "sarif";
      }
      shouldLog(level) {
        const desired = levelToNumber(level);
        const current = levelToNumber(this.level);
        if (desired > current) return false;
        if (this.isJsonLike && desired < levelToNumber("error") && this.level !== "debug" && this.level !== "verbose") {
          return false;
        }
        return true;
      }
      write(msg, level) {
        try {
          if (this.showTimestamps) {
            const ts = (/* @__PURE__ */ new Date()).toISOString();
            const lvl = level ? level : void 0;
            const prefix = lvl ? `[${ts}] [${lvl}]` : `[${ts}]`;
            process.stderr.write(`${prefix} ${msg}
`);
          } else {
            process.stderr.write(msg + "\n");
          }
        } catch {
        }
      }
      info(msg) {
        if (this.shouldLog("info")) this.write(msg, "info");
      }
      warn(msg) {
        if (this.shouldLog("warn")) this.write(msg, "warn");
      }
      error(msg) {
        if (this.shouldLog("error")) this.write(msg, "error");
      }
      verbose(msg) {
        if (this.shouldLog("verbose")) this.write(msg, "verbose");
      }
      debug(msg) {
        if (this.shouldLog("debug")) this.write(msg, "debug");
      }
      step(msg) {
        if (this.shouldLog("info")) this.write(`\u25B6 ${msg}`, "info");
      }
      success(msg) {
        if (this.shouldLog("info")) this.write(`\u2714 ${msg}`, "info");
      }
    };
    logger = new Logger();
  }
});

export {
  logger,
  logger_exports,
  init_logger
};
//# sourceMappingURL=chunk-VMPLF6FT.mjs.map