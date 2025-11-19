# Visor Workflow Style Guide

This guide captures pragmatic conventions for writing clear, safe, and maintainable Visor workflows (visor.yaml and friends). It complements the feature guides by focusing on readability, intent, and day‑2 operability.

## Why This Matters

- Readability reduces on‑call cognitive load and speeds reviews.
- A consistent structure makes behaviors obvious (what, when, how, and why).
- Guardrails prevent accidental side effects and clarify intent.

## Key Principles

- One step, one responsibility. Prefer small, composable steps over “kitchen‑sink” checks.
- Declare intent before mechanics. Readers should see what a step is and when it runs before how it runs.
- Guard and contract every important step. Preconditions (“assume” or “if”) up front, postconditions (“schema” or “guarantee”) after execution.
- Avoid hidden control flow. Prefer declarative transitions and explicit dependencies over imperative logic.
- Be idempotent, especially for external effects. Plan for retries and partial failures.

## Recommended Key Order (Per Step)

Use this top‑down order for every step. Omit sections that don’t apply.

1) Identity & Intent
- `type`
- `criticality` (external | internal | policy | info)
- `group`
- `tags`
- `description`

2) Triggers & Dependencies
- `on`
- `depends_on`
- `fanout` / `forEach` / `reduce`

3) Preconditions (Guards)
- `assume`
- `if`

4) Provider Configuration (Only fields for the given type)
- ai: `prompt`, `ai.{model,provider,tools,…}`
- command: `exec`, `args`, `cwd`, `shell`
- script: `content` or `file`
- github: `op`, `values`
- http/http_client/http_input: `url`, `method`, `body`, `headers`
- log/memory/workflow/noop: minimal fields

5) Contracts (Post‑Exec)
- `schema` (renderer name or JSON Schema)
- `guarantee`

6) Failure Policies
- `fail_if`
- `continue_on_failure`

7) Routing & Transitions
- `on_success`
- `on_fail`
- `on_finish`

8) Runtime Controls
- `timeout`, `retries/backoff`, `env`
- `namespace`, `reuse_ai_session`, `session_mode`

9) Output Formatting
- `template: { content | file }`
- `message`, `level` (for `log`)

## Criticality & Contracts (Default Safety)

- `external`: side effects outside the repo/CI boundary (e.g., GitHub ops, webhooks).
  - Require a precondition: `assume` (preferred) or `if`.
  - If output‑producing, also require a post‑exec contract: `schema` or `guarantee`.
  - Logical failures (schema/guarantee/fail_if) are not auto‑retried.

- `internal`: orchestration/state within CI/repo (formerly “control‑plane”).
  - Same enforcement as `external` (precondition + contract for output steps).
  - No auto‑retry for logical failures.

- `policy`: evaluative checks (security/perf/quality/docs). Optional guards/contracts.

- `info`: purely informational; never gates dependents. Good for exploratory or advisory steps.

Notes
- Global `fail_if` is non‑gating by design; it marks the run status but must not block dependents.
- Check‑level `fail_if` is gating (treated as fatal for routing).

## Declarative Flow > Imperative Glue

- Prefer `transitions` under `on_success` / `on_fail` / `on_finish` over imperative `goto_js`.
- Keep transition expressions short, pure, and readable; use optional chaining and nullish coalescing for safety.

Example

```yaml
on_finish:
  transitions:
    - when: "any(outputs_history['validate-fact'], v => v?.is_valid === false) && event.name === 'issue_opened'"
      to: issue-assistant
    - when: "any(outputs_history['validate-fact'], v => v?.is_valid === false) && event.name === 'issue_comment'"
      to: comment-assistant
    - when: "all(outputs_history['validate-fact'], v => v?.is_valid === true)"
      to: null
```

## forEach (Fan‑Out) Patterns

- Use `forEach: true` on the parent that produces an array; children with `fanout: map` run per item; with `fanout: reduce` run once (aggregate).
- Empty arrays should skip dependents with a visible message and not increment stats.
- Aggregate parents should route (on_success/on_fail) before committing; dependents read per‑scope outputs.

Minimal Map + Aggregate

```yaml
extract-facts:
  type: ai
  on: [issue_opened]
  forEach: true
  prompt: |
    Return JSON array of facts: [{ id, claim, verifiable }]
  schema:
    type: array
    items:
      type: object
      required: [id, claim, verifiable]

validate-fact:
  type: ai
  on: [issue_opened]
  depends_on: [extract-facts]
  fanout: map
  prompt: "Validate: {{ outputs['extract-facts'].claim }}"

aggregate:
  type: script
  on: [issue_opened]
  depends_on: [validate-fact]
  content: |
    const all = (outputs.history['validate-fact']||[]).filter(Boolean);
    return { all_valid: all.every(v => v?.is_valid === true) };
  schema:
    type: object
    required: [all_valid]
```

## GitHub Ops (External)

- Normalize values at the provider; still use `assume` to guard empties.
- Keep idempotency: label adds/sets should tolerate duplicates and ordering.

Example

```yaml
apply-issue-labels:
  type: github
  criticality: external
  on: [issue_opened]
  depends_on: [issue-assistant]
  assume:
    - "(outputs['issue-assistant']?.labels?.length ?? 0) > 0"
  op: labels.add
  values:
    - "{{ outputs['issue-assistant'].labels | default: [] | json }}"
```

## Memory & Idempotency

- Use `namespace` to avoid collisions.
- Treat memory reads in `assume`/`if` as guards only; avoid side effects in expressions.
- For external calls, design retry‑safe operations (check‑before‑write, idempotency keys).

## YAML Style

- Prefer block arrays/lists over inline `[]` unless trivially short.
- Quote JS expressions in `assume`/`if` using double quotes.
- Use `|` for multiline `prompt`/`content`; avoid trailing whitespace.
- Keep keys in the recommended order across all steps.

## Do’s and Don’ts

Do
- Declare `criticality` and follow the guard/contract rules for `external`/`internal`.
- Keep expressions short and defensive: `outputs?.x?.length ?? 0`.
- Add `schema` whenever output shape matters (AI/script/command/http).

Don’t
- Hide control flow in templates or long `*_js` snippets.
- Mix unrelated responsibilities in a single step.
- Depend on outputs you didn’t guard (always use `assume`).

## Quick Checklist (Per Step)

- Identity: `type`, `criticality`, `group` set?
- When: `on` clear and minimal?
- Inputs: `depends_on` accurate? `assume` present for risky reads?
- How: provider config minimal and readable?
- Contracts: `schema` or `guarantee` (required for external/internal outputs)?
- Policies: `fail_if` only for step‑specific gating?
- Flow: transitions (`on_success`/`on_fail`/`on_finish`) instead of imperative glue?
- Controls: timeouts and env only when necessary?

## Complete Example (Well‑Structured External Labeling)

```yaml
apply-overview-labels:
  type: github
  criticality: external
  tags: [github]
  on: [pr_opened]
  depends_on: [overview]
  assume:
    - "outputs['overview']?.tags?.label"
    - "outputs['overview']?.tags?.['review-effort'] != null"
  op: labels.add
  values:
    - "{{ outputs.overview.tags.label | default: '' | safe_label }}"
    - "{{ outputs.overview.tags['review-effort'] | default: '' | prepend: 'review/effort:' | safe_label }}"
```

## References

- Fault Management & Contracts
- Criticality Modes
- Dependencies & Routing

