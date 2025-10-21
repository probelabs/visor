#!/usr/bin/env node

/**
 * Calculator SDK Example with JSON Output
 *
 * This example shows how to:
 * - Use JSON output format instead of table
 * - Suppress stdout/stderr messages from the engine
 * - Get clean JSON response for programmatic processing
 * - Visualize results in custom script logic
 *
 * Usage:
 *   npm run build
 *   bun examples/calculator-sdk-json.ts
 */

import * as readline from 'readline';
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
      placeholder: "e.g., 42",
      allow_empty: false,
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
      placeholder: "e.g., 7",
      allow_empty: false,
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
      placeholder: "Enter one of: + - * /",
      allow_empty: false,
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
    },

    "format-result": {
      type: "log",
      depends_on: ["calculate"],
      level: "info",
      message: `{{ outputs['get-number1'] }} {{ outputs['get-operation'] }} {{ outputs['get-number2'] }} = {{ outputs['calculate'] }}`
    }
  }
};

// ============================================================================
// CUSTOM INPUT HANDLER (Quiet Mode)
// ============================================================================

/**
 * Minimal readline-based input handler for SDK mode
 * Only shows the prompt, not the engine's debug output
 */
async function customHumanInputHandler(request: HumanInputRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const promptText = request.placeholder
      ? `${request.prompt} (${request.placeholder}): `
      : `${request.prompt}: `;

    rl.question(promptText, (answer: string) => {
      rl.close();

      const trimmed = answer.trim();

      // Validate
      if (!request.allowEmpty && trimmed === '') {
        if (request.default) {
          resolve(request.default);
        } else {
          reject(new Error('Input cannot be empty'));
        }
      } else {
        resolve(trimmed || request.default || '');
      }
    });

    // Handle timeout if specified
    if (request.timeout) {
      setTimeout(() => {
        rl.close();
        if (request.default) {
          resolve(request.default);
        } else {
          reject(new Error('Input timeout'));
        }
      }, request.timeout);
    }
  });
}

// ============================================================================
// SUPPRESS ENGINE OUTPUT (Optional)
// ============================================================================

/**
 * Capture and suppress console output from the engine
 * Returns a restore function to revert
 */
function suppressConsole() {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalInfo = console.info;

  const logs: string[] = [];

  console.log = (...args: any[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args: any[]) => {
    logs.push('[ERROR] ' + args.map(String).join(' '));
  };
  console.warn = (...args: any[]) => {
    logs.push('[WARN] ' + args.map(String).join(' '));
  };
  console.info = (...args: any[]) => {
    logs.push('[INFO] ' + args.map(String).join(' '));
  };

  return {
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
      console.info = originalInfo;
    },
    getLogs: () => logs
  };
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  console.log('🧮 Calculator SDK - JSON Output Mode\n');

  try {
    // Set up the human input hook
    HumanInputCheckProvider.setHooks({
      onHumanInput: customHumanInputHandler
    });

    // Suppress engine console output
    const suppressor = suppressConsole();

    // Create execution engine
    const engine = new CheckExecutionEngine();

    // Execute all checks in the workflow with JSON output
    const checksToRun = Object.keys(calculatorConfig.checks || {});

    const result = await engine.executeChecks({
      checks: checksToRun,
      config: calculatorConfig,
      outputFormat: 'json',  // ← JSON format for programmatic processing
      maxParallelism: 1,     // Sequential for human input
      debug: false           // No debug output
    });

    // Restore console
    suppressor.restore();

    // ========================================================================
    // PROCESS JSON RESULT
    // ========================================================================

    console.log('\n📊 Execution Results (JSON):\n');
    console.log(JSON.stringify(result, null, 2));

    // ========================================================================
    // CUSTOM VISUALIZATION
    // ========================================================================

    console.log('\n✨ Custom Visualization:\n');

    // Extract calculation details from memory
    const { MemoryStore } = await import('../src/memory-store');
    const memoryStore = MemoryStore.getInstance(calculatorConfig.memory);

    const num1 = memoryStore.get('number1', 'calculator');
    const num2 = memoryStore.get('number2', 'calculator');
    const operation = memoryStore.get('operation', 'calculator');
    const resultValue = memoryStore.get('result', 'calculator');

    // Display in custom format
    console.log('┌─────────────────────────────────┐');
    console.log('│      CALCULATION RESULT         │');
    console.log('├─────────────────────────────────┤');
    console.log(`│  First Number:  ${String(num1).padEnd(15)} │`);
    console.log(`│  Second Number: ${String(num2).padEnd(15)} │`);
    console.log(`│  Operation:     ${String(operation).padEnd(15)} │`);
    console.log('├─────────────────────────────────┤');
    console.log(`│  Result:        ${String(resultValue).padEnd(15)} │`);
    console.log('└─────────────────────────────────┘');

    // Show execution statistics
    console.log('\n📈 Execution Statistics:');
    console.log(`   - Total checks: ${checksToRun.length}`);
    console.log(`   - Execution time: ${result.executionTime}ms`);
    console.log(`   - Timestamp: ${result.timestamp}`);

    // Check for issues
    const totalIssues = result.summary?.issues?.length || 0;
    if (totalIssues > 0) {
      console.log(`\n⚠️  Issues found: ${totalIssues}`);
      result.summary.issues.forEach((issue: any, idx: number) => {
        console.log(`   ${idx + 1}. [${issue.severity}] ${issue.message}`);
      });
    } else {
      console.log('\n✅ No issues found!');
    }

    // Return structured data for further processing
    return {
      success: true,
      calculation: {
        number1: num1,
        number2: num2,
        operation: operation,
        result: resultValue,
        expression: `${num1} ${operation} ${num2} = ${resultValue}`
      },
      executionTime: result.executionTime,
      issues: result.summary?.issues || []
    };

  } catch (error) {
    console.error('\n❌ Error running calculator:');
    if (error instanceof Error) {
      console.error(`   ${error.message}`);
    } else {
      console.error(`   ${error}`);
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

// Run and display final result
main()
  .then((finalResult) => {
    console.log('\n🎯 Final Result Object:\n');
    console.log(JSON.stringify(finalResult, null, 2));
    console.log('\n✨ Done!\n');
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
