import {
  createExtendedLiquid,
  init_liquid_extensions
} from "./chunk-PQWZ6NFL.mjs";
import {
  compileAndRun,
  createSecureSandbox,
  init_sandbox
} from "./chunk-LW3INISN.mjs";
import {
  init_logger,
  logger
} from "./chunk-FT3I25QV.mjs";
import {
  __esm,
  __export,
  __toCommonJS
} from "./chunk-J7LXIPZS.mjs";

// src/providers/check-provider.interface.ts
var CheckProvider;
var init_check_provider_interface = __esm({
  "src/providers/check-provider.interface.ts"() {
    "use strict";
    CheckProvider = class {
    };
  }
});

// src/utils/env-resolver.ts
var EnvironmentResolver;
var init_env_resolver = __esm({
  "src/utils/env-resolver.ts"() {
    "use strict";
    EnvironmentResolver = class {
      /**
       * Resolves a single configuration value that may contain environment variable references
       */
      static resolveValue(value) {
        if (typeof value !== "string") {
          return value;
        }
        let resolved = value.replace(/\$\{\{\s*env\.([A-Z_][A-Z0-9_]*)\s*\}\}/g, (match, envVar) => {
          return process.env[envVar] || match;
        });
        resolved = resolved.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (match, envVar) => {
          return process.env[envVar] || match;
        });
        resolved = resolved.replace(/\$([A-Z_][A-Z0-9_]*)/g, (match, envVar) => {
          return process.env[envVar] || match;
        });
        return resolved;
      }
      /**
       * Resolves all environment variables in an EnvConfig object
       */
      static resolveEnvConfig(envConfig) {
        const resolved = {};
        for (const [key, value] of Object.entries(envConfig)) {
          resolved[key] = this.resolveValue(value);
        }
        return resolved;
      }
      /**
       * Applies environment configuration to the process environment
       * This allows checks to access their specific environment variables
       */
      static applyEnvConfig(envConfig) {
        const resolved = this.resolveEnvConfig(envConfig);
        for (const [key, value] of Object.entries(resolved)) {
          if (value !== void 0) {
            process.env[key] = String(value);
          }
        }
      }
      /**
       * Creates a temporary environment for a specific check execution
       * Returns a cleanup function to restore the original environment
       */
      static withTemporaryEnv(envConfig, callback) {
        const resolved = this.resolveEnvConfig(envConfig);
        const originalValues = {};
        for (const [key, value] of Object.entries(resolved)) {
          originalValues[key] = process.env[key];
          if (value !== void 0) {
            process.env[key] = String(value);
          }
        }
        try {
          const result = callback();
          if (result instanceof Promise) {
            return result.finally(() => {
              for (const [key, originalValue] of Object.entries(originalValues)) {
                if (originalValue === void 0) {
                  delete process.env[key];
                } else {
                  process.env[key] = originalValue;
                }
              }
            });
          }
          for (const [key, originalValue] of Object.entries(originalValues)) {
            if (originalValue === void 0) {
              delete process.env[key];
            } else {
              process.env[key] = originalValue;
            }
          }
          return result;
        } catch (error) {
          for (const [key, originalValue] of Object.entries(originalValues)) {
            if (originalValue === void 0) {
              delete process.env[key];
            } else {
              process.env[key] = originalValue;
            }
          }
          throw error;
        }
      }
      /**
       * Validates that all required environment variables are available
       */
      static validateRequiredEnvVars(envConfig, requiredVars) {
        const resolved = this.resolveEnvConfig(envConfig);
        const missing = [];
        for (const varName of requiredVars) {
          const value = resolved[varName] || process.env[varName];
          if (!value) {
            missing.push(varName);
          }
        }
        return missing;
      }
      /**
       * Resolves environment variables in HTTP headers
       * Each header value is processed through resolveValue to replace env var references
       */
      static resolveHeaders(headers) {
        const resolved = {};
        for (const [key, value] of Object.entries(headers)) {
          resolved[key] = String(this.resolveValue(value));
        }
        return resolved;
      }
      /**
       * Sanitizes headers for logging/telemetry by redacting sensitive values
       * Headers like Authorization, API keys, and cookies are replaced with [REDACTED]
       */
      static sanitizeHeaders(headers) {
        const sensitiveHeaders = ["authorization", "x-api-key", "cookie", "set-cookie"];
        const sanitized = {};
        for (const [key, value] of Object.entries(headers)) {
          if (sensitiveHeaders.includes(key.toLowerCase())) {
            sanitized[key] = "[REDACTED]";
          } else {
            sanitized[key] = value;
          }
        }
        return sanitized;
      }
    };
  }
});

// src/utils/issue-normalizer.ts
function extractIssuesFromOutput(output, defaultRuleId) {
  if (output === null || output === void 0) {
    return null;
  }
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      return extractIssuesFromOutput(parsed, defaultRuleId);
    } catch {
      return null;
    }
  }
  if (Array.isArray(output)) {
    const issues = normalizeIssueArray(output, defaultRuleId);
    if (issues) {
      return { issues, remainingOutput: void 0 };
    }
    return null;
  }
  if (typeof output === "object") {
    const record = output;
    if (Array.isArray(record.issues)) {
      const issues = normalizeIssueArray(record.issues, defaultRuleId);
      if (!issues) {
        return null;
      }
      const remaining = { ...record };
      delete remaining.issues;
      return {
        issues,
        remainingOutput: Object.keys(remaining).length > 0 ? remaining : void 0
      };
    }
    const singleIssue = normalizeIssue(record, defaultRuleId);
    if (singleIssue) {
      return { issues: [singleIssue], remainingOutput: void 0 };
    }
  }
  return null;
}
function normalizeIssueArray(values, defaultRuleId) {
  const normalized = [];
  for (const value of values) {
    const issue = normalizeIssue(value, defaultRuleId);
    if (!issue) {
      return null;
    }
    normalized.push(issue);
  }
  return normalized;
}
function normalizeIssue(raw, defaultRuleId = "tool") {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const data = raw;
  const rawMessage = data.message || data.text || data.description || data.summary;
  if (typeof rawMessage !== "string") {
    return null;
  }
  const message = rawMessage.trim();
  if (!message) {
    return null;
  }
  const allowedSeverities = /* @__PURE__ */ new Set(["info", "warning", "error", "critical"]);
  const severityRaw = toTrimmedString(data.severity || data.level || data.priority);
  let severity = "warning";
  if (severityRaw) {
    const lower = severityRaw.toLowerCase();
    if (allowedSeverities.has(lower)) {
      severity = lower;
    }
  }
  const allowedCategories = /* @__PURE__ */ new Set(["security", "performance", "style", "logic", "documentation"]);
  const categoryRaw = toTrimmedString(data.category || data.type || data.group);
  let category = "logic";
  if (categoryRaw && allowedCategories.has(categoryRaw.toLowerCase())) {
    category = categoryRaw.toLowerCase();
  }
  const file = toTrimmedString(data.file || data.path || data.filename) || "system";
  const line = toNumber(data.line || data.startLine || data.lineNumber) ?? 0;
  const endLine = toNumber(data.endLine || data.end_line || data.stopLine);
  const suggestion = toTrimmedString(data.suggestion);
  const replacement = toTrimmedString(data.replacement);
  const ruleId = toTrimmedString(data.ruleId || data.rule || data.id || data.check) || defaultRuleId;
  return {
    file,
    line,
    endLine: endLine ?? void 0,
    ruleId,
    message,
    severity,
    category,
    suggestion: suggestion || void 0,
    replacement: replacement || void 0
  };
}
function toTrimmedString(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (value !== null && value !== void 0 && typeof value.toString === "function") {
    const converted = String(value).trim();
    return converted.length > 0 ? converted : null;
  }
  return null;
}
function toNumber(value) {
  if (value === null || value === void 0) {
    return null;
  }
  const num = Number(value);
  if (Number.isFinite(num)) {
    return Math.trunc(num);
  }
  return null;
}
var init_issue_normalizer = __esm({
  "src/utils/issue-normalizer.ts"() {
    "use strict";
  }
});

// src/utils/env-exposure.ts
var env_exposure_exports = {};
__export(env_exposure_exports, {
  buildSandboxEnv: () => buildSandboxEnv
});
function buildSandboxEnv(input) {
  const denyDefaults = [
    "GITHUB_TOKEN",
    "INPUT_GITHUB-TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AZURE_CLIENT_SECRET",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "HUGGINGFACE_API_KEY",
    "CLAUDE_CODE_API_KEY",
    "PROBE_API_KEY"
  ];
  const denyExtra = (input.VISOR_DENY_ENV || "").split(",").map((s) => s.trim()).filter(Boolean);
  const deny = Array.from(/* @__PURE__ */ new Set([...denyDefaults, ...denyExtra]));
  const allowSpec = (input.VISOR_ALLOW_ENV || "*").trim();
  const denyMatch = (key) => {
    for (const pat of deny) {
      if (!pat) continue;
      if (pat.endsWith("*")) {
        const prefix = pat.slice(0, -1);
        if (key.startsWith(prefix)) return true;
      } else if (key === pat) {
        return true;
      }
    }
    if (/(_TOKEN|_SECRET|_PASSWORD|_PRIVATE_KEY)$/i.test(key)) return true;
    return false;
  };
  const out = {};
  if (allowSpec !== "*") {
    const allow = allowSpec.split(",").map((s) => s.trim()).filter(Boolean);
    for (const key of allow) {
      const val = input[key];
      if (key && val !== void 0 && !denyMatch(key)) out[key] = String(val);
    }
    return out;
  }
  for (const [k, v] of Object.entries(input)) {
    if (v === void 0 || v === null) continue;
    if (denyMatch(k)) continue;
    out[k] = String(v);
  }
  return out;
}
var init_env_exposure = __esm({
  "src/utils/env-exposure.ts"() {
    "use strict";
  }
});

// src/providers/utcp-check-provider.ts
import * as fs from "fs";
import * as path from "path";
var UtcpCheckProvider;
var init_utcp_check_provider = __esm({
  "src/providers/utcp-check-provider.ts"() {
    init_check_provider_interface();
    init_logger();
    init_liquid_extensions();
    init_sandbox();
    init_env_resolver();
    init_issue_normalizer();
    UtcpCheckProvider = class _UtcpCheckProvider extends CheckProvider {
      liquid;
      sandbox;
      sdkAvailable = null;
      constructor() {
        super();
        this.liquid = createExtendedLiquid({
          cache: false,
          strictFilters: false,
          strictVariables: false
        });
      }
      getName() {
        return "utcp";
      }
      getDescription() {
        return "Call UTCP tools directly using their native protocols (HTTP, CLI, SSE)";
      }
      async validateConfig(config) {
        if (!config || typeof config !== "object") {
          return false;
        }
        const cfg = config;
        if (cfg.type !== "utcp") {
          return false;
        }
        if (!cfg.manual) {
          logger.error("UTCP check requires a manual (URL, file path, or inline call template)");
          return false;
        }
        if (!cfg.method || typeof cfg.method !== "string") {
          logger.error("UTCP check requires a method name");
          return false;
        }
        if (typeof cfg.manual === "string") {
          if (cfg.manual.startsWith("http://") || cfg.manual.startsWith("https://")) {
            try {
              const parsedUrl = new URL(cfg.manual);
              if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
                logger.error(`Invalid URL protocol for UTCP manual: ${parsedUrl.protocol}`);
                return false;
              }
            } catch {
              logger.error(`Invalid URL format for UTCP manual: ${cfg.manual}`);
              return false;
            }
          }
        } else if (typeof cfg.manual === "object") {
          if (!cfg.manual.call_template_type) {
            logger.error("Inline UTCP manual must have call_template_type");
            return false;
          }
        } else {
          logger.error("UTCP manual must be a URL string, file path, or inline call template object");
          return false;
        }
        return true;
      }
      async execute(prInfo, config, dependencyResults, sessionInfo) {
        const cfg = config;
        try {
          const stepName = config.checkName || "unknown";
          const mock = sessionInfo?.hooks?.mockForStep?.(String(stepName));
          if (mock !== void 0) {
            const ms = mock;
            const issuesArr = Array.isArray(ms?.issues) ? ms.issues : [];
            const out = ms && typeof ms === "object" && "output" in ms ? ms.output : ms;
            return {
              issues: issuesArr,
              ...out !== void 0 ? { output: out } : {}
            };
          }
        } catch {
        }
        try {
          const templateContext = {
            pr: {
              number: prInfo.number,
              title: prInfo.title,
              author: prInfo.author,
              branch: prInfo.head,
              base: prInfo.base
            },
            files: prInfo.files,
            fileCount: prInfo.files.length,
            outputs: this.buildOutputContext(dependencyResults),
            args: sessionInfo?.args || {},
            env: this.getSafeEnvironmentVariables(),
            inputs: config.workflowInputs || sessionInfo?.workflowInputs || {}
          };
          let methodArgs = cfg.methodArgs || {};
          if (cfg.argsTransform) {
            const rendered = await this.liquid.parseAndRender(cfg.argsTransform, templateContext);
            try {
              methodArgs = JSON.parse(rendered);
            } catch (error) {
              logger.error(`Failed to parse argsTransform as JSON: ${error}`);
              return {
                issues: [
                  {
                    file: "utcp",
                    line: 0,
                    ruleId: "utcp/args_transform_error",
                    message: `Failed to parse argsTransform: ${error instanceof Error ? error.message : "Unknown error"}`,
                    severity: "error",
                    category: "logic"
                  }
                ]
              };
            }
          } else if (methodArgs && typeof methodArgs === "object") {
            const renderValue = async (val) => {
              if (typeof val === "string" && (val.includes("{{") || val.includes("{%"))) {
                return await this.liquid.parseAndRender(val, templateContext);
              } else if (val && typeof val === "object" && !Array.isArray(val)) {
                const rendered = {};
                for (const [k, v] of Object.entries(val)) {
                  rendered[k] = await renderValue(v);
                }
                return rendered;
              } else if (Array.isArray(val)) {
                return Promise.all(val.map((item) => renderValue(item)));
              }
              return val;
            };
            methodArgs = await renderValue(methodArgs);
          }
          const resolvedVariables = {};
          if (cfg.variables) {
            for (const [key, value] of Object.entries(cfg.variables)) {
              resolvedVariables[key] = String(EnvironmentResolver.resolveValue(value));
            }
          }
          const result = await _UtcpCheckProvider.callTool(cfg.manual, cfg.method, methodArgs, {
            variables: resolvedVariables,
            plugins: cfg.plugins || ["http"],
            timeoutMs: (cfg.timeout || 60) * 1e3
          });
          {
            let finalOutput = result;
            if (cfg.transform) {
              try {
                const transformContext = {
                  ...templateContext,
                  output: result
                };
                const rendered = await this.liquid.parseAndRender(cfg.transform, transformContext);
                try {
                  finalOutput = JSON.parse(rendered.trim());
                } catch {
                  finalOutput = rendered.trim();
                }
              } catch (error) {
                logger.error(`Failed to apply Liquid transform: ${error}`);
                throw new Error(
                  `Failed to apply transform: ${error instanceof Error ? error.message : "Unknown error"}`
                );
              }
            }
            if (cfg.transform_js) {
              try {
                this.sandbox = createSecureSandbox();
                const scope = {
                  output: finalOutput,
                  pr: templateContext.pr,
                  files: templateContext.files,
                  outputs: templateContext.outputs,
                  env: templateContext.env
                };
                finalOutput = compileAndRun(
                  this.sandbox,
                  `return (${cfg.transform_js});`,
                  scope,
                  { injectLog: true, wrapFunction: false, logPrefix: "[utcp:transform_js]" }
                );
              } catch (error) {
                logger.error(`Failed to apply JavaScript transform: ${error}`);
                throw new Error(
                  `Failed to apply JavaScript transform: ${error instanceof Error ? error.message : "Unknown error"}`
                );
              }
            }
            const extracted = extractIssuesFromOutput(finalOutput, "utcp");
            if (extracted) {
              return {
                issues: extracted.issues,
                ...extracted.remainingOutput ? { output: extracted.remainingOutput } : {}
              };
            }
            return {
              issues: [],
              ...finalOutput ? { output: finalOutput } : {}
            };
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          const isTimeout = this.isTimeoutError(error);
          const severity = isTimeout ? "warning" : "error";
          const ruleId = isTimeout ? "utcp/timeout" : "utcp/execution_error";
          if (isTimeout) {
            logger.warn(`UTCP check timed out: ${errorMessage}`);
          } else {
            logger.error(`UTCP check failed: ${errorMessage}`);
          }
          return {
            issues: [
              {
                file: "utcp",
                line: 0,
                ruleId,
                message: isTimeout ? `UTCP check timed out: ${errorMessage}` : `UTCP check failed: ${errorMessage}`,
                severity,
                category: "logic"
              }
            ]
          };
        }
      }
      /**
       * Resolve manual config to a UTCP call template object.
       * Shared utility used by both the standalone UTCP provider and the AI check provider's UTCP-to-MCP bridge.
       */
      static async resolveManualCallTemplate(manual) {
        if (typeof manual === "object") {
          if (!manual.call_template_type) {
            throw new Error("Inline manual must have call_template_type");
          }
          if (!manual.name) {
            manual.name = "inline";
          }
          return manual;
        }
        if (manual.startsWith("http://") || manual.startsWith("https://")) {
          return {
            name: _UtcpCheckProvider.deriveManualName(manual),
            call_template_type: "http",
            url: manual,
            http_method: "GET"
          };
        }
        if (manual.includes("\0")) {
          throw new Error("Invalid UTCP manual path: null bytes are not allowed");
        }
        const resolvedPath = path.resolve(manual);
        const cwd = path.resolve(process.cwd());
        const normalizedResolved = path.normalize(resolvedPath);
        const cwdPrefix = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
        if (normalizedResolved !== cwd && !normalizedResolved.startsWith(cwdPrefix)) {
          throw new Error(
            `Path traversal detected: "${manual}" resolves outside the project directory. UTCP manual paths must be within the project directory.`
          );
        }
        if (fs.existsSync(resolvedPath)) {
          const realPath = fs.realpathSync(resolvedPath);
          if (realPath !== cwd && !realPath.startsWith(cwdPrefix)) {
            throw new Error(
              `Symlink traversal detected: "${manual}" points outside the project directory via symlink.`
            );
          }
        }
        if (!fs.existsSync(resolvedPath)) {
          throw new Error(`UTCP manual file not found: ${resolvedPath}`);
        }
        let content;
        try {
          content = fs.readFileSync(resolvedPath, "utf-8");
        } catch (err) {
          throw new Error(
            `Failed to read UTCP manual file: ${resolvedPath}: ${err instanceof Error ? err.message : "Unknown error"}`
          );
        }
        let parsed;
        try {
          parsed = JSON.parse(content);
        } catch (err) {
          throw new Error(
            `Failed to parse UTCP manual file as JSON: ${resolvedPath}: ${err instanceof Error ? err.message : "Unknown error"}`
          );
        }
        if (parsed.call_template_type) {
          if (!parsed.name) {
            parsed.name = path.basename(resolvedPath, path.extname(resolvedPath));
          }
          return parsed;
        }
        try {
          await import("@utcp/file");
        } catch {
          logger.debug("UTCP @utcp/file plugin not available, attempting direct parse");
        }
        return {
          name: parsed.name || path.basename(resolvedPath, path.extname(resolvedPath)),
          call_template_type: "file",
          file_path: resolvedPath,
          allowed_communication_protocols: ["file", "http", "https"]
        };
      }
      /**
       * Derive a manual name from a URL.
       * Shared utility for UTCP manual name derivation.
       */
      static deriveManualName(url) {
        try {
          const parsed = new URL(url);
          return parsed.hostname.replace(/\./g, "_").replace(/-/g, "_");
        } catch {
          return "utcp_manual";
        }
      }
      /**
       * Call a UTCP tool directly. Shared by both the standalone provider and the MCP-bridge SSE server.
       * Handles SDK import, plugin loading, client creation, tool calling, and cleanup.
       */
      static async callTool(manual, toolName, args, options) {
        const variables = options?.variables || {};
        const plugins = options?.plugins || ["http"];
        const timeoutMs = options?.timeoutMs || 6e4;
        const { UtcpClient } = await import("@utcp/sdk");
        for (const plugin of plugins) {
          try {
            await import(`@utcp/${plugin}`);
          } catch {
            logger.debug(`UTCP plugin @utcp/${plugin} not available`);
          }
        }
        const callTemplate = await _UtcpCheckProvider.resolveManualCallTemplate(manual);
        const client = await UtcpClient.create(process.cwd(), {
          manual_call_templates: [callTemplate],
          variables
        });
        try {
          let resolvedToolName = toolName;
          try {
            const tools = await client.getTools();
            const toolNames = tools.map((t) => t.name);
            logger.debug(`UTCP tools available: ${JSON.stringify(toolNames)}`);
            if (!toolNames.includes(resolvedToolName)) {
              const suffixMatch = toolNames.find(
                (name) => name.endsWith(`.${resolvedToolName}`)
              );
              if (suffixMatch) {
                logger.debug(
                  `UTCP method '${resolvedToolName}' resolved to '${suffixMatch}' via suffix match`
                );
                resolvedToolName = suffixMatch;
              }
            }
          } catch (err) {
            logger.debug(`Failed to list UTCP tools for name resolution: ${err}`);
          }
          let timer;
          const result = await Promise.race([
            client.callTool(resolvedToolName, args),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`UTCP tool '${toolName}' timed out after ${timeoutMs}ms`)),
                timeoutMs
              );
            })
          ]).finally(() => clearTimeout(timer));
          return result;
        } finally {
          try {
            if (typeof client.close === "function") {
              await client.close();
            }
          } catch {
          }
        }
      }
      /**
       * Check if an error is a timeout error
       */
      isTimeoutError(error) {
        const err = error;
        const message = typeof err?.message === "string" ? err.message.toLowerCase() : "";
        const code = typeof err?.code === "string" ? err.code.toLowerCase() : "";
        return message.includes("timeout") || message.includes("timed out") || code.includes("timeout");
      }
      /**
       * Build output context from dependency results
       */
      buildOutputContext(dependencyResults) {
        if (!dependencyResults) {
          return {};
        }
        const outputs = {};
        for (const [checkName, result] of dependencyResults) {
          const summary = result;
          outputs[checkName] = summary.output !== void 0 ? summary.output : summary;
        }
        return outputs;
      }
      /**
       * Get safe environment variables
       */
      getSafeEnvironmentVariables() {
        const safeVars = {};
        const { buildSandboxEnv: buildSandboxEnv2 } = (init_env_exposure(), __toCommonJS(env_exposure_exports));
        const merged = buildSandboxEnv2(process.env);
        for (const [key, value] of Object.entries(merged)) {
          safeVars[key] = String(value);
        }
        safeVars["PWD"] = process.cwd();
        return safeVars;
      }
      getSupportedConfigKeys() {
        return [
          "type",
          "manual",
          "method",
          "methodArgs",
          "argsTransform",
          "variables",
          "plugins",
          "transform",
          "transform_js",
          "timeout",
          "depends_on",
          "on",
          "if",
          "group"
        ];
      }
      async isAvailable() {
        if (this.sdkAvailable !== null) {
          return this.sdkAvailable;
        }
        try {
          await import("@utcp/sdk");
          this.sdkAvailable = true;
        } catch {
          this.sdkAvailable = false;
        }
        return this.sdkAvailable;
      }
      getRequirements() {
        return [
          "@utcp/sdk package installed",
          "UTCP manual source (URL, file path, or inline)",
          "Tool method name"
        ];
      }
    };
  }
});

export {
  CheckProvider,
  init_check_provider_interface,
  EnvironmentResolver,
  init_env_resolver,
  extractIssuesFromOutput,
  normalizeIssueArray,
  normalizeIssue,
  init_issue_normalizer,
  buildSandboxEnv,
  env_exposure_exports,
  init_env_exposure,
  UtcpCheckProvider,
  init_utcp_check_provider
};
//# sourceMappingURL=chunk-7XRSCOKE.mjs.map