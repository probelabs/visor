# Visor Engine: Fault Management, Contracts, and Transitions (NASA‑style)

This guide consolidates the expected behavior for conditional gating, design‑by‑contract, routing, and retries in the state‑machine engine. It follows safety‑critical software principles (detect → isolate → recover → report) while remaining practical for CI/PR automation.

## Core Principles
- Deterministic evaluations: expressions are pure (no side‑effects, time/network), evaluated in a sandbox.
- Fail‑secure defaults: evaluation errors pick the safest behavior (skip or fail closed), and are logged.
- Bounded retries: never unbounded loops; per‑scope caps and loop budgets.
- Isolation: failures do not cascade unless explicitly permitted.
- Auditability: every decision is journaled with cause, scope, and timestamps; JSON snapshots are exportable.

## Constructs and Expected Behavior

### Quick reference: differences at a glance

- Purpose
  - `if`: Scheduling gate — decides whether the step should be scheduled in this run.
  - `assume`: Preconditions — must hold immediately before executing the provider.
  - `guarantee`: Postconditions — must hold for the result the provider produced.
  - `fail_if`: Failure detector — declares which results count as failures.

- When it runs
  - `if`: before scheduling (earliest).
  - `assume`: after scheduling, right before calling the provider.
  - `guarantee`: immediately after provider returns.
  - `fail_if`: immediately after provider returns (can co‑exist with `guarantee`).

- Inputs visible to the expression
  - `if`: event, env, filesChanged meta, previous check outputs (current wave), memory (read‑only helpers).
  - `assume`: same as `if`, plus fully resolved dependency results for this scope.
  - `guarantee`/`fail_if`: same as `assume`, plus the step’s own output/result.

- Effect on execution
  - `if` false (or error): step is skipped and never scheduled.
  - `assume` false (or error): step is skipped right before execution; provider is not called.
  - `guarantee` violation: step has executed; violation adds issues; routes `on_fail`.
  - `fail_if` true: step has executed; marks failure; routes `on_fail`.

- Stats/journal
  - `if`/`assume` skip: recorded as a skip; does not count as a run; journal contains an empty result entry.
  - `guarantee`/`fail_if`: counted run; issues recorded; journal contains the full result.

- Routing & dependents
  - Skips (`if`/`assume`) propagate gating to dependents unless OR‑deps satisfy or `continue_on_failure` applies on an alternate path.
  - Failures (`guarantee`/`fail_if`) route via `on_fail` with bounded retries/remediation.

When to choose which
- Use `if` when you can decide at plan time whether a step should even be considered (tags, events, coarse repo conditions).
- Use `assume` when prerequisites depend on dynamic dependencies or environment right before execution (e.g., tools bootstrapped by a `prepare` step).
- Use `guarantee` when the provider must produce outputs that satisfy invariants (shape, counts, idempotency confirmations).
- Use `fail_if` when policy/thresholds on the produced results define failure (test counts, lints, security finding thresholds).

### 1) `if` (pre‑run gate)
- Purpose: schedule a step only when conditions are met (event, env, prior outputs).
- Behavior:
  - `if` true → run.
  - `if` false or evaluation error → skip with reason `if_condition` (does not count as a run); dependents skip unless alternate OR‑deps satisfy.
- Example:
```yaml
checks:
  lint:
    type: command
    on:
      - pr_opened
      - pr_updated
    if: "filesCount > 0 && env.CI === 'true'"
    exec: npx eslint .
```

### 2) `assume` (preconditions, design‑by‑contract)
- Purpose: non‑negotiable prerequisites before a step executes.
- Behavior:
  - Any `assume` expression false → skip with reason `assume` (non‑critical) or block dependents (critical).
  - No automatic retry unless a defined remediation can satisfy the precondition.
- Example with remediation:
```yaml
checks:
  prepare-env:
    type: command
    exec: node scripts/bootstrap.js
  analyze:
    type: command
    depends_on:
      - prepare-env
    assume:
      - "env.TOOLING_READY === 'true'"
      - "Array.isArray(outputs_history['prepare-env']) ? true : true"
    exec: node scripts/analyze.js
```

### 3) `guarantee` (postconditions, design‑by‑contract)
- Purpose: invariants that must hold after a step completes.
- Behavior:
  - Violations add non‑fatal issues with ruleId `contract/guarantee_failed` and route via `on_fail`.
  - Critical steps may treat violations as fatal downstream (e.g., skip posting labels/comments).
- Example:
```yaml
checks:
  summarize:
    type: command
    exec: "node -e \"console.log('{\\"items\\":[1,2,3]}')\""
    guarantee:
      - "output && Array.isArray(output.items)"
      - "output.items.length > 0"
    on_fail:
      run:
        - recompute
  recompute:
    type: command
    exec: node scripts/recompute.js
```

### 4) `fail_if` (post‑run failure detector)
- Purpose: codifies “this result means failure.”
- Behavior:
  - If true → mark step failed, append `<check>_fail_if` issue, and route `on_fail`.
  - Evaluation errors → log, treat as not triggered (prefer separate system issue).
- Example with bounded retry/backoff:
```yaml
checks:
  tests:
    type: command
    exec: npm test -- --runInBand
    fail_if: "output.summary.failed > 0"
    on_fail:
      retry: { max: 2, backoff: { mode: exponential, delay_ms: 1000 } }
      run:
        - collect-logs
  collect-logs:
    type: command
    exec: node scripts/collect-logs.js
```

## Declarative Transitions (on_success / on_fail / on_finish)
Use transitions for clear, testable routing without inline JS logic. If none match, the engine falls back to `goto_js/goto`.

Helpers available inside `when`: `outputs`, `outputs_history`, `output`, `event`, `memory`, plus `any/all/none/count`.

### Example — Fact Validation Loopback
```yaml
checks:
  extract-facts:
    type: ai
    forEach: true
    on_finish:
      transitions:
        - when: "any(outputs_history['validate-fact'], v => v && v.is_valid === false) && event.name === 'issue_opened'"
          to: issue-assistant
        - when: "any(outputs_history['validate-fact'], v => v && v.is_valid === false) && event.name === 'issue_comment'"
          to: comment-assistant

  validate-fact:
    type: ai
    depends_on:
      - extract-facts

  issue-assistant:
    type: ai
    on_success:
      transitions:
        - when: "event.name === 'issue_comment' && output?.intent === 'comment_retrigger'"
          to: overview
          goto_event: pr_updated
```

## Critical vs Non‑Critical Steps

A step is critical when it meets any of:
- External side effects (mutating: GitHub ops, HTTP methods ≠ GET/HEAD, file writes).
- Control‑plane impact (forEach parents, on_* that drive goto/run, memory used by conditions).
- Safety/policy gates (permission checks, strong `fail_if`/`guarantee`).
- Irreversible/noisy effects (user‑visible posts, ticket creation).

Pragmatic marking today:
- Use `tags: [critical]` (and optionally `control-plane`, `external`).
- Heuristics: treat mutating providers as critical by default.

Policy matrix (default)
- Non‑critical: `assume` skip (no retry); `guarantee` → issues + on_fail; `fail_if` → failure; retries only for transient faults.
- Critical: `assume` violation blocks dependents; `guarantee` violations prevent downstream side‑effects; `fail_if` retried only if transient; tighter loop budgets.

## Criticality vs. `continue_on_failure`

`continue_on_failure` is a dependency‑gating knob: it decides whether dependents may run after this step fails. It does not fully define criticality. A NASA‑style notion of criticality also governs contracts, retries, loop budgets, side‑effect controls, and escalation paths.

Recommended practice:

- Use `continue_on_failure` to control gating per edge, but classify steps explicitly as critical or not.
- Express criticality today via tags, and (optionally) promote to a dedicated field later.

### Expressing criticality (current config)

- Using tags (immediately usable):
```yaml
checks:
  post-comment:
    type: github
    tags:
      - critical
      - external
    on:
      - pr_opened
    op: comment.create
    assume:
      - "env.ALLOW_POST === 'true'"
    guarantee:
      - "typeof output.id === 'number'"
    continue_on_failure: false
    on_fail:
      retry: { max: 2, backoff: { mode: exponential, delay_ms: 1500 } }
```

- Using a proposed field (future‑proof, clearer intent):
```yaml
checks:
  label:
    type: github
    criticality: external   # or: control-plane | policy | non-critical
    on:
      - pr_opened
    op: labels.add
    values:
      - "reviewed"
    assume: "isMember()"
    guarantee: "Array.isArray(output.added) && output.added.includes('reviewed')"
```

Engine policy derived from criticality (summary):

- Critical (external/control‑plane/policy):
  - require meaningful `assume` and `guarantee`.
  - `continue_on_failure: false` by default.
  - retries only for transient faults, with tight caps and backoff.
  - lower routing loop budgets for branches this step drives.
  - suppress downstream mutating side‑effects when guarantees fail.
- Non‑critical:
  - `assume`/`guarantee` recommended but not mandatory.
  - may set `continue_on_failure: true` to keep non‑critical branches running.

### Concrete examples

1) Non‑critical compute that may fail without stopping the pipeline:
```yaml
checks:
  summarize:
    type: ai
    tags:
      - non-critical
    on:
      - pr_opened
      - pr_updated
    continue_on_failure: true
    fail_if: "(output.errors || []).length > 0"
```

2) External (critical) — posting a PR comment with strict contracts and bounded retries:
```yaml
checks:
  post-comment:
    type: github
    tags:
      - critical
      - external
    on:
      - pr_opened
    op: comment.create
    assume:
      - "isMember()"
      - "env.DRY_RUN !== 'true'"
    guarantee:
      - "output && typeof output.id === 'number'"
    continue_on_failure: false
    on_fail:
      retry: { max: 2, backoff: { mode: exponential, delay_ms: 1200 } }
```

3) Control‑plane (critical) — forEach parent that drives routing with a tighter loop budget:
```yaml
routing:
  max_loops: 8   # lower than default for safety on control‑plane flows

checks:
  extract-items:
    type: command
    tags:
      - critical
      - control-plane
    exec: "node -e \"console.log('[\\"a\\",\\"b\\",\\"c\\"]')\""
    forEach: true
    on_finish:
      transitions:
        - when: "any(outputs_history['validate'], x => x && x.ok === false)"
          to: remediate

  validate:
    type: command
    depends_on:
      - extract-items
    fanout: map
    exec: node scripts/validate.js

  remediate:
    type: command
    exec: node scripts/fix.js
```

## Retries, Loop Budgets, and ForEach
- Retries: bounded (e.g., max 3), exponential backoff with jitter; per‑scope attempt counters stored in memory.
- Routing loop budget: `routing.max_loops` (default 10) per scope; exceeding emits `routing/loop_budget_exceeded` and halts routing for that scope.
- ForEach fan‑out:
  - Per‑item retries are independent; partial success allowed; failed items are isolated.
  - Aggregates reflect per‑item outcomes; reduce/map fan‑out is controlled via `fanout: 'reduce' | 'map'` on dependents.

### Example — ForEach With Per‑Item Retries
```yaml
checks:
  list:
    type: command
    exec: "node -e \"console.log('[\\"a\\",\\"b\\"]')\""
    forEach: true

  process:
    type: command
    depends_on: [list]
    fanout: map
    exec: node scripts/process-item.js
    fail_if: "output.__failed === true"
    on_fail:
      retry: { max: 1, backoff: { mode: fixed, delay_ms: 500 } }
```

## Observability and Snapshots
- Every decision is committed to the journal (check id, scope, event, output, issues, timing).
- Export last run snapshot to JSON for post‑mortem or replay scaffolding:
```ts
const engine = new StateMachineExecutionEngine();
const result = await engine.executeChecks({ checks: ['build'], config });
await engine.saveSnapshotToFile('run-snapshot.json');
// const snap = await engine.loadSnapshotFromFile('run-snapshot.json');
```

## Safety Defaults Recap
- `if`: error → skip (if_condition).
- `assume`: violation → skip (or block dependents if critical).
- `guarantee`: violation → add `contract/guarantee_failed` issue; route on_fail.
- `fail_if`: true → failure; retries only for transient classifications.
- Loop budgets and retry caps prevent unbounded execution.

---

For additional examples, see:
- defaults/visor.yaml (fact validation transitions)
- tests/unit/routing-transitions-and-contracts.test.ts (transitions, assume/guarantee)
- docs/engine-state-machine-plan.md (state machine overview)

## Side‑by‑side examples: the same intent with different constructs

### Example A — Skip entirely when the repo has no changes
Using `if` (best: planning‑time decision):
```yaml
checks:
  summarize:
    type: ai
    on:
      - pr_opened
      - pr_updated
    if: "filesCount > 0"
    exec: node scripts/summarize.js
```

Using `assume` (works but later in the lifecycle):
```yaml
checks:
  summarize:
    type: ai
    on:
      - pr_opened
      - pr_updated
    assume:
      - "filesCount > 0"
    exec: node scripts/summarize.js
```
Both skip the step; `if` prunes earlier, `assume` skips right before calling the provider.

### Example B — Ensure outputs obey invariants
Using `guarantee` (contract):
```yaml
checks:
  collect:
    type: command
    exec: "node collect.js"    # produces { items: [...] }
    guarantee:
      - "output && Array.isArray(output.items)"
      - "output.items.length > 0"
    on_fail:
      run:
        - recompute
```

Using `fail_if` (policy):
```yaml
checks:
  collect:
    type: command
    exec: "node collect.js"
    fail_if: "!(output && Array.isArray(output.items) && output.items.length > 0)"
    on_fail:
      run:
        - recompute
```
Both mark the run as failed and route `on_fail`; use `guarantee` for design‑by‑contract semantics, `fail_if` for policy rules.

### Example C — “Hard‑fail” on unmet preconditions (guard step pattern)
If you need an explicit failure instead of a skip for an unmet `assume`, use a guard:
```yaml
checks:
  prechecks:
    type: command
    exec: node scripts/check-tools.js   # exit 1 when tools missing
    fail_if: "output.exitCode !== 0"
  analyze:
    type: command
    depends_on:
      - prechecks
    exec: node scripts/analyze.js
```
