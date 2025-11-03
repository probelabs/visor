# Agent Builder — Looping and Gating Plan (Right Way)

This document records the agreed approach for making the agent‑builder
configuration readable, robust, and deterministic while supporting multiple
refinement cycles.

## Goals

- Keep YAML simple and intention‑revealing (minimal control flow in config).
- Use a single, consistent `goto` semantics across outcomes.
- Loop until config lints, tests validate, and tests pass.
- Only run code‑review and cleanup when tests are truly green.
- Make tests deterministic with exact counts and clear staging.

## Engine Semantics (as implemented)

- `goto` may target any step from any outcome (`on_success`, `on_fail`, `on_finish`).
- If the target is a non‑ancestor, the engine performs a forward‑run starting at
  the target and continuing through all dependents in topological order.
- If the target is an ancestor, legacy behavior is preserved (re‑run the
  ancestor only).
- Loop budget is bounded by `routing.max_loops`.
- forEach (map) is respected when forward‑running, with per‑item scopes.

## Routing Pattern (Builder)

- Validators (`config-lint`, `tests-validate`, `agent-verify-tests`):
  ```yaml
  on_fail:
    goto: agent-refine
  ```
- Refine step:
  ```yaml
  on_success:
    goto: agent-write
  ```

This pattern keeps YAML small and the control flow obvious.

## Normalized Readiness Gate — `tests-ready`

To avoid brittle `if` conditions that depend on the shape of provider output,
introduce a tiny normalization step:

- `tests-ready` (command/script):
  - Inputs: `agent-verify-tests` output.
  - Output: `{ ready: boolean, failures: number }` where `ready === true` iff
    a real test result is available and `failures === 0`.
- Gate dependent steps with:
  ```yaml
  depends_on: [tests-ready]
  if: "outputs['tests-ready'] && outputs['tests-ready'].ready === true"
  ```

Apply this gate to:
- `agent-code-review`
- `agent-cleanup`

Result: code‑review/cleanup only run when tests are truly green, irrespective of
intermediate textual messages (like “No checks remain after tag filtering”).

## YAML Snippet (illustrative)

```yaml
checks:
  agent-verify-tests:
    type: command
    on: [manual, issue_opened]
    depends_on: [agent-write, config-lint, tests-validate]
    exec: node dist/index.js test --config tmp/{{ slug }}.tests.yaml --json - --bail
    output_format: json
    fail_if: "output && Number(output.failures||0) > 0"
    on_fail: { goto: agent-refine }

  tests-ready:
    type: command
    group: agent-quality
    depends_on: [agent-verify-tests]
    on: [manual, issue_opened]
    exec: |
      node <<'NODE'
      const fs=require('fs');
      try {
        const s=JSON.parse(process.env.INPUT||'{}');
        const results = !!s && typeof s==='object' && s.results;
        const failures = Number((s && s.failures) || 0);
        process.stdout.write(JSON.stringify({ ready: !!results && failures===0, failures }));
      } catch { process.stdout.write('{"ready":false,"failures":-1}'); }
      NODE
    env:
      INPUT: "{{ outputs['agent-verify-tests'] | json }}"
    output_format: json

  agent-code-review:
    type: ai
    depends_on: [tests-ready]
    if: "outputs['tests-ready'] && outputs['tests-ready'].ready === true"

  agent-cleanup:
    type: command
    depends_on: [tests-ready]
    if: "outputs['tests-ready'] && outputs['tests-ready'].ready === true"
```

## Test Strategy

- Prefer staged flow tests for readability:
  - Stage 1: shape failure (tests-validate fails) → refine → forward‑run.
  - Stage 2: behavioral failure (verify-tests fails) → refine → forward‑run.
  - Stage 3: code-review failure (ok=false) → refine → forward‑run → green.
- Keep one compact single‑run multi‑refine case to exercise repeated in‑run
  routing (engine sanity), but keep most multi‑step narratives in flows.
- Use exact counts for all steps; avoid `>=` and looseness.
- Never assert on anonymous/undefined steps; the recorder ignores them.

## Acceptance Criteria

- Builder loops until `config-lint`, `tests-validate`, and `agent-verify-tests`
  are green, then runs `agent-code-review` and `agent-cleanup` once.
- Forward‑run re‑executes the minimal dependent chain after each refine.
- All builder tests pass with exact counts and no “undefined” artifacts.

## Migration / Rollout

1) Keep existing configs working (ancestor goto unchanged).
2) Add `tests-ready` to defaults and wire gates for code‑review/cleanup.
3) Update builder tests to exact counts with forward‑run expectations.
4) Document the pattern in docs and examples; include in dist and npm package.

## Open Questions

- Should `tests-ready` also surface a short human‑readable summary? (Optional.)
- Do we want a memory‑based signal (e.g., `tests_green=true`) as an alternative
  to `tests-ready`? Current recommendation: keep `tests-ready` to avoid implicit
  coupling to memory.

## Notes

- The CLI `build` subcommand remains the single entrypoint for running the
  builder config locally.
- The recorder now ignores anonymous step names; tests should never rely on
  recorder artifacts.

