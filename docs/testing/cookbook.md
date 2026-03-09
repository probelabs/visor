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

## 10) Multi-turn conversation with cross-turn assertions

Simulate a multi-message conversation and assert on each response — including looking back at earlier turns from a later stage.

```yaml
- name: multi-turn-support-conversation
  flow:
    - name: user-reports-issue
      event: manual
      fixture: local.minimal
      routing: { max_loops: 0 }
      execution_context:
        conversation:
          transport: slack
          thread: { id: "support-thread" }
          messages:
            - { role: user, text: "My API is returning 502 errors" }
          current: { role: user, text: "My API is returning 502 errors" }
      mocks:
        chat[]:
          - text: "A 502 error typically means the upstream service is unreachable. Can you check if your backend is running and the target URL in your API definition is correct?"
          - intent: chat
      expect:
        calls:
          - step: chat
            exactly: 1
        llm_judge:
          - step: chat
            path: text
            prompt: Does the response acknowledge the 502 error and suggest diagnostic steps?

    - name: user-provides-details
      event: manual
      fixture: local.minimal
      routing: { max_loops: 0 }
      execution_context:
        conversation:
          transport: slack
          thread: { id: "support-thread" }
          messages:
            - { role: user, text: "My API is returning 502 errors" }
            - { role: assistant, text: "A 502 error typically means the upstream service is unreachable..." }
            - { role: user, text: "The backend is running. I checked with curl and it works directly." }
          current: { role: user, text: "The backend is running. I checked with curl and it works directly." }
      mocks:
        chat[]:
          - text: "If curl works directly but Tyk returns 502, check: 1) The `target_url` in your API definition matches what curl uses 2) Tyk can resolve the hostname (DNS) 3) Any TLS certificate issues between Tyk and the upstream."
          - intent: chat
      expect:
        calls:
          - step: chat
            exactly: 1
        llm_judge:
          # Assert current response narrows down based on user's info
          - step: chat
            index: last
            path: text
            prompt: |
              The user said curl works directly but Tyk gives 502.
              Does the response narrow down Tyk-specific causes (not repeat generic advice)?
          # Verify first response was appropriately general (before details were known)
          - step: chat
            index: first
            path: text
            prompt: |
              This was the first response before the user provided details.
              Was it appropriately exploratory (asking for info) rather than jumping to conclusions?
```

## 11) LLM-as-judge: semantic evaluation

Use `llm_judge` to evaluate whether AI responses meet semantic criteria that can't be expressed with regex or exact matching.

```yaml
- name: response-quality-check
  event: manual
  fixture: local.minimal
  mocks:
    chat[]:
      - text: |
          Tyk Gateway uses Redis-based distributed rate limiting through its
          middleware chain. Rate limits are configured per API key or policy
          with `rate` and `per` fields. When exceeded, returns HTTP 429.
      - intent: chat
      - skills: [code-explorer]
  expect:
    calls:
      - step: chat
        exactly: 1
    llm_judge:
      # Simple pass/fail verdict
      - step: chat
        path: text
        prompt: |
          Does this response accurately explain rate limiting?
          It should mention specific mechanisms, not be generic.

      # Structured extraction with assertions
      - step: chat
        path: text
        prompt: Analyze this technical response about rate limiting.
        schema:
          properties:
            mentions_redis:
              type: boolean
              description: "Mentions Redis for distributed rate limiting?"
            mentions_status_code:
              type: boolean
              description: "Mentions HTTP 429 status code?"
            technical_depth:
              type: string
              enum: [shallow, moderate, deep]
          required: [mentions_redis, mentions_status_code, technical_depth]
        assert:
          mentions_redis: true
          mentions_status_code: true
```

Configure the judge model globally:

```yaml
tests:
  defaults:
    llm_judge:
      model: gemini-2.0-flash
      provider: google
```

Or per-assertion with the `model` field. Set `VISOR_JUDGE_MODEL` env var as a fallback.

## 12) Conversation sugar: multi-turn without boilerplate

The `conversation:` format auto-builds message history from prior turns, removing the need to duplicate `execution_context.conversation.messages` across stages.

```yaml
- name: support-conversation
  strict: false
  conversation:
    - role: user
      text: "My API is returning 502 errors"
      mocks:
        chat: { text: "A 502 error typically means the upstream service is unreachable. Can you check if your backend is running?", intent: chat }
      expect:
        calls:
          - step: chat
            exactly: 1
    - role: user
      text: "The backend is running. Curl works directly."
      mocks:
        chat: { text: "If curl works directly but Tyk returns 502, check the target_url in your API definition and DNS resolution.", intent: chat }
      expect:
        outputs:
          - step: chat
            turn: current
            path: text
            matches: "(?i)target_url"
        llm_judge:
          - step: chat
            turn: current
            path: text
            prompt: Does the response narrow down Tyk-specific causes?
          - step: chat
            turn: 1
            path: text
            prompt: Was the first response appropriately exploratory?
```

Compare this with the equivalent `flow:` format in recipe #10 — the `conversation:` format is significantly more concise.

## Related Documentation

- [Getting Started](./getting-started.md) - Introduction to the test framework
- [DSL Reference](./dsl-reference.md) - Complete test YAML schema
- [Assertions](./assertions.md) - Available assertion types
- [Fixtures and Mocks](./fixtures-and-mocks.md) - Managing test data
- [Flows](./flows.md) - Multi-stage test flows
- [CLI](./cli.md) - Test runner command line options
- [CI Integration](./ci.md) - Running tests in CI pipelines
- [Troubleshooting](./troubleshooting.md) - Common issues and solutions
