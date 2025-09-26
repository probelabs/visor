## 📋 Schema-Template System

Visor pairs JSON Schemas (data shape) with Liquid templates (rendering) so outputs are predictable, auditable, and GitHub‑native.

### Overview
- Schema validates check output at runtime (via AJV)
- Template renders tables/markdown and GitHub Checks annotations
- Group controls which GitHub comment a check posts to

### Quick Example

```yaml
checks:
  security:
    type: ai
    group: code-review
    schema: code-review
    prompt: "Review for security issues and return JSON"

  overview:
    type: ai
    group: summary
    schema: text
    prompt: "Summarize PR in markdown"
```

### Built-in Schemas
- code-review: structured findings with severity, file, line → native annotations
- text: free‑form markdown content (no annotations)

### Grouping

```yaml
checks:
  security:   { group: code-review }
  performance:{ group: code-review }
  overview:   { group: summary }
  assistant:  { group: dynamic } # always creates a new comment
```

### Custom Schemas

```yaml
schemas:
  custom-metrics:
    file: ./schemas/metrics.json

checks:
  metrics:
    schema: custom-metrics
    group: metrics
```

### GitHub Checks API Compatibility

For status checks and annotations, use structured output with `issues[]` having:
- severity: critical | error | warning | info
- file, line, message

Unstructured (none/plain) → posted as-is, no status checks.

### Enhanced Prompts
- Smart auto‑detection, Liquid templating, file‑based prompts
- Template context: `pr`, `files`, `event`, `outputs`, `utils`
- See [Liquid Templates Guide](./liquid-templates.md) for available variables and filters

See full examples in `defaults/.visor.yaml`.

