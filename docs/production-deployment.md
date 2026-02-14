# Production Deployment Guide

This guide covers deploying Visor as a production service across Docker, Kubernetes, and traditional server environments.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Docker Deployment](#docker-deployment)
- [Docker Compose](#docker-compose)
- [Kubernetes Deployment](#kubernetes-deployment)
- [Environment Variables](#environment-variables)
- [Health Checks and Readiness](#health-checks-and-readiness)
- [Security Hardening](#security-hardening)
- [Multi-Instance / High Availability](#multi-instance--high-availability)
- [Logging and Monitoring](#logging-and-monitoring)
- [Backup and Recovery](#backup-and-recovery)
- [Upgrading](#upgrading)
- [Troubleshooting](#troubleshooting)

---

## Architecture Overview

A production Visor deployment typically consists of:

```
                      +------------------+
                      |   GitHub / Slack  |
                      +--------+---------+
                               |
                    +----------+----------+
                    |   Load Balancer /   |
                    |   Ingress Controller|
                    +----------+----------+
                               |
              +----------------+----------------+
              |                |                |
        +-----v-----+   +-----v-----+   +-----v-----+
        |  Visor #1  |   |  Visor #2  |   |  Visor #3  |
        |  (--slack)  |   |  (--slack)  |   |  (--slack)  |
        +-----+------+   +-----+------+   +-----+------+
              |                |                |
              +----------------+----------------+
                               |
                     +---------v---------+
                     |   PostgreSQL /    |
                     |   MySQL / MSSQL  |
                     +-------------------+
```

**Components:**
- **Visor instances** run in `--slack` mode (long-running) or as CI jobs (ephemeral)
- **Database** stores scheduler state and config snapshots (PostgreSQL recommended)
- **External services**: GitHub API, Slack API, AI providers (Gemini, Claude, OpenAI)

---

## Docker Deployment

### Dockerfile

```dockerfile
FROM node:20-alpine

WORKDIR /app

# Install Visor
RUN npm install -g @probelabs/visor

# For EE features with OPA policies:
# RUN npm install -g @probelabs/visor@ee
# RUN apk add --no-cache curl && \
#     curl -L -o /usr/local/bin/opa https://openpolicyagent.org/downloads/latest/opa_linux_amd64_static && \
#     chmod +x /usr/local/bin/opa

# Copy configuration
COPY .visor.yaml /app/.visor.yaml

# Optional: copy policy files
# COPY policies/ /app/policies/

# Non-root user
RUN addgroup -g 1001 visor && \
    adduser -D -u 1001 -G visor visor && \
    chown -R visor:visor /app
USER visor

ENTRYPOINT ["visor"]
```

### Running

```bash
# Build
docker build -t visor:latest .

# Run checks (ephemeral)
docker run --rm \
  -e GITHUB_TOKEN="${GITHUB_TOKEN}" \
  -e GEMINI_API_KEY="${GEMINI_API_KEY}" \
  -v "$(pwd):/workspace" \
  visor:latest --config /workspace/.visor.yaml --check all

# Run Slack mode (long-running)
docker run -d \
  --name visor \
  --restart unless-stopped \
  -e SLACK_APP_TOKEN="${SLACK_APP_TOKEN}" \
  -e GITHUB_TOKEN="${GITHUB_TOKEN}" \
  -e GEMINI_API_KEY="${GEMINI_API_KEY}" \
  visor:latest --slack --config /app/.visor.yaml --watch
```

---

## Docker Compose

```yaml
version: "3.8"

services:
  visor:
    build: .
    restart: unless-stopped
    command: ["--slack", "--config", "/app/.visor.yaml", "--watch"]
    environment:
      SLACK_APP_TOKEN: "${SLACK_APP_TOKEN}"
      GITHUB_TOKEN: "${GITHUB_TOKEN}"
      GEMINI_API_KEY: "${GEMINI_API_KEY}"
      # Database (EE)
      VISOR_DB_PASSWORD: "${VISOR_DB_PASSWORD}"
      # Telemetry
      VISOR_TELEMETRY_ENABLED: "true"
      VISOR_TELEMETRY_SINK: "otlp"
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://jaeger:4318/v1/traces"
    volumes:
      - visor-data:/app/.visor
      - ./config/.visor.yaml:/app/.visor.yaml:ro
    depends_on:
      db:
        condition: service_healthy

  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: visor
      POSTGRES_USER: visor
      POSTGRES_PASSWORD: "${VISOR_DB_PASSWORD}"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U visor"]
      interval: 10s
      timeout: 5s
      retries: 5

  jaeger:
    image: jaegertracing/all-in-one:latest
    ports:
      - "16686:16686"   # UI
      - "4318:4318"     # OTLP HTTP

volumes:
  visor-data:
  pgdata:
```

Start with:

```bash
docker compose up -d
```

---

## Kubernetes Deployment

### Namespace and Secret

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: visor
---
apiVersion: v1
kind: Secret
metadata:
  name: visor-secrets
  namespace: visor
type: Opaque
stringData:
  SLACK_APP_TOKEN: "xapp-..."
  GITHUB_TOKEN: "ghp_..."
  GEMINI_API_KEY: "AIza..."
  VISOR_DB_PASSWORD: "changeme"
  # EE license (if applicable)
  # VISOR_LICENSE: "eyJ..."
```

### ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: visor-config
  namespace: visor
data:
  .visor.yaml: |
    version: "1.0"
    checks:
      security:
        type: ai
        prompt: "Review for security issues"
    scheduler:
      enabled: true
      storage:
        driver: postgresql
        connection:
          host: postgres.visor.svc.cluster.local
          port: 5432
          database: visor
          user: visor
          password: ${VISOR_DB_PASSWORD}
          ssl: false
          pool:
            min: 2
            max: 10
      ha:
        enabled: true
```

### Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: visor
  namespace: visor
spec:
  replicas: 2
  selector:
    matchLabels:
      app: visor
  template:
    metadata:
      labels:
        app: visor
    spec:
      containers:
        - name: visor
          image: your-registry/visor:latest
          args: ["--slack", "--config", "/config/.visor.yaml", "--watch"]
          envFrom:
            - secretRef:
                name: visor-secrets
          volumeMounts:
            - name: config
              mountPath: /config
              readOnly: true
            - name: data
              mountPath: /app/.visor
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              cpu: "1"
              memory: 512Mi
          livenessProbe:
            exec:
              command: ["sh", "-c", "pgrep -f visor || exit 1"]
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            exec:
              command: ["sh", "-c", "pgrep -f visor || exit 1"]
            initialDelaySeconds: 5
            periodSeconds: 10
      volumes:
        - name: config
          configMap:
            name: visor-config
        - name: data
          emptyDir: {}
```

### PostgreSQL (StatefulSet)

For production PostgreSQL in Kubernetes, consider using an operator like [CloudNativePG](https://cloudnative-pg.io/) or a managed service (RDS, Cloud SQL, Azure Database). A minimal StatefulSet for reference:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: visor
spec:
  serviceName: postgres
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
        - name: postgres
          image: postgres:16-alpine
          env:
            - name: POSTGRES_DB
              value: visor
            - name: POSTGRES_USER
              value: visor
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: visor-secrets
                  key: VISOR_DB_PASSWORD
          ports:
            - containerPort: 5432
          volumeMounts:
            - name: pgdata
              mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
    - metadata:
        name: pgdata
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 5Gi
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: visor
spec:
  selector:
    app: postgres
  ports:
    - port: 5432
```

### Triggering Config Reload in Kubernetes

When the ConfigMap changes, send `SIGUSR2` to the Visor process:

```bash
kubectl exec -n visor deploy/visor -- kill -USR2 1
```

Or use a sidecar like [reloader](https://github.com/stakater/Reloader) to auto-restart on ConfigMap changes.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes (GitHub mode) | GitHub personal access token or app token |
| `SLACK_APP_TOKEN` | Yes (Slack mode) | Slack app-level token (`xapp-...`) |
| `GEMINI_API_KEY` | Provider-specific | Google Gemini API key |
| `ANTHROPIC_API_KEY` | Provider-specific | Anthropic Claude API key |
| `OPENAI_API_KEY` | Provider-specific | OpenAI API key |
| `VISOR_LICENSE` | EE only | Enterprise license JWT |
| `VISOR_LICENSE_FILE` | EE only | Path to license file (alternative to `VISOR_LICENSE`) |
| `VISOR_DB_PASSWORD` | EE + SQL | Database password (used in config via `${VISOR_DB_PASSWORD}`) |
| `VISOR_TELEMETRY_ENABLED` | No | Enable OpenTelemetry (`true`/`false`) |
| `VISOR_TELEMETRY_SINK` | No | Telemetry sink: `otlp`, `file`, `console` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | No | OTLP endpoint URL |
| `VISOR_WORKSPACE_PATH` | No | Override workspace base path |
| `VISOR_DEBUG` | No | Enable debug logging (`true`/`false`) |

---

## Security Hardening

### Secrets Management

- **Never** commit secrets to `.visor.yaml`. Use environment variable references (`${VAR_NAME}`).
- Use Kubernetes Secrets, AWS Secrets Manager, or HashiCorp Vault for secret injection.
- Rotate API keys and tokens periodically.

### Network

- Run Visor in a private subnet with outbound-only internet (for API calls to GitHub, Slack, AI providers).
- Restrict database access to Visor instances only (security groups / network policies).
- Use TLS for all database connections in production (`ssl: true`).

### Container

- Run as non-root user (UID 1001 in the Dockerfile above).
- Use read-only root filesystem where possible.
- Set resource limits to prevent runaway processes.
- Pin image tags to specific versions (not `latest`).

### EE Policy Engine

- Use `fallback: deny` to block unrecognized actions by default.
- Define explicit roles and scope policies to each team.
- Audit policy decisions with `fallback: warn` before switching to `deny`.

---

## Multi-Instance / High Availability

For multi-instance deployments (e.g., Kubernetes replicas > 1):

1. **Use a SQL database** (PostgreSQL recommended) instead of SQLite.
2. **Enable HA mode** in scheduler config:

```yaml
scheduler:
  storage:
    driver: postgresql
    connection:
      host: postgres.visor.svc.cluster.local
      database: visor
      user: visor
      password: ${VISOR_DB_PASSWORD}
  ha:
    enabled: true
    lock_ttl: 60
    heartbeat_interval: 15
```

3. **Each instance must have a unique `node_id`**. By default, Visor uses `hostname-pid` which is unique in containers.
4. **Slack mode**: Multiple replicas can connect to the same Slack app. Socket Mode distributes events across connected instances.

---

## Logging and Monitoring

### Structured Logging

Visor logs to stderr in structured format. Redirect to your log aggregator:

```yaml
# Kubernetes: logs are collected automatically by fluentd/fluent-bit
# Docker: use --log-driver
docker run --log-driver=json-file --log-opt max-size=100m ...
```

### OpenTelemetry

Enable tracing for full execution visibility:

```yaml
# .visor.yaml
telemetry:
  enabled: true
  sink: otlp
  tracing:
    auto_instrumentations: true
    trace_report:
      enabled: true
```

```bash
# Environment
VISOR_TELEMETRY_ENABLED=true
VISOR_TELEMETRY_SINK=otlp
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://jaeger:4318/v1/traces
```

See [Telemetry Setup](./telemetry-setup.md) and [Dashboards](./dashboards/README.md) for Grafana dashboard templates.

### Key Metrics to Monitor

- **Check execution duration**: Track via OTel spans (`visor.check.*`)
- **Check success/failure rates**: Available in execution statistics
- **Scheduler lock contention**: Watch for `Timeout acquiring a connection` errors
- **AI provider latency and errors**: Track via provider-level spans
- **Memory and CPU usage**: Standard container metrics

---

## Backup and Recovery

### SQLite (single-node)

```bash
# Backup
cp .visor/schedules.db .visor/schedules.db.bak
cp .visor/config.db .visor/config.db.bak

# Restore
cp .visor/schedules.db.bak .visor/schedules.db
```

### PostgreSQL

```bash
# Backup
pg_dump -h db.example.com -U visor visor > visor-backup.sql

# Restore
psql -h db.example.com -U visor visor < visor-backup.sql
```

For automated backups, see [Database Operations](./database-operations.md).

### Config Snapshots

Visor automatically snapshots resolved configuration at startup and on reload. Use the `visor config` command to list, view, and restore snapshots:

```bash
visor config snapshots         # List snapshots
visor config show 1            # View snapshot YAML
visor config restore 1 --output restored.yaml
```

---

## Upgrading

### Rolling Update (Kubernetes)

```bash
# Update image
kubectl set image -n visor deployment/visor visor=your-registry/visor:v1.2.3

# Monitor rollout
kubectl rollout status -n visor deployment/visor
```

### Docker Compose

```bash
docker compose pull
docker compose up -d
```

### Pre-upgrade Checklist

1. **Read release notes** for breaking changes.
2. **Back up the database** before upgrading.
3. **Validate config** with the new version: `visor validate --config .visor.yaml`
4. **Test in staging** before production rollout.
5. For EE: Verify your license is compatible with the new version.

---

## Troubleshooting

### Container Exits Immediately

- Check logs: `docker logs visor` or `kubectl logs -n visor deploy/visor`
- Verify `--config` path is correct and mounted.
- Ensure required environment variables are set.

### Cannot Connect to Database

- Verify network connectivity: `nc -zv db.example.com 5432`
- Check credentials and database name.
- For Kubernetes: Ensure the database Service is in the same namespace or use FQDN.

### Slack Mode Not Receiving Events

- Verify `SLACK_APP_TOKEN` is a valid app-level token (`xapp-...`).
- Check that Socket Mode is enabled in Slack app settings.
- Review Slack app event subscriptions.

### Config Reload Not Working

- `--watch` requires `--config <path>` (explicit path, not auto-discovery).
- Check file permissions on the config file.
- Send `SIGUSR2` manually to test: `kill -USR2 $(pgrep -f visor)`

### OOM Kills

- Increase memory limits in container spec.
- Reduce `--max-parallelism` to lower concurrent check count.
- Check for memory leaks in long-running Slack mode (report at [GitHub Issues](https://github.com/probelabs/visor/issues)).
