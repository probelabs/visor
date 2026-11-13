# Using Custom Tools with AI (Simple Guide)

## TL;DR

You can expose custom shell-based tools to AI using one of two methods:

**Method 1: Using `ai_custom_tools` (Recommended)**
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
    ai_custom_tools: [grep-pattern]  # Simple and explicit
```

**Method 2: Using `tools:` within `ai_mcp_servers`**
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
        tools: [grep-pattern]  # Creates ephemeral SSE MCP server
```

## How It Works

When you use either `ai_custom_tools` or `tools: [...]` within an MCP server config:

1. **Automatic Detection**: Visor detects you're referencing custom tools defined in the global `tools:` section
2. **Server Startup**: Creates an ephemeral SSE MCP server on an available port
3. **Tool Exposure**: Your custom tools become available to the AI via MCP protocol
4. **Auto Cleanup**: Server stops automatically when the AI check completes

## Examples

### Example 0: OpenAPI API Bundle Tool

```yaml
tools:
  users-api:
    type: api
    name: users-api
    spec: ./openapi/users.yaml
    headers:
      Authorization: "Bearer ${USERS_API_BEARER_TOKEN}"
      X-Tenant-Id: "${USERS_API_TENANT_ID}"
    overlays:
      - ./openapi/users-overlay.yaml
      - actions:
          - target: "$.paths['/users/{id}'].get.operationId"
            update: getUserFromInlineOverlay
    whitelist: [get*]
    targetUrl: https://api.example.com

steps:
  api-assistant:
    type: ai
    prompt: Use users API tools to answer requests.
    ai_custom_tools: [users-api]
```

`users-api` is a reusable tool bundle; each OpenAPI operation becomes an MCP tool exposed to AI.
`spec` and `overlays` support both inline objects and file/URL references.
`headers` also supports environment-variable interpolation (for example `Authorization: "Bearer ${USERS_API_BEARER_TOKEN}"`).

Repository examples:

- `examples/api-tools-library.yaml`
- `examples/api-tools-ai-example.yaml` (embedded tests)
- `examples/api-tools-mcp-example.yaml` (embedded tests)
- `examples/api-tools-inline-overlay-example.yaml` (embedded tests)

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
    ai_custom_tools: [check-secrets]
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
    ai_custom_tools: [grep-pattern, count-todos]
```

### Example 3: Combining Custom Tools with External MCP Servers

```yaml
steps:
  full-review:
    type: ai
    prompt: |
      You have both custom tools and external MCP servers.
      Use them for a comprehensive review.
    # Custom tools via ai_custom_tools
    ai_custom_tools: [grep-pattern, check-secrets]
    # External MCP servers
    ai_mcp_servers:
      filesystem:
        command: npx
        args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
```

## Configuration Format

### Method 1: ai_custom_tools (Recommended)

```yaml
steps:
  my-check:
    type: ai
    ai_custom_tools: [tool-name-1, tool-name-2, ...]
```

**Key points:**
- Simple and explicit configuration
- Tools must be defined in global `tools:` section
- Automatically creates SSE server on ephemeral port
- Can be combined with `ai_mcp_servers` for external servers

### Method 2: tools: within ai_mcp_servers

```yaml
ai_mcp_servers:
  <server-name>:
    tools: [tool-name-1, tool-name-2, ...]
```

**Key points:**
- Server name can be anything (e.g., `custom-tools`, `my-tools`)
- Tools must be defined in global `tools:` section
- Automatically creates SSE server on ephemeral port
- No command/URL needed - handled automatically

### External MCP Server (for comparison)

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

## Both Methods Work

Both configuration methods are fully supported:

```yaml
steps:
  # Method 1: ai_custom_tools (recommended for simplicity)
  check-with-custom-tools:
    type: ai
    ai_custom_tools: [tool1, tool2]

  # Method 2: tools: in ai_mcp_servers (useful for naming)
  check-with-mcp-tools:
    type: ai
    ai_mcp_servers:
      my-security-tools:
        tools: [tool1, tool2]
```

**Choose `ai_custom_tools` when:**
- You want simple, explicit configuration
- You're combining custom tools with external MCP servers

**Choose `tools:` in `ai_mcp_servers` when:**
- You want to name your tool server
- You prefer all MCP configuration in one place

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
    ai_custom_tools: [grep-security, scan-dependencies]
    ai:
      provider: anthropic
      model: claude-3-5-sonnet-20241022

  code-metrics:
    type: ai
    prompt: |
      Analyze code metrics:
      - Use count-lines to measure TypeScript code
      - Provide insights on code size and complexity
    ai_custom_tools: [count-lines]
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
- Verify `ai_custom_tools:` syntax (not `ai_custom_tool` singular)
- If using `ai_mcp_servers`, verify `tools:` field (not `tool` singular)
- Check tool names match exactly (case-sensitive)
- Enable debug logging to see server startup

## See Also

- Full documentation: `docs/ai-custom-tools.md`
- Examples: `examples/ai-custom-tools-simple.yaml`
- Advanced examples: `examples/ai-custom-tools-example.yaml`
