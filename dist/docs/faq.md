# Frequently Asked Questions (FAQ)

This document answers common questions about Visor, the AI-powered workflow orchestration tool for code review, automation, and CI/CD pipelines.

---

## Table of Contents

- [General Questions](#general-questions)
- [Configuration Questions](#configuration-questions)
- [GitHub Actions Questions](#github-actions-questions)
- [Provider Questions](#provider-questions)
- [Troubleshooting](#troubleshooting)
- [Advanced Topics](#advanced-topics)

---

## General Questions

### What is Visor?

Visor is an AI-powered workflow orchestration tool that can perform intelligent code review, automate CI/CD tasks, and integrate with various services. It supports multiple AI providers (Google Gemini, Anthropic Claude, OpenAI GPT, AWS Bedrock) and can run as both a GitHub Action and a CLI tool.

Key capabilities:
- Automated code review for pull requests
- Security, performance, and style analysis
- Custom workflow automation with 15+ provider types
- MCP (Model Context Protocol) tool integration
- Slack and HTTP webhook integrations

### How is Visor different from other code review tools?

Unlike traditional linters that rely on static rules, Visor uses AI to understand context and provide nuanced feedback. Key differentiators:

1. **AI-powered analysis**: Uses LLMs to understand code intent and provide contextual suggestions
2. **Workflow orchestration**: Not just code review - supports complex multi-step workflows with routing, retries, and state management
3. **Pluggable architecture**: 15+ provider types (AI, command, MCP, HTTP, memory, etc.) that can be combined
4. **Configuration-driven**: Define workflows in YAML without writing code
5. **Multiple transports**: Works as GitHub Action, CLI tool, or Slack bot

### Can Visor run without AI? What happens then?

Yes. If no AI API key is configured, Visor falls back to fast, heuristic-based checks using simple pattern matching for basic style and performance issues.

To use AI-powered features, set one of these environment variables:
- `GOOGLE_API_KEY` for Google Gemini
- `ANTHROPIC_API_KEY` for Anthropic Claude
- `OPENAI_API_KEY` for OpenAI GPT
- AWS credentials for AWS Bedrock

### What are the supported AI providers?

| Provider | Environment Variable | Example Models |
|----------|---------------------|----------------|
| Google Gemini | `GOOGLE_API_KEY` | `gemini-2.0-flash-exp`, `gemini-1.5-pro` |
| Anthropic Claude | `ANTHROPIC_API_KEY` | `claude-3-5-sonnet-latest`, `claude-3-opus-latest` |
| OpenAI GPT | `OPENAI_API_KEY` | `gpt-4o`, `gpt-4-turbo` |
| AWS Bedrock | AWS credentials | `anthropic.claude-sonnet-4-20250514-v1:0` |

See [AI Configuration](./ai-configuration.md) for complete setup instructions.

### How do I install Visor?

**Quick start (no installation required):**
```bash
npx -y @probelabs/visor@latest --help
```

**Global installation:**
```bash
npm install -g @probelabs/visor
```

**Project dependency:**
```bash
npm install --save-dev @probelabs/visor
```

See [NPM Usage](./NPM_USAGE.md) for detailed installation options.

---

## Configuration Questions

### Where should I put my configuration file?

Visor looks for configuration in this order:
1. CLI `--config` parameter
2. `.visor.yaml` in the project root (note the leading dot)
3. Default configuration

**Example:**
```bash
# Use default location (.visor.yaml)
visor --check all

# Use custom config file
visor --config path/to/my-config.yaml
```

### How do I validate my configuration?

Use the `validate` command to check for errors before running:

```bash
# Validate default config
visor validate

# Validate specific file
visor validate --config .visor.yaml
```

The validator checks for:
- Missing required fields
- Invalid check types
- Incorrect event triggers
- Schema compliance

See [Configuration](./configuration.md#validating-configuration) for details.

### How do I configure multiple AI providers?

You can set a global default and override per-check:

```yaml
# Global default
ai_provider: anthropic
ai_model: claude-3-5-sonnet-latest

steps:
  # This uses the global default (Anthropic)
  security-review:
    type: ai
    prompt: "Analyze security vulnerabilities"

  # This overrides to use Google
  performance-review:
    type: ai
    ai_provider: google
    ai_model: gemini-2.0-flash-exp
    prompt: "Analyze performance issues"

  # Alternative syntax using nested 'ai' block
  style-review:
    type: ai
    ai:
      provider: openai
      model: gpt-4o
    prompt: "Review code style"
```

### How do I enable or disable specific checks?

Use the `on` field to control when checks run:

```yaml
steps:
  # Runs on PR open and update
  security-check:
    type: ai
    on: [pr_opened, pr_updated]
    prompt: "Check for security issues"

  # Disable a check by setting on to empty
  disabled-check:
    type: ai
    on: []  # Never runs
```

You can also use tags and the CLI to filter checks:

```bash
# Run only checks tagged 'security'
visor --tags security

# Exclude checks tagged 'experimental'
visor --exclude-tags experimental
```

See [Tag Filtering](./tag-filtering.md) for more options.

### How do I configure custom tools?

Define tools in the `tools` section and reference them in checks:

```yaml
tools:
  my-lint-tool:
    name: my-lint-tool
    description: Run custom linter
    inputSchema:
      type: object
      properties:
        files:
          type: array
          items:
            type: string
      required: [files]
    exec: 'eslint {{ args.files | join: " " }}'

steps:
  run-linter:
    type: mcp
    transport: custom
    method: my-lint-tool
    methodArgs:
      files: ["src/**/*.ts"]
```

See [Custom Tools](./custom-tools.md) for complete documentation.

### How do I share configuration across projects?

Use the `extends` field to inherit from base configurations:

```yaml
# .visor.yaml
extends:
  - ./team-standards.yaml    # Local file
  - default                   # Built-in defaults

steps:
  my-custom-check:
    type: ai
    prompt: "Project-specific analysis"
```

You can also extend remote configurations:
```bash
visor --allowed-remote-patterns "https://github.com/myorg/"
```

See [Configuration Inheritance](./configuration.md#configuration-inheritance-with-extends).

---

## GitHub Actions Questions

### How do I set up Visor as a GitHub Action?

Create `.github/workflows/visor.yml`:

```yaml
name: Visor Code Review
on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read
  pull-requests: write
  issues: write
  checks: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: buger/visor@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
        env:
          GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
```

See [Action Reference](./action-reference.md) for all available inputs and outputs.

### What GitHub events trigger Visor?

| Event | Trigger | Use Case |
|-------|---------|----------|
| `pull_request` (opened) | `pr_opened` | New PR review |
| `pull_request` (synchronize) | `pr_updated` | Updated PR review |
| `pull_request` (closed) | `pr_closed` | PR close handling |
| `issues` (opened) | `issue_opened` | Issue assistants |
| `issue_comment` | `issue_comment` | Comment commands |
| `schedule` | `schedule` | Cron jobs |
| `workflow_dispatch` | `schedule` | Manual triggers |

See [Event Triggers](./event-triggers.md) for complete documentation.

### How do I customize what gets reviewed?

Use the `on` field and conditions:

```yaml
steps:
  # Only review TypeScript files
  ts-review:
    type: ai
    on: [pr_opened, pr_updated]
    if: "files.some(f => f.filename.endsWith('.ts'))"
    prompt: "Review TypeScript code"

  # Only review on main branch PRs
  main-review:
    type: ai
    on: [pr_opened]
    if: "pr.base === 'main'"
    prompt: "Review changes to main"
```

### How do I handle large PRs?

For large PRs, consider:

1. **Increase timeout:**
   ```yaml
   steps:
     review:
       type: ai
       timeout: 300000  # 5 minutes
   ```

2. **Run checks in parallel:**
   ```yaml
   max_parallelism: 5
   ```

3. **Split into focused checks:**
   ```yaml
   steps:
     security-review:
       type: ai
       prompt: "Focus only on security"

     style-review:
       type: ai
       prompt: "Focus only on style"
   ```

4. **Filter by file type:**
   ```yaml
   steps:
     js-review:
       type: ai
       if: "files.some(f => f.filename.endsWith('.js'))"
   ```

### Why am I getting permission errors on fork PRs?

Fork PRs have restricted permissions by default. Solutions:

1. **Accept comment-only mode**: Visor falls back to PR comments automatically
2. **Use `pull_request_target`**: For full check run support (requires careful security review)

See [GitHub Checks - Fork PR Support](./GITHUB_CHECKS.md#fork-pr-support).

---

## Provider Questions

### Which AI provider should I use?

| Provider | Best For | Notes |
|----------|----------|-------|
| **Anthropic Claude** | Complex code analysis, security review | Strong reasoning, good context handling |
| **Google Gemini** | Fast analysis, cost-effective | Good for high-volume reviews |
| **OpenAI GPT-4** | General-purpose analysis | Wide model availability |
| **AWS Bedrock** | Enterprise environments | IAM integration, private endpoints |

For most use cases, start with whichever provider you already have API access to.

### How do I add custom checks?

Several provider types support custom logic:

**Command provider (shell commands):**
```yaml
steps:
  custom-lint:
    type: command
    exec: "npm run lint"
```

**Script provider (JavaScript):**
```yaml
steps:
  custom-analysis:
    type: script
    content: |
      const largeFiles = pr.files.filter(f => f.additions > 100);
      return {
        hasLargeChanges: largeFiles.length > 0,
        files: largeFiles.map(f => f.filename)
      };
```

**AI provider (custom prompts):**
```yaml
steps:
  domain-review:
    type: ai
    prompt: |
      You are an expert in our domain. Review this code for:
      - Business logic correctness
      - Domain model violations
      - API contract adherence
```

### How do I use MCP tools?

The MCP provider supports direct tool execution via multiple transports:

**stdio transport (local command):**
```yaml
steps:
  probe-search:
    type: mcp
    transport: stdio
    command: npx
    command_args: ["-y", "@probelabs/probe@latest", "mcp"]
    method: search_code
    methodArgs:
      query: "TODO"
```

**HTTP transport (remote server):**
```yaml
steps:
  remote-tool:
    type: mcp
    transport: http
    url: https://mcp-server.example.com/mcp
    method: analyze
    methodArgs:
      data: "{{ pr.title }}"
```

**Custom transport (YAML-defined tools):**
```yaml
tools:
  grep-tool:
    exec: 'grep -rn "{{ args.pattern }}" src/'

steps:
  search:
    type: mcp
    transport: custom
    method: grep-tool
    methodArgs:
      pattern: "FIXME"
```

See [MCP Provider](./mcp-provider.md) for complete documentation.

### What's the difference between command and script providers?

| Feature | `command` | `script` |
|---------|-----------|----------|
| Execution | Shell commands | JavaScript sandbox |
| Use case | External tools, shell scripts | Logic, data processing |
| Access | File system, external commands | PR context, memory, outputs |
| Security | Runs with process permissions | Sandboxed environment |

**Use `command` for:**
```yaml
steps:
  run-tests:
    type: command
    exec: "npm test -- --json"
```

**Use `script` for:**
```yaml
steps:
  process-results:
    type: script
    depends_on: [run-tests]
    content: |
      const results = outputs['run-tests'];
      return {
        passed: results.tests.filter(t => t.passed).length,
        failed: results.tests.filter(t => !t.passed).length
      };
```

---

## Troubleshooting

### Why isn't my check running?

Common causes:

1. **Event filter mismatch**: Check if the `on` field matches the current event
   ```yaml
   steps:
     my-check:
       on: [pr_opened]  # Won't run on pr_updated
   ```

2. **Condition evaluated to false**: Check your `if` expression
   ```yaml
   steps:
     my-check:
       if: "files.length > 0"  # Won't run if no files changed
   ```

3. **Tag filter exclusion**: Check if tags are filtering out the check
   ```bash
   visor --tags github  # Only runs checks tagged 'github'
   ```

4. **Missing dependencies**: Ensure `depends_on` targets exist
   ```yaml
   steps:
     my-check:
       depends_on: [nonexistent-check]  # Will fail
   ```

Debug with:
```bash
visor --check all --debug
```

### Why is routing not working?

Common issues with `goto`, `retry`, and `run`:

1. **goto must target ancestors only**: You can only jump back to previously executed checks
   ```yaml
   steps:
     step-a:
       type: command
     step-b:
       depends_on: [step-a]
       on_fail:
         goto: step-a  # Valid (ancestor)
         # goto: step-c  # Invalid (not an ancestor)
   ```

2. **Loop limit reached**: Check `max_loops` setting
   ```yaml
   routing:
     max_loops: 10  # Increase if needed
   ```

3. **JS expression errors**: Use `log()` to debug
   ```yaml
   on_fail:
     goto_js: |
       log("Current outputs:", outputs);
       log("History:", outputs.history);
       return null;
   ```

See [Failure Routing](./failure-routing.md) for complete documentation.

### How do I debug my configuration?

**Enable debug mode:**
```bash
visor --check all --debug
```

**Use the logger check type:**
```yaml
steps:
  debug-flow:
    type: logger
    depends_on: [previous-check]
    message: |
      Outputs: {{ outputs | json }}
      PR: {{ pr | json }}
```

**Use `log()` in JavaScript expressions:**
```yaml
steps:
  my-check:
    type: command
    if: |
      log("Files:", filesChanged);
      log("Event:", event);
      return filesChanged.length > 0;
```

**Enable tracing with OpenTelemetry:**
```bash
VISOR_TELEMETRY_ENABLED=true \
VISOR_TELEMETRY_SINK=otlp \
visor --check all
```

See [Debugging Guide](./debugging.md) for comprehensive techniques.

### What do the different error messages mean?

| Error | Meaning | Solution |
|-------|---------|----------|
| `Configuration not found` | No `.visor.yaml` found | Create config or use `--config` |
| `Invalid check type` | Unknown provider type | Use valid type: ai, command, script, etc. |
| `outputs is undefined` | Missing `depends_on` | Add dependency to access outputs |
| `Rate limit exceeded` | API quota reached | Reduce parallelism or add delays |
| `Command execution failed` | Shell command error | Check command syntax and permissions |
| `Transform error` | Invalid Liquid/JS | Debug with `log()` function |

See [Troubleshooting](./troubleshooting.md) for more error resolutions.

### Why are my AI responses incomplete or truncated?

Possible causes:

1. **Timeout too short**: Increase step timeout
   ```yaml
   steps:
     analysis:
       type: ai
       timeout: 120000  # 2 minutes
   ```

2. **Model token limits**: Switch to a model with larger context
   ```yaml
   steps:
     analysis:
       type: ai
       ai_model: gpt-4-turbo  # 128k context
   ```

3. **Prompt too complex**: Split into smaller, focused prompts

---

## Advanced Topics

### How do I implement retry logic?

Use `on_fail.retry` with optional backoff:

```yaml
steps:
  api-call:
    type: http_client
    url: https://api.example.com/data
    on_fail:
      retry:
        max: 3
        backoff:
          mode: exponential
          delay_ms: 1000  # 1s, 2s, 4s
```

You can also configure retries at the AI provider level:

```yaml
steps:
  analysis:
    type: ai
    ai:
      retry:
        maxRetries: 3
        initialDelay: 1000
        backoffFactor: 2
```

See [Failure Routing](./failure-routing.md) for complete retry options.

### How do I share state between checks?

Use the memory provider for persistent key-value storage:

```yaml
steps:
  store-value:
    type: memory
    operation: set
    key: my-key
    value: "{{ outputs['previous-check'].result }}"
    namespace: my-workflow

  read-value:
    type: script
    content: |
      const value = memory.get('my-key', 'my-workflow');
      return { retrieved: value };
```

In script and routing expressions, use the `memory` object:
```javascript
// Read
const value = memory.get('key', 'namespace');

// Write
memory.set('key', 'value', 'namespace');

// Increment
memory.increment('counter', 1, 'namespace');
```

See [Memory Provider](./memory.md) for complete documentation.

### How do I create conditional workflows?

Use `if` conditions and routing:

**Simple conditions:**
```yaml
steps:
  security-scan:
    type: ai
    if: "files.some(f => f.filename.includes('security'))"
```

**Branch by output:**
```yaml
steps:
  check-type:
    type: script
    content: |
      return { type: pr.title.startsWith('fix:') ? 'bugfix' : 'feature' };

  bugfix-review:
    type: ai
    depends_on: [check-type]
    if: "outputs['check-type'].type === 'bugfix'"
    prompt: "Review this bug fix"

  feature-review:
    type: ai
    depends_on: [check-type]
    if: "outputs['check-type'].type === 'feature'"
    prompt: "Review this feature"
```

**Declarative routing with transitions:**
```yaml
steps:
  validate:
    type: ai
    on_success:
      transitions:
        - when: "outputs['validate'].score >= 90"
          to: publish
        - when: "outputs['validate'].score >= 70"
          to: review
        - when: "true"
          to: reject
```

See [Router Patterns](./router-patterns.md) for best practices.

### How do I test my Visor configuration?

Use the built-in test framework with YAML test files:

```yaml
# visor.tests.yaml
version: "1.0"
extends: ".visor.yaml"

tests:
  defaults:
    strict: true
    ai_provider: mock

  cases:
    - name: security-check-runs
      event: pr_opened
      fixture: gh.pr_open.minimal
      mocks:
        security-review:
          text: "No security issues found"
      expect:
        calls:
          - step: security-review
            exactly: 1
```

Run tests:
```bash
# Run all tests
visor test

# Run specific test case
visor test --only security-check-runs

# Validate test file only
visor test --validate
```

See [Testing Guide](./testing/getting-started.md) for complete documentation.

### How do I use workflows for reusable components?

Define reusable workflows in separate files:

```yaml
# workflows/security-scan.yaml
id: security-scan
name: Security Scanner
inputs:
  - name: severity_threshold
    schema:
      type: string
      enum: [low, medium, high]
    default: medium

steps:
  scan:
    type: ai
    prompt: |
      Scan for security issues with threshold: {{ inputs.severity_threshold }}

outputs:
  - name: vulnerabilities
    value_js: steps.scan.output.issues
```

Import and use in your main config:

```yaml
# .visor.yaml
imports:
  - ./workflows/security-scan.yaml

steps:
  run-security:
    type: workflow
    workflow: security-scan
    args:
      severity_threshold: high
```

See [Reusable Workflows](./workflows.md) for complete documentation.

---

## Further Reading

- [Configuration Reference](./configuration.md) - Complete configuration options
- [Provider Documentation](./pluggable.md) - All 15+ provider types
- [Debugging Guide](./debugging.md) - Troubleshooting techniques
- [Recipes](./recipes.md) - Copy-paste workflow examples
- [Workflow Style Guide](./guides/workflow-style-guide.md) - Best practices
