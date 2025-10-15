# Failure Routing (Auto-fix Loops)

This guide explains how to configure Visor to automatically remediate failures and re-run steps until convergence, using safe, deterministic routing.

## What You Can Do

- Retry failed steps with backoff (fixed or exponential)
- Run remediation steps on failure (e.g., `lint-fix`, `npm ci`)
- Jump back to an ancestor step on failure or success (`goto`)
- Compute remediation and targets dynamically with safe JS (`run_js`, `goto_js`)
- Protect against infinite loops with per-scope loop caps and per-step attempt counters
- Use the same semantics inside forEach branches (each item is isolated)

## Quick Examples

Retry + goto on failure:
```yaml
version: "2.0"
routing: { max_loops: 5 }
checks:
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
checks:
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

**Note:** When using goto loops, `outputs.history` tracks all previous check outputs, while `outputs` always contains the current/latest value. See [Output History](./output-history.md) for accessing historical data in loops and retries.

forEach remediation with retry:
```yaml
checks:
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
checks:
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
checks:
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

## Full Examples

See the repository examples:
- `examples/routing-basic.yaml`
- `examples/routing-on-success.yaml`
- `examples/routing-foreach.yaml`
- `examples/routing-dynamic-js.yaml`
