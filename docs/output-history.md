# Output History

The `outputs.history` feature tracks all outputs from check executions, making it easy to access previous iterations in loops, retries, and forEach operations.

## Overview

When checks execute multiple times (through `goto` loops, `retry` attempts, or `forEach` iterations), Visor automatically tracks all output values in `outputs.history`. This is essential for:

- **Loop iteration tracking** - Access all values from previous goto loop iterations
- **Retry analysis** - See outputs from all retry attempts
- **forEach processing** - Track all items processed in a forEach loop
- **Debugging** - Understand the full execution history
- **Progressive calculations** - Build on previous iteration results

## Structure

The `outputs` variable has two main parts:

```javascript
outputs['check-name']          // Current/latest value from this check
outputs.history['check-name']  // Array of ALL previous values from this check
```

### Current vs History

- **`outputs['check-name']`** - Always contains the **LATEST** value
  - Updated each time the check executes
  - Single value (not an array)
  - What you typically want to use for conditions and decisions

- **`outputs.history['check-name']`** - Contains **ALL PREVIOUS** values
  - Array of all outputs in chronological order
  - First element is from first execution, last is most recent
  - Useful for tracking progress, calculating totals, comparing changes

## Usage Examples

### Basic Loop Tracking

Track a counter through multiple goto iterations:

```yaml
checks:
  counter:
    type: memory
    operation: exec_js
    memory_js: |
      const count = (memory.get('count') || 0) + 1;
      memory.set('count', count);
      return { iteration: count, timestamp: Date.now() };

  process:
    type: memory
    depends_on: [counter]
    operation: exec_js
    memory_js: |
      // Current iteration
      log('Current iteration:', outputs.counter.iteration);

      // All previous iterations
      log('All iterations:', outputs.history.counter.map(h => h.iteration));

      // History length equals current iteration
      log('History length:', outputs.history.counter.length);

      return `Processed iteration ${outputs.counter.iteration}`;
    on_success:
      goto: counter
      goto_js: |
        // Continue looping until iteration 5
        return outputs.counter.iteration < 5 ? 'counter' : null;
```

### Retry Tracking

Track all retry attempts:

```yaml
checks:
  attempt-counter:
    type: memory
    operation: exec_js
    memory_js: |
      const attempt = (memory.get('attempt') || 0) + 1;
      memory.set('attempt', attempt);
      return { attempt, timestamp: Date.now() };

  flaky-operation:
    type: command
    depends_on: [attempt-counter]
    exec: './scripts/flaky-operation.sh'
    transform_js: |
      const attempt = outputs['attempt-counter'].attempt;
      log('Attempt number:', attempt);

      // Simulate success only on 3rd attempt
      if (attempt < 3) {
        throw new Error('Simulated failure');
      }

      return {
        succeeded: true,
        attempt,
        allAttempts: outputs.history['attempt-counter'].map(h => h.attempt)
      };
    on_fail:
      retry:
        max_attempts: 5
        delay: 1000
      goto: attempt-counter
```

### forEach History

Track all forEach iterations:

```yaml
checks:
  generate-items:
    type: memory
    operation: exec_js
    memory_js: |
      return [
        { id: 1, name: 'alpha', value: 10 },
        { id: 2, name: 'beta', value: 20 },
        { id: 3, name: 'gamma', value: 30 }
      ];

  process-item:
    type: memory
    depends_on: [generate-items]
    forEach: true
    operation: exec_js
    memory_js: |
      // Process current item
      const processed = {
        ...item,
        doubled: item.value * 2,
        processedAt: Date.now()
      };

      log('Processing item:', item.id);
      log('Items processed so far:', outputs.history['process-item'].length);

      return processed;

  summarize:
    type: memory
    depends_on: [process-item]
    operation: exec_js
    memory_js: |
      // Access all forEach results
      const allProcessed = outputs.history['process-item'];

      return {
        totalProcessed: allProcessed.length,
        totalValue: allProcessed.reduce((sum, item) => sum + item.doubled, 0),
        allIds: allProcessed.map(item => item.id),
        allNames: allProcessed.map(item => item.name)
      };
```

### Comparing with Previous Iteration

Compare current value with previous:

```yaml
checks:
  monitor-metric:
    type: command
    exec: 'curl -s https://api.example.com/metrics | jq .cpu_usage'
    transform_js: |
      const current = parseFloat(output);
      return { value: current, timestamp: Date.now() };

  check-trend:
    type: memory
    depends_on: [monitor-metric]
    operation: exec_js
    memory_js: |
      const current = outputs['monitor-metric'].value;
      const history = outputs.history['monitor-metric'];

      if (history.length > 1) {
        const previous = history[history.length - 1].value;
        const change = current - previous;
        const percentChange = (change / previous) * 100;

        log('Current:', current);
        log('Previous:', previous);
        log('Change:', percentChange.toFixed(2) + '%');

        if (percentChange > 50) {
          throw new Error(`CPU usage spiked by ${percentChange.toFixed(2)}%`);
        }
      }

      return { current, changeTracked: history.length > 1 };
    on_success:
      goto: monitor-metric
      goto_js: |
        // Monitor for 5 iterations
        return outputs.history['monitor-metric'].length < 5 ? 'monitor-metric' : null;
```

### Progressive Aggregation

Build up results over iterations:

```yaml
checks:
  fetch-page:
    type: memory
    operation: exec_js
    memory_js: |
      const page = (memory.get('page') || 0) + 1;
      memory.set('page', page);

      // Simulate fetching a page of data
      return {
        page,
        items: [`item-${page}-1`, `item-${page}-2`, `item-${page}-3`]
      };

  aggregate-results:
    type: memory
    depends_on: [fetch-page]
    operation: exec_js
    memory_js: |
      // Collect all items from all pages
      const allPages = outputs.history['fetch-page'];
      const allItems = allPages.flatMap(page => page.items);

      log('Pages fetched:', allPages.length);
      log('Total items:', allItems.length);

      return {
        totalPages: allPages.length,
        totalItems: allItems.length,
        items: allItems
      };
    on_success:
      goto: fetch-page
      goto_js: |
        // Fetch 3 pages
        return outputs.history['fetch-page'].length < 3 ? 'fetch-page' : null;
```

## Access in Different Contexts

### JavaScript Expressions

In `memory_js`, `transform_js`, `goto_js`, `fail_if`, etc.:

```javascript
// Current value
outputs['check-name']
outputs.checkName

// History array
outputs.history['check-name']
outputs.history.checkName

// Array operations
outputs.history.counter.length
outputs.history.counter.map(h => h.value)
outputs.history.counter.filter(h => h.success)
outputs.history.counter.every(h => h.valid)
outputs.history.counter.some(h => h.error)
```

### Liquid Templates

In templates (logger, http body, etc.):

```liquid
{# Current value #}
Current: {{ outputs.counter }}

{# History array #}
History: {% for val in outputs.history.counter %}{{ val }}{% unless forloop.last %}, {% endunless %}{% endfor %}

{# History length #}
Total iterations: {{ outputs.history.counter.size }}

{# Access specific iteration #}
First: {{ outputs.history.counter[0] }}
Last: {{ outputs.history.counter | last }}

{# Complex iteration #}
{% for item in outputs.history['process-item'] %}
  - Item {{ item.id }}: {{ item.name }}
{% endfor %}
```

### Command Templates

In shell commands:

```yaml
checks:
  show-history:
    type: command
    depends_on: [counter]
    exec: |
      echo "Current: {{ outputs.counter }}"
      echo "History: {{ outputs.history.counter | json }}"
```

## Important Behaviors

### History Contains Current Execution

The history array includes the current execution. So after 3 iterations:
- `outputs.counter` = value from 3rd iteration
- `outputs.history.counter` = `[value1, value2, value3]` (length = 3)

### Empty History

If a check hasn't executed yet, or has no output:
- `outputs.history['check-name']` = `[]` (empty array, not undefined)
- Always safe to check `.length` or iterate

### Failed Executions

Failed executions that throw errors are NOT added to history. Only successful outputs are tracked.

### forEach Iterations

Each forEach iteration is tracked separately:

```yaml
checks:
  process-items:
    forEach: true
    operation: exec_js
    memory_js: |
      return { itemId: item.id, processed: true };
```

After processing 3 items, `outputs.history['process-items']` will have 3 entries (one per item).

## Debugging with History

### Log All Iterations

```javascript
log('All counter values:', outputs.history.counter);
log('Iterations count:', outputs.history.counter.length);
```

### Verify Sequential Execution

```javascript
// Check that iterations are sequential
for (let i = 0; i < outputs.history.counter.length; i++) {
  if (outputs.history.counter[i].iteration !== i + 1) {
    throw new Error('Iteration order incorrect');
  }
}
```

### Track Timing

```javascript
const allTimestamps = outputs.history.counter.map(h => h.timestamp);
const durations = [];
for (let i = 1; i < allTimestamps.length; i++) {
  durations.push(allTimestamps[i] - allTimestamps[i-1]);
}
log('Average iteration time:', durations.reduce((a,b) => a+b, 0) / durations.length);
```

## Performance Considerations

- History stores only the output values, not full check results
- Memory usage grows linearly with iterations (O(n))
- For very long-running loops (100+ iterations), consider periodically clearing or summarizing
- Use `max_loops` configuration to prevent infinite loops

## Related Documentation

- [Liquid Templates](./liquid-templates.md) - Using history in templates
- [Memory Provider](./memory.md) - Storing and accessing state
- [Failure Routing](./failure-routing.md) - Using goto and retry with history
- [forEach Dependency Propagation](./foreach-dependency-propagation.md) - How forEach interacts with history
- [Debugging](./debugging.md) - Debugging techniques using history

## Examples

See the test files for complete working examples:
- `tests/unit/output-history.test.ts` - Basic history functionality
- `tests/integration/output-history-integration.test.ts` - Complex loop scenarios
- `tests/unit/goto-current-output.test.ts` - Verifying current vs history values
