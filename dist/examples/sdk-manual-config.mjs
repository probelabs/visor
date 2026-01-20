/**
 * Example: SDK with manually constructed config object
 * This demonstrates using loadConfig() with a raw config object
 * instead of loading from a file.
 */

import { loadConfig, runChecks } from '../dist/sdk/sdk.mjs';

async function main() {
  // Load and validate config from an object (not a file!)
  // loadConfig() validates, applies defaults, and returns a complete config
  const config = await loadConfig({
    version: '1.0',
    checks: {
      'security-check': {
        type: 'command',
        exec: 'echo "Running security scan..."',
      },
      'lint-check': {
        type: 'command',
        exec: 'echo "Running linter..."',
        depends_on: ['security-check'],
      },
    },
  });

  console.log('Running checks with manually constructed config...\n');

  // Run all checks defined in the config
  const result = await runChecks({
    config,
    checks: Object.keys(config.checks),
    output: { format: 'json' },
    debug: false,
  });

  // Display results
  console.log('Execution summary:');
  console.log(`  Total checks executed: ${result.checksExecuted.length}`);
  console.log(`  Total issues found: ${result.reviewSummary.issues?.length || 0}`);
  console.log(`  Execution time: ${result.executionTime}ms`);
  console.log(`  Timestamp: ${result.timestamp}`);

  // Display check results
  console.log('\nCheck results:');
  for (const checkName of result.checksExecuted) {
    console.log(`  ✓ ${checkName}`);
  }

  // Display any issues found
  if (result.reviewSummary.issues && result.reviewSummary.issues.length > 0) {
    console.log('\nIssues found:');
    result.reviewSummary.issues.forEach((issue, idx) => {
      console.log(`  ${idx + 1}. [${issue.severity}] ${issue.message}`);
      console.log(`     File: ${issue.file}:${issue.line}`);
    });
  }

  return result;
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
