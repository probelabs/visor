# Calculator SDK - JSON Output Guide

This guide explains how to use the calculator examples with JSON output for programmatic processing.

## Overview

Three calculator variants are provided:

1. **`calculator-sdk-real.ts`** - Interactive with table output (original)
2. **`calculator-sdk-json.ts`** - Interactive with JSON output + custom visualization
3. **`calculator-sdk-automated.ts`** - Non-interactive with pure JSON output

## Quick Start

### Interactive with JSON Output

```bash
bun examples/calculator-sdk-json.ts
```

**Features:**
- Prompts for user input
- Uses `outputFormat: 'json'`
- Suppresses engine console output
- Returns structured JSON
- Custom visualization in script

**Output:**
```json
{
  "success": true,
  "calculation": {
    "number1": 10,
    "number2": 5,
    "operation": "+",
    "result": 15,
    "expression": "10 + 5 = 15"
  },
  "executionTime": 1234,
  "issues": []
}
```

### Fully Automated (No Interaction)

```bash
# With default values (10 + 5)
bun examples/calculator-sdk-automated.ts

# With custom values
bun examples/calculator-sdk-automated.ts 100 25 -

# Output is pure JSON
bun examples/calculator-sdk-automated.ts 7 8 '*' --json
```

**Features:**
- No user interaction required
- Inputs provided programmatically
- All console output suppressed
- Perfect for testing & automation
- Includes test suite

## Key Techniques

### 1. Using JSON Output Format

```typescript
const result = await engine.executeChecks({
  checks: checksToRun,
  config: calculatorConfig,
  outputFormat: 'json',  // ← Instead of 'table'
  maxParallelism: 1,
  debug: false
});
```

### 2. Suppressing Console Output

```typescript
function suppressAllOutput() {
  const noop = () => {};
  const originalLog = console.log;
  // ... save all console methods

  console.log = noop;
  console.error = noop;
  console.warn = noop;
  // ... suppress all

  return {
    restore: () => {
      console.log = originalLog;
      // ... restore all
    }
  };
}

// Usage
const suppressor = suppressAllOutput();
const result = await engine.executeChecks({...});
suppressor.restore();
```

### 3. Automated Input Provider

```typescript
function createAutomatedInputHandler(inputs: {
  'get-number1': string;
  'get-number2': string;
  'get-operation': string;
}) {
  return async (request: HumanInputRequest): Promise<string> => {
    return inputs[request.checkId];
  };
}

// Set the hook
HumanInputCheckProvider.setHooks({
  onHumanInput: createAutomatedInputHandler({
    'get-number1': '10',
    'get-number2': '5',
    'get-operation': '+'
  })
});
```

### 4. Accessing Memory Results

```typescript
const { MemoryStore } = await import('../src/memory-store');
const memoryStore = MemoryStore.getInstance(config.memory);

const result = memoryStore.get('result', 'calculator');
const num1 = memoryStore.get('number1', 'calculator');
```

## JSON Output Structure

The result from `executeChecks` with `outputFormat: 'json'` returns:

```typescript
interface ExecutionResult {
  executionTime: number;
  timestamp: string;
  summary: {
    issues: Array<{
      file: string;
      line: number;
      ruleId: string;
      message: string;
      severity: 'info' | 'warning' | 'error' | 'critical';
      category: string;
    }>;
  };
  // Additional fields based on output format
}
```

## Custom Result Structure

You can transform this into your own structure:

```typescript
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

async function calculate(num1, num2, op): Promise<CalculationResult> {
  // Suppress output
  const suppressor = suppressAllOutput();

  // Execute
  const result = await engine.executeChecks({
    outputFormat: 'json',
    // ...
  });

  suppressor.restore();

  // Extract from memory
  const memoryStore = MemoryStore.getInstance();
  const resultValue = memoryStore.get('result', 'calculator');

  // Return custom structure
  return {
    success: true,
    calculation: {
      number1: parseFloat(num1),
      number2: parseFloat(num2),
      operation: op,
      result: resultValue,
      expression: `${num1} ${op} ${num2} = ${resultValue}`
    },
    executionTime: result.executionTime,
    issues: result.summary?.issues || []
  };
}
```

## Testing Example

```typescript
// Run multiple calculations programmatically
const testCases = [
  { num1: '100', num2: '25', operation: '-', expected: 75 },
  { num1: '7', num2: '8', operation: '*', expected: 56 },
  { num1: '100', num2: '4', operation: '/', expected: 25 },
];

const results = await Promise.all(
  testCases.map(tc =>
    calculate(tc.num1, tc.num2, tc.operation, { suppressOutput: true })
  )
);

// Verify results
results.forEach((result, idx) => {
  const tc = testCases[idx];
  const passed = result.calculation?.result === tc.expected;
  console.log(`${tc.num1} ${tc.operation} ${tc.num2} = ${result.calculation?.result} ${passed ? '✅' : '❌'}`);
});
```

## Benefits

### For Production Use
- ✅ Clean JSON output for APIs
- ✅ No stdout pollution
- ✅ Easy to parse and process
- ✅ Structured error handling

### For Testing
- ✅ Automated test suites
- ✅ CI/CD integration
- ✅ Reproducible results
- ✅ No user interaction needed

### For Monitoring
- ✅ Log to files/databases
- ✅ Metrics collection
- ✅ Alerting on failures
- ✅ Performance tracking

## Integration Examples

### Express API Endpoint

```typescript
app.post('/api/calculate', async (req, res) => {
  const { num1, num2, operation } = req.body;

  const result = await calculate(num1, num2, operation, {
    suppressOutput: true
  });

  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json({ error: result.error });
  }
});
```

### CLI Tool with JSON Flag

```typescript
if (process.argv.includes('--json')) {
  const result = await calculate(num1, num2, op, { suppressOutput: true });
  console.log(JSON.stringify(result));
} else {
  // Interactive mode
  await interactiveCalculator();
}
```

### Background Job

```typescript
async function processCalculations(jobs: CalculationJob[]) {
  const results = await Promise.all(
    jobs.map(job =>
      calculate(job.num1, job.num2, job.operation, {
        suppressOutput: true
      })
    )
  );

  // Store results in database
  await db.calculations.insertMany(results);

  return results;
}
```

## See Also

- **SDK Documentation**: `docs/sdk.md`
- **Human Input Feature**: `docs/human-input-feature-plan.md`
- **Memory Provider**: `src/providers/memory-check-provider.ts`
- **Examples**: `examples/calculator-*.ts`
