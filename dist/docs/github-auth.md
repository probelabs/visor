# GitHub Authentication

Visor supports two authentication methods for GitHub: **Personal Access Tokens (PAT)** and **GitHub App** installations. Authentication is optional in CLI mode but required for workflows that interact with GitHub (labels, comments, PR data, private repo access).

When configured, Visor automatically propagates credentials to all child processes — command checks, AI agents, MCP servers, and git operations work out of the box regardless of local git configuration.

---

## Quick Start

### Token Authentication

The simplest setup. Use a Personal Access Token or the default `GITHUB_TOKEN` in Actions.

**CLI:**
```bash
# Via environment variable (recommended)
GITHUB_TOKEN=ghp_xxx visor --config .visor.yaml

# Via CLI flag
visor --github-token ghp_xxx --config .visor.yaml
```

**GitHub Actions:**
```yaml
- uses: probelabs/visor@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

### GitHub App Authentication

Recommended for organizations. Provides granular permissions, bot identity, and audit logging.

**CLI:**
```bash
# Via environment variables
GITHUB_APP_ID=12345 \
GITHUB_APP_PRIVATE_KEY="$(cat key.pem)" \
visor --config .visor.yaml

# Via CLI flags
visor --github-app-id 12345 \
      --github-private-key ./key.pem \
      --config .visor.yaml
```

**GitHub Actions:**
```yaml
- uses: probelabs/visor@v1
  with:
    app-id: ${{ secrets.VISOR_APP_ID }}
    private-key: ${{ secrets.VISOR_PRIVATE_KEY }}
```

---

## CLI Options

| Option | Environment Variable | Description |
|--------|---------------------|-------------|
| `--github-token <token>` | `GITHUB_TOKEN` or `GH_TOKEN` | Personal access token or fine-grained token |
| `--github-app-id <id>` | `GITHUB_APP_ID` | GitHub App ID |
| `--github-private-key <key>` | `GITHUB_APP_PRIVATE_KEY` | App private key (PEM content or file path) |
| `--github-installation-id <id>` | `GITHUB_APP_INSTALLATION_ID` | Installation ID (auto-detected if omitted) |

**Resolution order:** CLI flags take precedence over environment variables.

---

## How It Works

When Visor authenticates with GitHub, it does three things:

### 1. Creates an Authenticated Octokit Instance

Used internally for GitHub API calls — posting PR comments, adding labels, creating check runs.

### 2. Sets Token Environment Variables

```
GITHUB_TOKEN=<token>
GH_TOKEN=<token>
```

These are inherited by all child processes, enabling:
- `gh` CLI commands in command checks
- `gh api` calls in AI agent bash steps
- Any tool that reads `GITHUB_TOKEN` from the environment

### 3. Configures Git HTTPS Credentials

```
GIT_CONFIG_COUNT=2
GIT_CONFIG_KEY_0=url.https://x-access-token:<token>@github.com/.insteadOf
GIT_CONFIG_VALUE_0=https://github.com/
GIT_CONFIG_KEY_1=url.https://x-access-token:<token>@github.com/.insteadOf
GIT_CONFIG_VALUE_1=git@github.com:
```

This uses git's `GIT_CONFIG_COUNT` mechanism (git 2.31+) to:
- Rewrite `https://github.com/` URLs to include the access token
- Rewrite `git@github.com:` SSH-style URLs to authenticated HTTPS
- Work on any machine regardless of local git configuration
- Require no temp files or global config changes
- Propagate automatically to all child processes

**Result:** `git clone`, `git push`, `git fetch`, and `git ls-remote` against github.com private repositories work automatically in command checks, AI agents, and MCP tools.

---

## GitHub App Setup

### 1. Create a GitHub App

1. Go to **Settings > Developer settings > GitHub Apps > New GitHub App**
2. Set a name (e.g., "Visor Bot")
3. Set the homepage URL (can be your repo URL)
4. Uncheck **Webhook > Active** (Visor doesn't need webhooks from the App)
5. Set permissions:
   - **Repository permissions:**
     - Contents: Read (for code access)
     - Pull requests: Read & Write (for comments, labels)
     - Checks: Read & Write (for check runs)
     - Issues: Read & Write (for issue operations)
     - Metadata: Read (required)
   - **Organization permissions:** None required
6. Click **Create GitHub App**

### 2. Generate a Private Key

1. On the App settings page, scroll to **Private keys**
2. Click **Generate a private key**
3. Save the downloaded `.pem` file securely

### 3. Install the App

1. Go to **Install App** in the sidebar
2. Select the organization or account
3. Choose **All repositories** or select specific repos
4. Click **Install**

### 4. Note the IDs

- **App ID**: Shown at the top of the App settings page
- **Installation ID**: Visible in the URL after installation (`/installations/<id>`)
  - Visor auto-detects this if you don't provide it

### 5. Store Secrets

**GitHub Actions:**
```bash
# Store as repository or organization secrets
gh secret set VISOR_APP_ID --body "12345"
gh secret set VISOR_PRIVATE_KEY < key.pem
```

**Local / CI:**
```bash
# Environment variables
export GITHUB_APP_ID=12345
export GITHUB_APP_PRIVATE_KEY="$(cat key.pem)"

# Or pass as file path
export GITHUB_APP_PRIVATE_KEY=./path/to/key.pem
```

---

## Token Permissions

### Personal Access Token (Classic)

Required scopes:
- `repo` — Full repository access (for private repos)
- `write:discussion` — Optional, for PR comments

### Fine-Grained Token

Required permissions:
- **Contents**: Read
- **Pull requests**: Read and Write
- **Issues**: Read and Write (if using label/comment operations)
- **Checks**: Read and Write (if using GitHub Checks API)

### Default `GITHUB_TOKEN` in Actions

The `${{ secrets.GITHUB_TOKEN }}` or `${{ github.token }}` works for most use cases. Limitations:
- Cannot trigger other workflows
- Cannot access other repositories
- Scoped to the current repository only

---

## Child Process Propagation

Visor's credential injection ensures authentication works across all provider types:

| Provider | What Works |
|----------|-----------|
| **command** | `gh pr list`, `git clone https://github.com/org/private-repo`, any tool reading `GITHUB_TOKEN` |
| **ai** (Claude Code) | Agent bash steps using `gh`, `git`, or any GitHub-aware CLI tool |
| **mcp** (stdio) | MCP server processes inherit all credentials |
| **github** (native) | Labels, comments, check runs via Octokit API |
| **git-checkout** | Cloning private repositories in worktrees |

### Example: Command Check with `gh`

```yaml
steps:
  list-prs:
    type: command
    exec: gh pr list --repo myorg/myrepo --json number,title
```

This works automatically when Visor has GitHub auth configured — no additional environment setup needed in the check definition.

### Example: AI Agent Accessing Private Repos

```yaml
steps:
  code-explorer:
    type: ai
    provider: claude-code
    prompt: |
      Clone the shared library from https://github.com/myorg/shared-lib
      and analyze its API surface.
    ai:
      allowBash: true
```

The agent's `git clone` command succeeds because the git credentials are in the environment.

---

## Without Authentication

When no GitHub credentials are provided:

- Visor runs normally — auth is optional in CLI mode
- GitHub provider checks (`type: github`) will return `github/missing_octokit` errors
- `gh` CLI commands will fail with auth errors
- `git` operations against private repos will fail
- Public repository operations still work

A warning is logged if auth is attempted but fails:

```
[warn] GitHub auth failed: <error message>
[warn] Continuing without GitHub API access
```

---

## Troubleshooting

### "No authenticated Octokit instance available"

The `github/missing_octokit` error means no credentials reached the GitHub provider.

**Fix:** Set `GITHUB_TOKEN` or configure App auth before running Visor.

### gh CLI shows "not logged in"

The `gh` CLI reads `GITHUB_TOKEN` or `GH_TOKEN` from the environment.

**Check:** Run `visor --debug` and look for `GitHub auth: token` or `GitHub auth: github-app` in the output.

### git clone fails for private repos

Git needs credentials configured. Visor sets `GIT_CONFIG_*` env vars automatically.

**Check:**
1. Verify auth is working: look for the auth log line
2. Verify git version is 2.31+ (`git --version`)
3. For SSH URLs (`git@github.com:...`), Visor rewrites them to HTTPS automatically

### GitHub App installation ID not found

If auto-detection fails:
```
GitHub App installation ID could not be auto-detected
```

**Fix:** Provide the installation ID explicitly:
```bash
visor --github-installation-id 12345678
# or
export GITHUB_APP_INSTALLATION_ID=12345678
```

### Token not propagating to child processes

**Check:** Add a debug command check to verify:
```yaml
steps:
  debug-auth:
    type: command
    exec: |
      echo "GITHUB_TOKEN set: $([ -n "$GITHUB_TOKEN" ] && echo yes || echo no)"
      echo "GIT_CONFIG_COUNT: $GIT_CONFIG_COUNT"
      gh auth status 2>&1 || true
```

---

## Security Considerations

- Tokens are stored only in `process.env` — no files are written to disk
- Git credentials use `GIT_CONFIG_COUNT` env vars, not `.gitconfig` or credential helpers
- All credentials are scoped to the Visor process and its children
- When the process exits, no persistent state remains
- For GitHub Apps, Visor extracts a short-lived installation token (~1 hour expiry)

See [Security](./security.md) for broader security guidance.

---

## Related Documentation

- [Security](./security.md) - Security best practices and authentication overview
- [Action Reference](./action-reference.md) - GitHub Action inputs and outputs
- [CI/CLI Mode](./ci-cli-mode.md) - Running Visor in CI pipelines
- [GitHub Provider](./github-ops.md) - Native GitHub operations (labels, comments)
- [Command Provider](./command-provider.md) - Running shell commands
- [Claude Code](./claude-code.md) - AI agent integration
