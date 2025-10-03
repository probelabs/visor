#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Read Visor package.json version
const packageJson = require('../package.json');
const version = packageJson.version;

// Try to read Probe version from installed dependency
let probeVersion = 'unknown';
// Try node resolution first
try {
  const probePkgPath = require.resolve('@probelabs/probe/package.json', {
    paths: [path.join(__dirname, '..')],
  });
  const probePkg = require(probePkgPath);
  if (probePkg && probePkg.version) probeVersion = probePkg.version;
} catch {}
// Fallback to package-lock resolution (robust in CI)
if (probeVersion === 'unknown') {
  try {
    const lock = require('../package-lock.json');
    const locked = lock.packages && lock.packages['node_modules/@probelabs/probe'];
    if (locked && locked.version) probeVersion = locked.version;
  } catch {}
}

// Path to the bundled file
const distPath = path.join(__dirname, '../dist/index.js');

// Read the bundled file
let content = fs.readFileSync(distPath, 'utf8');

// Inject version at the beginning of the file (after shebang will be added)
const versionInjection = `process.env.VISOR_VERSION = '${version}';\nprocess.env.PROBE_VERSION = '${probeVersion}';\n`;

// Write back with version injected
fs.writeFileSync(distPath, versionInjection + content);

console.log(`✅ Injected versions Visor=${version} Probe=${probeVersion} into dist/index.js`);
