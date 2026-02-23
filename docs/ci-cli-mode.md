# Run Modes in CI (including GitHub Actions)

Visor defaults to CLI mode everywhere (no auto-detection). To enable GitHub-specific behavior (comments, checks API), pass `--mode github-actions` or set the action input `mode: github-actions`.

## Basic CLI Mode (Default)

In CLI mode, Visor runs standalone without GitHub integration. This is ideal for local development, CI pipelines, or any environment where you want direct output.

```yaml
jobs:
  visor-cli:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx -y @probelabs/visor@latest --config .visor.yaml --output json
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

## GitHub Actions Mode

To enable GitHub-specific features (PR comments, GitHub Checks API):

```yaml
jobs:
  visor-github:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx -y @probelabs/visor@latest --mode github-actions --config .visor.yaml
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

## CI-Relevant CLI Options

| Option | Description | Example |
|--------|-------------|---------|
| `--config <path>` | Path to configuration file | `--config .visor.yaml` |
| `-o, --output <format>` | Output format: `table`, `json`, `markdown`, `sarif` | `--output sarif` |
| `--output-file <path>` | Write output to file instead of stdout | `--output-file results.json` |
| `--timeout <ms>` | Timeout in milliseconds (default: 1200000 / 20 min) | `--timeout 300000` |
| `--max-parallelism <n>` | Max parallel checks (default: 3) | `--max-parallelism 5` |
| `--fail-fast` | Stop execution on first failure | `--fail-fast` |
| `--tags <tags>` | Run only checks with these tags (comma-separated) | `--tags security,fast` |
| `--exclude-tags <tags>` | Skip checks with these tags | `--exclude-tags slow` |
| `--event <type>` | Simulate GitHub event type | `--event pr_opened` |
| `--analyze-branch-diff` | Analyze diff vs base branch | `--analyze-branch-diff` |
| `--debug` | Enable debug output | `--debug` |
| `-v, --verbose` | Increase verbosity | `--verbose` |
| `-q, --quiet` | Reduce output to warnings/errors | `--quiet` |
| `--mode <mode>` | Run mode: `cli` or `github-actions` | `--mode github-actions` |

## SARIF Output for GitHub Code Scanning

Generate SARIF output for integration with GitHub's code scanning feature:

```yaml
jobs:
  visor-security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx -y @probelabs/visor@latest --check security --output sarif --output-file results.sarif
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
```

## GitHub Authentication

Visor supports GitHub authentication in CLI mode via flags or environment variables. When configured, credentials are automatically propagated to all child processes — command checks, AI agents, MCP servers, and git operations work out of the box.

### Token Auth

```yaml
jobs:
  visor-cli:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx -y @probelabs/visor@latest --config .visor.yaml --output json
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

### GitHub App Auth

```yaml
jobs:
  visor-cli:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          npx -y @probelabs/visor@latest --config .visor.yaml \
            --github-app-id "$GITHUB_APP_ID" \
            --github-private-key "$GITHUB_APP_PRIVATE_KEY"
        env:
          GITHUB_APP_ID: ${{ secrets.VISOR_APP_ID }}
          GITHUB_APP_PRIVATE_KEY: ${{ secrets.VISOR_PRIVATE_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

| Option | Environment Variable | Description |
|--------|---------------------|-------------|
| `--github-token <token>` | `GITHUB_TOKEN` / `GH_TOKEN` | Personal access token |
| `--github-app-id <id>` | `GITHUB_APP_ID` | GitHub App ID |
| `--github-private-key <key>` | `GITHUB_APP_PRIVATE_KEY` | App private key (PEM content or file path) |
| `--github-installation-id <id>` | `GITHUB_APP_INSTALLATION_ID` | Installation ID (auto-detected if omitted) |

This enables `gh` CLI commands and `git` operations against private repos inside command checks and AI agent steps. See [GitHub Authentication](./github-auth.md) for full details.

## Environment Variables

### AI Provider Keys

Set one of the following based on your AI provider:

| Variable | Provider |
|----------|----------|
| `OPENAI_API_KEY` | OpenAI GPT models |
| `ANTHROPIC_API_KEY` | Anthropic Claude models |
| `GOOGLE_API_KEY` | Google Gemini models |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` + `AWS_REGION` | AWS Bedrock |
| `AWS_BEDROCK_API_KEY` | AWS Bedrock (API key auth) |

### GitHub Integration

| Variable | Description |
|----------|-------------|
| `GITHUB_TOKEN` | GitHub token for API access and child process propagation |
| `GH_TOKEN` | Alternative to `GITHUB_TOKEN` (both are set when auth is configured) |
| `GITHUB_APP_ID` | GitHub App ID (for App authentication) |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App private key, PEM content or file path |
| `GITHUB_APP_INSTALLATION_ID` | GitHub App installation ID (optional, auto-detected) |

## Exit Codes

- `0` - Success, no critical issues found
- `1` - Critical issues found or execution error

## Example: Full CI Pipeline

```yaml
jobs:
  visor-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Full history for branch diff analysis

      - name: Run Visor Code Review
        run: |
          npx -y @probelabs/visor@latest \
            --config .visor.yaml \
            --output json \
            --output-file visor-results.json \
            --analyze-branch-diff \
            --timeout 600000 \
            --fail-fast
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}

      - name: Upload Results
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: visor-results
          path: visor-results.json
```

## Notes

- GitHub credentials are optional in CLI mode. Provide them when your workflow uses `gh` CLI, accesses private repos, or uses the `github` provider.
- If you want PR comments/checks, use `--mode github-actions` with `GITHUB_TOKEN`.
- Use `--output-file` for reliable file output instead of shell redirection (`> file`).
- The `--fail-fast` flag is useful in CI to stop early when issues are found.
- Use `--quiet` to reduce noise in CI logs when only warnings/errors matter.

## Related Documentation

- [Configuration](./configuration.md) - Full configuration reference
- [Output Formats](./output-formats.md) - Details on output format options
- [Event Triggers](./event-triggers.md) - GitHub event filtering
- [Tag Filtering](./tag-filtering.md) - Selective check execution with tags
