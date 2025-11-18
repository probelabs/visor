# Visor Engine: Fault Management, Contracts, and Transitions (NASA‑style)

This guide consolidates the expected behavior for conditional gating, design‑by‑contract, routing, and retries in the state‑machine engine. It follows safety‑critical software principles (detect → isolate → recover → report) while remaining practical for CI/PR automation.

## Core Principles
- Deterministic evaluations: expressions are pure (no side‑effects, time/network), evaluated in a sandbox.
- Fail‑secure defaults: evaluation errors pick the safest behavior (skip or fail closed), and are logged.
- Bounded retries: never unbounded loops; per‑scope caps and loop budgets.
- Isolation: failures do not cascade unless explicitly permitted.
- Auditability: every decision is journaled with cause, scope, and timestamps; JSON snapshots are exportable.

## Criticality Model (What It Is and Why It Matters)

Criticality classifies a step by the operational risk it carries. We use it to choose safe defaults for contracts, gating, retries, and loop budgets. Continue_on_failure only controls dependency gating; it does not define criticality.

Classes (pick one):
- external: mutates outside world (GitHub ops, HTTP methods ≠ GET/HEAD, file writes)
- control-plane: alters routing/fan‑out (forEach parents; on_* with goto/run; memory used by guards)
- policy: enforces permissions/policy (strong `fail_if`/`guarantee` gating actions)
- non-critical: pure/read‑only compute

Defaults derived from criticality:
- Critical (external/control‑plane/policy)
  - Contracts required: must declare meaningful `assume` (preconditions) and `guarantee` (postconditions).
  - Gating: `continue_on_failure: false` by default; dependents skip on failure.
  - Retries: transient faults only; bounded (max 2–3 with backoff); no auto‑retry for logical violations (`fail_if`/`guarantee`).
  - Loop budget: tighter per‑scope (e.g., 8).
  - Side‑effects: suppress/postpone mutating actions when contracts or `fail_if` fail; route to remediation.
- Non‑critical
  - Contracts recommended; may allow `continue_on_failure: true`.
  - Standard loop budget (10), normal retry bounds.

How to express today:
- Use tags: `tags: [critical]` (and optionally `external`, `control-plane`, `policy`).
- (Proposed) First‑class field: `criticality: external|control-plane|policy|non-critical`.

Heuristics (auto‑classification you can apply): mutating providers → external; forEach parents/on_* goto/run → control‑plane; policy gates → policy; otherwise non‑critical.

## Behavior Matrix by Construct and Criticality

Below is the exact behavior for each construct depending on criticality. “Skip” means provider is not executed and it does not count as a run.

- if (plan‑time)
  - Non‑critical: false/error → skip; dependents may run if OR‑deps satisfy or they are unrelated.
  - Critical: same skip; because `continue_on_failure: false` is default, downstream mutators must depend on this step and will skip.

- assume (pre‑exec)
  - Non‑critical: false/error → skip (skipReason=assume); no retry.
  - Critical: false/error → skip and block downstream side‑effects via dependency gating. If you need an explicit failure (not a skip), add a guard step (see Example C below) or (optional) `assume_mode: 'fail'` when available.

- guarantee (post‑exec)
  - Non‑critical: violation → add `contract/guarantee_failed` issue; mark failure; route `on_fail`; no auto‑retry unless remediation exists.
  - Critical: violation → mark failure; suppress downstream mutating actions (dependents should depend_on this step). Route `on_fail` to remediation; retries only for transient exec faults, not logical ones.

- fail_if (post‑exec)
  - Non‑critical: true → failure; bounded retry only for transient faults; otherwise remediation.
  - Critical: true → failure; do not auto‑retry logical failures; block side‑effects; route remediation with tight caps.

- transitions / goto
  - Both: prefer declarative `transitions` first; respect per‑scope loop budgets (default 10; critical recommended 8). Exceeding budget adds `routing/loop_budget_exceeded` and halts routing in that scope.

Numeric defaults (recommended)
- Retries: max 3 (non‑critical), max 2 (critical), exponential backoff with jitter (e.g., 1s, 2s, 4s ±10%).
- Loop budgets: 10 (non‑critical), 8 (critical/control‑plane branches).

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
  - Any `assume` expression false → skip with reason `assume`. In critical branches, this blocks dependent mutating steps via dependency gating.
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
  - Violations add issues with ruleId `contract/guarantee_failed`, mark failure, and route via `on_fail`.
  - In critical branches, violation blocks downstream mutating actions (dependents should be gated on this step) and is not auto‑retried as a logical failure.
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

## End-to-End Policy (Do-It-Right Checklist)

This section summarizes the full, NASA‑style approach we recommend. Items marked (optional) are enhancements you can phase in.

### Config / Schema
- Criticality (proposed field; tags remain a fallback)
  - `criticality: external | control-plane | policy | non-critical`
  - or minimal boolean `critical: true|false` if you prefer simplicity.
- Contracts (implemented)
  - `assume:` preconditions (list of expressions)
  - `guarantee:` postconditions (list of expressions)
  - (optional) `assume_mode: 'skip' | 'fail'` — if set to `fail`, unmet assume marks failure and routes `on_fail`.
- Transitions (implemented)
  - `on_success|on_fail|on_finish.transitions: [{ when, to, goto_event? }]` with `goto_js` fallback.
- Retries
  - (proposed) `retry_on: ['transient'] | ['transient','logical']` (default: transient only).
- Safety profiles (optional)
  - `safety: strict | standard` (global defaults for budgets/retries on critical branches).

### Engine Policy (derived from criticality)
- External / Control‑plane / Policy (critical)
  - Require meaningful `assume` and `guarantee`.
  - Default `continue_on_failure: false`.
  - Retries: bounded (max 2–3), transient faults only; no auto‑retry for logical violations.
  - Lower per‑scope loop budget (e.g., 8 instead of 10).
  - Suppress downstream mutating actions if guarantees/fail_if violate; remediate or escalate.
- Non‑critical
  - Contracts recommended but not required.
  - `continue_on_failure: true` allowed where safe.
  - Default loop budget (10), normal retry bounds.

### Runtime Semantics
- Evaluation order
  1) `if` (plan‑time scheduling) → 2) `assume` (pre‑exec) → 3) provider → 4) `guarantee` + `fail_if` (post‑exec) → 5) transitions/goto.
- Determinism & safety
  - Expressions run in a secure sandbox; no I/O/time randomness; short timeouts.
- ForEach isolation
  - `fanout: map` executes per‑item; failures isolate; reduce aggregates once.
  - (optional) per‑item concurrency with default 1.

### Side‑Effect Control
- Detect mutating providers (GitHub ops except read‑only, HTTP methods ≠ GET/HEAD, file writes).
- For critical steps: require idempotency or compensating actions; block side‑effects when contracts fail.

### Observability / Telemetry
- Journal each decision (check, scope, expression, inputs, result, timestamps).
- Emit structured fault events: `fault.detected`, `fault.isolated`, `fault.recovery.*`.
- Metrics: retries, fault counts by class, loop budget hits.

### Persistence / Resume (debug‑first)
- Export last run as JSON (implemented): `saveSnapshotToFile()`.
- (future) Debug‑only resume that reconstructs state from snapshot.

### Validation / Guardrails
- Warn if a critical step lacks `assume` or `guarantee`.
- Warn if mutating provider lacks criticality classification.
- Warn if `transitions` exist with tight loops disabled in `strict` safety profile.
- CLI `--safe-mode` to disable mutating providers for dry‑runs.

### Verification (Tests & Acceptance Criteria)
- Unit
  - `assume` skip vs guard‑step hard‑fail.
  - `guarantee` violations add issues; no extra provider calls.
  - Transitions precedence over `goto_js`; loop budget enforcement.
- Integration
  - Critical external step blocks downstream side‑effects on contract failure.
  - Control‑plane forEach parent with tight budget; verifies no loops past limit.
  - Retry policy honors transient vs logical classification.
- YAML e2e
  - Updated defaults remain green; include a strict safety profile scenario.

### Acceptance Criteria (done when)
- All tests (unit/integration/YAML) green with critical/non‑critical mixes.
- Docs updated (this guide + engine plan); examples use block‑style YAML.
- Logger outputs timestamps; debug is gated.
- No dist/ committed; config validators warn on unsafe critical steps.

## Additional Examples

### Critical External Step
```yaml
checks:
  post-comment:
    type: github
    criticality: external
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

### Control‑Plane ForEach With Transitions
```yaml
routing:
  max_loops: 8

checks:
  extract-items:
    type: command
    criticality: control-plane
    exec: "node -e \"console.log('[\\"a\\",\\"b\\"]')\""
    forEach: true
    on_finish:
      transitions:
        - when: "any(outputs_history['validate'], v => v && v.ok === false)"
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
