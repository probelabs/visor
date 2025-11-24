# Lifecycle Hooks

Lifecycle hooks allow you to execute preprocessing or setup tasks automatically before a step runs. This is particularly useful for enriching context, fetching external data, or preparing the environment.

## `on_init` Hook

The `on_init` hook runs **before** a step executes, allowing you to:
- Fetch external data (JIRA issues, metrics, configuration)
- Enrich AI prompts with additional context
- Execute setup tasks or validation
- Invoke custom tools, steps, or workflows

### Basic Usage

```yaml
steps:
  my-check:
    type: ai
    on_init:
      run:
        - tool: fetch-jira-issue
          with:
            issue_key: "PROJ-123"
          as: jira-data
    prompt: |
      Review this PR considering JIRA issue: {{ outputs['jira-data'] | json }}
```

### Features

#### 1. Multiple Invocations

Execute multiple tools, steps, or workflows in sequence:

```yaml
on_init:
  run:
    - tool: fetch-user-data
      as: users
    - tool: fetch-config
      as: config
    - workflow: validate-environment
      as: validation
```

#### 2. Custom Arguments

Pass arguments to tools and workflows using `with`:

```yaml
on_init:
  run:
    - tool: fetch-external-data
      with:
        source: metrics-api
        format: json
      as: metrics
```

#### 3. Custom Output Names

Store outputs with custom names using `as`:

```yaml
on_init:
  run:
    - tool: fetch-jira-issue
      with:
        issue_key: "PROJ-456"
      as: jira-context  # Access via {{ outputs['jira-context'] }}
```

#### 4. Dynamic Preprocessing

Use `run_js` for conditional preprocessing based on PR context:

```yaml
on_init:
  run_js: |
    const items = [];

    // Fetch JIRA only if PR title contains issue key
    const jiraMatch = pr.title.match(/PROJ-\d+/);
    if (jiraMatch) {
      items.push({
        tool: 'fetch-jira-issue',
        with: { issue_key: jiraMatch[0] },
        as: 'jira-data'
      });
    }

    // Fetch metrics if backend files changed
    if (files.some(f => f.filename.includes('backend/'))) {
      items.push({
        tool: 'fetch-metrics',
        as: 'backend-metrics'
      });
    }

    return items;
```

### Invocation Types

#### Tool Invocation

Execute a custom MCP tool:

```yaml
on_init:
  run:
    - tool: my-custom-tool
      with:
        param1: value1
      as: tool-output
```

#### Step Invocation

Execute another step:

```yaml
on_init:
  run:
    - step: preprocessing-step
      with:
        input: "{{ pr.title }}"
      as: preprocessed
```

#### Workflow Invocation

Execute a workflow:

```yaml
on_init:
  run:
    - workflow: data-enrichment
      with:
        source: production
      as: enriched-data
```

### Accessing Outputs

Outputs from `on_init` items are available in the step's execution context:

```yaml
steps:
  my-check:
    type: command
    on_init:
      run:
        - tool: fetch-data
          as: external-data
    exec: |
      echo "Fetched data: {{ outputs['external-data'] | json }}"
```

### Reusable Tools and Workflows

Define tools and workflows in separate files and import them:

**reusable-tools.yaml:**
```yaml
version: "1.0"
tools:
  fetch-jira-issue:
    name: fetch-jira-issue
    exec: |
      # Fetch JIRA issue...
    parseJson: true
steps: {}
```

**Main configuration:**
```yaml
version: "1.0"
extends:
  - ./reusable-tools.yaml

steps:
  ai-review:
    type: ai
    on_init:
      run:
        - tool: fetch-jira-issue
          with:
            issue_key: "{{ pr.title | regex_search: '[A-Z]+-[0-9]+' }}"
          as: jira
    prompt: "Review considering: {{ outputs.jira | json }}"
```

### Loop Protection

To prevent infinite loops and excessive preprocessing:

- **Maximum 50 items**: `on_init` can execute at most 50 items (configurable via `MAX_ON_INIT_ITEMS`)
- **No nested execution**: `on_init` hooks within `on_init` items are skipped
- **Separate from routing loops**: `on_init` loop protection is independent of `on_success`/`on_fail` routing

### Examples

See the `examples/` directory for comprehensive examples:

- **examples/on-init-basic.yaml** - Basic tool invocation and parameters
- **examples/on-init-workflows.yaml** - Workflow invocation patterns
- **examples/on-init-jira-preprocessor.yaml** - Real-world JIRA preprocessing
- **examples/on-init-import-demo.yaml** - Using imported tools/workflows
- **examples/reusable-tools.yaml** - Reusable tool library
- **examples/reusable-workflows.yaml** - Reusable workflow library

### Best Practices

1. **Keep preprocessing lightweight**: `on_init` runs before every step execution
2. **Use custom output names**: Make outputs easy to identify with descriptive `as` names
3. **Leverage reusability**: Define common tools/workflows once and import them
4. **Use `run_js` for conditionals**: Avoid fetching unnecessary data
5. **Handle failures gracefully**: Consider what happens if preprocessing fails

### See Also

- [Custom Tools](./custom-tools.md) - Define reusable MCP tools
- [Workflows](./workflows.md) - Create reusable workflows
- [Liquid Templates](./liquid-templates.md) - Template syntax for dynamic values
- [RFC: on_init Hook](./rfc/on_init-hook.md) - Design proposal and rationale
