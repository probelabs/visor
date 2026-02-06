# Reusable Workflows

Visor supports defining reusable workflows that can be used as building blocks in your CI/CD pipeline. Workflows allow you to create modular, parameterized sequences of checks that can be shared across projects and teams.

## Table of Contents

- [Overview](#overview)
- [Workflow Structure](#workflow-structure)
- [Input Parameters](#input-parameters)
- [Output Parameters](#output-parameters)
- [Using Workflows](#using-workflows)
- [Advanced Features](#advanced-features)
- [Examples](#examples)
- [Best Practices](#best-practices)

## Overview

Workflows are reusable components that:
- Accept input parameters (args) with JSON Schema validation
- Define a sequence of steps at the root level (just like regular visor configs)
- Produce output values that can be consumed by other checks
- Must be defined in separate files and imported
- Support all existing check types as steps

## Workflow Structure

Each workflow is defined in its own file with the following structure:

```yaml
# workflow-name.yaml
id: workflow-name          # Unique identifier
name: Workflow Display Name # Human-readable name
description: What this workflow does
version: "1.0.0"           # Semantic versioning

# Input parameters
inputs:
  - name: param_name
    description: Parameter description
    schema:
      type: string
      enum: ["option1", "option2"]
    default: "option1"
    required: false

# Output parameters
outputs:
  - name: result
    description: Computation result
    value_js: steps.analyze.output.score

# Steps at root level - just like regular visor configs
steps:
  analyze:
    type: ai
    prompt: Analyze code with {{ inputs.param_name }}
    focus: security
```

## Importing Workflows

Import workflow files in your main configuration:

```yaml
# visor.yaml
version: "1.0"

# Import workflow definitions
imports:
  - ./workflows/security-scan.yaml
  - ./workflows/code-quality.yaml
  - https://example.com/workflows/shared.yaml

# Use imported workflows in your steps
steps:
  security_check:
    type: workflow
    workflow: security-scan
    args:
      severity_threshold: high
```

## Input Parameters

Workflows accept input parameters with JSON Schema validation:

```yaml
inputs:
  - name: language
    description: Programming language to analyze
    schema:
      type: string
      enum: ["javascript", "typescript", "python", "go"]
    required: true

  - name: strict_mode
    description: Enable strict checking
    schema:
      type: boolean
    default: false
    required: false

  - name: patterns
    description: Custom patterns to check
    schema:
      type: array
      items:
        type: string
      minItems: 1
```

### Supported Schema Types

- `string` - Text values with optional patterns, enums, length constraints
- `number` - Numeric values with min/max constraints
- `boolean` - True/false values
- `array` - Lists with item schemas
- `object` - Structured data with property schemas

## Output Parameters

Workflows produce outputs that can be consumed by other checks:

```yaml
outputs:
  - name: total_issues
    description: Total number of issues found
    value_js: |
      steps.scan1.output.issues.length +
      steps.scan2.output.issues.length

  - name: summary
    description: Human-readable summary
    value: |
      Found {{ outputs.total_issues }} issues:
      - Critical: {{ steps.scan1.output.critical_count }}
      - Warning: {{ steps.scan2.output.warning_count }}
```

### Output Computation Methods

1. **JavaScript expressions** (`value_js`): Compute outputs using JavaScript
2. **Liquid templates** (`value`): Format outputs using Liquid templating

## Workflow Steps

Steps in a workflow support all standard check features:

```yaml
steps:
  validate_input:
    type: script
    content: |
      if (!inputs.api_key) {
        throw new Error("API key is required");
      }
      return { valid: true };

  fetch_data:
    type: http_client
    url: https://api.example.com/data
    headers:
      Authorization: "Bearer {{ inputs.api_key }}"
    depends_on: [validate_input]

  analyze_data:
    type: ai
    prompt: |
      Analyze the following data:
      {{ steps.fetch_data.output | json }}

      Apply threshold: {{ inputs.threshold }}
    depends_on: [fetch_data]

  store_results:
    type: memory
    operation: set
    key: analysis_results
    value: "{{ steps.analyze_data.output }}"
    depends_on: [analyze_data]
```

### Step Input Mappings

Map workflow inputs to step parameters:

```yaml
steps:
  my_step:
    type: command
    exec: echo "Processing..."
    inputs:
      # Direct parameter reference
      param1:
        source: param
        value: input_name

      # Step output reference
      param2:
        source: step
        stepId: previous_step
        outputParam: result

      # Constant value
      param3:
        source: constant
        value: "fixed value"

      # JavaScript expression
      param4:
        source: expression
        expression: inputs.value * 2
```

## Using Workflows

### Basic Usage

Use a workflow as a check with the `workflow` type:

```yaml
steps:
  security_check:
    type: workflow
    workflow: security-scan  # Workflow ID from imported file
    args:
      severity_threshold: high
      scan_dependencies: true
    on: [pr_opened, pr_updated]
```

### Passing Inputs to Nested Workflows

When a step runs another workflow, you can pass inputs with `workflow_inputs`.
String values are rendered as Liquid templates. For non-string values, use a
JavaScript `expression` so the nested workflow receives the correct types.

```yaml
steps:
  context_collect:
    type: workflow
    config: workflows/context-collect.yaml
    workflow_inputs:
      # String inputs can use Liquid templates
      text: "{{ outputs['ask'].text }}"

      # Non-string inputs should use expressions
      enabled:
        expression: "inputs.tags?.includes('jira') ?? false"
      max_issues:
        expression: "inputs.max_issues ?? 3"
      ticket_prefixes:
        expression: "inputs.ticket_prefixes ?? ['TT', 'DX']"
```

Notes:
- Liquid templates are only rendered for **string** values.
- Avoid bare `key: {{ ... }}` for non-strings; YAML parses it as an object and
  it will not be rendered. Use `expression` instead.

### Using Config Path

Alternatively, reference a config file directly instead of a pre-registered workflow:

```yaml
steps:
  external_workflow:
    type: workflow
    config: ./other-workflow.yaml  # Path to workflow config file
    args:
      param1: value1
```

### With Output Mapping

Map workflow outputs to check outputs:

```yaml
steps:
  quality_analysis:
    type: workflow
    workflow: code-quality
    args:
      language: typescript
    output_mapping:
      final_score: quality_score  # Map workflow output to check output
      issues_list: recommendations
```

### With Step Overrides

Override specific steps in the workflow:

```yaml
steps:
  custom_scan:
    type: workflow
    workflow: security-scan
    args:
      severity_threshold: low
    overrides:
      secrets:  # Override the 'secrets' step
        prompt: "Custom prompt for secret scanning"
        timeout: 120
      sql_injection:  # Override the 'sql_injection' step
        ai_model: claude-3-opus-20240229
```

### Workflow Step Configuration Reference

| Property | Type | Description |
|----------|------|-------------|
| `workflow` | string | Workflow ID from imported workflow (required if not using `config`) |
| `config` | string | Path to workflow config file (alternative to `workflow`) |
| `args` | object | Input parameter values to pass to the workflow |
| `overrides` | object | Override specific step configurations within the workflow |
| `output_mapping` | object | Map workflow output names to check output names |
| `timeout` | number | Maximum execution time in milliseconds |
| `env` | object | Environment variables to set for workflow execution |

## Advanced Features

### Conditional Steps

Use conditions in workflow steps:

```yaml
steps:
  optional_check:
    type: ai
    prompt: Run expensive check
    if: inputs.enable_expensive_checks === true
```

### Dynamic Routing

Use workflow outputs for dynamic behavior:

```yaml
steps:
  decision_point:
    type: script
    content: |
      if (outputs.severity_check.critical_count > 0) {
        return { next_action: "block" };
      }
      return { next_action: "proceed" };

  follow_up:
    type: workflow
    workflow: "{{ steps.decision_point.output.next_action }}-workflow"
    depends_on: [decision_point]
```

### Workflow Composition

Workflows can use other workflows. Create a parent workflow file that imports and uses child workflows:

```yaml
# comprehensive-check.yaml
id: comprehensive-check
name: Comprehensive Check
version: "1.0"

inputs:
  - name: security_level
    schema:
      type: string
    default: medium
  - name: language
    schema:
      type: string
    required: true

steps:
  security:
    type: workflow
    workflow: security-scan
    args:
      severity_threshold: "{{ inputs.security_level }}"

  quality:
    type: workflow
    workflow: code-quality
    args:
      language: "{{ inputs.language }}"

  aggregate:
    type: script
    content: |
      return {
        passed: outputs['security'].passed && outputs['quality'].passed,
        score: (outputs['security'].score + outputs['quality'].score) / 2
      };
    depends_on: [security, quality]
```

## Examples

### Security Scan Workflow

```yaml
id: security-scan
name: Security Scanner
inputs:
  - name: scan_level
    schema:
      type: string
      enum: [basic, standard, comprehensive]
    default: standard

outputs:
  - name: vulnerabilities
    value_js: |
      [...(steps.secrets.output.issues || []),
       ...(steps.injection.output.issues || [])]

  - name: passed
    value_js: outputs.vulnerabilities.length === 0

steps:
  secrets:
    type: ai
    prompt: Scan for hardcoded secrets and API keys

  injection:
    type: ai
    prompt: Check for injection vulnerabilities
    depends_on: [secrets]
```

### Multi-Language Support Workflow

```yaml
id: language-check
name: Multi-Language Analyzer

inputs:
  - name: languages
    schema:
      type: array
      items:
        type: string

steps:
  detect_languages:
    type: script
    content: |
      const detected = [];
      if (filesChanged.some(f => f.endsWith('.js'))) detected.push('javascript');
      if (filesChanged.some(f => f.endsWith('.py'))) detected.push('python');
      return { languages: detected };

  analyze_each:
    type: ai
    forEach: true
    prompt: Analyze {{ item }} code for best practices
    depends_on: [detect_languages]

  summarize:
    type: script
    content: |
      const results = outputs.analyze_each;
      return {
        total_issues: results.reduce((sum, r) => sum + r.issues.length, 0),
        by_language: results.map((r, i) => ({
          language: steps.detect_languages.output.languages[i],
          issues: r.issues.length
        }))
      };
    depends_on: [analyze_each]
```

## Best Practices

### 1. Design for Reusability

- Use meaningful parameter names
- Provide sensible defaults
- Document all inputs and outputs
- Keep workflows focused on a single concern

### 2. Validate Inputs

```yaml
inputs:
  - name: url
    schema:
      type: string
      format: uri
      pattern: "^https://"
    description: HTTPS URL only
```

### 3. Handle Errors Gracefully

```yaml
steps:
  safe_operation:
    type: script
    content: |
      try {
        return processData(inputs.data);
      } catch (error) {
        return {
          success: false,
          error: error.message,
          fallback: inputs.default_value
        };
      }
```

### 4. Version Your Workflows

```yaml
version: "2.0.0"  # Semantic versioning
# Breaking changes from 1.x:
# - Renamed 'threshold' input to 'quality_threshold'
# - Added required 'language' input
```

### 5. Provide Examples

```yaml
examples:
  - name: Basic usage
    description: Run with default settings
    inputs:
      severity: medium

  - name: Strict mode
    description: Maximum security scanning
    inputs:
      severity: critical
      deep_scan: true
```

### 6. Test Your Workflows

You can include inline tests in workflow files that are automatically stripped when the workflow is imported:

```yaml
# my-workflow.yaml
id: my-workflow
name: My Workflow
version: "1.0"

inputs:
  - name: test_param
    schema:
      type: string

steps:
  process:
    type: script
    content: |
      return { result: inputs.test_param, score: 85 };

# Inline tests - NOT imported when used as component
tests:
  basic-test:
    type: script
    content: |
      const output = outputs['process'];
      if (output.result !== "test_value") throw new Error("Result mismatch");
      if (output.score < 0 || output.score > 100) throw new Error("Score out of range");
      return { passed: true };
    depends_on: [process]
```

Alternatively, create a separate test config:

```yaml
# test-workflow.yaml
steps:
  test_workflow:
    type: workflow
    workflow: my-workflow
    args:
      test_param: "test_value"

  validate_output:
    type: script
    content: |
      const output = outputs['test_workflow'];
      if (output.result === undefined) throw new Error("Result is required");
      if (output.score < 0 || output.score > 100) throw new Error("Score out of range");
      return { valid: true };
    depends_on: [test_workflow]
```

## Workflow Schema Reference

Complete workflow schema:

```typescript
interface WorkflowDefinition {
  id: string;                    // Unique identifier (required)
  name: string;                  // Display name (required)
  description?: string;          // Description
  version?: string;              // Semantic version
  tags?: string[];               // Categorization tags
  category?: string;             // Category (security, quality, etc.)

  inputs?: WorkflowInputParam[]; // Input parameters
  outputs?: WorkflowOutputParam[]; // Output parameters
  steps: Record<string, WorkflowStep>; // Workflow steps (required)

  on?: EventTrigger[];           // Events that can trigger this workflow
  defaults?: Partial<CheckConfig>; // Default config for steps
  tests?: Record<string, CheckConfig>; // Inline tests (NOT imported when used as component)

  author?: {                     // Author information
    name?: string;
    email?: string;
    url?: string;
  };

  license?: string;              // License information
  examples?: WorkflowExample[];  // Usage examples
}
```

**Note:** The `tests` field allows you to include inline test cases in a workflow file. When the workflow is imported via `imports`, the tests are stripped out and NOT executed. Tests only run when the workflow file is executed directly or via `visor test`.

## Integration with CI/CD

Workflows integrate seamlessly with GitHub Actions:

```yaml
name: PR Review
on: [pull_request]

jobs:
  visor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Run Visor with Workflows
        uses: your-org/visor-action@v1
        with:
          config: .visor.yaml
```

In your `.visor.yaml`, use the `imports` field to include workflow files:

```yaml
# .visor.yaml
version: "1.0"

# Import workflow definitions
imports:
  - ./workflows/*.yaml
  - https://workflows.example.com/shared/security.yaml

steps:
  run-security:
    type: workflow
    workflow: security-scan
    args:
      level: high
```

## Troubleshooting

### Common Issues

1. **Workflow not found**: Ensure the workflow is imported via the `imports` field in your config, or use the `config` property to reference the file path directly
2. **Input validation failed**: Check that inputs match the defined schema
3. **Circular dependencies**: Ensure workflow steps don't have circular `depends_on`
4. **Output computation error**: Verify JavaScript expressions and Liquid templates are valid
5. **Tests running unexpectedly**: When importing workflows, `tests` blocks are automatically stripped; if tests are running, check if you're executing the workflow file directly

### Debug Mode

Enable debug output to troubleshoot workflows:

```bash
visor --debug --config visor.yaml
```

This will show:
- Workflow registration details
- Input validation results
- Step execution order
- Output computation values

## See Also

- [Workflow Creation Guide](workflow-creation-guide.md) - Comprehensive guide with all check types and patterns
- [Configuration](configuration.md) - Main configuration reference
- [Event Triggers](event-triggers.md) - Configuring when workflows run
- [Liquid Templates](liquid-templates.md) - Template syntax for dynamic values
- [Debugging](debugging.md) - Debugging techniques for workflows
