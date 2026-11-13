/**
 * Copyright (c) ProbeLabs. All rights reserved.
 * Licensed under the Elastic License 2.0; you may not use this file except
 * in compliance with the Elastic License 2.0.
 */
/**
 * OPA Rego Compiler - compiles .rego policy files to WASM bundles using the `opa` CLI.
 *
 * Handles:
 * - Resolving input paths to WASM bytes (direct .wasm, directory with policy.wasm, or .rego files)
 * - Compiling .rego files to WASM via `opa build`
 * - Caching compiled bundles based on content hashes
 * - Extracting policy.wasm from OPA tar.gz bundles
 *
 * Requires:
 * - `opa` CLI on PATH (only when auto-compiling .rego files)
 */
export declare class OpaCompiler {
    private static CACHE_DIR;
    /**
     * Resolve the input paths to WASM bytes.
     *
     * Strategy:
     * 1. If any path is a .wasm file, read it directly
     * 2. If a directory contains policy.wasm, read it
     * 3. Otherwise, collect all .rego files and auto-compile via `opa build`
     */
    resolveWasmBytes(paths: string[]): Promise<Buffer>;
    /**
     * Auto-compile .rego files to a WASM bundle using the `opa` CLI.
     *
     * Caches the compiled bundle based on a content hash of all input .rego files
     * so subsequent runs skip compilation if policies haven't changed.
     */
    private compileRego;
}
//# sourceMappingURL=opa-compiler.d.ts.map