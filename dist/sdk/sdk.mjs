import {
  StateMachineExecutionEngine,
  init_state_machine_execution_engine
} from "./chunk-HLFJJU4A.mjs";
import "./chunk-KFKHU6CM.mjs";
import "./chunk-XXAEN5KU.mjs";
import "./chunk-XDLQ3UNF.mjs";
import "./chunk-D5KI4YQ4.mjs";
import {
  ConfigManager,
  init_config
} from "./chunk-CIIXKIO7.mjs";
import "./chunk-NCWIZVOT.mjs";
import "./chunk-6W75IMDC.mjs";
import "./chunk-SGS2VMEL.mjs";
import "./chunk-N7HO6KKC.mjs";
import "./chunk-J5RGJQ53.mjs";
import "./chunk-XR7XXGL7.mjs";
import "./chunk-R5Z7YWPB.mjs";
import "./chunk-25IC7KXZ.mjs";
import "./chunk-VF6XIUE4.mjs";
import "./chunk-2KB35MB7.mjs";
import "./chunk-PO7X5XI7.mjs";
import "./chunk-HEX3RL32.mjs";
import "./chunk-B7BVQM5K.mjs";
import "./chunk-J7LXIPZS.mjs";

// src/sdk.ts
init_state_machine_execution_engine();
init_config();
async function loadConfig(configOrPath, options) {
  const cm = new ConfigManager();
  if (typeof configOrPath === "object" && configOrPath !== null) {
    cm.validateConfig(configOrPath, options?.strict ?? false);
    const defaultConfig = {
      version: "1.0",
      checks: {},
      max_parallelism: 3,
      fail_fast: false
    };
    return {
      ...defaultConfig,
      ...configOrPath,
      checks: configOrPath.checks || {}
    };
  }
  if (typeof configOrPath === "string") {
    return cm.loadConfig(configOrPath);
  }
  return cm.findAndLoadConfig();
}
function resolveChecks(checkIds, config) {
  if (!config?.checks) return Array.from(new Set(checkIds));
  const resolved = /* @__PURE__ */ new Set();
  const visiting = /* @__PURE__ */ new Set();
  const result = [];
  const dfs = (id, stack = []) => {
    if (resolved.has(id)) return;
    if (visiting.has(id)) {
      const cycle = [...stack, id].join(" -> ");
      throw new Error(`Circular dependency detected involving check: ${id} (path: ${cycle})`);
    }
    visiting.add(id);
    const deps = config.checks[id]?.depends_on || [];
    for (const d of deps) dfs(d, [...stack, id]);
    if (!result.includes(id)) result.push(id);
    visiting.delete(id);
    resolved.add(id);
  };
  for (const id of checkIds) dfs(id);
  return result;
}
async function runChecks(opts = {}) {
  const cm = new ConfigManager();
  let config;
  if (opts.config) {
    cm.validateConfig(opts.config, opts.strictValidation ?? false);
    config = opts.config;
  } else if (opts.configPath) {
    config = await cm.loadConfig(opts.configPath);
  } else {
    config = await cm.findAndLoadConfig();
  }
  const checks = opts.checks && opts.checks.length > 0 ? resolveChecks(opts.checks, config) : Object.keys(config.checks || {});
  const engine = new StateMachineExecutionEngine(opts.cwd);
  if (opts.executionContext) {
    engine.setExecutionContext(opts.executionContext);
  }
  const result = await engine.executeChecks({
    checks,
    workingDirectory: opts.cwd,
    timeout: opts.timeoutMs,
    maxParallelism: opts.maxParallelism,
    failFast: opts.failFast,
    outputFormat: opts.output?.format,
    config,
    debug: opts.debug,
    tagFilter: opts.tagFilter
  });
  return result;
}
export {
  loadConfig,
  resolveChecks,
  runChecks
};
//# sourceMappingURL=sdk.mjs.map