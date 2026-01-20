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
    comment-assistant: { text: "We rely on defaults/.visor.yaml line 11 for max_parallelism=4.", intent: comment_reply }
    extract-facts:
      - { id: f1, category: Configuration, claim: "max_parallelism defaults to 4", verifiable: true }
    validate-fact[]:
      - { fact_id: f1, is_valid: true, confidence: high, evidence: "defaults/.visor.yaml:11" }
  expect:
    calls:
      - step: extract-facts
        exactly: 1
      - step: validate-fact
        at_least: 1
      - step: aggregate-validations
        exactly: 1
```

## 6) Facts invalid (correction reply)

```yaml
- name: facts-invalid
  event: issue_comment
  fixture: gh.issue_comment.visor_help
  env: { ENABLE_FACT_VALIDATION: "true" }
  mocks:
    comment-assistant: { text: "We rely on defaults/.visor.yaml line 11 for max_parallelism=4.", intent: comment_reply }
    extract-facts:
      - { id: f1, category: Configuration, claim: "max_parallelism defaults to 4", verifiable: true }
    validate-fact[]:
      - { fact_id: f1, is_valid: false, confidence: high, evidence: "defaults/.visor.yaml:11", correction: "max_parallelism defaults to 3" }
  expect:
    calls:
      - step: comment-assistant
        exactly: 2
      - step: aggregate-validations
        exactly: 1
    prompts:
      - step: comment-assistant
        index: last
        contains: ["<previous_response>", "Correction: max_parallelism defaults to 3"]
```

## 7) Two facts (one invalid)

```yaml
- name: facts-two-items
  event: issue_comment
  fixture: gh.issue_comment.visor_help
  env: { ENABLE_FACT_VALIDATION: "true" }
  mocks:
    comment-assistant: { text: "We rely on defaults/.visor.yaml for concurrency defaults.", intent: comment_reply }
    extract-facts:
      - { id: f1, category: Configuration, claim: "max_parallelism defaults to 4", verifiable: true }
      - { id: f2, category: Feature,       claim: "Fast mode is enabled by default", verifiable: true }
    validate-fact[]:
      - { fact_id: f1, is_valid: false, confidence: high, evidence: "defaults/.visor.yaml:11", correction: "max_parallelism defaults to 3" }
      - { fact_id: f2, is_valid: true,  confidence: high, evidence: "src/config.ts:FAST_MODE=true" }
  expect:
    calls:
      - step: validate-fact
        exactly: 2
    prompts:
      - step: comment-assistant
        index: last
        contains: ["max_parallelism defaults to 4", "Correction: max_parallelism defaults to 3"]
        not_contains: ["Fast mode is enabled by default"]
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

