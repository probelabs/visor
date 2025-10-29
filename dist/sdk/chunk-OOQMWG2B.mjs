// src/liquid-extensions.ts
import { Liquid, Tag, Value } from "liquidjs";
import fs from "fs/promises";
import path from "path";

// src/utils/author-permissions.ts
var PERMISSION_HIERARCHY = [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "NONE"
];
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

// src/liquid-extensions.ts
var ReadFileTag = class extends Tag {
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
  const isLocal = detectLocalMode();
  liquid.registerFilter("has_min_permission", (authorAssociation, level) => {
    return hasMinPermission(authorAssociation, level, isLocal);
  });
  liquid.registerFilter("is_owner", (authorAssociation) => {
    return isOwner(authorAssociation, isLocal);
  });
  liquid.registerFilter("is_member", (authorAssociation) => {
    return isMember(authorAssociation, isLocal);
  });
  liquid.registerFilter("is_collaborator", (authorAssociation) => {
    return isCollaborator(authorAssociation, isLocal);
  });
  liquid.registerFilter("is_contributor", (authorAssociation) => {
    return isContributor(authorAssociation, isLocal);
  });
  liquid.registerFilter("is_first_timer", (authorAssociation) => {
    return isFirstTimer(authorAssociation, isLocal);
  });
  liquid.registerFilter("safe_label", (value) => {
    if (value == null) return "";
    const s = String(value);
    return s.replace(/[^A-Za-z0-9:\/]/g, "").replace(/\/{2,}/g, "/");
  });
  liquid.registerFilter("safe_label_list", (value) => {
    if (!Array.isArray(value)) return [];
    return value.map((v) => v == null ? "" : String(v)).map((s) => s.replace(/[^A-Za-z0-9:\/]/g, "").replace(/\/{2,}/g, "/")).filter((s) => s.length > 0);
  });
  liquid.registerFilter("unescape_newlines", (value) => {
    if (value == null) return "";
    const s = String(value);
    return s.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "	");
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

export {
  createPermissionHelpers,
  detectLocalMode,
  ReadFileTag,
  configureLiquidWithExtensions,
  createExtendedLiquid
};
//# sourceMappingURL=chunk-OOQMWG2B.mjs.map