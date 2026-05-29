# Visor Local Observability

This is the canonical local observability stack for Visor.

It replaces the single-container `grafana/otel-lgtm` setup with separate services:
- `tempo`
- `otelcol`
- `prometheus`
- `grafana`
- `autoheal`

Ports:
- `8001` Grafana
- `4317` OTLP gRPC
- `4318` OTLP HTTP
- `3200` Tempo HTTP API
- `9091` Prometheus

Start from the Visor repo root:

```bash
docker compose -f deploy/observability/local/docker-compose.yml up -d
```

Stop:

```bash
docker compose -f deploy/observability/local/docker-compose.yml down
```

If the old all-in-one LGTM container is still running, remove it first:

```bash
docker rm -f grafana-otel
```

Point Visor-based apps at this stack with:
- `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`
- `GRAFANA_URL=http://localhost:8001`

This stack is generic Visor infrastructure. Project-specific apps like Oel should reference it rather than owning their own copy.
