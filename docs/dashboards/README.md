# Dashboards for Visor Telemetry

This folder contains example Grafana dashboards to visualize Visor traces and metrics exported via OpenTelemetry (Tempo + Prometheus).

## What's Included

- **grafana-visor-overview.json** - Run/Check overview dashboard with:
  - Check duration histogram (95th percentile)
  - Issues by severity rate panel
- **grafana-visor-diagrams.json** - Diagram telemetry dashboard with:
  - Diagram blocks by origin (content vs issue)

## Setup

1. Deploy Grafana + Tempo + Prometheus (or Grafana Cloud).
2. Configure your OTel Collector to receive OTLP traces/metrics and forward to Tempo/Prometheus.
3. Enable telemetry in Visor CI:
   ```bash
   export VISOR_TELEMETRY_ENABLED=true
   export VISOR_TELEMETRY_SINK=otlp
   export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://collector.example.com/v1/traces
   export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <token>"
   ```
4. Import the JSON dashboards into Grafana.
5. Update the data source UIDs in each dashboard to match your Tempo and Prometheus data sources (replace `PROM_DS` with your Prometheus data source UID).

## Notes

- Spans appear in Tempo's Explore/Trace view (service.name=visor).
- Metrics are emitted when the OTLP metrics exporter is configured.
- The dashboards use placeholder data source UIDs (`PROM_DS`) that need to be updated after import.

## Related Documentation

- [Telemetry Setup Guide](../telemetry-setup.md) - Complete setup instructions for enabling telemetry
- [Telemetry RFC](../telemetry-tracing-rfc.md) - Design rationale and architecture details

