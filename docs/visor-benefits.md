# Visor benefits and example walkthrough

This document explains the core features of Visor, why they matter compared to
linear CI engines, and how those benefits show up in
`examples/visor-benefits.yaml`.

## Why Visor vs. a linear CI engine

Traditional CI pipelines are linear and tool-specific. Visor is a workflow
engine with explicit control flow, schemas, and providers.

Key differences:
- Config-first workflows. One YAML defines all steps, prompts, schemas,
  routing, and outputs. No hidden logic.
- Graph execution. Dependencies, fan-out, fan-in, and routing are first-class.
- Deterministic outputs. Schema validation + templates produce predictable
  artifacts for humans and machines.
- Multi-provider automation. Mix AI, HTTP, GitHub, shell, MCP, and memory in
  the same workflow.
- Stateful runs. Built-in memory and workflow isolation enable stateful,
  reproducible flows without external DBs.
- Observability. OpenTelemetry tracing and log correlation are built-in.
- Testable workflows. YAML-driven tests and fixtures validate behavior in CI.

## Walkthrough of `examples/visor-benefits.yaml`

The example is structured to show specific benefits in each block.

### 0) Composition and environment layering

- `extends` composes configs without copy/paste. Use this to keep org-wide
  standards in one place and override per environment.
- `imports` allows reusable workflows to be loaded and used as steps.

### 1) Observability and state

- `telemetry.enabled` turns on tracing and log correlation.
- `memory` provides a simple, local state store for counters, flags, and
  cross-step data.

### 2) Webhooks and frontends

- `http_server` defines inbound endpoints (webhooks) outside of GitHub events.
- `slack` enables Slack as a frontend for the same workflow.

### 3) Control-plane safety

- `routing.max_loops` bounds retries and goto loops for safe automation.
- Routing rules (`on_fail`, `goto`) are deterministic and capped.

### 4) Custom tools and MCP tools

- `tools` defines reusable tools (shell commands + JSON transforms).
- `ai_mcp_servers` exposes tools to AI steps via MCP.
- This makes AI runs auditable and tool usage explicit.

### 5) PR automation and schema outputs

- `pr-overview` uses `schema: overview` for structured output.
- Templates (`security-report.liquid`) render stable, predictable results.
- `apply-overview-labels` uses the native `github` provider for labels and
  comments without shelling out.

### 6) AI session reuse

- `security-remediation` uses `reuse_ai_session: true` to continue a prior
  AI conversation, keeping context deterministic and isolated.

### 7) MCP provider and Claude Code provider

- `semgrep-security-scan` is a native MCP provider step.
- `claude-architecture` shows the Claude Code provider with tool access.

### 8) Human in the loop

- `ask` uses `human-input` for Slack or CLI, enabling supervised flows.
- `route-intent` routes to either a direct answer or a review pipeline.

### 9) Cross-repo fan-out and checkout

- `plan-repos` is a dynamic fan-out (forEach) list.
- `checkout-repo` uses `git-checkout` with worktrees for fast, isolated clones.
- `analyze-repo` runs per repo and can call tools.
- `policy-gate` enforces release policy (fail fast on critical issues).
- `review-summary` aggregates cross-repo results via `outputs_raw`.

### 10) Output history

- `history-snapshot` shows `outputs_history` so you can inspect prior runs or
  loop iterations.

### 11) Workflow reuse and memory

- `calculator-demo` calls an imported workflow.
- `bump-run-counter` demonstrates workflow state via memory increments.

### 12) Outbound automation and schedules

- `notify-ops` posts to external systems via HTTP.
- `health-check` demonstrates scheduled `http_client` polling.

### 13) Self-healing loops (goto)

- `flaky-step` demonstrates deterministic retries and a `goto` loop back to
  `setup-env`.

## Other important features (not shown in YAML)

These are available but are runtime or tooling features rather than YAML keys:

- Output formats: table, markdown, JSON, SARIF (`--output`, `--output-file`).
- Debug visualizer and trace report exporter.
- YAML workflow tests with fixtures and mocks (`visor test`).
- SDK usage for programmatic workflows (TypeScript/JS).
- Security defaults and allowlists for remote config and tools.
- Tag-based filtering (`--tags`, `--exclude-tags`).
- CLI event simulation (`--event pr_opened`, `--event issue_comment`).

## Quick reference: providers you can mix

- ai, claude-code, mcp
- command, script
- http, http_client, http_input
- github
- log, memory, human-input, noop
- git-checkout, workflow

## Next steps

- See `examples/visor-benefits.yaml` for the runnable config.
- Explore `docs/` for deep dives on routing, failure handling, telemetry, and
  testing.
