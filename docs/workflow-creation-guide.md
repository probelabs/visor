# Visor Workflow Creation Guide

This guide provides comprehensive instructions for creating Visor workflows. It covers the structure, available check types, configuration patterns, testing DSL, and best practices.

## Table of Contents

1. [Workflow Structure](#workflow-structure)
2. [Check Types Reference](#check-types-reference)
3. [Configuration Patterns](#configuration-patterns)
4. [Testing DSL](#testing-dsl)
5. [Style Guide](#style-guide)
6. [Example Patterns](#example-patterns)
7. [Common Pitfalls](#common-pitfalls)

---

## Workflow Structure

### Basic Structure

Every Visor workflow follows this structure:

```yaml
version: "1.0"

# Optional: Workflow metadata
id: my-workflow
name: My Workflow Name
description: What this workflow does

# Optional: Global routing configuration
routing:
  max_loops: 5    # Prevent infinite routing loops

# Optional: Workflow-level outputs
outputs:
  - name: result
    description: The aggregated result
    value_js: |
      const all = Object.values(outputs || {});
      return all.map(v => v?.issues || []).flat();

# Required: Steps definition
steps:
  step-one:
    type: ai
    prompt: "Analyze the code"
    # ... step configuration

  step-two:
    type: command
    depends_on: [step-one]
    exec: "echo done"

# Optional: Inline tests
tests:
  defaults:
    strict: true
    ai_provider: mock
  cases:
    - name: basic-flow
      event: manual
      # ... test case configuration
```

### Key Sections

| Section | Required | Description |
|---------|----------|-------------|
| `version` | Yes | Always `"1.0"` |
| `steps` | Yes | Map of step names to configurations |
| `outputs` | No | Workflow-level output definitions |
| `routing` | No | Global routing configuration |
| `tests` | No | Inline test cases (or use separate `.tests.yaml`) |
| `imports` | No | External workflow files to import |

### Event Triggers

Steps can declare which events trigger them:

```yaml
steps:
  on-pr-open:
    type: ai
    on: [pr_opened]              # Only on PR open

  on-pr-changes:
    type: ai
    on: [pr_opened, pr_updated]  # PR open or update

  on-manual:
    type: command
    # No 'on:' means manual-only by default
```

Available events:
- `pr_opened` - Pull request opened
- `pr_updated` - Pull request synchronized/updated
- `pr_closed` - Pull request closed
- `issue_opened` - Issue created
- `issue_comment` - Comment on issue or PR
- `manual` - CLI execution (no event)

---

## Check Types Reference

### 1. AI Check (`type: ai`)

AI-powered analysis using LLMs (Gemini, Claude, OpenAI).

```yaml
steps:
  analyze:
    type: ai
    on: [pr_opened, pr_updated]

    # The prompt sent to the AI
    prompt: |
      Analyze the code changes for security issues.

      Files changed: {{ files | json }}
      PR Title: {{ pr.title }}

    # Output schema (JSON Schema or named schema)
    schema: code-review         # Named schema
    # OR inline schema:
    schema:
      type: object
      properties:
        issues:
          type: array
          items:
            type: object
            properties:
              severity: { type: string, enum: [critical, error, warning, info] }
              message: { type: string }
            required: [severity, message]
      required: [issues]

    # AI configuration
    ai:
      provider: anthropic       # google, anthropic, openai
      model: claude-3-opus-20240229
      skip_code_context: false  # Include code context in prompt
      disableTools: false       # Allow tool use
      system_prompt: |
        You are a security expert.
```

### 2. Claude Code Check (`type: claude-code`)

Advanced AI with MCP tools, file editing, and subagents.

```yaml
steps:
  comprehensive-analysis:
    type: claude-code
    prompt: |
      Perform a comprehensive code review:
      {{ outputs['get-requirements'].text }}

    claude_code:
      allowedTools: ['Read', 'Grep', 'Edit', 'Write', 'Bash']
      maxTurns: 10
      systemPrompt: |
        You are an expert code reviewer.

      # Bash permissions
      allowBash: true
      bashConfig:
        allow:
          - 'npm test'
          - 'npm run lint'
          - 'git status'
          - 'git diff'
        deny:
          - 'rm -rf'
          - 'git push'

      # MCP server configuration
      mcpServers:
        analyzer:
          command: "node"
          args: ["./tools/analyzer.js"]
          env:
            MODE: "deep"
```

### 3. Command Check (`type: command`)

Execute shell commands.

```yaml
steps:
  build:
    type: command
    exec: "npm run build"

    # Working directory
    cwd: "{{ outputs.checkout.path }}"

    # Environment variables
    env:
      NODE_ENV: production
      API_KEY: "{{ env.API_KEY }}"

    # Output format
    output_format: json         # text (default), json

    # Output schema for JSON
    schema:
      type: object
      properties:
        success: { type: boolean }
        errors: { type: array }

  multi-command:
    type: command
    exec: |
      npm ci
      npm run lint
      npm test
```

### 4. Human Input Check (`type: human-input`)

Pause for user input.

```yaml
steps:
  get-input:
    type: human-input
    prompt: |
      What would you like to accomplish?
      Be specific about constraints and requirements.

    placeholder: "Enter your task description..."
    multiline: true           # Allow multi-line input
    allow_empty: false        # Require input
    default: "yes"            # Default value
    timeout: 300              # Timeout in seconds
```

Output structure: `{ text: string, ts: number }`

### 5. Log Check (`type: log`)

Output messages to the console/log.

```yaml
steps:
  finish:
    type: log
    depends_on: [process]
    message: |
      Processing complete!

      Results:
      {% for item in outputs['process'].results %}
      - {{ item.name }}: {{ item.status }}
      {% endfor %}

    level: info               # info, warn, error, debug
    include_pr_context: false
    include_dependencies: false
    include_metadata: false
```

### 6. Script Check (`type: script`)

Execute JavaScript code.

```yaml
steps:
  transform:
    type: script
    content: |
      const input = outputs['previous-step'];
      const filtered = input.items.filter(i => i.valid);
      return {
        total: input.items.length,
        valid: filtered.length,
        items: filtered
      };

    # Schema for output validation
    schema:
      type: object
      required: [total, valid, items]
```

### 7. GitHub Check (`type: github`)

Perform GitHub API operations.

```yaml
steps:
  add-labels:
    type: github
    criticality: external
    depends_on: [analyze]

    assume:
      - "(outputs['analyze']?.labels?.length ?? 0) > 0"

    op: labels.add
    values:
      - "{{ outputs['analyze'].labels | json }}"

  create-comment:
    type: github
    op: comment.create
    values:
      body: |
        ## Analysis Complete
        {{ outputs['analyze'].summary }}
```

Available operations:
- `labels.add`, `labels.remove`, `labels.set`
- `comment.create`, `comment.update`
- `review.create`, `review.approve`, `review.request_changes`
- `status.create`

### 8. Memory Check (`type: memory`)

Store and retrieve state across steps.

```yaml
steps:
  store:
    type: memory
    operation: set
    key: "analysis_result"
    value: "{{ outputs['analyze'] | json }}"
    namespace: "my-workflow"

  retrieve:
    type: memory
    operation: get
    key: "analysis_result"
    namespace: "my-workflow"

  increment:
    type: memory
    operation: increment
    key: "attempt_count"
    value: 1
    namespace: "retry-loop"
```

### 9. Workflow Check (`type: workflow`)

Call another workflow as a step.

```yaml
steps:
  security-scan:
    type: workflow
    workflow: security-scan      # Workflow ID
    args:
      severity_threshold: high
      scan_dependencies: true

    output_mapping:
      vulnerabilities: scan_results
```

### 10. Git Checkout Check (`type: git-checkout`)

Checkout code from a repository.

```yaml
steps:
  checkout:
    type: git-checkout
    repository: owner/repo       # GitHub repository
    ref: "{{ pr.head }}"         # Branch, tag, or commit

    # Optional configuration
    fetch_depth: 1               # Shallow clone
    fetch_tags: false
    submodules: false            # true, false, or 'recursive'
    working_directory: /tmp/checkout
```

Output: `{ success, path, ref, commit, repository }`

### 11. HTTP Checks

#### HTTP Client (`type: http_client`)

Make HTTP requests.

```yaml
steps:
  fetch-data:
    type: http_client
    url: "https://api.example.com/data"
    method: POST
    headers:
      Authorization: "Bearer {{ env.API_TOKEN }}"
      Content-Type: application/json
    body: |
      { "query": "{{ outputs['input'].query }}" }

    schema:
      type: object
      properties:
        data: { type: array }
```

#### HTTP Input (`type: http_input`)

Receive data via webhook.

```yaml
steps:
  webhook-receiver:
    type: http_input
    path: /webhook/data
    method: POST
```

### 12. Noop Check (`type: noop`)

A pass-through step for orchestration.

```yaml
steps:
  checkpoint:
    type: noop
    depends_on: [step-a, step-b, step-c]
    # All dependencies must complete before dependents run
```

---

## Configuration Patterns

### Dependencies

Control execution order with `depends_on`:

```yaml
steps:
  first:
    type: command
    exec: "echo first"

  second:
    type: command
    depends_on: [first]       # Runs after 'first'
    exec: "echo second"

  parallel-a:
    type: command
    depends_on: [second]
    exec: "echo parallel-a"

  parallel-b:
    type: command
    depends_on: [second]      # Runs in parallel with parallel-a
    exec: "echo parallel-b"

  final:
    type: command
    depends_on: [parallel-a, parallel-b]  # Waits for both
    exec: "echo final"
```

### Conditions (`if`)

Skip steps conditionally:

```yaml
steps:
  conditional:
    type: command
    depends_on: [check]
    if: "outputs['check']?.should_run === true"
    exec: "echo running"
```

### Guards (`assume`)

Assert preconditions before execution:

```yaml
steps:
  process:
    type: command
    depends_on: [fetch]
    assume:
      - "outputs['fetch']?.data != null"
      - "(outputs['fetch']?.data?.length ?? 0) > 0"
    exec: "process-data"
```

### Contracts (`guarantee`, `schema`)

Validate output:

```yaml
steps:
  analyze:
    type: ai
    prompt: "Analyze code"

    # Schema validation
    schema:
      type: object
      required: [issues]
      properties:
        issues: { type: array }

    # Post-execution guarantee
    guarantee: "output.issues != null && Array.isArray(output.issues)"
```

### Failure Conditions (`fail_if`)

Mark step as failed based on output:

```yaml
steps:
  validate:
    type: command
    exec: "./validate.sh"
    fail_if: "output.code !== 0"

  ai-check:
    type: ai
    prompt: "Check for issues"
    fail_if: "output.issues?.some(i => i.severity === 'critical')"
```

### Routing (`on_success`, `on_fail`, `goto`)

Control flow after step completion:

```yaml
steps:
  validate:
    type: command
    exec: "npm test"
    fail_if: "output.code !== 0"

    on_fail:
      run: [fix-issues]        # Run remediation step
      goto: validate           # Then retry (ancestor only)
      retry:
        max: 2
        backoff:
          mode: exponential
          delay_ms: 1000

    on_success:
      goto: finalize

  fix-issues:
    type: claude-code
    prompt: "Fix the test failures"
    claude_code:
      allowedTools: ['Read', 'Edit']

  finalize:
    type: log
    message: "All tests pass!"
```

### forEach (Fan-Out)

Process arrays in parallel:

```yaml
steps:
  extract-items:
    type: ai
    forEach: true             # Output is treated as array
    prompt: "Extract items from: {{ pr.body }}"
    schema:
      type: array
      items:
        type: object
        properties:
          id: { type: string }
          task: { type: string }

  process-item:
    type: command
    depends_on: [extract-items]
    fanout: map               # Run once per item
    exec: "process {{ outputs['extract-items'].task }}"

  aggregate:
    type: script
    depends_on: [process-item]
    fanout: reduce            # Run once with all results
    content: |
      const results = outputs_history['process-item'] || [];
      return { total: results.length };
```

### AI Session Reuse

Continue AI conversations across steps:

```yaml
steps:
  initial-analysis:
    type: ai
    prompt: "Analyze the code structure"

  follow-up:
    type: ai
    depends_on: [initial-analysis]
    reuse_ai_session: initial-analysis
    session_mode: clone        # or 'continue'
    prompt: "Now look for security issues in what we discussed"
```

---

## Testing DSL

### Test File Structure

Tests can be inline in the workflow or in a separate file:

```yaml
# workflow-name.tests.yaml
version: "1.0"
extends: "./workflow-name.yaml"

tests:
  defaults:
    strict: true              # Every executed step must be asserted
    ai_provider: mock         # Use mock AI provider
    prompt_max_chars: 16000   # Truncate captured prompts
    tags: "fast"              # Only run steps with these tags
    exclude_tags: "slow"      # Skip steps with these tags

  cases:
    - name: basic-flow
      description: Tests the happy path
      event: manual           # or pr_opened, pr_updated, etc.
      fixture: local.minimal  # Built-in or custom fixture

      mocks:
        step-one: "mock response"
        step-two:
          field: "value"
          items: [1, 2, 3]
        # Array mocks for loops
        step-three[]:
          - { attempt: 1, status: "fail" }
          - { attempt: 2, status: "pass" }

      expect:
        calls:
          - step: step-one
            exactly: 1
          - step: step-two
            at_least: 1
            at_most: 3

        no_calls:
          - step: should-not-run

        prompts:
          - step: step-one
            contains:
              - "expected text"
            not_contains:
              - "unwanted text"

        outputs:
          - step: step-two
            path: items.length
            equals: 3
          - step: step-two
            path: status
            matches: "^(pass|success)$"
```

### Fixtures

Built-in fixtures:
- `gh.pr_open.minimal` - Minimal PR opened event
- `gh.pr_sync.minimal` - Minimal PR sync event
- `gh.issue_open.minimal` - Minimal issue opened event
- `gh.issue_comment.standard` - Standard issue comment
- `local.minimal` - Minimal local/manual fixture

Custom fixtures:
```yaml
tests:
  fixtures:
    - name: my-fixture
      extends: gh.pr_open.minimal
      overrides:
        pr:
          title: "Custom PR Title"
          labels: ["bug", "urgent"]
```

### Mock Types

```yaml
mocks:
  # Simple string mock (for human-input or command stdout)
  get-input: "user input text"

  # JSON object mock (for AI with schema)
  analyze:
    issues: []
    summary: "All good"

  # Array mock for forEach or loops
  extract[]:
    - { id: 1, name: "item1" }
    - { id: 2, name: "item2" }

  # Command mock
  build:
    stdout: '{"success": true}'
    stderr: ""
    exit_code: 0
```

### Expect Assertions

```yaml
expect:
  # Call count assertions
  calls:
    - step: my-step
      exactly: 1              # Exactly N times
    - step: retry-step
      at_least: 1             # At least N times
      at_most: 5              # At most N times

  # Negative assertions
  no_calls:
    - step: should-skip

  # Prompt assertions
  prompts:
    - step: ai-step
      index: last             # first, last, or number
      contains: ["keyword"]
      not_contains: ["bad"]
      matches: "pattern.*"

  # Output assertions
  outputs:
    - step: process
      path: result.status     # Dot notation path
      equals: "success"
    - step: process
      path: items
      contains_unordered: ["a", "b"]
    - step: process
      where: { path: type, equals: "important" }
      path: value
      matches: "\\d+"

  # Failure assertions
  fail:
    message_contains: "expected error"
```

### Flow Tests (Multi-Stage)

Test sequences of events:

```yaml
tests:
  cases:
    - name: multi-event-flow
      flow:
        - name: pr-opened
          event: pr_opened
          fixture: gh.pr_open.minimal
          mocks:
            overview: { text: "Initial review" }
          expect:
            calls:
              - step: overview
                exactly: 1

        - name: pr-updated
          event: pr_updated
          fixture: gh.pr_sync.minimal
          mocks:
            overview: { text: "Updated review" }
          expect:
            calls:
              - step: overview
                exactly: 1
```

---

## Style Guide

### Key Principles

1. **One step, one responsibility** - Keep steps focused and composable
2. **Declare intent before mechanics** - Readers should understand what/when before how
3. **Guard and contract every important step** - Use `assume` and `schema`/`guarantee`
4. **Avoid hidden control flow** - Prefer declarative routing over imperative logic

### Recommended Key Order

For each step, use this order:

```yaml
my-step:
  # 1. Identity & Intent
  type: ai
  criticality: external       # external, internal, policy, info
  group: analysis
  tags: [security, slow]
  description: Analyzes code for security issues

  # 2. Triggers & Dependencies
  on: [pr_opened, pr_updated]
  depends_on: [overview]

  # 3. Preconditions (Guards)
  assume:
    - "outputs['overview']?.text != null"
  if: "outputs['overview']?.shouldAnalyze === true"

  # 4. Provider Configuration
  prompt: |
    Analyze for security issues...
  ai:
    provider: anthropic
    model: claude-3-opus-20240229

  # 5. Contracts (Post-Exec)
  schema: code-review
  guarantee: "output.issues != null"

  # 6. Failure Policies
  fail_if: "output.issues?.some(i => i.severity === 'critical')"
  continue_on_failure: false

  # 7. Routing & Transitions
  on_success:
    goto: next-step
  on_fail:
    run: [fix-step]
    goto: my-step

  # 8. Runtime Controls
  timeout: 120
  retries: 2
```

### Criticality Levels

- **`external`**: Side effects outside repo/CI (GitHub ops, webhooks)
  - Requires: `assume` or `if` precondition
  - Requires: `schema` or `guarantee` for outputs

- **`internal`**: Orchestration/state within CI
  - Same requirements as `external`

- **`policy`**: Evaluative checks (security, quality)
  - Guards/contracts optional

- **`info`**: Purely informational, never gates dependents

### Do's and Don'ts

**Do:**
- Declare `criticality` and follow guard/contract rules
- Keep expressions short and defensive: `outputs?.x?.length ?? 0`
- Add `schema` whenever output shape matters
- Use meaningful step names
- Include tests for all workflows

**Don't:**
- Hide control flow in templates or long JS snippets
- Mix unrelated responsibilities in a single step
- Depend on outputs you didn't guard
- Use magic numbers without explanation
- Create workflows without tests

---

## Example Patterns

### Human-in-the-Loop with Refinement

```yaml
steps:
  get-task:
    type: human-input
    prompt: "Describe what you want to accomplish"
    multiline: true
    allow_empty: false

  refine:
    type: ai
    depends_on: [get-task]
    ai:
      disableTools: true
    schema:
      type: object
      properties:
        refined: { type: boolean }
        text: { type: string }
      required: [refined, text]
    prompt: |
      Refine this task into clear, actionable requirements:
      {{ outputs['get-task'].text }}

      If clarification is needed, set refined=false and ask in text.
      If complete, set refined=true with the final specification.

    fail_if: "output.refined !== true"
    on_fail:
      goto: get-task
```

### Validation Loop with Retry

```yaml
routing:
  max_loops: 5

steps:
  generate:
    type: ai
    prompt: "Generate code for: {{ inputs.task }}"

  validate:
    type: command
    depends_on: [generate]
    exec: "npm run lint && npm test"
    fail_if: "output.code !== 0"
    on_fail:
      run: [fix]
    on_success:
      goto: complete

  fix:
    type: claude-code
    depends_on: [validate]
    if: "outputs['validate']?.code !== 0"
    prompt: |
      Fix these errors:
      {{ outputs['validate'].stderr }}
    claude_code:
      allowedTools: ['Read', 'Edit']
      maxTurns: 5
    on_success:
      goto: validate

  complete:
    type: log
    depends_on: [validate]
    message: "Validation passed!"
```

### Multi-AI Review Pipeline

```yaml
steps:
  overview:
    type: ai
    on: [pr_opened, pr_updated]
    prompt: "Provide PR overview"
    schema: overview

  security:
    type: ai
    depends_on: [overview]
    prompt: "Analyze for security issues"
    schema: code-review

  performance:
    type: ai
    depends_on: [overview]
    prompt: "Analyze for performance issues"
    schema: code-review

  aggregate:
    type: script
    depends_on: [security, performance]
    content: |
      const all = [
        ...(outputs['security']?.issues || []),
        ...(outputs['performance']?.issues || [])
      ];
      return {
        issues: all,
        hasErrors: all.some(i => i.severity === 'critical' || i.severity === 'error')
      };
```

### GitHub Integration

```yaml
steps:
  analyze:
    type: ai
    on: [pr_opened]
    prompt: "Analyze and suggest labels"
    schema:
      type: object
      properties:
        labels: { type: array, items: { type: string } }
        effort: { type: integer, minimum: 1, maximum: 5 }

  apply-labels:
    type: github
    criticality: external
    depends_on: [analyze]
    assume:
      - "(outputs['analyze']?.labels?.length ?? 0) > 0"
    op: labels.add
    values:
      - "{{ outputs['analyze'].labels | json }}"
      - "effort:{{ outputs['analyze'].effort }}"
```

---

## Common Pitfalls

### 1. Missing Dependencies

**Wrong:**
```yaml
steps:
  process:
    type: command
    exec: "process {{ outputs['fetch'].data }}"  # fetch not declared as dependency
```

**Right:**
```yaml
steps:
  process:
    type: command
    depends_on: [fetch]
    exec: "process {{ outputs['fetch'].data }}"
```

### 2. Infinite Routing Loops

**Wrong:**
```yaml
steps:
  step-a:
    on_fail:
      goto: step-b
  step-b:
    depends_on: [step-a]
    on_fail:
      goto: step-a  # Infinite loop!
```

**Right:**
```yaml
routing:
  max_loops: 3        # Limit iterations

steps:
  step-a:
    on_fail:
      goto: step-b
      retry:
        max: 2        # Limit retries
```

### 3. Unguarded External Operations

**Wrong:**
```yaml
steps:
  add-labels:
    type: github
    op: labels.add
    values:
      - "{{ outputs['analyze'].labels }}"  # May be null!
```

**Right:**
```yaml
steps:
  add-labels:
    type: github
    criticality: external
    depends_on: [analyze]
    assume:
      - "(outputs['analyze']?.labels?.length ?? 0) > 0"
    op: labels.add
    values:
      - "{{ outputs['analyze'].labels | json }}"
```

### 4. Tests Without Strict Mode

**Wrong:**
```yaml
tests:
  cases:
    - name: test
      mocks:
        step-one: "value"
      expect:
        outputs:
          - step: step-one
            path: text
            equals: "value"
      # Missing call assertions - unexecuted steps go unnoticed
```

**Right:**
```yaml
tests:
  defaults:
    strict: true      # Require call assertions for all executed steps
  cases:
    - name: test
      mocks:
        step-one: "value"
      expect:
        calls:
          - step: step-one
            exactly: 1
        outputs:
          - step: step-one
            path: text
            equals: "value"
```

### 5. Forgetting forEach Fanout

**Wrong:**
```yaml
steps:
  extract:
    type: ai
    forEach: true
    prompt: "Extract items"

  process:
    depends_on: [extract]
    # Runs once with first item only!
```

**Right:**
```yaml
steps:
  extract:
    type: ai
    forEach: true
    prompt: "Extract items"

  process:
    depends_on: [extract]
    fanout: map        # Runs for each item
```

### 6. Hardcoded Values in Tests

**Wrong:**
```yaml
expect:
  outputs:
    - step: calculate
      path: result
      equals: 42        # Magic number - why 42?
```

**Right:**
```yaml
# Use meaningful values that relate to the mock inputs
mocks:
  input: { value: 6 }
  multiplier: { value: 7 }

expect:
  outputs:
    - step: calculate
      path: result
      equals: 42        # 6 * 7 = 42, derivable from inputs
```

---

## Quick Reference

### Template Variables

Available in prompts and Liquid templates:

| Variable | Description |
|----------|-------------|
| `pr` | PR metadata (title, body, author, labels, etc.) |
| `files` | Changed files list |
| `outputs` | Map of dependency outputs |
| `outputs['step-name']` | Specific step output |
| `outputs_history['step-name']` | All historical outputs for step |
| `outputs_raw['step-name']` | Raw/aggregate output |
| `env` | Environment variables |
| `event` | Current event details |
| `inputs` | Workflow input parameters |

### Liquid Filters

| Filter | Example | Description |
|--------|---------|-------------|
| `json` | `{{ data \| json }}` | JSON encode |
| `default` | `{{ x \| default: 'fallback' }}` | Default value |
| `size` | `{{ arr \| size }}` | Array/string length |
| `first` | `{{ arr \| first }}` | First element |
| `last` | `{{ arr \| last }}` | Last element |
| `join` | `{{ arr \| join: ', ' }}` | Join array |
| `split` | `{{ str \| split: ',' }}` | Split string |
| `upcase` | `{{ str \| upcase }}` | Uppercase |
| `downcase` | `{{ str \| downcase }}` | Lowercase |

### JS Expression Context

Available in `if`, `fail_if`, `assume`, `guarantee`, `run_js`, `goto_js`:

| Variable | Description |
|----------|-------------|
| `output` | Current step's output |
| `outputs` | Map of dependency outputs |
| `outputs.history` | Historical outputs map |
| `attempt` | Current attempt number |
| `loop` | Current routing loop number |
| `step` | Current step metadata |
| `pr` | PR metadata |
| `files` | Changed files |
| `env` | Environment variables |
| `event` | Event metadata |
| `memory` | Memory access (get/set/increment) |

### CLI Commands

```bash
# Run workflow
visor --config workflow.yaml

# Run with message (for human-input)
visor --config workflow.yaml --message "input text"

# Validate configuration
visor validate --config workflow.yaml

# Run tests
visor test --config workflow.tests.yaml

# Run specific test
visor test --only test-name

# List tests
visor test --list

# Validate tests only
visor test --validate
```
