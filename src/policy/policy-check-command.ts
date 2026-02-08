/**
 * Policy-check CLI subcommand implementation.
 *
 * Validates Rego policy files for syntax and WASM compatibility.
 * Optionally evaluates against sample input JSON.
 *
 * MIT License — this is an OSS module.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../config';

// ─── Argument Parsing ────────────────────────────────────────────────────────

export interface PolicyCheckArgs {
  rulesPath: string | string[] | undefined;
  inputFile: string | undefined;
  verbose: boolean;
  configPath: string | undefined;
}

/**
 * Parse raw CLI argv into structured PolicyCheckArgs.
 * Does NOT resolve rulesPath from config — that is a separate async step.
 */
export function parsePolicyCheckArgs(argv: string[]): PolicyCheckArgs {
  const args = argv.slice(3); // skip node, script, 'policy-check'

  const getArg = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const hasFlag = (name: string): boolean => args.includes(name);

  const configPath = getArg('--config');
  const inputFile = getArg('--input');
  const verbose = hasFlag('--verbose') || hasFlag('-v');

  // Check for positional argument (first non-flag arg)
  let rulesPath: string | undefined;
  const flagsWithValues = new Set(['--config', '--input']);
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token.startsWith('-')) {
      if (flagsWithValues.has(token)) i++; // skip the value
      continue;
    }
    rulesPath = token;
    break;
  }

  return { rulesPath, inputFile, verbose, configPath };
}

/**
 * If no positional rules path was provided, try to resolve it from config.
 */
export async function resolveRulesPathFromConfig(
  args: PolicyCheckArgs
): Promise<string | string[] | undefined> {
  if (args.rulesPath) return args.rulesPath;

  try {
    const configManager = new ConfigManager();
    let config;
    if (args.configPath) {
      config = await configManager.loadConfig(args.configPath);
    } else {
      config = await configManager.findAndLoadConfig().catch(() => null);
    }
    if (config?.policy?.rules) {
      return config.policy.rules;
    }
  } catch {
    // Config loading failed
  }

  return undefined;
}

// ─── OPA CLI Discovery ──────────────────────────────────────────────────────

export interface ExecFileSync {
  (file: string, args: string[], options?: { stdio?: string; timeout?: number }): Buffer;
}

/**
 * Check that `opa` CLI is available on PATH and print its version.
 * Returns the execFileSync function for subsequent use, or calls process.exit(1).
 */
export async function verifyOpaCli(verbose: boolean): Promise<ExecFileSync> {
  const { execFileSync } = await import('child_process');

  try {
    const opaVersionOut = execFileSync('opa', ['version'], { stdio: 'pipe' }).toString().trim();
    const firstLine = opaVersionOut.split('\n')[0] || opaVersionOut;
    console.log(`OPA CLI: ${firstLine}`);
    if (verbose) {
      console.log(`OPA version details:\n${opaVersionOut}`);
    }
  } catch {
    console.error('Error: OPA CLI (`opa`) not found on PATH.');
    console.error('');
    console.error('Install it from https://www.openpolicyagent.org/docs/latest/#running-opa');
    console.error('');
    console.error('  macOS:  brew install opa');
    console.error('  Linux:  curl -L -o /usr/local/bin/opa \\');
    console.error(
      '            https://openpolicyagent.org/downloads/latest/opa_linux_amd64_static'
    );
    console.error('          chmod +x /usr/local/bin/opa');
    process.exit(1);
  }

  return execFileSync as unknown as ExecFileSync;
}

// ─── Rego File Resolution ───────────────────────────────────────────────────

/**
 * Resolve all .rego files from the provided path(s).
 * If a .wasm file is encountered, prints a message and exits with 0.
 * Returns the list of resolved .rego file paths.
 */
export function resolveRegoFiles(rulesPath: string | string[]): string[] {
  const pathsList = Array.isArray(rulesPath) ? rulesPath : [rulesPath];
  const regoFiles: string[] = [];

  for (const p of pathsList) {
    const resolved = path.resolve(p);
    if (!fs.existsSync(resolved)) {
      console.error(`Error: Path not found: ${resolved}`);
      process.exit(1);
    }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      const files = fs.readdirSync(resolved);
      for (const f of files) {
        if (f.endsWith('.rego')) {
          regoFiles.push(path.join(resolved, f));
        }
      }
    } else if (resolved.endsWith('.rego')) {
      regoFiles.push(resolved);
    } else if (resolved.endsWith('.wasm')) {
      console.log(`\nPath is a pre-compiled WASM bundle: ${resolved}`);
      console.log('Skipping syntax and compilation checks (already compiled).');
      console.log('\nResult: PASS (pre-compiled WASM)');
      process.exit(0);
    }
  }

  return regoFiles;
}

// ─── Syntax Validation ─────────────────────────────────────────────────────

/**
 * Run `opa check` on each .rego file. Returns true if all files pass.
 */
export function validateSyntax(
  regoFiles: string[],
  execFileSync: ExecFileSync,
  verbose: boolean
): boolean {
  console.log('\n--- Syntax Validation (opa check) ---\n');

  let allPassed = true;

  for (const f of regoFiles) {
    const relPath = path.relative(process.cwd(), f);
    if (verbose) {
      console.log(`Checking: ${f}`);
    }
    try {
      execFileSync('opa', ['check', f], { stdio: 'pipe', timeout: 15000 });
      console.log(`  PASS  ${relPath}`);
    } catch (err: any) {
      allPassed = false;
      const stderr = err?.stderr?.toString() || err?.stdout?.toString() || '';
      console.log(`  FAIL  ${relPath}`);
      if (stderr) {
        for (const line of stderr.trim().split('\n')) {
          console.log(`        ${line}`);
        }
      }
    }
  }

  return allPassed;
}

// ─── WASM Compilation Check ─────────────────────────────────────────────────

/**
 * Attempt to compile the .rego files into a WASM bundle via `opa build`.
 * Returns true if compilation succeeds.
 */
export async function checkWasmCompilation(
  regoFiles: string[],
  execFileSync: ExecFileSync,
  verbose: boolean
): Promise<boolean> {
  console.log('\n--- WASM Compilation Check (opa build -t wasm -e visor) ---\n');

  const os = await import('os');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-policy-check-'));
  const bundlePath = path.join(tmpDir, 'bundle.tar.gz');
  let passed = true;

  try {
    const buildArgs = ['build', '-t', 'wasm', '-e', 'visor', '-o', bundlePath, ...regoFiles];

    if (verbose) {
      console.log(`  Running: opa ${buildArgs.join(' ')}`);
    }

    execFileSync('opa', buildArgs, { stdio: 'pipe', timeout: 30000 });
    console.log('  PASS  WASM compilation succeeded.');

    // Verify the bundle contains policy.wasm
    try {
      const listing = (execFileSync as any)('tar', ['-tzf', bundlePath], {
        stdio: 'pipe',
      }).toString();
      if (verbose) {
        const bundleStats = fs.statSync(bundlePath);
        console.log(`  Bundle: ${bundlePath} (${bundleStats.size} bytes)`);
        console.log(
          `  Bundle contents:\n${listing
            .trim()
            .split('\n')
            .map((l: string) => `    ${l}`)
            .join('\n')}`
        );
      }
      if (listing.includes('policy.wasm')) {
        console.log('  PASS  Bundle contains policy.wasm.');
      } else {
        console.log('  WARN  Bundle does not contain policy.wasm. Contents:');
        for (const line of listing.trim().split('\n')) {
          console.log(`        ${line}`);
        }
      }
    } catch {
      console.log('  WARN  Could not inspect bundle contents.');
    }
  } catch (err: any) {
    passed = false;
    const stderr = err?.stderr?.toString() || err?.stdout?.toString() || '';
    console.log('  FAIL  WASM compilation failed.');
    if (stderr) {
      for (const line of stderr.trim().split('\n')) {
        console.log(`        ${line}`);
      }
    }
    console.log('');
    console.log('  Common causes:');
    console.log('    - WASM-unsafe Rego patterns (e.g., `not set[_] == X`)');
    console.log('    - Missing `package visor.*` declaration');
    console.log('    - Conflicting package definitions across files');
    console.log('');
    console.log('  Tip: Use helper rules instead of negated iteration.');
    console.log('  See: https://www.openpolicyagent.org/docs/latest/policy-language/#limitations');
  } finally {
    // Clean up temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }

  return passed;
}

// ─── Policy Evaluation Against Sample Input ─────────────────────────────────

/**
 * Evaluate the policy against a sample input JSON file.
 * Returns true if evaluation ran without errors.
 */
export function evaluateSampleInput(
  inputFile: string,
  regoFiles: string[],
  execFileSync: ExecFileSync
): boolean {
  console.log('\n--- Policy Evaluation (sample input) ---\n');

  const inputPath = path.resolve(inputFile);
  if (!fs.existsSync(inputPath)) {
    console.error(`  Error: Input file not found: ${inputPath}`);
    return false;
  }

  // Validate JSON
  let inputData: unknown = undefined;
  try {
    const raw = fs.readFileSync(inputPath, 'utf8');
    inputData = JSON.parse(raw);
  } catch (parseErr) {
    console.error(
      `  Error: Invalid JSON in ${inputFile}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
    );
    return false;
  }

  if (inputData === undefined) {
    return false;
  }

  // Evaluate all three policy scopes
  const scopes = [
    'data.visor.check.execute',
    'data.visor.tool.invoke',
    'data.visor.capability.resolve',
  ];

  // Build -d flags: one per unique directory containing .rego files
  const dirs = Array.from(new Set(regoFiles.map(f => path.dirname(f))));
  const dataArgs: string[] = [];
  for (const d of dirs) {
    dataArgs.push('-d', d);
  }

  for (const scope of scopes) {
    try {
      const evalArgs = ['eval', ...dataArgs, '-i', inputPath, '--format', 'pretty', scope];

      const result = (execFileSync as any)('opa', evalArgs, { stdio: 'pipe', timeout: 15000 })
        .toString()
        .trim();
      const scopeShort = scope.replace('data.visor.', '');
      console.log(`  ${scopeShort}:`);
      for (const line of result.split('\n')) {
        console.log(`    ${line}`);
      }
    } catch (err: any) {
      const stderr = err?.stderr?.toString() || '';
      const scopeShort = scope.replace('data.visor.', '');
      // "undefined" result is not an error -- the scope may not be defined
      if (stderr.includes('undefined')) {
        console.log(`  ${scopeShort}: (not defined)`);
      } else {
        console.log(`  ${scopeShort}: evaluation error`);
        if (stderr) {
          for (const line of stderr.trim().split('\n')) {
            console.log(`    ${line}`);
          }
        }
      }
    }
  }

  return true;
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

/**
 * Handle the policy-check subcommand.
 *
 * Validates Rego policy files for syntax and WASM compatibility.
 * Optionally evaluates against sample input JSON.
 *
 * Usage:
 *   visor policy-check [path] [--config <config>] [--input <json-file>]
 */
export async function handlePolicyCheckCommand(argv: string[]): Promise<void> {
  const args = parsePolicyCheckArgs(argv);

  // Resolve rulesPath from positional arg or config
  const rulesPath = await resolveRulesPathFromConfig(args);

  if (!rulesPath) {
    console.error('Error: No policy path specified.');
    console.error('');
    console.error('Usage: visor policy-check [path] [--config <config>] [--input <json-file>]');
    console.error('');
    console.error(
      'Provide a path to .rego files or a directory, or configure policy.rules in .visor.yaml'
    );
    process.exit(1);
  }

  console.log('Visor Policy Check\n');

  // Verify OPA CLI is available
  const execFileSync = await verifyOpaCli(args.verbose);

  // Resolve .rego files
  const regoFiles = resolveRegoFiles(rulesPath);

  if (regoFiles.length === 0) {
    const pathsList = Array.isArray(rulesPath) ? rulesPath : [rulesPath];
    console.error(`\nError: No .rego files found in: ${pathsList.join(', ')}`);
    process.exit(1);
  }

  console.log(`\nFound ${regoFiles.length} .rego file(s):`);
  for (const f of regoFiles) {
    console.log(`  ${path.relative(process.cwd(), f)}`);
  }

  let hasErrors = false;

  // Step 1: Syntax validation
  const syntaxPassed = validateSyntax(regoFiles, execFileSync, args.verbose);
  if (!syntaxPassed) {
    console.log('\nSyntax validation failed. Fix errors above before continuing.');
    console.log('\nResult: FAIL');
    process.exit(1);
  }

  console.log('\nAll files passed syntax validation.');

  // Step 2: WASM compilation check
  const wasmPassed = await checkWasmCompilation(regoFiles, execFileSync, args.verbose);
  if (!wasmPassed) {
    hasErrors = true;
  }

  // Step 3: Optional evaluation against sample input
  if (args.inputFile && !hasErrors) {
    const evalPassed = evaluateSampleInput(args.inputFile, regoFiles, execFileSync);
    if (!evalPassed) {
      hasErrors = true;
    }
  }

  // Final summary
  console.log('');
  if (hasErrors) {
    console.log('Result: FAIL');
    process.exit(1);
  } else {
    console.log('Result: PASS');
    if (!args.inputFile) {
      console.log('');
      console.log('Tip: Use --input <json-file> to evaluate against sample input.');
      console.log('     See docs/enterprise-policy.md for the input document schema.');
    }
    process.exit(0);
  }
}
