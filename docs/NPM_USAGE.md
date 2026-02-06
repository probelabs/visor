# Using Visor via npm/npx

## Quick Start (No Installation Required)

Run Visor directly using npx:

```bash
npx -y @probelabs/visor@latest --help
```

### Safety & Criticality (Quick Note)

Visor follows a criticality‑first model:

- Declare criticality on steps (`criticality: external|internal|policy|info`).
- Pair critical steps with contracts:
  - `assume:` preconditions (skip if unmet; use a guard step if you need a hard fail)
  - `guarantee:` postconditions (violation adds issues and routes `on_fail`)
- Prefer declarative `transitions` over `goto_js` for routing.

Example (block‑style YAML):
```yaml
checks:
  post-comment:
    type: github
    criticality: external
    on:
      - pr_opened
    op: comment.create
    assume:
      - "isMember()"
    guarantee:
      - "output && typeof output.id === 'number'"
    continue_on_failure: false
```

## Global Installation

Install globally for frequent use:

```bash
npm install -g @probelabs/visor
```

Then use the `visor` command:

```bash
visor --check all --output table
```

## Local Project Installation

Add to your project as a dev dependency:

```bash
npm install --save-dev @probelabs/visor
```

Add to your package.json scripts:

```json
{
  "scripts": {
    "review": "visor --check all",
    "review:security": "visor --check security --output json"
  }
}
```

## Usage Examples

### Validate configuration
```bash
# Validate config in current directory (searches for .visor.yaml)
npx -y @probelabs/visor validate

# Validate specific config file
npx -y @probelabs/visor validate --config .visor.yaml

# Validate before committing
npx -y @probelabs/visor validate --config examples/my-config.yaml
```

The `validate` command checks your configuration for:
- Missing required fields (e.g., `version`)
- Invalid check types or event triggers
- Incorrect field names and values
- Schema compliance

It provides detailed error messages with helpful hints to fix issues.

### Run all checks
```bash
npx -y @probelabs/visor@latest --check all
```

### Security check with JSON output
```bash
npx -y @probelabs/visor@latest --check security --output json
```

### Multiple checks with custom config
```bash
npx -y @probelabs/visor@latest --check performance --check architecture --config .visor.yaml
```

### Generate SARIF report for CI/CD
```bash
npx -y @probelabs/visor@latest --check security --output sarif --output-file results.sarif
```

### Save JSON to a file (recommended)
```bash
npx -y @probelabs/visor@latest --check all --output json --output-file visor-results.json
```

## Configuration

Create a `.visor.yaml` file in your project root:

```yaml
version: "1"

checks:
  security-review:
    type: ai
    schema: code-review
    prompt: |
      Review the code for security vulnerabilities.

  performance-review:
    type: ai
    schema: code-review
    prompt: |
      Review the code for performance issues.
```

For complete configuration options, see the [Configuration Guide](./configuration.md).

### Structured Outputs and Schemas

Use a `schema` field to control output format and validation:

- **String schemas** (e.g., `code-review`, `markdown`) select a rendering template
- **Object schemas** (JSON Schema) validate the produced `output`

```yaml
checks:
  summary:
    type: ai
    schema: code-review
    prompt: |
      Summarize the PR...

  summarize-json:
    type: ai
    schema:
      type: object
      properties:
        ok: { type: boolean }
        items: { type: array, items: { type: string } }
      required: [ok, items]
    prompt: |
      Return JSON with ok and items...
```

> **Note**: `output_schema` is deprecated. Use `schema` instead.

## Environment Variables

Set API keys for AI-powered reviews:

```bash
export GOOGLE_API_KEY=your-key-here
# or
export ANTHROPIC_API_KEY=your-key-here
# or
export OPENAI_API_KEY=your-key-here
```

## Subcommands

Visor supports several subcommands for different workflows:

### validate / lint

Validate your configuration file before running:

```bash
visor validate --config .visor.yaml
visor lint --config .visor.yaml  # alias
```

### test

Run YAML-based test suites:

```bash
visor test                              # Discover and run all test suites
visor test --config tests/             # Run tests in a directory
visor test --only "my-test-case"       # Run specific test case
visor test --bail                       # Stop on first failure
```

See the [Test Framework documentation](./testing/getting-started.md) for details.

### code-review / review

Run the built-in code review workflow:

```bash
visor code-review                       # Review current branch changes
visor review                            # alias
```

### mcp-server

Start Visor as an MCP (Model Context Protocol) server:

```bash
visor mcp-server --config .visor.yaml
```

## CLI Options Reference

| Option | Description |
|--------|-------------|
| `-c, --check <type>` | Specify check(s) to run (can be used multiple times) |
| `-o, --output <format>` | Output format: `table`, `json`, `markdown`, `sarif` |
| `--output-file <path>` | Write output to file instead of stdout |
| `--config <path>` | Path to configuration file |
| `--timeout <ms>` | Timeout in milliseconds (default: 1200000 / 20 min) |
| `--max-parallelism <n>` | Max parallel checks (default: 3) |
| `--debug` | Enable debug mode |
| `-v, --verbose` | Increase verbosity |
| `-q, --quiet` | Reduce output to warnings/errors |
| `--fail-fast` | Stop on first failure |
| `--tags <tags>` | Run checks with these tags (comma-separated) |
| `--exclude-tags <tags>` | Skip checks with these tags |
| `--event <type>` | Simulate event: `pr_opened`, `pr_updated`, `manual`, etc. |
| `--analyze-branch-diff` | Analyze diff vs base branch |
| `--tui` | Enable interactive TUI mode |
| `--debug-server` | Start debug visualizer |
| `--message <text>` | Message for human-input checks |

For complete CLI documentation, see the [CI/CLI Mode Guide](./ci-cli-mode.md).

## CI/CD Integration

Add to your GitHub Actions workflow:

```yaml
- name: Run Visor Code Review
  run: npx -y @probelabs/visor@latest --check all --output markdown
  env:
    GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
```

### SARIF Output for GitHub Code Scanning

```yaml
- name: Run Security Scan
  run: npx -y @probelabs/visor@latest --check security --output sarif --output-file results.sarif
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}

- name: Upload SARIF
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: results.sarif
```

For complete CI/CD examples, see the [CI/CLI Mode Guide](./ci-cli-mode.md).

## Related Documentation

- [Configuration Guide](./configuration.md) - Complete configuration reference
- [AI Configuration](./ai-configuration.md) - AI provider setup and options
- [CI/CLI Mode Guide](./ci-cli-mode.md) - GitHub Actions and CI integration
- [Test Framework](./testing/getting-started.md) - Writing and running tests
- [Troubleshooting](./troubleshooting.md) - Common issues and solutions
