#!/usr/bin/env node

/**
 * Calculator SDK - Fully Automated (Non-Interactive)
 *
 * This example shows how to:
 * - Run calculations without user interaction
 * - Provide inputs programmatically
 * - Get pure JSON output
 * - Use for testing or automation
 *
 * Usage:
 *   npm run build
 *   bun examples/calculator-sdk-automated.ts
 *   bun examples/calculator-sdk-automated.ts 10 5 +
 */

import { HumanInputRequest, VisorConfig } from '../src/types/config';
import { HumanInputCheckProvider } from '../src/providers/human-input-check-provider';
import { CheckExecutionEngine } from '../src/check-execution-engine';

// ============================================================================
// CONFIGURATION
// ============================================================================

const calculatorConfig: VisorConfig = {
  version: "1.0",

  memory: {
    namespace: "calculator",
    persist: false
  },

  checks: {
    "get-number1": {
      type: "human-input",
      prompt: "Enter the first number:",
    },

    "store-number1": {
      type: "memory",
      depends_on: ["get-number1"],
      operation: "set",
      namespace: "calculator",
      key: "number1",
      value_js: "parseFloat(outputs['get-number1'])"
    },

    "get-number2": {
      type: "human-input",
      depends_on: ["store-number1"],
      prompt: "Enter the second number:",
    },

    "store-number2": {
      type: "memory",
      depends_on: ["get-number2"],
      operation: "set",
      namespace: "calculator",
      key: "number2",
      value_js: "parseFloat(outputs['get-number2'])"
    },

    "get-operation": {
      type: "human-input",
      depends_on: ["store-number2"],
      prompt: "Select operation (+, -, *, /):",
    },

    "store-operation": {
      type: "memory",
      depends_on: ["get-operation"],
      operation: "set",
      namespace: "calculator",
      key: "operation",
      value_js: "outputs['get-operation'].trim()",
      fail_if: "!['+', '-', '*', '/'].includes(outputs['get-operation'].trim())"
    },

    "calculate": {
      type: "memory",
      depends_on: ["store-operation"],
      operation: "exec_js",
      namespace: "calculator",
      memory_js: `
        const num1 = memory.get('number1', 'calculator');
        const num2 = memory.get('number2', 'calculator');
        const op = memory.get('operation', 'calculator');

        let result;
        switch(op) {
          case '+': result = num1 + num2; break;
          case '-': result = num1 - num2; break;
          case '*': result = num1 * num2; break;
          case '/':
            if (num2 === 0) throw new Error('Division by zero!');
            result = num1 / num2;
            break;
          default: throw new Error('Invalid operation: ' + op);
        }

        memory.set('result', result, 'calculator');
        return result;
      `
    }
  }
};

// ============================================================================
// AUTOMATED INPUT PROVIDER
// ============================================================================

interface CalculatorInputs {
  'get-number1': string;
  'get-number2': string;
  'get-operation': string;
}

/**
 * Create an automated input handler with predefined values
 */
function createAutomatedInputHandler(inputs: CalculatorInputs) {
  return async (request: HumanInputRequest): Promise<string> => {
    const checkId = request.checkId as keyof CalculatorInputs;
    const value = inputs[checkId];

    if (value === undefined) {
      throw new Error(`No automated input provided for check: ${checkId}`);
    }

    return value;
  };
}

// ============================================================================
// SUPPRESS ALL CONSOLE OUTPUT
// ============================================================================

function suppressAllOutput() {
  const noop = () => {};
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const originalDebug = console.debug;

  console.log = noop;
  console.error = noop;
  console.warn = noop;
  console.info = noop;
  console.debug = noop;

  return {
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
      console.info = originalInfo;
      console.debug = originalDebug;
    }
  };
}

// ============================================================================
// CALCULATION FUNCTION
// ============================================================================

interface CalculationResult {
  success: boolean;
  calculation?: {
    number1: number;
    number2: number;
    operation: string;
    result: number;
    expression: string;
  };
  executionTime?: number;
  issues?: any[];
  error?: string;
}

async function calculate(
  num1: string,
  num2: string,
  operation: string,
  options: { verbose?: boolean; suppressOutput?: boolean } = {}
): Promise<CalculationResult> {
  const { verbose = false, suppressOutput = true } = options;

  try {
    // Set up automated inputs
    HumanInputCheckProvider.setHooks({
      onHumanInput: createAutomatedInputHandler({
        'get-number1': num1,
        'get-number2': num2,
        'get-operation': operation
      })
    });

    // Suppress console output if requested
    const suppressor = suppressOutput ? suppressAllOutput() : null;

    // Create execution engine
    const engine = new CheckExecutionEngine();

    // Execute all checks
    const checksToRun = Object.keys(calculatorConfig.checks || {});

    const result = await engine.executeChecks({
      checks: checksToRun,
      config: calculatorConfig,
      outputFormat: 'json',
      maxParallelism: 1,
      debug: false
    });

    // Restore console
    if (suppressor) suppressor.restore();

    // Extract results from memory
    const { MemoryStore } = await import('../src/memory-store');
    const memoryStore = MemoryStore.getInstance(calculatorConfig.memory);

    const n1 = memoryStore.get('number1', 'calculator');
    const n2 = memoryStore.get('number2', 'calculator');
    const op = memoryStore.get('operation', 'calculator');
    const resultValue = memoryStore.get('result', 'calculator');

    return {
      success: true,
      calculation: {
        number1: n1,
        number2: n2,
        operation: op,
        result: resultValue,
        expression: `${n1} ${op} ${n2} = ${resultValue}`
      },
      executionTime: result.executionTime,
      issues: result.summary?.issues || []
    };

  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);

  let num1: string, num2: string, operation: string;

  if (args.length >= 3) {
    // Use command line arguments
    [num1, num2, operation] = args;
  } else {
    // Use default values for demo
    num1 = '10';
    num2 = '5';
    operation = '+';
  }

  console.log('🧮 Calculator SDK - Automated Mode\n');
  console.log(`Input: ${num1} ${operation} ${num2}\n`);

  // Run calculation
  const result = await calculate(num1, num2, operation, {
    verbose: false,
    suppressOutput: true
  });

  // Display result
  if (result.success && result.calculation) {
    console.log('✅ Calculation Complete!\n');
    console.log('📊 Result (JSON):\n');
    console.log(JSON.stringify(result, null, 2));

    console.log('\n' + '─'.repeat(50));
    console.log('Expression:', result.calculation.expression);
    console.log('─'.repeat(50));

    if (result.issues && result.issues.length > 0) {
      console.log(`\n⚠️  ${result.issues.length} issue(s) found`);
    }
  } else {
    console.log('❌ Calculation Failed!\n');
    console.log('Error:', result.error);
  }

  console.log();

  // Run additional test cases
  console.log('🧪 Running Test Cases...\n');

  const testCases = [
    { num1: '100', num2: '25', operation: '-', expected: 75 },
    { num1: '7', num2: '8', operation: '*', expected: 56 },
    { num1: '100', num2: '4', operation: '/', expected: 25 },
    { num1: '15', num2: '3', operation: '+', expected: 18 },
  ];

  const results = await Promise.all(
    testCases.map(tc =>
      calculate(tc.num1, tc.num2, tc.operation, { suppressOutput: true })
    )
  );

  console.log('Test Results:');
  console.log('─'.repeat(70));
  console.log('Input'.padEnd(20), 'Expected'.padEnd(15), 'Actual'.padEnd(15), 'Status');
  console.log('─'.repeat(70));

  results.forEach((result, idx) => {
    const tc = testCases[idx];
    const input = `${tc.num1} ${tc.operation} ${tc.num2}`;
    const expected = tc.expected;
    const actual = result.calculation?.result;
    const status = actual === expected ? '✅ PASS' : '❌ FAIL';

    console.log(
      input.padEnd(20),
      String(expected).padEnd(15),
      String(actual).padEnd(15),
      status
    );
  });

  console.log('─'.repeat(70));
  console.log('\n✨ Done!\n');
}

// Run main
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
