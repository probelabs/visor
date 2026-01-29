# Writing Assertions

Assertions live under `expect:` and cover several surfaces:

- `calls`: step counts and provider effects (GitHub/Slack ops)
- `prompts`: final AI prompts (post templating/context)
- `outputs`: step outputs with history and selectors
- `workflow_output`: workflow-level outputs (for workflow testing)
- `no_calls`: assert that specific steps or provider ops were NOT called
- `fail`: assert that the case failed with a specific message
- `strict_violation`: assert strict mode failure for a missing expect on a step
- `use`: reference reusable macros defined in `tests.defaults.macros`

## Calls

```yaml
expect:
  calls:
    - step: overview
      exactly: 1
    - provider: github
      op: labels.add
      at_least: 1
      args:
        contains: [feature, "review/effort:2"]
    - provider: slack
      op: chat.postMessage
      at_least: 1
      args:
        contains: ["Review complete"]
```

Counts are consistent everywhere: `exactly`, `at_least`, `at_most`.

Supported providers:
- `github`: GitHub API operations (e.g., `labels.add`, `issues.createComment`, `pulls.createReview`, `checks.create`)
- `slack`: Slack API operations (e.g., `chat.postMessage`)

The `args` field supports:
- `contains`: array of values that must be present (for labels) or substrings (for Slack text)

## Prompts

```yaml
expect:
  prompts:
    - step: overview
      contains: ["feat: add user search", "diff --git a/src/search.ts"]
    - step: comment-assistant
      matches: "(?i)\\/visor\\s+help"
    - step: overview
      # Select the prompt that mentions a specific file
      where:
        contains: ["src/search.ts"]
      contains: ["diff --git a/src/search.ts"]
```

- `contains`: required substrings
- `not_contains`: forbidden substrings
- `matches`: regex (prefix `(?i)` for case-insensitive)
- `index`: `first` | `last` | N (default: last)
- `where`: selector to choose a prompt from history using `contains`/`not_contains`/`matches` before applying the assertion

Tip: Enable `--prompt-max-chars` CLI flag or `tests.defaults.prompt_max_chars` config setting to cap stored prompt size for large diffs.

## Outputs

Use `path` with dot/bracket syntax. You can select by index or by a `where` probe over the same output history.

```yaml
expect:
  outputs:
    - step: validate-fact
      index: 0
      path: fact_id
      equals: f1
    - step: validate-fact
      where: { path: fact_id, equals: f2 }
      path: confidence
      equals: high
    - step: aggregate-validations
      path: all_valid
      equals: true
```

Supported comparators:
- `equals` (primitive)
- `equalsDeep` (structural)
- `matches` (regex)
- `contains_unordered` (array membership ignoring order)

## Workflow Outputs

For workflow testing, use `workflow_output` to assert on workflow-level outputs (defined in the workflow's `outputs:` section):

```yaml
expect:
  workflow_output:
    - path: summary
      contains: "Review completed"
    - path: issues_found
      equals: 3
    - path: categories
      contains_unordered: ["security", "performance"]
```

Supported comparators for workflow outputs:
- `equals` (primitive)
- `equalsDeep` (structural)
- `matches` (regex)
- `contains` (substring check, can be string or array)
- `not_contains` (forbidden substrings)
- `contains_unordered` (array membership ignoring order)
- `where` (selector with `path` + `equals`/`matches`)

## Strict mode and "no calls"

Strict mode (default) fails any executed step without a corresponding `expect.calls` entry. You can also assert absence explicitly:

```yaml
expect:
  no_calls:
    - provider: github
      op: issues.createComment
    - provider: slack
      op: chat.postMessage
    - step: extract-facts
```

## Failure Assertions

Assert that a test case fails with a specific error message:

```yaml
expect:
  fail:
    message_contains: "validation failed"
```

Assert that strict mode caught an unexpected step execution:

```yaml
expect:
  strict_violation:
    for_step: unexpected-step
    message_contains: "Step executed without expect"
```

## Reusable Macros

Define reusable assertion blocks in `tests.defaults.macros` and reference them with `use`:

```yaml
tests:
  defaults:
    macros:
      basic-github-check:
        calls:
          - provider: github
            op: checks.create
            at_least: 1

  cases:
    - name: my-test
      event: pr_opened
      expect:
        use: [basic-github-check]
        calls:
          - step: overview
            exactly: 1
```

Macros are merged with inline expectations, allowing you to compose reusable assertion patterns.
