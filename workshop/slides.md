---
title: Visor — SDLC Automation & Code Review Orchestrator
separator: ^---$
verticalSeparator: ^--$
revealOptions:
  transition: slide
  slideNumber: true
  hash: true
  controls: true
  progress: true
  center: true
---

# Visor Workshop

Open‑source SDLC automation and code review orchestration.

Note:
- You can press `S` to open speaker notes during the talk.
- Use left/right for sections, up/down for deeper dives.

--

## Presenting This Deck

```bash
npm run workshop:setup   # one time; pins reveal-md
npm run workshop:serve   # starts local server (watch mode)
# Exports
npm run workshop:export  # static HTML → workshop/build
npm run workshop:pdf     # PDF → workshop/Visor-Workshop.pdf
```

Note:
`workshop:pdf:a4` is available too; `workshop:pdf:ci` adds Puppeteer flags.

--

## Agenda (Iceberg Format)

- Surface: What Visor is and quick start
- Layer 1: Core concepts and defaults
- Layer 2: Code review pipeline (overview → security → performance → quality → style)
- Layer 3: Customizing (tags, dependencies, templates, prompts)
- Layer 4: Architecture & internals
- Layer 5: SDLC automations (cron, webhooks, HTTP, Jira, release notes)
- Layer 6: Nested runs, foreach/loops
- Layer 7: Debugging, logging, observability
- Layer 8: Extending providers and advanced recipes

Note:
Keep the tempo brisk on surface levels; dive vertically where the room shows interest.

---

# What Is Visor?

Config‑first automation for code review and SDLC workflows with native GitHub checks/annotations.

- Runs locally as a CLI and in CI/GitHub Actions
- Produces structured, predictable outputs (JSON, Markdown, SARIF)
- Composable checks with dependencies, tags, and templates
- Multi‑provider AI (or no‑AI) and HTTP/command integrations

Note:
“Orchestration” is the keyword: Visor coordinates checks, dependencies, and outputs; it does not hide logic.

--

## 90‑Second Quick Start

Action (minimal):
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
          GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
```

CLI (in this repo):
```bash
npx -y @probelabs/visor --output table
```

Note:
The defaults live in `defaults/.visor.yaml`. You can override with a project `.visor.yaml`.

--

## Lab 0 — First Run (2 min)

1) Run defaults locally (all checks):
```bash
npx -y @probelabs/visor --output table --debug
```
2) Try JSON output to a file:
```bash
npx -y @probelabs/visor --check security --output json --output-file visor-results.json
```
3) Filter by tags (fast/local):
```bash
npx -y @probelabs/visor --tags local,fast --max-parallelism 5
```

Note:
If no AI key is set, use mock provider via CLI flags in your demos.

---

# Core Concepts

- Check: unit of work (e.g., `security`)
- Schema: JSON shape for outputs (e.g., `code-review`)
- Template: how results are rendered
- Group: comment bucket (`overview`, `review`, etc.)
- Provider: execution engine (`ai`, `http`, `command`, `claude-code`, `log`)
- Dependencies: `depends_on` defines order; independents run in parallel
- Tags: label checks (`fast`, `local`, `comprehensive`) and filter via `--tags`
- Events: PRs, issues, comments, webhooks, or cron

--

## The Default Pipeline

`overview → security → performance → quality → style` with session reuse and GitHub annotations.

```yaml
# defaults/.visor.yaml (excerpt)
checks:
  overview:   { type: ai, group: overview }
  security:   { type: ai, group: review, depends_on: [overview], reuse_ai_session: true }
  performance:{ type: ai, group: review, depends_on: [security], reuse_ai_session: true }
  quality:    { type: ai, group: review, depends_on: [performance], reuse_ai_session: true }
  style:      { type: ai, group: review, depends_on: [quality], reuse_ai_session: true }
```

Note:
Session reuse keeps context flowing through the chain for deeper analysis.

--

## Lab 1 — Using Defaults (3 min)

Run only the `overview` and `security` checks:
```bash
npx -y @probelabs/visor --check overview,security --output table
```
Add `--debug` to see dependency decisions and timing.

---

# Code Review Workflow

Visor emits native GitHub check runs and inline annotations.

- Schemas ensure predictable, renderable outputs
- Comments grouped for easy scanning
- Suppress false positives with `// visor-disable`

--

## PR Comment Commands

Trigger from comments:
```
/review
/review --check security
/visor how does caching work?
```

Note:
Great demo: show an `/review` run, then a targeted rerun for `security` only.

--

## Lab 2 — Suppressions (2 min)

Add a suppression near a flagged line:
```js
const testPassword = "demo123"; // visor-disable
```
Re‑run and confirm the warning is suppressed.

---

# Customizing Visor

Start from defaults, extend for your repo’s needs.

--

## Tags and Profiles

```yaml
checks:
  security-quick:
    type: ai
    prompt: "Quick security scan"
    tags: [local, fast, security]
```

CLI:
```bash
npx -y @probelabs/visor --tags local,fast
```

--

## Dependencies and Orchestration

```yaml
checks:
  security:    { type: ai }
  performance: { type: ai, depends_on: [security] }
```

Independent checks run in parallel; dependent checks observe order.

--

## Templates and Prompts

Place prompts in files and render via Liquid:
```yaml
checks:
  overview:
    type: ai
    prompt: ./prompts/overview.liquid
```

Render JSON in debug templates with `| json`.

--

## Lab 3 — Your First Config (5 min)

Open `workshop/labs/lab-01-basic.yaml` and run:
```bash
npx -y @probelabs/visor --config workshop/labs/lab-01-basic.yaml --tags local,fast --output table
```
Tweak a prompt and rerun. Then add a tag and filter by it.

---

# Architecture

High‑level flow:

1. Event/CLI input
2. Load config (`.visor.yaml` or defaults)
3. Select checks (by `--check`, tags, or events)
4. Plan graph (dependencies, parallelism)
5. Execute providers (ai/http/command/claude-code/log)
6. Render templates → outputs (Markdown/JSON/SARIF)
7. Post to GitHub checks/annotations/comments (if configured)

--

## Components (Mental Model)

- CLI and Action entrypoints (Node 18+)
- Config manager (load/merge/extends)
- Orchestrator (graph, parallelism, retries, fail‑fast)
- Providers: `ai`, `command`, `http`, `http_client`, `log`, `claude-code`
- Renderers: JSON → templates → outputs

Note:
This modularity is why SDLC automations beyond code review feel natural in Visor.

---

# SDLC Automations

Examples beyond PR review:

- Release notes (manual, tag‑driven)
- Cron audits against main
- HTTP/webhooks (receive → run checks → respond)
- Jira workflows and status sync

--

## Demo Targets (from examples/)

- `examples/cron-webhook-config.yaml`
- `examples/http-integration-config.yaml`
- `examples/jira-simple-example.yaml`
- `defaults/.visor.yaml` (release notes)

Run one locally:
```bash
npx -y @probelabs/visor --config examples/http-integration-config.yaml --check github-webhook --output table
```

--

## Lab 4 — Release Notes (5 min)

Simulate a release notes generation:
```bash
TAG_NAME=v1.0.0 GIT_LOG="$(git log --oneline -n 20)" \
GIT_DIFF_STAT="$(git diff --stat HEAD~20..HEAD)" \
npx -y @probelabs/visor --config defaults/.visor.yaml --check release-notes --output markdown
```

Note:
This check is manual by design; perfect for tagged release pipelines.

---

# Nested Runs and Loops

Use `forEach`/loop patterns for multi‑target checks.

See: `examples/forEach-example.yaml`, `examples/for-loop-example.yaml`.

--

## Lab 5 — foreach (5 min)

Run the foreach example and observe dependency propagation:
```bash
npx -y @probelabs/visor --config examples/forEach-example.yaml --output table --debug
```

Note:
Great for monorepos (iterate packages/services) with shared prompts and per‑target context.

---

# Debugging & Observability

- `--debug` for verbose execution tracing
- Use `log()` inside `if:` and `transform_js:` expressions
- Dump context in templates via Liquid `| json`
- Emit `json` or `sarif` and save with `--output-file`

--

## Lab 6 — Debug & Logs (3 min)

Run the debug example config:
```bash
npx -y @probelabs/visor --config workshop/labs/lab-03-debug.yaml --check debug-check --output markdown --debug
```

Open the log output and correlate with the rendered markdown.

---

# Providers and Extensibility

Mix and match providers:

- `ai` — model‑based checks (Gemini/Claude/OpenAI/Bedrock)
- `command` — run shell tasks; great for linters/tests
- `http`/`http_client` — call external APIs or receive webhooks
- `log` — structured logging to outputs
- `claude-code` — deeper analysis via Claude Code SDK

--

## Minimal Command Provider Example

```yaml
checks:
  unit-tests:
    type: command
    exec: 'npm test --silent'
    on: [manual]
```

Run:
```bash
npx -y @probelabs/visor --config workshop/labs/lab-02-command.yaml --check unit-tests --output markdown

--

## Lab 4 — Classify → Select → Plan (8–10 min)

End‑to‑end planner that:
- Classifies a task description into components and checks
- Runs per‑component agents (with folder‑scoped context)
- Consolidates into a single implementation proposal

Run it fast with the mock provider:
```bash
npx -y @probelabs/visor --config workshop/labs/lab-04-planner.yaml --output markdown --debug
```

Optional: provide your own task via env var
```bash
TASK_DESC="Add caching to HTTP client without breaking retries" \
npx -y @probelabs/visor --config workshop/labs/lab-04-planner.yaml --output markdown
```

Note:
- If your shell exports real AI keys (e.g., `GOOGLE_API_KEY`), the underlying agent may auto‑select that provider. For offline demos, temporarily unset them:
```bash
env -u GOOGLE_API_KEY -u ANTHROPIC_API_KEY -u OPENAI_API_KEY \
npx -y @probelabs/visor --config workshop/labs/lab-04-planner.yaml --output markdown
```
```

--

## Building Your Own Provider (Conceptual)

1) Implement a provider module (inputs → run() → outputs)
2) Register it in config, choose a schema/template
3) Reuse orchestration (tags, deps, templates) for free

See: `docs/pluggable.md` and `docs/command-provider.md`.

---

# Cheatsheet

CLI sampling:

```bash
# Run all checks from current config (defaults if none)
npx -y @probelabs/visor --output table

# Filter by tags
npx -y @probelabs/visor --tags local,fast

# JSON/SARIF outputs
npx -y @probelabs/visor --check security --output json --output-file results.json
npx -y @probelabs/visor --check security --output sarif --output-file results.sarif

# Use a specific config
npx -y @probelabs/visor --config workshop/labs/lab-01-basic.yaml --tags local,fast

# Debugging
npx -y @probelabs/visor --debug
```

Note:
Close with Q&A or jump back to any iceberg layer based on questions.
