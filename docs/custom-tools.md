# Custom Tools in YAML Configuration

## Overview

Custom tools allow you to define reusable command-line tools directly in your YAML configuration. These tools can then be used in MCP (Model Context Protocol) blocks throughout your configuration, making it easy to integrate any command-line tool or script into your workflow.

## Features

- **Define tools in YAML**: No need to create separate scripts or programs
- **Input validation**: Define JSON Schema for tool parameters
- **Template support**: Use Liquid templates for dynamic command generation
- **Transform outputs**: Process tool output with Liquid templates or JavaScript
- **Reusable**: Define once, use multiple times across your configuration
- **Importable**: Share tools across projects using the `extends` mechanism
- **Type-safe**: Full TypeScript support with input/output schemas
- **MCP-compatible**: Tools follow the Model Context Protocol specification

## Basic Tool Definition

```yaml
tools:
  my-tool:
    name: my-tool
    description: Description of what the tool does
    exec: 'echo "Hello World"'
```

## Complete Tool Schema

```yaml
tools:
  tool-name:
    # MCP-compatible fields (these map directly to MCP tool interface)
    name: tool-name                    # Required: Tool identifier (MCP: name)
    description: Tool description       # Recommended: Human-readable description (MCP: description)

    # Input schema (JSON Schema format) - MCP: inputSchema
    # This follows the JSON Schema specification and is used for:
    # 1. Validating tool inputs before execution
    # 2. Providing type information to AI models
    # 3. Auto-generating documentation
    inputSchema:
      type: object
      properties:
        param1:
          type: string
          description: Parameter description  # Describe each parameter for AI models
        param2:
          type: number
          description: Optional parameter
      required: [param1]                     # List required parameters
      additionalProperties: false            # Strict mode: reject unknown parameters

    # Custom tool execution fields
    exec: 'command {{ args.param1 }}'  # Required: Command to execute (supports Liquid)
    stdin: '{{ args.param2 }}'         # Optional: Data to pipe to stdin (supports Liquid)

    cwd: /path/to/directory            # Optional: Working directory
    env:                                # Optional: Environment variables
      MY_VAR: value

    timeout: 30000                      # Optional: Timeout in milliseconds (default: 30000)
    parseJson: true                     # Optional: Parse output as JSON

    # Transform output with Liquid template
    transform: '{ "result": {{ output | json }} }'

    # OR transform with JavaScript
    transform_js: |
      return {
        processed: output.trim().toUpperCase()
      };

    # Output schema for validation (optional) - MCP: outputSchema
    # Not currently enforced but useful for documentation
    outputSchema:
      type: object
      properties:
        result:
          type: string
          description: The processed result
```

## MCP Compatibility

Custom tools are designed to be fully compatible with the Model Context Protocol (MCP) specification. When you define a custom tool, it automatically becomes available as an MCP tool with the following mapping:

| Custom Tool Field | MCP Tool Field | Purpose |
|------------------|----------------|---------|
| `name` | `name` | Unique identifier for the tool |
| `description` | `description` | Human-readable description for AI models and documentation |
| `inputSchema` | `inputSchema` | JSON Schema defining expected parameters |
| `outputSchema` | `outputSchema` | JSON Schema for output validation (informational) |

### Why MCP Compatibility Matters

1. **AI Model Integration**: Tools with proper descriptions and schemas can be automatically understood and used by AI models
2. **Type Safety**: Input schemas provide runtime validation and type checking
3. **Documentation**: Schemas serve as self-documenting interfaces
4. **Interoperability**: Tools can potentially be used with other MCP-compatible systems

### Best Practices for MCP Compatibility

1. **Always provide descriptions**: Help AI models understand what your tool does
   ```yaml
   tools:
     analyze-code:
       name: analyze-code
       description: "Analyzes source code for complexity metrics and potential issues"
   ```

2. **Use detailed input schemas**: Include descriptions for each parameter
   ```yaml
   inputSchema:
     type: object
     properties:
       file:
         type: string
         description: "Path to the source code file to analyze"
       metrics:
         type: array
         description: "List of metrics to calculate"
         items:
           type: string
           enum: ["complexity", "lines", "dependencies"]
     required: ["file"]
   ```

3. **Consider output schemas**: While not enforced, they document expected outputs
   ```yaml
   outputSchema:
     type: object
     properties:
       complexity:
         type: number
         description: "Cyclomatic complexity score"
       issues:
         type: array
         description: "List of detected issues"
   ```

## Using Custom Tools

### In AI Steps

Use `ai_custom_tools` to expose custom tools to AI providers via an ephemeral MCP server. See [AI Custom Tools](./ai-custom-tools.md) for complete documentation.

```yaml
steps:
  ai-review:
    type: ai
    prompt: |
      Use the available tools to analyze the code for issues.
    ai_custom_tools:
      - grep-pattern
      - file-stats
    ai:
      provider: anthropic
      model: claude-3-5-sonnet-20241022
```

### In MCP Steps

Custom tools can also be used directly in MCP steps by setting `transport: custom`. The MCP provider supports four transport types:

- `stdio` - Spawn an MCP server as a subprocess (default)
- `sse` - Connect to an MCP server via Server-Sent Events (legacy)
- `http` - Connect via Streamable HTTP transport
- `custom` - Execute YAML-defined custom tools directly

```yaml
steps:
  my-check:
    type: mcp
    transport: custom              # Use custom transport for YAML-defined tools
    method: my-tool                 # Tool name (must be defined in tools: section)
    methodArgs:                     # Tool arguments
      param1: "value1"
      param2: 42
```

## Template Context

Tools have access to a rich template context through Liquid templates:

### In `exec` and `stdin`:
- `{{ args }}` - The arguments passed to the tool
- `{{ input }}` - Alias for `args` (same object)
- `{{ pr }}` - Pull request information:
  - `{{ pr.number }}` - PR number
  - `{{ pr.title }}` - PR title
  - `{{ pr.author }}` - PR author
  - `{{ pr.branch }}` - Head branch name
  - `{{ pr.base }}` - Base branch name
- `{{ files }}` - List of files in the PR
- `{{ outputs }}` - Outputs from previous checks
- `{{ env }}` - Environment variables

### In `transform` and `transform_js`:
- All of the above, plus:
- `{{ output }}` - The raw command output (or parsed JSON if `parseJson: true`)
- `{{ stdout }}` - Standard output (raw string)
- `{{ stderr }}` - Standard error (raw string)
- `{{ exitCode }}` - Command exit code (number)

## Examples

### 1. Simple Grep Tool

```yaml
tools:
  grep-todos:
    name: grep-todos
    description: Find TODO comments in code
    inputSchema:
      type: object
      properties:
        pattern:
          type: string
        files:
          type: array
          items:
            type: string
    exec: 'grep -n "{{ args.pattern }}" {{ args.files | join: " " }}'
```

### 2. JSON Processing Tool

```yaml
tools:
  analyze-package:
    name: analyze-package
    description: Analyze package.json dependencies
    inputSchema:
      type: object
      properties:
        file:
          type: string
    exec: 'cat {{ args.file }}'
    parseJson: true
    transform_js: |
      const deps = Object.keys(output.dependencies || {});
      const devDeps = Object.keys(output.devDependencies || {});
      return {
        totalDeps: deps.length + devDeps.length,
        prodDeps: deps.length,
        devDeps: devDeps.length
      };
```

### 3. Multi-Step Tool with Error Handling

```yaml
tools:
  build-and-test:
    name: build-and-test
    description: Build project and run tests
    exec: |
      npm run build && npm test
    timeout: 300000  # 5 minutes
    transform_js: |
      if (exitCode !== 0) {
        return {
          success: false,
          error: stderr || 'Build or tests failed'
        };
      }
      return {
        success: true,
        output: output
      };
```

### 4. Tool with Dynamic Command Generation

```yaml
tools:
  flexible-linter:
    name: flexible-linter
    description: Run appropriate linter based on file type
    inputSchema:
      type: object
      properties:
        file:
          type: string
    exec: |
      {% assign ext = args.file | split: "." | last %}
      {% case ext %}
        {% when "js", "ts" %}
          eslint {{ args.file }}
        {% when "py" %}
          pylint {{ args.file }}
        {% when "go" %}
          golint {{ args.file }}
        {% else %}
          echo "No linter for .{{ ext }} files"
      {% endcase %}
```

### 5. OpenAPI Tool Bundle (`type: api`)

You can expose an OpenAPI spec as MCP tools by defining a single reusable API bundle:

```yaml
tools:
  petstore-api:
    type: api
    name: petstore-api
    description: Petstore API as MCP tools
    spec: ./petstore-openapi.yaml
    overlays:
      - ./petstore-overlay.yaml
    whitelist:
      - "get*"
      - "POST:/pets*"
    targetUrl: https://petstore.example.com
    headers:
      X-Api-Version: "2026-01"
    apiKey: "${{ env.PETSTORE_API_KEY }}"
```

Behavior:

- Each OpenAPI operation with an `operationId` is exposed as an MCP tool.
- Tool names/descriptions come from OpenAPI and support `x-mcp` overrides.
- Inputs include path/query/header parameters and `requestBody`.
- Security schemes from OpenAPI are applied at call time using `apiKey` / `securityCredentials`.
- `whitelist`/`blacklist` supports glob patterns for `operationId` and `METHOD:/path`.

This works with `ai_custom_tools`, `ai_mcp_servers.<name>.tools`, and `transport: custom` MCP execution.

## Tool Libraries and Extends

### Creating a Tool Library

Create a file with just tool definitions:

```yaml
# tools-library.yaml
version: "1.0"

tools:
  tool1:
    name: tool1
    exec: 'command1'

  tool2:
    name: tool2
    exec: 'command2'
```

### Importing Tools

Use the `extends` mechanism to import tools:

```yaml
version: "1.0"
extends: ./tools-library.yaml

# Additional tools can be defined here
tools:
  local-tool:
    name: local-tool
    exec: 'local-command'

# Use both imported and local tools
steps:
  check1:
    type: mcp
    transport: custom
    method: tool1  # From tools-library.yaml

  check2:
    type: mcp
    transport: custom
    method: local-tool  # Defined locally
```

### Multiple Extends

You can import from multiple sources:

```yaml
extends:
  - ./base-tools.yaml
  - ./security-tools.yaml
  - https://example.com/shared-tools.yaml
```

Tools are merged with later sources overriding earlier ones.

## Integration with Other Features

### Using with forEach

```yaml
steps:
  lint-all-files:
    type: mcp
    transport: custom
    method: my-linter
    forEach: "{{ files }}"
    methodArgs:
      file: "{{ item.filename }}"
```

### Conditional Execution

```yaml
steps:
  optional-check:
    type: mcp
    transport: custom
    method: my-tool
    if: "files.some(f => f.filename.endsWith('.js'))"
    methodArgs:
      target: "src/"
```

### Chaining with on_success/on_failure

```yaml
steps:
  main-check:
    type: mcp
    transport: custom
    method: build-tool
    on_success:
      - type: mcp
        transport: custom
        method: test-tool
    on_failure:
      - type: mcp
        transport: custom
        method: cleanup-tool
```

## Best Practices

1. **Use Input Schemas**: Always define `inputSchema` to validate tool inputs
2. **Handle Errors**: Use `transform_js` to check exit codes and handle errors
3. **Set Timeouts**: Configure appropriate timeouts for long-running commands
4. **Parse JSON**: Use `parseJson: true` for tools that output JSON
5. **Document Tools**: Provide clear descriptions for each tool
6. **Create Libraries**: Group related tools in separate YAML files
7. **Version Control**: Store tool libraries in version control for sharing
8. **Test Tools**: Test tools independently before using in complex workflows

## Security Considerations

- Tools execute with the same permissions as the Visor process
- Be cautious with user input in tool commands
- Use input validation to prevent command injection
- Avoid exposing sensitive data in tool outputs
- Consider using environment variables for secrets

## Troubleshooting

### Tool Not Found

If you get "Tool not found" errors:
1. Ensure the tool is defined in the `tools` section
2. Check that the tool name matches exactly
3. Verify extends paths are correct

### Command Failures

For command execution issues:
1. Test the command manually first
2. Check working directory (`cwd`) settings
3. Verify required binaries are installed
4. Check timeout settings for long operations

### Template Errors

For Liquid template problems:
1. Validate template syntax
2. Check that variables exist in context
3. Use filters correctly (e.g., `| json`, `| join`)

### Transform Errors

For JavaScript transform issues:
1. Ensure valid JavaScript syntax
2. Always return a value
3. Handle undefined/null cases
4. Use try-catch for error handling
