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
- **Invalid check types** (must be: `ai`, `claude-code`, `command`, `http`, `http_input`, `http_client`, `noop`, `log`, `github`)
- **Invalid event triggers** (e.g., `scheduled` should be `schedule`)
- **Incorrect field names** and typos
- **Schema compliance** for all configuration options

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

Error: Invalid check type "webhook". Must be: ai, claude-code, command, http, http_input, http_client, noop, log, github

💡 Hint: The 'webhook' type has been renamed to 'http' for output and 'http_input' for input.
```

### Check-Level AI Configuration

Override global AI settings at the check level:

```yaml
# Global AI settings (optional)
ai_provider: anthropic  # or google, openai, bedrock
ai_model: claude-3-sonnet
ai_temperature: 0.2

steps:
  performance-review:
    type: ai
    ai:
      provider: google
      model: gemini-1.5-pro
      temperature: 0.1
    prompt: "Analyze performance metrics and provide optimization suggestions"

  security-review:
    type: ai
    ai_provider: bedrock  # Use AWS Bedrock for this step
    ai_model: anthropic.claude-sonnet-4-20250514-v1:0
    prompt: "Analyze code for security vulnerabilities"
```

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
