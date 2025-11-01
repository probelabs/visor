# Calculator SDK Example - Quick Reference

## Overview

`calculator-sdk-real.ts` is a complete, runnable example showing how to use Visor SDK programmatically with the human-input provider.

## Features

✅ **Real SDK Usage** - Actual imports and execution, not mocked
✅ **Inline Configuration** - No YAML files needed
✅ **Custom Input Hook** - Shows how to implement your own input handler
✅ **Complete Workflow** - 8 checks with dependencies, memory, and JavaScript
✅ **Error Handling** - Validation and error recovery
✅ **Two Modes** - Interactive (manual input) and automated (for testing)

## Quick Start

### Interactive Mode

```bash
# Build the project first
npm run build

# Run the example
ts-node examples/calculator-sdk-real.ts
```

You'll be prompted for:
1. First number (e.g., 42)
2. Second number (e.g., 7)
3. Operation (+, -, *, /)

### Automated Mode (Testing)

```bash
# Provide inputs as arguments: <num1> <num2> <operation>
ts-node examples/calculator-sdk-real.ts 42 7 +

# Examples:
ts-node examples/calculator-sdk-real.ts 100 25 -
ts-node examples/calculator-sdk-real.ts 6 7 "*"
ts-node examples/calculator-sdk-real.ts 81 9 /
```

## Code Structure

### 1. Configuration (Inline)

```typescript
const calculatorConfig: VisorConfig = {
  version: "1.0",
  memory: {
    storage: 'memory',
    namespace: 'calculator'
  },
  checks: {
    "get-number1": { type: "human-input", prompt: "Enter the first number:" },
    "store-number1": { type: "memory", operation: "set", key: "number1", ... },
    "get-number2": { type: "human-input", prompt: "Enter the second number:" },
    "store-number2": { type: "memory", operation: "set", key: "number2", ... },
    "get-operation": { type: "human-input", prompt: "Select operation:" },
    "store-operation": { type: "memory", operation: "set", key: "operation", ... },
    "calculate": { type: "script", content: "..." },
    "show-result": { type: "log", message: "..." }
  },
  output: { pr_comment: { format: "markdown", group_by: "check", collapse: false } }
};
```

### 2. Custom Hook Implementation

```typescript
async function customHumanInputHandler(request: HumanInputRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    // Display prompt
    console.log(`💬 ${request.prompt}`);

    rl.question('> ', (answer) => {
      rl.close();
      const trimmed = answer.trim();

      if (!trimmed && !request.allowEmpty) {
        reject(new Error('Empty input not allowed'));
      } else {
        resolve(trimmed || request.default || '');
      }
    });
  });
}
```

### 3. SDK Execution

```typescript
async function main() {
  // 1. Set up the hook
  HumanInputCheckProvider.setHooks({
    onHumanInput: customHumanInputHandler
  });

  // 2. Create execution engine
  const engine = new CheckExecutionEngine();

  // 3. Execute checks
  const result = await engine.executeChecks({
    checks: Object.keys(calculatorConfig.checks || {}),
    config: calculatorConfig,
    outputFormat: 'table',
    maxParallelism: 1, // Run sequentially for human input
    debug: false
  });

  // 4. Process results
  console.log('✅ Workflow completed!');
  console.log(`Execution time: ${result.executionTime}ms`);

  // 5. Access memory store for final values
  const { MemoryStore } = await import('../src/memory-store');
  const memoryStore = MemoryStore.getInstance(calculatorConfig.memory);
  const keys = memoryStore.list('calculator');
  for (const key of keys) {
    console.log(`${key}: ${memoryStore.get(key, 'calculator')}`);
  }
}
```

## Workflow Diagram

```
┌─────────────────┐
│  get-number1    │ ← User inputs: 42
│  (human-input)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ store-number1   │ ← Stores parseFloat(42) in memory
│   (memory)      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  get-number2    │ ← User inputs: 7
│  (human-input)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ store-number2   │ ← Stores parseFloat(7) in memory
│   (memory)      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ get-operation   │ ← User inputs: +
│  (human-input)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ store-operation │ ← Stores "+" in memory, validates
│   (memory)      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   calculate     │ ← JavaScript: 42 + 7 = 49
│   (memory)      │    Stores result in memory
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  show-result    │ ← Displays formatted output
│     (log)       │
└─────────────────┘
```

## Key Concepts Demonstrated

### 1. Human Input Integration
- Custom hook implementation
- Prompt customization
- Input validation
- Error handling

### 2. Memory Provider
- Storing values between checks
- Namespace isolation
- JavaScript value transformation (`value_js`)
- Script provider (`type: script`)

### 3. Dependency Management
- Sequential workflow with `depends_on`
- Output passing between checks
- Memory access in JavaScript

### 4. Error Handling
- Input validation with `fail_if`
- Division by zero protection
- Invalid operation detection
- Timeout handling

## Customization Examples

### Change Input Method

Replace readline with any input source:

```typescript
// Slack bot
async function slackInputHandler(request: HumanInputRequest): Promise<string> {
  const response = await slack.askUser(request.checkId, request.prompt);
  return response.text;
}

// Web API
async function apiInputHandler(request: HumanInputRequest): Promise<string> {
  const response = await fetch('/api/input', {
    method: 'POST',
    body: JSON.stringify(request)
  });
  return (await response.json()).value;
}

// GUI Dialog
async function guiInputHandler(request: HumanInputRequest): Promise<string> {
  return await electron.dialog.showInputBox({
    title: request.checkId,
    message: request.prompt
  });
}
```

### Add More Operations

Extend the calculator in the `calculate` step:

```typescript
content: `
  const num1 = memory.get('number1', 'calculator');
  const num2 = memory.get('number2', 'calculator');
  const op = memory.get('operation', 'calculator');

  let result;
  switch(op) {
    case '+': result = num1 + num2; break;
    case '-': result = num1 - num2; break;
    case '*': result = num1 * num2; break;
    case '/':
      if (num2 === 0) throw new Error('Division by zero');
      result = num1 / num2;
      break;
    case '**': result = Math.pow(num1, num2); break;  // Power
    case '%': result = num1 % num2; break;             // Modulo
    case 'sqrt': result = Math.sqrt(num1); break;     // Square root
    default: throw new Error('Invalid operation');
  }

  memory.set('result', result, 'calculator');
  return result;
`
```

### Add Input History

Store previous calculations:

```typescript
checks: {
  // ... existing checks ...

  "save-to-history": {
    type: "memory",
    depends_on: ["calculate"],
    operation: "append",
    namespace: "calculator",
    key: "history",
    value_js: `{
      num1: memory.get('number1', 'calculator'),
      num2: memory.get('number2', 'calculator'),
      operation: memory.get('operation', 'calculator'),
      result: memory.get('result', 'calculator'),
      timestamp: new Date().toISOString()
    }`
  },

  "show-history": {
    type: "log",
    depends_on: ["save-to-history"],
    message: "Previous calculations: {{ memory.get('history', 'calculator') | json }}"
  }
}
```

## Real-World Use Cases

This pattern can be adapted for:

1. **Approval Workflows**
   - Deployment approvals
   - Code review confirmations
   - Release gate checks

2. **Interactive Debugging**
   - Runtime parameter input
   - Configuration selection
   - Environment validation

3. **Data Collection**
   - User feedback gathering
   - Bug report details
   - Configuration wizards

4. **Quality Gates**
   - Manual test verification
   - Performance sign-off
   - Security review approval

## Tips

1. **Always validate input** - Use `fail_if` or JavaScript validation
2. **Provide defaults** - For optional inputs or timeouts
3. **Use memory** - For complex workflows with multiple steps
4. **Handle errors** - Try/catch in JavaScript, validation in checks
5. **Test automated mode** - Use predefined inputs for CI/CD testing

## Troubleshooting

### "Empty input not allowed"
- Check `allow_empty: true` in config
- Provide a `default` value
- Ensure your hook doesn't return empty strings

### "Division by zero"
- The example includes validation for this
- Add similar checks for your operations

### "Invalid operation"
- Check the `fail_if` validation in `store-operation`
- Ensure allowed operations match your JavaScript switch

### Hook not being called
- Verify `HumanInputCheckProvider.setHooks()` is called before `engine.executeChecks()`
- Check that check type is `"human-input"`
- Ensure the hook returns a Promise<string>

## Next Steps

- Modify the calculator for your use case
- Implement a custom input handler (Slack, GUI, etc.)
- Add more complex workflows with branching
- Integrate with your existing tools and services

## See Also

- `examples/calculator-config.yaml` - YAML version for CLI usage
- `examples/human-input-example.yaml` - Basic human-input patterns
- `docs/human-input-feature-plan.md` - Complete feature specification
- `docs/human-input-implementation-summary.md` - Implementation details
