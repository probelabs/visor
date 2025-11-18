# Visor Engine: Fault Management, Contracts, and Transitions (NASA‑style)

This guide consolidates the expected behavior for conditional gating, design‑by‑contract, routing, and retries in the state‑machine engine. It follows safety‑critical software principles (detect → isolate → recover → report) while remaining practical for CI/PR automation.

## Core Principles
- Deterministic evaluations: expressions are pure (no side‑effects, time/network), evaluated in a sandbox.
- Fail‑secure defaults: evaluation errors pick the safest behavior (skip or fail closed), and are logged.
- Bounded retries: never unbounded loops; per‑scope caps and loop budgets.
- Isolation: failures do not cascade unless explicitly permitted.
- Auditability: every decision is journaled with cause, scope, and timestamps; JSON snapshots are exportable.

## Constructs and Expected Behavior

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
