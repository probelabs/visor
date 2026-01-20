#!/usr/bin/env node

/**
 * Real SDK Calculator Example
 *
 * This is a complete, runnable example showing how to use Visor SDK with human-input.
 * The config is defined inline and the workflow executes programmatically.
 *
 * Usage:
 *   npm run build
 *   ts-node examples/calculator-sdk-real.ts
 *
 * Or after build:
 *   node examples/calculator-sdk-real.js
 */

import * as readline from 'readline';
import { HumanInputRequest, VisorConfig } from '../src/types/config';
import { HumanInputCheckProvider } from '../src/providers/human-input-check-provider';
import { CheckExecutionEngine } from '../src/check-execution-engine';

// ============================================================================
// CONFIGURATION - Defined inline
// ============================================================================

const calculatorConfig: VisorConfig = {
  version: "1.0",

  // Memory configuration for storing values between steps
  memory: {
    storage: 'memory',
    namespace: 'calculator'
  },

  // Define our workflow checks
  checks: {
    // Step 1: Get first number from user
    "get-number1": {
      type: "human-input",
      prompt: "Enter the first number:",
      placeholder: "e.g., 42",
      allow_empty: false
    },

    // Step 2: Parse and store first number in memory
    "store-number1": {
      type: "memory",
      depends_on: ["get-number1"],
      operation: "set",
      namespace: "calculator",
      key: "number1",
      value_js: "parseFloat(outputs['get-number1'])"
    },

    // Step 3: Get second number from user
    "get-number2": {
      type: "human-input",
      depends_on: ["store-number1"],
      prompt: "Enter the second number:",
      placeholder: "e.g., 7",
      allow_empty: false
    },

    // Step 4: Parse and store second number in memory
    "store-number2": {
      type: "memory",
      depends_on: ["get-number2"],
      operation: "set",
      namespace: "calculator",
      key: "number2",
      value_js: "parseFloat(outputs['get-number2'])"
    },

    // Step 5: Get operation from user
    "get-operation": {
      type: "human-input",
      depends_on: ["store-number2"],
      prompt: "Select operation (+, -, *, /):",
      placeholder: "Enter one of: + - * /",
      allow_empty: false
    },

    // Step 6: Validate and store operation
    "store-operation": {
      type: "memory",
      depends_on: ["get-operation"],
      operation: "set",
      namespace: "calculator",
      key: "operation",
      value_js: "outputs['get-operation'].trim()",
      // Validate operation
      fail_if: "!['+', '-', '*', '/'].includes(outputs['get-operation'].trim())"
    },

    // Step 7: Perform calculation using JavaScript
    "calculate": {
      type: "script",
      depends_on: ["store-operation"],
      content: `
        // Get values from memory
        const num1 = memory.get('number1', 'calculator');
        const num2 = memory.get('number2', 'calculator');
        const op = memory.get('operation', 'calculator');

        // Debug logging
        log('🔢 Calculating:', num1, op, num2);

        // Validate numbers
        if (isNaN(num1)) {
          throw new Error('First number is invalid: ' + num1);
        }
        if (isNaN(num2)) {
          throw new Error('Second number is invalid: ' + num2);
        }

        // Perform calculation
        let result;
        switch(op) {
          case '+':
            result = num1 + num2;
            break;
          case '-':
            result = num1 - num2;
            break;
          case '*':
            result = num1 * num2;
            break;
          case '/':
            if (num2 === 0) {
              throw new Error('❌ Division by zero!');
            }
            result = num1 / num2;
            break;
          default:
            throw new Error('Invalid operation: ' + op + ' (must be +, -, *, or /)');
        }

        log('✅ Result:', result);

        // Return result for dependent checks
        return result;
      `
    },

    // Step 8: Display the final result
    "show-result": {
      type: "log",
      depends_on: ["calculate"],
      level: "info",
      message: `
╔════════════════════════════════════════╗
║        CALCULATION RESULT              ║
╠════════════════════════════════════════╣
║                                        ║
║  {{ outputs['get-number1'] }} {{ outputs['get-operation'] }} {{ outputs['get-number2'] }} = {{ outputs['calculate'] }}
║                                        ║
╚════════════════════════════════════════╝
      `
    }
  },

  // Output configuration
  output: {
    pr_comment: {
      format: "markdown",
      group_by: "check",
      collapse: false
    }
  }
};

// ============================================================================
// CUSTOM HOOK IMPLEMENTATION
// ============================================================================

/**
 * Custom readline-based input handler for SDK mode
 * This shows how to implement your own input mechanism
 */
async function customHumanInputHandler(request: HumanInputRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    // Display a nice prompt
    console.log('\n┌─────────────────────────────────────────────────────────┐');
    const padding = 57 - request.prompt.length;
    console.log(`│ 💬 ${request.prompt}${' '.repeat(Math.max(0, padding))}│`);
    console.log('└─────────────────────────────────────────────────────────┘');

    if (request.placeholder) {
      console.log(`   ${request.placeholder}`);
    }

    rl.question('\n> ', (answer) => {
      rl.close();

      const trimmed = answer.trim();

      // Handle empty input
      if (!trimmed) {
        if (request.allowEmpty) {
          resolve(request.default || '');
        } else if (request.default) {
          console.log(`   (using default: ${request.default})`);
          resolve(request.default);
        } else {
          console.log('   ❌ Empty input not allowed\n');
          reject(new Error('Empty input not allowed'));
        }
      } else {
        resolve(trimmed);
      }
    });

    // Handle timeout if specified
    if (request.timeout) {
      setTimeout(() => {
        rl.close();
        if (request.default) {
          console.log(`\n   ⏱️  Timeout - using default: ${request.default}`);
          resolve(request.default);
        } else {
          reject(new Error('Input timeout'));
        }
      }, request.timeout);
    }
  });
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║      Visor SDK Calculator - Real Implementation          ║');
  console.log('║      Human Input + Memory + JavaScript                   ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  console.log('This is a real SDK example with:');
  console.log('  ✓ Inline configuration (no YAML files needed)');
  console.log('  ✓ Custom human-input hook using readline');
  console.log('  ✓ Memory provider for state management');
  console.log('  ✓ JavaScript execution for calculations');
  console.log('  ✓ Full dependency chain with error handling\n');

  console.log('═'.repeat(59));
  console.log('Starting calculator workflow...');
  console.log('═'.repeat(59));

  try {
    // Set up the human input hook
    HumanInputCheckProvider.setHooks({
      onHumanInput: customHumanInputHandler
    });

    // Create execution engine
    const engine = new CheckExecutionEngine();

    // Execute all checks in the workflow
    const checksToRun = Object.keys(calculatorConfig.checks || {});

    console.log(`\n📋 Running ${checksToRun.length} checks...\n`);

    const result = await engine.executeChecks({
      checks: checksToRun,
      config: calculatorConfig,
      outputFormat: 'json',
      maxParallelism: 1, // Run sequentially for human input
      debug: false
    });

    // Display results summary
    console.log('\n═'.repeat(59));
    console.log('✅ Calculator workflow completed successfully!');
    console.log('═'.repeat(59));

    console.log(`\n📊 Summary:`);
    console.log(`   - Total checks: ${checksToRun.length}`);
    console.log(`   - Execution time: ${result.executionTime}ms`);
    console.log(`   - Timestamp: ${result.timestamp}`);
    console.log(`   - Memory namespace: ${calculatorConfig.memory?.namespace}`);

    // Access memory store to show final values
    if (calculatorConfig.memory) {
      const { MemoryStore } = await import('../src/memory-store');
      const memoryStore = MemoryStore.getInstance(calculatorConfig.memory);

      console.log('\n💾 Final memory state:');
      const keys = memoryStore.list('calculator');
      for (const key of keys) {
        const value = memoryStore.get(key, 'calculator');
        console.log(`   ${key}: ${value}`);
      }
    }

  } catch (error) {
    console.error('\n❌ Error running calculator:');
    if (error instanceof Error) {
      console.error(`   ${error.message}`);
      if (error.stack) {
        console.error(`\n${error.stack}`);
      }
    } else {
      console.error(`   ${error}`);
    }
    process.exit(1);
  }

  console.log('\n✨ Done!\n');
}

// ============================================================================
// ALTERNATIVE: Non-interactive mode for testing
// ============================================================================

/**
 * Run calculator with predefined inputs (for testing/automation)
 */
async function runWithPredefinedInputs(num1: number, num2: number, op: string) {
  console.log('\n🤖 Running in automated mode with predefined inputs...\n');

  const inputs = [num1.toString(), num2.toString(), op];
  let inputIndex = 0;

  // Set up hook that uses predefined inputs
  HumanInputCheckProvider.setHooks({
    onHumanInput: async (request: HumanInputRequest) => {
      const value = inputs[inputIndex++];
      console.log(`${request.prompt} ${value}`);
      return value;
    }
  });

  // Run main workflow
  await main();
}

// ============================================================================
// ENTRY POINT
// ============================================================================

if (require.main === module) {
  // Check for command line arguments for automated mode
  const args = process.argv.slice(2);

  if (args.length === 3) {
    // Automated mode: node calculator-sdk-real.js 42 7 +
    const [num1, num2, op] = args;
    runWithPredefinedInputs(parseFloat(num1), parseFloat(num2), op)
      .catch(err => {
        console.error('Error:', err);
        process.exit(1);
      });
  } else if (args.length > 0) {
    console.error('Usage:');
    console.error('  Interactive mode: ts-node calculator-sdk-real.ts');
    console.error('  Automated mode:   ts-node calculator-sdk-real.ts <num1> <num2> <op>');
    console.error('  Example:          ts-node calculator-sdk-real.ts 42 7 +');
    process.exit(1);
  } else {
    // Interactive mode
    main().catch(err => {
      console.error('Error:', err);
      process.exit(1);
    });
  }
}

// Export for use as a module
export { calculatorConfig, customHumanInputHandler, main };
