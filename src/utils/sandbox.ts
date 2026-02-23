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

export interface JsSyntaxValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate JavaScript syntax without executing it.
 * Uses the sandbox's compile method to check for syntax errors.
 * Returns validation result with error message if invalid.
 */
export function validateJsSyntax(code: string): JsSyntaxValidationResult {
  if (!code || typeof code !== 'string') {
    return { valid: false, error: 'Code must be a non-empty string' };
  }

  const trimmed = code.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'Code cannot be empty' };
  }

  // Create a minimal sandbox instance for syntax checking
  const sandbox = createSecureSandbox();

  // Wrap code similar to compileAndRun to catch the same syntax issues
  const looksLikeBlock = /\breturn\b/.test(trimmed) || /;/.test(trimmed) || /\n/.test(trimmed);
  const looksLikeIife = /\)\s*\(\s*\)\s*;?$/.test(trimmed);
  const body = looksLikeBlock
    ? looksLikeIife
      ? `return (\n${trimmed}\n);\n`
      : `return (() => {\n${trimmed}\n})();\n`
    : `return (\n${trimmed}\n);\n`;

  // For syntax validation, we just need to ensure 'log' is defined so code using it parses correctly
  // No need for unique IDs since validation creates a fresh sandbox and only compiles (no execution)
  const header = `var log = function() {};\n`;
  const fullCode = `${header}${body}`;

  try {
    sandbox.compile(fullCode);
    return { valid: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { valid: false, error: msg };
  }
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
    // Provide console with limited surface. Use trampolines so that any test
    // spies (e.g., jest.spyOn(console, 'log')) see calls made inside the sandbox.
    console: {
      log: (...args: unknown[]) => {
        try {
          (console as any).log(...args);
        } catch {}
      },
      warn: (...args: unknown[]) => {
        try {
          (console as any).warn(...args);
        } catch {}
      },
      error: (...args: unknown[]) => {
        try {
          (console as any).error(...args);
        } catch {}
      },
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
  // Inject log function through scope to avoid "already declared" errors
  // when multiple sandbox executions run in parallel with shared global state.
  // Only add log when injectLog is true - when false, user code may declare its own log.
  const scopeWithLog = inject
    ? {
        ...scope,
        log: (...args: unknown[]) => {
          try {
            console.log(safePrefix, ...args);
          } catch {}
        },
      }
    : scope;
  // No header needed - log is passed through scope
  const header = '';
  // When wrapping, execute user code inside an IIFE and return its value.
  // This reliably captures the value of the last expression or any explicit
  // return statements inside the script, without requiring the caller to
  // manually `return` at top level.
  // Wrapper heuristic:
  // - If the snippet contains an explicit `return`, semicolons or newlines (likely a block),
  //   run it inside an IIFE so `return` works:  (() => { code })()
  // - Otherwise treat it as a pure expression and return its value directly.
  const src = String(userCode);
  const looksLikeBlock = /\breturn\b/.test(src) || /;/.test(src) || /\n/.test(src);
  // Heuristic: if the snippet itself looks like an IIFE/callable expression
  // (e.g., `(() => { ... })()` or `(function(){ ... })()`), return its value
  // directly to avoid swallowing the result by nesting it inside another block.
  const looksLikeIife = /\)\s*\(\s*\)\s*;?$/.test(src.trim());
  // Default wrapFunction to true if not explicitly set to false
  const shouldWrap = opts.wrapFunction !== false;
  const body = shouldWrap
    ? looksLikeBlock
      ? looksLikeIife
        ? `return (\n${src}\n);\n`
        : `return (() => {\n${src}\n})();\n`
      : `return (\n${src}\n);\n`
    : `${src}`;
  const code = `${header}${body}`;

  // Create code preview for error messages (first 100 chars, single line)
  const codePreview = src.replace(/\s+/g, ' ').trim().slice(0, 100);
  const contextInfo = safePrefix !== '[sandbox]' ? ` [${safePrefix}]` : '';

  let exec: ReturnType<typeof sandbox.compile>;
  try {
    exec = sandbox.compile(code);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`sandbox_compile_error${contextInfo}: ${msg} | code: ${codePreview}`);
  }

  let out: any;
  try {
    out = exec(scopeWithLog);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`sandbox_execution_error${contextInfo}: ${msg} | code: ${codePreview}`);
  }

  if (out && typeof out.run === 'function') {
    try {
      return out.run();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`sandbox_runner_error${contextInfo}: ${msg} | code: ${codePreview}`);
    }
  }
  return out as T;
}

/**
 * Compile and execute user-provided JS with async support.
 *
 * Uses sandbox.compileAsync() + .run() (same pattern as Probe's DSL runtime).
 * The code must already be transformed (async IIFE wrapped) by the caller —
 * this function does NOT apply wrapping heuristics like compileAndRun does.
 */
export async function compileAndRunAsync<T = unknown>(
  sandbox: Sandbox,
  transformedCode: string,
  scope: Record<string, unknown>,
  opts: CompileOptions = { injectLog: true, logPrefix: '[async-sandbox]' }
): Promise<T> {
  const inject = opts?.injectLog === true;
  let safePrefix = String(opts?.logPrefix ?? '[async-sandbox]');
  safePrefix = safePrefix
    .replace(/[\r\n\t\0]/g, '')
    .replace(/[`$\\]/g, '')
    .replace(/\$\{/g, '')
    .slice(0, 64);

  const scopeWithLog = inject
    ? {
        ...scope,
        log: (...args: unknown[]) => {
          try {
            console.log(safePrefix, ...args);
          } catch {}
        },
      }
    : scope;

  const codePreview = transformedCode.replace(/\s+/g, ' ').trim().slice(0, 100);
  const contextInfo = safePrefix !== '[async-sandbox]' ? ` [${safePrefix}]` : '';

  let exec: ReturnType<typeof sandbox.compileAsync>;
  try {
    exec = sandbox.compileAsync(transformedCode);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`async_sandbox_compile_error${contextInfo}: ${msg} | code: ${codePreview}`);
  }

  try {
    const result = await exec(scopeWithLog).run();
    return result as T;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`async_sandbox_execution_error${contextInfo}: ${msg} | code: ${codePreview}`);
  }
}
