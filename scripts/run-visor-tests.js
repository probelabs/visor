#!/usr/bin/env node
/*
 Runs the Visor YAML test suite for the default config.
 - Uses dist/index.js when present; falls back to ts-node on src/index.ts otherwise.
 - In CI, also writes JSON/JUnit/Markdown artifacts to ./output.
 - Exits non‑zero if the YAML tests fail.
*/

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const distCli = path.join(repoRoot, 'dist', 'index.js');
  const srcCli = path.join(repoRoot, 'src', 'index.ts');
  // Prefer new non-dot tests filename; allow multiple suites
  const primarySuite = process.env.VISOR_TESTS_PATH || path.join(repoRoot, 'defaults', 'visor.tests.yaml');
  const refinementSuite = path.join(repoRoot, 'defaults', 'task-refinement.yaml');
  const refinerSuite = path.join(repoRoot, 'defaults', 'code-refiner.yaml');
  // Local override tests that validate include/extends + appendPrompt behavior
  const overrideSuite = path.join(repoRoot, 'tests', 'override.tests.yaml');
  const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

  let nodeArgs = [];
  const baseArgs = [];
  if (!isCI) {
    // Prefer TypeScript source in local/dev for correctness
    try {
      require.resolve('ts-node/register');
      nodeArgs = ['-r', 'ts-node/register'];
      baseArgs.push(srcCli);
    } catch (_) {
      // Fallback to dist if ts-node is not installed
      if (fs.existsSync(distCli)) {
        baseArgs.push(distCli);
      } else {
        console.error('Neither ts-node nor dist/index.js found. Run `npm run build:cli` first.');
        process.exit(2);
      }
    }
  } else {
    // In CI we always use the freshly built dist
    // Fall back to ts-node
    if (fs.existsSync(distCli)) {
      baseArgs.push(distCli);
    } else {
      try {
        require.resolve('ts-node/register');
        nodeArgs = ['-r', 'ts-node/register'];
        baseArgs.push(srcCli);
      } catch (e) {
        console.error('Build artifacts missing and ts-node not available.');
        process.exit(2);
      }
    }
  }

  // Ensure VISOR_DEBUG is not noisy in CI
  const env = { ...process.env };
  if (isCI && env.VISOR_DEBUG === 'true') delete env.VISOR_DEBUG;

  const suites = [primarySuite];
  if (fs.existsSync(refinementSuite)) suites.push(refinementSuite);
  if (fs.existsSync(refinerSuite)) suites.push(refinerSuite);
  if (fs.existsSync(overrideSuite)) suites.push(overrideSuite);

  let exitCode = 0;
  const outDir = path.join(repoRoot, 'output');
  if (isCI) { try { fs.mkdirSync(outDir, { recursive: true }); } catch {}
  }

  for (const suite of suites) {
    const label = path.basename(suite).replace(/\.[^.]+$/, '');
    const args = [...baseArgs, 'test', '--config', suite, '--progress', 'compact'];
    if (isCI) {
      args.push('--json', path.join(outDir, `${label}.json`));
      args.push('--report', `junit:${path.join(outDir, `${label}.xml`)}`);
      args.push('--summary', `md:${path.join(outDir, `${label}.md`)}`);
    }
    const res = spawnSync(process.execPath, [...nodeArgs, ...args], {
      stdio: 'inherit',
      env,
      cwd: repoRoot,
    });
    if (typeof res.status === 'number' && res.status !== 0) exitCode = res.status;
    if (res.error) {
      console.error(res.error);
      exitCode = 1;
    }
  }

  process.exit(exitCode);
}

main();
