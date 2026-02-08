# Enterprise Policy Engine (OPA)

> **Enterprise Edition feature.** A valid Visor EE license is required.
> Contact **hello@probelabs.com** for licensing.

The OPA (Open Policy Agent) policy engine provides fine-grained, role-based access control over Visor workflows. Policies are written in [Rego](https://www.openpolicyagent.org/docs/latest/policy-language/) and evaluated locally via WebAssembly (WASM) or against a remote OPA server.

---

## Table of Contents

- [Overview](#overview)
- [What It Controls](#what-it-controls)
- [Installation](#installation)
- [Dependencies](#dependencies)
- [License Setup](#license-setup)
- [Configuration Reference](#configuration-reference)
- [Writing Rego Policies](#writing-rego-policies)
- [Policy Scopes](#policy-scopes)
- [Input Document Reference](#input-document-reference)
- [Per-Step Policy Overrides](#per-step-policy-overrides)
  - [Custom Rule Paths with `policy.rule`](#custom-rule-paths-with-policyrule)
- [Local WASM Mode](#local-wasm-mode)
- [Remote OPA Server Mode](#remote-opa-server-mode)
- [Fallback Behavior](#fallback-behavior)
- [How It Works](#how-it-works)
- [Relationship to Author Permissions](#relationship-to-author-permissions)
- [Troubleshooting](#troubleshooting)
- [Examples](#examples)

---

## Overview

The policy engine sits between your `.visor.yaml` configuration and check execution. Before a check runs, a tool is invoked, or AI capabilities are assembled, the engine evaluates an OPA policy to decide whether the action is allowed.

Key properties:

- **Deny by default**: Policies can be configured with `fallback: deny` so that any evaluation failure or unrecognized role is blocked.
- **Role-based**: Roles are resolved from GitHub `author_association`, team slugs, or explicit usernames, then passed into OPA as `input.actor.roles`.
- **Per-step overrides**: Individual steps can declare `policy.require` and `policy.deny` in YAML without writing any Rego.
- **Two evaluation backends**: Local WASM (zero network, ~1ms per evaluation) or remote OPA server (shared policy management).
- **Graceful degradation**: Without a valid license, the engine silently disables and all checks run normally.

---

## What It Controls

| Scope | When Evaluated | What It Does |
|-------|----------------|--------------|
| **Check execution** (`check.execute`) | Before each check runs | Gate which checks can run based on the actor's role |
| **MCP tool access** (`tool.invoke`) | Before each MCP tool call | Allow or block specific MCP methods per role |
| **AI capabilities** (`capability.resolve`) | When assembling AI provider config | Restrict `allowBash`, `allowEdit`, and tool lists per role |

---

## Installation

### 1. Install the EE build

```bash
npm install @probelabs/visor@ee
```

Or as a global tool:

```bash
npm install -g @probelabs/visor@ee
```

The EE build is a superset of the OSS build. All OSS functionality works identically. The enterprise code is inert without a license.

### 2. Install OPA CLI (optional, for local compilation)

The OPA CLI is needed only if you use `.rego` files with the `local` engine mode. Visor compiles `.rego` to `.wasm` at startup using the `opa` CLI.

**macOS (Homebrew):**
```bash
brew install opa
```

**Linux (binary):**
```bash
curl -L -o /usr/local/bin/opa \
  https://openpolicyagent.org/downloads/latest/opa_linux_amd64_static
chmod +x /usr/local/bin/opa
```

**Docker:**
```bash
docker pull openpolicyagent/opa:latest
```

**Verify installation:**
```bash
opa version
# Expected: Version: 0.70.0 or later
```

> **Note**: If you pre-compile your `.rego` files into a `.wasm` bundle (see [Pre-compiling WASM bundles](#pre-compiling-wasm-bundles)), the OPA CLI is not needed at runtime.

### 3. Install the WASM runtime (automatic)

The `@open-policy-agent/opa-wasm` npm package is an optional dependency of the EE build. It is installed automatically when you install `@probelabs/visor@ee`. If for some reason it's missing:

```bash
npm install @open-policy-agent/opa-wasm
```

---

## Dependencies

| Dependency | Required? | Purpose |
|-----------|-----------|---------|
| `@probelabs/visor@ee` | Yes | Visor Enterprise Edition build |
| Valid EE license (JWT) | Yes | Activates the policy engine |
| `opa` CLI | Only for `local` mode with `.rego` files | Compiles Rego to WASM at startup |
| `@open-policy-agent/opa-wasm` | Only for `local` mode | Evaluates WASM policies in-process |
| OPA server | Only for `remote` mode | External policy evaluation via HTTP |

### Rego language

Rego is OPA's declarative policy language. Key resources:

- [Rego language reference](https://www.openpolicyagent.org/docs/latest/policy-language/)
- [Rego playground](https://play.openpolicyagent.org/) (interactive editor and tester)
- [OPA documentation](https://www.openpolicyagent.org/docs/latest/)
- [Rego style guide](https://www.openpolicyagent.org/docs/latest/policy-language/#style-guide)

---

## License Setup

The policy engine requires a valid Visor EE license (a JWT signed by ProbeLabs). Visor looks for the license in this order:

1. **`VISOR_LICENSE` environment variable** (the JWT string directly)
2. **`VISOR_LICENSE_FILE` environment variable** (path to a file containing the JWT)
3. **`.visor-license` file in the project root**
4. **`~/.config/visor/.visor-license`** (user-level default)

### Setting up in CI (GitHub Actions)

```yaml
# .github/workflows/visor.yml
- uses: probelabs/visor@v1
  env:
    VISOR_LICENSE: ${{ secrets.VISOR_LICENSE }}
    GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
```

### Setting up locally

```bash
# Option A: environment variable
export VISOR_LICENSE="eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9..."

# Option B: file in project root
echo "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9..." > .visor-license

# Option C: user-level config
mkdir -p ~/.config/visor
echo "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9..." > ~/.config/visor/.visor-license
```

> **Important**: Add `.visor-license` to your `.gitignore` to avoid committing your license key.

### License features

Your license JWT encodes which features are available. The policy engine requires the `policy` feature. If your license doesn't include this feature, the engine falls back to the default (all-allow) behavior.

### Grace period

When a license expires, Visor provides a **72-hour grace period** during which the policy engine continues to work. A warning is logged:

```
[visor:enterprise] License has expired but is within the 72-hour grace period.
Please renew your license.
```

After the grace period, the policy engine silently disables.

---

## Configuration Reference

### Top-level `policy:` block

Add a `policy:` block to your `.visor.yaml`:

```yaml
version: "1.0"

policy:
  engine: local
  rules: ./policies/
  fallback: deny
  timeout: 5000

  roles:
    admin:
      author_association: [OWNER]
      users: [cto-username]
    developer:
      author_association: [MEMBER, COLLABORATOR]
    external:
      author_association: [FIRST_TIME_CONTRIBUTOR, FIRST_TIMER, NONE]
```

### Field reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `engine` | `local` \| `remote` \| `disabled` | `disabled` | Evaluation backend |
| `rules` | `string` \| `string[]` | — | Path to `.rego` files, a directory, or a `.wasm` bundle (local mode only) |
| `data` | `string` | — | Path to a JSON file to load as the OPA data document (local mode only). Contents are available in Rego via `data.<key>`. |
| `url` | `string` | — | OPA server URL (remote mode only) |
| `fallback` | `allow` \| `deny` \| `warn` | `allow` | Default decision when policy evaluation fails or times out. `warn` enables audit mode: violations are logged but checks are not blocked. |
| `timeout` | `number` | `5000` | Evaluation timeout in milliseconds |
| `roles` | `map` | — | Role definitions (see below) |

### Role definitions

Roles map GitHub metadata to named roles that your Rego policies reference via `input.actor.roles`.

```yaml
roles:
  admin:
    author_association: [OWNER]          # GitHub author associations
    users: [alice, bob]                   # Explicit GitHub usernames
    teams: [platform-team]                # GitHub team slugs (requires API access)
  developer:
    author_association: [MEMBER, COLLABORATOR]
  external:
    author_association: [FIRST_TIME_CONTRIBUTOR, NONE]
```

| Sub-field | Type | Description |
|-----------|------|-------------|
| `author_association` | `string[]` | GitHub author association values: `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `NONE` |
| `users` | `string[]` | Explicit GitHub usernames |
| `teams` | `string[]` | GitHub team slugs (reserved for future use; see note below) |

> **Note**: The `teams` field is reserved for future use and is **not currently enforced**. Team-based role resolution (matching GitHub team slugs via the GitHub API) is not yet implemented. If you configure `teams`, a validation warning will be emitted. Only `author_association` and `users` are currently used for role resolution.

A user is assigned a role if they match **any** of the criteria (OR logic). A user can have **multiple roles**.

---

## Writing Rego Policies

### Directory structure

Create a `policies/` directory (or any name you choose) with `.rego` files:

```
your-project/
  .visor.yaml
  policies/
    check_execute.rego      # Check execution gating (default scope)
    tool_invoke.rego         # MCP tool access control
    capability_resolve.rego  # AI capability restrictions
    deploy_production.rego   # Custom rule for production deploys (optional)
```

### Basic policy structure

Every policy file:
1. Declares a `package` matching the scope (e.g., `package visor.check.execute`)
2. Exports an `allowed` boolean (for `check.execute` and `tool.invoke` scopes)
3. Optionally exports a `reason` string for denial messages
4. Optionally exports a `capabilities` object (for `capability.resolve` scope)

```rego
package visor.check.execute

# Default: deny everything
default allowed = false

# Admin can run anything
allowed {
  input.actor.roles[_] == "admin"
}

# Developers can run non-production deployments
allowed {
  input.actor.roles[_] == "developer"
  not startswith(input.check.id, "deploy-production")
}

# Provide a reason when denied
reason = "insufficient role for this check" { not allowed }
```

### Rego tips for Visor

**Iterating over roles**: Use `input.actor.roles[_]` to check if any role matches:
```rego
# Any of the actor's roles is "admin"
allowed {
  input.actor.roles[_] == "admin"
}
```

**Per-step YAML deny list**: When a step declares `policy.deny`, use a `denied` helper to block matching roles. Add `not denied` to every `allowed` rule so deny always takes precedence:
```rego
# Deny takes precedence — any actor role in the deny list blocks the check
denied {
  some i, j
  input.check.policy.deny[i] == input.actor.roles[j]
}

# All allowed rules must include `not denied`
allowed {
  not denied
  input.actor.roles[_] == "admin"
}
```

**Per-step YAML requirements**: When a step declares `policy.require`, check it in Rego:
```rego
# String require (e.g., require: admin)
allowed {
  not denied
  required := input.check.policy.require
  is_string(required)
  input.actor.roles[_] == required
}

# Array require (e.g., require: [developer, admin])
allowed {
  not denied
  required := input.check.policy.require
  is_array(required)
  required[_] == input.actor.roles[_]
}
```

**Local mode bypass**: Allow broader access when running locally, but only for checks that have no explicit `policy.require` setting. This keeps sensitive steps (e.g. production deployments) protected even during local development:
```rego
# Checks WITHOUT policy.require are allowed in local mode (convenience).
# Checks WITH policy.require still enforce roles (security).
allowed {
  input.actor.isLocalMode == true
  not input.check.policy
}
```

**WASM compilation safety**: Some Rego patterns are not supported by OPA's WASM compiler. Avoid `not set[_] == X` — use helper rules instead:

```rego
# BAD: unsafe for WASM compilation
allowed = false {
  not input.actor.roles[_] == "admin"
}

# GOOD: use a helper rule
is_admin { input.actor.roles[_] == "admin" }
allowed = false {
  not is_admin
}
```

### Testing policies locally

Use the OPA CLI to test your policies before deploying:

```bash
# Evaluate a policy with test input
echo '{"actor":{"roles":["developer"],"isLocalMode":false},"check":{"id":"deploy-staging"}}' | \
  opa eval -d policies/ -i /dev/stdin 'data.visor.check.execute.allowed'

# Run OPA unit tests (if you have _test.rego files)
opa test policies/ -v
```

### Validating policies with `visor policy-check`

Visor includes a built-in policy validation command that checks your `.rego` files for syntax errors and WASM compilation compatibility in one step. This command does **not** require a license.

```bash
# Validate a directory of .rego files
visor policy-check ./policies/

# Validate a single .rego file
visor policy-check ./policies/check_execute.rego

# Use the policy.rules path from .visor.yaml automatically
visor policy-check

# Use a specific config file
visor policy-check --config .visor.yaml

# Validate and evaluate against sample input
visor policy-check ./policies/ --input sample-input.json

# Verbose output (shows the exact opa commands being run)
visor policy-check ./policies/ --verbose
```

The command performs three checks:

1. **Syntax validation** (`opa check`): Verifies each `.rego` file has valid Rego syntax.
2. **WASM compilation** (`opa build -t wasm -e visor`): Confirms the policies can be compiled to WebAssembly, catching WASM-unsafe patterns early.
3. **Sample evaluation** (optional, `--input`): Evaluates all three policy scopes (`check.execute`, `tool.invoke`, `capability.resolve`) against a provided JSON input file.

Example sample input file for testing:

```json
{
  "actor": {
    "login": "alice",
    "authorAssociation": "MEMBER",
    "roles": ["developer"],
    "isLocalMode": false
  },
  "check": {
    "id": "security-scan",
    "type": "ai",
    "policy": {
      "require": "developer"
    }
  },
  "repository": {
    "owner": "myorg",
    "name": "myrepo",
    "branch": "feat/new-feature",
    "baseBranch": "main"
  }
}
```

Exit codes:
- `0`: All checks passed
- `1`: One or more checks failed (syntax errors, WASM compilation failure, or missing files)

### Pre-compiling WASM bundles

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

> **Important**: When compiling with `opa build`, always use `-e visor` as the entrypoint. Visor navigates the WASM result tree starting from the `visor` package root.

---

## Policy Scopes

### `check.execute` — Check execution gating

**When**: Before each check runs, after `if` condition evaluation
**Package**: `package visor.check.execute`
**Decision**: `allowed` (boolean), `reason` (string)

```rego
package visor.check.execute

default allowed = false

# Deny list from YAML policy.deny (see Per-Step Policy Overrides)
denied {
  some i, j
  input.check.policy.deny[i] == input.actor.roles[j]
}

allowed {
  not denied
  input.actor.roles[_] == "admin"
}

allowed {
  not denied
  input.actor.roles[_] == "developer"
  not startswith(input.check.id, "deploy-production")
}

reason = "role is in the deny list for this check" { denied }
reason = "insufficient role for this check" { not denied; not allowed }
```

When a check is denied, it is skipped with `skipReason: policy_denied`. The denial reason appears in the execution stats and JSON output.

### `tool.invoke` — MCP tool access control

**When**: Before each MCP tool/method call
**Package**: `package visor.tool.invoke`
**Decision**: `allowed` (boolean), `reason` (string)

```rego
package visor.tool.invoke

default allowed = true

# Block destructive methods for non-admins
allowed = false {
  endswith(input.tool.methodName, "_delete")
  not is_admin
}

is_admin { input.actor.roles[_] == "admin" }

reason = "tool access denied by policy" { not allowed }
```

This scope works as an overlay on top of the static `allowedMethods`/`blockedMethods` configuration in `McpServerConfig`. Static filtering is applied first, then OPA filtering.

### `capability.resolve` — AI capability restrictions

**When**: When assembling AI provider configuration
**Package**: `package visor.capability.resolve`
**Decision**: `capabilities` (object with `allowEdit`, `allowBash`, `allowedTools` keys)

```rego
package visor.capability.resolve

# Disable file editing for non-developers
capabilities["allowEdit"] = false {
  not input.actor.roles[_] == "developer"
  not input.actor.roles[_] == "admin"
}

# Disable bash for external contributors
capabilities["allowBash"] = false {
  input.actor.roles[_] == "external"
}
```

Returned capability restrictions are merged with the YAML configuration. OPA can only **restrict** capabilities (set to `false` or reduce `allowedTools`), never grant more than the YAML config allows.

---

## Input Document Reference

Your Rego policies receive an `input` document with these fields:

```json
{
  "scope": "check.execute",
  "check": {
    "id": "deploy-production",
    "type": "command",
    "group": "deployment",
    "tags": ["deploy", "production"],
    "criticality": "external",
    "sandbox": "docker-image",
    "policy": {
      "require": "admin",
      "deny": ["external"],
      "rule": "visor/deploy/production"
    }
  },
  "tool": {
    "serverName": "github",
    "methodName": "search_repositories",
    "transport": "stdio"
  },
  "capability": {
    "allowEdit": true,
    "allowBash": true,
    "allowedTools": ["search_*"],
    "enableDelegate": false,
    "sandbox": "docker-image"
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
    "branch": "feat/new-feature",
    "baseBranch": "main",
    "event": "pull_request",
    "action": "synchronize"
  },
  "pullRequest": {
    "number": 42,
    "labels": ["approved", "ready-to-merge"],
    "draft": false,
    "changedFiles": 5
  }
}
```

> **Note**: Only the fields relevant to each scope are populated. For example, `check` is populated for `check.execute`, `tool` is populated for `tool.invoke`, etc. `actor`, `repository`, and `pullRequest` are always available when running in a PR context.

### Field descriptions

| Path | Type | Description |
|------|------|-------------|
| `scope` | string | The policy scope being evaluated |
| `check.id` | string | Step/check ID from `.visor.yaml` |
| `check.type` | string | Provider type (`ai`, `command`, `mcp`, etc.) |
| `check.group` | string | Comment group name |
| `check.tags` | string[] | Tags assigned to the check |
| `check.criticality` | string | `external`, `internal`, `policy`, or `info` |
| `check.sandbox` | string | Sandbox type if configured |
| `check.policy` | object | Per-step policy override from YAML |
| `tool.serverName` | string | MCP server name |
| `tool.methodName` | string | MCP method being invoked |
| `tool.transport` | string | MCP transport type (`stdio`, `sse`, `http`) |
| `actor.login` | string | GitHub username |
| `actor.authorAssociation` | string | Raw GitHub author association |
| `actor.roles` | string[] | Resolved roles from `policy.roles` config |
| `actor.isLocalMode` | boolean | `true` when running outside GitHub Actions |
| `repository.owner` | string | Repository owner/organization |
| `repository.name` | string | Repository name |
| `repository.branch` | string | Current/head branch |
| `repository.baseBranch` | string | Base branch for PRs |
| `repository.event` | string | GitHub event type |
| `repository.action` | string | GitHub event action |
| `pullRequest.number` | number | PR number |
| `pullRequest.labels` | string[] | Labels applied to the PR |
| `pullRequest.draft` | boolean | `true` if the PR is a draft |
| `pullRequest.changedFiles` | number | Number of files changed in the PR |

---

## Per-Step Policy Overrides

Individual steps can declare policy requirements directly in YAML. This is a convenience shortcut that works without writing Rego (though your Rego must handle the `input.check.policy` field for it to take effect).

```yaml
steps:
  deploy-staging:
    type: command
    exec: ./deploy.sh staging
    policy:
      require: [developer, admin]   # Any of these roles can run this step
      deny: [external]              # These roles are explicitly blocked
      rule: visor/deploy/staging    # Optional: custom OPA rule path
```

| Field | Type | Description |
|-------|------|-------------|
| `require` | `string` \| `string[]` | Role(s) required to run the step (any match suffices) |
| `deny` | `string[]` | Role(s) explicitly denied from running the step (deny takes precedence over allow) |
| `rule` | `string` | Custom OPA rule path (overrides the default scope-based path) |

### How `deny` works

The `deny` field is an explicit blocklist. If any of the actor's resolved roles appear in the `deny` array, the check is **unconditionally blocked** -- even if the actor also has a role that would otherwise satisfy `require` or a hardcoded `allowed` rule. Deny always takes precedence over allow.

**Example**: A user with both `developer` and `external` roles attempts to run this step:

```yaml
deploy-staging:
  type: command
  exec: ./deploy.sh staging
  policy:
    require: [developer, admin]
    deny: [external]
```

Even though the user has the `developer` role (which satisfies `require`), the step is blocked because they also have the `external` role, which appears in `deny`.

**Rego implementation**: The `deny` field is passed to OPA as `input.check.policy.deny`. Your Rego rules must include a `denied` helper that checks this field. The example policy in [`examples/enterprise-policy/policies/check_execute.rego`](../examples/enterprise-policy/policies/check_execute.rego) includes this enforcement:

```rego
# Explicit deny list from YAML policy.deny
denied {
  some i, j
  input.check.policy.deny[i] == input.actor.roles[j]
}

# Every allowed rule includes `not denied` so deny takes precedence
allowed {
  not denied
  input.actor.roles[_] == "admin"
}
```

> **Important**: The `deny` field only takes effect if your Rego policy reads `input.check.policy.deny` and uses it to block the `allowed` decision. The YAML field alone does nothing -- it is data that your policy must act on. The example policies shipped with Visor include this enforcement out of the box.

When a check is denied via `policy.deny`, the denial reason will be `"role is in the deny list for this check"` (distinct from the generic `"insufficient role for this check"` reason).

### Custom Rule Paths with `policy.rule`

By default, all check execution policies are evaluated against the `visor/check/execute` rule path (corresponding to `package visor.check.execute` in Rego). The `policy.rule` field lets you override this default and route a specific check to a completely different Rego package with its own specialized logic.

#### When to use it

Use a custom rule path when a check needs specialized policy logic that differs from the general `check.execute` rules. Common scenarios include:

- **Production deployments** that require additional safeguards beyond role checks (e.g., branch restrictions, time-of-day controls)
- **Sensitive operations** that need a dedicated approval workflow
- **Environment-specific gates** where staging and production have different policy requirements
- **Compliance checks** that must enforce domain-specific regulations

#### How it works

When a check declares `policy.rule`, the engine's `resolveRulePath` method returns the custom path instead of the default `visor/check/execute`. For WASM evaluation, the engine navigates the compiled result tree using the custom path segments. For remote OPA, the path is sent as the HTTP endpoint.

The flow is:

1. Check config has `policy.rule: visor/deploy/production`
2. Engine calls `resolveRulePath('check.execute', 'visor/deploy/production')`
3. The override is returned as-is: `visor/deploy/production`
4. For WASM: the engine strips the `visor/` prefix and navigates `result.deploy.production`
5. For remote OPA: a POST is sent to `${url}/v1/data/visor/deploy/production`

#### Complete example

**Step 1**: Declare the custom rule in your `.visor.yaml`:

```yaml
steps:
  deploy-production:
    type: command
    exec: ./deploy.sh production
    criticality: external
    policy:
      require: admin
      rule: visor/deploy/production
```

**Step 2**: Create the corresponding Rego file. The package name must match the rule path, with slashes converted to dots:

```rego
# policies/deploy_production.rego
package visor.deploy.production

default allowed = false

# Helper: check if actor is an admin (WASM-safe pattern)
is_admin { input.actor.roles[_] == "admin" }

# Only admins can deploy to production
allowed {
  is_admin
}

# Additionally require the PR to target the main branch
allowed {
  is_admin
  input.repository.baseBranch == "main"
}

reason = "only admins can deploy to production" { not allowed }
```

**Step 3**: Place the file in the same directory as your other policies (the directory referenced by `policy.rules` in your top-level config). OPA compiles all `.rego` files in that directory together, so the custom package is automatically included.

#### Important notes

- **Package name must match the rule path**: The Rego `package` declaration uses dots as separators, while the YAML `rule` field uses slashes. They must correspond: `visor/deploy/production` in YAML maps to `package visor.deploy.production` in Rego.
- **The `visor/` prefix is required**: Visor compiles WASM bundles with `-e visor` as the entrypoint. All rule paths must start with `visor/` so the engine can navigate the result tree correctly.
- **Custom Rego files go in the policy directory**: The file must be in the same directory (or listed in the same `policy.rules` array) as your other `.rego` files. OPA compiles all files together into one WASM bundle.
- **Custom rules must define `allowed`**: Like the default scopes, custom rules must export an `allowed` boolean. Optionally export a `reason` string for denial messages.
- **The full input document is available**: Custom rules receive the same `input` document as the default `check.execute` scope, including `input.actor`, `input.repository`, and `input.check` (with the `policy` sub-object containing `require`, `deny`, and `rule`).
- **Only one rule per check**: Each check can specify at most one `policy.rule`. If omitted, the default `visor/check/execute` path is used.

#### Testing custom rules

Use the OPA CLI to test your custom rule in isolation:

```bash
# Test the custom deploy rule with an admin actor
echo '{
  "actor": {"roles": ["admin"], "isLocalMode": false},
  "check": {"id": "deploy-production", "type": "command"},
  "repository": {"baseBranch": "main"}
}' | opa eval -d policies/ -i /dev/stdin 'data.visor.deploy.production.allowed'

# Expected output: true

# Test with a non-admin actor (should be denied)
echo '{
  "actor": {"roles": ["developer"], "isLocalMode": false},
  "check": {"id": "deploy-production", "type": "command"},
  "repository": {"baseBranch": "main"}
}' | opa eval -d policies/ -i /dev/stdin 'data.visor.deploy.production.allowed'

# Expected output: false

# Check the denial reason
echo '{
  "actor": {"roles": ["developer"], "isLocalMode": false},
  "check": {"id": "deploy-production", "type": "command"},
  "repository": {"baseBranch": "main"}
}' | opa eval -d policies/ -i /dev/stdin 'data.visor.deploy.production.reason'

# Expected output: "only admins can deploy to production"
```

See [`examples/enterprise-policy/policies/deploy_production.rego`](../examples/enterprise-policy/policies/deploy_production.rego) for the full working example.

---

## Local WASM Mode

Local mode compiles Rego policies into WebAssembly and evaluates them in-process. This is the recommended mode for most deployments.

```yaml
policy:
  engine: local
  rules: ./policies/       # Directory of .rego files
  fallback: deny
```

### How it works

1. At startup, Visor finds all `.rego` files in the specified path
2. It compiles them to WASM using `opa build -t wasm -e visor`
3. The WASM module is loaded into the Node.js process via `@open-policy-agent/opa-wasm`
4. Each policy evaluation takes ~1ms (no network round-trip)

### Supported `rules` values

| Value | Example | Description |
|-------|---------|-------------|
| Directory | `./policies/` | All `.rego` files in the directory are compiled together |
| Single file | `./policies/main.rego` | A single `.rego` file |
| Multiple files | `[./policies/check.rego, ./policies/tool.rego]` | Array of `.rego` files |
| WASM bundle | `./policy.wasm` | Pre-compiled WASM (skips `opa build` at startup) |

### External data document

You can load an external JSON file as the OPA data document using the `data` option. This makes the file's contents available in your Rego policies via `data.<key>`, allowing you to externalize dynamic configuration (allowed lists, thresholds, feature flags, etc.) without modifying your `.rego` files.

```yaml
policy:
  engine: local
  rules: ./policies/
  data: ./policies/data.json
```

The JSON file must contain a top-level object. For example:

```json
{
  "allowed_repos": ["visor", "probe"],
  "protected_checks": {
    "deploy-production": true,
    "deploy-staging": true
  },
  "max_concurrent_deploys": 3
}
```

You can then reference these values in your Rego policies:

```rego
package visor.check.execute

# Use external data for dynamic configuration
allowed {
  data.protected_checks[input.check.id]
  input.actor.roles[_] == "admin"
}

# Non-protected checks are allowed for developers
allowed {
  not data.protected_checks[input.check.id]
  input.actor.roles[_] == "developer"
}
```

> **Note**: The `data` option is only supported in `local` mode. For `remote` mode, load data directly into your OPA server using OPA's bundle or data APIs.

---

## Remote OPA Server Mode

Remote mode sends evaluation requests to an external OPA server via HTTP. This is useful for centralized policy management across multiple services.

```yaml
policy:
  engine: remote
  url: http://opa:8181
  fallback: deny
  timeout: 3000
```

### How it works

1. Visor sends POST requests to `${url}/v1/data/visor/<scope>`
2. The request body is `{ "input": <policy-input-document> }`
3. The response contains `{ "result": { "allowed": true/false, ... } }`

### Setting up an OPA server

```bash
# Run OPA as a server with your policies
opa run --server --addr :8181 ./policies/

# Or with Docker
docker run -p 8181:8181 \
  -v $(pwd)/policies:/policies \
  openpolicyagent/opa:latest \
  run --server --addr :8181 /policies/
```

### When to use remote mode

- Centralized policy management across multiple repositories
- Policy bundles pulled from a registry
- Audit logging at the OPA server level
- Policies shared with other services (not just Visor)

---

## Fallback Behavior

The `fallback` setting controls what happens when policy evaluation fails or a policy denies an action:

| Setting | Behavior |
|---------|----------|
| `allow` (default) | On error/timeout, allow the action |
| `deny` | On error/timeout, deny the action |
| `warn` | Evaluate policies normally but never block execution. Denied actions are allowed to proceed, and a warning is logged instead. Use this for gradual policy rollout. |

### Audit mode with `warn`

The `warn` fallback is designed for **gradual policy rollout**. When deploying new policies, set `fallback: warn` to observe what would be denied without actually blocking any checks. This lets you:

- Validate that your Rego policies match your intent before enforcing them
- Identify unexpected denials in production without disrupting workflows
- Gradually roll out policies: start with `warn`, review logs, then switch to `deny`

In warn mode:
- All policy evaluations run normally
- Denied decisions are overridden to allowed, with the original reason prefixed by `audit:`
- Warnings are emitted to the log: `[PolicyEngine] Audit: check '<id>' would be denied: <reason>`
- If policy evaluation fails (error/timeout), the action is still allowed and a warning is logged

```yaml
# Example: observe policy decisions before enforcing
policy:
  engine: local
  rules: ./policies/
  fallback: warn   # log violations, don't block
  roles:
    admin:
      author_association: [OWNER]
    developer:
      author_association: [MEMBER, COLLABORATOR]
```

Evaluation can fail due to:
- WASM compilation errors (invalid Rego syntax)
- Timeout exceeded
- Remote OPA server unreachable
- Missing or invalid `.rego` files
- Runtime evaluation errors in Rego

### Without a license

If no valid license is found, the policy engine is **silently disabled**. All checks run as normal with no policy enforcement. No error is raised. This means:

- The OSS build works exactly as before
- The EE build without a license works exactly as the OSS build
- Expired licenses (past the 72h grace period) behave as if no license is present

---

## How It Works

### Architecture

```
.visor.yaml (policy: block)
    |
    v
src/policy/types.ts           PolicyEngine interface (OSS)
src/policy/default-engine.ts  No-op implementation (OSS, always allows)
    |
    v  (dynamic import, license-gated)
src/enterprise/loader.ts      Sole import boundary
src/enterprise/policy/
    opa-policy-engine.ts      Wraps WASM + HTTP evaluators
    opa-wasm-evaluator.ts     @open-policy-agent/opa-wasm
    opa-http-evaluator.ts     REST client for OPA server
    policy-input-builder.ts   Builds OPA input documents
```

### Execution flow

1. **Engine startup**: If `config.policy.engine` is not `disabled`, Visor dynamically imports `src/enterprise/loader.ts`
2. **License check**: The loader validates the JWT license. If invalid or missing, returns `DefaultPolicyEngine` (no-op)
3. **OPA initialization**: For `local` mode, compiles `.rego` to WASM. For `remote` mode, validates the OPA server URL
4. **Check execution**: Before each check runs (after `if` conditions), the engine calls `policyEngine.evaluateCheckExecution()`
5. **Decision**: If denied, the check is skipped with `policy_denied` reason. If allowed, execution proceeds normally

### Import boundary

The enterprise code is strictly isolated. OSS code never imports from `src/enterprise/` directly. The sole boundary is `src/enterprise/loader.ts`, loaded via dynamic `await import()`. This is enforced by an ESLint rule.

---

## Relationship to Author Permissions

Visor provides two mechanisms for permission-based workflow control:

| Feature | Author Permissions (OSS) | Policy Engine (EE) |
|---------|--------------------------|-------------------|
| **License** | None (OSS) | EE license required |
| **Mechanism** | JavaScript expressions in `if`/`fail_if` | OPA Rego policies |
| **Scope** | Per-step `if` conditions | Pre-execution gating, tool filtering, capability restriction |
| **Enforcement** | Evaluated inline (can be bypassed by config changes) | Centralized, auditable, separable from config |
| **Role system** | Uses `hasMinPermission()`, `isMember()`, etc. | Custom roles resolved from `policy.roles` config |
| **Complexity** | Simple, inline | Full policy language (Rego) with testing tools |

### When to use each

- **Author Permissions**: Simple permission checks embedded in step conditions. Good for small teams with straightforward rules.
- **Policy Engine**: Centralized, auditable policy enforcement. Good for organizations that need compliance, separation of duties, or complex role hierarchies.

The two systems complement each other. Author permission functions remain available in `if`/`fail_if` expressions even when the policy engine is active. The policy engine evaluates first (before `if` conditions for check execution gating), providing an additional layer of control.

See [Author Permissions](./author-permissions.md) for the OSS permission functions.

---

## Troubleshooting

### Policy engine not activating

**Symptom**: Checks run without policy enforcement even with `policy:` configured.

1. **Check your license**: Ensure `VISOR_LICENSE` is set or `.visor-license` exists
2. **Verify the feature**: Your license must include the `policy` feature
3. **Check the engine setting**: Ensure `policy.engine` is `local` or `remote` (not `disabled`)
4. **Run with debug**: `visor --debug` shows policy initialization messages

### OPA CLI not found

**Symptom**: `Error: opa command not found` at startup.

- Install the OPA CLI: see [Installation](#2-install-opa-cli-optional-for-local-compilation)
- Or pre-compile your policies to `.wasm` to avoid needing the CLI at runtime

### WASM compilation errors

**Symptom**: `opa build` fails at startup.

- Run `visor policy-check ./policies/` to validate syntax and WASM compatibility in one step
- Check your Rego syntax: `opa check policies/`
- Avoid WASM-unsafe patterns (see [WASM compilation safety](#writing-rego-policies))
- Ensure the entrypoint package exists: your `.rego` files must declare `package visor.*` packages

### All checks denied unexpectedly

**Symptom**: Every check shows `skipReason: policy_denied`.

- Verify your role definitions match the actor's GitHub association
- Check `fallback: deny` vs `fallback: allow` — `deny` blocks on any evaluation error
- Test your policy with `opa eval`:
  ```bash
  echo '{"actor":{"roles":["developer"]}}' | \
    opa eval -d policies/ -i /dev/stdin 'data.visor.check.execute.allowed'
  ```

### Remote OPA server unreachable

**Symptom**: All checks are allowed/denied (based on fallback) when using remote mode.

- Verify the OPA server URL is correct and reachable
- Check firewall rules and network connectivity
- Increase `timeout` if the server is slow
- Check OPA server logs for errors

### Dumping the OPA input document

Use the `--dump-policy-input` flag to see the exact JSON input that Visor sends to OPA for a given check. This is invaluable for debugging Rego policies because you can feed the output directly into `opa eval`.

```bash
# Print the OPA input document for the "deploy-production" check
visor --dump-policy-input deploy-production

# With a specific config file
visor --dump-policy-input deploy-production --config ./my-visor.yaml
```

Example output:

```json
{
  "scope": "check.execute",
  "check": {
    "id": "deploy-production",
    "type": "command",
    "group": "deployment",
    "tags": ["deploy", "production"],
    "criticality": "external",
    "policy": {
      "require": "admin"
    }
  },
  "actor": {
    "login": "alice",
    "roles": ["developer"],
    "isLocalMode": true
  },
  "repository": {}
}
```

You can pipe this directly into `opa eval` to test your policy:

```bash
visor --dump-policy-input deploy-production | \
  opa eval -d policies/ -i /dev/stdin 'data.visor.check.execute'
```

**Notes**:
- This flag does **not** require a license -- it is a debugging tool.
- Actor context is derived from environment variables (`VISOR_AUTHOR_LOGIN`, `GITHUB_ACTOR`, `VISOR_AUTHOR_ASSOCIATION`, `GITHUB_ACTIONS`).
- Repository context is derived from GitHub environment variables (`GITHUB_REPOSITORY_OWNER`, `GITHUB_REPOSITORY`, `GITHUB_HEAD_REF`, `GITHUB_BASE_REF`, `GITHUB_EVENT_NAME`).
- When running locally (outside GitHub Actions), `actor.isLocalMode` is `true` and most repository fields will be empty.

### Timeout errors

**Symptom**: Policy evaluations timing out.

- For local mode: this is rare (~1ms per evaluation). Check if `.rego` files are very complex
- For remote mode: increase `timeout` or check network latency to the OPA server
- Set `fallback: allow` if timeouts should not block execution

---

## Examples

### Minimal setup

```yaml
# .visor.yaml
version: "1.0"

policy:
  engine: local
  rules: ./policies/
  fallback: deny
  roles:
    admin:
      author_association: [OWNER]
    developer:
      author_association: [MEMBER, COLLABORATOR]

steps:
  security-scan:
    type: ai
    prompt: "Review for security issues"
    policy:
      require: developer
```

```rego
# policies/check_execute.rego
package visor.check.execute

default allowed = false

# Explicit deny list (policy.deny in YAML) — deny takes precedence
denied {
  some i, j
  input.check.policy.deny[i] == input.actor.roles[j]
}

allowed {
  not denied
  input.actor.roles[_] == "admin"
}

allowed {
  not denied
  required := input.check.policy.require
  is_string(required)
  input.actor.roles[_] == required
}

# Local mode: allow checks without explicit policy requirements
allowed {
  not denied
  input.actor.isLocalMode == true
  not input.check.policy
}

reason = "role is in the deny list" { denied }
reason = "insufficient role" { not denied; not allowed }
```

### PR label and metadata policies

Use the `pullRequest` fields to gate checks based on PR metadata. These fields are populated when Visor runs in a PR context (GitHub Actions or CLI with PR info).

```rego
# policies/check_execute.rego
package visor.check.execute

# Only allow deploy-production if PR has the "approved" label
has_approved_label {
  input.pullRequest.labels[_] == "approved"
}

allowed {
  not denied
  input.check.id == "deploy-production"
  has_approved_label
  input.actor.roles[_] == "admin"
}

# Block all checks on draft PRs
allowed = false {
  input.pullRequest.draft == true
}

# Deny checks that change too many files (e.g., > 100)
allowed = false {
  input.pullRequest.changedFiles > 100
  input.check.id == "full-review"
}

reason = "PR must have 'approved' label for production deploy" {
  input.check.id == "deploy-production"
  not has_approved_label
}
reason = "checks are blocked on draft PRs" {
  input.pullRequest.draft == true
}
```

### Full example with all scopes

See [`examples/enterprise-policy/`](../examples/enterprise-policy/) for a complete working example with all three policy scopes, role definitions, and a ready-to-use `.visor.yaml`.

### GitHub Actions integration

```yaml
# .github/workflows/visor.yml
name: Visor
on:
  pull_request: { types: [opened, synchronize] }
permissions:
  contents: read
  pull-requests: write
  checks: write
jobs:
  visor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: probelabs/visor@v1
        env:
          VISOR_LICENSE: ${{ secrets.VISOR_LICENSE }}
          GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
```

---

**Questions? Need a license?** Contact **hello@probelabs.com**
