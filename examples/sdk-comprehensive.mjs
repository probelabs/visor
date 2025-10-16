/**
 * Comprehensive SDK Example
 *
 * This example demonstrates:
 * 1. Loading config from file vs manual construction
 * 2. Using resolveChecks to expand dependencies
 * 3. Different output formats
 * 4. Tag filtering
 * 5. Parallel execution control
 * 6. Timeout handling
 * 7. Error handling and result inspection
 */

import { loadConfig, runChecks, resolveChecks } from '../dist/sdk/sdk.mjs';

// Example 1: Manual Config with Dependencies
async function example1_manualConfig() {
  console.log('\n=== Example 1: Manual Config with Dependencies ===\n');

  const config = {
    version: '1.0',
    checks: {
      'setup': {
        type: 'command',
        exec: 'echo "Setup complete"',
      },
      'test-a': {
        type: 'command',
        exec: 'echo "Test A passed"',
        depends_on: ['setup'],
      },
      'test-b': {
        type: 'command',
        exec: 'echo "Test B passed"',
        depends_on: ['setup'],
      },
      'report': {
        type: 'command',
        exec: 'echo "All tests complete"',
        depends_on: ['test-a', 'test-b'],
      },
    },
    output: {
      format: 'json',
      comments: { enabled: false },
    },
  };

  // Resolve dependencies for 'report' check
  const checksToRun = resolveChecks(['report'], config);
  console.log('Resolved checks:', checksToRun);

  const result = await runChecks({
    config,
    checks: checksToRun,
    output: { format: 'json' },
    maxParallelism: 2,
  });

  console.log(`Executed ${result.checksExecuted.length} checks in ${result.executionTime}ms`);
  return result;
}

// Example 2: Tag Filtering
async function example2_tagFiltering() {
  console.log('\n=== Example 2: Tag Filtering ===\n');

  const config = {
    version: '1.0',
    checks: {
      'security-scan': {
        type: 'command',
        exec: 'echo "Security scan complete"',
        tags: ['security', 'critical'],
      },
      'style-check': {
        type: 'command',
        exec: 'echo "Style check complete"',
        tags: ['style'],
      },
      'performance-test': {
        type: 'command',
        exec: 'echo "Performance test complete"',
        tags: ['performance', 'critical'],
      },
    },
    output: {
      format: 'json',
      comments: { enabled: false },
    },
  };

  // Run only checks tagged with 'critical'
  const result = await runChecks({
    config,
    checks: Object.keys(config.checks),
    tagFilter: {
      include: ['critical'],
    },
  });

  console.log('Checks with "critical" tag:');
  result.checksExecuted.forEach((check) => console.log(`  - ${check}`));

  return result;
}

// Example 3: Different Output Formats
async function example3_outputFormats() {
  console.log('\n=== Example 3: Different Output Formats ===\n');

  const config = {
    version: '1.0',
    checks: {
      'check-1': {
        type: 'command',
        exec: 'echo "Check complete"',
      },
    },
    output: {
      format: 'json',
      comments: { enabled: false },
    },
  };

  // Run with different output formats
  const formats = ['json', 'table', 'markdown'];

  for (const format of formats) {
    console.log(`\nRunning with format: ${format}`);
    const result = await runChecks({
      config,
      checks: ['check-1'],
      output: { format },
      debug: false,
    });
    console.log(`  Execution time: ${result.executionTime}ms`);
  }
}

// Example 4: Loading Config from File
async function example4_loadFromFile() {
  console.log('\n=== Example 4: Loading Config from File ===\n');

  try {
    // Try to load config from default location
    const config = await loadConfig();
    console.log(`Loaded config with ${Object.keys(config.checks || {}).length} checks`);

    // Run a subset of checks
    const checksToRun = Object.keys(config.checks || {}).slice(0, 2);
    if (checksToRun.length > 0) {
      const result = await runChecks({
        config,
        checks: checksToRun,
        output: { format: 'json' },
      });
      console.log(`Executed ${result.checksExecuted.length} checks`);
    } else {
      console.log('No checks found in config');
    }
  } catch (error) {
    console.log('No config file found (expected in this example)');
  }
}

// Example 5: Error Handling and Fail Fast
async function example5_errorHandling() {
  console.log('\n=== Example 5: Error Handling and Fail Fast ===\n');

  const config = {
    version: '1.0',
    checks: {
      'pass-check': {
        type: 'command',
        exec: 'echo "This passes"',
      },
      'fail-check': {
        type: 'command',
        exec: 'exit 1',
        depends_on: ['pass-check'],
      },
      'skip-check': {
        type: 'command',
        exec: 'echo "This might be skipped"',
        depends_on: ['fail-check'],
      },
    },
    output: {
      format: 'json',
      comments: { enabled: false },
    },
  };

  // Run without fail_fast
  console.log('Running without fail_fast:');
  const result1 = await runChecks({
    config,
    checks: Object.keys(config.checks),
    failFast: false,
  });
  console.log(`  Executed: ${result1.checksExecuted.length} checks`);

  // Run with fail_fast
  console.log('\nRunning with fail_fast:');
  const result2 = await runChecks({
    config,
    checks: Object.keys(config.checks),
    failFast: true,
  });
  console.log(`  Executed: ${result2.checksExecuted.length} checks`);
}

// Example 6: Programmatic Result Inspection
async function example6_resultInspection() {
  console.log('\n=== Example 6: Programmatic Result Inspection ===\n');

  const config = {
    version: '1.0',
    checks: {
      'check-1': {
        type: 'command',
        exec: 'echo "Check complete"',
      },
    },
    output: {
      format: 'json',
      comments: { enabled: false },
    },
  };

  const result = await runChecks({
    config,
    checks: ['check-1'],
  });

  // Inspect the result structure
  console.log('Result structure:');
  console.log(`  - checksExecuted: ${result.checksExecuted.join(', ')}`);
  console.log(`  - executionTime: ${result.executionTime}ms`);
  console.log(`  - timestamp: ${result.timestamp}`);
  console.log(`  - issues count: ${result.reviewSummary.issues?.length || 0}`);
  console.log(`  - has reviewSummary: ${!!result.reviewSummary}`);

  return result;
}

// Run all examples
async function main() {
  console.log('Visor SDK - Comprehensive Examples');
  console.log('====================================');

  try {
    await example1_manualConfig();
    await example2_tagFiltering();
    await example3_outputFormats();
    await example4_loadFromFile();
    await example5_errorHandling();
    await example6_resultInspection();

    console.log('\n✅ All examples completed successfully!\n');
  } catch (error) {
    console.error('\n❌ Error running examples:', error.message);
    process.exit(1);
  }
}

main();
