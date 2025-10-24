# Failure Routing (Auto-fix Loops)

This guide explains how to configure Visor to automatically remediate failures and re-run steps until convergence, using safe, deterministic routing.

## What You Can Do

- Retry failed steps with backoff (fixed or exponential)
- Run remediation steps on failure (e.g., `lint-fix`, `npm ci`)
- Jump back to an ancestor step on failure or success (`goto`)
- Compute remediation and targets dynamically with safe JS (`run_js`, `goto_js`)
- Protect against infinite loops with per-scope loop caps and per-step attempt counters
- Use the same semantics inside forEach branches (each item is isolated)

## Outputs Surface (Routing JS)

When writing `run_js`/`goto_js`, you have three accessors:

- `outputs['x']` — nearest value for check `x` in the current snapshot and scope.
- `outputs_raw['x']` — aggregate value for `x` (e.g., the full array from a forEach parent).
- `outputs.history['x']` (alias: `outputs_history['x']`) — all historical values for `x` up to this snapshot.

Precedence for `outputs['x']` in routing sandboxes:
- If running inside a forEach item of `x`, resolves to that item’s value.
- Else prefer an ancestor scope value of `x`.
- Else the latest committed value of `x` in the snapshot.

Quick example using `outputs_raw` in `goto_js`:

```yaml
checks:
  list:
    type: command
    exec: echo '["a","b","c"]'
    forEach: true

  decide:
    type: memory
    depends_on: [list]
    operation: exec_js
    memory_js: 'return { n: (outputs_raw["list"] || []).length }'
    on_success:
      goto_js: |
        // Branch by aggregate size, not per-item value
        return (outputs_raw['list'] || []).length >= 3 ? 'bulk-process' : null;

  bulk-process: { type: log, message: 'bulk mode' }
```

Tip: `outputs_raw` is also available in provider templates (AI/command/log/memory), mirroring routing JS.

## Quick Examples

Retry + goto on failure:
```yaml
version: "2.0"
routing: { max_loops: 5 }
steps:
  setup: { type: command, exec: "echo setup" }
  build:
    type: command
    depends_on: [setup]
    exec: |
      test -f .ok || (echo first try fails >&2; touch .ok; exit 1)
      echo ok
    on_fail:
      goto: setup
      retry: { max: 1, backoff: { mode: exponential, delay_ms: 400 } }
```

on_success jump-back once + post-steps:
```yaml
steps:
  unit: { type: command, exec: "echo unit" }
  build:
    type: command
    depends_on: [unit]
    exec: "echo build"
    on_success:
      run: [notify]
      goto_js: |
        return attempt === 1 ? 'unit' : null;  # only once
  notify: { type: command, exec: "echo notify" }
```

Note on outputs access:
- `outputs['step-id']` returns the latest value for that step in the current snapshot.
- `outputs.history['step-id']` returns the cross-loop history array.
- `outputs_history['step-id']` is an alias for `outputs.history['step-id']` and is available in routing JS and provider templates.
See [Output History](./output-history.md) for more details.

forEach remediation with retry:
```yaml
steps:
  list: { type: command, exec: "echo '[\\"a\\",\\"b\\"]'", forEach: true }
  mark: { type: command, depends_on: [list], exec: "touch .m_{{ outputs.list }}" }
  process:
    type: command
    depends_on: [list]
    exec: "test -f .m_{{ outputs.list }} || exit 1"
    on_fail:
      run: [mark]
      retry: { max: 1 }
```

## Configuration Keys

Top-level defaults (optional):
```yaml
routing:
  max_loops: 10         # per-scope cap on routing transitions
  defaults:
    on_fail:
      retry: { max: 1, backoff: { mode: fixed, delay_ms: 300 } }
```

Per-step actions:
- `on_fail`:
  - `retry`: `{ max, backoff: { mode: fixed|exponential, delay_ms } }`
  - `run`: `[step-id, …]`
  - `goto`: `step-id` (ancestor-only)
  - `run_js`: JS returning `string[]`
  - `goto_js`: JS returning `string | null`
- `on_success`:
  - `run`, `goto`, `run_js`, `goto_js` (same types and constraints as above)

## Semantics

- Retry: re-run the same step up to `retry.max`; backoff adds fixed or exponential delay with deterministic jitter.
- Run: on failure (or success), run listed steps first; if successful, the failed step is re-attempted once (failure path).
- Goto (ancestor-only): jump back to a previously executed dependency, then continue forward. On success, Visor re-runs the current step once after the jump.
- Loop safety: `routing.max_loops` counts all routing transitions (runs, gotos, retries). Exceeding it aborts the current scope with a clear error.
- forEach: each item is isolated with its own loop/attempt counters; `*_js` receives `{ foreach: { index, total, parent } }`.

### Fan‑out vs. Reduce (Phase 5)

You can control how routing targets behave when invoked from a forEach context:

- `fanout: map` — schedule the target once per item (runs under each item scope).
- `fanout: reduce` (or `reduce: true`) — schedule a single aggregation run (default/back‑compat).

Where it applies:
- on_success.run / on_success.goto
- on_fail.run / on_fail.goto
- on_finish.run / on_finish.goto (when defined on the forEach producer)

Example — per‑item side‑effects via routing:
```yaml
checks:
  list:
    type: command
    exec: echo '["a","b","c"]'
    forEach: true
    on_success:
      run: [notify-item]

  notify-item:
    type: log
    fanout: map  # ← run once for each item from 'list'
    message: "Item: {{ outputs['list'] }}"
```

Example — single aggregation after forEach:
```yaml
checks:
  extract:
    forEach: true
    on_success:
      run: [summarize]

  summarize:
    type: memory
    fanout: reduce  # ← single run
    operation: exec_js
    memory_js: |
      const arr = outputs_raw['extract'] || [];
      return { total: arr.length };
```

## Goto Event Override (goto_event)

You can instruct a `goto` jump to simulate a different event so that the target step is filtered as if that event occurred. This is useful when you need to re-run an ancestor step under PR semantics from a different context (e.g., from an issue comment or internal assistant flow).

Key points:
- Add `goto_event: <event>` alongside `goto` or use it with `goto_js`.
- Valid values are the same as `on:` triggers (e.g., `pr_updated`, `pr_opened`, `issue_comment`, `issue_opened`).
- During the inline `goto` execution, Visor sets an internal event override:
  - Event filtering uses the overridden event for the target step.
  - `if:` expressions see `event.event_name` derived from the override (e.g., `pr_*` → `pull_request`, `issue_comment` → `issue_comment`, `issue_*` → `issues`).
- After the jump, the current step is re-run once; the override applies only to the inline target and that immediate re-run.
- `goto` remains ancestor-only.

Example: After `security` succeeds, jump back to `overview` and re-run `security`, evaluating both as if a PR update happened:

```yaml
steps:
  overview:
    type: ai
    on: [pr_opened, pr_updated]

  security:
    type: ai
    depends_on: [overview]
    on: [pr_opened, pr_updated]
    on_success:
      goto: overview           # ancestor-only
      goto_event: pr_updated   # simulate PR updated during the jump
```

Dynamic variant (only jump on first success):

```yaml
steps:
  quality:
    type: ai
    depends_on: [overview]
    on: [pr_opened, pr_updated]
    on_success:
      goto_js: |
        return attempt === 1 ? 'overview' : null
      goto_event: pr_updated
```

When to use goto_event vs. full re-run:
- Use `goto_event` for a targeted, in-process jump to a specific ancestor step with PR semantics.
- Use a higher-level “internal re-invoke” (e.g., synthesize a `pull_request` `synchronize` event and call the action entrypoint) when you need to re-run the entire PR workflow chain from an issue comment trigger.

## Dynamic JS (safe, sync only)

- `goto_js` / `run_js` are evaluated in a sandbox with:
  - Read-only context: `{ step, attempt, loop, error, foreach, outputs, pr, files, env }`
  - `outputs` contains current values, `outputs.history` contains arrays of all previous values (see [Output History](./output-history.md))
  - Pure sync execution; no IO, no async, no timers, no require/process.
  - Time and size limits (short wall time; small code/output caps) — evaluation failures fall back to static routing.

Return types:
- `goto_js`: a `string` (step id) or `null`/`undefined` to skip.
- `run_js`: a `string[]` (may be empty). Duplicates are removed preserving order.

## Guardrails & Tips

- Keep `max_loops` small (5–10). Add retries sparingly and prefer remediation over blind loops.
- Restrict `goto` to ancestors to preserve dependency semantics and avoid hard-to-reason paths.
- For expensive remediations, put them behind `run_js` conditions keyed to `error.message`/`stderr`.
- In CI, you can override defaults with CLI flags (future): `--on-fail-max-loops`, `--retry-max`.

## on_finish Hook (forEach Aggregation & Routing)

The `on_finish` hook is a special routing action that triggers **once** after a `forEach` check completes **all** of its dependent checks across **all** iterations. This is the ideal place to aggregate results from forEach iterations and make routing decisions based on the collective outcome.

### When on_finish Triggers

- Only on checks with `forEach: true`
- Triggers **after** all dependent checks complete all their iterations
- Does **not** trigger if the forEach array is empty
- Executes even if some iterations failed (you decide how to handle failures)

### Execution Order

```
forEach check executes once → outputs array [item1, item2, ...]
↓
All dependent checks execute N times (forEach propagation)
  - dependent-check runs for item1
  - dependent-check runs for item2
  - ...
↓
on_finish.run executes (checks run sequentially in order)
↓
on_finish.run_js evaluates (dynamic check selection)
↓
on_finish.goto_js evaluates (routing decision)
↓
If goto returned, jump to ancestor check and re-run current check
```

### How It Differs from on_success and on_fail

| Hook | Triggers When | Use Case |
|------|--------------|----------|
| `on_fail` | Check fails | Handle single check failure, retry, remediate |
| `on_success` | Check succeeds | Post-process single check success |
| `on_finish` | **All** forEach dependents complete | Aggregate **all** forEach iteration results, decide next step |

Key difference: `on_finish` sees the **complete picture** of all forEach iterations and all dependent check results, making it perfect for validation and aggregation scenarios.

### Available Context in on_finish

The `on_finish` hooks have access to the complete execution context:

```javascript
{
  step: { id: 'extract-facts', tags: [...], group: '...' },
  attempt: 1,              // Current attempt number for this check
  loop: 2,                 // Current loop number in routing
  outputs: {
    'extract-facts': [...], // Array of forEach items
    'validate-fact': [...], // Array of ALL dependent results
  },
  outputs.history: {
    'extract-facts': [[...], ...], // Cross-loop history
    'validate-fact': [[...], ...], // All results from all iterations
  },
  // Alias (also available):
  outputs_history: {
    'extract-facts': [[...], ...],
    'validate-fact': [[...], ...],
  },
  forEach: {
    total: 3,              // Total number of items
    successful: 3,         // Number of successful iterations
    failed: 0,             // Number of failed iterations
    items: [...]           // The forEach items array
  },
  memory,                  // Memory access functions
  pr,                      // PR metadata
  files,                   // Changed files
  env                      // Environment variables
}
```

### Configuration

```yaml
checks:
  extract-facts:
    type: ai
    forEach: true
    # ... regular check configuration ...

    on_finish:
      # Optional: Run additional checks to aggregate results
      run: [aggregate-validations]

      # Optional: Dynamically compute additional checks to run
      run_js: |
        return error ? ['log-error'] : [];

      # Optional: Static routing decision
      goto: previous-check

      # Optional: Dynamic routing decision
      goto_js: |
        const allValid = memory.get('all_facts_valid', 'fact-validation');
        const attempt = memory.get('fact_validation_attempt', 'fact-validation') || 0;

        if (allValid) {
          return null;  // Continue normal flow
        }

        if (attempt >= 1) {
          return null;  // Max attempts reached, give up
        }

        // Retry with correction context
        memory.increment('fact_validation_attempt', 1, 'fact-validation');
        return 'issue-assistant';  // Jump back to ancestor

      # Optional: Override event for goto target
      goto_event: pr_updated
```

### Common Patterns

#### Pattern 1: Validation with Retry

Aggregate validation results and retry if any fail:

```yaml
checks:
  extract-claims:
    type: ai
    forEach: true
    transform_js: JSON.parse(output).claims
    on_finish:
      run: [aggregate-results]
      goto_js: |
        const allValid = memory.get('all_valid', 'validation');
        const attempt = memory.get('attempt', 'validation') || 0;

        if (allValid || attempt >= 2) {
          return null;  // Success or max attempts
        }

        memory.increment('attempt', 1, 'validation');
        return 'generate-response';  // Retry

  validate-claim:
    type: ai
    depends_on: [extract-claims]
    # Validates each claim individually

  aggregate-results:
    type: memory
    operation: exec_js
    memory_js: |
      const results = outputs.history['validate-claim'];
      const allValid = results.every(r => r.is_valid);
      memory.set('all_valid', allValid, 'validation');
      return { total: results.length, valid: results.filter(r => r.is_valid).length };
```

#### Pattern 2: Conditional Post-Processing

Run different post-processing based on forEach results:

```yaml
checks:
  scan-files:
    type: command
    forEach: true
    exec: "find . -name '*.ts'"
    on_finish:
      run_js: |
        const hasErrors = outputs.history['analyze-file'].some(r => r.errors > 0);
        return hasErrors ? ['generate-fix-pr'] : ['post-success-comment'];

  analyze-file:
    type: command
    depends_on: [scan-files]
    exec: "eslint {{ outputs['scan-files'] }}"
```

#### Pattern 3: Multi-Dependent Aggregation

Aggregate results from **multiple** dependent checks:

```yaml
checks:
  extract-facts:
    type: ai
    forEach: true
    on_finish:
      run: [aggregate-all-validations]
      goto_js: |
        const securityValid = memory.get('security_valid', 'validation');
        const technicalValid = memory.get('technical_valid', 'validation');
        const formatValid = memory.get('format_valid', 'validation');

        if (!securityValid || !technicalValid || !formatValid) {
          return 'retry-with-context';
        }
        return null;

  validate-security:
    type: ai
    depends_on: [extract-facts]
    # Runs N times, validates security aspects

  validate-technical:
    type: ai
    depends_on: [extract-facts]
    # Runs N times, validates technical aspects

  validate-format:
    type: ai
    depends_on: [extract-facts]
    # Runs N times, validates format/style

  aggregate-all-validations:
    type: memory
    operation: exec_js
    memory_js: |
      // Access ALL results from ALL dependent checks
      const securityResults = outputs.history['validate-security'];
      const technicalResults = outputs.history['validate-technical'];
      const formatResults = outputs.history['validate-format'];

      memory.set('security_valid', securityResults.every(r => r.is_valid), 'validation');
      memory.set('technical_valid', technicalResults.every(r => r.is_valid), 'validation');
      memory.set('format_valid', formatResults.every(r => r.is_valid), 'validation');

      return { aggregated: true };
```

### Error Handling

- If `on_finish.run` checks fail, the forEach check is marked as failed
- If `goto_js` throws an error, the engine falls back to static `goto` (if present)
- Clear error messages are logged for debugging
- Loop safety: `on_finish.goto` counts toward `max_loops`

### Best Practices

1. **Use for Aggregation**: Perfect for collecting and analyzing results from all forEach iterations
2. **Memory for State**: Store aggregated results in memory for use in routing decisions and downstream checks
3. **Fail Gracefully**: Handle both success and failure scenarios in `goto_js`
4. **Limit Retries**: Use attempt counters to prevent infinite loops
5. **Log Decisions**: Use `log()` in JS to debug routing decisions
6. **Validate First**: Run aggregation checks before routing to ensure data is ready

### Debugging

```javascript
// In on_finish.goto_js
log('forEach stats:', forEach);
log('All results:', outputs.history['dependent-check']);
log('Current attempt:', attempt, 'loop:', loop);

const results = outputs.history['validate-fact'];
log('Valid:', results.filter(r => r.is_valid).length);
log('Invalid:', results.filter(r => !r.is_valid).length);
```

## Full Examples

See the repository examples:
- `examples/routing-basic.yaml`
- `examples/routing-on-success.yaml`
- `examples/routing-foreach.yaml`
- `examples/routing-dynamic-js.yaml`
- `examples/fact-validator.yaml` - Complete `on_finish` example with validation and retry
