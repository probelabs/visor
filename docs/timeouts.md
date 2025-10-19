# Timeouts: configuration and behavior

Checks can specify a per‑check timeout. When a timeout is reached, the provider is aborted and the engine records a timeout error and skips direct dependents.

## Configuration

```yaml
steps:
  fetch-tickets:
    type: command
    timeout: 300  # seconds (command)
    exec: node scripts/jira/batch-fetch.js "$JQL" --limit $LIMIT
```

Provider units and defaults:

- `command`:
  - Units: seconds.
  - Default: 60s if not specified.
  - Effect on timeout: issue `command/timeout` with message “Command execution timed out after <N> seconds”. Direct dependents are skipped.
- `http_client`:
  - Units: milliseconds.
  - Default: provider default (see provider docs/test for specifics).
- `ai`:
  - Use `ai.timeout` (milliseconds). CLI `--timeout` also maps to AI timeout.

The engine propagates the per‑check timeout into providers in dependency‑aware execution so behavior is consistent even in multi‑check workflows.

## Examples

```yaml
steps:
  fetch:
    type: command
    timeout: 120
    exec: curl -s https://example.com/data

  process:
    type: command
    depends_on: [fetch]
    exec: echo "{{ outputs.fetch }}" | jq '.items | length'
```

If `fetch` exceeds 120s, `process` is skipped with reason `dependency_failed`.

## Notes

- Be mindful of units when switching providers (seconds vs milliseconds).
- Consider adding `fail_if` conditions for additional guarding (e.g., `fail_if: !output || length(output.items) === 0`).

