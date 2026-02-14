# Database Operations Guide

> **Enterprise Edition feature.** PostgreSQL, MySQL, and MSSQL backends require a Visor EE license with the `scheduler-sql` feature.

This guide covers production database operations for Visor's SQL backends: backup, replication, failover, connection pooling, and migration from SQLite.

---

## Table of Contents

- [Overview](#overview)
- [Schema and Tables](#schema-and-tables)
- [PostgreSQL Operations](#postgresql-operations)
  - [Initial Setup](#initial-setup)
  - [Backup Strategies](#backup-strategies)
  - [Replication](#replication)
  - [Connection Pooling with PgBouncer](#connection-pooling-with-pgbouncer)
  - [Monitoring](#monitoring)
- [MySQL Operations](#mysql-operations)
- [MSSQL Operations](#mssql-operations)
- [Migrating from SQLite to PostgreSQL](#migrating-from-sqlite-to-postgresql)
- [Performance Tuning](#performance-tuning)
- [Disaster Recovery](#disaster-recovery)
- [Troubleshooting](#troubleshooting)

---

## Overview

Visor uses two databases in production:

| Database | Path / Table | Purpose | Backend |
|----------|-------------|---------|---------|
| Scheduler | `schedules`, `scheduler_locks` | Schedule state, HA locking | SQLite (OSS) or PostgreSQL/MySQL/MSSQL (EE) |
| Config Snapshots | `.visor/config.db` | Config snapshot history | SQLite only (local) |

The scheduler database is the critical stateful component. Config snapshots are local-only and do not require HA.

---

## Schema and Tables

Visor auto-creates tables on first connection. No manual migration is required.

### `schedules` Table

```sql
CREATE TABLE schedules (
  id               VARCHAR(36)  PRIMARY KEY,
  creator_id       VARCHAR(255) NOT NULL,
  creator_context  VARCHAR(255),
  creator_name     VARCHAR(255),
  timezone         VARCHAR(64)  NOT NULL DEFAULT 'UTC',
  schedule_expr    VARCHAR(255),
  run_at           BIGINT,
  is_recurring     BOOLEAN      NOT NULL,
  original_expression TEXT,
  workflow         VARCHAR(255),
  workflow_inputs  TEXT,          -- JSON
  output_context   TEXT,          -- JSON
  status           VARCHAR(20)  NOT NULL,
  created_at       BIGINT       NOT NULL,
  last_run_at      BIGINT,
  next_run_at      BIGINT,
  run_count        INTEGER      NOT NULL DEFAULT 0,
  failure_count    INTEGER      NOT NULL DEFAULT 0,
  last_error       TEXT,
  previous_response TEXT,
  claimed_by       VARCHAR(255),
  claimed_at       BIGINT,
  lock_token       VARCHAR(36)
);
```

### `scheduler_locks` Table (HA mode)

```sql
CREATE TABLE scheduler_locks (
  lock_id     VARCHAR(255) PRIMARY KEY,
  node_id     VARCHAR(255) NOT NULL,
  lock_token  VARCHAR(36)  NOT NULL,
  acquired_at BIGINT       NOT NULL,
  expires_at  BIGINT       NOT NULL
);
```

### Indexes

```sql
CREATE INDEX idx_schedules_creator_id ON schedules(creator_id);
CREATE INDEX idx_schedules_status ON schedules(status);
CREATE INDEX idx_schedules_status_next_run ON schedules(status, next_run_at);
```

---

## PostgreSQL Operations

### Initial Setup

```bash
# Create database and user
psql -U postgres <<SQL
CREATE USER visor WITH PASSWORD 'changeme';
CREATE DATABASE visor OWNER visor;
GRANT ALL PRIVILEGES ON DATABASE visor TO visor;
SQL
```

Visor configuration:

```yaml
scheduler:
  storage:
    driver: postgresql
    connection:
      host: db.example.com
      port: 5432
      database: visor
      user: visor
      password: ${VISOR_DB_PASSWORD}
      ssl: true
      pool:
        min: 2
        max: 10
  ha:
    enabled: true
```

Visor creates all tables and indexes automatically on first startup.

### Backup Strategies

#### Logical Backup (pg_dump)

Best for small-to-medium deployments. Creates a portable SQL file.

```bash
# Full backup
pg_dump -h db.example.com -U visor -Fc visor > visor-$(date +%Y%m%d).dump

# Restore
pg_restore -h db.example.com -U visor -d visor --clean visor-20260214.dump
```

#### Continuous Archiving (WAL)

Best for production with point-in-time recovery (PITR).

```ini
# postgresql.conf
wal_level = replica
archive_mode = on
archive_command = 'cp %p /var/lib/postgresql/wal_archive/%f'
```

```bash
# Base backup
pg_basebackup -h db.example.com -U replication -D /var/lib/postgresql/backup -Fp -Xs -P
```

#### Cloud-Managed Backups

- **AWS RDS**: Automated backups enabled by default (35-day retention).
- **Google Cloud SQL**: Automated + on-demand backups via Console or `gcloud`.
- **Azure Database**: Automated backups with geo-redundancy option.

#### Recommended Schedule

| Frequency | Method | Retention |
|-----------|--------|-----------|
| Hourly | WAL archiving | 7 days |
| Daily | pg_dump (full) | 30 days |
| Weekly | pg_dump to offsite | 90 days |

### Replication

#### Streaming Replication (read replicas)

On the primary:

```ini
# postgresql.conf
wal_level = replica
max_wal_senders = 3
```

```sql
-- Create replication user
CREATE USER replication WITH REPLICATION LOGIN PASSWORD 'replpass';
```

On the replica:

```bash
pg_basebackup -h primary.example.com -U replication -D /var/lib/postgresql/data -Fp -Xs -P -R
```

The `-R` flag generates `standby.signal` and connection settings automatically.

#### Cloud-Managed Replicas

- **AWS RDS**: Create Read Replica via Console or CLI.
- **Aurora**: Up to 15 read replicas with sub-10ms lag.
- **Azure**: Read replicas for Azure Database for PostgreSQL.

**Note**: Visor's scheduler should always connect to the **primary/writer** endpoint. Read replicas are useful for reporting queries only.

### Connection Pooling with PgBouncer

For high-concurrency deployments (many Visor instances), PgBouncer reduces connection overhead.

```ini
# pgbouncer.ini
[databases]
visor = host=db.example.com port=5432 dbname=visor

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
default_pool_size = 20
max_client_conn = 200
```

```
# userlist.txt
"visor" "md5hash"
```

Update Visor config to point to PgBouncer:

```yaml
scheduler:
  storage:
    driver: postgresql
    connection:
      host: pgbouncer.example.com
      port: 6432
      database: visor
      user: visor
      password: ${VISOR_DB_PASSWORD}
      pool:
        min: 0     # Let PgBouncer manage pooling
        max: 5     # Fewer connections per instance
```

### Monitoring

Key PostgreSQL metrics to watch:

```sql
-- Active connections
SELECT count(*) FROM pg_stat_activity WHERE datname = 'visor';

-- Table sizes
SELECT relname, pg_size_pretty(pg_total_relation_size(relid))
FROM pg_catalog.pg_statio_user_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(relid) DESC;

-- Lock contention
SELECT * FROM pg_locks WHERE NOT granted;

-- Slow queries
SELECT query, calls, mean_exec_time, total_exec_time
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = 'visor')
ORDER BY mean_exec_time DESC LIMIT 10;
```

Enable `pg_stat_statements` for query performance tracking:

```ini
# postgresql.conf
shared_preload_libraries = 'pg_stat_statements'
```

---

## MySQL Operations

### Initial Setup

```sql
CREATE DATABASE visor CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'visor'@'%' IDENTIFIED BY 'changeme';
GRANT ALL PRIVILEGES ON visor.* TO 'visor'@'%';
FLUSH PRIVILEGES;
```

### Backup

```bash
# Full backup
mysqldump -h db.example.com -u visor -p visor > visor-$(date +%Y%m%d).sql

# Restore
mysql -h db.example.com -u visor -p visor < visor-20260214.sql
```

### Connection Pooling

MySQL's default `max_connections` (151) is usually sufficient. For high concurrency, increase it and keep Visor's pool small:

```yaml
connection:
  pool:
    min: 0
    max: 5
```

---

## MSSQL Operations

### Initial Setup

```sql
CREATE DATABASE visor;
GO
CREATE LOGIN visor WITH PASSWORD = 'changeme';
GO
USE visor;
CREATE USER visor FOR LOGIN visor;
ALTER ROLE db_owner ADD MEMBER visor;
GO
```

### Backup

```sql
BACKUP DATABASE visor TO DISK = '/var/opt/mssql/backup/visor.bak';
```

---

## Migrating from SQLite to PostgreSQL

### Step 1: Export from SQLite

```bash
# Dump schedule data
sqlite3 .visor/schedules.db ".mode json" ".once schedules.json" "SELECT * FROM schedules;"
```

### Step 2: Configure PostgreSQL

```yaml
scheduler:
  storage:
    driver: postgresql
    connection:
      host: db.example.com
      database: visor
      user: visor
      password: ${VISOR_DB_PASSWORD}
      ssl: true
```

### Step 3: Start Visor

Visor will create the schema automatically. If you had an older JSON-based store (`.visor/schedules.json`), Visor auto-migrates it on first startup.

### Step 4: Import Data (optional)

For SQLite-to-PostgreSQL data transfer, use a script or tool:

```bash
# Using pgloader (if available)
pgloader sqlite:///.visor/schedules.db postgresql://visor:pass@db.example.com/visor

# Or manual import via psql + json
cat schedules.json | psql -h db.example.com -U visor -d visor -c \
  "COPY schedules FROM STDIN WITH (FORMAT csv, HEADER true);"
```

### Step 5: Enable HA

Once on PostgreSQL, enable HA for multi-instance deployments:

```yaml
scheduler:
  ha:
    enabled: true
    lock_ttl: 60
    heartbeat_interval: 15
```

---

## Performance Tuning

### PostgreSQL Settings

For a dedicated Visor database (small dataset, write-heavy locking):

```ini
# postgresql.conf
shared_buffers = 256MB
effective_cache_size = 512MB
work_mem = 4MB
maintenance_work_mem = 64MB
max_connections = 50
checkpoint_completion_target = 0.9
wal_buffers = 16MB
```

### Visor Pool Sizing

| Deployment | `pool.min` | `pool.max` | Notes |
|------------|-----------|-----------|-------|
| Single instance | 0 | 5 | Minimal overhead |
| 2-3 instances | 1 | 5 | Keep warm connections |
| 5+ instances | 0 | 3 | Use PgBouncer upstream |
| Serverless/Lambda | 0 | 2 | Short-lived, release fast |

### Index Maintenance

Visor's tables are small (hundreds to low thousands of rows). Standard autovacuum is sufficient. No custom index maintenance is needed.

---

## Disaster Recovery

### Recovery Time Objective (RTO)

| Scenario | Recovery Method | Estimated RTO |
|----------|----------------|---------------|
| Instance crash | Container restart | < 1 min |
| Database corruption | Restore from pg_dump | 5-15 min |
| Full data loss | Restore from backup + WAL replay | 15-60 min |
| Region failure | Failover to standby region | Cloud-dependent |

### Recovery Procedure

1. **Stop all Visor instances** to prevent writes to a corrupted database.
2. **Restore the database** from the most recent backup.
3. **Verify data integrity**: `SELECT count(*) FROM schedules; SELECT count(*) FROM scheduler_locks;`
4. **Restart Visor instances**. HA locking will re-establish automatically.
5. **Check scheduler state**: `visor schedule list`

---

## Troubleshooting

### "knex is required" Error

Install the appropriate database driver:

```bash
npm install knex pg          # PostgreSQL
npm install knex mysql2      # MySQL
npm install knex tedious     # MSSQL
```

### Connection Pool Exhaustion

```
Error: Knex: Timeout acquiring a connection
```

- Reduce `pool.max` per instance and use PgBouncer.
- Check for long-running transactions or connection leaks.
- Increase `pool.max` if genuinely under high load.

### Lock Contention in HA Mode

If schedules are executing slowly or being skipped:

- Increase `lock_ttl` (default: 60s) if executions take longer.
- Decrease `heartbeat_interval` for faster lock renewal.
- Check `scheduler_locks` table for stale locks:

```sql
SELECT * FROM scheduler_locks WHERE expires_at < EXTRACT(EPOCH FROM NOW()) * 1000;
```

### Duplicate Schedule Execution

In rare cases (network partition, lock expiry during execution):

- Ensure `lock_ttl` exceeds your longest workflow execution time.
- Use `heartbeat_interval < lock_ttl / 3` for safe renewal.
- Design workflows to be idempotent where possible.
