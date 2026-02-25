# RFC: Bubblewrap Isolation for Visor Workflow Runs

## Status

**Re-reviewed:** February 2025 — Updated after significant codebase changes on `main`.

### What Changed Since Original RFC

Visor has evolved substantially since this RFC was first drafted. The key developments that impact this proposal:

1. **Docker Sandbox System Shipped** (`src/sandbox/`): A full Docker-based sandbox implementation now exists with `SandboxManager`, `DockerImageSandbox`, `DockerComposeSandbox`, `CheckRunner`, `EnvFilter`, `CacheVolumeManager`, and telemetry. Checks can be routed to Docker containers via `sandbox-routing.ts`.

2. **GitHub Authentication & Credential Propagation** (`src/github-auth.ts`): End-to-end auth with PAT and GitHub App support. `injectGitHubCredentials()` sets `GITHUB_TOKEN`/`GH_TOKEN` and configures git HTTPS auth via `GIT_CONFIG_COUNT/KEY/VALUE` — no temp files or global config mutation.

3. **State Machine Execution Engine**: The check execution engine migrated to a state-machine architecture (`StateMachineExecutionEngine`). The old `check-execution-engine.ts` is a compatibility layer.

4. **Per-step `on_init` Hooks**: Rich `on_init` configuration with tool invocations, step invocations, and workflow invocations — runs before a specific step. This is per-step, not workflow-level.

5. **Sandbox Config in VisorConfig**: Top-level `sandbox` (default name), `sandboxes` (named definitions), `sandbox_defaults` (env passthrough), and per-check `sandbox` override are now first-class config fields.

6. **OPA Policy Engine** (`src/policy/`): Role-based access control for enterprise use.

7. **`EventTrigger` unchanged**: Still `pr_opened | pr_updated | pr_closed | issue_opened | issue_comment | manual | schedule | webhook_received`. No `visor:init` event has been added.

---

## Summary

This RFC explores using [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) as a **lightweight, Linux-native sandbox engine** complementary to the existing Docker sandbox. Bubblewrap provides unprivileged process isolation using Linux namespaces, offering sub-50ms overhead per command versus Docker's ~500ms+ container startup.

## Background

### Existing Isolation Layers

Visor now has multiple isolation mechanisms:

1. **Docker Sandbox** (`src/sandbox/`): Full container isolation via Docker images or Compose. Feature-rich (caching, telemetry, env filtering) but heavyweight. Requires Docker daemon.

2. **WorkspaceManager** (`src/utils/workspace-manager.ts`): Session-based filesystem isolation:
   - Each run gets `/tmp/visor-workspaces/{session-id}/`
   - Git worktrees for main project, symlinks for external projects
   - Reference counting for cleanup coordination
   - Human-readable names: `/workspace/my-project/`

3. **JavaScript Sandbox** (`src/utils/sandbox.ts`): `@nyariv/sandboxjs` for `transform_js` and `script` providers

4. **Environment Variable Filtering** (`src/sandbox/env-filter.ts`): Glob-based patterns for restricting env var propagation into sandboxes

5. **GitHub Credential Injection** (`src/github-auth.ts`): Secure credential propagation without touching global config files

### What is Bubblewrap?

Bubblewrap is a low-level unprivileged sandboxing tool that:
- Creates isolated filesystem, network, PID, IPC, and user namespaces
- Runs without root privileges (uses `PR_SET_NO_NEW_PRIVS`)
- Auto-cleans temporary mounts when processes exit
- Is used by Flatpak, rpm-ostree, and other security-conscious tools

### Why Bubblewrap When Docker Sandbox Exists?

| Dimension | Docker Sandbox | Bubblewrap |
|-----------|---------------|------------|
| **Startup overhead** | ~500ms+ per container | ~5-50ms per command |
| **Dependencies** | Docker daemon required | Single `bwrap` binary |
| **CI/CD fit** | Needs Docker-in-Docker or privileged mode | Works in unprivileged CI runners |
| **Resource overhead** | Container runtime + image layers | Kernel namespaces only |
| **Isolation strength** | Full container (strong) | Namespace-level (moderate) |
| **Platform** | Linux, macOS, Windows (via Docker Desktop) | Linux only |
| **Use case** | Heavy isolation, custom runtimes | Fast command sandboxing |

**The two are complementary, not competing:**
- **Docker** for checks needing custom runtimes, specific OS packages, or full container semantics
- **Bubblewrap** for fast, lightweight isolation of `command` checks that just need filesystem/network/process containment

## Problem Statement

Even with the Docker sandbox, there's a gap for lightweight isolation:

1. **Docker is heavyweight for simple commands** — Running `eslint src/` or `npm test` in a Docker container adds significant startup latency
2. **Docker requires Docker** — CI runners without Docker can't use sandboxing at all
3. **No isolation without Docker** — When `sandbox` is not configured, `command` checks run with full host access
4. **MCP stdio servers** — Long-running MCP servers can't easily restart in fresh containers per-invocation

Bubblewrap fills the gap: fast, daemon-free process isolation for command execution on Linux.

## Proposed Solution: Bubblewrap as a Sandbox Engine

### Architecture: Pluggable Engine in Existing Sandbox System

The key insight is that Visor's sandbox system already has the right abstractions. Bubblewrap fits as a new engine type alongside Docker:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     State Machine Execution Engine                       │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │              sandbox-routing.ts (existing)                          │ │
│  │  resolveSandbox() → check-level or workspace-level default          │ │
│  └─────────────────┬──────────────────────────┬───────────────────────┘ │
│                    │                          │                          │
│  ┌─────────────────▼──────────┐  ┌───────────▼───────────────────────┐ │
│  │  Docker Sandbox (existing)  │  │  Bubblewrap Sandbox (NEW)         │ │
│  │  - DockerImageSandbox       │  │  - BubblewrapSandbox              │ │
│  │  - DockerComposeSandbox     │  │  - Uses bwrap binary              │ │
│  │  - CacheVolumeManager       │  │  - Integrates w/ WorkspaceManager │ │
│  └─────────────────────────────┘  └───────────────────────────────────┘ │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐   │
│  │              WorkspaceManager (existing)                           │   │
│  │  /tmp/visor-workspaces/{session-id}/                               │   │
│  │    ├── main-project/  (git worktree)                               │   │
│  │    ├── external-repo/ (symlink)                                    │   │
│  │    └── another-repo/  (symlink)                                    │   │
│  └───────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
```

### How It Fits the Existing Config Model

Bubblewrap uses the **same config fields** as Docker sandbox — no new top-level concepts:

```yaml
# .visor.yaml
sandboxes:
  # Docker sandbox (existing)
  ci-runner:
    image: node:20-alpine
    cache:
      paths: [node_modules]

  # Bubblewrap sandbox (NEW)
  bwrap:
    engine: bubblewrap          # NEW field on SandboxConfig
    network: true               # Reuse existing field
    read_only: false            # Reuse existing field

# Default all checks to bubblewrap
sandbox: bwrap

checks:
  lint:
    type: command
    exec: eslint src/

  heavy-build:
    type: command
    sandbox: ci-runner          # Override: use Docker for this one
    exec: npm run build
```

**Key:** The `engine` field on `SandboxConfig` determines which backend handles execution. When absent, defaults to `docker` (current behavior). When set to `bubblewrap`, uses bwrap.

### Bubblewrap Command Construction

```bash
# $WORKSPACE_PATH = WorkspaceManager.getWorkspacePath()
# e.g., /tmp/visor-workspaces/abc123/

bwrap \
  --ro-bind /usr /usr \
  --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 \
  --ro-bind /bin /bin \
  --ro-bind /etc/resolv.conf /etc/resolv.conf \
  --ro-bind /etc/ssl /etc/ssl \
  --dev /dev \
  --proc /proc \
  --tmpfs /tmp \
  --bind $WORKSPACE_PATH /workspace \
  --chdir /workspace/main-project \
  --unshare-pid \
  --new-session \
  --die-with-parent \
  --clearenv \
  --setenv PATH /usr/bin:/bin \
  --setenv HOME /tmp \
  --setenv VISOR_WORKSPACE /workspace \
  -- $COMMAND
```

With `--unshare-net` added when `network: false`.

**Inside the sandbox**, the command sees:
```
/workspace/
├── main-project/     # Current repo (writable)
├── external-repo/    # Added via git-checkout (writable)
└── another-repo/     # Added via git-checkout (writable)
```

No access to `~/.ssh`, `~/.config`, `~/.aws`, or any host paths outside the workspace.

### Implementation: BubblewrapSandbox Class

The new class implements the existing `SandboxInstance` interface:

```typescript
// src/sandbox/bubblewrap-sandbox.ts

import { SandboxInstance, SandboxConfig, SandboxExecOptions, SandboxExecResult } from './types';
import { execFile } from 'child_process';

export class BubblewrapSandbox implements SandboxInstance {
  readonly name: string;
  readonly config: SandboxConfig;
  private workspacePath: string;

  constructor(name: string, config: SandboxConfig, workspacePath: string) {
    this.name = name;
    this.config = config;
    this.workspacePath = workspacePath;
  }

  async exec(options: SandboxExecOptions): Promise<SandboxExecResult> {
    const args = this.buildArgs(options);
    args.push('--', '/bin/sh', '-c', options.command);

    return new Promise((resolve, reject) => {
      execFile('bwrap', args, {
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
      }, (error, stdout, stderr) => {
        resolve({
          stdout: stdout || '',
          stderr: stderr || '',
          exitCode: error?.code ?? 0,
        });
      });
    });
  }

  async stop(): Promise<void> {
    // bwrap processes are ephemeral — nothing to stop
  }

  private buildArgs(options: SandboxExecOptions): string[] {
    const args = [
      '--ro-bind', '/usr', '/usr',
      '--ro-bind', '/bin', '/bin',
      '--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf',
      '--ro-bind', '/etc/ssl', '/etc/ssl',
      '--dev', '/dev',
      '--proc', '/proc',
      '--tmpfs', '/tmp',
      '--tmpfs', '/root',
    ];

    // /lib and /lib64 may not exist on all distros
    if (existsSync('/lib')) args.push('--ro-bind', '/lib', '/lib');
    if (existsSync('/lib64')) args.push('--ro-bind', '/lib64', '/lib64');

    // Workspace mount
    const readOnly = this.config.read_only;
    args.push(readOnly ? '--ro-bind' : '--bind', this.workspacePath, '/workspace');
    args.push('--chdir', options.cwd?.replace(this.workspacePath, '/workspace') || '/workspace');

    // Namespace isolation
    args.push('--unshare-pid', '--new-session', '--die-with-parent', '--clearenv');

    // Network isolation
    if (this.config.network === false) {
      args.push('--unshare-net');
    }

    // Environment variables (filtered by env-filter.ts)
    for (const [k, v] of Object.entries(options.env)) {
      args.push('--setenv', k, v);
    }

    return args;
  }
}
```

### Integration with SandboxManager

The change to `SandboxManager` is minimal — when `engine: 'bubblewrap'` is set on a `SandboxConfig`, it creates a `BubblewrapSandbox` instead of `DockerImageSandbox`:

```typescript
// In sandbox-manager.ts, getOrStart() method
async getOrStart(name: string): Promise<SandboxInstance> {
  const existing = this.instances.get(name);
  if (existing) return existing;

  const config = this.sandboxDefs[name];
  if (!config) throw new Error(`Sandbox '${name}' is not defined`);

  let instance: SandboxInstance;

  if (config.engine === 'bubblewrap') {
    instance = new BubblewrapSandbox(name, config, this.repoPath);
  } else if (config.compose) {
    instance = /* existing DockerComposeSandbox logic */;
  } else {
    instance = /* existing DockerImageSandbox logic */;
  }

  this.instances.set(name, instance);
  return instance;
}
```

### Integration with GitHub Auth

The existing `injectGitHubCredentials()` from `src/github-auth.ts` already works without touching global config files — it uses `GIT_CONFIG_COUNT/KEY/VALUE` environment variables. This means:

1. Credentials are passed as env vars into the bwrap sandbox via `--setenv`
2. No need for `~/.gitconfig` access inside the sandbox
3. `gh` CLI auth works via `GH_TOKEN` env var
4. No conflict with host credentials (they're never mounted)

This makes the original RFC's `visor:init` credential setup workflows **less critical** — the existing auth system already handles the main use case cleanly.

## Revised Design Decisions

### What to Keep from Original RFC

1. **Bubblewrap as lightweight sandbox engine** — Still the right tool for fast command isolation
2. **Integration with WorkspaceManager** — Natural mount point at `/workspace`
3. **Network isolation toggle** — `network: false` for offline checks
4. **Graceful fallback** — Log warning on non-Linux platforms

### What Changed from Original RFC

| Original RFC Proposal | Revised Approach |
|----------------------|------------------|
| New `SandboxEngine` interface | Use existing `SandboxInstance` interface from `src/sandbox/types.ts` |
| New `SandboxEngineRegistry` | Extend existing `SandboxManager` with engine detection |
| New `--sandbox=bubblewrap` CLI flag | Use existing `sandboxes:` config + `sandbox:` default |
| New `visor:init` event trigger | **Deprioritized** — GitHub auth now works via env vars; `on_init` per-step hooks cover other cases |
| Bundled `visor://sandbox-setup` workflows | **Deprioritized** — `injectGitHubCredentials()` handles the primary use case |
| Separate `src/sandbox/engines/` directory | Single `src/sandbox/bubblewrap-sandbox.ts` file alongside existing Docker files |

### What to Drop

1. **`visor:init` event trigger** — The motivating use case (credential setup in sandbox) is now solved by `injectGitHubCredentials()` which passes auth via env vars. The per-step `on_init` hooks cover remaining init-before-step scenarios. If a workflow-level init event is needed in the future, it can be added independently of bubblewrap.

2. **Bundled setup workflows** (`visor://sandbox-setup`, `visor://github-setup`, etc.) — These were designed to configure credentials inside the sandbox. With `GIT_CONFIG_COUNT` env vars and `GH_TOKEN` propagation already working, explicit setup workflows aren't needed for the common case.

3. **Pluggable `SandboxEngine` abstraction** — The existing `SandboxInstance` interface is sufficient. Adding another abstraction layer would be over-engineering.

## Security Considerations

### What Bubblewrap Protects Against

1. **Filesystem Escape**: Commands cannot access files outside allowed paths
2. **Process Visibility**: PID namespace hides other processes
3. **Environment Leakage**: `--clearenv` prevents credential theft
4. **Terminal Injection**: `--new-session` prevents TIOCSTI attacks
5. **Orphan Processes**: `--die-with-parent` ensures cleanup

### What Bubblewrap Does NOT Protect Against

1. **CPU/Memory Abuse**: No resource limits (use cgroups separately)
2. **Network-Based Attacks**: When `network: true`
3. **Kernel Exploits**: Namespace escapes via kernel bugs
4. **Custom Runtimes**: Can't install arbitrary packages (use Docker for that)

### Credential Isolation

With bubblewrap, credentials are isolated by default:

| Resource | Without Sandbox | With Bubblewrap |
|----------|----------------|-----------------|
| `~/.ssh/` | Accessible | Not mounted |
| `~/.config/gh/` | Accessible | Not mounted |
| `~/.npmrc` | Accessible | Fresh in sandbox |
| `~/.gitconfig` | Accessible | Not mounted (git config via env vars) |
| `~/.aws/` | Accessible | Not mounted |
| `$GH_TOKEN` | May leak from host | Only if explicitly passed via `env:` |

## Platform Support

| Platform | Support Level |
|----------|---------------|
| Linux | Full support |
| macOS | Not supported (no user namespaces) — falls back to `none` |
| Windows | Not supported — falls back to `none` |
| Docker/Containers | May need `--cap-add SYS_ADMIN` or `--privileged` |

## Performance Impact

Bubblewrap has minimal overhead:
- Namespace creation: ~1-5ms
- Mount operations: ~1-10ms per mount
- No runtime overhead once process is running

Total expected impact: **< 50ms per command execution** (vs ~500ms+ for Docker)

## Implementation Plan

### Milestone 1: BubblewrapSandbox Implementation

**Goal:** Working bubblewrap sandbox that integrates with existing sandbox routing.

**Deliverables:**

1. **`src/sandbox/bubblewrap-sandbox.ts`** — Implements `SandboxInstance` interface
   - Build bwrap command from `SandboxConfig`
   - Mount workspace from `WorkspaceManager` path
   - Handle `--clearenv` + explicit env passing
   - Network isolation via `--unshare-net`
   - Uses `execFile` (not `exec`) to prevent command injection

2. **Add `engine` field to `SandboxConfig`** (`src/sandbox/types.ts`)
   ```typescript
   engine?: 'docker' | 'bubblewrap';  // Default: 'docker'
   ```

3. **Update `SandboxManager`** to create `BubblewrapSandbox` when `engine: 'bubblewrap'`

4. **Availability check** — Detect if `bwrap` binary exists, error clearly if not

**Files to create:**
- `src/sandbox/bubblewrap-sandbox.ts`

**Files to modify:**
- `src/sandbox/types.ts` — Add `engine` field
- `src/sandbox/sandbox-manager.ts` — Route to `BubblewrapSandbox`

**Test cases:**
```
tests/unit/sandbox-bubblewrap.test.ts
  - bwrap command construction (mount args, env, network)
  - read_only workspace mount
  - network isolation flag
  - env var passing via --setenv
  - cwd path translation (host → /workspace)

tests/integration/sandbox-bubblewrap.test.ts  (Linux CI only)
  - Filesystem isolation (can't read /etc/passwd, can read /workspace)
  - Environment isolation (host env vars not visible)
  - Network isolation when network: false
  - Process isolation (can't see host PIDs)
  - Exit code propagation
```

**Acceptance criteria:**
- [ ] `sandboxes: { bwrap: { engine: bubblewrap } }` + `sandbox: bwrap` routes checks through bwrap
- [ ] Commands can read/write `/workspace/` but not host filesystem
- [ ] Host `~/.ssh`, `~/.aws`, `~/.config` are NOT accessible
- [ ] `GIT_CONFIG_COUNT/KEY/VALUE` env vars work inside sandbox (git operations succeed)
- [ ] `GH_TOKEN` env var works inside sandbox (gh CLI works)
- [ ] On non-Linux, `engine: bubblewrap` fails with clear error message
- [ ] `execFile` used (not `exec`) for security

---

### Milestone 2: Documentation & Hardening

**Goal:** Production-ready with docs and edge case handling.

**Deliverables:**

1. **Error handling**
   - Clear error when bwrap not installed
   - Helpful message for Docker-in-Docker conflicts (needs `--cap-add SYS_ADMIN`)
   - Timeout handling for sandboxed commands

2. **Config validation**
   - `engine: bubblewrap` rejects Docker-only fields (`image`, `dockerfile`, `compose`)
   - Validate that bwrap is available before first use

3. **Documentation section in README or docs/**
   - When to use bubblewrap vs Docker
   - Configuration examples
   - CI/CD setup instructions

4. **Additional tests**
   - Edge cases (empty workspace, special characters in commands)
   - macOS/Windows: clear error, not silent failure
   - Docker-in-Docker detection

**Acceptance criteria:**
- [ ] Helpful error messages for all failure modes
- [ ] Config validation prevents nonsensical combos (e.g., `engine: bubblewrap` + `image: node:20`)
- [ ] Performance overhead < 100ms per command on Linux

---

### Architecture Summary

```
src/sandbox/
├── types.ts                    # +engine field on SandboxConfig
├── sandbox-manager.ts          # Route to BubblewrapSandbox when engine=bubblewrap
├── bubblewrap-sandbox.ts       # NEW: implements SandboxInstance
├── docker-image-sandbox.ts     # Existing
├── docker-compose-sandbox.ts   # Existing
├── check-runner.ts             # Existing (works with any SandboxInstance)
├── env-filter.ts               # Existing (used by both engines)
├── cache-volume-manager.ts     # Existing (Docker only)
├── sandbox-telemetry.ts        # Existing (works with both)
├── trace-ingester.ts           # Existing
└── index.ts                    # Existing
```

**Design principles:**

1. **Reuse existing abstractions** — `SandboxInstance`, `SandboxConfig`, `SandboxManager`, `EnvFilter`
2. **Minimal new code** — One new file (`bubblewrap-sandbox.ts`), two modified files
3. **Same config model** — `sandboxes:` + `sandbox:` fields, no new CLI flags
4. **Fail clearly** — Non-Linux or missing bwrap = explicit error, never silent
5. **Security first** — `execFile` (not `exec`), `--clearenv`, `--die-with-parent`

## Open Questions

1. **Should bubblewrap be available as a fallback when Docker is unavailable?**
   - Auto-detect: if Docker not found but bwrap exists, use bwrap
   - Or keep it explicit: user must choose engine

2. **How to handle MCP stdio servers that need persistent state?**
   - Mount specific state directory read-write via additional bwrap args?
   - Or: MCP servers always run on host (not in sandbox)?

3. **Docker-in-Docker detection**
   - Bubblewrap inside Docker needs `--cap-add SYS_ADMIN` or `--privileged`
   - Should we detect this and warn proactively?

4. **Cache volume equivalent for bubblewrap?**
   - Docker sandbox has `CacheVolumeManager` for persistent caches
   - Bubblewrap could bind-mount a persistent cache dir if needed
   - Or: defer this to a future enhancement

## Alternatives Considered

| Alternative | Pros | Cons |
|------------|------|------|
| Docker only (status quo) | Already implemented, mature | Heavyweight, needs Docker daemon |
| Bubblewrap only | Lightweight, fast | Linux-only, no custom runtimes |
| Bubblewrap + Docker (proposed) | Best of both worlds | More code to maintain |
| gVisor | Good compatibility | Performance overhead, complex setup |
| No additional isolation | Simple | Security gap for lightweight checks |

## Conclusion

With the Docker sandbox already shipped, bubblewrap becomes a **focused, complementary addition** rather than a foundational architecture change. The implementation is significantly simpler than the original RFC proposed:

- **1 new file** (`bubblewrap-sandbox.ts`) implementing the existing `SandboxInstance` interface
- **2 modified files** (add `engine` field to types, route in manager)
- **No new abstractions** — reuses `SandboxConfig`, `SandboxManager`, `EnvFilter`, `sandbox-routing.ts`
- **No new CLI flags** — uses existing `sandboxes:` config
- **No `visor:init` event needed** — credential propagation via env vars already works

The original RFC's `visor:init` event and bundled setup workflows were solving a credential setup problem that `injectGitHubCredentials()` now handles more elegantly. These features could still be valuable independently but are no longer prerequisites for bubblewrap integration.

**Estimated effort:** 2-3 days for Milestone 1, 1-2 days for Milestone 2.

## References

- [Bubblewrap GitHub](https://github.com/containers/bubblewrap)
- [Visor Docker Sandbox PR #337](https://github.com/probelabs/visor/pull/337)
- [Visor GitHub Auth PR #396](https://github.com/probelabs/visor/pull/396)
- [Flatpak Security Model](https://flatpak.org/security/)
