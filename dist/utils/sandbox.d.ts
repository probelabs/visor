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
export declare function createSecureSandbox(): Sandbox;
/**
 * Compile and execute user-provided JS inside the sandbox with optional
 * helper injection. By default, code is wrapped in a function to keep the
 * global scope clean.
 */
export declare function compileAndRun<T = unknown>(sandbox: Sandbox, userCode: string, scope: Record<string, unknown>, opts?: CompileOptions): T;
//# sourceMappingURL=sandbox.d.ts.map