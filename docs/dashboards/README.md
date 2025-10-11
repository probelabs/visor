Dashboards for Visor Telemetry
==============================

This folder contains example Grafana dashboards to visualize Visor traces and metrics exported via OpenTelemetry (Tempo + Prometheus).

What’s included
- grafana-visor-overview.json — Run/Check overview: durations, issue counts by severity, recent runs.
- grafana-visor-diagrams.json — Diagram telemetry (syntax pass rate, average score) if you enable diagram attributes.

Setup
1) Deploy Grafana + Tempo + Prometheus (or Grafana Cloud).
2) Configure your OTel Collector to receive OTLP traces/metrics and forward to Tempo/Prometheus.
3) Enable telemetry in Visor CI:
   - VISOR_TELEMETRY_ENABLED=true
   - VISOR_TELEMETRY_SINK=otlp
   - OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example.com
   - OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>
4) Import the JSON dashboards into Grafana and set the Tempo + Prometheus data sources.

Notes
- Spans appear in Tempo’s Explore/Trace view (service.name=visor).
- Metrics are emitted when OTLP metrics exporter is configured; see docs/telemetry-tracing-rfc.md for details.

