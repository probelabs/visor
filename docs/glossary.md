# Visor Glossary

This glossary provides definitions for all key terms and concepts used in Visor. For detailed documentation on specific topics, follow the links to the relevant documentation pages.

## A

### AI Provider
An integration with a large language model service (Google Gemini, Anthropic Claude, OpenAI GPT, AWS Bedrock) that enables AI-powered code analysis. Configured via `type: ai` in step definitions. See [AI Configuration](./ai-configuration.md).

### `appendPrompt`
A configuration option that appends additional text to an inherited prompt when using `extends`. The parent and child prompts are joined with a double newline. See [Configuration](./configuration.md).

### `args`
Input parameter values passed to a workflow when invoking it via `type: workflow`. Also used in `on_init` hooks to pass arguments to tools, steps, or workflows. See [Workflows](./workflows.md).

### `argsTransform`
A Liquid template that dynamically constructs method arguments for MCP provider calls. See [MCP Provider](./mcp-provider.md).

### `assume`
A precondition (contract) that must be true before a step executes. If false, the step is skipped with `skipReason='assume'`. Used for pre-execution validation of environment variables, memory values, or upstream outputs. See [Fault Management Guide](./guides/fault-management-and-contracts.md).

## B

### Backoff Policy
Configuration for retry delays. Supports `fixed` (constant delay) or `exponential` (increasing delay with optional jitter) modes. Configured via `on_fail.retry.backoff`. See [Failure Routing](./failure-routing.md).

## C

### Check
A single unit of work in a Visor workflow. Each check has a type (provider), configuration, and optional dependencies. The terms "check" and "step" are used interchangeably; `steps:` is the recommended configuration key.

### Check Provider
A pluggable component that executes a specific type of check. Visor includes 15 built-in providers: `ai`, `claude-code`, `mcp`, `command`, `script`, `http`, `http_input`, `http_client`, `memory`, `noop`, `log`, `github`, `human-input`, `workflow`, and `git-checkout`. See [Pluggable Architecture](./pluggable.md).

### Claude Code Provider
A provider (`type: claude-code`) that integrates the Claude Code SDK with MCP tools and advanced agent capabilities including subagents and streaming. See [Claude Code](./claude-code.md).

### Command Provider
A provider (`type: command`) that executes shell commands with Liquid template support. Configured via `exec` field. See [Command Provider](./command-provider.md).

### `continue_on_failure`
A boolean flag that allows dependent steps to run even if this step fails. Defaults to `false` for critical steps and `true` for `info` criticality. Similar to GitHub Actions' `continue-on-error`. See [Configuration](./configuration.md).

### Contracts
Design-by-contract primitives (`assume`, `guarantee`, `fail_if`) that define preconditions, postconditions, and failure policies for steps. See [Fault Management Guide](./guides/fault-management-and-contracts.md).

### Criticality
A classification (`external`, `internal`, `policy`, `info`) that indicates the operational risk level of a step. Drives default safety policies for contracts, retries, loop budgets, and dependency gating. See [Criticality Modes Guide](./guides/criticality-modes.md).

#### Criticality Levels

| Level | Description | Use When |
|-------|-------------|----------|
| `external` | Mutates external systems (GitHub, HTTP POST, file writes) | Step has side effects outside the engine |
| `internal` | Steers execution (forEach, routing, flags) | Step controls workflow routing |
| `policy` | Enforces permissions or compliance | Step gates external actions |
| `info` | Read-only, non-critical | Pure computation, safe to fail |

### Custom Tools
User-defined MCP tools specified in the `tools:` section of configuration. Can be invoked via `transport: custom` in MCP checks or in `on_init` hooks. See [Custom Tools](./custom-tools.md).

## D

### Dependency Graph
The internal data structure that tracks dependencies between steps, used to determine execution order. Steps declare dependencies via `depends_on`.

### `depends_on`
A field that declares which steps must complete before this step runs. Accepts a single string or array of step names. See [Configuration](./configuration.md).

## E

### Engine
The execution runtime that orchestrates step execution based on dependencies, events, and routing rules. Operates in either `legacy` or `state-machine` mode.

### Engine State
The current phase of execution in the state machine engine. States include: `Init`, `PlanReady`, `WavePlanning`, `LevelDispatch`, `CheckRunning`, `Routing`, `Completed`, and `Error`.

### Event Trigger
A condition that determines when a step runs. Valid triggers: `pr_opened`, `pr_updated`, `pr_closed`, `issue_opened`, `issue_comment`, `manual`, `schedule`, `webhook_received`. Configured via the `on:` field. See [Event Triggers](./event-triggers.md).

### Execution Context
The runtime environment provided to step execution, including PR information, outputs from dependencies, memory store access, and environment variables.

### `extends`
A configuration option that inherits settings from another configuration file (local path, HTTP URL, or `default`). Supports single or multiple extends with merge semantics. See [Configuration](./configuration.md).

## F

### `fail_if`
A JavaScript expression that marks a step as failed when it evaluates to true. Used for policy and threshold decisions. Triggers `on_fail` routing. See [Fail If](./fail-if.md).

### Failure Routing
Configuration (`on_fail`) that defines how to handle step failures, including retry policies, remediation steps (`run`), and jump-back routing (`goto`). See [Failure Routing](./failure-routing.md).

### Fanout
The `fanout` field controls how routing targets behave when invoked from a `forEach` context. `map` schedules once per item; `reduce` schedules a single aggregation run. See [Failure Routing](./failure-routing.md).

### `forEach`
A boolean flag that processes a step's output as an array, running dependent steps once per item. Enables parallel processing and iteration patterns. See [Failure Routing](./failure-routing.md).

### Frontends
Event-driven integration points that trigger Visor workflows. Includes GitHub (webhooks) and Slack (Socket Mode). Configured via `frontends:` section. See [Slack Integration](./slack-integration.md).

## G

### Git-Checkout Provider
A provider (`type: git-checkout`) that checks out code from git repositories using efficient worktree management. Supports cross-repository comparisons. See [Git Checkout](./providers/git-checkout.md).

### GitHub Provider
A provider (`type: github`) that interacts with the GitHub API for operations like adding labels, creating comments, and managing status checks. See [Configuration](./configuration.md).

### `goto`
A routing directive that jumps back to a previously executed ancestor step. Used in `on_success`, `on_fail`, and `on_finish` hooks. See [Failure Routing](./failure-routing.md).

### `goto_event`
An event override used with `goto` to simulate a different event during the jump. For example, jumping to a PR step from an issue comment flow while treating it as `pr_updated`. See [Event Triggers](./event-triggers.md).

### `goto_js`
A JavaScript expression that dynamically computes the target step for a `goto`. Returns a step ID string or `null` to skip routing. See [Failure Routing](./failure-routing.md).

### `guarantee`
A postcondition (contract) that must hold after a step completes. Violations add `contract/guarantee_failed` issues and route via `on_fail`. Used for assertions about produced output shape and values. See [Fault Management Guide](./guides/fault-management-and-contracts.md).

### Group
A logical grouping for steps that controls how results are organized in PR comments. Steps with the same `group` value appear together. Configured via the `group:` field.

## H

### HTTP Client Provider
A provider (`type: http_client`) that makes HTTP requests to external APIs and returns the response for use by dependent steps. See [HTTP Integration](./http.md).

### HTTP Input Provider
A provider (`type: http_input`) that receives incoming webhooks at a configured endpoint. Triggers the `webhook_received` event. See [HTTP Integration](./http.md).

### HTTP Provider
A provider (`type: http`) that sends check results to external webhooks. Used for notifications and integrations. See [HTTP Integration](./http.md).

### Human Input Provider
A provider (`type: human-input`) that pauses workflow execution to request input from a user. In Slack, consumes thread messages; in CLI, prompts for input. See [Human Input Provider](./human-input-provider.md).

## I

### `if`
A JavaScript expression that determines whether a step should run. Evaluated at scheduling time; if false, the step is skipped. See [Configuration](./configuration.md).

### `imports`
A configuration field that loads workflow definitions from external files or URLs. Imported workflows can be invoked via `type: workflow`. See [Workflows](./workflows.md).

### Issue
A detected problem or suggestion from a check. Has properties like `file`, `line`, `message`, `severity`, `category`, and `ruleId`. Collected and displayed in PR comments or output formats.

## J

### Journal
The execution journal that records all check results, routing decisions, and state transitions. Used for debugging, auditing, and snapshot persistence.

## L

### Lifecycle Hooks
Four hooks that control step execution at different phases: `on_init` (before), `on_success` (after success), `on_fail` (after failure), `on_finish` (after all forEach iterations). See [Lifecycle Hooks](./lifecycle-hooks.md).

### Limits
Global execution constraints configured via `limits:`. Includes `max_runs_per_check` (default 50) and `max_workflow_depth` (default 3). See [Limits](./limits.md).

### Liquid Templates
A templating language used throughout Visor for dynamic values in prompts, commands, HTTP bodies, and transforms. Provides access to `pr`, `files`, `outputs`, `memory`, and `env` contexts. See [Liquid Templates](./liquid-templates.md).

### Log Provider
A provider (`type: log`) that outputs messages for debugging and workflow visibility. Supports message templates, log levels, and context inclusion. See [Debugging](./debugging.md).

### Loop Budget
The `routing.max_loops` setting that caps routing transitions (goto + run) per scope. Default is 10; recommended 8 for control-plane flows. Prevents infinite loops. See [Failure Routing](./failure-routing.md).

## M

### MCP (Model Context Protocol)
A protocol for AI tools that enables models to interact with external systems. Visor supports MCP via the `mcp` provider (direct tool calls) and within AI providers (enhancing AI with tools). See [MCP Provider](./mcp-provider.md) and [MCP Tools](./mcp.md).

### Memory Provider
A provider (`type: memory`) that provides persistent key-value storage across checks. Supports operations: `get`, `set`, `append`, `increment`, `delete`, `clear`, `list`. Enables stateful workflows. See [Memory](./memory.md).

### Memory Store
The runtime storage system accessible via the `memory` object in JavaScript expressions and Liquid templates. Supports namespaces for isolation. See [Memory](./memory.md).

## N

### Namespace
A memory isolation context that separates key-value data between different workflows or concerns. Configured via `memory.namespace` globally or `namespace:` per step.

### Noop Provider
A provider (`type: noop`) that performs no operation. Used for dependency triggering, control flow, and routing-only steps. See [Noop Provider](./providers/noop.md).

## O

### `on_fail`
A lifecycle hook that runs after a step fails. Supports `retry`, `run` (remediation steps), `goto` (jump-back), and dynamic variants (`run_js`, `goto_js`). See [Lifecycle Hooks](./lifecycle-hooks.md).

### `on_finish`
A lifecycle hook for `forEach` steps that runs once after all iterations and all dependent checks complete. Used for aggregation and validation across all items. See [Lifecycle Hooks](./lifecycle-hooks.md).

### `on_init`
A lifecycle hook that runs before a step executes. Used for preprocessing, data fetching, and context enrichment. Can invoke tools, steps, or workflows. See [Lifecycle Hooks](./lifecycle-hooks.md).

### `on_success`
A lifecycle hook that runs after a step completes successfully. Supports `run` (post-processing steps), `goto` (routing), and dynamic variants. See [Lifecycle Hooks](./lifecycle-hooks.md).

### Output
The result produced by a step, accessible via `outputs['step-name']` in subsequent steps. Can be transformed via `transform` or `transform_js`. See [Output History](./output-history.md).

### Output History
The `outputs.history` or `outputs_history` accessor that provides all historical values for a step across loop iterations. Used in routing decisions and aggregation. See [Output History](./output-history.md).

### Output Mapping
The `output_mapping` field in workflow invocations that maps workflow output names to check output names. See [Workflows](./workflows.md).

## P

### Provider
See [Check Provider](#check-provider).

### PR Context
The pull request information available in templates and expressions: `pr.number`, `pr.title`, `pr.author`, `pr.branch`, `pr.base`, etc. Also includes `files` (changed files) and `fileCount`.

## R

### Retry Policy
Configuration for automatic retries on step failure. Includes `max` (maximum attempts) and `backoff` (delay strategy). Configured via `on_fail.retry`. See [Failure Routing](./failure-routing.md).

### Routing
The system for controlling workflow execution flow via `goto`, `run`, and `transitions`. Enables loops, remediation, and dynamic execution paths. See [Failure Routing](./failure-routing.md) and [Router Patterns](./router-patterns.md).

### `run`
A routing directive that executes specified steps. Used in `on_init`, `on_success`, `on_fail`, and `on_finish` hooks. See [Lifecycle Hooks](./lifecycle-hooks.md).

### `run_js`
A JavaScript expression that dynamically computes which steps to run. Returns a string array of step IDs. See [Failure Routing](./failure-routing.md).

## S

### Schema
The `schema` field that specifies output format and validation. String values select template renderers (e.g., `code-review`, `markdown`). Object values provide JSON Schema for output validation. See [Configuration](./configuration.md).

### Scope
An execution context that tracks loop counters, attempt numbers, and forEach item indexes. Each forEach item creates a child scope. Used for isolation and loop budget enforcement.

### Script Provider
A provider (`type: script`) that executes JavaScript in a secure sandbox with access to PR context, outputs, memory, and environment. Configured via `content` field. See [Script](./script.md).

### Session
An AI conversation context that can be reused across steps via `reuse_ai_session`. Supports `clone` (copy history) or `append` (share history) modes.

### Slack Integration
Bidirectional Slack integration via Socket Mode that enables chat assistants, human input collection, and notifications. Configured via `slack:` section and `--slack` flag. See [Slack Integration](./slack-integration.md).

### Snapshot
A serialized state of workflow execution stored in the journal. Enables debugging, replay, and session resume.

### State Machine
The execution engine mode (`mode: 'state-machine'`) that processes steps in waves with sophisticated routing and loop control. The default for modern Visor workflows.

### Step
See [Check](#check). The recommended term and configuration key (`steps:` instead of `checks:`).

### Suppression
The ability to disable specific issues via inline comments (`// visor-disable: rule-id`). Controlled by `output.suppressionEnabled`. See [Suppressions](./suppressions.md).

## T

### Tags
Labels attached to steps for categorization and filtering. Common patterns: `local`/`remote`, `fast`/`slow`, `security`, `experimental`. Configured via `tags:` field. See [Tag Filtering](./tag-filtering.md).

### Tag Filter
Configuration (`tag_filter:` or `--tags`/`--exclude-tags`) that selectively runs steps based on their tags. Supports `include` and `exclude` arrays. See [Tag Filtering](./tag-filtering.md).

### Telemetry
OpenTelemetry-based tracing and metrics for debugging and observability. Configurable via environment variables or `telemetry:` section. Supports OTLP, file, and console sinks. See [Telemetry Setup](./telemetry-setup.md).

### Transform
The `transform` (Liquid) or `transform_js` (JavaScript) fields that modify step output before it's stored and passed to dependents. See [MCP Provider](./mcp-provider.md).

### Transitions
Declarative routing rules in `on_success`, `on_fail`, or `on_finish` blocks. Each rule has `when` (condition), `to` (target step), and optional `goto_event`. Evaluated in order; first match wins. See [Failure Routing](./failure-routing.md).

## V

### Validate Command
The `visor validate` CLI command that checks configuration files for errors before running. Validates schema compliance, check types, and event triggers. See [Configuration](./configuration.md).

### Visor
An AI-powered workflow orchestration tool for code review and automation. Runs as a GitHub Action or CLI tool.

## W

### Wave
A batch of steps executed in parallel during a single phase of the state machine. The engine processes waves iteratively based on the dependency graph and routing decisions.

### Webhook
An HTTP endpoint that receives external events. Configured via `http_server:` for incoming webhooks and `type: http` for outgoing notifications. See [HTTP Integration](./http.md).

### Workflow
A reusable, parameterized sequence of steps that can be invoked via `type: workflow`. Defined in separate files with `inputs`, `outputs`, and `steps`. Imported via the `imports:` field. See [Workflows](./workflows.md).

### Workflow Composition
The pattern of workflows invoking other workflows. Supports nested execution up to `limits.max_workflow_depth` (default 3). See [Workflows](./workflows.md).

### Workflow Provider
A provider (`type: workflow`) that executes a reusable workflow definition. Supports `args`, `overrides`, and `output_mapping`. See [Workflows](./workflows.md).

### Workspace
An isolated execution environment for workflows. Configured via `workspace:` section. Provides sandboxed file system access. See [Workspace Isolation RFC](./rfc/workspace-isolation.md).

---

## See Also

- [Configuration Reference](./configuration.md)
- [Pluggable Architecture](./pluggable.md)
- [Event Triggers](./event-triggers.md)
- [Lifecycle Hooks](./lifecycle-hooks.md)
- [Failure Routing](./failure-routing.md)
- [Workflows](./workflows.md)
- [Debugging](./debugging.md)
