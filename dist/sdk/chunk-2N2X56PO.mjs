import {
  detectLocalMode,
  hasMinPermission,
  init_author_permissions,
  isCollaborator,
  isContributor,
  isFirstTimer,
  isMember,
  isOwner
} from "./chunk-25IC7KXZ.mjs";
import {
  compileAndRun,
  createSecureSandbox,
  init_sandbox
} from "./chunk-VF6XIUE4.mjs";
import {
  MemoryStore,
  init_memory_store
} from "./chunk-UEWXVJ6C.mjs";
import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/liquid-extensions.ts
import { Liquid, Tag, Value } from "liquidjs";
import { AsyncLocalStorage } from "async_hooks";
import fs from "fs/promises";
import path from "path";
function sanitizeLabel(value) {
  if (value == null) return "";
  const s = String(value);
  return s.replace(/[^A-Za-z0-9:\/\- ]/g, "").replace(/\/{2,}/g, "/").trim();
}
function sanitizeLabelList(labels) {
  if (!Array.isArray(labels)) return [];
  return labels.map((v) => sanitizeLabel(v)).filter((s) => s.length > 0);
}
async function withPermissionsContext(ctx, fn) {
  return await permissionsALS.run(ctx, fn);
}
function configureLiquidWithExtensions(liquid) {
  liquid.registerTag("readfile", ReadFileTag);
  liquid.registerFilter("parse_json", (value) => {
    if (typeof value !== "string") {
      return value;
    }
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  });
  liquid.registerFilter("to_json", (value) => {
    try {
      return JSON.stringify(value);
    } catch {
      return "[Error: Unable to serialize to JSON]";
    }
  });
  liquid.registerFilter("base64", (value) => {
    if (value == null) return "";
    const str = String(value);
    return Buffer.from(str).toString("base64");
  });
  liquid.registerFilter("base64_decode", (value) => {
    if (value == null) return "";
    const str = String(value);
    try {
      return Buffer.from(str, "base64").toString("utf-8");
    } catch {
      return "[Error: Invalid base64 string]";
    }
  });
  liquid.registerFilter("safe_label", (value) => sanitizeLabel(value));
  liquid.registerFilter("safe_label_list", (value) => sanitizeLabelList(value));
  liquid.registerFilter("unescape_newlines", (value) => {
    if (value == null) return "";
    const s = String(value);
    return s.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "	");
  });
  liquid.registerFilter("json_escape", (value) => {
    if (value == null) return "";
    const s = String(value);
    const jsonStr = JSON.stringify(s);
    return jsonStr.slice(1, -1);
  });
  liquid.registerFilter("shell_escape", (value) => {
    if (value == null) return "''";
    const s = String(value);
    return "'" + s.replace(/'/g, "'\\''") + "'";
  });
  liquid.registerFilter("escape_shell", (value) => {
    if (value == null) return "''";
    const s = String(value);
    return "'" + s.replace(/'/g, "'\\''") + "'";
  });
  liquid.registerFilter("shell_escape_double", (value) => {
    if (value == null) return '""';
    const s = String(value);
    const escaped = s.replace(/\\/g, "\\\\").replace(/\$/g, "\\$").replace(/`/g, "\\`").replace(/"/g, '\\"').replace(/!/g, "\\!");
    return '"' + escaped + '"';
  });
  const isLocal = detectLocalMode();
  const resolveAssoc = (val) => {
    if (typeof val === "string" && val.length > 0) return val;
    const store = permissionsALS.getStore();
    return store?.authorAssociation;
  };
  liquid.registerFilter("has_min_permission", (authorAssociation, level) => {
    return hasMinPermission(resolveAssoc(authorAssociation), level, isLocal);
  });
  liquid.registerFilter("is_owner", (authorAssociation) => {
    return isOwner(resolveAssoc(authorAssociation), isLocal);
  });
  liquid.registerFilter("is_member", (authorAssociation) => {
    return isMember(resolveAssoc(authorAssociation), isLocal);
  });
  liquid.registerFilter("is_collaborator", (authorAssociation) => {
    return isCollaborator(resolveAssoc(authorAssociation), isLocal);
  });
  liquid.registerFilter("is_contributor", (authorAssociation) => {
    return isContributor(resolveAssoc(authorAssociation), isLocal);
  });
  liquid.registerFilter("is_first_timer", (authorAssociation) => {
    return isFirstTimer(resolveAssoc(authorAssociation), isLocal);
  });
  const memoryStore = MemoryStore.getInstance();
  liquid.registerFilter("memory_get", (key, namespace) => {
    if (typeof key !== "string") {
      return void 0;
    }
    return memoryStore.get(key, namespace);
  });
  liquid.registerFilter("memory_has", (key, namespace) => {
    if (typeof key !== "string") {
      return false;
    }
    const has = memoryStore.has(key, namespace);
    try {
      if (process.env.VISOR_DEBUG === "true" && key === "fact_validation_issues") {
        console.error(
          `[liquid] memory_has('${key}', ns='${namespace || memoryStore.getDefaultNamespace()}') => ${String(
            has
          )}`
        );
      }
    } catch {
    }
    return has;
  });
  liquid.registerFilter("memory_list", (namespace) => {
    return memoryStore.list(namespace);
  });
  liquid.registerFilter("get", (obj, pathExpr) => {
    if (obj == null) return void 0;
    const path2 = typeof pathExpr === "string" ? pathExpr : String(pathExpr || "");
    if (!path2) return obj;
    const parts = path2.split(".");
    let cur = obj;
    for (const p of parts) {
      if (cur == null) return void 0;
      cur = cur[p];
    }
    return cur;
  });
  liquid.registerFilter("not_empty", (v) => {
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "string") return v.length > 0;
    if (v && typeof v === "object") return Object.keys(v).length > 0;
    return false;
  });
  liquid.registerFilter("coalesce", (first, ...rest) => {
    const all = [first, ...rest];
    for (const v of all) {
      if (Array.isArray(v) && v.length > 0) return v;
      if (typeof v === "string" && v.length > 0) return v;
      if (v && typeof v === "object" && Object.keys(v).length > 0) return v;
    }
    return Array.isArray(first) ? [] : first ?? void 0;
  });
  liquid.registerFilter("where_exp", (items, varName, expr) => {
    const arr = Array.isArray(items) ? items : [];
    const name = typeof varName === "string" && varName.trim() ? varName.trim() : "i";
    const body = String(expr || "");
    try {
      const sandbox = createSecureSandbox();
      const out = [];
      for (let idx = 0; idx < arr.length; idx++) {
        const item = arr[idx];
        let ok = false;
        try {
          const scope = { [name]: item, idx, arr };
          ok = !!compileAndRun(sandbox, body, scope, {
            injectLog: false,
            wrapFunction: true
          });
        } catch {
          ok = false;
        }
        if (ok) out.push(item);
      }
      return out;
    } catch {
      return [];
    }
  });
  liquid.registerFilter(
    "chat_history",
    function(value, ...args) {
      try {
        const impl = this;
        const ctx = impl?.context;
        const allArgs = Array.isArray(args) ? args : [];
        if (allArgs.length === 0) {
          return [];
        }
        const positional = [];
        const options = {};
        for (const arg of allArgs) {
          if (Array.isArray(arg) && arg.length === 2 && typeof arg[0] === "string" && arg[0].length > 0) {
            options[arg[0]] = arg[1];
          } else {
            positional.push(arg);
          }
        }
        const stepArgs = positional;
        const steps = stepArgs.map((s) => String(s ?? "").trim()).filter((s) => s.length > 0);
        if (steps.length === 0) return [];
        const outputsHistoryVar = ctx?.get(["outputs_history"]) || {};
        const outputsVar = ctx?.get(["outputs"]) || {};
        const outputsHistory = outputsHistoryVar && Object.keys(outputsHistoryVar).length > 0 ? outputsHistoryVar : outputsVar?.history || {};
        const checksMeta = ctx?.get(["checks_meta"]) || ctx?.get(["event"])?.payload?.__checksMeta || void 0;
        const directionRaw = typeof options.direction === "string" ? options.direction.toLowerCase() : "";
        const direction = directionRaw === "desc" ? "desc" : "asc";
        const limit = typeof options.limit === "number" && options.limit > 0 ? Math.floor(options.limit) : void 0;
        const textCfg = options.text && typeof options.text === "object" ? options.text : {};
        const defaultField = typeof textCfg.default_field === "string" && textCfg.default_field.trim() ? textCfg.default_field.trim() : "text";
        const byStepText = {};
        if (textCfg.by_step && typeof textCfg.by_step === "object") {
          for (const [k, v] of Object.entries(textCfg.by_step)) {
            if (typeof v === "string" && v.trim()) {
              byStepText[k] = v.trim();
            }
          }
        }
        const rolesCfg = options.roles && typeof options.roles === "object" ? options.roles : {};
        const byTypeRole = {};
        if (rolesCfg.by_type && typeof rolesCfg.by_type === "object") {
          for (const [k, v] of Object.entries(rolesCfg.by_type)) {
            if (typeof v === "string" && v.trim()) {
              byTypeRole[k] = v.trim();
            }
          }
        }
        const byStepRole = {};
        if (rolesCfg.by_step && typeof rolesCfg.by_step === "object") {
          for (const [k, v] of Object.entries(rolesCfg.by_step)) {
            if (typeof v === "string" && v.trim()) {
              byStepRole[k] = v.trim();
            }
          }
        }
        if (typeof options.role_map === "string" && options.role_map.trim().length > 0) {
          const parts = String(options.role_map).split(",").map((p) => p.trim()).filter(Boolean);
          for (const part of parts) {
            const eqIdx = part.indexOf("=");
            if (eqIdx > 0) {
              const k = part.slice(0, eqIdx).trim();
              const v = part.slice(eqIdx + 1).trim();
              if (k && v) {
                byStepRole[k] = v;
              }
            }
          }
        }
        const defaultRole = typeof rolesCfg.default === "string" && rolesCfg.default.trim() ? rolesCfg.default.trim() : void 0;
        const getNested = (obj, path2) => {
          if (!obj || !path2) return void 0;
          const parts = path2.split(".");
          let cur = obj;
          for (const p of parts) {
            if (cur == null) return void 0;
            cur = cur[p];
          }
          return cur;
        };
        const normalizeText = (step, raw) => {
          try {
            const overrideField = byStepText[step];
            if (overrideField) {
              const val = getNested(raw, overrideField);
              if (val !== void 0 && val !== null) {
                const s = String(val);
                if (s.trim().length > 0) return s;
              }
            }
            if (raw && typeof raw === "object") {
              if (typeof raw.text === "string" && raw.text.trim().length > 0) {
                return raw.text;
              }
              if (typeof raw.content === "string" && raw.content.trim().length > 0) {
                return raw.content;
              }
              const dfVal = raw[defaultField];
              if (dfVal !== void 0 && dfVal !== null) {
                const s = String(dfVal);
                if (s.trim().length > 0) return s;
              }
            }
            if (typeof raw === "string") return raw;
            if (raw == null) return "";
            try {
              return JSON.stringify(raw);
            } catch {
              return String(raw);
            }
          } catch {
            if (typeof raw === "string") return raw;
            return "";
          }
        };
        const normalizeRole = (step) => {
          try {
            if (byStepRole[step]) return byStepRole[step];
            const meta = checksMeta ? checksMeta[step] : void 0;
            const type = meta?.type;
            if (type && byTypeRole[type]) return byTypeRole[type];
            if (type === "human-input") return "user";
            if (type === "ai") return "assistant";
            if (defaultRole) return defaultRole;
            if (type) {
              if (type === "human-input") return "user";
              if (type === "ai") return "assistant";
            }
          } catch {
          }
          return "assistant";
        };
        const messages = [];
        const tsBase = Date.now();
        let counter = 0;
        for (const step of steps) {
          const arr = outputsHistory?.[step];
          if (!Array.isArray(arr)) continue;
          for (const raw of arr) {
            let ts;
            if (raw && typeof raw === "object" && typeof raw.ts === "number") {
              ts = raw.ts;
            }
            if (!Number.isFinite(ts)) {
              ts = tsBase + counter++;
            }
            const text = normalizeText(step, raw);
            const role = normalizeRole(step);
            messages.push({ step, role, text, ts, raw });
          }
        }
        messages.sort((a, b) => a.ts - b.ts);
        if (direction === "desc") {
          messages.reverse();
        }
        if (limit && limit > 0 && messages.length > limit) {
          if (direction === "asc") {
            return messages.slice(messages.length - limit);
          }
          return messages.slice(0, limit);
        }
        return messages;
      } catch {
        return [];
      }
    }
  );
}
function createExtendedLiquid(options = {}) {
  const liquid = new Liquid({
    cache: false,
    strictFilters: false,
    strictVariables: false,
    ...options
  });
  configureLiquidWithExtensions(liquid);
  return liquid;
}
var ReadFileTag, permissionsALS;
var init_liquid_extensions = __esm({
  "src/liquid-extensions.ts"() {
    init_author_permissions();
    init_memory_store();
    init_sandbox();
    ReadFileTag = class extends Tag {
      filepath;
      constructor(token, remainTokens, liquid) {
        super(token, remainTokens, liquid);
        this.filepath = new Value(token.args, liquid);
      }
      *render(ctx, emitter) {
        const filePath = yield this.filepath.value(ctx, false);
        if (!filePath || typeof filePath !== "string") {
          emitter.write("[Error: Invalid file path]");
          return;
        }
        const projectRoot = process.cwd();
        const resolvedPath = path.resolve(projectRoot, filePath.toString());
        if (!resolvedPath.startsWith(projectRoot)) {
          emitter.write("[Error: File path escapes project directory]");
          return;
        }
        try {
          const content = yield fs.readFile(resolvedPath, "utf-8");
          emitter.write(content);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : error?.code || "Unknown error";
          emitter.write(`[Error reading file: ${errorMessage}]`);
        }
      }
    };
    permissionsALS = new AsyncLocalStorage();
  }
});

export {
  sanitizeLabel,
  sanitizeLabelList,
  ReadFileTag,
  withPermissionsContext,
  configureLiquidWithExtensions,
  createExtendedLiquid,
  init_liquid_extensions
};
//# sourceMappingURL=chunk-2N2X56PO.mjs.map