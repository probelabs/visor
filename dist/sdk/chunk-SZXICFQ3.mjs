import {
  context,
  init_lazy_otel,
  trace
} from "./chunk-UCMJJ3IM.mjs";
import {
  __esm,
  __export
} from "./chunk-J7LXIPZS.mjs";

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
    init_lazy_otel();
    Logger = class {
      level = "info";
      isJsonLike = false;
      isTTY = typeof process !== "undefined" ? !!process.stderr.isTTY : false;
      showTimestamps = true;
      // default: always show timestamps
      sink;
      sinkPassthrough = true;
      sinkErrorMode = "throw";
      sinkErrorHandler;
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
      setSink(sink, opts = {}) {
        this.sink = sink;
        this.sinkPassthrough = opts.passthrough !== void 0 ? opts.passthrough : true;
        this.sinkErrorMode = opts.errorMode || "throw";
        this.sinkErrorHandler = opts.onError;
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
      getTraceSuffix(msg) {
        if (!msg) return "";
        if (msg.includes("trace_id=") || msg.includes("trace_id:")) return "";
        try {
          const span = trace.getSpan(context.active()) || trace.getActiveSpan();
          const ctx = span?.spanContext?.();
          if (!ctx?.traceId) return "";
          return ` [trace_id=${ctx.traceId} span_id=${ctx.spanId}]`;
        } catch {
          return "";
        }
      }
      write(msg, level) {
        const suffix = this.getTraceSuffix(msg);
        const decoratedMsg = suffix ? `${msg}${suffix}` : msg;
        const lvl = level || "info";
        if (this.sink) {
          try {
            this.sink(decoratedMsg, lvl);
          } catch (error) {
            if (this.sinkErrorMode === "warn") {
              try {
                if (this.sinkErrorHandler) {
                  this.sinkErrorHandler(error);
                } else {
                  const errMsg = error instanceof Error ? error.message : String(error);
                  process.stderr.write(`[logger] sink failed: ${errMsg}
`);
                }
              } catch {
              }
            }
            if (this.sinkErrorMode === "throw") {
              throw error;
            }
            return;
          }
          if (!this.sinkPassthrough) return;
        }
        try {
          if (this.showTimestamps) {
            const ts = (/* @__PURE__ */ new Date()).toISOString();
            const lvl2 = level ? level : void 0;
            let tsToken = `[${ts}]`;
            let lvlToken = lvl2 ? `[${lvl2}]` : "";
            if (this.isTTY && !this.isJsonLike) {
              const reset = "\x1B[0m";
              const dim = "\x1B[2m";
              const colours = {
                silent: "",
                error: "\x1B[31m",
                // red
                warn: "\x1B[33m",
                // yellow
                info: "\x1B[36m",
                // cyan
                verbose: "\x1B[35m",
                // magenta
                debug: "\x1B[90m"
                // bright black / gray
              };
              tsToken = `${dim}${tsToken}${reset}`;
              if (lvl2) {
                const colour = colours[lvl2] || "";
                if (colour) {
                  lvlToken = `${colour}${lvlToken}${reset}`;
                }
              }
            }
            const prefix = lvl2 ? `${tsToken} ${lvlToken}` : tsToken;
            process.stderr.write(`${prefix} ${decoratedMsg}
`);
          } else {
            process.stderr.write(decoratedMsg + "\n");
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
//# sourceMappingURL=chunk-SZXICFQ3.mjs.map