# Lifecycle Hooks

Visor provides four lifecycle hooks that allow you to control step execution at different phases:

| Hook | When it Runs | Use Case |
|------|--------------|----------|
| `on_init` | **Before** step execution | Preprocessing, data fetching, context enrichment |
| `on_success` | **After** step succeeds | Post-processing, notifications, routing to next step |
| `on_fail` | **After** step fails | Error handling, retries, remediation |
| `on_finish` | **After all** forEach iterations complete | Aggregation, validation across all items |

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

### forEach Integration

**How on_init works with forEach**: When a check uses `forEach`, the `on_init` hook runs **once before the forEach loop starts**, not once per item:

```yaml
steps:
  analyze-files:
    type: ai
    forEach: file-list
    on_init:  # Runs ONCE before processing all files
      run:
        - tool: fetch-project-config
          as: config
    prompt: |
      Analyze {{ item }} using config: {{ outputs.config }}
      # outputs.config is available to ALL forEach iterations
```

This design allows you to:
- Fetch shared data once that all iterations can use
- Avoid redundant preprocessing for each item
- Keep forEach loops efficient

If you need per-item preprocessing, add `on_init` to child steps that depend on the forEach check.

### Examples

See the `examples/` directory for comprehensive examples:

- **examples/reusable-tools.yaml** - Reusable tool library with 3 custom tools (fetch-jira-issue, fetch-external-data, validate-data)
- **examples/reusable-workflows.yaml** - Reusable workflow library with 3 workflows (data-enrichment, issue-triage, multi-step-validation)
- **examples/on-init-import-demo.yaml** - Complete demonstration showing:
  - Using multiple imported tools in on_init
  - Invoking imported workflows
  - Chaining tools and workflows together
  - Reusing the same tool multiple times with different parameters
  - Includes 4 passing test cases

### Best Practices

1. **Keep preprocessing lightweight**: `on_init` runs before every step execution
2. **Use custom output names**: Make outputs easy to identify with descriptive `as` names
3. **Leverage reusability**: Define common tools/workflows once and import them
4. **Use `run_js` for conditionals**: Avoid fetching unnecessary data
5. **Handle failures gracefully**: Consider what happens if preprocessing fails

---

## `on_success` Hook

The `on_success` hook runs **after** a step completes successfully. It allows you to:
- Run post-processing steps
- Trigger notifications or downstream actions
- Jump back to a previous step for re-evaluation (routing)

### Basic Usage

```yaml
steps:
  build:
    type: command
    exec: npm run build
    on_success:
      run: [notify, deploy]
```

### Configuration Options

```yaml
on_success:
  # Run additional steps after success
  run: [step1, step2]

  # Optional: jump back to an ancestor step
  goto: previous-step

  # Optional: simulate a different event during goto
  goto_event: pr_updated

  # Dynamic step selection (JS expression returning string[])
  run_js: |
    return outputs['build'].hasWarnings ? ['review-warnings'] : [];

  # Dynamic routing (JS expression returning step id or null)
  goto_js: |
    // Re-run once using history length as attempt counter
    return outputs.history['build'].length === 1 ? 'setup' : null;

  # Declarative transitions (evaluated in order, first match wins)
  transitions:
    - when: "outputs['build'].score >= 90"
      to: publish
    - when: "outputs['build'].score >= 70"
      to: review
    - when: "true"
      to: null  # No routing
```

### Example: Conditional Post-Processing

```yaml
steps:
  analyze:
    type: ai
    prompt: Analyze code quality
    on_success:
      run_js: |
        const result = outputs['analyze'];
        if (result.issues?.length > 0) {
          return ['create-report', 'notify-team'];
        }
        return ['mark-approved'];

  create-report:
    type: command
    exec: generate-report.sh
    on: []

  notify-team:
    type: http
    url: https://slack.webhook.url
    on: []

  mark-approved:
    type: command
    exec: gh pr review --approve
    on: []
```

---

## `on_fail` Hook

The `on_fail` hook runs **after** a step fails. It provides mechanisms for:
- Automatic retries with backoff
- Running remediation steps before retry
- Jumping back to an ancestor step for re-execution

### Basic Usage

```yaml
steps:
  deploy:
    type: command
    exec: ./deploy.sh
    on_fail:
      retry:
        max: 3
        backoff:
          mode: exponential
          delay_ms: 1000
```

### Configuration Options

```yaml
on_fail:
  # Retry configuration
  retry:
    max: 3                           # Maximum retry attempts
    backoff:
      mode: fixed | exponential      # Backoff strategy
      delay_ms: 1000                 # Initial delay

  # Run remediation steps before retry
  run: [cleanup, reset-state]

  # Jump back to ancestor step
  goto: setup

  # Simulate different event during goto
  goto_event: pr_updated

  # Dynamic remediation (JS returning string[])
  run_js: |
    if (output.error?.includes('lock')) {
      return ['clear-locks'];
    }
    return [];

  # Dynamic routing (JS returning step id or null)
  goto_js: |
    return attempt < 2 ? 'install-deps' : null;

  # Declarative transitions
  transitions:
    - when: "output.error?.includes('timeout')"
      to: null  # Don't route, just retry
    - when: "output.error?.includes('auth')"
      to: refresh-auth
```

### Example: Remediation with Retry

```yaml
steps:
  install:
    type: command
    exec: npm ci

  test:
    type: command
    depends_on: [install]
    exec: npm test
    on_fail:
      run: [clean-cache]
      retry:
        max: 2
        backoff:
          mode: fixed
          delay_ms: 500

  clean-cache:
    type: command
    exec: rm -rf node_modules/.cache
    on: []  # Helper step only
```

---

## `on_finish` Hook

The `on_finish` hook runs **once** after a `forEach` step completes **all** iterations and all dependent checks. This is ideal for:
- Aggregating results from all forEach iterations
- Making routing decisions based on collective outcomes
- Validation across all processed items

**Note:** `on_finish` only applies to steps with `forEach: true`.

### When It Triggers

1. The forEach step produces an array of items
2. All dependent steps execute for each item
3. After ALL iterations complete, `on_finish` triggers once

### Basic Usage

```yaml
steps:
  process-files:
    type: command
    exec: "echo '[\"/a.ts\", \"/b.ts\", \"/c.ts\"]'"
    forEach: true
    on_finish:
      run: [summarize-results]
      goto_js: |
        const results = outputs.history['validate-file'];
        const allValid = results.every(r => r.valid);
        return allValid ? null : 'process-files';  # Retry if any failed

  validate-file:
    type: ai
    depends_on: [process-files]
    prompt: Validate {{ outputs['process-files'] }}

  summarize-results:
    type: script
    content: |
      const results = outputs.history['validate-file'];
      return {
        total: results.length,
        passed: results.filter(r => r.valid).length
      };
    on: []
```

### Available Context

The `on_finish` context is richer than other hooks:

```javascript
{
  step: { id: 'process-files', tags: [...] },
  attempt: 1,              // Current attempt number
  loop: 0,                 // Current loop in routing
  outputs: {
    'process-files': [...],  // Array of forEach items
    'validate-file': [...],  // ALL dependent results
    history: { ... }         // Alias for outputs_history
  },
  outputs_history: {
    'process-files': [[...], ...],
    'validate-file': [[...], ...],
  },
  outputs_raw: {
    'process-files': [...],  // Aggregate/parent values
  },
  forEach: {
    items: 3,              // Number of items
    last_wave_size: 3,
    last_items: [...],
    is_parent: true
  },
  memory: { get, set, has, getAll, increment, clear },
  pr: { number, title, author, branch, base },
  files: [...],
  env: { ... },
  event: { name: '...' }
}
```

### Example: Validation with Retry

```yaml
steps:
  extract-facts:
    type: ai
    forEach: true
    transform_js: JSON.parse(output).facts
    on_finish:
      run: [aggregate-validations]
      goto_js: |
        const allValid = memory.get('all_valid', 'validation');
        const attempt = memory.get('attempt', 'validation') || 0;

        if (allValid || attempt >= 2) {
          return null;  // Success or max attempts
        }

        memory.increment('attempt', 1, 'validation');
        return 'generate-response';  # Retry from ancestor

  validate-fact:
    type: ai
    depends_on: [extract-facts]
    prompt: Validate this fact...

  aggregate-validations:
    type: script
    content: |
      const results = outputs.history['validate-fact'];
      const allValid = results.every(r => r.is_valid);
      memory.set('all_valid', allValid, 'validation');
      return { total: results.length, valid: results.filter(r => r.is_valid).length };
    on: []
```

---

## Loop Protection & Safety

All routing hooks (`on_success`, `on_fail`, `on_finish`) are subject to loop protection:

```yaml
routing:
  max_loops: 10  # Per-scope cap on routing transitions
```

- **Retry counters**: Each step tracks attempt count independently
- **Loop budget**: Total routing transitions (goto + run) are capped per scope
- **forEach isolation**: Each item has its own loop/attempt counters

For hard caps on step executions, see [Execution Limits](./limits.md).

---

## See Also

- [Failure Routing](./failure-routing.md) - Complete guide to on_success, on_fail, on_finish
- [Custom Tools](./custom-tools.md) - Define reusable MCP tools
- [Workflows](./workflows.md) - Create reusable workflows
- [Liquid Templates](./liquid-templates.md) - Template syntax for dynamic values
- [Output History](./output-history.md) - Accessing historical outputs in routing
- [Execution Limits](./limits.md) - Configuring execution caps
- [RFC: on_init Hook](./rfc/on_init-hook.md) - Design proposal and rationale
