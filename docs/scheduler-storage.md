# Scheduler Storage

This guide covers database storage configuration for the Visor scheduler, including cloud database setup, SSL/TLS, connection pooling, and high-availability deployments.

## Overview

The scheduler supports four storage drivers:

| Driver | License | Use Case |
|--------|---------|----------|
| `sqlite` | OSS (free) | Single-node, local development, small deployments |
| `postgresql` | Enterprise | Production, multi-node HA, cloud databases |
| `mysql` | Enterprise | Production, multi-node HA, cloud databases |
| `mssql` | Enterprise | Azure SQL, SQL Server environments |

## SQLite (Default)

Zero-configuration — works out of the box:

```yaml
scheduler:
  enabled: true
  storage:
    driver: sqlite
    connection:
      filename: .visor/schedules.db  # default
```

SQLite is the default when no driver is specified. It stores data in a local file and supports all scheduler features except distributed locking (HA mode).

## PostgreSQL

```yaml
scheduler:
  storage:
    driver: postgresql
    connection:
      host: localhost
      port: 5432
      database: visor
      user: visor
      password: ${VISOR_DB_PASSWORD}
      ssl: true
```

## MySQL

```yaml
scheduler:
  storage:
    driver: mysql
    connection:
      host: localhost
      port: 3306
      database: visor
      user: visor
      password: ${VISOR_DB_PASSWORD}
      ssl: true
```

## MSSQL (SQL Server)

```yaml
scheduler:
  storage:
    driver: mssql
    connection:
      host: localhost
      port: 1433
      database: visor
      user: sa
      password: ${VISOR_DB_PASSWORD}
      ssl:
        reject_unauthorized: true
```

For MSSQL, `host` is mapped to the tedious driver's `server` parameter internally. SSL configuration maps to `encrypt` and `trustServerCertificate` options.

## Connection String

All server drivers support connection string URLs as an alternative to individual parameters:

```yaml
scheduler:
  storage:
    driver: postgresql
    connection:
      connection_string: postgresql://visor:secret@db.example.com:5432/visor?sslmode=require
```

```yaml
scheduler:
  storage:
    driver: mysql
    connection:
      connection_string: mysql://visor:secret@db.example.com:3306/visor
```

When `connection_string` is set, `host`, `port`, `database`, `user`, and `password` are ignored.

## SSL/TLS Configuration

### Boolean (simple)

```yaml
connection:
  host: db.example.com
  ssl: true  # enables SSL with rejectUnauthorized: true
```

### Object (detailed)

```yaml
connection:
  host: db.example.com
  ssl:
    enabled: true
    reject_unauthorized: true    # default: true
    ca: /path/to/ca-cert.pem     # CA certificate
    cert: /path/to/client-cert.pem  # client certificate (mTLS)
    key: /path/to/client-key.pem    # client key (mTLS)
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Enable SSL (when object is provided) |
| `reject_unauthorized` | `true` | Validate server certificate against CA |
| `ca` | — | Path to CA certificate PEM file |
| `cert` | — | Path to client certificate PEM file (for mTLS) |
| `key` | — | Path to client key PEM file (for mTLS) |

Certificate file paths are read at initialization time. This works well with Kubernetes secret mounts, AWS SSM Parameter Store files, and similar mechanisms.

## Connection Pool

```yaml
connection:
  host: db.example.com
  pool:
    min: 0    # default: 0 (good for serverless)
    max: 10   # default: 10
```

| Field | Default | Description |
|-------|---------|-------------|
| `min` | `0` | Minimum connections to keep open |
| `max` | `10` | Maximum simultaneous connections |

**Serverless tip**: Keep `min: 0` to avoid holding idle connections in Lambda/Cloud Functions. The pool will scale up on demand and release connections when idle.

**High-throughput tip**: Increase `max` if you have many concurrent schedule executions. Each execution may hold a connection during locking and updates.

## Cloud Database Examples

### AWS RDS PostgreSQL

```yaml
scheduler:
  storage:
    driver: postgresql
    connection:
      host: mydb.abc123.us-east-1.rds.amazonaws.com
      port: 5432
      database: visor
      user: visor
      password: ${RDS_PASSWORD}
      ssl:
        reject_unauthorized: true
        ca: /etc/ssl/certs/rds-combined-ca-bundle.pem
      pool:
        min: 0
        max: 10
```

Download the [RDS CA bundle](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html) and mount it in your container or EC2 instance.

### AWS RDS MySQL

```yaml
scheduler:
  storage:
    driver: mysql
    connection:
      host: mydb.abc123.us-east-1.rds.amazonaws.com
      port: 3306
      database: visor
      user: visor
      password: ${RDS_PASSWORD}
      ssl:
        reject_unauthorized: true
        ca: /etc/ssl/certs/rds-combined-ca-bundle.pem
```

### AWS Aurora PostgreSQL

```yaml
scheduler:
  storage:
    driver: postgresql
    connection:
      host: mycluster.cluster-abc123.us-east-1.rds.amazonaws.com
      port: 5432
      database: visor
      user: visor
      password: ${AURORA_PASSWORD}
      ssl:
        reject_unauthorized: true
        ca: /etc/ssl/certs/rds-combined-ca-bundle.pem
      pool:
        min: 0
        max: 10
```

Use the **cluster endpoint** (writer) for the scheduler. Aurora uses the same CA bundle as RDS.

### AWS Aurora MySQL

```yaml
scheduler:
  storage:
    driver: mysql
    connection:
      host: mycluster.cluster-abc123.us-east-1.rds.amazonaws.com
      port: 3306
      database: visor
      user: visor
      password: ${AURORA_PASSWORD}
      ssl:
        reject_unauthorized: true
        ca: /etc/ssl/certs/rds-combined-ca-bundle.pem
```

### Azure Database for PostgreSQL

```yaml
scheduler:
  storage:
    driver: postgresql
    connection:
      host: myserver.postgres.database.azure.com
      port: 5432
      database: visor
      user: visor@myserver
      password: ${AZURE_DB_PASSWORD}
      ssl:
        reject_unauthorized: true
        ca: /etc/ssl/certs/DigiCertGlobalRootCA.crt.pem
```

Azure PostgreSQL requires the username in `user@servername` format. Download the [DigiCert Global Root CA](https://learn.microsoft.com/en-us/azure/postgresql/single-server/concepts-ssl-connection-security).

### Azure Database for MySQL

```yaml
scheduler:
  storage:
    driver: mysql
    connection:
      host: myserver.mysql.database.azure.com
      port: 3306
      database: visor
      user: visor@myserver
      password: ${AZURE_DB_PASSWORD}
      ssl:
        reject_unauthorized: true
        ca: /etc/ssl/certs/DigiCertGlobalRootCA.crt.pem
```

### Azure SQL Database (MSSQL)

```yaml
scheduler:
  storage:
    driver: mssql
    connection:
      host: myserver.database.windows.net
      port: 1433
      database: visor
      user: visor
      password: ${AZURE_SQL_PASSWORD}
      ssl:
        reject_unauthorized: true
```

Azure SQL Database enforces encryption by default. The `ssl.reject_unauthorized: true` setting maps to `trustServerCertificate: false` (i.e., the server certificate is validated).

### Google Cloud SQL PostgreSQL

```yaml
scheduler:
  storage:
    driver: postgresql
    connection:
      host: /cloudsql/project:region:instance  # Unix socket
      database: visor
      user: visor
      password: ${CLOUDSQL_PASSWORD}
```

When using the [Cloud SQL Auth Proxy](https://cloud.google.com/sql/docs/postgres/connect-auth-proxy), connect via Unix socket (no SSL needed as the proxy handles encryption):

```yaml
connection:
  host: 127.0.0.1
  port: 5432
  database: visor
  user: visor
  password: ${CLOUDSQL_PASSWORD}
```

### Google Cloud SQL MySQL

```yaml
scheduler:
  storage:
    driver: mysql
    connection:
      host: 127.0.0.1
      port: 3306
      database: visor
      user: visor
      password: ${CLOUDSQL_PASSWORD}
```

### Google Cloud SQL - SQL Server

```yaml
scheduler:
  storage:
    driver: mssql
    connection:
      host: 127.0.0.1
      port: 1433
      database: visor
      user: sqlserver
      password: ${CLOUDSQL_PASSWORD}
      ssl:
        reject_unauthorized: true
```

## High Availability

For multi-node deployments, enable HA mode with a server database:

```yaml
scheduler:
  storage:
    driver: postgresql
    connection:
      host: db.example.com
      database: visor
      user: visor
      password: ${DB_PASSWORD}
      ssl: true
  ha:
    enabled: true
    node_id: node-1          # unique per node (default: hostname-pid)
    lock_ttl: 60             # lock expiry in seconds
    heartbeat_interval: 15   # lock renewal interval
```

HA mode uses row-level distributed locking to ensure each schedule is executed by exactly one node. SQLite does **not** support HA mode — use PostgreSQL, MySQL, or MSSQL.

## Migration from JSON

If you previously used JSON file storage (`storage.path: .visor/schedules.json`), the scheduler automatically migrates data to the configured database on first startup. The JSON file is preserved as a backup.

```yaml
# Legacy config (auto-migrated)
scheduler:
  storage:
    path: .visor/schedules.json

# New config
scheduler:
  storage:
    driver: sqlite  # or postgresql/mysql/mssql
```

## Troubleshooting

### Connection Refused

```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

- Verify the database server is running and accessible
- Check host, port, and firewall rules
- For cloud databases, ensure your IP is whitelisted

### SSL Certificate Error

```
Error: self signed certificate in certificate chain
```

- Set the `ca` path to your cloud provider's CA certificate bundle
- For development with self-signed certs: `ssl.reject_unauthorized: false` (not recommended for production)

### Authentication Failed

```
Error: password authentication failed for user "visor"
```

- Verify `user` and `password` are correct
- For Azure PostgreSQL, use `user@servername` format
- Check that the user has access to the specified database

### Module Not Found

```
Error: knex is required for PostgreSQL/MySQL/MSSQL schedule storage
```

Install the required database driver:

```bash
npm install knex pg          # PostgreSQL
npm install knex mysql2      # MySQL
npm install knex tedious     # MSSQL
```

### Pool Exhaustion

```
Error: Knex: Timeout acquiring a connection
```

- Increase `pool.max` in your configuration
- Check for connection leaks or long-running transactions
- For serverless, ensure `pool.min: 0` to avoid stale connections
