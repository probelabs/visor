#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
const path = require('path');
const fs = require('fs');
const Ajv = require('ajv');

function now() {
  const [s, n] = process.hrtime();
  return s * 1e3 + n / 1e6;
}

function main() {
  const schemaPath = path.resolve(__dirname, '..', 'dist', 'generated', 'config-schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false });

  const t0 = now();
  const validate = ajv.compile(schema);
  const t1 = now();

  const sampleConfig = {
    version: '1.0',
    checks: {
      sample: {
        type: 'log',
        message: 'Hello {{ pr.title }}',
      },
    },
    output: {
      pr_comment: { format: 'markdown', group_by: 'check', collapse: true },
    },
  };

  const t2 = now();
  const ok = validate(sampleConfig);
  const t3 = now();

  console.log(JSON.stringify({
    compile_ms: +(t1 - t0).toFixed(3),
    validate_ms: +(t3 - t2).toFixed(3),
    valid: !!ok,
    errors: validate.errors ? validate.errors.length : 0,
  }, null, 2));
}

main();

