# Grafana Dashboards for Visor

Pre-built Grafana dashboards for visualizing Visor telemetry data exported via OpenTelemetry.

## Dashboards

### Visor Overview (`grafana-visor-overview.json`)

The main dashboard with five sections:

**Runs & Users** — Top-level stats and trends:
- Total runs, unique users, avg duration, success rate
- AI call totals and avg AI calls per run
- Runs over time by source (CLI/Slack/TUI)
- Run duration percentiles (P50/P95/P99)
- Tables: runs by user, runs by workflow

**Check Performance** — Per-check metrics:
- Check duration P95 by check ID
- Issues by severity over time
- Top 10 slowest checks (bar gauge)
- Issues distribution by check (pie chart)

**AI Provider** — AI usage analytics:
- AI calls over time by model
- AI calls per run distribution (P50/P95)
- AI calls by check (table)
- AI calls by model (pie chart)

**Failure Conditions** — Health signals:
- fail_if trigger rate by check and scope
- Active concurrent checks (live gauge)
- Diagram blocks emitted

**Traces** — Recent `visor.run` traces from Tempo with drill-down

### Visor Diagrams (`grafana-visor-diagrams.json`)

Lightweight dashboard for Mermaid diagram block telemetry.

## Setup

### With Grafana LGTM (recommended for local dev)

```bash
docker run -d --name grafana-otel \
  -p 3000:3000 -p 4317:4317 -p 4318:4318 \
  -v grafana-otel-data:/data \
  grafana/otel-lgtm:latest
```

Grafana is at `http://localhost:3000` (admin/admin). Data sources are pre-configured.

### Import the Dashboard

1. Open Grafana → Dashboards → Import
2. Upload `grafana-visor-overview.json`
3. Select your Prometheus and Tempo data sources when prompted
4. Click Import

### With standalone Grafana

Update the data source UIDs in the JSON:
- Replace `${DS_PROMETHEUS}` references with your Prometheus data source UID
- Replace `${DS_TEMPO}` references with your Tempo data source UID

### Enable Visor Telemetry

```bash
export VISOR_TELEMETRY_ENABLED=true
export VISOR_TELEMETRY_SINK=otlp
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

## Template Variables

The overview dashboard includes filter variables:
- **Source** — Filter by run source (`cli`, `slack`, `tui`)
- **Workflow** — Filter by workflow/check combination

## Related Documentation

- [Telemetry Reference](../telemetry-reference.md) — Complete list of all spans, metrics, and events
- [Telemetry Setup Guide](../telemetry-setup.md) — How to enable and configure telemetry
