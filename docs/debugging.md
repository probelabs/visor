# Debugging Guide for Visor

This guide provides comprehensive debugging techniques and tools to help troubleshoot Visor configurations, checks, and transformations.

## Table of Contents
- [Debug Mode](#debug-mode)
- [Debugging JavaScript Expressions](#debugging-javascript-expressions)
- [Debugging Liquid Templates](#debugging-liquid-templates)
- [Using the Logger Check](#using-the-logger-check)
- [Common Debugging Patterns](#common-debugging-patterns)
- [Troubleshooting Tips](#troubleshooting-tips)

## Debug Mode

Enable debug mode to see detailed execution information:

```bash
# CLI
visor --check all --debug

# GitHub Action
- uses: probelabs/visor-action@v1
  with:
    debug: true
```

Debug mode provides:
- Detailed AI provider interactions
- Template rendering details
- Expression evaluation results
- Dependency resolution paths
- Error stack traces

## Debugging JavaScript Expressions

### Using the `log()` Function

The `log()` function is available in JavaScript expressions for debugging:

#### In `if` Conditions

```yaml
checks:
  analyze-bugs:
    type: ai
    depends_on: [fetch-tickets]
    if: |
      log("Full outputs object:", outputs);
      log("Ticket data:", outputs["fetch-tickets"]);
      log("Issue type:", outputs["fetch-tickets"]?.issueType);
      outputs["fetch-tickets"]?.issueType === "Bug"
    prompt: "Analyze this bug"
```

#### In `fail_if` Conditions

```yaml
checks:
  security-check:
    type: ai
    prompt: "Check for security issues"
    fail_if: |
      log("Checking issues:", output.issues);
      log("Critical count:", output.issues.filter(i => i.severity === "critical").length);
      output.issues.filter(i => i.severity === "critical").length > 0
```

#### In `transform_js`

```yaml
checks:
  process-data:
    type: command
    exec: curl -s https://api.example.com/data
    transform_js: |
      log("Raw response:", output);

      // Parse JSON with error handling
      let data;
      try {
        data = JSON.parse(output);
        log("Parsed successfully:", data);
      } catch (e) {
        log("Parse error:", e.message);
        return { error: e.message };
      }

      // Transform the data
      const transformed = data.items.map(item => ({
        id: item.id,
        score: item.metrics.score
      }));

      log("Transformed result:", transformed);
      return transformed;
```

### Debug Output Format

The `log()` function prefixes output with 🔍 for easy identification:

```
🔍 Debug: Full outputs object: { 'fetch-tickets': { issueType: 'Bug', priority: 'High' } }
🔍 Debug: Issue type: Bug
```

## Debugging Liquid Templates

### Using the `json` Filter

The `json` filter is invaluable for inspecting data structures:

```yaml
checks:
  debug-template:
    type: log
    message: |
      === Debug Information ===

      PR Context:
      {{ pr | json }}

      Dependency Outputs:
      {{ outputs | json }}

      Environment:
      {{ env | json }}

      Files Changed:
      {{ files | json }}
```

### Inspecting Specific Values

```liquid
# Check if a variable exists
{% if outputs.fetch-tickets %}
  Tickets found: {{ outputs.fetch-tickets | json }}
{% else %}
  No tickets data available
{% endif %}

# Debug array access
{% for item in outputs.fetch-items %}
  Item {{ forloop.index }}: {{ item | json }}
{% endfor %}

# Debug nested access
Nested value: {{ outputs["complex-check"]["data"]["nested"]["value"] | default: "Not found" }}
```

## Using the Logger Check

The `logger` check type is designed for debugging workflows:

```yaml
checks:
  debug-dependencies:
    type: logger
    depends_on: [fetch-data, process-data]
    message: |
      === Debugging Dependency Flow ===

      Fetch Data Output:
      {{ outputs["fetch-data"] | json }}

      Processed Data:
      {{ outputs["process-data"] | json }}

      PR Number: {{ pr.number }}
      Files Count: {{ files | size }}
    level: info  # info, warning, error, debug
    include_dependencies: true
    include_pr_context: true
    include_metadata: true
```

### Logger Check Options

| Option | Description | Default |
|--------|-------------|---------|
| `message` | Liquid template for the log message | Required |
| `level` | Log level: debug, info, warning, error | `info` |
| `include_dependencies` | Include dependency results | `true` |
| `include_pr_context` | Include PR information | `true` |
| `include_metadata` | Include execution metadata | `true` |

## Common Debugging Patterns

### 1. Debugging forEach Iterations

```yaml
checks:
  fetch-items:
    type: command
    exec: echo '[{"id":1,"name":"A"},{"id":2,"name":"B"}]'
    transform_js: |
      const items = JSON.parse(output);
      log("Total items:", items.length);
      items.forEach((item, index) => {
        log(`Item ${index}:`, item);
      });
      return items;
    forEach: true

  process-item:
    type: logger
    depends_on: [fetch-items]
    message: |
      Processing item: {{ outputs["fetch-items"] | json }}
```

**Note on forEach outputs**: When a check uses `forEach`, its output is automatically unwrapped in both templates and JavaScript contexts. Instead of getting `{output: [...], forEachItems: [...], isForEach: true}`, you get the array directly. This makes it easier to work with the data:

```yaml
checks:
  analyze-tickets:
    type: command
    depends_on: [fetch-tickets]
    if: |
      // Direct access to the array from forEach check
      log("Tickets:", outputs["fetch-tickets"]);
      outputs["fetch-tickets"].some(t => t.issueType === "Bug")
    exec: echo "Processing bugs..."
```

### 2. Debugging Conditional Execution

```yaml
checks:
  conditional-check:
    type: command
    exec: echo "test"
    if: |
      // Debug all available context
      log("Event:", event);
      log("Branch:", branch);
      log("Files changed:", filesChanged);
      log("Outputs available:", Object.keys(outputs));

      // Complex condition with debugging
      const shouldRun = branch === "main" && filesChanged.length > 0;
      log("Should run?", shouldRun);
      return shouldRun;
```

### 3. Debugging Transform Chains

```yaml
checks:
  fetch-raw:
    type: command
    exec: curl -s https://api.example.com/data
    transform_js: |
      log("Step 1 - Raw:", output.substring(0, 100));
      return output;

  parse-json:
    type: command
    depends_on: [fetch-raw]
    exec: echo '{{ outputs["fetch-raw"] }}'
    transform_js: |
      log("Step 2 - Input:", output.substring(0, 100));
      const parsed = JSON.parse(output);
      log("Step 2 - Parsed:", parsed);
      return parsed;

  extract-data:
    type: logger
    depends_on: [parse-json]
    message: |
      Final data: {{ outputs["parse-json"] | json }}
```

### 4. Debugging AI Prompts

```yaml
checks:
  debug-ai-context:
    type: logger
    depends_on: [fetch-context]
    message: |
      === AI Prompt Context ===
      Context data: {{ outputs["fetch-context"] | json }}

      Files to analyze: {{ files | size }}
      {% for file in files %}
      - {{ file.path }}: {{ file.additions }} additions, {{ file.deletions }} deletions
      {% endfor %}

  ai-analysis:
    type: ai
    depends_on: [debug-ai-context, fetch-context]
    prompt: |
      Analyze the following data:
      {{ outputs["fetch-context"] | json }}
```

## Troubleshooting Tips

### 1. Check Dependency Output Structure

When `outputs` access fails, debug the structure:

```yaml
checks:
  debug-outputs:
    type: command
    depends_on: [previous-check]
    exec: echo "debugging"
    transform_js: |
      log("All outputs:", outputs);
      log("Output keys:", Object.keys(outputs));
      log("Previous check type:", typeof outputs["previous-check"]);
      log("Is array?", Array.isArray(outputs["previous-check"]));
      return "debug complete";
```

### 2. Validate JSON Before Parsing

```yaml
transform_js: |
  log("Raw output type:", typeof output);
  log("First 50 chars:", output.substring(0, 50));

  // Safe JSON parsing
  try {
    const data = JSON.parse(output);
    log("Parse successful");
    return data;
  } catch (e) {
    log("Parse failed:", e.message);
    log("Invalid JSON:", output);
    return { error: "Invalid JSON", raw: output };
  }
```

### 3. Debug Environment Variables

```yaml
checks:
  debug-env:
    type: logger
    message: |
      Environment Variables:
      {% for key in env %}
      - {{ key }}: {{ env[key] }}
      {% endfor %}

      GitHub Context:
      - Event: {{ event.event_name }}
      - Action: {{ event.action }}
      - Repository: {{ event.repository }}
```

### 4. Debug File Patterns

```yaml
checks:
  debug-files:
    type: command
    exec: echo "checking files"
    if: |
      const jsFiles = filesChanged.filter(f => f.endsWith('.js'));
      const tsFiles = filesChanged.filter(f => f.endsWith('.ts'));

      log("JS files:", jsFiles);
      log("TS files:", tsFiles);
      log("Has source changes:", jsFiles.length > 0 || tsFiles.length > 0);

      return jsFiles.length > 0 || tsFiles.length > 0;
```

### 5. Debug Schema Validation

```yaml
checks:
  validate-output:
    type: command
    exec: echo '{"items":[1,2,3]}'
    transform_js: |
      const data = JSON.parse(output);

      // Validate structure
      log("Has items?", "items" in data);
      log("Items is array?", Array.isArray(data.items));
      log("Items count:", data.items?.length);

      if (!data.items || !Array.isArray(data.items)) {
        log("Invalid structure:", data);
        throw new Error("Expected items array");
      }

      return data.items;
    schema:
      type: array
      items:
        type: number
```

## Best Practices

1. **Use Progressive Debugging**: Start with high-level logs, then add more detail as needed
2. **Clean Up Logs**: Remove or comment out `log()` calls in production configs
3. **Log at Boundaries**: Add logs at the start/end of transforms and conditions
4. **Include Context**: Log not just values but also their types and structures
5. **Use Structured Output**: Return objects with error details rather than throwing errors

## Environment Variables for Debugging

Set these environment variables for additional debug output:

```bash
# Show all debug output
export DEBUG=1

# Show Liquid template rendering
export DEBUG_TEMPLATES=1

# Show command execution details
export DEBUG_COMMANDS=1

# Show dependency resolution
export DEBUG_DEPS=1
```

## Common Issues and Solutions

### Issue: "outputs is undefined"

```yaml
# Wrong - check has no dependencies
checks:
  my-check:
    type: command
    exec: echo "{{ outputs.other }}"  # Error: outputs is undefined

# Correct - add depends_on
checks:
  my-check:
    type: command
    depends_on: [other]
    exec: echo "{{ outputs.other }}"  # Now outputs is available
```

### Issue: "Cannot read property of undefined"

```yaml
# Debug the structure first
transform_js: |
  log("Output structure:", output);
  log("Has data property?", output && output.data !== undefined);

  // Safe access with optional chaining
  const value = output?.data?.items?.[0]?.value;
  log("Extracted value:", value);

  return value || "default";
```

### Issue: "Expression evaluation error"

```yaml
# Debug the expression step by step
if: |
  log("Step 1 - outputs exists:", outputs !== undefined);
  log("Step 2 - has key:", "my-check" in outputs);
  log("Step 3 - value:", outputs["my-check"]);

  // Break complex expressions into steps
  const hasData = outputs && outputs["my-check"];
  const isValid = hasData && outputs["my-check"].status === "success";

  log("Final result:", isValid);
  return isValid;
```

## Further Reading

- [Liquid Templates Guide](./liquid-templates.md) - Template syntax and variables
- [Command Provider Documentation](./command-provider.md) - Command execution and transforms
- [Configuration Reference](./configuration.md) - Full configuration options
- [GitHub Actions Integration](./github-actions.md) - CI/CD debugging