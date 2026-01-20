# Native GitHub Provider

The `github` provider performs safe, native GitHub operations via Octokit — no shelling out to `gh`.

- Supported ops: `labels.add`, `labels.remove`, `comment.create`.
- Works on Pull Requests and Issues (uses the current PR/issue number from the event context).
- Returns provider issues on failures instead of crashing the run.

## Requirements

- `GITHUB_TOKEN` (or the Action input `github-token`) must be present.
- `GITHUB_REPOSITORY` is auto‑set in Actions.

## Configuration

```yaml
steps:
  apply-overview-labels:
    type: github
    group: github
    tags: [github]
    depends_on: [overview]
    on: [pr_opened, pr_updated]
    op: labels.add
    values:
      - "{{ outputs.overview.tags.label | default: '' | safe_label }}"
      - "{{ outputs.overview.tags['review-effort'] | default: '' | prepend: 'review/effort:' | safe_label }}"
```

Notes:
- Empty strings are ignored automatically; no `value_js` needed to filter them out.

### Issues (Errors) Emitted

When the provider cannot perform an operation, it returns a synthetic issue in the check’s output:

- `github/missing_token` — no token available
- `github/missing_context` — missing owner/repo/PR number
- `github/unsupported_op` — unknown `op`
- `github/value_js_error` — exception thrown while evaluating `value_js`
- `github/op_failed` — Octokit call failed (includes error message)

These issues are visible in tables/markdown output and will not abort the whole workflow; use `fail_if` to control behavior.

## Labels: Sanitization

To prevent injection and ensure GitHub‑compatible labels, use Liquid filters:

- `safe_label` — keeps only `[A-Za-z0-9:/\- ]` (alphanumerics, colon, slash, hyphen, and space), collapses repeated `/`, and trims whitespace.
- `safe_label_list` — applies `safe_label` to arrays and removes empty values.

Examples:
```yaml
values:
  - "{{ outputs['issue-assistant'].tags.label | safe_label }}"
  - "{{ outputs.overview.tags['review-effort'] | prepend: 'review/effort:' | safe_label }}"
```

> Important: Do not build shell commands from labels. The `github` provider calls the API directly.

## Creating Comments

```yaml
steps:
  post-note:
    type: github
    op: comment.create
    values:
      - "Automated note for PR #{{ pr.number }}"
      - "\nDetails: {{ outputs.security.text | default: '' | unescape_newlines }}"
```

## Removing Labels

```yaml
steps:
  cleanup-labels:
    type: github
    op: labels.remove
    values:
      - legacy/triage
      - stale
```

## Tips

- Combine Liquid and `value_js` to build dynamic, multi‑label operations safely.
- Use `tags: [github]` to run these checks only in Actions (paired with `--tags github`).
- Pair with `if:` conditions to gate on prior outputs, e.g., apply labels only when `outputs.overview.tags.label` exists.
