import {
  StateMachineExecutionEngine,
  init_state_machine_execution_engine
} from "./chunk-UNWB3DYX.mjs";
import "./chunk-YSOIR46P.mjs";
import "./chunk-VPPBOKBQ.mjs";
import "./chunk-SJHBRMHX.mjs";
import "./chunk-2LLKENYD.mjs";
import "./chunk-TL3ZTYFY.mjs";
import "./chunk-4EA7TOUV.mjs";
import "./chunk-PGBV3VZB.mjs";
import "./chunk-MCKMB3CO.mjs";
import "./chunk-7QI6F66G.mjs";
import "./chunk-B7BVQM5K.mjs";
import "./chunk-77AKSSW2.mjs";
import "./chunk-32S5FVFW.mjs";
import "./chunk-4ZLYHSN4.mjs";
import {
  ConfigManager,
  init_config
} from "./chunk-LI72PJJA.mjs";
import "./chunk-KWTCTEFT.mjs";
import "./chunk-PH4QD7HU.mjs";
import "./chunk-IMDOAAE2.mjs";
import "./chunk-326JA6WQ.mjs";
import "./chunk-D545TJYQ.mjs";
import "./chunk-6YGHXAAC.mjs";
import "./chunk-AYW3HG6Y.mjs";
import "./chunk-FWWLD555.mjs";
import "./chunk-4HIWZA6M.mjs";
import "./chunk-25IC7KXZ.mjs";
import "./chunk-LW3INISN.mjs";
import "./chunk-4MHHELVZ.mjs";
import "./chunk-6E625R3C.mjs";
import "./chunk-B2OUZAWY.mjs";
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
  StateMachineExecutionEngine,
  loadConfig,
  resolveChecks,
  runChecks
};
//# sourceMappingURL=sdk.mjs.map