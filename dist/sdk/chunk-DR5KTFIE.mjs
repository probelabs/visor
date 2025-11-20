import {
  createPermissionHelpers,
  detectLocalMode,
  init_author_permissions
} from "./chunk-CNX7V5JK.mjs";
import {
  addEvent,
  fallback_ndjson_exports,
  init_fallback_ndjson,
  init_trace_helpers
} from "./chunk-ZYAUYXSW.mjs";
import {
  addFailIfTriggered,
  init_metrics
} from "./chunk-S2RUE2RG.mjs";
import {
  MemoryStore,
  init_memory_store
} from "./chunk-A7MRMUDG.mjs";
import {
  init_logger,
  logger_exports
} from "./chunk-VMPLF6FT.mjs";
import {
  __esm,
  __toCommonJS
} from "./chunk-WMJKH4XE.mjs";

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

// src/failure-condition-evaluator.ts
var FailureConditionEvaluator;
var init_failure_condition_evaluator = __esm({
  "src/failure-condition-evaluator.ts"() {
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
        const context = this.buildEvaluationContext(
          checkName,
          checkSchema,
          checkGroup,
          reviewSummary,
          previousOutputs,
          authorAssociation
        );
        try {
          try {
            const isObj = context.output && typeof context.output === "object";
            const keys = isObj ? Object.keys(context.output).join(",") : typeof context.output;
            let errorVal = void 0;
            if (isObj && context.output.error !== void 0)
              errorVal = context.output.error;
            (init_logger(), __toCommonJS(logger_exports)).logger.debug(
              `  fail_if: evaluating '${expression}' with output keys=${keys} error=${String(errorVal)}`
            );
          } catch {
          }
          const res = this.evaluateExpression(expression, context);
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
              const { emitNdjsonSpanWithEvents } = (init_fallback_ndjson(), __toCommonJS(fallback_ndjson_exports));
              emitNdjsonSpanWithEvents(
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
        const context = {
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
          const res = this.evaluateExpression(expression, context);
          try {
            if (process.env.VISOR_DEBUG === "true") {
              const envMap = context.env || {};
              console.error(
                `[if-eval] check=${checkName} expr="${expression}" env.ENABLE_FACT_VALIDATION=${String(
                  envMap.ENABLE_FACT_VALIDATION
                )} event=${context.event?.event_name} result=${String(res)}`
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
        const context = this.buildEvaluationContext(
          checkName,
          checkSchema,
          checkGroup,
          reviewSummary,
          previousOutputs,
          authorAssociation
        );
        const results = [];
        if (globalConditions) {
          const globalResults = await this.evaluateConditionSet(globalConditions, context, "global");
          results.push(...globalResults);
        }
        if (checkConditions) {
          const checkResults = await this.evaluateConditionSet(checkConditions, context, "check");
          const overriddenConditions = new Set(Object.keys(checkConditions));
          const filteredResults = results.filter(
            (result) => !overriddenConditions.has(result.conditionName)
          );
          results.length = 0;
          results.push(...filteredResults, ...checkResults);
        }
        return results;
      }
      /**
       * Evaluate a set of failure conditions
       */
      async evaluateConditionSet(conditions, context, source) {
        const results = [];
        for (const [conditionName, condition] of Object.entries(conditions)) {
          try {
            addEvent("fail_if.evaluated", {
              check: context.checkName,
              scope: source,
              name: conditionName,
              expression: this.extractExpression(condition)
            });
          } catch {
          }
          try {
            const { emitNdjsonSpanWithEvents } = (init_fallback_ndjson(), __toCommonJS(fallback_ndjson_exports));
            emitNdjsonSpanWithEvents(
              "visor.fail_if",
              { check: context.checkName || "unknown", scope: source, name: conditionName },
              [
                {
                  name: "fail_if.evaluated",
                  attrs: {
                    check: context.checkName,
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
            const result = await this.evaluateSingleCondition(conditionName, condition, context);
            results.push(result);
            if (result.failed) {
              try {
                addEvent("fail_if.triggered", {
                  check: context.checkName,
                  scope: source,
                  name: conditionName,
                  expression: result.expression,
                  severity: result.severity,
                  halt_execution: result.haltExecution
                });
              } catch {
              }
              try {
                addFailIfTriggered(context.checkName || "unknown", source);
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
      async evaluateSingleCondition(conditionName, condition, context) {
        const expression = this.extractExpression(condition);
        const config = this.extractConditionConfig(condition);
        try {
          const failed = this.evaluateExpression(expression, context);
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
      evaluateExpression(condition, context) {
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
            context.authorAssociation,
            detectLocalMode()
          );
          const hasMinPermission = permissionHelpers.hasMinPermission;
          const isOwner = permissionHelpers.isOwner;
          const isMember = permissionHelpers.isMember;
          const isCollaborator = permissionHelpers.isCollaborator;
          const isContributor = permissionHelpers.isContributor;
          const isFirstTimer = permissionHelpers.isFirstTimer;
          const output = context.output || {};
          const issues = output.issues || [];
          const metadata = context.metadata || {
            checkName: context.checkName || "",
            schema: context.schema || "",
            group: context.group || "",
            criticalIssues: issues.filter((i) => i.severity === "critical").length,
            errorIssues: issues.filter((i) => i.severity === "error").length,
            warningIssues: issues.filter((i) => i.severity === "warning").length,
            infoIssues: issues.filter((i) => i.severity === "info").length,
            totalIssues: issues.length,
            hasChanges: context.hasChanges || false
          };
          const criticalIssues = metadata.criticalIssues;
          const errorIssues = metadata.errorIssues;
          const totalIssues = metadata.totalIssues;
          const warningIssues = metadata.warningIssues;
          const infoIssues = metadata.infoIssues;
          const checkName = context.checkName || "";
          const schema = context.schema || "";
          const group = context.group || "";
          const branch = context.branch || "unknown";
          const baseBranch = context.baseBranch || "main";
          const filesChanged = context.filesChanged || [];
          const filesCount = context.filesCount || 0;
          const event = context.event || "manual";
          const env = context.env || {};
          const outputs = context.outputs || {};
          const debugData = context.debug || null;
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
            hasMinPermission,
            isOwner,
            isMember,
            isCollaborator,
            isContributor,
            isFirstTimer
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
        const context = {
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
          context.debug = {
            errors: debug.errors || [],
            processingTime: debug.processingTime || 0,
            provider: debug.provider || "unknown",
            model: debug.model || "unknown"
          };
        }
        return context;
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

export {
  createSecureSandbox,
  compileAndRun,
  init_sandbox,
  FailureConditionEvaluator,
  init_failure_condition_evaluator
};
//# sourceMappingURL=chunk-DR5KTFIE.mjs.map