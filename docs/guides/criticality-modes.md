# Criticality Modes — External, Control‑Plane, Policy, Non‑Critical

This document explains what each criticality mode means, how to declare it, the engine defaults it enables, and how core constructs (if, assume, guarantee, fail_if, transitions, retries, loop budgets) behave per mode. All examples use block‑style YAML.

## Why criticality?

Criticality classifies a step by the operational risk it carries. The engine uses it to pick safe defaults for contracts, dependency gating, retries, and loop budgets. `continue_on_failure` only controls gating; it does not define criticality.

Declare criticality on each check:
```yaml
checks:
  some-step:
    type: command
    criticality: control-plane   # external | control-plane | policy | non-critical
```

If the field is omitted, the engine may infer a default (mutating → external; forEach parent or on_* goto/run → control‑plane; policy gates → policy; else non‑critical). You can override any default on a per‑check basis.

---

## External

Mutates systems outside the engine (GitHub ops, HTTP methods ≠ GET/HEAD, file writes, ticket creation).

Defaults
- Contracts required: declare `assume` (preconditions) and `guarantee` (postconditions).
- Gating: `continue_on_failure: false` by default; dependents skip when this step fails.
- Retries: transient faults only, bounded (max 2–3 with backoff); no auto‑retry for logical (policy/contract) violations.
- Loop budget: standard (10) unless the step also routes.
- Side‑effects: suppress/postpone mutating actions when `guarantee`/`fail_if` fail; require remediation/approval.

Recommended contracts
- assume examples: authenticated/authorized; dry‑run disabled when posting; rate‑limit budget present.
- guarantee examples: created resource IDs present; idempotency markers written; invariants about payload size/format.

Example — safely posting a PR comment
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

---

## Control‑Plane

Steers execution (decides what runs next and how often). Examples: forEach parents, steps with on_* transitions/goto/run, memory/flags used by conditions.

Defaults
- Contracts required (route integrity): meaningful `assume` and `guarantee`.
- Gating: `continue_on_failure: false` by default.
- Retries: transient faults only (provider crashes); no auto‑retry for logical violations.
- Loop budgets: tighter per‑scope (recommended 8) to avoid oscillations.

Recommended contracts
- assume: structural preconditions and size caps (e.g., arrays, max fan‑out).
- guarantee: postconditions about control signals (e.g., last_wave_size ≤ cap, valid transition targets).

Example — fan‑out producer with loopback transitions
```yaml
routing:
  max_loops: 8

checks:
  extract-items:
    type: command
    criticality: control-plane
    exec: "node -e \"console.log('[\\"a\\",\\"b\\",\\"c\\"]')\""
    forEach: true
    assume:
      - "Array.isArray(output)"
      - "output.length <= 100"
    guarantee:
      - "Array.isArray(output)"
      - "output.every(x => typeof x === 'string')"
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

---

## Policy

Enforces permissions, compliance, or organizational policy (e.g., reviewer must be MEMBER, commit message format, license checks). Often gates external actions even if it doesn’t mutate itself.

Defaults
- Contracts required; strict handling of logical violations.
- Gating: `continue_on_failure: false` by default.
- Retries: do not auto‑retry logical failures; only retry transient provider errors.

Recommended contracts
- assume: environment/org state required for policy checks.
- guarantee: policy pass/fail booleans, lists of violations, etc.

Example — permission gate that blocks labels/comments on failure
```yaml
checks:
  permission-check:
    type: command
    criticality: policy
    exec: node scripts/check-permissions.js    # -> { allowed: boolean }
    guarantee:
      - "typeof output.allowed === 'boolean'"

  post-label:
    type: github
    depends_on:
      - permission-check
    criticality: external
    op: labels.add
    values:
      - "reviewed"
    if: "outputs['permission-check'].allowed === true"   # only proceed when policy passes
```

---

## Non‑Critical

Pure/read‑only compute where failures don’t risk unsafe behavior.

Defaults
- Contracts recommended (not mandatory).
- Gating: `continue_on_failure: true` allowed if safe.
- Retries: bounded; can be slightly looser.

Example — summary step that won’t block the pipeline
```yaml
checks:
  summarize:
    type: ai
    criticality: non-critical
    on:
      - pr_opened
      - pr_updated
    continue_on_failure: true
    fail_if: "(output.errors || []).length > 0"
```

---

## Construct Behavior by Mode

- if (plan‑time): false/error → skip in all modes. In critical branches, dependents should be gated so mutating steps do not run.
- assume (pre‑exec): false/error → skip before provider call. In critical modes this should block downstream mutators; use a guard step if you need a hard failure.
- guarantee (post‑exec): violation → failure, add `contract/guarantee_failed`, route `on_fail`. In critical modes, block mutating side‑effects until remediated.
- fail_if (post‑exec): true → failure, route `on_fail`. Do not auto‑retry logical failures in critical modes.
- transitions/goto: prefer declarative transitions; enforce loop budgets (default 10; recommended 8 for control‑plane fan‑outs).

Numeric defaults (recommended)
- Retries: max 3 (non‑critical), max 2–3 (critical), exponential backoff with jitter.
- Loop budget: 10 (default), 8 for control‑plane branches.

---

## Patterns & Guardrails

- Guard step for hard‑fail on unmet preconditions
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

- Side‑effect suppression
  - Ensure mutating steps depend on the critical gate/contract step so failures/violations block posting.

- Determinism
  - Keep routing/contract expressions pure (no time/random/network), with short evaluation timeouts.

---

## See also
- docs/guides/fault-management-and-contracts.md — full safety checklist, behavior matrix, and examples
- docs/engine-state-machine-plan.md — engine phases, routing, and loop budgets
