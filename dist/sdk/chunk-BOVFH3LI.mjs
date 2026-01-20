import {
  __esm
} from "./chunk-WMJKH4XE.mjs";

// src/utils/sandbox.ts
import Sandbox from "@nyariv/sandboxjs";
function validateJsSyntax(code) {
  if (!code || typeof code !== "string") {
    return { valid: false, error: "Code must be a non-empty string" };
  }
  const trimmed = code.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: "Code cannot be empty" };
  }
  const sandbox = createSecureSandbox();
  const looksLikeBlock = /\breturn\b/.test(trimmed) || /;/.test(trimmed) || /\n/.test(trimmed);
  const looksLikeIife = /\)\s*\(\s*\)\s*;?$/.test(trimmed);
  const body = looksLikeBlock ? looksLikeIife ? `return (
${trimmed}
);
` : `return (() => {
${trimmed}
})();
` : `return (
${trimmed}
);
`;
  const header = `const __lp = "[syntax-check]"; const log = (...a) => { try { console.log(__lp, ...a); } catch {} };
`;
  const fullCode = `${header}${body}`;
  try {
    sandbox.compile(fullCode);
    return { valid: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { valid: false, error: msg };
  }
}
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

export {
  validateJsSyntax,
  createSecureSandbox,
  compileAndRun,
  init_sandbox
};
//# sourceMappingURL=chunk-BOVFH3LI.mjs.map