# Capacity Planning and Sizing

This guide helps you size Visor deployments for different workloads, from single-developer setups to large-scale enterprise deployments.

---

## Table of Contents

- [Resource Profiles](#resource-profiles)
- [Deployment Tiers](#deployment-tiers)
- [Component Sizing](#component-sizing)
  - [Visor Instances](#visor-instances)
  - [Database](#database)
  - [AI Provider Costs](#ai-provider-costs)
- [Scaling Guidelines](#scaling-guidelines)
- [Bottleneck Analysis](#bottleneck-analysis)
- [Cloud Cost Estimates](#cloud-cost-estimates)
- [Load Testing](#load-testing)
- [Monitoring for Scale](#monitoring-for-scale)

---

## Resource Profiles

Visor's resource consumption depends primarily on:

1. **Number of concurrent checks**: Each check consumes a thread and memory for provider execution.
2. **AI provider usage**: AI checks send/receive large payloads (code diffs, prompts, responses).
3. **Sandbox usage**: Docker-based sandboxes consume additional CPU/memory per container.
4. **Scheduler load**: Number of active schedules and execution frequency.

### Per-Check Resource Footprint

| Check Type | CPU (avg) | Memory (avg) | Network | Duration |
|-----------|----------|-------------|---------|----------|
| `command` | 50m | 20MB | Minimal | 1-30s |
| `script` | 50m | 30MB | None | < 1s |
| `ai` (Gemini) | 10m | 50MB | Moderate | 5-30s |
| `ai` (Claude) | 10m | 50MB | Moderate | 10-60s |
| `claude-code` | 100m | 200MB | High | 30-300s |
| `mcp` | 50m | 50MB | Varies | 1-60s |
| `http` / `http_client` | 10m | 10MB | Low | 1-10s |
| Sandbox (Docker) | 250m+ | 256MB+ | Varies | 10-120s |

---

## Deployment Tiers

### Small (1-10 developers)

Single instance, SQLite, ephemeral runs.

| Component | Spec | Cost Estimate |
|-----------|------|---------------|
| Visor | 1 instance, 256MB RAM, 0.5 CPU | Free (CLI) or $5/mo (small VM) |
| Database | SQLite (local file) | $0 |
| AI Provider | ~100 reviews/month | $5-20/mo |

**Configuration:**
```yaml
max_parallelism: 3
scheduler:
  storage:
    driver: sqlite
```

### Medium (10-50 developers)

2-3 instances, PostgreSQL, Slack integration.

| Component | Spec | Cost Estimate |
|-----------|------|---------------|
| Visor | 2-3 instances, 512MB RAM, 1 CPU each | $30-80/mo |
| Database | PostgreSQL (small managed) | $15-30/mo |
| AI Provider | ~500-2000 reviews/month | $30-150/mo |

**Configuration:**
```yaml
max_parallelism: 5
scheduler:
  storage:
    driver: postgresql
    connection:
      pool:
        min: 1
        max: 5
  ha:
    enabled: true
```

### Large (50-500 developers)

5+ instances, PostgreSQL with PgBouncer, full observability.

| Component | Spec | Cost Estimate |
|-----------|------|---------------|
| Visor | 5+ instances, 1GB RAM, 2 CPU each | $150-400/mo |
| Database | PostgreSQL (medium managed + replica) | $50-200/mo |
| PgBouncer | 1 instance, 128MB RAM | $5-10/mo |
| AI Provider | ~5000-20000 reviews/month | $200-1500/mo |
| Observability | Jaeger/Grafana | $50-200/mo |

**Configuration:**
```yaml
max_parallelism: 10
scheduler:
  storage:
    driver: postgresql
    connection:
      pool:
        min: 0
        max: 3    # PgBouncer handles pooling
  ha:
    enabled: true
    lock_ttl: 120
    heartbeat_interval: 15
```

---

## Component Sizing

### Visor Instances

| Metric | Formula | Example |
|--------|---------|---------|
| **Concurrent checks** | `instances * max_parallelism` | 3 * 5 = 15 concurrent |
| **Memory per instance** | `base (100MB) + checks * avg_per_check` | 100 + 5 * 50 = 350MB |
| **CPU per instance** | `0.25 base + checks * avg_cpu` | 0.25 + 5 * 0.05 = 0.5 cores |

**Recommended instance sizes:**

| Workload | vCPU | Memory | `max_parallelism` |
|----------|------|--------|-------------------|
| Light (CLI checks only) | 0.5 | 256MB | 3 |
| Medium (AI + Slack) | 1 | 512MB | 5 |
| Heavy (Claude Code + sandboxes) | 2 | 1GB | 5-10 |
| Sandbox-heavy | 4 | 2GB | 3-5 |

### Database

Visor's database footprint is small. The `schedules` table grows linearly with active schedules.

| Deployment | Rows (approx) | Disk | Recommended Instance |
|------------|--------------|------|---------------------|
| Small | < 100 | < 10MB | SQLite |
| Medium | 100-1000 | < 100MB | db.t3.micro (AWS) / B1ms (Azure) |
| Large | 1000-10000 | < 1GB | db.t3.small (AWS) / B2s (Azure) |

PostgreSQL memory recommendation: **256MB shared_buffers** is sufficient for all Visor workloads.

### AI Provider Costs

AI costs scale with the size of code diffs and prompt complexity.

| Provider | Model | Cost per 1K tokens (approx) | Avg tokens per review | Cost per review |
|----------|-------|-----------------------------|----------------------|-----------------|
| Gemini | gemini-2.0-flash | $0.0001 / $0.0004 | 5K-20K | $0.002-0.01 |
| Claude | claude-sonnet-4-5 | $0.003 / $0.015 | 5K-20K | $0.03-0.20 |
| Claude Code | claude-sonnet-4-5 | $0.003 / $0.015 | 10K-50K | $0.10-0.50 |
| OpenAI | gpt-4o | $0.0025 / $0.01 | 5K-20K | $0.03-0.15 |

**Cost optimization strategies:**
- Use Gemini Flash for high-volume, lower-stakes checks.
- Reserve Claude/GPT-4 for security and architecture reviews.
- Use `--tags` to run expensive checks only when needed.
- Set `max_tokens` in AI provider config to cap response size.

---

## Scaling Guidelines

### When to Add Instances

| Signal | Action |
|--------|--------|
| Check queue backlog growing | Increase `max_parallelism` or add instances |
| Response times > 2x baseline | Add instances |
| Memory usage > 80% | Increase memory or reduce `max_parallelism` |
| Slack message response > 30s | Add instances for Slack mode |

### When to Upgrade Database

| Signal | Action |
|--------|--------|
| SQLite lock contention | Migrate to PostgreSQL |
| Multiple Visor instances needed | Migrate to PostgreSQL with HA |
| Connection pool exhaustion | Add PgBouncer |
| Query latency > 100ms | Check indexes, consider larger instance |

### Horizontal vs Vertical Scaling

| Dimension | Horizontal (more instances) | Vertical (bigger instance) |
|-----------|---------------------------|--------------------------|
| Best for | Slack throughput, HA | Heavy single checks, sandbox execution |
| Requires | PostgreSQL + HA mode | Nothing special |
| Limit | Slack API rate limits | Single-machine resources |
| Recommended | Yes, for production | Yes, up to 4 vCPU / 4GB |

---

## Bottleneck Analysis

Common bottlenecks in order of likelihood:

### 1. AI Provider Latency (most common)

AI API calls (5-60s) dominate total execution time.

**Mitigation:**
- Increase `max_parallelism` to overlap AI calls.
- Use faster models (Gemini Flash) for non-critical checks.
- Use `timeout` per check to prevent hangs.

### 2. Sandbox Startup Time

Docker container creation adds 2-10s overhead per sandboxed check.

**Mitigation:**
- Pre-pull images on nodes.
- Use lightweight base images (`alpine`).
- Enable cache volumes to avoid re-installing dependencies.

### 3. Database Connection Pool

With many instances and high scheduler activity, connections can exhaust.

**Mitigation:**
- Deploy PgBouncer for connection multiplexing.
- Keep Visor `pool.max` low (3-5) when using PgBouncer.
- Monitor with `pg_stat_activity`.

### 4. Network / API Rate Limits

GitHub API (5000 req/hr), Slack API (tier-based).

**Mitigation:**
- Use GitHub App tokens (higher rate limits) instead of PATs.
- Batch operations where possible.
- Monitor rate limit headers.

---

## Cloud Cost Estimates

### AWS

| Component | Service | Spec | Monthly Cost |
|-----------|---------|------|-------------|
| Visor (2x) | ECS Fargate | 0.5 vCPU, 1GB | ~$30 |
| Database | RDS PostgreSQL | db.t3.micro | ~$15 |
| Secrets | Secrets Manager | 3 secrets | ~$1.20 |
| Monitoring | CloudWatch | Basic | ~$5 |
| **Total** | | | **~$51/mo** |

### Google Cloud

| Component | Service | Spec | Monthly Cost |
|-----------|---------|------|-------------|
| Visor (2x) | Cloud Run | 1 vCPU, 512MB | ~$25 |
| Database | Cloud SQL PostgreSQL | db-f1-micro | ~$10 |
| Secrets | Secret Manager | 3 secrets | ~$0.18 |
| Monitoring | Cloud Monitoring | Basic | Free |
| **Total** | | | **~$35/mo** |

### Azure

| Component | Service | Spec | Monthly Cost |
|-----------|---------|------|-------------|
| Visor (2x) | Container Instances | 1 vCPU, 1GB | ~$35 |
| Database | Azure Database for PostgreSQL | B1ms | ~$15 |
| Secrets | Key Vault | 3 secrets | ~$0.10 |
| Monitoring | Monitor | Basic | ~$5 |
| **Total** | | | **~$55/mo** |

*Costs are approximate and vary by region. AI provider costs are additional.*

---

## Load Testing

### Test Setup

Create a load-test configuration with synthetic checks:

```yaml
# load-test.visor.yaml
version: "1.0"
max_parallelism: 10

checks:
  synthetic-fast:
    type: command
    command: "echo ok"
    tags: [load-test]

  synthetic-slow:
    type: command
    command: "sleep 2 && echo ok"
    tags: [load-test]

  synthetic-ai:
    type: ai
    prompt: "Say 'ok' in one word."
    tags: [load-test]
```

### Running Load Tests

```bash
# Sequential: measure single-check latency
time visor --config load-test.visor.yaml --check all --tags load-test

# Parallel: measure throughput
for i in $(seq 1 20); do
  visor --config load-test.visor.yaml --check all --tags load-test &
done
wait
```

### Key Metrics to Capture

- **P50/P95/P99 check duration**: Baseline for SLA.
- **Throughput**: Checks per minute at different parallelism levels.
- **Error rate**: Failed checks under load.
- **Memory growth**: Watch for leaks in long-running mode.
- **Database connections**: Peak concurrent connections.

---

## Monitoring for Scale

### Alerts to Configure

| Alert | Threshold | Action |
|-------|-----------|--------|
| Check error rate > 5% | 5min window | Investigate provider health |
| P95 latency > 120s | 5min window | Scale horizontally or reduce parallelism |
| Memory > 80% of limit | Sustained | Increase memory or reduce parallelism |
| DB connections > 80% of max | Sustained | Add PgBouncer or increase pool |
| Scheduler lock failures | Any | Check HA config, verify DB health |
| License expiring < 7 days | Daily check | Renew license |

### Grafana Dashboard Queries

If using OpenTelemetry with Grafana:

```promql
# Check execution rate
rate(visor_check_executions_total[5m])

# P95 check duration
histogram_quantile(0.95, rate(visor_check_duration_seconds_bucket[5m]))

# Active Visor instances (from heartbeat)
count(up{job="visor"})
```

See [Dashboards](./dashboards/README.md) for pre-built Grafana dashboards.
