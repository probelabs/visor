#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

function hrms() {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
}

async function baselineLoad(ConfigManager, configPath, runs = 5) {
  const cm = new ConfigManager();
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = hrms();
    await cm.loadConfig(configPath);
    times.push(hrms() - t0);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  return { times, avg };
}

function buildLargeConfig(n = 100) {
  const cfg = {
    version: '1.0',
    checks: {},
    output: { pr_comment: { format: 'table', group_by: 'check', collapse: true } },
  };
  for (let i = 0; i < n; i++) {
    cfg.checks[`check-${i}`] = { type: 'ai', prompt: `Check ${i}`, on: ['pr_opened'], triggers: [`**/*${i}.js`] };
  }
  return cfg;
}

async function main() {
  const { loadConfig } = require('../dist/sdk/sdk.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-ajv-perf-'));
  const cfgObj = buildLargeConfig(100);
  const cfgPath = path.join(tmpDir, 'config.yaml');
  fs.writeFileSync(cfgPath, yaml.dump(cfgObj), 'utf8');

  // Baseline: load without synchronous Ajv on the critical path
  async function baselineLoadViaSDK(configPath, runs = 5) {
    const times = [];
    for (let i = 0; i < runs; i++) {
      const t0 = hrms();
      await loadConfig(configPath);
      times.push(hrms() - t0);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    return { times, avg };
  }
  const baseline = await baselineLoadViaSDK(cfgPath, 5);

  // Synchronous Ajv: generate schema + compile + validate
  const t0 = hrms();
  const tjs = require('ts-json-schema-generator');
  const generator = tjs.createGenerator({
    path: path.resolve(__dirname, '..', 'src', 'types', 'config.ts'),
    tsconfig: path.resolve(__dirname, '..', 'tsconfig.json'),
    type: 'VisorConfig',
    expose: 'all',
    jsDoc: 'extended',
    skipTypeCheck: true,
    topRef: true,
  });
  const schema = generator.createSchema('VisorConfig');
  // Decorate schema similar to runtime
  (function decorate(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.type === 'object' && obj.properties) {
      if (obj.additionalProperties === undefined) obj.additionalProperties = false;
      obj.patternProperties = obj.patternProperties || {};
      obj.patternProperties['^x-'] = {};
    }
    for (const key of ['definitions', '$defs', 'properties', 'items', 'anyOf', 'allOf', 'oneOf']) {
      const child = obj[key];
      if (Array.isArray(child)) child.forEach(decorate);
      else if (child && typeof child === 'object') Object.values(child).forEach(decorate);
    }
  })(schema);

  const Ajv = require('ajv');
  const addFormats = require('ajv-formats');
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false });
  addFormats(ajv);
  const compileStart = hrms();
  const validate = ajv.compile(schema);
  const compileMs = hrms() - compileStart;

  // Validate the same config object several times
  const validateTimes = [];
  for (let i = 0; i < 5; i++) {
    const v0 = hrms();
    const ok = validate(cfgObj);
    const vMs = hrms() - v0;
    validateTimes.push(vMs);
    if (!ok && validate.errors) {
      // ignore errors; we just measure
    }
  }
  const validateAvg = validateTimes.reduce((a, b) => a + b, 0) / validateTimes.length;

  const buildMs = hrms() - t0;

  const result = {
    baseline: { avgMs: baseline.avg, runsMs: baseline.times },
    ajv: {
      totalBuildMs: buildMs,
      compileMs,
      validateAvgMs: validateAvg,
      validateRunsMs: validateTimes,
    },
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
