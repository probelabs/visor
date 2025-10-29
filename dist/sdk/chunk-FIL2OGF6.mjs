// src/liquid-extensions.ts
import { Liquid, Tag, Value } from "liquidjs";
import fs from "fs/promises";
import path from "path";
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
  ReadFileTag,
  configureLiquidWithExtensions,
  createExtendedLiquid
};
//# sourceMappingURL=chunk-FIL2OGF6.mjs.map