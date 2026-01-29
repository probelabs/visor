# Visor Engine Plan: Use `goto` for Looping on Failures

**Status: IMPLEMENTED** (Core features complete; `one_shot` tag not yet implemented)

This document captures the plan to simplify looping by using `goto` in `on_fail` and letting the engine re‑run the dependent chain deterministically.

## Background

Today, builder YAML uses `on_fail.run: [agent-refine, agent-write, config-lint, tests-validate, agent-verify-tests, …]` to bounce back through the pipeline. This is verbose and couples control‑flow to YAML.

Engine behavior:
- `on_success.goto` performs a forward‑run: it executes the `goto` target and all its dependents in topological order.
- `on_fail.goto` is currently limited to ancestor targets and does not forward‑run dependents.

## Goal

Allow clean, minimal YAML that uses only `goto` for looping:
- Validators: `on_fail: goto: agent-refine` (or directly `goto: agent-write`).
- Refine: `on_success: goto: agent-write`.

The engine should handle re‑running the necessary chain; YAML should not list the entire sequence.

## Proposed Engine Changes

1) Unify `goto` semantics across origins
- Make `goto` perform the same forward‑run whether invoked from `on_success`, `on_fail`, or `on_finish`.
- Factor shared code into a helper (e.g., `scheduleForwardRun(target, opts)`), currently implemented only inside the `on_success.goto` branch.

2) Relax ancestor‑only restriction for `on_fail.goto`
- Allow `goto` to any step in the DAG, not only ancestors.
- Keep safety guards (below) to prevent runaway loops.

3) Optional: Add anchors
- Introduce `anchor: true` (or `loop_anchor: true`) on steps like `agent-write`.
- If a validator has `on_fail` without explicit `goto`, engine can jump to the nearest anchor.

4) Loop safety and predictability
- Keep `routing.max_loops` budget (already implemented).
- **NOT YET IMPLEMENTED**: Respect `one_shot` tag: skip re‑running steps with `tags: [one_shot]` that already executed in this run.
- Maintain per‑run statistics to avoid duplicate scheduling within a wave.

5) Forward‑run details
- From the target (e.g., `agent-write`), compute the dependent subgraph (topological order) honoring `depends_on` and event filters.
- Preserve current event by default; honor `goto_event` only when explicitly provided.

## YAML Patterns After the Change

Pattern A (pure goto):
- Validators (`config-lint`, `tests-validate`, `agent-verify-tests`):
  ```yaml
  on_fail:
    goto: agent-refine
  ```
- Refine:
  ```yaml
  on_success:
    goto: agent-write
  ```

Pattern B (single hop to anchor):
- Validators:
  ```yaml
  on_fail:
    goto: agent-write
  ```

## Migration Plan

1) Engine implementation
- Unify forward‑run for `goto` in `on_fail` and `on_finish`.
- Remove ancestor‑only restriction or gate it behind a feature flag (e.g., `VISOR_GOTO_GLOBAL=true`).
- Extract forward‑run into a shared helper.

2) Builder YAML simplification
- Replace `on_fail.run: [ …full list… ]` with `on_fail: goto: agent-refine`.
- Keep `agent-refine on_success: goto: agent-write`.

3) Tests (exact counts only)
- Single‑invocation multi‑refine (3 cycles):
  - `refine = 3`, `write/lint/validate = 4`, `verify-tests = 3`, `code-review/cleanup/finish = 1`.
- Flow tests (staged multi‑refine) remain for readability.
- Edge cases: loop budget exceeded, `one_shot` steps, event override.

## Code Pointers

**Note:** The implementation now uses a state machine architecture. The original
`check-execution-engine.ts` is a compatibility layer that re-exports from
`state-machine-execution-engine.ts`.

Key files in `src/state-machine/states/`:
- `routing.ts` — handles `on_fail.run/goto` and `on_success.run/goto`:
  - `processOnSuccess()` and `processOnFail()` emit `ForwardRunRequested` events
  - Both use the same `evaluateGoto()` helper for unified behavior
- `wave-planning.ts` — processes forward-run requests:
  - Builds dependency subgraph and computes topological order
  - Detects cycles in forward-run dependency subset
  - Queues levels for execution
- `level-dispatch.ts` — executes checks and respects `if` conditions

Guards:
- `routing.max_loops` budget is enforced in `routing.ts` via `checkLoopBudget()`
- Per-wave deduplication handled in `wave-planning.ts`

## Telemetry / Debug
- Add concise debug logs for `goto` forward‑run across all origins: target, number of dependents, topological order.
- Keep existing OTEL and NDJSON traces.

## Rollout
- Implemented without a feature flag. Old configs are not broken: `goto` to
  ancestors preserves the previous “re-run ancestor only” behavior. New behavior
  simply allows `goto` to any step and forward‑runs its dependents when routing
  to a non‑ancestor.
- Builder YAML switched to pure `goto` in validators.

## Open Questions
- Should `goto` always forward‑run, or only when target is an anchor? (Leaning: always forward‑run for clarity.)
- Should we auto‑select an anchor when `goto` target is omitted? (Future convenience.)

## Acceptance Criteria
- Single‑run multi‑refine test passes with exact counts.
- Flow multi‑refine tests pass.
- No regression in existing suites; loop budget respected.

**Test Coverage:**
- `tests/integration/goto-forward-run-integration.test.ts` — verifies goto + goto_event forward-run
- `tests/unit/forward-goto-cycle-detection.test.ts` — verifies cycle detection in forward-run subset
