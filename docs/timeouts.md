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

#### AI Timeout (`ai_timeout`)

The `ai_timeout` field sets a **Probe-level soft timeout** that is separate from Visor's external hard timeout. When `ai_timeout` fires, Probe's internal timeout handling kicks in (graceful wind-down or negotiated extension) rather than Visor abruptly killing the process.

```yaml
steps:
  ai-review:
    type: ai
    prompt: "Analyze the codebase"
    ai:
      timeout: 300000      # Visor's hard kill (5 minutes)
      ai_timeout: 60000    # Probe's soft timeout (1 minute)
```

See [Negotiated Timeout](#negotiated-timeout) below for the observer-based extension pattern.

### Negotiated Timeout

The **negotiated timeout** feature enables an independent observer LLM to decide whether a running AI agent should receive a time extension or be stopped. This is particularly useful for long-running agents that invoke sub-workflow tools via MCP, where the main agent loop may be blocked waiting for a tool response and cannot process a simple graceful wind-down message.

#### How It Works

1. The agent runs until `ai_timeout` fires (the soft timeout).
2. An independent observer LLM evaluates the agent's progress.
3. The observer either **grants an extension** (with a time budget) or **declines**.
4. If declined, Probe calls `graceful_stop` on connected MCP servers, which:
   - Shortens the shared execution deadline for all active sub-workflows
   - Signals running ProbeAgent sessions to wind down via `triggerGracefulWindDown()`
5. After the `graceful_stop_deadline` window, the agent is hard-stopped.

#### Configuration

```yaml
steps:
  complex-analysis:
    type: ai
    prompt: "Perform comprehensive analysis using sub-workflow tools"
    ai:
      # Visor's external hard kill (always active as safety net)
      timeout: 300000                        # 5 minutes

      # Probe-level soft timeout — observer fires here
      ai_timeout: 60000                      # 1 minute

      # Negotiated timeout: observer LLM decides extensions
      timeout_behavior: negotiated
      negotiated_timeout_budget: 120000      # 2 min total extra time
      negotiated_timeout_max_requests: 3     # max 3 extension requests
      negotiated_timeout_max_per_request: 60000  # max 1 min per extension

      # Wind-down deadline for sub-agents after graceful_stop
      graceful_stop_deadline: 5000           # 5 seconds
```

#### Configuration Reference

| Field | Type | Description |
|-------|------|-------------|
| `timeout_behavior` | `'graceful'` \| `'negotiated'` | Timeout strategy. `graceful` (default) sends a wind-down message. `negotiated` uses an observer LLM. |
| `negotiated_timeout_budget` | number (ms) | Total extra time the observer can grant across all extensions. Use values ≥ 60000 (1 min) since the observer works in minute granularity. |
| `negotiated_timeout_max_requests` | number | Maximum number of extension requests before hard stop. |
| `negotiated_timeout_max_per_request` | number (ms) | Maximum time per individual extension grant. Use values ≥ 60000 (1 min). |
| `graceful_stop_deadline` | number (ms) | Time window for sub-agents to wind down after `graceful_stop` is called. |

#### The `graceful_stop` MCP Tool

When the observer declines an extension, Probe calls `graceful_stop` on all connected MCP servers. Visor's built-in MCP SSE server implements this tool to:

1. **Shorten the shared execution deadline** — all active sub-workflow tool calls see the new deadline at their next check iteration.
2. **Signal active ProbeAgent sessions** — iterates the `SessionRegistry` and calls `triggerGracefulWindDown()` on each session.

This two-phase approach ensures that even deeply nested workflows (e.g., assistant → engineer sub-workflow → code analysis) receive the stop signal and can produce partial results before the hard deadline.

See the [official example](../examples/negotiated-timeout.yaml) for a complete working configuration.

#### Important Notes

- **Minute granularity**: The observer works in minutes. Budget values under 60000ms round to 0 minutes and won't grant meaningful extensions. Use at least 60000ms (1 min) for `negotiated_timeout_budget` and `negotiated_timeout_max_per_request`.
- **Safety net**: Visor's external `timeout` always acts as the ultimate hard kill, regardless of negotiated timeout settings.
- **Default behavior**: If `timeout_behavior` is not set, the default is `graceful` — Probe sends a wind-down message when `ai_timeout` fires.

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
- [AI Configuration](./ai-configuration.md) - AI provider settings including negotiated timeout fields
- [Advanced AI Features](./advanced-ai.md) - Negotiated timeout and graceful stop for sub-workflows
- [Workflows](./workflows.md) - Reusable workflows and graceful stop propagation
- [MCP Tools](./mcp.md) - MCP server configuration and built-in `graceful_stop` tool
- [Human Input Provider](./human-input-provider.md) - Interactive input
- [Custom Tools](./custom-tools.md) - YAML-defined tools
- [Git Checkout Provider](./providers/git-checkout.md) - Repository checkout
- [Failure Routing](./failure-routing.md) - Handling failures and retries
- [Glossary](./glossary.md) - Definitions for Negotiated Timeout, Graceful Stop, Timeout Observer
