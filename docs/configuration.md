## ⚙️ Configuration & Extends

Use `.visor.yaml` to add/override workflow steps in your repo and extend shared configurations. Visor's merge logic makes it flexible for teams and orgs.

> **Note on Terminology**: Visor now uses `steps:` instead of `checks:` in configuration files to better reflect its workflow orchestration capabilities. Both keys work identically for backward compatibility, but `steps:` is recommended for new configurations.

### Validating Configuration

Before running checks, validate your configuration file to catch errors early:

```bash
# Validate default config location (.visor.yaml)
visor validate

# Validate specific config file
visor validate --config .visor.yaml

# Validate example configs
visor validate --config examples/enhanced-config.yaml
```

The `validate` command checks for:
- **Missing required fields** (e.g., `version`)
- **Invalid check types** (see [Check Types](#check-types) below)
- **Invalid event triggers** (e.g., `scheduled` should be `schedule`)
- **Incorrect field names** and typos
- **Schema compliance** for all configuration options

### Check Types

Visor supports the following check types:

| Type | Description | Documentation |
|------|-------------|---------------|
| `ai` | AI-powered analysis using LLMs | [AI Configuration](./ai-configuration.md) |
| `claude-code` | Claude Code SDK integration | [Claude Code](./claude-code.md) |
| `command` | Execute shell commands | [Command Provider](./command-provider.md) |
| `script` | Custom JavaScript logic | [Script](./script.md) |
| `http` | Send HTTP requests (output) | [HTTP Integration](./http.md) |
| `http_input` | Receive webhooks | [HTTP Integration](./http.md) |
| `http_client` | Fetch data from APIs | [HTTP Integration](./http.md) |
| `mcp` | MCP tool execution | [MCP Provider](./mcp-provider.md) |
| `memory` | Key-value storage operations | [Memory](./memory.md) |
| `workflow` | Reusable workflow invocation | [Workflows](./workflows.md) |
| `git-checkout` | Git repository checkout | [Git Checkout](./providers/git-checkout.md) |
| `human-input` | Request user input | [Human Input](./human-input-provider.md) |
| `github` | GitHub API operations | See [Native GitHub Provider](#native-github-provider) |
| `log` | Debug logging | [Debugging](./debugging.md) |
| `noop` | No-operation (for routing) | Used for control flow |

### Criticality and Contracts

Steps can declare their operational criticality, which drives default safety policies for contracts, retries, and loop budgets. See the [Criticality Modes Guide](./guides/criticality-modes.md) for complete documentation.

```yaml
steps:
  post-comment:
    type: github
    criticality: external   # external | internal | policy | info
    op: comment.create

    # Preconditions - must hold before execution
    assume:
      - "outputs['permission-check'].allowed === true"
      - "env.DRY_RUN !== 'true'"

    # Postconditions - assertions about produced output
    guarantee:
      - "output && typeof output.id === 'number'"

    # Other step configuration...
```

#### Criticality Levels

| Level | Description | Use When |
|-------|-------------|----------|
| `external` | Mutates external systems (GitHub, HTTP POST, etc.) | Step has side effects outside the engine |
| `internal` | Steers execution (forEach, routing, flags) | Step controls workflow routing |
| `policy` | Enforces permissions/compliance | Step gates external actions |
| `info` | Read-only, non-critical | Pure computation, safe to fail |

#### Contracts: assume and guarantee

- **`assume`**: Preconditions that must hold before execution. If false, the step is skipped (skipReason='assume').
- **`guarantee`**: Postconditions about the produced output. Violations are recorded as error issues with ruleId "contract/guarantee_failed".

```yaml
steps:
  critical-step:
    type: http
    criticality: external
    url: "https://api.example.com/deploy"
    method: POST

    # Only run if authenticated and not in dry-run mode
    assume:
      - "env.API_TOKEN"
      - "env.DRY_RUN !== 'true'"

    # Verify the response is valid
    guarantee:
      - "output && output.status === 'success'"
      - "output.deployment_id !== undefined"

    schema: plain
```

**Best Practices:**
- Use `assume` for pre-execution prerequisites (env/memory/upstream), not for checking this step's output
- Use `guarantee` for assertions about this step's produced output (shape, values, invariants)
- Use `fail_if` for policy/threshold decisions
- Keep expressions deterministic (no time/random/network)

Example validation output:
```
🔍 Visor Configuration Validator

📂 Validating configuration: .visor.yaml

✅ Configuration is valid!

📋 Summary:
   Version: 1.0
   Checks: 5

📝 Configured checks:
   • security (type: ai)
   • performance (type: ai)
   • style (type: command)
   • notify (type: http)
   • monitor (type: http_input)
```

If there are errors, you'll get detailed messages with hints:
```
❌ Configuration validation failed!

Error: Invalid check type "webhook". Must be: ai, claude-code, mcp, command, script, http, http_input, http_client, memory, noop, log, github, human-input, workflow, git-checkout

💡 Hint: The 'webhook' type has been renamed to 'http' for output and 'http_input' for input.
```

### Check-Level AI Configuration

Override global AI settings at the check level:

```yaml
# Global AI settings (optional)
ai_provider: anthropic  # or google, openai, bedrock
ai_model: claude-3-sonnet

steps:
  performance-review:
    type: ai
    ai:
      provider: google
      model: gemini-1.5-pro
    prompt: "Analyze performance metrics and provide optimization suggestions"

  security-review:
    type: ai
    ai_provider: bedrock  # Use AWS Bedrock for this step
    ai_model: anthropic.claude-sonnet-4-20250514-v1:0
    prompt: "Analyze code for security vulnerabilities"
```

### Lifecycle Hooks

Use `on_init` to run preprocessing tasks before a step executes:

```yaml
steps:
  ai-review:
    type: ai
    on_init:
      run:
        - tool: fetch-jira-issue
          with:
            issue_key: "{{ pr.title | regex_search: '[A-Z]+-[0-9]+' }}"
          as: jira-data
    prompt: |
      Review this PR considering JIRA issue context:
      {{ outputs['jira-data'] | json }}
```

See [Lifecycle Hooks](./lifecycle-hooks.md) for complete documentation.

### Environment Variables

Inject environment variables globally or per-check via `env`:

```yaml
# Global environment variables
env:
  OPENAI_API_KEY: "${{ env.OPENAI_API_KEY }}"
  ANTHROPIC_API_KEY: "${{ env.ANTHROPIC_API_KEY }}"
  GOOGLE_API_KEY: "${{ env.GOOGLE_API_KEY }}"
  # AWS Bedrock credentials
  AWS_ACCESS_KEY_ID: "${{ env.AWS_ACCESS_KEY_ID }}"
  AWS_SECRET_ACCESS_KEY: "${{ env.AWS_SECRET_ACCESS_KEY }}"
  AWS_REGION: "${{ env.AWS_REGION }}"
  SLACK_WEBHOOK: "${{ env.SLACK_WEBHOOK }}"

steps:
  custom-notify:
    type: http
    url: "https://hooks.slack.com/services/..."
    method: POST
    body: |
      { "text": "Build complete for {{ pr.title }}" }
    env:
      SLACK_WEBHOOK: "${{ env.SLACK_WEBHOOK }}"

  custom-ai-step:
    type: ai
    ai_provider: anthropic
    ai_model: claude-3-opus
    env:
      ANTHROPIC_API_KEY: "${{ env.ANTHROPIC_API_KEY }}"
    prompt: |
      Analyze with Anthropic using env-provided credentials
```

#### Environment Variable Syntax

- `${{ env.NAME }}` or `${NAME}` reference process env vars
- Missing variables resolve to empty strings (validated at runtime)
- Works in both global and per-check `env` blocks

```yaml
env:
  NODE_ENV: "${{ env.NODE_ENV }}"
  FEATURE_FLAGS: "${FEATURE_FLAGS}"

steps:
  example:
    type: ai
    prompt: |
      Environment: ${{ env.NODE_ENV }}
      Features: ${{ env.FEATURE_FLAGS }}
```

### Configuration Inheritance with `extends`

Build on existing configs and share standards:

```yaml
# .visor.yaml - project config
extends: ./base-config.yaml  # Single extend

# OR multiple extends (merged left-to-right)
extends:
  - default                   # Built-in defaults
  - ./team-standards.yaml     # Team standards
  - ./project-specific.yaml   # Project overrides

steps:
  my-custom-check:
    type: ai
    prompt: "Project-specific analysis..."
```

#### Example: Team Configuration

team-config.yaml
```yaml
version: "1.0"
ai_provider: openai
ai_model: gpt-4

steps:
  security-scan:
    type: ai
    prompt: "Perform security analysis following OWASP guidelines"
    on: [pr_opened, pr_updated]

  code-quality:
    type: ai
    prompt: "Check code quality and best practices"
    on: [pr_opened, pr_updated]
```

project-config.yaml
```yaml
extends: ./team-config.yaml

ai_model: gpt-4-turbo  # Override team default

steps:
  code-quality:
    on: []  # Disable a check

  performance-check:
    type: ai
    prompt: "Analyze performance implications"
    on: [pr_opened]
```

#### Remote Configuration (with Security)

Explicitly allow remote URLs for `extends`:

```bash
visor --check all \
  --allowed-remote-patterns "https://github.com/myorg/,https://raw.githubusercontent.com/myorg/"
```

Then reference in config:
```yaml
extends: https://raw.githubusercontent.com/myorg/configs/main/base.yaml
```

#### Security Features
1. Path traversal protection for local files
2. URL allowlist for remote configs (empty by default)
3. Disable remote extends entirely with `--no-remote-extends`

#### Merge Behavior
- Simple values: child overrides parent
- Objects: deep merge
- Arrays: replaced entirely
- Checks: disable with `on: []`

### Appending to Prompts with `appendPrompt`

```yaml
extends: ./base-config.yaml

steps:
  security-review:
    appendPrompt: "Also check for SQL injection and hardcoded secrets"
```

Notes:
- `appendPrompt` is joined with parent `prompt` via double newline
- If no parent `prompt`, `appendPrompt` becomes the prompt
- Use `prompt` to replace entirely

### Priority Order

1. Check-level settings (highest)
2. Current file configuration
3. Extended configurations (left → right)
4. Global configuration
5. Environment variables
6. Defaults (lowest)

### Production Environment Setup

```bash
export OPENAI_API_KEY="sk-your-openai-key"
export ANTHROPIC_API_KEY="sk-ant-your-anthropic-key"
export GOOGLE_API_KEY="your-google-api-key"
export GITHUB_TOKEN="ghp_your-github-token"
export SECURITY_MODEL="claude-3-opus"
export PERFORMANCE_MODEL="gpt-4-turbo"
export PREFERRED_AI_PROVIDER="anthropic"
export ANALYSIS_TIMEOUT="60000"
```

Reference from config:

```yaml
env:
  OPENAI_KEY: "${{ env.OPENAI_API_KEY }}"
  ANTHROPIC_KEY: "${{ env.ANTHROPIC_API_KEY }}"
  GITHUB_ACCESS_TOKEN: "${{ env.GITHUB_TOKEN }}"

steps:
  production-security:
    type: ai
    ai_model: "${{ env.SECURITY_MODEL }}"
    ai_provider: "${{ env.PREFERRED_AI_PROVIDER }}"
    env:
      API_KEY: "${{ env.ANTHROPIC_KEY }}"
      TIMEOUT: "${{ env.ANALYSIS_TIMEOUT }}"
    prompt: |
      Production security analysis with ${{ env.ANALYSIS_TIMEOUT }}ms timeout
```

### Native GitHub Provider

Use `type: github` to perform labels/comments via GitHub API (Octokit). This avoids shelling out to `gh` and supports safe label sanitization.

Keys:
- `op`: one of `labels.add`, `labels.remove`, `comment.create`.
- `values`/`value`: string or array to pass to the op (e.g., label names or comment lines). Empty strings are ignored automatically.
- `value_js` (optional): JavaScript snippet to compute values dynamically. Not required for filtering empties.

Example:
```yaml
steps:
  apply-overview-labels:
    type: github
    tags: [github]
    depends_on: [overview]
    on: [pr_opened, pr_updated]
    op: labels.add
    values:
      - "{{ outputs.overview.tags.label | default: '' | safe_label }}"
      - "{{ outputs.overview.tags['review-effort'] | default: '' | prepend: 'review/effort:' | safe_label }}"
```

Notes:
- Requires `GITHUB_TOKEN` (or `github-token` Action input) and `GITHUB_REPOSITORY` in environment.
- Use Liquid `safe_label` / `safe_label_list` to constrain labels to `[A-Za-z0-9:/\- ]` (alphanumerics, colon, slash, hyphen, and space).
- Provider errors surface as issues (e.g., `github/missing_token`, `github/op_failed`) and won't abort the whole run.

### Additional Configuration Options

The following global configuration options are available and documented in detail in their respective guides:

| Option | Description | Documentation |
|--------|-------------|---------------|
| `max_parallelism` | Maximum number of checks to run in parallel (default: 3) | [Performance](./performance.md) |
| `fail_fast` | Stop execution when any check fails (default: false) | [Performance](./performance.md) |
| `fail_if` | Global failure condition expression | [Fail If](./fail-if.md) |
| `tag_filter` | Filter checks by tags (include/exclude) | [Tag Filtering](./tag-filtering.md) |
| `routing` | Global routing defaults for retry/goto policies | [Failure Routing](./failure-routing.md) |
| `limits` | Global execution limits (max_runs_per_check, max_workflow_depth) | [Limits](./limits.md) |
| `tools` | Custom tool definitions for MCP blocks | [Custom Tools](./custom-tools.md) |
| `imports` | Import workflow definitions from external files | [Workflows](./workflows.md) |
| `inputs`/`outputs` | Workflow input/output definitions | [Workflows](./workflows.md) |
| `http_server` | HTTP server for receiving webhooks | [HTTP Integration](./http.md) |
| `memory` | Memory storage configuration | [Memory](./memory.md) |
| `output` | Output configuration (PR comments, file comments) | [Output Formats](./output-formats.md) |
| `sandbox` | Default sandbox name for all steps | [Sandbox Engines](./sandbox-engines.md) |
| `sandboxes` | Named sandbox definitions (Docker, Bubblewrap, Seatbelt) | [Sandbox Engines](./sandbox-engines.md) |
| `workspace` | Workspace isolation configuration | [Workspace Isolation RFC](./rfc/workspace-isolation.md) |

Example combining several options:

```yaml
version: "1.0"

max_parallelism: 5
fail_fast: true

tag_filter:
  include: [security, performance]
  exclude: [experimental]

limits:
  max_runs_per_check: 50
  max_workflow_depth: 3

routing:
  max_loops: 10
  defaults:
    on_fail:
      retry:
        max: 2
        backoff:
          mode: exponential
          delay_ms: 1000

steps:
  # ... your step definitions
```
