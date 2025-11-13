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

Workflows can use other workflows:

```yaml
workflows:
  comprehensive-check:
    steps:
      security:
        type: workflow
        workflow: security-scan
        workflow_inputs:
          severity_threshold: "{{ inputs.security_level }}"

      quality:
        type: workflow
        workflow: code-quality
        workflow_inputs:
          language: "{{ inputs.language }}"

      aggregate:
        type: script
        content: |
          return {
            passed: steps.security.output.passed && steps.quality.output.passed,
            score: (steps.security.output.score + steps.quality.output.score) / 2
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

Create test configurations to validate workflows:

```yaml
# test-workflow.yaml
steps:
  test_workflow:
    type: workflow
    workflow: my-workflow
    workflow_inputs:
      test_param: "test_value"

  validate_output:
    type: script
    content: |
      const output = outputs.test_workflow;
      assert(output.result !== undefined, "Result is required");
      assert(output.score >= 0 && output.score <= 100, "Score out of range");
    depends_on: [test_workflow]
```

## Workflow Schema Reference

Complete workflow schema:

```typescript
interface WorkflowDefinition {
  id: string;                    // Unique identifier
  name: string;                   // Display name
  description?: string;           // Description
  version?: string;              // Semantic version
  tags?: string[];               // Categorization tags
  category?: string;             // Category (security, quality, etc.)

  inputs?: WorkflowInputParam[]; // Input parameters
  outputs?: WorkflowOutputParam[]; // Output parameters
  steps: Record<string, WorkflowStep>; // Workflow steps

  on?: EventTrigger[];          // Events that can trigger this workflow
  defaults?: Partial<CheckConfig>; // Default config for steps
  reusable?: boolean;            // Can be used as component

  author?: {                    // Author information
    name?: string;
    email?: string;
    url?: string;
  };

  license?: string;              // License information
  examples?: WorkflowExample[];  // Usage examples
}
```

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
          workflow_imports: |
            ./workflows/*.yaml
            https://workflows.example.com/shared/*.yaml
```

## Troubleshooting

### Common Issues

1. **Workflow not found**: Ensure the workflow is registered via `workflows` or `workflow_imports`
2. **Input validation failed**: Check that inputs match the defined schema
3. **Circular dependencies**: Ensure workflow steps don't have circular `depends_on`
4. **Output computation error**: Verify JavaScript expressions and Liquid templates are valid

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