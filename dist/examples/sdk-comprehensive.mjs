/**
 * Comprehensive SDK Example
 *
 * Demonstrates:
 * - loadConfig() with raw object
 * - Complex check dependencies (depends_on)
 * - Check execution order
 * - Different check types
 * - Tag filtering
 * - Parallel execution control
 * - Error handling and results inspection
 */

import { loadConfig, runChecks, resolveChecks } from '../dist/sdk/sdk.mjs';

async function main() {
  console.log('=== Visor SDK - Comprehensive Example ===\n');

  // Create a complex config with dependencies
  const config = await loadConfig({
    version: '1.0',
    checks: {
      // Step 1: Setup/preparation check
      'setup': {
        type: 'command',
        exec: 'echo "Setup: Installing dependencies..."',
        tags: ['setup'],
      },

      // Step 2: Run tests (depends on setup)
      'unit-tests': {
        type: 'command',
        exec: 'echo "Running unit tests..."',
        depends_on: ['setup'],
        tags: ['tests'],
      },

      // Step 3: Integration tests (depends on setup)
      'integration-tests': {
        type: 'command',
        exec: 'echo "Running integration tests..."',
        depends_on: ['setup'],
        tags: ['tests'],
      },

      // Step 4: Security scan (depends on setup)
      'security-scan': {
        type: 'command',
        exec: 'echo "Running security scan..."',
        depends_on: ['setup'],
        tags: ['security', 'critical'],
      },

      // Step 5: Linting (depends on setup)
      'lint': {
        type: 'command',
        exec: 'echo "Running linter..."',
        depends_on: ['setup'],
        tags: ['quality'],
      },

      // Step 6: Build (depends on all tests passing)
      'build': {
        type: 'command',
        exec: 'echo "Building application..."',
        depends_on: ['unit-tests', 'integration-tests', 'lint'],
        tags: ['build'],
      },

      // Step 7: Deploy check (depends on build and security)
      'deploy-check': {
        type: 'command',
        exec: 'echo "Checking deployment readiness..."',
        depends_on: ['build', 'security-scan'],
        tags: ['deployment'],
      },

      // Step 8: Final report (depends on everything)
      'report': {
        type: 'command',
        exec: 'echo "Generating final report..."',
        depends_on: ['deploy-check'],
        tags: ['reporting'],
      },
    },
    max_parallelism: 3,
    fail_fast: false,
  });

  console.log('📋 Config loaded with', Object.keys(config.checks).length, 'checks\n');

  // Example 1: Resolve dependencies
  console.log('=== Example 1: Dependency Resolution ===');
  const reportDeps = resolveChecks(['report'], config);
  console.log('To run "report", these checks execute in order:');
  reportDeps.forEach((check, idx) => {
    console.log(`  ${idx + 1}. ${check}`);
  });

  // Example 2: Run specific checks
  console.log('\n=== Example 2: Run Specific Checks ===');
  const testResult = await runChecks({
    config,
    checks: ['setup', 'unit-tests', 'integration-tests'],
    output: { format: 'json' },
    debug: false,
  });
  console.log('✅ Executed:', testResult.checksExecuted.join(', '));
  console.log('⏱️  Time:', testResult.executionTime, 'ms');

  // Example 3: Tag filtering
  console.log('\n=== Example 3: Tag Filtering ===');
  const securityResult = await runChecks({
    config,
    checks: Object.keys(config.checks),
    tagFilter: { include: ['critical'] },
    output: { format: 'json' },
    debug: false,
  });
  console.log('✅ Critical checks:', securityResult.checksExecuted.join(', '));
  console.log('⏱️  Time:', securityResult.executionTime, 'ms');

  // Example 4: Full pipeline
  console.log('\n=== Example 4: Full Pipeline ===');
  const fullResult = await runChecks({
    config,
    checks: Object.keys(config.checks),
    output: { format: 'json' },
    maxParallelism: 3,
    debug: false,
  });

  console.log('📊 Results:');
  console.log('  Checks:', fullResult.checksExecuted.length);
  console.log('  Time:', fullResult.executionTime, 'ms');
  console.log('  Issues:', fullResult.reviewSummary.issues?.length || 0);

  console.log('\n  Execution order:');
  fullResult.checksExecuted.forEach((check, idx) => {
    console.log(`    ${idx + 1}. ${check}`);
  });

  // Example 5: Strict validation
  console.log('\n=== Example 5: Strict Validation ===');
  try {
    await loadConfig({
      version: '1.0',
      checks: { test: { type: 'command', exec: 'echo test' } },
      typo_field: 'error!',
    }, { strict: true });
    console.log('❌ Should have thrown');
  } catch (error) {
    console.log('✅ Caught:', error.message.substring(0, 50) + '...');
  }

  // Example 6: Dependency graph
  console.log('\n=== Example 6: Dependency Graph ===');
  for (const name of Object.keys(config.checks)) {
    const deps = config.checks[name].depends_on || [];
    const tags = config.checks[name].tags || [];
    const tagStr = tags.length ? ` [${tags.join(',')}]` : '';
    if (deps.length) {
      console.log(`  ${name}${tagStr} → ${deps.join(', ')}`);
    } else {
      console.log(`  ${name}${tagStr} → (root)`);
    }
  }

  console.log('\n✅ All examples complete!\n');
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
