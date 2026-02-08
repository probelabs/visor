/**
 * Copyright (c) ProbeLabs. All rights reserved.
 * Licensed under the Elastic License 2.0; you may not use this file except
 * in compliance with the Elastic License 2.0.
 */

import * as fs from 'fs';
import * as path from 'path';
import { OpaCompiler } from './opa-compiler';

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
export class OpaWasmEvaluator {
  private policy: any = null;
  private dataDocument: object = {};
  private compiler: OpaCompiler = new OpaCompiler();

  async initialize(rulesPath: string | string[]): Promise<void> {
    const paths = Array.isArray(rulesPath) ? rulesPath : [rulesPath];
    const wasmBytes = await this.compiler.resolveWasmBytes(paths);

    try {
      // Use createRequire to load the optional dep at runtime without ncc bundling it.
      // `new Function('id', 'return require(id)')` fails in ncc bundles because
      // `require` is not in the `new Function` scope. `createRequire` works correctly
      // because it creates a real Node.js require rooted at the given path.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createRequire } = require('module') as typeof import('module');
      const runtimeRequire = createRequire(__filename);
      const opaWasm = runtimeRequire('@open-policy-agent/opa-wasm');
      const loadPolicy = opaWasm.loadPolicy || opaWasm.default?.loadPolicy;
      if (!loadPolicy) {
        throw new Error('loadPolicy not found in @open-policy-agent/opa-wasm');
      }
      this.policy = await loadPolicy(wasmBytes);
    } catch (err: any) {
      if (err?.code === 'MODULE_NOT_FOUND' || err?.code === 'ERR_MODULE_NOT_FOUND') {
        throw new Error(
          'OPA WASM evaluator requires @open-policy-agent/opa-wasm. ' +
            'Install it with: npm install @open-policy-agent/opa-wasm'
        );
      }
      throw err;
    }
  }

  /**
   * Load external data from a JSON file to use as the OPA data document.
   * The loaded data will be passed to `policy.setData()` during evaluation,
   * making it available in Rego via `data.<key>`.
   */
  loadData(dataPath: string): void {
    const resolved = path.resolve(dataPath);
    if (path.normalize(resolved).includes('..')) {
      throw new Error(`Data path contains traversal sequences: ${dataPath}`);
    }
    if (!fs.existsSync(resolved)) {
      throw new Error(`OPA data file not found: ${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (stat.size > 10 * 1024 * 1024) {
      throw new Error(`OPA data file exceeds 10MB limit: ${resolved} (${stat.size} bytes)`);
    }
    const raw = fs.readFileSync(resolved, 'utf-8');
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('OPA data file must contain a JSON object (not an array or primitive)');
      }
      this.dataDocument = parsed;
    } catch (err: any) {
      if (err.message.startsWith('OPA data file must')) {
        throw err;
      }
      throw new Error(`Failed to parse OPA data file ${resolved}: ${err.message}`);
    }
  }

  async evaluate(input: object): Promise<any> {
    if (!this.policy) {
      throw new Error('OPA WASM evaluator not initialized');
    }

    this.policy.setData(this.dataDocument);
    const resultSet = this.policy.evaluate(input);

    if (Array.isArray(resultSet) && resultSet.length > 0) {
      return resultSet[0].result;
    }
    return undefined;
  }

  async shutdown(): Promise<void> {
    if (this.policy) {
      // opa-wasm policy objects may have a close/free method for WASM cleanup
      if (typeof this.policy.close === 'function') {
        try {
          this.policy.close();
        } catch {}
      } else if (typeof this.policy.free === 'function') {
        try {
          this.policy.free();
        } catch {}
      }
    }
    this.policy = null;
  }
}
