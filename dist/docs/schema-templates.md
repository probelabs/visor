## Schema-Template System

Visor pairs JSON Schemas (data shape) with Liquid templates (rendering) so outputs are predictable, auditable, and GitHub-native.

### Overview
- Schema validates check output at runtime (via AJV)
- Template renders tables/markdown and GitHub Checks annotations
- Group controls which GitHub comment a check posts to

### Quick Example

```yaml
steps:
  security:
    type: ai
    group: code-review
    schema: code-review
    prompt: "Review for security issues and return JSON"

  overview:
    type: ai
    group: summary
    schema: overview
    prompt: "Summarize PR in markdown"
```

### Built-in Schemas

| Schema | Description | Output Structure |
|--------|-------------|------------------|
| `code-review` | Structured findings with severity, file, line | `{ issues: [...] }` with GitHub annotations |
| `plain` | Free-form markdown/text content | `{ content: "..." }` |
| `overview` | PR summary with optional metadata tags | `{ text: "...", tags: {...} }` |
| `issue-assistant` | Issue triage with intent classification | `{ text: "...", intent: "...", labels: [...] }` |

### Grouping

Checks with the same `group` value are consolidated into a single GitHub comment:

```yaml
steps:
  security:   { group: code-review }
  performance:{ group: code-review }
  overview:   { group: summary }
  assistant:  { group: dynamic } # always creates a new comment
```

The special `dynamic` group creates a unique comment for each execution.

### Custom Schemas

You can use custom schemas in three ways:

**1. File path reference:**
```yaml
steps:
  metrics:
    schema: ./schemas/metrics.json
    group: metrics
```

**2. Inline JSON Schema object:**
```yaml
steps:
  custom-check:
    schema:
      type: object
      required: [result]
      properties:
        result:
          type: string
```

**3. With custom template:**
```yaml
steps:
  metrics:
    schema: ./schemas/metrics.json
    template:
      file: ./templates/metrics.liquid
    # Or inline template content:
    # template:
    #   content: "{{ output.result }}"
```

### GitHub Checks API Compatibility

For status checks and annotations, use structured output with `issues[]` having:
- `severity`: `warning` | `error` | `critical`
- `file`: path relative to repository root
- `line`: line number (required)
- `message`: description of the issue

Optional fields: `endLine`, `ruleId`, `category`, `suggestion`, `replacement`.

Unstructured schemas (`plain`) are posted as-is without status check annotations.

### Enhanced Prompts
- Smart auto-detection, Liquid templating, file-based prompts
- Template context: `pr`, `files`, `event`, `outputs`, `utils`
- See [Liquid Templates Guide](./liquid-templates.md) for available variables and filters

See full examples in `defaults/visor.yaml`.

