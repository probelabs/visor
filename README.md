<div align="center">
  <img src="site/visor.png" alt="Visor Logo" width="500" />

  # Visor — AI workflow engine for code review, assistants & automation

  [![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue)](https://www.typescriptlang.org/)
  [![Node](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/)
  [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

  Orchestrate checks, MCP tools, and AI providers with YAML-driven pipelines.
  Runs as GitHub Action, CLI, Slack bot, or HTTP API.
</div>

---

Visor is an open-source workflow engine that lets you define multi-step AI pipelines in YAML. Wire up shell commands, AI providers, MCP tools, HTTP calls, and custom scripts into dependency-aware DAGs — then run them from your terminal, CI, Slack, or an HTTP endpoint.

**What you get out of the box:**

- **YAML-driven pipelines** — define checks, transforms, routing, and AI prompts in a single config file.
- **4 runtime modes** — CLI, GitHub Action, Slack bot, HTTP server — same config, any surface.
- **12+ provider types** — `ai`, `command`, `script`, `mcp`, `http`, `claude-code`, `github`, `memory`, `workflow`, and more.
- **AI orchestration** — multi-provider (Gemini, Claude, OpenAI, Bedrock), session reuse, MCP tool calling, retry & fallback.
- **Execution engine** — dependency DAGs, parallel waves, forEach fan-out, conditional routing, failure auto-remediation.
- **Built-in testing** — YAML-native integration tests with fixtures, mocks, and assertions.

## Table of Contents

- [Quick Start](#-quick-start)
- [Runtime Modes](#-runtime-modes)
- [PR Comment Commands](#-pr-comment-commands)
- [Core Concepts](#-core-concepts)
- [Provider Types](#-provider-types)
- [Orchestration](#-orchestration)
- [AI & MCP](#-ai--mcp)
- [GitHub Provider](#-github-provider)
- [Templating & Transforms](#-templating--transforms)
- [Suppressing Warnings](#-suppressing-warnings)
- [Testing Framework](#-testing-framework)
- [SDK](#-sdk-programmatic-usage)
- [Configuration](#-configuration)
- [Observability](#-observability)
- [Security](#-security)
- [Enterprise Policy Engine](#-enterprise-policy-engine-ee)
- [Further Reading](#-further-reading)
- [Contributing](#-contributing)
- [License](#-license)

**Requirements:** Node.js 18+ (CI runs Node 20).

## 🚀 Quick Start

### Install & Run

```bash
# One-off
npx -y @probelabs/visor@latest --check all --output table

# As a dev dependency
npm i -D @probelabs/visor
npx visor --check all --output json
```

### Minimal Config (`.visor.yaml`)

```yaml
version: "1.0"
steps:
  security:
    type: ai
    prompt: "Identify security issues in changed files"
    tags: ["fast", "security"]

  run-tests:
    type: command
    exec: npm test
    depends_on: [security]

  notify:
    type: http
    method: POST
    url: https://hooks.slack.com/...
    body: '{ "text": "Tests {{ outputs[''run-tests''].status }}" }'
    depends_on: [run-tests]
```

### As a GitHub Action

```yaml
# .github/workflows/visor.yml
name: Visor
on:
  pull_request: { types: [opened, synchronize] }
  issues: { types: [opened] }
  issue_comment: { types: [created] }
permissions:
  contents: read
  pull-requests: write
  issues: write
  checks: write
jobs:
  visor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: probelabs/visor@v1
        env:
          GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
```

> **Tip:** Pin releases for stability with `@v1`. For bleeding-edge, use `@nightly`.

## 🖥️ Runtime Modes

Visor runs the same YAML config across four surfaces:

| Mode | How to run | Best for |
|------|-----------|----------|
| **CLI** | `visor --check all --output table` | Local dev, CI pipelines |
| **GitHub Action** | `uses: probelabs/visor@v1` | PR reviews, issue triage, annotations |
| **Slack bot** | `visor --slack --config .visor.yaml` | Team assistants, ChatOps |
| **HTTP server** | `http_server: { enabled: true, port: 8080 }` | Webhooks, API integrations |

Additional modes:
- **TUI** — interactive chat-style terminal UI: `visor --tui`
- **SDK** — programmatic Node.js API: `import { runChecks } from '@probelabs/visor/sdk'`
- **Scheduler** — cron-based execution with database-backed persistence

```bash
# CLI examples
visor --check all --output table
visor --tags fast,local --max-parallelism 5
visor --analyze-branch-diff                   # PR-style diff analysis
visor --event pr_updated                      # Simulate GitHub events
visor --tui --config ./workflow.yaml          # Interactive TUI
visor --debug-server --debug-port 3456        # Live web debugger
visor config snapshots                        # Config version history
visor validate                                # Validate config
visor test --progress compact                 # Run integration tests
```

**Run modes:** Default is CLI mode everywhere. For GitHub-specific behavior (comments, checks, annotations), run with `--mode github-actions` or set `mode: github-actions` in the Action. Force CLI mode inside Actions with `VISOR_MODE=cli`.

See [docs/commands.md](docs/commands.md) for the full CLI reference.

## 💬 PR Comment Commands

Trigger reviews and assistant actions via comments on PRs or issues:

```
/review                        # Re-run all checks
/review --check security       # Re-run specific check
/visor how does caching work?  # Ask the built-in assistant
```

Learn more: [docs/commands.md](docs/commands.md)

## 🧩 Core Concepts

| Concept | What it is |
|---------|-----------|
| **Step** (or Check) | Unit of work — a shell command, AI call, HTTP request, script, etc. |
| **Provider** | How a step runs: `ai`, `command`, `script`, `mcp`, `http`, `claude-code`, `github`, `memory`, `workflow`, … |
| **depends_on** | Execution order — independents run in parallel, dependents wait. |
| **forEach** | Fan-out — transform output into an array, run dependents per item. |
| **Routing** | `on_fail`, `on_success`, `goto`, `retry` — conditional flow with loop safety. |
| **Transform** | Reshape output with Liquid templates or JavaScript before passing downstream. |
| **Schema** | JSON Schema that validates step output (e.g., `code-review`). |
| **Template** | Renders validated output into Markdown/table for PR comments. |
| **Group** | Which PR comment a step posts into. |
| **Tags** | Label steps and filter with `--tags fast,local`. |
| **Events** | Trigger steps on PRs, issues, comments, webhooks, or cron schedules. |

## 🔌 Provider Types

| Provider | Description | Example use |
|----------|------------|------------|
| `ai` | Multi-provider AI (Gemini, Claude, OpenAI, Bedrock) | Code review, analysis, generation |
| `command` | Shell commands with Liquid templating | Run tests, build, lint |
| `script` | JavaScript in a secure sandbox | Transform data, custom logic |
| `mcp` | MCP tool execution (stdio/SSE/HTTP) | External tool integration |
| `claude-code` | Claude Code SDK with MCP tools | Deep code analysis, refactoring |
| `http` | HTTP output/webhook sender | Notify Slack, trigger CI |
| `http_input` | Webhook receiver | Accept external events |
| `http_client` | HTTP API client | Call external APIs |
| `github` | GitHub operations (labels, comments, checks) | Label PRs, post reviews |
| `memory` | Key-value store (get/set/append/increment) | State across steps |
| `workflow` | Reusable sub-workflows from files/URLs | Compose pipelines |
| `human-input` | Interactive prompts (TUI/Slack) | Approvals, user input |
| `log` / `logger` | Structured logging | Debug, audit trail |
| `noop` | No-op placeholder | Orchestration nodes |
| `git-checkout` | Git operations (clone, checkout, worktree) | Multi-repo workflows |

See [docs/pluggable.md](docs/pluggable.md) for building custom providers.

## ⚙️ Orchestration

### Dependencies & Parallel Execution

Steps without dependencies run in parallel waves. `depends_on` enforces ordering:

```yaml
steps:
  fetch-data:
    type: command
    exec: curl -s https://api.example.com/data

  analyze:
    type: ai
    prompt: "Analyze: {{ outputs['fetch-data'] }}"
    depends_on: [fetch-data]

  report:
    type: command
    exec: 'echo "Done: {{ outputs[''analyze''] | truncate: 100 }}"'
    depends_on: [analyze]
```

### forEach Fan-Out

Transform output into an array, run dependents once per item:

```yaml
steps:
  list-services:
    type: command
    exec: 'echo ''["auth","payments","notifications"]'''
    forEach: true

  check-service:
    type: command
    exec: 'curl -s https://{{ outputs["list-services"] }}/health'
    depends_on: [list-services]
```

Use `outputs_raw` in downstream steps to access the aggregated array of all forEach results:

```yaml
  summarize:
    type: script
    depends_on: [list-services]
    content: |
      const arr = outputs_raw['list-services'] || [];
      return { total: arr.length };
```

Learn more: [docs/foreach-dependency-propagation.md](docs/foreach-dependency-propagation.md)

### Failure Routing & Auto-Remediation

Steps can retry, run remediation, or jump to other steps on failure:

```yaml
version: "2.0"
routing:
  max_loops: 5
steps:
  build:
    type: command
    exec: make build
    on_fail:
      retry: { max: 2, backoff: { mode: exponential, delay_ms: 500 } }
      goto: setup            # Jump back on exhausted retries

  deploy:
    type: command
    exec: make deploy
    depends_on: [build]
    on_success:
      run: [notify]          # Run extra steps on success
    on_fail:
      goto_js: |
        return attempt <= 2 ? 'build' : null;  # Dynamic routing
```

Learn more: [docs/failure-routing.md](docs/failure-routing.md)

### Conditional Execution & Author Permissions

```yaml
steps:
  security-scan:
    type: command
    exec: npm audit
    if: "!hasMinPermission('MEMBER')"    # Only for external contributors

  auto-approve:
    type: github
    op: labels.add
    values: ["approved"]
    if: "hasMinPermission('COLLABORATOR') && totalIssues === 0"

  protect-secrets:
    type: command
    exec: echo "Checking permissions..."
    fail_if: "!isMember() && files.some(f => f.filename.startsWith('secrets/'))"
```

Available permission functions: `hasMinPermission(level)`, `isOwner()`, `isMember()`, `isCollaborator()`, `isContributor()`, `isFirstTimer()`.

Learn more: [docs/author-permissions.md](docs/author-permissions.md)

## 🤖 AI & MCP

### Multi-Provider AI

```yaml
steps:
  review:
    type: ai
    prompt: "Review this code for security issues"
    ai:
      provider: anthropic          # or: google, openai, bedrock
      model: claude-sonnet-4-20250514
      fallback:
        strategy: any              # Try other providers on failure
```

Supported providers: **Google Gemini**, **Anthropic Claude**, **OpenAI GPT**, **AWS Bedrock**.

Set one key via environment: `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or AWS credentials.

### MCP Tool Integration

Give AI steps access to MCP tools, or call MCP tools directly:

```yaml
# AI step with MCP tools
steps:
  analyze:
    type: ai
    prompt: "Use the search tool to find security patterns"
    ai:
      mcp_servers:
        - name: code-search
          command: npx
          args: ["-y", "@probe/search"]

# Direct MCP tool execution
  search:
    type: mcp
    transport: stdio
    command: npx
    args: ["-y", "@probe/search"]
    method: search
    arguments:
      query: "{{ outputs['setup'].pattern }}"
```

### AI Session Reuse

Chain AI conversations across steps:

```yaml
steps:
  security:
    type: ai
    prompt: "Find security issues"

  remediation:
    type: ai
    prompt: "Suggest fixes for the issues you found"
    depends_on: [security]
    reuse_ai_session: true          # Carries conversation history
    session_mode: append            # Or: clone (default)
```

### Claude Code Provider

Full Claude Code SDK integration with MCP tools and subagents:

```yaml
steps:
  deep-review:
    type: claude-code
    prompt: "Analyze code complexity and suggest refactoring"
    max_turns: 10
    mcp_servers:
      - name: filesystem
        command: npx
        args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
```

Learn more: [docs/claude-code.md](docs/claude-code.md) · [docs/mcp-provider.md](docs/mcp-provider.md) · [docs/advanced-ai.md](docs/advanced-ai.md)

## 🧰 GitHub Provider

Native GitHub operations (labels, comments, checks) without shelling out to `gh`:

```yaml
steps:
  apply-labels:
    type: github
    op: labels.add
    values:
      - "{{ outputs.overview.tags.label | default: '' | safe_label }}"
    value_js: |
      return values.filter(v => typeof v === 'string' && v.trim().length > 0);
```

Learn more: [docs/github-ops.md](docs/github-ops.md)

## 🧬 Templating & Transforms

### Liquid Templates

Steps can use Liquid templates in prompts, exec commands, HTTP bodies, and more:

```yaml
steps:
  greet:
    type: command
    exec: 'echo "Files changed: {{ files | size }}, branch: {{ branch }}"'

  post-results:
    type: http
    url: https://api.example.com/results
    body: |
      { "issues": {{ outputs["review"] | json }},
        "pr": {{ pr.number }} }
```

Available context: `outputs`, `outputs_raw`, `inputs`, `pr`, `files`, `env`, `memory`, `branch`, `event`, `conversation`.

### JavaScript Transforms

Transform step output before passing to dependents:

```yaml
steps:
  fetch:
    type: command
    exec: 'node -e "console.log(JSON.stringify({items:[1,2,3]}))"'
    transform_js: |
      return output.items.filter(i => i > 1);
```

### Dynamic Routing with JavaScript

```yaml
steps:
  check:
    type: command
    exec: npm test
    on_fail:
      goto_js: |
        if (attempt > 3) return null;   // Give up
        return 'fix-and-retry';         // Jump to remediation
```

Prompts can live in external files with full Liquid variable access:

```yaml
steps:
  overview:
    type: ai
    schema: code-review
    prompt: ./prompts/overview.liquid
```

Learn more: [docs/liquid-templates.md](docs/liquid-templates.md) · [docs/schema-templates.md](docs/schema-templates.md)

## 🔇 Suppressing Warnings

Suppress a specific issue by adding a nearby `visor-disable` comment:

```js
const testPassword = "demo123"; // visor-disable
```

Learn more: [docs/suppressions.md](docs/suppressions.md)

## 🧪 Testing Framework

Write and run integration tests for your Visor config in YAML:

```yaml
# .visor.tests.yaml
tests:
  - name: "Security check finds issues"
    config: .visor.yaml
    steps:
      security:
        mock_output: '{"issues": [{"severity": "high"}]}'
    assertions:
      - step: security
        called: { exactly: 1 }
      - step: security
        output_contains: "high"
```

```bash
visor test --progress compact          # Run tests
visor test --list                      # List test cases
visor test --only "Security*"          # Filter tests
visor test --bail                      # Stop on first failure
```

Docs: [Getting started](docs/testing/getting-started.md) · [DSL reference](docs/testing/dsl-reference.md) · [Fixtures & mocks](docs/testing/fixtures-and-mocks.md) · [Assertions](docs/testing/assertions.md) · [Cookbook](docs/testing/cookbook.md)

## 📦 SDK (Programmatic Usage)

Run Visor programmatically from Node.js:

```ts
import { loadConfig, runChecks } from '@probelabs/visor/sdk';

const config = await loadConfig('.visor.yaml');
const result = await runChecks({
  config,
  checks: Object.keys(config.checks || {}),
  output: { format: 'json' },
});
console.log('Issues:', result.reviewSummary.issues?.length ?? 0);
```

Learn more: [docs/sdk.md](docs/sdk.md)

## 🔧 Configuration

### Config Loading Order
1. CLI `--config` flag
2. `.visor.yaml` in project root
3. Built-in defaults

### Extending Configs

```yaml
extends:
  - default
  - ./team-standards.yaml
  - https://raw.githubusercontent.com/org/policies/main/base.yaml
```

### Dynamic Config Reloading

Long-running modes (Slack, HTTP) support live config reload:

```bash
visor --slack --config .visor.yaml --watch    # Auto-reload on file change
visor config snapshots                        # List config versions
visor config diff 1 2                         # Diff two snapshots
```

### Key Config Options

```yaml
version: "1.0"
max_parallelism: 3            # Concurrent steps
max_ai_concurrency: 3         # Concurrent AI API calls
routing:
  max_loops: 10               # Loop safety limit

http_server:
  enabled: true
  port: 8080
  auth: { bearer_token: "${WEBHOOK_SECRET}" }

telemetry:
  enabled: true
  sink: otlp                  # or: file, console

steps:
  # ... your pipeline
```

Learn more: [docs/configuration.md](docs/configuration.md)

## 👀 Observability

### Output Formats

```bash
visor --output table                          # Terminal-friendly (default)
visor --output json --output-file results.json
visor --output sarif --output-file results.sarif
visor --output markdown
```

### OpenTelemetry Tracing

```yaml
telemetry:
  enabled: true
  sink: otlp
```

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces visor --check all
```

Span hierarchy: `visor.run` → `engine.state.*` → `visor.check.*` → `visor.foreach.item`

### Debug Tools

```bash
visor --debug                                 # Verbose logging
visor --debug-server --debug-port 3456        # Live web visualizer
```

**Quick debugging tips:**

Use `log()` in JavaScript expressions (`if`, `fail_if`, `transform_js`):
```yaml
if: |
  log("Outputs:", outputs);
  outputs["fetch-data"]?.status === "ready"
```

Use the `json` filter in Liquid to inspect objects:
```yaml
type: logger
message: "Outputs: {{ outputs | json }}"
```

**TUI mode** (`visor --tui`): Press `Tab` to switch between Chat and Logs tabs, `q` to exit.

Learn more: [docs/observability.md](docs/observability.md) · [docs/debugging.md](docs/debugging.md) · [docs/debug-visualizer.md](docs/debug-visualizer.md)

## 🔐 Security

- **GitHub App support** for scoped, auditable access
- **Remote extends allowlist** to control external config sources
- **MCP method filtering** — allow/deny lists with wildcards
- **Bash allow/deny patterns** for AI-driven command execution
- **Docker & process sandboxes** for isolated step execution
- **Author permissions** — `hasMinPermission()`, `isMember()`, etc. for role-based logic
- **Environment filtering** — control which env vars steps can access

```bash
visor --no-remote-extends
visor --allowed-remote-patterns "https://raw.githubusercontent.com/myorg/"
```

Learn more: [docs/security.md](docs/security.md) · [docs/author-permissions.md](docs/author-permissions.md)

## 🏢 Enterprise Policy Engine (EE)

> **Enterprise Edition.** Requires a Visor EE license. Contact **hello@probelabs.com**.

OPA-based policy enforcement for gating checks, MCP tools, and AI capabilities:

```yaml
policy:
  engine: local
  rules: ./policies/
  fallback: deny
  roles:
    admin: { author_association: [OWNER] }
    developer: { author_association: [MEMBER, COLLABORATOR] }
```

Learn more: [docs/enterprise-policy.md](docs/enterprise-policy.md)

## 📚 Further Reading

**Guides:**
[CLI commands](docs/commands.md) · [Configuration](docs/configuration.md) · [AI config](docs/ai-configuration.md) · [Dependencies](docs/dependencies.md) · [forEach propagation](docs/foreach-dependency-propagation.md) · [Failure routing](docs/failure-routing.md) · [Liquid templates](docs/liquid-templates.md) · [Schema-template system](docs/schema-templates.md) · [Fail conditions](docs/fail-if.md) · [Timeouts](docs/timeouts.md) · [Execution limits](docs/limits.md) · [Output formats](docs/output-formats.md) · [Output formatting](docs/output-formatting.md) · [HTTP integration](docs/http.md) · [Scheduler](docs/scheduler.md)

**Providers:**
[Command](docs/command-provider.md) · [Script](docs/script.md) · [MCP](docs/mcp-provider.md) · [MCP tools for AI](docs/mcp.md) · [Claude Code](docs/claude-code.md) · [GitHub ops](docs/github-ops.md) · [Custom providers](docs/pluggable.md)

**Operations:**
[GitHub Action reference](docs/action-reference.md) · [Security](docs/security.md) · [Performance](docs/performance.md) · [Observability](docs/observability.md) · [Debugging](docs/debugging.md) · [Debug visualizer](docs/debug-visualizer.md) · [Troubleshooting](docs/troubleshooting.md) · [Suppressions](docs/suppressions.md) · [GitHub checks](docs/GITHUB_CHECKS.md)

**Architecture:**
[Failure conditions schema](docs/failure-conditions-schema.md) · [Failure conditions implementation](docs/failure-conditions-implementation.md)

**Testing:**
[Getting started](docs/testing/getting-started.md) · [DSL reference](docs/testing/dsl-reference.md) · [Flows](docs/testing/flows.md) · [Fixtures & mocks](docs/testing/fixtures-and-mocks.md) · [Assertions](docs/testing/assertions.md) · [Cookbook](docs/testing/cookbook.md) · [CLI & reporters](docs/testing/cli.md) · [CI integration](docs/testing/ci.md) · [Troubleshooting](docs/testing/troubleshooting.md)

**Recipes & examples:**
[Recipes](docs/recipes.md) · [Dev playbook](docs/dev-playbook.md) · [Tag filtering](docs/tag-filtering.md) · [Author permissions](docs/author-permissions.md) · [Session reuse](docs/advanced-ai.md)

## 🤝 Contributing

Learn more: [CONTRIBUTING.md](CONTRIBUTING.md)

## 📄 License

MIT License — see [LICENSE](LICENSE)

---

<div align="center">
  Made with ❤️ by <a href="https://probelabs.com">Probe Labs</a>
</div>
