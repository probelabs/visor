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
  const testsPath = process.env.VISOR_TESTS_PATH || path.join(repoRoot, 'defaults', '.visor.tests.yaml');
  const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

  let nodeArgs = [];
  let argv = [];
  if (!isCI) {
    // Prefer TypeScript source in local/dev for correctness
    try {
      require.resolve('ts-node/register');
      nodeArgs = ['-r', 'ts-node/register'];
      argv = [srcCli, 'test', '--config', testsPath, '--progress', 'compact'];
    } catch (_) {
      // Fallback to dist if ts-node is not installed
      if (fs.existsSync(distCli)) {
        argv = [distCli, 'test', '--config', testsPath, '--progress', 'compact'];
      } else {
        console.error('Neither ts-node nor dist/index.js found. Run `npm run build:cli` first.');
        process.exit(2);
      }
    }
  } else {
    // In CI we always use the freshly built dist
    // Fall back to ts-node
    if (fs.existsSync(distCli)) {
      argv = [distCli, 'test', '--config', testsPath, '--progress', 'compact'];
    } else {
      try {
        require.resolve('ts-node/register');
        nodeArgs = ['-r', 'ts-node/register'];
        argv = [srcCli, 'test', '--config', testsPath, '--progress', 'compact'];
      } catch (e) {
        console.error('Build artifacts missing and ts-node not available.');
        process.exit(2);
      }
    }
  }

  if (isCI) {
    const outDir = path.join(repoRoot, 'output');
    try { fs.mkdirSync(outDir, { recursive: true }); } catch {}
    argv.push('--json', path.join(outDir, 'visor-tests.json'));
    argv.push('--report', `junit:${path.join(outDir, 'visor-tests.xml')}`);
    argv.push('--summary', `md:${path.join(outDir, 'visor-tests.md')}`);
  }

  // Ensure VISOR_DEBUG is not noisy in CI
  const env = { ...process.env };
  if (isCI && env.VISOR_DEBUG === 'true') delete env.VISOR_DEBUG;

  const res = spawnSync(process.execPath, [...nodeArgs, ...argv], {
    stdio: 'inherit',
    env,
    cwd: repoRoot,
  });
  if (typeof res.status === 'number') process.exit(res.status);
  if (res.error) {
    console.error(res.error);
    process.exit(1);
  }
  process.exit(0);
}

main();
