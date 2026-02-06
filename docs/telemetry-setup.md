# Telemetry & Tracing — Setup Guide

This guide shows how to enable Visor telemetry and tracing with OpenTelemetry, export traces/metrics, auto‑instrument Node libraries, and generate a static HTML trace report.

## Quick Start (CLI)

Enable telemetry to serverless NDJSON traces:

```bash
export VISOR_TELEMETRY_ENABLED=true
export VISOR_TELEMETRY_SINK=file
export VISOR_TRACE_DIR=output/traces  # optional, defaults to output/traces

visor --config ./.visor.yaml --output json

# Inspect traces
ls output/traces/*.ndjson
```

## Environment Variables

Telemetry is configured via environment variables (highest precedence):

| Variable | Description | Default |
|----------|-------------|---------|
| `VISOR_TELEMETRY_ENABLED` | Enable telemetry (`true`/`false`) | `false` |
| `VISOR_TELEMETRY_SINK` | Sink type: `otlp`, `file`, or `console` | `file` |
| `VISOR_TRACE_DIR` | Directory for trace files | `output/traces` |
| `VISOR_TRACE_REPORT` | Generate static HTML trace report (`true`/`false`) | `false` |
| `VISOR_TELEMETRY_AUTO_INSTRUMENTATIONS` | Enable auto‑instrumentations (`true`/`false`) | `false` |
| `VISOR_TELEMETRY_FULL_CAPTURE` | Capture full AI prompts/responses in spans | `false` |
| `VISOR_FALLBACK_TRACE_FILE` | Explicit path for NDJSON trace file | auto-generated |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint URL (for both traces and metrics) | - |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | OTLP endpoint for traces (overrides above) | - |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | OTLP endpoint for metrics (overrides above) | - |
| `OTEL_EXPORTER_OTLP_HEADERS` | Headers for OTLP requests (e.g., auth tokens) | - |

Examples:

```bash
# File sink (serverless mode)
VISOR_TELEMETRY_ENABLED=true \
VISOR_TELEMETRY_SINK=file \
visor --config ./.visor.yaml

# OTLP sink with Jaeger
VISOR_TELEMETRY_ENABLED=true \
VISOR_TELEMETRY_SINK=otlp \
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces \
visor --config ./.visor.yaml

# With static HTML trace report
VISOR_TELEMETRY_ENABLED=true \
VISOR_TRACE_REPORT=true \
visor --config ./.visor.yaml
```

## Config (visor.yaml)

Telemetry can also be configured via the `telemetry` section in your config file:

```yaml
version: "1.0"
telemetry:
  enabled: true
  sink: file       # otlp | file | console
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

> **Note:** Environment variables take precedence over config file settings.

## Serverless Mode (NDJSON)

When using `VISOR_TELEMETRY_SINK=file` (the default), Visor writes NDJSON simplified spans to `output/traces/run-<timestamp>.ndjson`. This is ideal for serverless/CI environments where you can't run a persistent collector.

You can then ingest these files using the OTel Collector `filelog` receiver:

```yaml
# otel-collector-config.yaml
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

For real-time trace streaming to a collector:

```bash
export VISOR_TELEMETRY_ENABLED=true
export VISOR_TELEMETRY_SINK=otlp
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://collector.example.com/v1/traces
# Optional: authentication headers
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer your-token"
```

When using OTLP sink, the metrics exporter is automatically enabled if the required dependencies are installed (`@opentelemetry/exporter-metrics-otlp-http`, `@opentelemetry/sdk-metrics`). Metrics include histograms and counters for checks, providers, forEach items, and fail_if triggers.

## Auto‑Instrumentations

Enable with `VISOR_TELEMETRY_AUTO_INSTRUMENTATIONS=true` or in config:

```yaml
telemetry:
  tracing:
    auto_instrumentations: true
```

This activates `@opentelemetry/auto-instrumentations-node` (http/undici/child_process/etc.) and correlates external calls with Visor spans via context propagation.

> **Note:** Auto-instrumentations require `@opentelemetry/auto-instrumentations-node` as an optional dependency. If not installed, Visor skips auto‑instrumentation gracefully.

## Static Trace Report

Enable with `VISOR_TRACE_REPORT=true` or in config:

```yaml
telemetry:
  tracing:
    trace_report:
      enabled: true
```

This outputs two files per run to your trace directory:
- `*.trace.json` — simplified span JSON
- `*.report.html` — self‑contained HTML timeline (open locally in your browser)

## Span Attributes and Events

Visor emits spans with detailed attributes for debugging:

### Check Spans (`visor.check.<checkId>`)
- `visor.check.id` — Check identifier
- `visor.check.type` — Provider type (ai, command, etc.)
- `visor.check.input.context` — Liquid template context (sanitized)
- `visor.check.output` — Check result (truncated if large)
- `visor.foreach.index` — Index for forEach iterations

### State Spans (`engine.state.*`)
- `wave` — Current execution wave number
- `wave_kind` — Wave type
- `session_id` — Session identifier
- `level_size` — Number of checks in wave
- `level_checks_preview` — Preview of checks in wave

### Routing Events (`visor.routing`)
- `trigger` — What triggered the routing decision
- `action` — Routing action (retry, goto, run)
- `source` — Source check
- `target` — Target check(s)
- `scope` — Execution scope
- `goto_event` — Event override for goto

## Security & Redaction

By default, sensitive environment variables (containing `api_key`, `secret`, `token`, `password`, `auth`, `credential`, `private_key`) are automatically redacted in span attributes.

To capture full AI prompts and responses (for debugging), set:
```bash
export VISOR_TELEMETRY_FULL_CAPTURE=true
```

> **Warning:** Full capture may include sensitive data. Use only in secure debugging environments.

## GitHub Actions

Visor wraps each execution in a root span (`visor.run`). You can correlate traces with GitHub workflow runs by publishing the `trace_id` in logs or checks.

Example workflow step:

```yaml
- name: Run Visor with tracing
  run: |
    export VISOR_TELEMETRY_ENABLED=true
    export VISOR_TELEMETRY_SINK=otlp
    export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${{ secrets.OTEL_ENDPOINT }}
    export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer ${{ secrets.OTEL_TOKEN }}"
    npx -y @probelabs/visor@latest --config ./.visor.yaml --output json
```

For file-based tracing in CI (useful for artifact upload):

```yaml
- name: Run Visor with file traces
  run: |
    export VISOR_TELEMETRY_ENABLED=true
    export VISOR_TELEMETRY_SINK=file
    export VISOR_TRACE_DIR=./traces
    npx -y @probelabs/visor@latest --config ./.visor.yaml

- name: Upload traces
  uses: actions/upload-artifact@v4
  with:
    name: visor-traces
    path: ./traces/*.ndjson
```

## Troubleshooting

- **No spans?** Verify `VISOR_TELEMETRY_ENABLED=true` and check that OpenTelemetry packages are installed.
- **Missing metrics?** Install `@opentelemetry/exporter-metrics-otlp-http` and `@opentelemetry/sdk-metrics`.
- **Auto-instrumentations not working?** Install `@opentelemetry/auto-instrumentations-node`.
- **Large span attributes?** Visor truncates attributes at 10,000 characters. For full capture, use `VISOR_TELEMETRY_FULL_CAPTURE=true`.

## Related Documentation

- [Debugging Guide](./debugging.md) — Comprehensive debugging techniques
- [Debug Visualizer](./debug-visualizer.md) — Live execution visualization with `--debug-server`
- [Telemetry RFC](./telemetry-tracing-rfc.md) — Design rationale and architecture
