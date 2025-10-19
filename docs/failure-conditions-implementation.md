# Enhanced Failure Condition System for Visor

This document provides a complete overview of the enhanced failure condition configuration system implemented for the Visor code review tool.

## Overview

The enhanced failure condition system allows users to define flexible, powerful conditions using JavaScript expressions that determine when code reviews should fail or generate warnings. It supports both global conditions (applied to all checks) and check-specific conditions, with comprehensive metadata access.

## Architecture

### Key Components

1. **FailureConditionEvaluator** (`src/failure-condition-evaluator.ts`)
   - Core expression evaluation engine using Function Constructor with custom helper functions
   - Processes conditions and generates structured results

2. **Enhanced Configuration Types** (`src/types/config.ts`)
   - TypeScript interfaces for failure conditions
   - Context object definition for expression evaluation

3. **CheckExecutionEngine Integration** (`src/check-execution-engine.ts`)
   - Integration with existing check execution pipeline
   - Automated evaluation after check completion

## Configuration Schema

### Simple Conditions (String Format)
```yaml
failure_conditions:
  critical_blocker: "metadata.criticalIssues > 0"
  quality_gate: "metadata.totalIssues > 10"
```

### Complex Conditions (Object Format)
```yaml
failure_conditions:
  deployment_blocker:
    condition: "metadata.criticalIssues > 0"
    message: "Critical issues block deployment"
    severity: error
    halt_execution: true
```

### Check-Specific Conditions
```yaml
steps:
  security:
    type: ai
    prompt: "Security analysis..."
    on: [pr_opened, pr_updated]
    failure_conditions:
      security_gate: "metadata.errorIssues >= 1"
```

## JavaScript Expression Context

The context object available to all JavaScript expressions (evaluated in a secure sandbox) includes:

```typescript
{
  // Check results
  issues: Issue[],           // Array of found issues

  // Aggregated metadata
  metadata: {
    checkName: string,       // e.g., "security-check"
    schema: string,          // e.g., "code-review", "plain"
    group: string,           // e.g., "security-analysis"
    totalIssues: number,
    criticalIssues: number,
    errorIssues: number,
    warningIssues: number,
    infoIssues: number
  },

  // Debug information (if available)
  debug: {
    errors: string[],
    processingTime: number,
    provider: string,
    model: string
  }
}
```

## Available Helper Functions

### Issue Analysis
- `hasIssueWith(issues, field, value)` - Check if any issue has field matching value
- `countIssues(issues, field, value)` - Count issues with field matching value
- `hasFileWith(issues, text)` - Check if any issue file path contains text

## Example Use Cases

### Basic Quality Gates
```yaml
failure_conditions:
  # Block on any critical issues
  critical_blocker: "metadata.criticalIssues > 0"

  # Warn on too many issues
  quality_threshold: "metadata.totalIssues > 15"

  # Schema-specific rules
  code_review_gate: "metadata.schema == 'code-review' && metadata.errorIssues > 5"
```

### Security-Focused Conditions
```yaml
failure_conditions:
  # Critical security issues
  security_critical:
    condition: "hasIssueWith(issues, 'category', 'security') && hasIssueWith(issues, 'severity', 'critical')"
    message: "Critical security vulnerabilities detected"
    severity: error
    halt_execution: true

  # Sensitive file changes
  sensitive_files:
    condition: "hasFileWith(issues, 'auth') || hasFileWith(issues, 'password')"
    message: "Changes in sensitive files require extra review"
    severity: warning
```

### Performance Monitoring
```yaml
failure_conditions:
  # Slow analysis with issues
  performance_concern:
    condition: "debug && debug.processingTime > 30000 && metadata.errorIssues > 2"
    message: "Analysis was slow and found multiple issues"
    severity: info

  # Database-related issues
  database_issues:
    condition: "hasFileWith(issues, 'database') && hasIssueWith(issues, 'category', 'performance')"
    message: "Database performance issues detected"
    severity: warning
```

## Implementation Details

### Priority and Inheritance
1. **Check-specific conditions** override global conditions with the same name
2. **Global conditions** apply to all checks unless specifically overridden
3. **Multiple conditions** are evaluated independently

### Error Handling
- Malformed JavaScript expressions result in error-level condition results
- Missing helper functions gracefully degrade to basic JavaScript evaluation
- All evaluation errors are captured and reported

### Performance Considerations
- JavaScript evaluation in sandbox is fast for typical expressions
- Helper functions are optimized for common use cases
- Condition evaluation happens after check completion (non-blocking)

## Integration Points

### CheckExecutionEngine
```typescript
// Evaluate conditions after check completion
const results = await engine.evaluateFailureConditions(
  checkName,
  reviewSummary,
  config
);

// Check if execution should halt
if (FailureConditionEvaluator.shouldHaltExecution(results)) {
  // Handle execution halt
}
```

### GitHub Action Integration
Failure conditions can be used to:
- Set action exit codes
- Control PR approval requirements
- Generate status check results
- Customize comment formatting

### CLI Integration
- Display failure condition results in CLI output
- Use for exit code determination
- Support debug mode for condition testing

## Migration Guide

### From Basic Configuration
```yaml
# Before
steps:
  security:
    type: ai
    prompt: "Security analysis..."
    on: [pr_opened]

# After - add failure conditions
failure_conditions:
  critical_gate: "metadata.criticalIssues > 0"

steps:
  security:
    type: ai
    prompt: "Security analysis..."
    group: security-analysis
    schema: code-review
    on: [pr_opened]
    failure_conditions:
      security_specific: "metadata.errorIssues >= 1"
```

### Testing Conditions
1. Use debug mode to see evaluation results
2. Start with simple conditions and gradually add complexity
3. Test with various issue scenarios
4. Validate JavaScript expressions before deployment

## Best Practices

### Condition Design
- Start with simple metadata-based conditions
- Use descriptive condition names
- Include helpful messages for complex conditions
- Consider whether conditions should halt execution

### Organization
- Group related conditions logically
- Use global conditions for organization-wide policies
- Override with check-specific conditions for specialized rules
- Document complex expressions with comments

### Performance
- Prefer metadata conditions over issue iteration
- Use helper functions for common patterns
- Avoid overly complex nested expressions
- Test condition performance with large result sets

## Testing

### Unit Tests
- Comprehensive coverage of FailureConditionEvaluator
- Test various JavaScript expression patterns
- Validate helper function behavior
- Error handling scenarios

### Integration Tests
- End-to-end condition evaluation in CheckExecutionEngine
- Configuration loading and validation
- Real-world scenario testing
- Backward compatibility verification

## Future Enhancements

### Potential Additions
- Time-based conditions (e.g., business hours)
- Environment-specific conditions (e.g., production vs staging)
- Team-based conditions (e.g., author experience level)
- Historical trend analysis (e.g., issue count over time)

### Advanced Features
- Condition templates and reusable expressions
- Dynamic condition loading from external sources
- Conditional condition evaluation based on PR metadata
- Integration with external policy engines

## Summary

The enhanced failure condition system provides a flexible, powerful foundation for implementing custom quality gates and policies in Visor. By leveraging JavaScript expressions (evaluated in a secure sandbox) with comprehensive context access, teams can create sophisticated review workflows that adapt to their specific needs and standards.

The system maintains full backward compatibility while opening new possibilities for automated code quality enforcement and intelligent review assistance.