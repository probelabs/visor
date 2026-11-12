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

### Why this can be a problem

When `route-intent` finishes, `transitions` fire and emit a `ForwardRunRequested(target='capabilities-answer')`.

WavePlanning then:

1. Builds the forward‑run subset starting from the target.
2. Adds transitive dependencies of that target via `depends_on`.
   - `capabilities-answer.depends_on: [route-intent]`
   - `route-intent.depends_on: [ask]`
3. **However**, the engine now skips re‑running dependencies that have already succeeded in the current run.

**Note**: The engine's forward‑run planner was updated to deduplicate successful runs. Dependencies that have `successfulRuns > 0` are not re‑scheduled. This means the "double‑edge" pattern no longer causes runaway loops in most cases.

**When it still matters**:

- **Explicit loops via `goto`**: When a leaf step uses `goto: ask`, that *is* an intentional re‑run. The router will execute again on each loop iteration, which is expected behavior controlled by `routing.max_loops`.
- **Failed dependencies**: If a dependency failed (not succeeded), it will be re‑run. This can cause unexpected behavior if the failure was intentional.
- **Clarity**: Even though the engine handles deduplication, having both `depends_on` and `transitions` edges to the same step creates conceptual ambiguity about intent.

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

## Recommended patterns

### Pattern A: Router as pure control‑plane (no branch dependencies)

Treat router checks as **control‑plane only**:

- Router:
  - `depends_on` its true *inputs* (e.g. `ask`, context fetch steps).
  - Uses `on_success.transitions` to select branches.
- Branches:
  - **Do not** `depends_on` the router.
  - Instead, they **read** the router's output from `outputs['router']` and gate with `if` / `assume`.

This pattern avoids any ambiguity about the relationship between router and branches.

### Pattern B: Router with branch dependencies (common pattern)

In practice, many workflows use `depends_on` on branches to ensure ordering and data access:

- Router:
  - `depends_on` its true *inputs* (e.g. `ask`, context fetch steps).
  - Uses `on_success.transitions` to select branches.
- Branches:
  - **Do** `depends_on: [router]` for explicit ordering.
  - Also use `if` guards to skip when not selected.

This pattern is safe because the engine's forward‑run planner skips re‑running dependencies that already succeeded. See `examples/slack-simple-chat.yaml` for a working implementation.

### Choosing between patterns

- **Pattern A** is cleaner when branches don't actually need router output (pure control‑flow).
- **Pattern B** is more explicit and is the common pattern in real workflows where branches need access to router fields like `output.intent` or `output.project`.

#### Example: Pattern A (no branch dependencies)

```yaml
ask:
  type: human-input
  group: chat

route-intent:
  type: ai
  group: chat
  depends_on: [ask]
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

#### Example: Pattern B (with branch dependencies)

This is the pattern used in `examples/slack-simple-chat.yaml`:

```yaml
ask:
  type: human-input
  group: chat

route-intent:
  type: ai
  group: chat
  depends_on: [ask]
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
  depends_on: [route-intent]  # explicit dependency
  if: "outputs['route-intent']?.intent === 'capabilities'"
  prompt: |
    Explain briefly what you can help with.
  on_success:
    goto: ask

chat-answer:
  type: ai
  group: chat
  depends_on: [route-intent]  # explicit dependency
  if: "outputs['route-intent']?.intent === 'chat'"
  prompt: |
    You are a concise, friendly assistant.
    Latest user message: {{ outputs['ask'].text }}
  on_success:
    goto: ask
```

**Engine behavior (both patterns):**

- Initial wave:
  - DAG: `ask` → `route-intent`
  - Router runs once, then emits transitions.
- Forward‑run for `capabilities-answer`:
  - In Pattern A: Only the branch runs (no dependencies to pull in).
  - In Pattern B: The branch depends on `route-intent`, but since it already succeeded, it is **not** re‑run.
- Loops:
  - `capabilities-answer` closing to `ask` via `goto: ask` is explicit and controlled.
  - Router runs once per loop cycle (when `ask` completes and flows to `route-intent`).
  - Loop count is controlled by `routing.max_loops`.

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

There are three routing hooks: `on_success`, `on_fail`, and `on_finish`.

**`on_success`** — Fires when the check completes without fatal issues:

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

**`on_fail`** — Fires when the check fails (fatal issues or `fail_if` triggered):

```yaml
validate-input:
  type: ai
  fail_if: "output.valid === false"
  on_fail:
    goto: ask  # Loop back for retry
    # or use transitions:
    # transitions:
    #   - when: "output.error === 'auth'"
    #     to: auth-handler
```

**`on_finish`** — Fires regardless of success/failure:

```yaml
cleanup-step:
  type: command
  on_finish:
    run: log-completion  # Always run logging
```

**`goto` vs `run`**:

- `goto`: Preempts remaining work and jumps to the target. Used for loops and error recovery.
- `run`: Schedules the target after current wave completes. Used for side-effects like logging.

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

## Migration and testing best practices

### When to migrate

If you have existing workflows with unexpected loop counts or router re‑runs, consider these options:

1. **Keep Pattern B** (branches depend on router) — This is safe with the current engine. Just ensure you have:
   - `if` guards on branches
   - `routing.max_loops` set appropriately
   - Test assertions for expected call counts

2. **Migrate to Pattern A** (branches don't depend on router) — This is cleaner if branches don't actually need router output.

### Migration steps (if needed)

1. **Identify router checks**
   - Look for AI/script steps that:
     - read from a single human‑input or transport context, and
     - fan‑out into multiple branches via `transitions`.

2. **Remove router from branch `depends_on`** (optional)
   - For each branch:
     - Remove `depends_on: [router]` if you don't need explicit ordering.
     - Keep other dependencies (e.g. context fetch, sub‑routers).

3. **Ensure `if` guards on branches**
   - All branches should have guards regardless of pattern:

   ```yaml
   chat-answer:
     if: "outputs['route-intent']?.intent === 'chat'"
   ```

4. **Keep explicit loops**
   - Leave `goto: ask` and inner loops (`project-deploy-confirm` ↔ `project-deploy-answer`) as they are.
   - The loop behavior is explicit and controlled by `routing.max_loops`.

5. **Add strict call expectations in tests**
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
  - Use `if` guards on branches to skip when not selected by the router.
  - Use `depends_on` for real data dependencies (including router → branch when you need the router's output).
  - Use `goto`/`transitions` for loops and control‑flow.
  - Set `routing.max_loops` and add strict call count expectations in tests.

- **Acceptable**:
  - Having `depends_on: [router]` on branches when you need explicit ordering or access to router output — the engine deduplicates successful runs.

- **Avoid**:
  - Relying on implicit re‑runs of routers (use explicit `goto` for loops).
  - Using `assume` as a routing mechanism (use `if` or `transitions` instead).

Following these patterns produces clearer configs, leverages the engine's forward‑run deduplication, and makes loop behavior explicit and testable.

---

## Related documentation

- [Recipes](./recipes.md) — General routing patterns and chat examples
- [Fault Management and Contracts](./guides/fault-management-and-contracts.md) — `assume`, `guarantee`, and criticality
- [Criticality Modes](./guides/criticality-modes.md) — When to use `internal`, `external`, `policy`, `info`
- [Loop Routing Refactor](./loop-routing-refactor.md) — Technical details on forward-run deduplication
- [Human Input Provider](./human-input-provider.md) — Chat loops and `human-input` type
- [Debugging Guide](./debugging.md) — Tracing routing decisions with OpenTelemetry
