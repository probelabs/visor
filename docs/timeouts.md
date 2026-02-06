# Timeouts: Configuration and Behavior

Checks can specify a per-check timeout. When a timeout is reached, the provider is aborted and the engine records a timeout error and skips direct dependents.

## Configuration

```yaml
steps:
  fetch-tickets:
    type: command
    timeout: 60  # seconds (command provider uses seconds)
    exec: node scripts/jira/batch-fetch.js "$JQL" --limit $LIMIT
```

## Provider-Specific Timeout Behavior

Each provider has its own timeout handling:

| Provider | Unit | Default | Config Key |
|----------|------|---------|------------|
| `command` | seconds | 60s | `timeout` |
| `http_client` | milliseconds | 30000ms (30s) | `timeout` |
| `mcp` | seconds | 60s | `timeout` |
| `ai` | milliseconds | varies by model | `ai.timeout` |
| `human-input` | seconds | none (waits indefinitely) | `timeout` |
| `custom tools` | milliseconds | 30000ms (30s) | `timeout` |
| `git-checkout` | milliseconds | 300000ms (5 min) | `clone_timeout_ms` |

### Command Provider

- **Units**: seconds
- **Default**: 60 seconds
- **Error rule ID**: `command/timeout`
- **Message**: "Command execution timed out after N seconds"
- **Behavior**: Dependents are skipped with reason `dependency_failed`

```yaml
steps:
  long-build:
    type: command
    timeout: 300  # 5 minutes
    exec: npm run build
```

### HTTP Client Provider

- **Units**: milliseconds
- **Default**: 30000ms (30 seconds)
- **Error rule ID**: `http_client/fetch_error` or `http_client/download_timeout`
- **Message**: "Request timed out after Nms"

```yaml
steps:
  fetch-data:
    type: http_client
    timeout: 60000  # 60 seconds
    url: https://api.example.com/data
```

### MCP Provider

- **Units**: seconds (converted to milliseconds internally)
- **Default**: 60 seconds
- **Applies to**: Connection timeout and request timeout separately

```yaml
steps:
  mcp-analysis:
    type: mcp
    timeout: 120  # 2 minutes
    command: npx
    args: ["-y", "@probelabs/probe@latest", "mcp"]
    method: search_code
```

### AI Provider

- **Units**: milliseconds
- **Default**: varies by provider/model
- **Config location**: Nested under `ai:` block

```yaml
steps:
  ai-review:
    type: ai
    prompt: "Review this code"
    ai:
      provider: anthropic
      model: claude-3-opus
      timeout: 120000  # 2 minutes
```

### Human Input Provider

- **Units**: seconds
- **Default**: no timeout (waits indefinitely)
- **Behavior**: Returns default value if timeout expires

```yaml
steps:
  approval:
    type: human-input
    prompt: "Approve deployment? (yes/no)"
    timeout: 300  # 5 minutes
    default: "no"
```

### Custom Tools

- **Units**: milliseconds
- **Default**: 30000ms (30 seconds)

```yaml
tools:
  my-tool:
    name: my-tool
    exec: ./slow-script.sh
    timeout: 60000  # 60 seconds
```

### Git Checkout Provider

- **Units**: milliseconds
- **Default**: 300000ms (5 minutes)
- **Config key**: `clone_timeout_ms`

```yaml
steps:
  checkout-repo:
    type: git-checkout
    ref: main
    clone_timeout_ms: 600000  # 10 minutes for large repos
```

## CLI Global Timeout

The CLI supports a global timeout via the `--timeout` flag:

```bash
visor --check all --timeout 300000  # 5 minute global timeout (milliseconds)
```

This timeout applies to AI operations. The default is 1200000ms (30 minutes).

## Examples

### Basic Command Timeout

```yaml
steps:
  fetch:
    type: command
    timeout: 120  # 2 minutes
    exec: curl -s https://example.com/data

  process:
    type: command
    depends_on: [fetch]
    exec: echo "{{ outputs.fetch }}" | jq '.items | length'
```

If `fetch` exceeds 120 seconds, `process` is skipped with reason `dependency_failed`.

### Mixed Provider Timeouts

```yaml
steps:
  # Command: seconds
  build:
    type: command
    timeout: 300
    exec: npm run build

  # HTTP: milliseconds
  notify:
    type: http_client
    timeout: 10000
    url: https://webhook.example.com
    depends_on: [build]

  # AI: milliseconds (nested)
  review:
    type: ai
    prompt: "Review the build output"
    ai:
      timeout: 60000
    depends_on: [build]
```

## Notes

- **Unit awareness**: Be mindful of units when switching between providers (seconds vs milliseconds).
- **Dependency propagation**: When a check times out, all direct dependents are skipped.
- **Failure handling**: Consider using [`fail_if`](./fail-if.md) conditions for additional guarding.
- **Routing**: Use [`on_fail`](./failure-routing.md) to define retry or recovery behavior on timeout.

## Related Documentation

- [Command Provider](./command-provider.md) - Shell command execution
- [HTTP Integration](./http.md) - HTTP client and webhook providers
- [MCP Provider](./mcp-provider.md) - MCP tool execution
- [AI Configuration](./ai-configuration.md) - AI provider settings
- [Human Input Provider](./human-input-provider.md) - Interactive input
- [Custom Tools](./custom-tools.md) - YAML-defined tools
- [Git Checkout Provider](./providers/git-checkout.md) - Repository checkout
- [Failure Routing](./failure-routing.md) - Handling failures and retries
