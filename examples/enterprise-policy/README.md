# OPA Policy Engine (Enterprise Edition)

> **This is an Enterprise Edition feature.** A valid Visor EE license is required.
> To get a license or learn more, contact **hello@probelabs.com**.

The OPA (Open Policy Agent) policy engine gives you fine-grained, role-based access control over Visor checks, MCP tools, and AI capabilities. Policies are written in [Rego](https://www.openpolicyagent.org/docs/latest/policy-language/) and evaluated locally via WASM or against a remote OPA server.

For the full documentation, see [docs/enterprise-policy.md](../../docs/enterprise-policy.md).

## What it controls

| Scope | What it does |
|-------|-------------|
| **Check execution** | Gate which checks can run based on the actor's role |
| **MCP tool access** | Allow or block specific MCP methods per role |
| **AI capabilities** | Restrict `allowBash`, `allowEdit`, and tool lists per role |

## Prerequisites

| Dependency | Purpose |
|-----------|---------|
| `@probelabs/visor@ee` | Visor Enterprise Edition build |
| Valid EE license (JWT) | Activates the policy engine |
| `opa` CLI | Compiles `.rego` files to WASM at startup (local mode) |
| `@open-policy-agent/opa-wasm` | Evaluates WASM policies in-process (installed automatically with EE build) |

### Installing the OPA CLI

The OPA CLI is needed to compile `.rego` files into WebAssembly at startup.

**macOS:**
```bash
brew install opa
```

**Linux:**
```bash
curl -L -o /usr/local/bin/opa \
  https://openpolicyagent.org/downloads/latest/opa_linux_amd64_static
chmod +x /usr/local/bin/opa
```

**Verify:**
```bash
opa version
```

> You can skip the OPA CLI if you pre-compile your `.rego` files into a `.wasm` bundle (see [Pre-compiling](#pre-compiling-wasm-bundles) below).

## Quick start

### 1. Install the EE build

```bash
npm install @probelabs/visor@ee
```

### 2. Set your license

```bash
# Option A: environment variable
export VISOR_LICENSE="<your-jwt-token>"

# Option B: file in project root
echo "<your-jwt-token>" > .visor-license
```

### 3. Add the `policy:` block to your `.visor.yaml`

```yaml
version: "1.0"

policy:
  engine: local              # 'local' (WASM) or 'remote' (HTTP OPA server)
  rules: ./policies/         # Path to .rego files (local mode)
  fallback: deny             # 'allow' or 'deny' when evaluation fails
  timeout: 5000              # Evaluation timeout in ms

  roles:
    admin:
      author_association: [OWNER]
      users: [cto-username]
    developer:
      author_association: [MEMBER, COLLABORATOR]
    external:
      author_association: [FIRST_TIME_CONTRIBUTOR, FIRST_TIMER, NONE]
```

### 4. Write Rego policies

See the `policies/` directory in this example for ready-to-use policies:

- **`check_execute.rego`** -- Controls which checks each role can run
- **`tool_invoke.rego`** -- Blocks destructive MCP methods for non-admins
- **`capability_resolve.rego`** -- Restricts AI capabilities (bash, file editing) by role

### 5. Run

```bash
visor --config .visor.yaml
```

Checks that the actor's role is not authorized for will be skipped with reason `policy_denied`.

## Files in this example

```
enterprise-policy/
  visor.yaml                          # Example .visor.yaml with policy configuration
  policies/
    check_execute.rego                # Check execution gating
    tool_invoke.rego                  # MCP tool access control
    capability_resolve.rego           # AI capability restrictions
```

## Configuration reference

### Top-level `policy:` block

| Field | Type | Description |
|-------|------|-------------|
| `engine` | `local` \| `remote` \| `disabled` | Evaluation backend |
| `rules` | `string` \| `string[]` | Path to `.rego` files or `.wasm` bundle (local mode) |
| `url` | `string` | OPA server URL (remote mode) |
| `fallback` | `allow` \| `deny` | Default decision on evaluation failure |
| `timeout` | `number` | Evaluation timeout in ms (default: 5000) |
| `roles` | `map` | Role definitions (see below) |

### Role definitions

Roles map GitHub author associations, team slugs, or explicit usernames to named roles that your Rego policies reference.

```yaml
roles:
  admin:
    author_association: [OWNER]
    users: [alice, bob]
  developer:
    author_association: [MEMBER, COLLABORATOR]
  external:
    author_association: [FIRST_TIME_CONTRIBUTOR, NONE]
```

### Per-step `policy:` override

Individual steps can declare role requirements directly in YAML, without writing Rego:

```yaml
steps:
  deploy-production:
    type: command
    exec: ./deploy.sh production
    policy:
      require: admin           # Only admin role can trigger this
      deny: [external]         # Explicitly deny external contributors
      rule: visor/deploy/prod  # Optional: custom OPA rule path
```

## Rego policy structure

Policies live under `package visor.<scope>` and must export an `allowed` boolean:

```rego
package visor.check.execute

default allowed = false

allowed {
  input.actor.roles[_] == "admin"
}

reason = "access denied" { not allowed }
```

### Available scopes

| Package | Evaluated when |
|---------|---------------|
| `visor.check.execute` | Before each check runs |
| `visor.tool.invoke` | Before each MCP tool call |
| `visor.capability.resolve` | When assembling AI config |

### Input document

Your Rego policies receive an `input` document with these fields:

```json
{
  "scope": "check.execute",
  "check": {
    "id": "deploy-production",
    "type": "command",
    "tags": ["deploy"],
    "criticality": "external",
    "policy": { "require": "admin" }
  },
  "actor": {
    "login": "alice",
    "authorAssociation": "MEMBER",
    "roles": ["developer"],
    "isLocalMode": false
  },
  "repository": {
    "owner": "probelabs",
    "name": "visor",
    "branch": "feat/new-feature"
  }
}
```

## Writing Rego for Visor

### Checking roles

Use `input.actor.roles[_]` to check if the actor has a specific role:

```rego
allowed {
  input.actor.roles[_] == "admin"
}
```

### Handling per-step YAML requirements

When a step declares `policy.require`, your Rego must handle both string and array values:

```rego
# String require (e.g., require: admin)
allowed {
  required := input.check.policy.require
  is_string(required)
  input.actor.roles[_] == required
}

# Array require (e.g., require: [developer, admin])
allowed {
  required := input.check.policy.require
  is_array(required)
  required[_] == input.actor.roles[_]
}
```

### Local mode bypass

When running locally (CLI), you may want to allow all checks:

```rego
allowed {
  input.actor.isLocalMode == true
}
```

### WASM-safe patterns

OPA compiles Rego to WebAssembly for fast in-process evaluation. Some patterns are not WASM-safe:

```rego
# BAD: not safe for WASM compilation
allowed = false {
  not input.actor.roles[_] == "admin"
}

# GOOD: use a helper rule
is_admin { input.actor.roles[_] == "admin" }
allowed = false {
  not is_admin
}
```

### Testing your policies

Use the OPA CLI to test policies before deploying:

```bash
# Evaluate with test input
echo '{"actor":{"roles":["developer"],"isLocalMode":false},"check":{"id":"deploy-staging"}}' | \
  opa eval -d policies/ -i /dev/stdin 'data.visor.check.execute.allowed'

# Check for syntax errors
opa check policies/

# Run OPA unit tests (if you have _test.rego files)
opa test policies/ -v
```

## Pre-compiling WASM bundles

For faster startup (skip compilation at runtime), pre-compile your policies:

```bash
# Compile all .rego files into a WASM bundle
opa build -t wasm -e visor -d policies/ -o bundle.tar.gz

# Extract the WASM file
tar -xzf bundle.tar.gz /policy.wasm

# Reference the .wasm file in config
# policy:
#   rules: ./policy.wasm
```

> When compiling with `opa build`, always use `-e visor` as the entrypoint.

## Remote OPA server

To evaluate against a running OPA server instead of local WASM:

```yaml
policy:
  engine: remote
  url: http://opa:8181
  fallback: deny
  timeout: 3000
```

Visor sends POST requests to `${url}/v1/data/visor/<scope>` with `{ "input": ... }`.

### Running an OPA server

```bash
# Local server with your policies
opa run --server --addr :8181 ./policies/

# Docker
docker run -p 8181:8181 \
  -v $(pwd)/policies:/policies \
  openpolicyagent/opa:latest \
  run --server --addr :8181 /policies/
```

## Without a license

If no valid license is found, the policy engine is silently disabled and all checks run as normal (the OSS default). No error is raised.

## Further reading

- [Full enterprise policy documentation](../../docs/enterprise-policy.md) -- comprehensive guide with troubleshooting
- [Author permissions (OSS)](../../docs/author-permissions.md) -- simpler, inline permission checks
- [OPA documentation](https://www.openpolicyagent.org/docs/latest/) -- official OPA docs
- [Rego playground](https://play.openpolicyagent.org/) -- interactive Rego editor and tester

---

**Questions? Need a license?** Contact **hello@probelabs.com**
