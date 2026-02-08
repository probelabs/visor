# Debugging Guide for Visor

This guide provides comprehensive debugging techniques and tools to help troubleshoot Visor configurations, checks, and transformations.

## Table of Contents
- [Running Visor Locally](#running-visor-locally)
- [Debug Mode](#debug-mode)
- [Debugging JavaScript Expressions](#debugging-javascript-expressions)
- [Debugging Liquid Templates](#debugging-liquid-templates)
- [Using the Logger Check](#using-the-logger-check)
- [Common Debugging Patterns](#common-debugging-patterns)
- [Author Permission Functions](#author-permission-functions)
- [Troubleshooting Tips](#troubleshooting-tips)
- [Tracing with OpenTelemetry](#tracing-with-opentelemetry)
- [Debug Visualizer](#debug-visualizer)

## Running Visor Locally

### Building from Source

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run the CLI
./dist/cli-main.js --help
# or
./dist/index.js --help
```

### Basic CLI Usage

```bash
# Run with a config file
./dist/index.js --config ./examples/calculator-config.yaml

# Run specific checks only
./dist/index.js --config .visor.yaml --check security,lint

# Run with debug output
./dist/index.js --config .visor.yaml --debug

# Output in different formats
./dist/index.js --config .visor.yaml --output json
./dist/index.js --config .visor.yaml --output markdown
./dist/index.js --config .visor.yaml --output sarif

# Pass inline messages for human-input checks
./dist/index.js --config ./examples/calculator-config.yaml --message "42"
```

### TUI Mode (Interactive Terminal Interface)

The `--tui` flag enables a persistent chat-style interface for interactive workflows:

```bash
# Start with TUI mode
./dist/index.js --tui --config ./examples/calculator-config.yaml

# TUI with debug output (logs go to second tab)
./dist/index.js --tui --config .visor.yaml --debug
```

**TUI Features:**
- **Chat Tab**: Shows workflow prompts and results in a chat-like interface
- **Logs Tab**: Press `Tab` or `2` to switch to logs view
- **Persistent Input**: Type messages at any time to interact with the workflow
- **Re-run Workflows**: After completion, type a new message to re-run

**TUI Key Bindings:**
| Key | Action |
|-----|--------|
| `Enter` | Submit input |
| `Tab` | Switch between Chat and Logs tabs |
| `1` / `2` | Switch to Chat / Logs tab directly |
| `Escape` | Clear input |
| `Ctrl+C` | Exit / Abort workflow |
| `q` | Exit (when workflow is complete) |

### Debug Server (Visual Debugger)

The debug server provides a web-based UI for stepping through workflow execution:

```bash
# Start with debug server
./dist/index.js --config .visor.yaml --debug-server --debug-port 3456

# For headless/CI environments (skip auto-opening browser)
VISOR_NOBROWSER=true ./dist/index.js --config .visor.yaml --debug-server
```

Open http://localhost:3456 to view the visual debugger. You can:
- Click "Start" to begin execution
- Pause/resume workflow execution
- View spans and timing information
- See check outputs and errors

### Combining Debug Options

```bash
# TUI + Debug mode (verbose logging in logs tab)
./dist/index.js --tui --config .visor.yaml --debug

# Debug server + Debug mode (full visibility)
./dist/index.js --config .visor.yaml --debug-server --debug

# Full tracing with Jaeger
VISOR_TELEMETRY_ENABLED=true \
VISOR_TELEMETRY_SINK=otlp \
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces \
./dist/index.js --config .visor.yaml --debug
```

### Development Workflow Tips

1. **Use TUI for interactive workflows**: When developing workflows with human-input checks, TUI mode provides the best experience.

2. **Check logs tab for errors**: In TUI mode, press `Tab` to switch to the logs tab to see detailed execution logs.

3. **Use JSON output for debugging**: `--output json` gives you the full result structure to inspect.

4. **Watch mode for rapid iteration**:
   ```bash
   # In one terminal - watch and rebuild
   npm run build -- --watch

   # In another terminal - run your workflow
   ./dist/index.js --tui --config ./my-workflow.yaml
   ```

5. **Run tests for specific features**:
   ```bash
   npm test -- --testPathPattern="human-input"
   npm test -- --testPathPattern="memory"
   ```

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
steps:
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
steps:
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
steps:
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
steps:
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
steps:
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
steps:
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
      All processed so far: {{ outputs.history["fetch-items"] | json }}
```

**Note:** Use `outputs.history['check-name']` to access all previous iteration outputs. See [Output History](./output-history.md) for tracking outputs across loop iterations and forEach processing.

**Note on forEach outputs**: When a check uses `forEach`, its output is automatically unwrapped in both templates and JavaScript contexts, giving you direct access to the array. This makes it easier to work with the data:

```yaml
steps:
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
steps:
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
steps:
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
steps:
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
steps:
  debug-outputs:
    type: command
    depends_on: [previous-check]
    exec: echo "debugging"
    transform_js: |
      log("All outputs:", outputs);
      log("Output keys:", Object.keys(outputs));
      log("Previous check type:", typeof outputs["previous-check"]);
      log("Is array?", Array.isArray(outputs["previous-check"]));

      // Debug output history
      log("History available:", !!outputs.history);
      log("History keys:", Object.keys(outputs.history || {}));
      log("Previous check history length:", outputs.history["previous-check"]?.length);

      return "debug complete";
```

**Tip:** Use `outputs` for current values and `outputs.history` to see all previous values from loop iterations or retries. See [Output History](./output-history.md) for more details.

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
steps:
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
steps:
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
steps:
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
# Enable verbose debug output (used in diff processing and other internals)
export DEBUG=1
# or
export VERBOSE=1

# Enable telemetry and tracing
export VISOR_TELEMETRY_ENABLED=true
export VISOR_TELEMETRY_SINK=file  # or otlp, console

# Set trace output directory
export VISOR_TRACE_DIR=output/traces

# For headless/CI environments (skip auto-opening browser)
export VISOR_NOBROWSER=true
```

See [Telemetry Setup](./telemetry-setup.md) for detailed configuration of tracing and metrics.

## Common Issues and Solutions

### Issue: "outputs is undefined"

```yaml
# Wrong - check has no dependencies
steps:
  my-check:
    type: command
    exec: echo "{{ outputs.other }}"  # Error: outputs is undefined

# Correct - add depends_on
steps:
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

## Author Permission Functions

> **📖 For complete documentation, examples, and best practices, see [Author Permissions Guide](./author-permissions.md)**

Visor provides helper functions to check the PR author's permission level in JavaScript expressions (`if`, `fail_if`, `transform_js`). These functions use GitHub's `author_association` field.

### Permission Hierarchy

From highest to lowest privilege:
- **OWNER** - Repository owner
- **MEMBER** - Organization member
- **COLLABORATOR** - Invited collaborator
- **CONTRIBUTOR** - Has contributed before
- **FIRST_TIME_CONTRIBUTOR** - First PR to this repo
- **FIRST_TIMER** - First GitHub contribution ever
- **NONE** - No association

### Available Functions

#### `hasMinPermission(level)`

Check if author has **at least** the specified permission level (>= logic):

```yaml
steps:
  # Run security scan for external contributors only
  security-scan:
    type: command
    exec: npm run security-scan
    if: "!hasMinPermission('MEMBER')"  # Not owner or member

  # Auto-approve for trusted contributors
  auto-approve:
    type: command
    exec: gh pr review --approve
    if: "hasMinPermission('COLLABORATOR')"  # Collaborators and above
```

#### `isOwner()`, `isMember()`, `isCollaborator()`, `isContributor()`

Boolean checks for specific or hierarchical permission levels:

```yaml
steps:
  # Different workflows based on permission
  code-review:
    type: ai
    prompt: "Review code"
    if: |
      log("Author is owner:", isOwner());
      log("Author is member:", isMember());
      log("Author is collaborator:", isCollaborator());

      // Members can skip review
      !isMember()

  # Block sensitive file changes from non-members
  sensitive-files-check:
    type: command
    exec: echo "Checking sensitive files..."
    fail_if: |
      !isMember() && files.some(f =>
        f.filename.startsWith('secrets/') ||
        f.filename === '.env' ||
        f.filename.endsWith('.key')
      )
```

#### `isFirstTimer()`

Check if author is a first-time contributor:

```yaml
steps:
  welcome-message:
    type: command
    exec: gh pr comment --body "Welcome to the project!"
    if: "isFirstTimer()"

  require-review:
    type: command
    exec: gh pr review --request-changes
    fail_if: "isFirstTimer() && outputs.issues?.length > 5"
```

### Local Mode Behavior

When running locally (not in GitHub Actions):
- All permission checks return `true` (treated as owner)
- `isFirstTimer()` returns `false`
- This prevents blocking local development/testing

### Examples

#### Conditional Security Scanning

```yaml
steps:
  # Run expensive security scan only for external contributors
  deep-security-scan:
    type: command
    exec: npm run security-scan:deep
    if: "!hasMinPermission('MEMBER')"

  # Quick scan for trusted members
  quick-security-scan:
    type: command
    exec: npm run security-scan:quick
    if: "hasMinPermission('MEMBER')"
```

#### Require Reviews Based on Permission

```yaml
steps:
  require-approval:
    type: command
    exec: gh pr review --request-changes
    fail_if: |
      // First-timers need clean PRs
      (isFirstTimer() && totalIssues > 0) ||
      // Non-collaborators need approval for large changes
      (!hasMinPermission('COLLABORATOR') && pr.totalAdditions > 500)
```

#### Auto-merge for Trusted Contributors

```yaml
steps:
  auto-merge:
    type: command
    depends_on: [tests, lint, security-scan]
    exec: gh pr merge --auto --squash
    if: |
      // Only auto-merge for collaborators with passing checks
      hasMinPermission('COLLABORATOR') &&
      outputs.tests.error === false &&
      outputs.lint.error === false &&
      outputs["security-scan"].criticalIssues === 0
```

## Tracing with OpenTelemetry

Visor supports OpenTelemetry tracing for deep execution visibility. Enable tracing to see:

- **Root span**: `visor.run` - one per CLI/Slack execution
- **State spans**: `engine.state.*` with `wave`, `wave_kind`, `session_id` attributes
- **Check spans**: `visor.check.<checkId>` with `visor.check.id`, `visor.check.type`, `visor.foreach.index` (for map fanout)
- **Routing decisions**: `visor.routing` events with `trigger`, `action`, `source`, `target`, `scope`, `goto_event`
- **Wave visibility**: `engine.state.level_dispatch` includes `level_size` and `level_checks_preview`

### Quick Start with Jaeger

```bash
# Start Jaeger locally
docker run -d --name jaeger \
  -p 16686:16686 \
  -p 4318:4318 \
  jaegertracing/all-in-one:latest

# Run Visor with tracing enabled
VISOR_TELEMETRY_ENABLED=true \
VISOR_TELEMETRY_SINK=otlp \
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces \
visor --config .visor.yaml

# View traces at http://localhost:16686
```

For complete tracing setup and configuration, see [Telemetry Setup](./telemetry-setup.md).

## Debug Visualizer

Visor includes a built-in debug visualizer - a lightweight HTTP server that streams OpenTelemetry spans during execution and provides control endpoints for pause/resume/stop.

### Starting the Debug Visualizer

```bash
# Start with debug server
visor --config .visor.yaml --debug-server --debug-port 3456

# For CI/headless environments
VISOR_NOBROWSER=true visor --config .visor.yaml --debug-server --debug-port 3456
```

### Control Endpoints

- `GET /api/status` - Execution state and readiness
- `GET /api/spans` - Current in-memory spans (live view)
- `POST /api/start` - Begin execution
- `POST /api/pause` - Pause scheduling (in-flight work continues)
- `POST /api/resume` - Resume scheduling
- `POST /api/stop` - Stop scheduling new work
- `POST /api/reset` - Clear spans and return to idle

For complete debug visualizer documentation, see [Debug Visualizer](./debug-visualizer.md).

## Further Reading

- [Liquid Templates Guide](./liquid-templates.md) - Template syntax and variables
- [Command Provider Documentation](./command-provider.md) - Command execution and transforms
- [Configuration Reference](./configuration.md) - Full configuration options
- [Telemetry Setup](./telemetry-setup.md) - OpenTelemetry tracing and metrics
- [Debug Visualizer](./debug-visualizer.md) - Live execution visualization
- [Output History](./output-history.md) - Tracking outputs across loop iterations