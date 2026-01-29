# Noop Provider

The `noop` (no-operation) provider is a utility provider that does not perform any analysis or execution. It is designed for workflow orchestration, flow control, and dependency coordination.

## Overview

The noop provider serves as a structural element in workflows where you need:

- **Command orchestration**: Trigger multiple checks through dependencies without performing analysis
- **Flow control hubs**: Create synchronization points in complex workflows
- **Conditional routing**: Make routing decisions based on upstream outputs
- **Output aggregation**: Wait for multiple parallel checks to complete before continuing
- **Quality gates**: Validate workflow state and fail conditionally

Since noop checks always succeed (unless `fail_if` is specified), they are ideal for control flow without side effects.

## Configuration

### Basic Usage

```yaml
steps:
  sync-point:
    type: noop
    depends_on: [check-a, check-b, check-c]
```

### Full Configuration Options

```yaml
steps:
  orchestration-hub:
    type: noop

    # Standard check options
    depends_on: [upstream-check-1, upstream-check-2]
    on: [pr_opened, pr_updated]
    if: "conditions.are_met"
    group: orchestration
    tags: ["workflow", "sync"]

    # Conditional failure
    fail_if: |
      // JavaScript expression returning boolean
      return outputs['upstream-check'].failed === true;

    # Lifecycle hooks for routing
    on_success:
      run: [next-step-1, next-step-2]
      goto: previous-step
      goto_event: pr_updated
      goto_js: |
        return outputs.history['sync-point'].length === 1 ? 'start' : null;
      transitions:
        - when: "outputs['score'].value >= 90"
          to: fast-path
        - when: "true"
          to: standard-path

    on_fail:
      run: [error-handler]
      retry:
        max: 2
        backoff:
          mode: exponential
          delay_ms: 1000
```

### Supported Configuration Keys

| Key | Type | Description |
|-----|------|-------------|
| `type` | string | Must be `"noop"` |
| `command` | string | Optional command trigger (e.g., `/review`) |
| `depends_on` | array | Steps that must complete before this runs |
| `on` | array | Events that trigger this check |
| `if` | string | Conditional expression for execution |
| `fail_if` | string | JavaScript expression that causes failure when true |
| `group` | string | Group for output organization |
| `tags` | array | Tags for filtering and categorization |
| `on_success` | object | Routing actions when check succeeds |
| `on_fail` | object | Routing actions when check fails |

## Use Cases

### 1. Flow Control Hub

Create a synchronization point that waits for multiple parallel checks to complete:

```yaml
steps:
  # Parallel checks
  security-scan:
    type: ai
    prompt: Scan for security issues

  performance-check:
    type: ai
    prompt: Analyze performance

  style-review:
    type: ai
    prompt: Check code style

  # Synchronization point - waits for all parallel checks
  all-checks-complete:
    type: noop
    depends_on: [security-scan, performance-check, style-review]

  # Continues after all checks complete
  generate-summary:
    type: ai
    depends_on: [all-checks-complete]
    prompt: |
      Summarize findings from:
      - Security: {{ outputs['security-scan'] | json }}
      - Performance: {{ outputs['performance-check'] | json }}
      - Style: {{ outputs['style-review'] | json }}
```

### 2. Conditional Routing

Use noop with `on_success.transitions` for declarative routing decisions:

```yaml
steps:
  analyze-pr:
    type: ai
    prompt: Analyze this PR and provide a risk score (0-100)
    transform_js: "JSON.parse(output)"

  route-by-risk:
    type: noop
    depends_on: [analyze-pr]
    on_success:
      transitions:
        - when: "outputs['analyze-pr'].risk_score >= 80"
          to: detailed-security-review
        - when: "outputs['analyze-pr'].risk_score >= 50"
          to: standard-review
        - when: "true"
          to: quick-approve

  detailed-security-review:
    type: ai
    prompt: Perform detailed security analysis
    on: []  # Only triggered via routing

  standard-review:
    type: ai
    prompt: Perform standard code review
    on: []

  quick-approve:
    type: command
    exec: echo "Low risk - approved"
    on: []
```

### 3. Output Aggregation

Collect results from multiple sources before proceeding:

```yaml
steps:
  # Multiple analysis checks run in parallel
  lint-js:
    type: command
    exec: eslint src/ --format json
    transform_js: JSON.parse(output)

  lint-css:
    type: command
    exec: stylelint "**/*.css" --formatter json
    transform_js: JSON.parse(output)

  type-check:
    type: command
    exec: tsc --noEmit --pretty false

  # Aggregation point
  aggregate-lint-results:
    type: noop
    depends_on: [lint-js, lint-css, type-check]

  # Access all results through outputs
  report-issues:
    type: log
    depends_on: [aggregate-lint-results]
    message: |
      ## Lint Results

      **JavaScript Issues:** {{ outputs['lint-js'] | size }}
      **CSS Issues:** {{ outputs['lint-css'] | size }}
      **Type Errors:** {{ outputs['type-check'].exitCode == 0 | default: "None" }}
```

### 4. Workflow Synchronization Points

Create named synchronization points for complex multi-stage workflows:

```yaml
steps:
  # Stage 1: Setup
  checkout:
    type: git-checkout
    ref: "{{ pr.head }}"

  install-deps:
    type: command
    depends_on: [checkout]
    exec: npm ci
    working_directory: "{{ outputs.checkout.path }}"

  stage-1-complete:
    type: noop
    depends_on: [install-deps]
    tags: ["stage", "setup"]

  # Stage 2: Build & Test (parallel)
  build:
    type: command
    depends_on: [stage-1-complete]
    exec: npm run build

  test-unit:
    type: command
    depends_on: [stage-1-complete]
    exec: npm test

  test-integration:
    type: command
    depends_on: [stage-1-complete]
    exec: npm run test:integration

  stage-2-complete:
    type: noop
    depends_on: [build, test-unit, test-integration]
    tags: ["stage", "build-test"]

  # Stage 3: Deploy
  deploy:
    type: command
    depends_on: [stage-2-complete]
    exec: npm run deploy
```

### 5. Quality Gates with fail_if

Use noop to enforce quality gates by failing based on upstream results:

```yaml
steps:
  run-tests:
    type: command
    exec: npm test -- --coverage --json
    transform_js: JSON.parse(output)

  check-coverage:
    type: script
    depends_on: [run-tests]
    content: |
      const coverage = outputs['run-tests'].coveragePercentage;
      return { coverage, threshold: 80 };

  coverage-gate:
    type: noop
    depends_on: [check-coverage]
    fail_if: |
      const result = outputs['check-coverage'];
      return result.coverage < result.threshold;

  # Only runs if coverage gate passes
  deploy-preview:
    type: command
    depends_on: [coverage-gate]
    exec: npm run deploy:preview
```

### 6. Retry Logic with Memory

Combine noop with memory to implement custom retry logic:

```yaml
steps:
  init-retry:
    type: memory
    operation: set
    key: retry_count
    value: 0

  flaky-operation:
    type: command
    depends_on: [init-retry]
    exec: ./flaky-script.sh
    on_fail:
      run: [increment-retry, check-retry-limit]

  increment-retry:
    type: memory
    operation: set
    key: retry_count
    value_js: "memory.get('retry_count') + 1"

  check-retry-limit:
    type: noop
    depends_on: [increment-retry]
    on_success:
      goto_js: |
        const retries = memory.get('retry_count');
        log('Retry attempt:', retries);
        return retries < 3 ? 'flaky-operation' : null;
```

### 7. Command Orchestration

Use noop to create command-triggered workflows:

```yaml
steps:
  # Triggered by /review comment
  review-command:
    type: noop
    command: /review
    on: [issue_comment]
    on_success:
      run: [security-check, performance-check, style-check]

  security-check:
    type: ai
    prompt: Security analysis
    on: []  # Only via routing

  performance-check:
    type: ai
    prompt: Performance analysis
    on: []

  style-check:
    type: ai
    prompt: Style analysis
    on: []
```

### 8. Error Collection and Final Validation

Use noop to validate collected errors at the end of a workflow:

```yaml
steps:
  init-errors:
    type: memory
    operation: set
    key: errors
    value: []

  lint:
    type: command
    depends_on: [init-errors]
    exec: npm run lint
    on_fail:
      run: [collect-lint-error]

  collect-lint-error:
    type: memory
    operation: append
    key: errors
    value:
      check: lint
      message: "{{ outputs['lint'].stderr }}"

  test:
    type: command
    depends_on: [init-errors]
    exec: npm test
    on_fail:
      run: [collect-test-error]

  collect-test-error:
    type: memory
    operation: append
    key: errors
    value:
      check: test
      message: "{{ outputs['test'].stderr }}"

  # Final validation - fail if any errors collected
  validate-no-errors:
    type: noop
    depends_on: [lint, test]
    fail_if: |
      const errors = memory.get('errors') || [];
      return errors.length > 0;
```

## Integration with Routing

The noop provider integrates seamlessly with Visor's routing system. Since it always succeeds (unless `fail_if` triggers), it's ideal for making routing decisions.

### Using goto for Re-execution

```yaml
steps:
  generate:
    type: ai
    prompt: Generate code

  validate:
    type: ai
    depends_on: [generate]
    prompt: Validate the generated code
    transform_js: JSON.parse(output)

  decide-retry:
    type: noop
    depends_on: [validate]
    on_success:
      goto_js: |
        const result = outputs['validate'];
        const attempts = outputs.history['generate'].length;

        // Retry up to 3 times if validation fails
        if (!result.valid && attempts < 3) {
          return 'generate';
        }
        return null;
```

### Using transitions for Declarative Routing

```yaml
steps:
  score-pr:
    type: ai
    prompt: Score this PR from 0-100
    transform_js: "({ score: parseInt(output) })"

  route-by-score:
    type: noop
    depends_on: [score-pr]
    on_success:
      transitions:
        - when: "outputs['score-pr'].score >= 90"
          to: auto-approve
        - when: "outputs['score-pr'].score >= 70"
          to: request-review
        - when: "outputs['score-pr'].score >= 50"
          to: request-changes
        - when: "true"
          to: block-merge
```

### Using run for Triggering Multiple Steps

```yaml
steps:
  analyze:
    type: ai
    prompt: Analyze code and categorize issues
    transform_js: JSON.parse(output)

  dispatch-handlers:
    type: noop
    depends_on: [analyze]
    on_success:
      run_js: |
        const analysis = outputs['analyze'];
        const handlers = [];

        if (analysis.hasSecurityIssues) handlers.push('handle-security');
        if (analysis.hasPerformanceIssues) handlers.push('handle-performance');
        if (analysis.hasStyleIssues) handlers.push('handle-style');

        return handlers;

  handle-security:
    type: ai
    prompt: Detail security issues
    on: []

  handle-performance:
    type: ai
    prompt: Detail performance issues
    on: []

  handle-style:
    type: ai
    prompt: Detail style issues
    on: []
```

## Integration with Lifecycle Hooks

Noop checks support all lifecycle hooks:

### on_init

```yaml
steps:
  orchestrator:
    type: noop
    on_init:
      run:
        - tool: fetch-config
          as: config
    on_success:
      run_js: |
        const config = outputs['config'];
        return config.enabledChecks || [];
```

### on_success / on_fail

```yaml
steps:
  quality-gate:
    type: noop
    depends_on: [all-checks]
    fail_if: "outputs['all-checks'].failed"

    on_success:
      run: [notify-success, deploy]

    on_fail:
      run: [notify-failure]
      goto: retry-point
```

## Best Practices

### 1. Use Descriptive Names

Name noop checks to describe their purpose in the workflow:

```yaml
steps:
  # Good - describes the purpose
  all-validations-complete:
    type: noop

  quality-gate-passed:
    type: noop

  # Avoid generic names
  sync:
    type: noop
```

### 2. Use Tags for Organization

Tag noop checks for filtering and documentation:

```yaml
steps:
  stage-1-complete:
    type: noop
    tags: ["stage", "setup", "sync-point"]

  stage-2-complete:
    type: noop
    tags: ["stage", "build", "sync-point"]
```

### 3. Document Complex Routing Logic

Add comments explaining routing decisions:

```yaml
steps:
  route-decision:
    type: noop
    depends_on: [analysis]
    on_success:
      # Route based on risk level:
      # - High risk (>=80): Full security review
      # - Medium risk (50-79): Standard review
      # - Low risk (<50): Auto-approve
      transitions:
        - when: "outputs['analysis'].risk >= 80"
          to: security-review
        - when: "outputs['analysis'].risk >= 50"
          to: standard-review
        - when: "true"
          to: auto-approve
```

### 4. Keep fail_if Expressions Simple

Complex validation logic should be in a script check:

```yaml
steps:
  # Good - simple fail_if
  gate:
    type: noop
    fail_if: "outputs['validate'].passed === false"

  # Better for complex logic - use script
  complex-validation:
    type: script
    content: |
      const results = outputs['checks'];
      const hasBlockers = results.some(r => r.severity === 'blocker');
      const failCount = results.filter(r => !r.passed).length;
      return { shouldFail: hasBlockers || failCount > 5 };

  gate:
    type: noop
    depends_on: [complex-validation]
    fail_if: "outputs['complex-validation'].shouldFail"
```

### 5. Use noop for Aggregation Points in Workflows

When creating reusable workflows, use noop to define clear aggregation points:

```yaml
# In workflow file
steps:
  check-1:
    type: ai
    prompt: First check

  check-2:
    type: ai
    prompt: Second check

  check-3:
    type: ai
    prompt: Third check

  # Clear aggregation point for workflow consumers
  aggregate-results:
    type: noop
    depends_on: [check-1, check-2, check-3]
    # Workflow outputs reference this point

outputs:
  - name: all_complete
    value_js: "true"  # Signals all checks completed
```

## Troubleshooting

### Problem: Noop Check Not Running

**Solution**: Check that dependencies are met and event triggers match:

```yaml
steps:
  my-noop:
    type: noop
    depends_on: [upstream]  # Ensure upstream exists and succeeds
    on: [pr_opened]         # Ensure event matches
    if: "true"              # Check conditional
```

### Problem: fail_if Not Triggering

**Solution**: Verify the JavaScript expression and output access:

```yaml
steps:
  debug-gate:
    type: noop
    fail_if: |
      // Add logging to debug
      log('Outputs:', JSON.stringify(outputs['check']));
      return outputs['check']?.failed === true;
```

### Problem: Routing Not Working

**Solution**: Check that target steps have `on: []` to be routing-only:

```yaml
steps:
  router:
    type: noop
    on_success:
      run: [target-step]

  target-step:
    type: command
    exec: echo "routed"
    on: []  # Required for routing-only steps
```

## Related Documentation

- [Lifecycle Hooks](../lifecycle-hooks.md) - on_init, on_success, on_fail, on_finish hooks
- [Failure Routing](../failure-routing.md) - Routing and retry configuration
- [Workflows](../workflows.md) - Creating reusable workflows
- [Memory](../memory.md) - Persistent state across checks
- [Dependencies](../dependencies.md) - Dependency configuration
- [Configuration](../configuration.md) - Full configuration reference
