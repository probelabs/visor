# Using Custom Tools with AI (Simple Guide)

## TL;DR

You can expose custom shell-based tools to AI by adding `tools: [tool-names]` to your `ai_mcp_servers` configuration. No new config sections needed!

```yaml
tools:
  grep-pattern:
    name: grep-pattern
    exec: 'grep -rn "{{ args.pattern }}" *.ts'
    inputSchema:
      type: object
      properties:
        pattern: {type: string}
      required: [pattern]

steps:
  security-scan:
    type: ai
    prompt: Use grep-pattern to find security issues.
    ai_mcp_servers:
      custom-tools:
        tools: [grep-pattern]  # ← Automatically creates ephemeral SSE MCP server!
```

## How It Works

When you add `tools: [...]` to an MCP server config:

1. **Automatic Detection**: Visor detects you're referencing custom tools (not a command/URL)
2. **Server Startup**: Creates an ephemeral SSE MCP server on an available port
3. **Tool Exposure**: Your custom tools become available to the AI via MCP protocol
4. **Auto Cleanup**: Server stops automatically when the AI check completes

## Examples

### Example 1: Security Scanning

```yaml
tools:
  check-secrets:
    name: check-secrets
    description: Scan for hardcoded secrets
    exec: 'grep -rn -E "(api_key|secret|password)" .'
    inputSchema:
      type: object
      properties: {}

steps:
  security-review:
    type: ai
    prompt: Use check-secrets to find hardcoded credentials.
    ai_mcp_servers:
      security-tools:
        tools: [check-secrets]
```

### Example 2: Multiple Custom Tools

```yaml
tools:
  grep-pattern:
    name: grep-pattern
    exec: 'grep -rn "{{ args.pattern }}" *.ts'
    inputSchema:
      type: object
      properties:
        pattern: {type: string}
      required: [pattern]

  count-todos:
    name: count-todos
    exec: 'grep -r "TODO" src/ | wc -l'
    inputSchema:
      type: object
      properties: {}

steps:
  code-quality:
    type: ai
    prompt: |
      Use grep-pattern to find console.log statements.
      Use count-todos to count pending work items.
    ai_mcp_servers:
      custom-tools:
        tools: [grep-pattern, count-todos]
```

### Example 3: Combining Custom Tools with External MCP Servers

```yaml
steps:
  full-review:
    type: ai
    prompt: |
      You have both custom tools and external MCP servers.
      Use them for a comprehensive review.
    ai_mcp_servers:
      # Custom tools via ephemeral SSE server
      my-tools:
        tools: [grep-pattern, check-secrets]
      # External MCP server via stdio
      filesystem:
        command: npx
        args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
```

## Configuration Format

### Custom Tools Server (Ephemeral SSE)

```yaml
ai_mcp_servers:
  <server-name>:
    tools: [tool-name-1, tool-name-2, ...]
```

**Key points:**
- Server name can be anything (e.g., `custom-tools`, `my-tools`, `security-tools`)
- Tools must be defined in global `tools:` section
- Automatically creates SSE server on ephemeral port
- No command/URL needed - handled automatically

### External MCP Server (Traditional)

```yaml
ai_mcp_servers:
  <server-name>:
    command: <command>
    args: [<arg1>, <arg2>, ...]
```

**Key points:**
- Requires command to run external MCP server
- Uses stdio transport by default
- Can also use SSE/HTTP with `url:` and `transport:`

## Backward Compatibility

The old `ai_custom_tools` field still works for backward compatibility:

```yaml
steps:
  my-check:
    type: ai
    ai_custom_tools: [tool1, tool2]  # Still works!
```

But the **recommended approach** is to use `ai_mcp_servers` with `tools:` because:
- ✅ Consistent with existing MCP server configuration
- ✅ No new config fields to learn
- ✅ Easier to combine custom + external MCP servers
- ✅ More flexible (can name your tool server)

## Complete Example

```yaml
version: "1.0"

# Define custom tools (global section)
tools:
  grep-security:
    name: grep-security
    description: Search for security-related patterns
    inputSchema:
      type: object
      properties:
        pattern: {type: string}
      required: [pattern]
    exec: 'grep -rn "{{ args.pattern }}" src/'
    parseJson: false

  scan-dependencies:
    name: scan-dependencies
    description: Check for outdated dependencies
    inputSchema:
      type: object
      properties: {}
    exec: 'npm outdated --json 2>/dev/null || echo "{}"'
    parseJson: true

  count-lines:
    name: count-lines
    description: Count lines of code
    inputSchema:
      type: object
      properties:
        extension: {type: string}
      required: [extension]
    exec: 'find . -name "*.{{ args.extension }}" -exec wc -l {} + | tail -1'
    parseJson: false

# Use custom tools in AI checks
steps:
  security-audit:
    type: ai
    prompt: |
      Perform a security audit:
      1. Use grep-security to find eval(), exec(), or dangerous patterns
      2. Use scan-dependencies to check for outdated packages
      3. Report findings with severity levels
    ai_mcp_servers:
      security-tools:
        tools: [grep-security, scan-dependencies]
    ai:
      provider: anthropic
      model: claude-3-5-sonnet-20241022

  code-metrics:
    type: ai
    prompt: |
      Analyze code metrics:
      - Use count-lines to measure TypeScript code
      - Provide insights on code size and complexity
    ai_mcp_servers:
      metrics-tools:
        tools: [count-lines]
    ai:
      provider: anthropic
      model: claude-3-5-sonnet-20241022

output:
  pr_comment:
    enabled: true
    format: markdown
    group_by: check
    collapse: false
```

## Troubleshooting

### "Custom tool not found"

**Problem**: `Custom tool not found: my-tool`

**Solution**: Make sure the tool is defined in the global `tools:` section with the exact same name.

### "Failed to start custom tools SSE server"

**Problem**: Server fails to start

**Solutions**:
- Check if ports are available
- Verify tool definitions are valid
- Enable debug mode: `ai.debug: true`

### Tools not appearing to AI

**Problem**: AI says it doesn't have access to tools

**Solutions**:
- Verify `tools:` field in `ai_mcp_servers` (not `tool` singular)
- Check tool names match exactly (case-sensitive)
- Enable debug logging to see server startup

## See Also

- Full documentation: `docs/ai-custom-tools.md`
- Examples: `examples/ai-custom-tools-simple.yaml`
- Advanced examples: `examples/ai-custom-tools-example.yaml`
