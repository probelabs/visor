## Script Step (`type: script`)

The `script` provider executes JavaScript in a secure sandbox with access to PR context, dependency outputs, workflow inputs, environment variables, and the Visor memory store.

## Configuration

| Property | Required | Description |
|----------|----------|-------------|
| `type` | Yes | Must be `script` |
| `content` | Yes | JavaScript code to execute (max 1MB) |
| `depends_on` | No | Array of step IDs this step depends on |
| `group` | No | Group name for organizing steps |
| `on` | No | Event triggers for this step |
| `if` | No | Condition to evaluate before running |
| `fail_if` | No | Condition to fail the step |
| `on_fail` | No | Routing configuration on failure |
| `on_success` | No | Routing configuration on success |

## Sandbox Context

The secure sandbox exposes these objects and functions:

### Data Objects

| Object | Description |
|--------|-------------|
| `pr` | PR metadata: `number`, `title`, `body`, `author`, `base`, `head`, `totalAdditions`, `totalDeletions`, `files[]` |
| `outputs` | Map of dependency outputs (current values). Access via `outputs['step-name']` |
| `outputs.history` | Map of all historical outputs per step (arrays). See [Output History](./output-history.md) |
| `outputs_history` | Alias for `outputs.history` (top-level access) |
| `outputs_raw` | Aggregated values from `-raw` suffix dependencies |
| `outputs_history_stage` | Per-stage output history slice (used by test framework) |
| `inputs` | Workflow inputs (when running inside a workflow) |
| `args` | Arguments passed via `with:` directive in `on_init` |
| `env` | Environment variables (`process.env`) |

### Memory Operations

| Method | Description |
|--------|-------------|
| `memory.get(key, namespace?)` | Retrieve a value |
| `memory.has(key, namespace?)` | Check if key exists |
| `memory.list(namespace?)` | List all keys in namespace |
| `memory.getAll(namespace?)` | Get all key-value pairs |
| `memory.set(key, value, namespace?)` | Set a value |
| `memory.append(key, value, namespace?)` | Append to an array |
| `memory.increment(key, amount?, namespace?)` | Increment numeric value (default: 1) |
| `memory.delete(key, namespace?)` | Delete a key |
| `memory.clear(namespace?)` | Clear all keys in namespace |

### Utility Functions

| Function | Description |
|----------|-------------|
| `log(...args)` | Debug logging (outputs with prefix for identification) |
| `escapeXml(str)` | Escape string for XML output |
| `btoa(str)` | Base64 encode a string |
| `atob(str)` | Base64 decode a string |

## Return Value

The value you `return` from the script becomes the step's `output`, accessible to dependent steps via `outputs['step-name']`.

## Examples

### Basic Example

```yaml
steps:
  extract-facts:
    type: command
    exec: node ./scripts/extract-facts.js

  aggregate:
    type: script
    depends_on: [extract-facts]
    content: |
      const facts = outputs['extract-facts'] || [];
      memory.set('total_facts', Array.isArray(facts) ? facts.length : 0, 'fact-validation');
      const allValid = Array.isArray(facts) && facts.every(f => f.valid === true);
      memory.set('all_valid', allValid, 'fact-validation');
      return { total: memory.get('total_facts', 'fact-validation'), allValid };
```

### Using PR Context

```yaml
steps:
  analyze-pr:
    type: script
    content: |
      const largeFiles = pr.files.filter(f => f.additions > 100);
      const totalChanges = pr.totalAdditions + pr.totalDeletions;

      return {
        largeFileCount: largeFiles.length,
        totalChanges,
        isLargePR: totalChanges > 500,
        author: pr.author
      };
```

### Using Output History

```yaml
steps:
  track-retries:
    type: script
    depends_on: [some-check]
    content: |
      // Access all previous outputs from a check
      const history = outputs.history['some-check'] || [];
      const retryCount = history.length;

      log('Retry count:', retryCount);
      log('Previous outputs:', history);

      return {
        retryCount,
        lastOutput: history[history.length - 1]
      };
```

### Using Workflow Inputs

```yaml
# In a workflow file
inputs:
  - name: threshold
    default: 10

steps:
  check-threshold:
    type: script
    content: |
      const threshold = inputs.threshold || 10;
      const count = outputs['counter'].value;

      return {
        passed: count < threshold,
        message: count < threshold
          ? 'Within threshold'
          : `Exceeded threshold of ${threshold}`
      };
```

### Complex Data Processing

```yaml
steps:
  process-results:
    type: script
    depends_on: [run-tests]
    content: |
      const results = outputs['run-tests'];

      // Calculate statistics
      const stats = {
        total: results.tests?.length || 0,
        passed: results.tests?.filter(t => t.passed).length || 0,
        failed: results.tests?.filter(t => !t.passed).length || 0
      };

      stats.passRate = stats.total > 0
        ? ((stats.passed / stats.total) * 100).toFixed(2)
        : 0;

      // Store in memory for other steps
      memory.set('test_stats', stats);

      // Debug logging
      log('Test stats:', stats);

      return stats;
```

## Related Documentation

- [Memory Provider](./memory.md) - Persistent key-value storage
- [Output History](./output-history.md) - Tracking outputs across iterations
- [Dependencies](./dependencies.md) - Step dependency system
- [Liquid Templates](./liquid-templates.md) - Template syntax for other providers
- [Debugging](./debugging.md) - Debugging techniques including the `log()` function
