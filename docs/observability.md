# Observability

This document provides an overview of Visor's observability features, including output formats, logging verbosity, telemetry, debugging tools, and execution statistics.

## Output Formats

Visor supports four output formats for different use cases:

| Format | Flag | Description |
|--------|------|-------------|
| **table** | `--output table` | Default terminal summary with colored output (when TTY) |
| **json** | `--output json` | Machine-readable JSON for pipelines and automation |
| **markdown** | `--output markdown` | Render results as markdown (useful for PR comments) |
| **sarif** | `--output sarif` | SARIF 2.1.0 format for code scanning integrations |

### Saving Output to Files

Use `--output-file <path>` to write formatted results directly to a file without mixing with logs:

```bash
visor --check all --output json --output-file results.json
visor --check security --output sarif --output-file visor-results.sarif
visor --check architecture --output markdown --output-file report.md
```

All status logs are sent to stderr; stdout contains only the formatted result when not using `--output-file`.

For more details, see [Output Formats](./output-formats.md).

## Verbosity Control

Visor supports multiple log levels, from silent to debug:

| Level | Priority | Description |
|-------|----------|-------------|
| `silent` | 0 | No output |
| `error` | 10 | Errors only |
| `warn` | 20 | Warnings and errors |
| `info` | 30 | Default level - informational messages |
| `verbose` | 40 | Additional detail without full debug |
| `debug` | 50 | Full debug output including AI interactions |

### CLI Flags

| Flag | Effect |
|------|--------|
| `-q`, `--quiet` | Reduce verbosity to warnings and errors |
| `-v`, `--verbose` | Increase verbosity without full debug |
| `--debug` | Enable debug mode for detailed output |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `VISOR_LOG_LEVEL` | Set log level (`silent`, `error`, `warn`, `info`, `verbose`, `debug`, or `quiet`) |
| `VISOR_DEBUG` | Set to `true` to enable debug mode |

### JSON/SARIF Output Behavior

When using `--output json` or `--output sarif`, Visor automatically suppresses info and warning logs to keep stdout clean for machine-readable output. This can be overridden by explicitly setting `--verbose` or `--debug`.

## Telemetry and Tracing

Visor supports OpenTelemetry-based telemetry for tracing and metrics.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `VISOR_TELEMETRY_ENABLED` | Set to `true` to enable telemetry |
| `VISOR_TELEMETRY_SINK` | Sink type: `file` (NDJSON), `otlp` (HTTP), or `console` |
| `VISOR_TRACE_DIR` | Directory for trace output (default: `output/traces`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint URL for traces |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | OTLP endpoint specifically for traces |
| `OTEL_EXPORTER_OTLP_HEADERS` | Headers for OTLP authentication |

### CLI Flags

| Flag | Description |
|------|-------------|
| `--telemetry` | Enable telemetry (overrides config) |
| `--telemetry-sink <sink>` | Sink selection: `otlp`, `file`, or `console` |
| `--telemetry-endpoint <url>` | OTLP endpoint (HTTP) for traces/metrics |
| `--trace-report` | Write a static HTML trace report to output/traces |
| `--auto-instrumentations` | Enable OpenTelemetry auto-instrumentations |

### NDJSON Trace Output (Serverless Mode)

When using file sink, Visor writes simplified NDJSON spans to `output/traces/run-<timestamp>.ndjson`. These can be ingested with an OTel Collector `filelog` receiver.

```bash
VISOR_TELEMETRY_ENABLED=true VISOR_TELEMETRY_SINK=file visor --check all
ls output/traces/*.ndjson
```

### OpenTelemetry OTLP Export (Connected Mode)

For real-time trace export to collectors like Jaeger or Tempo:

```bash
VISOR_TELEMETRY_ENABLED=true \
VISOR_TELEMETRY_SINK=otlp \
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces \
visor --check all
```

### Configuration File

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

For comprehensive setup instructions, see [Telemetry Setup](./telemetry-setup.md).

## Debug Features

### Debug Visualizer Server

The Debug Visualizer is a lightweight HTTP server that streams OpenTelemetry spans during execution and exposes control endpoints for pause, resume, stop, and reset.

| Flag | Description |
|------|-------------|
| `--debug-server` | Start debug visualizer server for live execution visualization |
| `--debug-port <port>` | Port for debug server (default: 3456) |

```bash
visor --config .visor.yaml --debug-server --debug-port 3456
```

The server provides endpoints:
- `GET /api/status` - Execution state and readiness
- `GET /api/spans` - Live span stream
- `POST /api/start` - Begin execution
- `POST /api/pause` - Pause execution
- `POST /api/resume` - Resume execution
- `POST /api/stop` - Stop execution

Set `VISOR_NOBROWSER=true` for headless/CI environments.

For full details, see [Debug Visualizer](./debug-visualizer.md).

### TUI Mode

Enable interactive terminal UI with chat and logs tabs:

```bash
visor --tui --check all
```

### Debug Mode

Enable `--debug` for detailed output including:
- AI provider interactions
- Template rendering details
- Expression evaluation results
- Dependency resolution paths
- Error stack traces

For comprehensive debugging techniques, see [Debugging Guide](./debugging.md).

## Execution Statistics

Visor tracks and displays detailed execution statistics for each run.

### Summary Information

After execution, Visor displays:
- Total checks configured vs. total executions (including forEach iterations)
- Success, failure, and skip counts
- Total execution duration
- Issue counts by severity

### Table Output Example

```
Execution Complete (45.3s)
Checks: 8 configured -> 23 executions
Status: 20 success | 2 failed | 1 skipped
Issues: 15 total (3 critical, 12 warnings)

Check Details:
| Check           | Duration | Status   | Details         |
|-----------------|----------|----------|-----------------|
| list-files      | 0.5s     | success  | 5 outputs       |
| validate-file   | 12.3s    | success  | 5 iterations    |
| security-scan   | 8.2s     | success  | 3 critical      |
| notify-slack    | 2.1s     | failed   | HTTP 500        |
| production-only | -        | skipped  | if: branch==... |
```

### JSON Output

When using `--output json`, full `executionStatistics` object is included with:
- Per-check statistics (runs, duration, issues)
- Per-iteration timings for forEach checks
- Skip condition evaluations
- forEach item previews
- Complete error messages

### Tracked Metrics

| Metric | Description |
|--------|-------------|
| `totalChecksConfigured` | Number of checks defined in config |
| `totalExecutions` | Sum of all runs including forEach iterations |
| `successfulExecutions` | Checks that completed without error |
| `failedExecutions` | Checks that failed |
| `skippedChecks` | Checks skipped due to conditions |
| `totalDuration` | Total execution time in milliseconds |
| Issue counts | By severity: critical, error, warning, info |

## Related Documentation

- [Output Formats](./output-formats.md) - Detailed format specifications
- [Telemetry Setup](./telemetry-setup.md) - Complete telemetry configuration
- [Debug Visualizer](./debug-visualizer.md) - Live execution visualization
- [Debugging Guide](./debugging.md) - Debugging techniques and tips
- [Troubleshooting](./troubleshooting.md) - Common issues and solutions
- [Configuration](./configuration.md) - Full configuration reference
