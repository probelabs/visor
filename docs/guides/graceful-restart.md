# Graceful Restart

Visor supports zero-disruption restarts via `SIGUSR1`. When triggered, the old process stops accepting new work, a new process spawns and begins accepting requests, and the old process waits for all in-flight work to complete before exiting. Both processes run in parallel during the transition.

## How It Works

```
SIGUSR1 received by old process
  → Stop listening on all ports (free ports instantly)
  → Spawn new process with same args/env
  → New process starts, binds ports, sends IPC "ready" signal
  → Old process drains: waits for ALL in-flight work to complete
  → Old process runs cleanup callbacks
  → Old process exits
```

**Key behavior:** By default, the old process runs **indefinitely** until all in-flight work completes. There is no timeout — active conversations, tool calls, and webhook handlers are never interrupted. You can optionally set a hard timeout via configuration.

## Usage

### Trigger a Restart

```bash
# Find the Visor PID
pgrep -f visor

# Send SIGUSR1
kill -USR1 <pid>
```

### Kubernetes / Docker

```bash
# Kubernetes
kubectl exec -n visor deploy/visor -- kill -USR1 1

# Docker
docker kill --signal=USR1 visor
```

### systemd

```ini
[Service]
ExecReload=/bin/kill -USR1 $MAINPID
```

Then reload with:
```bash
systemctl reload visor
```

## Configuration

Add `graceful_restart` to your `.visor.yaml`:

```yaml
graceful_restart:
  # Maximum time to wait for in-flight work to complete (milliseconds).
  # 0 = unlimited (default). Old process waits as long as needed.
  drain_timeout_ms: 0

  # Maximum time to wait for the new process to start and signal readiness.
  # Default: 15000 (15 seconds).
  child_ready_timeout_ms: 15000

  # Send "bot is restarting" messages to active conversations.
  # Default: true.
  notify_users: true

  # Override the auto-detected spawn command.
  # Leave empty to auto-detect (recommended).
  restart_command: ""
```

## Auto-Detection of Spawn Method

Visor automatically detects how it was invoked and spawns the new process accordingly:

| Invocation | Spawn behavior |
|---|---|
| `npx -y @probelabs/visor@latest --slack` | Re-runs `npx -y @probelabs/visor@latest` + original args (fetches latest version) |
| `node dist/index.js --slack` | Re-runs `node dist/index.js` + same args (picks up updated binary on disk) |
| `./dist/index.js --slack` | Re-runs with `process.execPath` + same argv |
| Custom (`restart_command` set) | Runs the configured command + original Visor args |

The `VISOR_RESTART_GENERATION` environment variable is incremented on each restart, letting you track restart generations in logs.

## Graceful Restart vs Config Reload

Visor supports two complementary mechanisms for applying changes without disruption:

| Mechanism | Signal | Use case | Process lifecycle |
|---|---|---|---|
| **Graceful restart** (`SIGUSR1`) | `kill -USR1` | New code, binary updates, dependency changes | Old process drains, new process spawns |
| **Hot config reload** (`SIGUSR2` / `--watch`) | `kill -USR2` | Config-only changes (thresholds, checks, routing) | Same process, config reloaded in-place |

**When to use `--watch`:** If you only need to update `.visor.yaml` (e.g., add a check, change a threshold, adjust routing), use `--watch` to auto-reload on file changes — no restart needed:

```bash
visor --slack --config .visor.yaml --watch
```

The `--watch` flag monitors the config file for changes and applies them without restarting. This is faster and lighter than a full graceful restart. Use graceful restart (`SIGUSR1`) when you need to pick up new code or binary changes.

## Signal Reference

| Signal | Behavior |
|---|---|
| `SIGUSR1` | Graceful restart — spawns new process, drains old |
| `SIGUSR2` | Hot config reload — reloads `.visor.yaml` in-place (also triggered by `--watch`) |
| `SIGTERM` | Graceful shutdown (stop + exit) |
| `SIGINT` | Graceful shutdown (stop + exit) |

## What Gets Drained

Each runner type handles draining differently:

| Runner | stopListening | drain |
|---|---|---|
| **Slack** | Closes WebSocket, stops scheduler | Waits for all active threads to finish |
| **MCP Server** | Closes HTTP server, frees port | Waits for all active tool calls to complete |
| **Telegram** | Stops long-polling | Waits for active chat handlers |
| **Email** | Stops polling interval | Waits for active email processing |
| **WhatsApp** | Closes webhook HTTP server | Waits for active request handlers |
| **Teams** | Closes webhook HTTP server | Waits for active request handlers |
| **A2A** | Closes HTTP server | Waits for active tasks in queue |

## Error Handling

| Scenario | Behavior |
|---|---|
| New process fails to start | Restart aborted, old process continues serving |
| New process doesn't become ready in time | Restart aborted, child killed, old process continues |
| Drain timeout exceeded (if configured) | Old process force-exits; new process is already running |
| Double SIGUSR1 | Second signal ignored while restart is in progress |
| SIGTERM during restart | Standard shutdown handler takes over |

## Deployment Patterns

### Blue-Green with SIGUSR1

1. Deploy new code to disk (e.g., `npm install -g @probelabs/visor@latest`)
2. Send `SIGUSR1` to the running process
3. New process picks up updated binary automatically
4. Old process drains and exits

### Rolling Restart in Kubernetes

For Kubernetes deployments with multiple replicas, you can use the built-in rolling update strategy instead of SIGUSR1. However, SIGUSR1 is useful for single-replica deployments or when you want to avoid pod recreation:

```bash
# Restart single instance without pod recreation
kubectl exec -n visor deploy/visor -- kill -USR1 1
```

### CI/CD Integration

```yaml
# GitHub Actions example
- name: Deploy and restart
  run: |
    ssh deploy@server "cd /opt/visor && git pull && npm ci && npm run build"
    ssh deploy@server "kill -USR1 $(cat /var/run/visor.pid)"
```

## Monitoring

Track restarts via:
- **Logs:** Look for `[GracefulRestart]` log entries
- **Environment:** `VISOR_RESTART_GENERATION` shows current generation
- **OTel:** Restart events appear as spans in telemetry traces

## Limitations

- **Windows:** `SIGUSR1` is not available on Windows. Use process restart via your service manager instead.
- **Slack WebSocket:** The WebSocket connection cannot be transferred between processes. The new process opens a fresh Socket Mode connection. Slack automatically routes new events to the new connection.
- **npx mode:** When running via npx, each restart fetches the latest published version. Pin versions in `restart_command` if you need deterministic restarts.
