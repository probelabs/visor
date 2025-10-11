# Telemetry & Tracing — Setup Guide

This guide shows how to enable Visor telemetry and tracing with OpenTelemetry, export traces/metrics, auto‑instrument Node libraries, and generate a static HTML trace report.

## Quick Start (CLI)

- Enable telemetry to serverless NDJSON traces:
  - `VISOR_TELEMETRY_ENABLED=true`
  - `VISOR_TELEMETRY_SINK=file`
  - (optional) `VISOR_TRACE_DIR=output/traces`
- Run:
  - `visor --config ./.visor.yaml --output json`
- Inspect traces:
  - `ls output/traces/*.ndjson`

## CLI Flags

- `--telemetry` — enable telemetry (overrides config)
- `--telemetry-sink <otlp|file|console>` — sink selection
- `--telemetry-endpoint <url>` — OTLP endpoint (HTTP) for traces/metrics
- `--trace-report` — write a static HTML trace report to output/traces
- `--auto-instrumentations` — enable OpenTelemetry auto‑instrumentations

Examples:
- `visor --config ./.visor.yaml --telemetry --telemetry-sink otlp --telemetry-endpoint https://otel.example.com`
- `visor --config ./.visor.yaml --telemetry --trace-report --auto-instrumentations`

## Config (visor.yaml)

```yaml
version: "1.0"
telemetry:
  enabled: true
  sink: file       # otlp|file|console
  otlp:
    protocol: http
    endpoint: ${OTEL_EXPORTER_OTLP_ENDPOINT}
    headers: ${OTEL_EXPORTER_OTLP_HEADERS}
  file:
    dir: output/traces
    ndjson: true
  tracing:
    auto_instrumentations: true
    trace_report:
      enabled: true
```

ENV overrides (highest precedence):
- `VISOR_TELEMETRY_ENABLED`, `VISOR_TELEMETRY_SINK`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `VISOR_TRACE_DIR`
- `VISOR_TELEMETRY_AUTO_INSTRUMENTATIONS=true`
- `VISOR_TRACE_REPORT=true`

## Serverless Mode (NDJSON)

- Visor writes NDJSON simplified spans to `output/traces/run-<id>-<ts>.ndjson`.
- Ingest with OTel Collector `filelog` receiver + transform to OTLP.

OTel Collector (example):
```yaml
receivers:
  filelog:
    include: [ "/work/output/traces/*.ndjson" ]
    operators:
      - type: json_parser
        parse_from: body
exporters:
  otlphttp:
    endpoint: http://tempo:4318
service:
  pipelines:
    traces:
      receivers: [filelog]
      exporters: [otlphttp]
```

## Connected Mode (OTLP HTTP)

- Set `VISOR_TELEMETRY_SINK=otlp` and `OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example.com`.
- Metrics exporter is enabled automatically (optional dependency) — histograms/counters for checks, providers, foreach items, fail_if triggers, and diagram blocks.

## Auto‑Instrumentations

- Enable with `--auto-instrumentations` or `telemetry.tracing.auto_instrumentations: true`.
- Adds `@opentelemetry/auto-instrumentations-node` (http/undici/child_process/etc.) and correlates with Visor spans via context.
- Optional dependency; if not installed, Visor skips auto‑instrumentation gracefully.

## Static Trace Report

- Enable `--trace-report` or `telemetry.tracing.trace_report.enabled: true`.
- Outputs two files per run:
  - `*.trace.json` — simplified span JSON
  - `*.report.html` — self‑contained HTML timeline (open locally)

## Mermaid Telemetry

- Visor emits full `diagram.block` events with Mermaid code from outputs and issue messages.
- Metric: `visor.diagram.blocks{origin}` increments per diagram block.

## Security & Redaction

- Diagram events are sent verbatim by default (as requested). You can later opt‑in to redaction via `telemetry.redaction` (not enforced by default).

## GitHub Actions

- Visor wraps the Action run in a single root span (`visor.run`). Publish the `trace_id` in logs/checks for linking.
- Example step:
```yaml
- name: Visor
  run: |
    export VISOR_TELEMETRY_ENABLED=true
    export VISOR_TELEMETRY_SINK=otlp
    export OTEL_EXPORTER_OTLP_ENDPOINT=${{ secrets.OTEL_ENDPOINT }}
    export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer ${{ secrets.OTEL_TOKEN }}"
    npx -y @probelabs/visor --config ./.visor.yaml --output json
```

Troubleshooting:
- No spans? Check `VISOR_TELEMETRY_ENABLED`, `VISOR_TELEMETRY_SINK`, and that optional deps resolved in the environment.
- Huge mermaid outputs? Consider adding a soft length cap in Visor or pre-truncating in templates.

