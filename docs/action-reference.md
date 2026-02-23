## GitHub Action Reference

Visor is an AI-powered code review tool for GitHub Pull Requests. When used as a GitHub Action, it automatically analyzes PRs for security, performance, style, and architectural issues, posting feedback directly to your pull requests.

The action supports multiple AI providers (Google Gemini, Anthropic Claude, OpenAI GPT) and works out-of-the-box without configuration. For advanced setups, see [AI Configuration](ai-configuration.md).

### Inputs

| Input | Description | Default |
|-------|-------------|---------|
| `mode` | Run mode: `github-actions` or `cli` | `github-actions` |
| `github-token` | GitHub token for API access (use this OR app-id/private-key) | `${{ github.token }}` |
| `app-id` | GitHub App ID for authentication (optional, use with private-key) | |
| `private-key` | GitHub App private key for authentication (optional, use with app-id) | |
| `installation-id` | GitHub App installation ID (optional, auto-detected if not provided) | |
| `auto-review` | Enable automatic review on PR open/update | `true` |
| `checks` | Comma-separated list of checks to run (`security`, `performance`, `architecture`, `quality`, `all`) | `all` |
| `output-format` | Output format for analysis results (`table`, `json`, `markdown`, `sarif`) | `json` |
| `config-path` | Path to visor configuration file (uses bundled default if not specified). See [Configuration](configuration.md) | |
| `comment-on-pr` | Post review results as PR comment | `true` |
| `create-check` | Create GitHub check run with results. See [GitHub Checks](GITHUB_CHECKS.md) | `true` |
| `add-labels` | Add quality labels to PR | `true` |
| `add-reactions` | Add emoji reactions to PR/issues (eyes on start, thumbs up on completion) | `true` |
| `ai-model` | AI model to use (`mock`, `google-gemini-pro`, `claude-sonnet`, etc.). See [AI Configuration](ai-configuration.md) | |
| `ai-provider` | AI provider to use (`mock`, `google`, `anthropic`, `openai`). See [AI Configuration](ai-configuration.md) | |
| `fail-on-critical` | Fail the action if critical issues are found | `false` |
| `fail-on-api-error` | Fail the action if API authentication or rate limit errors occur | `false` |
| `max-parallelism` | Maximum number of checks to run in parallel | `1` |
| `fail-fast` | Stop execution when any check fails | `false` |
| `debug` | Enable debug mode for detailed output in comments | `false` |
| `tags` | Include checks with these tags (comma-separated). See [Tag Filtering](tag-filtering.md) | `github` |
| `exclude-tags` | Exclude checks with these tags (comma-separated). See [Tag Filtering](tag-filtering.md) | |

### Outputs

| Output | Description |
|--------|-------------|
| `total-issues` | Total number of issues found |
| `critical-issues` | Number of critical issues found |
| `review-url` | URL to the detailed review comment |
| `sarif-report` | SARIF format report (if output-format includes sarif) |
| `incremental-analysis` | Whether incremental analysis was performed (`true` for synchronize events) |
| `pr-action` | The GitHub PR action that triggered this run (`opened`, `synchronize`, `edited`) |
| `check-runs-created` | Number of GitHub check runs created. See [GitHub Checks](GITHUB_CHECKS.md) |
| `check-runs-urls` | URLs of created GitHub check runs (comma-separated) |
| `checks-api-available` | Whether GitHub Checks API was available (`true`/`false`) |

### Example Workflow

```yaml
name: Visor Code Review
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: buger/visor@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Credential Propagation

When running as a GitHub Action, Visor automatically propagates the authenticated token to all child processes. This means:

- **Command checks** using `gh` CLI or `git` against private repos work out of the box
- **AI agents** (Claude Code) can use `gh` and `git` in bash steps
- **MCP servers** (stdio) inherit the GitHub credentials
- **Git operations** (clone, push, fetch) authenticate automatically via `GIT_CONFIG_*` env vars

No additional configuration is needed — authentication is set up once and flows everywhere.

For CLI mode authentication and detailed setup, see [GitHub Authentication](github-auth.md).

### Related Documentation

- [AI Configuration](ai-configuration.md) - Configure AI providers and models
- [GitHub Authentication](github-auth.md) - Token and GitHub App auth setup
- [GitHub Checks](GITHUB_CHECKS.md) - GitHub Check runs integration
- [Tag Filtering](tag-filtering.md) - Filter checks by tags
- [Configuration](configuration.md) - Full configuration reference

For full input/output definitions, see `action.yml` in the repository root.
