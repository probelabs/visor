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
    'some',
    'every',
    'filter',
    'map',
    'reduce',
    'find',
    'includes',
    'indexOf',
    'length',
    'slice',
    'concat',
    'join',
    'push',
    'pop',
    'shift',
    'unshift',
    'sort',
    'reverse',
    'flat',
    'flatMap',
  ]);
  prototypeWhitelist.set(Array.prototype, arrayMethods);

  // Strings — allow common, safe manipulation helpers
  const stringMethods = new Set<string>([
    'toLowerCase',
    'toUpperCase',
    'includes',
    'indexOf',
    'startsWith',
    'endsWith',
    'slice',
    'substring',
    'length',
    'trim',
    'split',
    'replace',
    'match',
    'padStart',
    'padEnd',
  ]);
  prototypeWhitelist.set(String.prototype, stringMethods);

  // Objects — keep to basic safe operations
  const objectMethods = new Set<string>([
    'hasOwnProperty',
    'toString',
    'valueOf',
    'keys',
    'values',
  ]);
  prototypeWhitelist.set(Object.prototype, objectMethods);

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
  // Sanitize prefix: drop control chars and limit length
  safePrefix = safePrefix.replace(/[\r\n\t\0]/g, '').slice(0, 64);
  // Build a safe header without string concatenation inside user code
  const header = inject
    ? `const __lp = ${JSON.stringify(safePrefix)}; const log = (...a) => { try { console.log(__lp, ...a); } catch {} };\n`
    : '';
  const body = opts.wrapFunction
    ? `const __fn = () => {\n${userCode}\n};\nreturn __fn();\n`
    : `${userCode}`;
  const code = `${header}${body}`;
  const exec = sandbox.compile(code);
  const out = exec(scope) as unknown as { run?: () => T } | T;
  if (out && typeof (out as any).run === 'function') {
    return (out as any).run();
  }
  return out as T;
}
