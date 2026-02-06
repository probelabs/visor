# Memory Provider

The Memory provider enables persistent key-value storage across checks, allowing you to implement stateful workflows, retry logic with counters, error aggregation, and complex orchestration patterns.

## Table of Contents

- [Overview](#overview)
- [Configuration](#configuration)
- [Operations](#operations)
- [Namespaces](#namespaces)
- [Storage Formats](#storage-formats)
- [Access Patterns](#access-patterns)
- [Examples](#examples)
- [Best Practices](#best-practices)

## Overview

The Memory provider acts as a shared data store that persists across check executions. It supports:

- **Multiple operations**: get, set, append, increment, delete, clear, list
- **Namespace isolation**: Separate data contexts for different workflows
- **In-memory or file-based storage**: Choose between speed or persistence
- **Multiple formats**: JSON or CSV for file storage
- **Template and JavaScript access**: Use memory in Liquid templates and JS expressions

## Configuration

### Root-Level Configuration

Configure memory storage at the root level of your `.visor.yaml`:

```yaml
version: "1.0"

# Global memory configuration
memory:
  # Storage mode: "memory" (in-memory, default) or "file" (persistent)
  storage: memory | file

  # Storage format (only for file storage, default: json)
  format: json | csv

  # File path (required if storage: file)
  file: ./memory.json

  # Default namespace (default: "default")
  namespace: default

  # Auto-load on startup (default: true if storage: file)
  auto_load: true

  # Auto-save after operations (default: true if storage: file)
  auto_save: true

steps:
  # ... your checks
```

### Check-Level Configuration

Each memory check requires:

```yaml
steps:
  my-memory-check:
    type: memory

    # Operation (required)
    operation: get | set | append | increment | delete | clear | list

    # Key (required for get/set/append/increment/delete)
    key: string

    # Value (required for set/append, optional for increment)
    value: any

    # OR compute value dynamically
    value_js: "javascript_expression"

    # Or run custom JavaScript as a separate step
  my-script-step:
    type: script
    content: |
      // Full JavaScript with statements, loops, conditionals
      memory.set('key', 'value');
      return result;

    # Transform value (optional)
    transform: "{{ liquid_template }}"
    transform_js: "javascript_expression"

    # Override namespace (optional)
    namespace: custom-namespace
```

## Operations

### get

Retrieve a value from memory.

```yaml
steps:
  get-counter:
    type: memory
    operation: get
    key: counter
```

Returns the value, or `undefined` if the key doesn't exist.

### set

Set or override a value in memory.

```yaml
steps:
  set-counter:
    type: memory
    operation: set
    key: counter
    value: 0
```

### append

Append a value to an array. Creates a new array if the key doesn't exist.

```yaml
steps:
  append-error:
    type: memory
    operation: append
    key: errors
    value: "Error message"
```

### increment

Increment a numeric value. Creates a new counter starting at 0 if the key doesn't exist.

```yaml
steps:
  # Increment by 1 (default)
  increment-counter:
    type: memory
    operation: increment
    key: counter

  # Increment by custom amount
  increment-score:
    type: memory
    operation: increment
    key: score
    value: 10

  # Decrement (negative increment)
  decrement-remaining:
    type: memory
    operation: increment
    key: remaining
    value: -1

  # Dynamic increment amount
  increment-by-pr:
    type: memory
    operation: increment
    key: total_changes
    value_js: "pr.totalAdditions + pr.totalDeletions"
```

Returns the new value after increment. Throws an error if the existing value is not a number.

### delete

Delete a key from memory.

```yaml
steps:
  delete-temp:
    type: memory
    operation: delete
    key: temp_data
```

Returns `true` if deleted, `false` if key didn't exist.

### clear

Clear all keys in a namespace.

```yaml
steps:
  clear-all:
    type: memory
    operation: clear
    # Optional: specify namespace
    namespace: staging
```

### list

List all keys in a namespace.

```yaml
steps:
  list-keys:
    type: memory
    operation: list
    # Optional: specify namespace
    namespace: production
```

Returns an array of key names.

### Script

Execute custom JavaScript with full memory access. Useful for complex logic, loops, conditionals, and direct manipulation of memory state via the `memory` helper.

```yaml
steps:
  complex-logic:
    type: script
    content: |
      // Access existing values
      const errors = memory.get('errors') || [];
      const warnings = memory.get('warnings') || [];

      // Complex calculations
      const total = errors.length + warnings.length;
      const severity = total > 10 ? 'critical' : total > 5 ? 'warning' : 'ok';

      // Store results
      memory.set('total_issues', total);
      memory.set('severity', severity);

      // Return custom object
      return {
        total,
        severity,
        hasErrors: errors.length > 0
      };
```

 

**Available memory operations (in script context):**
- `memory.get(key, namespace?)` - Get value
- `memory.set(key, value, namespace?)` - Set value
- `memory.append(key, value, namespace?)` - Append to array
- `memory.increment(key, amount?, namespace?)` - Increment numeric value (default amount: 1)
- `memory.delete(key, namespace?)` - Delete key
- `memory.clear(namespace?)` - Clear namespace
- `memory.list(namespace?)` - List keys
- `memory.has(key, namespace?)` - Check if key exists
- `memory.getAll(namespace?)` - Get all key-value pairs

**Context available in script content:**
- `memory` - Memory operations object (see available operations above)
- `pr` - PR information (number, title, author, etc.)
- `outputs` - Previous check outputs (current values)
- `outputs.history` - All previous outputs from each check (arrays). See [Output History](./output-history.md)
- `outputs_history` - Alias for `outputs.history` (top-level access)
- `inputs` - Workflow inputs (when running inside a workflow)
- `args` - Arguments passed via `with:` directive in `on_init`
- `env` - Environment variables
- `log(...args)` - Debug logging function
- `escapeXml(str)` - Escape string for XML output
- `btoa(str)` - Base64 encode a string
- `atob(str)` - Base64 decode a string

## Namespaces

Namespaces provide isolation between different memory contexts.

### Default Namespace

If not specified, the global `memory.namespace` setting is used (defaults to "default"):

```yaml
memory:
  namespace: production

steps:
  set-counter:
    type: memory
    operation: set
    key: counter
    value: 10
    # Uses "production" namespace
```

### Per-Check Namespace Override

Override the namespace for specific checks:

```yaml
steps:
  set-prod:
    type: memory
    operation: set
    key: counter
    value: 100
    namespace: production

  set-stage:
    type: memory
    operation: set
    key: counter
    value: 50
    namespace: staging
```

### Accessing Different Namespaces

Access data from specific namespaces in templates and JavaScript:

```liquid
<!-- Liquid -->
{{ memory.get('counter', 'production') }}
{{ memory.get('counter', 'staging') }}
```

```javascript
// JavaScript
memory.get('counter', 'production')
memory.get('counter', 'staging')
```

## Storage Formats

### In-Memory Storage (Default)

Fast but not persistent across restarts:

```yaml
memory:
  storage: memory
```

### File Storage - JSON

Persistent, human-readable, supports complex objects:

```yaml
memory:
  storage: file
  file: ./data/memory.json
  format: json
```

**JSON Structure:**
```json
{
  "default": {
    "counter": 5,
    "errors": ["error1", "error2"],
    "metadata": {
      "version": "1.0"
    }
  },
  "production": {
    "counter": 100
  }
}
```

### File Storage - CSV

Persistent, tabular format, good for simple data:

```yaml
memory:
  storage: file
  file: ./data/memory.csv
  format: csv
```

**CSV Structure:**
```csv
namespace,key,value,type
default,counter,"5",number
default,errors,"error1",string
default,errors,"error2",string
production,counter,"100",number
```

## Access Patterns

### In Liquid Templates

Use `memory_get`, `memory_has`, and `memory_list` filters:

```yaml
steps:
  log-status:
    type: log
    message: |
      Counter: {{ "counter" | memory_get }}
      Has errors: {{ "errors" | memory_has }}
      All keys: {{ "" | memory_list | json }}
```

### In JavaScript Expressions

The `memory` object is available in `value_js`, `transform_js`, `fail_if`, etc.:

```yaml
steps:
  increment:
    type: memory
    operation: set
    key: counter
    value_js: "memory.get('counter') + 1"

  check-limit:
    type: noop
    fail_if: "memory.get('counter') > 10"
```

**Available Methods:**
- `memory.get(key, namespace?)` - Get value
- `memory.has(key, namespace?)` - Check if key exists
- `memory.list(namespace?)` - List all keys
- `memory.getAll(namespace?)` - Get all key-value pairs

### Access Dependency Outputs

```yaml
steps:
  run-test:
    type: command
    exec: npm test

  store-result:
    type: memory
    operation: set
    key: test_result
    value_js: 'outputs["run-test"].exitCode'
    depends_on: [run-test]
```

### Access PR Information

```yaml
steps:
  store-pr-number:
    type: memory
    operation: set
    key: pr_number
    value_js: "pr.number"
```

## Examples

### Retry Counter with goto

```yaml
memory:
  storage: memory

steps:
  init-retry:
    type: memory
    operation: set
    key: retry_count
    value: 0

  run-test:
    type: command
    exec: npm test
    depends_on: [init-retry]
    on_fail:
      run: [increment-retry]
      goto_js: "memory.get('retry_count') < 3 ? 'run-test' : null"

  increment-retry:
    type: memory
    operation: increment
    key: retry_count
```

**Note:** You can also track retry history using `outputs.history['increment-retry']` to see all previous retry count values. See [Output History](./output-history.md) for tracking outputs across loop iterations.

### Error Collection

```yaml
memory:
  storage: file
  file: ./errors.json

steps:
  init-errors:
    type: memory
    operation: set
    key: errors
    value: []

  validate-code:
    type: command
    exec: eslint src/
    on_fail:
      run: [collect-error]

  collect-error:
    type: memory
    operation: append
    key: errors
    value: "{{ outputs['validate-code'].stderr }}"

  report-errors:
    type: log
    depends_on: [collect-error]
    message: |
      Found {{ "errors" | memory_get | size }} errors:
      {% for error in "errors" | memory_get %}
      - {{ error }}
      {% endfor %}
```

### Workflow State Machine

```yaml
memory:
  storage: file
  file: ./workflow.json

steps:
  init-state:
    type: memory
    operation: set
    key: state
    value: "pending"

  step1:
    type: command
    exec: ./scripts/step1.sh
    depends_on: [init-state]
    on_success:
      run: [set-state-step1]

  set-state-step1:
    type: memory
    operation: set
    key: state
    value: "step1_complete"

  step2:
    type: command
    exec: ./scripts/step2.sh
    depends_on: [set-state-step1]
    if: 'memory.get("state") === "step1_complete"'
    on_success:
      run: [set-state-step2]

  set-state-step2:
    type: memory
    operation: set
    key: state
    value: "completed"
```

### Multi-Namespace Configuration

```yaml
memory:
  storage: file
  file: ./memory.json
  namespace: production

steps:
  # Production counter
  prod-init:
    type: memory
    operation: set
    key: counter
    value: 100

  # Staging counter (different namespace)
  stage-init:
    type: memory
    operation: set
    key: counter
    value: 10
    namespace: staging

  # Compare values
  compare:
    type: log
    depends_on: [prod-init, stage-init]
    message: |
      Production: {{ "counter" | memory_get: "production" }}
      Staging: {{ "counter" | memory_get: "staging" }}
```

### Dynamic Value Computation

```yaml
steps:
  calculate-score:
    type: memory
    operation: set
    key: score
    value_js: |
      const errors = outputs["lint"].issues?.length || 0;
      const warnings = outputs["test"].failures || 0;
      return Math.max(0, 100 - (errors * 10) - (warnings * 5));
    depends_on: [lint, test]

  check-score:
    type: noop
    fail_if: "memory.get('score') < 70"
    depends_on: [calculate-score]
```

### Complex Logic with script

```yaml
memory:
  storage: memory

steps:
  # Collect test results
  run-tests:
    type: command
    exec: npm test -- --json
    transform_js: "JSON.parse(output)"

  # Analyze results with complex logic
  analyze-results:
    type: script
    depends_on: [run-tests]
    content: |
      // Get test results
      const results = outputs['run-tests'];

      // Calculate statistics
      const stats = {
        total: results.numTotalTests || 0,
        passed: results.numPassedTests || 0,
        failed: results.numFailedTests || 0,
        skipped: results.numPendingTests || 0
      };

      // Calculate pass rate
      stats.passRate = stats.total > 0
        ? (stats.passed / stats.total * 100).toFixed(2)
        : 0;

      // Determine status
      let status;
      if (stats.failed === 0 && stats.total > 0) {
        status = 'excellent';
      } else if (stats.passRate >= 90) {
        status = 'good';
      } else if (stats.passRate >= 70) {
        status = 'acceptable';
      } else {
        status = 'poor';
      }

      // Store analysis
      memory.set('test_stats', stats);
      memory.set('test_status', status);

      // Collect failed test names
      if (results.testResults) {
        const failures = [];
        for (const suite of results.testResults) {
          for (const test of suite.assertionResults || []) {
            if (test.status === 'failed') {
              failures.push({
                suite: suite.name,
                test: test.fullName,
                message: test.failureMessages?.[0]
              });
            }
          }
        }
        memory.set('test_failures', failures);
      }

      // Return summary
      return {
        stats,
        status,
        failureCount: stats.failed
      };

  # Report results
  report:
    type: log
    depends_on: [analyze-results]
    message: |
      ## Test Results

      Status: **{{ "test_status" | memory_get | upcase }}**

      {% assign stats = "test_stats" | memory_get %}
      - Total: {{ stats.total }}
      - Passed: {{ stats.passed }}
      - Failed: {{ stats.failed }}
      - Pass Rate: {{ stats.passRate }}%

      {% assign failures = "test_failures" | memory_get %}
      {% if failures.size > 0 %}
      ### Failed Tests
      {% for failure in failures %}
      - **{{ failure.test }}**
        - Suite: {{ failure.suite }}
        - Error: {{ failure.message | truncate: 100 }}
      {% endfor %}
      {% endif %}

  # Fail if status is poor
  check-quality:
    type: noop
    depends_on: [report]
    fail_if: "memory.get('test_status') === 'poor'"
```

 

## Best Practices

### 1. Choose the Right Storage Mode

- **Use in-memory** for temporary data within a single run
- **Use file storage** for data that needs to persist across runs

### 2. Use Namespaces for Isolation

- Separate production/staging/development data
- Isolate different workflow contexts
- Avoid key collisions between independent workflows

### 3. Initialize Before Use

Always initialize memory values before using them:

```yaml
steps:
  init:
    type: memory
    operation: set
    key: counter
    value: 0

  use:
    type: memory
    operation: set
    key: counter
    value_js: "memory.get('counter') + 1"
    depends_on: [init]
```

### 4. Use Meaningful Key Names

Use descriptive, namespaced keys:

```yaml
# Good
key: workflow_retry_count
key: validation_errors
key: deployment_state

# Avoid
key: count
key: data
key: temp
```

### 5. Clean Up When Done

Clear temporary data when the workflow completes:

```yaml
steps:
  cleanup:
    type: memory
    operation: clear
    namespace: temporary
```

### 6. Handle Missing Keys

Always check if a key exists before using it:

```javascript
// Check existence
if (memory.has('counter')) {
  return memory.get('counter') + 1;
}
return 1;

// Or use default
const count = memory.get('counter') || 0;
```

### 7. Use append for Collections

For collecting multiple values, use `append` instead of manual array management:

```yaml
# Good
steps:
  collect-error:
    type: memory
    operation: append
    key: errors
    value: "{{ error_message }}"

# Avoid
steps:
  collect-error-manual:
    type: memory
    operation: set
    key: errors
    value_js: "[...(memory.get('errors') || []), '{{ error_message }}']"
```

### 8. Version Your Storage Files

For file-based storage, use versioning to avoid conflicts:

```yaml
memory:
  storage: file
  file: ./memory-v1.json  # Version in filename
```

### 9. Monitor Memory Size

For long-running workflows, periodically clear or archive old data to prevent unbounded growth.

### 10. Document Your Memory Schema

Add comments documenting the memory keys your workflow uses:

```yaml
# Memory keys used:
# - retry_count: number - Current retry attempt (0-3)
# - errors: string[] - Collected error messages
# - workflow_state: string - Current state (pending|running|complete)

steps:
  # ...
```

## Troubleshooting

### Key Not Found

If `memory.get()` returns `undefined`, the key may not be initialized:

```yaml
# Add initialization
steps:
  init:
    type: memory
    operation: set
    key: my_key
    value: default_value
```

### File Not Persisting

Ensure `auto_save` is enabled:

```yaml
memory:
  storage: file
  file: ./memory.json
  auto_save: true  # Must be true for auto-persistence
```

### Namespace Confusion

Always specify the namespace when accessing data:

```javascript
// Explicit namespace
memory.get('counter', 'production')

// Or use the default
memory.get('counter')  // Uses global memory.namespace
```

### Value Not Updating

Ensure dependencies are set correctly:

```yaml
steps:
  update:
    type: memory
    operation: set
    key: value
    value: 10
    depends_on: [init]  # Wait for init first
```

## Related Documentation

- [Liquid Templates](./liquid-templates.md)
- [Failure Routing](./failure-routing.md)
- [Commands](./commands.md)
- [Recipes](./recipes.md)
