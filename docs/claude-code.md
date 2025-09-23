## 🤖 Claude Code Provider

Visor includes advanced integration with Claude Code SDK, providing powerful AI-driven code analysis with MCP (Model Context Protocol) tools and subagent support.

### Features

- Advanced AI Analysis: Leverages Claude Code's sophisticated understanding
- MCP Tools: Built-in and custom tools for specialized analysis
- Subagents: Delegate specific tasks to specialized agents
- Streaming Responses: Real-time feedback during analysis
- Flexible Permissions: Granular control over tool usage

### Configuration

```yaml
checks:
  claude_comprehensive:
    type: claude-code
    prompt: "Perform a comprehensive security and performance review"
    tags: ["comprehensive", "security", "performance", "slow", "remote"]
    claude_code:
      allowedTools: ['Grep', 'Read', 'WebSearch']
      maxTurns: 5
      systemPrompt: "You are an expert security auditor"

  claude_with_mcp:
    type: claude-code
    prompt: "Analyze code complexity and architecture"
    tags: ["architecture", "complexity", "comprehensive", "remote"]
    claude_code:
      allowedTools: ['analyze_file_structure', 'calculate_complexity']
      mcpServers:
        custom_analyzer:
          command: "node"
          args: ["./mcp-servers/analyzer.js"]
          env:
            ANALYSIS_MODE: "deep"
```

### Built-in MCP Tools

- analyze_file_structure: Analyzes project organization
- detect_patterns: Identifies code patterns and anti-patterns
- calculate_complexity: Computes complexity metrics
- suggest_improvements: Provides improvement recommendations

### Custom MCP Servers

Create `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "security_scanner": {
      "command": "python",
      "args": ["./tools/security_scanner.py"],
      "env": {
        "SCAN_DEPTH": "full"
      }
    }
  }
}
```

### Environment Setup

```bash
# Install Claude Code CLI (required)
npm install -g @anthropic-ai/claude-code

# Set API key (optional - uses local Claude Code if available)
export CLAUDE_CODE_API_KEY=your-api-key
```

