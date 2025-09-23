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

checks:
  security_review:
    type: ai
    prompt: "Review code using available MCP tools"
    # Inherits global MCP servers automatically
```

#### Check-Level MCP Configuration

Override global MCP servers for specific checks:

```yaml
checks:
  performance_review:
    type: ai
    prompt: "Analyze performance using specialized tools"
    ai_mcp_servers:  # Overrides global servers
      probe:
        command: "npx"
        args: ["-y", "@probelabs/probe@latest", "mcp"]
      custom_profiler:
        command: "python3"
        args: ["./tools/performance-analyzer.py"]
```

#### AI Object-Level MCP Configuration

Most specific level - overrides both global and check-level:

```yaml
checks:
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

