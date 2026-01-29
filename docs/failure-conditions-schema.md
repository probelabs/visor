# Failure Condition Configuration Schema

This document describes the failure condition configuration system for Visor that supports JavaScript expressions (evaluated in a secure sandbox) for flexible and powerful failure evaluation.

> **Note:** The simple `fail_if` syntax is now preferred over the legacy `failure_conditions` object syntax. See [Fail If](./fail-if.md) for the recommended approach.

## Quick Start: Using `fail_if` (Recommended)

The simplest way to define failure conditions:

```yaml
version: "1.0"

# Global fail_if applies to all steps unless overridden
fail_if: "output.error || criticalIssues > 0"

steps:
  security:
    type: ai
    prompt: "Analyze for security vulnerabilities..."
    schema: code-review
    on:
      - pr_opened
      - pr_updated
    # Step-specific fail_if overrides global
    fail_if: "criticalIssues > 0 || errorIssues >= 3"

  performance:
    type: ai
    prompt: "Analyze performance implications..."
    schema: code-review
    on:
      - pr_opened
      - pr_updated
    # Complex condition with helper functions
    fail_if: "hasIssue(issues, 'category', 'performance') && errorIssues > 1"
```

## Legacy: Complex Failure Conditions

For more control, use the complex `failure_conditions` object syntax (deprecated but still supported):

```yaml
version: "1.0"

# Object syntax for complex conditions with additional options
failure_conditions:
  critical_security_issues:
    condition: "criticalIssues > 0"
    message: "Critical security issues detected - deployment blocked"
    severity: "error"
    halt_execution: true  # Stop all execution immediately

  performance_degradation:
    condition: "hasIssue(issues, 'category', 'performance') && errorIssues >= 3"
    message: "Performance issues detected that may impact production"
    severity: "warning"

  insufficient_coverage:
    condition: "totalIssues > 15"
    message: "Too many code quality issues - consider additional review"
    severity: "info"

steps:
  security:
    type: ai
    prompt: "Analyze for security vulnerabilities..."
    group: review
    schema: code-review
    on:
      - pr_opened
      - pr_updated
    # Step-specific failure conditions override global ones with same name
    failure_conditions:
      block_on_any_critical: "criticalIssues > 0"
      warn_on_multiple_errors: "errorIssues >= 2"
```

### Advanced JavaScript Expression Examples

```yaml
steps:
  security-check:
    type: ai
    prompt: "Analyze for security issues..."
    # Issue analysis with helper functions
    fail_if: "hasFileWith(issues, 'sql') && hasIssue(issues, 'severity', 'critical')"

  critical-files:
    type: ai
    prompt: "Review critical files..."
    # Multiple file types analysis
    fail_if: "(hasFileWith(issues, '.ts') || hasFileWith(issues, '.js')) && hasIssue(issues, 'severity', 'critical')"

  performance-check:
    type: ai
    prompt: "Analyze performance..."
    # Time-based conditions (if debug info is available)
    fail_if: "debug && debug.processingTime > 60000 && errorIssues > 0"

  auth-check:
    type: ai
    prompt: "Check authentication code..."
    # File-specific security checks with counting
    fail_if: "hasFileWith(issues, 'auth') && countIssues(issues, 'severity', 'critical') > 0"

  security-count:
    type: ai
    prompt: "Security analysis..."
    # Count-based conditions
    fail_if: "countIssues(issues, 'category', 'security') >= 3"
```

## Available Context Variables

### Primary Context

| Variable | Description |
|----------|-------------|
| `output` | Current step's structured output (includes `issues` and provider-specific fields) |
| `outputs` | Map of dependency outputs keyed by step name |
| `memory` | Memory store accessor (see [Memory](./memory.md)) |
| `inputs` | Workflow inputs (for workflows) |
| `env` | Environment variables |
| `debug` | Debug information (`errors`, `processingTime`, `provider`, `model`) |

### Legacy Context (Backward Compatibility)

| Variable | Description |
|----------|-------------|
| `issues` | Shorthand for `output.issues` |
| `criticalIssues` | Count of critical severity issues |
| `errorIssues` | Count of error severity issues |
| `warningIssues` | Count of warning severity issues |
| `infoIssues` | Count of info severity issues |
| `totalIssues` | Total issue count |
| `metadata` | Object with `checkName`, `schema`, `group`, issue counts, etc. |

### Additional Context for `if` Conditions

| Variable | Description |
|----------|-------------|
| `branch` | Current branch name |
| `baseBranch` | Target branch (default: `main`) |
| `filesChanged` | Array of changed file paths |
| `filesCount` | Number of changed files |
| `event` | GitHub event context (`event_name`, `action`, `repository`, etc.) |
| `checkName` | Current check name |
| `schema` | Check schema |
| `group` | Check group |

## Available Helper Functions

### String Helpers

| Function | Description |
|----------|-------------|
| `contains(haystack, needle)` | Case-insensitive substring check |
| `startsWith(s, prefix)` | Case-insensitive prefix check |
| `endsWith(s, suffix)` | Case-insensitive suffix check |
| `length(x)` | Length of string, array, or object keys |

### Control Helpers

| Function | Description |
|----------|-------------|
| `always()` | Always returns `true` |
| `success()` | Returns `true` |
| `failure()` | Returns `false` |

### Issue/File Matching Helpers

| Function | Description |
|----------|-------------|
| `hasIssue(issues, field, value)` | Check if any issue has a field matching value |
| `countIssues(issues, field, value)` | Count issues matching field/value |
| `hasFileMatching(issues, pattern)` | Check if any issue affects a file matching pattern |
| `hasIssueWith(issues, field, value)` | Alias for `hasIssue` |
| `hasFileWith(issues, pattern)` | Alias for `hasFileMatching` |

### Permission Helpers

| Function | Description |
|----------|-------------|
| `hasMinPermission(level)` | Check if author has at least the specified permission level |
| `isOwner()` | Check if author is repository owner |
| `isMember()` | Check if author is organization member |
| `isCollaborator()` | Check if author is collaborator |
| `isContributor()` | Check if author has contributed before |
| `isFirstTimer()` | Check if author is a first-time contributor |

### Debugging

| Function | Description |
|----------|-------------|
| `log(...args)` | Print debug output prefixed with emoji (see [Debugging Guide](./debugging.md)) |

## Configuration Priority and Inheritance

1. **Step-specific conditions** override global conditions with the same name
2. **Global conditions** apply to all steps unless specifically overridden
3. **Multiple conditions** are evaluated independently - any true condition triggers a failure

## Interaction with Criticality

Failure conditions (`fail_if`) and design-by-contract (`assume`, `guarantee`) work together with criticality:

- **Critical steps** (external/control-plane/policy):
  - Require meaningful `assume` and `guarantee`.
  - `continue_on_failure: false` by default; dependents skip when this step fails.
  - Retries only for transient provider faults; no auto-retry for logical failures (`fail_if`/`guarantee`).
- **Non-critical steps**:
  - Contracts recommended; may allow `continue_on_failure: true`.
  - Same retry bounds; tolerant gating.

See [Fault Management and Contracts](./guides/fault-management-and-contracts.md) for the full policy checklist and examples.

## Backward Compatibility

The system maintains full backward compatibility with both `fail_if` and `failure_conditions`:

```yaml
# Simple fail_if (recommended)
version: "1.0"
fail_if: "criticalIssues > 0"

steps:
  security:
    type: ai
    prompt: "Security analysis..."
    on:
      - pr_opened
      - pr_updated
    fail_if: "errorIssues >= 1"

# Legacy failure_conditions (still supported)
version: "1.0"
failure_conditions:
  default_critical:
    condition: "criticalIssues > 0"
    message: "Critical issues found"
    severity: error

steps:
  security:
    type: ai
    prompt: "Security analysis..."
    on:
      - pr_opened
      - pr_updated
    failure_conditions:
      security_specific: "errorIssues >= 1"
```

## Migration Guide

### Migrating from `failure_conditions` to `fail_if`

If you have existing `failure_conditions` configurations, migrate them to `fail_if`:

**Before (legacy):**
```yaml
failure_conditions:
  critical_blocker:
    condition: "metadata.criticalIssues > 0"
    message: "Critical issues found"
    severity: error
  quality_gate:
    condition: "metadata.totalIssues > 10"
    severity: warning
```

**After (recommended):**
```yaml
# Simple condition - just use fail_if
fail_if: "criticalIssues > 0 || totalIssues > 10"
```

If you need the `halt_execution` feature, keep using the complex form:
```yaml
failure_conditions:
  critical_blocker:
    condition: "criticalIssues > 0"
    message: "Critical issues found"
    severity: error
    halt_execution: true
```

### Step-by-Step Migration

1. Replace `metadata.criticalIssues` with `criticalIssues` (legacy variables still work)
2. Replace `hasIssueWith` with `hasIssue` (both work, but `hasIssue` is clearer)
3. Use `fail_if` string instead of `failure_conditions` object when possible
4. Test with `--debug` flag to verify expressions evaluate correctly

### Testing Your Conditions

Use debug mode to test conditions and refine expressions:

```bash
visor --config your-config.yaml --debug
```

You can also use the `log()` helper in expressions:
```yaml
fail_if: |
  log("Issues:", issues);
  log("Critical count:", criticalIssues);
  criticalIssues > 0
```

## Complex Failure Condition Options

When using the object syntax, these options are available:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `condition` | string | required | JavaScript expression to evaluate |
| `message` | string | - | Human-readable message when condition triggers |
| `severity` | string | `"error"` | Severity level: `error`, `warning`, or `info` |
| `halt_execution` | boolean | `false` | If `true`, stops all workflow execution immediately |

## Related Documentation

- [Fail If](./fail-if.md) - Recommended simple syntax for failure conditions
- [Author Permissions](./author-permissions.md) - Permission helper functions
- [Debugging Guide](./debugging.md) - Using `log()` and debugging techniques
- [Memory](./memory.md) - Memory store access in expressions
- [Fault Management and Contracts](./guides/fault-management-and-contracts.md) - Criticality and contracts
