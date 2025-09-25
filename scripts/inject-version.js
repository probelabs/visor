#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Read package.json version
const packageJson = require('../package.json');
const version = packageJson.version;

// Path to the bundled file
const distPath = path.join(__dirname, '../dist/index.js');

// Read the bundled file
let content = fs.readFileSync(distPath, 'utf8');

// Inject version at the beginning of the file (after shebang will be added)
const versionInjection = `process.env.VISOR_VERSION = '${version}';\n`;

// Write back with version injected
fs.writeFileSync(distPath, versionInjection + content);

console.log(`✅ Injected version ${version} into dist/index.js`);