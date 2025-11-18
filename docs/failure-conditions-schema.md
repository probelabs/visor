# Enhanced Failure Condition Configuration Schema

This document describes the enhanced failure condition configuration system for Visor that supports JavaScript expressions (evaluated in a secure sandbox) for flexible and powerful failure evaluation.

## YAML Configuration Schema

### Global Failure Conditions

```yaml
version: "1.0"

# Global failure conditions apply to all checks
failure_conditions:
  # Simple JavaScript expression for basic failure conditions
  critical_threshold: "metadata.criticalIssues > 0"

  # Complex conditions with multiple criteria
  security_gate: "metadata.checkName == 'security' && metadata.criticalIssues > 0"

  # Schema-based conditions
  code_review_quality: "metadata.schema == 'code-review' && metadata.totalIssues > 10"

  # Combined conditions with logical operators
  deployment_blocker: "metadata.criticalIssues > 0 || (metadata.errorIssues > 5 && metadata.checkName == 'security')"

# Alternative object syntax for more complex conditions
failure_conditions:
  critical_security_issues:
    condition: "metadata.criticalIssues > 0 && metadata.checkName == 'security'"
    message: "Critical security issues detected - deployment blocked"
    severity: "error"

  performance_degradation:
    condition: "metadata.checkName == 'performance' && metadata.errorIssues >= 3"
    message: "Performance issues detected that may impact production"
    severity: "warning"

  insufficient_coverage:
    condition: "metadata.schema == 'code-review' && metadata.totalIssues > 15"
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

    # Check-specific failure conditions override global ones
    failure_conditions:
      block_on_any_critical: "metadata.criticalIssues > 0"
      warn_on_multiple_errors: "metadata.errorIssues >= 2"

  performance:
    type: ai
    prompt: "Analyze performance implications..."
    group: review
    schema: code-review
    on:
      - pr_opened
      - pr_updated

    # Inherits global failure conditions unless overridden
    failure_conditions:
      performance_regression: "metadata.errorIssues > 1 && issues.some(i => i.category == 'performance')"
```

### Advanced JavaScript Expression Examples

```yaml
failure_conditions:
  # Issue analysis with helper functions
  sql_injection_check: "hasFileWith(issues, 'sql') && hasIssueWith(issues, 'severity', 'critical')"

  # Multiple file types analysis
  critical_files_affected: "hasFileWith(issues, '.ts') || hasFileWith(issues, '.js') && hasIssueWith(issues, 'severity', 'critical')"

  # Complex metadata-based conditions
  large_change_with_issues: "metadata.totalIssues > 5 && debug && debug.processingTime > 30000"

  # Schema and group combinations
  review_blocking_issues: "metadata.schema == 'code-review' && metadata.group == 'review' && metadata.criticalIssues > 0"

  # Time-based conditions (if debug info is available)
  slow_analysis_with_errors: "debug && debug.processingTime > 60000 && metadata.errorIssues > 0"

  # File-specific security checks
  sensitive_file_changes: "hasFileWith(issues, 'auth') || hasFileWith(issues, 'password') || hasFileWith(issues, 'secret')"

  # Count-based conditions
  multiple_security_issues: "countIssues(issues, 'category', 'security') >= 3"

  # Combined conditions
  critical_auth_issues: "hasFileWith(issues, 'auth') && countIssues(issues, 'severity', 'critical') > 0"
```

## Configuration Priority and Inheritance

1. **Check-specific conditions** override global conditions with the same name
2. **Global conditions** apply to all checks unless specifically overridden
3. **Built-in conditions** (if any) have the lowest priority
4. **Multiple conditions** are evaluated independently - any true condition triggers a failure

## Backward Compatibility

The enhanced system maintains full backward compatibility:

```yaml
# Legacy format (still supported)
version: "1.0"
steps:
  security:
    type: ai
    prompt: "Security analysis..."
    on:
      - pr_opened
      - pr_updated

# Enhanced format with failure conditions
version: "1.0"
failure_conditions:
  default_critical: "metadata.criticalIssues > 0"

steps:
  security:
    type: ai
    prompt: "Security analysis..."
    on:
      - pr_opened
      - pr_updated

## Interaction with Criticality

Failure conditions (`fail_if`) and design‑by‑contract (`assume`, `guarantee`) work together with criticality:

- Critical steps (external/control‑plane/policy):
  - Require meaningful `assume` and `guarantee`.
  - `continue_on_failure: false` by default; dependents skip when this step fails.
  - Retries only for transient provider faults; no auto‑retry for logical failures (`fail_if`/`guarantee`).
- Non‑critical steps:
  - Contracts recommended; may allow `continue_on_failure: true`.
  - Same retry bounds; tolerant gating.

See docs/guides/fault-management-and-contracts.md for the full policy checklist and examples.
    failure_conditions:
      security_specific: "metadata.errorIssues >= 1"
```

## Migration Guide

### Step 1: Add Global Conditions
```yaml
# Add to existing configuration
failure_conditions:
  critical_blocker: "metadata.criticalIssues > 0"
  quality_gate: "metadata.totalIssues > 10"
```

### Step 2: Add Check-Specific Conditions
```yaml
steps:
  security:
    # existing configuration...
    failure_conditions:
      security_gate: "metadata.errorIssues >= 1"
```

### Step 3: Test and Refine
Use debug mode to test conditions and refine expressions based on actual results.
