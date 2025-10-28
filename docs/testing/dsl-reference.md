# Test DSL Reference

This page documents the `.visor.tests.yaml` schema used by the Visor test runner.

```yaml
version: "1.0"
extends: ".visor.yaml"   # required; base config to run under tests

tests:
  defaults:
    strict: true                # default strict mode
    ai_provider: mock           # force AI provider to mock
    prompt_max_chars: 16000     # truncate captured prompts (optional)
    github_recorder:            # optional negative modes
      error_code: 0             # e.g., 429
      timeout_ms: 0             # e.g., 1000

  fixtures: []                  # (optional) suite-level custom fixtures

  cases:
    - name: <string>
      description: <markdown>
      skip: false|true

      # Single-event case
      event: pr_opened | pr_updated | pr_closed | issue_opened | issue_comment | manual
      fixture: <builtin|{ builtin, overrides }>
      env: { <KEY>: <VALUE>, ... }
      mocks: { <step>: <value>, <step>[]: [<value>...] }
      expect: <expect-block>
      strict: true|false         # overrides defaults.strict

      # OR flow case
      flow:
        - name: <string>
          event: ...             # per-stage event and fixture
          fixture: ...
          env: ...
          mocks: ...             # merged with flow-level mocks
          expect: <expect-block>
          strict: true|false     # per-stage fallback to case/defaults
```

## Fixtures

- Built-in GitHub fixtures: `gh.pr_open.minimal`, `gh.pr_sync.minimal`, `gh.issue_open.minimal`, `gh.issue_comment.standard`, `gh.issue_comment.visor_help`, `gh.issue_comment.visor_regenerate`.
- Use `overrides` to tweak titles, numbers, payload slices.

## Mocks

- Keys are step names; for forEach children use `step[]` (e.g., `validate-fact[]`).
- AI mocks may be structured JSON if a schema is configured for the step; otherwise use `text` and optional fields used by templates.
- Command/HTTP mocks emulate provider shape (`stdout`, `exit_code`, or HTTP body/status headers) and bypass real execution.

Inline example (AI with schema + list mocks):

```yaml
mocks:
  overview:
    text: "Overview body"
    tags: { label: feature, review-effort: 2 }
  extract-facts:
    - { id: f1, claim: "max_parallelism defaults to 4" }
    - { id: f2, claim: "Fast mode is enabled by default" }
  validate-fact[]:
    - { fact_id: f1, is_valid: false, correction: "max_parallelism defaults to 3" }
    - { fact_id: f2, is_valid: true }
```

## Expect block

```yaml
expect:
  calls:
    - step: <name> | provider: github + op: <rest.op>
      exactly|at_least|at_most: <number>
      args: { contains: [..], not_contains: [..] }   # provider args matching

  no_calls:
    - step: <name> | provider: github + op: <rest.op>

  prompts:
    - step: <name>
      index: first|last|<N>     # default: last
      where:                    # select a prompt from history, then assert
        contains: [..] | not_contains: [..] | matches: <regex>
      contains: [..]
      not_contains: [..]
      matches: <regex>

  outputs:
    - step: <name>
      index: first|last|<N>     # or
      where: { path: <expr>, equals|matches: <v> }
      path: <expr>              # dot/bracket, e.g. tags['review-effort']
      equals: <primitive>
      equalsDeep: <object>
      matches: <regex>
      contains_unordered: [..]

  fail:
    message_contains: <string>  # assert overall case failure message

  strict_violation:             # assert strict failure for a missing expect on a step
    for_step: <name>
    message_contains: <string>

Inline example (calls + prompts + outputs):

```yaml
expect:
  calls:
    - step: overview
      exactly: 1
    - provider: github
      op: labels.add
      at_least: 1
      args: { contains: [feature] }
  prompts:
    - step: overview
      contains: ["feat:", "diff --git a/"]
  outputs:
    - step: overview
      path: "tags['review-effort']"
      equals: 2
```
```

## Strict mode semantics

- When `strict: true` (default), any executed step must appear in `expect.calls` with a matching count; otherwise the case/stage fails.
- Use `no_calls` for explicit absence checks.

## Selectors and paths

- `index`: `first`, `last`, or 0‑based integer.
- `where`: evaluates against the same prompt/output history and selects a single item by content.
- `path`: dot/bracket (supports quoted keys: `tags['review-effort']`).

## CLI shortcuts

- Validate only: `visor test --validate --config <path>`
- Run one case: `visor test --only label-flow`
- Run one stage: `visor test --only pr-review-e2e-flow#facts-invalid`
- JSON/JUnit/Markdown reporters: `--json`, `--report junit:<path>`, `--summary md:<path>`
