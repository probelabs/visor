import {
  __esm,
  __export
} from "./chunk-WMJKH4XE.mjs";

// src/utils/config-merger.ts
var config_merger_exports = {};
__export(config_merger_exports, {
  ConfigMerger: () => ConfigMerger
});
var ConfigMerger;
var init_config_merger = __esm({
  "src/utils/config-merger.ts"() {
    ConfigMerger = class {
      /**
       * Merge two configurations with child overriding parent
       * @param parent - Base configuration
       * @param child - Configuration to merge on top
       * @returns Merged configuration
       */
      merge(parent, child) {
        const result = this.deepCopy(parent);
        if (child.version !== void 0) result.version = child.version;
        if (child.ai_model !== void 0) result.ai_model = child.ai_model;
        if (child.ai_provider !== void 0) result.ai_provider = child.ai_provider;
        if (child.max_parallelism !== void 0) result.max_parallelism = child.max_parallelism;
        if (child.fail_fast !== void 0) result.fail_fast = child.fail_fast;
        if (child.fail_if !== void 0) result.fail_if = child.fail_if;
        if (child.failure_conditions !== void 0)
          result.failure_conditions = child.failure_conditions;
        if (child.env) {
          result.env = this.mergeObjects(parent.env || {}, child.env);
        }
        if (child.output) {
          result.output = this.mergeOutputConfig(parent.output, child.output);
        }
        if (child.checks) {
          result.checks = this.mergeChecks(parent.checks || {}, child.checks);
        }
        if (child.steps) {
          const parentSteps = parent.steps || {};
          const childSteps = child.steps || {};
          result.steps = this.mergeChecks(parentSteps, childSteps);
        }
        if (child.tools) {
          result.tools = this.mergeObjects(parent.tools || {}, child.tools);
        }
        if (child.imports) {
          const parentImports = parent.imports || [];
          const childImports = child.imports || [];
          result.imports = [.../* @__PURE__ */ new Set([...parentImports, ...childImports])];
        }
        return result;
      }
      /**
       * Deep copy an object
       */
      deepCopy(obj) {
        if (obj === null || obj === void 0) {
          return obj;
        }
        if (obj instanceof Date) {
          return new Date(obj.getTime());
        }
        if (obj instanceof Array) {
          const copy = [];
          for (const item of obj) {
            copy.push(this.deepCopy(item));
          }
          return copy;
        }
        if (obj instanceof Object) {
          const copy = {};
          for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
              copy[key] = this.deepCopy(obj[key]);
            }
          }
          return copy;
        }
        return obj;
      }
      /**
       * Merge two objects (child overrides parent)
       */
      mergeObjects(parent, child) {
        const result = { ...parent };
        for (const key in child) {
          if (Object.prototype.hasOwnProperty.call(child, key)) {
            const parentValue = parent[key];
            const childValue = child[key];
            if (childValue === null || childValue === void 0) {
              delete result[key];
            } else if (typeof parentValue === "object" && typeof childValue === "object" && !Array.isArray(parentValue) && !Array.isArray(childValue) && parentValue !== null && childValue !== null) {
              result[key] = this.mergeObjects(
                parentValue,
                childValue
              );
            } else {
              result[key] = this.deepCopy(childValue);
            }
          }
        }
        return result;
      }
      /**
       * Merge output configurations
       */
      mergeOutputConfig(parent, child) {
        if (!child) return parent;
        if (!parent) return child;
        const result = this.deepCopy(parent);
        if (child.pr_comment) {
          result.pr_comment = this.mergeObjects(
            parent.pr_comment || {},
            child.pr_comment
          );
        }
        if (child.file_comment !== void 0) {
          if (child.file_comment === null) {
            delete result.file_comment;
          } else {
            result.file_comment = this.mergeObjects(
              parent.file_comment || {},
              child.file_comment
            );
          }
        }
        if (child.github_checks !== void 0) {
          if (child.github_checks === null) {
            delete result.github_checks;
          } else {
            result.github_checks = this.mergeObjects(
              parent.github_checks || {},
              child.github_checks
            );
          }
        }
        return result;
      }
      /**
       * Merge check configurations with special handling
       */
      mergeChecks(parent, child) {
        const result = {};
        for (const [checkName, checkConfig] of Object.entries(parent)) {
          result[checkName] = this.deepCopy(checkConfig);
        }
        for (const [checkName, childConfig] of Object.entries(child)) {
          const parentConfig = parent[checkName];
          if (!parentConfig) {
            const copiedConfig = this.deepCopy(childConfig);
            if (!copiedConfig.type) {
              copiedConfig.type = "ai";
            }
            if (!copiedConfig.on) {
              copiedConfig.on = ["manual"];
            }
            if (copiedConfig.appendPrompt !== void 0) {
              if (!copiedConfig.prompt) {
                copiedConfig.prompt = copiedConfig.appendPrompt;
              } else {
                copiedConfig.prompt = copiedConfig.prompt + "\n\n" + copiedConfig.appendPrompt;
              }
              delete copiedConfig.appendPrompt;
            }
            result[checkName] = copiedConfig;
          } else {
            result[checkName] = this.mergeCheckConfig(parentConfig, childConfig);
          }
        }
        return result;
      }
      /**
       * Merge individual check configurations
       */
      mergeCheckConfig(parent, child) {
        const result = this.deepCopy(parent);
        if (child.type !== void 0) result.type = child.type;
        if (!result.type) {
          result.type = "ai";
        }
        if (child.prompt !== void 0) result.prompt = child.prompt;
        if (child.appendPrompt !== void 0) {
          if (result.prompt) {
            result.prompt = result.prompt + "\n\n" + child.appendPrompt;
          } else {
            result.prompt = child.appendPrompt;
          }
          delete result.appendPrompt;
        }
        if (child.exec !== void 0) result.exec = child.exec;
        if (child.stdin !== void 0) result.stdin = child.stdin;
        if (child.url !== void 0) result.url = child.url;
        if (child.focus !== void 0) result.focus = child.focus;
        if (child.command !== void 0) result.command = child.command;
        if (child.ai_model !== void 0) result.ai_model = child.ai_model;
        if (child.ai_provider !== void 0) result.ai_provider = child.ai_provider;
        if (child.group !== void 0) result.group = child.group;
        if (child.schema !== void 0) result.schema = child.schema;
        if (child.if !== void 0) result.if = child.if;
        if (child.reuse_ai_session !== void 0) result.reuse_ai_session = child.reuse_ai_session;
        if (child.fail_if !== void 0) result.fail_if = child.fail_if;
        if (child.failure_conditions !== void 0)
          result.failure_conditions = child.failure_conditions;
        if (child.on !== void 0) {
          if (Array.isArray(child.on) && child.on.length === 0) {
            result.on = [];
          } else {
            result.on = [...child.on];
          }
        }
        if (!result.on) {
          result.on = ["manual"];
        }
        if (child.triggers !== void 0) {
          result.triggers = child.triggers ? [...child.triggers] : void 0;
        }
        if (child.depends_on !== void 0) {
          result.depends_on = child.depends_on ? [...child.depends_on] : void 0;
        }
        if (child.env) {
          result.env = this.mergeObjects(
            parent.env || {},
            child.env
          );
        }
        if (child.ai) {
          result.ai = this.mergeObjects(
            parent.ai || {},
            child.ai
          );
        }
        if (child.template) {
          result.template = this.mergeObjects(
            parent.template || {},
            child.template
          );
        }
        return result;
      }
      /**
       * Check if a check is disabled (has empty 'on' array)
       */
      isCheckDisabled(check) {
        return Array.isArray(check.on) && check.on.length === 0;
      }
      /**
       * Remove disabled checks from the configuration
       */
      removeDisabledChecks(config) {
        if (!config.checks) return config;
        const result = this.deepCopy(config);
        const enabledChecks = {};
        for (const [checkName, checkConfig] of Object.entries(result.checks)) {
          if (!this.isCheckDisabled(checkConfig)) {
            enabledChecks[checkName] = checkConfig;
          } else {
            console.log(`\u2139\uFE0F  Check '${checkName}' is disabled (empty 'on' array)`);
          }
        }
        result.checks = enabledChecks;
        return result;
      }
    };
  }
});

export {
  ConfigMerger,
  config_merger_exports,
  init_config_merger
};
//# sourceMappingURL=chunk-O5EZDNYL.mjs.map