<div align="center">
  <img src="site/visor.png" alt="Visor Logo" width="500" />
  
  # Visor — Open‑source, configurable code review
  
  [![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue)](https://www.typescriptlang.org/)
  [![Node](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/)
  [![License](https://img.shields.io/badge/license-MIT-blue)]()
  
  Native GitHub checks and annotations. Runs in any CI.
  Configure everything in `.visor.yaml` and templates — no hidden logic.
  Use as an Action or CLI; schedule with cron; react to webhooks.
  AI‑assisted when you want it, predictable when you don’t.
</div>

---

Visor ships with a ready-to-run configuration at `defaults/.visor.yaml`, so you immediately get:
- A staged review pipeline (`overview → security → performance → quality → style`).
- Native GitHub integration: check runs, annotations, and PR comments out of the box.
- Built-in code answering assistant: trigger from any issue or PR comment, for example: `/visor how it works?`.
- A manual release-notes generator you can trigger in tagged release workflows.
- No magic: everything is config‑driven in `.visor.yaml`; prompts and context are visible, templatable, and the code is fully open source.
- Built for scale: composable checks, tag-based profiles, and configuration reuse with local or remote `extends` (allowlisted) for shared, centrally managed policies.

## 🚀 Quick Start

### Table of Contents
- [Quick Start](#-quick-start)
- [Features](#-features)
- [Developer Experience Playbook](#-developer-experience-playbook)
- [Tag-Based Filtering](#-tag-based-check-filtering)
- [PR Comment Commands](#-pr-comment-commands)
- [Suppress Warnings](#-suppressing-warnings)
- [CLI Usage](#-cli-usage)
- [AI Configuration](#-ai-configuration)
- [MCP Support](#-mcp-model-context-protocol-support-for-ai-providers)
- [Step Dependencies](#-step-dependencies--intelligent-execution)
- [Troubleshooting](#-troubleshooting)
- [Security Defaults](#-security-defaults)
- [Performance & Cost](#-performance--cost-controls)
- [Observability](#-observability)
- [Examples & Recipes](#-examples--recipes)
- [Contributing](#-contributing)

### As GitHub Action (Recommended)

Create `.github/workflows/visor.yml`:

```yaml
name: Visor

on:
  # PR reviews: opened (new PR) and synchronize (new commits pushed)
  pull_request:
    types: [opened, synchronize]
  # Issue assistant: triage and help on new issues
  issues:
    types: [opened]
  # Commands: /review (rerun checks) and /visor ... (ask the assistant) via comments
  issue_comment:
    types: [created]

# Minimal permissions Visor needs
permissions:
  contents: read         # Read code, diffs, and .visor.yaml
  pull-requests: write   # Post/update PR comments and reviews
  issues: write          # Comment on issues (assistant via /visor ...)
  checks: write          # Create check runs and annotations

jobs:
  visor:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
      - name: Run Visor
        uses: probelabs/visor@main
        # Optional: Use a GitHub App for custom bot identity/branding and granular org-level permissions
        # (otherwise the default workflow token posts as github-actions[bot]).
        # Uncomment the block below and add secrets if you want your own bot name/avatar:
        # with:
        #   app-id: ${{ secrets.VISOR_APP_ID }}
        #   private-key: ${{ secrets.VISOR_APP_PRIVATE_KEY }}
        #   installation-id: ${{ secrets.VISOR_APP_INSTALLATION_ID }}  # Optional; auto-detected if omitted
        env:
          # Configure exactly one provider (see AI Configuration below)
          GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
          # ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          # OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

The default `GITHUB_TOKEN` already exists in every workflow run, so you do **not** need to create a secret for it. Switch to a GitHub App when you want a dedicated bot identity (custom name/avatar), granular repo/org permissions, or org‑wide deployment.

Events explained: `pull_request` runs automatic PR reviews; `issues` enables the built‑in assistant on new issues; `issue_comment` powers `/review` (rerun checks on PRs) and `/visor ...` (assistant Q&A on issues or PRs).

If you don't commit a `.visor.yaml` yet, Visor automatically loads `defaults/.visor.yaml`, giving your team the full overview → security → performance → quality → style pipeline, native GitHub checks and comments, assistant commands (e.g., `/visor how it works?`), and an optional release‑notes check out of the box.

**Optional GitHub App setup:**
1. [Create a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) with:
   - **Pull requests**: Read & Write
   - **Issues**: Write
   - **Metadata**: Read
2. Generate and store the private key securely.
3. Install the app on the repositories (or org) you want Visor to review.
4. Add secrets for `VISOR_APP_ID`, `VISOR_APP_PRIVATE_KEY`, and optionally `VISOR_APP_INSTALLATION_ID` if you don't want auto-detection.

Visor will now review pull requests automatically in the environments you configure.

#### Advanced Configuration Options

For more control over execution behavior:

```yaml
name: Code Review with Performance Tuning
on: pull_request

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./  # or: probelabs/visor@main
        with:
          max-parallelism: '5'      # Run up to 5 checks in parallel
          fail-fast: 'true'         # Stop on first failure
          checks: 'security,performance'  # Run specific checks only
        env:
          GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
```

### As CLI Tool

```bash
# Install dependencies
npm install

# Build TypeScript sources (required when running from a clone)
npm run build

# Run analysis from the compiled dist bundle
node dist/index.js --cli --check all

# Or use the published package without building
npx @probelabs/visor --check security --output json

# Point to a custom config file
npx @probelabs/visor --config custom.yaml --check all
```

> Tip: `node dist/index.js --cli` forces CLI mode even inside GitHub Action environments. Install the package globally (`npm install --global @probelabs/visor`) if you prefer calling the `visor` binary directly.

## ✨ Features

- **Automated PR Reviews** - Analyzes code changes and posts review comments
- **Schema-Template System** - Flexible data validation with JSON Schema and Liquid templating
- **Group-Based Comments** - Multiple GitHub comments organized by check groups
- **Multiple Check Types** - Security, performance, style, and architecture analysis
- **Flexible Output** - Table, JSON, Markdown, or SARIF format (SARIF emits standard 2.1.0)
- **Step Dependencies** - Define execution order with `depends_on` relationships
- **PR Commands** - Trigger reviews with `/review` comments
- **GitHub Integration** - Creates check runs, adds labels, posts comments
- **Any CI** - Use the CLI in any CI system alongside GitHub Actions
- **Cron & Webhooks** - Schedule recurring checks or trigger from external events
- **Warning Suppression** - Suppress false positives with `visor-disable` comments
- **Tag-Based Filtering** - Run subsets of checks based on tags for different execution profiles

## 🧭 Developer Experience Playbook

- **Start with the shipping defaults** – Copy `dist/defaults/.visor.yaml` (after `npm run build`) or `examples/quick-start-tags.yaml` into your repo as `.visor.yaml`, run `npx @probelabs/visor --check all --debug`, and commit both the config and observed baseline so every contributor shares the same playbook.
- **Treat configuration as code** – Review config edits in PRs, version Liquid prompt templates under `prompts/`, and pin AI provider/model in config to keep reviews reproducible.
- **Roll out checks gradually** – Use tag filters (`local`, `fast`, `critical`) to gate heavier analysis behind branch rules and to stage new checks on a subset of teams before rolling out widely.
- **Secure your credentials** – Prefer GitHub App auth in production for clearer audit trails; fall back to repo `GITHUB_TOKEN` only for sandboxes. Scope AI API keys to review-only projects and rotate them with GitHub secret scanning alerts enabled.
- **Make feedback actionable** – Group related checks, enable `reuse_ai_session` for multi-turn follow-ups, and add `/review --check performance` comment triggers so reviewers can pull deeper insights on demand.
- **Keep suppressions intentional** – Use `visor-disable` sparingly, add context in the adjacent comment, and review `visor-disable-file` entries during quarterly hygiene passes to avoid silencing real regressions.
- **Validate locally before CI** – Reproduce findings with `node dist/index.js --cli --check security --output markdown`, run `npm test` for guardrails, and enable `--fail-fast` in fast lanes to surface blocking issues instantly.

## 📚 Examples & Recipes

- Minimal `.visor.yaml` starter
```yaml
version: "1.0"
checks:
  security:
    type: ai
    schema: code-review
    prompt: "Identify security vulnerabilities in changed files"
```

- Fast local pre-commit hook (Husky)
```bash
npx husky add .husky/pre-commit "npx @probelabs/visor --tags local,fast --output table || exit 1"
```

- Deep dives and integrations
- docs/NPM_USAGE.md – CLI usage and flags
- GITHUB_CHECKS.md – Checks, outputs, and workflow integration
- examples/ – MCP, Jira, and advanced configs

## 🤝 Contributing

- Requirements: Node.js 18+ (20 recommended) and npm.
- Install and build: `npm install && npm run build`
- Test: `npm test` (watch: `npm run test:watch`, coverage: `npm run test:coverage`)
- Lint/format: `npm run lint` / `npm run lint:fix` and `npm run format`
- Before opening PRs: run the test suite and ensure README examples remain accurate.

Releases are handled via `scripts/release.sh` and follow semver.

## 🏷️ Tag-Based Check Filtering

Visor supports tagging checks to create flexible execution profiles. This allows you to run different sets of checks in different environments (e.g., lightweight checks locally, comprehensive checks in CI).

### How It Works

1. **Tag your checks** with descriptive labels
2. **Filter execution** using `--tags` and `--exclude-tags` parameters
3. **Dependencies work intelligently** - they use what's available after filtering

### Basic Configuration

```yaml
# .visor.yaml
version: "1.0"

checks:
  # Fast, local security check
  security-quick:
    type: ai
    prompt: "Quick security scan for common vulnerabilities"
    tags: ["local", "fast", "security"]
    on: [pr_opened, pr_updated]

  # Comprehensive security analysis (for CI)
  security-comprehensive:
    type: ai
    prompt: "Deep security analysis with full vulnerability scanning"
    tags: ["remote", "comprehensive", "security", "slow"]
    on: [pr_opened]

  # Performance check that runs everywhere
  performance:
    type: ai
    prompt: "Analyze performance issues"
    tags: ["local", "remote", "performance", "fast"]
    on: [pr_opened, pr_updated]

  # Experimental new check
  ai-architecture:
    type: ai
    prompt: "AI-powered architecture review"
    tags: ["experimental", "architecture", "slow"]
    on: [manual]

  # Report that depends on security checks
  security-report:
    type: noop
    tags: ["reporting", "local", "remote"]
    depends_on: [security-quick, security-comprehensive]
    on: [pr_opened, pr_updated]
```

### CLI Usage

```bash
# Run only fast, local checks (great for pre-commit hooks)
visor --tags local,fast

# Run comprehensive remote checks (for CI/CD)
visor --tags remote,comprehensive

# Run all security-related checks
visor --tags security

# Run everything except slow checks
visor --exclude-tags slow

# Run everything except experimental features
visor --exclude-tags experimental

# Combine filters: Run fast security checks only
visor --tags security,fast

# Run local checks but skip experimental ones
visor --tags local --exclude-tags experimental
```

### GitHub Action Usage

```yaml
name: Code Review with Tags
on: pull_request

jobs:
  # Fast checks on every push
  fast-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: probelabs/visor@main
        with:
          tags: "local,fast"
          exclude-tags: "experimental"
        env:
          GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}

  # Comprehensive checks only on main branch PRs
  comprehensive-review:
    if: github.base_ref == 'main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: probelabs/visor@main
        with:
          tags: "remote,comprehensive"
        env:
          GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
```

### Common Tag Patterns

| Tag | Purpose | Example Use |
|-----|---------|-------------|
| `local` | Checks suitable for local development | Pre-commit hooks, developer testing |
| `remote` | Checks designed for CI/CD environments | GitHub Actions, Jenkins |
| `fast` | Quick checks (< 30 seconds) | Rapid feedback loops |
| `slow` | Time-consuming checks | Nightly builds, release validation |
| `security` | Security-related checks | Security audits |
| `performance` | Performance analysis | Performance testing |
| `style` | Code style and formatting | Linting, formatting |
| `experimental` | Beta/testing features | Opt-in testing |
| `critical` | Must-pass checks | Release gates |
| `comprehensive` | Thorough analysis | Full PR reviews |

### Advanced Examples

#### Environment-Specific Execution

```yaml
# Development environment - fast feedback
development:
  extends: .visor.yaml
  tag_filter:
    include: ["local", "fast"]
    exclude: ["experimental"]

# Staging environment - balanced
staging:
  extends: .visor.yaml
  tag_filter:
    include: ["remote", "security", "performance"]
    exclude: ["experimental"]

# Production environment - comprehensive
production:
  extends: .visor.yaml
  tag_filter:
    include: ["remote", "comprehensive", "critical"]
```

#### Multi-Stage Pipeline

```yaml
# GitHub Actions workflow with progressive checks
name: Progressive Code Review
on: pull_request

jobs:
  stage-1-fast:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: probelabs/visor@main
        with:
          tags: "fast,critical"
          fail-fast: "true"  # Stop if critical issues found

  stage-2-security:
    needs: stage-1-fast
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: probelabs/visor@main
        with:
          tags: "security"
          exclude-tags: "fast"  # Run deeper security checks

  stage-3-comprehensive:
    needs: [stage-1-fast, stage-2-security]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: probelabs/visor@main
        with:
          tags: "comprehensive"
          exclude-tags: "fast,security"  # Run remaining checks
```

#### Dependency-Aware Filtering

When using tags with dependencies, Visor intelligently handles missing dependencies:

```yaml
checks:
  data-validation:
    type: ai
    prompt: "Validate data structures"
    tags: ["local", "data"]

  api-validation:
    type: ai
    prompt: "Validate API contracts"
    tags: ["remote", "api"]

  integration-report:
    type: noop
    tags: ["reporting"]
    depends_on: [data-validation, api-validation]
    # When filtered by "local" tag, only uses data-validation
    # When filtered by "remote" tag, only uses api-validation
    # With no filter, uses both dependencies
```

### Tag Validation Rules

- Tags must start with an alphanumeric character
- Can contain letters, numbers, hyphens, and underscores
- Examples: `local`, `test-env`, `feature_flag`, `v2`
- Invalid: `-invalid`, `@special`, `tag with spaces`

### Best Practices

1. **Use consistent naming conventions** across your organization
2. **Document your tag taxonomy** in your team's documentation
3. **Start simple** - begin with `local`/`remote` or `fast`/`slow`
4. **Avoid over-tagging** - too many tags can be confusing
5. **Use tag combinations** for fine-grained control
6. **Test your tag filters** before deploying to production

## 💬 PR Comment Commands

Add comments to issues or PRs:

- `/review` – Rerun all configured checks on the pull request
- `/review --check security` – Run only security checks
- `/review --check performance` – Run only performance checks
- `/visor how it works?` – Ask the built‑in assistant a question about the code or context
- `/review --help` – Show available review commands

## 🔇 Suppressing Warnings

Visor supports suppressing specific warnings or all warnings in a file using special comments in your code. This is useful for false positives or intentional code patterns that should not trigger warnings.

### Line-Level Suppression

Add `visor-disable` in a comment within ±2 lines of the issue to suppress it:

```javascript
// Example: Suppress a specific warning
function authenticate() {
  const testPassword = "demo123"; // visor-disable
  // This hardcoded password warning will be suppressed
}
```

The suppression works with any comment style:
- `// visor-disable` (JavaScript, TypeScript, C++, etc.)
- `# visor-disable` (Python, Ruby, Shell, etc.)
- `/* visor-disable */` (Multi-line comments)
- `<!-- visor-disable -->` (HTML, XML)

### File-Level Suppression

To suppress all warnings in an entire file, add `visor-disable-file` in the first 5 lines:

```javascript
// visor-disable-file
// All warnings in this file will be suppressed

function insecureCode() {
  eval("user input"); // No warning
  const password = "hardcoded"; // No warning
}
```

### Configuration

The suppression feature is enabled by default. You can disable it in your configuration:

```yaml
# .visor.yaml
version: "1.0"
output:
  suppressionEnabled: false  # Disable suppression comments
  pr_comment:
    format: markdown
    group_by: check
```

### Important Notes

- Suppression comments are **case-insensitive** (`visor-disable`, `VISOR-DISABLE`, `Visor-Disable` all work)
- The comment just needs to contain the suppression keyword as a substring
- When issues are suppressed, Visor logs a summary showing which files had suppressed issues
- Use suppression judiciously - it's better to fix issues than suppress them

### Examples

```python
# Python example
def process_data():
    api_key = "sk-12345"  # visor-disable
    return api_key
```

```typescript
// TypeScript example - suppress within range
function riskyOperation() {
  // visor-disable
  const unsafe = eval(userInput); // Suppressed (within 2 lines)
  processData(unsafe);             // Suppressed (within 2 lines)

  doSomethingElse();
  anotherOperation();              // NOT suppressed (> 2 lines away)
}
```

```go
// Go example - file-level suppression
// visor-disable-file
package main

func main() {
    password := "hardcoded" // All issues suppressed
    fmt.Println(password)
}
```

## 📋 CLI Usage

```bash
visor [options]

Options:
  -c, --check <type>         Check type: security, performance, style, architecture, all
                             Can be used multiple times: --check security --check style
  -o, --output <format>      Output format: table, json, markdown, sarif
                             Default: table
  --config <path>            Path to configuration file
                             Default search: ./.visor.yaml or ./.visor.yml
  --max-parallelism <count>  Maximum number of checks to run in parallel
                             Default: 3
  --fail-fast                Stop execution when any check fails
                             Default: false
  --timeout <ms>             Timeout for check operations in milliseconds
                             Default: 600000ms (10 minutes)
  --debug                    Enable debug mode for detailed output
  --allowed-remote-patterns  Comma-separated list of allowed URL prefixes for remote configs
                             Example: "https://github.com/myorg/,https://raw.githubusercontent.com/"
  --no-remote-extends        Disable remote configuration extends for security
  --version                  Show version
  --help                     Show help

Examples:
  visor --check all                           # Run all checks
  visor --check security --output json        # Security check with JSON output
  visor --check style --check performance     # Multiple specific checks
  visor --check all --max-parallelism 5       # Run up to 5 checks in parallel
  visor --check all --fail-fast               # Stop on first failure
  visor --check all --timeout 300000 --debug  # 5 minute timeout with debug output

  # Using remote configs with security allowlist
  visor --check all --allowed-remote-patterns "https://github.com/myorg/"
```

## 🛠️ Troubleshooting

- Not a git repository or no changes: run inside a Git repo with a diff (PR or local changes), or supply a config that doesn’t require PR context.
- No AI keys configured: Visor falls back to pattern checks. Set `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY` and optionally `MODEL_NAME`.
- Claude Code provider errors: install optional peers `@anthropic/claude-code-sdk` and `@modelcontextprotocol/sdk`, then set `CLAUDE_CODE_API_KEY` or `ANTHROPIC_API_KEY`.
- No PR comments posted: ensure workflow `permissions` include `pull-requests: write`; set `debug: true` (action input) or run `--debug` locally and inspect logs.
- Remote extends blocked: confirm `--no-remote-extends` or `VISOR_NO_REMOTE_EXTENDS=true` is intended; otherwise remove.

## 🔐 Security Defaults

- Use the workflow token by default; prefer a GitHub App for production (bot identity, least-privilege scopes).
- Lock remote configuration: set `VISOR_NO_REMOTE_EXTENDS=true` in CI or pass `--no-remote-extends` to avoid loading external configs.
- Scope AI API keys to a review-only project; rotate regularly and enable GitHub secret scanning alerts.

## ⚡ Performance & Cost Controls

- Cache Node in CI: `actions/setup-node@v4` with `cache: npm` (included in Quick Start).
- Separate fast vs. deep checks via tags: run `local,fast` in PRs, `remote,comprehensive` nightly.
- Increase `max_parallelism` only when not using `reuse_ai_session` between dependent checks.

## 👀 Observability

- Machine-readable output: use `--output json` for pipelines; redirect SARIF for code scanning: `npx @probelabs/visor --check security --output sarif > visor-results.sarif`.
- Verbose logs: set `--debug` (CLI) or `debug: true` in the action input.

## 🤖 AI Configuration

Visor uses AI-powered code analysis to provide intelligent review feedback. Configure one of the following providers:

### Supported AI Providers

| Provider | Environment Variable | Recommended Models |
|----------|---------------------|-------------------|
| Google Gemini | `GOOGLE_API_KEY` | `gemini-2.0-flash-exp` (default), `gemini-1.5-pro` |
| Anthropic Claude | `ANTHROPIC_API_KEY` | `claude-3-opus`, `claude-3-sonnet` |
| OpenAI GPT | `OPENAI_API_KEY` | `gpt-4`, `gpt-4-turbo`, `gpt-3.5-turbo` |

### Setting Up API Keys

#### For GitHub Actions
Add your API key as a repository secret:
1. Go to Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Add one of: `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`
4. (Optional) Add `MODEL_NAME` to specify a model

#### For Local Development
Set environment variables:
```bash
# Using Google Gemini
export GOOGLE_API_KEY="your-api-key"
export MODEL_NAME="gemini-2.0-flash-exp"

# Using Anthropic Claude
export ANTHROPIC_API_KEY="your-api-key"
export MODEL_NAME="claude-3-sonnet"

# Using OpenAI GPT
export OPENAI_API_KEY="your-api-key"
export MODEL_NAME="gpt-4"
```

### Getting API Keys

- **Google Gemini**: [Get API Key](https://makersuite.google.com/app/apikey) (Free tier available)
- **Anthropic Claude**: [Get API Key](https://console.anthropic.com/)
- **OpenAI GPT**: [Get API Key](https://platform.openai.com/api-keys)

### Fallback Behavior

If no API key is configured, Visor will fall back to basic pattern-matching analysis:
- Keyword detection for security issues (e.g., `eval`, `innerHTML`)
- Simple performance checks (nested loops, large files)
- Basic style validation

For best results, configure an AI provider for intelligent, context-aware code review.

### MCP (Model Context Protocol) Support for AI Providers

Visor supports MCP servers for AI providers, enabling enhanced code analysis with specialized tools. MCP servers can provide additional context and capabilities to AI models.

MCP configuration follows the same pattern as AI provider configuration, supporting **global**, **check-level**, and **AI object-level** settings.

#### Global MCP Configuration

Configure MCP servers once globally for all AI checks:

```yaml
# Global configuration
ai_provider: anthropic
ai_model: claude-3-sonnet
ai_mcp_servers:
  probe:
    command: "npx"
    args: ["-y", "@probelabs/probe@latest", "mcp"]
  filesystem:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/project"]

checks:
  security_review:
    type: ai
    prompt: "Review code using available MCP tools"
    # Inherits global MCP servers automatically
```

#### Check-Level MCP Configuration

Override global MCP servers for specific checks:

```yaml
checks:
  performance_review:
    type: ai
    prompt: "Analyze performance using specialized tools"
    ai_mcp_servers:  # Overrides global servers
      probe:
        command: "npx"
        args: ["-y", "@probelabs/probe@latest", "mcp"]
      custom_profiler:
        command: "python3"
        args: ["./tools/performance-analyzer.py"]
```

#### AI Object-Level MCP Configuration

Most specific level - overrides both global and check-level:

```yaml
checks:
  comprehensive_review:
    type: ai
    prompt: "Comprehensive analysis with specific tools"
    ai:
      provider: anthropic
      mcpServers:  # Overrides everything else
        probe:
          command: "npx"
          args: ["-y", "@probelabs/probe@latest", "mcp"]
        github:
          command: "npx"
          args: ["-y", "@modelcontextprotocol/server-github"]
```

#### Available MCP Servers

- **Probe**: Advanced code search and analysis (`@probelabs/probe`)
- **Jira**: Jira Cloud integration for issue management (`@orengrinker/jira-mcp-server`)
- **Filesystem**: File system access (`@modelcontextprotocol/server-filesystem`)
- **GitHub**: GitHub API access (coming soon)
- **Custom**: Your own MCP servers

#### Example Configurations

- [Basic MCP with Probe](examples/ai-with-mcp.yaml) - Code analysis with multiple MCP servers
- [Jira Workflow Automation](examples/jira-workflow-mcp.yaml) - Complete Jira integration examples
- [Simple Jira Analysis](examples/jira-simple-example.yaml) - Basic JQL → analyze → label workflow
- [Setup Guide](examples/JIRA_MCP_SETUP.md) - Detailed Jira MCP configuration instructions

## 📊 Step Dependencies & Intelligent Execution

### Dependency-Aware Check Execution

Visor supports defining dependencies between checks using the `depends_on` field. This enables:

- **Sequential Execution**: Dependent checks wait for their dependencies to complete
- **Parallel Optimization**: Independent checks run simultaneously for faster execution
- **Smart Scheduling**: Automatic topological sorting ensures correct execution order

### Configuration Example

```yaml
version: "1.0"
checks:
  security:
    type: ai
    group: code-review
    schema: code-review
    prompt: "Comprehensive security analysis..."
    tags: ["security", "critical", "comprehensive"]
    on: [pr_opened, pr_updated]
    # No dependencies - runs first

  performance:
    type: ai
    group: code-review
    schema: code-review
    prompt: "Performance analysis..."
    tags: ["performance", "fast", "local", "remote"]
    on: [pr_opened, pr_updated]
    # No dependencies - runs parallel with security

  style:
    type: ai
    group: code-review
    schema: code-review
    prompt: "Style analysis based on security findings..."
    tags: ["style", "fast", "local"]
    on: [pr_opened]
    depends_on: [security]  # Waits for security to complete

  architecture:
    type: ai
    group: code-review
    schema: code-review
    prompt: "Architecture analysis building on previous checks..."
    on: [pr_opened, pr_updated]
    depends_on: [security, performance]  # Waits for both to complete
```

### Execution Flow

With the above configuration:
1. **Level 0**: `security` and `performance` run in parallel
2. **Level 1**: `style` runs after `security` completes
3. **Level 2**: `architecture` runs after both `security` and `performance` complete

### Benefits

- **Faster Execution**: Independent checks run in parallel
- **Better Context**: Later checks can reference findings from dependencies
- **Logical Flow**: Ensures foundational checks (like security) complete before specialized ones
- **Error Handling**: Failed dependencies don't prevent other independent checks from running

### Advanced Patterns

#### Diamond Dependency
```yaml
version: "1.0"
checks:
  foundation:
    type: ai
    group: base
    schema: code-review
    prompt: "Base analysis"
    
  branch_a:
    type: ai
    group: code-review
    schema: code-review
    depends_on: [foundation]
    
  branch_b:
    type: ai
    group: code-review
    schema: code-review
    depends_on: [foundation]
    
  final:
    type: ai
    group: summary
    schema: markdown
    depends_on: [branch_a, branch_b]
```

#### Multiple Independent Chains
```yaml
version: "1.0"
checks:
  # Security chain
  security_basic:
    type: ai
    group: security
    schema: code-review
    prompt: "Basic security scan"
    
  security_advanced:
    type: ai
    group: security
    schema: code-review
    depends_on: [security_basic]
    
  # Performance chain  
  performance_basic:
    type: ai
    group: performance
    schema: code-review
    prompt: "Basic performance scan"
    
  performance_advanced:
    type: ai
    group: performance
    schema: code-review
    depends_on: [performance_basic]
    
  # Final integration (waits for both chains)
  integration:
    type: ai
    group: summary
    schema: markdown
    depends_on: [security_advanced, performance_advanced]
```

### Error Handling

- **Cycle Detection**: Circular dependencies are detected and reported
- **Missing Dependencies**: References to non-existent checks are validated
- **Graceful Failures**: Failed checks don't prevent independent checks from running
- **Dependency Results**: Results from dependency checks are available to dependent checks

## 🤖 Claude Code Provider

Visor includes advanced integration with Claude Code SDK, providing powerful AI-driven code analysis with MCP (Model Context Protocol) tools and subagent support.

### Features

- **Advanced AI Analysis**: Leverages Claude Code's sophisticated understanding
- **MCP Tools**: Built-in and custom tools for specialized analysis
- **Subagents**: Delegate specific tasks to specialized agents
- **Streaming Responses**: Real-time feedback during analysis
- **Flexible Permissions**: Granular control over tool usage

### Configuration

```yaml
checks:
  claude_comprehensive:
    type: claude-code
    prompt: "Perform a comprehensive security and performance review"
    tags: ["comprehensive", "security", "performance", "slow", "remote"]
    claude_code:
      allowedTools: ['Grep', 'Read', 'WebSearch']
      maxTurns: 5
      systemPrompt: "You are an expert security auditor"

  claude_with_mcp:
    type: claude-code
    prompt: "Analyze code complexity and architecture"
    tags: ["architecture", "complexity", "comprehensive", "remote"]
    claude_code:
      allowedTools: ['analyze_file_structure', 'calculate_complexity']
      mcpServers:
        custom_analyzer:
          command: "node"
          args: ["./mcp-servers/analyzer.js"]
          env:
            ANALYSIS_MODE: "deep"
```

### Built-in MCP Tools

- `analyze_file_structure`: Analyzes project organization
- `detect_patterns`: Identifies code patterns and anti-patterns
- `calculate_complexity`: Computes complexity metrics
- `suggest_improvements`: Provides improvement recommendations

### Custom MCP Servers

Create `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "security_scanner": {
      "command": "python",
      "args": ["./tools/security_scanner.py"],
      "env": {
        "SCAN_DEPTH": "full"
      }
    }
  }
}
```

### Environment Setup

```bash
# Install Claude Code CLI (required)
npm install -g @anthropic-ai/claude-code

# Set API key (optional - uses local Claude Code if available)
export CLAUDE_CODE_API_KEY=your-api-key
```

## 🔄 AI Session Reuse

Visor supports AI session reuse for dependent checks, allowing follow-up analysis to maintain conversation context with the AI. This creates more intelligent, contextual analysis workflows.

### How It Works

When `reuse_ai_session: true` is set on a dependent check, Visor:
1. **Reuses the ProbeAgent session** from the parent check
2. **Maintains conversation context** - the AI remembers the previous discussion
3. **Forces sequential execution** - dependent checks with session reuse run sequentially to preserve context
4. **Provides intelligent follow-ups** - the AI can reference previous findings

### Configuration

```yaml
version: "1.0"

checks:
  security:
    type: ai
    group: review
    schema: code-review
    prompt: "Analyze code for security vulnerabilities..."
    on: [pr_opened, pr_updated]

  security-remediation:
    type: ai
    group: review
    schema: code-review
    prompt: |
      Based on our previous security analysis discussion,
      provide detailed remediation guidance for the issues we identified.
    depends_on: [security]
    reuse_ai_session: true  # 🔄 Reuses security check's AI session
    on: [pr_opened, pr_updated]
```

### Key Benefits

- **Context Continuity**: AI remembers previous analysis and can reference it
- **Cost Efficiency**: Reuses existing AI sessions instead of creating new ones
- **Better Analysis**: Follow-up prompts build on previous discussion
- **Natural Conversation Flow**: Creates multi-turn conversations with AI

### Validation Rules

- **Requires Dependencies**: `reuse_ai_session: true` can only be used with `depends_on`
- **Sequential Execution**: Checks with session reuse are automatically scheduled sequentially
- **AI Checks Only**: Only works with `type: ai` checks
- **Clear Error Messages**: Invalid configurations provide helpful guidance

### Example Use Cases

#### Security Analysis + Remediation
```yaml
security:
  type: ai
  prompt: "Identify security vulnerabilities..."

security-fixes:
  type: ai
  prompt: "Based on our security discussion, provide step-by-step fix instructions..."
  depends_on: [security]
  reuse_ai_session: true
```

#### Performance Analysis + Optimization
```yaml
performance:
  type: ai
  prompt: "Analyze performance issues..."

performance-optimization:
  type: ai
  prompt: "Building on our performance analysis, create an optimization roadmap..."
  depends_on: [performance]
  reuse_ai_session: true
```

#### Multi-step Code Review
```yaml
initial-review:
  type: ai
  prompt: "Perform comprehensive code review..."

clarification:
  type: ai
  prompt: "Let's dive deeper into the most critical issues we identified..."
  depends_on: [initial-review]
  reuse_ai_session: true

final-recommendations:
  type: ai
  prompt: "Summarize our discussion with prioritized action items..."
  depends_on: [clarification]
  reuse_ai_session: true
```

## 📋 Schema-Template System

Visor's new schema-template system provides structured output validation and customizable rendering, replacing the previous category-based approach with a more flexible, configuration-driven system.

### Overview

The schema-template system separates data structure (schemas) from presentation (templates), enabling:

- **JSON Schema Validation**: Runtime validation of check results using AJV
- **Liquid Templates**: Dynamic content rendering with conditional logic and loops
- **Multiple Output Formats**: Support for structured tables, free-form markdown, and custom formats
- **Group-Based Comments**: Create separate GitHub comments based on `group` configuration
- **Check-Focused Organization**: Group issues by check name rather than artificial categories
- **Extensible Design**: Easy to add new schemas and output formats

### Configuration

```yaml
version: "1.0"

checks:
  security:
    type: ai
    group: code-review        # Groups this check with others for commenting
    schema: code-review       # Uses built-in code-review schema
    prompt: |
      Perform comprehensive security analysis focusing on:
      - SQL injection vulnerabilities
      - XSS attack vectors  
      - Authentication/authorization issues
      
      Return results in JSON format matching the code-review schema.
    on: [pr_opened, pr_updated]

  performance:
    type: ai
    group: code-review        # Same group = combined in one comment
    schema: code-review       # Same schema = same table format
    prompt: |
      Analyze performance issues including:
      - Algorithm complexity
      - Memory usage patterns
      - Database query optimization
    on: [pr_opened, pr_updated]

  full-review:
    type: ai
    group: pr-overview       # Different group = separate comment
    schema: text             # Uses built-in text schema for markdown
    prompt: |
      Create a comprehensive pull request overview in markdown format with:
      
      ## 📋 Pull Request Overview
      1. **Summary**: Brief description of changes
      2. **Files Changed**: Table of modified files
      3. **Architecture Impact**: Key architectural considerations
    on: [pr_opened]
```

## 🎯 Enhanced Prompts

Visor supports advanced prompt features including Liquid templates, file-based prompts, and access to event context and previous check results.

### Smart Auto-Detection

Visor automatically detects whether your prompt is a file path or inline content:

```yaml
checks:
  security:
    type: ai
    # File path - automatically detected
    prompt: ./templates/security-analysis.liquid
    
  performance:
    type: ai
    # Inline string - automatically detected
    prompt: "Analyze this code for performance issues"
    
  quality:
    type: ai
    # Multi-line string - automatically detected
    prompt: |
      Review this code for:
      - Code quality issues
      - Best practices violations
      - Maintainability concerns
```

**Auto-detection rules:**
- ✅ **File paths**: `./file.liquid`, `../templates/prompt.md`, `/absolute/path/file.txt`
- ✅ **Inline content**: `Analyze this code`, `Review for security issues`
- ✅ **Multi-line**: Uses YAML `|` or `>` syntax for longer prompts

### Liquid Template Support

Prompts can use [Liquid templating](https://shopify.github.io/liquid/) with rich context data:

```yaml
checks:
  context-aware-review:
    type: ai
    prompt: |
      # Review for PR {{ pr.number }}: {{ pr.title }}
      
      ## PR Details
      - Author: {{ pr.author }}
      - Branch: {{ pr.headBranch }} → {{ pr.baseBranch }}
      - Files changed: {{ files.size }}
      - Total changes: +{{ pr.totalAdditions }}/-{{ pr.totalDeletions }}
      
      ## File Analysis
      {% if utils.filesByExtension.ts %}
      ### TypeScript Files ({{ utils.filesByExtension.ts.size }})
      {% for file in utils.filesByExtension.ts %}
      - {{ file.filename }} (+{{ file.additions }}/-{{ file.deletions }})
      {% endfor %}
      {% endif %}
      
      {% if utils.hasLargeChanges %}
      ⚠️ **Warning**: This PR contains large changes requiring careful review.
      {% endif %}
      
      ## Previous Results
      {% if outputs.security %}
      Security check found {{ outputs.security.totalIssues }} issues:
      {% for issue in outputs.security.securityIssues %}
      - **{{ issue.severity | upcase }}**: {{ issue.message }} in {{ issue.file }}:{{ issue.line }}
      {% endfor %}
      {% endif %}
    on: [pr_opened, pr_updated]
```

### File-Based Prompts

Store prompts in external files for better organization:

```yaml
checks:
  security-review:
    type: ai
    prompt: ./prompts/security-detailed.liquid  # Auto-detects file path
    on: [pr_opened, pr_updated]
    
  architecture-check:
    type: ai  
    prompt: /absolute/path/to/architecture-prompt.liquid  # Auto-detects file path
    on: [pr_opened]
```

### Template Context Variables

#### PR Information (`pr`)
```liquid
{{ pr.number }}          <!-- PR number -->
{{ pr.title }}           <!-- PR title -->
{{ pr.author }}          <!-- PR author -->
{{ pr.baseBranch }}      <!-- Base branch name -->
{{ pr.headBranch }}      <!-- Head branch name -->
{{ pr.totalAdditions }}  <!-- Total lines added -->
{{ pr.totalDeletions }}  <!-- Total lines deleted -->
{{ pr.isIncremental }}   <!-- Boolean: incremental analysis -->
```

#### File Information (`files` and `utils`)
```liquid
{{ files.size }}                          <!-- Number of files changed -->
{{ utils.filesByExtension.ts.size }}     <!-- TypeScript files count -->
{{ utils.filesByExtension.js.size }}     <!-- JavaScript files count -->
{{ utils.addedFiles.size }}              <!-- Newly added files -->
{{ utils.modifiedFiles.size }}           <!-- Modified files -->
{{ utils.hasLargeChanges }}              <!-- Boolean: large changes detected -->
{{ utils.totalFiles }}                   <!-- Total files changed -->
```

#### GitHub Event Context (`event`)
```liquid
{{ event.name }}                  <!-- Event name (pull_request, issue_comment, etc.) -->
{{ event.action }}               <!-- Event action (opened, updated, etc.) -->
{{ event.repository.fullName }}  <!-- Repository owner/name -->

<!-- For comment-triggered events -->
{% if event.comment %}
{{ event.comment.body }}         <!-- Comment text -->
{{ event.comment.author }}       <!-- Comment author -->
{% endif %}
```

#### Previous Check Results (`outputs`)
```liquid
{% if outputs.security %}
Security Results:
- Total issues: {{ outputs.security.totalIssues }}
- Critical: {{ outputs.security.criticalIssues }}
- Errors: {{ outputs.security.errorIssues }}
- Warnings: {{ outputs.security.warningIssues }}

Security Issues:
{% for issue in outputs.security.securityIssues %}
- {{ issue.severity | upcase }}: {{ issue.message }}
{% endfor %}

Suggestions:
{% for suggestion in outputs.security.suggestions %}
- {{ suggestion }}
{% endfor %}
{% endif %}
```

### Custom Templates

Customize output rendering with custom templates:

```yaml
checks:
  security-with-custom-output:
    type: ai
    prompt: "Analyze security vulnerabilities..."
    template:
      file: ./templates/security-report.liquid
      # OR inline content:
      # content: |
      #   # 🔒 Security Report
      #   {% for issue in issues %}
      #   - **{{ issue.severity }}**: {{ issue.message }}
      #   {% endfor %}
    on: [pr_opened]
```

### Advanced Example: Multi-Context Review

```yaml
checks:
  comprehensive-review:
    type: ai
    depends_on: [security, performance]  # Run after these checks
    prompt:
      content: |
        # Comprehensive Review for {{ event.repository.fullName }}#{{ pr.number }}
        
        {% if event.comment %}
        Triggered by comment: "{{ event.comment.body }}" from {{ event.comment.author }}
        {% endif %}
        
        ## Previous Analysis Summary
        {% if outputs.security %}
        - **Security**: {{ outputs.security.totalIssues }} issues found
          {% for issue in outputs.security.criticalIssues %}
          - 🔴 **CRITICAL**: {{ issue.message }}
          {% endfor %}
        {% endif %}
        
        {% if outputs.performance %}
        - **Performance**: {{ outputs.performance.totalIssues }} issues found  
        {% endif %}
        
        ## New Focus Areas
        Based on file changes in this PR:
        {% for ext, files in utils.filesByExtension %}
        - {{ ext | upcase }} files: {{ files.size }}
        {% endfor %}
        
        Please provide an architectural review focusing on:
        1. Integration between modified components
        2. Impact on existing security measures  
        3. Performance implications of changes
        4. Maintainability and technical debt
    on: [pr_opened, pr_updated]
```

## 🔧 Advanced Configuration

### Check-Level AI Configuration

Override global AI settings for specific checks:

```yaml
# Global AI settings (optional)
ai_model: gpt-3.5-turbo
ai_provider: openai

checks:
  security-advanced:
    type: ai
    prompt: "Perform advanced security analysis..."
    # Override global settings for this check
    ai_model: claude-3-opus
    ai_provider: anthropic
    on: [pr_opened]
    
  performance-quick:
    type: ai
    prompt: "Quick performance check..."
    # Use different model for performance checks
    ai_model: gpt-4-turbo
    # ai_provider will inherit global setting (openai)
    on: [pr_updated]
    
  quality-standard:
    type: ai
    prompt: "Standard quality review..."
    # No overrides - uses global settings
    on: [pr_opened]
```

### Environment Variable Configuration

Use environment variables with GitHub Actions-like syntax:

```yaml
# Global environment variables
env:
  DEFAULT_TIMEOUT: "30000"
  LOG_LEVEL: "info"
  SHARED_SECRET: "${{ env.GITHUB_TOKEN }}"

checks:
  security-with-env:
    type: ai
    prompt: |
      Security analysis using timeout: ${{ env.SECURITY_TIMEOUT }}ms
      API endpoint: ${{ env.SECURITY_API_ENDPOINT }}
      
      Analyze these files for security issues...
    # Check-specific environment variables
    env:
      SECURITY_API_KEY: "${{ env.ANTHROPIC_API_KEY }}"
      SECURITY_TIMEOUT: "${DEFAULT_TIMEOUT}"  # Reference global env
      ANALYSIS_MODE: "comprehensive"
      CUSTOM_RULES: "security,auth,crypto"
    # Use environment variable for AI model
    ai_model: "${{ env.SECURITY_MODEL }}"
    ai_provider: "${{ env.PREFERRED_AI_PROVIDER }}"
    on: [pr_opened, pr_updated]
```

#### Environment Variable Syntax

Visor supports multiple environment variable syntaxes:

```yaml
env:
  # GitHub Actions style (recommended)
  API_KEY: "${{ env.OPENAI_API_KEY }}"
  
  # Shell style
  MODEL_NAME: "${CUSTOM_MODEL}"
  
  # Simple shell style
  PROVIDER: "$AI_PROVIDER"
  
  # Mixed usage
  ENDPOINT: "https://${{ env.API_HOST }}/v1/${API_VERSION}"
  
  # Static values
  TIMEOUT: 45000
  DEBUG_MODE: true
  FEATURES: "security,performance"
```

### Configuration Inheritance with Extends

Visor supports configuration inheritance through the `extends` directive, allowing you to build upon existing configurations. This is useful for:
- Sharing common configurations across projects
- Building team/organization standards
- Creating environment-specific configs (dev, staging, prod)

#### Using the Extends Directive

The `extends` field can reference:
- **Local files**: Relative or absolute paths to YAML files
- **Remote URLs**: HTTPS URLs to configuration files (requires allowlist for security)
- **Default**: Built-in default configuration (`extends: default`)

```yaml
# .visor.yaml - Your project config
extends: ./base-config.yaml  # Single extend
# OR multiple extends (merged left-to-right)
extends:
  - default                   # Start with defaults
  - ./team-standards.yaml     # Apply team standards
  - ./project-specific.yaml   # Project overrides

checks:
  my-custom-check:
    type: ai
    prompt: "Project-specific analysis..."
```

#### Example: Team Configuration

**team-config.yaml** (shared team configuration):
```yaml
version: "1.0"
ai_provider: openai
ai_model: gpt-4

checks:
  security-scan:
    type: ai
    prompt: "Perform security analysis following OWASP guidelines"
    on: [pr_opened, pr_updated]

  code-quality:
    type: ai
    prompt: "Check code quality and best practices"
    on: [pr_opened, pr_updated]
```

**project-config.yaml** (project extends team config):
```yaml
extends: ./team-config.yaml

# Override team defaults
ai_model: gpt-4-turbo  # Use newer model

checks:
  # Disable code-quality by setting empty 'on' array
  code-quality:
    on: []

  # Add project-specific check
  performance-check:
    type: ai
    prompt: "Analyze performance implications"
    on: [pr_opened]
```

#### Remote Configuration (with Security)

For security, remote URLs must be explicitly allowed via CLI:

```bash
# Allow specific URL prefixes
visor --check all \
  --allowed-remote-patterns "https://github.com/myorg/,https://raw.githubusercontent.com/myorg/"
```

Then use in your config:
```yaml
extends: https://raw.githubusercontent.com/myorg/configs/main/base.yaml

checks:
  # Your project-specific checks...
```

#### Security Features

1. **Path Traversal Protection**: Local file paths are restricted to the project root
2. **URL Allowlist**: Remote URLs must match allowed patterns (empty by default)
3. **No Remote by Default**: Use `--no-remote-extends` to completely disable remote configs

#### Merge Behavior

When extending configurations:
- **Simple values**: Child overrides parent
- **Objects**: Deep merge (child properties override parent)
- **Arrays**: Replaced entirely (not concatenated)
- **Checks**: Can be disabled by setting `on: []`

#### Appending to Prompts with `appendPrompt`

When extending configurations, you can append additional instructions to existing prompts using the `appendPrompt` field. This is useful for adding project-specific requirements without completely replacing the base prompt.

**base-config.yaml**:
```yaml
checks:
  security-review:
    type: ai
    prompt: "Perform basic security analysis"
    on: [pr_opened]
```

**project-config.yaml**:
```yaml
extends: ./base-config.yaml

checks:
  security-review:
    # Appends to the parent prompt instead of replacing it
    appendPrompt: "Also check for SQL injection vulnerabilities and hardcoded secrets"
    # Result: "Perform basic security analysis\n\nAlso check for SQL injection vulnerabilities and hardcoded secrets"
```

Notes:
- `appendPrompt` is combined with parent `prompt` using a double newline separator
- If no parent prompt exists, `appendPrompt` becomes the prompt
- Use `prompt` field to completely replace the parent prompt instead of appending

### Configuration Priority Order

With extends, the full priority order becomes:

1. **Check-level settings** (highest priority)
2. **Current file configuration**
3. **Extended configurations** (merged in order)
4. **Global configuration**
5. **Environment variables**
6. **Default values** (lowest priority)

```yaml
# Global defaults
ai_model: gpt-3.5-turbo
ai_provider: openai
env:
  GLOBAL_TIMEOUT: "30000"
  
checks:
  example-check:
    type: ai
    prompt: "Example analysis"
    # These override global settings
    ai_model: claude-3-opus    # Overrides global ai_model
    # ai_provider: inherits openai from global
    
    env:
      # Inherits GLOBAL_TIMEOUT from global env
      CHECK_TIMEOUT: "45000"   # Check-specific setting
      API_KEY: "${{ env.ANTHROPIC_API_KEY }}"  # From process env
```

### Production Environment Setup

For production deployments, set up environment variables:

```bash
# AI Provider API Keys
export OPENAI_API_KEY="sk-your-openai-key"
export ANTHROPIC_API_KEY="sk-ant-your-anthropic-key"
export GOOGLE_API_KEY="your-google-api-key"

# GitHub Integration
export GITHUB_TOKEN="ghp_your-github-token"

# Custom Configuration
export SECURITY_MODEL="claude-3-opus"
export PERFORMANCE_MODEL="gpt-4-turbo"
export PREFERRED_AI_PROVIDER="anthropic"
export ANALYSIS_TIMEOUT="60000"
```

Then reference them in your configuration:

```yaml
env:
  # Production environment references
  OPENAI_KEY: "${{ env.OPENAI_API_KEY }}"
  ANTHROPIC_KEY: "${{ env.ANTHROPIC_API_KEY }}"
  GITHUB_ACCESS_TOKEN: "${{ env.GITHUB_TOKEN }}"

checks:
  production-security:
    type: ai
    ai_model: "${{ env.SECURITY_MODEL }}"
    ai_provider: "${{ env.PREFERRED_AI_PROVIDER }}"
    env:
      API_KEY: "${{ env.ANTHROPIC_KEY }}"
      TIMEOUT: "${{ env.ANALYSIS_TIMEOUT }}"
    prompt: |
      Production security analysis with ${{ env.ANALYSIS_TIMEOUT }}ms timeout
      Using provider: ${{ env.PREFERRED_AI_PROVIDER }}
      Model: ${{ env.SECURITY_MODEL }}
      
      Perform comprehensive security analysis...
```

### Built-in Schemas

#### Code Review Schema (`code-review`)
Structured format for code analysis results:
```json
{
  "issues": [
    {
      "file": "src/auth.ts",
      "line": 15,
      "ruleId": "security/hardcoded-secret", 
      "message": "Hardcoded API key detected",
      "severity": "critical",
      "category": "security",
      "suggestion": "Use environment variables"
    }
  ]
}
```

#### Text Schema (`text`)
Free-form text/markdown content:
```json
{
  "content": "# PR Overview\n\nThis PR adds authentication features..."
}
```

### Output Templates

#### Code Review Template
Renders structured data as HTML tables with:
- Grouping by check name
- Severity indicators with emojis (🔴 🟠 🟡 🟢)
- Collapsible suggestion details
- File and line information

#### Text Template  
Renders text/markdown content as-is for:
- PR overviews and summaries
- Architecture diagrams
- Custom formatted content

### Comment Grouping

The `group` property controls GitHub comment generation:

```yaml
checks:
  security:
    group: code-review    # \
  performance:            #  } All grouped in one comment
    group: code-review    # /

  overview:
    group: summary        # Separate comment

  issue-assistant:
    group: dynamic        # Special group: creates NEW comment each time (never updates)
```

**Special "dynamic" group**: When a check uses `group: dynamic`, it creates a new comment for each execution instead of updating an existing comment. This is perfect for:
- Issue assistants that respond to user questions
- Release notes generation
- Changelog updates
- Any check where you want to preserve the history of responses

### Custom Schemas and Templates

Add custom schemas in your config:

```yaml
schemas:
  custom-metrics:
    file: ./schemas/metrics.json     # Local file
  compliance:  
    url: https://example.com/compliance.json  # Remote URL

checks:
  metrics:
    schema: custom-metrics    # References custom schema
    group: metrics           # Separate comment group
```

### Key Features Implemented

- ✅ **Check-Based Organization**: Issues grouped by check name, not artificial categories
- ✅ **Group-Based Comments**: Multiple GitHub comments based on `group` property
- ✅ **JSON Schema Validation**: Runtime validation with AJV library
- ✅ **Liquid Templates**: Dynamic rendering with conditional logic
- ✅ **Multiple Output Formats**: Structured tables vs free-form markdown
- ✅ **Backwards Compatibility**: Existing configurations continue to work
- ✅ **No False Categories**: Eliminates "logic" issues when no logic checks configured
- ✅ **Type Safety**: Structured data validation prevents malformed output
- ✅ **Extensible Design**: Easy to add custom schemas and templates

### Schema and Template Properties

The schema-template system introduces two new configuration properties:

#### Group Property
Controls GitHub comment organization:
```yaml
checks:
  security:
    group: code-review    # Groups with other code-review checks
  performance:
    group: code-review    # Same group = combined in one comment
  overview:
    group: pr-summary     # Different group = separate comment
  changelog:
    group: dynamic        # Special: creates NEW comment each time
```

The special `group: dynamic` creates a new comment for each execution instead of updating existing comments. Use this for checks where you want to preserve history (issue assistants, release notes, etc.)

#### Schema Property
Enforces structured output format:
```yaml
checks:
  security:
    schema: code-review   # Structured table format
    prompt: "Return JSON matching code-review schema"
  overview:
    schema: text          # Free-form markdown
    prompt: "Return markdown content"
```

#### Benefits
- **Check-Based Organization**: Only configured checks appear in results
- **Multiple Comments**: Separate GitHub comments based on `group` property
- **Structured Output**: JSON Schema validation ensures consistent data
- **Flexible Rendering**: Different templates for different output types

### GitHub Integration Schema Requirements

Visor is **fully schema-agnostic** - checks can return any structure and templates handle all formatting logic. However, for GitHub Checks API integration (status checks, outputs), specific structure may be required:

#### Unstructured Checks (No Schema / Plain Schema)
```yaml
# ✅ No-schema and plain schema behave identically
overview:
  type: ai
  # No schema - returns raw markdown directly to PR comments
  prompt: "Analyze this PR and provide an overview"

documentation:
  type: ai
  schema: plain  # Equivalent to no schema
  prompt: "Generate documentation for these changes"
```

**Behavior**: AI returns raw text/markdown → Posted as-is to PR comments → GitHub integration reports 0 issues

#### Structured Checks (GitHub Checks API Compatible)
```yaml
security:
  type: ai
  schema: code-review  # Built-in schema, works out of the box
  prompt: "Review for security issues and return findings as JSON"

# Custom schema example
custom-check:
  type: ai
  schema: |
    {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["issues"],
      "properties": {
        "issues": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["file", "line", "message", "severity"],
            "properties": {
              "file": { "type": "string" },
              "line": { "type": "integer" },
              "ruleId": { "type": "string" },
              "message": { "type": "string" },
              "severity": { "enum": ["critical", "error", "warning", "info"] },
              "category": { "type": "string" }
            }
          }
        }
      }
    }
  prompt: "Review the code and return JSON matching the schema"
```

**Required Structure for GitHub Checks API Integration**:
- `issues`: Array of issue objects (required for GitHub status checks)
- `issues[].severity`: Must be `"critical"`, `"error"`, `"warning"`, or `"info"`
- `issues[].file`: File path (required for GitHub annotations)
- `issues[].line`: Line number (required for GitHub annotations)
- `issues[].message`: Issue description (required for GitHub annotations)

#### GitHub Checks API Features
When checks return the structured format above:
- ✅ **GitHub Status Checks**: Pass/fail based on severity thresholds
- ✅ **GitHub Annotations**: Issues appear as file annotations in PR
- ✅ **Action Outputs**: `issues-found`, `critical-issues-found` outputs
- ✅ **PR Comments**: Structured table format with issue details

#### Schema Behavior Summary
| Schema Type | AI Output | Comment Rendering | GitHub Checks API |
|-------------|-----------|-------------------|-------------------|
| **None/Plain** | Raw text/markdown | ✅ Posted as-is | ❌ No status checks, 0 issues |
| **Structured** | JSON with `issues[]` | ✅ Table format | ✅ Full GitHub integration |

**Key Design**: Use unstructured (none/plain) for narrative content like overviews and documentation. Use structured schemas for actionable code review findings that integrate with GitHub's checking system.

## 🧠 Advanced AI Features

### XML-Formatted Analysis
Visor uses structured XML formatting when sending data to AI providers, enabling precise and context-aware analysis for both pull requests and issues.

#### Pull Request Context
For PR events, Visor provides comprehensive code review context:

```xml
<pull_request>
  <metadata>
    <number>123</number>                    <!-- PR number -->
    <title>Add user authentication</title>  <!-- PR title -->
    <author>developer</author>               <!-- PR author username -->
    <base_branch>main</base_branch>         <!-- Target branch (where changes will be merged) -->
    <target_branch>feature-auth</target_branch> <!-- Source branch (contains the changes) -->
    <total_additions>250</total_additions>  <!-- Total lines added across all files -->
    <total_deletions>50</total_deletions>   <!-- Total lines removed across all files -->
    <files_changed_count>3</files_changed_count> <!-- Number of files modified -->
  </metadata>

  <description>
    <!-- PR description/body text provided by the author -->
    This PR implements JWT-based authentication with refresh token support
  </description>

  <full_diff>
    <!-- Complete unified diff of all changes (present for all PR analyses) -->
    --- src/auth.ts
    +++ src/auth.ts
    @@ -1,3 +1,10 @@
    +import jwt from 'jsonwebtoken';
    ...
  </full_diff>

  <commit_diff>
    <!-- Only present for incremental analysis (pr_updated events) -->
    <!-- Contains diff of just the latest commit pushed -->
  </commit_diff>

  <files_summary>
    <!-- List of all modified files with change statistics -->
    <file index="1">
      <filename>src/auth.ts</filename>
      <status>modified</status>          <!-- added/modified/removed/renamed -->
      <additions>120</additions>          <!-- Lines added in this file -->
      <deletions>10</deletions>           <!-- Lines removed from this file -->
    </file>
  </files_summary>

  <!-- Only present for issue_comment events on PRs -->
  <triggering_comment>
    <author>reviewer1</author>
    <created_at>2024-01-16T15:30:00Z</created_at>
    <body>/review --check security</body>
  </triggering_comment>

  <!-- Historical comments on the PR (excludes triggering comment) -->
  <comment_history>
    <comment index="1">
      <author>reviewer2</author>
      <created_at>2024-01-15T11:00:00Z</created_at>
      <body>Please add unit tests for the authentication logic</body>
    </comment>
    <comment index="2">
      <author>developer</author>
      <created_at>2024-01-15T14:30:00Z</created_at>
      <body>Tests added in latest commit</body>
    </comment>
  </comment_history>
</pull_request>
```

#### Issue Context
For issue events, Visor provides issue-specific context for intelligent assistance:

```xml
<issue>
  <metadata>
    <number>456</number>                   <!-- Issue number -->
    <title>Feature request: Add dark mode</title> <!-- Issue title -->
    <author>user123</author>                <!-- Issue author username -->
    <state>open</state>                     <!-- Issue state: open/closed -->
    <created_at>2024-01-15T10:30:00Z</created_at> <!-- When issue was created -->
    <updated_at>2024-01-16T14:20:00Z</updated_at> <!-- Last update timestamp -->
    <comments_count>5</comments_count>      <!-- Total number of comments -->
  </metadata>

  <description>
    <!-- Issue body/description text provided by the author -->
    I would like to request a dark mode feature for better accessibility...
  </description>

  <labels>
    <!-- GitHub labels applied to categorize the issue -->
    <label>enhancement</label>
    <label>good first issue</label>
    <label>ui/ux</label>
  </labels>

  <assignees>
    <!-- Users assigned to work on this issue -->
    <assignee>developer1</assignee>
    <assignee>developer2</assignee>
  </assignees>

  <milestone>
    <!-- Project milestone this issue is part of (if any) -->
    <title>v2.0 Release</title>
    <state>open</state>                     <!-- Milestone state: open/closed -->
    <due_on>2024-03-01T00:00:00Z</due_on>  <!-- Milestone due date -->
  </milestone>

  <!-- Only present for issue_comment events -->
  <triggering_comment>
    <author>user456</author>                <!-- User who posted the triggering comment -->
    <created_at>2024-01-16T15:30:00Z</created_at> <!-- When comment was posted -->
    <body>/review security --focus authentication</body> <!-- The comment text -->
  </triggering_comment>

  <!-- Historical comments on the issue (excludes triggering comment) -->
  <comment_history>
    <comment index="1">                     <!-- Comments ordered by creation time -->
      <author>developer1</author>
      <created_at>2024-01-15T11:00:00Z</created_at>
      <body>This is a great idea! I'll start working on it.</body>
    </comment>
    <comment index="2">
      <author>user123</author>
      <created_at>2024-01-15T14:30:00Z</created_at>
      <body>Thanks! Please consider accessibility standards.</body>
    </comment>
  </comment_history>
</issue>
```

### Incremental Commit Analysis
When new commits are pushed to a PR, Visor performs incremental analysis:
- **Full Analysis**: Reviews the entire PR on initial creation
- **Incremental Analysis**: On new commits, focuses only on the latest changes
- **Smart Updates**: Updates existing review comments instead of creating duplicates

### Intelligent Comment Management
- **Unique Comment IDs**: Each PR gets a unique review comment that persists across updates
- **Collision Detection**: Prevents conflicts when multiple reviews run simultaneously
- **Context-Aware Updates**: Comments are updated with relevant context (PR opened, updated, synchronized)

## 🌐 HTTP Integration & Scheduling

Visor provides comprehensive HTTP integration capabilities including webhook reception, HTTP outputs, scheduled executions via cron, and TLS/HTTPS support.

### HTTP Server for Webhook Reception

Configure an HTTP/HTTPS server to receive webhooks and trigger checks:

```yaml
version: "1.0"

http_server:
  enabled: true
  port: 8080
  host: "0.0.0.0"

  # Optional TLS/HTTPS configuration
  tls:
    enabled: true
    cert: "${TLS_CERT}"  # From environment variable
    key: "${TLS_KEY}"
    ca: "${TLS_CA}"      # Optional CA certificate
    rejectUnauthorized: true

  # Authentication
  auth:
    type: bearer_token
    secret: "${WEBHOOK_SECRET}"

  # Webhook endpoints
  endpoints:
    - path: "/webhook/github"
      name: "github-events"
    - path: "/webhook/jenkins"
      name: "jenkins-builds"
```

**Note**: The HTTP server is automatically disabled when running in GitHub Actions to avoid conflicts.

### Check Types for HTTP Integration

#### 1. HTTP Input (Webhook Receiver)
Receive data from configured webhook endpoints:

```yaml
checks:
  github-webhook:
    type: http_input
    endpoint: "/webhook/github"
    on: [webhook_received]
    transform: |
      {
        "event": "{{ webhook.action }}",
        "repository": "{{ webhook.repository.full_name }}"
      }
```

#### 2. HTTP Output (Send Data)
Send check results to external services:

```yaml
checks:
  notify-external:
    type: http
    depends_on: [security-check]
    url: "https://api.example.com/notify"
    method: POST
    headers:
      Content-Type: "application/json"
      Authorization: "Bearer ${API_TOKEN}"
    body: |
      {
        "results": {{ outputs['security-check'] | json }},
        "timestamp": "{{ 'now' | date: '%Y-%m-%d %H:%M:%S' }}"
      }
```

#### 3. HTTP Client (Fetch Data)
Fetch data from external APIs:

```yaml
checks:
  fetch-config:
    type: http_client
    url: "https://api.example.com/config"
    method: GET
    headers:
      Authorization: "Bearer ${API_TOKEN}"
    transform: |
      {
        "settings": {{ response.data | json }},
        "fetched_at": "{{ 'now' | date: '%Y-%m-%d' }}"
      }
```

#### 4. Log Provider (Debugging & Monitoring)
Output debugging information and monitor workflow execution:

```yaml
checks:
  debug-start:
    type: log
    group: debugging
    level: info
    message: "🚀 Starting code review for PR #{{ pr.number }} by {{ pr.author }}"
    include_pr_context: true
    include_dependencies: false
    include_metadata: true

  debug-dependencies:
    type: log
    group: debugging
    level: debug
    depends_on: [security-check]
    message: |
      📊 Dependency results summary:
      {% if dependencies %}
      - Security check found {{ dependencies['security-check'].issueCount }} issues
      {% else %}
      - No dependencies processed
      {% endif %}
    include_dependencies: true

  performance-monitor:
    type: log
    group: monitoring
    level: warn
    message: "⚠️ Large PR detected: {{ pr.totalAdditions }} lines added"
    include_pr_context: true
```

**Configuration Options:**
- `message` - Log message (required, supports Liquid templates)
- `level` - Log level: `debug`, `info`, `warn`, `error` (default: `info`)
- `include_pr_context` - Include PR information (default: `true`)
- `include_dependencies` - Include dependency results (default: `true`)
- `include_metadata` - Include execution metadata (default: `true`)
- `group` - Output group for organization

**Use Cases:**
- Debug complex check workflows and execution order
- Monitor check performance and resource usage
- Create audit trails for review processes
- Troubleshoot configuration issues
- Track dependency execution flow

### Cron Scheduling

Schedule any check type to run at specific intervals:

```yaml
checks:
  daily-security-scan:
    type: ai
    prompt: "Perform comprehensive security audit"
    schedule: "0 2 * * *"  # Run at 2 AM daily

  hourly-metrics:
    type: http_client
    url: "https://metrics.example.com/latest"
    schedule: "0 * * * *"  # Every hour

  weekly-report:
    type: ai
    prompt: "Generate weekly summary"
    schedule: "0 9 * * MON"  # Every Monday at 9 AM
```

**Cron Expression Format**:
```
┌────────────── minute (0-59)
│ ┌──────────── hour (0-23)
│ │ ┌────────── day of month (1-31)
│ │ │ ┌──────── month (1-12)
│ │ │ │ ┌────── day of week (0-6, Sunday=0)
│ │ │ │ │
* * * * *
```

### TLS/HTTPS Configuration

Support for various TLS certificate configurations:

#### Environment Variables
```yaml
tls:
  enabled: true
  cert: "${TLS_CERT}"  # Certificate from env var
  key: "${TLS_KEY}"    # Private key from env var
```

#### File Paths
```yaml
tls:
  enabled: true
  cert: "/etc/ssl/certs/server.crt"
  key: "/etc/ssl/private/server.key"
  ca: "/etc/ssl/certs/ca-bundle.crt"
```

#### Let's Encrypt
```yaml
tls:
  enabled: true
  cert: "/etc/letsencrypt/live/example.com/fullchain.pem"
  key: "/etc/letsencrypt/live/example.com/privkey.pem"
```

### HTTP Security Features

Visor's HTTP server includes comprehensive security protections:

#### Authentication Methods
```yaml
# Bearer Token Authentication
auth:
  type: bearer_token
  secret: "${WEBHOOK_SECRET}"

# HMAC-SHA256 Signature Verification
auth:
  type: hmac
  secret: "${WEBHOOK_SECRET}"

# Basic Authentication
auth:
  type: basic
  username: "${HTTP_USERNAME}"
  password: "${HTTP_PASSWORD}"
```

#### HMAC Authentication Details
For `hmac` authentication, webhooks must include the `x-webhook-signature` header:
- Signature format: `sha256={hash}`
- Uses HMAC-SHA256 with the configured secret
- Implements timing-safe comparison to prevent timing attacks
- Compatible with GitHub webhook signatures

#### DoS Protection
- **Request size limits**: Maximum 1MB request body size
- **Early rejection**: Validates `Content-Length` header before processing
- **Graceful error handling**: Returns proper HTTP status codes (413 Payload Too Large)

#### Security Best Practices
- **Environment detection**: Automatically disables in GitHub Actions
- **TLS support**: Full HTTPS configuration with custom certificates
- **Input validation**: Validates all webhook payloads before processing
- **Error isolation**: Security failures don't affect independent checks

### Complete HTTP Pipeline Example

```yaml
version: "1.0"

# HTTP server configuration
http_server:
  enabled: true
  port: 8443
  tls:
    enabled: true
    cert: "${TLS_CERT}"
    key: "${TLS_KEY}"
  auth:
    type: bearer_token
    secret: "${WEBHOOK_SECRET}"
  endpoints:
    - path: "/webhook/deployment"
      name: "deployment-trigger"

checks:
  # 1. Receive webhook
  deployment-webhook:
    type: http_input
    endpoint: "/webhook/deployment"
    on: [webhook_received]
    transform: |
      {
        "version": "{{ webhook.version }}",
        "environment": "{{ webhook.environment }}"
      }

  # 2. Analyze deployment
  deployment-analysis:
    type: ai
    depends_on: [deployment-webhook]
    prompt: |
      Analyze deployment for version {{ outputs['deployment-webhook'].suggestions | first }}
      Check for potential issues and risks

  # 3. Fetch current status
  current-status:
    type: http_client
    depends_on: [deployment-webhook]
    url: "https://api.example.com/status"
    method: GET

  # 4. Send results
  notify-team:
    type: http
    depends_on: [deployment-analysis, current-status]
    url: "https://slack.example.com/webhook"
    body: |
      {
        "text": "Deployment Analysis Complete",
        "analysis": {{ outputs['deployment-analysis'] | json }},
        "current_status": {{ outputs['current-status'] | json }}
      }

  # 5. Scheduled health check
  health-check:
    type: http_client
    url: "https://api.example.com/health"
    schedule: "*/5 * * * *"  # Every 5 minutes
    transform: |
      {
        "status": "{{ response.status }}",
        "checked_at": "{{ 'now' | date: '%Y-%m-%d %H:%M:%S' }}"
      }
```

### Liquid Template Support

All HTTP configurations support Liquid templating for dynamic content:

- Access webhook data: `{{ webhook.field }}`
- Access headers: `{{ headers['x-custom-header'] }}`
- Access previous outputs: `{{ outputs['check-name'].suggestions | first }}`
- Date formatting: `{{ 'now' | date: '%Y-%m-%d' }}`
- JSON encoding: `{{ data | json }}`

## 🔧 Pluggable Architecture

Visor features a pluggable provider system for extensibility:

### Supported Check Types
- **AI Provider**: Intelligent analysis using LLMs (Google Gemini, Anthropic Claude, OpenAI GPT) with MCP (Model Context Protocol) tools support
- **Claude Code Provider**: Advanced AI analysis using Claude Code SDK with MCP tools and subagents
- **Tool Provider**: Integration with external tools (ESLint, Prettier, SonarQube)
- **HTTP Provider**: Send data to external HTTP endpoints
- **HTTP Input Provider**: Receive data from webhooks
- **HTTP Client Provider**: Fetch data from external APIs
- **Script Provider**: Custom shell scripts and commands

### Adding Custom Providers
```typescript
// Custom provider implementation
export class CustomCheckProvider extends CheckProvider {
  getName(): string {
    return 'custom-security-scan';
  }
  
  async execute(prInfo: PRInfo, config: CheckProviderConfig): Promise<ReviewSummary> {
    // Your custom analysis logic
    return {
      issues: [...],
      suggestions: [...]
    };
  }
}

// Register your provider
CheckProviderRegistry.getInstance().registerProvider(new CustomCheckProvider());
```

## ⚙️ Configuration

Create `.visor.yaml` in your project root:

```yaml
# .visor.yaml
version: "1.0"

# Project metadata
project:
  name: "My Project"
  description: "My awesome project"
  language: "typescript"    # primary language
  frameworks:               # frameworks in use
    - "react"
    - "nodejs"

# Analysis configuration  
analysis:
  # File patterns to include/exclude
  include:
    - "src/**/*"           # Include all files in src
    - "lib/**/*"           # Include all files in lib
  exclude:
    - "node_modules/**"    # Exclude node_modules
    - "dist/**"           # Exclude build output
    - "**/*.test.ts"      # Exclude test files
  
  # Limits
  maxFileSize: 500000      # Max file size in bytes (500KB)
  maxFiles: 1000          # Max number of files to analyze

# Check-specific settings
checks:
  security:
    enabled: true          # Enable/disable this check
    severity: warning      # Minimum severity: info, warning, error, critical
    rules:                 # Specific rules to apply
      - detect-secrets
      - xss-prevention
      - sql-injection
  
  performance:
    enabled: true
    severity: info
    rules:
      - complexity-analysis
      - memory-leaks
      - algorithm-efficiency
    depends_on: [security]  # Run after security check completes
  
  style:
    enabled: true
    severity: info
    extends: "eslint:recommended"  # Extend from ESLint config
    rules:
      - naming-conventions
      - formatting
    depends_on: [security]  # Ensure secure coding style
  
  architecture:
    enabled: true
    severity: warning
    rules:
      - circular-dependencies
      - design-patterns
    depends_on: [security, performance]  # Build on foundational checks

# Thresholds for pass/fail
thresholds:
  minScore: 70            # Minimum overall score (0-100)
  maxIssues: 100         # Maximum total issues
  maxCriticalIssues: 0   # Maximum critical issues

# Output settings
reporting:
  format: markdown        # Default output format
  verbose: false         # Show detailed output
  includeFixSuggestions: true  # Include fix suggestions
  groupByFile: true      # Group issues by file
```

## 🎯 GitHub Action Reference

### Inputs

| Input | Description | Default | Required |
|-------|-------------|---------|----------|
| `github-token` | GitHub token for API access (auto-provided) | `${{ github.token }}` | No (defaults to workflow token) |
| `auto-review` | Auto-review on PR open/update | `true` | No |
| `checks` | Checks to run (comma-separated) | `all` | No |
| `output-format` | Output format | `markdown` | No |
| `config-path` | Path to config file | `.visor.yaml` | No |
| `max-parallelism` | Maximum number of checks to run in parallel | `3` | No |
| `fail-fast` | Stop execution when any check fails | `false` | No |
| `comment-on-pr` | Post review as PR comment | `true` | No |
| `create-check` | Create GitHub check run | `true` | No |
| `add-labels` | Add quality labels to PR | `true` | No |
| `fail-on-critical` | Fail if critical issues found | `false` | No |
| `min-score` | Minimum score to pass (0-100) | `0` | No |

### Outputs

| Output | Description |
|--------|-------------|
| `review-score` | Overall code quality score (0-100) |
| `total-issues` | Total number of issues found |
| `critical-issues` | Number of critical issues |
| `auto-review-completed` | Whether auto-review was completed (true/false) |
| `pr-action` | The PR action that triggered the review (opened/synchronize/edited) |
| `incremental-analysis` | Whether incremental analysis was used (true/false) |
| `issues-found` | Total number of issues found (alias for total-issues) |
| `review-url` | URL to the review comment |

### Example Workflows

#### Basic Review with Incremental Analysis
```yaml
name: PR Review
on:
  pull_request:
    types: [opened, synchronize, edited]  # Enable incremental analysis on new commits

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./
        with:
          auto-review: true  # Enable automatic review
        env:
          GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
          MODEL_NAME: gemini-2.0-flash-exp
```

#### Security Focus with SARIF Upload
```yaml
name: Security Scan
on: [push, pull_request]

jobs:
  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Visor Security Scan
        uses: ./
        with:
          checks: security
          output-format: sarif
      
      - name: Upload SARIF
        uses: github/codeql-action/upload-sarif@v2
        if: always()
        with:
          sarif_file: visor-results.sarif
```

#### Quality Gate
```yaml
name: Quality Gate
on: pull_request

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./
        with:
          min-score: 80
          fail-on-critical: true
```

#### Command-Triggered Review
```yaml
name: Manual Review
on:
  issue_comment:
    types: [created]

jobs:
  review:
    if: |
      github.event.issue.pull_request &&
      startsWith(github.event.comment.body, '/review')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./
        # Optional: configure inputs (e.g., tag filters, custom configs) with a `with:` block
```

## 📊 Output Formats

### Table (Default)
```
╔════════════════════════════════════════════════════════════════╗
║                      Analysis Summary                          ║
╠════════════════════════════════════════════════════════════════╣
║ Overall Score: 85/100         Issues Found: 12                ║
╟────────────────────────────────────────────────────────────────╢
║ ✓ Security:     92/100    ⚠ Performance:  78/100             ║
║ ✓ Style:        88/100    ✓ Architecture: 82/100             ║
╚════════════════════════════════════════════════════════════════╝
```

### JSON
```json
{
  "summary": {
    "overallScore": 85,
    "totalIssues": 12,
  "criticalIssues": 1
  },
  "issues": [
    {
      "file": "src/api.ts",
      "line": 45,
      "severity": "critical",
      "category": "security",
      "message": "Potential SQL injection"
    }
  ]
}
```

### SARIF
Compatible with GitHub Security tab and other SARIF consumers.

## 🛠️ Development

### Setup
```bash
# Clone and install
git clone https://github.com/your-org/visor.git
cd visor
npm install

# Build
npm run build

# Test
npm test
```

### Project Structure
```
visor/
├── src/
│   ├── cli-main.ts         # CLI entry point
│   ├── index.ts            # GitHub Action entry
│   ├── reviewer.ts         # Core review logic
│   └── output-formatters.ts # Output formatting
├── tests/                  # Test suites
├── .github/workflows/      # GitHub workflows
├── action.yml             # Action metadata
└── .visor.yaml            # Project config (overrides defaults/.visor.yaml)
```

### Available Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Build TypeScript |
| `npm test` | Run tests |
| `npm run test:watch` | Test watch mode |
| `npm run test:coverage` | Coverage report |

## 🤝 Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a PR

## 📄 License

MIT License - see [LICENSE](LICENSE) file

---

<div align="center">
  Made with ❤️ by <a href="https://probelabs.com">Probe Labs</a>
</div>
