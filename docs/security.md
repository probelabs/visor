# Security

This document covers security considerations and best practices for Visor deployments. Security is a critical aspect of any CI/CD tool that interacts with source code, AI providers, and external services.

## Overview

Visor operates in sensitive environments where it has access to:
- Source code and pull request data
- AI provider credentials
- GitHub tokens with repository permissions
- External service integrations

Understanding and properly configuring security controls is essential for safe operation.

---

## Authentication

### GitHub Token vs GitHub App

Visor supports two authentication methods for GitHub integration:

| Method | Use Case | Permissions |
|--------|----------|-------------|
| **GitHub Token** | Quick setup, personal repos | Repository-scoped |
| **GitHub App** | Organizations, fine-grained control | Installation-scoped |

**GitHub Token (PAT or default token)**:
```yaml
- uses: probelabs/visor@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

**GitHub App** (recommended for organizations):
```yaml
- uses: probelabs/visor@v1
  with:
    app-id: ${{ secrets.VISOR_APP_ID }}
    private-key: ${{ secrets.VISOR_PRIVATE_KEY }}
```

**Best Practice**: Prefer GitHub App authentication for:
- Granular repository permissions
- Bot identity (separate from user)
- Organization-wide installations
- Audit logging and traceability

### Credential Propagation

When Visor authenticates, it automatically injects credentials into `process.env` so that all child processes (command checks, AI agents, MCP servers, git operations) inherit them. This includes:

- `GITHUB_TOKEN` and `GH_TOKEN` for the `gh` CLI
- `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*` for authenticated git HTTPS access

No temp files are written, no global git config is modified, and credentials are scoped to the Visor process tree.

See [GitHub Authentication](./github-auth.md) for complete setup guide including CLI options, GitHub App creation steps, and troubleshooting.

---

## AI Provider Security

AI providers require careful configuration to prevent unintended actions.

### File Editing Control (`allowEdit`)

By default, AI agents cannot modify files. Enable only when necessary:

```yaml
steps:
  auto-fix:
    type: ai
    prompt: "Fix the security vulnerabilities"
    ai:
      allowEdit: true  # Disabled by default
```

**When to enable**: Automated fix workflows, code refactoring, sandboxed environments.

**When to disable**: Review-only workflows, production environments, untrusted inputs.

### Tool Filtering (`allowedTools`, `disableTools`)

Control which tools the AI agent can access:

```yaml
steps:
  # Whitelist mode - only specified tools
  restricted:
    type: ai
    ai:
      allowedTools: ['Read', 'Grep', 'Glob']

  # Exclusion mode - block specific tools
  safe-review:
    type: ai
    ai:
      allowedTools: ['!Edit', '!Write', '!Delete']

  # Disable all tools (raw AI mode)
  conversational:
    type: ai
    ai:
      disableTools: true
```

### Bash Command Execution (`allowBash`, `bashConfig`)

Bash execution is disabled by default. When enabled, comprehensive allow/deny lists apply:

```yaml
steps:
  # Simple enable with default safe commands
  analysis:
    type: ai
    ai:
      allowBash: true

  # Advanced configuration
  custom-bash:
    type: ai
    ai:
      allowBash: true
      bashConfig:
        allow: ['npm test', 'npm run lint']
        deny: ['npm install', 'rm -rf']
        timeout: 30000
        workingDirectory: './src'
```

**Default security**:
- ~235 safe read-only commands allowed (ls, cat, git status, grep, etc.)
- ~191 dangerous commands blocked (rm -rf, sudo, curl, npm install, etc.)

See [AI Configuration](./ai-configuration.md) for complete AI security options.

---

## HTTP Security

### Authentication Methods

The HTTP server supports multiple authentication types:

```yaml
http_server:
  auth:
    # Bearer Token
    type: bearer_token
    secret: "${WEBHOOK_SECRET}"

    # HMAC-SHA256 Signature (GitHub-compatible)
    type: hmac
    secret: "${WEBHOOK_SECRET}"

    # Basic Authentication
    type: basic
    username: "${HTTP_USERNAME}"
    password: "${HTTP_PASSWORD}"
```

### HMAC Signature Verification

For `hmac` authentication:
- Signature header: `x-webhook-signature`
- Format: `sha256={hash}`
- Timing-safe comparison prevents timing attacks
- Compatible with GitHub webhook signatures

### DoS Protection

Built-in protections:
- **Request size limit**: Maximum 1MB request body
- **Early rejection**: `Content-Length` validation before processing
- **Graceful errors**: Returns HTTP 413 for oversized requests

### TLS/HTTPS Configuration

```yaml
http_server:
  tls:
    enabled: true
    cert: "${TLS_CERT}"
    key: "${TLS_KEY}"
    ca: "${TLS_CA}"  # Optional CA certificate
    rejectUnauthorized: true
```

**Sources**: Environment variables, file paths, or Let's Encrypt certificates.

See [HTTP Integration](./http.md) for complete HTTP security configuration.

---

## Path Traversal Protection

Visor validates all local file paths to prevent directory traversal attacks.

### Protection Mechanisms

1. **Project root boundary**: Paths must remain within the project root (git root or package.json location)

2. **Sensitive file blocking**: Access denied to:
   - `/.ssh/` - SSH keys
   - `/.aws/` - AWS credentials
   - `/.env` - Environment files
   - `/etc/passwd` - System files
   - `/etc/shadow` - Password hashes
   - `/private/` - macOS private directory

### Example Blocked Paths

```
../../../etc/passwd          # Traversal attack
/home/user/.ssh/id_rsa       # SSH key access
config/../../../.env         # Hidden traversal
```

**Error message**: `Security error: Path traversal detected. Cannot access files outside project root`

This protection is implemented in the configuration loader and applies to:
- Configuration file extends
- Local file references
- Template file includes

---

## Process Sandbox Engines

Visor supports three sandbox engines that isolate command execution from the host system:

| Engine | Platform | Isolation Model |
|--------|----------|-----------------|
| **Docker** | Linux, macOS, Windows | Full container isolation |
| **Bubblewrap** | Linux only | Linux kernel namespaces (PID, mount, network) |
| **Seatbelt** | macOS only | `sandbox-exec` with SBPL deny-by-default profiles |

### What Sandboxes Protect Against

- **Filesystem escape**: Commands cannot access files outside allowed paths (`~/.ssh`, `~/.aws`, `~/.config` are inaccessible)
- **Environment leakage**: All engines strip inherited environment variables; only explicitly passed vars are visible
- **Network exfiltration**: Optional network isolation (`network: false`) blocks all network access
- **Process visibility**: Bubblewrap uses PID namespaces to hide host processes

### What Sandboxes Do NOT Protect Against

- **CPU/Memory abuse**: No resource limits enforced by bubblewrap or seatbelt (use Docker `resources:` or external cgroups)
- **Kernel exploits**: Namespace escapes via kernel bugs (bubblewrap/seatbelt are not full VMs)
- **Network attacks**: When `network: true` (the default), sandboxed commands have full network access

### Credential Isolation in Sandboxes

| Resource | Without Sandbox | With Sandbox |
|----------|----------------|--------------|
| `~/.ssh/` | Accessible | Not mounted / denied |
| `~/.aws/` | Accessible | Not mounted / denied |
| `~/.gitconfig` | Accessible | Not mounted / denied (git auth via env vars) |
| `~/.config/gh/` | Accessible | Not mounted / denied |
| Host env vars | All inherited | Only explicitly passed vars |

GitHub credentials are propagated securely via environment variables (`GITHUB_TOKEN`, `GIT_CONFIG_COUNT`/`KEY`/`VALUE`), so authenticated git and `gh` CLI operations work inside any sandbox engine without exposing credential files.

See [Sandbox Engines](./sandbox-engines.md) for complete configuration and usage documentation.

---

## Command Provider Security

The command provider executes shell commands with security safeguards.

### Command Injection Prevention

**Never use uncontrolled user input directly in commands**:

```yaml
# DANGEROUS - PR title could contain malicious commands
bad:
  type: command
  exec: "echo '{{ pr.title }}'"  # VULNERABLE!

# SAFE - Properly escaped
safe:
  type: command
  exec: "echo '{{ pr.title | escape }}'"
```

### Escaping Patterns

```yaml
steps:
  # Use Liquid escape filter
  safe-echo:
    type: command
    exec: "echo '{{ pr.title | escape }}'"

  # Use JSON encoding for complex data
  safe-json:
    type: command
    exec: |
      cat << 'EOF' | jq .
      { "title": {{ pr.title | json }} }
      EOF

  # Avoid user input when possible
  safest:
    type: command
    exec: "echo 'PR #{{ pr.number }}'"  # Numbers are safe
```

### Environment Variable Filtering

Only safe environment variables are exposed in Liquid templates:
- **Allowed prefixes**: `CI_`, `GITHUB_`, `RUNNER_`, `NODE_`, `npm_`
- **Always available**: `PATH`, `HOME`, `USER`, `PWD`

**Note**: Shell commands inherit the full process environment, so `$VAR` expansion has access to all variables.

### Execution Limits

- **Timeout**: 60 seconds default (configurable)
- **Output limit**: 10MB maximum
- **Buffer protection**: Prevents memory exhaustion

See [Command Provider](./command-provider.md) for complete security documentation.

---

## MCP Provider Security

### Command Validation

For stdio transport, commands are validated to prevent shell injection:

```yaml
steps:
  mcp-check:
    type: mcp
    transport: stdio
    command: npx  # Validated command
    args: ["-y", "@probelabs/probe@latest", "mcp"]
```

**Rejected metacharacters**: `;`, `|`, `&`, `` ` ``, `$`, `()`, `{}`, `[]`

### Sandboxed JavaScript

The `transform_js` context runs in a secure sandbox:

**Available**:
- Standard JavaScript: `Array`, `String`, `Object`, `Math`, `JSON`
- Context variables: `output`, `pr`, `files`, `outputs`, `env`

**Blocked**:
- `eval`, `Function`, `require`
- File system access
- Network access
- Process control

### URL Protocol Validation

For SSE and HTTP transports, only `http:` and `https:` protocols are allowed:

```yaml
steps:
  remote-mcp:
    type: mcp
    transport: http
    url: https://mcp-server.example.com/mcp  # Only HTTPS allowed
```

See [MCP Provider](./mcp-provider.md) for complete MCP security documentation.

---

## Custom Tools Security

### Execution Context

Custom tools execute with the same permissions as the Visor process:

```yaml
tools:
  my-tool:
    name: my-tool
    exec: 'grep -n "{{ args.pattern }}" src/'
```

**Security implications**:
- Full file system access within process permissions
- Environment variable access
- Network access if commands allow

### Input Validation

Always define `inputSchema` to validate tool inputs:

```yaml
tools:
  search-tool:
    name: search-tool
    inputSchema:
      type: object
      properties:
        pattern:
          type: string
          maxLength: 100
      required: [pattern]
      additionalProperties: false  # Reject unknown properties
    exec: 'grep -n "{{ args.pattern | escape }}" src/'
```

### Best Practices

1. **Use input validation**: Reject malformed or oversized inputs
2. **Escape arguments**: Use `| escape` filter for shell commands
3. **Limit scope**: Use `cwd` to restrict working directory
4. **Set timeouts**: Prevent runaway commands
5. **Avoid secrets in output**: Filter sensitive data from tool responses

See [Custom Tools](./custom-tools.md) for complete custom tools documentation.

---

## Remote Configuration Security

### Default: Remote URLs Blocked

By default, remote configuration URLs are blocked. Use `--allowed-remote-patterns` to enable:

```bash
visor --check all \
  --allowed-remote-patterns "https://github.com/myorg/,https://raw.githubusercontent.com/myorg/"
```

### Configuration

```yaml
# Only allowed if URL matches an allowed pattern
extends: https://raw.githubusercontent.com/myorg/configs/main/base.yaml
```

### Disable Remote Entirely

```bash
visor --check all --no-remote-extends
```

### Security Features

1. **URL allowlist**: Empty by default, must explicitly allow patterns
2. **Path traversal protection**: Local extends validated against project root
3. **Protocol restriction**: Only `http:` and `https:` for remote configs

See [Configuration](./configuration.md) for complete extends documentation.

---

## Production Security Checklist

### Authentication

- [ ] Use GitHub App authentication for organizations
- [ ] Rotate API keys regularly (AI providers, webhooks)
- [ ] Store secrets in GitHub Secrets, not in code
- [ ] Use environment-specific tokens (dev/staging/prod)

### AI Providers

- [ ] Keep `allowEdit: false` unless explicitly needed
- [ ] Use `allowedTools` to restrict agent capabilities
- [ ] Keep `allowBash: false` for review-only workflows
- [ ] Set appropriate timeouts for AI operations

### HTTP Endpoints

- [ ] Enable TLS for all HTTP servers
- [ ] Use HMAC or bearer token authentication
- [ ] Implement request size limits
- [ ] Monitor for suspicious request patterns

### Configuration

- [ ] Validate configuration files before deployment: `visor validate`
- [ ] Block remote extends unless explicitly needed
- [ ] Review extended configurations for security implications
- [ ] Use `--allowed-remote-patterns` with specific URLs only

### Commands and Tools

- [ ] Escape all user input in shell commands
- [ ] Use input schemas for custom tools
- [ ] Set appropriate timeouts
- [ ] Avoid executing code from untrusted PRs

### Monitoring

- [ ] Enable telemetry for audit trails
- [ ] Review GitHub Checks for unexpected failures
- [ ] Monitor AI provider usage and costs
- [ ] Set up alerts for authentication failures

---

## Related Documentation

- [Sandbox Engines](./sandbox-engines.md) - Process isolation with Docker, Bubblewrap, and Seatbelt
- [GitHub Authentication](./github-auth.md) - Token and GitHub App auth setup, credential propagation
- [AI Configuration](./ai-configuration.md) - AI provider security options
- [HTTP Integration](./http.md) - HTTP authentication and TLS
- [Command Provider](./command-provider.md) - Command injection prevention
- [MCP Provider](./mcp-provider.md) - MCP security features
- [Custom Tools](./custom-tools.md) - Tool execution security
- [Configuration](./configuration.md) - Remote configuration controls
- [GitHub Checks](./GITHUB_CHECKS.md) - GitHub authentication
- [Action Reference](./action-reference.md) - GitHub Action inputs
