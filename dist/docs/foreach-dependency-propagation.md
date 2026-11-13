# ForEach Output: Validation, Dependent Propagation, and on_finish

This doc clarifies how `forEach` output is validated, how it affects dependent checks, and how to use the `on_finish` hook for aggregation and routing after all forEach iterations complete.

## Valid and invalid outputs

- `transform_js` or provider output must resolve to a value. If it is `undefined`, the engine emits an error:
  - Issue: `forEach/execution_error`
  - Effect: direct dependents are skipped (`dependency_failed`).
- If the value is an array, the engine iterates items.
- If the value is a string, the engine tries to JSON.parse it; if it parses to an array, that array is used; otherwise it treats the string as a single item.
- If the value is `null`, it is normalized to an empty array (0 iterations).

## Empty arrays vs undefined

- `[]` (empty array): valid — the check runs zero iterations. Dependents that rely on items are effectively skipped (no provider execution), and you’ll see a log like:

```
forEach: no items from "fetch-tickets", skipping check...
```

- `undefined`: invalid — treated as a configuration/transform error. The engine emits a `forEach/execution_error` issue and skips direct dependents.

## Example

```yaml
steps:
  fetch-tickets:
    type: command
    exec: echo '{"tickets": []}'
    transform_js: JSON.parse(output).tickets
    forEach: true

  analyze-ticket:
    type: command
    depends_on: [fetch-tickets]
    exec: echo "TICKET: {{ outputs['fetch-tickets'].key }}"
```

- If `tickets` is `[]`, `analyze-ticket` is effectively skipped (no per‑item execution).
- If `transform_js` returns `undefined`, the engine raises `forEach/execution_error` and `analyze-ticket` is skipped due to a failed dependency.

## Output Access and History with forEach

When a check has `forEach: true`, three accessors are available:
- `outputs['check-name']` — nearest value in scope (inside an iteration, this is the current item).
- `outputs_raw['check-name']` — aggregate/parent value (the full array produced by the forEach parent).
- `outputs.history['check-name']` — all committed values up to the current snapshot (alias: `outputs_history['check-name']`).

```yaml
steps:
  process-items:
    type: script
    depends_on: [fetch-tickets]
    forEach: true
    content: |
      const curr = outputs['fetch-tickets'];
      return { itemId: curr.key, processed: true };

  summarize:
    type: script
    depends_on: [process-items]
    content: |
      // Access all forEach iteration results
      // Also available as: outputs_history['process-items']
      const allProcessed = outputs.history['process-items'];
      return { totalProcessed: allProcessed.length };
```

Precedence rules (summary):
- `outputs['x']` resolves to the nearest item if inside a per-item scope of `x`; otherwise to an ancestor value; otherwise to the latest committed.
- `outputs_raw['x']` resolves to the shallowest/aggregate scope of `x` (e.g., the full array for a forEach parent).
- `outputs.history['x']` returns all committed values for `x` in this session up to the snapshot.

Routing JS also gets `outputs_raw` with the same semantics, so you can branch on the aggregate even when you’re inside a per-item iteration.

See [Output History](./output-history.md) for more details on tracking outputs across iterations.

## The on_finish Hook: Lifecycle Extension

The `on_finish` hook is a special routing action that extends the forEach lifecycle. It triggers **once** after **all** dependent checks complete **all** their iterations, providing a single point for aggregation and routing decisions.

### Complete forEach Lifecycle

```
1. forEach Check Executes
   └─> Outputs array: [item1, item2, item3]

2. Dependent Checks Execute (N iterations)
   ├─> dependent-check runs for item1
   ├─> dependent-check runs for item2
   └─> dependent-check runs for item3

3. on_finish Hook Triggers (on the forEach check)
   ├─> on_finish.run executes (optional aggregation checks)
   ├─> on_finish.run_js evaluates (optional dynamic checks)
   ├─> on_finish.goto_js evaluates (optional routing decision)
   └─> If goto returns a check name, jump to that ancestor

4. Downstream Checks Execute
   └─> Checks that don't depend on the forEach check continue
```

### When on_finish Triggers

- **Only** on checks with `forEach: true`
- **After** ALL dependent checks complete ALL iterations
- **Does not** trigger if forEach array is empty (`[]`)
- **Does not** trigger if output is `undefined` (error state)
- **Always** triggers after successful forEach propagation

### Configuration

```yaml
checks:
  extract-facts:
    type: ai
    forEach: true
    prompt: "Extract facts from {{ outputs.response }}"
    transform_js: JSON.parse(output).facts

    # on_finish runs after all validate-fact iterations complete
    on_finish:
      # Optional: Run aggregation checks
      run: [aggregate-validations]

      # Optional: Make routing decision
      goto_js: |
        const allValid = memory.get('all_facts_valid', 'validation');
        const attempt = memory.get('fact_validation_attempt', 'validation') || 0;

        if (allValid) {
          return null;  // Continue to downstream checks
        }

        if (attempt >= 1) {
          return null;  // Max attempts, give up
        }

        memory.increment('fact_validation_attempt', 1, 'validation');
        return 'generate-response';  // Jump back to ancestor

      # Optional: Override event for goto target
      goto_event: issue_opened

  validate-fact:
    type: ai
    depends_on: [extract-facts]
    # Runs N times (once per fact)

  aggregate-validations:
    type: script
    fanout: reduce  # ensure single aggregation run after forEach
    content: |
      // Access all validation results
      const validations = outputs.history['validate-fact'];
      const allValid = validations.every(v => v.is_valid);
      memory.set('all_facts_valid', allValid, 'validation');
      return { total: validations.length, valid: allValid };
```

### Context Available in on_finish

```javascript
{
  step: {
    id: 'extract-facts',
    tags: [...],
    group: '...'
  },
  attempt: 1,           // Attempt number for this check
  loop: 0,              // Loop number in routing (starts at 0)
  outputs: {
    'extract-facts': [...],     // The forEach array
    'validate-fact': [...],     // Latest dependent results
    history: {...}              // Same as outputs_history
  },
  outputs_history: {
    'extract-facts': [[...], ...],  // Historical forEach outputs
    'validate-fact': [[...], ...],  // ALL iteration results
  },
  outputs_raw: {
    'extract-facts': [...],     // Raw outputs without history
  },
  forEach: {
    items: 3            // Number of items in the forEach array
  },
  memory: {             // Memory access functions
    get: (key, ns?) => value,
    has: (key, ns?) => boolean,
    getAll: (ns?) => object,
    set: (key, value, ns?) => void,
    clear: (ns?) => void,
    increment: (key, amount?, ns?) => number
  },
  pr: {                 // PR metadata
    number: 123,
    title: '...',
    author: '...',
    branch: '...',
    base: '...'
  },
  files,                // Changed files
  env,                  // Environment variables
  event: { name: '...' } // Event that triggered execution
}
```

### Flow Diagram with on_finish

```
┌─────────────────────┐
│  forEach Check      │
│  outputs: [1,2,3]   │
└──────────┬──────────┘
           │
           ├──────────────────────────────┐
           │                              │
           ▼                              ▼
    ┌──────────────┐            ┌──────────────┐
    │ Dependent A  │            │ Dependent B  │
    │ (3 times)    │            │ (3 times)    │
    └──────┬───────┘            └──────┬───────┘
           │                           │
           └───────────┬───────────────┘
                       │
                       ▼
            ┌─────────────────────┐
            │   on_finish hook    │
            │   ┌─────────────┐   │
            │   │   run: []   │   │
            │   ├─────────────┤   │
            │   │  goto_js    │   │
            │   └─────────────┘   │
            └──────────┬──────────┘
                       │
         ┌─────────────┴──────────────┐
         │                            │
         ▼                            ▼
    goto target?                 Downstream
    (ancestor)                    Checks
```

### Example: Validation with Retry

A complete example showing validation, aggregation, and retry:

```yaml
checks:
  # Step 1: Generate initial response
  generate-response:
    type: ai
    prompt: "Generate response for: {{ event.issue.body }}"

  # Step 2: Extract facts (forEach)
  extract-facts:
    type: ai
    depends_on: [generate-response]
    forEach: true
    prompt: |
      Extract verifiable facts from: {{ outputs['generate-response'] }}
      Return JSON: [{"claim": "...", "category": "..."}]
    transform_js: JSON.parse(output)

    # Step 5: Aggregate and route
    on_finish:
      run: [aggregate-validations]
      goto_js: |
        const allValid = memory.get('all_valid', 'fact-validation');
        const attempt = memory.get('attempt', 'fact-validation') || 0;

        log('Validation complete:', {
          allValid,
          attempt,
          items: forEach.items + ' facts checked'
        });

        if (allValid) {
          log('All valid, proceeding to post');
          return null;
        }

        if (attempt >= 1) {
          log('Max attempts reached');
          return null;
        }

        log('Retrying with validation context');
        memory.increment('attempt', 1, 'fact-validation');
        return 'generate-response';

  # Step 3: Validate each fact (runs N times)
  validate-fact:
    type: ai
    depends_on: [extract-facts]
    prompt: |
      Verify this fact using code search:
      Claim: {{ outputs['extract-facts'].claim }}
      Category: {{ outputs['extract-facts'].category }}

      Return JSON: {"is_valid": true/false, "evidence": "..."}
    transform_js: JSON.parse(output)

  # Step 4: Aggregate all validation results
  aggregate-validations:
    type: script
    content: |
      // Get ALL validation results from forEach iterations
      const validations = outputs.history['validate-fact'];

      log('Aggregating', validations.length, 'validations');

      const invalid = validations.filter(v => !v.is_valid);
      const allValid = invalid.length === 0;

      // Store for goto_js and downstream checks
      memory.set('all_valid', allValid, 'fact-validation');
      memory.set('invalid_count', invalid.length, 'fact-validation');

      // Store issues for retry context
      if (!allValid) {
        memory.set('validation_issues', invalid, 'fact-validation');
      }

      return {
        total: validations.length,
        valid: validations.length - invalid.length,
        invalid: invalid.length,
        all_valid: allValid
      };

  # Step 6: Post response (only if valid)
  post-response:
    type: github
    depends_on: [extract-facts]
    if: "memory.get('all_valid', 'fact-validation') === true"
    op: comment.create
    value: "{{ outputs['generate-response'] }}"
```

**Flow:**
1. `generate-response` runs → outputs AI response
2. `extract-facts` runs → outputs `[fact1, fact2, fact3]`
3. `validate-fact` runs 3 times (once per fact)
4. **on_finish triggers:**
   - `aggregate-validations` runs → stores results in memory
   - `goto_js` evaluates → returns `'generate-response'` or `null`
5. If goto returned a check name:
   - Jump to `generate-response` (with incremented attempt counter)
   - Re-run the entire flow with validation context
6. If goto returned `null`:
   - Continue to `post-response` (if validation passed)

### Multiple Dependents Pattern

The power of `on_finish` is aggregating across **multiple** dependent checks:

```yaml
checks:
  extract-claims:
    type: ai
    forEach: true
    on_finish:
      run: [aggregate-all]
      goto_js: |
        const securityOk = memory.get('security_ok', 'validation');
        const techOk = memory.get('tech_ok', 'validation');
        return (securityOk && techOk) ? null : 'retry';

  # Multiple dependents, all run N times
  validate-security:
    depends_on: [extract-claims]

  validate-technical:
    depends_on: [extract-claims]

  validate-style:
    depends_on: [extract-claims]

  aggregate-all:
    type: script
    fanout: reduce
    content: |
      // Access ALL results from ALL dependent checks
      const security = outputs.history['validate-security'];
      const technical = outputs.history['validate-technical'];
      const style = outputs.history['validate-style'];

      memory.set('security_ok', security.every(r => r.valid), 'validation');
      memory.set('tech_ok', technical.every(r => r.valid), 'validation');
      memory.set('style_ok', style.every(r => r.valid), 'validation');

      return { aggregated: true };
```

This is the **only way** to aggregate across multiple dependent checks after forEach completes.

### Error Handling in on_finish

- If `on_finish.run` checks fail, the forEach check is marked as failed
- If `goto_js` throws an error, the engine falls back to static `goto` (if present)
- If no fallback exists, the error is logged and execution continues
- Loop safety: `on_finish.goto` counts toward `routing.max_loops`

### Best Practices for on_finish

1. **Always Aggregate First**: Use `on_finish.run` to aggregate before `goto_js` runs
2. **Use outputs.history**: Access all iteration results with `outputs.history['check-name']`
3. **Store in Memory**: Pass aggregated state to `goto_js` and downstream checks via memory
4. **Limit Retries**: Track attempt counts in memory to prevent infinite loops
5. **Handle Empty Arrays**: Check `forEach.items` or array length before processing
6. **Log Decisions**: Use `log()` in JavaScript to debug routing decisions
7. **Check Multiple Dependents**: Perfect for scenarios with multiple dependent checks

### Common Pitfalls

❌ **Don't** use `on_finish` on non-forEach checks:
```yaml
regular-check:
  type: command
  on_finish:  # ❌ ERROR: on_finish requires forEach: true
    run: [something]
```

❌ **Don't** forget to return from `goto_js`:
```javascript
goto_js: |
  const shouldRetry = memory.get('should_retry');
  'retry-check';  // ❌ Missing return statement
```

✅ **Do** return explicitly:
```javascript
goto_js: |
  const shouldRetry = memory.get('should_retry');
  return shouldRetry ? 'retry-check' : null;  // ✅ Explicit return
```

❌ **Don't** access `outputs['check']` for iteration results:
```javascript
// ❌ Only gives latest result
const results = outputs['validate-fact'];
```

✅ **Do** use `outputs.history` for all iterations:
```javascript
// ✅ All iteration results
const results = outputs.history['validate-fact'];
```

## Tips

- Always `return` from `transform_js`. Missing `return` is the most common cause of `undefined`.
- Prefer returning arrays directly from `transform_js` (avoid stringifying) to keep types clear and avoid parsing surprises.
- Use `outputs.history` to access all forEach iteration results in dependent checks and `on_finish` hooks.
- Use `on_finish` for aggregation after all forEach iterations complete.
- Store aggregated state in memory for use in `goto_js` and downstream checks.
- Track attempt counters in memory to prevent infinite retry loops.

## See Also

- [Failure Routing](./failure-routing.md) - Complete `on_finish` reference with examples
- [Dependencies](./dependencies.md) - `on_finish` with forEach propagation patterns
- [Output History](./output-history.md) - Accessing historical outputs across iterations
- [examples/fact-validator.yaml](../examples/fact-validator.yaml) - Complete working example

## Fan-out Control for Routing (Phase 5)

When routing from a forEach context, you can opt into per‑item runs without writing manual loops:

- Add `fanout: map` to the target check to schedule it once per item.
- Add `fanout: reduce` (or `reduce: true`) to run once at the parent scope (default).

This works with `on_success.run/goto`, `on_fail.run/goto`, and `on_finish.run/goto`.

Example:
```yaml
checks:
  files:
    type: command
    exec: git ls-files '*.ts'
    forEach: true
    on_success:
      run: [lint-file]

  lint-file:
    type: command
    fanout: map
    exec: eslint {{ outputs['files'] }}
```
