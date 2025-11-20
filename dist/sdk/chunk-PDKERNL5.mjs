import {
  detectLocalMode,
  hasMinPermission,
  init_author_permissions,
  isCollaborator,
  isContributor,
  isFirstTimer,
  isMember,
  isOwner
} from "./chunk-CNX7V5JK.mjs";
import {
  MemoryStore,
  init_memory_store
} from "./chunk-A7MRMUDG.mjs";
import {
  __esm
} from "./chunk-WMJKH4XE.mjs";

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
  liquid.registerFilter("safe_label", (value) => sanitizeLabel(value));
  liquid.registerFilter("safe_label_list", (value) => sanitizeLabelList(value));
  liquid.registerFilter("unescape_newlines", (value) => {
    if (value == null) return "";
    const s = String(value);
    return s.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "	");
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
      const fn = new Function(
        name,
        "idx",
        "arr",
        `try { return (${body}); } catch { return false; }`
      );
      const out = [];
      for (let idx = 0; idx < arr.length; idx++) {
        const i = arr[idx];
        let ok = false;
        try {
          ok = !!fn(i, idx, arr);
        } catch {
          ok = false;
        }
        if (ok) out.push(i);
      }
      return out;
    } catch {
      return [];
    }
  });
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
//# sourceMappingURL=chunk-PDKERNL5.mjs.map