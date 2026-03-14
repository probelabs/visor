# Telemetry Reference — Spans, Metrics & Events

This document is the complete reference for all OpenTelemetry signals emitted by Visor. Use it to build Grafana dashboards, set up alerts, or debug execution flows.

For setup instructions, see [Telemetry Setup Guide](./telemetry-setup.md).

---

## Metrics

All metrics use the `visor` meter and are exported when the OTLP sink is configured with `@opentelemetry/exporter-metrics-otlp-http`.

> **Prometheus naming**: OTel metric names use dots (e.g., `visor.run.total`) but Prometheus converts them to underscores (e.g., `visor_run_total`). The table below shows both forms.

### Run Metrics

| Metric | Prometheus Name | Type | Unit | Description |
|--------|----------------|------|------|-------------|
| `visor.run.total` | `visor_run_total` | Counter | 1 | Total number of visor runs (workflow executions) |
| `visor.run.duration_ms` | `visor_run_duration_ms` | Histogram | ms | Duration of a complete visor run |
| `visor.run.active_checks` | `visor_run_active_checks` | UpDownCounter | 1 | Number of checks actively running (concurrent gauge) |
| `visor.run.ai_calls` | `visor_run_ai_calls` | Histogram | 1 | Number of AI calls per visor run |

**Labels for `visor.run.total`:**

| Label | Description | Example |
|-------|-------------|---------|
| `visor.run.source` | Entry point that started the run | `cli`, `slack`, `tui`, `tui-rerun` |
| `visor.run.user_id` | User identifier (Slack user ID, etc.) | `U01ABC123` |
| `visor.run.user_name` | User display name | `alice` |
| `visor.run.workflow` | Comma-separated check IDs | `security,performance` |
| `visor.instance_id` | Unique instance identifier | `abc123` |

**Labels for `visor.run.duration_ms`:**

| Label | Description | Example |
|-------|-------------|---------|
| `visor.run.source` | Entry point | `cli`, `slack`, `tui` |
| `visor.run.user_id` | User identifier | `U01ABC123` |
| `visor.run.workflow` | Check IDs | `security,performance` |
| `visor.run.success` | Whether the run succeeded | `true`, `false` |

### Check Metrics

| Metric | Prometheus Name | Type | Unit | Description |
|--------|----------------|------|------|-------------|
| `visor.check.duration_ms` | `visor_check_duration_ms` | Histogram | ms | Duration of a single check execution |
| `visor.check.issues` | `visor_check_issues_total` | Counter | 1 | Number of issues produced by checks |

**Labels:**

| Label | Applies To | Description |
|-------|-----------|-------------|
| `visor.check.id` | Both | Check identifier (e.g., `security`, `overview`) |
| `visor.check.group` | `duration_ms` | Check group (default: `default`) |
| `severity` | `issues` | Issue severity level |

### Provider Metrics

| Metric | Prometheus Name | Type | Unit | Description |
|--------|----------------|------|------|-------------|
| `visor.provider.duration_ms` | `visor_provider_duration_ms` | Histogram | ms | Duration of provider execution |
| `visor.foreach.item.duration_ms` | `visor_foreach_item_duration_ms` | Histogram | ms | Duration of a single forEach item |

**Labels:**

| Label | Applies To | Description |
|-------|-----------|-------------|
| `visor.check.id` | Both | Check identifier |
| `visor.provider.type` | `provider.duration_ms` | Provider type (`ai`, `command`, `http`, etc.) |
| `visor.foreach.index` | `foreach.item.duration_ms` | Iteration index |
| `visor.foreach.total` | `foreach.item.duration_ms` | Total items in forEach |

### AI Metrics

| Metric | Prometheus Name | Type | Unit | Description |
|--------|----------------|------|------|-------------|
| `visor.ai_call.total` | `visor_ai_call_total` | Counter | 1 | Total number of AI provider calls |

**Labels:**

| Label | Description | Example |
|-------|-------------|---------|
| `visor.check.id` | Check that triggered the AI call | `security` |
| `visor.ai.model` | AI model name | `gemini-2.5-flash`, `claude-sonnet-4-5-20250514` |
| `visor.run.source` | Entry point | `cli`, `slack` |

### Other Metrics

| Metric | Prometheus Name | Type | Unit | Description |
|--------|----------------|------|------|-------------|
| `visor.fail_if.triggered` | `visor_fail_if_triggered_total` | Counter | 1 | Times a fail_if condition triggered |
| `visor.diagram.blocks` | `visor_diagram_blocks_total` | Counter | 1 | Mermaid diagram blocks emitted |

---

## Spans

### Root Span

| Span Name | Description |
|-----------|-------------|
| `visor.run` | Root span wrapping an entire workflow execution. One per CLI invocation, Slack message, or TUI interaction. |

**Attributes on `visor.run`:**

| Attribute | Description |
|-----------|-------------|
| `visor.version` | Visor version (from package.json or `VISOR_VERSION` env) |
| `visor.commit` | Git commit short SHA |
| `visor.commit.sha` | Git commit full SHA |
| `visor.instance_id` | Unique instance identifier |
| `visor.run.source` | Entry point: `cli`, `slack`, `tui`, `tui-rerun`, `slack_message_trigger` |
| `visor.run.ai_calls` | Total AI calls made during this run |
| `visor.run.duration_ms` | Run duration in milliseconds |

Additional attributes for Slack message triggers:

| Attribute | Description |
|-----------|-------------|
| `visor.trigger.id` | Trigger configuration ID |
| `visor.trigger.workflow` | Triggered workflow name |
| `slack.channel_id` | Slack channel ID |
| `slack.thread_ts` | Slack thread timestamp |
| `slack.user_id` | Slack user ID |

### State Machine Spans

| Span Name | Description |
|-----------|-------------|
| `engine.state.init` | Engine initialization |
| `engine.state.planready` | Plan is ready for execution |
| `engine.state.waveplanning` | Planning which checks to execute in the next wave |
| `engine.state.leveldispatch` | Dispatching checks for execution |
| `engine.state.checkrunning` | Checks are actively running |
| `engine.state.completed` | Engine has completed |
| `engine.state.error` | Engine encountered an error |

**Attributes on state spans:**

| Attribute | Description |
|-----------|-------------|
| `wave` | Current execution wave number |
| `wave_kind` | Wave type |
| `session_id` | Session identifier |
| `level_size` | Number of checks planned in this wave |
| `level_checks_preview` | Preview of check IDs in this wave |

### Check Spans

| Span Name | Description |
|-----------|-------------|
| `visor.check.<checkId>` | Execution of a single check (e.g., `visor.check.security`) |

**Attributes on check spans:**

| Attribute | Description |
|-----------|-------------|
| `visor.check.id` | Check identifier |
| `visor.check.type` | Provider type (`ai`, `command`, `http`, `mcp`, `claude-code`, `noop`, `logger`) |
| `visor.foreach.index` | Iteration index (if inside a forEach) |
| `session_id` | Session identifier |
| `wave` | Wave number |
| `visor.check.effective_timeout` | Computed timeout in ms (capped by parent deadline) |
| `visor.check.deadline` | Absolute deadline timestamp |
| `visor.check.parent_deadline` | Parent workflow's deadline (if nested) |
| `visor.check.ai_timeout` | Probe soft timeout in ms (if configured) |
| `visor.check.timeout_behavior` | `graceful` or `negotiated` (if configured) |
| `visor.check.negotiated_timeout_budget` | Total extra time budget in ms (if configured) |
| `visor.check.negotiated_timeout_max_requests` | Max extension requests (if configured) |
| `visor.check.negotiated_timeout_max_per_request` | Max time per extension in ms (if configured) |
| `visor.check.graceful_stop_deadline` | Wind-down window in ms (if configured) |

### AI Provider Spans

| Span Name | Description |
|-----------|-------------|
| `visor.ai_check` | Fresh AI agent call (new session) |
| `visor.ai_check_reuse` | AI agent call reusing an existing session |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `check.name` | Check name |
| `check.session_id` | AI session ID (fresh calls only) |
| `check.mode` | `session_reuse` (reuse calls only) |
| `prompt.length` | Length of the prompt in characters |
| `schema.type` | Output schema type |
| `probe.ai_timeout` | Probe-level soft timeout in ms |
| `probe.visor_timeout` | Visor hard timeout in ms |
| `probe.timeout_behavior` | `graceful` or `negotiated` |
| `probe.negotiated_timeout_budget` | Total observer extension budget in ms |
| `probe.negotiated_timeout_max_requests` | Max extension requests |
| `probe.negotiated_timeout_max_per_request` | Max time per extension in ms |
| `probe.graceful_stop_deadline` | Wind-down window for sub-agents in ms |

### Sandbox Spans

| Span Name | Description |
|-----------|-------------|
| `visor.sandbox.start` | Starting a sandbox container |
| `visor.sandbox.exec` | Executing a command in a sandbox |
| `visor.sandbox.stopAll` | Stopping all sandboxes |
| `visor.sandbox.build` | Building a sandbox Docker image |
| `visor.sandbox.runCheck` | Running a check inside a sandbox |
| `visor.sandbox.child.<type>` | Sandbox child process execution |

### Agent Protocol Spans

| Span Name | Description |
|-----------|-------------|
| `agent.task` | A2A agent task execution |
| `agent.queue.execute` | Task queue worker execution |

---

## Span Events

Events are attached to the currently active span and provide fine-grained execution details.

### Routing Events

| Event Name | Description |
|------------|-------------|
| `visor.routing` | A routing decision was made after a check completed |

**Attributes:** `check_id`, `trigger`, `action` (`retry`/`goto`/`run`), `target`, `source`, `scope`, `goto_event`

### Failure Condition Events

| Event Name | Description |
|------------|-------------|
| `fail_if.evaluated` | A fail_if condition was evaluated |
| `fail_if.triggered` | A fail_if condition was triggered (failed) |

**Attributes:** `visor.check.id`, `scope` (`global`/`check`), `expression`, `result`, `severity`, `name`

### Tool Setup Events (AI Provider)

| Event Name | Description |
|------------|-------------|
| `tool_setup.mcp_servers_js` | MCP servers loaded from dynamic JS expression |
| `tool_setup.mcp_servers_js_error` | Error evaluating MCP server expression |
| `tool_setup.mcp_servers_js_skipped` | MCP server setup skipped |
| `tool_setup.resolution` | Tool name resolution completed |
| `tool_setup.sse_server_error` | SSE tool server connection failed |
| `tool_setup.final` | Final tool setup summary |

### Sandbox Events

| Event Name | Description |
|------------|-------------|
| `visor.sandbox.container.started` | Docker container started |
| `visor.sandbox.container.stopped` | Docker container stopped |
| `visor.sandbox.bwrap.exec` | Bubblewrap sandbox execution |
| `visor.sandbox.seatbelt.exec` | Seatbelt sandbox execution |
| `visor.sandbox.stopped` | Sandbox stopped |

### Timeout Configuration Events (AI Provider)

| Event Name | Description |
|------------|-------------|
| `probe.timeout_configured` | Emitted when a ProbeAgent is created with timeout configuration |

**Attributes:** `probe.ai_timeout`, `probe.visor_timeout`, `probe.timeout_behavior`, `probe.negotiated_timeout_budget`, `probe.negotiated_timeout_max_requests`, `probe.negotiated_timeout_max_per_request`, `probe.graceful_stop_deadline`

### Graceful Stop Events (MCP Server)

| Event Name | Description |
|------------|-------------|
| `graceful_stop.invoked` | The `graceful_stop` MCP tool was called |
| `graceful_stop.deadline_shortened` | Shared execution deadline was shortened |
| `graceful_stop.session_signaled` | A ProbeAgent session was signaled to wind down |
| `graceful_stop.completed` | Graceful stop processing completed |

**Attributes for `graceful_stop.invoked`:** `mcp.session_id`, `mcp.server`

**Attributes for `graceful_stop.deadline_shortened`:** `mcp.session_id`, `graceful_stop.previous_deadline`, `graceful_stop.new_deadline`, `graceful_stop.remaining_ms`

**Attributes for `graceful_stop.session_signaled`:** `mcp.session_id`, `probe.session_id`

**Attributes for `graceful_stop.completed`:** `mcp.session_id`, `graceful_stop.sessions_signaled`

### Diagram Events

| Event Name | Description |
|------------|-------------|
| `diagram.block` | A Mermaid diagram block was emitted |

**Attributes:** `check`, `origin` (`content`/`issue`), `code`

---

## State Capture Attributes

When `VISOR_TELEMETRY_FULL_CAPTURE=true`, additional detailed attributes are captured on check spans:

### Check Input Context

| Attribute | Description | Max Size |
|-----------|-------------|----------|
| `visor.check.input.keys` | Comma-separated context variable names | — |
| `visor.check.input.count` | Number of context keys | — |
| `visor.check.input.context` | Full template context (JSON, sanitized) | 10 KB |
| `visor.check.input.pr` | PR information subset | 1 KB |
| `visor.check.input.outputs` | Previous check outputs | 5 KB |
| `visor.check.input.env_keys` | Environment variable keys available | — |

### Check Output

| Attribute | Description | Max Size |
|-----------|-------------|----------|
| `visor.check.output.type` | Output type (`object`, `array`, `string`) | — |
| `visor.check.output.length` | Array length (if output is array) | — |
| `visor.check.output.preview` | Preview of first 10 items | 2 KB |
| `visor.check.output` | Full serialized output | 10 KB |

### Provider Call Details

| Attribute | Description | Max Size |
|-----------|-------------|----------|
| `visor.provider.type` | Provider type | — |
| `visor.provider.request.model` | AI model name | — |
| `visor.provider.request.prompt.length` | Prompt character count | — |
| `visor.provider.request.prompt.preview` | Prompt preview | 500 B |
| `visor.provider.request.prompt` | Full prompt (full capture only) | 10 KB |
| `visor.provider.response.length` | Response character count | — |
| `visor.provider.response.preview` | Response preview | 500 B |
| `visor.provider.response.content` | Full response (full capture only) | 10 KB |
| `visor.provider.response.tokens` | Token count (if available) | — |

### Liquid Template Evaluation

| Attribute | Description | Max Size |
|-----------|-------------|----------|
| `visor.liquid.template` | Template source | 1 KB |
| `visor.liquid.result` | Rendered result | 2 KB |
| `visor.liquid.context` | Template context | 3 KB |

### Transform JS

| Attribute | Description | Max Size |
|-----------|-------------|----------|
| `visor.transform.code` | JavaScript code | 2 KB |
| `visor.transform.input` | Input data | 2 KB |
| `visor.transform.output` | Output data | 2 KB |

### Conditional Evaluation

| Attribute | Description | Max Size |
|-----------|-------------|----------|
| `visor.condition.expression` | Condition expression | 500 B |
| `visor.condition.result` | Boolean evaluation result | — |
| `visor.condition.context` | Evaluation context | 2 KB |

### Routing Decision

| Attribute | Description |
|-----------|-------------|
| `visor.routing.action` | Action: `retry`, `goto`, `run` |
| `visor.routing.target` | Target check(s) or event |
| `visor.routing.condition` | Routing condition expression |

---

## Resource Attributes

The OTel resource is configured with:

| Attribute | Value |
|-----------|-------|
| `service.name` | `visor` |
| `service.version` | Visor version or `dev` |
| `deployment.environment` | `github-actions`, `ci`, or `local` |

---

## Example Queries

### Prometheus / Grafana

```promql
# Total runs per user (last 24h)
sum by (visor_run_user_id) (increase(visor_run_total[24h]))

# Average run duration by workflow
avg by (visor_run_workflow) (visor_run_duration_ms_sum / visor_run_duration_ms_count)

# AI calls per run (average)
avg(visor_run_ai_calls_sum / visor_run_ai_calls_count)

# AI calls by model (rate)
sum by (visor_ai_model) (rate(visor_ai_call_total[5m]))

# P95 check duration
histogram_quantile(0.95, sum(rate(visor_check_duration_ms_bucket[5m])) by (le, visor_check_id))

# Failed runs rate
sum(rate(visor_run_duration_ms_count{visor_run_success="false"}[5m]))

# Active concurrent checks
visor_run_active_checks
```

### Tempo (TraceQL)

```
# Find all runs from Slack
{ resource.service.name = "visor" && name = "visor.run" && span.visor.run.source = "slack" }

# Find slow checks (>30s)
{ resource.service.name = "visor" && name =~ "visor.check.*" } | duration > 30s

# Find runs with many AI calls
{ resource.service.name = "visor" && name = "visor.run" && span.visor.run.ai_calls > 10 }

# Find failed routing decisions
{ resource.service.name = "visor" } >> { name = "visor.routing" && span.action = "retry" }
```

---

## Related Documentation

- [Telemetry Setup Guide](./telemetry-setup.md) — How to enable and configure telemetry
- [Debugging Guide](./debugging.md) — Debugging techniques including tracing
- [Grafana Dashboards](./dashboards/) — Pre-built dashboards for Visor telemetry
