/**
 * TypeScript SDK Example
 *
 * Demonstrates:
 * - Type-safe config construction
 * - TypeScript type inference
 * - Compile-time type checking
 * - Using exported types
 */

// Import from the package for full TypeScript type definitions
// In a real project, you would use: '@probelabs/visor/sdk'
// For this example, we import from the built SDK with type definitions
import { loadConfig, runChecks, type VisorConfig, type RunOptions } from '../dist/sdk/sdk.js';

async function main(): Promise<void> {
  console.log('=== Visor SDK - TypeScript Example ===\n');

  // Type-safe config construction (note: VisorConfig is exported from SDK)
  const rawConfig: Partial<VisorConfig> = {
    version: '1.0',
    checks: {
      'type-check': {
        type: 'command',
        exec: 'echo "Running TypeScript compiler..."',
        tags: ['typescript', 'build'],
      },
      'unit-tests': {
        type: 'command',
        exec: 'echo "Running unit tests..."',
        depends_on: ['type-check'],
        tags: ['testing'],
      },
      'build': {
        type: 'command',
        exec: 'echo "Building application..."',
        depends_on: ['type-check', 'unit-tests'],
        tags: ['build'],
      },
    },
    max_parallelism: 2,
    fail_fast: false,
  };

  // Load and validate config with full type safety
  const config = await loadConfig(rawConfig);

  console.log('✅ Config validated and loaded');
  console.log(`   Checks: ${Object.keys(config.checks).length}`);
  console.log(`   Max parallelism: ${config.max_parallelism}\n`);

  // Run checks with type-safe options
  const result = await runChecks({
    config,
    checks: ['type-check', 'unit-tests', 'build'],
    output: { format: 'json' },
    maxParallelism: 2,
    debug: false,
    tagFilter: { include: ['typescript', 'testing', 'build'] },
  });

  // Type-safe result inspection
  console.log('📊 Results:');
  console.log(`   Checks executed: ${result.checksExecuted.length}`);
  console.log(`   Execution time: ${result.executionTime}ms`);
  console.log(`   Issues found: ${result.reviewSummary.issues?.length ?? 0}`);
  console.log(`   Timestamp: ${result.timestamp}`);

  // Type-safe iteration over results
  console.log('\n   Executed checks:');
  result.checksExecuted.forEach((checkName: string, index: number) => {
    console.log(`     ${index + 1}. ${checkName}`);
  });

  // Demonstrate type checking with issues
  if (result.reviewSummary.issues && result.reviewSummary.issues.length > 0) {
    console.log('\n   Issues:');
    result.reviewSummary.issues.forEach((issue) => {
      // TypeScript knows the structure of issue
      console.log(`     ${issue.file}:${issue.line} - ${issue.message}`);
      console.log(`     Severity: ${issue.severity}`);
    });
  }

  console.log('\n✅ TypeScript example complete!\n');
}

// Run with proper error handling
main().catch((error: Error) => {
  console.error('❌ Error:', error.message);
  process.exit(1);
});
