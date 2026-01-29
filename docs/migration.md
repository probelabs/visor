# Migration Guide

This guide helps you upgrade Visor between versions, documenting breaking changes and how to adapt your configurations.

## Table of Contents

- [Version History Overview](#version-history-overview)
- [Configuration Key Changes](#configuration-key-changes)
- [Provider Changes](#provider-changes)
- [Breaking Changes by Version](#breaking-changes-by-version)
- [Migration Steps](#migration-steps)
- [Deprecation Warnings](#deprecation-warnings)
- [Compatibility Notes](#compatibility-notes)

---

## Version History Overview

| Version | Key Changes |
|---------|-------------|
| 0.1.x | Current stable release with state machine engine |
| 0.1.40+ | Workspace isolation, git-checkout provider |
| 0.1.30+ | Lifecycle hooks standardization (`on_init`) |
| 0.1.20+ | Transitions DSL, memory provider enhancements |
| 0.1.10+ | Routing system (`on_success`, `on_fail`, `on_finish`) |
| 0.1.0 | Initial release with basic check providers |

---

## Configuration Key Changes

### `args` to `command_args` (MCP Provider)

The MCP provider renamed `args` to `command_args` for stdio transport to avoid confusion with method arguments.

**Before:**
```yaml
steps:
  mcp-check:
    type: mcp
    transport: stdio
    command: npx
    args: ["-y", "@probelabs/probe@latest", "mcp"]
    method: search_code
```

**After:**
```yaml
steps:
  mcp-check:
    type: mcp
    transport: stdio
    command: npx
    command_args: ["-y", "@probelabs/probe@latest", "mcp"]
    method: search_code
```

### `checks` to `steps` (Terminology)

Visor now uses `steps:` instead of `checks:` to better reflect workflow orchestration capabilities. Both keys work identically for backward compatibility.

**Before:**
```yaml
version: "1.0"
checks:
  security-review:
    type: ai
    prompt: "Review for security issues"
```

**After (Recommended):**
```yaml
version: "1.0"
steps:
  security-review:
    type: ai
    prompt: "Review for security issues"
```

### `custom_prompt` to `system_prompt` (AI Provider)

The AI provider renamed `custom_prompt` to `system_prompt` for clarity.

**Before:**
```yaml
steps:
  ai-check:
    type: ai
    ai:
      custom_prompt: "You are a security expert..."
```

**After:**
```yaml
steps:
  ai-check:
    type: ai
    ai:
      system_prompt: "You are a security expert..."
```

### `failure_conditions` to `fail_if` (Simplified)

The verbose `failure_conditions` object has been replaced with a simpler `fail_if` expression.

**Before:**
```yaml
steps:
  quality-check:
    type: ai
    failure_conditions:
      high_severity:
        condition: "output.issues?.filter(i => i.severity === 'error').length > 0"
        message: "Critical issues found"
        severity: error
```

**After:**
```yaml
steps:
  quality-check:
    type: ai
    fail_if: "output.issues?.filter(i => i.severity === 'error').length > 0"
```

### `include` to `extends` (Configuration Inheritance)

The `include` key has been renamed to `extends` to better match common configuration patterns.

**Before:**
```yaml
version: "1.0"
include:
  - ./base-config.yaml
  - ./team-standards.yaml
```

**After:**
```yaml
version: "1.0"
extends:
  - ./base-config.yaml
  - ./team-standards.yaml
```

---

## Provider Changes

### New Providers

The following providers have been added:

| Provider | Type | Description |
|----------|------|-------------|
| `git-checkout` | `git-checkout` | Checkout git repositories with worktree support |
| `workflow` | `workflow` | Invoke reusable workflows |
| `human-input` | `human-input` | Request user input in workflows |
| `script` | `script` | Execute custom JavaScript logic |
| `log` | `log` | Debug logging (replaces `logger`) |
| `github` | `github` | Native GitHub API operations |

### Provider Type Renames

| Old Type | New Type | Notes |
|----------|----------|-------|
| `webhook` | `http` | For output webhooks |
| (new) | `http_input` | For receiving webhooks |
| (new) | `http_client` | For fetching from APIs |
| `logger` | `log` | Debug logging |

**Before:**
```yaml
steps:
  notify:
    type: webhook
    url: https://slack.webhook.url
```

**After:**
```yaml
steps:
  notify:
    type: http
    url: https://slack.webhook.url
    method: POST
```

### MCP Provider Transport Types

The MCP provider now supports multiple transports:

| Transport | Description |
|-----------|-------------|
| `stdio` | Local command via stdin/stdout (default) |
| `sse` | Server-Sent Events (legacy) |
| `http` | Modern Streamable HTTP |
| `custom` | YAML-defined tools |

**Example with explicit transport:**
```yaml
steps:
  mcp-tool:
    type: mcp
    transport: stdio  # Explicitly specify transport
    command: npx
    command_args: ["-y", "@probelabs/probe@latest", "mcp"]
    method: search_code
```

---

## Breaking Changes by Version

### Version 0.1.40+: Workspace Isolation

**What Changed:**
- Introduced workspace isolation for sandboxed execution
- Steps now execute in isolated `/tmp/visor-workspaces/<sessionId>/` directories
- Main project is automatically worktree-cloned into the workspace

**Impact:**
- File paths in outputs may be relative to workspace, not original directory
- Commands should use `{{ outputs['checkout'].path }}` for checkout paths

**Migration:**
```yaml
# New workspace configuration (optional)
workspace:
  enabled: true
  base_path: /tmp/visor-workspaces
  cleanup_on_exit: true

steps:
  checkout:
    type: git-checkout
    ref: "{{ pr.head }}"

  build:
    type: command
    depends_on: [checkout]
    # Use workspace path from checkout output
    exec: "cd {{ outputs.checkout.path }} && npm run build"
```

### Version 0.1.30+: Lifecycle Hooks (`on_init`)

**What Changed:**
- Added `on_init` hook for preprocessing before step execution
- Unified invocation syntax for tools, steps, and workflows
- Arguments passed via `with:` directive

**Migration:**
If you used `depends_on` for preprocessing, consider migrating to `on_init`:

**Before:**
```yaml
steps:
  fetch-jira:
    type: mcp
    method: fetch-jira
    methodArgs:
      issue_key: "PROJ-123"

  ai-review:
    type: ai
    depends_on: [fetch-jira]
    prompt: |
      JIRA: {{ outputs['fetch-jira'] }}
      Review the PR...
```

**After:**
```yaml
tools:
  fetch-jira:
    exec: "curl https://jira.../issue/{{ args.issue_key }}"
    parseJson: true

steps:
  ai-review:
    type: ai
    on_init:
      run:
        - tool: fetch-jira
          with:
            issue_key: "PROJ-123"
          as: jira-context
    prompt: |
      JIRA: {{ outputs['jira-context'] }}
      Review the PR...
```

### Version 0.1.20+: Transitions DSL

**What Changed:**
- Added declarative `transitions` array as alternative to `goto_js`
- Transitions evaluated in order; first matching rule wins
- Helper functions available in `when` expressions: `any()`, `all()`, `none()`, `count()`

**Migration:**
Complex `goto_js` logic can be simplified with transitions:

**Before:**
```yaml
steps:
  validate:
    type: ai
    on_success:
      goto_js: |
        if (outputs['validate'].score >= 90) return 'publish';
        if (outputs['validate'].score >= 70) return 'review';
        return 'reject';
```

**After:**
```yaml
steps:
  validate:
    type: ai
    on_success:
      transitions:
        - when: "outputs['validate'].score >= 90"
          to: publish
        - when: "outputs['validate'].score >= 70"
          to: review
        - when: "true"
          to: reject
```

### Version 0.1.10+: Routing System

**What Changed:**
- Introduced `on_success`, `on_fail`, `on_finish` hooks
- Added `routing` configuration for global defaults
- Retry policies with backoff (fixed/exponential)
- Loop protection via `max_loops`

**Migration:**
Add routing configuration to enable retry and routing features:

```yaml
version: "2.0"

routing:
  max_loops: 10
  defaults:
    on_fail:
      retry:
        max: 2
        backoff:
          mode: exponential
          delay_ms: 1000

steps:
  flaky-step:
    type: command
    exec: ./sometimes-fails.sh
    on_fail:
      retry:
        max: 3
      goto: setup-step  # Jump to ancestor on failure
```

### Memory Provider Changes

**What Changed:**
- Added `script` type for complex JavaScript logic (previously part of memory provider)
- Memory operations now require explicit `operation` key
- Added `value_js` for dynamic value computation

**Migration:**

**Before (if using inline JS in memory):**
```yaml
steps:
  complex-calc:
    type: memory
    key: result
    value: |
      // This was never valid, but some tried it
      const x = 1 + 2;
      return x;
```

**After:**
```yaml
steps:
  complex-calc:
    type: script
    content: |
      const x = 1 + 2;
      memory.set('result', x);
      return x;
```

---

## Migration Steps

### Step 1: Update Configuration Version

If using routing features, update to version "2.0":

```yaml
version: "2.0"  # Required for routing features
```

### Step 2: Rename Deprecated Keys

Use the following sed commands or manually update:

```bash
# Rename args to command_args in MCP checks
sed -i 's/^\(\s*\)args:/\1command_args:/' .visor.yaml

# Rename checks to steps (optional but recommended)
sed -i 's/^checks:/steps:/' .visor.yaml

# Rename custom_prompt to system_prompt
sed -i 's/custom_prompt:/system_prompt:/' .visor.yaml

# Rename include to extends
sed -i 's/^include:/extends:/' .visor.yaml
```

### Step 3: Validate Configuration

Run the validation command to check for errors:

```bash
visor validate --config .visor.yaml
```

### Step 4: Update Provider Types

Replace deprecated provider types:

| Find | Replace With |
|------|--------------|
| `type: webhook` | `type: http` |
| `type: logger` | `type: log` |

### Step 5: Test in Dry-Run Mode

Before deploying, test your configuration:

```bash
# Test with debug output
visor --check all --debug

# Or test specific checks
visor --check security --debug
```

---

## Deprecation Warnings

### Features Scheduled for Removal

| Feature | Deprecated In | Removal Target | Alternative |
|---------|--------------|----------------|-------------|
| `checks:` key | 0.1.30 | 1.0.0 | Use `steps:` |
| `failure_conditions` | 0.1.20 | 1.0.0 | Use `fail_if` |
| `custom_prompt` | 0.1.20 | 1.0.0 | Use `system_prompt` |
| `include:` key | 0.1.30 | 1.0.0 | Use `extends:` |
| `args` in MCP stdio | 0.1.25 | 1.0.0 | Use `command_args` |

### Deprecation Messages

When using deprecated features, Visor logs warnings:

```
[WARN] 'checks:' is deprecated, use 'steps:' instead
[WARN] 'failure_conditions' is deprecated, use 'fail_if' instead
[WARN] 'args' in MCP stdio transport is deprecated, use 'command_args'
```

---

## Compatibility Notes

### GitHub Action vs CLI

Both modes share the same configuration format with minor differences:

| Feature | GitHub Action | CLI |
|---------|--------------|-----|
| Event triggers (`on:`) | Automatic from webhook | Manual or simulated |
| PR context | From GitHub event | From git/API |
| Output | PR comments, check runs | Console, file |
| Secrets | GitHub secrets | Environment variables |

### Node.js Version Requirements

| Visor Version | Node.js Requirement |
|---------------|---------------------|
| 0.1.x | Node.js 18+ |
| 1.0.0 (planned) | Node.js 20+ |

### Dependencies

Visor's core dependencies:

| Dependency | Purpose |
|------------|---------|
| `@modelcontextprotocol/sdk` | MCP protocol support |
| `liquidjs` | Template rendering |
| `js-yaml` | YAML parsing |
| `ajv` | JSON Schema validation |

### Environment Variables

Key environment variables for migration:

| Variable | Purpose |
|----------|---------|
| `VISOR_WORKSPACE_PATH` | Override workspace base path |
| `VISOR_WORKTREE_PATH` | Override git worktree cache |
| `VISOR_TELEMETRY_ENABLED` | Enable OpenTelemetry tracing |

---

## Troubleshooting

### Common Migration Issues

#### Issue: "Invalid check type" error

**Cause:** Using old provider type names.

**Solution:** Update to new type names (see [Provider Type Renames](#provider-type-renames)).

#### Issue: MCP check fails with "args not recognized"

**Cause:** Using `args` instead of `command_args` for stdio transport.

**Solution:** Rename `args` to `command_args` in MCP checks.

#### Issue: Configuration validation fails

**Cause:** Schema changes between versions.

**Solution:** Run `visor validate` and fix reported issues.

#### Issue: Outputs not available in templates

**Cause:** Using old output access patterns.

**Solution:** Use `outputs['step-name']` or `outputs.history['step-name']` for history.

### Getting Help

- [Configuration Documentation](./configuration.md)
- [GitHub Issues](https://github.com/probelabs/visor/issues)
- [Examples Directory](../examples/)

---

## Quick Reference

### Configuration Changes Checklist

- [ ] Update `version:` to "2.0" if using routing
- [ ] Rename `checks:` to `steps:`
- [ ] Rename `args:` to `command_args:` in MCP stdio checks
- [ ] Rename `custom_prompt:` to `system_prompt:`
- [ ] Rename `include:` to `extends:`
- [ ] Replace `failure_conditions:` with `fail_if:`
- [ ] Update provider types (`webhook` to `http`, `logger` to `log`)
- [ ] Run `visor validate` to check configuration

### Version-Specific Features

```yaml
# Version 1.0 features
version: "1.0"
steps:
  basic-check:
    type: ai
    prompt: "Review code"

# Version 2.0 features (routing)
version: "2.0"
routing:
  max_loops: 10
steps:
  with-routing:
    type: command
    exec: ./script.sh
    on_fail:
      retry:
        max: 3
      goto: setup
```
