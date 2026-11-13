# Failure Routing (Retry/Goto/Remediate) — RFC

Status: **Implemented** (fully landed in engine, Phase 5 fanout/reduce included)

Last updated: 2026-01-28

Owner: Visor team

> **Note**: This RFC has been fully implemented. For user documentation, see
> [failure-routing.md](./failure-routing.md). The implementation includes all
> core features: `on_fail`, `on_success`, `on_finish`, retry with backoff,
> `goto`/`goto_js`, `run`/`run_js`, `goto_event`, fanout/reduce semantics, loop
> budgets, and forEach scope isolation.

## Objectives

- Enable a workflow step to handle failure by retrying, jumping back to a prior step, or running a remediation step, then continuing.
- Keep runs deterministic and safe: no infinite loops, clear audit trail, reproducible results.
- Make it ergonomic in YAML and backward-compatible with existing Visor configs.

## Approach

- Add “failure routes” to the execution graph: normal success edges remain; failure edges are now explicit.
- Introduce lightweight “checkpoints” via step IDs (no heavy snapshots). Re-execution rebuilds state deterministically.
- Provide per-step retry policies with backoff and a global loop budget to avoid livelock.

## Config Sketch (MVP)

Proposed additions use Visor's existing 2.0 style (type/exec/depends_on). New keys are `on_fail`, `on_success`, `on_finish`, and optional top‑level `routing` for defaults.

> **Implementation note**: The implementation also added `transitions` (declarative rule-based routing) and `goto_event` (event override for goto targets). See [failure-routing.md](./failure-routing.md) for full documentation.

```yaml
version: "2.0"

# Optional global defaults for routing (new)
routing:
  max_loops: 10              # per-scope cap on routing transitions
  defaults:
    on_fail:
      retry:
        max: 0               # attempts per step on failure (0 = disabled)
        backoff:
          mode: fixed        # fixed|exponential
          delay_ms: 2000     # initial delay in milliseconds

steps:
  setup-env:
    type: command
    exec: "npm ci"

  unit-tests:
    type: command
    exec: "npm test"
    on_fail:
      retry: { max: 1, backoff: { mode: fixed, delay_ms: 3000 } }
      goto: setup-env        # jump back, then continue forward
      # Dynamic routing alternatives (evaluated on failure):
      # - goto_js returns a step-id or null
      # - run_js returns an array of step-ids or []
      goto_js: |
        // Provided variables: step, attempt, loop, error, foreach, outputs, pr, files
        if (error.message?.includes('module not found')) return 'setup-env';
        return null;

      run_js: |
        // Optionally compute remediation steps dynamically.
        const fixes = [];
        if (error.stderr?.includes('lint')) fixes.push('lint-fix');
        return fixes;

  lint-fix:
    type: command
    exec: "npm run lint:fix"

  build:
    type: command
    exec: "npm run build"
    on_fail:
      run: [lint-fix]        # remediation steps
      retry: { max: 1 }

  summary:
    type: command
    exec: "node scripts/summarize.js"
    on_success:
      run: [notify]
      # Allow goto on success (ancestor-only) with optional dynamic variant
      goto: unit-tests
      goto_js: |
        // Jump back to re-validate if summary indicates retest
        if (/retest/i.test(outputs?.overview ?? '')) return 'unit-tests';
        return null;

  notify:
    type: command
    exec: "echo notify"
```

## Execution Semantics

- Retry: Re-run the same step up to `retry.max` with backoff; counts toward `max_loops`.
- Goto (failure): After retries are exhausted, jump to `goto` step (ancestor-only), then proceed forward to eventually re-run the failed step.
- Run (failure remediation): On failure, run listed steps in order; if all succeed, re-attempt the failed step once (counted).
- on_success actions: After a step succeeds, run `on_success.run` plus `run_js` (if any), then optionally `goto`/`goto_js` (ancestor-only). After the jump, proceed forward along the normal path.
- Loop safety: Maintain per-check attempt counters (for retries) and a per-scope `max_loops` routing counter covering ALL routing transitions (failure and success). Abort with a clear error if exceeded.
- State: Carry forward run context; recompute outputs of any steps that are re-executed (no stale artifact reuse by default).
- Telemetry: Log structured events for failure, retry, goto, remediation, and loop-abort to aid debugging.

### Dynamic Routing (goto_js, run_js)

- When present, `goto_js` and `run_js` are evaluated inside a safe JS sandbox on routing events:
  - on_fail: evaluate both after a failure.
  - on_success: evaluate `run_js` after success; evaluate `goto_js` after run/run_js.
- Provided variables (read‑only):
  - `step` – current step metadata: `{ id, tags, group }`.
  - `attempt` – attempt count for this step (1 on first try).
  - `loop` – number of routing transitions taken so far in this scope.
  - `error` – for failures: `{ message, code, stdout, stderr, exitCode }` (truncated strings).
  - `foreach` – if inside forEach: `{ key, index, total, path }`, else `null`.
  - `outputs` – dependency outputs (same as in templates/transform_js).
  - `pr`, `files`, `env` – standard Visor template context.
- Results:
  - `goto_js`: must return a step-id string or `null`/`undefined`.
  - `run_js`: must return an array of step-id strings (may be empty).
- Precedence and merge:
  - If `goto_js` returns a valid id, it overrides static `goto`.
  - `run_js` result is concatenated after static `run` (duplicates removed, original order preserved).
  - on_success ordering: execute run/run_js first; then evaluate and apply goto/goto_js.
- Determinism: No IO, no randomness unless seeded; evaluation is pure and time-limited.

### Safe Evaluation

- Engine executes JS via a restricted VM with:
  - Whitelisted globals only: `Math`, `JSON`, limited `Date.now()`; no `require`, no `process`, no timers, no async.
  - CPU time limit (e.g., 25 ms) and memory cap; code size limit (e.g., 8 KB) per evaluation.
  - Inputs are immutable; outputs validated (types, size) before use.
  - Any sandbox violation or timeout is treated as evaluation failure; static `on_fail` keys still apply.

### Loop Counters and Routing Behavior

- Per-check counters: Each step maintains its own `attempt` counter; increments on each retry of that step.
- Per-scope loop budget: `max_loops` is tracked per execution scope and counts ALL routing transitions (failure gotos, success gotos, and remediation-triggered reattempts):
  - Root scope: applies across the top-level graph.
  - `forEach` scope: each item has its own independent loop counter (a separate “parallel universe”).
- On exceeding `max_loops`, the engine fails the current scope immediately with a clear error (no silent recovery), regardless of whether routing was triggered by failure or success.
- Counters are keyed by `(scopeId, stepId)`; `scopeId` changes for each `forEach` item.

### forEach Semantics

- Each `forEach` item creates an isolated subgraph with:
  - Independent step attempt counters and loop budget.
  - Local name resolution for `goto`/`run`/`*_js` targets (must reference steps within the same scope).
- Cross-scope jumps are disallowed by default to prevent non-local effects and loops.
- The `foreach` context exposes `{ key, index, total, path }` to drive dynamic decisions in `*_js` code.

## Engine Work

- Represent failure edges in the internal DAG and scheduler.
- Implement retry/backoff, goto transitions, and remediation chains.
- Add loop detection with `max_loops` and per-step retry budgets.
- Validate `goto` targets, detect cycles, and provide actionable errors.
- Add a JS evaluator module with sandboxing, type guards, and timeouts.
- Integrate dynamic routing evaluation and precedence rules.

## CLI and UX

- **Future Flags** (not yet implemented): `--on-fail-max-loops`, `--retry-max`, `--no-failure-routing` (to disable feature globally).
- Run summary shows failure routes taken with timestamps and attempt counts.
- Debug: when `--debug` is set, include evaluated `*_js` results (with sensitive data redacted), sandbox timing, retry/backoff decisions, goto/run transitions, and per-scope loop counters.
- Telemetry: routing decisions are traced via OTel events (`visor.routing`) with attributes like `trigger`, `action`, `target`, `source`, `scope`, and `goto_event`.

## Tests and Demo

- Unit tests: each policy in isolation (retry, goto, remediation, loop-abort, `goto_js`, `run_js`, timeouts, type errors).
- Integration: top-level and `forEach` flows, ensuring per-item loop isolation and correct scoping.

## Acceptance Criteria

All original acceptance criteria have been met:

- [x] **Goto**: Given a failing step with `goto: setup-env`, engine jumps to `setup-env`, proceeds, and re-runs the failed step.
- [x] **Remediation**: Given `run: [lint-fix]`, if remediation succeeds, the failed step re-runs once; if remediation fails, the run stops with a clear message.
- [x] **Retry**: Per-step retries respect backoff and caps; global `max_loops` prevents infinite ping-pong.
- [x] **Compatibility**: Configs without `on_fail` behave exactly as today.
- [x] **Observability**: Logs show ordered trace of retries and jumps; exit codes reflect final outcome.
- [x] **Dynamic routing**: `goto_js` and `run_js` work with pure, time-limited evaluation; precedence and merging behave as specified.
- [x] **forEach**: Each item runs with isolated counters; `*_js` receives `foreach` context and cannot jump across scopes.
- [x] **on_success goto**: After a step succeeds, `goto` (ancestor-only) can jump back to a prior step; with `max_loops` enforcement the run either converges or fails with a clear trace.

Additional features implemented beyond the original RFC:

- [x] **on_finish hook**: Runs after all forEach iterations and dependent checks complete — ideal for aggregation.
- [x] **goto_event**: Override the event trigger when performing a goto (e.g., simulate `pr_updated`).
- [x] **Declarative transitions**: Rule-based routing via `transitions: [{ when, to, goto_event }]` in on_fail/on_success/on_finish.
- [x] **Fanout/reduce**: Control whether routing targets run per-item (`fanout: map`) or as a single aggregation (`fanout: reduce`).
- [x] **Criticality-aware retry suppression**: High-criticality steps skip retries for logical failures (fail_if/guarantee).

## Open Questions

- Should `goto` support only step IDs, or also labeled checkpoints (e.g., `goto_checkpoint`)?
- Should remediation steps be “ephemeral” (only run on failure) or regular steps reused elsewhere?
- Any preferred global default (e.g., retry once everywhere with linear 2s backoff)?
- Should we allow opt-in cross-scope targets via explicit qualifiers (e.g., `parent:setup-env`), guarded by additional loop caps?

## Next Steps (Completed)

All primary implementation work is done:

1. ~~Audit current workflow engine & failure handling.~~ Done.
2. ~~Finalize config keys and schema validation messages.~~ Done — see `src/types/config.ts`.
3. ~~Implement engine changes with loop safeguards.~~ Done — see `src/state-machine/states/routing.ts`.
4. ~~Add tests and demos.~~ Done — see `tests/integration/routing-*.test.ts` and `examples/routing-*.yaml`.
5. ~~Extend docs and workshop slides.~~ Done — see [failure-routing.md](./failure-routing.md).

Remaining follow-ups:
- CLI flags (`--on-fail-max-loops`, `--retry-max`, `--no-failure-routing`) are planned but not yet implemented.
- Consider adding labeled checkpoints and opt-in cross-scope targets (see Open Questions).
