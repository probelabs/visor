# Visor Architecture

This document provides a comprehensive overview of Visor's internal architecture, explaining how the system works at a high level.

## Table of Contents

- [System Overview](#system-overview)
- [Entry Points](#entry-points)
- [Core Components](#core-components)
- [Provider Architecture](#provider-architecture)
- [State Machine](#state-machine)
- [Event Sources](#event-sources)
- [Data Flow](#data-flow)
- [Extension Points](#extension-points)
- [Telemetry and Observability](#telemetry-and-observability)
- [Error Handling](#error-handling)
- [Security Considerations](#security-considerations)
- [Memory and State Management](#memory-and-state-management)
- [Performance Optimization](#performance-optimization)
- [Related Documentation](#related-documentation)
- [Appendix A: File Structure](#appendix-a-file-structure)
- [Appendix B: Configuration Schema Reference](#appendix-b-configuration-schema-reference)
- [Appendix C: Event Types](#appendix-c-event-types)
- [Appendix D: Glossary](#appendix-d-glossary)

---

## System Overview

Visor is an AI-powered workflow orchestration tool that can run as a GitHub Action, CLI tool, or Slack bot. The system uses a state machine-based execution engine to orchestrate checks (steps) with sophisticated dependency resolution, routing, and error handling.

### High-Level Architecture Diagram

```
                                    +------------------+
                                    |   Entry Points   |
                                    +------------------+
                                    |                  |
                      +-------------+---+----------+---+-------------+
                      |                 |              |             |
                      v                 v              v             v
               +------+------+   +------+------+  +---+---+   +-----+-----+
               | GitHub      |   |    CLI      |  | Slack |   | HTTP      |
               | Action      |   | (cli-main)  |  | Socket|   | Webhook   |
               | (index.ts)  |   |             |  | Mode  |   | Server    |
               +------+------+   +------+------+  +---+---+   +-----+-----+
                      |                 |              |             |
                      +--------+--------+--------------+-------------+
                               |
                               v
                    +----------+-----------+
                    |  Configuration       |
                    |  Manager             |
                    |  (config.ts)         |
                    +----------+-----------+
                               |
                               v
                    +----------+-----------+
                    |  State Machine       |
                    |  Execution Engine    |
                    +----------+-----------+
                               |
          +--------------------+--------------------+
          |                    |                    |
          v                    v                    v
   +------+------+      +------+------+      +------+------+
   |  Dependency |      |   Journal   |      |  Provider   |
   |  Resolver   |      |   (Snapshot |      |  Registry   |
   |             |      |    Store)   |      |             |
   +-------------+      +-------------+      +------+------+
                                                    |
          +----------------+------------------------+
          |                |                |       |
          v                v                v       v
   +------+------+  +------+------+  +-----+----+ +--+--+
   | AI Provider |  | Command     |  | HTTP     | | ... |
   |             |  | Provider    |  | Provider | |     |
   +-------------+  +-------------+  +----------+ +-----+
```

### Key Components

| Component | Description |
|-----------|-------------|
| **Entry Points** | GitHub Action, CLI, Slack Socket Mode, HTTP webhooks |
| **Configuration Manager** | Loads and validates YAML configuration |
| **State Machine Engine** | Orchestrates check execution with wave-based scheduling |
| **Provider Registry** | Registry of pluggable check providers |
| **Journal** | Execution state and output history |
| **Dependency Resolver** | Builds execution graph from check dependencies |

---

## Entry Points

Visor supports multiple entry points for different integration scenarios.

### GitHub Action Entry (`src/index.ts`)

The primary entry point for GitHub Actions:

```typescript
// Simplified flow
async function run(): Promise<void> {
  const { octokit, authType } = await createAuthenticatedOctokit();
  const configManager = new ConfigManager();
  const config = await configManager.loadConfig(configPath);
  await handleEvent(octokit, inputs, eventName, context, config);
}
```

**Responsibilities:**
- Authenticate with GitHub (token or App)
- Load GitHub event context from `GITHUB_EVENT_PATH`
- Map GitHub events to Visor event triggers
- Execute checks via the state machine engine
- Post results as PR comments

**Supported GitHub Events:**
- `pull_request` (opened, synchronize, edited)
- `issue_comment` (command-driven reviews)
- `issues` (issue assistant workflows)
- `push` (associated PR detection)

### CLI Entry (`src/cli-main.ts`)

The command-line interface for local development and CI:

```bash
visor --config .visor.yaml --checks security,performance
visor review                  # Built-in code review workflow
visor test tests/             # Run YAML test suites
visor validate                # Validate configuration
```

**CLI Features:**
- Configuration validation and loading
- Check filtering by name or tags
- Multiple output formats (table, json, markdown, sarif)
- Debug visualizer integration
- TUI (Terminal User Interface) mode
- Telemetry/tracing support

### Slack Socket Mode

For Slack bot integration:

```bash
visor --slack --config .visor.yaml
```

Uses Slack's Socket Mode for real-time event handling without requiring a public webhook endpoint.

### HTTP Webhook Server

For receiving external webhooks:

```yaml
http_server:
  enabled: true
  port: 8080
  endpoints:
    - path: /webhook
      transform: "{{ request.body | json }}"
```

---

## Core Components

### Configuration Loading (`src/config.ts`)

The `ConfigManager` handles all configuration operations:

```
+------------------+
| ConfigManager    |
+------------------+
| - loadConfig()   |  <-- Load from file path
| - findAndLoad()  |  <-- Auto-discover .visor.yaml
| - validateConfig |  <-- Schema validation (Ajv)
| - mergeDefaults  |  <-- Apply default values
+------------------+
```

**Configuration Resolution Order:**
1. CLI `--config` parameter
2. `visor.yaml` or `.visor.yaml` in project root
3. `visor.yaml` or `.visor.yaml` in git repository root
4. Bundled default configuration

**Key Features:**
- YAML parsing with `js-yaml`
- Schema validation with Ajv
- Configuration inheritance via `extends`/`include`
- Environment variable interpolation
- Remote configuration loading (HTTP/HTTPS)

### Check Execution Engine (`src/state-machine-execution-engine.ts`)

The main orchestration layer that coordinates check execution:

```typescript
class StateMachineExecutionEngine {
  async executeGroupedChecks(
    prInfo: PRInfo,
    checks: string[],
    timeout?: number,
    config?: VisorConfig,
    // ... additional options
  ): Promise<ExecutionResult>
}
```

**Responsibilities:**
- Build engine context from configuration
- Initialize workspace isolation (if enabled)
- Create and run the state machine runner
- Manage frontends (GitHub, Slack integration)
- Aggregate results into `ExecutionResult`

### Provider System

Providers are pluggable components that implement specific check types:

```
+-------------------+
| CheckProvider     |  <-- Abstract base class
+-------------------+
| + getName()       |
| + execute()       |
| + validateConfig()|
| + isAvailable()   |
+-------------------+
         ^
         |
    +----+----+----+----+----+
    |    |    |    |    |    |
   AI  Cmd Script HTTP MCP  ...
```

See [Provider Architecture](#provider-architecture) for details.

### Routing and Flow Control

Checks can define routing rules for success, failure, and completion:

```yaml
checks:
  my-check:
    type: ai
    prompt: "..."
    on_fail:
      retry:
        max: 3
        backoff:
          mode: exponential
          delay_ms: 1000
      run: [remediation-step]
      goto: previous-step
    on_success:
      run: [post-process]
    on_finish:  # For forEach checks
      run: [aggregation-step]
```

---

## Provider Architecture

### Base Provider Interface

All providers implement the `CheckProvider` abstract class:

```typescript
abstract class CheckProvider {
  abstract getName(): string;
  abstract getDescription(): string;
  abstract validateConfig(config: unknown): Promise<boolean>;
  abstract execute(
    prInfo: PRInfo,
    config: CheckProviderConfig,
    dependencyResults?: Map<string, ReviewSummary>,
    context?: ExecutionContext
  ): Promise<ReviewSummary>;
  abstract getSupportedConfigKeys(): string[];
  abstract isAvailable(): Promise<boolean>;
  abstract getRequirements(): string[];
}
```

### Provider Registry

The singleton `CheckProviderRegistry` manages provider registration:

```typescript
class CheckProviderRegistry {
  static getInstance(): CheckProviderRegistry;
  register(provider: CheckProvider): void;
  getProvider(name: string): CheckProvider | undefined;
  getAvailableProviders(): string[];
}
```

**Registration Flow:**
1. Registry instantiates on first access
2. Default providers registered automatically
3. Custom providers can be registered programmatically

### Built-in Providers

| Provider | Type | Description |
|----------|------|-------------|
| `ai` | AI-powered | Uses Gemini, Claude, OpenAI, or Bedrock for analysis |
| `command` | Command | Executes shell commands |
| `script` | Script | Executes JavaScript in a sandbox |
| `http` | HTTP Output | Sends results to webhooks |
| `http_input` | HTTP Input | Receives webhook data |
| `http_client` | HTTP Client | Makes HTTP requests |
| `mcp` | MCP | Connects to MCP tool servers |
| `claude-code` | Claude Code | Uses Claude Code SDK with MCP tools |
| `memory` | Memory | Persistent key-value storage |
| `log` | Logger | Debug logging output |
| `noop` | No-op | Placeholder for orchestration |
| `human-input` | Human Input | Collects user input interactively |
| `workflow` | Workflow | Invokes nested workflows |
| `git-checkout` | Git Checkout | Checks out git references |
| `github` | GitHub Ops | GitHub API operations (labels, comments) |

### Provider Lifecycle

```
+-------------+     +-------------+     +-------------+
| Instantiate | --> | Validate    | --> | Execute     |
| Provider    |     | Config      |     | Check       |
+-------------+     +-------------+     +-------------+
                          |                    |
                          v                    v
                    Config Error?        +-----+-----+
                          |              | Result    |
                          v              | (Summary) |
                    Skip Check           +-----------+
```

---

## State Machine

Visor uses a state machine-based execution engine for orchestrating checks. This provides deterministic execution, observability, and support for complex workflows.

### State Machine States

```
+-------+     +-----------+     +-------------+
| Init  | --> | PlanReady | --> | WavePlanning|
+-------+     +-----------+     +-------------+
                                       |
                                       v
+-------------+     +---------------+  |
| Completed   | <-- | LevelDispatch | <+
+-------------+     +---------------+
      ^                    |
      |                    v
+-------+          +-------------+
| Error |          | CheckRunning|
+-------+          +-------------+
                          |
                          v
                   +-------------+
                   |   Routing   |
                   +-------------+
```

### State Descriptions

| State | Description |
|-------|-------------|
| **Init** | Initialize context, load configuration, build dependency graph |
| **PlanReady** | Execution plan is ready, dependency graph built |
| **WavePlanning** | Plan the next execution wave based on dependency levels |
| **LevelDispatch** | Dispatch checks at the current dependency level |
| **CheckRunning** | Execute dispatched checks (parallel execution) |
| **Routing** | Evaluate routing rules (on_success, on_fail, on_finish) |
| **Completed** | All checks completed, aggregate results |
| **Error** | Fatal error occurred, cleanup and exit |

### Wave-Based Execution

Checks are executed in waves based on their dependency levels:

```
Wave 0: [check-a, check-b]     # No dependencies
           |
           v
Wave 1: [check-c]              # depends_on: [check-a]
           |
           v
Wave 2: [check-d, check-e]     # depends_on: [check-c]
```

**Wave Planning Rules:**
1. Checks with no unmet dependencies are scheduled
2. Checks run in parallel within a wave (respecting `max_parallelism`)
3. A new wave starts when all checks in the current wave complete
4. Routing can trigger additional waves (on_fail.goto, on_success.run)

### Dependency Resolution

The `DependencyResolver` builds an execution graph:

```typescript
interface DependencyGraph {
  levels: ExecutionGroup[];  // Checks grouped by dependency level
  checkDeps: Map<string, string[]>;  // Check -> its dependencies
  checkDependents: Map<string, string[]>;  // Check -> checks that depend on it
}
```

**Dependency Features:**
- Linear dependencies: `depends_on: [step-a]`
- OR dependencies: `depends_on: "step-a | step-b"` (either can satisfy)
- Cycle detection and error reporting
- Skip propagation (failed dependencies skip dependents)

### State Management

Runtime state is tracked in `RunState`:

```typescript
interface RunState {
  currentState: EngineState;
  wave: number;
  levelQueue: ExecutionGroup[];
  eventQueue: EngineEvent[];
  activeDispatches: Map<string, DispatchRecord>;
  completedChecks: Set<string>;
  stats: Map<string, CheckExecutionStats>;
  historyLog: EngineEvent[];
  // ... additional tracking fields
}
```

### Output History

The `ExecutionJournal` stores all check outputs for cross-check access:

```typescript
// In Liquid templates
{{ outputs["previous-check"].result }}
{{ outputs["data-fetch"] | json }}

// In JavaScript expressions (fail_if, transform_js)
outputs["check-name"].issues.length > 0
```

---

## Event Sources

### GitHub Webhook Integration

GitHub events are processed by the action entry point:

```
GitHub Event --> GITHUB_EVENT_PATH --> Event Parser --> Event Trigger
```

**Event Mapping:**
| GitHub Event | Action | Visor Trigger |
|--------------|--------|---------------|
| `pull_request` | `opened` | `pr_opened` |
| `pull_request` | `synchronize` | `pr_updated` |
| `issue_comment` | `created` | `issue_comment` |
| `issues` | `opened` | `issue_opened` |

### Slack Socket Mode

Real-time Slack integration without public webhooks:

```typescript
class SlackSocketRunner {
  async start(): Promise<void> {
    // Connect to Slack Socket Mode
    // Handle app_mention and message events
    // Route to engine execution
  }
}
```

**Event Flow:**
1. User mentions bot or sends message
2. Slack Socket Mode delivers event
3. Visor extracts thread context
4. Engine executes configured checks
5. Results posted back to thread

### HTTP Input Provider

For custom webhook sources:

```yaml
checks:
  webhook-handler:
    type: http_input
    endpoint: /api/webhook
    transform: |
      {% assign data = request.body | json %}
      {{ data.message }}
```

---

## Data Flow

### PR Review Request Flow

```
1. GitHub PR Event
        |
        v
2. Load Configuration
        |
        v
3. Build Dependency Graph
        |
        v
4. Wave Planning (Level 0)
        |
        v
5. Dispatch Checks -----> [AI Provider]
        |                      |
        |                      v
        |               6. AI Analysis
        |                      |
        v                      v
7. Collect Results <----- [ReviewSummary]
        |
        v
8. Route (on_success/on_fail)
        |
        v
9. Next Wave or Complete
        |
        v
10. Aggregate Results
        |
        v
11. Post PR Comment
```

### Output Propagation Between Checks

```yaml
checks:
  fetch-data:
    type: command
    exec: "curl -s https://api.example.com/data"

  analyze:
    type: ai
    depends_on: [fetch-data]
    prompt: |
      Analyze this data:
      {{ outputs["fetch-data"] | json }}
```

**Output Access:**
- Liquid templates: `{{ outputs["check-name"] }}`
- JavaScript: `outputs["check-name"]`
- Transform: `transform_js: "return outputs['fetch-data'].items"`

### Template Rendering with Liquid

Visor uses Liquid templates extensively:

```yaml
checks:
  example:
    type: ai
    prompt: |
      Review this PR:
      Title: {{ pr.title }}
      Author: {{ pr.author }}
      Files changed: {{ pr.files | size }}

      {% for file in pr.files %}
      - {{ file.filename }} (+{{ file.additions }}/-{{ file.deletions }})
      {% endfor %}
```

**Available Context:**
| Variable | Description |
|----------|-------------|
| `pr` | PR information (title, body, author, files) |
| `outputs` | Previous check outputs |
| `env` | Environment variables |
| `event` | GitHub event context |
| `memory` | Memory store accessor |

---

## Extension Points

### Adding New Providers

Create a new provider by extending `CheckProvider`:

```typescript
import { CheckProvider, CheckProviderConfig } from './check-provider.interface';

export class CustomProvider extends CheckProvider {
  getName(): string { return 'custom'; }
  getDescription(): string { return 'My custom provider'; }

  async execute(
    prInfo: PRInfo,
    config: CheckProviderConfig,
    dependencyResults?: Map<string, ReviewSummary>,
    context?: ExecutionContext
  ): Promise<ReviewSummary> {
    // Implementation
  }

  // ... other required methods
}

// Register
registry.register(new CustomProvider());
```

### Custom Tools

Define tools in configuration for use with MCP/AI checks:

```yaml
tools:
  search-docs:
    description: "Search documentation"
    inputSchema:
      type: object
      properties:
        query: { type: string }
      required: [query]
    exec: "grep -r '{{ query }}' docs/"
    transform_js: |
      return { results: output.split('\n').filter(Boolean) }
```

Tools are exposed to AI providers via an ephemeral MCP server.

### MCP Integration

Connect to external MCP servers:

```yaml
checks:
  code-analysis:
    type: ai
    ai:
      mcpServers:
        probe:
          command: "npx"
          args: ["-y", "@anthropic/probe-mcp"]
    prompt: "Analyze the codebase"
```

Or use the MCP provider directly:

```yaml
checks:
  direct-mcp:
    type: mcp
    transport: stdio
    exec: "npx @my-org/tool"
    method: analyze
    methodArgs:
      path: "{{ pr.files[0].filename }}"
```

### Workflow Composition

Create reusable workflows:

```yaml
# workflows/security-scan.yaml
id: security-scan
inputs:
  - name: severity_threshold
    default: warning
steps:
  scan:
    type: ai
    prompt: "Scan for security issues..."
outputs:
  - name: issues
    value: "{{ outputs['scan'].issues }}"
```

Use in main configuration:

```yaml
checks:
  security:
    type: workflow
    workflow: workflows/security-scan.yaml
    args:
      severity_threshold: error
```

### Frontend Integration

Create event-driven integrations:

```typescript
class CustomFrontend implements Frontend {
  async start(ctx: FrontendContext): Promise<void> {
    ctx.eventBus.on('CheckCompleted', async (event) => {
      // Handle check completion
    });
  }
}
```

Frontends receive events via the event bus:
- `CheckScheduled`
- `CheckCompleted`
- `CheckErrored`
- `HumanInputRequested`
- `StateTransition`

---

## Telemetry and Observability

Visor includes comprehensive telemetry support for debugging, monitoring, and performance analysis.

### OpenTelemetry Integration

Visor supports OpenTelemetry (OTEL) for distributed tracing:

```yaml
# visor.yaml
telemetry:
  enabled: true
  sink: otlp  # or 'file', 'console'
  file:
    dir: ./output/traces
    ndjson: true
  tracing:
    auto_instrumentations: true
    trace_report:
      enabled: true
```

**Environment Variables:**
| Variable | Description |
|----------|-------------|
| `VISOR_TELEMETRY_ENABLED` | Enable telemetry (`true`/`false`) |
| `VISOR_TELEMETRY_SINK` | Sink type: `otlp`, `file`, `console` |
| `VISOR_TRACE_DIR` | Directory for trace files |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | OTLP endpoint (e.g., `http://localhost:4318/v1/traces`) |

### Trace Structure

```
visor.run (root span)
  |
  +-- engine.state.init
  |     +-- dependency_resolver.build_graph
  |
  +-- engine.state.wave_planning
  |     +-- wave: 0, wave_kind: initial
  |
  +-- engine.state.level_dispatch
  |     +-- level_size: 3, level_checks_preview: [check-a, check-b, check-c]
  |
  +-- visor.check.check-a
  |     +-- visor.check.id: check-a
  |     +-- visor.check.type: ai
  |
  +-- visor.routing (events)
        +-- trigger: on_success, action: run, target: next-check
```

### Debug Visualizer

Start the debug visualizer for interactive debugging:

```bash
visor --debug-server --debug-port 3456 --config .visor.yaml
```

The visualizer provides:
- Real-time span streaming
- State machine visualization
- Execution timeline
- Pause/resume/step controls

---

## Error Handling

Visor implements comprehensive error handling at multiple levels.

### Provider-Level Error Handling

Each provider handles errors and returns them in the `ReviewSummary`:

```typescript
try {
  const result = await provider.execute(prInfo, config, deps, context);
  return result;
} catch (error) {
  return {
    issues: [{
      severity: 'error',
      ruleId: `${checkName}/execution-error`,
      message: error.message,
      file: '',
      line: 0
    }]
  };
}
```

### Routing-Based Error Recovery

Checks can define error recovery strategies:

```yaml
checks:
  risky-operation:
    type: command
    exec: "./risky-script.sh"
    on_fail:
      retry:
        max: 3
        backoff:
          mode: exponential
          delay_ms: 1000
          max_delay_ms: 30000
      run: [cleanup-step]
      goto: safe-fallback

  cleanup-step:
    type: command
    exec: "./cleanup.sh"

  safe-fallback:
    type: noop
    message: "Using fallback due to failure"
```

### Fail-Fast Mode

Enable fail-fast to stop execution on first critical error:

```yaml
# visor.yaml
fail_fast: true

# Or via CLI
visor --fail-fast --config .visor.yaml
```

### Error Propagation

Errors propagate through the dependency graph:

```
check-a (fails)
    |
    v
check-b (depends_on: [check-a]) --> SKIPPED
    |
    v
check-c (depends_on: [check-b]) --> SKIPPED
```

Skipped checks are marked with `severity: info` and `ruleId: checkName/__skipped`.

---

## Security Considerations

### Workspace Isolation

For untrusted code execution, enable workspace isolation:

```yaml
# visor.yaml
workspace:
  enabled: true
  base_path: /tmp/visor-workspaces
  cleanup: true  # Remove after execution
```

This creates isolated directories for each execution, preventing cross-contamination.

### Process Sandbox Engines

Visor supports three sandbox engines for isolating command execution:

| Engine | Platform | Isolation Model |
|--------|----------|-----------------|
| **Docker** | Linux, macOS, Windows | Full container isolation |
| **Bubblewrap** | Linux only | Linux kernel namespaces (PID, mount, network) |
| **Seatbelt** | macOS only | macOS `sandbox-exec` with SBPL profiles |

All three implement the `SandboxInstance` interface and are routed through `SandboxManager`. Configure via the `sandboxes:` block and `sandbox:` default in `.visor.yaml`.

See [Sandbox Engines](./sandbox-engines.md) for complete documentation.

### Environment Variable Handling

Sensitive values can be passed via environment:

```yaml
checks:
  api-call:
    type: http_client
    url: "https://api.example.com"
    headers:
      Authorization: "Bearer {{ env.API_TOKEN }}"
```

**Security practices:**
- Never commit secrets to configuration files
- Use GitHub Secrets or environment variables
- Visor does not log environment variable values

### Command Execution Security

The `command` provider executes shell commands. Mitigate risks by:

1. **Using explicit paths:** `exec: "/usr/bin/grep"`
2. **Avoiding shell expansion:** Use `args` array instead of string interpolation
3. **Setting working directory:** `workingDirectory: /safe/path`
4. **Limiting execution time:** `timeout: 30000`

### AI Provider Security

When using AI providers:

- API keys are never logged or included in outputs
- Prompts containing sensitive data should use redaction
- Review AI outputs before automated actions (labels, comments)

### HTTP Input Validation

For webhook endpoints, configure authentication:

```yaml
http_server:
  enabled: true
  port: 8080
  auth:
    type: hmac
    secret_env: WEBHOOK_SECRET
    header: X-Signature-256
```

---

## Memory and State Management

### Memory Store

Visor provides a persistent key-value memory store:

```yaml
checks:
  store-data:
    type: memory
    operation: set
    key: "session:{{ pr.number }}"
    value: "{{ outputs['fetch-data'] | json }}"

  retrieve-data:
    type: memory
    operation: get
    key: "session:{{ pr.number }}"
    depends_on: [store-data]
```

Memory persists across checks within a single execution but not across separate runs (unless using external persistence).

### Execution Journal

The `ExecutionJournal` (snapshot store) maintains:
- Output history per check
- Scoped visibility for nested workflows
- Snapshot points for rollback scenarios

```typescript
// Read outputs visible to a check
const outputs = journal.readVisible(sessionId, snapshot, scope);

// Write check result
journal.write(sessionId, checkId, scope, result);
```

### Session Registry

AI sessions are managed via `SessionRegistry`:

```yaml
checks:
  first-analysis:
    type: ai
    prompt: "Initial analysis..."
    reuse_ai_session: self  # Create named session

  follow-up:
    type: ai
    prompt: "Follow-up question..."
    depends_on: [first-analysis]
    reuse_ai_session: first-analysis  # Reuse session
    session_mode: append  # or 'clone'
```

---

## Performance Optimization

### Parallel Execution

Control parallelism via configuration:

```yaml
max_parallelism: 5  # Execute up to 5 checks concurrently
```

Or via CLI:

```bash
visor --max-parallelism 10 --config .visor.yaml
```

### Dependency-Aware Scheduling

The wave-based scheduler automatically optimizes execution:

1. Identifies independent checks (no dependencies)
2. Schedules them in parallel
3. Waits for wave completion before next level
4. Respects `max_parallelism` limits

### Caching Considerations

Currently, Visor does not cache AI responses between runs. For expensive operations:

1. Use `memory` provider to store intermediate results
2. Implement `if` conditions to skip unnecessary checks
3. Consider external caching for HTTP responses

---

## Related Documentation

- [Configuration](./configuration.md) - Configuration file reference
- [Sandbox Engines](./sandbox-engines.md) - Docker, Bubblewrap, and Seatbelt isolation
- [Security](./security.md) - Security overview and best practices
- [Providers](./providers/) - Provider-specific documentation
- [Custom Tools](./custom-tools.md) - Creating custom tools
- [MCP Provider](./mcp-provider.md) - MCP integration details
- [Command Provider](./command-provider.md) - Shell command execution
- [HTTP Integration](./http.md) - HTTP server and client features
- [Debugging](./debugging.md) - Debugging techniques

---

## Appendix A: File Structure

```
src/
  index.ts                    # GitHub Action entry point
  cli-main.ts                 # CLI entry point
  config.ts                   # Configuration loading
  state-machine-execution-engine.ts  # Main orchestration

  types/
    config.ts                 # Configuration types
    engine.ts                 # Engine state types
    execution.ts              # Execution result types
    cli.ts                    # CLI option types

  state-machine/
    runner.ts                 # State machine runner
    states/
      init.ts                 # Init state handler
      plan-ready.ts           # PlanReady state handler
      wave-planning.ts        # WavePlanning state handler
      level-dispatch.ts       # LevelDispatch state handler
      check-running.ts        # CheckRunning state handler
      routing.ts              # Routing logic
      completed.ts            # Completed state handler
      error.ts                # Error state handler

  providers/
    check-provider.interface.ts  # Provider base class
    check-provider-registry.ts   # Provider registry
    ai-check-provider.ts         # AI provider (Gemini, Claude, OpenAI)
    claude-code-check-provider.ts # Claude Code SDK provider
    command-check-provider.ts    # Shell command provider
    script-check-provider.ts     # JavaScript sandbox provider
    http-check-provider.ts       # HTTP output provider
    http-input-provider.ts       # HTTP webhook input provider
    http-client-provider.ts      # HTTP client provider
    mcp-check-provider.ts        # MCP tool provider
    mcp-tools.ts                 # MCP server management
    memory-check-provider.ts     # Key-value memory provider
    log-check-provider.ts        # Debug logging provider
    noop-check-provider.ts       # No-op orchestration provider
    human-input-check-provider.ts # Interactive input provider
    workflow-check-provider.ts   # Nested workflow provider
    git-checkout-provider.ts     # Git reference checkout provider
    github-ops-provider.ts       # GitHub API operations provider
    custom-tool-executor.ts      # Custom tool execution

  event-bus/
    event-bus.ts              # Event bus for frontends
    types.ts                  # Event envelope types

  frontends/
    host.ts                   # Frontend manager
    github/                   # GitHub integration frontend
    slack/                    # Slack integration frontend

  sandbox/
    types.ts                  # SandboxInstance interface, SandboxConfig
    sandbox-manager.ts        # Lifecycle management, engine routing
    docker-image-sandbox.ts   # Docker image-based sandbox
    docker-compose-sandbox.ts # Docker Compose sandbox
    bubblewrap-sandbox.ts     # Linux namespace isolation (bwrap)
    seatbelt-sandbox.ts       # macOS sandbox-exec isolation
    check-runner.ts           # Check execution in sandboxes
    env-filter.ts             # Environment variable filtering
    cache-volume-manager.ts   # Docker cache volumes
    sandbox-telemetry.ts      # Telemetry for sandbox operations

  utils/
    config-loader.ts          # Remote config loading
    config-merger.ts          # Configuration merging
    workspace-manager.ts      # Workspace isolation
    sandbox.ts                # JavaScript sandbox
    liquid-helpers.ts         # Liquid template helpers

  telemetry/
    opentelemetry.ts          # OTEL initialization
    trace-helpers.ts          # Span creation helpers
    fallback-ndjson.ts        # File-based trace export

  debug-visualizer/
    ws-server.ts              # WebSocket server for debug UI
```

---

## Appendix B: Configuration Schema Reference

The complete configuration schema is defined in `src/types/config.ts`. Key types:

```typescript
interface VisorConfig {
  version: string;
  checks: Record<string, CheckConfig>;
  steps?: Record<string, CheckConfig>;  // Alias for checks

  // Global settings
  max_parallelism?: number;
  fail_fast?: boolean;
  fail_if?: string;

  // AI configuration
  ai_provider?: string;
  ai_model?: string;
  ai_mcp_servers?: Record<string, McpServerConfig>;

  // Output configuration
  output?: OutputConfig;

  // HTTP server
  http_server?: HttpServerConfig;

  // Workflow imports
  imports?: string[];

  // Frontends (GitHub, Slack)
  frontends?: FrontendConfig[];

  // Telemetry
  telemetry?: TelemetryConfig;
}

interface CheckConfig {
  type: ConfigCheckType;
  prompt?: string;
  exec?: string;
  url?: string;

  // Dependencies and routing
  depends_on?: string[];
  on_success?: RoutingConfig;
  on_fail?: RoutingConfig;
  on_finish?: RoutingConfig;

  // Execution control
  if?: string;
  forEach?: string | boolean;
  timeout?: number;

  // Output handling
  schema?: string | object;
  transform_js?: string;
  fail_if?: string;

  // Metadata
  tags?: string[];
  group?: string;
  on?: EventTrigger[];
}
```

---

## Appendix C: Event Types

Events that flow through the state machine:

| Event | Description | Fields |
|-------|-------------|--------|
| `PlanBuilt` | Dependency graph constructed | `graph` |
| `WaveRequested` | New wave requested | `wave` |
| `LevelReady` | Execution level ready | `level`, `wave` |
| `LevelDepleted` | All checks in level complete | `level`, `wave` |
| `CheckScheduled` | Check dispatched for execution | `checkId`, `scope` |
| `CheckCompleted` | Check finished successfully | `checkId`, `scope`, `result` |
| `CheckErrored` | Check failed with error | `checkId`, `scope`, `error` |
| `ForwardRunRequested` | Routing triggered new check | `target`, `gotoEvent`, `scope`, `origin` |
| `WaveRetry` | Wave needs re-execution | `reason` |
| `StateTransition` | State machine transitioned | `from`, `to` |
| `Shutdown` | Engine shutting down | `error?` |

---

## Appendix D: Glossary

| Term | Definition |
|------|------------|
| **Check** | A single unit of work (AI analysis, command, HTTP call, etc.) |
| **Step** | Alias for check (used interchangeably) |
| **Wave** | A batch of checks executed in parallel |
| **Level** | Dependency level in the execution graph |
| **Provider** | Implementation of a check type |
| **Journal** | Execution history and output storage |
| **Scope** | Hierarchical path for nested workflow execution |
| **Frontend** | Integration point (GitHub, Slack) |
| **Routing** | Control flow based on check results |
| **MCP** | Model Context Protocol - standard for AI tool integration |
