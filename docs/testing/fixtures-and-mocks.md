# Fixtures and Mocks

Integration tests simulate outside world inputs and provider outputs.

## Built-in GitHub fixtures (gh.*)

Use via `fixture: gh.<name>` or `fixture: { builtin: gh.<name>, overrides: {...} }`.

- `gh.pr_open.minimal` — pull_request opened with a tiny diff and `src/search.ts` file.
- `gh.pr_sync.minimal` — pull_request synchronize with a small follow-up diff.
- `gh.pr_closed.minimal` — pull_request closed event.
- `gh.issue_open.minimal` — issues opened (short title/body).
- `gh.issue_comment.standard` — normal human comment on a PR/issue.
- `gh.issue_comment.visor_help` — comment containing `/visor help`.
- `gh.issue_comment.visor_regenerate` — `/visor Regenerate reviews`.

Overrides allow tailored inputs:

```yaml
fixture:
  builtin: gh.pr_open.minimal
  overrides:
    pr.title: "feat: custom title"
    webhook.payload.pull_request.number: 42
```

## GitHub recorder

The test runner injects a recording Octokit by default:

- Captures every GitHub op+args for assertions (`expect.calls` with `provider: github`).
- Returns stable stub shapes so flows can continue without network.
- Negative modes are available globally via `tests.defaults.github_recorder`:

```yaml
tests:
  defaults:
    github_recorder:
      error_code: 429      # simulate API error
      timeout_ms: 1000     # simulate request timeout
```

## Mocks

Mocks are keyed by step name under `mocks`.

Examples:

```yaml
mocks:
  # AI with structured schema
  overview:
    text: "High-level PR summary."
    tags: { label: feature, review-effort: 2 }

  # AI plain text schema
  comment-assistant:
    text: "Sure, here’s how I can help."
    intent: comment_reply

  # Array outputs (e.g., extract-facts)
  extract-facts:
    - { id: f1, category: Configuration, claim: "max_parallelism defaults to 4", verifiable: true }

  # Command provider
  unit-tests:
    stdout: '{"passed": 128, "failed": 0}'
    exit_code: 0
```

Notes:
- No `returns:` key; provide values directly.
- For HTTP/Command providers, mocks bypass real execution and are recorded for assertions.

