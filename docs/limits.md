## 🚦 Execution Limits (Run Caps)

This feature protects workflows from accidental infinite loops by capping how many times a step may execute in a single engine run. It complements (but is different from) routing loop budgets.

### Why this exists

- Complex `on_fail`/`on_success` routing can create feedback loops when a remediation step immediately routes back to its source.
- The cap provides a hard stop with a clear error if a step keeps re-running without converging.

### Configuration

Global limits (defaults shown):

```yaml
version: "1.0"

limits:
  max_runs_per_check: 50   # Applies to every step unless overridden
  max_workflow_depth: 3    # Maximum nesting depth for nested workflows
```

Per-step override:

```yaml
steps:
  refine:
    type: ai
    max_runs: 10  # Hard cap for this step within one engine run
```

Disable cap for a specific step (not recommended unless you know it converges quickly):

```yaml
steps:
  extract:
    type: command
    max_runs: 0   # or any negative value
```

### Behavior

- The engine counts executions per step. For `forEach` children, the counter is tracked per item scope (each item has its own budget).
- When the cap is exceeded, the step fails immediately with a single error issue:
  - `ruleId`: `<step-id>/limits/max_runs_exceeded`
  - `severity`: `error`
  - `message` includes the scope and attempt number
- Dependents are gated as with any error unless the dependency declares `continue_on_failure: true`.

### How this differs from `routing.max_loops`

- `routing.max_loops` caps routing transitions (e.g., goto/retry waves) per scope. Default: 10.
- `limits.max_runs_per_check` caps actual step executions per step (also per scope for `forEach`). Default: 50.
- `limits.max_workflow_depth` caps nested workflow invocations. Default: 3.
- Both execution and routing guard rails can be used together: set a modest routing budget (e.g., 5-10) and leave the execution cap at the default (50) or tailor per step.

### Workflow Depth Limit

The `max_workflow_depth` setting prevents infinite recursion when workflows call other workflows:

```yaml
limits:
  max_workflow_depth: 3  # Maximum nesting depth (default: 3)
```

When the depth limit is exceeded, the workflow provider throws an error. This protects against:
- Accidentally creating recursive workflow chains
- Runaway nested workflow invocations

### Recommendations

- Keep `routing.max_loops` small for fast feedback (5–10).
- Use per-step `max_runs` on chat-like loops or known retryers if you need tighter control.
- Prefer fixing the loop logic (conditions/routing) over raising the caps.

### Troubleshooting

- If you hit `.../limits/max_runs_exceeded` immediately, check if a step is routed back without changing state.
- For `forEach` flows, confirm whether the error is tied to a specific item scope; fix that item’s remediation path.

