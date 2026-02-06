#!/usr/bin/env node

/**
 * Calculator SDK Example
 *
 * This example demonstrates how to use the human-input provider with SDK hooks
 * to create an interactive calculator that:
 * 1. Asks user for first number
 * 2. Asks user for second number
 * 3. Asks user for operation (+, -, *, /)
 * 4. Stores values in memory
 * 5. Performs calculation using JavaScript
 * 6. Outputs the result
 *
 * Usage:
 *   node examples/calculator-sdk-example.ts
 *
 * Or with custom hook implementation:
 *   ts-node examples/calculator-sdk-example.ts
 */

import * as readline from 'readline';
import { HumanInputRequest } from '../src/types/config';

// Mock the CheckExecutionEngine - in real usage, you'd import from '@probelabs/visor'
// For this example, we'll simulate the workflow

interface CalculatorConfig {
  version: string;
  checks: Record<string, any>;
  output: any;
  memory?: {
    storage: 'memory';
    namespace: string;
  };
}

const calculatorConfig: CalculatorConfig = {
  version: "1.0",

  memory: {
    storage: 'memory',
    namespace: 'calculator'
  },

  checks: {
    // Step 1: Get first number
    "get-number1": {
      type: "human-input",
      prompt: "Enter the first number:",
      placeholder: "e.g., 42",
      allow_empty: false
    },

    // Step 2: Store first number in memory
    "store-number1": {
      type: "memory",
      depends_on: ["get-number1"],
      operation: "set",
      namespace: "calculator",
      key: "number1",
      value_js: "parseFloat(outputs['get-number1'])"
    },

    // Step 3: Get second number
    "get-number2": {
      type: "human-input",
      depends_on: ["store-number1"],
      prompt: "Enter the second number:",
      placeholder: "e.g., 7",
      allow_empty: false
    },

    // Step 4: Store second number in memory
    "store-number2": {
      type: "memory",
      depends_on: ["get-number2"],
      operation: "set",
      namespace: "calculator",
      key: "number2",
      value_js: "parseFloat(outputs['get-number2'])"
    },

    // Step 5: Get operation
    "get-operation": {
      type: "human-input",
      depends_on: ["store-number2"],
      prompt: "Select operation (+, -, *, /):",
      placeholder: "Enter one of: + - * /",
      allow_empty: false
    },

    // Step 6: Store operation in memory
    "store-operation": {
      type: "memory",
      depends_on: ["get-operation"],
      operation: "set",
      namespace: "calculator",
      key: "operation",
      value_js: "outputs['get-operation'].trim()"
    },

    // Step 7: Perform calculation using memory and JavaScript
    "calculate": {
      type: "script",
      depends_on: ["store-operation"],
      content: `
        // Get values from memory
        const num1 = memory.get('number1', 'calculator');
        const num2 = memory.get('number2', 'calculator');
        const op = memory.get('operation', 'calculator');

        // Log for debugging
        log('Calculating:', num1, op, num2);

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
              throw new Error('Division by zero!');
            }
            result = num1 / num2;
            break;
          default:
            throw new Error('Invalid operation: ' + op);
        }

        // Return result for output
        return result;
      `
    },

    // Step 8: Display the result
    "show-result": {
      type: "log",
      depends_on: ["calculate"],
      message: `
╔════════════════════════════════════════╗
║          CALCULATION RESULT            ║
╠════════════════════════════════════════╣
║                                        ║
║  {{ memory.get('number1', 'calculator') }} {{ memory.get('operation', 'calculator') }} {{ memory.get('number2', 'calculator') }} = {{ memory.get('result', 'calculator') }}
║                                        ║
╚════════════════════════════════════════╝
      `
    }
  },

  output: {
    pr_comment: {
      format: "markdown",
      group_by: "check",
      collapse: false
    }
  }
};

/**
 * Custom hook for handling human input via readline
 * This is what users would implement in their SDK integration
 */
async function customHumanInputHandler(request: HumanInputRequest): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    console.log('\n┌─────────────────────────────────────────┐');
    console.log(`│ ${request.prompt.padEnd(39)} │`);
    console.log('└─────────────────────────────────────────┘');

    rl.question('> ', (answer) => {
      rl.close();

      const trimmed = answer.trim();
      if (!trimmed && !request.allowEmpty) {
        console.log('❌ Empty input not allowed. Please try again.\n');
        // In real implementation, would retry
        resolve('');
      } else {
        resolve(trimmed || request.default || '');
      }
    });
  });
}

/**
 * Main SDK example
 */
async function main() {
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║   Visor SDK Calculator Example           ║');
  console.log('║   Human Input + Memory + JavaScript      ║');
  console.log('╚═══════════════════════════════════════════╝\n');

  console.log('This example demonstrates:');
  console.log('  • Using human-input checks with SDK hooks');
  console.log('  • Storing data in memory between steps');
  console.log('  • Performing calculations with JavaScript');
  console.log('  • Sequential workflow with dependencies\n');

  console.log('Configuration loaded:');
  console.log(`  - ${Object.keys(calculatorConfig.checks).length} checks defined`);
  console.log(`  - Memory namespace: ${calculatorConfig.memory?.namespace}\n`);

  console.log('─'.repeat(45));
  console.log('Starting interactive calculator workflow...');
  console.log('─'.repeat(45));

  // In a real implementation, you would:
  //
  // import { CheckExecutionEngine } from '@probelabs/visor';
  // import { HumanInputCheckProvider } from '@probelabs/visor/providers';
  //
  // // Set the hook
  // HumanInputCheckProvider.setHooks({
  //   onHumanInput: customHumanInputHandler
  // });
  //
  // // Run the checks
  // const engine = new CheckExecutionEngine();
  // const results = await engine.executeChecks(
  //   prInfo,
  //   calculatorConfig,
  //   Object.keys(calculatorConfig.checks)
  // );
  //
  // console.log('Results:', results);

  console.log('\n📝 To run this example with actual Visor SDK:');
  console.log('   1. Import CheckExecutionEngine and HumanInputCheckProvider');
  console.log('   2. Set the onHumanInput hook with customHumanInputHandler');
  console.log('   3. Execute the checks with the calculator configuration');
  console.log('   4. The workflow will prompt for inputs and calculate result');

  console.log('\n💡 Alternatively, run with CLI:');
  console.log('   Save the config to calculator.yaml and run:');
  console.log('   $ visor --config calculator.yaml');
  console.log('   (Will use interactive terminal prompts automatically)');

  // Save the config for CLI usage
  const fs = require('fs');
  const yaml = require('js-yaml');
  const configPath = __dirname + '/calculator-config.yaml';

  try {
    const yamlContent = yaml.dump(calculatorConfig);
    fs.writeFileSync(configPath, yamlContent);
    console.log(`\n✅ Configuration saved to: ${configPath}`);
  } catch (error) {
    console.log('\n⚠️  Could not save YAML config (js-yaml not installed)');
    console.log('   Install with: npm install js-yaml');
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
}

export { calculatorConfig, customHumanInputHandler };
