import Sandbox from '@nyariv/sandboxjs';

/**
 * Centralized helpers for creating and using SandboxJS instances consistently
 * across providers. The goal is to have one place to define allowed globals
 * and prototype whitelists, and to offer a small helper to inject a `log`
 * utility inside user-provided JS snippets.
 */

export interface CompileOptions {
  injectLog?: boolean;
  logPrefix?: string;
  /** When true, wrap the code in a function and `return` its result */
  wrapFunction?: boolean;
}

/**
 * Create a hardened Sandbox with a consistent set of globals and prototype
 * whitelists. This is a superset of the sets previously used by individual
 * providers, kept intentionally minimal and side‑effect free.
 */
export function createSecureSandbox(): Sandbox {
  const globals = {
    ...Sandbox.SAFE_GLOBALS,
    Math,
    JSON,
    // Provide console with limited surface. Calls are harmless in CI logs and
    // help with debugging value_js / transform_js expressions.
    console: {
      log: console.log,
      warn: console.warn,
      error: console.error,
    },
  } as Record<string, unknown>;

  const prototypeWhitelist = new Map(Sandbox.SAFE_PROTOTYPES);

  // Arrays — union of methods used around the codebase
  const arrayMethods = new Set<string>([
    // Query/iteration
    'some',
    'every',
    'filter',
    'map',
    'reduce',
    'reduceRight',
    'find',
    'findIndex',
    'findLast',
    'findLastIndex',
    'includes',
    'indexOf',
    'lastIndexOf',
    'keys',
    'values',
    'entries',
    'forEach',
    // Non‑mutating ES2023 additions
    'toReversed',
    'toSorted',
    'toSpliced',
    'with',
    'at',
    // Mutators and common ops
    'slice',
    'concat',
    'join',
    'push',
    'pop',
    'shift',
    'unshift',
    'sort',
    'reverse',
    'copyWithin',
    'fill',
    // Flattening
    'flat',
    'flatMap',
    // Meta
    'length',
  ]);
  prototypeWhitelist.set(Array.prototype, arrayMethods);

  // Strings — allow common, safe manipulation helpers
  const stringMethods = new Set<string>([
    'toLowerCase',
    'toUpperCase',
    'includes',
    'indexOf',
    'lastIndexOf',
    'startsWith',
    'endsWith',
    'slice',
    'substring',
    'substr',
    'trim',
    'trimStart',
    'trimEnd',
    'split',
    'replace',
    'replaceAll',
    'match',
    'matchAll',
    'charAt',
    'charCodeAt',
    'codePointAt',
    'normalize',
    'repeat',
    'padStart',
    'padEnd',
    'at',
    'length',
  ]);
  prototypeWhitelist.set(String.prototype, stringMethods);

  // Objects — keep to basic safe operations
  const objectMethods = new Set<string>([
    'hasOwnProperty',
    'propertyIsEnumerable',
    'toString',
    'valueOf',
  ]);
  prototypeWhitelist.set(Object.prototype, objectMethods);

  // Keep native constructors from SAFE_GLOBALS; rely on prototype whitelists above.

  // Maps and Sets — allow common, safe operations
  const mapMethods = new Set<string>([
    'get',
    'set',
    'has',
    'delete',
    'entries',
    'keys',
    'values',
    'forEach',
  ]);
  // @ts-ignore - sandbox typings accept Map.prototype as a key
  prototypeWhitelist.set((Map as any).prototype, mapMethods);

  const setMethods = new Set<string>([
    'add',
    'has',
    'delete',
    'entries',
    'keys',
    'values',
    'forEach',
  ]);
  // @ts-ignore
  prototypeWhitelist.set((Set as any).prototype, setMethods);

  // Date and RegExp — read‑only helpers
  const dateMethods = new Set<string>(['toISOString', 'toJSON', 'getTime']);
  // @ts-ignore
  prototypeWhitelist.set((Date as any).prototype, dateMethods);

  const regexpMethods = new Set<string>(['test', 'exec']);
  // @ts-ignore
  prototypeWhitelist.set((RegExp as any).prototype, regexpMethods);

  return new Sandbox({ globals, prototypeWhitelist });
}

/**
 * Compile and execute user-provided JS inside the sandbox with optional
 * helper injection. By default, code is wrapped in a function to keep the
 * global scope clean.
 */
export function compileAndRun<T = unknown>(
  sandbox: Sandbox,
  userCode: string,
  scope: Record<string, unknown>,
  opts: CompileOptions = { injectLog: true, wrapFunction: true, logPrefix: '[sandbox]' }
): T {
  const inject = opts?.injectLog === true;
  let safePrefix = String(opts?.logPrefix ?? '[sandbox]');
  // Sanitize prefix aggressively: drop control chars and risky tokens, limit length
  safePrefix = safePrefix
    .replace(/[\r\n\t\0]/g, '')
    .replace(/[`$\\]/g, '') // strip backticks, dollar (template) and backslashes
    .replace(/\$\{/g, '') // remove template openings if present
    .slice(0, 64);
  // Build a safe header without string concatenation inside user code
  const header = inject
    ? `const __lp = ${JSON.stringify(safePrefix)}; const log = (...a) => { try { console.log(__lp, ...a); } catch {} };\n`
    : '';
  const body = opts.wrapFunction
    ? `const __fn = () => {\n${userCode}\n};\nreturn __fn();\n`
    : `${userCode}`;
  const code = `${header}${body}`;
  let exec: ReturnType<typeof sandbox.compile>;
  try {
    exec = sandbox.compile(code);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`sandbox_compile_error: ${msg}`);
  }

  let out: any;
  try {
    out = exec(scope);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`sandbox_execution_error: ${msg}`);
  }

  if (out && typeof out.run === 'function') {
    try {
      return out.run();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`sandbox_runner_error: ${msg}`);
    }
  }
  return out as T;
}
