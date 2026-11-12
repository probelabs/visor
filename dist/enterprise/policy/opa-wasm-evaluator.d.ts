/**
 * Copyright (c) ProbeLabs. All rights reserved.
 * Licensed under the Elastic License 2.0; you may not use this file except
 * in compliance with the Elastic License 2.0.
 */
/**
 * OPA WASM Evaluator - loads and evaluates OPA policies locally.
 *
 * Supports three input formats:
 * 1. Pre-compiled `.wasm` bundle — loaded directly (fastest startup)
 * 2. `.rego` files or directory — auto-compiled to WASM via `opa build` CLI
 * 3. Directory with `policy.wasm` inside — loaded directly
 *
 * Compilation and caching of .rego files is delegated to {@link OpaCompiler}.
 *
 * Requires:
 * - `@open-policy-agent/opa-wasm` npm package (optional dep)
 * - `opa` CLI on PATH (only when auto-compiling .rego files)
 */
export declare class OpaWasmEvaluator {
    private policy;
    private dataDocument;
    private compiler;
    initialize(rulesPath: string | string[]): Promise<void>;
    /**
     * Load external data from a JSON file to use as the OPA data document.
     * The loaded data will be passed to `policy.setData()` during evaluation,
     * making it available in Rego via `data.<key>`.
     */
    loadData(dataPath: string): void;
    evaluate(input: object): Promise<any>;
    shutdown(): Promise<void>;
}
//# sourceMappingURL=opa-wasm-evaluator.d.ts.map