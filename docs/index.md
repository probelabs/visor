# Visor Documentation

Visor is an AI-powered workflow orchestration tool for code review, automation, and CI/CD pipelines. It supports multiple AI providers, pluggable check providers, and integrates with GitHub Actions and Slack.

---

## Getting Started

| Document | Description |
|----------|-------------|
| [NPM Usage](./NPM_USAGE.md) | Quick start guide for installing and running Visor via npm/npx |
| [Configuration](./configuration.md) | Core configuration reference for `.visor.yaml` files |
| [Commands](./commands.md) | CLI commands and PR comment commands reference |
| [Action Reference](./action-reference.md) | GitHub Action inputs, outputs, and usage examples |
| [CI/CLI Mode](./ci-cli-mode.md) | Running Visor in CI pipelines and CLI mode |

---

## Configuration

| Document | Description |
|----------|-------------|
| [Configuration](./configuration.md) | Main configuration guide including check types and validation |
| [Tag Filtering](./tag-filtering.md) | Filter check execution using tags for different environments |
| [Event Triggers](./event-triggers.md) | GitHub events and how to trigger checks based on PR/issue actions |
| [Timeouts](./timeouts.md) | Per-provider timeout configuration and behavior |
| [Execution Limits](./limits.md) | Run caps and loop protection for workflow safety |
| [Liquid Templates](./liquid-templates.md) | Template syntax for dynamic content in prompts and commands |
| [Schema Templates](./schema-templates.md) | JSON Schema validation and output rendering system |
| [Default Output Schema](./default-output-schema.md) | Automatic timestamp injection and output normalization |
| [Suppressions](./suppressions.md) | Suppressing warnings using code comments |

---

## Providers

Visor supports 15 provider types for different check and workflow operations.

### AI Providers

| Document | Description |
|----------|-------------|
| [AI Configuration](./ai-configuration.md) | Configure AI providers (Gemini, Claude, OpenAI, Bedrock) |
| [Claude Code](./claude-code.md) | Claude Code SDK integration with MCP tools and subagents |
| [Advanced AI](./advanced-ai.md) | Session reuse, multi-turn conversations, and advanced AI features |
| [AI Custom Tools](./ai-custom-tools.md) | Define custom shell-based tools for AI via ephemeral MCP servers |
| [AI Custom Tools Usage](./ai-custom-tools-usage.md) | Practical examples of using custom tools with AI providers |
| [MCP Support for AI](./mcp.md) | MCP server configuration for AI provider enhancement |

### Execution Providers

| Document | Description |
|----------|-------------|
| [MCP Provider](./mcp-provider.md) | Direct MCP tool execution via stdio, SSE, or HTTP transports |
| [Command Provider](./command-provider.md) | Execute shell commands with output parsing and templating |
| [Script Provider](./script.md) | Run JavaScript in a secure sandbox with PR context access |
| [Custom Tools](./custom-tools.md) | Define reusable command-line tools in YAML configuration |

### Integration Providers

| Document | Description |
|----------|-------------|
| [HTTP Integration](./http.md) | HTTP server, webhooks, scheduling, and TLS configuration |
| [GitHub Provider](./github-ops.md) | Native GitHub operations (labels, comments) via Octokit |
| [Git Checkout](./providers/git-checkout.md) | Checkout code from repositories using git worktrees |
| [Memory Provider](./memory.md) | Persistent key-value storage for stateful workflows |
| [Human Input](./human-input-provider.md) | Pause workflows to collect user input via CLI, stdin, or SDK |

### Utility Providers

| Document | Description |
|----------|-------------|
| [Pluggable Architecture](./pluggable.md) | Overview of all providers and custom provider development |

---

## Workflows and Routing

| Document | Description |
|----------|-------------|
| [Reusable Workflows](./workflows.md) | Define modular, parameterized workflow components |
| [Dependencies](./dependencies.md) | Step dependencies, parallel execution, and DAG scheduling |
| [Failure Routing](./failure-routing.md) | Auto-fix loops, retries, goto routing, and remediation |
| [Router Patterns](./router-patterns.md) | Best practices for router steps and control flow |
| [Lifecycle Hooks](./lifecycle-hooks.md) | on_init, on_success, on_fail, on_finish hooks |
| [ForEach Propagation](./foreach-dependency-propagation.md) | ForEach output validation and dependent propagation |
| [Output History](./output-history.md) | Track outputs across loops, retries, and forEach iterations |
| [Fail If](./fail-if.md) | Conditional failure expressions for any provider |
| [Author Permissions](./author-permissions.md) | Permission checking functions based on PR author association |
| [Workflow Creation Guide](./workflow-creation-guide.md) | Comprehensive guide to creating Visor workflows |
| [Recipes](./recipes.md) | Copy-pasteable examples for common workflow patterns |

---

## Testing

The test framework allows you to write integration tests for your Visor workflows in YAML.

| Document | Description |
|----------|-------------|
| [Getting Started](./testing/getting-started.md) | Quick start guide for writing and running tests |
| [CLI Reference](./testing/cli.md) | Test runner commands, flags, and parallelism options |
| [DSL Reference](./testing/dsl-reference.md) | Complete schema reference for `.visor.tests.yaml` files |
| [Assertions](./testing/assertions.md) | Writing expectations for calls, prompts, outputs, and failures |
| [Flow Tests](./testing/flows.md) | Multi-stage flow tests across multiple events |
| [Fixtures and Mocks](./testing/fixtures-and-mocks.md) | Built-in fixtures and mocking AI/provider responses |
| [CI Integration](./testing/ci.md) | Running tests in CI pipelines with reporting |
| [Troubleshooting](./testing/troubleshooting.md) | Common test issues and solutions |
| [Cookbook](./testing/cookbook.md) | Copy-pasteable test recipes for common scenarios |

---

## Integrations

| Document | Description |
|----------|-------------|
| [GitHub Checks](./GITHUB_CHECKS.md) | GitHub Checks API integration for PR status reporting |
| [Slack Integration](./slack-integration.md) | Bidirectional Slack integration via Socket Mode |
| [Deployment](./DEPLOYMENT.md) | Cloudflare Pages deployment for landing page |

---

## Observability

| Document | Description |
|----------|-------------|
| [Observability Overview](./observability.md) | Output formats, logging, telemetry, and execution statistics |
| [Output Formats](./output-formats.md) | Table, JSON, markdown, and SARIF output format details |
| [Debugging](./debugging.md) | Debug mode, logging, expression debugging, and visualizer |
| [Telemetry Setup](./telemetry-setup.md) | OpenTelemetry configuration for traces and metrics |
| [Dashboards](./dashboards/README.md) | Grafana dashboards for Visor telemetry visualization |
| [Troubleshooting](./troubleshooting.md) | Common issues and diagnostic techniques |
| [Performance](./performance.md) | Parallelism, cost controls, and optimization strategies |

---

## Guides

Best practices and style guides for writing maintainable workflows.

| Document | Description |
|----------|-------------|
| [Workflow Style Guide](./guides/workflow-style-guide.md) | Conventions for clear, safe, and maintainable workflows |
| [Criticality Modes](./guides/criticality-modes.md) | external, internal, policy, info classification and defaults |
| [Fault Management](./guides/fault-management-and-contracts.md) | NASA-style fault handling with assume/guarantee contracts |
| [Security](./security.md) | Authentication, permissions, and security best practices |
| [Development Playbook](./dev-playbook.md) | Internal development guide and conventions |

---

## Reference

| Document | Description |
|----------|-------------|
| [SDK](./sdk.md) | Programmatic usage of Visor from Node.js |
| [Output Formatting](./output-formatting.md) | Output format specification and customization |

---

## RFCs and Design Documents

Internal design documents, proposals, and implementation tracking.

### Implemented RFCs

| Document | Description |
|----------|-------------|
| [Git Checkout Step](./rfc/git-checkout-step.md) | Design for git worktree-based checkout provider |
| [Workspace Isolation](./rfc/workspace-isolation.md) | Isolated workspace implementation using /tmp |
| [on_init Hook](./rfc/on_init-hook.md) | Lifecycle hook for context preprocessing |
| [Telemetry Tracing](./telemetry-tracing-rfc.md) | OpenTelemetry tracing architecture |
| [Test Framework](./test-framework-rfc.md) | In-YAML integration test framework design |

### Design Documents

| Document | Description |
|----------|-------------|
| [Failure Routing RFC](./failure-routing-rfc.md) | Auto-fix loops and routing design |
| [Failure Conditions Schema](./failure-conditions-schema.md) | Schema for failure condition configuration |
| [Failure Conditions Implementation](./failure-conditions-implementation.md) | Implementation details for failure handling |
| [Engine State Machine Plan](./engine-state-machine-plan.md) | State machine execution engine design |
| [Loop Routing Refactor](./loop-routing-refactor.md) | Refactoring plan for routing loops |
| [Goto Forward Run Plan](./goto-forward-run-plan.md) | Forward-run implementation for goto routing |
| [Debug Visualizer](./debug-visualizer.md) | Interactive debugging visualizer design |
| [Debug Visualizer RFC](./debug-visualizer-rfc.md) | Debug visualizer architecture RFC |
| [Debug Visualizer Progress](./debug-visualizer-progress.md) | Implementation progress tracker |
| [Execution Statistics RFC](./execution-statistics-rfc.md) | Execution metrics and statistics design |
| [Event-Driven GitHub](./event-driven-github-integration-rfc.md) | Event-driven GitHub integration design |
| [Bot Transports RFC](./bot-transports-rfc.md) | Transport layer design for bot integrations |
| [Engine Pause/Resume RFC](./engine-pause-resume-rfc.md) | Pause and resume functionality design |
| [Visor SDK RFC](./visor-sdk-rfc.md) | SDK architecture and API design |
| [Schema Next PR](./schema-next-pr.md) | Schema evolution planning |

### Proposals

| Document | Description |
|----------|-------------|
| [Snapshot Scope Execution](./proposals/snapshot-scope-execution.md) | MVCC-style snapshot isolation execution model |

### Roadmap

| Document | Description |
|----------|-------------|
| [Criticality Implementation](./roadmap/criticality-implementation-tasks.md) | Implementation tasks for criticality model |
| [Fact Validator Implementation](./fact-validator-implementation-plan.md) | Fact validation feature implementation plan |
| [Fact Validator Gap Analysis](./fact-validator-gap-analysis.md) | Gap analysis for fact validation system |
