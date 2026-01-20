### MCP (Model Context Protocol) Support for AI Providers

Visor supports MCP servers for AI providers, enabling enhanced code analysis with specialized tools. MCP servers can provide additional context and capabilities to AI models.

MCP configuration follows the same pattern as AI provider configuration, supporting global, check-level, and AI object-level settings.

#### Global MCP Configuration

Configure MCP servers once globally for all AI checks:

```yaml
# Global configuration
ai_provider: anthropic
ai_model: claude-3-sonnet
ai_mcp_servers:
  probe:
    command: "npx"
    args: ["-y", "@probelabs/probe@latest", "mcp"]
  filesystem:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/project"]

steps:
  security_review:
    type: ai
    prompt: "Review code using available MCP tools"
    # Inherits global MCP servers automatically
```

#### Check-Level MCP Configuration (YAML keys and precedence)

You can declare MCP servers for an individual check in two ways. Visor supports both and merges them with the following precedence (last wins):

1) Global: `ai_mcp_servers` at the root of `.visor.yaml` (applies to all AI checks)
2) Check level: `ai_mcp_servers` under a specific check (overrides global for that check)
3) AI object: `ai.mcpServers` inside the same check (highest precedence)

For Claude Code checks, use `claude_code.mcpServers` (provider‑specific) instead of `ai_mcp_servers`.

Override global MCP servers for specific checks:

```yaml
steps:
  performance_review:
    type: ai
    prompt: "Analyze performance using specialized tools"
    # Option A: check-level (recommended for simple cases)
    ai_mcp_servers:
      probe:
        command: "npx"
        args: ["-y", "@probelabs/probe@latest", "mcp"]
      custom_profiler:
        command: "python3"
        args: ["./tools/performance-analyzer.py"]
    # Option B: via ai.mcpServers (overrides check-level if both present)
    ai:
      mcpServers:
        probe:
          command: "npx"
          args: ["-y", "@probelabs/probe@latest", "mcp"]
```

#### AI Object-Level MCP Configuration

Most specific level - overrides both global and check-level:

```yaml
steps:
  comprehensive_review:
    type: ai
    prompt: "Comprehensive analysis with specific tools"
    ai:
      provider: anthropic
      mcpServers:  # Overrides everything else
        probe:
          command: "npx"
          args: ["-y", "@probelabs/probe@latest", "mcp"]
        github:
          command: "npx"
          args: ["-y", "@modelcontextprotocol/server-github"]

#### Claude Code Provider (check-level)

When using the `claude-code` provider, configure MCP servers under `claude_code.mcpServers`:

```yaml
steps:
  claude_with_mcp:
    type: claude-code
    prompt: "Analyze code complexity and architecture"
    claude_code:
      mcpServers:
        custom_analyzer:
          command: "node"
          args: ["./mcp-servers/analyzer.js"]
```

#### How Visor passes MCP to the engine

- For AI checks (`type: ai`), Visor forwards your MCP server configuration directly to the ProbeAgent SDK as:
  - `enableMcp: true`
  - `mcpConfig: { mcpServers: { ... } }`

  The SDK handles all MCP server lifecycle management including spawning processes, discovering tools, and routing tool calls.

- For Claude Code checks (`type: claude-code`), Visor passes `claude_code.mcpServers` configuration directly to the Claude Code SDK via the query object. The SDK manages all server operations internally.

Tip: run with `--debug` to see how many MCP servers were configured for a check.
```

#### Available MCP Servers

- Probe: Advanced code search and analysis (`@probelabs/probe`)
- Jira: Jira Cloud integration for issue management (`@orengrinker/jira-mcp-server`)
- Filesystem: File system access (`@modelcontextprotocol/server-filesystem`)
- GitHub: GitHub API access (coming soon)
- Custom: Your own MCP servers

#### Example Configurations

- [Basic MCP with Probe](../examples/ai-with-mcp.yaml) - Code analysis with multiple MCP servers
- [Jira Workflow Automation](../examples/jira-workflow-mcp.yaml) - Complete Jira integration examples
- [Simple Jira Analysis](../examples/jira-simple-example.yaml) - Basic JQL → analyze → label workflow
- [Setup Guide](../examples/JIRA_MCP_SETUP.md) - Detailed Jira MCP configuration instructions
