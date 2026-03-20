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
export class OpaCompiler {
  private static CACHE_DIR = path.join(os.tmpdir(), 'visor-opa-cache');

  /**
   * Resolve the input paths to WASM bytes.
   *
   * Strategy:
   * 1. If any path is a .wasm file, read it directly
   * 2. If a directory contains policy.wasm, read it
   * 3. Otherwise, collect all .rego files and auto-compile via `opa build`
   */
  async resolveWasmBytes(paths: string[]): Promise<Buffer> {
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

    // Auto-compile .rego -> .wasm
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
    const cacheDir = OpaCompiler.CACHE_DIR;
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
