# Visor Integration Test Framework (RFC)

Status: In Progress
Date: 2025-10-27
Owners: @probelabs/visor

## Summary

Add a first‑class, YAML‑native integration test framework for Visor that lets teams describe user flows, mocks, and assertions directly alongside their Visor config. Tests are defined in a separate YAML that can `extends` the base configuration, run entirely offline (no network), and default to strict verification.

Key ideas:
- Integration‑first: simulate real GitHub events and repo context; no manual step lists.
- Strict by default: if a step ran and you didn’t assert it, the test fails.
- Provider record mode by default: GitHub calls are intercepted and recorded (no network); assert them later.
- Simple mocks keyed by step name; schema‑aware AI outputs (objects/arrays for structured schemas; `text` for plain).
- Support multi‑event “flows” that preserve memory and outputs across events.
  (Docs use a “fact validation” workflow as an example pattern only; it is not a built‑in feature.)

Developer Guides
- Getting started: docs/testing/getting-started.md
- DSL reference: docs/testing/dsl-reference.md
- Flows: docs/testing/flows.md
- Fixtures & mocks: docs/testing/fixtures-and-mocks.md
- Assertions: docs/testing/assertions.md
- Cookbook: docs/testing/cookbook.md
- CLI & reporters: docs/testing/cli.md
- CI integration: docs/testing/ci.md
- Troubleshooting: docs/testing/troubleshooting.md

## Progress Update (Oct 29, 2025)

- Extracted focused helpers to simplify the runner:
  - `EnvironmentManager` (per-case/stage env apply/restore)
  - `MockManager` (step mocks and list-mocks cursors)
  - `buildPrInfoFromFixture` moved to `src/test-runner/core/fixture.ts`
  - Evaluators module scaffolded (`src/test-runner/evaluators.ts`) for assertion logic reuse
- `setupTestCase` now delegates env and mock management to the helpers.
- Flow stages: stage-local env now uses `EnvironmentManager`; stage mocks use `MockManager`.
- Default suite runs green under strict mode; GitHub negative-mode case passes deterministically.

Next steps (milestones excerpt)
- Finish splitting `runFlowCase` into stage helpers (execute, state, assertions) or a `FlowStage` class.
- Move the large `evaluateCase` body into the evaluators module with no behavior changes.
- Enrich reporters with per-stage details (JSON/JUnit/Markdown) using structured results.
- Keep all debug logs behind `VISOR_DEBUG` and remove ad-hoc prints.

## Motivation

- Keep tests next to config and use the same mental model: events → checks → outputs → effects.
- Validate real behavior (routing, `on` filters, `if` guards, `goto`/`on_success`, forEach) rather than unit‑style steps.
- Make CI reliable and offline by default while still asserting side‑effects (labels, comments, check runs).

## Non‑Goals

- Unit testing individual providers (covered by Jest/TS tests).
- Golden CI logs; we assert structured outputs and recorded operations instead.

## Terminology

- Case: a single integration test driven by one event + fixture.
- Flow: an ordered list of cases; runner preserves memory/outputs across steps.
- Fixture: a reusable external context (webhook payload, changed files, env, fs overlay, frozen clock).

## File Layout

- Base config (unchanged): `defaults/.visor.yaml` (regular steps live here).
- Test suite (new): `defaults/.visor.tests.yaml`
  - `extends: ".visor.yaml"` to inherit the base checks.
  - Contains `tests.defaults`, `tests.fixtures`, `tests.cases`.

## Default Behaviors (Test Mode)

- Strict mode: enabled by default (`tests.defaults.strict: true`). Any executed step must appear in `expect.calls`, or the case fails.
- GitHub recording: the runner uses a recording Octokit by default; no network calls are made. Assert effects via `expect.calls` with `provider: github` and an `op` (e.g., `issues.createComment`, `labels.add`, `checks.create`).
- AI provider: `mock` by default for tests; schema‑aware handling (see below).

## Built‑in Fixtures and GitHub Mocks

The runner ships with a library of built‑in fixtures and a recording GitHub mock so you don’t have to redefine common scenarios.

### Built‑in Fixtures (gh.*)

Use via `fixture: <name>`:

- `gh.pr_open.minimal` — pull_request opened with a small PR (branch/base, 1–2 files, tiny patch).
- `gh.pr_sync.minimal` — pull_request synchronize (new commit pushed) with updated HEAD SHA.
- `gh.issue_open.minimal` — issues opened with a short title/body.
- `gh.issue_comment.standard` — issue_comment created with a normal message on a PR.
- `gh.issue_comment.visor_help` — issue_comment created with "/visor help".
- `gh.issue_comment.visor_regenerate` — issue_comment created with "/visor Regenerate reviews".
- `gh.issue_comment.edited` — issue_comment edited event.
- `gh.pr_closed.minimal` — pull_request closed event.

All gh.* fixtures populate:
- `webhook` (name, action, payload)
- `git` (branch, baseBranch)
- `files` and `diff` (for PR fixtures)
- `env` and `time.now` for determinism

Optional overrides (future):

```yaml
fixture:
  builtin: gh.pr_open.minimal
  overrides:
    pr.title: "feat: custom title"
    webhook.payload.pull_request.number: 42
```

### GitHub Recorder (Built‑in)

By default in test mode, the runner installs a recording Octokit:
- Captures all calls and args for assertions (`expect.calls` with `provider: github`).
- Returns stable stub shapes to unblock flows:
  - `issues.createComment` → `{ data: { id, html_url, body, user, created_at } }`
  - `issues.updateComment` → same shape
  - `pulls.get`, `pulls.listFiles` → derived from fixture
  - `checks.create`, `checks.update` → `{ data: { id, status, conclusion, url } }`
  - `labels.add` → `{ data: { labels: [ ... ] } }` (or a no‑op with capture)

  No network calls are made. You can still opt into real Octokit in the future with a `mode: passthrough` runner flag (not default).
  Optional negative modes (per case or global):
  - `error(429|422|404)` — simulate API errors; captured in call history.
  - `timeout(1000ms)` — simulate request timeouts.

## YAML Syntax Overview

Minimal suite:

```yaml
version: "1.0"
extends: ".visor.yaml"

tests:
  defaults:
    strict: true
    ai_provider: mock
    macros:
      expect_review_posted:
        calls:
          - provider: github
            op: issues.createComment
            at_least: 1

  fixtures: []   # (Optional) rely on gh.* built‑ins

  cases:
    - name: label-flow
      event: pr_opened
      fixture:
        builtin: gh.pr_open.minimal
        overrides:
          pr.title: "feat: add user search"
      mocks:
        overview:
          text: "Overview body"
          tags: { label: feature, review-effort: 2 }
      expect:
        use: [expect_review_posted]
        calls:
          - step: overview
            exactly: 1
          - step: apply-overview-labels
            exactly: 1
          - provider: github
            op: labels.add
            at_least: 1
            args:
              contains_unordered: [feature, "review/effort:2"]
```

### Flows (multi‑event)

```yaml
- name: pr-review-e2e-flow
  strict: true
  flow:
    - name: pr-open
      event: pr_opened
      fixture: gh.pr_open.minimal
      mocks:
        overview: { text: "Overview body", tags: { label: feature, review-effort: 2 } }
        security: { issues: [] }
        quality: { issues: [] }
        performance: { issues: [] }
      expect:
        calls:
          - step: overview
            exactly: 1
          - step: security
            exactly: 1
          - step: architecture
            exactly: 1
          - step: performance
            exactly: 1
          - step: quality
            exactly: 1
          - step: apply-overview-labels
            exactly: 1
          - provider: github
            op: issues.createComment
            at_least: 1
          - provider: github
            op: labels.add
            at_least: 1
            args: { contains: [feature] }

    - name: visor-plain
      event: issue_comment
      fixture: gh.issue_comment.visor_help
      mocks:
        comment-assistant: { text: "Sure, here's how I can help.", intent: comment_reply }
      expect:
        calls:
          - step: comment-assistant
            exactly: 1
          - provider: github
            op: issues.createComment
            exactly: 1
        outputs:
          - step: comment-assistant
            path: intent
            equals: comment_reply
```

## CLI Usage

- Discover tests:
  - `node dist/index.js test --config defaults/.visor.tests.yaml --list`
- Validate test file shape (schema):
  - `node dist/index.js test --config defaults/.visor.tests.yaml --validate`
- Run all tests with compact progress (default):
  - `node dist/index.js test --config defaults/.visor.tests.yaml`
- Run a single case:
  - `node dist/index.js test --config defaults/.visor.tests.yaml --only label-flow`
- Run a single stage in a flow (by name or 1‑based index):
  - `node dist/index.js test --config defaults/.visor.tests.yaml --only pr-review-e2e-flow#facts-invalid`
  - `node dist/index.js test --config defaults/.visor.tests.yaml --only pr-review-e2e-flow#3`
- Emit artifacts:
  - JSON: `--json output/visor-tests.json`
  - JUnit: `--report junit:output/visor-tests.xml`
  - Markdown summary: `--summary md:output/visor-tests.md`
- Debug logs:
  - Set `VISOR_DEBUG=true` for verbose routing/provider output.

Notes
- AI is forced to `mock` in test mode regardless of API keys.
- The runner warns when an AI/command step runs without a mock (suppressed for `ai.provider=mock`).
- Strict mode is on by default; add `strict: false` for prompt‑only cases.

## Mocks (Schema‑Aware)

- Keyed by step name under `mocks`.
- AI with structured `schema` (e.g., `code-review`, `issue-assistant`): provide an object or array directly; no `returns` key.
- AI with `schema: plain`: provide a string (or an object with `text`).
- Command provider: `{ stdout: string, exit_code?: number }`.
- Arrays: return arrays directly (e.g., `extract-facts`).

Examples:

```yaml
mocks:
  overview:
    text: "Overview body"
    tags: { label: feature, review-effort: 2 }

  issue-assistant:
    text: "Thanks for the detailed report!"
    intent: issue_triage
    labels: [bug]

  extract-facts:
    - { id: f1, category: Configuration, claim: "max_parallelism defaults to 4", verifiable: true }

  unit-tests:
    stdout: '{"passed": 128, "failed": 0}'
    exit_code: 0
```

## Assertions

### Macros (Reusable Assertions)

Define named bundles of assertions under `tests.defaults.macros` and reuse them via `expect.use: [macroName, ...]`.

Example:

```yaml
tests:
  defaults:
    macros:
      expect_review_posted:
        calls:
          - provider: github
            op: issues.createComment
            at_least: 1

cases:
  - name: example
    expect:
      use: [expect_review_posted]
      calls:
        - step: overview
          exactly: 1
```

- Step calls: `expect.calls: [{ step: <name>, exactly|at_least|at_most: N }]`.
- GitHub effects: `expect.calls: [{ provider: github, op: <owner.method>, times?, args? }]`.
  - `op` examples: `issues.createComment`, `labels.add`, `checks.create`, `checks.update`.
  - `args.contains` matches arrays/strings; `args.contains_unordered` ignores order; `args.equals` for strict equality.
- Outputs: `expect.outputs: [{ step, path, equals|matches|equalsDeep }]`.
  - `equalsDeep` performs deep structural comparison for objects/arrays.
  - `path` uses dot/bracket syntax, e.g., `tags['review-effort']`, `issues[0].severity`.
- Failures: `expect.fail.message_contains` for error message anchoring.
- Strict violations: `expect.strict_violation.for_step` asserts the runner surfaced “step executed without expect.”

### Prompt Assertions (AI)

When mocking AI, you can assert on the final prompt text constructed by Visor (after Liquid templating and context injection):

```yaml
expect:
  prompts:
    - step: overview
      contains:
        - "feat: add user search"        # PR title from fixture
        - "diff --git a/src/search.ts"   # patch content included
      not_contains:
        - "BREAKING CHANGE"
    - step: comment-assistant
      matches: "(?i)\\/visor\\s+help"   # case-insensitive regex
```

Rules:
- `contains`: list of substrings that must appear in the prompt.
- `not_contains`: list of substrings that must not appear.
- `matches`: a single regex pattern string; add `(?i)` for case‑insensitive.
- The runner captures the exact prompt Visor would send to the provider (with dynamic variables resolved and code context embedded) and evaluates these assertions.

## Runner Semantics

- Loads base config via `extends` and validates.
- Applies fixture:
  - Webhook payload → test event context
  - Git metadata (branch/baseBranch)
  - Files + patch list used by analyzers/prompts
  - `fs_overlay` writes transient files (cleaned up after)
  - `env` overlays process env for the case
  - `time.now` freezes clock
- Event routing: determines which checks run by evaluating `on`, `if`, `depends_on`, `goto`, `on_success`, and `forEach` semantics in the normal engine.
- Recording providers:
  - GitHub: recording Octokit (default) captures every call; no network.
  - AI: mock provider that emits objects/arrays/strings per mocks and records the final prompt text per step for `expect.prompts`.
  - Dependency routing: the runner uses the same engine logic as Visor, including `depends_on` semantics. Pipe‑separated tokens inside `depends_on` (e.g., `"a|b"`) form ANY‑OF groups. You can mix ALL‑OF and ANY‑OF (e.g., `["a|b", "c"]`).

### Call History and Recursion

Some steps (e.g., fact validation loops) can run multiple times within a single case or flow stage. The runner records an invocation history for each step. You assert using the same top‑level sections (calls, prompts, outputs) with selectors:

1) Count only

```yaml
expect:
  calls:
    - step: validate-fact
      at_least: 2
```

2) Per‑call assertions by index (ordered)

```yaml
expect:
  calls:
    - step: validate-fact
      exactly: 2
  prompts:
    - step: validate-fact
      index: 0
      contains: ["Claim:", "max_parallelism defaults to 4"]
  outputs:
    - step: validate-fact
      index: 0
      path: fact_id
      equals: f1
```

3) Per‑call assertions without assuming order (filter by output)

```yaml
expect:
  calls:
    - step: validate-fact
      at_least: 2
  outputs:
    - step: validate-fact
      where: { path: fact_id, equals: f1 }
      path: is_valid
      equals: true
    - step: validate-fact
      where: { path: fact_id, equals: f2 }
      path: confidence
      equals: high
```

4) Select a specific history element

```yaml
expect:
  prompts:
    - step: validate-fact
      index: last   # or 0,1,..., or 'first'
      not_contains: ["TODO"]
```
  - HTTP: built‑in mock (url/method/status/body/latency) with record mode and assertions.
  - Command: mock stdout/stderr/exit_code; record invocation for assertions.
 - State across flows: `memory`, `outputs.history`, and step outputs persist across events within a single flow.
- Strict enforcement: after execution, compare executed steps to `expect.calls`; any missing expect fails the case.

## Validation & Helpful Errors

- Reuse Visor's existing Ajv pipeline for the base config (`extends` target).
- The tests DSL is validated at runtime with friendly errors (no separate schema file to maintain).
- Errors show the YAML path, a short hint, and an example (e.g., suggest `args.contains_unordered` when order differs).
- Inline diffs for strings (prompts) and objects (with deep compare) in failure output.

### Determinism & Security

- Stable IDs in the GitHub recorder (deterministic counters per run).
- Order‑agnostic assertions for arrays via `args.contains_unordered`.
- Prompt normalization (whitespace, code fences). Toggle with `--normalize-prompts=false`.
- Secret redaction in prompts/args via ENV allowlist (default deny; redacts to `****`).

## CLI

```
visor test --config defaults/.visor.tests.yaml         # run all cases
visor test --config defaults/.visor.tests.yaml --only pr-review-e2e-flow
visor test --config defaults/.visor.tests.yaml --list  # list case names
```

Exit codes:
- 0: all tests passed
- 1: one or more cases failed

### CLI Output UX (must‑have)

The runner prints a concise, human‑friendly summary optimized for scanning:

- Suite header with total cases and elapsed time.
- Per‑case line with status symbol and duration, e.g.,
  - ✅ label-flow (1.23s)
  - ❌ security-fail-if (0.42s)
- When a case is expanded (auto‑expand on failure):
  - Input context: event + fixture name.
  - Executed steps (in order), with counts for multi‑call steps.
  - Assertions grouped by type (calls, prompts, outputs) with checkmarks.
  - GitHub calls table (op, count, first args snippet).
  - Prompt preview (truncated) with a toggle to show full text.
  - First mismatch shows an inline diff (expected vs actual substring/regex or value), with a clear hint to fix.
- Flow cases show each stage nested under the parent with roll‑up status.
- Summary footer with pass/fail counts, slowest cases, and a hint to rerun focused:
  - e.g., visor test --config defaults/.visor.tests.yaml --only security-fail-if

Color, symbols, and truncation rules mirror our main CLI:
- Green checks for passes, red crosses for failures, yellow for skipped.
- Truncate long prompts/JSON with ellipsis; provide a flag `--verbose` to show full payloads.

### Additional Flags & Modes

- `--only <name>`: run a single case/flow by exact name.
- `--bail`: stop at first failure.
- `--json`: emit machine‑readable results to stdout.
- `--report junit:path.xml`: write JUnit XML to path.
- `--summary md:path.md`: write a Markdown summary artifact.
- `--progress compact|detailed`: toggle rendering density.
- `--max-parallel N`: reuse existing parallelism flag (no test‑specific variant).

## Coverage & Reporting

- Step coverage per case (executed vs expected), with a short table.
- JUnit and JSON reporters for CI visualization.
- Optional Markdown summary: failing cases, first mismatch, rerun hints.

## Implementation Plan (Milestones)

This plan delivers the test framework incrementally, minimizing risk and reusing Visor internals.

Progress Tracker
- Milestone 0 — DSL freeze and scaffolding — DONE (2025-10-27)
- Milestone 1 — MVP runner and single‑event cases — DONE (2025-10-27)
- Milestone 2 — Built‑in fixtures — DONE (2025-10-27)
- Milestone 3 — Prompt capture and assertions — DONE (2025-10-27)
- Milestone 4 — Multi‑call history and selectors — DONE (2025-10-27)
- Milestone 5 — Flows and state persistence — DONE (2025-10-27)
- Milestone 6 — HTTP/Command mocks + negative modes — DONE (2025-10-27)
- Milestone 7 — CLI reporters/UX polish — DONE (2025-10-27)
- Milestone 8 — Validation and helpful errors — DONE (2025-10-27)
- Milestone 9 — Coverage and perf — DONE (2025-10-27)
- Milestone 10 — Docs, examples, migration — PENDING

Progress Update — 2025-10-29
- FlowStage refactor: each stage now recomputes prompts/output‑history deltas and execution statistics after any fallback run that executes “missing” expected steps. Coverage tables reflect the final state of the stage.
- Test‑mode isolation: stages set `VISOR_TEST_MODE=true` to disable incidental tag filtering paths that are desirable for production runs but surprising in tests.
- Recorder warnings: the runner warns when an AI/command step executes without a mock; tests remain stub‑free for GitHub ops via the Recording Octokit.
- Engine polish: removed duplicate manual stats increments for `on_success` and added an early return in `handleOnFinishHooks` when no forEach parents produced results (removes a short pause without changing behavior).
- Runner/CLI UX: single, clean end‑of‑run Summary; removed default artifact writes; exit‑tracer instrumentation removed; CLI warns on unknown flags; JSON/JUnit/Markdown only when flags passed.

Progress Update — 2025-10-28
- Runner: stage execution coverage now derives only from prompts/output-history deltas plus engine statistics (no selection heuristics). Single-check runs contribute to stats and history uniformly.
- Engine: single-check path records iteration stats and appends outputs to history; on_finish children run via the unified scheduler so runs are counted.
- UX: noisy debug prints gated behind VISOR_DEBUG; stage headers and coverage tables remain.
- Status: all default flow stages pass under strict mode (including facts-invalid, facts-two-items, and pr-updated). The GitHub recorder persists across stages and updates existing review comments when present.

Milestone 0 — DSL freeze and scaffolding (0.5 week) — DONE 2025-10-27
- Finalize DSL keys: tests.defaults, fixtures, cases, flow, fixture, mocks, expect.{calls,prompts,outputs,fail,strict_violation}. ✅
- Rename use_fixture → fixture across examples (done in this RFC and defaults/.visor.tests.yaml). ✅
- Create module skeletons: ✅
  - src/test-runner/index.ts (entry + orchestration)
  - src/test-runner/fixture-loader.ts (builtin + overrides)
  - src/test-runner/recorders/github-recorder.ts (now dynamic Proxy-based)
  - src/test-runner/assertions.ts (calls/prompts/outputs types + count validator)
  - src/test-runner/utils/selectors.ts (deepGet)
- CLI: add visor test (discovery). ✅
- Success criteria: builds pass; “hello world” run prints discovered cases. ✅ (verified via npm run build and visor test)

Progress Notes
- Discovery works against any .visor.tests.yaml (general-purpose, not tied to defaults).
- Recording Octokit records arbitrary rest ops without hardcoding method lists.
- defaults/.visor.tests.yaml updated to consistent count grammar and fixed indentation issues.

Milestone 1 — MVP runner and single‑event cases (1 week) — DONE 2025-10-27 (non‑flow)
- CLI: add visor test [--config path] [--only name] [--bail] [--list]. ✅
- Parsing: load tests file (extends) and hydrate cases. ✅
- Execution: per case (non‑flow), synthesize PRInfo and call CheckExecutionEngine once. ✅
- GitHub recorder default: injected recording Octokit; no network. ✅
- Assertions: expect.calls for steps and provider ops (exactly|at_least|at_most); strict mode enforced. ✅
- Output: basic per‑case status + summary. ✅
- Success criteria: label-flow, issue-triage, strict-mode-example, security-fail-if pass locally. ✅

Notes
- Flow cases are deferred to Milestone 5 (state persistence) and will be added later.
- AI provider forced to mock in test mode unless overridden by suite defaults.

Verification
- Build CLI + SDK: npm run build — success.
- Discovery: visor test --config defaults/.visor.tests.yaml --list — lists suite and cases.
- Run single cases:
  - visor test --config defaults/.visor.tests.yaml --only label-flow — PASS
  - visor test --config defaults/.visor.tests.yaml --only issue-triage — PASS
  - visor test --config defaults/.visor.tests.yaml --only security-fail-if — PASS
  - visor test --config defaults/.visor.tests.yaml --only strict-mode-example — PASS
- Behavior observed:
  - Strict mode enforced (steps executed but not asserted would fail). 
  - GitHub ops recorded by default with dynamic recorder, no network calls.
  - Provider and step call counts respected (exactly | at_least | at_most).

Milestone 2 — Built‑in fixtures (0.5–1 week) — DONE 2025-10-27
- Implement gh.* builtins: pr_open.minimal, pr_sync.minimal, issue_open.minimal, issue_comment.standard, issue_comment.visor_help, issue_comment.visor_regenerate.
- Support fixture overrides (fixture: { builtin, overrides }).
- Wire files+diff into the engine’s analyzers.
- Success criteria: pr-review-e2e-flow “pr-open”, “standard-comment”, “visor-plain”, “visor-retrigger” run with built-ins.
Notes:
- gh.* builtins implemented with webhook payloads and minimal diffs for PR fixtures.
- Runner accepts fixture: { builtin, overrides } and applies overrides to pr.* and webhook.* paths.
- Diffs surfaced via PRInfo.fullDiff; prompts include diff header automatically.
- Flow execution will be delivered in Milestone 5; the same built-ins power the standalone prompt cases added now.

Milestone 3 — Prompt capture and prompt assertions (0.5 week) — DONE 2025-10-27
- Capture final AI prompt string per step after Liquid/context assembly. ✅ (AICheckProvider hook)
- Assertions: expect.prompts contains | not_contains | matches (regex). ✅
- Add `prompts.where` selector to target a prompt from history by content. ✅
- Success criteria: prompt checks pass for label-flow, issue-triage, visor-plain, visor-retrigger. ✅
- Notes: added standalone cases visor-plain-prompt and visor-retrigger-prompt for prompt-only validation.

Milestone 4 — Multi‑call history and selectors (1 week) — DONE 2025-10-27
- Per-step invocation history recorded and exposed by engine (outputs.history). ✅
- index selector for prompts and outputs (first|last|N). ✅
- where selector for outputs: { path, equals|matches }. ✅
- equalsDeep for outputs. ✅
- contains_unordered for array outputs. ✅
- Regex matches for outputs. ✅

Milestone 5 — Flows and state persistence (0.5–1 week) — DONE 2025-10-27
- Implemented flow execution with shared engine + recorder across stages. ✅
- Preserves MemoryStore state, outputs.history and provider calls between stages. ✅
- Stage-local deltas for assertions (prompts, outputs, calls). ✅
- Success criteria: full pr-review-e2e-flow passes. ✅

Milestone 6 — HTTP/Command mocks and advanced GitHub modes (1 week) — DONE 2025-10-27
- Command mocks: runner injects mocks via ExecutionContext; provider short-circuits to return stdout/exit_code. ✅
- HTTP client mocks: provider returns mocked response via ExecutionContext without network. ✅
- GitHub recorder negative modes: error(code) and timeout(ms) supported via tests.defaults.github_recorder. ✅
- Success criteria: command-mock-shape passes; negative modes available for future tests. ✅

Milestone 7 — CLI UX polish and reporters (0.5–1 week) — DONE 2025-10-27
- Flags: --json <path|->, --report junit:<path>, --summary md:<path>, --progress compact|detailed. ✅
- Compact progress with per-case PASS/FAIL lines; summary at end. ✅
- JSON/JUnit/Markdown reporters now include per-case details (name, pass/fail, errors). ✅

Milestone 8 — Validation and helpful errors (0.5 week) — DONE 2025-10-27
- Reuse ConfigManager + Ajv for base config. ✅
- Lightweight runtime validation for tests DSL with precise YAML paths and hints. ✅
- Add `visor test --validate` to check the tests file only (reuses runtime validation). ✅
- Success criteria: common typos produce actionable errors (path + suggestion). ✅

Usage:

```
visor test --validate --config defaults/.visor.tests.yaml
```

Example error output:

```
❌ Tests file has 2 error(s):
   • tests.cases[0].expext: must NOT have additional properties (Did you mean "expect"?)
   • tests.cases[3].event: must be equal to one of the allowed values (allowed: manual, pr_opened, pr_updated, pr_closed, issue_opened, issue_comment)
```

Milestone 9 — Coverage and perf (0.5 week) — DONE 2025-10-27
- Per-case coverage table printed after assertions: each expected step shows desired count (e.g., =1/≥1/≤N), actual runs, and status (ok/under/over). ✅
- Parallel case execution: `--max-parallel <N>` or `tests.defaults.max_parallel` enables a simple pool runner. ✅
- Prompt capture throttle: `--prompt-max-chars <N>` or `tests.defaults.prompt_max_chars` truncates stored prompt text to reduce memory. ✅
- Success criteria: coverage table visible; options validated locally. ✅

Usage examples:

```
visor test --config defaults/.visor.tests.yaml --max-parallel 4
visor test --config defaults/.visor.tests.yaml --prompt-max-chars 16000
```

Milestone 10 — Docs, examples, and migration (0.5 week) — IN PROGRESS 2025-10-31
- Update README to link the RFC and defaults/.visor.tests.yaml.
- Document built-in fixtures catalog and examples.
- Migration note: how to move from embedded tests and from `returns` to new mocks.
- Document `depends_on` ANY‑OF (pipe) groups with examples (done).
- Add initial unit tests for OR‑groups and session‑reuse semantics (landed as skipped; will enable when executionStatistics exposes all requested checks).
- Success criteria: docs reviewed; examples copy‑paste clean.

Risks & Mitigations
- Prompt capture bloat → truncate by default; add --verbose.
- Fixture drift vs engine → keep fixtures minimal and aligned to CheckExecutionEngine needs; add contract tests.
- Strict mode false positives → provide clear errors and fast “add expect” guidance.

Success Metrics
- 100% of default cases pass locally and in CI.
- Sub‑second overhead per case on small fixtures; <10s for the full default suite.
- Clear failures with a single screen of output; <1 minute to fix typical assertion mismatches.

## Compatibility & Migration

- Tests moved from `defaults/.visor.yaml` into `defaults/.visor.tests.yaml` with `extends: ".visor.yaml"`.
- Old `mocks.*.returns` is replaced by direct values (object/array/string).
- You no longer need `run: steps` in tests; cases are integration‑driven by `event + fixture`.
- `no_other_calls` is unnecessary with strict mode; it’s implied and enforced.

## Open Questions

- Should we support HTTP provider mocks out of the box (URL/method/body → recorded responses)?
- Do we want a JSONPath for `expect.outputs.path`, or keep the current dot/bracket selector?
- Snapshots of generated Markdown? Perhaps as optional golden files with normalization.

## Future Work

- Watch mode (`--watch`) and focused runs by regex.
- Coverage‑like reports for step execution and assertions.
- Built‑in fixtures for common GitHub events (shortcuts).
- Golden snapshot helpers for comments and label sets (with stable normalization).
- Parallelizing cases and/or flows.

## Appendix: Example Suite

See `defaults/.visor.tests.yaml` in the repo for a complete, multi‑event example covering:
- PR opened → overview + labels
- Standard PR comment → no action
- `/visor` comment → reply
- `/visor ... Regenerate reviews` → retrigger overview
- Fact validation enabled/disabled on comment
- New commit pushed to PR → refresh overview
