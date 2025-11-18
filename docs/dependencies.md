## 📊 Step Dependencies & Intelligent Execution

Visor supports defining dependencies between checks using `depends_on`. This enables:

- Sequential execution: dependents wait for prerequisites to finish
- Parallel optimization: independent checks run simultaneously
- Smart scheduling: automatic topological ordering

### Configuration Example

```yaml
version: "1.0"
steps:
  security:
    type: ai
    group: code-review
    schema: code-review
    prompt: "Comprehensive security analysis..."
    tags:
      - security
      - critical
      - comprehensive
    on:
      - pr_opened
      - pr_updated
    # No dependencies - runs first

  performance:
    type: ai
    group: code-review
    schema: code-review
    prompt: "Performance analysis..."
    tags:
      - performance
      - fast
      - local
      - remote
    on:
      - pr_opened
      - pr_updated
    # No dependencies - runs parallel with security

  style:
    type: ai
    group: code-review
    schema: code-review
    prompt: "Style analysis based on security findings..."
    tags:
      - style
      - fast
      - local
    on:
      - pr_opened
    depends_on:
      - security  # Waits for security to complete

  architecture:
    type: ai
    group: code-review
    schema: code-review
    prompt: "Architecture analysis building on previous checks..."
    on:
      - pr_opened
      - pr_updated
    depends_on:
      - security
      - performance
```

### Execution Flow

1. Level 0: `security` and `performance` run in parallel
2. Level 1: `style` runs after `security`
3. Level 2: `architecture` runs after both

### Advanced Patterns

#### Diamond Dependency
```yaml
steps:
  foundation: { type: ai, group: base, schema: code-review, prompt: "Base analysis" }
  branch_a:   { type: ai, group: code-review, schema: code-review, depends_on: [foundation] }
  branch_b:   { type: ai, group: code-review, schema: code-review, depends_on: [foundation] }
  final:      { type: ai, group: summary, schema: markdown, depends_on: [branch_a, branch_b] }
```

#### Multiple Independent Chains
```yaml
steps:
  security_basic:     { type: ai, group: security,    schema: code-review }
  security_advanced:  { type: ai, group: security,    schema: code-review, depends_on: [security_basic] }
  performance_basic:  { type: ai, group: performance, schema: code-review }
  performance_advanced:{ type: ai, group: performance, schema: code-review, depends_on: [performance_basic] }
  integration:        { type: ai, group: summary,     schema: markdown, depends_on: [security_advanced, performance_advanced] }
```

#### Any‑of (OR) Dependency Groups

Sometimes a check can proceed when any one of several upstream steps has completed successfully. Visor supports this with pipe‑separated tokens inside `depends_on`.

## Criticality and Gating

`continue_on_failure` controls whether dependents may run after a failure — it is a gating knob, not the definition of criticality. Classify steps by criticality (external | control-plane | policy | non-critical) and derive defaults:

- Critical: `continue_on_failure: false`, require `assume`/`guarantee`, tighter loop budgets, retries only for transient faults.
- Non‑critical: may allow `continue_on_failure: true` to keep non‑critical branches moving.

Example — non‑critical branch that can proceed after a soft failure:
```yaml
steps:
  summarize:
    type: ai
    tags:
      - non-critical
    continue_on_failure: true
    fail_if: "(output.errors || []).length > 0"
```

```yaml
checks:
  parse-issue:   { type: noop }
  parse-comment: { type: noop }
  triage:        { type: noop, depends_on: ["parse-issue|parse-comment"] }
```

Rules:
- Each string containing `|` denotes an ANY‑OF group. In the example above, either `parse-issue` or `parse-comment` satisfies the dependency for `triage`.
- You may combine ALL‑OF and ANY‑OF: `depends_on: ["a|b", "c"]` means “(a or b) and c”.
- Event gating still applies: a dependency only counts if it is applicable to the current event (has compatible `on` or no `on`).
- Failure/skip semantics: a member that is skipped or fails fatally does not satisfy the group; at least one member must complete without a fatal error for the group to be satisfied.
- Session reuse: if `reuse_ai_session: true` and `depends_on` contains a pipe group, the session parent is selected from the first satisfied member at runtime.

Tip: When targeting a leaf in ad‑hoc runs (e.g., `visor --check final`), include one member of each pipe group explicitly (e.g., `--check a --check final`) to make intent unambiguous. In normal runs Visor computes the plan automatically from your config.

### Error Handling

- Cycle detection and missing dependency validation
- Failed checks don't block independent branches
- Dependency results are available to dependents via `outputs`

## forEach Dependency Propagation with on_finish

When a check has `forEach: true`, it outputs an array and all its dependent checks run once per array item. After **all** dependents complete **all** iterations, the `on_finish` hook on the forEach check triggers to aggregate results and optionally route to a different check.

### Basic Flow

```yaml
checks:
  extract-items:
    type: ai
    forEach: true
    # Outputs: [item1, item2, item3]

  process-item:
    depends_on: [extract-items]
    # Runs 3 times (once per item)
```

**Execution order:**
1. `extract-items` runs once → outputs `[item1, item2, item3]`
2. `process-item` runs 3 times (once for each item)
3. All 3 iterations complete
4. Downstream checks that depend on `process-item` can now run

### on_finish Hook for Aggregation

The `on_finish` hook runs **once** after all dependent checks complete all their iterations, making it perfect for aggregating results and making routing decisions:

```yaml
checks:
  extract-facts:
    type: ai
    forEach: true
    # Outputs: [fact1, fact2, fact3]

    on_finish:
      # Run aggregation check
      run: [aggregate-validations]

      # Then decide whether to retry
      goto_js: |
        const allValid = memory.get('all_valid', 'validation');
        return allValid ? null : 'retry-assistant';

  validate-fact:
    depends_on: [extract-facts]
    # Runs 3 times (once per fact)

  aggregate-validations:
    type: script
    content: |
      // Access ALL validation results
      const results = outputs.history['validate-fact'];
      const allValid = results.every(r => r.is_valid);
      memory.set('all_valid', allValid, 'validation');
      return { total: results.length, valid: allValid };
```

**Execution order:**
1. `extract-facts` runs once → outputs array of facts
2. `validate-fact` runs N times (once per fact)
3. **on_finish triggers:**
   - First: `aggregate-validations` runs
   - Then: `goto_js` evaluates
   - If goto returns a check name, jump to that ancestor
4. Downstream checks continue

### When on_finish Triggers

- **Only** on checks with `forEach: true`
- **After** ALL dependent checks complete ALL iterations
- **Does not** trigger if forEach array is empty
- **Before** any downstream checks that don't depend on the forEach check

### Accessing forEach Results

Inside `on_finish` hooks, you have access to all iteration results via `outputs.history`:

```javascript
// In on_finish.goto_js or on_finish.run_js
{
  outputs: {
    'extract-facts': [...],  // The forEach array
    'validate-fact': [...],  // Latest results (for compatibility)
  },
  outputs.history: {
    'validate-fact': [[...], ...], // ALL results from ALL iterations
  },
  forEach: {
    total: 3,       // Total forEach items
    successful: 3,  // Number of successful iterations
    failed: 0,      // Number of failed iterations
    items: [...]    // The forEach items array
  }
}
```

### Complete Example: Multi-Dependent Aggregation

The real power of `on_finish` is aggregating results from **multiple** dependent checks:

```yaml
checks:
  # Step 1: Extract claims from AI response
  extract-claims:
    type: ai
    forEach: true
    prompt: "Extract all factual claims from: {{ outputs.ai-response }}"
    transform_js: JSON.parse(output).claims
    depends_on: [ai-response]

    # Step 4: After ALL validations complete
    on_finish:
      run: [aggregate-all-validations]
      goto_js: |
        const securityOk = memory.get('security_valid', 'validation');
        const technicalOk = memory.get('technical_valid', 'validation');
        const attempt = memory.get('attempt', 'validation') || 0;

        if (securityOk && technicalOk) {
          return null;  // All good, proceed
        }

        if (attempt >= 2) {
          return null;  // Max attempts, give up
        }

        memory.increment('attempt', 1, 'validation');
        return 'ai-response';  // Retry with validation context

  # Step 2: Validate security aspects (runs N times)
  validate-security:
    type: ai
    depends_on: [extract-claims]
    prompt: |
      Validate security implications of: {{ outputs['extract-claims'].claim }}

  # Step 3: Validate technical accuracy (runs N times)
  validate-technical:
    type: ai
    depends_on: [extract-claims]
    prompt: |
      Validate technical accuracy of: {{ outputs['extract-claims'].claim }}

  # Step 4a: Aggregate ALL results
  aggregate-all-validations:
    type: script
    content: |
      // Get results from BOTH dependent checks
      const securityResults = outputs.history['validate-security'];
      const technicalResults = outputs.history['validate-technical'];

      const securityValid = securityResults.every(r => r.is_valid);
      const technicalValid = technicalResults.every(r => r.is_valid);

      memory.set('security_valid', securityValid, 'validation');
      memory.set('technical_valid', technicalValid, 'validation');

      // Store issues for retry context
      if (!securityValid || !technicalValid) {
        const issues = [
          ...securityResults.filter(r => !r.is_valid),
          ...technicalResults.filter(r => !r.is_valid)
        ];
        memory.set('validation_issues', issues, 'validation');
      }

      return {
        security: { total: securityResults.length, valid: securityValid },
        technical: { total: technicalResults.length, valid: technicalValid }
      };

  # Step 5: Post if validation passed
  post-response:
    type: github
    depends_on: [extract-claims]
    if: "memory.get('security_valid', 'validation') && memory.get('technical_valid', 'validation')"
    op: comment.create
    value: "{{ outputs['ai-response'] }}"
```

This is the **only way** to aggregate across multiple dependent checks in a forEach scenario. Without `on_finish`, there would be no single point where all results are available together.

### Best Practices

1. **Use outputs.history**: Access all forEach iteration results with `outputs.history['check-name']`
2. **Store in Memory**: Use memory to pass aggregated state to `goto_js` and downstream checks
3. **Handle Empty Arrays**: Check `forEach.total` or array length before processing
4. **Limit Loops**: Use attempt counters in memory to prevent infinite retry loops
5. **Multiple Dependents**: `on_finish` is perfect when you have multiple checks depending on the same forEach check
6. **Event Preservation**: Use `goto_event` when jumping back to maintain correct event context

### Comparison: on_finish vs Regular Dependent

| Approach | When It Runs | Access to Results | Use Case |
|----------|-------------|-------------------|----------|
| Regular dependent check | After forEach parent completes | Only parent's array items | Process individual items |
| `on_finish` hook | After **all** dependents complete **all** iterations | All iteration results via `outputs.history` | Aggregate, validate, route |

**Example showing the difference:**

```yaml
checks:
  extract-items:
    type: command
    forEach: true
    exec: echo '[1, 2, 3]'
    on_finish:
      run: [summarize-all]

  process-item:
    depends_on: [extract-items]
    # Runs 3 times, once per item
    # Has access to: outputs['extract-items'] (current item)

  summarize-all:
    type: script
    # Runs ONCE after all 3 process-item iterations
    # Has access to: outputs.history['process-item'] (all 3 results)
    content: |
      const allResults = outputs.history['process-item'];
      return { processed: allResults.length };
```

### See Also

- [Failure Routing](./failure-routing.md) - Complete `on_finish` reference
- [forEach Dependency Propagation](./foreach-dependency-propagation.md) - Detailed forEach mechanics
- [Output History](./output-history.md) - Accessing historical outputs
