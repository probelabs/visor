# A2A Provider (Agent-to-Agent Protocol)

Visor implements the [A2A (Agent-to-Agent) protocol](https://github.com/google/A2A) for agent interoperability. This enables two modes of operation:

- **Server mode** — Visor exposes workflows as a discoverable A2A agent that external systems can call
- **Client mode** — Visor calls external A2A agents as workflow steps using `type: a2a`

### A2A vs MCP

| | A2A | MCP |
|---|---|---|
| **Pattern** | Agent-to-Agent task delegation | Agent-to-Tool function calls |
| **Communication** | Stateful tasks with lifecycle | Stateless function invocation |
| **Input** | Natural language + structured data | Typed JSON Schema parameters |
| **Discovery** | Agent Card at `/.well-known/agent-card.json` | Tool listing via `tools/list` |
| **Multi-turn** | Built-in (input_required state) | Not applicable |

Use MCP when you need deterministic tool calls with typed schemas. Use A2A when you need to delegate complex tasks to another agent that may require multiple turns or long-running execution.

---

## Quick Start

### Server: Expose a Workflow as an A2A Agent

```yaml
# .visor.yaml
version: "1.0"

agent_protocol:
  enabled: true
  protocol: a2a
  port: 9000
  agent_card_inline:
    name: "Review Agent"
    description: "AI code review"
    skills:
      - id: review
        name: Code Review
        description: Review code for issues
  default_workflow: review

steps:
  review:
    type: ai
    prompt: "Review the submitted code for issues"
    on: [manual]
```

```bash
# Start the A2A server
visor --a2a --config .visor.yaml

# Test with curl
curl http://localhost:9000/.well-known/agent-card.json
curl -X POST http://localhost:9000/message:send \
  -H "Content-Type: application/json" \
  -d '{"message": {"message_id": "1", "role": "user", "parts": [{"text": "Review my code"}]}}'
```

### Client: Call an External A2A Agent

```yaml
steps:
  scan:
    type: a2a
    agent_url: "http://compliance-agent:9000"
    message: "Review PR #{{ pr.number }}: {{ pr.title }}"
    blocking: true
```

---

## Server Mode: Visor as an A2A Agent

### Enabling the Server

Start with the `--a2a` CLI flag:

```bash
visor --a2a --config .visor.yaml
```

Or enable in configuration:

```yaml
agent_protocol:
  enabled: true
  protocol: a2a
  port: 9000          # default: 9000
  host: "0.0.0.0"     # default: 0.0.0.0
```

A2A can run alongside other modes:

```bash
visor --a2a --slack --config .visor.yaml    # A2A + Slack simultaneously
```

### Agent Card

The Agent Card describes your agent to external clients. Define it inline or load from a file:

```yaml
# Inline
agent_protocol:
  agent_card_inline:
    name: "Code Review Agent"
    description: "AI-powered code review"
    version: "1.0.0"
    provider:
      organization: "My Org"
      url: "https://myorg.com"
    skills:
      - id: security
        name: Security Review
        description: OWASP Top 10 analysis
        tags: [security, owasp]
      - id: performance
        name: Performance Review
        description: Performance bottleneck detection
        tags: [performance]
    supported_interfaces:
      - url: "http://localhost:9000"
        protocol_binding: "a2a/v1"
    capabilities:
      streaming: false
      push_notifications: false

# Or load from file
agent_protocol:
  agent_card: "./agent-card.json"
```

The Agent Card is served publicly at `GET /.well-known/agent-card.json` (no authentication required).

### Skill Routing

Map incoming A2A skill IDs to internal Visor workflows:

```yaml
agent_protocol:
  skill_routing:
    security: security-review       # A2A skill "security" → workflow "security-review"
    performance: performance-review
  default_workflow: general-review   # Fallback when skill not matched
```

When a client sends a message with `metadata.skill_id: "security"`, Visor routes it to the `security-review` workflow. Unmatched skills use `default_workflow`.

### Authentication

Configure authentication for inbound requests:

```yaml
agent_protocol:
  auth:
    type: bearer                    # bearer | api_key | none
    token_env: AGENT_AUTH_TOKEN     # Environment variable containing the token
```

**Bearer token:**
```yaml
auth:
  type: bearer
  token_env: AGENT_AUTH_TOKEN       # Checked via Authorization: Bearer <token>
```

**API key:**
```yaml
auth:
  type: api_key
  key_env: AGENT_API_KEY
  header_name: X-API-Key            # default: x-api-key
  param_name: api_key               # also checked as query parameter
```

> The Agent Card endpoint (`/.well-known/agent-card.json`) is always public regardless of auth configuration.

### HTTP Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/.well-known/agent-card.json` | No | Agent Card for discovery |
| `POST` | `/message:send` | Yes | Submit a task / send a message |
| `GET` | `/tasks/{id}` | Yes | Get task by ID |
| `GET` | `/tasks` | Yes | List all tasks |
| `POST` | `/tasks/{id}:cancel` | Yes | Cancel a running task |

### Task Lifecycle

Tasks follow a state machine with these transitions:

```
                            ┌─────────────┐
                            │  submitted  │
                            └──────┬──────┘
                      ┌────────────┼────────────┐
                      v            v            v
                ┌──────────┐ ┌──────────┐ ┌──────────┐
                │ working  │ │ canceled │ │ rejected │
                └────┬─────┘ └──────────┘ └──────────┘
           ┌─────┬───┼───┬─────────┐
           v     v   v   v         v
     ┌─────────┐ │ ┌───┐ │  ┌────────────────┐
     │completed│ │ │   │ │  │input_required  │──→ working (resumed)
     └─────────┘ │ │   │ │  └────────────────┘
           ┌─────┘ │   │ └──────────┐
           v       v   v            v
     ┌──────────┐  ┌──────────┐  ┌────────────────┐
     │  failed  │  │ canceled │  │ auth_required  │──→ working (resumed)
     └──────────┘  └──────────┘  └────────────────┘
```

**Terminal states:** `completed`, `failed`, `canceled`, `rejected`

| State | Description |
|-------|-------------|
| `submitted` | Task created, waiting to be picked up |
| `working` | Workflow engine is processing the task |
| `input_required` | Agent needs additional input from the client |
| `auth_required` | Agent needs authentication credentials |
| `completed` | Task finished successfully |
| `failed` | Task execution encountered an error |
| `canceled` | Task was canceled by the client |
| `rejected` | Task was rejected at submission |

### Task Queue

For async execution, configure the task queue:

```yaml
agent_protocol:
  queue:
    poll_interval: 1000        # Poll database every N ms (default: 1000)
    max_concurrent: 5          # Max concurrent tasks (default: 5)
    stale_claim_timeout: 300000  # Worker timeout in ms (default: 300000)
  task_ttl: "7d"               # Task retention period (default: 7d)
```

**Blocking vs async:**
- **Blocking** (default): The `POST /message:send` request waits for the workflow to complete and returns the full task with artifacts.
- **Async**: Set `configuration.blocking: false` in the request. Returns the task ID immediately; the client polls `GET /tasks/{id}` for status updates.

### TLS

For production deployments:

```yaml
agent_protocol:
  tls:
    cert: "/path/to/cert.pem"
    key: "/path/to/key.pem"
```

---

## Client Mode: Calling External A2A Agents

Use `type: a2a` to call external A2A-compatible agents from your workflow.

### Basic Usage

```yaml
steps:
  compliance-scan:
    type: a2a
    agent_url: "http://compliance-agent:9000"
    message: |
      Review PR #{{ pr.number }}: {{ pr.title }}
      Files changed: {{ files | size }}
    blocking: true
    timeout: 60000
```

### Agent Discovery

Specify the agent endpoint in one of two ways (mutually exclusive):

```yaml
# Option 1: Direct URL to the agent
agent_url: "http://agent.example.com:9000"

# Option 2: URL to the Agent Card (endpoint resolved from card)
agent_card: "https://agent.example.com/.well-known/agent-card.json"
```

When using `agent_card`, Visor fetches the card, caches it for 5 minutes, and resolves the endpoint from `supported_interfaces`.

### Authentication

```yaml
steps:
  scan:
    type: a2a
    agent_url: "http://agent:9000"
    message: "Review this code"
    auth:
      scheme: bearer              # bearer | api_key
      token_env: AGENT_TOKEN      # Environment variable with the token
      # header_name: X-API-Key    # For api_key scheme (default: x-api-key)
```

### Message Construction

**Text message** (Liquid template):
```yaml
message: |
  Review PR #{{ pr.number }}: {{ pr.title }}
  Author: {{ pr.author }}
```

**Structured data** (Liquid-templated key-value pairs sent as data parts):
```yaml
data:
  repo_context: '{{ pr.repo | json }}'
  file_list: '{{ files | json }}'
```

**File attachments:**
```yaml
files:
  - url: "https://example.com/requirements.txt"
    media_type: "text/plain"
    filename: "requirements.txt"
```

### Polling and Multi-Turn

```yaml
steps:
  interactive-agent:
    type: a2a
    agent_url: "http://agent:9000"
    message: "Analyze {{ pr.title }}"

    blocking: true          # Wait for completion (default: true)
    timeout: 300000         # Max wait in ms (default: 300000)
    poll_interval: 2000     # Poll frequency in ms (default: 2000)

    # Multi-turn conversation
    max_turns: 3            # Max conversation turns (default: 1)
    on_input_required: |    # Auto-reply when agent asks for more info
      Here is additional context:
      {{ pr.body }}
```

When the agent enters `input_required` state, Visor automatically sends the `on_input_required` template as a follow-up message. This continues up to `max_turns`.

### Output Transformation

Transform agent responses into structured issues with JavaScript:

```yaml
steps:
  scan:
    type: a2a
    agent_url: "http://agent:9000"
    message: "Security scan"
    transform_js: |
      return {
        issues: (output.issues || []).map(function(i) {
          return {
            file: i.file,
            line: i.line || 0,
            ruleId: 'a2a/' + (i.ruleId || 'issue'),
            message: i.message,
            severity: i.severity || 'warning'
          };
        })
      };
```

### Error Handling

A2A errors are surfaced as issues with `ruleId: a2a/error`:

| Error | When |
|-------|------|
| `A2ATimeoutError` | Task didn't complete within `timeout` |
| `A2AMaxTurnsExceededError` | Conversation exceeded `max_turns` |
| `A2AInputRequiredError` | Agent needs input but `max_turns` exhausted |
| `A2AAuthRequiredError` | Agent requires authentication credentials |
| `A2ATaskFailedError` | Task execution failed on the remote agent |
| `A2ATaskRejectedError` | Task was rejected or canceled |
| `A2ARequestError` | HTTP request to the agent failed |
| `AgentCardFetchError` | Failed to fetch Agent Card |
| `InvalidAgentCardError` | Agent Card is malformed |

---

## Task Management CLI

Monitor and manage A2A tasks with `visor tasks`:

```bash
visor tasks                                    # List all tasks (alias for list)
visor tasks list                               # List tasks
visor tasks list --state working               # Filter by state
visor tasks list --agent security-review       # Filter by workflow
visor tasks list --limit 50                    # Show more results
visor tasks list --output json                 # JSON output
visor tasks list --watch                       # Live refresh every 2s
visor tasks stats                              # Queue summary statistics
visor tasks stats --output json                # Stats as JSON
visor tasks cancel <task-id>                   # Cancel a running task
visor tasks help                               # Show usage
```

**Flags:**

| Flag | Description | Default |
|------|-------------|---------|
| `--state <state>` | Filter by task state | all |
| `--agent <workflow-id>` | Filter by workflow | all |
| `--limit <n>` | Number of tasks to show | 20 |
| `--output <format>` | Output format: `table`, `json`, `markdown` | table |
| `--watch` | Refresh every 2 seconds | off |

---

## Configuration Reference

### Server-Side: `agent_protocol`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Enable the A2A server |
| `protocol` | string | `"a2a"` | Protocol binding |
| `port` | number | `9000` | HTTP listen port |
| `host` | string | `"0.0.0.0"` | HTTP bind address |
| `public_url` | string | auto | Public URL for Agent Card |
| `agent_card_inline` | object | - | Inline Agent Card definition |
| `agent_card` | string | - | Path to Agent Card JSON file |
| `auth` | object | - | Authentication config |
| `auth.type` | string | - | `bearer`, `api_key`, or `none` |
| `auth.token_env` | string | - | Env var for bearer token |
| `auth.key_env` | string | - | Env var for API key |
| `auth.header_name` | string | `"x-api-key"` | Custom header for API key |
| `auth.param_name` | string | `"api_key"` | Query parameter for API key |
| `skill_routing` | object | - | Map of skill_id to workflow name |
| `default_workflow` | string | - | Fallback workflow for unmatched skills |
| `task_ttl` | string | `"7d"` | Task retention period |
| `queue.poll_interval` | number | `1000` | Queue poll interval in ms |
| `queue.max_concurrent` | number | `5` | Max concurrent task executions |
| `queue.stale_claim_timeout` | number | `300000` | Worker stale claim timeout in ms |
| `tls.cert` | string | - | Path to TLS certificate |
| `tls.key` | string | - | Path to TLS private key |

### Client-Side: `type: a2a` Check Provider

| Key | Type | Default | Required | Description |
|-----|------|---------|----------|-------------|
| `agent_url` | string | - | one of | Direct agent endpoint URL |
| `agent_card` | string | - | one of | URL to Agent Card |
| `message` | string | - | yes | Liquid template for the message text |
| `data` | object | - | no | Liquid-templated structured data parts |
| `files` | array | - | no | File attachments (`url`, `media_type`, `filename`) |
| `auth.scheme` | string | - | no | `bearer` or `api_key` |
| `auth.token_env` | string | - | no | Env var containing auth token |
| `auth.header_name` | string | `"x-api-key"` | no | Custom header for API key |
| `blocking` | boolean | `true` | no | Wait for task completion |
| `timeout` | number | `300000` | no | Max wait time in ms |
| `poll_interval` | number | `2000` | no | Poll interval in ms |
| `max_turns` | number | `1` | no | Max conversation turns |
| `on_input_required` | string | - | no | Liquid template for auto-reply |
| `transform_js` | string | - | no | JavaScript output transformation |
| `accepted_output_modes` | string[] | `["text/plain", "application/json"]` | no | Accepted MIME types |

---

## Examples

### Server: Code Review Agent

Full example from [examples/a2a-agent-example.yaml](../examples/a2a-agent-example.yaml):

```yaml
version: "1.0"

agent_protocol:
  enabled: true
  protocol: a2a
  port: 9000
  host: "0.0.0.0"

  agent_card_inline:
    name: "Code Review Agent"
    description: "AI-powered code review agent built with Visor"
    version: "1.0.0"
    provider:
      organization: "Visor"
    skills:
      - id: security
        name: Security Review
        description: Analyze code for security vulnerabilities (OWASP Top 10)
        tags: [security, owasp]
      - id: performance
        name: Performance Review
        description: Analyze code for performance issues and bottlenecks
        tags: [performance]
    supported_interfaces:
      - url: "http://localhost:9000"
        protocol_binding: "a2a/v1"
    capabilities:
      streaming: false
      push_notifications: false

  auth:
    type: bearer
    token_env: AGENT_AUTH_TOKEN

  skill_routing:
    security: security-review
    performance: performance-review
  default_workflow: general-review

  task_ttl: "7d"
  queue:
    max_concurrent: 5

steps:
  security-review:
    type: ai
    prompt: |
      Perform a security review focusing on OWASP Top 10 vulnerabilities.
      Check for SQL injection, XSS, CSRF, and authentication issues.
    on: [manual]

  performance-review:
    type: ai
    prompt: |
      Review for performance issues: N+1 queries, memory leaks,
      unnecessary allocations, and algorithmic complexity.
    on: [manual]

  general-review:
    type: ai
    prompt: |
      General code quality review: naming, structure, error handling,
      and adherence to project conventions.
    on: [manual]
```

```bash
# Start
visor --a2a --config examples/a2a-agent-example.yaml

# Discover
curl http://localhost:9000/.well-known/agent-card.json | jq .

# Send a task targeting the security skill
curl -X POST http://localhost:9000/message:send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AGENT_AUTH_TOKEN" \
  -d '{
    "message": {
      "message_id": "msg-1",
      "role": "user",
      "parts": [{"text": "Review auth.py for security issues"}],
      "metadata": {"skill_id": "security"}
    }
  }'

# Monitor tasks
visor tasks list --watch
```

### Client: Multi-Agent Composition

Chain multiple A2A agents and aggregate results:

```yaml
steps:
  compliance-scan:
    type: a2a
    agent_url: "http://compliance-agent:9000"
    message: "Check compliance for PR #{{ pr.number }}"
    blocking: true

  security-scan:
    type: a2a
    agent_url: "http://security-agent:9000"
    message: "Security review for PR #{{ pr.number }}"
    blocking: true

  summarize:
    type: ai
    depends_on: [compliance-scan, security-scan]
    prompt: |
      Summarize findings from two agents:
      Compliance: {{ outputs["compliance-scan"] | json }}
      Security: {{ outputs["security-scan"] | json }}
```

### Multi-Turn Conversation

Handle agents that ask follow-up questions:

```yaml
steps:
  interactive-review:
    type: a2a
    agent_card: "https://agent.example.com/.well-known/agent-card.json"
    message: "Analyze {{ pr.title }} for best practices"
    max_turns: 3
    on_input_required: |
      Here is additional context:
      {{ pr.body }}
    transform_js: |
      return {
        issues: (output.issues || []).map(function(i) {
          return {
            file: i.file,
            line: i.line || 0,
            ruleId: 'a2a/' + (i.ruleId || 'issue'),
            message: i.message,
            severity: i.severity || 'warning'
          };
        })
      };
```

---

## Security Considerations

- **Always configure auth for production** — without it, anyone can submit tasks to your agent
- **Use `token_env` / `key_env`** — never hardcode tokens in config files
- **Enable TLS** for public-facing servers
- **Agent Card is public** — it's served without auth, so don't include sensitive information
- **Task TTL** — set appropriate retention to limit stored data (`task_ttl: "7d"`)
- **Token comparison** uses timing-safe comparison to prevent timing attacks

---

## Debugging

```bash
# Start with debug logging
visor --a2a --debug --config .visor.yaml

# Verify Agent Card is served correctly
curl http://localhost:9000/.well-known/agent-card.json | jq .

# Monitor live task queue
visor tasks list --watch

# Check queue statistics
visor tasks stats

# View specific task
visor tasks list --state failed    # Find failed tasks
```

With OpenTelemetry enabled, A2A tasks emit spans with:
- `agent.task.id` — Task ID
- `agent.task.state` — Current state
- `agent.task.workflow_id` — Target workflow

---

## Related Documentation

- [MCP Provider](./mcp-provider.md) — MCP tool integration (complementary to A2A)
- [HTTP Integration](./http.md) — HTTP server and webhooks
- [Workflows](./workflows.md) — Reusable workflow definitions
- [Configuration](./configuration.md) — Configuration reference
- [Architecture](./architecture.md) — System architecture overview
- [Security](./security.md) — Security best practices
- [Debugging](./debugging.md) — Debugging techniques
- [RFC: A2A Protocol Support](../rfc/001-a2a-protocol-support.md) — Design document
