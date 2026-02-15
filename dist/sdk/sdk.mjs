import {
  StateMachineExecutionEngine,
  init_state_machine_execution_engine
} from "./chunk-D3XYG3O3.mjs";
import "./chunk-LG4AUKHB.mjs";
import "./chunk-KFKHU6CM.mjs";
import "./chunk-B7BVQM5K.mjs";
import "./chunk-XXAEN5KU.mjs";
import "./chunk-GEW6LS32.mjs";
import "./chunk-DIND4ZCV.mjs";
import {
  ConfigManager,
  init_config
} from "./chunk-LQ5B4T6L.mjs";
import "./chunk-NCWIZVOT.mjs";
import "./chunk-2GCSK3PD.mjs";
import "./chunk-EBTD2D4L.mjs";
import "./chunk-N4I6ZDCJ.mjs";
import "./chunk-JL7JXCET.mjs";
import "./chunk-XJQKTK6V.mjs";
import "./chunk-25IC7KXZ.mjs";
import "./chunk-VF6XIUE4.mjs";
import "./chunk-VPC3QSPW.mjs";
import "./chunk-SZXICFQ3.mjs";
import "./chunk-UCMJJ3IM.mjs";
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