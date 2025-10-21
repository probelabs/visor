# Human Input Provider

The human-input provider pauses workflow execution to request input from a human user. This enables interactive workflows, approval gates, and dynamic parameter collection.

## Table of Contents
- [Overview](#overview)
- [Configuration](#configuration)
- [Input Methods](#input-methods)
- [Examples](#examples)
- [SDK Usage](#sdk-usage)
- [Security](#security)

## Overview

The human-input provider supports four input methods, prioritized as follows:

1. **CLI with `--message` argument** - Inline text or file path
2. **Piped stdin** - Input from pipe or file redirect
3. **SDK hook** - Custom `onHumanInput` callback
4. **Interactive prompt** - Beautiful terminal UI (when TTY available)

## Configuration

### Basic Configuration

```yaml
checks:
  approval:
    type: human-input
    prompt: "Do you approve this deployment? (yes/no)"
```

### Full Configuration Options

```yaml
checks:
  approval:
    type: human-input
    prompt: "Enter approval decision"           # Required: prompt text
    placeholder: "Type yes or no..."            # Optional: placeholder text
    allow_empty: false                          # Optional: allow empty input (default: false)
    multiline: false                            # Optional: enable multiline input (default: false)
    timeout: 300                                # Optional: timeout in seconds
    default: "no"                               # Optional: default value
```

### Using Input in Dependent Checks

The user's input is available to dependent checks via the `outputs` variable:

```yaml
checks:
  get-version:
    type: human-input
    prompt: "Enter version number"

  tag-release:
    type: command
    depends_on: [get-version]
    exec: |
      git tag v{{ outputs['get-version'] }}
      git push origin v{{ outputs['get-version'] }}
```

## Input Methods

### 1. CLI with --message

Provide input directly via command line:

```bash
# Inline message
visor --check approval --message "yes"

# From file
visor --check approval --message ./approval.txt
```

### 2. Piped stdin

Pipe input from another command or file:

```bash
# From echo
echo "yes" | visor --check approval

# From file
visor --check approval < approval.txt

# From command
curl https://api.example.com/approval | visor --check approval
```

### 3. SDK Hook

Use a custom hook for programmatic input:

```typescript
import { runChecks, HumanInputCheckProvider } from '@probelabs/visor';

// Option 1: Using deprecated static method (backward compatible)
HumanInputCheckProvider.setHooks({
  onHumanInput: async (request) => {
    console.log(`Prompt: ${request.prompt}`);
    return 'yes';
  }
});

await runChecks({ config });

// Option 2: Using new ExecutionContext (recommended)
await runChecks({
  config,
  executionContext: {
    hooks: {
      onHumanInput: async (request) => {
        console.log(`Prompt: ${request.prompt}`);
        return 'yes';
      }
    }
  }
});
```

The `HumanInputRequest` interface:

```typescript
interface HumanInputRequest {
  checkId: string;        // Check name/ID
  prompt: string;         // Prompt text
  placeholder?: string;   // Placeholder text
  allowEmpty?: boolean;   // Allow empty input
  multiline?: boolean;    // Multiline mode
  timeout?: number;       // Timeout in milliseconds
  default?: string;       // Default value
}
```

### 4. Interactive Terminal Prompt

When running in a TTY (interactive terminal), a beautiful prompt appears:

```
┌─────────────────────────────────────────────┐
│ Enter approval decision                     │
├─────────────────────────────────────────────┤
│ Type yes or no...                           │
│                                             │
│ Press Ctrl+D when done (or Ctrl+C to exit) │
└─────────────────────────────────────────────┘
```

## Examples

### Simple Approval Gate

```yaml
checks:
  manual-approval:
    type: human-input
    prompt: "Approve deployment to production? (yes/no)"
    allow_empty: false

  deploy:
    type: command
    depends_on: [manual-approval]
    fail_if: |
      outputs['manual-approval'].toLowerCase() !== 'yes'
    exec: ./deploy.sh production
```

### Version Input

```yaml
checks:
  get-version:
    type: human-input
    prompt: "Enter version number (e.g., 1.2.3)"

  validate-version:
    type: javascript
    depends_on: [get-version]
    exec: |
      const version = outputs['get-version'];
      const valid = /^\d+\.\d+\.\d+$/.test(version);
      if (!valid) throw new Error('Invalid version format');
```

### Multi-step Input

```yaml
checks:
  get-feature:
    type: human-input
    prompt: "Enter feature name"

  get-description:
    type: human-input
    prompt: "Enter feature description"
    multiline: true
    depends_on: [get-feature]

  create-issue:
    type: command
    depends_on: [get-feature, get-description]
    exec: |
      gh issue create \
        --title "{{ outputs['get-feature'] }}" \
        --body "{{ outputs['get-description'] }}"
```

### Calculator Example

See [examples/calculator-sdk-real.ts](../examples/calculator-sdk-real.ts) for a complete working example with:
- Multiple human-input checks in sequence
- Output passing between checks
- JavaScript execution with user input
- Memory storage

## SDK Usage

### Basic SDK Usage

```typescript
import { runChecks } from '@probelabs/visor';

const config = {
  version: '1.0',
  checks: {
    approval: {
      type: 'human-input',
      prompt: 'Approve? (yes/no)'
    }
  }
};

// Run with execution context (recommended)
const result = await runChecks({
  config,
  executionContext: {
    hooks: {
      onHumanInput: async (request) => {
        // Your custom input logic
        return await getUserInput(request.prompt);
      }
    }
  }
});
```

### With CLI Message

```typescript
import { CheckExecutionEngine } from '@probelabs/visor';

const engine = new CheckExecutionEngine();

// Set execution context
engine.setExecutionContext({
  cliMessage: 'yes'  // Simulates --message flag
});

const result = await engine.executeChecks({
  checks: ['approval'],
  config
});
```

### Automated Testing

```typescript
const testInputs = {
  'get-number1': '42',
  'get-number2': '7',
  'get-operation': '+'
};

await runChecks({
  config,
  executionContext: {
    hooks: {
      onHumanInput: async (request) => {
        return testInputs[request.checkId] || '';
      }
    }
  }
});
```

## Security

The human-input provider includes several security features:

### Input Sanitization

All user input is automatically sanitized before being passed to dependent checks:

- **Null bytes removed** - Prevents C-string injection
- **Control characters removed** - Except newlines and tabs
- **Size limit** - Maximum 100KB per input

### Path Traversal Protection

When using `--message` with file paths:

- **Path normalization** - Resolves `..` components
- **Directory restriction** - Only reads files within current working directory
- **File type validation** - Only reads regular files
- **Async operations** - Non-blocking file I/O

### DoS Prevention

Stdin input has protection against denial-of-service:

- **Size limit** - Default 1MB maximum
- **Timeout support** - Configurable timeout
- **Resource cleanup** - Proper cleanup with `stdin.pause()`

### Execution Context Isolation

The new ExecutionContext pattern eliminates global state:

- **Thread-safe** - No global mutable state
- **Test isolation** - Each execution has isolated context
- **Concurrent safe** - Safe for parallel execution

## Migration Guide

### From Static API to ExecutionContext

**Old way (still works but deprecated):**

```typescript
import { HumanInputCheckProvider, runChecks } from '@probelabs/visor';

HumanInputCheckProvider.setHooks({
  onHumanInput: async (request) => 'yes'
});

await runChecks({ config });
```

**New way (recommended):**

```typescript
import { runChecks } from '@probelabs/visor';

await runChecks({
  config,
  executionContext: {
    hooks: {
      onHumanInput: async (request) => 'yes'
    }
  }
});
```

Benefits of the new approach:
- Thread-safe (no global state)
- Better for concurrent executions
- Easier to test
- More flexible

## See Also

- [Calculator SDK Example](../examples/calculator-sdk-real.ts) - Complete working example
- [Debugging Guide](./debugging.md) - Debugging techniques
- [Command Provider](./command-provider.md) - Executing shell commands
- [MCP Provider](./mcp-provider.md) - MCP integration
