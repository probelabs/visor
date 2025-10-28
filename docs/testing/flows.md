# Flow Tests

> Model realistic user journeys across multiple external events in one case.

A flow case defines a `flow:` array of stages. Each stage has its own `event`, `fixture`, optional `env` and `mocks`, plus `expect`.

```yaml
- name: pr-review-e2e-flow
  strict: true
  flow:
    - name: pr-open
      event: pr_opened
      fixture: gh.pr_open.minimal
      mocks: { overview: { text: "Overview body", tags: { label: feature, review-effort: 2 } } }
      expect:
        calls:
          - step: overview
            exactly: 1
          - step: apply-overview-labels
            exactly: 1

    - name: visor-retrigger
      event: issue_comment
      fixture: gh.issue_comment.visor_regenerate
      mocks:
        comment-assistant: { text: "Regenerating.", intent: comment_retrigger }
        overview: { text: "Overview (regenerated)", tags: { label: feature, review-effort: 2 } }
      expect:
        calls:
          - step: comment-assistant
            exactly: 1
          - step: overview
            exactly: 1
```

## Stage selection and deltas

- Run a single stage: `--only case#stage` (name substring) or `--only case#N` (1‑based index).
- Coverage, prompts, outputs, and provider calls are computed per‑stage as deltas from the previous stage.
- The same engine instance is reused across stages, so memory and output history carry over.

## Ordering and `on_finish`

- Flow execution honors dependencies and `on_success`/`on_fail` routing.
- For forEach parents with `on_finish.run`, the runner defers static targets from the initial set so they execute after per-item processing.
- Dynamic `on_finish.run_js` is executed and counted like regular steps.

## Strict mode across stages

- If any step executes in a stage and lacks a corresponding `expect.calls` entry for that stage, the stage fails under strict mode.
- Use `no_calls` to assert absence (e.g., a standard comment should not trigger a reply or fact validation).

## Facts workflow patterns

- Per-item validation: `validate-fact` depends on `extract-facts` (which outputs an array) and runs once per item.
- Aggregation: `aggregate-validations` is a memory step that summarizes the latest validation wave and, when not all facts are valid, schedules a correction comment via `on_finish.run_js`.
- In tests: provide array mocks for `extract-facts` and per-call list mocks for `validate-fact[]`. Assert that only invalid facts appear in the correction prompt using `prompts.contains`/`not_contains`.

## Stage-local mocks and env

- Stage mocks override flow-level defaults: the runner merges `{...flow.mocks, ...stage.mocks}`.
- `env:` applies only for the stage and is restored afterward.

## Debugging flows

- Set `VISOR_DEBUG=true` to print stage headers, selected checks, and internal debug lines from the engine.
- To reduce noise, limit the run to a stage: `VISOR_DEBUG=true visor test --only pr-review-e2e-flow#facts-invalid`.

