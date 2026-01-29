## Claude Code Provider

Visor includes advanced integration with the Claude Code SDK, providing powerful AI-driven code analysis with MCP (Model Context Protocol) tools and subagent support.

### Features

- **Advanced AI Analysis**: Leverages Claude Code's sophisticated understanding
- **MCP Tools**: Custom tools for specialized analysis via MCP servers
- **Subagents**: Delegate specific tasks to specialized agents
- **Session Reuse**: Continue conversations across dependent checks
- **Flexible Permissions**: Granular control over tool usage

### Configuration Options

The `claude_code` configuration block supports the following options:

| Option | Type | Description |
|--------|------|-------------|
| `allowedTools` | `string[]` | List of tool names Claude can use (e.g., `['Grep', 'Read', 'WebSearch']`) |
| `maxTurns` | `number` | Maximum conversation turns (default: 5) |
| `systemPrompt` | `string` | Custom system prompt for the analysis |
| `mcpServers` | `object` | MCP server configurations (see below) |
| `subagent` | `string` | Path to a subagent definition file |
| `hooks` | `object` | Lifecycle hooks (`onStart`, `onEnd`, `onError`) |

### Basic Example

```yaml
steps:
  claude_security_review:
    type: claude-code
    prompt: "Perform a comprehensive security review"
    claude_code:
      allowedTools: ['Grep', 'Read', 'WebSearch']
      maxTurns: 5
      systemPrompt: "You are an expert security auditor"
```

### Example with MCP Servers

```yaml
steps:
  claude_with_mcp:
    type: claude-code
    prompt: "Analyze code complexity and architecture"
    claude_code:
      allowedTools: ['Read', 'Grep', 'custom_tool']
      mcpServers:
        custom_analyzer:
          command: "node"
          args: ["./mcp-servers/analyzer.js"]
          env:
            ANALYSIS_MODE: "deep"
```

### MCP Server Configuration

Each MCP server entry supports:

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `command` | `string` | Yes | The command to spawn the MCP server |
| `args` | `string[]` | No | Command line arguments |
| `env` | `object` | No | Environment variables for the server process |

### Subagents

Use the `subagent` option to delegate tasks to specialized agents:

```yaml
steps:
  claude_comprehensive:
    type: claude-code
    prompt: "Perform a comprehensive code review"
    claude_code:
      subagent: "./.claude/agents/code-reviewer.md"
      maxTurns: 10
```

### Hooks

Lifecycle hooks allow custom processing at different stages:

```yaml
steps:
  claude_with_hooks:
    type: claude-code
    prompt: "Review the code"
    claude_code:
      hooks:
        onStart: "echo 'Starting review'"
        onEnd: "echo 'Review complete'"
        onError: "./scripts/handle-error.sh"
```

### Session Reuse

Reuse Claude Code sessions across dependent checks for context continuity:

```yaml
steps:
  initial_analysis:
    type: claude-code
    prompt: "Analyze the code structure"
    claude_code:
      maxTurns: 3

  follow_up:
    type: claude-code
    prompt: "Based on the previous analysis, suggest improvements"
    depends_on: [initial_analysis]
    reuse_ai_session: true
```

### Environment Variables

The provider requires an API key via one of these environment variables:

```bash
# Option 1: Claude Code specific key
export CLAUDE_CODE_API_KEY=your-api-key

# Option 2: General Anthropic API key
export ANTHROPIC_API_KEY=your-api-key
```

### Required Dependencies

Install the Claude Code SDK:

```bash
npm install @anthropic/claude-code-sdk @modelcontextprotocol/sdk
```

### Complete Example

See [examples/claude-code-config.yaml](../examples/claude-code-config.yaml) for a comprehensive configuration example.

### Related Documentation

- [MCP Support for AI Providers](./mcp.md) - General MCP configuration
- [AI Configuration](./ai-configuration.md) - Standard AI provider configuration
- [Configuration](./configuration.md) - General configuration reference

