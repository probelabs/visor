import {
  MemoryStore,
  init_memory_store
} from "./chunk-6F5DTN74.mjs";
import {
  init_logger,
  logger,
  logger_exports
} from "./chunk-RH4HH6SI.mjs";
import {
  __esm,
  __export,
  __require,
  __toCommonJS
} from "./chunk-WMJKH4XE.mjs";

// src/telemetry/lazy-otel.ts
function getOtelApi() {
  if (otelApiAttempted) return otelApi;
  otelApiAttempted = true;
  try {
    otelApi = (function(name) {
      return __require(name);
    })(OTEL_API_MODULE);
  } catch {
    otelApi = null;
  }
  return otelApi;
}
function createNoOpTracer() {
  return {
    startSpan: () => createNoOpSpan(),
    // Support both OTel v1 and v2 overloads:
    // - startActiveSpan(name, callback)
    // - startActiveSpan(name, options, callback)
    // - startActiveSpan(name, options, context, callback)
    startActiveSpan: (name, arg2, arg3, arg4) => {
      const span = createNoOpSpan();
      let cb = void 0;
      if (typeof arg2 === "function") cb = arg2;
      else if (typeof arg3 === "function") cb = arg3;
      else if (typeof arg4 === "function") cb = arg4;
      if (typeof cb === "function") {
        try {
          return cb(span);
        } catch {
          return void 0;
        }
      }
      return span;
    }
  };
}
function createNoOpSpan() {
  return {
    spanContext: () => ({ traceId: "", spanId: "", traceFlags: 0 }),
    setAttribute: () => {
    },
    setAttributes: () => {
    },
    addEvent: () => {
    },
    setStatus: () => {
    },
    updateName: () => {
    },
    end: () => {
    },
    isRecording: () => false,
    recordException: () => {
    }
  };
}
function createNoOpMeter() {
  return {
    createCounter: () => ({ add: () => {
    } }),
    createHistogram: () => ({ record: () => {
    } }),
    createUpDownCounter: () => ({ add: () => {
    } }),
    createObservableGauge: () => {
    },
    createObservableCounter: () => {
    },
    createObservableUpDownCounter: () => {
    }
  };
}
var otelApi, otelApiAttempted, OTEL_API_MODULE, trace, context, metrics, SpanStatusCode;
var init_lazy_otel = __esm({
  "src/telemetry/lazy-otel.ts"() {
    "use strict";
    otelApi = null;
    otelApiAttempted = false;
    OTEL_API_MODULE = "@opentelemetry/api";
    trace = {
      getTracer(name, version) {
        const api = getOtelApi();
        if (!api) return createNoOpTracer();
        return api.trace.getTracer(name, version);
      },
      getSpan(context2) {
        const api = getOtelApi();
        if (!api) return void 0;
        return api.trace.getSpan(context2);
      },
      getActiveSpan() {
        const api = getOtelApi();
        if (!api) return void 0;
        return api.trace.getActiveSpan();
      }
    };
    context = {
      active() {
        const api = getOtelApi();
        if (!api) return {};
        return api.context.active();
      },
      with(context2, fn, thisArg, ...args) {
        const api = getOtelApi();
        if (!api) return fn.call(thisArg, ...args);
        return api.context.with(context2, fn, thisArg, ...args);
      }
    };
    metrics = {
      getMeter(name, version) {
        const api = getOtelApi();
        if (!api?.metrics) return createNoOpMeter();
        return api.metrics.getMeter(name, version);
      }
    };
    SpanStatusCode = {
      get UNSET() {
        const api = getOtelApi();
        return api?.SpanStatusCode?.UNSET ?? 0;
      },
      get OK() {
        const api = getOtelApi();
        return api?.SpanStatusCode?.OK ?? 1;
      },
      get ERROR() {
        const api = getOtelApi();
        return api?.SpanStatusCode?.ERROR ?? 2;
      }
    };
  }
});

// src/telemetry/fallback-ndjson.ts
var fallback_ndjson_exports = {};
__export(fallback_ndjson_exports, {
  emitNdjsonFallback: () => emitNdjsonFallback,
  emitNdjsonSpanWithEvents: () => emitNdjsonSpanWithEvents,
  flushNdjson: () => flushNdjson
});
import * as fs from "fs";
import * as path from "path";
function resolveTargetPath(outDir) {
  if (process.env.VISOR_FALLBACK_TRACE_FILE) {
    CURRENT_FILE = process.env.VISOR_FALLBACK_TRACE_FILE;
    return CURRENT_FILE;
  }
  if (CURRENT_FILE) return CURRENT_FILE;
  const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  CURRENT_FILE = path.join(outDir, `${ts}.ndjson`);
  return CURRENT_FILE;
}
function isEnabled() {
  if (process.env.VISOR_FALLBACK_TRACE_FILE) return true;
  return process.env.VISOR_TELEMETRY_ENABLED === "true" && (process.env.VISOR_TELEMETRY_SINK || "file") === "file";
}
function appendAsync(outDir, line) {
  writeChain = writeChain.then(async () => {
    if (!dirReady) {
      try {
        await fs.promises.mkdir(outDir, { recursive: true });
      } catch {
      }
      dirReady = true;
    }
    const target = resolveTargetPath(outDir);
    await fs.promises.appendFile(target, line, "utf8");
  }).catch(() => {
  });
}
async function flushNdjson() {
  try {
    await writeChain;
  } catch {
  }
}
function emitNdjsonFallback(name, attrs) {
  try {
    if (!isEnabled()) return;
    const outDir = process.env.VISOR_TRACE_DIR || path.join(process.cwd(), "output", "traces");
    const line = JSON.stringify({ name, attributes: attrs }) + "\n";
    appendAsync(outDir, line);
  } catch {
  }
}
function emitNdjsonSpanWithEvents(name, attrs, events) {
  try {
    if (!isEnabled()) return;
    const outDir = process.env.VISOR_TRACE_DIR || path.join(process.cwd(), "output", "traces");
    const line = JSON.stringify({ name, attributes: attrs, events }) + "\n";
    appendAsync(outDir, line);
  } catch {
  }
}
var CURRENT_FILE, dirReady, writeChain;
var init_fallback_ndjson = __esm({
  "src/telemetry/fallback-ndjson.ts"() {
    "use strict";
    CURRENT_FILE = null;
    dirReady = false;
    writeChain = Promise.resolve();
  }
});

// src/telemetry/trace-helpers.ts
function getTracer() {
  return trace.getTracer("visor");
}
async function withActiveSpan(name, attrs, fn) {
  const tracer = getTracer();
  return await new Promise((resolve, reject) => {
    const callback = async (span) => {
      try {
        const res = await fn(span);
        resolve(res);
      } catch (err) {
        try {
          if (err instanceof Error) span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR });
        } catch {
        }
        reject(err);
      } finally {
        try {
          span.end();
        } catch {
        }
      }
    };
    const options = attrs ? { attributes: attrs } : {};
    tracer.startActiveSpan(name, options, callback);
  });
}
function addEvent(name, attrs) {
  const span = trace.getSpan(context.active());
  if (span) {
    try {
      span.addEvent(name, attrs);
    } catch {
    }
  }
  try {
    const { emitNdjsonSpanWithEvents: emitNdjsonSpanWithEvents2 } = (init_fallback_ndjson(), __toCommonJS(fallback_ndjson_exports));
    emitNdjsonSpanWithEvents2("visor.event", {}, [{ name, attrs }]);
    if (name === "fail_if.triggered") {
      emitNdjsonSpanWithEvents2("visor.event", {}, [
        { name: "fail_if.evaluated", attrs },
        { name: "fail_if.triggered", attrs }
      ]);
    }
  } catch {
  }
}
var init_trace_helpers = __esm({
  "src/telemetry/trace-helpers.ts"() {
    "use strict";
    init_lazy_otel();
  }
});

// src/telemetry/metrics.ts
function ensureInstruments() {
  if (initialized) return;
  try {
    checkDurationHist = meter.createHistogram("visor.check.duration_ms", {
      description: "Duration of a check execution in milliseconds",
      unit: "ms"
    });
    providerDurationHist = meter.createHistogram("visor.provider.duration_ms", {
      description: "Duration of provider execution in milliseconds",
      unit: "ms"
    });
    foreachDurationHist = meter.createHistogram("visor.foreach.item.duration_ms", {
      description: "Duration of a forEach item execution in milliseconds",
      unit: "ms"
    });
    issuesCounter = meter.createCounter("visor.check.issues", {
      description: "Number of issues produced by checks",
      unit: "1"
    });
    activeChecks = meter.createUpDownCounter("visor.run.active_checks", {
      description: "Number of checks actively running",
      unit: "1"
    });
    failIfCounter = meter.createCounter("visor.fail_if.triggered", {
      description: "Number of times fail_if condition triggered",
      unit: "1"
    });
    diagramBlocks = meter.createCounter("visor.diagram.blocks", {
      description: "Number of Mermaid diagram blocks emitted",
      unit: "1"
    });
    initialized = true;
  } catch {
  }
}
function addFailIfTriggered(check, scope) {
  ensureInstruments();
  try {
    failIfCounter?.add(1, { "visor.check.id": check, scope });
  } catch {
  }
  if (TEST_ENABLED) TEST_SNAPSHOT.fail_if_triggered++;
}
function addDiagramBlock(origin) {
  ensureInstruments();
  try {
    diagramBlocks?.add(1, { origin });
  } catch {
  }
}
var initialized, meter, TEST_ENABLED, TEST_SNAPSHOT, checkDurationHist, providerDurationHist, foreachDurationHist, issuesCounter, activeChecks, failIfCounter, diagramBlocks;
var init_metrics = __esm({
  "src/telemetry/metrics.ts"() {
    "use strict";
    init_lazy_otel();
    initialized = false;
    meter = metrics.getMeter("visor");
    TEST_ENABLED = process.env.VISOR_TEST_METRICS === "true";
    TEST_SNAPSHOT = { fail_if_triggered: 0 };
  }
});

// src/utils/sandbox.ts
import Sandbox from "@nyariv/sandboxjs";
function createSecureSandbox() {
  const globals = {
    ...Sandbox.SAFE_GLOBALS,
    Math,
    JSON,
    // Provide console with limited surface. Use trampolines so that any test
    // spies (e.g., jest.spyOn(console, 'log')) see calls made inside the sandbox.
    console: {
      log: (...args) => {
        try {
          console.log(...args);
        } catch {
        }
      },
      warn: (...args) => {
        try {
          console.warn(...args);
        } catch {
        }
      },
      error: (...args) => {
        try {
          console.error(...args);
        } catch {
        }
      }
    }
  };
  const prototypeWhitelist = new Map(Sandbox.SAFE_PROTOTYPES);
  const arrayMethods = /* @__PURE__ */ new Set([
    // Query/iteration
    "some",
    "every",
    "filter",
    "map",
    "reduce",
    "reduceRight",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "includes",
    "indexOf",
    "lastIndexOf",
    "keys",
    "values",
    "entries",
    "forEach",
    // Non‑mutating ES2023 additions
    "toReversed",
    "toSorted",
    "toSpliced",
    "with",
    "at",
    // Mutators and common ops
    "slice",
    "concat",
    "join",
    "push",
    "pop",
    "shift",
    "unshift",
    "sort",
    "reverse",
    "copyWithin",
    "fill",
    // Flattening
    "flat",
    "flatMap",
    // Meta
    "length"
  ]);
  prototypeWhitelist.set(Array.prototype, arrayMethods);
  const stringMethods = /* @__PURE__ */ new Set([
    "toLowerCase",
    "toUpperCase",
    "includes",
    "indexOf",
    "lastIndexOf",
    "startsWith",
    "endsWith",
    "slice",
    "substring",
    "substr",
    "trim",
    "trimStart",
    "trimEnd",
    "split",
    "replace",
    "replaceAll",
    "match",
    "matchAll",
    "charAt",
    "charCodeAt",
    "codePointAt",
    "normalize",
    "repeat",
    "padStart",
    "padEnd",
    "at",
    "length"
  ]);
  prototypeWhitelist.set(String.prototype, stringMethods);
  const objectMethods = /* @__PURE__ */ new Set([
    "hasOwnProperty",
    "propertyIsEnumerable",
    "toString",
    "valueOf"
  ]);
  prototypeWhitelist.set(Object.prototype, objectMethods);
  const mapMethods = /* @__PURE__ */ new Set([
    "get",
    "set",
    "has",
    "delete",
    "entries",
    "keys",
    "values",
    "forEach"
  ]);
  prototypeWhitelist.set(Map.prototype, mapMethods);
  const setMethods = /* @__PURE__ */ new Set([
    "add",
    "has",
    "delete",
    "entries",
    "keys",
    "values",
    "forEach"
  ]);
  prototypeWhitelist.set(Set.prototype, setMethods);
  const dateMethods = /* @__PURE__ */ new Set(["toISOString", "toJSON", "getTime"]);
  prototypeWhitelist.set(Date.prototype, dateMethods);
  const regexpMethods = /* @__PURE__ */ new Set(["test", "exec"]);
  prototypeWhitelist.set(RegExp.prototype, regexpMethods);
  return new Sandbox({ globals, prototypeWhitelist });
}
function compileAndRun(sandbox, userCode, scope, opts = { injectLog: true, wrapFunction: true, logPrefix: "[sandbox]" }) {
  const inject = opts?.injectLog === true;
  let safePrefix = String(opts?.logPrefix ?? "[sandbox]");
  safePrefix = safePrefix.replace(/[\r\n\t\0]/g, "").replace(/[`$\\]/g, "").replace(/\$\{/g, "").slice(0, 64);
  const header = inject ? `const __lp = ${JSON.stringify(safePrefix)}; const log = (...a) => { try { console.log(__lp, ...a); } catch {} };
` : "";
  const src = String(userCode);
  const looksLikeBlock = /\breturn\b/.test(src) || /;/.test(src) || /\n/.test(src);
  const looksLikeIife = /\)\s*\(\s*\)\s*;?$/.test(src.trim());
  const body = opts.wrapFunction ? looksLikeBlock ? looksLikeIife ? `return (
${src}
);
` : `return (() => {
${src}
})();
` : `return (
${src}
);
` : `${src}`;
  const code = `${header}${body}`;
  let exec;
  try {
    exec = sandbox.compile(code);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`sandbox_compile_error: ${msg}`);
  }
  let out;
  try {
    out = exec(scope);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`sandbox_execution_error: ${msg}`);
  }
  if (out && typeof out.run === "function") {
    try {
      return out.run();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`sandbox_runner_error: ${msg}`);
    }
  }
  return out;
}
var init_sandbox = __esm({
  "src/utils/sandbox.ts"() {
    "use strict";
  }
});

// src/utils/author-permissions.ts
function getPermissionLevel(association) {
  if (!association) return PERMISSION_HIERARCHY.length;
  const index = PERMISSION_HIERARCHY.indexOf(association.toUpperCase());
  return index === -1 ? PERMISSION_HIERARCHY.length : index;
}
function hasMinPermission(authorAssociation, minPermission, isLocalMode = false) {
  if (isLocalMode) {
    return true;
  }
  const authorLevel = getPermissionLevel(authorAssociation);
  const minLevel = getPermissionLevel(minPermission);
  return authorLevel <= minLevel;
}
function isOwner(authorAssociation, isLocalMode = false) {
  if (isLocalMode) return true;
  return authorAssociation?.toUpperCase() === "OWNER";
}
function isMember(authorAssociation, isLocalMode = false) {
  if (isLocalMode) return true;
  return hasMinPermission(authorAssociation, "MEMBER", isLocalMode);
}
function isCollaborator(authorAssociation, isLocalMode = false) {
  if (isLocalMode) return true;
  return hasMinPermission(authorAssociation, "COLLABORATOR", isLocalMode);
}
function isContributor(authorAssociation, isLocalMode = false) {
  if (isLocalMode) return true;
  return hasMinPermission(authorAssociation, "CONTRIBUTOR", isLocalMode);
}
function isFirstTimer(authorAssociation, isLocalMode = false) {
  if (isLocalMode) return false;
  const assoc = authorAssociation?.toUpperCase();
  return assoc === "FIRST_TIME_CONTRIBUTOR" || assoc === "FIRST_TIMER";
}
function createPermissionHelpers(authorAssociation, isLocalMode = false) {
  return {
    hasMinPermission: (minPermission) => hasMinPermission(authorAssociation, minPermission, isLocalMode),
    isOwner: () => isOwner(authorAssociation, isLocalMode),
    isMember: () => isMember(authorAssociation, isLocalMode),
    isCollaborator: () => isCollaborator(authorAssociation, isLocalMode),
    isContributor: () => isContributor(authorAssociation, isLocalMode),
    isFirstTimer: () => isFirstTimer(authorAssociation, isLocalMode)
  };
}
function detectLocalMode() {
  return !process.env.GITHUB_ACTIONS;
}
function resolveAssociationFromEvent(eventContext, fallback) {
  try {
    const ec = eventContext || {};
    return ec?.comment?.author_association || ec?.issue?.author_association || ec?.pull_request?.author_association || fallback;
  } catch {
    return fallback;
  }
}
var PERMISSION_HIERARCHY;
var init_author_permissions = __esm({
  "src/utils/author-permissions.ts"() {
    "use strict";
    PERMISSION_HIERARCHY = [
      "OWNER",
      "MEMBER",
      "COLLABORATOR",
      "CONTRIBUTOR",
      "FIRST_TIME_CONTRIBUTOR",
      "FIRST_TIMER",
      "NONE"
    ];
  }
});

// src/failure-condition-evaluator.ts
var FailureConditionEvaluator;
var init_failure_condition_evaluator = __esm({
  "src/failure-condition-evaluator.ts"() {
    "use strict";
    init_trace_helpers();
    init_metrics();
    init_sandbox();
    init_author_permissions();
    init_memory_store();
    FailureConditionEvaluator = class _FailureConditionEvaluator {
      sandbox;
      constructor() {
      }
      /**
       * Create a secure sandbox with whitelisted functions and globals
       */
      createSecureSandbox() {
        return createSecureSandbox();
      }
      /**
       * Evaluate simple fail_if condition
       */
      async evaluateSimpleCondition(checkName, checkSchema, checkGroup, reviewSummary, expression, previousOutputs, authorAssociation) {
        const context2 = this.buildEvaluationContext(
          checkName,
          checkSchema,
          checkGroup,
          reviewSummary,
          previousOutputs,
          authorAssociation
        );
        try {
          try {
            const isObj = context2.output && typeof context2.output === "object";
            const keys = isObj ? Object.keys(context2.output).join(",") : typeof context2.output;
            let errorVal = void 0;
            if (isObj && context2.output.error !== void 0)
              errorVal = context2.output.error;
            (init_logger(), __toCommonJS(logger_exports)).logger.debug(
              `  fail_if: evaluating '${expression}' with output keys=${keys} error=${String(errorVal)}`
            );
          } catch {
          }
          const res = this.evaluateExpression(expression, context2);
          if (res === true) {
            try {
              addEvent("fail_if.triggered", {
                check: checkName,
                scope: "check",
                name: `${checkName}_fail_if`,
                expression,
                severity: "error"
              });
            } catch {
            }
            try {
              const { emitNdjsonSpanWithEvents: emitNdjsonSpanWithEvents2 } = (init_fallback_ndjson(), __toCommonJS(fallback_ndjson_exports));
              emitNdjsonSpanWithEvents2(
                "visor.fail_if",
                { check: checkName, scope: "check", name: `${checkName}_fail_if` },
                [
                  {
                    name: "fail_if.triggered",
                    attrs: {
                      check: checkName,
                      scope: "check",
                      name: `${checkName}_fail_if`,
                      expression,
                      severity: "error"
                    }
                  }
                ]
              );
            } catch {
            }
          }
          return res;
        } catch (error) {
          console.warn(`Failed to evaluate fail_if expression: ${error}`);
          return false;
        }
      }
      /**
       * Determine if the event is related to pull requests
       */
      determineIfPullRequest(eventType) {
        if (!eventType) return false;
        const prEvents = ["pr_opened", "pr_updated", "pr_closed", "pull_request"];
        return prEvents.includes(eventType) || eventType.startsWith("pr_");
      }
      /**
       * Determine if the event is related to issues
       */
      determineIfIssue(eventType) {
        if (!eventType) return false;
        const issueEvents = ["issue_opened", "issue_comment", "issues"];
        return issueEvents.includes(eventType) || eventType.startsWith("issue_");
      }
      /**
       * Evaluate if condition to determine whether a check should run
       */
      async evaluateIfCondition(checkName, expression, contextData) {
        const context2 = {
          // Check metadata
          checkName,
          // Git context
          branch: contextData?.branch || "unknown",
          baseBranch: contextData?.baseBranch || "main",
          filesChanged: contextData?.filesChanged || [],
          filesCount: contextData?.filesChanged?.length || 0,
          // GitHub event context
          event: {
            event_name: contextData?.event || "manual",
            action: void 0,
            // Would be populated from actual GitHub context
            repository: void 0
            // Would be populated from actual GitHub context
          },
          // Environment variables
          env: contextData?.environment || {},
          // Previous check results (unwrap output field like templates do)
          outputs: contextData?.previousResults ? (() => {
            const outputs = {};
            for (const [checkName2, result] of contextData.previousResults) {
              const summary = result;
              outputs[checkName2] = summary.output !== void 0 ? summary.output : summary;
            }
            return outputs;
          })() : {},
          // Workflow inputs (for workflows)
          inputs: contextData?.workflowInputs || {},
          // Required output property (empty for if conditions)
          output: {
            issues: []
          },
          // Author association (used by permission helpers)
          authorAssociation: contextData?.authorAssociation,
          // Utility metadata
          metadata: {
            checkName,
            schema: "",
            group: "",
            criticalIssues: 0,
            errorIssues: 0,
            warningIssues: 0,
            infoIssues: 0,
            totalIssues: 0,
            hasChanges: (contextData?.filesChanged?.length || 0) > 0,
            branch: contextData?.branch || "unknown",
            event: contextData?.event || "manual"
          }
        };
        try {
          const res = this.evaluateExpression(expression, context2);
          try {
            if (process.env.VISOR_DEBUG === "true") {
              const envMap = context2.env || {};
              console.error(
                `[if-eval] check=${checkName} expr="${expression}" env.ENABLE_FACT_VALIDATION=${String(
                  envMap.ENABLE_FACT_VALIDATION
                )} event=${context2.event?.event_name} result=${String(res)}`
              );
            }
          } catch {
          }
          return res;
        } catch (error) {
          console.warn(`Failed to evaluate if expression for check '${checkName}': ${error}`);
          return false;
        }
      }
      /**
       * Evaluate all failure conditions for a check result
       */
      async evaluateConditions(checkName, checkSchema, checkGroup, reviewSummary, globalConditions, checkConditions, previousOutputs, authorAssociation) {
        const context2 = this.buildEvaluationContext(
          checkName,
          checkSchema,
          checkGroup,
          reviewSummary,
          previousOutputs,
          authorAssociation
        );
        const results = [];
        if (globalConditions) {
          const globalResults = await this.evaluateConditionSet(globalConditions, context2, "global");
          results.push(...globalResults);
        }
        if (checkConditions) {
          const checkResults = await this.evaluateConditionSet(checkConditions, context2, "check");
          const overriddenConditions = new Set(Object.keys(checkConditions));
          const filteredResults = results.filter(
            (result) => !overriddenConditions.has(result.conditionName)
          );
          results.length = 0;
          results.push(...filteredResults, ...checkResults);
        }
        try {
          if (checkName === "B") {
            console.error(
              `\u{1F527} Debug: fail_if results for ${checkName}: ${JSON.stringify(results)} context.output=${JSON.stringify(
                context2.output
              )}`
            );
          }
        } catch {
        }
        return results;
      }
      /**
       * Evaluate a set of failure conditions
       */
      async evaluateConditionSet(conditions, context2, source) {
        const results = [];
        for (const [conditionName, condition] of Object.entries(conditions)) {
          try {
            addEvent("fail_if.evaluated", {
              check: context2.checkName,
              scope: source,
              name: conditionName,
              expression: this.extractExpression(condition)
            });
          } catch {
          }
          try {
            const { emitNdjsonSpanWithEvents: emitNdjsonSpanWithEvents2 } = (init_fallback_ndjson(), __toCommonJS(fallback_ndjson_exports));
            emitNdjsonSpanWithEvents2(
              "visor.fail_if",
              { check: context2.checkName || "unknown", scope: source, name: conditionName },
              [
                {
                  name: "fail_if.evaluated",
                  attrs: {
                    check: context2.checkName,
                    scope: source,
                    name: conditionName,
                    expression: this.extractExpression(condition)
                  }
                }
              ]
            );
          } catch {
          }
          try {
            const result = await this.evaluateSingleCondition(conditionName, condition, context2);
            results.push(result);
            if (result.failed) {
              try {
                addEvent("fail_if.triggered", {
                  check: context2.checkName,
                  scope: source,
                  name: conditionName,
                  expression: result.expression,
                  severity: result.severity,
                  halt_execution: result.haltExecution
                });
              } catch {
              }
              try {
                addFailIfTriggered(context2.checkName || "unknown", source);
              } catch {
              }
            }
          } catch (error) {
            results.push({
              conditionName,
              failed: false,
              expression: this.extractExpression(condition),
              severity: "error",
              haltExecution: false,
              error: `Failed to evaluate ${source} condition '${conditionName}': ${error instanceof Error ? error.message : String(error)}`
            });
          }
        }
        return results;
      }
      /**
       * Evaluate a single failure condition
       */
      async evaluateSingleCondition(conditionName, condition, context2) {
        const expression = this.extractExpression(condition);
        const config = this.extractConditionConfig(condition);
        try {
          const failed = this.evaluateExpression(expression, context2);
          return {
            conditionName,
            failed,
            expression,
            message: config.message,
            severity: config.severity || "error",
            haltExecution: config.halt_execution || false
          };
        } catch (error) {
          throw new Error(
            `Expression evaluation error: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      /**
       * Secure expression evaluation using SandboxJS
       * Supports the same GitHub Actions-style functions as the previous implementation
       */
      evaluateExpression(condition, context2) {
        try {
          const normalize = (expr) => {
            const trimmed = expr.trim();
            if (!/[\n;]/.test(trimmed)) return trimmed;
            const parts = trimmed.split(/[\n;]+/).map((s) => s.trim()).filter((s) => s.length > 0 && !s.startsWith("//"));
            if (parts.length === 0) return "true";
            const lastRaw = parts.pop();
            const last = lastRaw.replace(/^return\s+/i, "").trim();
            if (parts.length === 0) return last;
            return `(${parts.join(", ")}, ${last})`;
          };
          const contains = (searchString, searchValue) => String(searchString).toLowerCase().includes(String(searchValue).toLowerCase());
          const startsWith = (searchString, searchValue) => String(searchString).toLowerCase().startsWith(String(searchValue).toLowerCase());
          const endsWith = (searchString, searchValue) => String(searchString).toLowerCase().endsWith(String(searchValue).toLowerCase());
          const length = (value) => {
            if (typeof value === "string" || Array.isArray(value)) {
              return value.length;
            }
            if (value && typeof value === "object") {
              return Object.keys(value).length;
            }
            return 0;
          };
          const always = () => true;
          const success = () => true;
          const failure = () => false;
          const log = (...args) => {
            console.log("\u{1F50D} Debug:", ...args);
          };
          const hasIssue = (issues2, field, value) => {
            if (!Array.isArray(issues2)) return false;
            return issues2.some((issue) => issue[field] === value);
          };
          const countIssues = (issues2, field, value) => {
            if (!Array.isArray(issues2)) return 0;
            return issues2.filter((issue) => issue[field] === value).length;
          };
          const hasFileMatching = (issues2, pattern) => {
            if (!Array.isArray(issues2)) return false;
            return issues2.some((issue) => issue.file?.includes(pattern));
          };
          const hasIssueWith = hasIssue;
          const hasFileWith = hasFileMatching;
          const permissionHelpers = createPermissionHelpers(
            context2.authorAssociation,
            detectLocalMode()
          );
          const hasMinPermission2 = permissionHelpers.hasMinPermission;
          const isOwner2 = permissionHelpers.isOwner;
          const isMember2 = permissionHelpers.isMember;
          const isCollaborator2 = permissionHelpers.isCollaborator;
          const isContributor2 = permissionHelpers.isContributor;
          const isFirstTimer2 = permissionHelpers.isFirstTimer;
          const output = context2.output || {};
          const issues = output.issues || [];
          const metadata = context2.metadata || {
            checkName: context2.checkName || "",
            schema: context2.schema || "",
            group: context2.group || "",
            criticalIssues: issues.filter((i) => i.severity === "critical").length,
            errorIssues: issues.filter((i) => i.severity === "error").length,
            warningIssues: issues.filter((i) => i.severity === "warning").length,
            infoIssues: issues.filter((i) => i.severity === "info").length,
            totalIssues: issues.length,
            hasChanges: context2.hasChanges || false
          };
          const criticalIssues = metadata.criticalIssues;
          const errorIssues = metadata.errorIssues;
          const totalIssues = metadata.totalIssues;
          const warningIssues = metadata.warningIssues;
          const infoIssues = metadata.infoIssues;
          const checkName = context2.checkName || "";
          const schema = context2.schema || "";
          const group = context2.group || "";
          const branch = context2.branch || "unknown";
          const baseBranch = context2.baseBranch || "main";
          const filesChanged = context2.filesChanged || [];
          const filesCount = context2.filesCount || 0;
          const event = context2.event || "manual";
          const env = context2.env || {};
          const outputs = context2.outputs || {};
          const debugData = context2.debug || null;
          const memoryStore = MemoryStore.getInstance();
          const memoryAccessor = {
            get: (key, ns) => memoryStore.get(key, ns),
            has: (key, ns) => memoryStore.has(key, ns),
            list: (ns) => memoryStore.list(ns),
            getAll: (ns) => memoryStore.getAll(ns)
          };
          const scope = {
            // Primary context variables
            output,
            outputs,
            debug: debugData,
            // Memory accessor for fail_if expressions
            memory: memoryAccessor,
            // Legacy compatibility variables
            issues,
            metadata,
            criticalIssues,
            errorIssues,
            totalIssues,
            warningIssues,
            infoIssues,
            // If condition context
            checkName,
            schema,
            group,
            branch,
            baseBranch,
            filesChanged,
            filesCount,
            event,
            env,
            // Helper functions
            contains,
            startsWith,
            endsWith,
            length,
            always,
            success,
            failure,
            log,
            hasIssue,
            countIssues,
            hasFileMatching,
            hasIssueWith,
            hasFileWith,
            // Permission helpers
            hasMinPermission: hasMinPermission2,
            isOwner: isOwner2,
            isMember: isMember2,
            isCollaborator: isCollaborator2,
            isContributor: isContributor2,
            isFirstTimer: isFirstTimer2
          };
          const raw = condition.trim();
          if (!this.sandbox) {
            this.sandbox = this.createSecureSandbox();
          }
          let exec;
          try {
            exec = this.sandbox.compile(`return (${raw});`);
          } catch {
            const normalizedExpr = normalize(condition);
            exec = this.sandbox.compile(`return (${normalizedExpr});`);
          }
          const result = exec(scope).run();
          try {
            (init_logger(), __toCommonJS(logger_exports)).logger.debug(`  fail_if: result=${Boolean(result)}`);
          } catch {
          }
          return Boolean(result);
        } catch (error) {
          console.error("\u274C Failed to evaluate expression:", condition, error);
          throw error;
        }
      }
      /**
       * Extract the expression from a failure condition
       */
      extractExpression(condition) {
        if (typeof condition === "string") {
          return condition;
        }
        return condition.condition;
      }
      /**
       * Extract configuration from a failure condition
       */
      extractConditionConfig(condition) {
        if (typeof condition === "string") {
          return {};
        }
        return {
          message: condition.message,
          severity: condition.severity,
          halt_execution: condition.halt_execution
        };
      }
      /**
       * Build the evaluation context for expressions
       */
      buildEvaluationContext(checkName, checkSchema, checkGroup, reviewSummary, previousOutputs, authorAssociation) {
        const { issues, debug } = reviewSummary;
        const reviewSummaryWithOutput = reviewSummary;
        const {
          output: extractedOutput,
          // Exclude issues from otherFields since we handle it separately
          issues: _issues,
          // eslint-disable-line @typescript-eslint/no-unused-vars
          ...otherFields
        } = reviewSummaryWithOutput;
        const aggregatedOutput = {
          issues: (issues || []).map((issue) => ({
            file: issue.file,
            line: issue.line,
            endLine: issue.endLine,
            ruleId: issue.ruleId,
            message: issue.message,
            severity: issue.severity,
            category: issue.category,
            group: issue.group,
            schema: issue.schema,
            suggestion: issue.suggestion,
            replacement: issue.replacement
          })),
          // Include additional schema-specific data from reviewSummary
          ...otherFields
        };
        if (Array.isArray(extractedOutput)) {
          aggregatedOutput.items = extractedOutput;
          const anyError = extractedOutput.find(
            (it) => it && typeof it === "object" && it.error
          );
          if (anyError && anyError.error !== void 0) {
            aggregatedOutput.error = anyError.error;
          }
        } else if (extractedOutput && typeof extractedOutput === "object") {
          Object.assign(aggregatedOutput, extractedOutput);
        }
        try {
          const raw = reviewSummaryWithOutput.__raw;
          if (raw && typeof raw === "object") {
            Object.assign(aggregatedOutput, raw);
          }
        } catch {
        }
        try {
          if (typeof extractedOutput === "string") {
            const parsed = this.tryExtractJsonFromEnd(extractedOutput) ?? (() => {
              try {
                return JSON.parse(extractedOutput);
              } catch {
                return null;
              }
            })();
            if (parsed !== null) {
              if (Array.isArray(parsed)) {
                aggregatedOutput.items = parsed;
              } else if (typeof parsed === "object") {
                Object.assign(aggregatedOutput, parsed);
              }
            }
            const lower = extractedOutput.toLowerCase();
            const boolFrom = (key) => {
              const reTrue = new RegExp(
                `(?:^|[^a-z0-9_])${key}[^a-z0-9_]*[:=][^a-z0-9_]*true(?:[^a-z0-9_]|$)`
              );
              const reFalse = new RegExp(
                `(?:^|[^a-z0-9_])${key}[^a-z0-9_]*[:=][^a-z0-9_]*false(?:[^a-z0-9_]|$)`
              );
              if (reTrue.test(lower)) return true;
              if (reFalse.test(lower)) return false;
              return null;
            };
            const keys = ["error"];
            for (const k of keys) {
              const v = boolFrom(k);
              if (v !== null && aggregatedOutput[k] === void 0) {
                aggregatedOutput[k] = v;
              }
            }
          }
        } catch {
        }
        try {
          const rsAny = reviewSummaryWithOutput;
          const hasStructuredOutput = extractedOutput !== void 0 && extractedOutput !== null;
          if (!hasStructuredOutput && typeof rsAny?.content === "string") {
            const parsedFromContent = this.tryExtractJsonFromEnd(rsAny.content);
            if (parsedFromContent !== null && parsedFromContent !== void 0) {
              if (Array.isArray(parsedFromContent)) {
                aggregatedOutput.items = parsedFromContent;
              } else if (typeof parsedFromContent === "object") {
                Object.assign(aggregatedOutput, parsedFromContent);
              }
            }
          }
        } catch {
        }
        const memoryStore = MemoryStore.getInstance();
        const context2 = {
          output: aggregatedOutput,
          outputs: (() => {
            if (!previousOutputs) return {};
            const outputs = {};
            for (const [checkName2, result] of Object.entries(previousOutputs)) {
              const summary = result;
              outputs[checkName2] = summary.output !== void 0 ? summary.output : summary;
            }
            return outputs;
          })(),
          // Add memory accessor for fail_if expressions
          memory: {
            get: (key, ns) => memoryStore.get(key, ns),
            has: (key, ns) => memoryStore.has(key, ns),
            list: (ns) => memoryStore.list(ns),
            getAll: (ns) => memoryStore.getAll(ns)
          },
          // Add basic context info for failure conditions
          checkName,
          schema: checkSchema,
          group: checkGroup,
          authorAssociation
        };
        if (debug) {
          context2.debug = {
            errors: debug.errors || [],
            processingTime: debug.processingTime || 0,
            provider: debug.provider || "unknown",
            model: debug.model || "unknown"
          };
        }
        return context2;
      }
      // Minimal JSON-from-end extractor for fail_if context fallback
      tryExtractJsonFromEnd(text) {
        try {
          const lines = text.split("\n");
          for (let i = lines.length - 1; i >= 0; i--) {
            const t = lines[i].trim();
            if (t.startsWith("{") || t.startsWith("[")) {
              const candidate = lines.slice(i).join("\n").trim();
              if (candidate.startsWith("{") && candidate.endsWith("}") || candidate.startsWith("[") && candidate.endsWith("]")) {
                return JSON.parse(candidate);
              }
            }
          }
        } catch {
        }
        return null;
      }
      /**
       * Check if any failure condition requires halting execution
       */
      static shouldHaltExecution(results) {
        return results.some((result) => result.failed && result.haltExecution);
      }
      /**
       * Get all failed conditions
       */
      static getFailedConditions(results) {
        return results.filter((result) => result.failed);
      }
      /**
       * Group results by severity
       */
      static groupResultsBySeverity(results) {
        return {
          // Only 'error' severity now (no backward compatibility needed here as this is internal)
          error: results.filter((r) => r.severity === "error"),
          warning: results.filter((r) => r.severity === "warning"),
          info: results.filter((r) => r.severity === "info")
        };
      }
      /**
       * Format results for display
       */
      static formatResults(results) {
        const failed = _FailureConditionEvaluator.getFailedConditions(results);
        if (failed.length === 0) {
          return "\u2705 All failure conditions passed";
        }
        const grouped = _FailureConditionEvaluator.groupResultsBySeverity(failed);
        const sections = [];
        if (grouped.error.length > 0) {
          sections.push(`\u274C **Error severity conditions (${grouped.error.length}):**`);
          grouped.error.forEach((result) => {
            sections.push(`  - ${result.conditionName}: ${result.message || result.expression}`);
          });
        }
        if (grouped.warning.length > 0) {
          sections.push(`\u26A0\uFE0F **Warning conditions (${grouped.warning.length}):**`);
          grouped.warning.forEach((result) => {
            sections.push(`  - ${result.conditionName}: ${result.message || result.expression}`);
          });
        }
        if (grouped.info.length > 0) {
          sections.push(`\u2139\uFE0F **Info conditions (${grouped.info.length}):**`);
          grouped.info.forEach((result) => {
            sections.push(`  - ${result.conditionName}: ${result.message || result.expression}`);
          });
        }
        return sections.join("\n");
      }
    };
  }
});

// src/snapshot-store.ts
var snapshot_store_exports = {};
__export(snapshot_store_exports, {
  ContextView: () => ContextView,
  ExecutionJournal: () => ExecutionJournal
});
var ExecutionJournal, ContextView;
var init_snapshot_store = __esm({
  "src/snapshot-store.ts"() {
    "use strict";
    ExecutionJournal = class {
      commit = 0;
      entries = [];
      beginSnapshot() {
        return this.commit;
      }
      commitEntry(entry) {
        const committed = {
          sessionId: entry.sessionId,
          scope: entry.scope,
          checkId: entry.checkId,
          result: entry.result,
          event: entry.event,
          commitId: ++this.commit
        };
        this.entries.push(committed);
        return committed;
      }
      readVisible(sessionId, commitMax, event) {
        return this.entries.filter(
          (e) => e.sessionId === sessionId && e.commitId <= commitMax && (event ? e.event === event : true)
        );
      }
      // Lightweight helpers for debugging/metrics
      size() {
        return this.entries.length;
      }
    };
    ContextView = class {
      constructor(journal, sessionId, snapshotId, scope, event) {
        this.journal = journal;
        this.sessionId = sessionId;
        this.snapshotId = snapshotId;
        this.scope = scope;
        this.event = event;
      }
      /** Return the nearest result for a check in this scope (exact item → ancestor → latest). */
      get(checkId) {
        const visible = this.journal.readVisible(this.sessionId, this.snapshotId, this.event).filter((e) => e.checkId === checkId);
        if (visible.length === 0) return void 0;
        const exact = visible.find((e) => this.sameScope(e.scope, this.scope));
        if (exact) return exact.result;
        let best;
        for (const e of visible) {
          const dist = this.ancestorDistance(e.scope, this.scope);
          if (dist >= 0 && (best === void 0 || dist < best.dist)) {
            best = { entry: e, dist };
          }
        }
        if (best) return best.entry.result;
        return visible[visible.length - 1]?.result;
      }
      /** Return an aggregate (raw) result – the shallowest scope for this check. */
      getRaw(checkId) {
        const visible = this.journal.readVisible(this.sessionId, this.snapshotId, this.event).filter((e) => e.checkId === checkId);
        if (visible.length === 0) return void 0;
        let shallow = visible[0];
        for (const e of visible) {
          if (e.scope.length < shallow.scope.length) shallow = e;
        }
        return shallow.result;
      }
      /** All results for a check up to this snapshot. */
      getHistory(checkId) {
        return this.journal.readVisible(this.sessionId, this.snapshotId, this.event).filter((e) => e.checkId === checkId).map((e) => e.result);
      }
      sameScope(a, b) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
          if (a[i].check !== b[i].check || a[i].index !== b[i].index) return false;
        }
        return true;
      }
      // distance from ancestor to current; -1 if not ancestor
      ancestorDistance(ancestor, current) {
        if (ancestor.length > current.length) return -1;
        if (ancestor.length === 0 && current.length > 0) return -1;
        for (let i = 0; i < ancestor.length; i++) {
          if (ancestor[i].check !== current[i].check || ancestor[i].index !== current[i].index)
            return -1;
        }
        return current.length - ancestor.length;
      }
    };
  }
});

// src/state-machine/states/routing.ts
async function handleRouting(context2, state, transition, emitEvent, routingContext) {
  const { checkId, scope, result, checkConfig, success } = routingContext;
  if (context2.debug) {
    logger.info(`[Routing] Evaluating routing for check: ${checkId}, success: ${success}`);
  }
  const failIfTriggered = await evaluateFailIf(
    checkId,
    result,
    checkConfig,
    context2,
    state
  );
  if (failIfTriggered) {
    if (context2.debug) {
      logger.info(`[Routing] fail_if triggered for ${checkId}`);
    }
    await processOnFail(checkId, scope, result, checkConfig, context2, state, emitEvent);
  } else if (success) {
    await processOnSuccess(checkId, scope, result, checkConfig, context2, state, emitEvent);
  } else {
    await processOnFail(checkId, scope, result, checkConfig, context2, state, emitEvent);
  }
  if (checkConfig.on_finish && !checkConfig.forEach) {
    await processOnFinish(checkId, scope, result, checkConfig, context2, state, emitEvent);
  }
  transition("WavePlanning");
}
async function processOnFinish(checkId, scope, result, checkConfig, context2, state, emitEvent) {
  const onFinish = checkConfig.on_finish;
  if (!onFinish) {
    return;
  }
  logger.info(`Processing on_finish for ${checkId}`);
  if (onFinish.run && onFinish.run.length > 0) {
    for (const targetCheck of onFinish.run) {
      if (checkLoopBudget(context2, state, "on_finish", "run")) {
        const errorIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context2.config.routing?.max_loops ?? 10}) during on_finish run`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], errorIssue];
        return;
      }
      if (context2.debug) {
        logger.info(`[Routing] on_finish.run: scheduling ${targetCheck}`);
      }
      state.routingLoopCount++;
      emitEvent({
        type: "ForwardRunRequested",
        target: targetCheck,
        scope
      });
    }
  }
  if (onFinish.run_js) {
    const dynamicTargets = await evaluateRunJs(
      onFinish.run_js,
      checkId,
      checkConfig,
      result,
      context2,
      state
    );
    for (const targetCheck of dynamicTargets) {
      if (checkLoopBudget(context2, state, "on_finish", "run")) {
        const errorIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context2.config.routing?.max_loops ?? 10}) during on_finish run`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], errorIssue];
        return;
      }
      if (context2.debug) {
        logger.info(`[Routing] on_finish.run_js: scheduling ${targetCheck}`);
      }
      state.routingLoopCount++;
      emitEvent({
        type: "ForwardRunRequested",
        target: targetCheck,
        scope
      });
    }
  }
  const gotoTarget = await evaluateGoto(
    onFinish.goto_js,
    onFinish.goto,
    checkId,
    checkConfig,
    result,
    context2,
    state
  );
  if (gotoTarget) {
    if (checkLoopBudget(context2, state, "on_finish", "goto")) {
      const errorIssue = {
        file: "system",
        line: 0,
        ruleId: `${checkId}/routing/loop_budget_exceeded`,
        message: `Routing loop budget exceeded (max_loops=${context2.config.routing?.max_loops ?? 10}) during on_finish goto`,
        severity: "error",
        category: "logic"
      };
      result.issues = [...result.issues || [], errorIssue];
      return;
    }
    if (context2.debug) {
      logger.info(`[Routing] on_finish.goto: ${gotoTarget}`);
    }
    state.routingLoopCount++;
    emitEvent({
      type: "ForwardRunRequested",
      target: gotoTarget,
      scope
    });
    state.flags.forwardRunRequested = true;
  }
}
async function evaluateFailIf(checkId, result, checkConfig, context2, state) {
  const config = context2.config;
  const globalFailIf = config.fail_if;
  const checkFailIf = checkConfig.fail_if;
  if (!globalFailIf && !checkFailIf) {
    return false;
  }
  const evaluator = new FailureConditionEvaluator();
  const outputsRecord = {};
  for (const [key] of state.stats.entries()) {
    try {
      const snapshotId = context2.journal.beginSnapshot();
      const contextView = new (init_snapshot_store(), __toCommonJS(snapshot_store_exports)).ContextView(
        context2.journal,
        context2.sessionId,
        snapshotId,
        [],
        context2.event
      );
      const journalResult = contextView.get(key);
      if (journalResult) {
        outputsRecord[key] = journalResult;
      }
    } catch {
      outputsRecord[key] = { issues: [] };
    }
  }
  const checkSchema = typeof checkConfig.schema === "object" ? "custom" : checkConfig.schema || "";
  const checkGroup = checkConfig.group || "";
  if (globalFailIf) {
    try {
      const failed = await evaluator.evaluateSimpleCondition(
        checkId,
        checkSchema,
        checkGroup,
        result,
        globalFailIf,
        outputsRecord
      );
      if (failed) {
        logger.warn(`[Routing] Global fail_if triggered for ${checkId}: ${globalFailIf}`);
        const failIssue = {
          file: "system",
          line: 0,
          ruleId: "global_fail_if",
          message: `Global failure condition met: ${globalFailIf}`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], failIssue];
        return true;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Routing] Error evaluating global fail_if: ${msg}`);
    }
  }
  if (checkFailIf) {
    try {
      const failed = await evaluator.evaluateSimpleCondition(
        checkId,
        checkSchema,
        checkGroup,
        result,
        checkFailIf,
        outputsRecord
      );
      if (failed) {
        logger.warn(`[Routing] Check fail_if triggered for ${checkId}: ${checkFailIf}`);
        const failIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}_fail_if`,
          message: `Check failure condition met: ${checkFailIf}`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], failIssue];
        return true;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Routing] Error evaluating check fail_if: ${msg}`);
    }
  }
  return false;
}
function checkLoopBudget(context2, state, origin, action) {
  const maxLoops = context2.config.routing?.max_loops ?? 10;
  if (state.routingLoopCount >= maxLoops) {
    const msg = `Routing loop budget exceeded (max_loops=${maxLoops}) during ${origin} ${action}`;
    logger.error(`[Routing] ${msg}`);
    return true;
  }
  return false;
}
async function processOnSuccess(checkId, scope, result, checkConfig, context2, state, emitEvent) {
  const onSuccess = checkConfig.on_success;
  if (!onSuccess) {
    return;
  }
  if (context2.debug) {
    logger.info(`[Routing] Processing on_success for ${checkId}`);
  }
  if (onSuccess.run && onSuccess.run.length > 0) {
    for (const targetCheck of onSuccess.run) {
      if (checkLoopBudget(context2, state, "on_success", "run")) {
        const errorIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context2.config.routing?.max_loops ?? 10}) during on_success run`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], errorIssue];
        return;
      }
      if (context2.debug) {
        logger.info(`[Routing] on_success.run: scheduling ${targetCheck}`);
      }
      state.routingLoopCount++;
      emitEvent({
        type: "ForwardRunRequested",
        target: targetCheck,
        scope
      });
    }
  }
  if (onSuccess.run_js) {
    const dynamicTargets = await evaluateRunJs(
      onSuccess.run_js,
      checkId,
      checkConfig,
      result,
      context2,
      state
    );
    for (const targetCheck of dynamicTargets) {
      if (checkLoopBudget(context2, state, "on_success", "run")) {
        const errorIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context2.config.routing?.max_loops ?? 10}) during on_success run`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], errorIssue];
        return;
      }
      if (context2.debug) {
        logger.info(`[Routing] on_success.run_js: scheduling ${targetCheck}`);
      }
      state.routingLoopCount++;
      emitEvent({
        type: "ForwardRunRequested",
        target: targetCheck,
        scope
      });
    }
  }
  const gotoTarget = await evaluateGoto(
    onSuccess.goto_js,
    onSuccess.goto,
    checkId,
    checkConfig,
    result,
    context2,
    state
  );
  if (gotoTarget) {
    if (checkLoopBudget(context2, state, "on_success", "goto")) {
      const errorIssue = {
        file: "system",
        line: 0,
        ruleId: `${checkId}/routing/loop_budget_exceeded`,
        message: `Routing loop budget exceeded (max_loops=${context2.config.routing?.max_loops ?? 10}) during on_success goto`,
        severity: "error",
        category: "logic"
      };
      result.issues = [...result.issues || [], errorIssue];
      return;
    }
    if (context2.debug) {
      logger.info(`[Routing] on_success.goto: ${gotoTarget}`);
    }
    state.routingLoopCount++;
    emitEvent({
      type: "ForwardRunRequested",
      target: gotoTarget,
      gotoEvent: onSuccess.goto_event,
      scope
    });
    state.flags.forwardRunRequested = true;
  }
}
async function processOnFail(checkId, scope, result, checkConfig, context2, state, emitEvent) {
  const defaults = context2.config.routing?.defaults?.on_fail || {};
  const onFail = checkConfig.on_fail ? { ...defaults, ...checkConfig.on_fail } : void 0;
  if (!onFail) {
    return;
  }
  if (context2.debug) {
    logger.info(`[Routing] Processing on_fail for ${checkId}`);
  }
  if (onFail.run && onFail.run.length > 0) {
    for (const targetCheck of onFail.run) {
      if (checkLoopBudget(context2, state, "on_fail", "run")) {
        const errorIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context2.config.routing?.max_loops ?? 10}) during on_fail run`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], errorIssue];
        return;
      }
      if (context2.debug) {
        logger.info(`[Routing] on_fail.run: scheduling ${targetCheck}`);
      }
      state.routingLoopCount++;
      emitEvent({
        type: "ForwardRunRequested",
        target: targetCheck,
        scope
      });
    }
  }
  if (onFail.run_js) {
    const dynamicTargets = await evaluateRunJs(
      onFail.run_js,
      checkId,
      checkConfig,
      result,
      context2,
      state
    );
    for (const targetCheck of dynamicTargets) {
      if (checkLoopBudget(context2, state, "on_fail", "run")) {
        const errorIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context2.config.routing?.max_loops ?? 10}) during on_fail run`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], errorIssue];
        return;
      }
      if (context2.debug) {
        logger.info(`[Routing] on_fail.run_js: scheduling ${targetCheck}`);
      }
      state.routingLoopCount++;
      emitEvent({
        type: "ForwardRunRequested",
        target: targetCheck,
        scope
      });
    }
  }
  const gotoTarget = await evaluateGoto(
    onFail.goto_js,
    onFail.goto,
    checkId,
    checkConfig,
    result,
    context2,
    state
  );
  if (gotoTarget) {
    if (checkLoopBudget(context2, state, "on_fail", "goto")) {
      const errorIssue = {
        file: "system",
        line: 0,
        ruleId: `${checkId}/routing/loop_budget_exceeded`,
        message: `Routing loop budget exceeded (max_loops=${context2.config.routing?.max_loops ?? 10}) during on_fail goto`,
        severity: "error",
        category: "logic"
      };
      result.issues = [...result.issues || [], errorIssue];
      return;
    }
    if (context2.debug) {
      logger.info(`[Routing] on_fail.goto: ${gotoTarget}`);
    }
    state.routingLoopCount++;
    emitEvent({
      type: "ForwardRunRequested",
      target: gotoTarget,
      gotoEvent: onFail.goto_event,
      scope
    });
    state.flags.forwardRunRequested = true;
  }
}
async function evaluateRunJs(runJs, checkId, checkConfig, result, context2, state) {
  try {
    const sandbox = createSecureSandbox();
    const snapshotId = context2.journal.beginSnapshot();
    const contextView = new (init_snapshot_store(), __toCommonJS(snapshot_store_exports)).ContextView(
      context2.journal,
      context2.sessionId,
      snapshotId,
      [],
      context2.event
    );
    const outputsRecord = {};
    const outputsHistory = {};
    for (const [key] of state.stats.entries()) {
      try {
        const journalResult = contextView.get(key);
        if (journalResult) {
          outputsRecord[key] = journalResult;
        }
      } catch {
        outputsRecord[key] = { issues: [] };
      }
      try {
        const history = contextView.getHistory(key);
        if (history && history.length > 0) {
          outputsHistory[key] = history.map((r) => r.output !== void 0 ? r.output : r);
        }
      } catch {
      }
    }
    const scopeObj = {
      step: {
        id: checkId,
        tags: checkConfig.tags || [],
        group: checkConfig.group
      },
      outputs: outputsRecord,
      outputs_history: outputsHistory,
      output: result?.output,
      event: {
        name: context2.event || "manual"
      }
    };
    const code = `
      const step = scope.step;
      const outputs = scope.outputs;
      const outputs_history = scope.outputs_history;
      const output = scope.output;
      const event = scope.event;
      const log = (...args) => console.log('\u{1F50D} Debug:', ...args);
      const __fn = () => {
        ${runJs}
      };
      const __res = __fn();
      return Array.isArray(__res) ? __res.filter(x => typeof x === 'string' && x) : [];
    `;
    const evalResult = compileAndRun(
      sandbox,
      code,
      { scope: scopeObj },
      { injectLog: false, wrapFunction: false }
    );
    return Array.isArray(evalResult) ? evalResult.filter(Boolean) : [];
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`[Routing] Error evaluating run_js: ${msg}`);
    return [];
  }
}
async function evaluateGoto(gotoJs, gotoStatic, checkId, checkConfig, result, context2, state) {
  if (gotoJs) {
    try {
      const sandbox = createSecureSandbox();
      const snapshotId = context2.journal.beginSnapshot();
      const contextView = new (init_snapshot_store(), __toCommonJS(snapshot_store_exports)).ContextView(
        context2.journal,
        context2.sessionId,
        snapshotId,
        [],
        context2.event
      );
      const outputsRecord = {};
      const outputsHistory = {};
      for (const [key] of state.stats.entries()) {
        try {
          const journalResult = contextView.get(key);
          if (journalResult) {
            outputsRecord[key] = journalResult;
          }
        } catch {
          outputsRecord[key] = { issues: [] };
        }
        try {
          const history = contextView.getHistory(key);
          if (history && history.length > 0) {
            outputsHistory[key] = history.map((r) => r.output !== void 0 ? r.output : r);
          }
        } catch {
        }
      }
      const scopeObj = {
        step: {
          id: checkId,
          tags: checkConfig.tags || [],
          group: checkConfig.group
        },
        outputs: outputsRecord,
        outputs_history: outputsHistory,
        output: result?.output,
        event: {
          name: context2.event || "manual"
        }
      };
      if (context2.debug) {
        logger.info(`[Routing] evaluateGoto: checkId=${checkId}, outputs_history keys=${Object.keys(outputsHistory).join(",")}`);
        for (const [key, values] of Object.entries(outputsHistory)) {
          logger.info(`[Routing]   ${key}: ${values.length} items`);
        }
      }
      const code = `
        const step = scope.step;
        const outputs = scope.outputs;
        const outputs_history = scope.outputs_history;
        const output = scope.output;
        const event = scope.event;
        const log = (...args) => console.log('\u{1F50D} Debug:', ...args);
        ${gotoJs}
      `;
      const evalResult = compileAndRun(
        sandbox,
        code,
        { scope: scopeObj },
        { injectLog: false, wrapFunction: true }
      );
      if (context2.debug) {
        logger.info(`[Routing] evaluateGoto result: ${evalResult}`);
      }
      if (typeof evalResult === "string" && evalResult) {
        return evalResult;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Routing] Error evaluating goto_js: ${msg}`);
      if (gotoStatic) {
        logger.info(`[Routing] Falling back to static goto: ${gotoStatic}`);
        return gotoStatic;
      }
    }
  }
  return gotoStatic || null;
}
var init_routing = __esm({
  "src/state-machine/states/routing.ts"() {
    init_logger();
    init_failure_condition_evaluator();
    init_sandbox();
  }
});

export {
  trace,
  context,
  init_lazy_otel,
  emitNdjsonFallback,
  emitNdjsonSpanWithEvents,
  fallback_ndjson_exports,
  init_fallback_ndjson,
  withActiveSpan,
  addEvent,
  init_trace_helpers,
  addDiagramBlock,
  init_metrics,
  createSecureSandbox,
  compileAndRun,
  init_sandbox,
  hasMinPermission,
  isOwner,
  isMember,
  isCollaborator,
  isContributor,
  isFirstTimer,
  createPermissionHelpers,
  detectLocalMode,
  resolveAssociationFromEvent,
  init_author_permissions,
  FailureConditionEvaluator,
  init_failure_condition_evaluator,
  ExecutionJournal,
  snapshot_store_exports,
  init_snapshot_store,
  handleRouting,
  evaluateGoto,
  init_routing
};
//# sourceMappingURL=chunk-FGOILCDM.mjs.map