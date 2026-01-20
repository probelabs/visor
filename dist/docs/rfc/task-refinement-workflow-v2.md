# RFC: Task Refinement Workflow v2 (3‑Amigos + Git Context)

## Status
**Draft** – for discussion and iteration

### Decision Record (proposed)
- **Date**: 2025-11-23
- **Decision**: Introduce a new, opinionated task-refinement workflow that:
  - Encodes a Tyk‑specific refinement framework (3‑amigos: Product, QA, Engineering).
  - Uses structured schemas end‑to‑end (no “plain” AI outputs).
  - Can run against real tickets (Jira/Zendesk) and code (via `git-checkout`).
- **Rationale**: Our current task-refinement flow is powerful but generic and code‑centric. We want a refinement system that:
  - Reflects how Tyk actually refines work (3‑amigos, APIM domain, non‑functionals).
  - Improves ticket quality at source (Jira/Zendesk) instead of only helping engineers locally.
  - Is reusable as a building block for Slack/GitHub transports and future “refinement personas”.

## Summary

This RFC proposes **Task Refinement Workflow v2** – a new default workflow that combines:

- The existing **CLI task‑refinement loop** (`defaults/task-refinement.yaml`).
- The **Slack 3‑amigos / routing patterns** developed in the Slack v2 frontend work.
- The new **`git-checkout` provider** for safe, contextual code inspection.

The goal is a **transport‑agnostic refinement pipeline** that:

1. Accepts a “raw ticket” (from Jira/Zendesk/Slack/GitHub/CLI).
2. Applies a **Tyk‑specific refinement framework** (sections like Context, Replication, Non‑functionals, Acceptance Criteria).
3. Uses **three AI personas** (Product, QA, Engineer) as internal steps, not separate bots.
4. Optionally checks out code (using `git-checkout`) when the refinement needs real repo context.
5. Produces a **structured refinement artifact** that can:
   - Update Jira/Zendesk templates.
   - Power Slack/GitHub replies.
   - Feed downstream workflows (e.g. implementation, test‑planning).

The workflow will live under `defaults/task-refinement-v2.yaml` initially, with a path to eventually replace the current `task-refinement.yaml` once proven.

## Motivation

### Current Pain Points

- **Ticket quality is inconsistent** – real‑world Jira/Zendesk tickets often lack:
  - Clear problem statement vs. symptoms.
  - Reproduction details and environments.
  - Explicit non‑functional expectations (performance, security, scalability, MDCB, etc.).
  - Concrete acceptance criteria.
- **Refinement is late and expensive** – much of the real refinement happens during implementation:
  - Engineers infer requirements while coding.
  - Test design and non‑functional thinking are delayed until after the “fix”.
- **Existing task‑refinement flow is repo‑centric**:
  - It is great for “developer sitting at CLI, refining their own task”.
  - It doesn’t encode a Tyk‑specific refinement framework or 3‑amigos roles.
  - It doesn’t interact with actual ticket systems today.

### Desired Outcomes

- **Drive up ticket quality at source**:
  - Guided refinement against a shared framework, regardless of ticket originator.
  - Make “good tickets” the default, not the exception.
- **Make quality everyone’s concern**:
  - Ticket cannot be “ready for product/engineering” until a refinement baseline is met.
  - Provide feedback to originators (“ticket incomplete, please add X/Y/Z”).
- **Reuse the same refinement engine everywhere**:
  - Jira/Zendesk templates.
  - Slack agent (“3‑amigos assistant”).
  - GitHub PR / issue helpers.
  - CLI refinement.

## Goals and Non‑Goals

### Goals

- Define a **concrete refinement framework** aligned with Tyk’s APIM domain:
  - Context & replication.
  - Non‑functional and MDCB concerns.
  - Delivery & test strategy.
  - Acceptance criteria language.
- Design a **workflow** that:
  - Is transport‑agnostic (no Slack‑only quirks baked into the core).
  - Uses **schemas** for all AI outputs (no `schema: plain`).
  - Uses **criticality / assume / guarantee** consistently.
  - Can plug in `git-checkout` for code‑aware refinement.
- Enable **multiple personas** (Product, QA, Engineer) as internal steps:
  - Shared context, consistent structure.
  - Output that can be surfaced in different UIs.
- Provide a **clear integration surface**:
  - How Jira/Zendesk templates map to refinement sections.
  - How Slack/GitHub transports pass ticket/thread context in.

### Non‑Goals (for v2)

- Implement full Jira/Zendesk API integration in this RFC.
  - We will design the interface and placeholders (e.g. `ticket_input` / `ticket_output` steps).
  - Concrete provider implementations can come later.
- Replace the existing `defaults/task-refinement.yaml` immediately.
  - v2 ships alongside v1 initially.
- Solve all multi‑agent orchestration problems.
  - We focus on a linear pipeline with persona‑flavoured AI steps, not a generic multi‑agent framework.

## Refinement Framework (Tyk‑Flavoured)

We base v2 on the proposed Tyk refinement framework, adapted into structured sections. This is what the workflow will **produce** as its main artifact.

At a high level:

1. **Understanding & Replication**
2. **Refine & Fix**
3. **Acceptance & Testability**

### 1. Understanding & Replication

Captured as a structured object, not free prose:

- **Context**
  - Real problem vs. surface symptoms.
  - Customer / ICP and what they are trying to achieve.
  - Impact of not fixing (customer, security, revenue).
  - Existing workarounds/plugins.
- **End‑to‑End Understanding**
  - Where in the stack this touches (Gateway, Dashboard, data plane, docs, SDKs, etc.).
  - Upstream/downstream dependencies.
  - Relevant industry standards / best practices.
- **Replication**
  - Environment (staging/prod, OS, browser, gateway/portal versions, topology).
  - Preconditions (feature flags, config state, data, auth).
  - Steps to reproduce (ordered, numbered).
  - Expected vs. actual results at each step.
- **Evidence**
  - Configs, APIs, logs, traces, profiles, metrics, screenshots.
- **Rollback / Regression**
  - Is this a regression?
  - What happened on rollback or in prior versions/environments?

### 2. Refine & Fix

Here we capture “what should happen”, non‑functionals, and delivery shape:

- **Expected Behaviour**
  - Clear description of correct behaviour for the relevant area.
- **Non‑Functionals**
  - Security, performance, scalability, maintainability, observability.
  - Connectivity across the Tyk stack.
  - Dependencies across Tyk components (MDCB, Sync, Operator, Pump, etc.).
- **Navigating Delivery**
  - Can this be broken down into smaller tickets?
  - Rollout/compatibility/versioning plan.
  - Documentation impact (customer‑facing and internal).
  - Governance / regulatory / API standards considerations.
- **Test Cases**
  - Happy path.
  - Negative / error paths.
  - Non‑functional tests.
  - Regression / contract / performance / security tests.
- **How We Will Fix It**
  - Proposed approach (plain language first).
  - Changes required (code, configuration, infrastructure).
  - Alternatives considered, with rationale.
  - Impact scope (modules, APIs, user journeys).

### 3. Acceptance & Language

We want **short, declarative, domain‑specific** acceptance criteria that cover:

- Functional (happy + negative paths).
- Non‑functional expectations (perf, security, observability, scalability, MDCB impact).
- Connectivity and dependency implications.

The workflow should:

- Produce acceptance criteria in a **structured list** grouped by category.
- Encourage the “I can … / If X then Y … / Only authenticated … / Within N seconds …” style.
- Remain close to how Tyk engineers talk about tickets today.

## High‑Level Workflow Design

### Overview

The v2 workflow is conceptually:

1. **Ingest** ticket context.
2. **Collect/clarify** missing inputs from the originator (loop).
3. Run **3‑amigos personas** over the ticket + context.
4. **Synthesize** a single refinement artifact matching the framework.
5. **Validate completeness** (QA‑style gate).
6. Optionally **plan validation commands** and **git checkout** where relevant.
7. **Emit** refined ticket (for Jira/Zendesk/Slack/GitHub/CLI).

### Proposed Step Skeleton (YAML‑level)

Naming is illustrative; final names may change.

```yaml
version: "1.0"

steps:
  ticket-input:        # type: http_input / human-input / transport-specific glue
  normalize-ticket:    # type: ai – normalize into internal ticket model

  collect-missing:     # type: ai + human-input loop
                       # clarifying questions to fill gaps in Context/Replication/Evidence

  git-context:         # type: git-checkout (optional)
                       # uses ticket metadata (repo, branch, PR, commit) when available

  persona-pm:          # type: ai – product/business framing (problem, value, ICP, delivery risks)
  persona-qa:          # type: ai – tests, acceptance criteria, non-functionals
  persona-eng:         # type: ai – stack, dependencies, implementation + tech risks

  synthesize-refinement:  # type: ai – merge personas into a single structured refinement document

  qa-completeness:     # type: ai – “completeness bot” that checks refinement against framework
                       # and either accepts or asks for focused follow-ups

  ticket-output:       # type: log / http / script – writes back into Jira/Zendesk/Slack/etc.
```

The **3‑amigos personas are internal**; the user interacts primarily with:

- `ticket-input` (initial description).
- `collect-missing` human prompts (clarifications).
- The final refinement view (via `ticket-output`).

## Code Context Resolution Flow

A key requirement for Tyk is that **refinement is code‑aware**: personas must know where in the stack the ticket lives, and be able to reason about concrete modules/APIs across multiple repos. To keep this reusable and contained, we split this into three layers:

1. **Project routing** – “which repos/refs are relevant?”
2. **Code checkout + light analysis** – “where is the code and what’s roughly inside?”
3. **Persona consumption** – “how does PM/QA/Eng use this without re‑implementing checkout?”

### 1. Project Routing (`code_plan`)

We introduce a routing step (or small sub‑workflow) that outputs a **code plan** from the ticket:

```yaml
code_plan:
  projects:
    - id: "gateway"
      role: "primary"
      repo: "TykTechnologies/tyk"
      ref: "main"           # or PR head / release branch
      paths: ["gateway/"]   # optional focus for sparse checkout
    - id: "dashboard"
      role: "supporting"
      repo: "TykTechnologies/tyk-analytics"
      ref: "main"
  confidence: "high" | "medium" | "low"
  questions: []             # questions to ask if routing is ambiguous
```

Implementation idea:

- `route-projects`:
  - Type: `ai`, `criticality: internal`.
  - Inputs:
    - `ticket.labels`, `ticket.text.title/description`.
    - Static mapping of **Tyk components → repos/paths** (e.g. from a small YAML config).
  - Schema returns `code_plan` as above.
  - If `confidence` is low, it may add focused questions to be surfaced via `collect-missing`.

This routing step is reusable across workflows that need “which repos matter?” without hard‑coding it into personas.

### 2. Code Context Workflow (`code_context`)

We then define a **reusable workflow** (e.g. `code-context.yaml`) that:

- Accepts `code_plan` as input.
- Performs `git-checkout` for each referenced project.
- Optionally runs light analysis to build a **summary** the personas can consume.

Shape of the output:

```yaml
code_context:
  projects:
    - id: "gateway"
      role: "primary"
      repo: "TykTechnologies/tyk"
      ref: "main"
      path: "/abs/path/to/worktree"
      summary:
        main_components: ["gateway/http", "gateway/middleware"]
        key_files: ["gateway/config.go", "gateway/router.go"]
        notes: "HTTP handlers live under gateway/http/..."
    - id: "dashboard"
      role: "supporting"
      repo: "TykTechnologies/tyk-analytics"
      ref: "main"
      path: "/abs/path/to/dashboard"
      summary:
        main_components: ["ui/", "api/"]
        key_files: []
        notes: ""
```

Inside `code-context`:

- For each `code_plan.projects[*]`:
  - `checkout-<id>`:
    ```yaml
    type: git-checkout
    criticality: internal
    assume:
      - "project.repo != null"
      - "project.ref != null"
    repository: "{{ project.repo }}"
    ref: "{{ project.ref }}"
    sparse_checkout: "{{ project.paths | default: [] }}"
    guarantee:
      - "output.success === true"
      - "output.path != null"
    ```
  - Optional `scan-structure`:
    - Type: `command` or `mcp`, `criticality: internal`.
    - Restricted to `output.path`.
    - Produces a concise list of main packages/dirs/important files.
- The workflow collates those into a single `code_context` output.

This keeps **git interactions and lightweight repo understanding** in one place and makes them reusable by any persona‑style workflow.

### 3. How Personas Use `code_context`

Personas do **not** perform their own git checkouts. Instead:

- `persona-eng` receives `ticket`, partial `refinement`, `code_plan`, and `code_context`:
  - Uses `code_context.projects[*].summary` to:
    - Populate `stack_areas` with concrete components (Gateway/Dashboard/MDCB/etc.).
    - Populate `dependencies` with real services/modules.
    - Align `implementation_approach` and `impact_scope` with actual code locations.
  - Prompt can allow *read‑only* tools (e.g. `searchFiles`, `listFiles`) scoped to `code_context.projects[*].path` where appropriate.
- `persona-qa` uses `code_context` to:
  - Anchor test ideas to concrete modules / endpoints.
  - Suggest where tests should live (e.g. “add regression test under `gateway/tests/...`”).
- `persona-pm` mostly uses ticket text, but can:
  - Refer to components by name/role (“Gateway + MDCB”) based on `code_plan`.

At synthesis time (`synthesize-refinement`), we combine:

- `ticket`
- Persona outputs
- `code_plan`
- `code_context`

Into the final `refinement` object, enriching:

- `stack_areas` and `dependencies`.
- Non‑functional sections (e.g. MDCB impact).
- Delivery breakdown (e.g. separate tickets for gateway vs. dashboard work).

### 4. Reusable “Code Question” Flow

We also want a **reusable sub‑flow** that can answer detailed questions about the codebase, using the same `code_plan` / `code_context` machinery, and delegating to per‑project analysis where helpful.

Conceptually, this is a child workflow (e.g. `code-question-helper.yaml`) with this contract:

```yaml
inputs:
  question: string          # “Explain how rate limiting works for X”
  ticket:   object|null     # optional ticket for extra context
  code_plan: object|null    # optional; if not provided, the flow will compute it

outputs:
  answer:
    text: string            # human-facing answer
    per_project:            # optional deeper breakdown
      - project_id: string
        summary: string
        details: string
```

Internal steps:

```yaml
steps:
  ensure-code-plan:
    type: ai
    # If caller did not provide code_plan, call route-projects

  code-context:
    type: workflow          # calls the reusable code-context workflow
    depends_on: [ensure-code-plan]

  plan-code-query:
    type: ai
    depends_on: [code-context]
    # Produces a plan: which projects to query, what to ask each, and how deep to go

  per-project-delegates:
    # One or more delegated tool calls (e.g. claude-code/mcp) per selected project

  synthesize-code-answer:
    type: ai
    depends_on: [plan-code-query, per-project-delegates]
```

The key step here is `plan-code-query`, which should:

- Receive:
  - The **user’s question**.
  - `code_context.projects[*]` including `id`, `repo`, `ref`, `path`, and `summary`.
  - Optional `ticket` (for extra context).
- Emit:

```yaml
schema:
  type: object
  additionalProperties: false
  properties:
    projects:
      type: array
      items:
        type: object
        additionalProperties: false
        properties:
          project_id: { type: string }   # matches code_context.projects[*].id
          role: { type: string }         # "primary" | "secondary"
          question: { type: string }     # focused question for this project
        required: [project_id, question]
    notes: { type: string }
  required: [projects]
```

Its **system prompt** should:

- Explicitly instruct the model to:
  - Use **delegated tools per project** (e.g. `delegate` / `claude-code` / `mcp`) where available, instead of trying to reason about all code inline.
  - Use the `path` and `paths` hints from `code_context` to keep queries focused.
  - Only include projects that are likely relevant to the question.
- Provide each project’s:
  - `id`, `repo`, `ref`.
  - `path` (checkout root).
  - `summary.main_components` / `summary.key_files` as contextual hints.

The next step (`per-project-delegates`) would then:

- Iterate over `plan-code-query.output.projects[*]` and, for each:
  - Call a code‑aware tool (e.g. `claude-code` provider or an MCP tool) with:
    - `cwd` / `path` set to the matching `code_context` path.
    - The per‑project `question` from the plan.
- Collect their responses into a structured `per_project` array for `synthesize-code-answer`.

`synthesize-code-answer` then:

- Produces the final `answer.text` plus the optional per‑project breakdown.
- Can be reused by:
  - Personas (e.g. `persona-eng` calling this helper for deeper dives).
  - Other workflows (Slack commands like “explain this bug in terms of code”, GitHub PR questions, etc.).

## Initial Multi‑Project Flow (Phase 1 Slice)

Given the Tyk reality (multiple core repos from day one), the **first implemented flow** should already support multiple projects per ticket. We still keep the slice narrow enough to be testable.

### Step Graph (Phase 1)

For the initial `defaults/task-refinement-v2.yaml`, we propose:

```yaml
steps:
  ticket-input:
    # manual / CLI for now (later: Slack/Jira/Zendesk wrappers)

  normalize-ticket:
    # ai; produces canonical `ticket`

  collect-missing:
    # ai + human-input loop (simple, one clarifying turn in tests)

  route-projects:
    # ai; outputs multi-project `code_plan`

  code-context:
    # workflow; uses git-checkout to build `code_context` for all projects in code_plan

  persona-pm:
    # ai; uses ticket + refinement + code_plan + code_context

  persona-qa:
  persona-eng:

  synthesize-refinement:
    # ai; merges personas into final `refinement` object

  qa-completeness:
    # ai; checks refinement against framework; may loop back to collect-missing (Phase 1 tests: single pass)

  ticket-output:
    # log; emits final refinement JSON (for CLI) or passes to transport wrapper
```

Key constraints for Phase 1:

- **Multi‑project from the start**:
  - `route-projects` must be able to return 1..N projects.
  - `code-context` must handle N>1 by running multiple `git-checkout`s and summarising each.
- **Single interactive pass in tests**:
  - Tests will exercise one‑turn `collect-missing` (no long chat chains yet).
- **Personas tool‑light**:
  - Personas consume `code_plan`/`code_context` as data.
  - Deep per‑project analysis via `code-question-helper` can be wired later; not required for the first YAML.

This gives us a coherent, multi‑project refinement pipeline without overloading the first implementation with every possible loop.

## Testing Plan for Initial Flow

We’ll drive the design with YAML tests in the style of `defaults/task-refinement.yaml` and Slack tests. Below is an outline of the **first test cases** we expect for `task-refinement-v2.yaml`.

### Test Defaults

```yaml
tests:
  defaults:
    strict: true
    ai_provider: mock
```

Mocks will feed deterministic outputs for AI steps and the `git-checkout` provider (via `run-commands`‑style stdout or dedicated mock wiring).

### Case 1: Single‑Project Gateway Ticket

**Goal**: basic happy path where ticket clearly maps to the gateway repo only.

Sketch:

```yaml
  cases:
    - name: gateway-single-project
      event: manual
      fixture: local.minimal
      mocks:
        ticket-input:
          text: "Bug: rate limiting misbehaves on Tyk Gateway..."
        normalize-ticket:
          ticket:
            text:
              title: "Gateway rate limiting bug"
              description: "..."
            labels: ["component:gateway"]
        collect-missing:
          # no extra questions in this simple case
        route-projects:
          code_plan:
            projects:
              - id: "gateway"
                role: "primary"
                repo: "TykTechnologies/tyk"
                ref: "main"
                paths: ["gateway/"]
            confidence: "high"
        code-context:
          code_context:
            projects:
              - id: "gateway"
                role: "primary"
                repo: "TykTechnologies/tyk"
                ref: "main"
                path: "/tmp/visor/gateway"
                summary:
                  main_components: ["gateway/http"]
                  key_files: ["gateway/router.go"]
        persona-pm: {...}
        persona-qa: {...}
        persona-eng: {...}
        synthesize-refinement:
          refinement:
            context: { problem_statement: "..." }
            acceptance_criteria: { functional: [ { kind: "happy", text: "..." } ] }
      expect:
        calls:
          - step: route-projects
            exactly: 1
          - step: code-context
            exactly: 1
          - step: persona-pm
            exactly: 1
          - step: persona-qa
            exactly: 1
          - step: persona-eng
            exactly: 1
          - step: synthesize-refinement
            exactly: 1
          - step: qa-completeness
            exactly: 1
        outputs:
          - step: route-projects
            path: code_plan.projects.length
            equals: 1
          - step: code-context
            path: code_context.projects[0].id
            equals: "gateway"
          - step: synthesize-refinement
            path: refinement.context.problem_statement
            matches: "(?i)rate limiting"
          - step: synthesize-refinement
            path: refinement.acceptance_criteria.functional.length
            at_least: 1
```

### Case 2: Multi‑Project Gateway + Dashboard Ticket

**Goal**: ticket clearly involves both gateway and dashboard (e.g. UI + underlying behaviour).

Expectations:

- `route-projects` returns two projects (`gateway`, `dashboard`).
- `code-context` has two entries.
- `persona-eng` or `synthesize-refinement` marks both in `stack_areas` and `dependencies`.

Sketch expectations:

```yaml
    - name: gateway-dashboard-multiple-projects
      event: manual
      fixture: local.minimal
      mocks:
        normalize-ticket:
          ticket:
            text:
              title: "Analytics UI shows wrong rate limit values"
            labels: ["component:gateway","component:dashboard"]
        route-projects:
          code_plan:
            projects:
              - { id: "gateway",   role: "primary",   repo: "TykTechnologies/tyk",          ref: "main", paths: ["gateway/"] }
              - { id: "dashboard", role: "supporting", repo: "TykTechnologies/tyk-analytics", ref: "main", paths: ["ui/","api/"] }
            confidence: "high"
        code-context:
          code_context:
            projects:
              - { id: "gateway",   path: "/tmp/visor/gateway",   summary: { main_components: ["gateway/http"] } }
              - { id: "dashboard", path: "/tmp/visor/dashboard", summary: { main_components: ["ui/","api/"] } }
        synthesize-refinement:
          refinement:
            context: { problem_statement: "..." }
            # stack_areas and dependencies merged from persona-eng
            # acceptance_criteria touches both UI and gateway behaviour
      expect:
        outputs:
          - step: route-projects
            path: code_plan.projects.length
            equals: 2
          - step: code-context
            path: code_context.projects.length
            equals: 2
          - step: synthesize-refinement
            path: refinement.non_functionals.connectivity.length
            at_least: 1
          - step: synthesize-refinement
            path: refinement.acceptance_criteria.functional.length
            at_least: 1
```

### Case 3: Process‑Only Ticket (No Code Projects)

**Goal**: ticket describes a pure process/policy change; router returns no projects, and `code-context` is skipped.

Expectations:

- `route-projects` returns `projects: []` with `confidence: high` or `medium`.
- `code-context` not called.
- Personas still produce a valid `refinement` object.

### Case 4: Code Question Helper on Multi‑Project Plan

**Goal**: verify `code-question-helper` uses `code_plan`/`code_context` and delegates per project.

Sketch expectations (for its own tests, separate from task‑refinement):

- Given a question referencing both gateway and dashboard:
  - `plan-code-query` includes both project IDs with focused sub‑questions.
  - `per-project-delegates` is called once per selected project.
  - `synthesize-code-answer` returns `answer.text` and a `per_project` array with two entries.

We can keep these as tests on the helper workflow itself rather than on `task-refinement-v2.yaml`, but they inform how we design the helper.

---

These initial tests give us concrete behavioural targets for the first implementation:

- Multi‑project routing and checkout.
- Correct wiring of personas and synthesis.
- Basic coverage of process‑only tickets and reusable code‑question flow.

## Internal Ticket Schema (Proposed)

To keep transports and ticket systems loosely coupled, we introduce a **normalized ticket model** that all inputs map into and all outputs build on.

At a high level:

```yaml
ticket:
  source:
    system: jira | zendesk | slack | github | cli
    key: ""                # e.g. JIRA-123, Zendesk ID, Slack thread_ts, GitHub URL
    url: ""                # deep link to the original artefact (optional)
  meta:
    reporter: ""           # human name or handle
    team: ""               # optional owning squad
    created_at: ""         # ISO timestamp if available
  text:
    title: ""              # short one-liner
    description: ""        # raw long description / body
  links:
    repositories:          # optional repo hints for git-checkout
      - repo: ""           # owner/name
        ref: ""            # branch/sha/pr head
        path_hint: ""      # optional subdir of interest
    related_issues: []     # other ticket IDs / URLs
  labels: []               # tags / components / products
```

The **refinement artefact** extends this with structured sections from the framework:

```yaml
refinement:
  context: { ... }          # problem, ICP, impact, workarounds
  replication: { ... }      # env, preconditions, steps, expected vs actual
  evidence: { ... }         # configs, logs, links to artefacts
  regression: { ... }       # rollback story, versions
  expected_behaviour: { ... }
  non_functionals: { ... }  # security/perf/scalability/observability/etc.
  delivery: { ... }         # breakdown, rollout, docs, governance
  tests: { ... }            # test taxonomy
  acceptance_criteria: { ... }
  open_questions: []        # for follow-up with reporter / 3 amigos
```

The workflow’s AI steps operate over this **`{ ticket, refinement }`** pair. Transports/providers only need to implement:

- **Ingestion**: map their native shape → `ticket`.
- **Projection**: map `refinement` back into their native fields (comments, custom fields, labels, etc.).

## Integration with Git Checkout

We want the refinement workflow to be able to reason about **real code** when appropriate, without coupling it tightly to GitHub.

### When to Use `git-checkout`

- Ticket references a PR, branch, or commit.
- Refinement persona(s) need to:
  - Inspect the current implementation.
  - Identify impacted modules/APIs.
  - Suggest meaningful tests.

### How `git-checkout` Fits In

```yaml
steps:
  git-context:
    type: git-checkout
    criticality: internal
    assume:
      - "ticket.repo != null"
      - "ticket.ref != null"
    ref: "{{ ticket.ref }}"
    repository: "{{ ticket.repo }}"
    guarantee:
      - "output.success === true"
      - "output.path != null"
```

Downstream AI steps (PM/QA/Eng personas, synthesis) can include references such as:

- “Implementation root: `{{ outputs['git-context'].path }}`”.
- Optional additional analysis commands (e.g. `ls`, `ripgrep`) via `command` or `mcp` providers, constrained by `criticality`.

We keep the **baseline workflow usable without git** by:

- Making `git-context` optional (guarded by `if` / `assume`).
- Ensuring personas don’t *require* code context to function.

## Example Flows

These examples are illustrative only; the final YAML will live in `defaults/task-refinement-v2.yaml` and potentially thin transport-specific wrappers.

### CLI / Local Developer Flow

Goal: refine a local task description (similar to v1), but using the new framework and personas.

```yaml
steps:
  ticket-input:
    type: human-input
    prompt: |
      Describe the task or problem you want to refine.
      Include any relevant context, links, and constraints.
    multiline: true
    allow_empty: false

  normalize-ticket:
    type: ai
    depends_on: [ticket-input]
    schema: { ... ticket schema ... }

  collect-missing:
    type: ai
    depends_on: [normalize-ticket]
    # ask clarifying questions about missing Context/Replication/Evidence
    # + human-input loop similar to existing task-refinement

  persona-pm:
    type: ai
    depends_on: [collect-missing]

  persona-qa:
    type: ai
    depends_on: [collect-missing]

  persona-eng:
    type: ai
    depends_on: [collect-missing]

  synthesize-refinement:
    type: ai
    depends_on: [persona-pm, persona-qa, persona-eng]

  qa-completeness:
    type: ai
    depends_on: [synthesize-refinement]
    fail_if: "output?.complete !== true"
    on_fail:
      goto: collect-missing

  ticket-output:
    type: log
    depends_on: [qa-completeness]
    message: |
      ✅ Refined ticket (CLI):
      {{ outputs['synthesize-refinement'] | to_json }}
```

### Slack Thread Flow (3‑Amigos Assistant)

Goal: user mentions the bot in a thread; the workflow refines the “ticket” anchored to that thread using the v2 engine.

Transport glue (Slack) would:

- Map thread messages into `ticket.text.description` and `ticket.meta.reporter`.
- Attach `slack.conversation` / `conversation` context similarly to GitHub’s `github_context`.

Workflow sketch:

```yaml
steps:
  ticket-input:
    type: workflow    # or transport-specific wrapper
    # pulls slack.conversation into ticket.{text,meta,links}

  normalize-ticket:   # as above
  collect-missing:    # persona + human-input via Slack
  persona-pm/qa/eng:  # re-used from CLI flow
  synthesize-refinement:
  qa-completeness:
  ticket-output:
    type: log         # plus slack frontend posts refined summary into the thread
```

Slack-specific concerns (when to pause/resume, how many messages to post, how to display acceptance criteria) stay in the **frontend**, not in the workflow itself.

### Jira Ticket Flow (Conceptual)

Goal: use v2 to validate and enrich Jira tickets based on the refinement framework.

```yaml
steps:
  ticket-input:
    type: http_input   # or a future jira-ticket provider
    # pulls Jira issue JSON

  normalize-ticket:
    type: ai
    depends_on: [ticket-input]
    # maps Jira fields → internal ticket schema

  collect-missing:
    # if run interactively, ask reporter for missing info
    # if batch mode, simply flag gaps in refinement

  persona-pm/qa/eng:
  synthesize-refinement:
  qa-completeness:

  ticket-output:
    type: script
    depends_on: [qa-completeness]
    # writes comments / updates fields in Jira based on refinement + completeness result
```

This lets us start by **running v2 against existing tickets** in a read‑only way, then incrementally add write‑back behaviour (labels like “incomplete”, suggested acceptance criteria, etc.).

## Transport and Ticket Systems

The core workflow is **transport‑agnostic**. Individual transports (Slack, GitHub, CLI, future Jira/Zendesk webhooks) will:

- Map their event payloads into a **normalized ticket input** shape (e.g. `ticket-input`).
- Decide how to present clarifying questions and refined output.

### Jira / Zendesk Templates (Conceptual)

We will treat Jira/Zendesk templates as **views over the same internal refinement structure**:

- Each template section maps to part of the refinement artifact:
  - “Context” ↔ Context section.
  - “Steps to Reproduce” ↔ Replication.
  - “Impact” ↔ Impact fields.
  - “Acceptance Criteria” ↔ grouped criteria list.
  - etc.
- The workflow can:
  - Validate that the incoming ticket covers required sections.
  - Suggest missing content or corrections (QA completeness persona).
  - Emit a fully populated version of the template fields in `ticket-output`.

Concrete provider design for Jira/Zendesk is out of scope here, but this RFC will define the **internal ticket schema** we target.

## AI Schemas, Criticality, Assume / Guarantee

We will follow the discipline used in the recent routing and Slack examples:

- **All AI steps use explicit JSON schemas** – no `schema: plain`, no “return Markdown”.
- **Criticality**:
  - `external` for steps that modify external systems or are user‑visible.
  - `internal` for helper steps (persona analyses, planners).
  - `best_effort`/`low` (where appropriate) for non‑blocking helpers.
- **Assume vs `if`**:
  - Use `assume` for **true preconditions** – if they don’t hold, the step *must* fail.
  - Use `if` for **routing/skipping** – branches that should simply not run if conditions are not met.
- **Guarantee** (where appropriate):
  - Express postconditions that should be true if the step is considered successful (e.g. non‑empty acceptance criteria).

We will encode these patterns explicitly in the v2 workflow so it serves as a **teaching example** (and will cross‑link from `docs/recipes.md` / routing docs).

## Persona Structure and Outputs

Each persona step should produce **machine‑readable structure**, not prose blobs. Below are **proposed JSON schemas** we can implement directly in `task-refinement-v2.yaml` (names may be tweaked during implementation).

### `persona-pm` (Product / Problem Framing)

```yaml
schema:
  type: object
  additionalProperties: false
  properties:
    summary: { type: string }                # single-paragraph “what is this about?”
    problem_statement: { type: string }      # problem, not solution
    icp: { type: string }                    # ideal customer profile / user segment
    user_goals:
      type: array
      items: { type: string }
    business_impact: { type: string }        # revenue / risk / strategic impact
    workarounds:
      type: array
      items: { type: string }
    delivery_risks:
      type: array
      items: { type: string }
    questions:
      type: array
      items: { type: string }                # questions PM wants answered before build
  required: [summary, problem_statement]
```

### `persona-qa` (QA / Test & Acceptance)

```yaml
schema:
  type: object
  additionalProperties: false
  properties:
    summary: { type: string }
    functional_criteria:
      description: "Happy + negative path acceptance criteria"
      type: array
      items:
        type: object
        additionalProperties: false
        properties:
          id: { type: string }
          kind: { type: string, enum: ["happy", "negative"] }
          text: { type: string }
        required: [kind, text]
    non_functional_criteria:
      description: "Perf / security / scalability / observability / MDCB etc."
      type: array
      items:
        type: object
        additionalProperties: false
        properties:
          category:
            type: string
            enum: ["performance","security","scalability","maintainability","observability","connectivity","dependency","mdcb","other"]
          text: { type: string }
        required: [category, text]
    test_matrix:
      description: "Concrete test ideas grouped by type"
      type: object
      additionalProperties: false
      properties:
        unit:        { type: array, items: { type: string } }
        integration: { type: array, items: { type: string } }
        e2e:         { type: array, items: { type: string } }
        regression:  { type: array, items: { type: string } }
        performance: { type: array, items: { type: string } }
        security:    { type: array, items: { type: string } }
        manual:      { type: array, items: { type: string } }
    questions:
      type: array
      items: { type: string }                # QA-specific open questions / clarifications
  required: [summary]
```

### `persona-eng` (Engineering / Implementation & Dependencies)

```yaml
schema:
  type: object
  additionalProperties: false
  properties:
    summary: { type: string }                # short eng summary in plain language
    stack_areas:
      description: "Where in the stack this touches"
      type: array
      items:
        type: object
        additionalProperties: false
        properties:
          area: { type: string }             # e.g. "Gateway", "Dashboard", "MDCB", "Pump"
          rationale: { type: string }
        required: [area]
    dependencies:
      description: "Upstream/downstream dependencies inside/outside Tyk"
      type: array
      items:
        type: object
        additionalProperties: false
        properties:
          name: { type: string }             # service/module/package
          kind: { type: string }             # e.g. "upstream","downstream","external"
          rationale: { type: string }
        required: [name]
    non_functional_concerns:
      type: array
      items: { type: string }                # engineering view of perf/scale/security risks
    implementation_approach: { type: string } # plain-language proposal
    impact_scope:
      description: "Areas of system touched"
      type: array
      items: { type: string }
    risks:
      type: array
      items: { type: string }
    tech_debt:
      type: array
      items: { type: string }                # new or existing debt to note
    questions:
      type: array
      items: { type: string }
  required: [summary]
```

### Final Refinement Schema (Synthesis Output)

`synthesize-refinement` consumes the three persona outputs and produces a **single refinement artefact** aligned with the framework. Proposed schema:

```yaml
schema:
  type: object
  additionalProperties: false
  properties:
    framework_version: { type: string }
    context:
      type: object
      additionalProperties: false
      properties:
        problem_statement: { type: string }
        icp: { type: string }
        user_goals: { type: array, items: { type: string } }
        impact: { type: string }
        workarounds: { type: array, items: { type: string } }
      required: [problem_statement]
    replication:
      type: object
      additionalProperties: false
      properties:
        environment: { type: string }
        preconditions: { type: array, items: { type: string } }
        steps_to_reproduce: { type: array, items: { type: string } }
        expected_result: { type: string }
        actual_result: { type: string }
    evidence:
      type: object
      additionalProperties: true
      properties:
        links: { type: array, items: { type: string } }
        notes: { type: string }
    regression:
      type: object
      additionalProperties: false
      properties:
        is_regression: { type: boolean }
        rollback_story: { type: string }
        affected_versions: { type: array, items: { type: string } }
    expected_behaviour:
      type: object
      additionalProperties: false
      properties:
        description: { type: string }
    non_functionals:
      type: object
      additionalProperties: false
      properties:
        security:      { type: array, items: { type: string } }
        performance:   { type: array, items: { type: string } }
        scalability:   { type: array, items: { type: string } }
        maintainability:{ type: array, items: { type: string } }
        observability: { type: array, items: { type: string } }
        connectivity:  { type: array, items: { type: string } }
        dependency:    { type: array, items: { type: string } }
        mdcb:          { type: array, items: { type: string } }
    delivery:
      type: object
      additionalProperties: false
      properties:
        breakdown: { type: array, items: { type: string } }   # suggested sub-tickets
        rollout_plan: { type: string }
        docs_impact: { type: string }
        governance: { type: string }
    tests:
      type: object
      additionalProperties: false
      properties:
        unit:        { type: array, items: { type: string } }
        integration: { type: array, items: { type: string } }
        e2e:         { type: array, items: { type: string } }
        regression:  { type: array, items: { type: string } }
        performance: { type: array, items: { type: string } }
        security:    { type: array, items: { type: string } }
        manual:      { type: array, items: { type: string } }
    acceptance_criteria:
      type: object
      additionalProperties: false
      properties:
        functional:
          type: array
          items:
            type: object
            additionalProperties: false
            properties:
              kind: { type: string, enum: ["happy","negative"] }
              text: { type: string }
            required: [kind, text]
        non_functional:
          type: array
          items:
            type: object
            additionalProperties: false
            properties:
              category: { type: string }
              text: { type: string }
            required: [category, text]
    open_questions:
      type: array
      items: { type: string }
  required:
    - context
    - expected_behaviour
    - acceptance_criteria
```

This refinement object (plus the original `ticket`) is the **canonical contract** between:

- Ticket systems (Jira/Zendesk).
- Transports (Slack, GitHub).
- Downstream workflows (implementation, test planning).

It is intentionally more structured than v1, but still flexible enough to evolve (e.g. we can add fields under nested objects without breaking callers as long as top‑level shape stays stable).

This artifact is the **canonical contract** between:

- Ticket systems (Jira/Zendesk).
- Transports (Slack, GitHub).
- Downstream workflows (implementation, test planning).

## Loops and Human Interaction

We will reuse proven patterns from Slack and existing task‑refinement:

- **Outer loop**: ticket originator ↔ refinement assistant.
  - Human provides initial ticket; assistant asks clarifying questions until the refinement artifact passes QA completeness.
  - Implemented via `fail_if` + `on_fail.goto` loops and human‑input checkpoints.
- **Inner loops**: within a refinement session.
  - For example, if completeness check fails due to missing non‑functionals, we loop back to a focused human input step that collects exactly that.

The workflow should be designed so that:

- Loops are **explicit** in the YAML (no hidden state machine magic).
- `routing.max_loops` is a **safety net**, not the primary way to stop chat.
- History helpers (e.g. `chat_history` patterns) can be used to provide clean conversational context to personas.

## Phased Implementation Plan

To keep scope manageable, we propose:

### Phase 1 – Core Workflow + CLI / Mock Tickets

- Implement `defaults/task-refinement-v2.yaml` with:
  - Normalized ticket input (from CLI fixture/mocks).
  - 3‑amigos persona steps (schemas only, no external integrations).
  - Synthesis + QA completeness gate.
  - Optional `git-checkout` step wired in but guarded by `if`.
- Add YAML tests that:
  - Exercise single‑pass refinement (high‑quality input).
  - Exercise multi‑turn clarification loops.
  - Verify persona outputs and final refinement artifact structure.

### Phase 2 – Slack / GitHub Transport Glue

- Add small transport‑specific workflows or examples that:
  - Feed Slack thread / GitHub issue/PR context into `task-refinement-v2`.
  - Surface clarifying questions and final refinement artifact back to the user.
- Reuse Slack Socket patterns (pause/resume, snapshots) where appropriate.

### Phase 3 – Ticket System Integration

- Design and (optionally) implement providers / scripts for:
  - Reading Jira/Zendesk tickets into the internal ticket schema.
  - Writing refined fields back (comments, custom fields, labels like “incomplete/complete”).
- Add tests using fixtures that mimic real tickets.

### Phase 4 – Incremental Migration and Docs

- Document v2 alongside v1, with guidance on when to use which.
- Once stable and battle‑tested, consider:
  - Making v2 the default `task-refinement.yaml`.
  - Deprecating or simplifying v1.

## Open Questions

1. **Ticket schema**: What minimal internal ticket schema should we standardise on so Jira/Zendesk/Slack/GitHub can all map into it without pain?
2. **Where to host persona prompts**:
   - Inline in v2 YAML?
   - Shared prompt snippets in a separate file?
3. **Git context defaults**:
   - Should `git-checkout` be opt‑in (strict `if`) or opportunistic when PR/ref metadata is present?
4. **Transport‑specific vs. generic workflow**:
   - Should Slack/GitHub use this exact workflow, or a thin wrapper that routes into it?
5. **How strict should the QA completeness gate be**:
   - Hard block (cannot proceed until fully satisfied)?
   - Configurable strictness per team / project?

## Next Steps

1. Review and iterate on this RFC:
   - Confirm the refinement framework sections and naming.
   - Confirm persona breakdown and responsibilities.
   - Agree on the internal refinement artifact schema.
2. Once agreed, implement `defaults/task-refinement-v2.yaml` following:
   - The patterns used in `defaults/task-refinement.yaml`.
   - Routing, criticality, assume/guarantee patterns from recent Slack/routing work.
3. Add YAML tests that:
   - Cover at least: single‑pass refinement, multi‑turn clarification, persona disagreement, and incomplete tickets.
4. Explore Slack/GitHub glue once the core workflow is stable.

---

**Author**: (to be filled)
**Version**: 0.1.0
