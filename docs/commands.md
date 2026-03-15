# Visor Commands

This document covers both the CLI commands and PR comment commands available in Visor.

## CLI Commands

The main entry point is the `visor` command. Run `visor --help` to see all available options.

### Main Command

```bash
visor [options]
```

Run configured checks against the current repository. Without any options, Visor will discover and load configuration from `.visor.yaml` in the project root.

### Subcommands

#### `visor validate` / `visor lint`

Validate a Visor configuration file without running checks.

```bash
visor validate --config path/to/config.yaml
visor lint --config .visor.yaml
```

#### `visor test`

Run the Visor test framework for testing workflows.

```bash
visor test [path] [options]
```

**Options:**
- `--config <path>` - Path to test suite file, directory, or glob pattern
- `--only <name>` - Run only tests matching this name (supports `CASE` or `CASE#STAGE`)
- `--bail` - Stop on first failure
- `--list` - List discovered tests without running them
- `--validate` - Validate test files without running them
- `--json <path>` - Write JSON report to path (use `-` for stdout)
- `--report junit:<path>` - Write JUnit XML report
- `--summary md:<path>` - Write Markdown summary
- `--max-parallel <n>` - Maximum parallel test cases per suite
- `--max-suites <n>` - Maximum parallel test suites
- `--no-mocks` - Disable mocks

**Examples:**
```bash
visor test tests/                           # Run all tests in directory
visor test --config tests/my-suite.yaml     # Run specific test suite
visor test --only "my test case"            # Run specific test
visor test --bail --json results.json       # Stop on failure, save JSON report
```

#### `visor code-review` / `visor review`

Run the built-in code review workflow against the current repository.

```bash
visor code-review [options]
visor review [options]
```

This uses the default code-review configuration from `defaults/code-review.yaml`.

#### `visor build`

Run the agent builder workflow to create or modify Visor agents.

```bash
visor build <path/to/agent.yaml> [options]
```

**Example:**
```bash
visor build agents/my-agent.yaml --message "Add error handling"
```

#### `visor config`

Manage configuration snapshots. Visor automatically snapshots resolved configuration at startup and on each reload, keeping the most recent 3 snapshots in `.visor/config.db`.

```bash
visor config <command> [options]
```

**Subcommands:**
- `snapshots` - List all configuration snapshots
- `show <id>` - Print the full YAML of a snapshot
- `diff <id_a> <id_b>` - Show unified diff between two snapshots
- `restore <id> --output <path>` - Write snapshot YAML to a file

**Examples:**
```bash
visor config snapshots                         # List saved snapshots
visor config show 1                            # Print full YAML of snapshot 1
visor config diff 1 2                          # Unified diff between snapshots
visor config restore 1 --output restored.yaml  # Restore snapshot to file
```

#### `visor mcp-server`

Start Visor as an MCP (Model Context Protocol) server. Supports local stdio transport (default) and remote HTTP transport with authentication and TLS.

```bash
visor mcp-server [options]
```

**Options:**
- `--config <path>` - Configuration file path
- `--mcp-tool-name <name>` - Custom tool name for the MCP server
- `--mcp-tool-description <desc>` - Custom tool description
- `--transport <stdio|http>` - Transport type (default: `stdio`)
- `--port <number>` - Port for HTTP transport (default: `8080`)
- `--host <address>` - Bind address for HTTP transport (default: `0.0.0.0`)
- `--auth-token <token>` - Bearer token for HTTP authentication
- `--auth-token-env <var>` - Environment variable name containing the Bearer token
- `--tls-cert <path>` - Path to TLS certificate PEM file
- `--tls-key <path>` - Path to TLS private key PEM file

> **Note:** HTTP transport requires `--auth-token` or `--auth-token-env` — the server refuses to start without authentication to prevent accidental unauthenticated exposure.

**Examples:**
```bash
# Local stdio (default, for Claude Desktop / Claude Code)
visor mcp-server

# Fixed workflow via stdio
visor mcp-server --config defaults/code-review.yaml

# Remote HTTP with direct token
visor mcp-server --transport http --port 8080 --auth-token "my-secret-token"

# Remote HTTP with token from env var
VISOR_MCP_TOKEN=secret visor mcp-server --transport http --auth-token-env VISOR_MCP_TOKEN

# HTTPS with TLS certificates
visor mcp-server --transport http --port 443 \
  --tls-cert /path/to/cert.pem --tls-key /path/to/key.pem \
  --auth-token-env VISOR_MCP_TOKEN

# Fixed workflow + remote HTTP
visor mcp-server --transport http --config defaults/code-review.yaml \
  --mcp-tool-name code_review --auth-token-env VISOR_MCP_TOKEN
```

#### `visor tasks`

Monitor and manage A2A agent tasks.

```bash
visor tasks [command] [options]
```

**Subcommands:**
- `list` (default) — List tasks with optional filters
- `stats` — Queue summary statistics
- `cancel <task-id>` — Cancel a running task
- `help` — Show usage

**Options:**
- `--state <state>` — Filter by state: `submitted`, `working`, `completed`, `failed`, `canceled`
- `--agent <workflow-id>` — Filter by workflow
- `--limit <n>` — Number of tasks to show (default: 20)
- `--output <format>` — Output format: `table` (default), `json`, `markdown`
- `--watch` — Live refresh every 2 seconds

**Examples:**
```bash
visor tasks                                  # List all tasks
visor tasks list --state working             # Show only working tasks
visor tasks list --agent security-review     # Tasks for a specific workflow
visor tasks list --output json               # JSON output
visor tasks list --watch                     # Live monitoring
visor tasks stats                            # Queue summary
visor tasks stats --output json              # Stats as JSON
visor tasks cancel abc123                    # Cancel a task
```

### Common CLI Options

#### Check Selection
- `-c, --check <type>` - Specify check type (can be used multiple times)

#### Output Options
- `-o, --output <format>` - Output format: `table` (default), `json`, `markdown`, `sarif`
- `--output-file <path>` - Write output to file instead of stdout

#### Configuration
- `--config <path>` - Path to configuration file

#### Execution Control
- `--timeout <ms>` - Timeout for operations (default: 1200000ms / 30 minutes)
- `--max-parallelism <count>` - Maximum parallel checks (default: 3)
- `--fail-fast` - Stop execution on first failure

#### Tag Filtering
- `--tags <tags>` - Include checks with these tags (comma-separated)
- `--exclude-tags <tags>` - Exclude checks with these tags (comma-separated)

See [Tag Filtering](tag-filtering.md) for detailed tag filtering documentation.

#### Verbosity
- `--debug` - Enable debug mode with detailed output
- `-v, --verbose` - Increase verbosity (without full debug)
- `-q, --quiet` - Reduce verbosity to warnings and errors

#### Code Context
- `--enable-code-context` - Force include code diffs in analysis
- `--disable-code-context` - Force exclude code diffs from analysis
- `--analyze-branch-diff` - Analyze diff vs base branch (auto-enabled for code-review schemas)

#### Event Simulation
- `--event <type>` - Simulate GitHub event: `pr_opened`, `pr_updated`, `issue_opened`, `issue_comment`, `manual`, `all`

#### Interactive Mode
- `--tui` - Enable interactive TUI (chat + logs tabs)
- `--message <text>` - Message for human-input checks (inline text or file path)

#### Debug Server
- `--debug-server` - Start debug visualizer server for live execution visualization
- `--debug-port <port>` - Port for debug server (default: 3456)

#### Workspace Options
- `--keep-workspace` - Keep workspace folders after execution (for debugging)
- `--workspace-path <path>` - Workspace base path
- `--workspace-here` - Place workspace under current directory
- `--workspace-name <name>` - Workspace directory name
- `--workspace-project-name <name>` - Main project folder name inside workspace

#### Config Reloading
- `--watch` - Watch config file for changes and reload automatically (requires `--config`). Also reloads on `SIGUSR2` signal (non-Windows). Intended for long-running modes like `--slack`.

#### GitHub Authentication
- `--github-token <token>` - GitHub token for API operations (env: `GITHUB_TOKEN`)
- `--github-app-id <id>` - GitHub App ID (env: `GITHUB_APP_ID`)
- `--github-private-key <key>` - GitHub App private key, PEM content or file path (env: `GITHUB_APP_PRIVATE_KEY`)
- `--github-installation-id <id>` - GitHub App installation ID, auto-detected if omitted

See [GitHub Authentication](github-auth.md) for setup guide and details.

#### Agent Protocol
- `--a2a` - Enable A2A Agent Protocol server mode (see [A2A Provider](a2a-provider.md))

#### Other Options
- `--slack` - Enable Slack Socket Mode runner
- `--mode <mode>` - Run mode: `cli` (default) or `github-actions`
- `--no-remote-extends` - Disable loading configurations from remote URLs
- `--allowed-remote-patterns <patterns>` - Comma-separated list of allowed URL prefixes for remote config extends

### Examples

```bash
# Run all configured checks
visor

# Run specific check types
visor --check security --check performance

# Output as JSON to file
visor --output json --output-file results.json

# Run with 5 minute timeout and 5 parallel checks
visor --timeout 300000 --max-parallelism 5

# Run only checks tagged as 'local' or 'fast'
visor --tags local,fast

# Run security checks but skip slow ones
visor --tags security --exclude-tags slow

# Enable debug mode with markdown output
visor --debug --output markdown

# Generate SARIF report
visor --output sarif > results.sarif

# Interactive TUI mode
visor --tui

# Debug visualizer
visor --debug-server --debug-port 3456

# Slack mode with live config reloading
visor --slack --config .visor.yaml --watch

# Reload config at runtime via signal (non-Windows)
kill -USR2 <visor-pid>

# List config snapshots and diff changes
visor config snapshots
visor config diff 1 2
```

---

## PR Comment Commands

When Visor is configured as a GitHub Action, it responds to slash commands in PR comments.

### Built-in Commands

#### `/help`

Show available commands and their descriptions.

```
/help
```

Displays a help message listing all configured custom commands plus built-in commands.

#### `/status`

Show current PR status and metrics.

```
/status
```

Displays information about the current state of the pull request.

### Custom Commands

Custom commands are configured via the `command` property in check definitions within your `.visor.yaml` file.

**Example configuration:**

```yaml
checks:
  security-review:
    type: ai
    command: review-security
    prompt: "Review this code for security issues"

  performance-check:
    type: ai
    command: check-perf
    prompt: "Analyze performance implications"
```

With the above configuration, the following commands become available in PR comments:

- `/review-security` - Runs the security-review check
- `/check-perf` - Runs the performance-check check

When a user comments `/help` on a PR, they'll see these custom commands listed along with which checks they trigger.

### Command Behavior

- Commands are **case-insensitive** (`/Help` and `/help` both work)
- Commands must start with a forward slash (`/`)
- Unrecognized commands are ignored
- Commands can only be used in PR comments when Visor is running as a GitHub Action

---

## Related Documentation

- [Configuration](configuration.md) - Full configuration reference
- [Tag Filtering](tag-filtering.md) - Filter checks by tags
- [CI/CLI Mode](ci-cli-mode.md) - Running Visor in CI environments
- [Debug Visualizer](debug-visualizer.md) - Interactive debugging
- [Event Triggers](event-triggers.md) - Configuring when checks run
