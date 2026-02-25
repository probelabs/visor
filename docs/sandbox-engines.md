# Sandbox Engines

Visor supports three sandbox engines for isolating command execution. Each engine provides different tradeoffs between isolation strength, platform support, and performance.

## Overview

| Engine | Platform | Startup Overhead | Dependencies | Isolation Model |
|--------|----------|-----------------|--------------|-----------------|
| **Docker** | Linux, macOS, Windows | ~500ms+ | Docker daemon | Full container |
| **Bubblewrap** | Linux only | ~5-50ms | `bwrap` binary | Linux namespaces |
| **Seatbelt** | macOS only | ~10-30ms | Built-in (`sandbox-exec`) | SBPL policy profiles |

All three engines implement the same `SandboxInstance` interface and are configured through the same `sandboxes:` config block. The `engine` field determines which backend handles execution.

## Quick Start

```yaml
# .visor.yaml
sandboxes:
  # Linux: use bubblewrap for lightweight isolation
  bwrap:
    engine: bubblewrap
    network: true

  # macOS: use seatbelt for native isolation
  mac:
    engine: seatbelt
    network: true

  # Any platform: use Docker for full container isolation
  docker:
    image: node:20-alpine

# Default all steps to a sandbox
sandbox: bwrap  # or mac, or docker

steps:
  lint:
    type: command
    exec: eslint src/

  build:
    type: command
    sandbox: docker  # Override: use Docker for this step
    exec: npm run build
```

## Configuration

### Common Options

These options apply to all engine types:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `engine` | `'docker' \| 'bubblewrap' \| 'seatbelt'` | `'docker'` | Sandbox engine backend |
| `network` | `boolean` | `true` | Enable/disable network access |
| `read_only` | `boolean` | `false` | Mount repository as read-only |
| `workdir` | `string` | `'/workspace'` | Working directory inside sandbox (Docker/Bubblewrap only) |
| `env_passthrough` | `string[]` | — | Glob patterns for host env vars to forward |

### Docker-Only Options

These fields are only valid when `engine` is `'docker'` (or omitted):

| Field | Type | Description |
|-------|------|-------------|
| `image` | `string` | Docker image (e.g., `node:20-alpine`) |
| `dockerfile` | `string` | Path to Dockerfile |
| `dockerfile_inline` | `string` | Inline Dockerfile content |
| `compose` | `string` | Path to docker-compose file |
| `service` | `string` | Service name within compose file |
| `resources` | `object` | Memory/CPU limits (`memory: '512m'`, `cpu: 1.0`) |
| `cache` | `object` | Cache volume configuration |
| `visor_path` | `string` | Where visor is mounted inside container |

Using Docker-only fields with `engine: bubblewrap` or `engine: seatbelt` produces a validation error.

---

## Bubblewrap Engine

Bubblewrap (`bwrap`) provides lightweight process isolation using Linux kernel namespaces. It creates an isolated filesystem view, PID namespace, and optionally isolated network for each command execution.

### Requirements

- **Linux only** (uses kernel namespaces, which are not available on macOS/Windows)
- `bwrap` binary must be installed (`apt install bubblewrap` on Debian/Ubuntu)

### How It Works

Each `exec()` call spawns a fresh `bwrap` process with:

1. **Mount namespace**: Read-only system dirs (`/usr`, `/bin`, `/lib`, `/etc`) + writable workspace at `/workspace`
2. **PID namespace**: Sandboxed process cannot see host PIDs (`--unshare-pid`)
3. **Clean environment**: `--clearenv` strips all host env vars; only explicitly passed vars are visible (`--setenv`)
4. **Session isolation**: `--new-session` prevents terminal injection attacks
5. **Orphan cleanup**: `--die-with-parent` kills sandbox if parent dies
6. **Network isolation**: `--unshare-net` when `network: false`

### Configuration

```yaml
sandboxes:
  bwrap:
    engine: bubblewrap
    network: true        # Allow network access (default: true)
    read_only: false     # Writable workspace (default: false)
    workdir: /workspace  # Working directory inside sandbox (default: /workspace)
```

### Filesystem Layout Inside Sandbox

| Path | Access | Source |
|------|--------|--------|
| `/workspace` | Read-write (or read-only) | Host repository directory |
| `/usr`, `/bin`, `/lib` | Read-only | Host system directories |
| `/etc/resolv.conf`, `/etc/ssl` | Read-only | DNS and TLS certificates |
| `/tmp` | Read-write | Fresh tmpfs per execution |
| `/dev`, `/proc` | Minimal | Virtual filesystems |
| `~/.ssh`, `~/.aws`, `~/.config` | **Not mounted** | Inaccessible |

### Security Properties

| Property | Status |
|----------|--------|
| Filesystem isolation | Commands cannot access files outside allowed paths |
| Process isolation | PID namespace hides other processes |
| Environment isolation | `--clearenv` prevents credential theft |
| Terminal injection | `--new-session` prevents TIOCSTI attacks |
| Orphan cleanup | `--die-with-parent` ensures cleanup |
| Network isolation | Optional via `--unshare-net` |
| Resource limits | Not enforced (use cgroups separately) |

### CI/CD Notes

- Works in unprivileged CI runners (no Docker-in-Docker needed)
- May need `--cap-add SYS_ADMIN` or `--privileged` when running inside Docker containers
- On non-Linux platforms, `engine: bubblewrap` will fail at runtime with a clear error

---

## Seatbelt Engine

Seatbelt uses macOS's built-in `sandbox-exec` with dynamically-generated SBPL (Seatbelt Profile Language) profiles. Unlike bubblewrap, it does not create mount namespaces — commands see the real filesystem but are restricted by ACL-style policy rules.

### Requirements

- **macOS only** (`sandbox-exec` ships with macOS)
- No additional installation needed

### How It Works

Each `exec()` call:

1. **Generates an SBPL profile** with `(deny default)` base policy and explicit `(allow ...)` rules
2. **Runs** `sandbox-exec -p '<profile>' /usr/bin/env -i KEY=VAL ... /bin/sh -c '<command>'`
3. **Resolves symlinks** via `realpathSync` (macOS uses `/var` -> `/private/var`, `/tmp` -> `/private/tmp`)
4. **Cleans environment** using `env -i` (sandbox-exec inherits parent env, unlike bubblewrap's `--clearenv`)

### Configuration

```yaml
sandboxes:
  mac:
    engine: seatbelt
    network: true        # Allow network access (default: true)
    read_only: false     # Writable workspace (default: false)
```

Note: The `workdir` field is ignored for seatbelt — commands run from the real repository path (no mount remapping).

### SBPL Profile

The generated profile follows a deny-by-default model:

```scheme
(version 1)
(deny default)

;; Process execution
(allow process-exec)
(allow process-fork)

;; System paths (read-only)
(allow file-read*
  (literal "/")
  (subpath "/usr") (subpath "/bin") (subpath "/sbin")
  (subpath "/Library") (subpath "/System")
  (subpath "/private") (subpath "/var") (subpath "/etc")
  (subpath "/dev") (subpath "/tmp"))

;; Temp and device writes
(allow file-write*
  (subpath "/tmp") (subpath "/private/tmp") (subpath "/dev"))

;; xcrun cache (macOS Xcode tools)
(allow file-write* (regex #"/private/var/folders/.*/T/xcrun_db"))

;; Workspace access
(allow file-read* (subpath "/path/to/repo"))
(allow file-write* (subpath "/path/to/repo"))  ;; omitted when read_only

;; Network (omitted when network: false)
(allow network*)

;; System operations
(allow sysctl-read)
(allow mach-lookup)
(allow signal)
```

### Filesystem Access Inside Sandbox

| Path | Access | Notes |
|------|--------|-------|
| Repository directory | Read-write (or read-only) | Real filesystem path |
| `/usr`, `/bin`, `/Library`, `/System` | Read-only | System binaries and libraries |
| `/private`, `/var`, `/etc` | Read-only | System config (symlink-resolved) |
| `/tmp` | Read-write | Temporary files |
| `~/Documents`, `~/Desktop` | **Denied** | "Operation not permitted" |
| `~/.ssh`, `~/.aws`, `~/.claude` | **Denied** | "Operation not permitted" |
| `~/.gitconfig`, `~/.zsh_history` | **Denied** | "Operation not permitted" |

### Security Properties

| Property | Status |
|----------|--------|
| Filesystem isolation | ACL-style policy blocks access to unauthorized paths |
| Process isolation | Limited (no PID namespace) |
| Environment isolation | `env -i` strips inherited vars; only explicitly passed vars visible |
| Network isolation | Optional via omitting `(allow network*)` rule |
| Resource limits | Not enforced |
| Write protection | `read_only: true` omits file-write rules for workspace |

### Known Limitations

- **No mount namespaces**: Commands see real filesystem paths (no `/workspace` remapping)
- **Git worktrees**: If the repository is a git worktree, the `.git` file points outside the repo directory. Git commands may fail because the parent `.git` directory is not in the allowed paths. Standalone git repos work fine.
- **Deprecated API**: Apple has deprecated `sandbox-exec` but it remains functional on current macOS versions. There is no replacement API for command-line use.

---

## Choosing an Engine

### Use Docker When

- You need custom runtimes, specific OS packages, or language versions
- Full container isolation is required
- Cross-platform consistency matters
- You need cache volumes for persistent caches (e.g., `node_modules`)

### Use Bubblewrap When

- Running on Linux and need fast, lightweight isolation
- CI runners don't have Docker available
- You're running many short-lived commands (the ~5-50ms overhead adds up much less than Docker's ~500ms)
- You need namespace-level isolation (PID, mount, network) without containers

### Use Seatbelt When

- Running on macOS (local development, macOS CI runners)
- You want filesystem and network restrictions without Docker
- You want near-zero setup (sandbox-exec is built into macOS)

### Mixing Engines

You can define multiple sandboxes with different engines and assign them per-step:

```yaml
sandboxes:
  fast:
    engine: bubblewrap  # Quick commands
    network: false

  full:
    image: node:20-alpine  # Heavy builds
    cache:
      paths: [node_modules]

sandbox: fast  # Default to bubblewrap

steps:
  lint:
    type: command
    exec: eslint src/         # Uses bubblewrap (fast)

  build:
    type: command
    sandbox: full              # Uses Docker (full isolation)
    exec: npm run build

  test:
    type: command
    exec: npm test             # Uses bubblewrap (fast)
    read_only: true
```

---

## Credential Propagation

All sandbox engines work with Visor's credential propagation system. The `injectGitHubCredentials()` function from `src/github-auth.ts` passes authentication via environment variables:

- `GITHUB_TOKEN` / `GH_TOKEN` for `gh` CLI
- `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_*` / `GIT_CONFIG_VALUE_*` for authenticated `git` HTTPS access

No temp files are written and no global git config is modified, so credentials work inside any sandbox engine without special handling.

---

## Environment Variable Filtering

Before commands execute in any sandbox engine, environment variables pass through `filterEnvForSandbox()` from `src/sandbox/env-filter.ts`. This applies glob-based patterns from `env_passthrough` config and a built-in passthrough list (`PATH`, `HOME`, `USER`, `CI`, `NODE_ENV`, `LANG`).

Only filtered variables are passed into the sandbox:
- **Bubblewrap**: Via `--setenv KEY VALUE` args
- **Seatbelt**: Via `env -i KEY=VALUE` args
- **Docker**: Via `-e KEY=VALUE` args to `docker exec`

---

## Telemetry

All sandbox engines emit telemetry events:

| Event | Attributes |
|-------|-----------|
| `visor.sandbox.bwrap.exec` | `visor.sandbox.name`, `visor.sandbox.exit_code` |
| `visor.sandbox.seatbelt.exec` | `visor.sandbox.name`, `visor.sandbox.exit_code` |
| `visor.sandbox.docker.exec` | `visor.sandbox.name`, `visor.sandbox.exit_code` |

These integrate with Visor's OpenTelemetry tracing via `src/sandbox/sandbox-telemetry.ts`.

---

## Related Documentation

- [Configuration](./configuration.md) - General configuration and `sandboxes:` block
- [Security](./security.md) - Security overview and best practices
- [Command Provider](./command-provider.md) - Command execution in sandboxes
- [GitHub Authentication](./github-auth.md) - Credential propagation into sandboxes
- [Architecture](./architecture.md) - System architecture overview
