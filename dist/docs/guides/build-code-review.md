# Build a Code Review Pipeline

This guide walks you through building an AI-powered code review pipeline that runs on every PR. By the end you'll have a working `.visor.yaml` that reviews code for security, style, and bugs.

## Prerequisites

- Node.js 18+
- An AI provider API key (Google, Anthropic, or OpenAI)

## Step 1: Install and scaffold

```bash
npm i -D @probelabs/visor
npx visor init
```

This creates a `.visor.yaml` with inline documentation. You can start from scratch too — here's the minimal version:

```yaml
version: "1.0"
ai_provider: google    # or: anthropic, openai, bedrock

steps:
  review:
    type: ai
    prompt: "Review the code changes for bugs and security issues."
```

Run it: `npx visor`

## Step 2: Add focused review steps

Split your review into focused steps that run in parallel:

```yaml
version: "1.0"
ai_provider: google

steps:
  security:
    type: ai
    prompt: "Find security vulnerabilities in the changed code."
    ai:
      system_prompt: "You are a security expert. Focus on OWASP Top 10."
    tags: [security, fast]

  style:
    type: ai
    prompt: "Check code style and naming conventions."
    tags: [style, fast]

  architecture:
    type: ai
    prompt: "Review architectural decisions and suggest improvements."
    tags: [architecture]
```

Run only fast checks: `npx visor --tags fast`

## Step 3: Add shell commands

Mix AI steps with real tooling:

```yaml
  lint:
    type: command
    exec: npx eslint --format json src/
    tags: [fast, lint]

  tests:
    type: command
    exec: npm test -- --coverage --json
    tags: [fast, test]
```

Command steps auto-parse JSON output — no `parseJson` flag needed.

## Step 4: Chain steps with dependencies

```yaml
  summary:
    type: ai
    prompt: |
      Summarize all review findings:
      Security: {{ outputs["security"] | json }}
      Style: {{ outputs["style"] | json }}
      Lint: {{ outputs["lint"] | json }}
      Tests: {{ outputs["tests"] | json }}
    depends_on: [security, style, lint, tests]
    tags: [summary]
```

Steps without `depends_on` run in parallel. Steps with dependencies wait.

## Step 5: Deploy as a GitHub Action

Create `.github/workflows/visor.yml`:

```yaml
name: Visor Code Review
on:
  pull_request:
    types: [opened, synchronize]
permissions:
  contents: read
  pull-requests: write
  checks: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: probelabs/visor@v1
        env:
          GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
```

Visor will post review comments directly on the PR.

## Step 6: Add conditional failure

Fail the CI check if critical issues are found:

```yaml
  summary:
    type: ai
    # ...
    fail_if: "output.issues && output.issues.some(i => i.severity === 'critical')"
```

## Complete example

See [examples/quick-start-tags.yaml](../../examples/quick-start-tags.yaml) for a working config, or [examples/enhanced-config.yaml](../../examples/enhanced-config.yaml) for advanced features.

## Common mistakes

| Mistake | Fix |
|---------|-----|
| `system_prompt` at step level | Put it inside `ai:` block, or use `ai_system_prompt` |
| Top-level `ai:` block | Use `ai_provider` and `ai_model` at top level |
| `parseJson: true` on command steps | Not needed — commands auto-parse JSON |
| `provider:` at step level | Use `ai_provider` or put it inside `ai:` block |

Run `npx visor validate` to catch these early.

## Next steps

- [AI Configuration](../ai-configuration.md) — providers, retry, fallback
- [Failure Routing](../failure-routing.md) — auto-remediation on failures
- [Testing](../testing/getting-started.md) — write tests for your pipeline
- [Tag Filtering](../tag-filtering.md) — organize steps with tags
