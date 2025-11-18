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

### Mode selection — quick checklist
- Does this step mutate external state? → external
- Does it steer execution (fan‑out, transitions/goto, sets flags for other guards)? → control-plane
- Does it enforce permissions/policy/compliance and gate external steps? → policy
- Otherwise, is it read‑only/pure and low‑risk? → non-critical

If in doubt, start with non-critical and promote to policy/control‑plane/external when you add gating, routing, or side‑effects.

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

### When to pick EXTERNAL (real‑life)
- GitHub comment/label/edit operations (comment.create, labels.add/remove).
- HTTP webhooks that mutate (POST/PUT/PATCH/DELETE) — Slack messages, PagerDuty incidents, Notion/Linear/Jira ticket creation.
- File system writes (artifact publishing, changelog generation into repo) or any step that makes persistent changes.
- Git operations that change state (push, tag, merge) — if ever enabled, treat as external by default.

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
    guarantee:
      - "Array.isArray(output)"
      - "output.every(x => typeof x === 'string')"
      - "output.length <= 100"           # size cap belongs in guarantee (post‑exec)
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

### When to pick CONTROL‑PLANE (real‑life)
- A forEach parent that fans out work to child steps (e.g., facts, files, services, directories, modules).
- An aggregator that computes a run decision (`all_valid`, `needs_retry`, `next_targets`) and routes via transitions.
- A small `memory`/`log`/`script` step that sets flags used by `if/assume/guarantee` on other checks (e.g., `needs_retry=true`).
- Workflow orchestration steps whose purpose is routing/looping rather than producing user-facing output.

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

### When to pick POLICY (real‑life)
- Permission & role checks that gate external actions (only MEMBERS may post/label).
- Compliance or guardrail checks (branch protection, commit message format, DCO/CLA verification) that block mutating steps.
- Change‑management windows (e.g., “no posts on weekends”), environment gates (PROD vs. STAGING), or organization‑wide safety toggles.

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

### When to pick NON‑CRITICAL (real‑life)
- Read‑only analysis and summaries (lint, style, performance hints, PR summary) where failure should not block critical tasks.
- Exploratory AI steps that help humans but don’t gate or mutate (draft review comments in dry‑run; heuristics, suggestions).
- Any leaf computation whose outputs aren’t consumed by control‑plane or external steps.

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

## Comprehensive Example — End‑to‑End Flow Using All Primitives

```yaml
version: "1.0"

routing:
  max_loops: 8

checks:
  extract-facts:
    type: command
    criticality: control-plane
    on:
      - issue_opened
      - issue_comment
    exec: "node -e \"console.log('[{""id"":1,""claim"":""A""},{""id"":2,""claim"":""B""}]')\""
    forEach: true
    assume:
      - "Array.isArray(output)"
      - "output.length <= 50"
    guarantee:
      - "Array.isArray(output)"
      - "output.every(x => typeof x.id === 'number' && typeof x.claim === 'string')"
    on_finish:
      transitions:
        - when: "any(outputs_history['validate-fact'], v => v && v.is_valid === false) && event.name === 'issue_opened'"
          to: issue-assistant
        - when: "any(outputs_history['validate-fact'], v => v && v.is_valid === false) && event.name === 'issue_comment'"
          to: comment-assistant

  validate-fact:
    type: command
    depends_on:
      - extract-facts
    fanout: map
    exec: node scripts/validate-fact.js
    fail_if: "output && output.is_valid === false"
    on_fail:
      retry: { max: 1, backoff: { mode: exponential, delay_ms: 1000 } }

  aggregate:
    type: command
    criticality: control-plane
    depends_on:
      - validate-fact
    exec: node scripts/aggregate-validity.js   # -> { all_valid: boolean }
    guarantee:
      - "output && typeof output.all_valid === 'boolean'"
    on_success:
      transitions:
        - when: "output.all_valid === true"
          to: permission-check

  permission-check:
    type: command
    criticality: policy
    exec: node scripts/check-permissions.js    # -> { allowed: boolean }
    guarantee:
      - "typeof output.allowed === 'boolean'"

  post-comment:
    type: github
    criticality: external
    depends_on:
      - permission-check
    on:
      - issue_opened
    if: "outputs['permission-check'] && outputs['permission-check'].allowed === true"
    assume:
      - "outputs['permission-check'] && outputs['permission-check'].allowed === true"
      - "env.DRY_RUN !== 'true'"
    op: comment.create
    guarantee:
      - "output && typeof output.id === 'number'"
    continue_on_failure: false

  summarize:
    type: ai
    criticality: non-critical
    on:
      - issue_opened
    continue_on_failure: true
    fail_if: "(output.errors || []).length > 0"
```

This scenario demonstrates all primitives across modes: control‑plane fan‑out + transitions, policy gating, external action with contracts, and a non‑critical leaf that may fail softly.
