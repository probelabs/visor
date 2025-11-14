# Manual Loop Routing Refactor — Plan and Status

This document captures the plan, rationale, completed work, and next steps to support manual‑only chat loops in Visor without special tags or goto_js.

## Background

The previous behavior de‑duplicated a step when re‑routed in the same event, which stalled manual chat loops (ask → refine → ask …). We also experimented with a `repeatable` tag to bypass the guard, but it added concept complexity.

## Goals

- Manual‑only loop: ask → refine → ask … until refined=true, then finish.
- No special tags, no goto_js, no schedule event hops.
- Use fail_if + on_fail/on_success only.
- Keep default suites green and avoid regressions.

## Changes (Completed)

1) Engine parity for inline runs
- Inline `fail_if` evaluation and post‑`fail_if` routing: honor `on_fail.goto` for inline runs.

2) Routed re‑runs (no special tags)
- For `origin='on_fail'`, forward‑run allows re‑running the same step within the same grouped run; loop safety relies on `routing.max_loops`.

3) Failure‑aware forward runs
- Skip static `on_success.goto` chains when the target produced fatal issues (including `fail_if`).
- For `origin='on_fail'`, schedule only direct dependents of the failed target; skip dependents when any direct dep has fatal issues.

4) One‑shot opt‑in
- `tags: [one_shot]` prevents a terminal step (e.g., `finish`) from running more than once per grouped run.

5) Test‑visible history
- `executeChecks` now attaches `reviewSummary.history` with a safe snapshot of per‑step outputs history for deterministic testing (no I/O).

6) Task‑refinement agent (manual‑only)
- `defaults/task-refinement.yaml` uses `ask` → `refine` loop with `fail_if` and `on_fail/on_success` only; no `repeatable`, no `goto_js`, no `schedule`.
- Embedded tests: one‑pass and multi‑turn pass locally.

## Removed

- `repeatable` / `x-repeatable` mechanics: no longer needed.

## Tests

- YAML suites (green):
  - `defaults/task-refinement.yaml` (both cases)
  - `defaults/visor.tests.yaml` (10/10)

- Jest integration (added):
  - `tests/integration/on-fail-no-cascade.test.ts`: verifies failure‑aware forward runs do not cascade into success chains.

- Jest integration (deferred):
  - A deterministic loop test using `reviewSummary.history` to assert multiple turns. Will add a tiny test driver to stabilize execution context and tag filtering.

## How to Validate Locally

```bash
# Build CLI
npm run build:cli

# Task-refinement YAML
VISOR_DEBUG=true node dist/index.js test --config defaults/task-refinement.yaml --max-parallel 1

# Default suite
node dist/index.js test --config defaults/visor.tests.yaml --max-parallel 2 --json tmp/visor.json

# Focused Jest tests (engine behavior)
npm test -- on-fail-no-cascade.test.ts
```

Acceptance criteria:
- Both YAML suites pass.
- No `repeatable`/`x-repeatable` in the codebase.
- `defaults/task-refinement.yaml` contains no `goto_js` and no `schedule` hops.

## Next Steps (Planned)

1) Deterministic Jest loop test
- Add a small engine test driver util (internal only) that seeds event=`manual` and disables tag filtering; assert loop counts via `reviewSummary.history`.

2) Documentation
- Add a short “Manual Loops” page covering `fail_if`+`on_fail/on_success`, loop budgets, and `one_shot` for terminal steps.

3) CI gates
- Add a CI job to run: default YAML, task‑refinement YAML, and the focused Jest tests.

## Risk & Rollback

- Risk: forward‑run changes could over/under schedule dependents; mitigated by direct‑dependent + fatal‑skip guards.
- Rollback: revert to pre‑refactor `scheduleForwardRun` and inline `fail_if` handling while keeping `reviewSummary.history` attachment (benign).
