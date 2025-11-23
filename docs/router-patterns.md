# Router Steps, Transitions, and `depends_on`

This document describes recommended patterns for “router” checks (AI or script steps that classify intent and decide where to go next), and how they should interact with `depends_on`, `transitions`, and loops.

The goal is:

- predictable routing (no accidental loops),
- a clean mental model for control‑flow vs data dependencies,
- and good DX for authoring chat‑like and org‑automation workflows.

Examples referenced here:

- `examples/slack-simple-chat.yaml` (Slack org assistant: `ask` → `route-intent` → branches)
- `docs/recipes.md` (general routing patterns and chat examples)

---

## Concepts: control vs data edges

There are three main “edges” between checks:

- **Data dependency**: `depends_on`
  - Meaning: “B needs A’s output to compute.”
  - Engine impact: A is always scheduled before B in the DAG; forward‑run uses this to pull parents into new waves.

- **Control‑flow edge**: `on_success.transitions` / `on_fail.transitions` / `on_finish.transitions` and `goto`
  - Meaning: “when A finishes (and a condition holds), *schedule* B.”
  - Engine impact: emits `ForwardRunRequested` events; WavePlanning then plans a subgraph for the target and its dependencies.

- **Guards**: `if` and `assume`
  - `if`: soft gate. B is *skipped* when the condition is false.
  - `assume`: hard precondition. If B runs and the condition is false, that’s a contract violation.

Best DX comes from keeping these roles distinct:

- Use `depends_on` for real data prerequisites.
- Use `transitions` / `goto` for routing and loops.
- Use `if` / `assume` for gating semantics, not for wiring the graph.

---

## Anti‑pattern: router as both dependency and transition source

**Shape (simplified):**

```yaml
ask:
  type: human-input
  group: chat

route-intent:
  type: ai
  group: chat
  depends_on: [ask]
  on_success:
    transitions:
      - when: "output.intent === 'capabilities'"
        to: capabilities-answer

capabilities-answer:
  type: ai
  group: chat
  depends_on: [route-intent]
  if: "outputs['route-intent']?.intent === 'capabilities'"
  on_success:
    goto: ask
```

Here, the router (`route-intent`) is connected to the branch (`capabilities-answer`) **twice**:

- as a data dependency: `capabilities-answer.depends_on: [route-intent]`
- as a control‑flow source: `route-intent.on_success.transitions → capabilities-answer`

### Why this is a problem

When `route-intent` finishes, `transitions` fire and emit a `ForwardRunRequested(target='capabilities-answer')`.

WavePlanning then:

1. Builds the forward‑run subset starting from the target.
2. Adds **all transitive dependencies** of that target via `depends_on`.
   - `capabilities-answer.depends_on: [route-intent]`
   - `route-intent.depends_on: [ask]`
3. Schedules a wave that re‑runs `route-intent` (and `ask`), then `capabilities-answer`.

Each time `route-intent` re‑runs, its `transitions` fire again, enqueueing another forward‑run to `capabilities-answer`, which again pulls `route-intent` in as a dependency. This repeats until `routing.max_loops` is hit.

**Symptoms:**

- For a single “what can you do?” message, you may see multiple runs of:
  - `ask`
  - `route-intent`
  - and repeated routing logs, until the loop budget is exceeded.
- In tests with non‑zero `routing.max_loops`, strict `exactly` expectations on router calls fail (router runs 6+ times instead of once).

This is exactly the pattern we saw in the Slack org‑assistant flow when:

- `route-intent` used `on_success.transitions`, **and**
- branches like `capabilities-answer` had `depends_on: [route-intent]`, **and**
- leaf steps used `goto: ask` to close the loop.

---

## Recommended pattern: router as pure control‑plane

### Core idea

Treat router checks as **control‑plane only**:

- Router:
  - `depends_on` its true *inputs* (e.g. `ask`, context fetch steps).
  - Uses `on_success.transitions` to select branches.
- Branches:
  - **Do not** `depends_on` the router.
  - Instead, they **read** the router’s output from `outputs['router']` and gate with `if` / `assume`.

This gives a clean, acyclic structure:

```yaml
ask:
  type: human-input
  group: chat

route-intent:
  type: ai
  group: chat
  depends_on: [ask]
  ai:
    disableTools: true
    allowedTools: []
  schema:
    type: object
    properties:
      intent:
        type: string
        enum: [chat, capabilities]
    required: [intent]
  on_success:
    transitions:
      - when: "output.intent === 'capabilities'"
        to: capabilities-answer
      - when: "output.intent === 'chat'"
        to: chat-answer

capabilities-answer:
  type: ai
  group: chat
  # no depends_on: [route-intent]
  if: "outputs['route-intent']?.intent === 'capabilities'"
  ai:
    disableTools: true
    allowedTools: []
  prompt: |
    Explain briefly what you can help with.
  on_success:
    goto: ask

chat-answer:
  type: ai
  group: chat
  # no depends_on: [route-intent]
  if: "outputs['route-intent']?.intent === 'chat'"
  prompt: |
    You are a concise, friendly assistant.
    Latest user message: {{ outputs['ask'].text }}
  on_success:
    goto: ask
```

**Engine behavior:**

- Initial wave:
  - DAG: `ask` → `route-intent`
  - Router runs once, then emits transitions.
- Forward‑run for `capabilities-answer`:
  - Only includes the branch and any *real* dependencies the branch declares (e.g. context fetch, project status).
  - Does **not** pull `route-intent` back in, because the branch no longer `depends_on` it.
- Loops:
  - `capabilities-answer` closing to `ask` via `goto: ask` is explicit and controlled.
  - Router still runs once per loop cycle (when `ask` completes), but is not re‑run just because the branch was targeted by a transition.

This pattern avoids the “router as both dependency and transition source” cycle that caused loops in Slack.

---

## When to use `depends_on` vs `transitions` vs `if` / `assume`

### Use `depends_on` for real data prerequisites

Examples:

```yaml
project-status-fetch:
  type: script
  criticality: external
  depends_on: [project-intent]

project-status-answer:
  type: ai
  depends_on: [project-status-fetch]
  assume:
    - "!!outputs['project-status-fetch']?.project"
```

- `project-status-answer` truly needs `project-status-fetch`’s output to behave; this is a data edge.
- `assume` documents and enforces a precondition on that data.

### Use `transitions` / `goto` for control‑flow

Examples:

```yaml
route-intent:
  type: ai
  on_success:
    transitions:
      - when: "output.intent === 'status'"
        to: project-status-answer
      - when: "output.intent === 'deployment'"
        to: project-deploy-confirm

project-deploy-answer:
  type: ai
  on_success:
    transitions:
      - when: "output.done === true"
        to: ask
      - when: "output.done === false"
        to: project-deploy-confirm
```

- Router edges are expressed only via `transitions`.
- Inner “deployment helper” loop is controlled by transitions on `done`.

### Use `if` and `assume` for semantics, not wiring

Examples:

```yaml
capabilities-answer:
  # Soft gate: skip unless router chose 'capabilities'
  if: "outputs['route-intent']?.intent === 'capabilities'"

project-status-answer:
  # Hard precondition: fetch must have produced a project
  assume:
    - "!!outputs['project-status-fetch']?.project"
```

Guidelines:

- Use `if` to conditionally *skip* a step when a control field doesn’t match.
- Use `assume` to assert invariants when the step *does* run.
- Do **not** rely on `assume` to implement routing; that’s what `transitions` and `if` are for.

---

## Migration: from router‑as‑dependency to router‑as‑control‑plane

If you have existing workflows where:

- router checks use `on_success.transitions`, and
- branches also `depends_on` the router, and
- leaf steps loop back via `goto: <entry-step>`,

then you’re in the “double‑edge” pattern and may hit the same kind of loops we saw in Slack.

### Migration steps

1. **Identify router checks**  
   - Look for AI/script steps that:
     - read from a single human‑input or transport context, and
     - fan‑out into multiple branches via `transitions`.

2. **Remove router from branch `depends_on`**  
   - For each branch:
     - Remove `depends_on: [router]`.
     - Keep other dependencies (e.g. context fetch, sub‑routers).

3. **Add `if` / `assume` guards on branches**
   - Replace router‑dependency semantics with guards:

   ```yaml
   chat-answer:
     # was: depends_on: [route-intent]
     if: "outputs['route-intent']?.intent === 'chat'"
   ```

4. **Keep explicit loops**
   - Leave `goto: ask` and inner loops (`project-deploy-confirm` ↔ `project-deploy-answer`) as they are.
   - The loop behavior remains explicit and is no longer entangled with router dependencies.

5. **Increase `routing.max_loops` and add strict call expectations**
   - In YAML tests, set a reasonable `routing.max_loops` (e.g. 5–10).
   - Assert `exactly` call counts for:
     - router(s),
     - branches,
     - entry steps.
   - This surfaces unintentional loops as test failures instead of silently relying on the loop budget.

---

## Backward compatibility considerations

The recommendations above are **config‑level**; you can adopt them without changing engine semantics.

However, future engine changes to reinforce this model could be backward‑incompatible for configs that rely on the old pattern. For example:

- If we introduce special handling to **avoid re‑running routers** during forward‑runs when the target already depends on them via `transitions`, then:
  - Workflows that implicitly relied on “router re‑runs as dependents” would see different call counts.
  - Some side‑effects triggered on every router run might fire fewer times.

To keep migration safe:

- Prefer the “router as control‑plane only” pattern for new workflows.
- Gradually refactor existing ones (Slack, GitHub, HTTP automations) to:
  - remove `depends_on` edges from router → branch,
  - keep `transitions` as the single source of truth for routing,
  - use `if` / `assume` on branches for intent gating.

Once most configs follow this pattern, engine‑level improvements (e.g. smarter forward‑run for routers) can be introduced with minimal behavioral change for users.

---

## Summary

- **Do**:
  - Use routers (`route-intent`, `project-intent`, …) as control‑plane steps:
    - `depends_on` only real inputs,
    - route with `transitions`.
  - Keep branches free of router `depends_on`; gate them with `if` / `assume`.
  - Use `depends_on` only for real data dependencies.
  - Use `goto`/`transitions` for loops and control‑flow.

- **Avoid**:
  - Wiring the same edge both via `depends_on` and `transitions`.
  - Using `assume` as a routing mechanism.

Following this pattern produces clearer configs, avoids accidental router loops, and matches how the state‑machine’s forward‑run planner is intended to be used.***
