# Test Cookbook

Copy‑pasteable recipes for common scenarios.

## 1) Label PR on open

```yaml
- name: label-flow
  event: pr_opened
  fixture: gh.pr_open.minimal
  mocks:
    overview:
      text: "Overview body"
      tags: { label: feature, review-effort: 2 }
  expect:
    calls:
      - step: overview
        exactly: 1
      - step: apply-overview-labels
        exactly: 1
      - provider: github
        op: labels.add
        at_least: 1
        args: { contains: [feature, "review/effort:2"] }
```

## 2) Ignore normal comment

```yaml
- name: standard-comment
  event: issue_comment
  fixture: gh.issue_comment.standard
  mocks:
    comment-assistant: { text: "", intent: comment_reply }  # empty text → no reply
  expect:
    no_calls:
      - provider: github
        op: issues.createComment
    calls:
      - step: comment-assistant
        exactly: 1
```

## 3) `/visor help` reply and prompt check

```yaml
- name: visor-plain
  event: issue_comment
  fixture: gh.issue_comment.visor_help
  mocks:
    comment-assistant: { text: "Sure, here’s how I can help.", intent: comment_reply }
  expect:
    calls:
      - step: comment-assistant
        exactly: 1
      - provider: github
        op: issues.createComment
        exactly: 1
    prompts:
      - step: comment-assistant
        matches: "(?i)\\/visor\\s+help"
```

## 4) Regenerate reviews on command

```yaml
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

## 5) Facts enabled (one fact)

```yaml
- name: facts-enabled
  event: issue_comment
  fixture: gh.issue_comment.visor_help
  env: { ENABLE_FACT_VALIDATION: "true" }
  mocks:
    comment-assistant: { text: "We rely on defaults/visor.yaml line 11 for max_parallelism=4.", intent: comment_reply }
    extract-facts:
      - { id: f1, category: Configuration, claim: "max_parallelism defaults to 4", verifiable: true }
    validate-fact[]:
      - { fact_id: f1, claim: "max_parallelism defaults to 4", is_valid: true, confidence: high, evidence: "defaults/visor.yaml:11" }
  expect:
    calls:
      - step: comment-assistant
        exactly: 1
      - step: extract-facts
        exactly: 1
      - step: validate-fact
        at_least: 1
```

## 6) Facts invalid (correction reply)

When a fact is invalid, the correction flow triggers a re-run. Due to goto forward-running dependents, `extract-facts` and `validate-fact` also run again.

```yaml
- name: facts-invalid
  event: issue_comment
  fixture: gh.issue_comment.visor_help
  env: { ENABLE_FACT_VALIDATION: "true" }
  routing:
    max_loops: 1
  mocks:
    comment-assistant: { text: "We rely on defaults/visor.yaml line 11 for max_parallelism=4.", intent: comment_reply }
    extract-facts:
      - { id: f1, category: Configuration, claim: "max_parallelism defaults to 4", verifiable: true }
    validate-fact[]:
      - { fact_id: f1, claim: "max_parallelism defaults to 4", is_valid: false, confidence: high, evidence: "defaults/visor.yaml:11 does not set 4", correction: "max_parallelism defaults to 3" }
  expect:
    calls:
      - step: comment-assistant
        exactly: 2
      - step: extract-facts
        exactly: 2
      - step: validate-fact
        exactly: 2
      - step: aggregate
        exactly: 1
    outputs:
      - step: validate-fact
        where: { path: fact_id, equals: f1 }
        path: correction
        equals: "max_parallelism defaults to 3"
```

## 7) Two facts (one invalid)

With two facts extracted where only one is invalid, the correction pass runs for the invalid fact. Due to goto forward-running dependents, `extract-facts` and `validate-fact` run again on retry.

```yaml
- name: facts-two-items
  event: issue_comment
  fixture: gh.issue_comment.visor_help
  env: { ENABLE_FACT_VALIDATION: "true" }
  routing:
    max_loops: 1
  mocks:
    comment-assistant: { text: "We rely on defaults/visor.yaml for concurrency defaults.", intent: comment_reply }
    extract-facts:
      - { id: f1, category: Configuration, claim: "max_parallelism defaults to 4", verifiable: true }
      - { id: f2, category: Feature,       claim: "Fast mode is enabled by default", verifiable: true }
    validate-fact[]:
      - { fact_id: f1, claim: "max_parallelism defaults to 4", is_valid: false, confidence: high, evidence: "defaults/visor.yaml:11", correction: "max_parallelism defaults to 3" }
      - { fact_id: f2, claim: "Fast mode is enabled by default", is_valid: true,  confidence: high, evidence: "src/config.ts:FAST_MODE=true" }
  expect:
    calls:
      - step: comment-assistant
        exactly: 2
      - step: extract-facts
        exactly: 2
      - step: validate-fact
        exactly: 4
      - step: aggregate
        exactly: 1
    outputs:
      - step: validate-fact
        where: { path: fact_id, equals: f1 }
        path: is_valid
        equals: false
      - step: validate-fact
        where: { path: fact_id, equals: f2 }
        path: is_valid
        equals: true
```

## 8) GitHub negative mode

```yaml
- name: github-negative-mode
  event: pr_opened
  fixture: gh.pr_open.minimal
  github_recorder: { error_code: 429 }
  mocks: { overview: { text: "Overview body", tags: { label: feature, review-effort: 2 } } }
  expect:
    calls:
      - step: overview
        exactly: 1
      - step: apply-overview-labels
        exactly: 1
    fail:
      message_contains: "github/op_failed"
```

## 9) API tool (`type: api`) with YAML tests

You can verify OpenAPI-to-MCP conversion without real network calls by asserting generated-tool validation behavior:

```yaml
tools:
  users-api:
    type: api
    name: users-api
    spec: ./fixtures/api-tool-openapi.json
    headers:
      Authorization: "Bearer ${API_TEST_BEARER_TOKEN}"
      X-Tenant-Id: "${API_TEST_TENANT_ID}"
    whitelist: [get*]

checks:
  api-tool-missing-required-input:
    type: mcp
    transport: custom
    method: getUser
    methodArgs: {}
    on: [manual]

tests:
  cases:
    - name: api-tool-generated-operation-validates-input
      event: manual
      fixture: gh.pr_open.minimal
      expect:
        calls:
          - step: api-tool-missing-required-input
            exactly: 1
        outputs:
          - step: api-tool-missing-required-input
            path: issues[0].message
            matches: "(?i)required property 'id'"
```

This confirms generated operation tools are registered and invoked through `transport: custom`.
The same config supports env-backed custom headers (for example `Authorization: "Bearer ${API_TEST_BEARER_TOKEN}"`).

Also see end-to-end example suites:

- `examples/api-tools-mcp-example.yaml` (embedded tests)
- `examples/api-tools-ai-example.yaml` (embedded tests)
- `examples/api-tools-inline-overlay-example.yaml` (embedded tests)

## Related Documentation

- [Getting Started](./getting-started.md) - Introduction to the test framework
- [DSL Reference](./dsl-reference.md) - Complete test YAML schema
- [Assertions](./assertions.md) - Available assertion types
- [Fixtures and Mocks](./fixtures-and-mocks.md) - Managing test data
- [Flows](./flows.md) - Multi-stage test flows
- [CLI](./cli.md) - Test runner command line options
- [CI Integration](./ci.md) - Running tests in CI pipelines
- [Troubleshooting](./troubleshooting.md) - Common issues and solutions
