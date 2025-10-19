## 📊 Step Dependencies & Intelligent Execution

Visor supports defining dependencies between checks using `depends_on`. This enables:

- Sequential execution: dependents wait for prerequisites to finish
- Parallel optimization: independent checks run simultaneously
- Smart scheduling: automatic topological ordering

### Configuration Example

```yaml
version: "1.0"
steps:
  security:
    type: ai
    group: code-review
    schema: code-review
    prompt: "Comprehensive security analysis..."
    tags: ["security", "critical", "comprehensive"]
    on: [pr_opened, pr_updated]
    # No dependencies - runs first

  performance:
    type: ai
    group: code-review
    schema: code-review
    prompt: "Performance analysis..."
    tags: ["performance", "fast", "local", "remote"]
    on: [pr_opened, pr_updated]
    # No dependencies - runs parallel with security

  style:
    type: ai
    group: code-review
    schema: code-review
    prompt: "Style analysis based on security findings..."
    tags: ["style", "fast", "local"]
    on: [pr_opened]
    depends_on: [security]  # Waits for security to complete

  architecture:
    type: ai
    group: code-review
    schema: code-review
    prompt: "Architecture analysis building on previous checks..."
    on: [pr_opened, pr_updated]
    depends_on: [security, performance]
```

### Execution Flow

1. Level 0: `security` and `performance` run in parallel
2. Level 1: `style` runs after `security`
3. Level 2: `architecture` runs after both

### Advanced Patterns

#### Diamond Dependency
```yaml
steps:
  foundation: { type: ai, group: base, schema: code-review, prompt: "Base analysis" }
  branch_a:   { type: ai, group: code-review, schema: code-review, depends_on: [foundation] }
  branch_b:   { type: ai, group: code-review, schema: code-review, depends_on: [foundation] }
  final:      { type: ai, group: summary, schema: markdown, depends_on: [branch_a, branch_b] }
```

#### Multiple Independent Chains
```yaml
steps:
  security_basic:     { type: ai, group: security,    schema: code-review }
  security_advanced:  { type: ai, group: security,    schema: code-review, depends_on: [security_basic] }
  performance_basic:  { type: ai, group: performance, schema: code-review }
  performance_advanced:{ type: ai, group: performance, schema: code-review, depends_on: [performance_basic] }
  integration:        { type: ai, group: summary,     schema: markdown, depends_on: [security_advanced, performance_advanced] }
```

### Error Handling

- Cycle detection and missing dependency validation
- Failed checks don’t block independent branches
- Dependency results are available to dependents via `outputs`

