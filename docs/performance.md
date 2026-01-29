# Performance and Cost Controls

This guide covers configuration options and best practices for optimizing Visor execution speed, resource usage, and AI API costs.

## Parallelism Configuration

### max_parallelism Option

Controls how many checks run simultaneously. Higher values speed up execution but increase resource usage and may hit API rate limits.

**YAML Configuration:**

```yaml
version: "1.0"

# Global parallelism setting
max_parallelism: 5

steps:
  security:
    type: ai
    prompt: "Security analysis..."

  performance:
    type: ai
    prompt: "Performance analysis..."

  style:
    type: ai
    prompt: "Style analysis..."
```

**CLI Flag:**

```bash
# Run up to 5 checks in parallel
visor --max-parallelism 5

# Conservative single-threaded execution
visor --max-parallelism 1

# Default: 3 in CLI mode
visor --config .visor.yaml
```

**Defaults:**
- CLI mode: 3
- GitHub Action: 1 (conservative for stability)

**Recommendations:**
- Start with the default (3) and increase if you have many independent checks
- Reduce to 1 when debugging to get clearer logs
- Consider AI provider rate limits when increasing parallelism
- For checks using `reuse_ai_session`, parallelism is constrained by session dependencies

### GitHub Action Configuration

```yaml
- uses: probelabs/visor@v1
  with:
    max-parallelism: 3
  env:
    GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
```

## Fail Fast Mode

Stop execution immediately when any check fails, saving time and API costs when early failures indicate deeper problems.

**YAML Configuration:**

```yaml
version: "1.0"

fail_fast: true

steps:
  lint:
    type: command
    exec: npm run lint

  security:
    type: ai
    prompt: "Security analysis..."
    depends_on: [lint]
```

**CLI Flag:**

```bash
# Stop on first failure
visor --fail-fast

# Continue despite failures (default)
visor
```

**Use Cases:**
- CI pipelines where any failure blocks the PR
- Fast feedback during local development
- Cost control when running expensive AI checks

**Example: Progressive Pipeline with Fail Fast**

```yaml
version: "1.0"

fail_fast: true

steps:
  # Stage 1: Fast, cheap checks first
  format-check:
    type: command
    exec: npm run format:check
    tags: [fast, local]

  lint:
    type: command
    exec: npm run lint
    tags: [fast, local]

  # Stage 2: Expensive AI checks only if basics pass
  security-analysis:
    type: ai
    depends_on: [lint, format-check]
    prompt: "Deep security analysis..."
    tags: [expensive, security]
```

## Tag Filtering for Selective Execution

Use tags to run only the checks you need, reducing execution time and costs.

**Configuration:**

```yaml
version: "1.0"

steps:
  quick-security:
    type: ai
    prompt: "Quick security scan..."
    tags: [fast, local, security]

  deep-security:
    type: ai
    prompt: "Comprehensive security analysis..."
    tags: [slow, comprehensive, security]

  performance:
    type: ai
    prompt: "Performance analysis..."
    tags: [fast, performance]
```

**CLI Usage:**

```bash
# Run only fast checks (great for pre-commit)
visor --tags fast

# Run security checks but skip slow ones
visor --tags security --exclude-tags slow

# Run comprehensive checks (for CI)
visor --tags comprehensive
```

**GitHub Action:**

```yaml
jobs:
  fast-checks:
    steps:
      - uses: probelabs/visor@v1
        with:
          tags: "fast,local"
          exclude-tags: "experimental"
```

**Best Practices:**
- Tag fast checks with `local` or `fast` for pre-commit hooks
- Tag expensive checks with `comprehensive` or `slow` for nightly builds
- Use `--exclude-tags experimental` to skip untested checks

For detailed tag filtering patterns, see [Tag Filtering](./tag-filtering.md).

## AI Session Reuse

Reuse AI conversation sessions across dependent checks to reduce API calls and improve context continuity.

**Configuration:**

```yaml
version: "1.0"

steps:
  security:
    type: ai
    prompt: "Analyze code for security vulnerabilities..."

  security-remediation:
    type: ai
    prompt: "Based on our security analysis, provide remediation guidance."
    depends_on: [security]
    reuse_ai_session: true  # Reuses session from 'security'
    session_mode: clone     # Independent copy (default)

  security-verify:
    type: ai
    prompt: "Verify the remediation suggestions."
    depends_on: [security-remediation]
    reuse_ai_session: true
    session_mode: append    # Shared conversation thread
```

**Session Modes:**
- `clone` (default): Independent copy of conversation history
- `append`: Shared conversation thread for multi-turn dialogs

**Benefits:**
- Reduces total API calls by continuing conversations
- Maintains context for follow-up analysis
- Improves response quality through conversation continuity

**Self-Session Reuse for Chat Loops:**

```yaml
steps:
  chat-assistant:
    type: ai
    reuse_ai_session: self  # Reuse own session on retry
    session_mode: append
    prompt: "Process user request..."
    on_success:
      goto_js: |
        return needsMoreInput ? 'chat-assistant' : null;
```

For detailed AI session configuration, see [Advanced AI Features](./advanced-ai.md).

## Timeout Configuration

Set per-check timeouts to prevent runaway execution and control costs.

**Per-Check Timeout:**

```yaml
steps:
  fetch-data:
    type: command
    timeout: 120  # seconds for command provider
    exec: curl -s https://api.example.com/data

  ai-analysis:
    type: ai
    ai:
      timeout: 60000  # milliseconds for AI provider
    prompt: "Analyze the data..."
```

**CLI Global Timeout:**

```bash
# 5-minute timeout for all operations
visor --timeout 300000
```

**Provider-Specific Units:**
| Provider | Units | Default |
|----------|-------|---------|
| command | seconds | 60 |
| http_client | milliseconds | varies |
| ai | milliseconds | CLI --timeout or provider default |

**Timeout Behavior:**
- Timed-out checks fail with a timeout error
- Dependent checks are skipped with `dependency_failed` reason
- Use `continue_on_failure: true` to allow dependents to proceed anyway

For detailed timeout configuration, see [Timeouts](./timeouts.md).

## Execution Limits

Protect against infinite loops and runaway execution with run caps.

**Global Limit:**

```yaml
version: "1.0"

limits:
  max_runs_per_check: 50  # Default, applies to all checks
```

**Per-Check Override:**

```yaml
steps:
  retry-loop:
    type: ai
    max_runs: 10  # Tighter limit for this check
    prompt: "Process with retry..."
    on_fail:
      retry:
        max: 5

  infinite-safe:
    type: command
    max_runs: 0  # Disable limit (use with caution)
    exec: echo "No limit"
```

**Behavior:**
- Counter tracked per check, per scope (for forEach items)
- Exceeding limit fails the check with `limits/max_runs_exceeded` error
- Works alongside `routing.max_loops` for comprehensive protection

For detailed limit configuration, see [Execution Limits](./limits.md).

## Dependency-Driven Parallelism

The execution engine automatically parallelizes independent checks based on the dependency graph (DAG).

**Example:**

```yaml
steps:
  # Level 0: Run in parallel
  security:
    type: ai
    prompt: "Security analysis..."

  performance:
    type: ai
    prompt: "Performance analysis..."

  lint:
    type: command
    exec: npm run lint

  # Level 1: Runs after security completes
  security-report:
    type: ai
    depends_on: [security]
    prompt: "Generate security report..."

  # Level 2: Runs after all of the above
  final-summary:
    type: ai
    depends_on: [security-report, performance, lint]
    prompt: "Generate final summary..."
```

**Execution Flow:**
1. Level 0: `security`, `performance`, `lint` run in parallel (up to max_parallelism)
2. Level 1: `security-report` runs when `security` completes
3. Level 2: `final-summary` runs when all dependencies complete

**Optimization Tips:**
- Structure independent checks without dependencies to maximize parallelism
- Use `depends_on` only when output from one check is needed by another
- Group related checks with shared dependencies to batch their execution

For detailed dependency configuration, see [Dependencies](./dependencies.md).

## Cost Control Strategies

### 1. Use Cheaper Models for Fast Checks

```yaml
steps:
  quick-lint:
    type: ai
    ai:
      provider: google
      model: gemini-1.5-flash  # Faster, cheaper
    prompt: "Quick syntax and style check..."
    tags: [fast, cheap]

  deep-security:
    type: ai
    ai:
      provider: anthropic
      model: claude-sonnet-4-20250514  # More capable, more expensive
    prompt: "Comprehensive security analysis..."
    tags: [comprehensive, expensive]
```

### 2. Session Reuse to Reduce API Calls

```yaml
steps:
  initial-analysis:
    type: ai
    prompt: "Analyze the codebase..."

  follow-up-1:
    type: ai
    depends_on: [initial-analysis]
    reuse_ai_session: true  # Continues conversation, no new context upload
    prompt: "Based on your analysis, what are the security concerns?"

  follow-up-2:
    type: ai
    depends_on: [follow-up-1]
    reuse_ai_session: true
    prompt: "Suggest fixes for those concerns."
```

### 3. Tag-Based Selective Execution

```yaml
# Local development: fast, cheap checks only
visor --tags fast,local

# CI on feature branches: moderate checks
visor --tags local,remote --exclude-tags comprehensive

# CI on main branch: full analysis
visor --tags comprehensive
```

### 4. Fail Fast with Progressive Checks

```yaml
version: "1.0"

fail_fast: true

steps:
  # Free/cheap checks first
  syntax-check:
    type: command
    exec: npm run lint

  # Moderate cost
  basic-security:
    type: ai
    ai:
      model: gemini-1.5-flash
    depends_on: [syntax-check]
    prompt: "Basic security scan..."

  # Expensive - only if basics pass
  deep-analysis:
    type: ai
    ai:
      model: claude-sonnet-4-20250514
    depends_on: [basic-security]
    prompt: "Deep code analysis..."
```

### 5. Conditional Execution with `if`

```yaml
steps:
  expensive-check:
    type: ai
    if: "filesChanged.some(f => f.endsWith('.ts'))"
    prompt: "TypeScript-specific analysis..."
```

## CI Optimization Tips

### Cache Dependencies

```yaml
# GitHub Actions
- uses: actions/setup-node@v4
  with:
    node-version: '20'
    cache: npm  # Cache npm dependencies
```

### Environment-Specific Configurations

```yaml
# .visor.yaml - Base configuration
version: "1.0"

steps:
  security:
    type: ai
    prompt: "Security analysis..."
    tags: [security]

# .visor.ci.yaml - CI overrides
version: "1.0"
extends: .visor.yaml

max_parallelism: 5
fail_fast: true
tag_filter:
  include: [security, performance]
  exclude: [experimental]
```

```bash
# Use CI config
visor --config .visor.ci.yaml
```

## Related Documentation

- [Tag Filtering](./tag-filtering.md) - Detailed tag-based execution patterns
- [Advanced AI Features](./advanced-ai.md) - Session reuse and AI configuration
- [Timeouts](./timeouts.md) - Per-check and global timeout configuration
- [Execution Limits](./limits.md) - Run caps and loop protection
- [Dependencies](./dependencies.md) - Dependency graph and parallel execution
- [Configuration](./configuration.md) - Complete configuration reference
- [Failure Routing](./failure-routing.md) - Retry policies and error handling
