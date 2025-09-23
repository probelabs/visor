<div align="center">
  <img src="site/visor.png" alt="Visor Logo" width="500" />
  
  # Visor — Open‑source SDLC automation & code review orchestration
  
  [![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue)](https://www.typescriptlang.org/)
  [![Node](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/)
  [![License](https://img.shields.io/badge/license-MIT-blue)]()
  
  Config‑driven checks and automations with native GitHub checks/annotations.
  PR reviews, issue assistants, release notes, scheduled audits, and webhooks.
  AI‑assisted when you want it, fully predictable when you don’t.
</div>

---

Visor ships with a ready-to-run configuration at `defaults/.visor.yaml`, so you immediately get:
- A staged review pipeline (`overview → security → performance → quality → style`).
- Native GitHub integration: check runs, annotations, and PR comments out of the box.
- Built‑in code answering assistant: trigger from any issue or PR comment, e.g. `/visor how it works?`.
- A manual release-notes generator for tagged release workflows.
- No magic: everything is config‑driven in `.visor.yaml`; prompts/context are visible and templatable.
- Built for scale: composable checks, tag-based profiles, and flexible `extends` for shared policies.

## 🚀 90‑second Quick Start

### Add the Action

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
          GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }} # or ANTHROPIC/OPENAI
```

### Open a PR
- Visor posts a PR summary, creates GitHub Check runs, and annotates lines.

### Optional: Add `.visor.yaml`

```yaml
version: "1.0"
checks:
  security:
    type: ai
    schema: code-review
    prompt: "Identify security issues in changed files"
    tags: ["fast", "security"]
```

Tip: Pin releases for stability, e.g. `uses: probelabs/visor@v1`.

## 🧩 Core Concepts (1 minute)

- Check – unit of work (`security`, `performance`).
- Schema – JSON shape checks return (e.g., `code-review`).
- Template – renders results (tables/markdown).
- Group – which comment a check is posted into.
- Provider – how a check runs (`ai`, `http`, `tool`, `script`, `claude-code`).
- Dependencies – `depends_on` controls order; independents run in parallel.
- Tags – label checks (`fast`, `local`, `comprehensive`) and filter with `--tags`.
- Events – PRs, issues, `/review` comments, webhooks, or cron schedules.

## Beyond Code Review

Visor is a general SDLC automation framework:
- PR Reviews – security/perf/style findings with native annotations
- Issue Assistant – `/visor …` for code Q&A and triage
- Release Notes – manual or tagged release workflows
- Scheduled Audits – cron‑driven checks against main
- Webhooks & HTTP – receive events, call APIs, and post results
- Policy‑as‑Code – schemas + templates for predictable, auditable outputs

## Table of Contents

- [90‑second Quick Start](#90-second-quick-start)
- [Core Concepts](#core-concepts-1-minute)
- [Beyond Code Review](#beyond-code-review)
- [Features](#features)
- [When to pick Visor](#when-to-pick-visor)
- [Developer Experience Playbook](#developer-experience-playbook)
- [Tag-Based Filtering](#tag-based-check-filtering)
- [PR Comment Commands](#pr-comment-commands)
- [Suppress Warnings](#suppressing-warnings)
- [CLI Usage](#cli-usage)
- [Troubleshooting](#troubleshooting)
- [Security Defaults](#security-defaults)
- [Performance & Cost Controls](#performance--cost-controls)
- [Observability](#observability)
- [AI Configuration](#ai-configuration)
- [Step Dependencies](#step-dependencies--intelligent-execution)
- [Claude Code Provider](#claude-code-provider)
- [AI Session Reuse](#ai-session-reuse)
- [Schema-Template System](#schema-template-system)
- [Enhanced Prompts](#enhanced-prompts)
- [Advanced Configuration](#advanced-configuration)
- [HTTP Integration & Scheduling](#http-integration--scheduling)
- [Pluggable Architecture](#pluggable-architecture)
- [GitHub Action Reference](#github-action-reference)
- [Output Formats](#output-formats)

## ✨ Features

- Native GitHub reviews: Check runs, inline annotations, and status reporting wired into PRs.
- Config‑first: One `.visor.yaml` defines checks, prompts, schemas, and templates — no hidden logic.
- Structured outputs: JSON Schema validation drives deterministic rendering, annotations, and SARIF.
- Orchestrated pipelines: Dependencies, parallelism, and tag‑based profiles; run in Actions or any CI.
- Multi‑provider AI: Google Gemini, Anthropic Claude, OpenAI — plus MCP tools and Claude Code SDK.
- Assistants & commands: `/review` to rerun checks, `/visor …` for Q&A, predictable comment groups.
- HTTP & schedules: Receive webhooks, call external APIs, and run cron‑scheduled audits and reports.
- Extensible providers: `ai`, `http`, `http_client`, `log`, `tool`, `script`, `claude-code` — or add your own.
- Security by default: GitHub App support, scoped tokens, remote‑extends allowlist, opt‑in network usage.
- Observability & control: JSON/SARIF outputs, fail‑fast and timeouts, parallelism and cost control.

## When to pick Visor

- You want native GitHub checks/annotations and config‑driven behavior
- You need structured outputs (schemas) and predictable templates
- You care about dependency‑aware execution and tag‑based profiles
- You want PR reviews + assistants + scheduled audits from one tool
- You prefer open‑source with no hidden rules

## 🧭 Developer Experience Playbook

Start with the defaults, iterate locally, and commit a shared `.visor.yaml` for your team.

Example:
```bash
npx @probelabs/visor --check all --debug
```

Learn more: docs/dev-playbook.md

## 🏷️ Tag-Based Check Filtering

Run subsets of checks (e.g., `local`, `fast`, `security`) and select them per environment with `--tags`/`--exclude-tags`.

Example:
```yaml
checks:
  security-quick:
    type: ai
    prompt: "Quick security scan"
    tags: ["local", "fast", "security"]
```

CLI:
```bash
visor --tags local,fast
```

Learn more: docs/tag-filtering.md

## 💬 PR Comment Commands

Trigger reviews and assistant actions via comments on PRs/issues.

Examples:
```
/review
/review --check security
/visor how does caching work?
```

Learn more: docs/commands.md

## 🔇 Suppressing Warnings

Suppress a specific issue by adding a nearby `visor-disable` comment.

Example (JS):
```js
const testPassword = "demo123"; // visor-disable
```

Learn more: docs/suppressions.md

## 📋 CLI Usage

Run locally in any CI or dev machine.

Example:
```bash
npx @probelabs/visor --check all --output table
```

See docs/NPM_USAGE.md for full options and examples.

## 🛠️ Troubleshooting

If comments/annotations don’t appear, verify workflow permissions and run with `--debug`.

Example:
```bash
node dist/index.js --cli --check all --debug
```

Learn more: docs/troubleshooting.md

## 🔐 Security Defaults

Prefer a GitHub App for production, and restrict remote extends unless explicitly allowed.

Examples:
```bash
visor --no-remote-extends
visor --allowed-remote-patterns "https://raw.githubusercontent.com/myorg/"
```

Learn more: docs/security.md

## ⚡ Performance & Cost Controls

Use tags for fast lanes and raise parallelism cautiously.

Example:
```bash
visor --tags local,fast --max-parallelism 5
```

Learn more: docs/performance.md

## 👀 Observability

Use JSON for pipelines or SARIF for code scanning.

Examples:
```bash
visor --check security --output json
visor --check security --output sarif > visor-results.sarif
```

Learn more: docs/observability.md

## 🤖 AI Configuration

Set one provider key (Google/Anthropic/OpenAI) via env.

Example (Action):
```yaml
- uses: probelabs/visor@v1
  env:
    GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
```

Learn more: docs/ai-configuration.md

## 📊 Step Dependencies & Intelligent Execution

Define `depends_on` to enforce order; independent checks run in parallel.

Example:
```yaml
checks:
  security:   { type: ai }
  performance:{ type: ai, depends_on: [security] }
```

Learn more: docs/dependencies.md

## 🤖 Claude Code Provider

Use the Claude Code SDK as a provider for deeper analysis.

Example:
```yaml
checks:
  claude-review:
    type: claude-code
    prompt: "Analyze code complexity"
```

Learn more: docs/claude-code.md

## 🔄 AI Session Reuse

Reuse context between dependent AI checks for smarter follow‑ups.

Example:
```yaml
checks:
  security: { type: ai }
  remediation:
    type: ai
    depends_on: [security]
    reuse_ai_session: true
```

Learn more: docs/advanced-ai.md

## 📋 Schema-Template System

Schemas validate outputs; templates render GitHub‑friendly comments.

Example:
```yaml
checks:
  security:
    type: ai
    schema: code-review
    prompt: "Return JSON matching code-review schema"
```

Learn more: docs/schema-templates.md

## 🎯 Enhanced Prompts

Write prompts inline or in files; Liquid variables provide PR context.

Example:
```yaml
checks:
  overview:
    type: ai
    prompt: ./prompts/overview.liquid
```

Learn more: docs/schema-templates.md

## 🔧 Advanced Configuration

Extend shared configs and override per‑repo settings.

Example:
```yaml
extends:
  - default
  - ./team-standards.yaml
```

Learn more: docs/configuration.md

## 🌐 HTTP Integration & Scheduling

Receive webhooks, call APIs, and schedule checks.

Examples:
```yaml
http_server: { enabled: true, port: 8080 }
checks:
  nightly: { type: ai, schedule: "0 2 * * *" }
```

Learn more: docs/http.md

## 🔧 Pluggable Architecture

Mix providers (`ai`, `http`, `http_client`, `log`, `tool`, `script`, `claude-code`) or add your own.

Learn more: docs/pluggable.md

## 🎯 GitHub Action Reference

Common inputs include `max-parallelism`, `fail-fast`, and `config-path`.

Example:
```yaml
- uses: probelabs/visor@v1
  with:
    max-parallelism: 5
```

Learn more: docs/action-reference.md

## 📊 Output Formats

Emit `table`, `json`, `markdown`, or `sarif`.

Example:
```bash
visor --check security --output json
```

Learn more: docs/output-formats.md

## 🤝 Contributing

Learn more: docs/contributing.md

## 📄 License

MIT License - see LICENSE

---

<div align="center">
  Made with ❤️ by <a href="https://probelabs.com">Probe Labs</a>
</div>
