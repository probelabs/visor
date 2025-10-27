# Writing Assertions

Assertions live under `expect:` and cover three surfaces:

- `calls`: step counts and provider effects (GitHub ops)
- `prompts`: final AI prompts (post templating/context)
- `outputs`: step outputs with history and selectors

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
```

Counts are consistent everywhere: `exactly`, `at_least`, `at_most`.

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

Tip: enable `--prompt-max-chars` or `tests.defaults.prompt_max_chars` to cap stored prompt size for large diffs.

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

## Strict mode and “no calls”

Strict mode (default) fails any executed step without a corresponding `expect.calls` entry. You can also assert absence explicitly:

```yaml
expect:
  no_calls:
    - provider: github
      op: issues.createComment
    - step: extract-facts
```
