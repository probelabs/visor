/**
 * Copyright (c) ProbeLabs. All rights reserved.
 * Licensed under the Elastic License 2.0; you may not use this file except
 * in compliance with the Elastic License 2.0.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';

/**
 * OPA WASM Evaluator - loads and evaluates OPA policies locally.
 *
 * Supports three input formats:
 * 1. Pre-compiled `.wasm` bundle — loaded directly (fastest startup)
 * 2. `.rego` files or directory — auto-compiled to WASM via `opa build` CLI
 * 3. Directory with `policy.wasm` inside — loaded directly
 *
 * Requires:
 * - `@open-policy-agent/opa-wasm` npm package (optional dep)
 * - `opa` CLI on PATH (only when auto-compiling .rego files)
 */
export class OpaWasmEvaluator {
  private policy: any = null;
  private dataDocument: object = {};
  private static CACHE_DIR = path.join(os.tmpdir(), 'visor-opa-cache');

  async initialize(rulesPath: string | string[]): Promise<void> {
    const paths = Array.isArray(rulesPath) ? rulesPath : [rulesPath];
    const wasmBytes = await this.resolveWasmBytes(paths);

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
    if (!fs.existsSync(resolved)) {
      throw new Error(`OPA data file not found: ${resolved}`);
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
    this.policy = null;
  }

  /**
   * Resolve the input paths to WASM bytes.
   *
   * Strategy:
   * 1. If any path is a .wasm file, read it directly
   * 2. If a directory contains policy.wasm, read it
   * 3. Otherwise, collect all .rego files and auto-compile via `opa build`
   */
  private async resolveWasmBytes(paths: string[]): Promise<Buffer> {
    // Collect .rego files and check for existing .wasm
    const regoFiles: string[] = [];

    for (const p of paths) {
      const resolved = path.resolve(p);
      // Reject paths containing '..' after resolution (path traversal)
      if (path.normalize(resolved).includes('..')) {
        throw new Error(`Policy path contains traversal sequences: ${p}`);
      }

      // Direct .wasm file
      if (resolved.endsWith('.wasm') && fs.existsSync(resolved)) {
        return fs.readFileSync(resolved);
      }

      if (!fs.existsSync(resolved)) continue;
      const stat = fs.statSync(resolved);

      if (stat.isDirectory()) {
        // Check for pre-compiled policy.wasm in directory
        const wasmCandidate = path.join(resolved, 'policy.wasm');
        if (fs.existsSync(wasmCandidate)) {
          return fs.readFileSync(wasmCandidate);
        }
        // Collect all .rego files from directory
        const files = fs.readdirSync(resolved);
        for (const f of files) {
          if (f.endsWith('.rego')) {
            regoFiles.push(path.join(resolved, f));
          }
        }
      } else if (resolved.endsWith('.rego')) {
        regoFiles.push(resolved);
      }
    }

    if (regoFiles.length === 0) {
      throw new Error(
        `OPA WASM evaluator: no .wasm bundle or .rego files found in: ${paths.join(', ')}`
      );
    }

    // Auto-compile .rego → .wasm
    return this.compileRego(regoFiles);
  }

  /**
   * Auto-compile .rego files to a WASM bundle using the `opa` CLI.
   *
   * Caches the compiled bundle based on a content hash of all input .rego files
   * so subsequent runs skip compilation if policies haven't changed.
   */
  private compileRego(regoFiles: string[]): Buffer {
    // Check that `opa` CLI is available
    try {
      execFileSync('opa', ['version'], { stdio: 'pipe' });
    } catch {
      throw new Error(
        'OPA CLI (`opa`) not found on PATH. Install it from https://www.openpolicyagent.org/docs/latest/#running-opa\n' +
          'Or pre-compile your .rego files: opa build -t wasm -e visor -o bundle.tar.gz ' +
          regoFiles.join(' ')
      );
    }

    // Compute content hash for cache key
    const hash = crypto.createHash('sha256');
    for (const f of regoFiles.sort()) {
      hash.update(fs.readFileSync(f));
      hash.update(f); // include filename for disambiguation
    }
    const cacheKey = hash.digest('hex').slice(0, 16);
    const cacheDir = OpaWasmEvaluator.CACHE_DIR;
    const cachedWasm = path.join(cacheDir, `${cacheKey}.wasm`);

    // Return cached bundle if still valid
    if (fs.existsSync(cachedWasm)) {
      return fs.readFileSync(cachedWasm);
    }

    // Compile to WASM via opa build
    fs.mkdirSync(cacheDir, { recursive: true });
    const bundleTar = path.join(cacheDir, `${cacheKey}-bundle.tar.gz`);

    try {
      const args = [
        'build',
        '-t',
        'wasm',
        '-e',
        'visor', // entrypoint: the visor package tree
        '-o',
        bundleTar,
        ...regoFiles,
      ];
      execFileSync('opa', args, {
        stdio: 'pipe',
        timeout: 30000,
      });
    } catch (err: any) {
      const stderr = err?.stderr?.toString() || '';
      throw new Error(
        `Failed to compile .rego files to WASM:\n${stderr}\n` +
          'Ensure your .rego files are valid and the `opa` CLI is installed.'
      );
    }

    // Extract policy.wasm from the tar.gz bundle
    // OPA bundles are tar.gz with /policy.wasm inside
    try {
      execFileSync('tar', ['-xzf', bundleTar, '-C', cacheDir, '/policy.wasm'], {
        stdio: 'pipe',
      });
      const extractedWasm = path.join(cacheDir, 'policy.wasm');
      if (fs.existsSync(extractedWasm)) {
        // Move to cache-key named file
        fs.renameSync(extractedWasm, cachedWasm);
      }
    } catch {
      // Some tar implementations don't like leading /
      try {
        execFileSync('tar', ['-xzf', bundleTar, '-C', cacheDir, 'policy.wasm'], {
          stdio: 'pipe',
        });
        const extractedWasm = path.join(cacheDir, 'policy.wasm');
        if (fs.existsSync(extractedWasm)) {
          fs.renameSync(extractedWasm, cachedWasm);
        }
      } catch (err2: any) {
        throw new Error(`Failed to extract policy.wasm from OPA bundle: ${err2?.message || err2}`);
      }
    }

    // Clean up tar
    try {
      fs.unlinkSync(bundleTar);
    } catch {}

    if (!fs.existsSync(cachedWasm)) {
      throw new Error('OPA build succeeded but policy.wasm was not found in the bundle');
    }

    return fs.readFileSync(cachedWasm);
  }
}
