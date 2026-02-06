# AI Custom Tools via Ephemeral SSE MCP Servers

## Overview

This feature allows AI checks to use custom shell-based tools defined in your Visor configuration. Custom tools are automatically exposed to AI via ephemeral SSE (Server-Sent Events) MCP (Model Context Protocol) servers that start on-demand and clean up automatically.

## Key Benefits

✅ **Zero Configuration**: Ports are automatically assigned by the OS
✅ **Automatic Lifecycle**: Servers start before AI execution and clean up after
✅ **Seamless Integration**: Works with existing AI providers (Anthropic, OpenAI, Gemini)
✅ **Secure Execution**: Reuses existing tool security features
✅ **Concurrent Support**: Multiple AI checks run independently with separate servers

## How It Works

1. **Define Tools**: Create custom tools in the `tools:` section of your config
2. **Reference in AI Check**: Add `ai_custom_tools:` to your AI check configuration
3. **Automatic Server**: Visor starts an ephemeral SSE MCP server on an available port
4. **AI Execution**: AI can call your custom tools via the MCP protocol
5. **Automatic Cleanup**: Server stops automatically when the AI check completes

```
┌─────────────┐
│   AI Check  │
│  (Step 1)   │
└──────┬──────┘
       │
       │ ai_custom_tools: [grep, scan]
       ↓
┌─────────────────────────────┐
│  AICheckProvider            │
│  1. Detect custom tools     │
│  2. Start SSE server (port) │
│  3. Add to MCP servers      │
└──────────┬──────────────────┘
           │
           ↓
    ┌──────────────────┐
    │  SSE MCP Server  │
    │  localhost:PORT  │
    │                  │
    │  Tools:          │
    │  - grep-tool     │
    │  - scan-tool     │
    └──────────────────┘
           ↑
           │ MCP Protocol (tools/list, tools/call)
           │
    ┌──────────────────┐
    │   AI Provider    │
    │  (Claude, GPT)   │
    └──────────────────┘
```

## Configuration

There are two methods to expose custom tools to AI checks. Both methods create an ephemeral SSE MCP server automatically.

### Method 1: Using `ai_custom_tools` (Recommended)

The simplest approach is to use the `ai_custom_tools` field:

```yaml
version: "1.0"

# Define custom tools
tools:
  grep-pattern:
    name: grep-pattern
    description: Search for patterns in files
    inputSchema:
      type: object
      properties:
        pattern:
          type: string
          description: The regex pattern to search
      required: [pattern]
    exec: 'grep -rn "{{ args.pattern }}" *.ts'
    parseJson: false

steps:
  security-review:
    type: ai
    prompt: |
      Use the grep-pattern tool to find potential security issues.
      Search for: eval, exec, dangerouslySetInnerHTML
    ai_custom_tools:
      - grep-pattern  # Enable custom tool for this AI check
    ai:
      provider: anthropic
      model: claude-3-5-sonnet-20241022
```

### Method 2: Using `tools:` within `ai_mcp_servers`

Alternatively, you can define custom tools within the `ai_mcp_servers` block:

```yaml
steps:
  security-review:
    type: ai
    prompt: |
      Use the grep-pattern tool to find potential security issues.
    ai_mcp_servers:
      my-custom-tools:
        tools: [grep-pattern]  # Creates ephemeral SSE server
    ai:
      provider: anthropic
      model: claude-3-5-sonnet-20241022
```

**Choose `ai_custom_tools` when:**
- You want simple, explicit configuration
- You are combining custom tools with external MCP servers

**Choose `tools:` in `ai_mcp_servers` when:**
- You want to give a meaningful name to your tool server
- You prefer all MCP configuration in one place

### Basic Example

### Advanced Example with Multiple Tools

```yaml
tools:
  check-secrets:
    name: check-secrets
    description: Scan for hardcoded secrets
    inputSchema:
      type: object
      properties:
        file:
          type: string
          description: File to scan (optional)
    exec: |
      grep -rn -E "(api[_-]?key|secret|password)" {{ args.file | default: "." }}
    parseJson: false
    timeout: 10000

  count-todos:
    name: count-todos
    description: Count TODO comments
    inputSchema:
      type: object
      properties: {}
    exec: 'grep -r "TODO" src/ | wc -l'
    parseJson: false

  file-stats:
    name: file-stats
    description: Get file statistics
    inputSchema:
      type: object
      properties:
        filename:
          type: string
          description: File to analyze
      required: [filename]
    exec: |
      echo "Lines: $(wc -l < {{ args.filename }})"
      echo "Size: $(wc -c < {{ args.filename }}) bytes"
    parseJson: false

steps:
  comprehensive-review:
    type: ai
    prompt: |
      You have access to specialized analysis tools:
      - check-secrets: Scan for hardcoded credentials
      - count-todos: Count pending work items
      - file-stats: Analyze file statistics

      Use these tools to provide a comprehensive code review.
    ai_custom_tools:
      - check-secrets
      - count-todos
      - file-stats
    ai:
      provider: anthropic
      model: claude-3-5-sonnet-20241022
      debug: true
```

### Combining with External MCP Servers

You can combine custom tools with external MCP servers:

```yaml
steps:
  full-review:
    type: ai
    prompt: |
      You have both custom tools and external MCP servers available.
      Use them strategically for a thorough review.
    ai_custom_tools:
      - grep-pattern
      - check-secrets
    ai_mcp_servers:
      filesystem:
        command: npx
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
      probe:
        command: npx
        args: ["-y", "@probelabs/probe@latest", "mcp"]
```

## Tool Definition Reference

### Required Fields

- `name`: Unique identifier for the tool
- `exec`: Shell command to execute (supports Liquid templates)
- `inputSchema`: JSON Schema defining the tool's input parameters

### Optional Fields

- `description`: Human-readable description of what the tool does
- `parseJson`: Whether to parse the command output as JSON (default: false)
- `timeout`: Execution timeout in milliseconds (default: 30000)
- `stdin`: Optional input to pass to the command
- `transform`: Liquid template to transform the output
- `transform_js`: JavaScript expression to transform the output
- `cwd`: Working directory for command execution
- `env`: Environment variables to set
- `outputSchema`: JSON Schema for validating/documenting tool output (informational)

### Input Schema

The `inputSchema` uses JSON Schema format to define tool parameters:

```yaml
inputSchema:
  type: object
  properties:
    pattern:
      type: string
      description: Pattern to search for
    files:
      type: string
      description: File glob pattern
      default: "*.ts"
  required: [pattern]  # List of required parameters
```

### Liquid Templates

You can use Liquid templates in `exec`, `stdin`, and `transform`:

```yaml
exec: 'grep -n "{{ args.pattern }}" {{ args.files | default: "*.ts" }}'
```

Available variables:
- `args`: Tool input arguments
- `pr`: PR information (if available)
- `files`: Changed files (if available)
- `outputs`: Outputs from previous checks
- `env`: Environment variables

## Security Considerations

Custom tools run with the same security constraints as other command providers:

1. **Command Injection Protection**: Input validation via JSON Schema
2. **Sandboxed Execution**: Tools run in isolated processes
3. **Timeout Enforcement**: All tools have configurable timeouts
4. **Localhost Only**: SSE servers bind only to localhost
5. **No Credential Storage**: Servers don't store authentication data

## Troubleshooting

### Server Won't Start

**Problem**: `Failed to start custom tools SSE server`

**Solutions**:
- Check if ports are available (firewall/permissions)
- Verify tools are defined in global `tools:` section
- Enable debug mode: `ai.debug: true`

### Tool Not Found

**Problem**: `Custom tool not found: <tool-name>`

**Solutions**:
- Verify tool name matches exactly (case-sensitive)
- Check tool is defined in global `tools:` section
- Ensure `ai_custom_tools` references correct tool name

### Tool Execution Timeout

**Problem**: Tool calls timeout

**Solutions**:
- Increase tool timeout: `timeout: 60000` (60 seconds)
- Simplify the tool command
- Check command is not blocking on input

### Debug Mode

Enable debug logging to see detailed server operations:

```yaml
steps:
  my-check:
    type: ai
    ai_custom_tools: [my-tool]
    ai:
      debug: true  # ← Enable debug logging
```

You'll see:
- Server startup messages
- Port assignment
- Tool execution logs
- Cleanup operations

## Performance

- **Server Startup**: < 100ms
- **Tool Execution**: Inherits timeout from tool config (default: 30s)
- **Server Shutdown**: < 1s graceful, 5s forced
- **Memory Overhead**: Minimal per server instance
- **Concurrent Requests**: Queued (one at a time per server)

## Implementation Details

### Components

1. **CustomToolsSSEServer** (`src/providers/mcp-custom-sse-server.ts`)
   - HTTP server with SSE endpoint
   - MCP protocol implementation
   - Tool execution via CustomToolExecutor

2. **AICheckProvider Integration** (`src/providers/ai-check-provider.ts`)
   - Automatic tool detection
   - Server lifecycle management
   - MCP server configuration injection

3. **Configuration Types** (`src/types/config.ts`)
   - `ai_custom_tools?: string[]` field on CheckConfig

### MCP Protocol Support

The server implements these MCP methods:

- `initialize`: Connection initialization
- `tools/list`: List available tools
- `tools/call`: Execute a tool
- `notifications/initialized`: Initialization confirmation

Message format: JSON-RPC 2.0

### Lifecycle Management

```typescript
// Pseudo-code of lifecycle
const server = new CustomToolsSSEServer(tools, sessionId, debug);

try {
  const port = await server.start();  // OS assigns port
  // ... AI execution with tools ...
} finally {
  await server.stop();  // Always cleanup
}
```

## Examples

See `examples/ai-custom-tools-example.yaml` for a comprehensive example with:
- Security scanning tools
- Code quality tools
- File analysis tools
- Git integration tools
- Combined custom + external MCP servers

## Testing

The custom tools SSE server is covered by automated tests. Run the test suite:

```bash
npm test -- --testPathPattern=mcp-custom-sse-server
```

This runs the unit tests in `tests/unit/mcp-custom-sse-server.test.ts` which verify:
- Server startup and port binding
- Tool listing via MCP protocol
- Tool execution with arguments
- Error handling for invalid tools
- Server cleanup

## Future Enhancements

Potential improvements:
- Tool result caching
- Parallel tool execution
- Tool dependencies
- Tool composition (chaining)
- Persistent MCP servers (optional)
- Tool metrics and monitoring

## Related Documentation

- [AI Custom Tools - Simple Guide](./ai-custom-tools-usage.md) - Quick start guide with minimal examples
- [Custom Tools](./custom-tools.md) - Complete reference for defining custom tools
- [MCP Provider](./mcp-provider.md) - Using MCP protocol with external servers

## Support

For issues or questions:
- Check troubleshooting section above
- Enable debug mode for detailed logs
- Review test files in `tests/unit/mcp-custom-sse-server.test.ts`
- See examples in `examples/ai-custom-tools-example.yaml` and `examples/ai-custom-tools-simple.yaml`
