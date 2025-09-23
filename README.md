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

1) Add the Action

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

2) Open a PR
- Visor posts a PR summary, creates GitHub Check runs, and annotates lines.

3) (Optional) Add `.visor.yaml`

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

- 90‑second Quick Start
- Core Concepts
- Beyond Code Review
- Features
- When to pick Visor
- Developer Experience Playbook
- Tag-Based Filtering
- PR Comment Commands
- Suppress Warnings
- CLI Usage
- Troubleshooting
- Security Defaults
- Performance & Cost Controls
- Observability
- AI Configuration
- Step Dependencies
- Claude Code Provider
- AI Session Reuse
- Schema-Template System
- Enhanced Prompts
- Advanced Configuration
- HTTP Integration & Scheduling
- Pluggable Architecture
- Configuration
- GitHub Action Reference
- Output Formats

## ✨ Features

- Automated PR Reviews with native annotations and check runs
- Schema + template system for structured, predictable outputs
- Grouped comments, tags, and dependency‑aware execution
- Any CI via CLI; first‑class GitHub Action support
- Cron, webhooks, HTTP server/client, and MCP tools support

## When to pick Visor

- You want native GitHub checks/annotations and config‑driven behavior
- You need structured outputs (schemas) and predictable templates
- You care about dependency‑aware execution and tag‑based profiles
- You want PR reviews + assistants + scheduled audits from one tool
- You prefer open‑source with no hidden rules

## 🧭 Developer Experience Playbook

Learn more: docs/dev-playbook.md

## 🏷️ Tag-Based Check Filtering

Run subsets of checks with tags (e.g., `local`, `fast`, `security`) and filter via `--tags`/`--exclude-tags`.

Learn more: docs/tag-filtering.md

## 💬 PR Comment Commands

Learn more: docs/commands.md

## 🔇 Suppressing Warnings

Learn more: docs/suppressions.md

## 📋 CLI Usage

See docs/NPM_USAGE.md for full CLI options and examples.

## 🛠️ Troubleshooting

Learn more: docs/troubleshooting.md

## 🔐 Security Defaults

Learn more: docs/security.md

## ⚡ Performance & Cost Controls

Learn more: docs/performance.md

## 👀 Observability

Learn more: docs/observability.md

## 🤖 AI Configuration

Learn more: docs/ai-configuration.md

## 📊 Step Dependencies & Intelligent Execution

Define `depends_on` to control order; independent checks run in parallel.

Learn more: docs/dependencies.md

## 🤖 Claude Code Provider

Learn more: docs/claude-code.md

## 🔄 AI Session Reuse

Learn more: docs/advanced-ai.md

## 📋 Schema-Template System

Learn more: docs/schema-templates.md

## 🎯 Enhanced Prompts

Learn more: docs/schema-templates.md

## 🔧 Advanced Configuration

Learn more: docs/configuration.md

## 🌐 HTTP Integration & Scheduling

Learn more: docs/http.md

## 🔧 Pluggable Architecture

Learn more: docs/pluggable.md

## ⚙️ Configuration

Use `.visor.yaml` to add custom checks for your repo and extend defaults.

Learn more: docs/configuration.md

## 🎯 GitHub Action Reference

Learn more: docs/action-reference.md

## 📊 Output Formats

Learn more: docs/output-formats.md

## 🤝 Contributing

Learn more: docs/contributing.md

## 📄 License

MIT License - see LICENSE

---

<div align="center">
  Made with ❤️ by <a href="https://probelabs.com">Probe Labs</a>
</div>

