# Telemetry & Tracing Platform — RFC

Status: Draft

Last updated: 2025-10-07

Owner: Visor team

Supersedes: telemetry-platform-rfc.md, opentelemetry-tracing-rfc.md (merged into this single RFC)
Related: execution-statistics-rfc.md, failure-routing-rfc.md

## Motivation

We want SonarCloud‑style visibility and durable, searchable traces for every Visor run. Beyond raw telemetry, the goal is to power dashboards (per repo/org, per check, trends) with no rate limiting in CI, while remaining privacy‑first and operable in both connected and serverless environments.

## Goals

- Open standards: adopt OpenTelemetry (OTel) as the primary API/SDK for tracing and metrics.
- Well‑thought spans covering runs, checks, providers, routing, forEach items, and diagram evaluation.
- Zero sampling in CI (AlwaysOn); rely on batching/queues, not drops or rate limiting.
- Serverless mode: write NDJSON (one span per line) simplified spans to disk for later ingestion (OTLP JSON optional later).
- Privacy by default: no raw code/AI payloads; hash/redact sensitive strings.
- Minimal overhead: lightweight Mermaid analysis; no rendering.

## Non‑Goals

- Rendering Mermaid diagrams into images/SVG.
- Replacing existing logs/execution statistics; this augments and unifies them.
- Sending data to third parties without explicit config.

## Overview

We introduce a unified telemetry platform centered on OpenTelemetry. The platform emits structured spans, metrics, and (optionally) events. It integrates with existing `ExecutionStatistics` and adds small, cheap Mermaid diagram checks for observability only.

Two deployment modes:
- Connected: OTLP (HTTP/gRPC) exporters to an OTel Collector (Tempo/Jaeger/etc.).
- Serverless: write NDJSON (one span per line) simplified spans to `output/traces/` for later upload. (Optional: OTLP JSON in a future iteration.)

## Node.js Standards & SDK Setup

- Use `@opentelemetry/sdk-node` with AsyncLocalStorage context manager.
- Auto‑instrumentations: `@opentelemetry/auto-instrumentations-node` (http, undici, child_process, dns; fs optional).
- Exporters: `@opentelemetry/exporter-trace-otlp-http` or gRPC; plus a custom FileSpanExporter for serverless.
- Sampler: AlwaysOn in CI (no sampling). In dev, allow ratio sampling.
- BatchSpanProcessor tuned for high throughput; large queues instead of rate limits.

### Unified Logging + Tracing

- Preferred approach: keep our existing logger, but inject OTel context (`trace_id`, `span_id`, `trace_flags`) into every log line.
- Implementation: `logger.ts` consults `@opentelemetry/api` `trace.getSpan(context.active())` to fetch ids and appends them as structured fields.
- Output: JSONL to stderr (unchanged) with added fields for correlation; pretty mode in local dev.
- Optional: if OTel Logs for Node is sufficiently stable in our env, add an OTLP Log Exporter alongside console JSONL. Otherwise, route logs to Loki/ELK with fields.
- Guarantees: every `console`/`logger` message becomes traceable via `trace_id/span_id` and shows up next to spans in backends that support exemplars/correlation.

## Span Topology

```
trace: visor.run (root span)
  ├─ visor.check (per check execution)
  │    ├─ visor.provider (ai|command|http|claude-code)
  │    ├─ visor.routing (retry/goto/run remediation)
  │    ├─ visor.foreach.item (when forEach is active)
  │    └─ visor.mermaid (extract/evaluate; no rendering)
  └─ auto‑instrumented http/undici/... spans
```

Naming & Status:
- `visor.run` — root; `OK` unless the entire run aborts.
- `visor.check` — `ERROR` on execution error or fail_if triggered; issues alone do not imply error.
- `visor.provider` — `ERROR` if provider call fails; captures model/provider attributes.
- `visor.routing` — spans for retry/goto/run_js decisions; `ERROR` if loop budget exceeded.
- `visor.foreach.item` — isolates per‑item timing/attributes.
- `visor.mermaid` — extract/evaluate spans; metrics only, no source persisted.

Span events to record decisions: `issues.present`, `fail_if.triggered`, `retry.scheduled`, `goto.target`, `run_js.result`, `goto_js.result`.

State change coverage (exhaustive):
- Run: `run.started`, `run.completed` (attributes: totals, duration).
- Check lifecycle: `check.scheduled`, `check.started`, `check.skipped` (with `skip_reason`), `check.completed`.
- forEach items: `foreach.started`/`foreach.completed` (index/total attributes) or dedicated child spans.
- Dependencies: `dependency.waiting` (dep id), `dependency.ready`.
- Conditional evaluation: `if.evaluated` (expression hash, result), `fail_if.evaluated` (hash, result), `fail_if.triggered`.
- Routing: `retry.scheduled` (attempt, backoff), `goto.target` (step id), `run.remediation` (step id list).
- Providers: `provider.request`/`provider.response` (sizes, durations; no payloads), `ai.session.reused`.

## Attributes (selected)

Resource (standard + custom):
- `service.name=visor`, `service.version`, `service.namespace=<org>`
- `deployment.environment=github-actions|ci|local`

Run (`visor.run`):
- `visor.run.id`, `visor.run.mode` (cli|github-actions)
- `visor.repo.owner`, `visor.repo.name`, `visor.pr.number`, `visor.git.head`, `visor.git.base`
- `visor.files.changed_count`, `visor.diff.additions`, `visor.diff.deletions`
- `visor.max_parallelism`, `visor.fail_fast`

Check (`visor.check`):
- `visor.check.id`, `visor.check.type`, `visor.check.group`, `visor.check.schema`, `visor.check.tags`
- `visor.check.depends_on`, `visor.check.skipped`, `visor.check.skip_reason`
- `visor.check.foreach.index`, `visor.check.foreach.total`
- `visor.issues.total`, `visor.issues.critical`, `visor.issues.error`, `visor.issues.warning`, `visor.issues.info`

Provider (`visor.provider`):
- `visor.provider.type`, `visor.ai.model`, `visor.ai.session_reused`

Routing (`visor.routing`):
- `visor.routing.action` (retry|goto|run), `visor.routing.attempt`, `visor.routing.backoff_ms`, `visor.routing.goto_target`, `visor.routing.loop_count`, `visor.routing.max_loops`

Mermaid (`visor.mermaid`):
- Extract: `visor.diagram.blocks_found`, `visor.diagram.source` (content|issue)
- Evaluate: `visor.diagram.syntax_ok`, `visor.diagram.node_count`, `visor.diagram.edge_count`, `visor.diagram.components`, `visor.diagram.density`, `visor.diagram.isolated_nodes`, `visor.diagram.references_changed_components`, `visor.diagram.score`

Privacy: do not persist raw code, diagram text, prompts, or responses unless explicitly enabled. Hash file paths and messages when redaction is on.

## Metrics (OTel Metrics API)

Counters:
- `visor.check.issues` (attrs: check_id, severity)
- `visor.diagram.blocks` (attrs: syntax_ok)

Histograms:
- `visor.check.duration_ms`
- `visor.provider.duration_ms`
- `visor.diagram.evaluate.duration_ms`

Gauges:
- `visor.run.active_checks`

## Mermaid Telemetry

- Extraction via fenced block regex for ```mermaid in rendered outputs and issue messages.
- No local analysis. We emit full Mermaid code as telemetry so downstream services can analyze asynchronously.
- Event shape: `diagram.block` with attributes `{ check, origin: 'content'|'issue', code: <full_mermaid> }`.
- Redaction: none by default for diagrams (unaltered code is sent) per current requirements.

## Configuration

`VisorConfig.telemetry` (excerpt):

```yaml
telemetry:
  enabled: false
  sink: otlp            # otlp|file|console
  diagrams:
    evaluate: true      # evaluation only; no render
  redaction:
    hash_files: true
    hash_messages: true
  tracing:
    sampler: always_on  # in CI; ratio allowed in dev
    batch:
      max_queue_size: 65536
      max_export_batch_size: 8192
      scheduled_delay_ms: 1000
      export_timeout_ms: 10000
  otlp:
    protocol: http      # or grpc
    endpoint: ${OTEL_EXPORTER_OTLP_ENDPOINT}
    headers: ${OTEL_EXPORTER_OTLP_HEADERS}
  file_trace:
    dir: output/traces
    format: otlp_json   # otlp_json|ndjson
```

CLI flags: `--telemetry`, `--telemetry-sink`, `--telemetry-endpoint`, `--telemetry-diagrams`.
ENV: Standard OTel envs + `VISOR_TELEMETRY_*`.

## Serverless File Export

- `FileSpanExporter` writes NDJSON (`one span per line`) simplified span objects to `output/traces/run-<id>-<ts>.ndjson`.
- These files are ingestible by an OTel Collector via a `filelog` receiver + transform pipeline to OTLP.
- Optional OTLP JSON export may be added later if needed.
- Provide `scripts/push-traces.ts` (planned) to upload stored traces to a collector.

## Integration with Execution Statistics

- Existing `ExecutionStatistics` (engine) remains the authoritative per‑run aggregate.
- `run_completed` span records aggregate counters as attributes; metrics are derived as histograms/counters.
- This RFC supersedes earlier execution‑only docs for schema guidance; `execution-statistics-rfc.md` remains as historical rationale.

## Instrumentation Plan (Code Map)

- `src/telemetry/opentelemetry.ts` — NodeSDK bootstrap, exporters, resource.
- `src/check-execution-engine.ts` — create `visor.run` and `visor.check`/`routing`/`foreach.item` spans; add events and attributes.
- `src/providers/*` — wrap provider calls with `visor.provider` spans; propagate context.
- `src/reviewer.ts` — after content assembly, scan for Mermaid, emit `visor.mermaid` spans (attributes only).
- `src/pr-analyzer.ts` — enrich root span with PR/repo attributes.
- `src/github-check-service.ts` — optional summary check; include trace id link in details.
- Logger — append `trace_id`/`span_id` when telemetry enabled.

### Logger Injection Sketch

```ts
// src/logger.ts (sketch)
import { context, trace } from '@opentelemetry/api';

function traceContext() {
  const span = trace.getSpan(context.active());
  const ctx = span?.spanContext();
  return ctx ? { trace_id: ctx.traceId, span_id: ctx.spanId, trace_flags: ctx.traceFlags } : undefined;
}

function write(level: string, msg: string, extra?: Record<string, unknown>) {
  const tc = traceContext();
  const payload = { level, msg, ts: new Date().toISOString(), ...(tc || {}), ...(extra || {}) };
  process.stderr.write(JSON.stringify(payload) + '\n');
}
```


## Dashboards

- Provide example Grafana dashboards (Tempo + Prometheus):
  - Run overview: success/failure/skip, duration percentiles, parallelism, issue counts by severity.
  - Check deep dive: duration by check, error hot spots, routing actions.
  - Diagram quality: syntax pass rate, average score.

## Rollout Plan

1) SDK bootstrap + FileSpanExporter + minimal spans in engine/providers.
2) OTLP exporters and CI config; Grafana/Tempo example dashboards.
3) Mermaid evaluation attributes; logs correlation; script for pushing stored traces.

## Acceptance Criteria

- CI runs emit full traces with AlwaysOn sampling and no drops under typical load (batched exports).
- Serverless mode writes valid OTLP JSON traces loadable by an OTel Collector.
- Spans show the expected hierarchy; attributes are present and PII‑safe by default.
- Diagram spans emit evaluation metrics only; no rendering or diagram source persisted.

## Risks & Mitigations

- Overhead: keep spans coarse (few levels), batch aggressively; disable heavy auto‑instrumentations.
- Data leakage: default redaction and attribute size caps; no raw code/AI payloads.
- Volume: AlwaysOn in CI; rely on queue sizing and backpressure; allow local ratio sampling.

## Open Questions

- Default protocol (HTTP vs gRPC) for OTLP in GitHub Actions.
- Injecting `traceparent` into command providers by default to link downstream tools.
- Which CI environments beyond GitHub Actions to tailor resource attributes for.

---

## Implementation Status (as of 2025‑10‑07)

Completed
- [x] Single RFC consolidating telemetry + OpenTelemetry tracing.
- [x] Config: `telemetry` block (enabled, sink=otlp|file|console, otlp/file options) with env overrides.
- [x] Bootstrap: `initTelemetry` (OTLP HTTP traces, optional OTLP metrics; serverless NDJSON exporter); AlwaysOn in CI (no rate limiting).
- [x] Log correlation: logger adds `[trace_id span_id]`; console.* patched when telemetry enabled.
- [x] CLI and GitHub Actions: root `visor.run` span around major phases; full root coverage in CLI; partial in Actions (reviewPR path).
- [x] Spans: `visor.check` (parent), `visor.provider` (child), `visor.foreach.item` (per item).
- [x] Events: `check.started/completed`, `if.evaluated`, `fail_if.evaluated`, `check.skipped`, `retry.scheduled`, `goto.target`, `run.remediation`, `command.exec.completed/error`, `http.request/response`, `foreach.started/skipped/completed`.
- [x] Metrics: histograms (`visor.check.duration_ms`, `visor.provider.duration_ms`, `visor.foreach.item.duration_ms`), counter (`visor.check.issues{severity}`), gauge (`visor.run.active_checks` via UpDownCounter), counter (`visor.fail_if.triggered{scope}`).
- [x] Providers: command exec child span + W3C context injection; http request/response events with status.
- [x] E2E tests: forEach + transform chains; read and validate resulting JSON; assert spans/events counts and attributes.
- [x] Example Grafana dashboards: overview + diagrams (skeleton) and setup guide.
- [x] Schema/types: `telemetry` block added to `VisorConfig` TypeScript types and generator picks it up for JSON Schema.
- [x] Mermaid telemetry: emit `diagram.block` with full Mermaid code (no local analysis or redaction).

Changed vs. original plan
- [x] Serverless exporter writes NDJSON simplified spans (one span per line) instead of full OTLP JSON. Rationale: easier diffs and ingestion via Collector filelog; OTLP JSON remains optional for later.
- [x] Diagram rendering explicitly out of scope; only telemetry signals are planned. (No rendering implemented.)

Pending / Next
- [ ] Wrap the entire GitHub Actions `run()` with a single root `visor.run` span (early logs included); ensure consistent repo/PR attributes at start.
- [ ] Diagram counters/panels: add metrics counters for diagram blocks to power Grafana panels.
- [ ] Redaction controls: enforce hashing/truncation for file paths/messages when enabled in `telemetry.redaction`.
- [ ] OTLP Logs: consider optional exporter when Node OTel Logs is stable; otherwise keep JSONL logs with trace correlation.
- [ ] Telemetry summary GitHub Check: optional status check summarizing totals and linking to trace.
- [ ] Additional tests: fail_if trigger E2E, Actions path E2E, command/http provider span details.
- [ ] Schema: add `telemetry` block to generated config schema and validation (Ajv), with docs/examples.
- [ ] Optional OTLP JSON file exporter alongside NDJSON if needed by downstream tooling.
