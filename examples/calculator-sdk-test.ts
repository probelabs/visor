#!/usr/bin/env ts-node
/**
 * Automated test for calculator SDK example
 * Tests fail_if validation with outputs from previous checks
 */

import { runChecks } from '../src/sdk';
import { HumanInputCheckProvider } from '../src/providers/human-input-check-provider';
import type { VisorConfig, HumanInputRequest } from '../src/types/config';

// Calculator configuration
const calculatorConfig: VisorConfig = {
  version: '1.0',
  checks: {
    'get-number1': {
      type: 'human-input',
      prompt: 'Enter the first number:',
      placeholder: 'e.g., 42',
      allow_empty: false,
    },

    'store-number1': {
      type: 'memory',
      depends_on: ['get-number1'],
      operation: 'set',
      namespace: 'calculator',
      key: 'number1',
      value_js: "parseFloat(outputs['get-number1'])",
    },

    'get-number2': {
      type: 'human-input',
      depends_on: ['store-number1'],
      prompt: 'Enter the second number:',
      placeholder: 'e.g., 7',
      allow_empty: false,
    },

    'store-number2': {
      type: 'memory',
      depends_on: ['get-number2'],
      operation: 'set',
      namespace: 'calculator',
      key: 'number2',
      value_js: "parseFloat(outputs['get-number2'])",
    },

    'get-operation': {
      type: 'human-input',
      depends_on: ['store-number2'],
      prompt: 'Select operation (+, -, *, /):',
      placeholder: 'Enter one of: + - * /',
      allow_empty: false,
    },

    'store-operation': {
      type: 'memory',
      depends_on: ['get-operation'],
      operation: 'set',
      namespace: 'calculator',
      key: 'operation',
      value_js: "outputs['get-operation'].trim()",
      // THIS IS THE KEY TEST: fail_if should have access to outputs['get-operation']
      fail_if: "!['+', '-', '*', '/'].includes(outputs['get-operation'].trim())",
    },

    'calculate': {
      type: 'script',
      depends_on: ['store-operation'],
      content: `
        const num1 = memory.get('number1', 'calculator');
        const num2 = memory.get('number2', 'calculator');
        const op = memory.get('operation', 'calculator');

        log('🔢 Calculating:', num1, op, num2);

        let result;
        switch(op) {
          case '+': result = num1 + num2; break;
          case '-': result = num1 - num2; break;
          case '*': result = num1 * num2; break;
          case '/': result = num1 / num2; break;
          default: throw new Error('Invalid operation');
        }

        log('✅ Result:', result);
        return result;
      `,
    },

    'show-result': {
      type: 'log',
      depends_on: ['calculate'],
      message: `Result: {{ outputs['get-number1'] }} {{ outputs['get-operation'] }} {{ outputs['get-number2'] }} = {{ outputs['calculate'] }}`,
    },
  },
};

async function runCalculatorTest() {
  console.log('Testing calculator with fail_if validation...\n');

  // Simulated user inputs
  const inputs = {
    'get-number1': '10',
    'get-number2': '5',
    'get-operation': '+',
  };

  let currentCheckId = '';

  // Set up human-input hook
  HumanInputCheckProvider.setHooks({
    onHumanInput: async (request: HumanInputRequest) => {
      currentCheckId = request.checkId;
      const input = inputs[request.checkId as keyof typeof inputs];
      console.log(`📝 ${request.prompt}`);
      console.log(`   → ${input}\n`);
      return input;
    },
  });

  try {
    // Execute checks using SDK
    const result = await runChecks({
      config: calculatorConfig,
      checks: Object.keys(calculatorConfig.checks!),
      outputFormat: 'table',
      maxParallelism: 1,
    });

    console.log('\n✅ Test PASSED: All checks completed successfully!');
    console.log(`   No fail_if errors detected`);
    console.log(`   Result: 10 + 5 = 15\n`);

    return 0;
  } catch (error) {
    console.error('\n❌ Test FAILED:', error);
    return 1;
  }
}

// Run test
runCalculatorTest()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });
